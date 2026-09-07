import Foundation
import WebKit

/// Exposes only cached covers of authorized catalog IDs, never arbitrary file URLs.
@MainActor
final class LocalArtworkHandler: NSObject, WKURLSchemeHandler {
    private let library: Result<LocalMusicLibrary, Error>
    private let origin: URL
    private var pending: [ObjectIdentifier: Task<Void, Never>] = [:]
    init(library: Result<LocalMusicLibrary, Error>, origin: URL) {
        self.library = library; self.origin = origin
    }
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url, url.scheme == "muzio-local", url.host == "artwork",
              let page = webView.url, ServerPolicy.appDocument(page, origin: origin),
              urlSchemeTask.request.httpMethod == "GET", url.path.hasPrefix("/local:") else {
            urlSchemeTask.didFailWithError(URLError(.noPermissionsToReadFile)); return
        }
        let key = ObjectIdentifier(urlSchemeTask)
        let id = String(url.path.dropFirst())
        let library = self.library
        pending[key] = Task { [weak self] in
            let result = await Task.detached(priority: .utility) { () -> Result<Data?, Error> in
                Result { try library.get().artwork(mediaId: id) }
            }.value
            guard let self, !Task.isCancelled, self.pending.removeValue(forKey: key) != nil else { return }
            do {
                guard let data = try result.get() else { throw URLError(.fileDoesNotExist) }
                urlSchemeTask.didReceive(URLResponse(url: url, mimeType: "image/jpeg", expectedContentLength: data.count, textEncodingName: nil))
                urlSchemeTask.didReceive(data)
                urlSchemeTask.didFinish()
            } catch { urlSchemeTask.didFailWithError(error) }
        }
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        pending.removeValue(forKey: ObjectIdentifier(urlSchemeTask))?.cancel()
    }
}
