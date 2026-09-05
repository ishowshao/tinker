import Foundation
import Darwin

/// Opt-in local acceptance evidence; never contains prompts or credentials.
enum AcceptanceTrace {
    static func record(_ event: String) {
        #if DEBUG
        guard ProcessInfo.processInfo.environment["TINKER_ACCEPTANCE_DIAGNOSTICS"] == "1" else { return }
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var query: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        let result = sysctl(&query, UInt32(query.count), &info, &size, nil, 0)
        let store = RemoteAppStore.shared
        let record: [String: Any] = [
            "event": event, "at": ISO8601DateFormatter().string(from: Date()), "pid": getpid(),
            "debuggerCheckSucceeded": result == 0, "debuggerAttached": (info.kp_proc.p_flag & P_TRACED) != 0,
            "sessionId": store.saved.sessionId ?? "", "requestId": store.sync.view?.activeRequestId ?? "",
            "status": store.sync.view?.status ?? "idle"
        ]
        do {
            let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let file = directory.appendingPathComponent("remote-acceptance.jsonl")
            var data = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
            data.append(10)
            if !FileManager.default.fileExists(atPath: file.path) { try data.write(to: file, options: .completeFileProtectionUntilFirstUserAuthentication) }
            else { let handle = try FileHandle(forWritingTo: file); defer { try? handle.close() }; try handle.seekToEnd(); try handle.write(contentsOf: data) }
        } catch { /* Diagnostic output must not change client behavior. */ }
        #endif
    }
}
