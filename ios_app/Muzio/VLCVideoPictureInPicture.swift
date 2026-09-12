#if os(iOS)
import UIKit
import AVKit
import VLCKit

/// One drawable per media generation. Retired VLC callbacks cannot control the
/// replacement player. VLCKit owns the PiP window; we never access its AVKit internals.
final class VLCVideoPictureInPicture: NSObject, VLCDrawable,
    VLCPictureInPictureDrawable, VLCPictureInPictureMediaControlling {
    private let surface: UIView
    private let command: @MainActor (String, [String: Any]) -> Void
    private let read: @MainActor () -> [String: Any]
    private let changed: @MainActor (Bool) -> Void
    private weak var controller: VLCPictureInPictureWindowControlling?
    private var retired = false
    private(set) var active = false
    var supported: Bool { AVPictureInPictureController.isPictureInPictureSupported() }
    // The public VLC API exposes controller readiness, not AVKit's isPossible.
    var controllerReady: Bool { !retired && controller != nil }

    init(surface: UIView, command: @escaping @MainActor (String, [String: Any]) -> Void,
         read: @escaping @MainActor () -> [String: Any], changed: @escaping @MainActor (Bool) -> Void) {
        self.surface = surface; self.command = command; self.read = read; self.changed = changed
    }
    private func onMain<T>(_ work: @MainActor () -> T) -> T {
        if Thread.isMainThread { return MainActor.assumeIsolated { work() } }
        return DispatchQueue.main.sync { MainActor.assumeIsolated { work() } }
    }
    func addSubview(_ view: UIView) { onMain { if !retired { surface.addSubview(view) } } }
    func bounds() -> CGRect { onMain { surface.bounds } }
    func mediaController() -> VLCPictureInPictureMediaControlling { self }
    func pictureInPictureReady() -> ((VLCPictureInPictureWindowControlling?) -> Void)? {
        { [weak self] controller in
            self?.onMain {
                guard let self, let controller, !self.retired else { return }
                self.controller = controller
                controller.stateChangeEventHandler = { [weak self] active in
                    self?.onMain {
                        guard let self, !self.retired else { return }
                        self.active = active
                        self.changed(active)
                    }
                }
                controller.invalidatePlaybackState()
            }
        }
    }
    func setActive(_ value: Bool) throws {
        guard !retired, supported, let controller else {
            throw HostError.message("영상 준비 후 PiP를 다시 시도해 주세요.")
        }
        if value { controller.startPictureInPicture() } else { controller.stopPictureInPicture() }
    }
    func invalidatePlaybackState() { controller?.invalidatePlaybackState() }
    func retire() {
        retired = true
        controller?.stateChangeEventHandler = { _ in }
        controller?.stopPictureInPicture()
        controller = nil; active = false
    }
    func play() { onMain { if !retired { command("video.play", [:]) } } }
    func pause() { onMain { if !retired { command("video.pause", [:]) } } }
    func seek(by offset: Int64, completion: @escaping () -> Void) {
        onMain {
            guard !retired else { completion(); return }
            let state = read()
            let duration = state["durationSec"] as? Double ?? 0
            let position = state["positionSec"] as? Double ?? 0
            command("video.seek", ["positionSec": min(duration, max(0, position + Double(offset) / 1000))])
            // The owner completes after the sought frame arrives (or seek failure).
            command("video.pipSeekCompletion", ["completion": completion])
        }
    }
    func mediaLength() -> Int64 { onMain { retired ? 0 : Int64((read()["durationSec"] as? Double ?? 0) * 1000) } }
    func mediaTime() -> Int64 { onMain { retired ? 0 : Int64((read()["positionSec"] as? Double ?? 0) * 1000) } }
    func isMediaSeekable() -> Bool { onMain { !retired && !(read()["seekable"] as? [[Double]] ?? []).isEmpty } }
    func isMediaPlaying() -> Bool { onMain { !retired && read()["playing"] as? Bool == true } }
}
#endif
