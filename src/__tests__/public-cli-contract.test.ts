import { describe, expect, test } from "bun:test";
import {
  PUBLIC_CLI_BEGIN_MARKER,
  PUBLIC_CLI_END_MARKER,
  renderPublicCliCommands,
  updatePublicCliSection,
} from "../../scripts/render-public-contract-docs";
import { PUBLIC_CLI_CONTRACT } from "../cli/public-cli-contract";

describe("public CLI documentation contract", () => {
  test("renders commands and Prompt sources from the runtime declaration", () => {
    const rendered = renderPublicCliCommands();
    expect(rendered).toContain(
      PUBLIC_CLI_CONTRACT.tui.profileOption.flags.split(", ")[1],
    );
    for (const source of PUBLIC_CLI_CONTRACT.run.promptSources) {
      expect(rendered).toContain(source.syntax);
      expect(rendered).toContain(source.description);
    }
    expect(rendered).toContain("tinker --help");
    expect(rendered).toContain("tinker --version");
  });

  test("replaces exactly one ordered marker pair deterministically", () => {
    const source = `before\n${PUBLIC_CLI_BEGIN_MARKER}\nstale\n${PUBLIC_CLI_END_MARKER}\nafter\n`;
    const generated = updatePublicCliSection(source);
    expect(generated).not.toContain("stale");
    expect(updatePublicCliSection(generated)).toBe(generated);
  });

  test("fails missing, duplicate, and reversed markers", () => {
    for (const markdown of [
      "missing",
      `${PUBLIC_CLI_BEGIN_MARKER}\n${PUBLIC_CLI_BEGIN_MARKER}\n${PUBLIC_CLI_END_MARKER}`,
      `${PUBLIC_CLI_END_MARKER}\n${PUBLIC_CLI_BEGIN_MARKER}`,
    ]) {
      expect(() => updatePublicCliSection(markdown)).toThrow();
    }
  });
});
