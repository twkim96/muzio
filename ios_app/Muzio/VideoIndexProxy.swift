import Foundation
import Network
import CryptoKit

enum VideoIndexTrace {
    private static let lock = NSLock()
    static func write(_ message: String) {
        #if DEBUG
        lock.lock(); defer { lock.unlock() }
        guard let root = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else { return }
        let directory = root.appendingPathComponent("Muzio")
        let file = directory.appendingPathComponent("video-index-trace.log")
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let line = Data(String(format: "%.3f %@\n", Date().timeIntervalSince1970, String(message.prefix(1024))).utf8)
            var data = (try? Data(contentsOf: file)) ?? Data()
            if data.count + line.count > 64 * 1024 {
                data = Data(data.suffix(32 * 1024))
                if let newline = data.firstIndex(of: 10) { data.removeSubrange(...newline) }
            }
            data.append(line)
            try data.write(to: file, options: .atomic)
        } catch { /* Diagnostics must never interrupt playback. */ }
        #endif
    }
}

struct VideoIndexManifest: Codable {
    let eligible: Bool
    let revision: String
    let fileSize: Int64
    let indexBytes: Int64
    let mimeType: String
    let modifiedAt: String
    var startupManifest: VideoIndexManifest {
        VideoIndexManifest(eligible: eligible, revision: revision, fileSize: fileSize,
                           indexBytes: min(fileSize, min(128 * 1024 * 1024, indexBytes + 16 * 1024 * 1024)),
                           mimeType: mimeType, modifiedAt: modifiedAt)
    }
    var valid: Bool {
        revision.count == 64 && revision.allSatisfy { $0.isHexDigit } && fileSize > 0 &&
        indexBytes > 0 && indexBytes <= 128 * 1024 * 1024 && indexBytes <= fileSize &&
        ["video/mp4", "video/quicktime"].contains(mimeType)
    }
}

// Each entry is a directory atomically renamed only after a complete prefix is
// downloaded. The digest detects damaged files; origin and revision isolate data.
final class VideoIndexDiskCache {
    struct Record: Codable { let manifest: VideoIndexManifest; let digest: String }
    private let root: URL
    private let lock = NSLock()
    let fillLock = NSLock()
    private struct Fingerprint: Equatable {
        let size: UInt64
        let modified: Date
        let identity: UInt64
    }
    private func fingerprint(_ url: URL) -> Fingerprint? {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
              let size = attrs[.size] as? UInt64, let modified = attrs[.modificationDate] as? Date,
              let identity = attrs[.systemFileNumber] as? UInt64 else { return nil }
        return Fingerprint(size: size, modified: modified, identity: identity)
    }
    private struct Verification: Equatable { let prefix: Fingerprint; let record: Fingerprint }
    private var verified: [String: Verification] = [:]
    private let digestFile: (URL) throws -> String
    private let maxEntries: Int
    private let maxBytes: Int64
    init(root: URL, maxEntries: Int = 5, maxBytes: Int64 = 640 * 1024 * 1024, digestFile: @escaping (URL) throws -> String = VideoIndexDiskCache.digest) throws {
        self.digestFile = digestFile
        self.root = root; self.maxEntries = maxEntries; self.maxBytes = maxBytes
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        // Only abandoned staging files are disposable; committed entries survive
        // launches. Active transfers are stopped before WebHost changes origin.
        for entry in (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? [] where entry.lastPathComponent.hasPrefix(".tmp-") || entry.lastPathComponent.hasPrefix(".download-") {
            try? FileManager.default.removeItem(at: entry)
        }
    }
    static func hash(_ value: String) -> String { SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined() }
    private func readRecord(_ directory: URL) -> Record? {
        let url = directory.appendingPathComponent("record.json")
        guard let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 16 * 1024,
              let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(Record.self, from: data)
    }
    func indexBytesAndPromote(key: String) -> Int64? {
        lock.lock(); defer { lock.unlock() }
        let directory = root.appendingPathComponent(key)
        guard let record = readRecord(directory), record.manifest.valid else { return nil }
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: directory.path)
        return record.manifest.indexBytes
    }
    // Called while fillLock is held: reserve space before the one active fill.
    func temporaryFile(reserving bytes: Int64) throws -> URL {
        lock.lock(); defer { lock.unlock() }
        var entries = try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: [.contentModificationDateKey], options: [.skipsHiddenFiles])
        entries.sort { ((try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) > ((try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) }
        var retained = bytes
        for entry in entries {
            let size = Int64((try? entry.appendingPathComponent("prefix").resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
            if retained + size > maxBytes { verified.removeValue(forKey: entry.lastPathComponent); try? FileManager.default.removeItem(at: entry) } else { retained += size }
        }
        return root.appendingPathComponent(".download-" + UUID().uuidString)
    }
    static func digest(_ file: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: file); defer { try? handle.close() }
        var hash = SHA256()
        while let data = try handle.read(upToCount: 64 * 1024), !data.isEmpty { hash.update(data: data) }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
    func lookup(key: String, manifest: VideoIndexManifest) -> FileHandle? {
        lock.lock(); defer { lock.unlock() }
        let directory = root.appendingPathComponent(key)
        let file = directory.appendingPathComponent("prefix")
        guard let record = readRecord(directory), record.manifest.valid,
              record.manifest.revision == manifest.revision, record.manifest.indexBytes == manifest.indexBytes else { return nil }
        guard let prefixStamp = fingerprint(file), prefixStamp.size == manifest.indexBytes,
              let recordStamp = fingerprint(directory.appendingPathComponent("record.json")),
              verified[key] == Verification(prefix: prefixStamp, record: recordStamp) || (try? digestFile(file)) == record.digest,
              let handle = try? FileHandle(forReadingFrom: file) else {
            verified.removeValue(forKey: key); try? FileManager.default.removeItem(at: directory); return nil
        }
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: directory.path)
        verified[key] = Verification(prefix: prefixStamp, record: recordStamp)
        return handle
    }
    func install(key: String, manifest: VideoIndexManifest, temporary: URL) throws {
        guard manifest.valid, let size = try temporary.resourceValues(forKeys: [.fileSizeKey]).fileSize,
              Int64(size) == manifest.indexBytes else { throw ProxyError.invalid }
        let staged = root.appendingPathComponent(".tmp-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: staged, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: staged) }
        try FileManager.default.moveItem(at: temporary, to: staged.appendingPathComponent("prefix"))
        let record = Record(manifest: manifest, digest: try digestFile(staged.appendingPathComponent("prefix")))
        try JSONEncoder().encode(record).write(to: staged.appendingPathComponent("record.json"), options: .atomic)
        lock.lock(); defer { lock.unlock() }
        let destination = root.appendingPathComponent(key)
        try? FileManager.default.removeItem(at: destination)
        try FileManager.default.moveItem(at: staged, to: destination)
        if let prefix = fingerprint(destination.appendingPathComponent("prefix")), let record = fingerprint(destination.appendingPathComponent("record.json")) {
            verified[key] = Verification(prefix: prefix, record: record)
        } else { verified.removeValue(forKey: key) }
        var entries = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: [.contentModificationDateKey], options: [.skipsHiddenFiles])) ?? []
        entries.sort { ((try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) > ((try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) }
        var bytes: Int64 = 0
        for (index, entry) in entries.enumerated() {
            let count = Int64((try? entry.appendingPathComponent("prefix").resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
            bytes += count
            if index >= maxEntries || bytes > maxBytes { verified.removeValue(forKey: entry.lastPathComponent); try? FileManager.default.removeItem(at: entry) }
        }
    }
}

enum ProxyError: Error { case invalid, canceled, timeout }

// A serial delegate applies socket backpressure before accepting the next data
// callback. URLSession never accumulates an entire open-ended video in Data.
private final class ProxyTransfer: NSObject, URLSessionDataDelegate {
    let response: (HTTPURLResponse) throws -> Void
    let consume: (Data) throws -> Void
    let done = DispatchSemaphore(value: 0)
    var failure: Error?
    init(response: @escaping (HTTPURLResponse) throws -> Void, consume: @escaping (Data) throws -> Void) {
        self.response = response; self.consume = consume
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        do { guard let http = response as? HTTPURLResponse else { throw ProxyError.invalid }; try self.response(http); completionHandler(.allow) }
        catch { failure = error; completionHandler(.cancel) }
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        dataTask.suspend()
        do { try consume(data); dataTask.resume() } catch { failure = error; dataTask.cancel() }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) { if failure == nil { failure = error }; done.signal() }
}

final class VideoIndexProxy {
    private static let cacheLock = NSLock()
    private static var caches: [String: VideoIndexDiskCache] = [:]
    // A cache root has one owner for the application lifetime. Origin changes
    // reuse its fill lock and cannot clean another transfer's staging files.
    private static func sharedCache(_ root: URL) throws -> VideoIndexDiskCache {
        cacheLock.lock(); defer { cacheLock.unlock() }
        let key = root.standardizedFileURL.path
        if let cache = caches[key] { return cache }
        let cache = try VideoIndexDiskCache(root: root)
        caches[key] = cache
        return cache
    }
    private let origin: URL
    private let cache: VideoIndexDiskCache
    private let token = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    private let queue = DispatchQueue(label: "muzio.video-index.listener")
    private var listener: NWListener?
    private var clients: [UUID: ProxyClient] = [:]
    init(origin: URL, cacheRoot: URL? = nil) throws {
        self.origin = origin
        let root = cacheRoot ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("Muzio/video-index-v1")
        cache = try Self.sharedCache(root)
    }
    func start(completion: @escaping (URL?) -> Void) {
        queue.async {
            do {
                let parameters = NWParameters.tcp
                parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
                let listener = try NWListener(using: parameters)
                self.listener = listener
                var reported = false
                listener.stateUpdateHandler = { [weak self, weak listener] state in
                    guard let self, let listener else { return }
                    switch state {
                    case .ready:
                        // Older WebKit allows localhost media from HTTPS pages but blocks numeric loopback IPs.
                        if !reported { reported = true; completion(listener.port.flatMap { URL(string: "http://localhost:\($0.rawValue)/\(self.token)/") }) }
                    case .failed, .cancelled:
                        if !reported { reported = true; completion(nil) }
                    default: break
                    }
                }
                listener.newConnectionHandler = { [weak self] connection in
                    guard let self else { connection.cancel(); return }
                    guard self.clients.count < 16 else { connection.cancel(); return }
                    let id = UUID()
                    let client = ProxyClient(connection: connection, origin: self.origin, token: self.token, cache: self.cache) { [weak self] in self?.queue.async { [weak self] in self?.clients.removeValue(forKey: id) } }
                    self.clients[id] = client; client.start()
                }
                listener.start(queue: self.queue)
                self.queue.asyncAfter(deadline: .now() + 5) { [weak listener] in
                    guard let listener else { return }
                    if !reported { reported = true; listener.cancel(); completion(nil) }
                }
            } catch { completion(nil) }
        }
    }
    func stop() { queue.async {
        self.listener?.stateUpdateHandler = nil
        self.listener?.newConnectionHandler = nil
        self.listener?.cancel(); self.listener = nil
        for client in self.clients.values { client.cancel() }
        self.clients.removeAll()
    } }
}

private final class ProxyClient {
    private let connection: NWConnection
    private let origin: URL
    private let token: String
    private let cache: VideoIndexDiskCache
    private let finished: () -> Void
    private let ioQueue = DispatchQueue(label: "muzio.video-index.socket", attributes: .concurrent)
    private let lock = NSLock()
    private var stopped = false
    private var receivedRequest = false
    private var session: URLSession?
    private var headersSent = false
    private var cacheHit = false
    init(connection: NWConnection, origin: URL, token: String, cache: VideoIndexDiskCache, finished: @escaping () -> Void) {
        self.connection = connection; self.origin = origin; self.token = token; self.cache = cache; self.finished = finished
    }
    func start() {
        connection.stateUpdateHandler = { [weak self] state in if case .failed = state { self?.cancel() } }
        connection.start(queue: ioQueue); receive(Data())
        ioQueue.asyncAfter(deadline: .now() + 10) { self.lock.lock(); let accepted = self.receivedRequest; self.lock.unlock(); if !accepted { self.cancel() } }
    }
    func cancel() { lock.lock(); let wasStopped = stopped; stopped = true; let active = session; lock.unlock(); active?.invalidateAndCancel(); connection.cancel(); if !wasStopped { finished() } }
    private func check() throws { lock.lock(); defer { lock.unlock() }; if stopped { throw ProxyError.canceled } }
    private func receive(_ accumulated: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) { data, _, complete, error in
            var next = accumulated; if let data { next.append(data) }
            guard next.count <= 16 * 1024, error == nil else { self.cancel(); return }
            if let end = next.range(of: Data("\r\n\r\n".utf8)) {
                self.lock.lock(); self.receivedRequest = true; self.lock.unlock()
                let header = next[..<end.lowerBound]
                self.connection.receive(minimumIncompleteLength: 1, maximumLength: 1) { _, _, _, _ in self.cancel() }
                DispatchQueue.global(qos: .userInitiated).async { self.handle(Data(header)) }
            } else if complete { self.cancel() } else { self.receive(next) }
        }
    }
    private func send(_ data: Data) throws {
        try check()
        let done = DispatchSemaphore(value: 0)
        var failed = false
        connection.send(content: data, completion: .contentProcessed { error in failed = error != nil; done.signal() })
        guard done.wait(timeout: .now() + 30) == .success, !failed else { throw ProxyError.timeout }
    }
    private func headers(status: Int, values: [String: String]) throws {
        var text = "HTTP/1.1 \(status) \(HTTPURLResponse.localizedString(forStatusCode: status))\r\nConnection: close\r\n"
        for (key, value) in values where !value.contains("\r") && !value.contains("\n") { text += "\(key): \(value)\r\n" }
        try send(Data((text + "\r\n").utf8)); headersSent = true
    }
    private func transfer(_ request: URLRequest, response: @escaping (HTTPURLResponse) throws -> Void, consume: @escaping (Data) throws -> Void) throws {
        try check()
        let delegate = ProxyTransfer(response: response, consume: consume)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil; configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 30
        let delegates = OperationQueue(); delegates.maxConcurrentOperationCount = 1
        let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: delegates)
        lock.lock(); self.session = session; let canceled = stopped; lock.unlock()
        defer { session.invalidateAndCancel(); lock.lock(); self.session = nil; lock.unlock() }
        if canceled { throw ProxyError.canceled }
        session.dataTask(with: request).resume()
        delegate.done.wait()
        if let error = delegate.failure { throw error }
    }
    private func request(_ url: URL, method: String = "GET", range: String? = nil) -> URLRequest {
        var request = URLRequest(url: url); request.httpMethod = method; request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        if let range { request.setValue(range, forHTTPHeaderField: "Range") }
        return request
    }
    private func manifest(_ url: URL) throws -> VideoIndexManifest {
        var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)!; parts.queryItems = [URLQueryItem(name: "index", value: "manifest")]
        var body = Data()
        try transfer(request(parts.url!), response: { if $0.statusCode != 200 { throw ProxyError.invalid } }, consume: { data in guard body.count + data.count <= 16 * 1024 else { throw ProxyError.invalid }; body.append(data) })
        return try JSONDecoder().decode(VideoIndexManifest.self, from: body)
    }
    private func prefix(_ url: URL, manifest: VideoIndexManifest, original: VideoIndexManifest) throws -> FileHandle {
        let key = VideoIndexDiskCache.hash(origin.absoluteString + "\n" + url.path)
        try check()
        if let hit = cache.lookup(key: key, manifest: manifest) { cacheHit = true; return hit }
        cache.fillLock.lock(); defer { cache.fillLock.unlock() }
        try check()
        if let hit = cache.lookup(key: key, manifest: manifest) { cacheHit = true; return hit }
        // Keep the original index open while reserving space for its replacement.
        let existing = cache.lookup(key: key, manifest: original)
        defer { try? existing?.close() }
        let temporary = try cache.temporaryFile(reserving: manifest.indexBytes)
        FileManager.default.createFile(atPath: temporary.path, contents: nil)
        defer { try? FileManager.default.removeItem(at: temporary) }
        let output = try FileHandle(forWritingTo: temporary); defer { try? output.close() }
        var count: Int64 = 0
        func append(_ data: Data) throws {
            count += Int64(data.count)
            guard count <= manifest.indexBytes else { throw ProxyError.invalid }
            try output.write(contentsOf: data)
        }
        if let existing {
            while let data = try existing.read(upToCount: 64 * 1024), !data.isEmpty { try check(); try append(data) }
        } else {
            var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)!
            parts.queryItems = [URLQueryItem(name: "index", value: "data"), URLQueryItem(name: "revision", value: original.revision)]
            try transfer(request(parts.url!), response: { response in
                guard response.statusCode == 200, response.expectedContentLength == original.indexBytes,
                      response.value(forHTTPHeaderField: "X-Muzio-Revision") == original.revision else { throw ProxyError.invalid }
            }, consume: append)
        }
        guard count == original.indexBytes else { throw ProxyError.invalid }
        if manifest.indexBytes > original.indexBytes {
            let start = original.indexBytes; let end = manifest.indexBytes - 1
            var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)!
            parts.queryItems = (parts.queryItems ?? []).filter { $0.name != "index_revision" } + [URLQueryItem(name: "index_revision", value: original.revision)]
            try transfer(request(parts.url!, range: "bytes=\(start)-\(end)"), response: { response in
                guard response.statusCode == 206, response.value(forHTTPHeaderField: "X-Muzio-Revision") == original.revision,
                      response.value(forHTTPHeaderField: "Content-Range") == "bytes \(start)-\(end)/\(original.fileSize)",
                      response.expectedContentLength == end - start + 1 else { throw ProxyError.invalid }
            }, consume: append)
        }
        guard count == manifest.indexBytes else { throw ProxyError.invalid }
        try output.synchronize(); try cache.install(key: key, manifest: manifest, temporary: temporary)
        guard let handle = cache.lookup(key: key, manifest: manifest) else { throw ProxyError.invalid }; return handle
    }
    private func sendPrefix(_ handle: FileHandle, start: Int64, end: Int64) throws {
        guard start <= end else { return }; try handle.seek(toOffset: UInt64(start)); var remaining = end - start + 1
        while remaining > 0 { try check(); guard let data = try handle.read(upToCount: Int(min(remaining, 64 * 1024))), !data.isEmpty else { throw ProxyError.invalid }; try send(data); remaining -= Int64(data.count) }
    }
    private func passthrough(_ url: URL, method: String, fields: [String: String]) throws {
        var upstream = request(url, method: method, range: fields["range"])
        for key in ["if-range", "if-none-match", "if-modified-since", "if-match", "if-unmodified-since"] { if let value = fields[key] { upstream.setValue(value, forHTTPHeaderField: key) } }
        try transfer(upstream, response: { response in
            var values = ["Cache-Control": "no-store"]
            for key in ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Last-Modified", "ETag", "X-Muzio-Revision"] { if let value = response.value(forHTTPHeaderField: key) { values[key] = value } }
            try self.headers(status: response.statusCode, values: values)
        }, consume: { if method != "HEAD" { try self.send($0) } })
    }
    private func handle(_ data: Data) {
        defer { cancel() }
        do {
            guard let text = String(data: data, encoding: .utf8) else { throw ProxyError.invalid }
            let lines = text.components(separatedBy: "\r\n"); let first = lines[0].split(separator: " ")
            guard first.count == 3, ["GET", "HEAD"].contains(String(first[0])), first[1].hasPrefix("/\(token)/api/media/") else { throw ProxyError.invalid }
            let method = String(first[0]); var fields: [String: String] = [:]
            for line in lines.dropFirst() { guard let colon = line.firstIndex(of: ":") else { throw ProxyError.invalid }; let key = line[..<colon].lowercased(); guard fields[key] == nil else { throw ProxyError.invalid }; fields[key] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces) }
            let relative = String(first[1].dropFirst(token.count + 1))
            guard let url = URL(string: relative, relativeTo: origin)?.absoluteURL, ServerPolicy.sameOrigin(url, origin), url.path.hasPrefix("/api/media/"), url.path.dropFirst(11).contains("/") == false, url.fragment == nil else { throw ProxyError.invalid }
            if fields["range"] == "bytes=0-1" {
                _ = cache.indexBytesAndPromote(key: VideoIndexDiskCache.hash(origin.absoluteString + "\n" + url.path))
                try passthrough(url, method: method, fields: fields); return
            }
            if method == "HEAD" || fields.keys.contains(where: { $0.hasPrefix("if-") && $0 != "if-range" }) || fields["range"]?.contains(",") == true || fields["range"]?.hasPrefix("bytes=-") == true {
                try passthrough(url, method: method, fields: fields); return
            }
            let key = VideoIndexDiskCache.hash(origin.absoluteString + "\n" + url.path)
            if let range = fields["range"], range.hasPrefix("bytes="), let lower = Int64(range.dropFirst(6).split(separator: "-", omittingEmptySubsequences: false).first ?? ""),
               let indexBytes = cache.indexBytesAndPromote(key: key), lower >= indexBytes {
                try passthrough(url, method: method, fields: fields); return
            }
            let original: VideoIndexManifest
            do { original = try manifest(url) } catch { try passthrough(url, method: method, fields: fields); return }
            guard original.eligible && original.valid else { try passthrough(url, method: method, fields: fields); return }
            let info = original.startupManifest
            if let validator = fields["if-range"], validator != info.modifiedAt { try passthrough(url, method: method, fields: fields); return }
            var start: Int64 = 0; var end = info.fileSize - 1
            if let range = fields["range"] {
                let parts = range.dropFirst(6).split(separator: "-", omittingEmptySubsequences: false)
                guard range.hasPrefix("bytes="), parts.count == 2, let lower = Int64(parts[0]), lower >= 0 else { try passthrough(url, method: method, fields: fields); return }
                start = lower
                if !parts[1].isEmpty { guard let upper = Int64(parts[1]), upper >= start else { try passthrough(url, method: method, fields: fields); return }; end = min(upper, end) }
            }
            guard start < info.indexBytes, start <= end else { try passthrough(url, method: method, fields: fields); return }
            let handle: FileHandle
            do { handle = try prefix(url, manifest: info, original: original) } catch { try passthrough(url, method: method, fields: fields); return }
            defer { try? handle.close() }
            var values = ["Content-Type": info.mimeType, "Content-Length": String(end - start + 1), "Accept-Ranges": "bytes", "Cache-Control": "no-store", "X-Muzio-Revision": info.revision, "X-Muzio-Index-Cache": cacheHit ? "hit" : "miss"]
            let status = fields["range"] == nil ? 200 : 206
            if status == 206 { values["Content-Range"] = "bytes \(start)-\(end)/\(info.fileSize)" }
            if end < info.indexBytes { try headers(status: status, values: values); try sendPrefix(handle, start: start, end: end); return }
            var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)!; parts.queryItems = (parts.queryItems ?? []).filter { $0.name != "index_revision" } + [URLQueryItem(name: "index_revision", value: info.revision)]
            let tailStart = info.indexBytes; var received: Int64 = 0
            try transfer(request(parts.url!, range: "bytes=\(tailStart)-\(end)"), response: { response in
                guard response.statusCode == 206, response.value(forHTTPHeaderField: "X-Muzio-Revision") == info.revision,
                      response.value(forHTTPHeaderField: "Content-Range") == "bytes \(tailStart)-\(end)/\(info.fileSize)", response.expectedContentLength == end-tailStart+1 else { throw ProxyError.invalid }
                try self.headers(status: status, values: values); try self.sendPrefix(handle, start: start, end: tailStart-1)
            }, consume: { data in received += Int64(data.count); guard received <= end-tailStart+1 else { throw ProxyError.invalid }; try self.send(data) })
            guard received == end-tailStart+1 else { throw ProxyError.invalid }
        } catch { if !headersSent { try? headers(status: 502, values: ["Content-Length": "0", "Cache-Control": "no-store"]) } }
    }
}
