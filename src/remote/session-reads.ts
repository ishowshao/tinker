import { readPromptHistory, appendPromptHistory } from "./prompt-history";
import { loadProjectSlashCommands } from "../tui/project-slash-commands";
import { readCurrentGitBranch } from "../tui/git-branch";
import { listMemoryFiles } from "../memory/memory-files";
import path from "node:path";
import { realpath } from "node:fs/promises";
import type { HostedSession } from "../agent/runtime-hosted-session";
import { requireObject, requireText, RemoteError } from "./protocol";
import { IMAGE_INPUT_POLICY } from "../image/image-input-policy";
import { validateImageAssetRef, type ImageAssetRef } from "../image/image-types";
import { encodeFailure } from "./failures";
import { createWorkspaceFileLister } from "../tui/workspace-file-search";
import { loadViewFile } from "../tui/view-file";
import { readLastAssistantResponse } from "../session/session-last-response-reader";

export async function sessionPost(
  session: HostedSession,
  route: string,
  request: Request,
  homeRoot?: string,
): Promise<Response | undefined> {
  if (!["images", "verify-images", "prompt-history"].includes(route)) return undefined;
  try {
    if (route === "prompt-history") {
      await appendPromptHistory(
        request,
        session.tuiSnapshot().history.workspaceRoot,
        homeRoot,
      );
      return Response.json({ saved: true });
    }
    const input = requireObject(await request.json());
    const value = await session.exclusive(async (runtime) => {
      if (route === "verify-images") {
        if (
          !Array.isArray(input.assets) ||
          input.assets.length > IMAGE_INPUT_POLICY.maxImagesPerMessage
        )
          throw new Error("Invalid image asset list.");
        for (const asset of input.assets) validateImageAssetRef(asset as ImageAssetRef);
        await runtime.verifyImageAssets(
          input.assets as ImageAssetRef[],
          request.signal,
        );
        return { verified: true };
      }
      const count = input.count;
      if (
        typeof count !== "number" ||
        !Number.isInteger(count) ||
        count < 1 ||
        count > IMAGE_INPUT_POLICY.maxImagesPerMessage
      )
        throw new Error("Invalid image count.");
      if (input.sourcePath !== undefined) {
        const source = requireText(input.sourcePath, "sourcePath", 4096);
        if (path.isAbsolute(source))
          throw new Error("Workspace image paths must be relative.");
        return runtime.importImage(source, request.signal, count);
      }
      const encoded = requireText(
        input.bytes,
        "bytes",
        Math.ceil(IMAGE_INPUT_POLICY.maxBytesPerImage / 3) * 4,
      );
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0)
        throw new Error("Invalid base64 image.");
      return runtime.importImageBytes(
        Buffer.from(encoded, "base64"),
        requireText(input.originalName, "originalName", 255),
        request.signal,
        count,
      );
    });
    return Response.json(value, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      {
        error: { message: error instanceof Error ? error.message : String(error) },
        failure: encodeFailure(error),
      },
      { status: error instanceof RemoteError ? error.status : 422 },
    );
  }
}
export async function sessionRead(
  session: HostedSession,
  route: string,
  url: URL,
  signal: AbortSignal,
  homeRoot?: string,
): Promise<unknown> {
  const snapshot = session.tuiSnapshot();
  const workspaceRoot = snapshot.history.workspaceRoot;
  if (route === "prompt-history") return readPromptHistory(workspaceRoot, homeRoot);
  if (route === "project-commands") return loadProjectSlashCommands(workspaceRoot);
  if (route === "git-branch")
    return { branch: await readCurrentGitBranch(workspaceRoot) };
  if (route === "memories") return listMemoryFiles(homeRoot);
  if (route === "files") return createWorkspaceFileLister()(workspaceRoot, signal);
  if (route === "last-response")
    return {
      text: await readLastAssistantResponse({
        workspaceRoot,
        sessionId: session.id,
        homeRoot,
      }),
    };
  if (route === "view-file") {
    const requested = requireText(url.searchParams.get("path"), "path", 4096);
    const actual = await realpath(path.resolve(workspaceRoot, requested));
    const relative = path.relative(workspaceRoot, actual);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw new RemoteError(
        403,
        "OUTSIDE_WORKSPACE",
        "File is outside this workspace.",
      );
    return loadViewFile(workspaceRoot, relative);
  }
  throw new RemoteError(404, "NOT_FOUND", "Unknown session read route.");
}
