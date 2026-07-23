import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PUBLIC_CLI_CONTRACT } from "../src/cli/public-cli-contract";

export const PUBLIC_CLI_BEGIN_MARKER = "<!-- BEGIN GENERATED: PUBLIC CLI COMMANDS -->";
export const PUBLIC_CLI_END_MARKER = "<!-- END GENERATED: PUBLIC CLI COMMANDS -->";

export function renderPublicCliCommands(): string {
  const contract = PUBLIC_CLI_CONTRACT;
  const profile = longFlags(contract.tui.profileOption.flags);
  const runProfile = longFlags(contract.run.profileOption.flags);
  const help = longFlags(contract.helpFlags);
  const version = longFlags(contract.versionFlags);
  const runCommand = contract.run.command.split(" ")[0];
  const helpCommand = contract.helpCommand.command.split(" ")[0];
  if (runCommand === undefined || helpCommand === undefined) {
    throw new Error("Public CLI command declarations must not be empty.");
  }
  const rows = [
    ["`tinker`", contract.tui.description],
    [`\`tinker ${profile}\``, "Start the TUI with a selected model profile."],
    [
      `\`tinker run [${runProfile}] ${contract.run.promptSources[0].syntax}\``,
      contract.run.promptSources[0].description,
    ],
    [
      `\`tinker run [${runProfile}] ${contract.run.promptSources[1].syntax}\``,
      contract.run.promptSources[1].description,
    ],
    [
      `\`tinker run [${runProfile}] ${contract.run.promptSources[2].syntax}\``,
      contract.run.promptSources[2].description,
    ],
    [`\`tinker ${help}\``, "Show top-level CLI help."],
    [`\`tinker ${helpCommand} ${runCommand}\``, "Show one-shot command help."],
    [`\`tinker ${version}\``, "Print the installed package version."],
  ];
  return [
    "| Command | Description |",
    "| --- | --- |",
    ...rows.map(([command, description]) => `| ${command} | ${description} |`),
  ].join("\n");
}

export function updatePublicCliSection(markdown: string): string {
  const beginOffsets = markerOffsets(markdown, PUBLIC_CLI_BEGIN_MARKER);
  const endOffsets = markerOffsets(markdown, PUBLIC_CLI_END_MARKER);
  if (beginOffsets.length !== 1 || endOffsets.length !== 1) {
    throw new Error("README must contain exactly one PUBLIC CLI COMMANDS marker pair.");
  }
  const begin = beginOffsets[0];
  const end = endOffsets[0];
  if (begin === undefined || end === undefined || begin >= end) {
    throw new Error("README PUBLIC CLI COMMANDS markers are out of order.");
  }
  const contentStart = begin + PUBLIC_CLI_BEGIN_MARKER.length;
  return `${markdown.slice(0, contentStart)}\n${renderPublicCliCommands()}\n${markdown.slice(end)}`;
}

async function run(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== "--write" && mode !== "--check") {
    throw new Error("Usage: render-public-contract-docs.ts --write|--check");
  }
  const readmePath = path.join(import.meta.dir, "..", "README.md");
  const current = await readFile(readmePath, "utf8");
  const generated = updatePublicCliSection(current);
  if (mode === "--check") {
    if (generated !== current) {
      throw new Error(
        "README PUBLIC CLI COMMANDS section is stale. Run bun run docs:generate.",
      );
    }
    return;
  }
  if (generated === current) {
    return;
  }
  const temporaryPath = `${readmePath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, generated);
    await rename(temporaryPath, readmePath);
  } finally {
    await rm(temporaryPath).catch((error: unknown) => {
      if (!isNotFound(error)) {
        throw error;
      }
    });
  }
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

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

if (import.meta.main) {
  await run();
}
