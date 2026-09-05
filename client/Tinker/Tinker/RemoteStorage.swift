import Foundation
import Security

enum RemoteStorage {
    static func loadPairing() throws -> Pairing? {
        var query = keychainQuery
        query[kSecReturnData as String] = true
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw RemoteClientError.message("无法读取钥匙串中的连接凭据。") }
        return try JSONDecoder().decode(Pairing.self, from: data).validated()
    }
    static func savePairing(_ pairing: Pairing) throws {
        let data = try JSONEncoder().encode(pairing.validated())
        let update = [kSecValueData as String: data]
        let status = SecItemUpdate(keychainQuery as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var query = keychainQuery
            query[kSecValueData as String] = data
            query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(query as CFDictionary, nil) == errSecSuccess else { throw RemoteClientError.message("无法保存连接凭据。") }
        } else if status != errSecSuccess { throw RemoteClientError.message("无法更新连接凭据。") }
    }
    private static var keychainQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.shshaoxia.Tinker.remote", kSecAttrAccount as String: "paired-device"]
    }
    static var stateURL: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("remote-state.json")
    }
    static func loadState() throws -> RemoteSavedState {
        guard FileManager.default.fileExists(atPath: stateURL.path) else { return RemoteSavedState() }
        return try JSONDecoder().decode(RemoteSavedState.self, from: Data(contentsOf: stateURL))
    }
    static func saveState(_ state: RemoteSavedState) throws {
        try FileManager.default.createDirectory(at: stateURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(state).write(to: stateURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}
