import type { ToolCall } from "../../agent/types";
import { createDefaultTooling as createDefaultToolingBase } from "../../tools/registry";
import { type ToolExecutionContext } from "../../tools/types";
import {
  createTestHistoryReader,
  createTestRuntime,
  type TestToolCallInput,
} from "../test-runtime";

export const testToolContext: ToolExecutionContext = {
  signal: new AbortController().signal,
};

export function createDefaultTooling(
  options: Omit<
    Parameters<typeof createDefaultToolingBase>[0],
    "runtimeSession" | "historyReader"
  >,
) {
  const testRuntime = createTestRuntime();
  const tooling = createDefaultToolingBase({
    ...options,
    runtimeSession: testRuntime.runtimeSession,
    historyReader: createTestHistoryReader(testRuntime.runtimeSession.sessionId),
  });
  return {
    ...tooling,
    runtime: {
      execute: (
        call: TestToolCallInput | ToolCall,
        context: ToolExecutionContext = testToolContext,
      ) =>
        tooling.runtime.execute(
          "sessionId" in call ? call : testRuntime.toolCall(call),
          context,
        ),
    },
    testRuntime,
  };
}
