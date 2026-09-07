import Foundation
import AVFoundation
import ImageIO
import UniformTypeIdentifiers
import CryptoKit

final class LocalMusicAccess {
    let url: URL
    private let lock = NSLock()
    private var scopedRoot: URL?
    init(url: URL, scopedRoot: URL?) { self.url = url; self.scopedRoot = scopedRoot }
    func release() {
        lock.lock(); let root = scopedRoot; scopedRoot = nil; lock.unlock()
        root?.stopAccessingSecurityScopedResource()
    }
    deinit { release() }
}

/// Filename discovery precedes serial metadata loading. All state and persistence share one lock.
final class LocalMusicLibrary: @unchecked Sendable {
    private struct Root: Codable {
        var id: String; var name: String; var uri: String; var bookmark: Data
        var available = true; var error: String?; var needsScan = true
    }
    private struct Item: Codable {
        var id: String; var storageId: String; var rootName: String; var relativePath: String
        var name: String; var sizeBytes: Int64; var modifiedAt: Double
        var title: String?; var artist: String?; var album: String?; var duration: Double?
        var thumbnail: String?; var pending = true; var enrichmentError: String?
        var json: [String: Any] {
            var value: [String: Any] = ["id": id, "location": "local", "storageId": storageId,
                "type": "audio", "rootName": rootName, "relativePath": relativePath, "name": name,
                "sizeBytes": sizeBytes, "modifiedAt": Date(timeIntervalSince1970: modifiedAt / 1000).ISO8601Format()]
            var metadata: [String: Any] = [:]
            if let title { metadata["title"] = title }; if let artist { metadata["artist"] = artist }
            if let album { metadata["album"] = album }; if let duration { metadata["duration"] = duration; metadata["durationSec"] = duration }
            if let enrichmentError { value["enrichmentError"] = enrichmentError }; if !metadata.isEmpty { value["metadata"] = metadata }; if let thumbnail { value["thumbnail"] = ["url": thumbnail, "kind": "embedded-artwork", "status": "ready", "cacheKey": id + ":" + String(modifiedAt)] }
            return value
        }
    }
    private struct State: Codable { var roots: [Root] = []; var items: [Item] = [] }
    private let lock = NSLock()
    private let file: URL
    private var state: State
    private var revision = 0
    private var working = false
    private var persistenceError: String?
    private var unsavedEnrichment = 0
    private static let extensions: Set<String> = ["mp3", "m4a", "aac", "wav", "flac", "aif", "aiff", "alac", "ogg", "opus", "caf"]
    init(cacheDirectory: URL? = nil) throws {
        let directory = try cacheDirectory ?? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("Muzio/LocalMusic", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        file = directory.appendingPathComponent("catalog.json")
        state = FileManager.default.fileExists(atPath: file.path) ? try JSONDecoder().decode(State.self, from: Data(contentsOf: file)) : State()
    }
    private func locked<T>(_ action: () throws -> T) rethrows -> T { lock.lock(); defer { lock.unlock() }; return try action() }
    private func persist() throws { try JSONEncoder().encode(state).write(to: file, options: .atomic); persistenceError = nil }
    private func saveBackground() { do { try persist() } catch { persistenceError = error.localizedDescription } }
    private static func bookmark(_ url: URL) throws -> Data {
        #if os(macOS)
        return try url.bookmarkData(options: [.withSecurityScope, .securityScopeAllowOnlyReadAccess], includingResourceValuesForKeys: nil, relativeTo: nil)
        #else
        return try url.bookmarkData(options: [.minimalBookmark], includingResourceValuesForKeys: nil, relativeTo: nil)
        #endif
    }
    private static func open(_ root: Root) throws -> (URL, Bool, Bool) {
        var stale = false
        #if os(macOS)
        let url = try URL(resolvingBookmarkData: root.bookmark, options: [.withSecurityScope, .withoutUI], relativeTo: nil, bookmarkDataIsStale: &stale)
        #else
        let url = try URL(resolvingBookmarkData: root.bookmark, options: [.withoutUI], relativeTo: nil, bookmarkDataIsStale: &stale)
        #endif
        let scoped = url.startAccessingSecurityScopedResource()
        return (url, scoped, stale)
    }
    private func schedule() {
        guard !working, state.roots.contains(where: { root in root.needsScan || (root.available && state.items.contains(where: { $0.storageId == root.id && $0.pending })) }) else { return }
        working = true
        Task.detached(priority: .utility) { [self] in await run() }
    }
    func snapshot() async -> [String: Any] { locked { schedule(); return json() } }
    private func json() -> [String: Any] {
        var result: [String: Any] = ["roots": state.roots.map { root -> [String: Any] in
            var value: [String: Any] = ["id": root.id, "name": root.name, "uri": "local:" + root.id, "available": root.available]
            if let error = root.error { value["error"] = error }; return value
        }, "items": state.items.map(\.json), "enrichment": ["pending": state.items.filter(\.pending).count, "total": state.items.count, "scanning": state.roots.contains(where: \.needsScan)]]
        if let persistenceError { result["error"] = persistenceError }; return result
    }
    func add(_ url: URL) async throws -> [String: Any] {
        let scoped = url.startAccessingSecurityScopedResource(); defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let canonical = url.standardizedFileURL.resolvingSymlinksInPath()
        guard try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey]).isDirectory == true,
              try url.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink != true else { throw CocoaError(.fileReadUnsupportedScheme) }
        let data = try Self.bookmark(canonical)
        return try locked {
            if let index = state.roots.firstIndex(where: { $0.uri == canonical.absoluteString }) {
                state.roots[index].bookmark = data; state.roots[index].needsScan = true
            } else { state.roots.append(Root(id: UUID().uuidString, name: canonical.lastPathComponent, uri: canonical.absoluteString, bookmark: data)) }
            revision += 1; try persist(); schedule(); return json()
        }
    }
    func refresh() async throws -> [String: Any] { try locked {
        revision += 1; for index in state.roots.indices { state.roots[index].needsScan = true }
        try persist(); schedule(); return json()
    } }
    func remove(id: String) async throws -> [String: Any] { try locked {
        revision += 1; state.roots.removeAll { $0.id == id }
        for item in state.items where item.storageId == id { try? FileManager.default.removeItem(at: artworkFile(item.id)) }
        state.items.removeAll { $0.storageId == id }
        try persist(); schedule(); return json()
    } }
    private static func contained(_ url: URL, in root: URL) -> Bool {
        let base = root.standardizedFileURL.resolvingSymlinksInPath().path + "/"
        return url.standardizedFileURL.resolvingSymlinksInPath().path.hasPrefix(base)
    }
    private func artworkFile(_ id: String) -> URL {
        let name = SHA256.hash(data: Data(id.utf8)).map { String(format: "%02x", $0) }.joined()
        return file.deletingLastPathComponent().appendingPathComponent(name + ".jpg")
    }
    func artwork(mediaId: String) throws -> Data? { try locked {
        guard state.items.contains(where: { $0.id == mediaId && $0.thumbnail != nil }) else { return nil }
        let url = artworkFile(mediaId)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try Data(contentsOf: url)
    } }
    func resolve(mediaId: String) throws -> LocalMusicAccess { try locked {
        guard let item = state.items.first(where: { $0.id == mediaId }), let root = state.roots.first(where: { $0.id == item.storageId }) else { throw CocoaError(.fileNoSuchFile) }
        let (base, scoped, _) = try Self.open(root)
        let url = base.appendingPathComponent(item.relativePath)
        do {
            guard Self.contained(url, in: base), try url.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink != true,
                  FileManager.default.isReadableFile(atPath: url.path) else { throw CocoaError(.fileReadNoPermission) }
            return LocalMusicAccess(url: url, scopedRoot: scoped ? base : nil)
        } catch { if scoped { base.stopAccessingSecurityScopedResource() }; throw error }
    } }
    private func run() async {
        while true {
            let job: (Root, Int, Item?)? = locked {
                if let root = state.roots.first(where: \.needsScan) { return (root, revision, nil) }
                if let item = state.items.first(where: { item in item.pending && state.roots.contains(where: { $0.id == item.storageId && $0.available }) }), let root = state.roots.first(where: { $0.id == item.storageId }) { return (root, revision, item) }
                if unsavedEnrichment > 0 { saveBackground(); unsavedEnrichment = 0 }; working = false; return nil
            }
            guard let (root, token, item) = job else { return }
            do {
                let (base, scoped, stale) = try Self.open(root)
                defer { if scoped { base.stopAccessingSecurityScopedResource() } }
                guard FileManager.default.isReadableFile(atPath: base.path) else { throw CocoaError(.fileReadNoPermission) }
                if stale { let data = try Self.bookmark(base); locked { if token == revision, let i = state.roots.firstIndex(where: { $0.id == root.id }) { state.roots[i].bookmark = data } } }
                if var item {
                    let url = base.appendingPathComponent(item.relativePath)
                    let values = try? url.resourceValues(forKeys: [.isSymbolicLinkKey, .isUbiquitousItemKey, .ubiquitousItemDownloadingStatusKey])
                    guard Self.contained(url, in: base), values != nil, values?.isSymbolicLink != true,
                          FileManager.default.isReadableFile(atPath: url.path),
                          values?.isUbiquitousItem != true || values?.ubiquitousItemDownloadingStatus == .current else {
                        locked { if token == revision, let index = state.items.firstIndex(where: { $0.id == item.id }) { state.items[index].pending = false; state.items[index].enrichmentError = "File unavailable; download cloud files on this device and refresh."; unsavedEnrichment += 1; if unsavedEnrichment >= 10 { saveBackground(); unsavedEnrichment = 0 } } }
                        continue
                    }
                    let asset = AVURLAsset(url: url)
                    let timeout = Task.detached { try? await Task.sleep(nanoseconds: 15_000_000_000); if !Task.isCancelled { asset.cancelLoading() } }
                    defer { timeout.cancel() }
                    if let metadata = try? await asset.load(.commonMetadata) {
                        for entry in metadata {
                            switch entry.commonKey {
                            case .commonKeyTitle: item.title = try? await entry.load(.stringValue)
                            case .commonKeyArtist: item.artist = try? await entry.load(.stringValue)
                            case .commonKeyAlbumName: item.album = try? await entry.load(.stringValue)
                            case .commonKeyArtwork:
                                if let data = try? await entry.load(.dataValue), data.count <= 4_000_000 {
                                    if let source = CGImageSourceCreateWithData(data as CFData, nil),
                                       let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 160, kCGImageSourceCreateThumbnailWithTransform: true] as CFDictionary) {
                                        let output = NSMutableData()
                                        if let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil) {
                                            CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.75] as CFDictionary)
                                            if CGImageDestinationFinalize(destination) {
                                                locked { if token == revision { try? (output as Data).write(to: artworkFile(item.id), options: .atomic) } }
                                                if FileManager.default.fileExists(atPath: artworkFile(item.id).path) {
                                                    let encoded = item.id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
                                                    item.thumbnail = "muzio-local://artwork/" + encoded + "?v=\(item.modifiedAt)"
                                                }
                                            }
                                        }
                                    }
                                }
                            default: break
                            }
                        }
                    }
                    if let duration = try? await asset.load(.duration), duration.seconds.isFinite, duration.seconds >= 0 { item.duration = duration.seconds }
                    item.pending = false
                    locked { if token == revision, let index = state.items.firstIndex(where: { $0.id == item.id }) { state.items[index] = item; unsavedEnrichment += 1; if unsavedEnrichment >= 10 { saveBackground(); unsavedEnrichment = 0 } } }
                } else {
                    var found: [Item] = []
                    let keys: Set<URLResourceKey> = [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey, .contentModificationDateKey]
                    var enumerationError: Error?
                    guard let enumerator = FileManager.default.enumerator(at: base, includingPropertiesForKeys: Array(keys), options: [.skipsHiddenFiles], errorHandler: { _, error in enumerationError = error; return false }) else { throw CocoaError(.fileReadUnknown) }
                    for case let url as URL in enumerator {
                        guard locked({ token == revision }) else { break }
                        let values = try url.resourceValues(forKeys: keys)
                        if values.isSymbolicLink == true || !Self.contained(url, in: base) { enumerator.skipDescendants(); continue }
                        guard values.isRegularFile == true, Self.extensions.contains(url.pathExtension.lowercased()) else { continue }
                        let relative = String(url.path.dropFirst(base.path.hasSuffix("/") ? base.path.count : base.path.count + 1))
                        let id = "local:" + root.id + ":" + Data(relative.utf8).base64EncodedString()
                        found.append(Item(id: id, storageId: root.id, rootName: root.name, relativePath: relative, name: url.lastPathComponent, sizeBytes: Int64(values.fileSize ?? 0), modifiedAt: (values.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000))
                    }
                    if let enumerationError { throw enumerationError }
                    locked {
                        guard token == revision, let index = state.roots.firstIndex(where: { $0.id == root.id }) else { return }
                        let old = Dictionary(uniqueKeysWithValues: state.items.filter { $0.storageId == root.id }.map { ($0.id, $0) })
                        found = found.map { item in if let previous = old[item.id], previous.sizeBytes == item.sizeBytes, previous.modifiedAt == item.modifiedAt, previous.enrichmentError == nil { return previous }; return item }
                        state.items.removeAll { $0.storageId == root.id }; state.items.append(contentsOf: found)
                        state.roots[index].needsScan = false; state.roots[index].available = true; state.roots[index].error = nil; saveBackground()
                    }
                }
            } catch {
                locked { guard token == revision, let index = state.roots.firstIndex(where: { $0.id == root.id }) else { return }
                    state.roots[index].available = false; state.roots[index].needsScan = false; state.roots[index].error = error.localizedDescription; saveBackground()
                }
            }
        }
    }
}
