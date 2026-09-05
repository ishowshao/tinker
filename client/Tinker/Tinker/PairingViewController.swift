import UIKit
import UniformTypeIdentifiers

final class PairingViewController: UIViewController, UIDocumentPickerDelegate {
    private let endpoint = UITextField()
    private let token = UITextField()
    private let fingerprint = UITextField()
    private let note = UILabel()
    private var importedName = "我的 Mac"
    override func viewDidLoad() {
        super.viewDidLoad(); title = "连接你的 Mac"
        view.backgroundColor = .systemBackground
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "取消", style: .plain, target: self, action: #selector(close))
        navigationItem.rightBarButtonItem = UIBarButtonItem(title: "连接", style: .prominent, target: self, action: #selector(save))
        navigationItem.rightBarButtonItem?.accessibilityIdentifier = "savePairing"
        let heading = UILabel(); heading.text = "随时接回本机的工作"; heading.font = .preferredFont(forTextStyle: .title2); heading.numberOfLines = 0
        note.text = "从 Mac 导入 pairing.json，或填写连接信息。任务由 Mac 执行，手机断线后仍会继续。"
        note.font = .preferredFont(forTextStyle: .subheadline); note.textColor = .secondaryLabel; note.numberOfLines = 0
        let importButton = UIButton(configuration: .tinted()); importButton.setTitle("导入配对文件", for: .normal)
        importButton.addTarget(self, action: #selector(importFile), for: .touchUpInside); importButton.accessibilityIdentifier = "importPairing"
        for field in [endpoint, token, fingerprint] {
            field.borderStyle = .roundedRect; field.font = .preferredFont(forTextStyle: .body)
            field.autocorrectionType = .no; field.autocapitalizationType = .none
            field.clearButtonMode = .always
        }
        endpoint.placeholder = "https://your-mac.example.com"; endpoint.keyboardType = .URL; endpoint.accessibilityIdentifier = "pairingURL"
        token.placeholder = "设备凭据"; token.isSecureTextEntry = true; token.accessibilityIdentifier = "pairingToken"
        fingerprint.placeholder = "本地证书指纹（正式证书可留空）"; fingerprint.accessibilityIdentifier = "pairingFingerprint"
        let fields = UIStackView(arrangedSubviews: [heading, note, importButton, fieldLabel("HTTPS 入口"), endpoint, fieldLabel("设备凭据"), token, fieldLabel("本地开发证书（可选）"), fingerprint])
        fields.axis = .vertical; fields.spacing = 14; fields.translatesAutoresizingMaskIntoConstraints = false
        let scroll = UIScrollView(); scroll.translatesAutoresizingMaskIntoConstraints = false; scroll.keyboardDismissMode = .interactive
        view.addSubview(scroll); scroll.addSubview(fields)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor), scroll.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor), scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            fields.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 24), fields.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -24),
            fields.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 24), fields.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -24),
            fields.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -48)
        ])
        if let pairing = RemoteAppStore.shared.pairing { fill(pairing) }
    }
    private func fieldLabel(_ text: String) -> UILabel { let label = UILabel(); label.text = text; label.font = .preferredFont(forTextStyle: .caption1); label.textColor = .secondaryLabel; return label }
    private func fill(_ pairing: Pairing) { loadViewIfNeeded(); importedName = pairing.name; endpoint.text = pairing.url; token.text = pairing.token; fingerprint.text = pairing.certificateSha256 }
    func importPairing(_ pairing: Pairing) { fill(pairing) }
    @objc private func close() { dismiss(animated: true) }
    @objc private func save() {
        do {
            let pin = fingerprint.text?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
            try RemoteAppStore.shared.configure(Pairing(name: importedName, url: endpoint.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "", token: token.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "", certificateSha256: pin.isEmpty ? nil : pin))
            dismiss(animated: true)
        } catch { note.text = error.localizedDescription; note.textColor = .systemRed }
    }
    @objc private func importFile() { let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.json], asCopy: true); picker.delegate = self; present(picker, animated: true) }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let url = urls.first else { return }
        let scoped = url.startAccessingSecurityScopedResource(); defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        do { fill(try JSONDecoder().decode(Pairing.self, from: Data(contentsOf: url)).validated()); note.text = "配对信息已导入，点“连接”保存到钥匙串。" }
        catch { note.text = error.localizedDescription; note.textColor = .systemRed }
    }
}
