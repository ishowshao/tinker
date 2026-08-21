import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { TurnCancelledError } from "../agent/turn-cancellation";
import { ObservationBuilder } from "../observation/observation-builder";
import { decodeStoredToolRawResult } from "../session/session-store";
import { SkillActivationCoordinator } from "../skills/skill-context";
import { loadSkillCatalog } from "../skills/skill-loader";
import { createSkillToolExecutor } from "../skills/skill-tool";
import { createTestRuntime } from "./test-runtime";

const executionContext = { signal: new AbortController().signal };

describe("Skill tool", () => {
  test("returns the immutable discovery snapshot and a sorted resource manifest", async () => {
    await withSkill(async ({ root, workspace, home, skillDirectory, content }) => {
      await mkdir(path.join(skillDirectory, "scripts"));
      await mkdir(path.join(skillDirectory, "references"));
      await writeFile(path.join(skillDirectory, "scripts", "z.sh"), "exit 0\n");
      await writeFile(path.join(skillDirectory, "scripts", "a.sh"), "exit 0\n");
      await writeFile(path.join(skillDirectory, "references", "guide.md"), "guide\n");
      const catalog = await loadSkillCatalog({
        workspaceRoot: workspace,
        homeRoot: home,
      });
      const coordinator = new SkillActivationCoordinator();
      const executor = createSkillToolExecutor({ catalog, coordinator });
      const call = createTestRuntime().toolCall({
        name: "Skill",
        args: { name: "review-code" },
      });

      await writeFile(
        path.join(skillDirectory, "SKILL.md"),
        content.replace("Review code", "Changed after discovery"),
      );
      const raw = await executor.execute(call.args, call, executionContext);

      expect(raw).toMatchObject({
        kind: "skill",
        ok: true,
        status: "loaded",
        name: "review-code",
        scope: "project",
        content,
        resources: ["references/guide.md", "scripts/a.sh", "scripts/z.sh"],
        resourcesTruncated: false,
      });
      expect(coordinator.status("review-code")).toMatchObject({
        status: "loaded",
        lifecycle: "pending",
      });

      const observation = new ObservationBuilder().build({ call, raw }).displayText;
      expect(observation).toContain('<agent_skill name="review-code" scope="project">');
      expect(observation).toContain("Review code");
      expect(observation).not.toContain("Changed after discovery");
      expect(observation).toContain('<skill_resources truncated="false">');
      expect(observation).toContain(`Skill directory: ${skillDirectory}`);
      expect(root).not.toBe("");
    });
  });

  test("is idempotent across pending, dispatched, and active lifecycle states", async () => {
    await withSkill(async ({ workspace, home }) => {
      const catalog = await loadSkillCatalog({
        workspaceRoot: workspace,
        homeRoot: home,
      });
      const coordinator = new SkillActivationCoordinator();
      const executor = createSkillToolExecutor({ catalog, coordinator });
      const identity = createTestRuntime();
      const execute = () => {
        const call = identity.toolCall({
          name: "Skill",
          args: { name: "review-code" },
        });
        return executor.execute(call.args, call, executionContext);
      };

      expect(await execute()).toMatchObject({ status: "loaded" });
      coordinator.markPending("review-code");
      expect(await execute()).toMatchObject({
        status: "already_loaded",
        lifecycle: "pending",
      });
      coordinator.markDispatched(["review-code"]);
      expect(await execute()).toMatchObject({
        status: "already_loaded",
        lifecycle: "dispatched",
      });
      const skill = catalog.skills.get("review-code")!;
      coordinator.replaceActive([
        {
          skill,
          activationMessageId: "activation-message" as never,
        },
      ]);
      expect(await execute()).toMatchObject({ status: "already_active" });
    });
  });

  test("fails a resource symlink outside the skill and releases its reservation", async () => {
    await withSkill(async ({ root, workspace, home, skillDirectory }) => {
      const outside = path.join(root, "outside.txt");
      await writeFile(outside, "private\n");
      await mkdir(path.join(skillDirectory, "references"));
      await symlink(outside, path.join(skillDirectory, "references", "outside.txt"));
      const catalog = await loadSkillCatalog({
        workspaceRoot: workspace,
        homeRoot: home,
      });
      const coordinator = new SkillActivationCoordinator();
      const executor = createSkillToolExecutor({ catalog, coordinator });
      const call = createTestRuntime().toolCall({
        name: "Skill",
        args: { name: "review-code" },
      });

      expect(await executor.execute(call.args, call, executionContext)).toMatchObject({
        kind: "skill",
        ok: false,
        status: "failed",
        errorCode: "SKILL_RESOURCE_INVALID",
      });
      expect(coordinator.status("review-code")).toEqual({ status: "inactive" });
    });
  });

  test("bounds large resource manifests without reading resource contents", async () => {
    await withSkill(async ({ workspace, home, skillDirectory }) => {
      const assets = path.join(skillDirectory, "assets");
      await mkdir(assets);
      await Promise.all(
        Array.from({ length: 205 }, (_, index) =>
          writeFile(path.join(assets, `${String(index).padStart(3, "0")}.txt`), ""),
        ),
      );
      const catalog = await loadSkillCatalog({
        workspaceRoot: workspace,
        homeRoot: home,
      });
      const executor = createSkillToolExecutor({
        catalog,
        coordinator: new SkillActivationCoordinator(),
      });
      const call = createTestRuntime().toolCall({
        name: "Skill",
        args: { name: "review-code" },
      });

      const raw = await executor.execute(call.args, call, executionContext);
      expect(raw).toMatchObject({
        kind: "skill",
        ok: true,
        status: "loaded",
        resourcesTruncated: true,
      });
      if (raw.kind !== "skill" || !raw.ok || raw.status !== "loaded") {
        throw new Error("Expected a loaded Skill result.");
      }
      expect(raw.resources).toHaveLength(200);
      expect(raw.resources[0]).toBe("assets/000.txt");
      expect(raw.resources.at(-1)).toBe("assets/199.txt");
    });
  });

  test("rejects arguments outside the exact one-name schema", async () => {
    await withSkill(async ({ workspace, home }) => {
      const catalog = await loadSkillCatalog({
        workspaceRoot: workspace,
        homeRoot: home,
      });
      const coordinator = new SkillActivationCoordinator();
      const executor = createSkillToolExecutor({ catalog, coordinator });
      const call = createTestRuntime().toolCall({
        name: "Skill",
        args: { name: "review-code", extra: true },
      });

      expect(await executor.execute(call.args, call, executionContext)).toMatchObject({
        kind: "skill",
        ok: false,
        status: "failed",
        errorCode: "SKILL_FIELD_INVALID",
      });
    });
  });

  test("bounds resource depth and never executes discovered scripts", async () => {
    await withSkill(async ({ root, workspace, home, skillDirectory }) => {
      const marker = path.join(root, "executed.txt");
      const scriptDirectory = path.join(skillDirectory, "scripts");
      await mkdir(scriptDirectory);
      await writeFile(
        path.join(scriptDirectory, "danger.sh"),
        `#!/bin/sh\nprintf executed > ${JSON.stringify(marker)}\n`,
      );
      const deepDirectory = path.join(
        skillDirectory,
        "references",
        "one",
        "two",
        "three",
        "four",
      );
      await mkdir(deepDirectory, { recursive: true });
      await writeFile(path.join(deepDirectory, "hidden.md"), "hidden\n");

      const catalog = await loadSkillCatalog({
        workspaceRoot: workspace,
        homeRoot: home,
      });
      const executor = createSkillToolExecutor({
        catalog,
        coordinator: new SkillActivationCoordinator(),
      });
      const call = createTestRuntime().toolCall({
        name: "Skill",
        args: { name: "review-code" },
      });
      const raw = await executor.execute(call.args, call, executionContext);

      expect(raw).toMatchObject({
        ok: true,
        status: "loaded",
        resourcesTruncated: true,
      });
      if (raw.kind !== "skill" || !raw.ok || raw.status !== "loaded") {
        throw new Error("Expected a loaded Skill result.");
      }
      expect(raw.resources).toContain("scripts/danger.sh");
      expect(raw.resources).not.toContain("references/one/two/three/four/hidden.md");
      expect(await Bun.file(marker).exists()).toBe(false);
    });
  });

  test("enforces the combined active and unresolved skill count limit", async () => {
    await withSkill(async ({ workspace, home }) => {
      for (let index = 0; index < 16; index += 1) {
        const name = `extra-${String(index).padStart(2, "0")}`;
        const directory = path.join(workspace, ".agents", "skills", name);
        await mkdir(directory, { recursive: true });
        await writeFile(
          path.join(directory, "SKILL.md"),
          `---\nname: ${name}\ndescription: Extra ${index}\n---\nbody\n`,
        );
      }
      const catalog = await loadSkillCatalog({
        workspaceRoot: workspace,
        homeRoot: home,
      });
      const coordinator = new SkillActivationCoordinator();
      const executor = createSkillToolExecutor({ catalog, coordinator });
      const runtime = createTestRuntime();
      const names = [...catalog.skills.keys()];

      for (const name of names.slice(0, 16)) {
        const call = runtime.toolCall({ name: "Skill", args: { name } });
        expect(await executor.execute(call.args, call, executionContext)).toMatchObject(
          { ok: true, status: "loaded" },
        );
      }
      const rejectedName = names[16];
      if (rejectedName === undefined) {
        throw new Error("Expected a seventeenth skill.");
      }
      const rejectedCall = runtime.toolCall({
        name: "Skill",
        args: { name: rejectedName },
      });
      expect(
        await executor.execute(rejectedCall.args, rejectedCall, executionContext),
      ).toMatchObject({
        ok: false,
        status: "failed",
        errorCode: "SKILL_ACTIVE_LIMIT_EXCEEDED",
      });
      expect(coordinator.status(rejectedName)).toEqual({ status: "inactive" });
    });
  });

  test("enforces the combined active and unresolved skill byte limit", async () => {
    await withSkill(async ({ workspace, home, skillDirectory }) => {
      const body = "x".repeat(44_000);
      await writeFile(
        path.join(skillDirectory, "SKILL.md"),
        `---\nname: review-code\ndescription: Review code\n---\n${body}\n`,
      );
      for (const name of ["large-one", "large-two"]) {
        const directory = path.join(workspace, ".agents", "skills", name);
        await mkdir(directory, { recursive: true });
        await writeFile(
          path.join(directory, "SKILL.md"),
          `---\nname: ${name}\ndescription: Large guidance\n---\n${body}\n`,
        );
      }
      const catalog = await loadSkillCatalog({
        workspaceRoot: workspace,
        homeRoot: home,
      });
      const coordinator = new SkillActivationCoordinator();
      const executor = createSkillToolExecutor({ catalog, coordinator });
      const runtime = createTestRuntime();
      for (const name of ["review-code", "large-one"]) {
        const call = runtime.toolCall({ name: "Skill", args: { name } });
        expect(await executor.execute(call.args, call, executionContext)).toMatchObject(
          { ok: true, status: "loaded" },
        );
      }
      const rejectedCall = runtime.toolCall({
        name: "Skill",
        args: { name: "large-two" },
      });
      expect(
        await executor.execute(rejectedCall.args, rejectedCall, executionContext),
      ).toMatchObject({
        ok: false,
        status: "failed",
        errorCode: "SKILL_ACTIVE_LIMIT_EXCEEDED",
      });
      expect(coordinator.status("large-two")).toEqual({ status: "inactive" });
    });
  });

  test("round-trips strict Skill raw results through stored decoding", async () => {
    await withSkill(async ({ workspace, home }) => {
      const catalog = await loadSkillCatalog({
        workspaceRoot: workspace,
        homeRoot: home,
      });
      const executor = createSkillToolExecutor({
        catalog,
        coordinator: new SkillActivationCoordinator(),
      });
      const call = createTestRuntime().toolCall({
        name: "Skill",
        args: { name: "review-code" },
      });
      const raw = await executor.execute(call.args, call, executionContext);
      expect(decodeStoredToolRawResult(JSON.parse(JSON.stringify(raw)))).toEqual(raw);
      expect(() => decodeStoredToolRawResult({ ...raw, unexpected: true })).toThrow(
        "loaded Skill raw result has invalid keys",
      );
    });
  });

  test("honors turn cancellation before reserving a skill", async () => {
    await withSkill(async ({ workspace, home }) => {
      const catalog = await loadSkillCatalog({
        workspaceRoot: workspace,
        homeRoot: home,
      });
      const coordinator = new SkillActivationCoordinator();
      const executor = createSkillToolExecutor({ catalog, coordinator });
      const call = createTestRuntime().toolCall({
        name: "Skill",
        args: { name: "review-code" },
      });
      const controller = new AbortController();
      controller.abort(new TurnCancelledError("user"));

      await expectTurnCancellation(
        executor.execute(call.args, call, { signal: controller.signal }),
      );
      expect(coordinator.status("review-code")).toEqual({ status: "inactive" });
    });
  });
});

async function expectTurnCancellation(pending: Promise<unknown>): Promise<void> {
  try {
    await pending;
  } catch (error) {
    expect(error).toBeInstanceOf(TurnCancelledError);
    return;
  }
  throw new Error("Expected Skill execution to be cancelled.");
}

async function withSkill(
  callback: (fixture: {
    root: string;
    workspace: string;
    home: string;
    skillDirectory: string;
    content: string;
  }) => Promise<void>,
): Promise<void> {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "tinker-skill-tool-")),
  );
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  const skillDirectory = path.join(workspace, ".agents", "skills", "review-code");
  const content =
    "---\nname: review-code\ndescription: Review code for correctness\n---\nReview code carefully.\n";
  await mkdir(skillDirectory, { recursive: true });
  await mkdir(home);
  await writeFile(path.join(skillDirectory, "SKILL.md"), content);
  try {
    await callback({ root, workspace, home, skillDirectory, content });
  } finally {
    await rm(root, { recursive: true });
  }
}
