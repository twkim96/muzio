#if os(iOS)
import Darwin
import UIKit
import VLCKit

@main
struct VLCVideoPictureInPictureTests {
    private struct Failure: Error, CustomStringConvertible {
        let description: String
    }

    private final class FakeWindowController: NSObject, VLCPictureInPictureWindowControlling {
        var stateChangeEventHandler: ((Bool) -> Void)?
        private(set) var starts = 0
        private(set) var stops = 0
        private(set) var invalidations = 0

        func startPictureInPicture() { starts += 1 }
        func stopPictureInPicture() { stops += 1 }
        func invalidatePlaybackState() { invalidations += 1 }

        func emitState(_ active: Bool) { stateChangeEventHandler?(active) }
    }

    static func main() {
        do {
            try run()
            print("VLC PiP adapter regression passed")
            exit(0)
        } catch {
            fputs("VLC PiP adapter regression failed: \(error)\n", stderr)
            exit(1)
        }
    }

    private static func run() throws {
        let surface = UIView(frame: CGRect(x: 0, y: 0, width: 640, height: 360))
        let state: [String: Any] = [
            "durationSec": 123.456,
            "positionSec": 12.345,
            "seekable": [[0.0, 123.456]],
            "playing": false
        ]
        var commands = [(String, [String: Any])]()
        var oldChanged = [Bool]()
        var oldRequestedPlaying = false
        let old = VLCVideoPictureInPicture(
            surface: surface,
            command: { command, values in
                commands.append((command, values))
                if command == "video.play" { oldRequestedPlaying = true }
                if command == "video.pause" { oldRequestedPlaying = false }
            },
            read: { state },
            changed: { oldChanged.append($0) }
        )
        let controller = FakeWindowController()
        guard let oldReady = old.pictureInPictureReady() else {
            throw Failure(description: "adapter did not provide a PiP readiness callback")
        }
        oldReady(controller)
        guard old.controllerReady, controller.invalidations == 1 else {
            throw Failure(description: "ready callback did not retain the controller and invalidate state")
        }

        guard old.supported else {
            throw Failure(description: "AVKit PiP is unsupported on the selected iOS simulator")
        }
        try old.setActive(true)
        try old.setActive(false)
        guard controller.starts == 1, controller.stops == 1 else {
            throw Failure(description: "PiP start/stop was not forwarded: starts=\(controller.starts), stops=\(controller.stops)")
        }

        controller.emitState(true)
        guard old.active, oldChanged == [true] else {
            throw Failure(description: "PiP state callback did not update the adapter")
        }
        old.play()
        guard oldRequestedPlaying else {
            throw Failure(description: "play callback did not update requested playback state")
        }
        old.pause()
        let commandNames = commands.map { $0.0 }
        guard commandNames == ["video.play", "video.pause"], !oldRequestedPlaying else {
            throw Failure(description: "pause callback did not update requested playback state")
        }

        var seekCompletionCalled = false
        old.seek(by: 2_500) { seekCompletionCalled = true }
        guard commands.count == 4,
              commands[2].0 == "video.seek",
              let requestedPosition = commands[2].1["positionSec"] as? Double,
              abs(requestedPosition - 14.845) < 0.000_001,
              commands[3].0 == "video.pipSeekCompletion",
              !seekCompletionCalled else {
            throw Failure(description: "seek callback did not forward the expected position and completion")
        }
        guard let ownerCompletion = commands[3].1["completion"] as? () -> Void else {
            throw Failure(description: "seek completion was not handed to the owner")
        }
        ownerCompletion()
        guard seekCompletionCalled else {
            throw Failure(description: "owner seek completion did not execute")
        }

        guard old.mediaLength() == 123_456,
              old.mediaTime() == 12_345,
              old.isMediaSeekable(),
              !old.isMediaPlaying() else {
            throw Failure(description: "media values were not converted to milliseconds correctly")
        }

        let staleStateCallback = controller.stateChangeEventHandler!
        let changedBeforeRetire = oldChanged.count
        old.retire()
        guard !old.controllerReady, !old.active,
              old.mediaLength() == 0, old.mediaTime() == 0,
              !old.isMediaSeekable(), !old.isMediaPlaying(),
              controller.stops == 2 else {
            throw Failure(description: "retire did not clear readiness/media state and stop PiP")
        }

        var replacementRequestedPlaying = false
        var replacementChanged = [Bool]()
        let replacement = VLCVideoPictureInPicture(
            surface: surface,
            command: { command, _ in
                if command == "video.play" { replacementRequestedPlaying = true }
                if command == "video.pause" { replacementRequestedPlaying = false }
            },
            read: { state },
            changed: { replacementChanged.append($0) }
        )
        let replacementController = FakeWindowController()
        guard let replacementReady = replacement.pictureInPictureReady() else {
            throw Failure(description: "replacement adapter did not provide a PiP readiness callback")
        }
        replacementReady(replacementController)
        replacement.play()
        guard replacementRequestedPlaying else {
            throw Failure(description: "replacement playback did not receive play")
        }

        let oldCommandCount = commands.count
        oldReady(replacementController)
        staleStateCallback(false)
        old.play()
        old.pause()
        var retiredSeekCompletionCalled = false
        old.seek(by: 1_000) { retiredSeekCompletionCalled = true }
        guard oldCommandCount == commands.count,
              replacementRequestedPlaying,
              oldChanged.count == changedBeforeRetire,
              replacementChanged.isEmpty,
              retiredSeekCompletionCalled,
              !old.controllerReady else {
            throw Failure(description: "retired callbacks or controls disturbed replacement playback")
        }

        replacementController.emitState(true)
        guard replacement.active, replacementChanged == [true] else {
            throw Failure(description: "replacement controller callback did not remain functional")
        }
        replacement.retire()
    }
}
#endif
