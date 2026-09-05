//
//  ViewController.swift
//  Tinker
//
//  Created by cyberoldman on 2026/9/5.
//

import UIKit

class RemoteListViewController: UIViewController, UITableViewDataSource, UITableViewDelegate {
    let store = RemoteAppStore.shared
    let table = UITableView(frame: .zero, style: .insetGrouped)
    let statusLabel = UILabel()
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemGroupedBackground
        statusLabel.font = .preferredFont(forTextStyle: .footnote)
        statusLabel.textColor = .secondaryLabel
        statusLabel.numberOfLines = 0
        statusLabel.accessibilityIdentifier = "connectionStatus"
        table.dataSource = self; table.delegate = self
        table.refreshControl = UIRefreshControl()
        table.refreshControl?.addTarget(self, action: #selector(refresh), for: .valueChanged)
        let stack = UIStackView(arrangedSubviews: [statusLabel, table])
        stack.axis = .vertical; stack.spacing = 8; stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            stack.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        NotificationCenter.default.addObserver(self, selector: #selector(renderState), name: .remoteDidChange, object: store)
        renderState()
    }
    @objc func refresh() { table.refreshControl?.endRefreshing() }
    @objc func renderState() { statusLabel.text = store.connection + (store.error.map { "\n\($0)" } ?? ""); table.reloadData() }
    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { 0 }
    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell { UITableViewCell() }
    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {}
    func cell(_ title: String, detail: String?, symbol: String, identifier: String? = nil) -> UITableViewCell {
        let cell = UITableViewCell(style: .subtitle, reuseIdentifier: nil)
        var content = cell.defaultContentConfiguration()
        content.text = title; content.secondaryText = detail; content.image = UIImage(systemName: symbol)
        content.textProperties.numberOfLines = 2; content.secondaryTextProperties.numberOfLines = 2
        cell.contentConfiguration = content; cell.accessoryType = .disclosureIndicator
        cell.accessibilityIdentifier = identifier
        return cell
    }
    func showError(_ error: Error) {
        let alert = UIAlertController(title: "无法完成操作", message: error.localizedDescription, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "好", style: .default)); present(alert, animated: true)
    }
}

class ViewController: RemoteListViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Tinker"
        navigationController?.navigationBar.prefersLargeTitles = true
        navigationItem.rightBarButtonItem = UIBarButtonItem(image: UIImage(systemName: "link"), style: .plain, target: self, action: #selector(pair))
        navigationItem.rightBarButtonItem?.accessibilityLabel = "连接设置"
        navigationItem.rightBarButtonItem?.accessibilityIdentifier = "pairingSettings"
        store.activate()
    }
    @objc private func pair() { present(UINavigationController(rootViewController: PairingViewController()), animated: true) }
    override func refresh() { Task { await store.refreshWorkspaces(); table.refreshControl?.endRefreshing() } }
    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        if store.pairing == nil { return 1 }
        return store.workspaces.count + (store.saved.sessionId == nil ? 0 : 1)
    }
    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        if store.pairing == nil { return cell("连接你的 Mac", detail: "导入配对文件，或填写 HTTPS 入口和设备凭据", symbol: "laptopcomputer", identifier: "pairMac") }
        if store.saved.sessionId != nil, indexPath.row == 0 {
            return cell(store.sync.view?.session.title ?? "继续上次会话", detail: "\(remoteStatusLabel(store.sync.view?.status ?? "idle")) · 接入同一个会话", symbol: "bubble.left.and.bubble.right", identifier: "resumeSession")
        }
        let workspace = store.workspaces[indexPath.row - (store.saved.sessionId == nil ? 0 : 1)]
        return cell(workspace.name, detail: "本机工作区", symbol: "folder", identifier: "workspace-\(workspace.id)")
    }
    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        if store.pairing == nil { pair(); return }
        if let sessionId = store.saved.sessionId, indexPath.row == 0 {
            navigationController?.pushViewController(SessionViewController(sessionId: sessionId), animated: true); return
        }
        let workspace = store.workspaces[indexPath.row - (store.saved.sessionId == nil ? 0 : 1)]
        navigationController?.pushViewController(WorkspaceViewController(workspace: workspace), animated: true)
    }
}

final class WorkspaceViewController: RemoteListViewController {
    private let workspace: RemoteWorkspace
    private var awaitingRequestId: String?
    init(workspace: RemoteWorkspace) { self.workspace = workspace; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("Use init(workspace:)") }
    override func viewDidLoad() {
        super.viewDidLoad(); title = workspace.name
        navigationItem.rightBarButtonItem = UIBarButtonItem(title: "新建会话", style: .plain, target: self, action: #selector(create))
        navigationItem.rightBarButtonItem?.accessibilityIdentifier = "createSession"
        refresh()
    }
    override func refresh() { Task { await store.refreshSessions(workspace: workspace.id); table.refreshControl?.endRefreshing() } }
    @objc private func create() {
        do {
            let operation = RemoteOperation(kind: "create", workspaceId: workspace.id)
            awaitingRequestId = operation.requestId
            try store.enqueue(operation)
            navigationItem.rightBarButtonItem?.isEnabled = false
        } catch { awaitingRequestId = nil; showError(error) }
    }
    override func renderState() {
        super.renderState()
        if let awaitingRequestId, store.lastAccepted?.requestId == awaitingRequestId, let sessionId = store.saved.sessionId, store.saved.workspaceId == workspace.id,
           store.sync.view?.session.id == sessionId {
            self.awaitingRequestId = nil; navigationItem.rightBarButtonItem?.isEnabled = true
            navigationController?.pushViewController(SessionViewController(sessionId: sessionId), animated: true)
            refresh()
        }
        if let awaitingRequestId, store.saved.outbox.first(where: { $0.id == awaitingRequestId })?.rejected == true {
            self.awaitingRequestId = nil; navigationItem.rightBarButtonItem?.isEnabled = true
        }
    }
    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { store.sessions.filter { $0.workspaceId == workspace.id }.count }
    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let session = store.sessions.filter { $0.workspaceId == workspace.id }[indexPath.row]
        return cell(session.title, detail: "\(remoteStatusLabel(session.status)) · \(session.owner == "service" ? "服务托管" : "本地会话")", symbol: "bubble.left.and.text.bubble.right", identifier: "sessionRow")
    }
    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        let session = store.sessions.filter { $0.workspaceId == workspace.id }[indexPath.row]
        if session.owner == "local" {
            let alert = UIAlertController(title: "接入本地会话", message: "请先退出正在使用它的本地 TUI。接入后由服务执行任务，手机退出不会停止任务。", preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "取消", style: .cancel))
            alert.addAction(UIAlertAction(title: "接入", style: .default) { [weak self] _ in
                guard let self else { return }
                do { let operation = RemoteOperation(kind: "adopt", workspaceId: self.workspace.id, sessionId: session.id); self.awaitingRequestId = operation.requestId; try self.store.enqueue(operation) }
                catch { self.awaitingRequestId = nil; self.showError(error) }
            }); present(alert, animated: true)
        } else {
            do { try store.select(session); navigationController?.pushViewController(SessionViewController(sessionId: session.id), animated: true) }
            catch { showError(error) }
        }
    }
}
