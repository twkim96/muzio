import Foundation
@main struct NativeVideoSourceTests {
    static func main() throws {
        let origin = URL(string: "https://example.test:5173")!
        let proxy = URL(string: "http://127.0.0.1:23456/0123456789abcdef0123456789abcdef/")!
        for raw in ["/api/media/relative", "https://example.test:5173/api/media/song%2Fvideo.mp4#t=35", "https://example.test:5173/api/video-optimization/media/id", "https://example.test:5173/api/video-optimization/hls/id/master.m3u8", proxy.absoluteString + "api/media/id"] {
            let url = try NativeVideoSourcePolicy.validate(raw, origin: origin, proxyBase: proxy)
            precondition(url.fragment == nil)
        }
        for raw in ["file:///tmp/video.mp4", "https://other.test/api/media/id", "https://user:pass@example.test:5173/api/media/id", "https://example.test:5173/api/media/id?index=1", "https://example.test:5173/api/media/../secret", "https://example.test:5173/api/media/%2e%2e", "http://127.0.0.1:23456/wrong/api/media/id", "https://example.test:5173/settings"] {
            do { _ = try NativeVideoSourcePolicy.validate(raw, origin: origin, proxyBase: proxy); fatalError("accepted: \(raw)") }
            catch { }
        }
        let localhost = URL(string: "http://localhost:23456/0123456789abcdef0123456789abcdef/")!
        let normalized = try NativeVideoSourcePolicy.validate(localhost.absoluteString + "api/media/id?v=2#t=35", origin: origin, proxyBase: localhost)
        precondition(normalized.absoluteString == proxy.absoluteString + "api/media/id?v=2")
        let remote = "https://example.test:5173/api/media/id?v=2"
        let direct = try NativeVideoSourcePolicy.validate(remote, origin: origin, proxyBase: localhost)
        precondition(direct.absoluteString == remote)
        for raw in [proxy.absoluteString + "api/media/id", "http://localhost:23456/wrong/api/media/id", "http://localhost:23457/0123456789abcdef0123456789abcdef/api/media/id", "http://user@localhost:23456/0123456789abcdef0123456789abcdef/api/media/id"] {
            do { _ = try NativeVideoSourcePolicy.validate(raw, origin: origin, proxyBase: localhost); fatalError("accepted: \(raw)") }
            catch { }
        }
        print("Native video source policy passed")
    }
}
