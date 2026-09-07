import Foundation

/// A disk outbox independent of WKWebView lifetime. Accessed on the host main actor.
final class ApplePlaybackHistory {
    private let file: URL
    private var pending: [[String: Any]] = []
    private var activeKey: String?
    private var activeSession: String?
    private var startedAtMs: Double = 0
    private var previousEnded = false

    convenience init(origin: URL) {
        let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Muzio/PlaybackHistory", isDirectory: true)
        let key = Data(origin.absoluteString.utf8).base64EncodedString().replacingOccurrences(of: "/", with: "_")
        self.init(file: directory.appendingPathComponent(key + ".json"))
    }

    init(file: URL) {
        self.file = file
        if let data = try? Data(contentsOf: file),
           let saved = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
            pending = saved
        }
    }

    func record(snapshot: [String: Any]) {
        defer {
            if snapshot["historyBoundary"] as? Bool == true {
                activeKey = nil; activeSession = nil
            }
        }
        guard let source = snapshot["source"] as? [String: Any], let mediaId = source["mediaId"] as? String,
              let status = snapshot["status"] as? [String: Any], let kind = status["kind"] as? String else {
            activeKey = nil; activeSession = nil; return
        }
        let key = mediaId + "|" + (source["queueEntryId"] as? String ?? "")
        let position = (snapshot["positionSec"] as? NSNumber)?.doubleValue ?? 0
        let duration = (snapshot["durationSec"] as? NSNumber)?.doubleValue ?? 0
        guard position.isFinite, duration.isFinite else { return }
        let now = floor(Date().timeIntervalSince1970 * 1000)
        if key != activeKey || (previousEnded && kind != "ended") {
            activeKey = key; activeSession = nil
        }
        previousEnded = kind == "ended"
        // Loading a queue does not mean a track has actually played.
        if activeSession == nil {
            guard kind == "playing" || kind == "ended" else { return }
            activeSession = UUID().uuidString
            startedAtMs = max(now, startedAtMs + 1)
        }
        guard let session = activeSession else { return }
        let entry: [String: Any] = ["id": UUID().uuidString, "session": session, "source": source,
            "positionSec": max(0, position), "durationSec": max(0, duration), "completed": kind == "ended",
            "updatedAtMs": now, "startedAtMs": startedAtMs]
        var next = pending.filter { $0["session"] as? String != session }
        next.append(entry)
        persist(next)
    }

    func snapshot() -> [String: Any] { ["pending": pending] }

    @discardableResult
    func acknowledge(ids: [String]) -> [String: Any] {
        let acknowledged = Set(ids)
        persist(pending.filter { !acknowledged.contains($0["id"] as? String ?? "") })
        return snapshot()
    }

    private func persist(_ next: [[String: Any]]) {
        do {
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = try JSONSerialization.data(withJSONObject: next)
            try data.write(to: file, options: .atomic)
            pending = next
        } catch {
            // Keep unacknowledged durable entries if a disk operation fails.
            NSLog("Muzio playback history persistence failed: %@", error.localizedDescription)
        }
    }
}
