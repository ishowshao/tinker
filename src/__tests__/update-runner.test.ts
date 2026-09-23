import { describe, expect, test } from "bun:test";
import {
  OFFICIAL_NPM_REGISTRY,
  runUpdate,
  type UpdateRunnerDependencies,
} from "../cli/update-runner";

class MemoryWriter {
  output = "";

  write(chunk: string): boolean {
    this.output += chunk;
    return true;
  }
}

const PREFIX = "/opt/tinker-update-test";
const GLOBAL_ROOT = `${PREFIX}/lib/node_modules`;
const PACKAGE_ROOT = `${GLOBAL_ROOT}/tinker-agent`;

describe("CLI update runner", () => {
  test("prepares before installation and verifies restart only after package verification", async () => {
    const harness = updateHarness("1.8.0");
    const events: string[] = [];
    const npm = harness.dependencies.runNpm;
    harness.dependencies.runNpm = async (input) => {
      if (input.args[0] === "install") events.push("install");
      return npm(input);
    };
    harness.dependencies.readPackageMetadata = async () => {
      events.push("verify");
      return { name: "tinker-agent", version: "1.8.0" };
    };
    harness.dependencies.prepareServiceUpgrade = async () => {
      events.push("prepare");
      return {
        restartInstructions: "tinker serve --restart",
        restart: async (version) => {
          events.push(`restart ${version}`);
        },
        release: async () => {
          events.push("release");
        },
      };
    };
    const stdout = new MemoryWriter();
    await runUpdate(
      { metadata: { name: "tinker-agent", version: "1.7.0" }, stdout, env: {} },
      harness.dependencies,
    );
    expect(events).toEqual([
      "prepare",
      "install",
      "verify",
      "restart 1.8.0",
      "release",
    ]);
    expect(stdout.output).toContain("Service restart verified");
  });

  test("busy service postpones installation", async () => {
    const harness = updateHarness("1.8.0");
    harness.dependencies.prepareServiceUpgrade = async () => {
      throw new Error("Service is busy; update postponed");
    };
    expect(
      String(
        await runUpdate(
          {
            metadata: { name: "tinker-agent", version: "1.7.0" },
            stdout: new MemoryWriter(),
            env: {},
          },
          harness.dependencies,
        ).catch((error: unknown) => error),
      ),
    ).toContain("update postponed");
    expect(harness.calls.some((args) => args[0] === "install")).toBe(false);
  });

  test("installation and restart failures report distinct recovery states and release ownership", async () => {
    for (const installFails of [true, false]) {
      const harness = updateHarness("1.8.0", installFails ? "install" : undefined);
      let released = false;
      let restarted = false;
      harness.dependencies.prepareServiceUpgrade = async () => ({
        restartInstructions: "tinker serve --config '/custom/service.json' --restart",
        restart: async () => {
          restarted = true;
          throw new Error("startup failed");
        },
        release: async () => {
          released = true;
        },
      });
      const stdout = new MemoryWriter();
      const result = await runUpdate(
        { metadata: { name: "tinker-agent", version: "1.7.0" }, stdout, env: {} },
        harness.dependencies,
      ).catch((error: unknown) => error);
      expect(String(result)).toContain(
        installFails
          ? "services stopped for this update remain stopped"
          : "Software updated to 1.8.0, but service restart failed",
      );
      expect(String(result)).toContain("--config '/custom/service.json' --restart");
      expect(released).toBe(true);
      expect(restarted).toBe(!installFails);
      expect(stdout.output).not.toContain("Service restart verified");
    }
  });

  test("refuses to replace package files while a service is still using the installation", async () => {
    const harness = updateHarness("1.8.0");
    harness.dependencies.assertServiceUpgradeSafe = async () => {
      throw new Error("Stop the running service before upgrading");
    };
    const result = await runUpdate(
      {
        metadata: { name: "tinker-agent", version: "1.7.0" },
        stdout: new MemoryWriter(),
        env: {},
      },
      harness.dependencies,
    ).catch((error: unknown) => error);
    expect(String(result)).toContain("Stop the running service");
    expect(harness.calls.some((args) => args[0] === "install")).toBe(false);
  });

  test("updates the active global installation to the exact npm latest version", async () => {
    const writer = new MemoryWriter();
    const harness = updateHarness("1.8.0");
    let verifiedPath = "";
    harness.dependencies.readPackageMetadata = async (packageJsonPath) => {
      verifiedPath = packageJsonPath;
      return { name: "tinker-agent", version: "1.8.0" };
    };

    expect(
      await runUpdate(
        {
          metadata: { name: "tinker-agent", version: "1.7.0" },
          stdout: writer,
          env: { PATH: "/usr/bin" },
        },
        harness.dependencies,
      ),
    ).toBe(0);

    expect(writer.output).toBe(
      "Current version: 1.7.0\n" +
        "Checking npm official registry for the latest version...\n" +
        "Updating to 1.8.0...\n" +
        "Successfully updated from 1.7.0 to version 1.8.0\n",
    );
    expect(verifiedPath).toBe(`${PACKAGE_ROOT}/package.json`);
    expect(harness.calls).toEqual([
      ["root", "--global"],
      ["prefix", "--global"],
      [
        "view",
        "tinker-agent@latest",
        "version",
        "--json",
        "--registry",
        OFFICIAL_NPM_REGISTRY,
        "--prefer-online",
      ],
      [
        "install",
        "--global",
        "--prefix",
        PREFIX,
        "tinker-agent@1.8.0",
        "--registry",
        OFFICIAL_NPM_REGISTRY,
        "--prefer-online",
        "--no-audit",
        "--no-fund",
        "--loglevel",
        "error",
      ],
    ]);
  });

  test("exits successfully without installing when no upgrade is needed", async () => {
    for (const scenario of [
      {
        current: "1.8.0",
        latest: "1.8.0",
        final: "Already up to date: 1.8.0\n",
      },
      {
        current: "2.0.0-beta.1",
        latest: "1.8.0",
        final:
          "Installed version 2.0.0-beta.1 is newer than npm latest 1.8.0; no changes made.\n",
      },
    ]) {
      const writer = new MemoryWriter();
      const harness = updateHarness(scenario.latest);
      expect(
        await runUpdate(
          {
            metadata: { name: "tinker-agent", version: scenario.current },
            stdout: writer,
            env: {},
          },
          harness.dependencies,
        ),
      ).toBe(0);
      expect(writer.output).toBe(
        `Current version: ${scenario.current}\n` +
          "Checking npm official registry for the latest version...\n" +
          scenario.final,
      );
      expect(harness.calls).toHaveLength(3);
    }
  });

  test("rejects source checkouts and linked global packages", async () => {
    for (const overrides of [
      { packageRoot: "/workspace/tinker" },
      { isSymbolicLink: async () => true },
    ]) {
      const writer = new MemoryWriter();
      const harness = updateHarness("1.8.0");
      expect(
        runUpdate(
          {
            metadata: { name: "tinker-agent", version: "1.7.0" },
            stdout: writer,
            env: {},
          },
          { ...harness.dependencies, ...overrides },
        ),
      ).rejects.toThrow("not managed by the active npm global prefix");
      expect(harness.calls).toHaveLength(2);
    }
  });

  test("reports registry and install failures without claiming success", async () => {
    const registryWriter = new MemoryWriter();
    const registryHarness = updateHarness("1.8.0", "view");
    expect(
      runUpdate(
        {
          metadata: { name: "tinker-agent", version: "1.7.0" },
          stdout: registryWriter,
          env: {},
        },
        registryHarness.dependencies,
      ),
    ).rejects.toThrow("Could not query the npm official registry: network down");
    expect(registryWriter.output).not.toContain("Successfully updated");

    const installWriter = new MemoryWriter();
    const installHarness = updateHarness("1.8.0", "install");
    expect(
      runUpdate(
        {
          metadata: { name: "tinker-agent", version: "1.7.0" },
          stdout: installWriter,
          env: {},
        },
        installHarness.dependencies,
      ),
    ).rejects.toThrow("npm could not install tinker-agent@1.8.0: permission denied");
    expect(installWriter.output).toContain("Updating to 1.8.0...");
    expect(installWriter.output).not.toContain("Successfully updated");
  });

  test("rejects invalid update metadata and failed post-install verification", async () => {
    const invalidHarness = updateHarness("1.8.0");
    invalidHarness.dependencies.runNpm = async (input) => {
      invalidHarness.calls.push([...input.args]);
      if (input.args[0] === "root") {
        return success(`${GLOBAL_ROOT}\n`);
      }
      if (input.args[0] === "prefix") {
        return success(`${PREFIX}\n`);
      }
      return success("not-json");
    };
    expect(
      runUpdate(
        {
          metadata: { name: "tinker-agent", version: "1.7.0" },
          stdout: new MemoryWriter(),
          env: {},
        },
        invalidHarness.dependencies,
      ),
    ).rejects.toThrow("npm returned invalid update metadata");

    const verificationHarness = updateHarness("1.8.0");
    verificationHarness.dependencies.readPackageMetadata = async () => ({
      name: "tinker-agent",
      version: "1.7.0",
    });
    expect(
      runUpdate(
        {
          metadata: { name: "tinker-agent", version: "1.7.0" },
          stdout: new MemoryWriter(),
          env: {},
        },
        verificationHarness.dependencies,
      ),
    ).rejects.toThrow("active global installation is not version 1.8.0");
  });
});

function updateHarness(latestVersion: string, failAt?: "view" | "install") {
  const calls: string[][] = [];
  const dependencies: Mutable<UpdateRunnerDependencies> = {
    prepareServiceUpgrade: async () => ({
      restartInstructions: "",
      restart: async () => undefined,
      release: async () => undefined,
    }),
    assertServiceUpgradeSafe: async () => undefined,
    packageRoot: PACKAGE_ROOT,
    npmCwd: "/tmp",
    runNpm: async (input) => {
      calls.push([...input.args]);
      switch (input.args[0]) {
        case "root":
          return success(`${GLOBAL_ROOT}\n`);
        case "prefix":
          return success(`${PREFIX}\n`);
        case "view":
          return failAt === "view"
            ? failure("network down")
            : success(`${JSON.stringify(latestVersion)}\n`);
        case "install":
          return failAt === "install" ? failure("permission denied") : success();
        default:
          throw new Error(`Unexpected npm command: ${String(input.args[0])}`);
      }
    },
    canonicalizePath: async (filePath) => filePath,
    isSymbolicLink: async () => false,
    readPackageMetadata: async () => ({
      name: "tinker-agent",
      version: latestVersion,
    }),
    compareVersions: (left, right) => Bun.semver.order(left, right),
  };
  return { calls, dependencies };
}

function success(stdout = "") {
  return { exitCode: 0, signal: null, stdout, stderr: "" } as const;
}

function failure(stderr: string) {
  return { exitCode: 1, signal: null, stdout: "", stderr } as const;
}

type Mutable<Value> = { -readonly [Key in keyof Value]: Value[Key] };
