import UIKit

final class SessionViewController: UIViewController, UITableViewDataSource, UITableViewDelegate, UITextViewDelegate {
    private let store = RemoteAppStore.shared
    private let sessionId: String
    private let table = UITableView(frame: .zero, style: .plain)
    private let connectionLabel = UILabel()
    private let taskLabel = UILabel()
    private let composer = UITextView()
    private let sendButton = UIButton(configuration: .filled())
    private let interactionStack = UIStackView()
    private var shownInteractionId: String?
    private var rows: [Row] = []
    private struct Row: Equatable { var id: String; var title: String; var text: String; var kind: String }

    init(sessionId: String) { self.sessionId = sessionId; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("Use init(sessionId:)") }
    override func viewDidLoad() {
        super.viewDidLoad(); title = "会话"; view.backgroundColor = .systemBackground
        navigationItem.largeTitleDisplayMode = .never
        navigationItem.rightBarButtonItem = UIBarButtonItem(title: "停止", style: .plain, target: self, action: #selector(stop))
        navigationItem.rightBarButtonItem?.tintColor = .systemRed
        navigationItem.rightBarButtonItem?.accessibilityIdentifier = "stopTask"
        connectionLabel.font = .preferredFont(forTextStyle: .caption1); connectionLabel.textColor = .secondaryLabel
        connectionLabel.numberOfLines = 0; connectionLabel.accessibilityIdentifier = "connectionStatus"
        taskLabel.font = .preferredFont(forTextStyle: .subheadline); taskLabel.numberOfLines = 0; taskLabel.accessibilityIdentifier = "taskStatus"
        let status = UIStackView(arrangedSubviews: [taskLabel, connectionLabel]); status.axis = .vertical; status.spacing = 4
        table.dataSource = self; table.delegate = self; table.separatorStyle = .none
        table.keyboardDismissMode = .interactive; table.estimatedRowHeight = 130; table.rowHeight = UITableView.automaticDimension
        table.register(RemoteMessageCell.self, forCellReuseIdentifier: "message")
        table.accessibilityIdentifier = "conversation"
        let older = UIButton(type: .system); older.setTitle("加载更早的历史", for: .normal); older.addTarget(self, action: #selector(loadOlder), for: .touchUpInside)
        older.frame = CGRect(x: 0, y: 0, width: 200, height: 44); older.accessibilityIdentifier = "loadOlderHistory"; table.tableHeaderView = older
        composer.font = .preferredFont(forTextStyle: .body); composer.backgroundColor = .secondarySystemBackground
        composer.layer.cornerRadius = 14; composer.textContainerInset = UIEdgeInsets(top: 10, left: 10, bottom: 10, right: 10)
        composer.delegate = self; composer.accessibilityLabel = "输入任务"; composer.accessibilityIdentifier = "promptInput"
        composer.text = store.saved.drafts[sessionId] ?? ""
        sendButton.setTitle("发送", for: .normal); sendButton.addTarget(self, action: #selector(send), for: .touchUpInside); sendButton.accessibilityIdentifier = "sendPrompt"
        let input = UIStackView(arrangedSubviews: [composer, sendButton]); input.axis = .horizontal; input.spacing = 8; input.alignment = .bottom
        composer.heightAnchor.constraint(equalToConstant: 84).isActive = true
        sendButton.widthAnchor.constraint(equalToConstant: 70).isActive = true
        interactionStack.axis = .vertical; interactionStack.spacing = 8
        let stack = UIStackView(arrangedSubviews: [status, table, interactionStack, input]); stack.axis = .vertical; stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8), stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16), stack.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor, constant: -8)
        ])
        NotificationCenter.default.addObserver(self, selector: #selector(renderState), name: .remoteDidChange, object: store)
        renderState()
    }
    @objc private func renderState() {
        guard isViewLoaded else { return }
        let view = store.sync.view?.session.id == sessionId ? store.sync.view : nil
        title = view?.session.title ?? "正在接入会话…"
        connectionLabel.text = store.connection
        taskLabel.text = remoteStatusLabel(view?.status ?? "idle")
        taskLabel.textColor = view?.status == "failed" ? .systemRed : .label
        navigationItem.rightBarButtonItem?.isEnabled = view?.activeRequestId != nil
        var next: [Row] = []
        for message in view?.history.messages ?? [] {
            let label = message.role == "user" ? "你" : message.role == "assistant" ? "Tinker" : (message.name ?? "工具")
            if !message.text.isEmpty { next.append(Row(id: message.id, title: label, text: message.text, kind: message.role)) }
            for call in message.toolCalls ?? [] {
                let status = view?.tools.first(where: { $0.id == call.id })?.status
                next.append(Row(id: call.id, title: call.name + (status.map { " · \(remoteStatusLabel($0))" } ?? ""), text: call.arguments, kind: "tool"))
            }
        }
        if let streaming = view?.streaming { next.append(Row(id: "stream", title: "Tinker · 正在生成", text: streaming.text, kind: "assistant")) }
        for receipt in view?.operations ?? [] where receipt.kind == "prompt" && receipt.status == "accepted" {
            next.append(Row(id: receipt.id, title: "后续任务 · 已接受", text: receipt.prompt ?? "", kind: "queued"))
        }
        for pending in store.saved.outbox where pending.operation.sessionId == sessionId {
            let label = pending.rejected ? "提交未被接受" : pending.attempted ? "提交确认中 · 将使用同一请求重试" : "未提交 · 等待连接"
            next.append(Row(id: pending.id, title: label, text: (pending.operation.prompt ?? "操作") + (pending.error.map { "\n\($0)" } ?? ""), kind: "queued"))
        }
        if let error = view?.error ?? store.error { next.append(Row(id: "error", title: "状态提示", text: error, kind: "error")) }
        if next != rows {
            let atBottom = table.contentSize.height - table.bounds.height - table.contentOffset.y < 120
            let oldOffset = table.contentOffset
            rows = next; table.reloadData(); table.layoutIfNeeded()
            if atBottom, !rows.isEmpty { table.scrollToRow(at: IndexPath(row: rows.count - 1, section: 0), at: .bottom, animated: false) }
            else { table.contentOffset = oldOffset }
        }
        table.tableHeaderView?.isHidden = !(view?.history.hasMore ?? false)
        if shownInteractionId != view?.interaction?.id {
            shownInteractionId = view?.interaction?.id
            renderInteraction(view?.interaction)
        }
    }
    private func renderInteraction(_ pending: RemoteInteraction?) {
        for child in interactionStack.arrangedSubviews { interactionStack.removeArrangedSubview(child); child.removeFromSuperview() }
        interactionStack.isHidden = pending == nil
        guard let pending else { return }
        let label = UILabel(); label.font = .preferredFont(forTextStyle: .subheadline); label.numberOfLines = 3
        label.text = pending.kind == "question" ? pending.question : "需要确认：\(pending.command ?? "")"
        interactionStack.addArrangedSubview(label)
        let button = UIButton(configuration: .tinted())
        button.setTitle(pending.kind == "question" ? "回答提问" : "查看并确认命令", for: .normal)
        button.accessibilityIdentifier = "answerInteraction"
        button.addAction(UIAction { [weak self] _ in self?.presentInteraction(pending) }, for: .touchUpInside)
        interactionStack.addArrangedSubview(button)
    }
    private func presentInteraction(_ pending: RemoteInteraction) {
        let alert = UIAlertController(title: pending.kind == "question" ? pending.question : "确认工具执行", message: pending.kind == "confirmation" ? "\(pending.command ?? "")\n\n\(pending.reason ?? "")" : nil, preferredStyle: .actionSheet)
        if pending.kind == "question" {
            for (index, option) in (pending.options ?? []).enumerated() {
                alert.addAction(UIAlertAction(title: option.description, style: .default) { [weak self] _ in self?.answer(pending, selectedIndex: index) })
            }
            alert.addAction(UIAlertAction(title: "明确跳过此问题", style: .destructive) { [weak self] _ in self?.answer(pending, selectedIndex: nil) })
        } else {
            alert.addAction(UIAlertAction(title: "允许执行", style: .destructive) { [weak self] _ in self?.confirm(pending, decision: "allow") })
            alert.addAction(UIAlertAction(title: "拒绝执行", style: .default) { [weak self] _ in self?.confirm(pending, decision: "deny") })
        }
        alert.addAction(UIAlertAction(title: "稍后处理", style: .cancel))
        alert.popoverPresentationController?.sourceView = interactionStack
        present(alert, animated: true)
    }
    private func answer(_ pending: RemoteInteraction, selectedIndex: Int?) {
        do { try store.enqueue(RemoteOperation(kind: "answer", sessionId: sessionId, interactionId: pending.id, selectedIndex: selectedIndex)) } catch { showError(error) }
    }
    private func confirm(_ pending: RemoteInteraction, decision: String) {
        do { try store.enqueue(RemoteOperation(kind: "confirm", sessionId: sessionId, interactionId: pending.id, decision: decision)) } catch { showError(error) }
    }
    @objc private func send() {
        let text = composer.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        guard text.utf8.count <= 64 * 1024 else { showError(RemoteClientError.message("单次任务最多 64 KiB，请缩短输入。")); return }
        do { try store.enqueue(RemoteOperation(kind: "prompt", sessionId: sessionId, prompt: text)); composer.text = ""; composer.resignFirstResponder() }
        catch { showError(error) }
    }
    @objc private func stop() {
        guard let requestId = store.sync.view?.activeRequestId else { return }
        do { try store.enqueue(RemoteOperation(kind: "stop", sessionId: sessionId, targetRequestId: requestId)) } catch { showError(error) }
    }
    @objc private func loadOlder() { Task { await store.loadOlderHistory() } }
    func textViewDidChange(_ textView: UITextView) { store.saveDraft(textView.text, sessionId: sessionId) }
    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { rows.count }
    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "message", for: indexPath) as! RemoteMessageCell
        let row = rows[indexPath.row]
        cell.configure(title: row.title, text: row.text, kind: row.kind)
        return cell
    }
    private func showError(_ error: Error) {
        let alert = UIAlertController(title: "无法完成操作", message: error.localizedDescription, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "好", style: .default)); present(alert, animated: true)
    }
}

private final class RemoteMessageCell: UITableViewCell {
    private let heading = UILabel()
    private let body = UITextView()
    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        selectionStyle = .none; backgroundColor = .clear
        heading.font = .preferredFont(forTextStyle: .caption1); heading.numberOfLines = 0
        body.isEditable = false; body.isScrollEnabled = false; body.backgroundColor = .clear
        body.textContainerInset = .zero; body.textContainer.lineFragmentPadding = 0
        body.adjustsFontForContentSizeCategory = true
        let stack = UIStackView(arrangedSubviews: [heading, body]); stack.axis = .vertical; stack.spacing = 6; stack.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(stack)
        NSLayoutConstraint.activate([stack.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 12), stack.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -12), stack.leadingAnchor.constraint(equalTo: contentView.leadingAnchor), stack.trailingAnchor.constraint(equalTo: contentView.trailingAnchor)])
    }
    required init?(coder: NSCoder) { fatalError("Use init(style:reuseIdentifier:)") }
    func configure(title: String, text: String, kind: String) {
        heading.text = title
        heading.textColor = kind == "user" ? .systemBlue : kind == "error" ? .systemRed : .secondaryLabel
        body.font = kind == "tool" ? .monospacedSystemFont(ofSize: 13, weight: .regular) : .preferredFont(forTextStyle: .body)
        body.textColor = .label; body.text = text
        body.accessibilityIdentifier = kind == "assistant" ? "assistantText" : "messageText"
    }
}
