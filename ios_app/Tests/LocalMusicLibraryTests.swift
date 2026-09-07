import Foundation

@main
struct LocalMusicLibraryTests {
    struct Failure: Error { let message: String }
    static func expect(_ value: Bool, _ message: String) throws { if !value { throw Failure(message: message) } }
    static func wait(_ library: LocalMusicLibrary, predicate: ([String: Any]) -> Bool) async throws -> [String: Any] {
        for _ in 0..<400 {
            let state = await library.snapshot()
            if predicate(state) { return state }
            try await Task.sleep(nanoseconds: 25_000_000)
        }
        throw Failure(message: "Timed out waiting for catalog")
    }
    static func main() async throws {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: base) }
        let root = base.appendingPathComponent("Music"), cache = base.appendingPathComponent("cache")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        for index in 0..<1001 { try Data().write(to: root.appendingPathComponent("Song \(index).wav")) }
        let outside = base.appendingPathComponent("outside.wav")
        try Data().write(to: outside)
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("escape.wav"), withDestinationURL: outside)
        let library = try LocalMusicLibrary(cacheDirectory: cache)
        let start = Date()
        let initial = try await library.add(root)
        try expect(Date().timeIntervalSince(start) < 2, "add waited for metadata")
        try expect((initial["enrichment"] as? [String: Any])?["scanning"] as? Bool == true, "add did not schedule scan")
        let listed = try await wait(library) { ($0["items"] as? [[String: Any]])?.count == 1001 }
        let roots = listed["roots"] as! [[String: Any]], rootID = roots[0]["id"] as! String
        let items = listed["items"] as! [[String: Any]]
        try expect(items.allSatisfy { $0["name"] as? String != "escape.wav" }, "symlink indexed")
        try expect((listed["enrichment"] as! [String: Any])["pending"] as! Int > 0, "filename listing waited for enrichment")
        try expect(items[0]["modifiedAt"] is String, "modifiedAt must be ISO8601")
        let access = try library.resolve(mediaId: items[0]["id"] as! String)
        try expect(access.url.resolvingSymlinksInPath().path.hasPrefix(root.resolvingSymlinksInPath().path), "resolved outside root"); access.release(); access.release()
        do { _ = try library.resolve(mediaId: "local:../../outside.wav"); throw Failure(message: "unknown ID accepted") } catch is CocoaError { }
        let duplicate = try await library.add(root)
        try expect((duplicate["roots"] as! [[String: Any]]).count == 1, "duplicate root")
        _ = try await library.remove(id: rootID)
        try await Task.sleep(nanoseconds: 100_000_000)
        let removed = await library.snapshot()
        try expect((removed["items"] as! [[String: Any]]).isEmpty, "stale worker restored removed items")
        let restarted = try LocalMusicLibrary(cacheDirectory: cache)
        let persisted = await restarted.snapshot()
        try expect((persisted["roots"] as! [[String: Any]]).isEmpty, "remove not persisted")
        // Read a persisted pending catalog into an isolated cache to model process restart.
        _ = try await library.add(root)
        _ = try await wait(library) { ($0["items"] as? [[String: Any]])?.count == 1001 }
        let restartCache = base.appendingPathComponent("restart")
        try FileManager.default.createDirectory(at: restartCache, withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: cache.appendingPathComponent("catalog.json"), to: restartCache.appendingPathComponent("catalog.json"))
        let resumed = try LocalMusicLibrary(cacheDirectory: restartCache)
        let recovered = await resumed.snapshot()
        try expect((recovered["items"] as! [[String: Any]]).count == 1001, "pending membership lost at restart")
        let pendingBefore = (recovered["enrichment"] as! [String: Any])["pending"] as! Int
        try expect(pendingBefore > 0, "restart fixture did not contain pending metadata")
        _ = try await wait(resumed) { (($0["enrichment"] as! [String: Any])["pending"] as! Int) < pendingBefore }
        _ = try await library.remove(id: (recovered["roots"] as! [[String: Any]])[0]["id"] as! String)
        _ = try await resumed.remove(id: (recovered["roots"] as! [[String: Any]])[0]["id"] as! String)
        if CommandLine.arguments.count > 1 {
            let artworkRoot = base.appendingPathComponent("Artwork")
            try FileManager.default.createDirectory(at: artworkRoot, withIntermediateDirectories: true)
            try FileManager.default.copyItem(at: URL(fileURLWithPath: CommandLine.arguments[1]), to: artworkRoot.appendingPathComponent("cover.mp3"))
            _ = try await library.add(artworkRoot)
            let enriched = try await wait(library) {
                let status = $0["enrichment"] as! [String: Any]
                return status["scanning"] as? Bool == false && status["pending"] as? Int == 0
            }
            let song = (enriched["items"] as! [[String: Any]])[0]
            let thumbnail = song["thumbnail"] as? [String: Any]
            try expect(thumbnail?["kind"] as? String == "embedded-artwork", "artwork thumbnail shape")
            try expect(thumbnail?["status"] as? String == "ready", "artwork thumbnail status")
            try expect((thumbnail?["url"] as? String)?.hasPrefix("muzio-local://artwork/") == true, "artwork URL scheme")
            let artwork = try library.artwork(mediaId: song["id"] as! String)
            try expect(artwork?.starts(with: [0xff, 0xd8]) == true, "cached JPEG unavailable")
        }
        print("LocalMusicLibraryTests passed: 1001 files, fast list, duplicate, symlink, resolution, removal, restart")
    }
}
