import XCTest

final class TinkerUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    @MainActor
    func testPairingRejectsAnInsecureEndpoint() throws {
        let app = XCUIApplication(); app.launch()
        XCTAssertTrue(app.buttons["pairingSettings"].waitForExistence(timeout: 15))
        app.buttons["pairingSettings"].tap()
        replace(app.textFields["pairingURL"], with: "http://localhost")
        app.buttons["savePairing"].tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "请输入 HTTPS")).firstMatch.waitForExistence(timeout: 5))
    }

    @MainActor
    func testNativeRelayFlowBackgroundAndRelaunch() throws {
        let app = try connectedApp()
        try openNewSession(app)
        let marker = "IOS_BACKGROUND_" + UUID().uuidString.prefix(8)
        send(app, "Connectivity acceptance. Do not edit source files. Call Bash with command: sleep 12; printf '\(marker)\\n'. Wait for it and reply with \(marker).")
        waitForStatus(app, containing: "执行中", timeout: 120)
        let tool = app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "Bash")).firstMatch
        XCTAssertTrue(tool.waitForExistence(timeout: 120), "The foreground app must show a real tool call")
        attach(app, name: "Foreground real tool progress")
        XCUIDevice.shared.press(.home)
        XCTAssertTrue(app.wait(for: .runningBackground, timeout: 10))
        Thread.sleep(forTimeInterval: 16)
        app.activate()
        waitForStatus(app, containing: "已完成", timeout: 120)
        XCTAssertTrue(app.textViews.matching(identifier: "assistantText").containing(NSPredicate(format: "value CONTAINS %@", String(marker))).firstMatch.waitForExistence(timeout: 10))
        attach(app, name: "Background result recovered")

        let relaunchMarker = "IOS_RELAUNCH_" + UUID().uuidString.prefix(8)
        send(app, "Connectivity acceptance. Call Bash with command: sleep 12; printf '\(relaunchMarker)\\n'. Then reply with \(relaunchMarker). Do not edit source files.")
        waitForStatus(app, containing: "执行中", timeout: 120)
        app.terminate()
        Thread.sleep(forTimeInterval: 16)
        app.launch()
        XCTAssertTrue(app.cells["resumeSession"].waitForExistence(timeout: 20))
        app.cells["resumeSession"].tap()
        waitForStatus(app, containing: "已完成", timeout: 120)
        XCTAssertTrue(app.textViews.matching(identifier: "assistantText").containing(NSPredicate(format: "value CONTAINS %@", String(relaunchMarker))).firstMatch.waitForExistence(timeout: 20))
        attach(app, name: "Relaunch result recovered")
    }

    @MainActor
    func testNativeQuestionAndExplicitStop() throws {
        let app = try connectedApp()
        try openNewSession(app)
        send(app, "Acceptance test: call AskUser with question 'Choose a scope' and options 'Current workspace' and 'All workspaces'. After the answer reply IOS_QUESTION_DONE. Do not edit files.")
        XCTAssertTrue(app.buttons["answerInteraction"].waitForExistence(timeout: 120))
        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(app.buttons["answerInteraction"].waitForExistence(timeout: 20))
        app.buttons["answerInteraction"].tap()
        XCTAssertTrue(app.buttons["Current workspace"].waitForExistence(timeout: 10))
        app.buttons["Current workspace"].tap()
        waitForStatus(app, containing: "已完成", timeout: 120)
        send(app, "Acceptance test: call Bash with command sleep 60, then say DONE. Do not edit files.")
        waitForStatus(app, containing: "执行中", timeout: 120)
        app.buttons["stopTask"].tap()
        waitForStatus(app, containing: "已取消", timeout: 30)
        attach(app, name: "Explicit stop")
    }

    @MainActor
    private func connectedApp() throws -> XCUIApplication {
        guard let text = ProcessInfo.processInfo.environment["TINKER_UI_PAIRING_JSON"] else { throw XCTSkip("Set TINKER_UI_PAIRING_JSON in the test runner to run the real relay journeys.") }
        let pairing = try JSONSerialization.jsonObject(with: Data(text.utf8)) as! [String: Any]
        let app = XCUIApplication()
        app.launchEnvironment["TINKER_ACCEPTANCE_DIAGNOSTICS"] = "1"
        addUIInterruptionMonitor(withDescription: "Local network permission") { alert in
            for title in ["Allow", "允许", "好", "OK"] where alert.buttons[title].exists { alert.buttons[title].tap(); return true }
            return false
        }
        app.launch()
        XCTAssertTrue(app.buttons["pairingSettings"].waitForExistence(timeout: 20))
        app.buttons["pairingSettings"].tap()
        replace(app.textFields["pairingURL"], with: pairing["url"] as! String)
        replace(app.secureTextFields["pairingToken"], with: pairing["token"] as! String)
        replace(app.textFields["pairingFingerprint"], with: pairing["certificateSha256"] as? String ?? "")
        app.buttons["savePairing"].tap()
        let workspace = app.cells["workspace-workspace"]
        if !workspace.waitForExistence(timeout: 15) { app.tap() }
        XCTAssertTrue(workspace.waitForExistence(timeout: 30))
        return app
    }
    @MainActor
    private func openNewSession(_ app: XCUIApplication) throws {
        app.cells["workspace-workspace"].tap()
        XCTAssertTrue(app.buttons["createSession"].waitForExistence(timeout: 10))
        app.buttons["createSession"].tap()
        XCTAssertTrue(app.textViews["promptInput"].waitForExistence(timeout: 60))
    }
    @MainActor
    private func replace(_ field: XCUIElement, with value: String) {
        XCTAssertTrue(field.waitForExistence(timeout: 10)); field.tap()
        if field.buttons.firstMatch.exists { field.buttons.firstMatch.tap() }
        field.typeText(value)
        if field.elementType == .textField { XCTAssertTrue((field.value as? String) == value, "The input must replace the complete previous value") }
    }
    @MainActor
    private func send(_ app: XCUIApplication, _ prompt: String) {
        let input = app.textViews["promptInput"]; input.tap(); input.typeText(prompt); app.buttons["sendPrompt"].tap()
    }
    @MainActor
    private func waitForStatus(_ app: XCUIApplication, containing text: String, timeout: TimeInterval) {
        let status = app.staticTexts["taskStatus"]
        let predicate = NSPredicate(format: "label CONTAINS %@", text)
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: status)], timeout: timeout), .completed)
    }
    @MainActor
    private func attach(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
}
