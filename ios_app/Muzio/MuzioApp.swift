import SwiftUI
import UniformTypeIdentifiers
import WebKit
#if os(macOS)
import AppKit
#endif

@main
struct MuzioApp: App {
    @StateObject private var host = WebHost()
    var body: some Scene {
        WindowGroup {
            RootScreen(host: host)
                #if os(macOS)
                .frame(minWidth: 480, minHeight: 560)
                #endif
        }
        #if os(macOS)
        .defaultSize(width: 1160, height: 800)
        .commands {
            CommandGroup(replacing: .newItem) {}
            CommandGroup(after: .appSettings) {
                Button("서버 연결 설정…") { host.editServer() }.keyboardShortcut(",")
                Button("새로고침") { host.reload() }.keyboardShortcut("r")
            }
        }
        #endif
    }
}

struct RootScreen: View {
    @ObservedObject var host: WebHost
    @Environment(\.scenePhase) private var phase
    var body: some View {
        ZStack {
            host.appearanceColor.ignoresSafeArea()
            if let web = host.webView {
                BrowserSurface(web: web, host: host).id(ObjectIdentifier(web))
                    #if os(iOS)
                    .ignoresSafeArea(edges: host.videoFullscreen ? .all : [])
                    #endif
                if host.loading { ProgressView().padding(12).background(.regularMaterial, in: Capsule()).frame(maxHeight: .infinity, alignment: .top).padding(.top, 8) }
                if !host.loadError.isEmpty {
                    VStack(spacing: 16) {
                        Text("연결을 확인해 주세요").font(.headline)
                        Text(host.loadError).font(.callout).multilineTextAlignment(.center)
                        HStack {
                            Button("다시 시도") { host.reload() }
                            Button("서버 변경") { host.editServer() }
                        }
                    }.padding(28).frame(maxWidth: 420).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 24)).padding()
                }
            } else { ServerScreen(host: host) }
        }
        .preferredColorScheme(host.appearanceScheme)
        .fileImporter(isPresented: $host.showFolderPicker, allowedContentTypes: [.folder], allowsMultipleSelection: false) { result in
            host.folderPicked(result)
        }
        .sheet(isPresented: $host.showSetup) { ServerScreen(host: host).padding().frame(minWidth: 300).preferredColorScheme(host.appearanceScheme) }
        #if os(iOS)
        .statusBarHidden(host.videoFullscreen)
        #endif
        .onChange(of: phase) { phase in if phase == .active { host.resume() } }
    }
}

struct ServerScreen: View {
    @ObservedObject var host: WebHost
    @State private var address = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Muzio").font(.largeTitle.bold())
            Text("사용 중인 Muzio 서버에 연결합니다.").foregroundStyle(.secondary)
            TextField("https://my-mac.ts.net:5173", text: $address)
                .textFieldStyle(.roundedBorder)
                #if os(iOS)
                .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                #endif
                .onSubmit { connect() }
                .disabled(host.connecting)
            if !host.connectionError.isEmpty { Text(host.connectionError).foregroundStyle(.red).font(.callout) }
            HStack {
                if host.webView != nil { Button("취소") { host.showSetup = false }.disabled(host.connecting) }
                Spacer()
                Button(host.connecting ? "연결 중…" : "연결") { connect() }
                    .buttonStyle(.borderedProminent).disabled(host.connecting || address.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }.padding(28).frame(maxWidth: 460)
            .onAppear { address = host.savedOrigin }
    }
    private func connect() { Task { await host.connect(address) } }
}

#if os(iOS)
struct BrowserSurface: UIViewRepresentable {
    let web: WKWebView
    let host: WebHost
    func makeUIView(context: Context) -> VideoBrowserContainer { VideoBrowserContainer(web: web, video: host.video) }
    func updateUIView(_ uiView: VideoBrowserContainer, context: Context) {}
}
final class VideoBrowserContainer: UIView {
    weak var video: NativeVideoPlayer?
    init(web: WKWebView, video: NativeVideoPlayer?) {
        self.video = video
        super.init(frame: .zero)
        if let video { addSubview(video.surface) }
        web.translatesAutoresizingMaskIntoConstraints = false
        addSubview(web)
        NSLayoutConstraint.activate([web.leadingAnchor.constraint(equalTo: leadingAnchor), web.trailingAnchor.constraint(equalTo: trailingAnchor), web.topAnchor.constraint(equalTo: topAnchor), web.bottomAnchor.constraint(equalTo: bottomAnchor)])
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func layoutSubviews() { super.layoutSubviews(); video?.layout(in: bounds) }
}

#else
// An explicit container keeps WebKit fullscreen resizing independent of SwiftUI layout.
struct BrowserSurface: NSViewRepresentable {
    let web: WKWebView
    let host: WebHost
    func makeNSView(context: Context) -> NSView {
        let container = NSView()
        web.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(web)
        NSLayoutConstraint.activate([web.leadingAnchor.constraint(equalTo: container.leadingAnchor), web.trailingAnchor.constraint(equalTo: container.trailingAnchor), web.topAnchor.constraint(equalTo: container.topAnchor), web.bottomAnchor.constraint(equalTo: container.bottomAnchor)])
        return container
    }
    func updateNSView(_ nsView: NSView, context: Context) {}
}
#endif
