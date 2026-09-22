export type PublicCliOption = {
  readonly flags: string;
  readonly description: string;
  readonly valueName?: string;
};

export type PublicPromptSource = {
  readonly kind: "argument" | "stdin" | "file";
  readonly syntax: string;
  readonly description: string;
};

const PROFILE_OPTION = Object.freeze({
  flags: "-p, --profile <profile-name>",
  description: "Select a model profile.",
  valueName: "profile-name",
} satisfies PublicCliOption);

const RUN_PROMPT_SOURCES = Object.freeze([
  Object.freeze({
    kind: "argument",
    syntax: "<prompt>",
    description: "Submit one shell-quoted prompt argument.",
  }),
  Object.freeze({
    kind: "stdin",
    syntax: "--stdin",
    description: "Read the prompt from standard input until EOF.",
  }),
  Object.freeze({
    kind: "file",
    syntax: "--file <path>",
    description: "Read the prompt from a UTF-8 text file.",
  }),
] satisfies readonly PublicPromptSource[]);

export const PUBLIC_CLI_CONTRACT = Object.freeze({
  name: "tinker",
  description: "A personal coding agent for a local workspace.",
  helpFlags: "-h, --help",
  versionFlags: "-V, --version",
  helpCommand: Object.freeze({
    command: "help [command]",
    description: "display help for command",
  }),
  tui: Object.freeze({
    description:
      "Start the full TUI through the shared local service; exiting detaches only.",
    localOption: Object.freeze({
      flags: "--local",
      description: "Run the TUI independently without a service (explicit fallback).",
    } satisfies PublicCliOption),
    profileOption: PROFILE_OPTION,
  }),
  serve: Object.freeze({
    residentOptions: Object.freeze([
      {
        flags: "--install",
        description:
          "Install and start a macOS per-user LaunchAgent with crash restart.",
      },
      {
        flags: "--uninstall",
        description:
          "Drain, stop and remove the LaunchAgent; retain history and configuration.",
      },
      {
        flags: "--stop",
        description:
          "Drain and stop the service; disable supervisor restart until the next start.",
      },
      {
        flags: "--restart",
        description: "Drain and restart with the current executable and configuration.",
      },
      {
        flags: "--force",
        description: "Allow interruption after the configured shutdown grace period.",
      },
    ] satisfies readonly PublicCliOption[]),
    command: "serve",
    description: "Run the local daemon for paired remote clients.",
    configOption: Object.freeze({
      flags: "--config <path>",
      description:
        "Read service JSON (default: <home>/.tinker/service/service.json; home follows TINKER_HOME).",
      valueName: "path",
    } satisfies PublicCliOption),
    backgroundOption: Object.freeze({
      flags: "--background",
      description:
        "Discover or start one detached service for this state directory, and print its address as JSON.",
    } satisfies PublicCliOption),
    statusOption: Object.freeze({
      flags: "--status",
      description:
        "Probe the local service without starting it; print JSON and exit 1 when offline.",
    } satisfies PublicCliOption),
  }),
  connect: Object.freeze({
    command: "connect",
    description: "Attach a terminal client to a service; exiting detaches only.",
    tuiOption: Object.freeze({
      flags: "--tui",
      description: "Use the full TUI for service sessions and task execution.",
    } satisfies PublicCliOption),
    workspaceOption: Object.freeze({
      flags: "--workspace <id>",
      description:
        "Select a service workspace for --tui; otherwise resolve the current directory on the service host.",
      valueName: "id",
    } satisfies PublicCliOption),
    serviceConfigOption: Object.freeze({
      flags: "--service-config <path>",
      description:
        "With --tui, discover/start this local service and register the current directory if needed.",
      valueName: "path",
    } satisfies PublicCliOption),
    sessionOption: Object.freeze({
      flags: "--session <id>",
      description:
        "Connect an existing session with --tui; otherwise create a new one.",
      valueName: "id",
    } satisfies PublicCliOption),
    configOption: Object.freeze({
      flags: "--config <path>",
      description: "Read the paired client JSON configuration.",
      valueName: "path",
    } satisfies PublicCliOption),
  }),
  run: Object.freeze({
    command: "run [prompt]",
    description: "Run one prompt non-interactively.",
    profileOption: PROFILE_OPTION,
    stdinOption: Object.freeze({
      flags: "--stdin",
      description: "Read the prompt from standard input until EOF.",
    } satisfies PublicCliOption),
    fileOption: Object.freeze({
      flags: "--file <path>",
      description: "Read the prompt from a UTF-8 text file.",
      valueName: "path",
    } satisfies PublicCliOption),
    yoloOption: Object.freeze({
      flags: "--yolo",
      description: "Skip destructive Bash command confirmation; use at your own risk.",
    } satisfies PublicCliOption),
    promptSources: RUN_PROMPT_SOURCES,
    helpAfter:
      "Use exactly one prompt source. For complex or sensitive prompts, prefer --stdin or --file.",
  }),
  update: Object.freeze({
    command: "update",
    description: "Update the global npm installation from the official npm registry.",
  }),
});

export type PublicCliContract = typeof PUBLIC_CLI_CONTRACT;
