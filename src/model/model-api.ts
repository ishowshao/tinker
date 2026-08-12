export const MODEL_APIS = ["chat-completions", "responses"] as const;

export type ModelApi = (typeof MODEL_APIS)[number];

export function parseModelApi(value: unknown, name: string): ModelApi {
  if (value === "chat-completions" || value === "responses") {
    return value;
  }
  throw new Error(
    `${name} must be one of ${MODEL_APIS.map((api) => JSON.stringify(api)).join(", ")}.`,
  );
}
