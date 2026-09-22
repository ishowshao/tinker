import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { lstat, readdir, realpath, readFile } from "node:fs/promises";
import path from "node:path";
import {
  localServicePaths,
  type LocalServiceInstance,
} from "../remote/local-service-discovery";

/** Check every live service using this installation, including explicit non-default state directories. */
export async function assertServiceUpgradeSafe(packageRoot: string): Promise<void> {
  if (process.platform === "win32") return;
  const root = path.dirname(localServicePaths("").socket);
  let entries: string[];
  try {
    const info = await lstat(root);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077
    )
      throw new Error(
        "Unsafe local service discovery directory; cannot verify upgrade safety.",
      );
    entries = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const canonical = await realpath(packageRoot);
  for (const entry of entries.filter((name) =>
    /^[a-f0-9]{32}\.sock\.json$/.test(name),
  )) {
    const instance = JSON.parse(
      await readFile(path.join(root, entry), "utf8"),
    ) as LocalServiceInstance;
    if (
      instance.packageRoot === canonical &&
      (await Bun.file(
        path.join(instance.stateDirectory, "supervisor.enabled"),
      ).exists())
    )
      throw new Error(
        `Disable the supervised service before upgrading: tinker serve --config ${instance.configPath} --stop.`,
      );
  }
  for (const entry of entries.filter((name) => /^[a-f0-9]{32}\.sock$/.test(name))) {
    const instance = await probe(path.join(root, entry));
    if (instance && (!instance.packageRoot || instance.packageRoot === canonical))
      throw new Error(
        `Stop the running service before upgrading: tinker serve --config ${instance.configPath} --stop. Upgrade does not interrupt work or replace a live runtime.`,
      );
  }
}
function probe(socketPath: string): Promise<LocalServiceInstance | undefined> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const nonce = randomUUID();
    let content = "";
    let finished = false;
    const done = (instance?: LocalServiceInstance, error?: Error) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(instance);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(1000, () =>
      done(
        undefined,
        new Error(
          "A local service is unresponsive; stop it explicitly before upgrading.",
        ),
      ),
    );
    socket.once("connect", () => socket.write(`${nonce}\n`));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      ["ENOENT", "ECONNREFUSED"].includes(error.code ?? "")
        ? done()
        : done(undefined, error),
    );
    socket.once("end", () => done());
    socket.on("data", (chunk: string) => {
      content += chunk;
      if (content.length > 16384)
        return done(undefined, new Error("Invalid service upgrade probe response."));
      if (!content.includes("\n")) return;
      try {
        const response = JSON.parse(content.trim()) as {
          nonce: string;
          instance: LocalServiceInstance;
        };
        if (response.nonce !== nonce || response.instance?.version !== 1)
          throw new Error("Invalid service upgrade probe response.");
        done(response.instance);
      } catch (error) {
        done(
          undefined,
          error instanceof Error ? error : new Error("Invalid service response."),
        );
      }
    });
  });
}
