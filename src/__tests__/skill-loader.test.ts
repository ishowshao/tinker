import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { createSkillToolDefinition } from "../skills/skill-catalog";
import {
  SKILL_CATALOG_MAX_BYTES,
  SKILL_COUNT_MAX,
  SKILL_FILE_MAX_BYTES,
  SkillError,
  loadSkillCatalog,
} from "../skills/skill-loader";

describe("Agent Skill loader", () => {
  test("returns a frozen empty catalog when both fixed roots are absent", async () => {
    await withRoots(async ({ workspace, home }) => {
      const catalog = await loadSkillCatalog({
        workspaceRoot: workspace,
        homeRoot: home,
      });

      expect(catalog.skills.size).toBe(0);
      expect(catalog.shadowed).toEqual([]);
      expect(catalog.manifestSha256).toBe(
        createHash("sha256").update("[]").digest("hex"),
      );
      expect(Object.isFrozen(catalog)).toBe(true);
    });
  });

  test("validates every collision candidate, then lets project scope win", async () => {
    await withRoots(async ({ workspace, home }) => {
      await writeSkill(home, "shared-skill", "User description", "user body");
      await writeSkill(
        workspace,
        "shared-skill",
        "Project description",
        "project body",
      );
      await writeSkill(home, "user-only", "User only", "user-only body", {
        extraFrontmatter: "license: ''\nallowed-tools: ''\n",
      });

      const catalog = await loadSkillCatalog({
        workspaceRoot: workspace,
        homeRoot: home,
      });
      const winner = catalog.skills.get("shared-skill");
      expect([...catalog.skills.keys()]).toEqual(["shared-skill", "user-only"]);
      expect(winner).toMatchObject({
        scope: "project",
        description: "Project description",
      });
      expect(winner?.content).toContain("project body");
      expect(catalog.shadowed).toEqual([
        { name: "shared-skill", winner: "project", loser: "user" },
      ]);

      const definition = createSkillToolDefinition(catalog);
      expect(definition.parameters).toMatchObject({
        additionalProperties: false,
        properties: {
          name: { enum: ["shared-skill", "user-only"] },
        },
      });
      expect(definition.description).toContain("Project description");
      expect(definition.description).not.toContain("project body");
      expect(definition.description).not.toContain(workspace);
      expect(() =>
        (catalog.skills as Map<string, unknown>).set("unexpected", {}),
      ).toThrow("immutable");

      await writeSkill(
        workspace,
        "shared-skill",
        "Changed after discovery",
        "changed body",
      );
      expect(winner?.description).toBe("Project description");
      expect(winner?.content).toContain("project body");
    });
  });

  test("ignores unknown top-level fields while preserving the original content", async () => {
    await withRoots(async ({ workspace, home }) => {
      await writeSkill(home, "extended-skill", "Extended", "user body", {
        extraFrontmatter: "version: 1.0.0\nunknown-field: retained\n",
      });

      const catalog = await loadSkillCatalog({
        workspaceRoot: workspace,
        homeRoot: home,
      });
      const skill = catalog.skills.get("extended-skill");

      expect(skill?.frontmatter).toEqual({});
      expect(skill?.content).toContain("version: 1.0.0");
      expect(skill?.content).toContain("unknown-field: retained");
    });
  });

  test.each([
    {
      label: "duplicate keys",
      frontmatter: "name: invalid-skill\nname: invalid-skill\ndescription: duplicate\n",
      code: "SKILL_FRONTMATTER_INVALID",
    },
    {
      label: "anchors",
      frontmatter:
        "name: invalid-skill\ndescription: anchored\nmetadata: &meta\n  key: value\n",
      code: "SKILL_FRONTMATTER_INVALID",
    },
    {
      label: "custom tags",
      frontmatter: "name: invalid-skill\ndescription: !unsupported tagged-value\n",
      code: "SKILL_FRONTMATTER_INVALID",
    },
    {
      label: "non-string metadata keys",
      frontmatter:
        "name: invalid-skill\ndescription: metadata\nmetadata:\n  1: value\n",
      code: "SKILL_FIELD_INVALID",
    },
    {
      label: "empty body",
      frontmatter: "name: invalid-skill\ndescription: empty body\n",
      body: "   \n",
      code: "SKILL_BODY_EMPTY",
    },
  ])("fast-fails $label", async ({ frontmatter, body = "body\n", code }) => {
    await withRoots(async ({ workspace, home }) => {
      const directory = path.join(workspace, ".agents", "skills", "invalid-skill");
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, "SKILL.md"),
        `---\n${frontmatter}---\n${body}`,
      );

      await expectSkillLoadError(
        loadSkillCatalog({ workspaceRoot: workspace, homeRoot: home }),
        code,
      );
    });
  });

  test("rejects oversized files and skill paths outside the scope boundary", async () => {
    await withRoots(async ({ root, workspace, home }) => {
      const oversized = path.join(workspace, ".agents", "skills", "oversized");
      await mkdir(oversized, { recursive: true });
      await writeFile(
        path.join(oversized, "SKILL.md"),
        Buffer.alloc(SKILL_FILE_MAX_BYTES + 1, 0x61),
      );
      await expectSkillLoadError(
        loadSkillCatalog({ workspaceRoot: workspace, homeRoot: home }),
        "SKILL_FILE_TOO_LARGE",
      );

      await rm(oversized, { recursive: true });
      const outside = path.join(root, "outside-skill");
      await mkdir(outside);
      await writeFile(
        path.join(outside, "SKILL.md"),
        "---\nname: linked-skill\ndescription: Outside\n---\nbody\n",
      );
      const skillsRoot = path.join(workspace, ".agents", "skills");
      await symlink(outside, path.join(skillsRoot, "linked-skill"));
      await expectSkillLoadError(
        loadSkillCatalog({ workspaceRoot: workspace, homeRoot: home }),
        "SKILL_PATH_OUTSIDE_SCOPE",
      );
    });
  });

  test("scans identical project and user roots once with project precedence", async () => {
    await withRoots(async ({ workspace }) => {
      await writeSkill(workspace, "single-scan", "One copy", "body");

      const catalog = await loadSkillCatalog({
        workspaceRoot: workspace,
        homeRoot: workspace,
      });

      expect([...catalog.skills.values()]).toMatchObject([
        { name: "single-scan", scope: "project" },
      ]);
      expect(catalog.shadowed).toEqual([]);
    });
  });

  test.each([
    "Uppercase",
    "-leading",
    "trailing-",
    "double--hyphen",
    "a".repeat(65),
  ])("rejects invalid skill name %s", async (name) => {
    await withRoots(async ({ workspace, home }) => {
      await writeSkill(workspace, name, "Invalid name", "body");
      await expectSkillLoadError(
        loadSkillCatalog({ workspaceRoot: workspace, homeRoot: home }),
        "SKILL_FIELD_INVALID",
      );
    });
  });

  test("counts Unicode code points for description and compatibility limits", async () => {
    await withRoots(async ({ workspace, home }) => {
      await writeSkill(workspace, "unicode-limits", "😀".repeat(1_024), "body", {
        extraFrontmatter: `compatibility: ${"界".repeat(500)}\n`,
      });
      const catalog = await loadSkillCatalog({
        workspaceRoot: workspace,
        homeRoot: home,
      });
      expect(catalog.skills.get("unicode-limits")?.description).toHaveLength(2_048);

      await writeSkill(workspace, "unicode-limits", "😀".repeat(1_025), "body");
      await expectSkillLoadError(
        loadSkillCatalog({ workspaceRoot: workspace, homeRoot: home }),
        "SKILL_FIELD_INVALID",
      );
    });
  });

  test("rejects NUL, invalid UTF-8, directories, and broken skill files", async () => {
    await withRoots(async ({ workspace, home }) => {
      const directory = path.join(workspace, ".agents", "skills", "invalid-file");
      const skillFile = path.join(directory, "SKILL.md");
      await mkdir(directory, { recursive: true });

      await writeFile(
        skillFile,
        Buffer.concat([
          Buffer.from("---\nname: invalid-file\ndescription: Invalid UTF-8\n---\n"),
          Buffer.from([0xff]),
        ]),
      );
      await expectSkillLoadError(
        loadSkillCatalog({ workspaceRoot: workspace, homeRoot: home }),
        "SKILL_FILE_NOT_UTF8",
      );

      await writeFile(
        skillFile,
        Buffer.from("---\nname: invalid-file\ndescription: NUL\n---\nbody\u0000tail\n"),
      );
      await expectSkillLoadError(
        loadSkillCatalog({ workspaceRoot: workspace, homeRoot: home }),
        "SKILL_FIELD_INVALID",
      );

      await rm(skillFile);
      await mkdir(skillFile);
      await expectSkillLoadError(
        loadSkillCatalog({ workspaceRoot: workspace, homeRoot: home }),
        "SKILL_FILE_NOT_REGULAR",
      );

      await rm(skillFile, { recursive: true });
      await symlink("missing.md", skillFile);
      await expectSkillLoadError(
        loadSkillCatalog({ workspaceRoot: workspace, homeRoot: home }),
        "SKILL_FILE_NOT_REGULAR",
      );
    });
  });

  test("rejects a SKILL.md FIFO without blocking", async () => {
    await withRoots(async ({ workspace, home }) => {
      const directory = path.join(workspace, ".agents", "skills", "fifo-skill");
      const skillFile = path.join(directory, "SKILL.md");
      await mkdir(directory, { recursive: true });
      const process = Bun.spawn(["mkfifo", skillFile], {
        stdout: "ignore",
        stderr: "pipe",
      });
      const exitCode = await process.exited;
      if (exitCode !== 0) {
        throw new Error(`mkfifo failed: ${await new Response(process.stderr).text()}`);
      }

      await expectSkillLoadError(
        loadSkillCatalog({ workspaceRoot: workspace, homeRoot: home }),
        "SKILL_FILE_NOT_REGULAR",
      );
    });
  });

  test("does not treat a SKILL.md permission error as a missing skill", async () => {
    if (process.getuid?.() === 0) {
      return;
    }
    await withRoots(async ({ workspace, home }) => {
      await writeSkill(workspace, "private-skill", "Private", "body");
      const skillFile = path.join(
        workspace,
        ".agents",
        "skills",
        "private-skill",
        "SKILL.md",
      );
      await chmod(skillFile, 0o000);
      try {
        await expectSkillLoadError(
          loadSkillCatalog({ workspaceRoot: workspace, homeRoot: home }),
          "SKILL_FILE_NOT_REGULAR",
        );
      } finally {
        await chmod(skillFile, 0o600);
      }
    });
  });

  test("fails if SKILL.md changes after its file handle is opened", async () => {
    await withRoots(async ({ workspace, home }) => {
      await writeSkill(workspace, "read-race", "Before", "original body");
      const skillFile = path.join(
        workspace,
        ".agents",
        "skills",
        "read-race",
        "SKILL.md",
      );
      const probe = await open(skillFile, "r");
      const prototype = Object.getPrototypeOf(probe) as Record<string, unknown>;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "read");
      await probe.close();
      const originalReadValue = prototype.read;
      if (descriptor === undefined || typeof originalReadValue !== "function") {
        throw new Error("FileHandle.read is unavailable for the race fixture.");
      }
      const originalRead = originalReadValue as (
        this: unknown,
        ...args: unknown[]
      ) => Promise<unknown>;
      let changed = false;
      Object.defineProperty(prototype, "read", {
        ...descriptor,
        async value(this: unknown, ...args: unknown[]) {
          const result = await originalRead.apply(this, args);
          if (!changed) {
            changed = true;
            await writeFile(
              skillFile,
              "---\nname: read-race\ndescription: After\n---\nchanged body\n",
            );
          }
          return result;
        },
      });
      try {
        await expectSkillLoadError(
          loadSkillCatalog({ workspaceRoot: workspace, homeRoot: home }),
          "SKILL_FILE_NOT_REGULAR",
        );
      } finally {
        Object.defineProperty(prototype, "read", descriptor);
      }
      expect(changed).toBe(true);
    });
  });

  test("fast-fails skill count and catalog byte limits", async () => {
    await withRoots(async ({ workspace, home }) => {
      await Promise.all(
        Array.from({ length: SKILL_COUNT_MAX + 1 }, (_, index) =>
          writeSkill(
            workspace,
            `count-${String(index).padStart(3, "0")}`,
            "counted",
            "body",
          ),
        ),
      );
      await expectSkillLoadError(
        loadSkillCatalog({ workspaceRoot: workspace, homeRoot: home }),
        "SKILL_COUNT_EXCEEDED",
      );
    });

    await withRoots(async ({ workspace, home }) => {
      const description = "x".repeat(1_024);
      await Promise.all(
        Array.from({ length: Math.ceil(SKILL_CATALOG_MAX_BYTES / 1_000) }, (_, index) =>
          writeSkill(
            workspace,
            `catalog-${String(index).padStart(3, "0")}`,
            description,
            "body",
          ),
        ),
      );
      await expectSkillLoadError(
        loadSkillCatalog({ workspaceRoot: workspace, homeRoot: home }),
        "SKILL_CATALOG_TOO_LARGE",
      );
    });
  });
});

async function withRoots(
  callback: (roots: { root: string; workspace: string; home: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "tinker-skills-loader-"));
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  await mkdir(workspace);
  await mkdir(home);
  try {
    await callback({ root, workspace, home });
  } finally {
    await rm(root, { recursive: true });
  }
}

async function expectSkillLoadError(
  pending: Promise<unknown>,
  code: SkillError["code"],
): Promise<void> {
  try {
    await pending;
  } catch (error) {
    if (!(error instanceof SkillError)) {
      throw error;
    }
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`Expected Agent Skill loading to fail with ${code}.`);
}

async function writeSkill(
  trustRoot: string,
  name: string,
  description: string,
  body: string,
  options: { extraFrontmatter?: string } = {},
): Promise<void> {
  const directory = path.join(trustRoot, ".agents", "skills", name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n${options.extraFrontmatter ?? ""}---\n${body}\n`,
  );
}
