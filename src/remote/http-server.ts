import type { ServerWebSocket } from "bun";
import { authenticateDevice, type RemoteServiceConfig } from "./config";
import {
  RemoteError,
  parseOperation,
  requireId,
  type RemoteCursor,
  type RemoteFrame,
} from "./protocol";
import { RemoteService } from "./service";
import type { HostedSession } from "../agent/runtime-hosted-session";

type SocketData = {
  session: HostedSession;
  cursor?: RemoteCursor;
  unsubscribe?: () => void;
  device: string;
};
const SOCKET_BUFFER_LIMIT = 2 * 1024 * 1024;

export function startRemoteHttpServer(
  service: RemoteService,
  config: RemoteServiceConfig,
) {
  const sockets = new Set<ServerWebSocket<SocketData>>();
  const server = Bun.serve<SocketData>({
    hostname: config.hostname,
    port: config.port,
    tls: {
      cert: Bun.file(config.tls.certFile),
      key: Bun.file(config.tls.keyFile),
    },
    maxRequestBodySize: 72 * 1024,
    idleTimeout: 30,
    async fetch(request, server) {
      try {
        // Native clients authenticate in headers. Browser-origin requests are not supported.
        if (request.headers.has("origin"))
          throw new RemoteError(
            403,
            "ORIGIN_REJECTED",
            "Browser origins are not enabled.",
          );
        const device = authenticateDevice(
          request.headers.get("authorization"),
          config.devices,
        );
        if (!device)
          throw new RemoteError(
            401,
            "AUTH_REQUIRED",
            "Pair this device with the Mac before connecting.",
          );
        const url = new URL(request.url);
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts[0] !== "v1")
          throw new RemoteError(404, "NOT_FOUND", "Unknown API version or route.");
        if (request.method === "GET" && url.pathname === "/v1/workspaces") {
          return json({
            version: 1,
            workspaces: service.workspaces.map(({ id, name }) => ({
              id,
              name,
            })),
          });
        }
        if (
          request.method === "GET" &&
          parts.length === 4 &&
          parts[1] === "workspaces" &&
          parts[3] === "sessions"
        ) {
          return json({
            sessions: await service.listSessions(requireId(parts[2], "workspaceId")),
          });
        }
        if (parts[1] === "operations") {
          if (request.method === "POST" && parts.length === 2) {
            if (!request.headers.get("content-type")?.startsWith("application/json"))
              throw new RemoteError(415, "JSON_REQUIRED", "Send application/json.");
            const input = parseOperation(await request.json());
            // Never use request.signal as a runtime cancellation signal.
            return json(await service.submit(input, device), 202);
          }
          if (request.method === "GET" && parts.length === 3)
            return json(service.store.get(requireId(parts[2], "requestId", true)));
        }
        if (request.method === "GET" && parts.length === 4 && parts[1] === "sessions") {
          const session = service.session(requireId(parts[2], "sessionId", true));
          await session.open();
          if (parts[3] === "snapshot") return json(session.hub.snapshot());
          if (parts[3] === "history") {
            return json(
              session.history(
                optionalInteger(
                  url.searchParams.get("before"),
                  1,
                  Number.MAX_SAFE_INTEGER,
                ),
                optionalInteger(url.searchParams.get("limit"), 1, 100),
              ),
            );
          }
          if (parts[3] === "events") {
            if (sockets.size >= 64)
              throw new RemoteError(
                429,
                "CONNECTION_LIMIT",
                "Too many connected clients.",
              );
            const epoch = url.searchParams.get("epoch");
            const sequence = optionalInteger(
              url.searchParams.get("after"),
              0,
              Number.MAX_SAFE_INTEGER,
            );
            const cursor =
              epoch && sequence !== undefined ? { epoch, sequence } : undefined;
            if (server.upgrade(request, { data: { session, cursor, device } })) return;
            throw new RemoteError(
              400,
              "WEBSOCKET_REQUIRED",
              "Upgrade this request to WebSocket.",
            );
          }
        }
        throw new RemoteError(404, "NOT_FOUND", "Unknown API route.");
      } catch (error) {
        if (error instanceof RemoteError)
          return json(
            { error: { code: error.code, message: error.message } },
            error.status,
          );
        if (error instanceof SyntaxError)
          return json(
            {
              error: {
                code: "INVALID_JSON",
                message: "Request body is not valid JSON.",
              },
            },
            400,
          );
        return json(
          {
            error: {
              code: "LOCAL_SERVICE_ERROR",
              message:
                error instanceof Error ? error.message : "The local operation failed.",
            },
          },
          500,
        );
      }
    },
    websocket: {
      maxPayloadLength: 1024,
      backpressureLimit: SOCKET_BUFFER_LIMIT,
      closeOnBackpressureLimit: true,
      idleTimeout: 60,
      sendPings: true,
      open(socket) {
        sockets.add(socket);
        const send = (frame: RemoteFrame) => {
          try {
            if (socket.getBufferedAmount() > SOCKET_BUFFER_LIMIT) {
              socket.close(1013, "Reconnect to resynchronize");
              return;
            }
            const text = JSON.stringify(frame);
            if (socket.send(text) === -1)
              socket.close(1013, "Reconnect to resynchronize");
          } catch {
            socket.close(1011, "Reconnect to resynchronize");
          }
        };
        socket.data.unsubscribe = socket.data.session.hub.subscribe(
          socket.data.cursor,
          send,
        );
      },
      message(socket) {
        socket.close(1008, "Submit operations over HTTPS");
      },
      close(socket) {
        sockets.delete(socket);
        socket.data.unsubscribe?.();
        // Detach only. The hosted runtime and its AbortController stay alive.
      },
    },
  });
  return {
    port: server.port!,
    async stopTransport() {
      for (const socket of sockets) {
        socket.data.unsubscribe?.();
        socket.terminate();
      }
      // Bun 1.3.14 can leave stop's promise pending after a closing TLS socket
      // is terminated. stop(true) synchronously closes the listener/connections;
      // bound its completion wait so runtime disposal can always proceed.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          server.stop(true),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 250);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
function optionalInteger(
  value: string | null,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === null) return undefined;
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < minimum ||
    Number(value) > maximum
  )
    throw new RemoteError(400, "INVALID_CURSOR", "Invalid history or event cursor.");
  return Number(value);
}
