import Foundation
import MediaPlayer

/// One owner at a time: the video engine releases these targets before music claims them.
@MainActor
final class VideoNowPlaying {
    private(set) var active = false
    private var title = "Video"
    private var targets: [(MPRemoteCommand, Any)] = []
    private let read: () -> [String: Any]
    private let command: (String, [String: Any]) -> Void

    init(read: @escaping () -> [String: Any], command: @escaping (String, [String: Any]) -> Void) {
        self.read = read; self.command = command
    }

    func acquire(title: String) {
        self.title = title
        if !active {
            active = true
            let center = MPRemoteCommandCenter.shared()
            center.likeCommand.isEnabled = false
            center.nextTrackCommand.isEnabled = false
            center.previousTrackCommand.isEnabled = false
            bind(center.playCommand, "play")
            bind(center.pauseCommand, "pause")
            bind(center.togglePlayPauseCommand, "toggle")
            center.skipBackwardCommand.preferredIntervals = [10]
            center.skipForwardCommand.preferredIntervals = [10]
            bind(center.skipBackwardCommand, "backward")
            bind(center.skipForwardCommand, "forward")
            bind(center.changePlaybackPositionCommand, "seek")
        }
        update()
    }

    func perform(_ action: String, position: Double? = nil) {
        guard active else { return }
        let state = read()
        guard let generation = state["generation"] as? String, !generation.isEmpty else { return }
        var payload: [String: Any] = ["generation": generation]
        let playing = state["playing"] as? Bool == true
        switch action {
        case "play", "pause": command("video.\(action)", payload)
        case "toggle": command(playing ? "video.pause" : "video.play", payload)
        case "backward", "forward", "seek":
            let current = state["positionSec"] as? Double ?? 0
            let duration = state["durationSec"] as? Double ?? 0
            let target = action == "seek" ? position : current + (action == "forward" ? 10 : -10)
            guard let target, target.isFinite, duration.isFinite, duration > 0 else { return }
            payload["positionSec"] = min(duration, max(0, target))
            command("video.seek", payload)
        default: break
        }
    }

    func update() {
        guard active else { return }
        let state = read()
        let playing = state["playing"] as? Bool == true
        let waiting = state["waiting"] as? Bool == true
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [
            MPMediaItemPropertyTitle: title,
            MPMediaItemPropertyPlaybackDuration: state["durationSec"] ?? 0,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: state["positionSec"] ?? 0,
            MPNowPlayingInfoPropertyPlaybackRate: playing && !waiting ? (state["rate"] ?? 1) : 0,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.video.rawValue,
        ]
        #if os(macOS)
        MPNowPlayingInfoCenter.default().playbackState = playing ? .playing : .paused
        #endif
    }

    func relinquish() {
        guard active else { return }
        active = false
        targets.forEach { $0.0.removeTarget($0.1) }
        targets.removeAll()
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }

    private func bind(_ remote: MPRemoteCommand, _ action: String) {
        remote.isEnabled = true
        let target = remote.addTarget { [weak self] event in
            let position = (event as? MPChangePlaybackPositionCommandEvent)?.positionTime
            Task { @MainActor in self?.perform(action, position: position) }
            return .success
        }
        targets.append((remote, target))
    }
}
