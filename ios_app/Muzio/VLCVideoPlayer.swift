import Foundation
import AVFoundation
#if os(iOS)
import UIKit
import VLCKit
final class VLCPixelView: UIView {}
#else
import AppKit
import VLCKit
final class VLCPixelView: VLCVideoView {
    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}
#endif

/// Shared Apple decoder. The WK page owns all controls; this view draws only pixels.
@MainActor
final class VLCVideoPlayer {
    let surface = VLCPixelView(frame: .zero)
    private var player = VLCMediaPlayer()
    private let origin: URL
    private let proxyBase: URL?
    private let emit: ([String: Any]) -> Void
    private var timer: Timer?
    private var generation = ""
    var onAcquirePlayback: (() -> Void)?
    private var mediaTitle = "Video"
    private lazy var nowPlaying = VideoNowPlaying(read: { [weak self] in self?.snapshot() ?? [:] }, command: { [weak self] command, payload in
        _ = try? self?.handle(command, payload)
    })
    func relinquishSystemControls() { pause(); nowPlaying.relinquish() }
    private var wantsPlay = false
    #if os(iOS)
    private var inputPrepared = false
    #endif
    private var volume = 1.0
    private var muted = false
    private var rate: Float = 1
    private var pendingSeek: Double?
    private var activeSeek: (target: Double, started: Date, frames: UInt64)?
    private var seekError: String?
    private var pausedSeekPosition: Double?
    private var lastPosition = -1.0
    private var lastProgress = Date()
    private var requestedFrame = CGRect.zero
    private var viewportWidth = 1.0
    private var frameVisible = false
    private var disposed = false
    private var fullscreenObserver: NSObjectProtocol?
    #if os(iOS)
    private var pictureInPicture: VLCVideoPictureInPicture?
    private var pipSeekCompletions: [() -> Void] = []
    private var restoreAfterPiP = false
    private var foregroundObserver: NSObjectProtocol?
    #endif
    private var diagnosticTick = 0
    private let diagnostics = ProcessInfo.processInfo.environment["MUZIO_VIDEO_DIAGNOSTICS"] == "1"

    init(origin: URL, proxyBase: URL?, emit: @escaping ([String: Any]) -> Void) {
        self.origin = origin; self.proxyBase = proxyBase; self.emit = emit
        #if os(iOS)
        surface.isUserInteractionEnabled = false
        surface.backgroundColor = .black
        surface.layer.masksToBounds = true
        foregroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.restorePiPInterfaceIfNeeded()
                self.layout(); self.publish()
            }
        }
        #else
        surface.wantsLayer = true
        surface.layer?.masksToBounds = true
        #endif
        surface.isHidden = true
        #if os(macOS)
        fullscreenObserver = NotificationCenter.default.addObserver(forName: NSWindow.didExitFullScreenNotification, object: nil, queue: .main) { [weak self] event in
            MainActor.assumeIsolated {
                guard let self, let window = event.object as? NSWindow, window === self.surface.window else { return }
                self.emit(["type": "videoFullscreen", "state": ["active": false]])
            }
        }
        #endif
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.publish() }
        }
    }

    func handle(_ command: String, _ payload: [String: Any]) throws -> [String: Any] {
        if diagnostics { NSLog("VLC command %@", command) }
        guard !disposed else { throw HostError.message("영상 플레이어가 종료되었습니다.") }
        if command == "video.frame" {
            func number(_ key: String) -> Double {
                let n = payload[key] as? Double ?? 0
                return n.isFinite ? n : 0
            }
            viewportWidth = max(1, number("viewportWidth"))
            requestedFrame = CGRect(x: number("x"), y: number("y"), width: max(0, number("width")), height: max(0, number("height")))
            frameVisible = payload["visible"] as? Bool == true
            #if os(iOS)
            surface.layer.cornerRadius = max(0, number("radius"))
            #else
            surface.layer?.cornerRadius = max(0, number("radius"))
            #endif
            layout()
            return [:]
        }
        // Fullscreen geometry is owned by the shared web surface, including Escape.
        if command == "video.fullscreen" { setFullscreen(payload["active"] as? Bool == true); return [:] }
        if command == "video.snapshot" { return snapshot() }
        if command == "video.load" {
            guard let next = payload["generation"] as? String, !next.isEmpty,
                  let raw = payload["url"] as? String else { throw HostError.message("영상 주소가 없습니다.") }
            let url = try NativeVideoSourcePolicy.validate(raw, origin: origin, proxyBase: proxyBase)
            clear()
            generation = next
            mediaTitle = payload["title"] as? String ?? "Video"
            player = VLCMediaPlayer()
            #if os(iOS)
            let pip = VLCVideoPictureInPicture(surface: surface, command: { [weak self] command, values in
                guard let self, self.generation == next else { return }
                if command == "video.pipSeekCompletion", let completion = values["completion"] as? () -> Void {
                    if self.activeSeek == nil { completion() } else { self.pipSeekCompletions.append(completion) }
                    return
                }
                do { _ = try self.handle(command, values.merging(["generation": next]) { _, new in new }) }
                catch { self.seekError = error.localizedDescription; self.publish() }
            }, read: { [weak self] in
                guard let self, self.generation == next else { return [:] }
                return self.snapshot()
            }, changed: { [weak self] active in
                guard let self, self.generation == next else { return }
                if active { self.restoreAfterPiP = true }
                self.restorePiPInterfaceIfNeeded()
                self.publish()
            })
            pictureInPicture = pip
            player.drawable = pip
            #else
            player.drawable = surface
            #endif
            #if os(iOS)
            guard let media = VLCMedia(url: url) else {
                clear()
                throw HostError.message("영상 소스를 열지 못했습니다.")
            }
            #else
            let media = VLCMedia(url: url)
            #endif
            // Read metadata without starting sound. The web provider sends play
            // after readiness, and the same input resumes without another fetch.
            media.addOption(":start-paused")
            if let fragment = URLComponents(string: raw)?.fragment, fragment.hasPrefix("t="),
               let start = Double(fragment.dropFirst(2).split(separator: ",").first ?? ""), start.isFinite, start > 0 {
                media.addOption(":start-time=\(start)")
            }
            player.media = media
            applySettings()
            player.play()
        } else {
            guard !generation.isEmpty, payload["generation"] as? String == generation else {
                throw HostError.message("이전 영상 명령입니다.")
            }
            switch command {
            case "video.play":
                onAcquirePlayback?()
                nowPlaying.acquire(title: mediaTitle)
                #if os(iOS)
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(.playback, mode: .moviePlayback)
                try session.setActive(true)
                #endif
                wantsPlay = true; seekError = nil; lastProgress = Date()
                #if os(iOS)
                if inputPrepared { player.play() }
                #else
                player.play()
                #endif
            case "video.pause": pause()
            case "video.seek":
                guard let value = payload["positionSec"] as? Double, value.isFinite, value >= 0 else {
                    throw HostError.message("잘못된 재생 위치입니다.")
                }
                pendingSeek = value; lastProgress = Date(); seekError = nil
                activeSeek = (value, Date(), displayedFrames)
                applyPendingSeek()
            case "video.settings":
                if let value = payload["volume"] as? Double, value.isFinite { volume = min(1, max(0, value)) }
                if let value = payload["muted"] as? Bool { muted = value }
                if let value = payload["rate"] as? Double, value.isFinite, value > 0, value <= 4 { rate = Float(value) }
                applySettings()
            case "video.tracks":
                #if os(iOS)
                if let id = payload["audioId"] as? String,
                   let track = player.audioTracks.first(where: { $0.trackId == id }) { track.isSelectedExclusively = true }
                if payload["textId"] is NSNull { player.deselectAllTextTracks() }
                else if let id = payload["textId"] as? String,
                        let track = player.textTracks.first(where: { $0.trackId == id }) { player.selectTextTracks([track]) }
                #else
                if let id = payload["audioId"] as? String, let value = Int32(id),
                   (player.audioTrackIndexes as? [NSNumber] ?? []).contains(NSNumber(value: value)) { player.currentAudioTrackIndex = value }
                if payload["textId"] is NSNull { player.currentVideoSubTitleIndex = -1 }
                else if let id = payload["textId"] as? String, let value = Int32(id),
                        (player.videoSubTitlesIndexes as? [NSNumber] ?? []).contains(NSNumber(value: value)) { player.currentVideoSubTitleIndex = value }
                #endif
            case "video.pip":
                #if os(iOS)
                guard let pictureInPicture else { throw HostError.message("영상 준비 후 PiP를 다시 시도해 주세요.") }
                try pictureInPicture.setActive(payload["active"] as? Bool == true)
                #else
                throw HostError.message("Mac 영상은 앱 창에서 재생합니다.")
                #endif
            case "video.clear": clear()
            default: throw HostError.message("지원하지 않는 영상 명령입니다.")
            }
        }
        publish()
        return snapshot()
    }

    private func setFullscreen(_ active: Bool) {
        #if os(macOS)
        if let window = surface.window, window.styleMask.contains(.fullScreen) != active { window.toggleFullScreen(nil) }
        #endif
    }
    private var displayedFrames: UInt64 { UInt64(max(0, player.media?.statistics.displayedPictures ?? 0)) }
    private func applySettings() {
        player.audio?.volume = Int32((volume * 100).rounded())
        player.audio?.isMuted = muted
        player.rate = rate
    }
    private func applyPendingSeek() {
        guard let target = pendingSeek, player.isSeekable else { return }
        player.time = VLCTime(number: NSNumber(value: target * 1000))
        pendingSeek = nil
    }
    func pause() { wantsPlay = false; player.pause(); publish() }
    func layout() {
        #if os(iOS)
        // WK can send a hidden/zero rect while entering the background. Retain
        // the attached inline drawable so AVKit can transfer its video layer.
        if !generation.isEmpty && (UIApplication.shared.applicationState != .active || pictureInPicture?.active == true) { return }
        #endif
        guard let bounds = surface.superview?.bounds else { return }
        let scale = bounds.width / viewportWidth
        surface.frame = CGRect(x: requestedFrame.minX * scale, y: requestedFrame.minY * scale,
                               width: requestedFrame.width * scale, height: requestedFrame.height * scale)
        surface.isHidden = !frameVisible || generation.isEmpty
    }
    private func tracks(_ names: [Any]?, _ indexes: [Any]?, selected: Int32) -> [[String: Any]] {
        zip(names ?? [], indexes ?? []).compactMap { name, index in
            guard let id = index as? NSNumber, id.int32Value >= 0 else { return nil }
            return ["id": id.stringValue, "label": String(describing: name), "language": "", "selected": id.int32Value == selected]
        }
    }
    private func snapshot() -> [String: Any] {
        let duration = max(0, (player.media?.length.value?.doubleValue ?? 0) / 1000)
        let position = activeSeek?.target ?? pausedSeekPosition ?? max(0, (player.time.value?.doubleValue ?? 0) / 1000)
        #if os(iOS)
        let ready = inputPrepared && duration > 0
        #else
        let ready = duration > 0
        #endif
        #if os(iOS)
        let ended = player.state == .stopped && duration > 0 && position >= duration - 1
        let audioTracks = player.audioTracks.map { ["id": $0.trackId, "label": $0.trackName, "language": "", "selected": $0.isSelected] as [String: Any] }
        let textTracks = player.textTracks.map { ["id": $0.trackId, "label": $0.trackName, "language": "", "selected": $0.isSelected] as [String: Any] }
        #else
        let ended = player.state == .ended
        let audioTracks = tracks(player.audioTrackNames, player.audioTrackIndexes, selected: player.currentAudioTrackIndex)
        let textTracks = tracks(player.videoSubTitlesNames, player.videoSubTitlesIndexes, selected: player.currentVideoSubTitleIndex)
        #endif
        var state: [String: Any] = ["generation": generation, "ready": ready,
            "playing": wantsPlay && !ended && player.state != .error, "ended": ended,
            "positionSec": position, "durationSec": duration, "volume": volume, "muted": muted, "rate": rate,
            "waiting": wantsPlay && (!ready || Date().timeIntervalSince(lastProgress) > 1.5),
            "seeking": activeSeek != nil, "seekable": player.isSeekable && duration > 0 ? [[0, duration]] : [],
            // VLC does not expose byte-buffer time ranges; do not invent them.
            "buffered": [[Double]](), "pip": false, "pipSupported": false, "pipPossible": false,
            "audioTracks": audioTracks, "textTracks": textTracks]
        #if os(iOS)
        state["pip"] = pictureInPicture?.active == true
        state["pipSupported"] = pictureInPicture?.supported == true
        // Do not claim AVKit isPossible from the weaker VLC ready callback.
        state.removeValue(forKey: "pipPossible")
        #endif
        if let seekError { state["error"] = seekError }
        if player.state == .error { state["error"] = "영상을 재생하지 못했습니다. 연결과 파일 형식을 확인해 주세요." }
        return state
    }
    private func publish() {
        guard !generation.isEmpty else { return }
        #if os(iOS)
        // VLC4 publishes duration while still opening. A play at that point can
        // run before :start-paused takes effect and leave the input paused forever.
        if !inputPrepared && player.state == .paused {
            inputPrepared = true
            if wantsPlay { player.play() }
        }
        #endif
        let position = (player.time.value?.doubleValue ?? 0) / 1000
        diagnosticTick += 1
        if diagnostics && diagnosticTick % 8 == 0 {
            let stats = player.media?.statistics
            NSLog("VLC state=%ld position=%.3f duration=%.3f wants=%d seek=%d frames=%llu audio=%llu", player.state.rawValue, position, (player.media?.length.value?.doubleValue ?? 0)/1000, wantsPlay ? 1 : 0, activeSeek == nil ? 0 : 1, UInt64(max(0, stats?.displayedPictures ?? 0)), UInt64(max(0, stats?.playedAudioBuffers ?? 0)))
        }
        if position != lastPosition { lastProgress = Date(); lastPosition = position }
        if let seek = activeSeek, pendingSeek == nil {
            let elapsed = Date().timeIntervalSince(seek.started)
            let frames = displayedFrames
            if elapsed >= 0.25 && frames > seek.frames && (!wantsPlay || abs(position - seek.target) < 2) {
                // VLC renders the sought frame while paused, but its playback
                // clock remains at the old time until resume. Keep the accepted
                // paused position until the running clock catches up.
                pausedSeekPosition = wantsPlay ? nil : seek.target
                activeSeek = nil
            } else if elapsed > 15 {
                activeSeek = nil
                seekError = "재생 위치를 이동하지 못했습니다. 다시 시도해 주세요."
            }
        }
        if wantsPlay, let target = pausedSeekPosition, abs(position - target) < 2 { pausedSeekPosition = nil }
        applyPendingSeek()
        #if os(iOS)
        if activeSeek == nil { finishPiPSeeks() }
        pictureInPicture?.invalidatePlaybackState()
        #endif
        layout()
        nowPlaying.update()
        emit(["type": "video", "state": snapshot()])
    }
    #if os(iOS)
    private func finishPiPSeeks() {
        let completions = pipSeekCompletions; pipSeekCompletions.removeAll()
        completions.forEach { $0() }
    }
    private func restorePiPInterfaceIfNeeded() {
        if restoreAfterPiP && pictureInPicture?.active != true && UIApplication.shared.applicationState == .active {
            restoreAfterPiP = false
            emit(["type": "videoRestore"])
        }
    }
    #endif
    func clear() {
        nowPlaying.relinquish()
        #if os(iOS)
        inputPrepared = false
        pictureInPicture?.retire(); pictureInPicture = nil
        restoreAfterPiP = false; finishPiPSeeks()
        #endif
        setFullscreen(false)
        wantsPlay = false; pendingSeek = nil; activeSeek = nil; pausedSeekPosition = nil; seekError = nil; generation = ""
        player.stop(); player.drawable = nil
        lastPosition = -1; lastProgress = Date(); surface.isHidden = true
    }
    func shutdown() {
        #if os(iOS)
        if let foregroundObserver { NotificationCenter.default.removeObserver(foregroundObserver) }; foregroundObserver = nil
        #endif
        clear(); disposed = true; timer?.invalidate(); timer = nil; if let fullscreenObserver { NotificationCenter.default.removeObserver(fullscreenObserver) }; fullscreenObserver = nil; surface.removeFromSuperview() }
}
