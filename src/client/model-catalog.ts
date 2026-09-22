import type { ModelProfile } from "../cli/model-profiles";

/** Display data only. Provider endpoints and credentials never cross the client boundary. */
export type ClientModelProfile = Pick<
  ModelProfile,
  "name" | "model" | "contextWindowTokens" | "maxSupportedOutputTokens"
>;
export type ClientModelCatalog = {
  defaultProfile: string;
  profiles: readonly ClientModelProfile[];
};
export type ClientModelProfiles = {
  defaultProfile: string;
  profiles: ReadonlyMap<string, ClientModelProfile>;
};
