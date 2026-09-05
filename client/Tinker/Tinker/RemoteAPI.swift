import Foundation
import Security
import CryptoKit

final class RemoteAPI {
    let pairing: Pairing
    private let delegate: RemoteTLSDelegate
    private let session: URLSession
    init(pairing: Pairing) {
        self.pairing = pairing
        delegate = RemoteTLSDelegate(pin: pairing.certificateSha256)
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 30
        config.waitsForConnectivity = false
        config.urlCache = nil
        session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
    }
    func request<T: Decodable>(_ route: String, operation: RemoteOperation? = nil) async throws -> T {
        var request = try makeRequest(route)
        if let operation {
            request.httpMethod = "POST"
            request.httpBody = try JSONEncoder().encode(operation)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw RemoteClientError.message("连接入口没有返回 HTTP 响应。") }
        guard (200..<300).contains(response.statusCode) else {
            let message = (try? JSONDecoder().decode(RemoteHTTPFailure.self, from: data))?.error.message ?? "服务响应错误（\(response.statusCode)）。"
            throw RemoteClientError.http(response.statusCode, message)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
    func webSocket(sessionId: String, epoch: String?, sequence: Int?) throws -> URLSessionWebSocketTask {
        var components = URLComponents(string: pairing.url)!
        components.scheme = "wss"
        components.path = "/v1/sessions/\(sessionId)/events"
        if let epoch, let sequence { components.queryItems = [URLQueryItem(name: "epoch", value: epoch), URLQueryItem(name: "after", value: String(sequence))] }
        var request = URLRequest(url: components.url!)
        request.setValue("Bearer \(pairing.token)", forHTTPHeaderField: "Authorization")
        let task = session.webSocketTask(with: request)
        task.maximumMessageSize = 32 * 1024 * 1024
        task.resume()
        return task
    }
    private func makeRequest(_ route: String) throws -> URLRequest {
        guard let url = URL(string: route, relativeTo: URL(string: pairing.url)) else { throw RemoteClientError.message("无效的服务地址。") }
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("Bearer \(pairing.token)", forHTTPHeaderField: "Authorization")
        return request
    }
    func invalidate() { session.invalidateAndCancel() }
}

private struct RemoteHTTPFailure: Decodable {
    struct Detail: Decodable { var message: String }
    var error: Detail
}

private final class RemoteTLSDelegate: NSObject, URLSessionDelegate, URLSessionTaskDelegate, @unchecked Sendable {
    nonisolated let pin: String?
    init(pin: String?) { self.pin = pin?.isEmpty == false ? pin : nil }

    nonisolated func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                               completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let pin else { completionHandler(.performDefaultHandling, nil); return }
        guard let trust = challenge.protectionSpace.serverTrust,
              let certificates = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let leaf = certificates.first else { completionHandler(.cancelAuthenticationChallenge, nil); return }
        let data = SecCertificateCopyData(leaf) as Data
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard digest == pin else { completionHandler(.cancelAuthenticationChallenge, nil); return }
        // A manually paired development certificate is a scoped anchor. Still verify
        // its hostname, validity and TLS policy; never disable trust globally.
        SecTrustSetAnchorCertificates(trust, [leaf] as CFArray)
        SecTrustSetAnchorCertificatesOnly(trust, true)
        SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, challenge.protectionSpace.host as CFString))
        guard SecTrustEvaluateWithError(trust, nil) else { completionHandler(.cancelAuthenticationChallenge, nil); return }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask,
                               willPerformHTTPRedirection response: HTTPURLResponse,
                               newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
