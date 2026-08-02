export const PROTOCOL_VERSION = 1 as const;
export const PROTOCOL_VERSION_V2 = 2 as const;
export const MAX_FRAME_BYTES = 1024 * 1024;

export const NATIVE_HOST_NAME = "com.tinker.chrome";
export const EXTENSION_ID = "bakgbafndlkajmiifhlndicifmhdchpn";
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`;
export const EXTENSION_PUBLIC_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqGlL8D8gqoSvijoMlAxM7qGSO4g5VzVK6/+ulZBkaOe5hgCAmRkSktS4bUGTWEc6xv6HOT33qCzrhjEQTkUcS5XnPfY94M2kFwVFV5uEwQEElPuOLRuFlWbBnklp19y9l4v7KtBSWNR8p5Erpo0JVsuhyp1PaOauwstcf/oIDR6+YAx9bVe6Llo9k+sCFu54f5wd+QKNDX9bBCIrV4muRQjMqgNW5hF6EOq/XEhUyA8GpCkpqf9uP4luxWhWrv24uRZ/kvAGgWIToMWyYsF5v1yj6Ko/vsbj3yrltK+MlbD8B2R8OvK5h0M1zQi2w241kwTCBWWrh/DwVfwxltsufwIDAQAB";

export const PLUGIN_VERSION = "0.4.0";
export const PLUGIN_CAPABILITIES = ["page.open", "page.summary"] as const;
export const PLUGIN_CAPABILITIES_V2 = [
  "page.open",
  "page.summary",
  "page.snapshot",
  "page.click",
  "page.fill",
  "page.press_key",
  "page.type_text",
  "page.wait_for",
  "page.scroll",
  "page.hover",
  "page.fill_form",
  "page.drag",
  "page.resize",
  "page.emulate",
  "page.upload_file",
  "page.list",
  "page.navigate",
  "page.close",
  "page.handle_dialog",
  "page.console.list",
  "page.console.get",
  "page.network.list",
  "page.network.get",
] as const;

export const PLUGIN_HELLO_TIMEOUT_MS = 5_000;
export const RPC_HEARTBEAT_INTERVAL_MS = 15_000;
export const RPC_HEARTBEAT_TIMEOUT_MS = 45_000;
export const OPEN_PAGE_TIMEOUT_MS = 30_000;
export const PAGE_SUMMARY_TIMEOUT_MS = 10_000;
export const PAGE_SNAPSHOT_TIMEOUT_MS = 15_000;
export const PAGE_ACTION_TIMEOUT_MS = 15_000;
export const PAGE_NAVIGATION_TIMEOUT_MS = 30_000;
export const PAGE_DEBUG_TIMEOUT_MS = 15_000;
export const PAGE_WAIT_DEFAULT_TIMEOUT_MS = 5_000;
export const PAGE_WAIT_MAX_TIMEOUT_MS = 30_000;

export const MAX_URL_CHARS = 8_192;
export const MAX_CONTENT_CODE_POINTS = 20_000;
export const MAX_DESCRIPTION_CODE_POINTS = 1_000;
export const MAX_HEADING_CODE_POINTS = 500;
export const MAX_HEADINGS = 40;
export const MAX_SNAPSHOT_CODE_POINTS = 32_000;
export const MAX_ACTION_TEXT_CODE_POINTS = 20_000;
export const MAX_WAIT_TEXTS = 20;
export const MAX_KEY_CHARS = 100;
export const MAX_SCROLL_AMOUNT = 10_000;
export const MAX_FORM_ELEMENTS = 100;
export const MAX_VIEWPORT_DIMENSION = 10_000;
export const MAX_DEVICE_SCALE_FACTOR = 10;
export const MAX_EXTRA_HTTP_HEADERS = 100;
export const MAX_HTTP_HEADER_NAME_CHARS = 200;
export const MAX_HTTP_HEADER_VALUE_CHARS = 8_192;
export const MAX_FILE_PATH_CHARS = 8_192;
export const MAX_OWNED_PAGES = 100;
export const DEBUG_LIST_DEFAULT_PAGE_SIZE = 50;
export const DEBUG_LIST_MAX_PAGE_SIZE = 200;
export const MAX_DEBUG_OUTPUT_CODE_POINTS = 32_000;
export const MAX_DEBUG_TEXT_CODE_POINTS = 10_000;
export const MAX_DEBUG_ITEMS_PER_NAVIGATION = 1_000;
export const MAX_DEBUG_NAVIGATIONS = 3;
export const MAX_DIALOG_TEXT_CODE_POINTS = 1_000;

export const CONSOLE_MESSAGE_TYPES = [
  "log",
  "debug",
  "info",
  "error",
  "warn",
  "dir",
  "dirxml",
  "table",
  "trace",
  "clear",
  "startGroup",
  "startGroupCollapsed",
  "endGroup",
  "assert",
  "profile",
  "profileEnd",
  "count",
  "timeEnd",
  "verbose",
] as const;

export const NETWORK_RESOURCE_TYPES = [
  "document",
  "stylesheet",
  "image",
  "media",
  "font",
  "script",
  "texttrack",
  "xhr",
  "fetch",
  "prefetch",
  "eventsource",
  "websocket",
  "manifest",
  "signedexchange",
  "ping",
  "cspviolationreport",
  "preflight",
  "fedcm",
  "other",
] as const;
