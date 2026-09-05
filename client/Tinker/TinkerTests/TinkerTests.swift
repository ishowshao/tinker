import Foundation
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
