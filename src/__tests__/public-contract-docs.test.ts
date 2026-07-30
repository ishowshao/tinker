import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BUILT_IN_SLASH_COMMANDS_BEGIN_MARKER,
  BUILT_IN_SLASH_COMMANDS_END_MARKER,
  MODEL_PROFILE_BEGIN_MARKER,
  MODEL_PROFILE_END_MARKER,
  PUBLIC_CLI_BEGIN_MARKER,
  PUBLIC_CLI_END_MARKER,
  PUBLIC_ENVIRONMENT_BEGIN_MARKER,
  PUBLIC_ENVIRONMENT_END_MARKER,
  assertPublicContractDocsCurrent,
  renderBuiltInSlashCommands,
  renderModelProfileFields,
  renderPublicEnvironmentVariables,
  runPublicContractDocs,
  updatePublicContractSections,
} from "../../scripts/render-public-contract-docs";
import { parseModelProfiles } from "../cli/model-profiles";
import {
  MEMORY_CONFIG_FIELDS,
  MEMORY_EMBEDDING_FIELDS,
  MODEL_PROFILE_FIELDS,
  MODEL_TOKEN_ESTIMATOR_FIELDS,
  PUBLIC_CONFIG_FIELDS,
} from "../cli/public-config-contract";
import { SLASH_COMMANDS } from "../tui/slash-commands";

describe("public contract documentation rendering", () => {
  test("renders every public environment field from the runtime declaration", () => {
    const rendered = renderPublicEnvironmentVariables();
    for (const field of PUBLIC_CONFIG_FIELDS) {
      expect(rendered).toContain(`\`${field.name}\``);
      expect(rendered).toContain(field.description);
      if ("defaultValue" in field && field.defaultValue !== undefined) {
        expect(rendered).toContain(`\`${JSON.stringify(field.defaultValue)}\``);
      }
    }
    for (const field of PUBLIC_CONFIG_FIELDS.filter((entry) => entry.secret)) {
      expect(tableRow(rendered, field.name)).toContain("| Yes |");
    }
  });

  test("renders all profile fields and production-valid text, image, and memory examples", () => {
    const rendered = renderModelProfileFields();
    for (const field of [
      ...MODEL_PROFILE_FIELDS,
      ...MODEL_TOKEN_ESTIMATOR_FIELDS,
      ...MEMORY_CONFIG_FIELDS,
      ...MEMORY_EMBEDDING_FIELDS,
    ]) {
      expect(rendered).toContain(`\`${field.name}\``);
      expect(rendered).toContain(field.description);
    }

    const examples = [...rendered.matchAll(/```json\n([\s\S]*?)\n```/g)].map(
      (match) => match[1],
    );
    expect(examples).toHaveLength(3);
    for (const [index, example] of examples.entries()) {
      expect(example).toBeDefined();
      parseModelProfiles(example ?? "", `README example ${index + 1}`);
    }
    expect(examples[0]).toContain('"inputModalities": [');
    expect(examples[1]).toContain('"tokenEstimator": {');
    expect(examples[2]).toContain('"memory": {');
  });

  test("renders built-in slash command order, usage, and descriptions", () => {
    const rendered = renderBuiltInSlashCommands();
    let previous = -1;
    for (const command of SLASH_COMMANDS) {
      const offset = rendered.indexOf(`\`${command.usage.replaceAll("|", "\\|")}\``);
      expect(offset).toBeGreaterThan(previous);
      expect(rendered).toContain(command.description);
      previous = offset;
    }
  });

  test("is deterministic and idempotent", () => {
    const first = updatePublicContractSections(markerSkeleton());
    const second = updatePublicContractSections(markerSkeleton());
    expect(second).toBe(first);
    expect(updatePublicContractSections(first)).toBe(first);
  });

  test("rejects missing, duplicate, reversed, crossed, and reordered markers", () => {
    const source = markerSkeleton();
    const cliBlock = markerBlock(PUBLIC_CLI_BEGIN_MARKER, PUBLIC_CLI_END_MARKER);
    const environmentBlock = markerBlock(
      PUBLIC_ENVIRONMENT_BEGIN_MARKER,
      PUBLIC_ENVIRONMENT_END_MARKER,
    );

    const invalid = [
      source.replace(PUBLIC_CLI_BEGIN_MARKER, ""),
      source.replace(
        PUBLIC_CLI_BEGIN_MARKER,
        `${PUBLIC_CLI_BEGIN_MARKER}\n${PUBLIC_CLI_BEGIN_MARKER}`,
      ),
      source.replace(
        cliBlock,
        markerBlock(PUBLIC_CLI_END_MARKER, PUBLIC_CLI_BEGIN_MARKER),
      ),
      source.replace(
        `${cliBlock}\n${environmentBlock}`,
        [
          PUBLIC_CLI_BEGIN_MARKER,
          PUBLIC_ENVIRONMENT_BEGIN_MARKER,
          "stale",
          PUBLIC_CLI_END_MARKER,
          PUBLIC_ENVIRONMENT_END_MARKER,
        ].join("\n"),
      ),
      source.replace(
        `${cliBlock}\n${environmentBlock}`,
        `${environmentBlock}\n${cliBlock}`,
      ),
    ];

    for (const markdown of invalid) {
      expect(() => updatePublicContractSections(markdown)).toThrow();
    }
  });

  test("reports the stale section with a bounded diff and a repair command", () => {
    const current = updatePublicContractSections(markerSkeleton());
    const stale = current.replace("Optional model profiles JSON path", "Stale text");
    let error: unknown;
    try {
      assertPublicContractDocsCurrent(stale);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : "";
    expect(message).toContain("PUBLIC ENVIRONMENT VARIABLES");
    expect(message).toContain("bun run docs:generate");
    expect(message).toContain("-|");
    expect(message).toContain("+|");
    expect(message.length).toBeLessThan(16_000);
  });
});

describe("public contract documentation commands", () => {
  test("writes atomically and idempotently while check remains read-only", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tinker-docs-contract-"));
    const readmePath = path.join(directory, "README.md");
    try {
      await writeFile(readmePath, markerSkeleton(), "utf8");
      await runPublicContractDocs("write", readmePath);
      const first = await readFile(readmePath, "utf8");
      await runPublicContractDocs("write", readmePath);
      expect(await readFile(readmePath, "utf8")).toBe(first);
      expect(await readdir(directory)).toEqual(["README.md"]);

      const currentSnapshot = await directorySnapshot(directory);
      await runPublicContractDocs("check", readmePath);
      expect(await directorySnapshot(directory)).toEqual(currentSnapshot);

      const stale = first.replace("Show top-level CLI help.", "Stale help text.");
      await writeFile(readmePath, stale, "utf8");
      const staleSnapshot = await directorySnapshot(directory);
      expect(runPublicContractDocs("check", readmePath)).rejects.toThrow(
        "PUBLIC CLI COMMANDS",
      );
      expect(await directorySnapshot(directory)).toEqual(staleSnapshot);
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});

function markerSkeleton(): string {
  return [
    "before",
    markerBlock(PUBLIC_CLI_BEGIN_MARKER, PUBLIC_CLI_END_MARKER),
    markerBlock(PUBLIC_ENVIRONMENT_BEGIN_MARKER, PUBLIC_ENVIRONMENT_END_MARKER),
    markerBlock(MODEL_PROFILE_BEGIN_MARKER, MODEL_PROFILE_END_MARKER),
    markerBlock(
      BUILT_IN_SLASH_COMMANDS_BEGIN_MARKER,
      BUILT_IN_SLASH_COMMANDS_END_MARKER,
    ),
    "after",
    "",
  ].join("\n");
}

function markerBlock(begin: string, end: string): string {
  return `${begin}\nstale\n${end}`;
}

function tableRow(markdown: string, fieldName: string): string {
  return markdown.split("\n").find((line) => line.includes(`\`${fieldName}\``)) ?? "";
}

async function directorySnapshot(directory: string): Promise<readonly string[]> {
  const names = (await readdir(directory)).sort();
  return Promise.all(
    names.map(
      async (name) => `${name}\n${await readFile(path.join(directory, name), "utf8")}`,
    ),
  );
}
