import Foundation
import AVFoundation
import SwiftUI
import WebKit
#if os(iOS)
import UIKit
#else
import AppKit
#endif

@MainActor
final class WebHost: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    @Published private(set) var appearanceDark: Bool?
    @Published private(set) var appearanceHex = "#1f1f1f"
    var appearanceColor: Color {
        if appearanceDark == nil {
            #if os(iOS)
            return Color(uiColor: .systemBackground)
            #else
            return Color(nsColor: .windowBackgroundColor)
            #endif
        }
        let rgb = UInt32(appearanceHex.dropFirst(), radix: 16) ?? 0x1f1f1f
        return Color(red: Double((rgb >> 16) & 255) / 255, green: Double((rgb >> 8) & 255) / 255, blue: Double(rgb & 255) / 255)
    }
    var appearanceScheme: ColorScheme? { appearanceDark.map { $0 ? .dark : .light } }
    private func applyAppearance(_ payload: [String: Any]) throws {
        guard let hex = payload["backgroundColor"] as? String,
              hex.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) != nil,
              let dark = payload["dark"] as? Bool else { throw HostError.message("올바르지 않은 화면 테마입니다.") }
        appearanceHex = hex.lowercased(); appearanceDark = dark
        UserDefaults.standard.set(["backgroundColor": appearanceHex, "dark": dark], forKey: "muzio.appearance")
        applyWebBackground()
    }
    private func applyWebBackground() {
        guard let webView else { return }
        #if os(iOS)
        let color = UIColor(appearanceColor)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.overrideUserInterfaceStyle = appearanceDark.map { $0 ? .dark : .light } ?? .unspecified
        #else
        let color = NSColor(appearanceColor)
        webView.appearance = appearanceDark.map { NSAppearance(named: $0 ? .darkAqua : .aqua) } ?? nil
        #endif
        #if os(iOS)
        webView.underPageBackgroundColor = .clear
        #else
        webView.underPageBackgroundColor = color
        #endif
    }
    @Published var webView: WKWebView?
    @Published var showSetup = false
    @Published var showFolderPicker = false
    private var folderReply: CheckedContinuation<URL?, Error>?
    private let localLibrary = Result { try LocalMusicLibrary() }

    func folderPicked(_ result: Result<[URL], Error>) {
        showFolderPicker = false
        let reply = folderReply; folderReply = nil
        switch result {
        case .success(let urls): reply?.resume(returning: urls.first)
        case .failure(let error):
            if (error as NSError).code == NSUserCancelledError { reply?.resume(returning: nil) }
            else { reply?.resume(throwing: error) }
        }
    }

    private func pickFolder() async throws -> URL? {
        guard folderReply == nil else { throw HostError.message("이미 폴더를 선택하고 있습니다.") }
        return try await withCheckedThrowingContinuation { reply in
            folderReply = reply; showFolderPicker = true
        }
    }
    @Published var connecting = false
    @Published var loading = false
    @Published var connectionError = ""
    @Published var loadError = ""
    private(set) var origin: URL?
    private var audio: NativeAudioPlayer?
    private var playbackHistory: ApplePlaybackHistory?
    private var videoIndexProxy: VideoIndexProxy?
    private var openGeneration = UUID()
    private var documentGeneration = UUID()
    var savedOrigin: String { UserDefaults.standard.string(forKey: "muzio.serverOrigin") ?? "" }

    override init() {
        super.init()
        if let saved = UserDefaults.standard.dictionary(forKey: "muzio.appearance") { try? applyAppearance(saved) }
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
        let generation = UUID()
        openGeneration = generation
        documentGeneration = UUID()
        audio?.shutdown()
        videoIndexProxy?.stop()
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "muzio")
        webView?.stopLoading()
        self.origin = origin
        loadError = ""; loading = true
        do {
            let proxy = try VideoIndexProxy(origin: origin)
            videoIndexProxy = proxy
            proxy.start { [weak self] baseURL in
                Task { @MainActor in
                    guard let self, self.openGeneration == generation else { return }
                    self.loadDocument(origin, videoIndexBaseURL: baseURL)
                }
            }
        } catch {
            videoIndexProxy = nil
            loadDocument(origin, videoIndexBaseURL: nil)
        }
    }

    private func loadDocument(_ origin: URL, videoIndexBaseURL: URL?) {
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
        let videoIndexMetadata = videoIndexBaseURL.map { "videoIndexBaseUrl: \(Self.jsonString($0.absoluteString))," } ?? ""
        controller.addUserScript(WKUserScript(source: """
        (() => {
          if (window !== window.top || location.origin !== \(serializedOrigin)) return;
          const port = { platform: '\(platform)', capabilities: { localLibrary: true, nativeAudio: true, notificationLikes: true, playbackHistory: true },
            \(videoIndexMetadata)
            onmessage: null,
            postMessage(message) { window.webkit.messageHandlers.muzio.postMessage(message); }
          };
          Object.defineProperty(window, 'MuzioNative', { value: port, writable: false, configurable: false });
        })();
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        configuration.setURLSchemeHandler(LocalArtworkHandler(library: localLibrary, origin: origin), forURLScheme: "muzio-local")
        configuration.userContentController = controller
        let web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = self; web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = false // The app owns Music/Video/Image swipes.
        #if os(iOS)
        web.scrollView.contentInsetAdjustmentBehavior = .never
        #endif
        // Video uses the shared HTML player on every Apple host. The index
        // proxy accelerates its source without adding another playback engine.
        webView = web
        applyWebBackground()
        let library = localLibrary
        let history = ApplePlaybackHistory(origin: origin)
        playbackHistory = history
        audio = NativeAudioPlayer(origin: origin, resolveLocal: { id in
            let access = try library.get().resolve(mediaId: id)
            return NativeAudioLocalAccess(url: access.url, release: { access.release() })
        }, feedbackStore: try? AppleNotificationLikeStore(origin: origin), artworkProvider: { id in
            try library.get().artwork(mediaId: id)
        }) { [weak self] event in
            if let state = event["state"] as? [String: Any] { history.record(snapshot: state) }
            self?.send(event)
        }
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
        if command.hasPrefix("localLibrary.") {
            Task { @MainActor in
                do {
                    let library = try localLibrary.get()
                    let result: [String: Any]
                    switch command {
                    case "localLibrary.list": result = await library.snapshot()
                    case "localLibrary.add":
                        let url = try await pickFolder()
                        guard generation == documentGeneration else { return }
                        if let url { result = try await library.add(url) }
                        else { result = await library.snapshot() }
                    case "localLibrary.refresh": result = try await library.refresh()
                    case "localLibrary.remove":
                        guard let rootID = payload["id"] as? String else { throw HostError.message("폴더를 선택해 주세요.") }
                        result = try await library.remove(id: rootID)
                    default: throw HostError.message("지원하지 않는 로컬 음악 명령입니다.")
                    }
                    if generation == documentGeneration { send(["type": "response", "id": id, "ok": true, "result": result]) }
                } catch {
                    if generation == documentGeneration { send(["type": "response", "id": id, "ok": false, "error": error.localizedDescription]) }
                }
            }
            return
        }
        do {
            let result: [String: Any]
            if command == "playback.history" {
                result = playbackHistory?.snapshot() ?? ["pending": []]
            } else if command == "playback.ackHistory" {
                result = playbackHistory?.acknowledge(ids: payload["ids"] as? [String] ?? []) ?? ["pending": []]
            } else if command.hasPrefix("playback.") {
                guard let audio else { throw HostError.message("음악 플레이어가 준비되지 않았습니다.") }
                result = try audio.handle(command: command, payload: payload)
            } else {
                switch command {
                case "shell.profile": result = ["baseUrl": origin.absoluteString, "setup": false, "displayName": "Muzio"]
                case "shell.legacyPreferences": result = ["values": [String: String]()]
                case "shell.finishMigration", "shell.background", "shell.cancelSetup": result = [:]
                case "shell.appearance": try applyAppearance(payload); result = [:]
                case "shell.editServer": editServer(); result = [:]
                case "shell.videoState":
                    if payload["playing"] as? Bool == true {
                        audio?.relinquishForVideo()
                        #if os(iOS)
                        // WK video needs the same background playback category as native music.
                        let session = AVAudioSession.sharedInstance()
                        try session.setCategory(.playback, mode: .moviePlayback)
                        try session.setActive(true)
                        #endif
                    }
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
