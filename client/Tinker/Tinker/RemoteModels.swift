import Foundation

struct Pairing: Codable, Equatable, Sendable {
    var version = 1
    var name: String
    var url: String
    var token: String
    var certificateSha256: String?

    func validated() throws -> Pairing {
        guard version == 1, let endpoint = URLComponents(string: url), endpoint.scheme == "https",
              endpoint.host != nil, endpoint.user == nil, endpoint.password == nil,
              endpoint.query == nil, endpoint.fragment == nil,
              endpoint.path.isEmpty || endpoint.path == "/" else {
            throw RemoteClientError.message("请输入 HTTPS 连接入口，例如 https://your-mac.example.com。")
        }
        if let port = URLComponents(string: url)?.port, !(1...65535).contains(port) {
            throw RemoteClientError.message("连接端口应在 1 到 65535 之间。")
        }
        guard token.range(of: "^[A-Za-z0-9_-]{43,128}$", options: .regularExpression) != nil else {
            throw RemoteClientError.message("设备凭据格式不正确，请重新导入配对文件。")
        }
        if let pin = certificateSha256, !pin.isEmpty,
           pin.range(of: "^[0-9a-f]{64}$", options: .regularExpression) == nil {
            throw RemoteClientError.message("证书指纹应为 64 位 SHA-256 十六进制文本。")
        }
        return self
    }
}

struct RemoteWorkspace: Codable, Identifiable { var id: String; var name: String }
struct WorkspaceResponse: Decodable { var workspaces: [RemoteWorkspace] }
struct SessionResponse: Decodable { var sessions: [RemoteSessionInfo] }
struct RemoteSessionInfo: Codable, Identifiable {
    var id: String; var workspaceId: String; var title: String; var modelName: String
    var owner: String; var status: String; var updatedAt: String
}
struct RemoteMessage: Codable, Identifiable {
    var id: String; var ordinal: Int; var role: String; var text: String; var turnId: String
    var turnStatus: String; var createdAt: String; var name: String?; var toolCallId: String?
    var toolCalls: [RemoteToolCall]?
}
struct RemoteToolCall: Codable, Identifiable { var id: String; var name: String; var arguments: String }
struct RemoteHistory: Codable { var messages: [RemoteMessage]; var hasMore: Bool; var beforeOrdinal: Int? }
struct RemoteTool: Codable, Identifiable {
    var id: String; var name: String; var arguments: String; var status: String; var detail: String?
}
struct RemoteOption: Codable { var description: String }
struct RemoteInteraction: Codable, Identifiable {
    var id: String; var kind: String; var question: String?; var options: [RemoteOption]?
    var command: String?; var reason: String?
}
struct RemoteStreaming: Codable { var iterationId: String; var attempt: Int; var text: String }
struct OperationReceipt: Codable, Identifiable {
    var requestId: String; var sessionId: String; var kind: String; var status: String
    var createdAt: String; var updatedAt: String; var turnId: String?; var prompt: String?; var error: String?
    var id: String { requestId }
}
struct RemoteActivity: Codable {
    var session: RemoteSessionInfo; var status: String; var activeRequestId: String?; var activeTurnId: String?
    var streaming: RemoteStreaming?; var tools: [RemoteTool]; var interaction: RemoteInteraction?
    var operations: [OperationReceipt]; var error: String?
}
struct RemoteView: Codable {
    var session: RemoteSessionInfo; var status: String; var activeRequestId: String?; var activeTurnId: String?
    var streaming: RemoteStreaming?; var tools: [RemoteTool]; var interaction: RemoteInteraction?
    var operations: [OperationReceipt]; var error: String?; var history: RemoteHistory

    mutating func apply(_ activity: RemoteActivity) {
        session = activity.session; status = activity.status; activeRequestId = activity.activeRequestId
        activeTurnId = activity.activeTurnId; streaming = activity.streaming; tools = activity.tools
        interaction = activity.interaction; operations = activity.operations; error = activity.error
    }
}
struct RemoteChange: Codable { var activity: RemoteActivity; var messages: [RemoteMessage] }
struct RemoteFrame: Codable {
    var version: Int; var type: String; var epoch: String; var sequence: Int
    var view: RemoteView?; var change: RemoteChange?
}

struct RemoteOperation: Codable, Identifiable {
    var requestId = UUID().uuidString.lowercased()
    var kind: String
    var workspaceId: String?
    var sessionId: String?
    var title: String?
    var prompt: String?
    var targetRequestId: String?
    var interactionId: String?
    var selectedIndex: Int?
    var decision: String?
    var id: String { requestId }

    enum CodingKeys: String, CodingKey {
        case requestId, kind, workspaceId, sessionId, title, prompt, targetRequestId, interactionId, selectedIndex, decision
    }
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(requestId, forKey: .requestId); try container.encode(kind, forKey: .kind)
        try container.encodeIfPresent(workspaceId, forKey: .workspaceId); try container.encodeIfPresent(sessionId, forKey: .sessionId)
        try container.encodeIfPresent(title, forKey: .title); try container.encodeIfPresent(prompt, forKey: .prompt)
        try container.encodeIfPresent(targetRequestId, forKey: .targetRequestId); try container.encodeIfPresent(interactionId, forKey: .interactionId)
        if kind == "answer" { try container.encode(selectedIndex, forKey: .selectedIndex) }
        try container.encodeIfPresent(decision, forKey: .decision)
    }
}
struct PendingOperation: Codable, Identifiable {
    var operation: RemoteOperation; var error: String?; var rejected = false; var attempted = false
    var id: String { operation.requestId }
}
struct RemoteSavedState: Codable {
    var endpoint: String?; var sessionId: String?; var workspaceId: String?
    var outbox: [PendingOperation] = []; var drafts: [String: String] = [:]
}

struct RemoteSyncState {
    var epoch: String?; var sequence: Int?; var view: RemoteView?
    mutating func receive(_ frame: RemoteFrame) throws {
        guard frame.version == 1, frame.sequence >= 0 else { throw RemoteClientError.message("服务协议版本不兼容。") }
        if frame.type == "snapshot", let snapshot = frame.view {
            epoch = frame.epoch; sequence = frame.sequence; view = snapshot; return
        }
        guard frame.type == "event", epoch == frame.epoch, let current = sequence, view != nil, let change = frame.change else {
            throw RemoteClientError.resynchronize
        }
        if frame.sequence <= current { return }
        guard frame.sequence == current + 1 else { throw RemoteClientError.resynchronize }
        view?.apply(change.activity)
        let merged = Self.merge(view?.history.messages ?? [], change.messages)
        view?.history.messages = merged
        sequence = frame.sequence
    }
    static func merge(_ before: [RemoteMessage], _ after: [RemoteMessage]) -> [RemoteMessage] {
        var messages = Dictionary(before.map { ($0.id, $0) }, uniquingKeysWith: { _, newer in newer })
        for message in after { messages[message.id] = message }
        return messages.values.sorted { $0.ordinal < $1.ordinal }
    }
}

enum RemoteClientError: LocalizedError {
    case message(String), http(Int, String), resynchronize
    var errorDescription: String? {
        switch self {
        case .message(let text), .http(_, let text): return text
        case .resynchronize: return "正在重新同步会话。"
        }
    }
}
func remoteStatusLabel(_ status: String) -> String {
    switch status {
    case "accepted": return "已接受 · 等待执行"
    case "running", "open": return "执行中"
    case "waiting_input": return "等待你的回答"
    case "completed": return "已完成"
    case "failed": return "执行失败"
    case "cancelled": return "已取消"
    case "interrupted": return "本机进程曾中断"
    case "active": return "本地终端正在使用"
    case "resumable", "idle": return "就绪"
    default: return status
    }
}
