import AVFoundation
import Foundation
import MediaPlayer

/// The app owns this instance independently of the web view's page lifetime.
@MainActor
final class NativeAudioPlayer: NSObject {
    private let origin: URL
    private let onEvent: ([String: Any]) -> Void
    private let player = AVPlayer()
    private var queue: [[String: Any]] = []
    private var index = -1
    private var generation = 0
    private var seekRevision = 0
    private var queueChanged = true
    private var disposed = false
    private var wantsPlay = false
    private var ended = false
    private var failure: String?
    private var pendingPosition: Double?
    private var repeatMode = "none"
    private var stopAfterCurrent = false
    private var sleepTimerEndsAtMs: Double?
    private var sleepTimerExpired = false
    private var sleepTimer: Timer?
    private var resumeAfterInterruption = false
    private var statusObservation: NSKeyValueObservation?
    private var timeObservation: NSKeyValueObservation?
    private var periodicObserver: Any?
    private var notifications: [NSObjectProtocol] = []
    private var itemNotifications: [NSObjectProtocol] = []
    private var remoteTargets: [(MPRemoteCommand, Any)] = []

    init(origin: URL, onEvent: @escaping ([String: Any]) -> Void) {
        self.origin = origin
        self.onEvent = onEvent
        super.init()
        player.automaticallyWaitsToMinimizeStalling = true
        timeObservation = player.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
            Task { @MainActor in self?.publish() }
        }
        periodicObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 1, preferredTimescale: 600), queue: .main) { [weak self] _ in
            Task { @MainActor in self?.expireSleepTimerIfNeeded(); self?.publish() }
        }
        #if os(iOS)
        observeSession()
        #endif
        installRemoteCommands()
    }

    func handle(command: String, payload: [String: Any]) throws -> [String: Any] {
        guard !disposed else { throw invalid("Playback engine is shut down") }
        expireSleepTimerIfNeeded()
        switch command {
        case "playback.snapshot": break
        case "playback.load":
            guard let source = payload["source"] as? [String: Any] else { throw invalid("Missing source") }
            var next = try validatedQueue(payload["queue"] ?? [source])
            if next.isEmpty { next = [try validatedSource(source)] }
            let selected = try queueIndex(payload, count: next.count)
            var resolved = try validatedSource(source)
            guard sameMedia(resolved, next[selected]),
                  resolved["queueEntryId"] == nil || resolved["queueEntryId"] as? String == next[selected]["queueEntryId"] as? String
            else { throw invalid("Source does not match queue selection") }
            if let key = next[selected]["queueEntryId"] { resolved["queueEntryId"] = key }
            next[selected] = resolved
            let position = try number(payload, "positionSec", fallback: 0)
            queue = next; index = selected; queueChanged = true
            select(position: position, autoplay: false)
        case "playback.queue":
            let next = try validatedQueue(payload["queue"])
            if next.isEmpty { clear(cancelTimer: false); break }
            let retained = current.flatMap { source -> Int? in
                guard let key = source["queueEntryId"] as? String, !key.isEmpty else { return nil }
                return next.firstIndex { $0["queueEntryId"] as? String == key && sameMedia(source, $0) }
            }
            let selected = try retained ?? queueIndex(payload, count: next.count)
            let autoplay = current != nil && wantsPlay
            queue = next; index = selected; queueChanged = true
            if retained == nil { select(position: 0, autoplay: autoplay) }
        case "playback.play": try play()
        case "playback.pause": pause()
        case "playback.seek": seek(try number(payload, "positionSec"))
        case "playback.settings": try settings(payload)
        case "playback.clear": clear(cancelTimer: true)
        default: throw invalid("Unknown playback command: \(command)")
        }
        publish()
        return snapshot(includeQueue: command == "playback.snapshot")
    }

    func shutdown() {
        guard !disposed else { return }
        disposed = true
        generation += 1
        player.pause()
        statusObservation = nil; timeObservation = nil
        if let token = periodicObserver { player.removeTimeObserver(token) }
        periodicObserver = nil
        (notifications + itemNotifications).forEach { NotificationCenter.default.removeObserver($0) }
        notifications.removeAll(); itemNotifications.removeAll()
        remoteTargets.forEach { $0.0.removeTarget($0.1) }; remoteTargets.removeAll()
        sleepTimer?.invalidate(); sleepTimer = nil
        player.replaceCurrentItem(with: nil)
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
    }

    private var current: [String: Any]? { queue.indices.contains(index) ? queue[index] : nil }
    private func invalid(_ message: String) -> NSError { NSError(domain: "MuzioPlayback", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    private func sameMedia(_ a: [String: Any], _ b: [String: Any]) -> Bool { a["mediaId"] as? String == b["mediaId"] as? String }
    private func number(_ value: [String: Any], _ key: String, fallback: Double? = nil) throws -> Double {
        guard let result = (value[key] as? NSNumber)?.doubleValue ?? fallback, result.isFinite, result >= 0 else { throw invalid("Invalid \(key)") }
        return result
    }
    private func queueIndex(_ payload: [String: Any], count: Int) throws -> Int {
        let raw = try number(payload, "index", fallback: 0)
        guard raw < Double(count), raw.rounded(.down) == raw else { throw invalid("Invalid queue index") }
        return Int(raw)
    }
    private func validatedQueue(_ value: Any?) throws -> [[String: Any]] {
        guard let entries = value as? [[String: Any]] else { throw invalid("Missing queue") }
        return try entries.map(validatedSource)
    }
    private func validatedSource(_ source: [String: Any]) throws -> [String: Any] {
        guard source["kind"] as? String == "remote", source["mediaType"] as? String == "audio",
              source["location"] == nil || source["location"] as? String == "network",
              let id = source["mediaId"] as? String, !id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !id.hasPrefix("local:"), source["name"] is String else { throw invalid("Only network audio is supported") }
        var result = source
        // Ignore page-provided URLs. Encode the opaque ID as exactly one path component.
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
        guard let encoded = id.addingPercentEncoding(withAllowedCharacters: allowed),
              var components = URLComponents(url: origin, resolvingAgainstBaseURL: false),
              ["http", "https"].contains(components.scheme ?? ""), components.host != nil else { throw invalid("Invalid audio origin") }
        components.percentEncodedPath = "/api/media/" + encoded
        components.query = nil; components.fragment = nil; components.user = nil; components.password = nil
        guard let url = components.url else { throw invalid("Invalid media ID") }
        result["url"] = url.absoluteString
        return result
    }

    private func select(position: Double, autoplay: Bool) {
        generation += 1
        let token = generation
        statusObservation = nil
        itemNotifications.forEach { NotificationCenter.default.removeObserver($0) }; itemNotifications.removeAll()
        player.pause(); wantsPlay = autoplay; ended = false; failure = nil; pendingPosition = position
        guard let source = current, let string = source["url"] as? String, let url = URL(string: string) else { return }
        let item = AVPlayerItem(url: url)
        player.replaceCurrentItem(with: item)
        statusObservation = item.observe(\.status, options: [.initial, .new]) { [weak self] _, _ in
            Task { @MainActor in
                guard let self, self.generation == token, !self.disposed else { return }
                if item.status == .failed { self.failure = item.error?.localizedDescription ?? "Audio playback failed"; self.wantsPlay = false }
                if item.status == .readyToPlay {
                    if let position = self.pendingPosition { self.seek(position) }
                    else if self.wantsPlay { self.player.play() }
                }
                self.publish()
            }
        }
        itemNotifications.append(NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
            Task { @MainActor in guard let self, self.generation == token, !self.disposed else { return }; self.didEnd() }
        })
        itemNotifications.append(NotificationCenter.default.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: item, queue: .main) { [weak self] note in
            let message = (note.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error)?.localizedDescription
            Task { @MainActor in
                guard let self, self.generation == token, !self.disposed else { return }
                self.failure = message ?? "Audio playback failed"; self.pause(); self.publish()
            }
        })
    }

    private func play() throws {
        guard current != nil else { return }
        #if os(iOS)
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .default)
        try session.setActive(true)
        #endif
        wantsPlay = true; resumeAfterInterruption = false
        if ended { seek(0) }
        if player.currentItem?.status == .readyToPlay && pendingPosition == nil { player.play() }
    }
    private func pause() { wantsPlay = false; resumeAfterInterruption = false; player.pause() }
    private func seek(_ seconds: Double) {
        guard current != nil else { return }
        ended = false
        pendingPosition = seconds
        guard player.currentItem?.status == .readyToPlay else { return }
        seekRevision += 1
        let revision = seekRevision
        let token = generation
        player.seek(to: CMTime(seconds: seconds, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] finished in
            Task { @MainActor in
                guard let self, self.generation == token, !self.disposed, finished, self.seekRevision == revision, self.pendingPosition == seconds else { return }
                self.pendingPosition = nil
                self.expireSleepTimerIfNeeded()
                if self.wantsPlay { self.player.play() }
                self.publish()
            }
        }
    }
    private func didEnd() {
        expireSleepTimerIfNeeded()
        if stopAfterCurrent || !wantsPlay { pause(); ended = true; publish(); return }
        if repeatMode == "one" { seek(0); return }
        if index + 1 < queue.count { index += 1; select(position: 0, autoplay: wantsPlay) }
        else if repeatMode == "all" && !queue.isEmpty { index = 0; select(position: 0, autoplay: wantsPlay) }
        else { pause(); ended = true }
        publish()
    }
    private func clear(cancelTimer: Bool) {
        generation += 1; pause(); player.replaceCurrentItem(with: nil)
        statusObservation = nil
        itemNotifications.forEach { NotificationCenter.default.removeObserver($0) }; itemNotifications.removeAll()
        queue = []; index = -1; queueChanged = true; ended = false; failure = nil; pendingPosition = nil
        if cancelTimer { setSleepTimer(nil) }
    }

    private func settings(_ payload: [String: Any]) throws {
        let mode = payload["repeatMode"] as? String ?? repeatMode
        guard ["none", "all", "one"].contains(mode) else { throw invalid("Invalid repeat mode") }
        let volume = try number(payload, "volume", fallback: Double(player.volume))
        guard volume <= 1 else { throw invalid("Invalid volume") }
        var timer = sleepTimerEndsAtMs
        if let value = payload["sleepTimerEndsAtMs"] { timer = value is NSNull ? nil : try number(payload, "sleepTimerEndsAtMs") }
        repeatMode = mode; player.volume = Float(volume)
        if let muted = payload["muted"] as? Bool { player.isMuted = muted }
        if let stop = payload["stopAfterCurrent"] as? Bool { stopAfterCurrent = stop }
        if payload["sleepTimerEndsAtMs"] != nil { setSleepTimer(timer) }
    }
    private func setSleepTimer(_ end: Double?) {
        sleepTimer?.invalidate(); sleepTimer = nil
        sleepTimerEndsAtMs = end; sleepTimerExpired = false
        guard let end else { return }
        expireSleepTimerIfNeeded()
        guard sleepTimerEndsAtMs != nil else { return }
        let timer = Timer(timeInterval: max(0.01, end / 1000 - Date().timeIntervalSince1970), repeats: false) { [weak self] _ in
            Task { @MainActor in self?.expireSleepTimerIfNeeded(); self?.publish() }
        }
        sleepTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }
    private func expireSleepTimerIfNeeded() {
        guard let end = sleepTimerEndsAtMs, Date().timeIntervalSince1970 * 1000 >= end else { return }
        sleepTimer?.invalidate(); sleepTimer = nil; sleepTimerEndsAtMs = nil; sleepTimerExpired = true; pause()
    }

    private func snapshot(includeQueue: Bool) -> [String: Any] {
        let position = pendingPosition ?? max(0, finite(player.currentTime().seconds))
        let duration = max(0, finite(player.currentItem?.duration.seconds ?? 0, fallback: (current?["durationSec"] as? NSNumber)?.doubleValue ?? 0))
        let kind: String
        if failure != nil { kind = "error" }
        else if current == nil { kind = "idle" }
        else if ended { kind = "ended" }
        else if player.currentItem?.status != .readyToPlay || pendingPosition != nil { kind = "loading" }
        else if player.timeControlStatus == .playing { kind = "playing" }
        else if wantsPlay { kind = position > 0 ? "buffering" : "loading" }
        else { kind = "paused" }
        var status: [String: Any] = ["kind": kind]
        if let failure { status["message"] = failure }
        var result: [String: Any] = ["source": current as Any? ?? NSNull(), "status": status,
            "positionSec": position, "durationSec": duration, "index": index, "repeatMode": repeatMode,
            "volume": Double(player.volume), "muted": player.isMuted, "stopAfterCurrent": stopAfterCurrent,
            "sleepTimerEndsAtMs": sleepTimerEndsAtMs as Any? ?? NSNull(), "sleepTimerExpired": sleepTimerExpired]
        if includeQueue { result["queue"] = queue }
        return result
    }
    private func finite(_ value: Double, fallback: Double = 0) -> Double { value.isFinite ? value : (fallback.isFinite ? fallback : 0) }
    private func publish() {
        guard !disposed else { return }
        let state = snapshot(includeQueue: queueChanged)
        queueChanged = false
        updateNowPlaying(state)
        onEvent(["type": "playback", "state": state])
    }
    private func updateNowPlaying(_ state: [String: Any]) {
        guard let source = current else { MPNowPlayingInfoCenter.default().nowPlayingInfo = nil; return }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [
            MPMediaItemPropertyTitle: source["title"] ?? source["name"] ?? "Muzio",
            MPMediaItemPropertyArtist: source["artist"] ?? "", MPMediaItemPropertyAlbumTitle: source["album"] ?? "",
            MPMediaItemPropertyPlaybackDuration: state["durationSec"] ?? 0,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: state["positionSec"] ?? 0,
            MPNowPlayingInfoPropertyPlaybackRate: player.rate,
            MPNowPlayingInfoPropertyPlaybackQueueIndex: index, MPNowPlayingInfoPropertyPlaybackQueueCount: queue.count,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue]
    }
    private func installRemoteCommands() {
        let center = MPRemoteCommandCenter.shared()
        addRemote(center.playCommand) { try $0.play() }
        addRemote(center.pauseCommand) { $0.pause() }
        addRemote(center.togglePlayPauseCommand) { engine in if engine.wantsPlay { engine.pause() } else { try engine.play() } }
        addRemote(center.nextTrackCommand) { $0.skip(1) }
        addRemote(center.previousTrackCommand) { $0.skip(-1) }
        center.changePlaybackPositionCommand.isEnabled = true
        let target = center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            let position = event.positionTime
            Task { @MainActor in guard let self, !self.disposed, position.isFinite, position >= 0 else { return }; self.seek(position); self.publish() }
            return .success
        }
        remoteTargets.append((center.changePlaybackPositionCommand, target))
    }
    private func addRemote(_ command: MPRemoteCommand, action: @escaping @MainActor (NativeAudioPlayer) throws -> Void) {
        command.isEnabled = true
        let target = command.addTarget { [weak self] _ in
            Task { @MainActor in
                guard let self, !self.disposed else { return }
                self.expireSleepTimerIfNeeded()
                do { try action(self) } catch { self.failure = error.localizedDescription }
                self.publish()
            }
            return .success
        }
        remoteTargets.append((command, target))
    }
    private func skip(_ delta: Int) {
        guard current != nil else { return }
        if delta < 0 && player.currentTime().seconds > 3 { seek(0); return }
        let next = index + delta
        if queue.indices.contains(next) { index = next }
        else if repeatMode == "all" { index = delta > 0 ? 0 : queue.count - 1 }
        else { return }
        select(position: 0, autoplay: wantsPlay)
    }
    #if os(iOS)
    private func observeSession() {
        let session = AVAudioSession.sharedInstance()
        notifications.append(NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: .main) { [weak self] note in
            let type = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? NSNumber)?.uintValue
            let options = (note.userInfo?[AVAudioSessionInterruptionOptionKey] as? NSNumber)?.uintValue ?? 0
            Task { @MainActor in
                guard let self, !self.disposed else { return }
                if type == AVAudioSession.InterruptionType.began.rawValue {
                    self.resumeAfterInterruption = self.wantsPlay; self.wantsPlay = false; self.player.pause()
                } else if type == AVAudioSession.InterruptionType.ended.rawValue {
                    self.expireSleepTimerIfNeeded()
                    if self.resumeAfterInterruption && AVAudioSession.InterruptionOptions(rawValue: options).contains(.shouldResume) { try? self.play() }
                    self.resumeAfterInterruption = false
                }
                self.publish()
            }
        })
        notifications.append(NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: session, queue: .main) { [weak self] note in
            let reason = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? NSNumber)?.uintValue
            Task { @MainActor in
                guard let self, !self.disposed else { return }
                if reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue { self.pause(); self.publish() }
            }
        })
    }
    #endif
}
