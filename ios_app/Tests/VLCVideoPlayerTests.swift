import AppKit
import Darwin
import Foundation

@MainActor
@main
struct VLCVideoPlayerTests {
    private static let generation = "vlc-native-test-current"
    private static let staleGeneration = "vlc-native-test-stale"

    private struct Failure: Error, CustomStringConvertible {
        let description: String
    }

    static func main() {
        do {
            try run()
            print("VLC native video regression passed")
        } catch {
            fputs("VLC native video regression failed: \(error)\n", stderr)
            exit(1)
        }
    }

    private static func run() throws {
        let arguments = Array(CommandLine.arguments.dropFirst())
        let environment = ProcessInfo.processInfo.environment
        let originText = arguments.first ?? environment["MUZIO_VIDEO_TEST_ORIGIN"] ?? ""
        let mediaText = arguments.dropFirst().first ?? environment["MUZIO_VIDEO_TEST_MEDIA_URL"] ?? ""
        guard !originText.isEmpty, !mediaText.isEmpty else { throw Failure(description: "Supply an origin and a video URL (CLI or MUZIO_VIDEO_TEST_ORIGIN / MUZIO_VIDEO_TEST_MEDIA_URL).") }
        let origin = try ServerPolicy.origin(originText)

        var events = [[String: Any]]()
        let player = VLCVideoPlayer(origin: origin, proxyBase: nil) { event in
            events.append(event)
        }
        let application = NSApplication.shared
        application.setActivationPolicy(.prohibited)
        application.finishLaunching()
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 640, height: 360),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let container = NSView(frame: NSRect(x: 0, y: 0, width: 640, height: 360))
        player.surface.frame = container.bounds
        player.surface.autoresizingMask = [.width, .height]
        container.addSubview(player.surface)
        window.contentView = container
        window.makeKeyAndOrderFront(nil)
        defer {
            player.shutdown()
            window.orderOut(nil)
            window.close()
        }

        try testVideoNowPlaying()

        try issue(player, "video.frame", [
            "viewportWidth": 640.0, "x": 0.0, "y": 0.0,
            "width": 640.0, "height": 360.0, "radius": 0.0, "visible": true
        ])
        try issue(player, "video.load", ["generation": generation, "url": mediaText])
        try issue(player, "video.settings", [
            "generation": generation, "volume": 0.0, "muted": true, "rate": 1.0
        ])
        try waitUntil("metadata readiness", timeout: 20) {
            let state = snapshot(player)
            return bool(state, "ready") && number(state, "durationSec") > 0
        }

        try issue(player, "video.seek", ["generation": generation, "positionSec": 5.0])
        try waitUntil("initial seek started", timeout: 4) {
            bool(snapshot(player), "seeking") || events.contains { bool(eventState($0), "seeking") }
        }

        let beforePlay = number(snapshot(player), "positionSec")
        try issue(player, "video.play", ["generation": generation])
        try waitUntil("clock start after play", timeout: 12) {
            let state = snapshot(player)
            return bool(state, "playing") && number(state, "positionSec") >= 4 && number(state, "positionSec") > beforePlay + 0.5
        }

        try issue(player, "video.pause", ["generation": generation])
        try waitUntil("pause", timeout: 4) { !bool(snapshot(player), "playing") }

        events.removeAll(keepingCapacity: true)
        try issue(player, "video.seek", ["generation": generation, "positionSec": 15.0])
        try waitUntil("paused seek started", timeout: 4) {
            events.contains { bool(eventState($0), "seeking") }
        }
        try waitUntil("paused seek completed", timeout: 18) {
            events.contains {
                let state = eventState($0)
                return !bool(state, "seeking") && abs(number(state, "positionSec") - 15) < 1.5
            }
        }
        let pausedSeek = snapshot(player)
        guard !bool(pausedSeek, "playing"), !bool(pausedSeek, "seeking"),
              abs(number(pausedSeek, "positionSec") - 15) < 1.5 else {
            throw Failure(description: "paused seek snapshot did not report position 15: \(pausedSeek)")
        }

        let beforeResume = number(pausedSeek, "positionSec")
        try issue(player, "video.play", ["generation": generation])
        try waitUntil("resume near paused seek", timeout: 12) {
            let state = snapshot(player)
            return bool(state, "playing") && number(state, "positionSec") >= 14
        }
        try waitUntil("clock advances after resume", timeout: 8) {
            number(snapshot(player), "positionSec") > beforeResume + 0.4
        }

        let beforeStale = snapshot(player)
        try expectRejected(player, "video.play", ["generation": staleGeneration])
        try expectRejected(player, "video.clear", ["generation": staleGeneration])
        let afterStale = snapshot(player)
        guard string(afterStale, "generation") == generation,
              bool(afterStale, "playing"),
              number(afterStale, "positionSec") >= number(beforeStale, "positionSec") - 0.5 else {
            throw Failure(description: "stale commands disturbed current playback: before=\(beforeStale), after=\(afterStale)")
        }
        try waitUntil("current playback after stale commands", timeout: 8) {
            number(snapshot(player), "positionSec") > number(beforeStale, "positionSec") + 0.4
        }

        let cleared = try player.handle("video.clear", ["generation": generation])
        guard string(cleared, "generation").isEmpty,
              !bool(cleared, "playing"), !bool(cleared, "seeking") else {
            throw Failure(description: "clear did not stop the current generation: \(cleared)")
        }
        player.shutdown()
        print("metadata, play clock, paused seek, stale generation, clear and shutdown checks passed")
    }

    private static func issue(_ player: VLCVideoPlayer, _ command: String, _ payload: [String: Any]) throws {
        _ = try player.handle(command, payload)
    }

    private static func expectRejected(_ player: VLCVideoPlayer, _ command: String, _ payload: [String: Any]) throws {
        do {
            _ = try player.handle(command, payload)
            throw Failure(description: "stale \(command) was accepted")
        } catch let failure as Failure {
            throw failure
        } catch {
            // HostError.message is the expected rejection from the generation guard.
        }
    }

    private static func snapshot(_ player: VLCVideoPlayer) -> [String: Any] {
        (try? player.handle("video.snapshot", [:])) ?? [:]
    }

    private static func waitUntil(_ label: String, timeout: TimeInterval, _ predicate: () -> Bool) throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if predicate() { return }
            RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        }
        throw Failure(description: "timed out waiting for \(label)")
    }

    private static func eventState(_ event: [String: Any]) -> [String: Any]? {
        event["state"] as? [String: Any]
    }

    private static func bool(_ state: [String: Any]?, _ key: String) -> Bool {
        state?[key] as? Bool ?? false
    }

    private static func number(_ state: [String: Any]?, _ key: String) -> Double {
        state?[key] as? Double ?? (state?[key] as? NSNumber)?.doubleValue ?? 0
    }

    private static func string(_ state: [String: Any], _ key: String) -> String {
        state[key] as? String ?? ""
    }
}
