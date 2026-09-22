import Foundation
import UIKit
import Testing
@testable import Tinker

@MainActor
struct TinkerTests {
    @Test func pairingRequiresHTTPSAndScopedCertificatePin() throws {
        let token = String(repeating: "a", count: 43)
        _ = try Pairing(name: "Mac", url: "https://localhost:18443", token: token).validated()
        #expect(throws: (any Error).self) { try Pairing(name: "Mac", url: "http://localhost", token: token).validated() }
        #expect(throws: (any Error).self) { try Pairing(name: "Mac", url: "https://user:password@host", token: token).validated() }
        #expect(throws: (any Error).self) { try Pairing(name: "Mac", url: "https://host/path", token: token).validated() }
        #expect(throws: (any Error).self) { try Pairing(name: "Mac", url: "https://host", token: token, certificateSha256: "bad").validated() }
    }

    @Test func outboxKeepsRequestIdentityAndExplicitQuestionDismissal() throws {
        let prompt = RemoteOperation(kind: "prompt", sessionId: "session", prompt: "hello")
        let saved = RemoteSavedState(endpoint: "https://host", sessionId: "session", outbox: [PendingOperation(operation: prompt, attempted: true)])
        let restored = try JSONDecoder().decode(RemoteSavedState.self, from: JSONEncoder().encode(saved))
        #expect(restored.outbox[0].id == prompt.requestId)
        #expect(restored.outbox[0].attempted)
        let answer = RemoteOperation(kind: "answer", sessionId: "session", interactionId: "interaction")
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(answer)) as! [String: Any]
        #expect(encoded["selectedIndex"] is NSNull)
        #expect(encoded["decision"] == nil)
        #expect(encoded["prompt"] == nil)
    }

    @Test func snapshotsAndDeltasMergeWithoutTreatingProvisionalTextAsHistory() throws {
        var state = RemoteSyncState()
        let base = try frame(sequence: 10, type: "snapshot")
        try state.receive(base)
        #expect(state.view?.streaming?.text == "partial")
        #expect(state.view?.history.messages.isEmpty == true)
        var delta = try frame(sequence: 11, type: "event")
        delta.change?.messages = [message(id: "one", ordinal: 1, text: "complete")]
        delta.change?.activity.streaming = nil
        try state.receive(delta)
        try state.receive(delta)
        #expect(state.view?.history.messages.count == 1)
        #expect(state.view?.history.messages[0].text == "complete")
        #expect(state.view?.streaming == nil)
        #expect(state.sequence == 11)
        let gap = try frame(sequence: 13, type: "event")
        #expect(throws: (any Error).self) { try state.receive(gap) }
        #expect(state.sequence == 11)
        var newBoot = try frame(sequence: 0, type: "snapshot")
        newBoot.epoch = "new"
        try state.receive(newBoot)
        #expect(state.epoch == "new")
        #expect(state.sequence == 0)
    }

    @Test func pagedHistoryKeepsOrderAndUpdatesCanonicalRows() {
        let result = RemoteSyncState.merge([message(id: "b", ordinal: 2, text: "old")], [message(id: "a", ordinal: 1, text: "first"), message(id: "b", ordinal: 2, text: "updated")])
        #expect(result.map(\.id) == ["a", "b"])
        #expect(result.last?.text == "updated")
    }

    @Test func remoteAnswerDismissesAnAlreadyOpenInteractionSheet() {
        let presentation = RemoteInteractionPresentation()
        #expect(presentation.update("first"))
        let alert = DismissalTrackingAlert(title: "Question", message: nil, preferredStyle: .actionSheet)
        let answer = UIAlertAction(title: "Answer", style: .default)
        alert.addAction(answer)
        presentation.track(alert)
        #expect(!presentation.update("first"))
        #expect(answer.isEnabled)
        #expect(!alert.wasDismissed)
        #expect(presentation.update(nil))
        #expect(!answer.isEnabled)
        #expect(alert.wasDismissed)
    }

    @Test func replacementInteractionInvalidatesOldSheetEvenWhenContentMatches() {
        let presentation = RemoteInteractionPresentation()
        presentation.update("first")
        let alert = DismissalTrackingAlert(title: "Same question", message: nil, preferredStyle: .actionSheet)
        let answer = UIAlertAction(title: "Answer", style: .default)
        alert.addAction(answer)
        presentation.track(alert)
        #expect(presentation.update("second"))
        #expect(!answer.isEnabled)
        #expect(alert.wasDismissed)
    }

    @Test func crossClientInteractionAndRestartReplaceProvisionalState() throws {
        var state = RemoteSyncState()
        var initial = try frame(sequence: 10, type: "snapshot")
        initial.view?.interaction = RemoteInteraction(id: "retry", kind: "question", question: "Retry provider?", options: [RemoteOption(description: "Retry"), RemoteOption(description: "Stop")])
        initial.view?.status = "waiting_input"
        initial.view?.activeRequestId = "active"
        try state.receive(initial)
        #expect(state.view?.interaction?.options?.count == 2)
        var answered = try frame(sequence: 11, type: "event")
        answered.change?.activity.interaction = nil
        try state.receive(answered)
        #expect(state.view?.interaction == nil)
        var restarted = try frame(sequence: 0, type: "snapshot")
        restarted.epoch = "restarted"
        restarted.view?.status = "interrupted"
        restarted.view?.streaming = nil
        restarted.view?.activeRequestId = nil
        try state.receive(restarted)
        #expect(state.view?.status == "interrupted")
        #expect(state.view?.activeRequestId == nil)
        #expect(state.view?.streaming == nil)
        #expect(throws: (any Error).self) { try state.receive(answered) }
        #expect(state.epoch == "restarted")
    }

    private func message(id: String, ordinal: Int, text: String) -> RemoteMessage {
        RemoteMessage(id: id, ordinal: ordinal, role: "assistant", text: text, turnId: "turn", turnStatus: "completed", createdAt: "now")
    }
    private func frame(sequence: Int, type: String) throws -> RemoteFrame {
        let activity = """
        {"session":{"id":"session","workspaceId":"workspace","title":"Title","modelName":"test","owner":"service","status":"running","updatedAt":"now"},"status":"running","streaming":{"iterationId":"iteration","attempt":1,"text":"partial"},"tools":[],"operations":[]}
        """
        var object = try JSONSerialization.jsonObject(with: Data(activity.utf8)) as! [String: Any]
        let body: [String: Any]
        if type == "snapshot" { object["history"] = ["messages": [], "hasMore": false]; body = ["view": object] }
        else { body = ["change": ["activity": object, "messages": []]] }
        let value = body.merging(["version": 1, "type": type, "epoch": "epoch", "sequence": sequence]) { _, new in new }
        return try JSONDecoder().decode(RemoteFrame.self, from: JSONSerialization.data(withJSONObject: value))
    }
}

@MainActor
private final class DismissalTrackingAlert: UIAlertController {
    var wasDismissed = false
    override func dismiss(animated flag: Bool, completion: (() -> Void)? = nil) {
        wasDismissed = true
        completion?()
    }
}
