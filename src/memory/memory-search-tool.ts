import { createGrepToolExecutor, type GrepToolOptions } from "../tools/grep";
import { type ToolExecutor } from "../tools/types";
import { ensureMemoryDirectory, memoryDirectory } from "./memory-files";

export function createMemorySearchToolExecutor(
  options: GrepToolOptions & { homeRoot?: string },
): ToolExecutor {
  const grep = createGrepToolExecutor(options);
  const properties = {
    ...(grep.definition.parameters.properties as Record<string, unknown>),
  };
  delete properties.path;
  return {
    ...grep,
    definition: {
      ...grep.definition,
      name: "MemorySearch",
      description: `Search historical session records and explicitly saved notes across workspaces. Use proactively when earlier decisions, preferences, or work may help. This is Grep with its path fixed to ${memoryDirectory(options.homeRoot)}. Read returned paths to see complete records. ${grep.definition.description}`,
      parameters: { ...grep.definition.parameters, properties },
    },
    async execute(args, call, context) {
      const directory = await ensureMemoryDirectory(options.homeRoot);
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        return grep.execute(args, call, context);
      }
      return grep.execute({ ...args, path: directory }, call, context);
    },
  };
}
