export const PROTOCOL_VERSION = 1 as const;
export const MAX_FRAME_BYTES = 1024 * 1024;

export const NATIVE_HOST_NAME = "com.tinker.chrome";
export const EXTENSION_ID = "bakgbafndlkajmiifhlndicifmhdchpn";
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`;
export const EXTENSION_PUBLIC_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqGlL8D8gqoSvijoMlAxM7qGSO4g5VzVK6/+ulZBkaOe5hgCAmRkSktS4bUGTWEc6xv6HOT33qCzrhjEQTkUcS5XnPfY94M2kFwVFV5uEwQEElPuOLRuFlWbBnklp19y9l4v7KtBSWNR8p5Erpo0JVsuhyp1PaOauwstcf/oIDR6+YAx9bVe6Llo9k+sCFu54f5wd+QKNDX9bBCIrV4muRQjMqgNW5hF6EOq/XEhUyA8GpCkpqf9uP4luxWhWrv24uRZ/kvAGgWIToMWyYsF5v1yj6Ko/vsbj3yrltK+MlbD8B2R8OvK5h0M1zQi2w241kwTCBWWrh/DwVfwxltsufwIDAQAB";

export const PLUGIN_VERSION = "0.1.0";
export const PLUGIN_CAPABILITIES = ["page.open", "page.summary"] as const;

export const PLUGIN_HELLO_TIMEOUT_MS = 5_000;
export const RPC_HEARTBEAT_INTERVAL_MS = 15_000;
export const RPC_HEARTBEAT_TIMEOUT_MS = 45_000;
export const OPEN_PAGE_TIMEOUT_MS = 30_000;
export const PAGE_SUMMARY_TIMEOUT_MS = 10_000;

export const MAX_URL_CHARS = 8_192;
export const MAX_CONTENT_CODE_POINTS = 20_000;
export const MAX_DESCRIPTION_CODE_POINTS = 1_000;
export const MAX_HEADING_CODE_POINTS = 500;
export const MAX_HEADINGS = 40;
