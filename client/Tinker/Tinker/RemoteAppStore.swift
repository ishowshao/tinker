import UIKit

extension Notification.Name { static let remoteDidChange = Notification.Name("Tinker.remoteDidChange") }

@MainActor
final class RemoteAppStore {
    static let shared = RemoteAppStore()
    private(set) var pairing: Pairing?
    private(set) var workspaces: [RemoteWorkspace] = []
    private(set) var sessions: [RemoteSessionInfo] = []
    private(set) var sync = RemoteSyncState()
    private(set) var saved = RemoteSavedState()
    private(set) var connection = "未连接"
    private(set) var error: String?
    private(set) var lastAccepted: OperationReceipt?
    private var api: RemoteAPI?
    private var foreground = false
    private var connectionTask: Task<Void, Never>?
    private var flushTask: Task<Void, Never>?
    private var socket: URLSessionWebSocketTask?
    private var heartbeatTask: Task<Void, Never>?
    private var cacheTask: Task<Void, Never>?
    private var connectionGeneration = UUID()
    private var lastPong = Date()
    private var cacheURL: URL { RemoteStorage.stateURL.deletingLastPathComponent().appendingPathComponent("last-view.json") }

    init() {
        do {
            pairing = try RemoteStorage.loadPairing()
            saved = try RemoteStorage.loadState()
            if let pairing {
                api = RemoteAPI(pairing: pairing)
                if saved.endpoint == pairing.url, let data = try? Data(contentsOf: cacheURL) {
                    let cached = try JSONDecoder().decode(RemoteView.self, from: data)
                    if cached.session.id == saved.sessionId { sync.view = cached }
                }
            }
        } catch { self.error = error.localizedDescription }
    }

    func configure(_ next: Pairing) throws {
        let next = try next.validated()
        if pairing != nil, pairing?.url != next.url, saved.outbox.contains(where: { !$0.rejected }) {
            throw RemoteClientError.message("还有未确认提交的请求。请先连接原入口，或在会话页检查并移除这些请求，再切换入口。")
        }
        try RemoteStorage.savePairing(next)
        disconnect()
        api?.invalidate()
        if saved.endpoint != next.url {
            saved = RemoteSavedState(endpoint: next.url)
            sync = RemoteSyncState(); workspaces = []; sessions = []
        }
        saved.endpoint = next.url
        try RemoteStorage.saveState(saved)
        pairing = next; api = RemoteAPI(pairing: next); error = nil
        notify(); activate()
    }

    func activate() {
        foreground = true
        guard api != nil else { return }
        if connectionTask == nil, saved.sessionId != nil { watch() }
        flush()
        Task { await refreshWorkspaces() }
    }
    func background() {
        foreground = false
        disconnect()
        connection = "已暂停连接 · 本机任务继续"
        cacheNow(); notify()
    }
    private func disconnect() {
        connectionGeneration = UUID()
        connectionTask?.cancel(); connectionTask = nil
        heartbeatTask?.cancel(); heartbeatTask = nil
        socket?.cancel(with: .goingAway, reason: nil); socket = nil
    }

    func refreshWorkspaces() async {
        guard let api else { return }
        do {
            let response: WorkspaceResponse = try await api.request("/v1/workspaces")
            guard self.api === api else { return }
            workspaces = response.workspaces; error = nil
            if saved.sessionId == nil { connection = "已连接" }
        } catch {
            guard self.api === api else { return }
            self.error = error.localizedDescription
            if saved.sessionId == nil { connection = "连接不可用 · 下拉重试" }
        }
        notify()
    }
    func refreshSessions(workspace: String) async {
        guard let api else { return }
        do {
            let response: SessionResponse = try await api.request("/v1/workspaces/\(workspace)/sessions")
            guard self.api === api else { return }
            sessions = response.sessions; error = nil
        } catch { self.error = error.localizedDescription }
        notify()
    }
    func select(_ session: RemoteSessionInfo) throws {
        saved.sessionId = session.id; saved.workspaceId = session.workspaceId
        try RemoteStorage.saveState(saved)
        if sync.view?.session.id != session.id { sync = RemoteSyncState() }
        disconnect(); watch(); notify()
    }
    @discardableResult
    func enqueue(_ operation: RemoteOperation) throws -> String {
        guard saved.outbox.filter({ !$0.rejected }).count < 16 else { throw RemoteClientError.message("已有 16 个未提交请求，请等待恢复连接。") }
        var next = saved
        next.outbox.append(PendingOperation(operation: operation))
        if operation.kind == "prompt", let sessionId = operation.sessionId { next.drafts[sessionId] = "" }
        try RemoteStorage.saveState(next) // Persist the same UUID before any network side effect.
        saved = next
        error = nil; notify(); flush()
        return operation.requestId
    }
    func removeUnsubmitted(_ requestId: String) throws {
        guard let pending = saved.outbox.first(where: { $0.id == requestId }), pending.rejected else {
            throw RemoteClientError.message("尚不确定服务是否接受此请求。请恢复连接后检查；要取消执行，请使用停止按钮。")
        }
        saved.outbox.removeAll { $0.id == requestId }
        try RemoteStorage.saveState(saved); notify()
    }
    func saveDraft(_ text: String, sessionId: String) {
        saved.drafts[sessionId] = text
        do { try RemoteStorage.saveState(saved) } catch { self.error = error.localizedDescription; notify() }
    }

    private func flush() {
        guard flushTask == nil, foreground, api != nil else { return }
        flushTask = Task { [weak self] in
            guard let self else { return }
            defer { self.flushTask = nil }
            var delay: UInt64 = 500_000_000
            while self.foreground, let api = self.api, let index = self.saved.outbox.firstIndex(where: { !$0.rejected }) {
                let operation = self.saved.outbox[index].operation
                do {
                    self.saved.outbox[index].attempted = true
                    try RemoteStorage.saveState(self.saved)
                    self.notify()
                    let receipt: OperationReceipt = try await api.request("/v1/operations", operation: operation)
                    guard self.api === api else { return }
                    self.lastAccepted = receipt
                    self.saved.outbox.removeAll { $0.id == operation.requestId }
                    if operation.kind == "create" || operation.kind == "adopt" {
                        self.saved.sessionId = receipt.sessionId; self.saved.workspaceId = operation.workspaceId
                        self.sync = RemoteSyncState(); self.disconnect()
                        if self.foreground { self.watch() }
                    }
                    try RemoteStorage.saveState(self.saved)
                    self.error = nil; self.notify(); delay = 500_000_000
                } catch {
                    guard self.api === api else { return }
                    let rejected: Bool
                    if case RemoteClientError.http(let code, _) = error { rejected = (400..<500).contains(code) && code != 429 }
                    else { rejected = false }
                    if let current = self.saved.outbox.firstIndex(where: { $0.id == operation.requestId }) {
                        self.saved.outbox[current].error = error.localizedDescription
                        self.saved.outbox[current].rejected = rejected
                    }
                    self.error = error.localizedDescription
                    do { try RemoteStorage.saveState(self.saved) } catch { self.error = error.localizedDescription }
                    self.notify()
                    if !rejected {
                        do { try await Task.sleep(nanoseconds: delay) } catch { return }
                        delay = min(delay * 2, 10_000_000_000)
                    }
                }
            }
        }
    }

    private func watch() {
        guard foreground, let sessionId = saved.sessionId, let api else { return }
        let generation = UUID(); connectionGeneration = generation
        connectionTask = Task { [weak self] in
            guard let self else { return }
            var delay: UInt64 = 500_000_000
            while !Task.isCancelled, self.foreground, self.connectionGeneration == generation {
                self.connection = "正在连接…"; self.notify()
                do {
                    let socket = try api.webSocket(sessionId: sessionId, epoch: self.sync.epoch, sequence: self.sync.sequence)
                    self.socket = socket
                    self.beginHeartbeat(socket, generation: generation)
                    while !Task.isCancelled, self.connectionGeneration == generation {
                        let message = try await socket.receive()
                        guard self.connectionGeneration == generation else { return }
                        let data: Data
                        switch message { case .data(let bytes): data = bytes; case .string(let text): data = Data(text.utf8); @unknown default: throw RemoteClientError.resynchronize }
                        let frame = try JSONDecoder().decode(RemoteFrame.self, from: data)
                        do { try self.sync.receive(frame) }
                        catch { self.sync.epoch = nil; self.sync.sequence = nil; throw error }
                        self.connection = "已连接 · 实时同步"; self.error = nil; delay = 500_000_000
                        self.notify(); self.scheduleCache(); self.flush()
                    }
                } catch {
                    guard self.connectionGeneration == generation, !Task.isCancelled else { return }
                    self.socket?.cancel(with: .goingAway, reason: nil)
                    self.heartbeatTask?.cancel()
                    self.connection = "连接中断 · 本机任务继续"
                    self.error = error.localizedDescription; self.notify()
                    do { try await Task.sleep(nanoseconds: delay) } catch { return }
                    delay = min(delay * 2, 10_000_000_000)
                }
            }
        }
    }
    private func beginHeartbeat(_ socket: URLSessionWebSocketTask, generation: UUID) {
        heartbeatTask?.cancel()
        heartbeatTask = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
                guard let self, self.connectionGeneration == generation else { return }
                let sent = Date()
                let owner = self
                socket.sendPing { error in
                    Task { @MainActor in
                        guard owner.connectionGeneration == generation else { return }
                        if error != nil { socket.cancel(with: .goingAway, reason: nil) }
                        else { owner.lastPong = Date() }
                    }
                }
                do { try await Task.sleep(for: .seconds(10)) } catch { return }
                if self.lastPong < sent { socket.cancel(with: .goingAway, reason: nil); return }
            }
        }
    }
    func loadOlderHistory() async {
        guard let api, let sessionId = saved.sessionId, let before = sync.view?.history.beforeOrdinal else { return }
        do {
            let page: RemoteHistory = try await api.request("/v1/sessions/\(sessionId)/history?before=\(before)")
            guard saved.sessionId == sessionId else { return }
            let merged = RemoteSyncState.merge(page.messages, sync.view?.history.messages ?? [])
            sync.view?.history = RemoteHistory(messages: merged, hasMore: page.hasMore, beforeOrdinal: page.beforeOrdinal)
            error = nil; notify()
        } catch { self.error = error.localizedDescription; notify() }
    }
    private func scheduleCache() {
        guard cacheTask == nil else { return }
        cacheTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(1))
            self?.cacheNow(); self?.cacheTask = nil
        }
    }
    private func cacheNow() {
        guard var view = sync.view else { return }
        view.history.messages = Array(view.history.messages.suffix(80))
        view.history.beforeOrdinal = view.history.messages.first?.ordinal
        view.history.hasMore = true
        do {
            try FileManager.default.createDirectory(at: cacheURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(view).write(to: cacheURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch { self.error = error.localizedDescription }
    }
    private func notify() { NotificationCenter.default.post(name: .remoteDidChange, object: self) }
}
