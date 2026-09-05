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
    description: "Start the interactive terminal interface.",
    profileOption: PROFILE_OPTION,
  }),
  serve: Object.freeze({
    command: "serve",
    description: "Run the local daemon for paired remote clients.",
    configOption: Object.freeze({
      flags: "--config <path>",
      description: "Read the service JSON configuration.",
      valueName: "path",
    } satisfies PublicCliOption),
  }),
  connect: Object.freeze({
    command: "connect",
    description: "Attach a terminal client to a service; exiting detaches only.",
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
