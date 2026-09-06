import Foundation

@main
struct NativeAudioTests {
    @MainActor
    static func main() async {
        do {
            guard CommandLine.arguments.count == 2, let origin = URL(string: CommandLine.arguments[1]) else {
                throw TestFailure(message: "Expected fixture origin")
            }
            var events: [[String: Any]] = []
            let engine = NativeAudioPlayer(origin: origin) { events.append($0) }
            defer { engine.shutdown() }
            func snapshot() throws -> [String: Any] { try engine.handle(command: "playback.snapshot", payload: [:]) }
            func status(_ state: [String: Any]) -> String { (state["status"] as? [String: Any])?["kind"] as? String ?? "missing" }
            func position(_ state: [String: Any]) -> Double { state["positionSec"] as? Double ?? -1 }
            func source(_ key: String) -> [String: Any] {
                ["kind": "remote", "mediaType": "audio", "mediaId": "fixture", "name": "Silent fixture", "queueEntryId": key,
                 "url": "https://invalid.example/do-not-fetch", "durationSec": 12]
            }
            func command(_ command: String, _ payload: [String: Any] = [:]) throws {
                _ = try engine.handle(command: "playback." + command, payload: payload)
            }
            func expect(_ condition: Bool, _ message: String) throws {
                if !condition { throw TestFailure(message: message) }
            }
            func wait(_ label: String, timeout: Double = 10, condition: () throws -> Bool) async throws {
                let deadline = Date().addingTimeInterval(timeout)
                while Date() < deadline {
                    if try condition() { return }
                    try await Task.sleep(nanoseconds: 50_000_000)
                }
                throw TestFailure(message: "Timeout: \(label); state=\(try snapshot())")
            }
            var local = source("local")
            local["location"] = "local"
            do {
                try command("load", ["source": local])
                throw TestFailure(message: "Local source accepted")
            } catch is TestFailure { throw TestFailure(message: "Local source accepted") } catch { }
            local.removeValue(forKey: "location"); local["mediaId"] = "local:fixture"
            do {
                try command("load", ["source": local])
                throw TestFailure(message: "Local ID accepted")
            } catch is TestFailure { throw TestFailure(message: "Local ID accepted") } catch { }

            let a = source("a"), b = source("b")
            try command("load", ["source": b, "queue": [a, b], "index": 1, "positionSec": 1.5])
            try await wait("load stays paused") { status(try snapshot()) == "paused" }
            let loaded = try snapshot()
            try expect(abs(position(loaded) - 1.5) < 0.1, "Resume position was lost")
            let resolvedURL = (loaded["source"] as? [String: Any])?["url"] as? String
            try expect(resolvedURL == origin.absoluteString + "/api/media/fixture", "Untrusted URL was not replaced: \(resolvedURL ?? "nil")")
            try await Task.sleep(nanoseconds: 250_000_000)
            try expect(abs(position(try snapshot()) - 1.5) < 0.1, "Load played before play command")
            try command("play")
            try await wait("play advances") { let value = try snapshot(); return status(value) == "playing" && position(value) > 1.7 }
            try command("seek", ["positionSec": 4.0])
            try await wait("seek completes") { let value = try snapshot(); return status(value) == "playing" && position(value) >= 4 && position(value) < 5 }
            try command("pause")
            try await wait("pause") { status(try snapshot()) == "paused" }
            let beforeReorder = position(try snapshot())
            try command("queue", ["queue": [b, a], "index": 1])
            let reordered = try snapshot()
            try expect(reordered["index"] as? Int == 0, "Duplicate queue entry identity not retained")
            try expect((reordered["source"] as? [String: Any])?["queueEntryId"] as? String == "b", "Wrong duplicate retained")
            try expect(abs(position(reordered) - beforeReorder) < 0.1, "Reorder reset current position")
            try command("settings", ["volume": 0.3, "muted": true, "repeatMode": "all", "stopAfterCurrent": true])
            let settings = try snapshot()
            try expect(abs((settings["volume"] as? Double ?? 0) - 0.3) < 0.001 && settings["muted"] as? Bool == true, "Volume/mute settings lost")
            try expect(settings["repeatMode"] as? String == "all" && settings["stopAfterCurrent"] as? Bool == true, "Queue settings lost")
            try command("play")
            try await wait("resume") { status(try snapshot()) == "playing" }
            try command("settings", ["sleepTimerEndsAtMs": Date().timeIntervalSince1970 * 1000 + 350])
            // No bridge commands during the deadline: the native timer must emit expiry itself.
            let eventStart = events.count
            try await Task.sleep(nanoseconds: 800_000_000)
            let expiry = events.dropFirst(eventStart).compactMap { $0["state"] as? [String: Any] }.first { $0["sleepTimerExpired"] as? Bool == true }
            try expect(expiry != nil, "Native timer did not emit expiry without bridge polling")
            try expect(status(try snapshot()) == "paused", "Sleep timer did not pause")
            try expect(events.compactMap { $0["state"] as? [String: Any] }.contains { $0["queue"] == nil }, "Every event retransmitted queue")
            try command("clear")
            let cleared = try snapshot()
            try expect(status(cleared) == "idle" && cleared["index"] as? Int == -1 && (cleared["queue"] as? [Any])?.isEmpty == true, "Clear left playback state")
            print("PASS NativeAudioPlayer: canonical sources, paused resume, play/seek/pause, duplicate reorder, settings, native sleep timer, clear")
        } catch {
            FileHandle.standardError.write(Data("FAIL \(error)\n".utf8))
            exit(1)
        }
    }
    struct TestFailure: Error, CustomStringConvertible {
        let message: String
        var description: String { message }
    }
}
