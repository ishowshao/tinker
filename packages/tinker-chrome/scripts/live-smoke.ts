import process from "node:process";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repositoryRoot = path.resolve(import.meta.dir, "../../..");
const fixtureServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const pathname = new URL(request.url).pathname;
    return new Response(pathname === "/next" ? nextHtml() : fixtureHtml(), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
});
const fixtureUrl = `http://127.0.0.1:${fixtureServer.port}`;
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["packages/tinker-chrome/src/cli.ts", "mcp"],
  cwd: repositoryRoot,
  stderr: "pipe",
});
transport.stderr?.on("data", (chunk: unknown) => {
  if (typeof chunk === "string" || chunk instanceof Uint8Array) {
    process.stderr.write(chunk);
  }
});
const client = new Client({
  name: "tinker-chrome-live-smoke",
  version: "1.0.0",
});

try {
  await client.connect(transport);
  const tools = await client.listTools();
  if (tools.tools.length !== 10) {
    throw new Error(`Expected 10 Tinker Chrome tools; received ${tools.tools.length}.`);
  }

  const opened = await openPageWhenConnected(fixtureUrl);
  const pageId = opened.match(/^pageId=([\w-]+)$/m)?.[1];
  if (pageId === undefined) {
    throw new Error(`open_page returned no pageId.\n${opened}`);
  }
  const summary = await callTool("get_page_summary", { pageId });
  requireIncludes(summary, "title=Tinker Chrome Live Fixture", "page summary");

  const firstSnapshot = await callTool("take_snapshot", { pageId });
  const secondSnapshot = await callTool("take_snapshot", { pageId });
  const nameUid = uidFor(firstSnapshot, "Name");
  const showUid = uidFor(firstSnapshot, "Show success");
  const hoverUid = uidFor(firstSnapshot, "Hover target");
  const nextUid = uidFor(firstSnapshot, "Go next");
  if (uidFor(secondSnapshot, "Name") !== nameUid) {
    throw new Error("Stable UID was not reused across snapshots.");
  }

  await callTool("fill", { pageId, uid: nameUid, value: "alpha" });
  await callTool("type_text", { pageId, text: "beta" });
  await callTool("press_key", { pageId, key: "Enter" });
  await callTool("wait_for", {
    pageId,
    text: ["Submitted: alphabeta"],
    timeoutMs: 3_000,
  });

  await callTool("click", { pageId, uid: showUid });
  await callTool("wait_for", {
    pageId,
    text: ["Ready signal"],
    timeoutMs: 3_000,
  });
  await callTool("hover", { pageId, uid: hoverUid });
  await callTool("wait_for", {
    pageId,
    text: ["Hovered signal"],
    timeoutMs: 3_000,
  });
  await callTool("scroll", { pageId, direction: "down", amount: 700 });
  await callTool("wait_for", {
    pageId,
    text: ["Scrolled signal"],
    timeoutMs: 3_000,
  });

  const afterActions = await callTool("take_snapshot", {
    pageId,
    verbose: true,
  });
  if (uidFor(afterActions, "Name") !== nameUid) {
    throw new Error("Stable UID changed after non-navigation actions.");
  }

  const navigation = await callTool("click", { pageId, uid: nextUid });
  requireIncludes(navigation, `navigatedToUrl=${fixtureUrl}/next`, "navigation result");
  const stale = await client.callTool({
    name: "click",
    arguments: { pageId, uid: showUid },
  });
  const staleText = textOf(stale);
  if (!stale.isError || !staleText.includes("code=SNAPSHOT_REQUIRED")) {
    throw new Error(`Old UID was not invalidated after navigation.\n${staleText}`);
  }
  const nextSnapshot = await callTool("take_snapshot", { pageId });
  requireIncludes(nextSnapshot, "Navigation complete", "new page snapshot");

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        tools: tools.tools.map((tool) => tool.name),
        pageId,
        stableUid: nameUid,
        navigationInvalidation: "SNAPSHOT_REQUIRED",
        finalUrl: `${fixtureUrl}/next`,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await client.close().catch(() => undefined);
  await fixtureServer.stop(true);
}

async function openPageWhenConnected(url: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await client.callTool({
      name: "open_page",
      arguments: { url },
    });
    const text = textOf(result);
    if (!result.isError) {
      return text;
    }
    if (!text.includes("code=PLUGIN_NOT_CONNECTED")) {
      throw new Error(`open_page failed.\n${text}`);
    }
    await Bun.sleep(250);
  }
  throw new Error("Tinker Chrome did not connect to the live MCP runtime.");
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  const text = textOf(result);
  if (result.isError) {
    throw new Error(`${name} failed.\n${text}`);
  }
  return text;
}

function textOf(result: unknown): string {
  if (
    typeof result !== "object" ||
    result === null ||
    !("content" in result) ||
    !Array.isArray(result.content)
  ) {
    throw new Error("MCP tool result has no content array.");
  }
  return result.content
    .flatMap((item: unknown): string[] => {
      if (
        typeof item === "object" &&
        item !== null &&
        "type" in item &&
        item.type === "text" &&
        "text" in item &&
        typeof item.text === "string"
      ) {
        return [item.text];
      }
      return [];
    })
    .join("\n");
}

function uidFor(snapshot: string, name: string): string {
  const line = snapshot
    .split("\n")
    .find((candidate) => candidate.includes(`"${name}"`));
  const uid = line?.match(/\buid=([^\s]+)/)?.[1];
  if (uid === undefined) {
    throw new Error(`No UID found for ${name}.\n${snapshot}`);
  }
  return uid;
}

function requireIncludes(value: string, expected: string, label: string): void {
  if (!value.includes(expected)) {
    throw new Error(`${label} did not contain ${expected}.\n${value}`);
  }
}

function fixtureHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Tinker Chrome Live Fixture</title>
  </head>
  <body>
    <h1>Chrome interaction fixture</h1>
    <label>Name <input id="name" aria-label="Name"></label>
    <button id="show">Show success</button>
    <div id="hover" role="button" tabindex="0">Hover target</div>
    <p id="status" aria-live="polite">Idle</p>
    <div style="height: 1800px"></div>
    <a href="/next">Go next</a>
    <script>
      const nameInput = document.getElementById("name");
      const status = document.getElementById("status");
      document.getElementById("show").addEventListener("click", () => {
        setTimeout(() => { status.textContent = "Ready signal"; }, 150);
      });
      document.getElementById("hover").addEventListener("mouseenter", () => {
        status.textContent = "Hovered signal";
      });
      nameInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") status.textContent = "Submitted: " + nameInput.value;
      });
      addEventListener("scroll", () => { status.textContent = "Scrolled signal"; }, { once: true });
    </script>
  </body>
</html>`;
}

function nextHtml(): string {
  return '<!doctype html><html lang="en"><title>Next fixture</title><h1>Navigation complete</h1></html>';
}
