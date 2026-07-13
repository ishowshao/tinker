import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  buildSystemPrompt,
  loadProjectInstructions,
  PROJECT_INSTRUCTIONS_MAX_BYTES,
  projectInstructionManifest,
} from "../instructions/project-instructions";

describe("project instruction loading", () => {
  test("returns an empty snapshot when neither supported file exists", async () => {
    await withWorkspace(async (workspace) => {
      expect(await loadProjectInstructions(workspace)).toEqual({
        workspaceRoot: workspace,
      });
    });
  });

  test("loads CLAUDE.md only when AGENTS.md is absent", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "CLAUDE.md"), "claude rules\n");

      const snapshot = await loadProjectInstructions(workspace);

      expect(snapshot.instruction).toMatchObject({
        fileName: "CLAUDE.md",
        absolutePath: path.join(workspace, "CLAUDE.md"),
        content: "claude rules\n",
        byteLength: 13,
      });
    });
  });

  test("prefers AGENTS.md without reading CLAUDE.md", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "AGENTS.md"), "agent rules");
      await mkdir(path.join(workspace, "CLAUDE.md"));

      const snapshot = await loadProjectInstructions(workspace);

      expect(snapshot.instruction?.fileName).toBe("AGENTS.md");
      expect(snapshot.instruction?.content).toBe("agent rules");
    });
  });

  test("still selects AGENTS.md when both files have identical content", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "AGENTS.md"), "same");
      await writeFile(path.join(workspace, "CLAUDE.md"), "same");

      expect((await loadProjectInstructions(workspace)).instruction?.fileName).toBe(
        "AGENTS.md",
      );
    });
  });

  test("does not fall back when AGENTS.md is invalid", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "AGENTS.md"), "  \n\t");
      await writeFile(path.join(workspace, "CLAUDE.md"), "valid fallback");

      await expectLoadFailure(
        workspace,
        "Project instruction AGENTS.md must not be empty.",
      );
    });
  });

  test.each([
    {
      name: "NUL bytes",
      content: Buffer.from([0x72, 0x75, 0x6c, 0x65, 0x00]),
      message: "contains a NUL byte",
    },
    {
      name: "invalid UTF-8",
      content: Buffer.from([0xc3, 0x28]),
      message: "is not valid UTF-8",
    },
    {
      name: "oversized content",
      content: Buffer.alloc(PROJECT_INSTRUCTIONS_MAX_BYTES + 1, 0x61),
      message: `the limit is ${PROJECT_INSTRUCTIONS_MAX_BYTES} bytes`,
    },
  ])("fast-fails $name", async ({ content, message }) => {
    await withWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "AGENTS.md"), content);

      await expectLoadFailure(workspace, message);
    });
  });

  test("rejects a directory and a FIFO", async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(path.join(workspace, "AGENTS.md"));
      await expectLoadFailure(workspace, "must be a regular file");

      await rm(path.join(workspace, "AGENTS.md"), { recursive: true });
      const fifoPath = path.join(workspace, "AGENTS.md");
      const process = Bun.spawn(["mkfifo", fifoPath]);
      expect(await process.exited).toBe(0);
      await expectLoadFailure(workspace, "must be a regular file");
    });
  });

  test("rejects a symlink whose target is outside the workspace", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "tinker-instructions-link-"));
    const workspace = path.join(parent, "workspace");
    try {
      await mkdir(workspace);
      const outside = path.join(parent, "outside.md");
      await writeFile(outside, "outside rules");
      await symlink(outside, path.join(workspace, "AGENTS.md"));

      await expectLoadFailure(workspace, "resolves outside the workspace root");
    } finally {
      await rm(parent, { recursive: true });
    }
  });

  test("does not treat permission errors as a missing file", async () => {
    if (process.getuid?.() === 0) {
      return;
    }
    await withWorkspace(async (workspace) => {
      const instructionPath = path.join(workspace, "AGENTS.md");
      await writeFile(instructionPath, "private rules", { mode: 0o600 });
      await chmod(instructionPath, 0o000);

      await expectLoadFailure(
        workspace,
        "Failed to load project instruction AGENTS.md",
      );
    });
  });

  test("keeps a loaded snapshot after the file changes", async () => {
    await withWorkspace(async (workspace) => {
      const instructionPath = path.join(workspace, "AGENTS.md");
      await writeFile(instructionPath, "before");
      const snapshot = await loadProjectInstructions(workspace);
      const manifest = projectInstructionManifest(snapshot);

      await writeFile(instructionPath, "after");

      expect(snapshot.instruction?.content).toBe("before");
      expect(manifest).toEqual({
        path: "AGENTS.md",
        byteLength: 6,
        sha256: createHash("sha256").update("before").digest("hex"),
      });
    });
  });
});

describe("project instruction system prompt composition", () => {
  test("keeps runtime instructions and emits no project boundary when absent", async () => {
    await withWorkspace(async (workspace) => {
      const prompt = buildSystemPrompt({
        workspaceRoot: workspace,
        runtimeInstructions: "runtime rules",
        projectInstructions: await loadProjectInstructions(workspace),
      });

      expect(prompt).toBe(
        "<tinker_runtime_instructions>\nruntime rules\n</tinker_runtime_instructions>",
      );
      expect(prompt).not.toContain("<project_instructions>");
    });
  });

  test("adds exactly one project source after the runtime boundary", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "AGENTS.md"), "# Rules\n<literal>\n");
      await writeFile(path.join(workspace, "CLAUDE.md"), "ignored");
      const snapshot = await loadProjectInstructions(workspace);
      const input = {
        workspaceRoot: workspace,
        runtimeInstructions: "runtime rules",
        projectInstructions: snapshot,
      };

      const prompt = buildSystemPrompt(input);

      expect(prompt.indexOf("</tinker_runtime_instructions>")).toBeLessThan(
        prompt.indexOf("<project_instructions>"),
      );
      expect(prompt.match(/<project_instructions>/g)).toHaveLength(1);
      expect(prompt.match(/<instruction_file path="AGENTS.md">/g)).toHaveLength(1);
      expect(prompt).not.toContain("CLAUDE.md");
      expect(prompt).toContain("# Rules\n<literal>\n</instruction_file>");
      expect(buildSystemPrompt(input)).toBe(prompt);
      expect(createHash("sha256").update(buildSystemPrompt(input)).digest("hex")).toBe(
        createHash("sha256").update(prompt).digest("hex"),
      );
    });
  });
});

async function withWorkspace(
  callback: (workspace: string) => Promise<void>,
): Promise<void> {
  const workspace = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "tinker-instructions-")),
  );
  try {
    await callback(workspace);
  } finally {
    await rm(workspace, { recursive: true });
  }
}

async function expectLoadFailure(workspace: string, message: string): Promise<void> {
  const error = await loadProjectInstructions(workspace).catch(
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(message);
}
