import UIKit

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = self.window ?? UIWindow(windowScene: scene)
        window.rootViewController = UINavigationController(rootViewController: ViewController())
        self.window = window
        window.makeKeyAndVisible()
        AcceptanceTrace.record("launch")
        if let url = connectionOptions.urlContexts.first?.url { importPairing(url) }
    }
    func sceneDidBecomeActive(_ scene: UIScene) { RemoteAppStore.shared.activate(); AcceptanceTrace.record("foreground") }
    func sceneDidEnterBackground(_ scene: UIScene) { AcceptanceTrace.record("background"); RemoteAppStore.shared.background() }
    func sceneDidDisconnect(_ scene: UIScene) { RemoteAppStore.shared.background() }
    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        if let url = URLContexts.first?.url { importPairing(url) }
    }
    private func importPairing(_ url: URL) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        do {
            let pairing = try JSONDecoder().decode(Pairing.self, from: Data(contentsOf: url)).validated()
            let controller = PairingViewController()
            controller.importPairing(pairing)
            window?.rootViewController?.present(UINavigationController(rootViewController: controller), animated: true)
        } catch {
            let alert = UIAlertController(title: "无法导入配对文件", message: error.localizedDescription, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "好", style: .default))
            window?.rootViewController?.present(alert, animated: true)
        }
    }
}
