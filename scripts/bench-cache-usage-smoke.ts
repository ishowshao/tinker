/**
 * Cache-usage smoke probe: for each model profile, send two sequential
 * requests sharing a stable long prefix, then print the raw `usage`
 * objects so we can verify which cache-hit fields each provider returns.
 *
 * Usage: bun scripts/bench-cache-usage-smoke.ts [profile ...]
 * Defaults to all profiles in .tinker/models.json.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

type Profile = {
  model: string;
  apiBase: string;
  apiKey: string;
};

const modelsPath = path.join(process.cwd(), ".tinker", "models.json");
const config = JSON.parse(readFileSync(modelsPath, "utf8")) as {
  profiles: Record<string, Profile>;
};

const requested = process.argv.slice(2);
const profileNames = (
  requested.length > 0 ? requested : Object.keys(config.profiles)
).filter((name) => name !== "kimi-for-coding" || requested.includes(name));

// A deterministic, fairly long system prompt so every provider's cache
// threshold is comfortably exceeded (DeepSeek >=1024, GLM ~512, Kimi >256).
const SYSTEM_PROMPT = [
  "You are a cache-probe assistant. The following reference text exists only",
  "to create a long, stable prompt prefix. Answer user questions tersely.",
  Array.from(
    { length: 120 },
    (_, i) =>
      `Rule ${i + 1}: the archive of tinker ${"lore ".repeat(8)}section ${i + 1}.`,
  ).join("\n"),
].join("\n\n");

const USER_ONE = "Reply with exactly: one";
const USER_TWO = "Reply with exactly: two";

async function chat(
  profile: Profile,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${profile.apiBase}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${profile.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

async function chatStreamUsage(
  profile: Profile,
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`${profile.apiBase}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${profile.apiKey}`,
    },
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  const text = await response.text();
  let usage: unknown;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    const chunk = JSON.parse(line.slice(6)) as { usage?: unknown };
    if (chunk.usage !== undefined && chunk.usage !== null) {
      usage = chunk.usage;
    }
  }
  return usage;
}

function baseMessages(): Record<string, unknown>[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: USER_ONE },
  ];
}

async function probe(name: string, profile: Profile): Promise<void> {
  console.log(`\n=== ${name} (${profile.apiBase}, model=${profile.model}) ===`);

  const extra: Record<string, unknown> = {};
  if (name === "k3") {
    // Moonshot sticky-routing hint; keep stable across the two requests.
    extra.prompt_cache_key = "tinker-cache-probe-0001";
  }

  // Round 1: seeds the cache.
  const first = await chat(profile, {
    model: profile.model,
    messages: baseMessages(),
    ...extra,
  });
  console.log("round1 usage:", JSON.stringify(first.usage));

  const assistantOne = (first.choices as { message: Record<string, unknown> }[])[0]
    .message;
  const replayAssistant: Record<string, unknown> = {
    role: "assistant",
    content: assistantOne.content ?? "",
  };

  // Round 2: identical prefix + appended turn -> should hit the cache.
  const second = await chat(profile, {
    model: profile.model,
    messages: [...baseMessages(), replayAssistant, { role: "user", content: USER_TWO }],
    ...extra,
  });
  console.log("round2 usage:", JSON.stringify(second.usage));

  // Round 3: streaming, verify usage arrives in the final chunk.
  const streamUsage = await chatStreamUsage(profile, {
    model: profile.model,
    messages: [
      ...baseMessages(),
      replayAssistant,
      { role: "assistant", content: "two" },
      { role: "user", content: "Reply with exactly: three" },
    ],
    stream_options: { include_usage: true },
    ...extra,
  });
  console.log("stream usage:", JSON.stringify(streamUsage));
}

for (const name of profileNames) {
  const profile = config.profiles[name];
  if (!profile) {
    console.log(`profile not found: ${name}`);
    continue;
  }
  try {
    await probe(name, profile);
  } catch (error) {
    console.log(`\n=== ${name} FAILED ===`);
    console.log(error instanceof Error ? error.message : String(error));
  }
}
