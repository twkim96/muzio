import Foundation
import CryptoKit

/// Atomic desired-state outbox. Native edits survive page and app recreation.
@MainActor
final class AppleNotificationLikeStore {
    private struct Change: Codable { let id: String; let key: String; let liked: Bool }
    private struct State: Codable { var keys: Set<String> = []; var pending: [Change] = [] }
    private let file: URL
    private var state: State
    init(origin: URL, directory: URL? = nil) throws {
        let root = try directory ?? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("Muzio/NotificationLikes")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let key = SHA256.hash(data: Data(origin.absoluteString.utf8)).map { String(format: "%02x", $0) }.joined()
        file = root.appendingPathComponent(key + ".json")
        state = FileManager.default.fileExists(atPath: file.path) ? try JSONDecoder().decode(State.self, from: Data(contentsOf: file)) : State()
    }
    func snapshot() -> [String: Any] { ["pending": state.pending.map { ["id": $0.id, "key": $0.key, "liked": $0.liked] as [String: Any] }] }
    func isLiked(_ key: String) -> Bool { state.keys.contains(key) }
    func toggle(_ key: String) throws {
        guard !key.isEmpty else { return }
        var next = state
        let liked = !next.keys.contains(key)
        if liked { next.keys.insert(key) } else { next.keys.remove(key) }
        next.pending.append(Change(id: UUID().uuidString, key: key, liked: liked))
        try save(next)
    }
    func sync(keys: Set<String>, acknowledged: Set<String>) throws -> [String: Any] {
        var next = State(keys: keys, pending: state.pending.filter { !acknowledged.contains($0.id) })
        for change in next.pending { if change.liked { next.keys.insert(change.key) } else { next.keys.remove(change.key) } }
        try save(next)
        return snapshot()
    }
    private func save(_ next: State) throws {
        try JSONEncoder().encode(next).write(to: file, options: .atomic)
        state = next
    }
}
