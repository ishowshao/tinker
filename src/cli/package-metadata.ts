import { readFile } from "node:fs/promises";

export type PackageMetadata = {
  readonly name: string;
  readonly version: string;
};

export class PackageMetadataError extends Error {
  constructor() {
    super("Tinker package metadata is unavailable.");
    this.name = "PackageMetadataError";
  }
}

export async function loadPackageMetadata(
  packageJsonUrl = new URL("../../package.json", import.meta.url),
): Promise<PackageMetadata> {
  try {
    const parsed = JSON.parse(await readFile(packageJsonUrl, "utf8")) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("name" in parsed) ||
      typeof parsed.name !== "string" ||
      parsed.name.trim() === "" ||
      !("version" in parsed) ||
      typeof parsed.version !== "string" ||
      parsed.version.trim() === ""
    ) {
      throw new TypeError("Invalid package metadata.");
    }
    return Object.freeze({ name: parsed.name, version: parsed.version });
  } catch {
    throw new PackageMetadataError();
  }
}
