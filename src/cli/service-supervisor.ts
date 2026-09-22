import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalServiceTarget } from "../remote/local-service-discovery";

export function supervisorPaths(target: LocalServiceTarget) {
  const label = `dev.tinker.service.${createHash("sha256").update(target.config.stateDirectory).digest("hex").slice(0, 16)}`;
  return {
    label,
    job: `gui/${process.getuid?.()}/${label}`,
    plist: path.join(homedir(), "Library/LaunchAgents", `${label}.plist`),
    enabled: path.join(target.config.stateDirectory, "supervisor.enabled"),
    environment: path.join(target.config.stateDirectory, "supervisor-env.json"),
    marker: path.join(target.config.stateDirectory, "supervisor.json"),
  };
}
const xml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!,
  );
export function launchAgentPlist(target: LocalServiceTarget): string {
  const files = supervisorPaths(target);
  const args = [
    process.execPath,
    fileURLToPath(new URL("./index.ts", import.meta.url)),
    "serve",
    "--config",
    target.configPath,
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${xml(files.label)}</string>
<key>ProgramArguments</key><array>${args.map((value) => `<string>${xml(value)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(path.dirname(target.configPath))}</string>
<key>EnvironmentVariables</key><dict><key>TINKER_HOME</key><string>${xml(target.homeRoot)}</string><key>TINKER_SERVICE_ENV_FILE</key><string>${xml(files.environment)}</string></dict>
<key>KeepAlive</key><dict><key>PathState</key><dict><key>${xml(files.enabled)}</key><true/></dict></dict>
<key>ThrottleInterval</key><integer>10</integer>
<key>ExitTimeOut</key><integer>${Math.ceil((target.config.resident?.shutdownGraceMs ?? 30000) / 1000) + 10}</integer>
<key>StandardOutPath</key><string>${xml(path.join(target.config.stateDirectory, "service.log"))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(target.config.stateDirectory, "service.log"))}</string>
<key>Umask</key><integer>63</integer>
</dict></plist>\n`;
}
export async function launchctl(args: string[]): Promise<void> {
  const child = Bun.spawn(["/bin/launchctl", ...args], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const [error, code] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(`launchctl ${args[0]} failed (${code}): ${error.trim()}`);
}
export async function installSupervisor(
  target: LocalServiceTarget,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (process.platform !== "darwin")
    throw new Error(
      "System supervision currently supports macOS LaunchAgents; use serve --background elsewhere.",
    );
  const files = supervisorPaths(target);
  if (await Bun.file(files.marker).exists())
    throw new Error(
      "Supervision is already installed. Stop and uninstall before replacing its configuration.",
    );
  await mkdir(path.dirname(files.plist), { recursive: true, mode: 0o700 });
  await mkdir(target.config.stateDirectory, { recursive: true, mode: 0o700 });
  const kept = Object.fromEntries(
    Object.entries(env).filter(
      ([key, value]) =>
        value !== undefined &&
        key !== "TINKER_SERVICE_ENV_FILE" &&
        (key.startsWith("TINKER_") ||
          [
            "PATH",
            "HOME",
            "LANG",
            "LC_ALL",
            "TZ",
            "EXA_API_KEY",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "NO_PROXY",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
          ].includes(key)),
    ),
  );
  await writeFile(
    files.environment,
    JSON.stringify({ ...kept, TINKER_HOME: target.homeRoot }) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  let wrotePlist = false;
  let bootstrapped = false;
  try {
    await writeFile(files.plist, launchAgentPlist(target), { mode: 0o600, flag: "wx" });
    wrotePlist = true;
    await writeFile(files.enabled, "enabled\n", { mode: 0o600 });
    await launchctl(["bootstrap", `gui/${process.getuid?.()}`, files.plist]);
    bootstrapped = true;
    await writeFile(
      files.marker,
      JSON.stringify({ version: 1, label: files.label }) + "\n",
      { mode: 0o600 },
    );
  } catch (error) {
    await rm(files.enabled, { force: true });
    if (bootstrapped) await launchctl(["bootout", files.job]).catch(() => undefined);
    await Promise.all(
      [...(wrotePlist ? [files.plist] : []), files.environment].map((file) =>
        rm(file, { force: true }),
      ),
    );
    throw error;
  }
}
export async function disableSupervisor(target: LocalServiceTarget): Promise<void> {
  await rm(supervisorPaths(target).enabled, { force: true });
}
export async function startSupervisor(target: LocalServiceTarget): Promise<boolean> {
  const files = supervisorPaths(target);
  if (!(await Bun.file(files.marker).exists())) return false;
  if (process.platform !== "darwin")
    throw new Error("This service is managed by macOS launchd.");
  await writeFile(files.enabled, "enabled\n", { mode: 0o600 });
  // A job may be registered after a login, or may need bootstrap after an explicit bootout.
  try {
    await launchctl(["print", files.job]);
  } catch {
    await launchctl(["bootstrap", `gui/${process.getuid?.()}`, files.plist]);
  }
  await launchctl(["kickstart", files.job]);
  return true;
}
export async function uninstallSupervisor(target: LocalServiceTarget): Promise<void> {
  const files = supervisorPaths(target);
  if (!(await Bun.file(files.marker).exists())) return;
  await disableSupervisor(target);
  await launchctl(["bootout", files.job]);
  await Promise.all(
    [files.plist, files.marker, files.environment].map((file) =>
      rm(file, { force: true }),
    ),
  );
}
export async function supervisedEnvironment(
  env: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  if (!env.TINKER_SERVICE_ENV_FILE) return env;
  const values = JSON.parse(
    await readFile(env.TINKER_SERVICE_ENV_FILE, "utf8"),
  ) as Record<string, unknown>;
  if (
    !values ||
    Array.isArray(values) ||
    typeof values !== "object" ||
    Object.values(values).some((value) => typeof value !== "string")
  )
    throw new Error("Invalid supervised service environment.");
  await chmod(env.TINKER_SERVICE_ENV_FILE, 0o600);
  return { ...env, ...values } as NodeJS.ProcessEnv;
}
