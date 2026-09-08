import Foundation

func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw NSError(domain: message, code: 1) }
}

@main struct VideoIndexProxyTests {
    static func main() async throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1])
        let origin = URL(string: CommandLine.arguments[2])!
        let cacheRoot = root.appendingPathComponent("cache")
        let proxy = try VideoIndexProxy(origin: origin, cacheRoot: cacheRoot)
        let base: URL? = await withCheckedContinuation { continuation in proxy.start { continuation.resume(returning: $0) } }
        guard let base else { fatalError("proxy did not start") }
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 10
        let session = URLSession(configuration: config)
        func get(_ id: String = "video", range: String? = nil, method: String = "GET", ifRange: String? = nil, extra: [String: String] = [:]) async throws -> (Data, HTTPURLResponse) {
            var request = URLRequest(url: base.appendingPathComponent("api/media/" + id))
            request.httpMethod = method
            request.setValue(range, forHTTPHeaderField: "Range")
            request.setValue(ifRange, forHTTPHeaderField: "If-Range")
            for (key, value) in extra { request.setValue(value, forHTTPHeaderField: key) }
            let (data, response) = try await session.data(for: request)
            return (data, response as! HTTPURLResponse)
        }
        let (probe, probeResponse) = try await get(range: "bytes=0-1")
        try require(probe.count == 2 && probeResponse.statusCode == 206, "Safari probe response")
        let probeLog = try String(contentsOf: root.appendingPathComponent("requests.log"), encoding: .utf8)
        try require(!probeLog.contains("index="), "Safari probe fetched index")
        for field in ["If-Match", "If-Unmodified-Since"] {
            let (_, conditional) = try await get(range: "bytes=0-3", extra: [field: "reject-me"])
            try require(conditional.statusCode == 412, "conditional header was dropped")
        }
        // Constructing another proxy during a server transition must not delete
        // staging data owned by the shared cache's active fill.
        let activeStage = cacheRoot.appendingPathComponent(".download-active")
        try Data([1]).write(to: activeStage)
        var replacement: VideoIndexProxy? = try VideoIndexProxy(origin: origin, cacheRoot: cacheRoot)
        weak var releasedProxy = replacement
        try require(FileManager.default.fileExists(atPath: activeStage.path), "new proxy removed active staging file")
        let _: URL? = await withCheckedContinuation { continuation in replacement!.start { continuation.resume(returning: $0) } }
        replacement?.stop(); replacement = nil
        try await Task.sleep(nanoseconds: 100_000_000)
        try require(releasedProxy == nil, "stopped proxy retained by listener")
        try FileManager.default.removeItem(at: activeStage)
        let (cold, coldResponse) = try await get(range: "bytes=0-2098175")
        try require(coldResponse.statusCode == 206 && cold.count == 2098176, "cold composition size")
        try require(cold.prefix(1024).allSatisfy { $0 == 65 } && cold.dropFirst(1024).allSatisfy { $0 == 66 }, "cold composition bytes")
        let (warm, warmResponse) = try await get(range: "bytes=100-199")
        try require(warmResponse.statusCode == 206 && warm == Data(repeating: 65, count: 100) && warmResponse.value(forHTTPHeaderField: "X-Muzio-Index-Cache") == "hit", "warm prefix")
        let beforeTail = try String(contentsOf: root.appendingPathComponent("requests.log"), encoding: .utf8)
        _ = try await get(range: "bytes=16778240-16779263")
        let afterTail = try String(contentsOf: root.appendingPathComponent("requests.log"), encoding: .utf8)
        try require(beforeTail.components(separatedBy: "index=manifest").count == afterTail.components(separatedBy: "index=manifest").count, "tail seek issued manifest")
        let (composed, composedResponse) = try await get(range: "bytes=16777728-16778751")
        try require(composedResponse.statusCode == 206 && composed == Data(repeating: 66, count: 1024), "expanded prefix and remote tail composition")
        let beforeStartup = try String(contentsOf: root.appendingPathComponent("requests.log"), encoding: .utf8)
        let (startup, startupResponse) = try await get(range: "bytes=1024-1049599")
        try require(startup == Data(repeating: 66, count: 1048576) && startupResponse.value(forHTTPHeaderField: "X-Muzio-Index-Cache") == "hit", "startup body not cached")
        let afterStartup = try String(contentsOf: root.appendingPathComponent("requests.log"), encoding: .utf8)
        let startupRequests = String(afterStartup.dropFirst(beforeStartup.count)).split(separator: "\n")
        try require(startupRequests.count == 1 && startupRequests[0].contains("index=manifest"), "warm startup body fetched upstream media or skipped freshness")
        // An old index-only entry upgrades by fetching just the startup body.
        let original = VideoIndexManifest(eligible: true, revision: String(repeating: "a", count: 64), fileSize: 20 * 1024 * 1024, indexBytes: 1024, mimeType: "video/mp4", modifiedAt: "Mon, 07 Sep 2026 00:00:00 GMT")
        let upgradeKey = VideoIndexDiskCache.hash(origin.absoluteString + "\n/api/media/upgrade")
        let originalCache = try VideoIndexDiskCache(root: cacheRoot)
        let originalFile = root.appendingPathComponent("original-index")
        try Data(repeating: 65, count: 1024).write(to: originalFile)
        try originalCache.install(key: upgradeKey, manifest: original, temporary: originalFile)
        let (upgraded, _) = try await get("upgrade", range: "bytes=0-2047")
        try require(upgraded == Data(repeating: 65, count: 1024) + Data(repeating: 66, count: 1024), "original index upgrade bytes")
        let upgradeLog = try String(contentsOf: root.appendingPathComponent("requests.log"), encoding: .utf8)
        try require(!upgradeLog.contains("/upgrade?index=data"), "upgrade redownloaded original index")
        let expanded = originalCache.lookup(key: upgradeKey, manifest: original.startupManifest)
        try require(expanded != nil, "upgrade did not publish expanded prefix"); try expanded?.close()
        let corruptFile = try FileHandle(forWritingTo: cacheRoot.appendingPathComponent(upgradeKey).appendingPathComponent("prefix"))
        try corruptFile.seek(toOffset: 1024); try corruptFile.write(contentsOf: Data([9])); try corruptFile.close()
        let (repairedStartup, _) = try await get("upgrade", range: "bytes=1024-2047")
        try require(repairedStartup == Data(repeating: 66, count: 1024), "corrupt startup body was served")
        let repairLog = try String(contentsOf: root.appendingPathComponent("requests.log"), encoding: .utf8)
        try require(repairLog.components(separatedBy: "/upgrade?index=data").count - 1 == 1, "corrupt expanded cache was not rebuilt")
        let (_, invalidStartup) = try await get("badstartup", range: "bytes=0-2047")
        try require(invalidStartup.value(forHTTPHeaderField: "X-Muzio-Index-Cache") == nil, "revision mismatch startup was composed")
        let invalidKey = VideoIndexDiskCache.hash(origin.absoluteString + "\n/api/media/badstartup")
        try require(!FileManager.default.fileExists(atPath: cacheRoot.appendingPathComponent(invalidKey).path), "revision mismatch startup was published")
        let (dated, dateResponse) = try await get(range: "bytes=0-3", ifRange: "Mon, 07 Sep 2026 00:00:00 GMT")
        try require(dateResponse.statusCode == 206 && dated.count == 4, "matching If-Range date")
        let (_, head) = try await get(method: "HEAD")
        try require(head.statusCode == 200, "HEAD passthrough")
        let (suffix, _) = try await get(range: "bytes=-4")
        try require(suffix == Data(repeating: 66, count: 4), "suffix passthrough")
        let (_, conditional) = try await get(range: "bytes=0-3", ifRange: "some-validator")
        try require(conditional.statusCode == 200, "If-Range passthrough")
        let (_, unsupported) = try await get("unsupported", range: "bytes=0-3")
        try require(unsupported.statusCode == 206, "unsupported direct")
        let log = try String(contentsOf: root.appendingPathComponent("requests.log"), encoding: .utf8)
        try require(log.components(separatedBy: "/video?index=data").count - 1 == 1, "warm cache redownloaded index")
        try "2".write(to: root.appendingPathComponent("revision"), atomically: true, encoding: .utf8)
        let (changed, _) = try await get(range: "bytes=0-3")
        try require(changed == Data(repeating: 67, count: 4), "revision invalidation")
        // A server revision change between manifest and tail must never publish a
        // response assembled from two versions.
        let (_, mismatch) = try await get("race", range: "bytes=0-18874367")
        try require(mismatch.statusCode == 502, "tail revision mismatch was composed")
        // A disconnected slow transfer must not keep an upstream connection alive.
        var slow = URLRequest(url: base.appendingPathComponent("api/media/slow"))
        slow.setValue("bytes=16778240-", forHTTPHeaderField: "Range")
        let task = session.dataTask(with: slow); task.resume()
        try await Task.sleep(nanoseconds: 300_000_000); task.cancel()
        try await Task.sleep(nanoseconds: 500_000_000)
        try require(FileManager.default.fileExists(atPath: root.appendingPathComponent("canceled").path), "upstream cancellation")
        proxy.stop(); session.invalidateAndCancel()
        try testLRU(root: root.appendingPathComponent("lru"))
        try require(original.startupManifest.indexBytes == 1024 + 16 * 1024 * 1024, "startup extent")
        let capped = VideoIndexManifest(eligible: true, revision: original.revision, fileSize: 256 * 1024 * 1024, indexBytes: 120 * 1024 * 1024, mimeType: original.mimeType, modifiedAt: original.modifiedAt)
        try require(capped.startupManifest.indexBytes == 128 * 1024 * 1024, "startup exceeds prefix cap")
        let short = VideoIndexManifest(eligible: true, revision: original.revision, fileSize: 2048, indexBytes: 1024, mimeType: original.mimeType, modifiedAt: original.modifiedAt)
        try require(short.startupManifest.indexBytes == short.fileSize, "startup exceeds file size")
        print("VideoIndexProxyTests passed: startup reuse and upgrade, composition, revision, passthrough, cancellation, LRU and corruption")
    }
    static func testLRU(root: URL) throws {
        var hashes = 0
        let cache = try VideoIndexDiskCache(root: root, maxEntries: 2, maxBytes: 8, digestFile: { file in
            hashes += 1; return try VideoIndexDiskCache.digest(file)
        })
        let manifest = VideoIndexManifest(eligible: true, revision: String(repeating: "a", count: 64), fileSize: 20, indexBytes: 4, mimeType: "video/mp4", modifiedAt: "Mon, 07 Sep 2026 00:00:00 GMT")
        let temporary = root.appendingPathComponent(".input")
        try Data([1,2,3,4]).write(to: temporary)
        for key in ["a", "b"] { try Data([1,2,3,4]).write(to: temporary); try cache.install(key: key, manifest: manifest, temporary: temporary); Thread.sleep(forTimeInterval: 0.02) }
        let hit = cache.lookup(key: "a", manifest: manifest); try require(hit != nil, "LRU hit"); try hit?.close()
        try require(hashes == 2, "warm lookup rehashed prefix")
        Thread.sleep(forTimeInterval: 0.02)
        try Data([1,2,3,4]).write(to: temporary)
        try cache.install(key: "c", manifest: manifest, temporary: temporary)
        try require(cache.lookup(key: "b", manifest: manifest) == nil, "LRU promotion")
        try Data([9,9,9,9]).write(to: root.appendingPathComponent("a/prefix"))
        try require(cache.lookup(key: "a", manifest: manifest) == nil, "corrupt index accepted")
        try require(hashes == 4, "changed prefix did not revalidate")
        let restored = try VideoIndexDiskCache(root: root, maxEntries: 2, maxBytes: 8, digestFile: { file in
            hashes += 1; return try VideoIndexDiskCache.digest(file)
        })
        let persisted = restored.lookup(key: "c", manifest: manifest); try require(persisted != nil, "persistent entry"); try persisted?.close()
        try require(hashes == 5, "restart skipped disk verification")
        let again = restored.lookup(key: "c", manifest: manifest); try again?.close()
        try require(hashes == 5, "restored warm hit rehashed")
        try Data("bad".utf8).write(to: root.appendingPathComponent("c/record.json"))
        try require(restored.lookup(key: "c", manifest: manifest) == nil, "changed record accepted")
        let small = try VideoIndexDiskCache(root: root.appendingPathComponent("small"), maxEntries: 5, maxBytes: 4)
        try Data([1,2,3,4]).write(to: temporary)
        try small.install(key: "a", manifest: manifest, temporary: temporary)
        try Data([1,2,3,4]).write(to: temporary)
        try small.install(key: "b", manifest: manifest, temporary: temporary)
        try require(small.lookup(key: "a", manifest: manifest) == nil, "byte cap")
    }
}
