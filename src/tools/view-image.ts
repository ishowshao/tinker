import type { ImageAssetStore } from "../image/image-asset-store";
import { defineToolExecutor } from "./types";

export const VIEW_IMAGE_TOOL_DEFINITION = Object.freeze({
  name: "ViewImage",
  description:
    "View one local image and return it to the model. Supports PNG, JPEG, and WebP. " +
    "Relative paths resolve within the workspace; absolute paths may point outside it. " +
    "Symbolic links are not supported.",
  parameters: Object.freeze({
    type: "object",
    additionalProperties: false,
    properties: Object.freeze({
      file_path: Object.freeze({
        type: "string",
        description: "Workspace-relative path or absolute path to one image file.",
      }),
    }),
    required: Object.freeze(["file_path"]),
  }),
});

export function createViewImageToolExecutor(input: {
  imageAssetStore: ImageAssetStore;
}) {
  return defineToolExecutor("view_image", {
    definition: VIEW_IMAGE_TOOL_DEFINITION,
    async execute(args, _call, context) {
      context.signal.throwIfAborted();
      const parsed = parseArguments(args);
      if (!parsed.ok) {
        return {
          ok: false,
          filePath: parsed.filePath,
          error: parsed.error,
        };
      }
      try {
        const imported = await input.imageAssetStore.importFile(parsed.filePath, {
          signal: context.signal,
        });
        context.signal.throwIfAborted();
        return {
          ok: true,
          filePath: parsed.filePath,
          originalName: imported.originalName,
          asset: imported.asset,
        };
      } catch (error) {
        context.signal.throwIfAborted();
        return {
          ok: false,
          filePath: parsed.filePath,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}

function parseArguments(
  value: unknown,
):
  | { readonly ok: true; readonly filePath: string }
  | { readonly ok: false; readonly filePath: string; readonly error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      filePath: "",
      error: "Arguments must be an object containing only file_path.",
    };
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const filePath = typeof record.file_path === "string" ? record.file_path : "";
  if (
    keys.length !== 1 ||
    keys[0] !== "file_path" ||
    typeof record.file_path !== "string" ||
    record.file_path.trim() === ""
  ) {
    return {
      ok: false,
      filePath,
      error: "file_path must be the only argument and must be a non-empty string.",
    };
  }
  return { ok: true, filePath: record.file_path };
}
