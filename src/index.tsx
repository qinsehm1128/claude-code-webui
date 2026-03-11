import { serve } from "bun";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ClientEvent, ServerEvent } from "./types";
import { runClaude, type RunnerHandle } from "./libs/runner";
import { SessionStore } from "./libs/session-store";
import "./claude-settings";
import { dirname, extname, join, resolve, sep } from "path";
import { networkInterfaces } from "os";
import { generateSessionTitle } from "./libs/util";
import { existsSync } from "fs";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const distDir = resolve(rootDir, "dist");
const distIndex = resolve(distDir, "index.html");
const useDist = process.env.CLAUDE_CODE_WEBUI_USE_DIST !== "0" && existsSync(distIndex);
const distPrefix = distDir + sep;
const devIndex = useDist ? null : (await import("./index.html")).default;
const indexFile = useDist ? Bun.file(distIndex) : devIndex;
const indexRoutes = {
  "/": indexFile,
  "/index.html": indexFile
};
const staticContentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp"
};

const PORT = Number(process.env.PORT ?? 10086);
const DB_PATH = process.env.DB_PATH ?? join(process.cwd(), "webui.db");
const rawCorsOrigin = process.env.CORS_ORIGIN ?? "*";
const corsOrigins = rawCorsOrigin.split(",").map((origin) => origin.trim()).filter(Boolean);
const corsOrigin = corsOrigins.length === 1 ? corsOrigins[0] : corsOrigins;
const sessions = new SessionStore(DB_PATH);
const clients = new Set<unknown>();
const runnerHandles = new Map<string, RunnerHandle>();

function broadcast(event: ServerEvent) {
  const payload = JSON.stringify(event);
  for (const client of clients) {
    const ws = client as { readyState: number; send: (data: string) => void };
    if (ws.readyState === 1) { // WebSocket.OPEN = 1
      ws.send(payload);
    }
  }
}

function emit(event: ServerEvent) {
  if (event.type === "session.status") {
    sessions.updateSession(event.payload.sessionId, { status: event.payload.status });
  }
  if (event.type === "stream.message") {
    sessions.recordMessage(event.payload.sessionId, event.payload.message);
  }
  if (event.type === "stream.user_prompt") {
    sessions.recordMessage(event.payload.sessionId, {
      type: "user_prompt",
      prompt: event.payload.prompt
    });
  }
  broadcast(event);
}

function handleClientEvent(event: ClientEvent) {
  if (event.type === "session.list") {
    emit({
      type: "session.list",
      payload: { sessions: sessions.listSessions() }
    });
    return;
  }

  if (event.type === "session.history") {
    const history = sessions.getSessionHistory(event.payload.sessionId);
    if (!history) {
      emit({
        type: "runner.error",
        payload: { message: "Unknown session" }
      });
      return;
    }
    emit({
      type: "session.history",
      payload: {
        sessionId: history.session.id,
        status: history.session.status,
        messages: history.messages
      }
    });
    return;
  }

  if (event.type === "session.start") {
    const session = sessions.createSession({
      cwd: event.payload.cwd,
      title: event.payload.title,
      allowedTools: event.payload.allowedTools,
      prompt: event.payload.prompt
    });

    sessions.updateSession(session.id, {
      status: "running",
      lastPrompt: event.payload.prompt
    });
    emit({
      type: "session.status",
      payload: { sessionId: session.id, status: "running", title: session.title, cwd: session.cwd }
    });

    emit({
      type: "stream.user_prompt",
      payload: { sessionId: session.id, prompt: event.payload.prompt }
    });

    runClaude({
      prompt: event.payload.prompt,
      session,
      onEvent: emit,
      onSessionUpdate: (updates) => {
        sessions.updateSession(session.id, updates);
      }
    })
      .then((handle) => {
        runnerHandles.set(session.id, handle);
        sessions.setAbortController(session.id, undefined);
      })
      .catch((error) => {
        sessions.updateSession(session.id, { status: "error" });
        emit({
          type: "session.status",
          payload: {
            sessionId: session.id,
            status: "error",
            title: session.title,
            cwd: session.cwd,
            error: String(error)
          }
        });
      });

    return;
  }

  if (event.type === "session.continue") {
    const session = sessions.getSession(event.payload.sessionId);
    if (!session) {
      emit({
        type: "runner.error",
        payload: { message: "Unknown session" }
      });
      return;
    }

    sessions.updateSession(session.id, { status: "running", lastPrompt: event.payload.prompt });
    emit({
      type: "session.status",
      payload: { sessionId: session.id, status: "running", title: session.title, cwd: session.cwd }
    });

    emit({
      type: "stream.user_prompt",
      payload: { sessionId: session.id, prompt: event.payload.prompt }
    });

    // Use claudeSessionId for resume if available, otherwise start fresh
    runClaude({
      prompt: event.payload.prompt,
      session,
      resumeSessionId: session.claudeSessionId,
      onEvent: emit,
      onSessionUpdate: (updates) => {
        sessions.updateSession(session.id, updates);
      }
    })
      .then((handle) => {
        runnerHandles.set(session.id, handle);
      })
      .catch((error) => {
        sessions.updateSession(session.id, { status: "error" });
        emit({
          type: "session.status",
          payload: {
            sessionId: session.id,
            status: "error",
            title: session.title,
            cwd: session.cwd,
            error: String(error)
          }
        });
      });

    return;
  }

  if (event.type === "session.stop") {
    const session = sessions.getSession(event.payload.sessionId);
    if (!session) return;

    const handle = runnerHandles.get(session.id);
    if (handle) {
      handle.abort();
      runnerHandles.delete(session.id);
    }

    sessions.updateSession(session.id, { status: "idle" });
    emit({
      type: "session.status",
      payload: { sessionId: session.id, status: "idle", title: session.title, cwd: session.cwd }
    });
    return;
  }

  if (event.type === "session.delete") {
    const sessionId = event.payload.sessionId;
    const handle = runnerHandles.get(sessionId);
    if (handle) {
      handle.abort();
      runnerHandles.delete(sessionId);
    }

    const deleted = sessions.deleteSession(sessionId);
    if (!deleted) {
      emit({
        type: "runner.error",
        payload: { message: "Unknown session" }
      });
      return;
    }
    emit({
      type: "session.deleted",
      payload: { sessionId }
    });
    return;
  }

  if (event.type === "permission.response") {
    const session = sessions.getSession(event.payload.sessionId);
    if (!session) return;

    const pending = session.pendingPermissions.get(event.payload.toolUseId);
    if (pending) {
      pending.resolve(event.payload.result);
    }
    return;
  }
}

const app = new Hono();

app.use("*", cors({
  origin: corsOrigin,
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
  credentials: corsOrigin !== "*",
}));

app.get("/api/health", c =>
  c.text("ok")
);

app.get("/api/sessions/recent-cwd", async (c) => {
  const limitParam = c.req.query("limit");
  const limit = limitParam ? Number(limitParam) : 8;
  const boundedLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 20) : 8;
  const cwds = sessions.listRecentCwds(boundedLimit);
  return c.json({ cwds });
})

app.get("/api/sessions/title", async (c) => {
  const userInput = c.req.query("userInput") || null;
  const title = await generateSessionTitle(userInput);
  return c.json({ title });
})

const server = serve({
  port: PORT,
  hostname: "0.0.0.0",
  routes: indexRoutes,
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/ws" && server.upgrade(req)) {
      return;
    }
    if (url.pathname.startsWith("/api")) {
      return app.fetch(req);
    }
    if (req.method === "GET") {
      if (useDist) {
        const filePath = resolve(distDir, "." + url.pathname);
        if (filePath === distDir || filePath.startsWith(distPrefix)) {
          const file = Bun.file(filePath);
          if (await file.exists()) {
            const contentType = staticContentTypes[extname(filePath)];
            if (contentType) {
              return new Response(file, {
                headers: {
                  "Content-Type": contentType
                }
              });
            }
            return file;
          }
        }
      }
    }
    return app.fetch(req);
  },
  websocket: {
    open(ws) {
      clients.add(ws);
    },
    close(ws) {
      clients.delete(ws);
    },
    message(_, message) {
      try {
        const parsed = JSON.parse(String(message)) as ClientEvent;
        handleClientEvent(parsed);
      } catch (error) {
        emit({
          type: "runner.error",
          payload: { message: `Invalid message: ${String(error)}` }
        });
      }
    }
  },
  development: process.env.NODE_ENV !== "production" && {
    // Enable browser hot reloading in development
    hmr: true,

    // Echo console logs from the browser to the server
    console: true,
  },
});

const serverUrl = new URL(server.url);
const port = serverUrl.port || String(PORT);
const localAddresses = new Set<string>(["127.0.0.1"]);
const nets = networkInterfaces();
for (const netInterfaces of Object.values(nets)) {
  for (const net of netInterfaces ?? []) {
    if (net.family === "IPv4" && !net.internal) {
      localAddresses.add(net.address);
    }
  }
}

console.log("🚀 Server running at:");
for (const address of localAddresses) {
  console.log(`  http://${address}:${port}/`);
}
