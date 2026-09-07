import Foundation

enum NativeVideoSourcePolicy {
    static func validate(_ raw: String, origin: URL, proxyBase: URL?) throws -> URL {
        guard let resolved = URL(string: raw, relativeTo: origin)?.absoluteURL,
              var parts = URLComponents(url: resolved, resolvingAgainstBaseURL: false), let url = parts.url,
              url.user == nil, url.password == nil else { throw HostError.message("올바르지 않은 영상 주소입니다.") }
        var path = parts.percentEncodedPath
        if let proxyBase, let prefix = URLComponents(url: proxyBase, resolvingAgainstBaseURL: false)?.percentEncodedPath,
           ServerPolicy.sameOrigin(url, proxyBase), path.hasPrefix(prefix) {
            path = "/" + path.dropFirst(prefix.count)
        } else if !ServerPolicy.sameOrigin(url, origin) {
            throw HostError.message("연결된 서버의 영상만 재생할 수 있습니다.")
        }
        let patterns = ["^/api/media/[^/]+$", "^/api/video-optimization/media/[^/]+$", "^/api/video-optimization/hls/[^/]+/[^?#]+\\.m3u8$"]
        guard patterns.contains(where: { path.range(of: $0, options: .regularExpression) != nil }),
              !path.contains(".."), !path.lowercased().contains("%2e"),
              !(parts.queryItems ?? []).contains(where: { $0.name == "index" }) else {
            throw HostError.message("지원하지 않는 영상 경로입니다.")
        }
        parts.fragment = nil
        return parts.url!
    }
}
