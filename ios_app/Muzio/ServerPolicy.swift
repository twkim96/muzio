import Foundation

enum ServerPolicy {
    static func origin(_ text: String) throws -> URL {
        guard let parts = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = parts.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil, parts.path.isEmpty || parts.path == "/",
              parts.port == nil || (1...65535).contains(parts.port!) else {
            throw HostError.message("서버 주소만 입력해 주세요. 예: https://my-mac.ts.net:5173")
        }
        var clean = URLComponents()
        clean.scheme = scheme; clean.host = host.lowercased()
        clean.port = parts.port == (scheme == "https" ? 443 : 80) ? nil : parts.port
        guard let url = clean.url else { throw HostError.message("서버 주소가 올바르지 않습니다.") }
        return url
    }

    static func sameOrigin(_ candidate: URL?, _ origin: URL) -> Bool {
        guard let candidate, candidate.user == nil, candidate.password == nil else { return false }
        func port(_ url: URL) -> Int { url.port ?? (url.scheme?.lowercased() == "https" ? 443 : 80) }
        return candidate.scheme?.lowercased() == origin.scheme?.lowercased()
            && candidate.host?.lowercased() == origin.host?.lowercased() && port(candidate) == port(origin)
    }

    static func appDocument(_ url: URL, origin: URL) -> Bool {
        guard sameOrigin(url, origin) else { return false }
        return ["/", "/settings", "/settings/backend", "/player"].contains(url.path)
            || url.path.hasPrefix("/library/") || url.path.hasPrefix("/image/") || url.path.hasPrefix("/video/")
    }
}

enum HostError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case let .message(message) = self { return message }; return nil }
}

/// A server check must not silently authenticate or redirect to a different site.
final class ServerCheck: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }

    static func verify(_ origin: URL) async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 12
        let delegate = ServerCheck()
        let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (_, response) = try await session.data(from: origin.appendingPathComponent("healthz"))
        guard let http = response as? HTTPURLResponse, http.statusCode == 200,
              ServerPolicy.sameOrigin(http.url, origin) else {
            throw HostError.message("Muzio 서버에 연결하지 못했습니다. 주소와 서버 실행 상태를 확인해 주세요.")
        }
    }
}
