import Foundation
import MediaPlayer

@main
struct NativeAudioTests {
    @MainActor
    static func main() async {
        do {
            guard CommandLine.arguments.count == 2, let origin = URL(string: CommandLine.arguments[1]) else {
                throw TestFailure(message: "Expected fixture origin")
            }
            let likesDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: likesDirectory) }
            let likes = try AppleNotificationLikeStore(origin: origin, directory: likesDirectory)
            let videoInfo: [String: Any] = [
                MPMediaItemPropertyTitle: "Video sentinel",
                MPNowPlayingInfoPropertyPlaybackRate: 1.0
            ]
            func nowPlayingTitle() -> String? {
                MPNowPlayingInfoCenter.default().nowPlayingInfo?[MPMediaItemPropertyTitle] as? String
            }
            MPNowPlayingInfoCenter.default().nowPlayingInfo = videoInfo
            var events: [[String: Any]] = []
            let engine = NativeAudioPlayer(origin: origin, feedbackStore: likes) { events.append($0) }
            defer { engine.shutdown() }
            try expect(nowPlayingTitle() == "Video sentinel", "Initial no-audio engine changed another owner's Now Playing info")
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
            try likes.toggle("song")
            let restored = try AppleNotificationLikeStore(origin: origin, directory: likesDirectory)
            try expect(restored.isLiked("song"), "Native like did not survive recreation")
            let pending = restored.snapshot()["pending"] as! [[String: Any]]
            _ = try command("syncNotificationLikes", ["keys": [], "acknowledged": []])
            try expect(likes.isLiked("song"), "Unacknowledged native edit lost to stale web keys")
            try command("syncNotificationLikes", ["keys": ["song"], "acknowledged": [pending[0]["id"] as! String]])
            let feedback = try engine.handle(command: "playback.notificationLikes", payload: [:])
            try expect((feedback["pending"] as? [Any])?.isEmpty == true, "Acknowledged edit was not removed")
            let other = try AppleNotificationLikeStore(origin: URL(string: "https://other.example")!, directory: likesDirectory)
            try expect(!other.isLiked("song"), "Likes leaked across servers")
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

            local["location"] = "local"
            do {
                try command("load", ["source": local])
                throw TestFailure(message: "Local source accepted without resolver")
            } catch is TestFailure { throw TestFailure(message: "Local source accepted without resolver") } catch { }

            let a = source("a"), b = source("b")
            try command("load", ["source": b, "queue": [a, b], "index": 1, "positionSec": 1.5])
            try await wait("load stays paused") { status(try snapshot()) == "paused" }
            let loaded = try snapshot()
            try expect(nowPlayingTitle() == "Silent fixture", "Playback load did not acquire audio Now Playing ownership")
            try expect(abs(position(loaded) - 1.5) < 0.1, "Resume position was lost")
            let resolvedURL = (loaded["source"] as? [String: Any])?["url"] as? String
            try expect(resolvedURL == origin.absoluteString + "/api/media/fixture", "Untrusted URL was not replaced: \(resolvedURL ?? "nil")")
            try await Task.sleep(nanoseconds: 250_000_000)
            try expect(abs(position(try snapshot()) - 1.5) < 0.1, "Load played before play command")

            MPNowPlayingInfoCenter.default().nowPlayingInfo = videoInfo
            engine.relinquishForVideo()
            try command("queue", ["queue": [b, a], "index": 0])
            try command("settings", ["volume": 0.25])
            _ = try snapshot()
            try expect(nowPlayingTitle() == "Video sentinel", "Yielded queue/settings/snapshot reclaimed video Now Playing info")
            try command("load", ["source": b, "queue": [a, b], "index": 1, "positionSec": 1.5])
            try await wait("load reacquires after video") { status(try snapshot()) == "paused" }
            try expect(nowPlayingTitle() == "Silent fixture", "Explicit playback load did not reacquire audio ownership")
            MPNowPlayingInfoCenter.default().nowPlayingInfo = videoInfo
            engine.relinquishForVideo()
            try await Task.sleep(nanoseconds: 250_000_000)
            try expect(abs(position(try snapshot()) - 1.5) < 0.1, "Yielded audio resumed without an explicit music command")
            try command("play")
            try expect(nowPlayingTitle() == "Silent fixture", "Explicit music play did not reacquire audio Now Playing ownership")
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
            MPNowPlayingInfoCenter.default().nowPlayingInfo = videoInfo
            engine.relinquishForVideo()
            engine.shutdown()
            try expect(nowPlayingTitle() == "Video sentinel", "Shutdown after video yield cleared another owner's Now Playing info")
            let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".wav")
            try Data(contentsOf: origin.appendingPathComponent("api/media/fixture")).write(to: file)
            defer { try? FileManager.default.removeItem(at: file) }
            var acquisitions = 0, releases = 0, artworkReads = 0
            let localEngine = NativeAudioPlayer(origin: origin, resolveLocal: { id in
                guard id == "local:fixture" || id == "local:missing" else { throw TestFailure(message: "Unauthorized catalog ID") }
                acquisitions += 1
                return NativeAudioLocalAccess(url: id == "local:missing" ? file.appendingPathExtension("missing") : file, release: { releases += 1 })
            }, artworkProvider: { _ in
                artworkReads += 1
                return Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=")
            }) { _ in }
            defer { localEngine.shutdown() }
            var authorized = source("authorized")
            authorized["location"] = "local"; authorized["mediaId"] = "local:fixture"
            authorized["url"] = "file:///private/unauthorized.wav"
            func localCommand(_ name: String, _ payload: [String: Any] = [:]) throws -> [String: Any] {
                try localEngine.handle(command: "playback." + name, payload: payload)
            }
            _ = try localCommand("load", ["source": authorized])
            try await wait("authorized local file loads") { status(try localCommand("snapshot")) == "paused" }
            try await wait("local Now Playing artwork") { MPNowPlayingInfoCenter.default().nowPlayingInfo?[MPMediaItemPropertyArtwork] != nil }
            _ = try localCommand("snapshot")
            try expect(artworkReads == 1, "Artwork was read repeatedly for same source")
            _ = try localCommand("play")
            try await wait("local playback advances") { position(try localCommand("snapshot")) > 0.1 }
            _ = try localCommand("pause")
            _ = try localCommand("queue", ["queue": [authorized]])
            _ = try localCommand("play")
            try expect(acquisitions == 1 && releases == 0, "Pause/resume or queue retention lost the local lease")
            let localState = try localCommand("snapshot")
            try expect(((localState["source"] as? [String: Any])?["url"] as? String)?.hasPrefix("/__muzio_local/media/") == true, "Local snapshot leaked or trusted file URL")
            var denied = authorized; denied["mediaId"] = "local:unauthorized"
            denied["url"] = file.absoluteString
            let rejected = try localCommand("load", ["source": denied])
            try expect(status(rejected) == "error" && releases == 1 && acquisitions == 1, "Unauthorized ID used page URL or retained old lease")
            _ = try localCommand("load", ["source": authorized])
            _ = try localCommand("clear")
            try expect(releases == 2, "Clear did not release local lease")
            _ = try localCommand("load", ["source": authorized])
            var missing = authorized; missing["mediaId"] = "local:missing"
            _ = try localCommand("load", ["source": missing])
            try await wait("local item failure") { status(try localCommand("snapshot")) == "error" }
            try expect(releases == 4, "Failed item did not release local lease")
            _ = try localCommand("load", ["source": authorized])
            localEngine.shutdown()
            try expect(releases == 5, "Shutdown did not release local lease")
            print("PASS NativeAudioPlayer: canonical sources, paused resume, play/seek/pause, duplicate reorder, settings, native sleep timer, clear, authorized local playback, artwork, durable likes and lease lifecycle")
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
