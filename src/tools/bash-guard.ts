import path from "node:path";

export type BashRisk =
  | { readonly dangerous: false }
  | { readonly dangerous: true; readonly reason: string };

export type BashRiskContext = {
  readonly workspaceRoot?: string;
};

const SAFE: BashRisk = Object.freeze({ dangerous: false });

export function classifyBashRisk(
  command: string,
  context: BashRiskContext = {},
): BashRisk {
  const normalized = command.trim();
  if (normalized === "") {
    return SAFE;
  }

  if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(normalized)) {
    return dangerous("fork bomb");
  }

  for (const segment of shellSegments(normalized)) {
    const words = shellWords(segment);
    const commandIndex = commandWordIndex(words);
    if (commandIndex === -1) {
      continue;
    }
    const name = basename(words[commandIndex] ?? "");
    const args = words.slice(commandIndex + 1);

    if (["shutdown", "reboot", "halt", "poweroff"].includes(name)) {
      return dangerous(`system power command ${name}`);
    }
    if (name === "wipefs" || name.startsWith("mkfs.")) {
      return dangerous(`block-device command ${name}`);
    }
    if (name === "dd" && args.some((word) => /^of=\/dev\/[^/]/.test(word))) {
      return dangerous("dd writes directly to a device");
    }
    if ((name === "chmod" || name === "chown") && hasRecursiveFlag(args)) {
      const operands = args.filter((word) => !word.startsWith("-"));
      if (operands.at(-1) === "/") {
        return dangerous(`${name} recursively targets the filesystem root`);
      }
    }
    if (name === "rm" && hasRecursiveFlag(args) && hasForceFlag(args)) {
      const operands = args.filter((word) => !word.startsWith("-"));
      if (
        operands.some((target) => isDestructiveRmTarget(target, context.workspaceRoot))
      ) {
        return dangerous("recursive forced removal targets a protected root");
      }
    }
  }

  return SAFE;
}

function dangerous(reason: string): BashRisk {
  return Object.freeze({ dangerous: true, reason });
}

function shellSegments(command: string): string[] {
  return command.split(/(?:&&|\|\||[;|\n])/);
}

function shellWords(segment: string): string[] {
  return segment.match(/"(?:\\.|[^"])*"|'[^']*'|[^\s]+/g)?.map(unquote) ?? [];
}

function unquote(word: string): string {
  if (
    (word.startsWith('"') && word.endsWith('"')) ||
    (word.startsWith("'") && word.endsWith("'"))
  ) {
    return word.slice(1, -1);
  }
  return word;
}

function commandWordIndex(words: readonly string[]): number {
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? "")) {
    index += 1;
  }
  if (basename(words[index] ?? "") === "sudo") {
    index += 1;
    while ((words[index] ?? "").startsWith("-")) {
      index += 1;
    }
  }
  return index < words.length ? index : -1;
}

function basename(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

function hasRecursiveFlag(args: readonly string[]): boolean {
  return args.some((word) => /^-[^-]*[rR]/.test(word) || word === "--recursive");
}

function hasForceFlag(args: readonly string[]): boolean {
  return args.some((word) => /^-[^-]*f/.test(word) || word === "--force");
}

function isDestructiveRmTarget(
  target: string,
  workspaceRoot: string | undefined,
): boolean {
  if (target === "/" || target === "/*" || target === "~" || target === "~/*") {
    return true;
  }
  if (
    target === "$HOME" ||
    target === "${HOME}" ||
    target === "$HOME/*" ||
    target === "${HOME}/*"
  ) {
    return true;
  }
  if (workspaceRoot === undefined || !path.isAbsolute(target)) {
    return false;
  }
  const normalizedTarget = path.resolve(target.replace(/\/\*$/, ""));
  return normalizedTarget === path.resolve(workspaceRoot);
}
