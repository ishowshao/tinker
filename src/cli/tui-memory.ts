import {
  boundedMemoryError,
  memoryErrorCode,
  type MemoryPaths,
} from "../memory/contracts";
import { MemoryCoordinator } from "../memory/memory-coordinator";
import { MemoryLog } from "../memory/memory-log";
import { resolveMemoryPaths } from "../memory/memory-store";
import type { ResolvedMemoryConfig } from "./config";
import { createModelClient } from "./runner-dependencies";

export type TuiMemoryInitialization = {
  readonly coordinator?: MemoryCoordinator;
  readonly notice?: string;
};

export async function initializeTuiMemory(input: {
  readonly config?: ResolvedMemoryConfig;
  readonly env: NodeJS.ProcessEnv;
  readonly paths?: MemoryPaths;
  readonly createCoordinator?: typeof MemoryCoordinator.create;
}): Promise<TuiMemoryInitialization> {
  if (input.config === undefined) {
    return Object.freeze({});
  }

  const paths = input.paths ?? resolveMemoryPaths();
  const log = new MemoryLog(paths.log);
  try {
    const memoryConfig = input.config;
    const coordinator = await (input.createCoordinator ?? MemoryCoordinator.create)({
      paths,
      embedding: memoryConfig.embedding,
      extractionContextBudget: memoryConfig.contextBudget,
      createExtractionClient: () => {
        const profile = memoryConfig.profile;
        return createModelClient(
          {
            modelName: profile.model,
            api: profile.api,
            apiKey: profile.apiKey,
            apiBase: profile.apiBase,
            ...(profile.reasoning === undefined
              ? {}
              : { reasoning: profile.reasoning }),
            includeReasoningContent: profile.includeReasoningContent,
            stream: profile.stream,
            contextBudget: memoryConfig.contextBudget,
            inputModalities: profile.inputModalities,
            toolResultModalities: profile.toolResultModalities,
          },
          input.env,
        );
      },
    });
    return Object.freeze({ coordinator });
  } catch (error) {
    const reason = memoryErrorCode(error, "memory_init_failed");
    await log.append({
      at: new Date().toISOString(),
      kind: "init",
      outcome: "failed",
      reason,
    });
    return Object.freeze({
      notice: `memory disabled: ${boundedMemoryError(error)}`,
    });
  }
}
