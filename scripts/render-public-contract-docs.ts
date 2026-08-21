import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { diffLines } from "diff";
import { parseModelProfiles } from "../src/cli/model-profiles";
import { PUBLIC_CLI_CONTRACT } from "../src/cli/public-cli-contract";
import {
  MEMORY_CONFIG_FIELDS,
  MEMORY_EMBEDDING_FIELDS,
  MODEL_PROFILE_FIELDS,
  MODEL_REASONING_FIELDS,
  PUBLIC_CONFIG_FIELDS,
  type ModelProfileField,
  type ModelReasoningField,
  type MemoryEmbeddingField,
  type PublicConfigField,
} from "../src/cli/public-config-contract";
import { SLASH_COMMANDS } from "../src/tui/slash-commands";

export const PUBLIC_CLI_BEGIN_MARKER = "<!-- BEGIN GENERATED: PUBLIC CLI COMMANDS -->";
export const PUBLIC_CLI_END_MARKER = "<!-- END GENERATED: PUBLIC CLI COMMANDS -->";
export const PUBLIC_ENVIRONMENT_BEGIN_MARKER =
  "<!-- BEGIN GENERATED: PUBLIC ENVIRONMENT VARIABLES -->";
export const PUBLIC_ENVIRONMENT_END_MARKER =
  "<!-- END GENERATED: PUBLIC ENVIRONMENT VARIABLES -->";
export const MODEL_PROFILE_BEGIN_MARKER =
  "<!-- BEGIN GENERATED: MODEL PROFILE FIELDS -->";
export const MODEL_PROFILE_END_MARKER = "<!-- END GENERATED: MODEL PROFILE FIELDS -->";
export const BUILT_IN_SLASH_COMMANDS_BEGIN_MARKER =
  "<!-- BEGIN GENERATED: BUILT-IN SLASH COMMANDS -->";
export const BUILT_IN_SLASH_COMMANDS_END_MARKER =
  "<!-- END GENERATED: BUILT-IN SLASH COMMANDS -->";

export type GeneratedSectionName =
  | "PUBLIC CLI COMMANDS"
  | "PUBLIC ENVIRONMENT VARIABLES"
  | "MODEL PROFILE FIELDS"
  | "BUILT-IN SLASH COMMANDS";

type GeneratedSection = {
  readonly name: GeneratedSectionName;
  readonly beginMarker: string;
  readonly endMarker: string;
  readonly render: () => string;
};

type LocatedSection = GeneratedSection & {
  readonly beginOffset: number;
  readonly endOffset: number;
};

const GENERATED_SECTIONS: readonly GeneratedSection[] = Object.freeze([
  Object.freeze({
    name: "PUBLIC CLI COMMANDS",
    beginMarker: PUBLIC_CLI_BEGIN_MARKER,
    endMarker: PUBLIC_CLI_END_MARKER,
    render: renderPublicCliCommands,
  }),
  Object.freeze({
    name: "PUBLIC ENVIRONMENT VARIABLES",
    beginMarker: PUBLIC_ENVIRONMENT_BEGIN_MARKER,
    endMarker: PUBLIC_ENVIRONMENT_END_MARKER,
    render: renderPublicEnvironmentVariables,
  }),
  Object.freeze({
    name: "MODEL PROFILE FIELDS",
    beginMarker: MODEL_PROFILE_BEGIN_MARKER,
    endMarker: MODEL_PROFILE_END_MARKER,
    render: renderModelProfileFields,
  }),
  Object.freeze({
    name: "BUILT-IN SLASH COMMANDS",
    beginMarker: BUILT_IN_SLASH_COMMANDS_BEGIN_MARKER,
    endMarker: BUILT_IN_SLASH_COMMANDS_END_MARKER,
    render: renderBuiltInSlashCommands,
  }),
]);

const MAX_DIFF_LINES = 48;
const MAX_DIFF_LINE_LENGTH = 240;

export function renderPublicCliCommands(): string {
  const contract = PUBLIC_CLI_CONTRACT;
  const profile = longFlags(contract.tui.profileOption.flags);
  const runProfile = longFlags(contract.run.profileOption.flags);
  const runYolo = longFlags(contract.run.yoloOption.flags);
  const help = longFlags(contract.helpFlags);
  const version = longFlags(contract.versionFlags);
  const runCommand = firstCommandWord(contract.run.command);
  const updateCommand = firstCommandWord(contract.update.command);
  const helpCommand = firstCommandWord(contract.helpCommand.command);
  const rows = [
    ["`tinker`", contract.tui.description],
    [`\`tinker ${profile}\``, "Start the TUI with a selected model profile."],
    [
      `\`tinker ${runCommand} [${runProfile}] [${runYolo}] ${contract.run.promptSources[0].syntax}\``,
      contract.run.promptSources[0].description,
    ],
    [
      `\`tinker ${runCommand} [${runProfile}] [${runYolo}] ${contract.run.promptSources[1].syntax}\``,
      contract.run.promptSources[1].description,
    ],
    [
      `\`tinker ${runCommand} [${runProfile}] [${runYolo}] ${contract.run.promptSources[2].syntax}\``,
      contract.run.promptSources[2].description,
    ],
    [`\`tinker ${updateCommand}\``, contract.update.description],
    [`\`tinker ${help}\``, "Show top-level CLI help."],
    [`\`tinker ${helpCommand} ${runCommand}\``, "Show one-shot command help."],
    [`\`tinker ${helpCommand} ${updateCommand}\``, "Show update command help."],
    [`\`tinker ${version}\``, "Print the installed package version."],
  ];
  return renderTable(["Command", "Description"], rows);
}

export function renderPublicEnvironmentVariables(): string {
  const rows = PUBLIC_CONFIG_FIELDS.map((field) => [
    `\`${field.name}\``,
    publicConfigArea(field),
    field.appliesIn === "always" ? "All modes" : "Env mode",
    publicConfigRequired(field),
    publicValueKind(field.valueKind),
    publicConfigDefault(field),
    field.secret ? "Yes" : "No",
    field.description,
  ]);
  return renderTable(
    [
      "Variable",
      "Area",
      "Applies",
      "Required",
      "Type",
      "Default",
      "Secret",
      "Description",
    ],
    rows,
  );
}

export function renderModelProfileFields(): string {
  const profileRows = MODEL_PROFILE_FIELDS.map((field) => [
    `\`${field.name}\``,
    field.required ? "Yes" : "No",
    modelProfileValueKind(field),
    modelProfileDefault(field),
    field.secret ? "Yes" : "No",
    field.description,
  ]);
  const reasoningRows = MODEL_REASONING_FIELDS.map((field) => [
    `\`${field.name}\``,
    reasoningConstraint(field),
    field.description,
  ]);
  const memoryRows = MEMORY_CONFIG_FIELDS.map((field) => [
    `\`${field.name}\``,
    field.required ? "Yes" : "No",
    field.valueKind === "embedding-profile" ? "Object" : "Non-empty string",
    field.secret ? "Yes" : "No",
    field.description,
  ]);
  const embeddingRows = MEMORY_EMBEDDING_FIELDS.map((field) => [
    `\`${field.name}\``,
    field.required ? "Yes" : "No",
    memoryEmbeddingConstraint(field),
    field.secret ? "Yes" : "No",
    field.description,
  ]);
  const textDocument = createProfileExample(false);
  const imageDocument = createProfileExample(true);
  const memoryDocument = createMemoryExample();

  parseModelProfiles(JSON.stringify(textDocument), "README text profile example");
  parseModelProfiles(JSON.stringify(imageDocument), "README image profile example");
  parseModelProfiles(JSON.stringify(memoryDocument), "README memory profile example");

  return [
    "Profile fields:",
    "",
    renderTable(
      ["Field", "Required", "Type / constraint", "Default", "Secret", "Description"],
      profileRows,
    ),
    "",
    "`reasoning` fields:",
    "",
    renderTable(["Field", "Type / constraint", "Description"], reasoningRows),
    "",
    "The optional `reasoning` object declares provider-specific effort values. Efforts must be unique non-whitespace strings, `reset` is reserved by the TUI command, and `defaultEffort` must appear in `supportedEfforts`. Omitting `reasoning` sends no effort parameter and disables `/reasoning` for that profile.",
    "",
    "Text-only profile example:",
    "",
    "```json",
    JSON.stringify(textDocument, null, 2),
    "```",
    "",
    "Image-capable profile example:",
    "",
    "```json",
    JSON.stringify(imageDocument, null, 2),
    "```",
    "",
    "The top-level `memory` object is optional. When present, every field below is required. It enables completed-turn extraction and `MemorySearch` only in the TUI; one-shot runs do not load memory.",
    "",
    renderTable(
      ["Field", "Required", "Type / constraint", "Secret", "Description"],
      memoryRows,
    ),
    "",
    "`memory.embedding` fields:",
    "",
    renderTable(
      ["Field", "Required", "Type / constraint", "Secret", "Description"],
      embeddingRows,
    ),
    "",
    "Enabling memory sends completed-turn text (not image bytes) to `memory.profile`, and sends extracted candidates plus search queries to the embedding endpoint. Derived memories are stored in `~/.tinker/memory/memory.sqlite`; newly inserted memory text is appended to the private development log `~/.tinker/memory/extracted-memories.log`.",
    "",
    "Atomic-memory profile example:",
    "",
    "```json",
    JSON.stringify(memoryDocument, null, 2),
    "```",
  ].join("\n");
}

export function renderBuiltInSlashCommands(): string {
  return renderTable(
    ["Command", "Description"],
    SLASH_COMMANDS.map((command) => [`\`${command.usage}\``, command.description]),
  );
}

export function updatePublicContractSections(markdown: string): string {
  const sections = locateGeneratedSections(markdown);
  let generated = markdown;
  for (const section of [...sections].reverse()) {
    generated = replaceLocatedSection(generated, section, section.render());
  }
  return generated;
}

export function assertPublicContractDocsCurrent(markdown: string): void {
  const sections = locateGeneratedSections(markdown);
  const stale = sections.flatMap((section) => {
    const actual = sectionBody(markdown, section);
    const expected = `\n${section.render()}\n`;
    return actual === expected ? [] : [{ section, actual, expected }];
  });
  if (stale.length === 0) {
    return;
  }

  const names = stale.map(({ section }) => section.name).join(", ");
  const details = boundedDiff(
    stale.map(({ section, actual, expected }) => ({
      name: section.name,
      actual,
      expected,
    })),
  );
  throw new Error(
    `README generated sections are stale: ${names}. Run bun run docs:generate.\n${details}`,
  );
}

export function updatePublicCliSection(markdown: string): string {
  const section = locateSingleSection(markdown, GENERATED_SECTIONS[0]);
  return replaceLocatedSection(markdown, section, renderPublicCliCommands());
}

export async function runPublicContractDocs(
  mode: "write" | "check",
  readmePath: string,
): Promise<void> {
  const current = await readFile(readmePath, "utf8");
  if (mode === "check") {
    assertPublicContractDocsCurrent(current);
    return;
  }

  const generated = updatePublicContractSections(current);
  if (generated === current) {
    return;
  }

  const temporaryPath = `${readmePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, generated, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, readmePath);
  } finally {
    await rm(temporaryPath).catch((error: unknown) => {
      if (!isNotFound(error)) {
        throw error;
      }
    });
  }
}

function locateGeneratedSections(markdown: string): readonly LocatedSection[] {
  const sections = GENERATED_SECTIONS.map((section) =>
    locateSingleSection(markdown, section),
  );
  const actualMarkers = sections
    .flatMap((section) => [
      { marker: section.beginMarker, offset: section.beginOffset },
      { marker: section.endMarker, offset: section.endOffset },
    ])
    .sort((left, right) => left.offset - right.offset)
    .map(({ marker }) => marker);
  const expectedMarkers = GENERATED_SECTIONS.flatMap((section) => [
    section.beginMarker,
    section.endMarker,
  ]);
  if (
    actualMarkers.length !== expectedMarkers.length ||
    actualMarkers.some((marker, index) => marker !== expectedMarkers[index])
  ) {
    throw new Error(
      `README generated markers must appear in this fixed order: ${expectedMarkers.join(" -> ")}.`,
    );
  }
  return sections;
}

function locateSingleSection(
  markdown: string,
  section: GeneratedSection | undefined,
): LocatedSection {
  if (section === undefined) {
    throw new Error("Missing generated section declaration.");
  }
  const beginOffsets = markerOffsets(markdown, section.beginMarker);
  const endOffsets = markerOffsets(markdown, section.endMarker);
  if (beginOffsets.length !== 1 || endOffsets.length !== 1) {
    throw new Error(
      `README must contain exactly one ${section.name} marker pair; found ${beginOffsets.length} begin and ${endOffsets.length} end markers.`,
    );
  }
  const beginOffset = beginOffsets[0];
  const endOffset = endOffsets[0];
  if (
    beginOffset === undefined ||
    endOffset === undefined ||
    beginOffset >= endOffset
  ) {
    throw new Error(`README ${section.name} markers are reversed or crossed.`);
  }
  return { ...section, beginOffset, endOffset };
}

function replaceLocatedSection(
  markdown: string,
  section: LocatedSection,
  rendered: string,
): string {
  const contentStart = section.beginOffset + section.beginMarker.length;
  return `${markdown.slice(0, contentStart)}\n${rendered}\n${markdown.slice(section.endOffset)}`;
}

function sectionBody(markdown: string, section: LocatedSection): string {
  const contentStart = section.beginOffset + section.beginMarker.length;
  return markdown.slice(contentStart, section.endOffset);
}

function createProfileExample(image: boolean): Record<string, unknown> {
  const profileName = image ? "image" : "text";
  const profileValues: Readonly<Record<string, unknown>> = Object.freeze({
    model: image ? "example-vision-model" : "example-text-model",
    api: image ? "responses" : "chat-completions",
    apiBase: "https://api.example.com/v1",
    apiKey: "your-model-api-key",
    contextWindowTokens: 128_000,
    maxSupportedOutputTokens: 8_192,
    reasoning: {
      supportedEfforts: ["low", "medium", "high"],
      defaultEffort: "medium",
    },
    includeReasoningContent: false,
    stream: true,
    inputModalities: image ? ["text", "image"] : ["text"],
    toolResultModalities: image ? ["text", "image"] : ["text"],
  });
  const profile = Object.fromEntries(
    MODEL_PROFILE_FIELDS.map((field) => [field.name, profileValues[field.name]]),
  );
  return {
    default: profileName,
    profiles: {
      [profileName]: profile,
    },
  };
}

function createMemoryExample(): Record<string, unknown> {
  return {
    ...createProfileExample(false),
    memory: {
      profile: "text",
      embedding: {
        name: "example-embedding-space",
        kind: "openai-compatible",
        model: "example-embedding-model",
        apiBase: "https://embeddings.example.com/v1",
        apiKey: "your-embedding-api-key",
        dimensions: 1_024,
      },
    },
  };
}

function publicConfigArea(field: PublicConfigField): string {
  switch (field.section) {
    case "model":
      return "Model";
    case "workspace":
      return "Workspace";
    case "tooling":
      return "Tooling";
  }
}

function publicConfigRequired(field: PublicConfigField): string {
  switch (field.requiredIn) {
    case "always":
      return "Always";
    case "env-mode":
      return "Env mode";
    case "never":
      return "No";
  }
}

function publicValueKind(kind: PublicConfigField["valueKind"]): string {
  switch (kind) {
    case "non-empty-string":
      return "Non-empty string";
    case "positive-integer":
      return "Positive integer";
    case "boolean":
      return "Boolean";
  }
}

function publicConfigDefault(field: PublicConfigField): string {
  if (field.defaultValue !== undefined) {
    return codeValue(field.defaultValue);
  }
  if (field.defaultSource === "process-cwd") {
    return "Process cwd";
  }
  if (field.defaultSource === "bundled-ripgrep") {
    return "Bundled ripgrep";
  }
  return "—";
}

function modelProfileValueKind(field: ModelProfileField): string {
  switch (field.valueKind) {
    case "non-empty-string":
      return "Non-empty string";
    case "positive-integer":
      return "Positive integer";
    case "boolean":
      return "JSON boolean";
    case "input-modalities":
    case "tool-result-modalities":
      return "Normalized modality array";
    case "reasoning":
      return "Object";
  }
}

function reasoningConstraint(field: ModelReasoningField): string {
  return field.valueKind === "non-empty-string-array"
    ? "Non-empty unique string array"
    : "Non-empty string listed above";
}

function modelProfileDefault(field: ModelProfileField): string {
  return field.defaultValue === undefined ? "—" : codeValue(field.defaultValue);
}

function memoryEmbeddingConstraint(field: MemoryEmbeddingField): string {
  if (field.literalValue !== undefined) {
    return `Literal ${codeValue(field.literalValue)}`;
  }
  return field.valueKind === "positive-integer"
    ? "Positive integer"
    : "Non-empty string";
}

function codeValue(value: string | number | boolean | readonly string[]): string {
  return `\`${JSON.stringify(value)}\``;
}

function renderTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  return [
    `| ${headers.map(escapeTableCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map((cell) => escapeTableCell(cell)).join(" | ")} |`),
  ].join("\n");
}

function escapeTableCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function boundedDiff(
  stale: readonly {
    readonly name: GeneratedSectionName;
    readonly actual: string;
    readonly expected: string;
  }[],
): string {
  const lines: string[] = [];
  let truncated = false;
  for (const entry of stale) {
    if (lines.length >= MAX_DIFF_LINES) {
      truncated = true;
      break;
    }
    lines.push(`--- ${entry.name} (current)`, `+++ ${entry.name} (expected)`);
    for (const change of diffLines(entry.actual, entry.expected)) {
      if (change.added !== true && change.removed !== true) {
        continue;
      }
      const prefix = change.added === true ? "+" : "-";
      const changedLines = change.value.split("\n");
      if (changedLines.at(-1) === "") {
        changedLines.pop();
      }
      for (const line of changedLines) {
        if (lines.length >= MAX_DIFF_LINES) {
          truncated = true;
          break;
        }
        lines.push(`${prefix}${truncateDiffLine(line)}`);
      }
      if (truncated) {
        break;
      }
    }
  }
  if (truncated) {
    lines.push("... diff truncated ...");
  }
  return lines.join("\n");
}

function truncateDiffLine(line: string): string {
  return line.length <= MAX_DIFF_LINE_LENGTH
    ? line
    : `${line.slice(0, MAX_DIFF_LINE_LENGTH)}…`;
}

function markerOffsets(markdown: string, marker: string): number[] {
  const offsets: number[] = [];
  let offset = 0;
  while (true) {
    const found = markdown.indexOf(marker, offset);
    if (found === -1) {
      return offsets;
    }
    offsets.push(found);
    offset = found + marker.length;
  }
}

function longFlags(flags: string): string {
  const long = flags
    .split(",")
    .map((value) => value.trim())
    .find((value) => value.startsWith("--"));
  if (long === undefined) {
    throw new Error(`CLI option ${JSON.stringify(flags)} has no long form.`);
  }
  return long;
}

function firstCommandWord(command: string): string {
  const first = command.split(" ")[0];
  if (first === undefined || first === "") {
    throw new Error("Public CLI command declarations must not be empty.");
  }
  return first;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function run(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== "--write" && mode !== "--check") {
    throw new Error("Usage: render-public-contract-docs.ts --write|--check");
  }
  const readmePath = path.join(import.meta.dir, "..", "README.md");
  await runPublicContractDocs(mode === "--write" ? "write" : "check", readmePath);
}

if (import.meta.main) {
  await run();
}
