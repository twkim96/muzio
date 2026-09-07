import Foundation

@main struct ApplePlaybackHistoryTests {
    static func main() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("history.json")
        let history = ApplePlaybackHistory(file: file)
        func state(_ id: String, _ kind: String, _ position: Double) -> [String: Any] {
            ["source": ["mediaId": id, "name": id, "mediaType": "audio"], "status": ["kind": kind], "positionSec": position, "durationSec": 100.0]
        }
        history.record(snapshot: state("a", "playing", 20))
        let old = (history.snapshot()["pending"] as! [[String: Any]])[0]["id"] as! String
        history.record(snapshot: state("a", "ended", 100))
        history.acknowledge(ids: [old])
        history.record(snapshot: state("b", "playing", 10))
        let restored = ApplePlaybackHistory(file: file)
        let pending = restored.snapshot()["pending"] as! [[String: Any]]
        precondition(pending.count == 2)
        precondition(pending[0]["completed"] as? Bool == true)
        precondition((pending[0]["source"] as? [String: Any])?["mediaId"] as? String == "a")
        restored.acknowledge(ids: pending.map { $0["id"] as! String })
        precondition((ApplePlaybackHistory(file: file).snapshot()["pending"] as! [[String: Any]]).isEmpty)
        var boundary = state("b", "paused", 15)
        boundary["historyBoundary"] = true
        history.record(snapshot: boundary)
        history.record(snapshot: state("b", "playing", 0))
        let repeated = history.snapshot()["pending"] as! [[String: Any]]
        precondition(repeated.count == 3)
        precondition(Set(repeated.compactMap { $0["session"] as? String }).count == 3)
        print("ApplePlaybackHistoryTests passed")
    }
}
