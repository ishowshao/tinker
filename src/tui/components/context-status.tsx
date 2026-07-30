import { Box, Text } from "ink";
import type { BashGuardSnapshot } from "../../agent/runtime-session";
import type { TuiProjectionState } from "../event-store";
import { formatContextUsageLine, formatTokenCount } from "../context-format";

export function ContextStatus(props: {
  state: TuiProjectionState;
  bashGuard: BashGuardSnapshot;
}) {
  const usage = props.state.contextUsage;
  const profile = props.state.contextProfile;
  const budget = props.state.contextBudget;

  return (
    <Box flexDirection="column">
      <Text bold>Session</Text>
      <Text> id: {props.state.sessionId}</Text>
      <Text> model: {props.state.modelName}</Text>
      <Text> workspace: {props.state.workspaceRoot}</Text>
      <Text> </Text>
      <Text bold>Bash guard</Text>
      <Text>
        {" mode: "}
        {props.bashGuard.mode} (source: {props.bashGuard.source})
      </Text>
      <Text> </Text>
      <Text bold>Context</Text>
      {usage === undefined || profile === undefined || budget === undefined ? (
        <Text color="yellow"> measurement unavailable</Text>
      ) : (
        <>
          <Text> used: {formatContextUsageLine(usage).slice("context ".length)}</Text>
          <Text> pressure: {usage.pressure}</Text>
          <Text>
            {" trigger: "}
            {formatTokenCount(usage.triggerTokens)} ({usage.triggerRatio * 100}%)
          </Text>
          <Text> model window: {formatTokenCount(profile.contextWindowTokens)}</Text>
          <Text>
            {" request max output: "}
            {formatTokenCount(usage.requestMaxOutputTokens)}
          </Text>
          <Text>
            {" model max output: "}
            {formatTokenCount(profile.maxSupportedOutputTokens)}
          </Text>
          <Text> </Text>
          <Text bold>Measurement</Text>
          <Text> source: {formatSource(usage.source)}</Text>
          {usage.source === "estimated_full" ||
          usage.lastProviderUsage === undefined ? (
            <>
              <Text> provider anchor: not available</Text>
              {usage.rawFullEstimate === undefined ? null : (
                <>
                  <Text>
                    {" raw full: "}
                    {formatTokenCount(usage.rawFullEstimate.totalTokens)}
                  </Text>
                  <Text>
                    {" breakdown: kernel "}
                    {formatTokenCount(usage.rawFullEstimate.kernelTokens)}, user{" "}
                    {formatTokenCount(usage.rawFullEstimate.userTokens)}, assistant{" "}
                    {formatTokenCount(usage.rawFullEstimate.assistantTokens)}, tool{" "}
                    {formatTokenCount(usage.rawFullEstimate.toolTokens)}, schema{" "}
                    {formatTokenCount(usage.rawFullEstimate.toolSchemaTokens)}, protocol{" "}
                    {formatTokenCount(usage.rawFullEstimate.protocolTokens)}
                  </Text>
                </>
              )}
            </>
          ) : (
            <ProviderUsage usage={usage.lastProviderUsage} />
          )}
          <Text> </Text>
          <Text bold>Estimator</Text>
          <Text> correction factor: {formatFactor(usage.correctionFactor)}</Text>
          <Text> samples: {usage.calibrationSampleCount}/8</Text>
          {usage.rawDeltaTokens === undefined ? null : (
            <Text> raw pending delta: {formatTokenCount(usage.rawDeltaTokens)}</Text>
          )}
          {usage.guardedDeltaTokens === undefined ? null : (
            <Text>
              {" guarded pending delta: "}
              {formatTokenCount(usage.guardedDeltaTokens)}
            </Text>
          )}
          <Text> prefix: sha256:{shortHash(usage.prefixHash)}</Text>
        </>
      )}
    </Box>
  );
}

function ProviderUsage(props: {
  usage: NonNullable<TuiProjectionState["contextUsage"]>["lastProviderUsage"];
}) {
  const usage = props.usage;
  if (usage === undefined) {
    return null;
  }
  return (
    <>
      <Text> prompt: {formatTokenCount(usage.promptTokens)}</Text>
      <Text> completion: {formatTokenCount(usage.completionTokens)}</Text>
      <Text> total: {formatTokenCount(usage.totalTokens)}</Text>
      {usage.promptCacheHitTokens === undefined ? null : (
        <Text> cache hit: {formatTokenCount(usage.promptCacheHitTokens)}</Text>
      )}
      {usage.promptCacheMissTokens === undefined ? null : (
        <Text> cache miss: {formatTokenCount(usage.promptCacheMissTokens)}</Text>
      )}
      {usage.reasoningTokens === undefined ? null : (
        <Text> reasoning: {formatTokenCount(usage.reasoningTokens)}</Text>
      )}
    </>
  );
}

function formatSource(
  source: NonNullable<TuiProjectionState["contextUsage"]>["source"],
): string {
  if (source === "provider_measured") {
    return "provider measured";
  }
  return source === "measured_plus_estimated_delta"
    ? "measured + estimated delta"
    : "full estimated";
}

function formatFactor(value: number): string {
  return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function shortHash(value: string): string {
  return `${value.slice(0, 12)}${value.length > 12 ? "..." : ""}`;
}
