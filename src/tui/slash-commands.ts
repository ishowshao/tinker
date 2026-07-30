export type SlashCommand = {
  readonly name: string;
  readonly description: string;
  readonly usage?: string;
};

export type BuiltInSlashCommand = SlashCommand & {
  readonly usage: string;
};

export const SLASH_COMMANDS: readonly BuiltInSlashCommand[] = [
  {
    name: "status",
    usage: "/status",
    description: "Show session and context details",
  },
  {
    name: "skills",
    usage: "/skills",
    description: "Show available and active Agent Skills",
  },
  {
    name: "mcp",
    usage: "/mcp",
    description: "Show MCP servers and runtime tools",
  },
  {
    name: "yolo",
    usage: "/yolo [on|off]",
    description: "Show or change destructive Bash confirmation",
  },
  {
    name: "memory",
    usage: "/memory",
    description: "Browse stored global memories",
  },
  {
    name: "compact",
    usage: "/compact [retire]",
    description: "Swap tool output or retire a cold history prefix",
  },
  {
    name: "clear",
    usage: "/clear",
    description: "Start a new session and clear conversation",
  },
  { name: "fork", usage: "/fork", description: "Clone the current session" },
  {
    name: "view",
    usage: "/view <path>",
    description: "View a local UTF-8 text file",
  },
  {
    name: "copy",
    usage: "/copy",
    description: "Copy the last response as Markdown",
  },
  {
    name: "model",
    usage: "/model [profile-name]",
    description: "Switch model profile (new session)",
  },
  {
    name: "resume",
    usage: "/resume [session-id]",
    description: "Choose or resume a session",
  },
  {
    name: "session",
    usage: "/session delete <session-id> --confirm",
    description: "Manage stored sessions",
  },
  { name: "quit", usage: "/quit", description: "Exit the TUI" },
];

export type ParsedSlashCommand =
  | { type: "status" }
  | { type: "yolo_status" }
  | { type: "yolo"; enabled: boolean }
  | { type: "skills" }
  | { type: "mcp" }
  | { type: "memory" }
  | { type: "compact" }
  | { type: "compact_retire" }
  | { type: "clear" }
  | { type: "fork" }
  | { type: "view"; filePath: string }
  | { type: "copy" }
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
    throw slashCommandUsageError("view");
  }
  if (trimmed.startsWith("/view ") || trimmed.startsWith("/view\t")) {
    const filePath = trimmed.slice(5).trim();
    if (filePath === "") {
      throw slashCommandUsageError("view");
    }
    return { type: "view", filePath };
  }

  const tokens = trimmed.split(/\s+/);
  const command = tokens[0];
  if (command === "/status" && tokens.length === 1) {
    return { type: "status" };
  }
  if (command === "/yolo") {
    if (tokens.length === 1) {
      return { type: "yolo_status" };
    }
    if (tokens.length === 2 && (tokens[1] === "on" || tokens[1] === "off")) {
      return { type: "yolo", enabled: tokens[1] === "on" };
    }
    throw slashCommandUsageError("yolo");
  }
  if (command === "/skills" && tokens.length === 1) {
    return { type: "skills" };
  }
  if (command === "/mcp") {
    if (tokens.length === 1) {
      return { type: "mcp" };
    }
    throw slashCommandUsageError("mcp");
  }
  if (command === "/memory") {
    if (tokens.length === 1) {
      return { type: "memory" };
    }
    throw slashCommandUsageError("memory");
  }
  if (command === "/compact") {
    if (tokens.length === 1) {
      return { type: "compact" };
    }
    if (tokens.length === 2 && tokens[1] === "retire") {
      return { type: "compact_retire" };
    }
    throw slashCommandUsageError("compact");
  }
  if (command === "/clear") {
    if (tokens.length === 1) {
      return { type: "clear" };
    }
    throw slashCommandUsageError("clear");
  }
  if (command === "/fork") {
    if (tokens.length === 1) {
      return { type: "fork" };
    }
    throw slashCommandUsageError("fork");
  }
  if (command === "/copy") {
    if (tokens.length === 1) {
      return { type: "copy" };
    }
    throw slashCommandUsageError("copy");
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
    throw slashCommandUsageError("model");
  }
  if (command === "/resume") {
    if (tokens.length === 1) {
      return { type: "resume_list" };
    }
    if (tokens.length === 2) {
      return { type: "resume", sessionId: parsePublicSessionId(tokens[1]) };
    }
    throw slashCommandUsageError("resume");
  }
  if (command === "/session") {
    if (tokens.length === 4 && tokens[1] === "delete" && tokens[3] === "--confirm") {
      return {
        type: "session_delete",
        sessionId: parsePublicSessionId(tokens[2]),
      };
    }
    throw slashCommandUsageError("session");
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

function slashCommandUsageError(
  name: (typeof SLASH_COMMANDS)[number]["name"],
): SlashCommandError {
  const command = SLASH_COMMANDS.find((candidate) => candidate.name === name);
  if (command === undefined) {
    throw new Error(`Missing built-in slash command declaration for ${name}.`);
  }
  return new SlashCommandError(`Usage: ${command.usage}`);
}
import { parseSessionId, type SessionId } from "../ids/runtime-id";
