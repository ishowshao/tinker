import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXTENSION_ID, EXTENSION_PUBLIC_KEY } from "../src/constants";
import { extensionBuildRoot, extensionSourceRoot } from "../src/extension-path";

const sourceRoot = extensionSourceRoot();
const outputRoot = extensionBuildRoot();
await mkdir(outputRoot, { recursive: true, mode: 0o700 });

const manifestRaw = await readFile(path.join(sourceRoot, "manifest.json"), "utf8");
const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
if (manifest.key !== EXTENSION_PUBLIC_KEY) {
  throw new Error("Extension manifest key does not match the source constant.");
}
const derivedExtensionId = deriveExtensionId(EXTENSION_PUBLIC_KEY);
if (derivedExtensionId !== EXTENSION_ID) {
  throw new Error(
    `Extension key derives ${derivedExtensionId}, expected ${EXTENSION_ID}.`,
  );
}

const result = await Bun.build({
  entrypoints: [path.join(sourceRoot, "src", "service-worker.ts")],
  outdir: outputRoot,
  target: "browser",
  format: "esm",
  naming: "service-worker.js",
  minify: false,
  sourcemap: "none",
});
if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  throw new Error("Failed to build the Tinker Chrome extension.");
}

const puppeteerBrowserBundlePath = fileURLToPath(
  import.meta.resolve("puppeteer-core/lib/es5-iife/puppeteer-core-browser.js"),
);
const serviceWorkerPath = path.join(outputRoot, "service-worker.js");
const [puppeteerBrowserBundle, serviceWorker] = await Promise.all([
  readFile(puppeteerBrowserBundlePath, "utf8"),
  readFile(serviceWorkerPath, "utf8"),
]);
await writeFile(
  serviceWorkerPath,
  `${puppeteerBrowserBundle}\n${serviceWorker}`,
  "utf8",
);

await writeFile(
  path.join(outputRoot, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);
console.info(`Built Tinker Chrome extension ${EXTENSION_ID}`);
console.info(outputRoot);

function deriveExtensionId(publicKey: string): string {
  const digest = createHash("sha256")
    .update(Buffer.from(publicKey, "base64"))
    .digest("hex")
    .slice(0, 32);
  return digest.replace(/[0-9a-f]/g, (character) =>
    String.fromCharCode("a".charCodeAt(0) + Number.parseInt(character, 16)),
  );
}
