export const TOKEN_K = 1_024;
export const PRODUCT_MAX_OUTPUT_TOKENS = 128 * TOKEN_K;
export const CONTEXT_PRESSURE_TRIGGER_RATIO = 0.8 as const;

export type ModelContextProfile = {
  contextWindowTokens: number;
  maxSupportedOutputTokens: number;
};

export type ModelContextBudget = ModelContextProfile & {
  requestMaxOutputTokens: number;
  inputBudgetTokens: number;
  triggerRatio: typeof CONTEXT_PRESSURE_TRIGGER_RATIO;
  triggerTokens: number;
};

export function readModelContextProfileFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ModelContextProfile {
  return createModelContextProfile({
    contextWindowTokens: parseRequiredTokenCount(
      env.TINKER_CONTEXT_WINDOW_TOKENS,
      "TINKER_CONTEXT_WINDOW_TOKENS",
    ),
    maxSupportedOutputTokens: parseRequiredTokenCount(
      env.TINKER_MAX_SUPPORTED_OUTPUT_TOKENS,
      "TINKER_MAX_SUPPORTED_OUTPUT_TOKENS",
    ),
  });
}

export function createModelContextProfile(
  input: ModelContextProfile,
): ModelContextProfile {
  requirePositiveSafeInteger(
    input.contextWindowTokens,
    "contextWindowTokens",
    input.contextWindowTokens,
  );
  requirePositiveSafeInteger(
    input.maxSupportedOutputTokens,
    "maxSupportedOutputTokens",
    input.maxSupportedOutputTokens,
  );
  if (input.maxSupportedOutputTokens > input.contextWindowTokens) {
    throw new Error(
      `maxSupportedOutputTokens must not exceed contextWindowTokens; received ${input.maxSupportedOutputTokens} > ${input.contextWindowTokens}.`,
    );
  }

  return { ...input };
}

export function deriveModelContextBudget(
  profileInput: ModelContextProfile,
): ModelContextBudget {
  const profile = createModelContextProfile(profileInput);
  const requestMaxOutputTokens = Math.min(
    PRODUCT_MAX_OUTPUT_TOKENS,
    profile.maxSupportedOutputTokens,
  );
  if (requestMaxOutputTokens >= profile.contextWindowTokens) {
    throw new Error(
      `Derived requestMaxOutputTokens must be smaller than contextWindowTokens; received ${requestMaxOutputTokens} >= ${profile.contextWindowTokens}.`,
    );
  }

  const inputBudgetTokens = profile.contextWindowTokens - requestMaxOutputTokens;
  if (inputBudgetTokens <= 0) {
    throw new Error(
      `Derived inputBudgetTokens must be positive; received ${inputBudgetTokens}.`,
    );
  }

  const triggerTokens = Math.floor(inputBudgetTokens * CONTEXT_PRESSURE_TRIGGER_RATIO);
  if (triggerTokens <= 0 || triggerTokens >= inputBudgetTokens) {
    throw new Error(
      `Derived triggerTokens must be between 0 and inputBudgetTokens; received ${triggerTokens} for budget ${inputBudgetTokens}.`,
    );
  }

  return {
    ...profile,
    requestMaxOutputTokens,
    inputBudgetTokens,
    triggerRatio: CONTEXT_PRESSURE_TRIGGER_RATIO,
    triggerTokens,
  };
}

export function assertMatchingContextBudget(
  profile: ModelContextProfile,
  budget: ModelContextBudget,
): void {
  const expected = deriveModelContextBudget(profile);
  for (const key of Object.keys(expected) as Array<keyof ModelContextBudget>) {
    if (budget[key] !== expected[key]) {
      throw new Error(
        `Model context budget ${key} must be ${expected[key]}; received ${budget[key]}.`,
      );
    }
  }
}

function parseRequiredTokenCount(value: string | undefined, name: string): number {
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required; received ${displayValue(value)}.`);
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(
      `${name} must be a positive safe integer token count; received ${displayValue(value)}.`,
    );
  }

  const parsed = Number(value);
  requirePositiveSafeInteger(parsed, name, value);
  return parsed;
}

function requirePositiveSafeInteger(
  value: number,
  name: string,
  received: unknown,
): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `${name} must be a positive safe integer token count; received ${displayValue(received)}.`,
    );
  }
}

function displayValue(value: unknown): string {
  return value === undefined ? "undefined" : JSON.stringify(value);
}
