import Foundation
@main struct ServerPolicyTests {
    static func main() throws {
        let origin = try ServerPolicy.origin(" https://EXAMPLE.com:443/ ")
        assert(origin.absoluteString == "https://example.com")
        assert(ServerPolicy.sameOrigin(URL(string: "https://example.com/library/music"), origin))
        for address in ["file:///private", "javascript:alert(1)", "https://user:pass@example.com", "https://example.com/api", "https://example.com?x=1", "https://example.com#x", "http://example.com:0"] {
            assert((try? ServerPolicy.origin(address)) == nil, address)
        }
        for address in ["https://evil.example/library/music", "http://example.com/library/music", "https://example.com:444/", "https://example.com@evil.example/", "https://example.com/api/media/x"] {
            assert(!ServerPolicy.appDocument(URL(string: address)!, origin: origin), address)
        }
        assert(ServerPolicy.appDocument(URL(string:"https://example.com/library/video")!, origin: origin))
        assert(ServerPolicy.appDocument(URL(string:"https://example.com/settings")!, origin: origin))
        print("ServerPolicy: normalization, credentials, origin/port and document boundary checks passed")
    }
}
