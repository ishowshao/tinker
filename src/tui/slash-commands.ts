export type SlashCommand = {
  name: string;
  description: string;
};

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "status", description: "Show session and context details" },
  {
    name: "compact",
    description: "Swap tool output or retire a cold history prefix",
  },
  { name: "view", description: "View a local UTF-8 text file" },
  { name: "model", description: "Switch model profile (new session)" },
  { name: "resume", description: "Choose or resume a session" },
  { name: "session", description: "Manage stored sessions" },
  { name: "quit", description: "Exit the TUI" },
];

export type ParsedSlashCommand =
  | { type: "status" }
  | { type: "compact" }
  | { type: "compact_retire" }
  | { type: "view"; filePath: string }
  | { type: "quit" }
  | { type: "model" }
  | { type: "model_switch"; profileName: string }
  | { type: "resume_list" }
  | { type: "resume"; sessionId: SessionId }
  | { type: "session_delete"; sessionId: SessionId };

export class SlashCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlashCommandError";
  }
}

export function parseSlashCommand(input: string): ParsedSlashCommand {
  const trimmed = input.trim();
  if (trimmed === "/view") {
    throw new SlashCommandError("Usage: /view <path>");
  }
  if (trimmed.startsWith("/view ") || trimmed.startsWith("/view\t")) {
    const filePath = trimmed.slice(5).trim();
    if (filePath === "") {
      throw new SlashCommandError("Usage: /view <path>");
    }
    return { type: "view", filePath };
  }

  const tokens = trimmed.split(/\s+/);
  const command = tokens[0];
  if (command === "/status" && tokens.length === 1) {
    return { type: "status" };
  }
  if (command === "/compact") {
    if (tokens.length === 1) {
      return { type: "compact" };
    }
    if (tokens.length === 2 && tokens[1] === "retire") {
      return { type: "compact_retire" };
    }
    throw new SlashCommandError("Usage: /compact [retire]");
  }
  if (command === "/quit" && tokens.length === 1) {
    return { type: "quit" };
  }
  if (command === "/model") {
    if (tokens.length === 1) {
      return { type: "model" };
    }
    if (tokens.length === 2) {
      return { type: "model_switch", profileName: tokens[1] };
    }
    throw new SlashCommandError("Usage: /model [profile-name]");
  }
  if (command === "/resume") {
    if (tokens.length === 1) {
      return { type: "resume_list" };
    }
    if (tokens.length === 2) {
      return { type: "resume", sessionId: parsePublicSessionId(tokens[1]) };
    }
    throw new SlashCommandError("Usage: /resume [session-id]");
  }
  if (command === "/session") {
    if (tokens.length === 4 && tokens[1] === "delete" && tokens[3] === "--confirm") {
      return {
        type: "session_delete",
        sessionId: parsePublicSessionId(tokens[2]),
      };
    }
    throw new SlashCommandError("Usage: /session delete <session-id> --confirm");
  }
  throw new SlashCommandError(`Unknown command: ${trimmed}`);
}

export function matchSlashCommands(
  input: string,
  commands: readonly SlashCommand[] = SLASH_COMMANDS,
): SlashCommand[] {
  if (!input.startsWith("/")) {
    return [];
  }

  const query = input.slice(1);
  if (/\s/.test(query)) {
    return [];
  }

  return commands.filter((command) => command.name.startsWith(query));
}

export function findSlashCommand(
  input: string,
  commands: readonly SlashCommand[] = SLASH_COMMANDS,
): SlashCommand | undefined {
  if (!input.startsWith("/")) {
    return undefined;
  }

  const [name = ""] = input.slice(1).split(/\s+/, 1);
  return commands.find((command) => command.name === name);
}

function parsePublicSessionId(value: string): SessionId {
  try {
    return parseSessionId(value);
  } catch {
    throw new SlashCommandError(`Invalid session ID: ${value}`);
  }
}
import { parseSessionId, type SessionId } from "../ids/runtime-id";
