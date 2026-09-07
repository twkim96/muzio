#if os(iOS)
import AVFoundation
import AVKit
import WebKit

/// Only the video pixels are native. All inline controls remain in the web player.
@MainActor
final class NativeVideoPlayer: NSObject, @preconcurrency AVPictureInPictureControllerDelegate {
    let surface = VideoPixelView()
    let player = AVPlayer()
    private var pip: AVPictureInPictureController?
    private let origin: URL
    private let proxyBase: URL?
    private let emit: ([String: Any]) -> Void
    private var observations: [NSKeyValueObservation] = []
    private var itemObservations: [NSKeyValueObservation] = []
    private var tick: Any?
    private var endedObserver: NSObjectProtocol?
    private var generation = ""
    private let playback = NativeVideoPlaybackState()
    private var ended = false
    private var pendingSeek: Double?
    private var preferredRate: Float = 1
    private var restoreReply: ((Bool) -> Void)?
    private var restoreRevision = 0
    private var restored = false
    private var disposed = false
    private var viewportWidth: Double = 1
    private var requestedFrame = CGRect.zero
    private var frameVisible = false
    private var audioGroup: AVMediaSelectionGroup?
    private var textGroup: AVMediaSelectionGroup?
    private var errorMessage: String?

    init(origin: URL, proxyBase: URL?, emit: @escaping ([String: Any]) -> Void) {
        self.origin = origin; self.proxyBase = proxyBase; self.emit = emit
        super.init()
        surface.playerLayer.player = player
        surface.playerLayer.videoGravity = .resizeAspect
        surface.isUserInteractionEnabled = false
        surface.isHidden = true
        pip = AVPictureInPictureController(playerLayer: surface.playerLayer)
        pip?.delegate = self
        pip?.canStartPictureInPictureAutomaticallyFromInline = true
        observations = [
            player.observe(\.timeControlStatus, options: [.new]) { [weak self, playback] _, change in
                guard let status = change.newValue else { return }
                let observation = playback.captureObservation()
                let playing = status != .paused
                Task { @MainActor in
                    guard let self else { return }
                    if self.player.currentItem?.status == .readyToPlay {
                        self.playback.observePlaying(playing, observation: observation)
                    }
                    self.publish()
                }
            }
        ]
        tick = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.25, preferredTimescale: 600), queue: .main) { [weak self] _ in
            Task { @MainActor in self?.publish() }
        }
    }

    func accepts(_ payload: [String: Any]) -> Bool { !generation.isEmpty && payload["generation"] as? String == generation }
    func handle(_ command: String, _ payload: [String: Any]) throws -> [String: Any] {
        guard !disposed else { throw HostError.message("영상 플레이어가 종료되었습니다.") }
        if command == "video.frame" {
            func value(_ key: String) -> Double { let n = payload[key] as? Double ?? 0; return n.isFinite ? n : 0 }
            viewportWidth = max(1, value("viewportWidth"))
            requestedFrame = CGRect(x: value("x"), y: value("y"), width: max(0, value("width")), height: max(0, value("height")))
            frameVisible = payload["visible"] as? Bool == true
            surface.layer.cornerRadius = max(0, value("radius"))
            layout(in: surface.superview?.bounds ?? .zero)
            return snapshot()
        }
        if command == "video.snapshot" { return snapshot() }
        if command == "video.load" {
            guard let next = payload["generation"] as? String, !next.isEmpty,
                  let raw = payload["url"] as? String else { throw HostError.message("영상 주소가 없습니다.") }
            let url = try NativeVideoSourcePolicy.validate(raw, origin: origin, proxyBase: proxyBase)
            playback.reset(); player.pause(); ended = false; pendingSeek = nil; errorMessage = nil
            generation = next
            itemObservations.removeAll(); audioGroup = nil; textGroup = nil
            if let endedObserver { NotificationCenter.default.removeObserver(endedObserver) }
            let item = AVPlayerItem(url: url)
            player.replaceCurrentItem(with: item)
            itemObservations = [item.observe(\.status, options: [.initial, .new]) { [weak self, weak item] _, _ in
                Task { @MainActor in
                    guard let self, let item, self.player.currentItem === item, self.generation == next else { return }
                    if item.status == .failed {
                        self.playback.reset(); self.pendingSeek = nil
                        self.errorMessage = item.error?.localizedDescription ?? "영상을 열 수 없습니다."
                    }
                    if item.status == .readyToPlay {
                        self.audioGroup = item.asset.mediaSelectionGroup(forMediaCharacteristic: .audible)
                        self.textGroup = item.asset.mediaSelectionGroup(forMediaCharacteristic: .legible)
                    }
                    if item.status == .readyToPlay, let target = self.pendingSeek { self.seek(target) }
                    self.publish()
                }
            }]
            endedObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
                Task { @MainActor in
                    guard let self, self.player.currentItem === item, self.generation == next else { return }
                    self.ended = true; self.playback.requestPlay(false); self.publish()
                }
            }
        } else {
            guard accepts(payload) else { throw HostError.message("이전 영상 명령입니다.") }
            switch command {
            case "video.play":
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(.playback, mode: .moviePlayback); try session.setActive(true)
                playback.requestPlay(true); ended = false
                player.playImmediately(atRate: preferredRate)
            case "video.pause": pause()
            case "video.seek":
                guard let position = payload["positionSec"] as? Double, position.isFinite, position >= 0 else { throw HostError.message("잘못된 재생 위치입니다.") }
                seek(position)
            case "video.settings":
                if let volume = payload["volume"] as? Double, volume.isFinite { player.volume = Float(min(1, max(0, volume))) }
                if let muted = payload["muted"] as? Bool { player.isMuted = muted }
                if let rate = payload["rate"] as? Double, rate.isFinite, rate > 0, rate <= 4 {
                    preferredRate = Float(rate)
                    if player.rate > 0 { player.rate = preferredRate }
                }
            case "video.tracks":
                if let id = payload["audioId"] as? String, let index = Int(id), let group = audioGroup, group.options.indices.contains(index) {
                    player.currentItem?.select(group.options[index], in: group)
                }
                if payload.keys.contains("textId"), let group = textGroup {
                    if payload["textId"] is NSNull { player.currentItem?.select(nil, in: group) }
                    else if let id = payload["textId"] as? String, let index = Int(id), group.options.indices.contains(index) {
                        player.currentItem?.select(group.options[index], in: group)
                    }
                }
            case "video.pip":
                if payload["active"] as? Bool == true {
                    guard pip?.isPictureInPicturePossible == true else { throw HostError.message("PiP가 아직 준비되지 않았습니다.") }
                    pip?.startPictureInPicture()
                } else { pip?.stopPictureInPicture() }
            case "video.clear": clear()
            default: throw HostError.message("지원하지 않는 영상 명령입니다.")
            }
        }
        publish()
        return snapshot()
    }
    func pause() { playback.requestPlay(false); player.pause(); publish() }
    private func seek(_ seconds: Double) {
        pendingSeek = seconds
        let revision = playback.beginSeek(), source = generation
        ended = false
        guard player.currentItem?.status == .readyToPlay else { publish(); return }
        pendingSeek = nil
        publish()
        // Exact frame decoding over HTTP can require substantial preroll. Keep
        // the requested position within 250 ms while allowing a nearby sync point.
        let tolerance = CMTime(seconds: 0.25, preferredTimescale: 600)
        player.seek(to: CMTime(seconds: seconds, preferredTimescale: 600), toleranceBefore: tolerance, toleranceAfter: tolerance) { [weak self] finished in
            Task { @MainActor in
                guard let self, self.generation == source, self.playback.isCurrentSeek(revision) else { return }
                // Resume before releasing the seek guard: synchronous and queued
                // transient pause observations must not erase the user's intent.
                if self.playback.wantsPlay { self.player.playImmediately(atRate: self.preferredRate) }
                else { self.player.pause() }
                self.playback.finishSeek(revision)
                if !finished, self.player.currentItem?.status == .failed {
                    self.errorMessage = self.player.currentItem?.error?.localizedDescription ?? "영상 위치를 이동할 수 없습니다."
                }
                self.publish()
            }
        }
    }

    func layout(in bounds: CGRect) {
        let scale = bounds.width / viewportWidth
        surface.frame = CGRect(x: requestedFrame.minX * scale, y: requestedFrame.minY * scale,
                               width: requestedFrame.width * scale, height: requestedFrame.height * scale)
        surface.isHidden = !frameVisible || requestedFrame.width <= 1 || requestedFrame.height <= 1
        if !surface.isHidden, surface.window != nil, let reply = restoreReply { restored = true; restoreReply = nil; reply(true) }
    }
    private func snapshot() -> [String: Any] {
        func finite(_ time: CMTime?) -> Double { let n = time?.seconds ?? 0; return n.isFinite ? max(0, n) : 0 }
        let duration = finite(player.currentItem?.duration)
        let buffered = (player.currentItem?.loadedTimeRanges ?? []).map { value -> [Double] in
            let range = value.timeRangeValue; return [finite(range.start), finite(CMTimeRangeGetEnd(range))]
        }
        var state: [String: Any] = ["generation": generation, "ready": player.currentItem?.status == .readyToPlay,
            "playing": playback.wantsPlay && !ended, "waiting": playback.wantsPlay && (playback.seeking || player.timeControlStatus == .waitingToPlayAtSpecifiedRate),
            "ended": ended, "seeking": playback.seeking, "positionSec": finite(player.currentTime()), "durationSec": duration,
            "volume": Double(player.volume), "muted": player.isMuted, "rate": Double(preferredRate), "buffered": buffered,
            "seekable": duration > 0 ? [[0, duration]] : [], "pip": pip?.isPictureInPictureActive == true,
            "pipSupported": AVPictureInPictureController.isPictureInPictureSupported(), "pipPossible": pip?.isPictureInPicturePossible == true]
        func tracks(_ group: AVMediaSelectionGroup?) -> [[String: Any]] {
            guard let group else { return [] }
            let selected = player.currentItem?.currentMediaSelection.selectedMediaOption(in: group)
            return group.options.enumerated().map { index, option in
                ["id": String(index), "label": option.displayName, "language": option.extendedLanguageTag ?? option.locale?.identifier ?? "", "selected": option === selected]
            }
        }
        state["audioTracks"] = tracks(audioGroup); state["textTracks"] = tracks(textGroup)
        if let errorMessage { state["error"] = errorMessage }
        return state
    }
    private func publish() { if !disposed { emit(["type": "video", "state": snapshot()]) } }
    func clear() {
        restoreReply?(false); restoreReply = nil; restoreRevision += 1
        playback.reset(); pip?.stopPictureInPicture(); player.pause()
        itemObservations.removeAll(); player.replaceCurrentItem(with: nil); generation = ""; pendingSeek = nil
        surface.isHidden = true
    }
    func shutdown() {
        clear(); disposed = true; observations.removeAll()
        if let tick { player.removeTimeObserver(tick) }; tick = nil
        if let endedObserver { NotificationCenter.default.removeObserver(endedObserver) }; endedObserver = nil
        pip?.delegate = nil; surface.removeFromSuperview()
    }
    func pictureInPictureControllerWillStartPictureInPicture(_ controller: AVPictureInPictureController) { restored = false }
    func pictureInPictureControllerDidStartPictureInPicture(_ controller: AVPictureInPictureController) { publish() }
    func pictureInPictureController(_ controller: AVPictureInPictureController, failedToStartPictureInPictureWithError error: Error) { publish() }
    func pictureInPictureControllerDidStopPictureInPicture(_ controller: AVPictureInPictureController) {
        if !restored && UIApplication.shared.applicationState != .active { pause() }
        publish()
    }
    func pictureInPictureController(_ controller: AVPictureInPictureController, restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completionHandler: @escaping (Bool) -> Void) {
        restored = false
        restoreReply?(false)
        restoreReply = completionHandler; restoreRevision += 1
        let revision = restoreRevision
        emit(["type": "videoRestore"])
        if frameVisible, !surface.isHidden, surface.window != nil, surface.bounds.width > 1, surface.bounds.height > 1 { restored = true; restoreReply = nil; completionHandler(true) }
        else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                guard let self, self.restoreRevision == revision, let reply = self.restoreReply else { return }
                reply(false); self.restoreReply = nil
                if UIApplication.shared.applicationState != .active { self.pause() }
            }
        }
    }
}

final class VideoPixelView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    override init(frame: CGRect) { super.init(frame: frame); backgroundColor = .black; clipsToBounds = true }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
}
#endif
