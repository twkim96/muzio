import Foundation
import SwiftUI
import WebKit
#if os(iOS)
import UIKit
#else
import AppKit
#endif

@MainActor
final class WebHost: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    @Published var webView: WKWebView?
    @Published var showSetup = false
    @Published var connecting = false
    @Published var loading = false
    @Published var connectionError = ""
    @Published var loadError = ""
    private(set) var origin: URL?
    private var audio: NativeAudioPlayer?
    private var documentGeneration = UUID()
    var savedOrigin: String { UserDefaults.standard.string(forKey: "muzio.serverOrigin") ?? "" }

    override init() {
        super.init()
        if let url = try? ServerPolicy.origin(savedOrigin) { open(url) }
    }

    func connect(_ address: String) async {
        guard !connecting else { return }
        connecting = true; connectionError = ""
        defer { connecting = false }
        do {
            let next = try ServerPolicy.origin(address)
            try await ServerCheck.verify(next)
            UserDefaults.standard.set(next.absoluteString, forKey: "muzio.serverOrigin")
            open(next)
            showSetup = false
        } catch { connectionError = error.localizedDescription }
    }

    func editServer() { connectionError = ""; showSetup = webView != nil }
    func reload() { loadError = ""; loading = true; webView?.reload() }
    func resume() {
        guard trustedDocument else { return }
        webView?.evaluateJavaScript("window.dispatchEvent(new Event('muzio-resume'))", completionHandler: nil)
    }

    private var trustedDocument: Bool {
        guard let origin, let url = webView?.url else { return false }
        return ServerPolicy.appDocument(url, origin: origin)
    }

    private func open(_ origin: URL) {
        documentGeneration = UUID()
        audio?.shutdown()
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "muzio")
        webView?.stopLoading()
        self.origin = origin
        loadError = ""; loading = true
        let configuration = WKWebViewConfiguration()
        let controller = WKUserContentController()
        controller.add(WeakMessageHandler(self), name: "muzio")
        #if os(iOS)
        let platform = "ios"
        configuration.allowsInlineMediaPlayback = true
        configuration.allowsPictureInPictureMediaPlayback = true
        #else
        let platform = "macos"
        #endif
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.preferences.isElementFullscreenEnabled = true
        configuration.websiteDataStore = .default()
        let serializedOrigin = Self.jsonString(origin.absoluteString)
        controller.addUserScript(WKUserScript(source: """
        (() => {
          if (window !== window.top || location.origin !== \(serializedOrigin)) return;
          const port = { platform: '\(platform)', capabilities: { localLibrary: false, nativeAudio: true },
            onmessage: null,
            postMessage(message) { window.webkit.messageHandlers.muzio.postMessage(message); }
          };
          Object.defineProperty(window, 'MuzioNative', { value: port, writable: false, configurable: false });
        })();
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        configuration.userContentController = controller
        let web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = self; web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = false // The app owns Music/Video/Image swipes.
        #if os(iOS)
        web.scrollView.contentInsetAdjustmentBehavior = .never
        #endif
        webView = web
        audio = NativeAudioPlayer(origin: origin) { [weak self] event in self?.send(event) }
        web.load(URLRequest(url: origin.appendingPathComponent("library/music")))
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, message.webView === webView, trustedDocument,
              let origin, ServerPolicy.sameOrigin(message.frameInfo.request.url, origin),
              let body = message.body as? String, body.utf8.count <= 8 * 1024 * 1024,
              let data = body.data(using: .utf8), let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = request["id"] as? String, let command = request["command"] as? String else { return }
        let payload = request["payload"] as? [String: Any] ?? [:]
        let generation = documentGeneration
        do {
            let result: [String: Any]
            if command.hasPrefix("playback.") {
                guard let audio else { throw HostError.message("음악 플레이어가 준비되지 않았습니다.") }
                result = try audio.handle(command: command, payload: payload)
            } else {
                switch command {
                case "shell.profile": result = ["baseUrl": origin.absoluteString, "setup": false, "displayName": "Muzio"]
                case "shell.legacyPreferences": result = ["values": [String: String]()]
                case "shell.finishMigration", "shell.appearance", "shell.background", "shell.cancelSetup": result = [:]
                case "shell.editServer": editServer(); result = [:]
                case "shell.videoState":
                    if payload["playing"] as? Bool == true { _ = try audio?.handle(command: "playback.pause", payload: [:]) }
                    result = [:]
                default: throw HostError.message("이 앱에서 지원하지 않는 기능입니다: \(command)")
                }
            }
            if generation == documentGeneration { send(["type": "response", "id": id, "ok": true, "result": result]) }
        } catch {
            if generation == documentGeneration { send(["type": "response", "id": id, "ok": false, "error": error.localizedDescription]) }
        }
    }

    private func send(_ object: [String: Any]) {
        guard trustedDocument, JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object), let json = String(data: data, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.MuzioNative?.onmessage?.({data:\(Self.jsonString(json))})", completionHandler: nil)
    }

    private static func jsonString(_ value: String) -> String {
        let data = try! JSONSerialization.data(withJSONObject: [value])
        return String(data: data, encoding: .utf8)!.dropFirst().dropLast().description
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let origin, let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if navigationAction.targetFrame?.isMainFrame == false { decisionHandler(.cancel); return }
        if ServerPolicy.appDocument(url, origin: origin), navigationAction.targetFrame != nil { decisionHandler(.allow); return }
        if navigationAction.navigationType == .linkActivated, ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
            #if os(iOS)
            UIApplication.shared.open(url)
            #else
            NSWorkspace.shared.open(url)
            #endif
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        documentGeneration = UUID(); loading = true; loadError = ""
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loading = false; resume() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }
    private func failed(_ error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        loading = false; loadError = error.localizedDescription
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { loading = false; loadError = "화면이 종료되었습니다. 다시 시도하면 재생 상태를 불러옵니다." }
}

private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}
