import path from "node:path";

export function tinkerChromePackageRoot(): string {
  return path.resolve(import.meta.dir, "..");
}

export function extensionSourceRoot(): string {
  return path.join(tinkerChromePackageRoot(), "extension");
}

export function extensionBuildRoot(): string {
  return path.join(tinkerChromePackageRoot(), "dist", "extension");
}
