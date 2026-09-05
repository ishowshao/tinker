import { Box, Text, useApp, useInput } from "ink";
import { TextInput } from "@inkjs/ui";
import { useEffect, useState, useSyncExternalStore } from "react";
import { RemoteClient } from "../remote/client";
import type { RemoteSessionInfo } from "../remote/protocol";

/** An explicit network client mode; the normal App/controller path is untouched. */
export function RemoteApp({ client }: { client: RemoteClient }) {
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const { exit } = useApp();
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>([]);
  const [sessions, setSessions] = useState<RemoteSessionInfo[]>([]);
  const [workspace, setWorkspace] = useState<string | undefined>(client.workspaceId);
  const [notice, setNotice] = useState(
    "Select a workspace number. /workspaces returns here; /quit detaches.",
  );
  const [inputKey, setInputKey] = useState(0);
  const [visibleCount, setVisibleCount] = useState(30);
  const [browsing, setBrowsing] = useState(!client.sessionId);
  const report = (error: unknown) =>
    setNotice(error instanceof Error ? error.message : String(error));
  useEffect(() => {
    void client
      .workspaces()
      .then((result) => setWorkspaces(result.workspaces))
      .catch(report);
  }, [client]);
  useInput((input, key) => {
    if (key.ctrl && input === "c") exit();
  });
  const submit = async (text: string) => {
    setInputKey((value) => value + 1);
    if (!text.trim()) return;
    if (text === "/quit") {
      exit();
      return;
    }
    if (text === "/workspaces") {
      setWorkspace(undefined);
      setBrowsing(true);
      setSessions([]);
      setWorkspaces((await client.workspaces()).workspaces);
      return;
    }
    if (browsing) {
      if (!workspace) {
        const chosen = workspaces[Number(text) - 1];
        if (!chosen) throw new Error("Enter a workspace number.");
        setWorkspace(chosen.id);
        setSessions((await client.sessions(chosen.id)).sessions);
        setNotice(
          "Enter a session number, or /new. A local session is explicitly attached when selected.",
        );
      } else if (text === "/new") {
        await client.submit({ kind: "create", workspaceId: workspace });
        setBrowsing(false);
      } else {
        const chosen = sessions[Number(text) - 1];
        if (!chosen) throw new Error("Enter a session number or /new.");
        if (chosen.owner === "local")
          await client.submit({
            kind: "adopt",
            workspaceId: workspace,
            sessionId: chosen.id,
          });
        else await client.select(chosen.id, workspace);
        setBrowsing(false);
      }
      return;
    }
    const sessionId = client.sessionId;
    if (!sessionId) throw new Error("Waiting for the service to accept the session.");
    const pending = state.view?.interaction;
    if (text === "/stop") {
      if (!state.view?.activeRequestId) throw new Error("No active task is shown.");
      await client.submit({
        kind: "stop",
        sessionId,
        targetRequestId: state.view.activeRequestId,
      });
    } else if (text === "/allow" || text === "/deny") {
      if (pending?.kind !== "confirmation")
        throw new Error("No confirmation is pending.");
      await client.submit({
        kind: "confirm",
        sessionId,
        interactionId: pending.id,
        decision: text === "/allow" ? "allow" : "deny",
      });
    } else if (text.startsWith("/answer ") || text === "/dismiss") {
      if (pending?.kind !== "question") throw new Error("No question is pending.");
      await client.submit({
        kind: "answer",
        sessionId,
        interactionId: pending.id,
        selectedIndex: text === "/dismiss" ? null : Number(text.slice(8)) - 1,
      });
    } else if (text === "/history") {
      await client.loadOlderHistory();
      setVisibleCount((count) => count + 80);
      setNotice(
        "Older history loaded; use your terminal scrollback to read previous renders.",
      );
    } else if (text.startsWith("/")) {
      throw new Error(
        "Commands: /stop /allow /deny /answer N /dismiss /history /workspaces /quit",
      );
    } else {
      await client.submit({ kind: "prompt", sessionId, prompt: text });
    }
  };
  const view = state.view;
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        Tinker · Service connection
      </Text>
      <Text>
        {state.connection} · {view?.status ?? "select session"} · {state.pending}{" "}
        unsubmitted
      </Text>
      <Text dimColor>{notice}</Text>
      {state.error && <Text color="red">{safe(state.error)}</Text>}
      {browsing ? (
        <Box flexDirection="column">
          {!workspace
            ? workspaces.map((w, i) => (
                <Text key={w.id}>
                  {i + 1}. {safe(w.name)}
                </Text>
              ))
            : sessions.map((s, i) => (
                <Text key={s.id}>
                  {i + 1}. {safe(s.title)} · {s.status} · {s.owner}
                </Text>
              ))}
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text bold>{safe(view?.session.title ?? "Connecting…")}</Text>
          {view?.history.messages.slice(-visibleCount).map((message) => (
            <Box key={message.id} flexDirection="column" marginTop={1}>
              <Text bold color={message.role === "user" ? "green" : "cyan"}>
                {message.name ?? message.role}
              </Text>
              <Text>{safe(message.text)}</Text>
              {message.toolCalls?.map((call) => (
                <Text key={call.id} dimColor>
                  {call.name} {safe(call.arguments)}
                </Text>
              ))}
            </Box>
          ))}
          {view?.streaming && (
            <Box flexDirection="column">
              <Text dimColor>Generating…</Text>
              <Text>{safe(view.streaming.text)}</Text>
            </Box>
          )}
          {view?.tools
            .filter((tool) => tool.status === "running")
            .map((tool) => (
              <Text key={tool.id} color="yellow">
                {tool.name}: {safe(tool.arguments)}
              </Text>
            ))}
          {view?.interaction?.kind === "question" && (
            <Box flexDirection="column">
              <Text color="yellow">{safe(view.interaction.question)}</Text>
              {view.interaction.options.map((option, i) => (
                <Text key={i}>
                  {i + 1}. {safe(option.description)}
                </Text>
              ))}
              <Text>/answer N or /dismiss</Text>
            </Box>
          )}
          {view?.interaction?.kind === "confirmation" && (
            <Box flexDirection="column">
              <Text color="yellow">{safe(view.interaction.command)}</Text>
              <Text>{safe(view.interaction.reason)} · /allow or /deny</Text>
            </Box>
          )}
        </Box>
      )}
      <Box marginTop={1}>
        <Text color="cyan">› </Text>
        <TextInput
          key={inputKey}
          placeholder={
            browsing
              ? "Choose a workspace/session"
              : "Send task; /stop cancels; /quit detaches"
          }
          onSubmit={(value) => {
            void submit(value).catch(report);
          }}
        />
      </Box>
    </Box>
  );
}
function safe(value: string): string {
  return [...value]
    .filter((character) => {
      const code = character.codePointAt(0)!;
      return code === 10 || code === 9 || (code >= 32 && (code < 127 || code > 159));
    })
    .join("");
}
