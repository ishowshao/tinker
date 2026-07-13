import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import path from "node:path";

export const PROJECT_INSTRUCTIONS_MAX_BYTES = 64 * 1024;

export type ProjectInstructionFileName = "CLAUDE.md" | "AGENTS.md";

export type LoadedProjectInstruction = {
  fileName: ProjectInstructionFileName;
  absolutePath: string;
  content: string;
  contentSha256: string;
  byteLength: number;
};

export type ProjectInstructionsSnapshot = {
  workspaceRoot: string;
  instruction?: LoadedProjectInstruction;
};

export type ProjectInstructionManifest = {
  path: ProjectInstructionFileName;
  byteLength: number;
  sha256: string;
};

const PROJECT_INSTRUCTION_FILE_NAMES: readonly ProjectInstructionFileName[] = [
  "AGENTS.md",
  "CLAUDE.md",
];

export async function loadProjectInstructions(
  workspaceRoot: string,
): Promise<ProjectInstructionsSnapshot> {
  const canonicalRoot = await realpath(workspaceRoot);
  for (const fileName of PROJECT_INSTRUCTION_FILE_NAMES) {
    const instruction = await loadCandidate(canonicalRoot, fileName);
    if (instruction !== undefined) {
      return { workspaceRoot: canonicalRoot, instruction };
    }
  }
  return { workspaceRoot: canonicalRoot };
}

export function buildSystemPrompt(input: {
  workspaceRoot: string;
  runtimeInstructions: string;
  projectInstructions: ProjectInstructionsSnapshot;
}): string {
  if (input.runtimeInstructions.trim() === "") {
    throw new Error("Runtime instructions must not be empty.");
  }
  if (input.projectInstructions.workspaceRoot !== input.workspaceRoot) {
    throw new Error(
      "Project instructions snapshot does not match the current workspace root.",
    );
  }

  const runtime = wrapTextBlock(
    "tinker_runtime_instructions",
    input.runtimeInstructions,
  );
  const instruction = input.projectInstructions.instruction;
  if (instruction === undefined) {
    return runtime;
  }

  const content =
    instruction.content + (instruction.content.endsWith("\n") ? "" : "\n");
  const project = `<project_instructions>
The following file contains trusted project instructions for this workspace.
They do not override Tinker's runtime, tool protocol, or safety constraints.

<instruction_file path="${instruction.fileName}">
${content}</instruction_file>
</project_instructions>`;
  return `${runtime}\n\n${project}`;
}

export function projectInstructionManifest(
  snapshot: ProjectInstructionsSnapshot,
): ProjectInstructionManifest | undefined {
  const instruction = snapshot.instruction;
  return instruction === undefined
    ? undefined
    : {
        path: instruction.fileName,
        byteLength: instruction.byteLength,
        sha256: instruction.contentSha256,
      };
}

async function loadCandidate(
  workspaceRoot: string,
  fileName: ProjectInstructionFileName,
): Promise<LoadedProjectInstruction | undefined> {
  const absolutePath = path.join(workspaceRoot, fileName);
  let handle;
  try {
    handle = await open(absolutePath, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      throw loadError(fileName, error);
    }
    try {
      await lstat(absolutePath);
    } catch (lstatError) {
      if (isErrno(lstatError, "ENOENT")) {
        return undefined;
      }
      throw loadError(fileName, lstatError);
    }
    throw loadError(fileName, error);
  }

  try {
    const targetPath = await realpath(absolutePath);
    if (!isWithinWorkspace(workspaceRoot, targetPath)) {
      throw new Error(
        `Project instruction ${fileName} resolves outside the workspace root.`,
      );
    }

    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error(`Project instruction ${fileName} must be a regular file.`);
    }
    const targetStats = await stat(targetPath);
    if (targetStats.dev !== stats.dev || targetStats.ino !== stats.ino) {
      throw new Error(`Project instruction ${fileName} changed while being opened.`);
    }
    if (stats.size > PROJECT_INSTRUCTIONS_MAX_BYTES) {
      throw tooLargeError(fileName, stats.size);
    }

    const bytes = await readBounded(handle, PROJECT_INSTRUCTIONS_MAX_BYTES);
    if (bytes.byteLength > PROJECT_INSTRUCTIONS_MAX_BYTES) {
      throw tooLargeError(fileName, bytes.byteLength);
    }
    if (bytes.includes(0)) {
      throw new Error(`Project instruction ${fileName} contains a NUL byte.`);
    }

    let content: string;
    try {
      content = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
    } catch (error) {
      throw new Error(`Project instruction ${fileName} is not valid UTF-8.`, {
        cause: error,
      });
    }
    if (content.trim() === "") {
      throw new Error(`Project instruction ${fileName} must not be empty.`);
    }

    return {
      fileName,
      absolutePath,
      content,
      contentSha256: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
    };
  } catch (error) {
    if (isProjectInstructionError(error, fileName)) {
      throw error;
    }
    throw loadError(fileName, error);
  } finally {
    await handle.close().catch((error: unknown) => {
      throw loadError(fileName, error);
    });
  }
}

async function readBounded(
  handle: Awaited<ReturnType<typeof open>>,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maxBytes) {
    const chunk = Buffer.allocUnsafe(Math.min(8192, maxBytes + 1 - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
    if (bytesRead === 0) {
      break;
    }
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  return Buffer.concat(chunks, total);
}

function wrapTextBlock(tag: string, content: string): string {
  return `<${tag}>\n${content}${content.endsWith("\n") ? "" : "\n"}</${tag}>`;
}

function isWithinWorkspace(workspaceRoot: string, targetPath: string): boolean {
  const relative = path.relative(workspaceRoot, targetPath);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function tooLargeError(fileName: ProjectInstructionFileName, actual: number): Error {
  return new Error(
    `Project instruction ${fileName} is ${actual} bytes; the limit is ${PROJECT_INSTRUCTIONS_MAX_BYTES} bytes.`,
  );
}

function loadError(fileName: ProjectInstructionFileName, cause: unknown): Error {
  return new Error(
    `Failed to load project instruction ${fileName}: ${errorMessage(cause)}`,
    { cause },
  );
}

function isProjectInstructionError(
  error: unknown,
  fileName: ProjectInstructionFileName,
): error is Error {
  return error instanceof Error && error.message.includes(`instruction ${fileName}`);
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
