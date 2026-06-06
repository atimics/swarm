/**
 * Tests for local server route handlers.
 */
import { describe, expect, it, beforeAll } from "bun:test";
import { injectTestClients } from "../../admin-api/src/handlers/__test-helpers__/inject-clients.js";
import express from "express";

// ── Request simulator ─────────────────────────────────────────────────
function hitRoute(app: express.Express, method: string, path: string, body?: unknown) {
  return new Promise<{ status: number; body: unknown }>((resolve) => {
    const done = (s: number, d: unknown) => resolve({ status: s, body: d });
    const res: any = {
      _status: 200, statusCode: 200, _headers: {}, locals: {}, headersSent: false,
      status(c: number) { this._status = c; this.statusCode = c; return this; },
      json(d: unknown) { done(this._status, d); },
      send(d: unknown) { done(this._status, d); },
      end() { done(this._status, null); },
      set(k: string, v: string) { this._headers[k] = v; return this; },
      header(k: string, v: string) { this._headers[k] = v; return this; },
      setHeader(k: string, v: string) { this._headers[k.toLowerCase()] = v; },
      getHeader(k: string) { return this._headers[k.toLowerCase()]; },
      get() { return undefined; }, removeHeader() {},
    };
    const m = path.match(/^\/api\/avatars\/([^/]+)/);
    const req: any = {
      method: method.toUpperCase(), url: path, path, baseUrl: "",
      body, params: m ? { id: m[1] } : {}, query: {}, headers: {},
      get() { return undefined; }, app, res,
      _parsedUrl: { pathname: path, search: "", query: {} },
    };
    (app as any).handle(req, res, () => done(404, { error: "not found" }));
  });
}

// ── Pure contract tests ───────────────────────────────────────────────
function shapeChatResponse(r: Record<string, unknown>) {
  return {
    response: r.response, history: r.history, avatar: r.avatar,
    pendingToolCall: (r as any).pendingToolCall,
    taskActions: (r as any).taskActions,
    media: (r as any).media,
    pendingJobs: (r as any).pendingJobs,
    avatarUpdates: (r as any).avatarUpdates,
  };
}
function validateChatBody(b: { message?: string; history?: unknown[] }) {
  const { message, history = [] } = b;
  if (!message && !(history as unknown[]).length) return "message or history required";
  return null;
}

describe("chat response shaping", () => {
  it("forwards all fields including pendingToolCall", () => {
    const body = shapeChatResponse({
      response: "ok", history: [], avatar: { id: "a1" },
      pendingToolCall: { id: "tc-1", name: "configure_integration", arguments: { integration: "telegram" } },
      taskActions: [{ id: "ta-1" }], media: [{ type: "image", url: "x" }],
      pendingJobs: [{ jobId: "j1" }], avatarUpdates: { name: "X" },
    });
    expect(body.pendingToolCall).toBeDefined();
    expect(body.taskActions).toEqual([{ id: "ta-1" }]);
  });
  it("omits absent fields", () => {
    const body = shapeChatResponse({ response: "hi", history: [], avatar: null });
    expect(body.pendingToolCall).toBeUndefined();
  });
  it("rejects empty chat body", () => {
    expect(validateChatBody({})).toMatch(/message or history/);
    expect(validateChatBody({ message: "hi" })).toBeNull();
  });
});

// ── Import resolution tests — catch wrong/broken imports ─────────────
describe("admin-api import resolution", () => {
  beforeAll(async () => {
      await injectTestClients();
  });
  it("processChat is a function from chat.js", async () => {
    const { processChat } = await import("../../admin-api/src/handlers/chat.js");
    expect(typeof processChat).toBe("function");
  });
  it("resumeChatAfterToolResult is a function from chat.js (wrapper with 1 param)", async () => {
    const { resumeChatAfterToolResult } = await import("../../admin-api/src/handlers/chat.js");
    expect(typeof resumeChatAfterToolResult).toBe("function");
    expect(resumeChatAfterToolResult.length).toBe(1);
  });
  it("resumeChatAfterToolResult is a function from resume-chat.js (raw with 2 params)", async () => {
    const { resumeChatAfterToolResult } = await import("../../admin-api/src/handlers/chat-tools/resume-chat.js");
    expect(typeof resumeChatAfterToolResult).toBe("function");
    expect(resumeChatAfterToolResult.length).toBe(2);
  });
});

// ── Route surface + integration tests ─────────────────────────────────
const AID = "test-1";
const stubSvc = {
  secrets: { setSecret: async () => {}, flush: async () => {}, listSecrets: async () => [] as string[], getSecret: async () => "", deleteSecret: async () => {} },
};

describe("mountAdminRoutes integration", () => {
  beforeAll(async () => {
      await injectTestClients();
  });

  it("all expected routes return non-404", async () => {
    const { mountAdminRoutes } = await import("./server.js");
    const app = express();
    await mountAdminRoutes(app, stubSvc as any, async () => ({ response: "hi", history: [], avatar: { id: AID } }) as any);
    const routes: Array<[string, string, unknown?]> = [
      ["POST", "/api/chat", { message: "hi" }],
      ["GET", "/api/avatars"], ["POST", "/api/avatars", { name: "t" }],
      ["GET", `/api/avatars/${AID}`], ["PUT", `/api/avatars/${AID}`, { name: "x" }],
      ["PATCH", `/api/avatars/${AID}`, { name: "x" }],
      ["POST", `/api/avatars/${AID}/secrets`, { key: "t", value: "x" }],
      ["GET", `/api/avatars/${AID}/secrets`],
      ["POST", `/api/avatars/${AID}/validate-token`, { type: "telegram_bot_token", value: "1".repeat(30) }],
      ["POST", `/api/avatars/${AID}/validate-ai-key`, { integration: "openrouter", value: "sk-xxx" }],
      ["GET", `/api/avatars/${AID}/telegram/diagnose`],
      ["POST", `/api/avatars/${AID}/telegram/repair`],
      ["GET", `/api/avatars/${AID}/integrations`],
      ["POST", `/api/avatars/${AID}/integrations`, {}],
      ["GET", "/api/integrations/models?integration=openrouter"],
      ["POST", `/api/avatars/${AID}/tools/tc-1`, { result: { configured: true } }],
      ["GET", `/api/avatars/${AID}/discord/status`],
    ];
    const results = await Promise.all(routes.map(([m, p, b]) => hitRoute(app, m, p, b).then(r => `${m} ${p} -> ${r.status}`)));
    const bad = results.filter(r => r.endsWith("404"));
    expect(bad).toEqual([]);
  });

  it("passes pendingToolCall through /api/chat", async () => {
    const { mountAdminRoutes } = await import("./server.js");
    const app = express();
    await mountAdminRoutes(app, stubSvc as any, async () => ({
      response: "ok", history: [], avatar: { id: AID },
      pendingToolCall: { id: "tc-99", name: "configure_integration", arguments: { integration: "discord" } },
      taskActions: [{ id: "ta-1" }], media: [], pendingJobs: [], avatarUpdates: {},
    }) as any);
    const { status, body } = await hitRoute(app, "POST", "/api/chat", { message: "t" });
    expect(status).toBe(200);
    expect((body as any).pendingToolCall.id).toBe("tc-99");
  });

  it("returns 400 on empty chat body", async () => {
    const { mountAdminRoutes } = await import("./server.js");
    const app = express();
    await mountAdminRoutes(app, stubSvc as any, async () => ({ response: "x", history: [], avatar: null }) as any);
    expect((await hitRoute(app, "POST", "/api/chat", {})).status).toBe(400);
  });

  it("returns 500 when processChat throws", async () => {
    const { mountAdminRoutes } = await import("./server.js");
    const app = express();
    await mountAdminRoutes(app, stubSvc as any, async () => { throw new Error("boom"); });
    const { status, body } = await hitRoute(app, "POST", "/api/chat", { message: "hi" });
    expect(status).toBe(500);
    expect((body as any).error).toBe("Chat processing failed");
  });

  it("secret save works", async () => {
    const { mountAdminRoutes } = await import("./server.js");
    const app = express();
    await mountAdminRoutes(app, stubSvc as any);
    const { status } = await hitRoute(app, "POST", `/api/avatars/${AID}/secrets`, { key: "t", value: "x" });
    expect(status).toBe(200);
  });

  it("tools resume route exists and returns non-404", async () => {
    const { mountAdminRoutes } = await import("./server.js");
    const app = express();
    await mountAdminRoutes(app, stubSvc as any);
    const { status } = await hitRoute(app, "POST", `/api/avatars/${AID}/tools/tc-1`, { result: { ok: true } });
    // Route exists (not 404); internal store may not be initialized so error varies
    expect(status).not.toBe(404);
  });
});

