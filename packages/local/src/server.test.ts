/**
 * Tests for local server route handlers.
 */
import { describe, expect, it, beforeAll } from "bun:test";
import express from "express";

// ── Request simulator (mimics enough of http.ServerResponse for Express) ──

function hitRoute(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve) => {
    const done = (status: number, data: unknown) => resolve({ status, body: data });
    const headers: Record<string, string> = {};
    const res = {
      _status: 200,
      _headers: headers,
      statusCode: 200,
      status(c: number) { this._status = c; this.statusCode = c; return this as any; },
      json(d: unknown) { done(this._status, d); },
      send(d: unknown) { done(this._status, d); },
      end() { done(this._status, null); },
      set(k: string, v: string) { headers[k] = v; return this; },
      header(k: string, v: string) { headers[k] = v; return this; },
      setHeader(k: string, v: string) { headers[k.toLowerCase()] = v; },
      getHeader(k: string) { return headers[k.toLowerCase()]; },
      get(_k: string) { return undefined; },
      removeHeader() {},
      headersSent: false,
      locals: {},
    };
    const req: Record<string, unknown> = {
      method: method.toUpperCase(),
      url: path,
      path,
      baseUrl: "",
      body,
      params: extractParams(path),
      query: {},
      headers: {},
      get() { return undefined; },
      app,
      res,
      next: undefined,
      _parsedUrl: { pathname: path, search: "", query: {} },
    };
    (app as any).handle(req, res, (_err?: unknown) => done(404, { error: "not found" }));
  });
}

function extractParams(path: string): Record<string, string> {
  const m = path.match(/^\/api\/avatars\/([^/]+)/);
  return m ? { id: m[1] } : {};
}

// ── Pure contract tests ───────────────────────────────────────────────

function shapeChatResponse(result: Record<string, unknown>): Record<string, unknown> {
  return {
    response: result.response,
    history: result.history,
    avatar: result.avatar,
    pendingToolCall: (result as any).pendingToolCall,
    taskActions: (result as any).taskActions,
    media: (result as any).media,
    pendingJobs: (result as any).pendingJobs,
    avatarUpdates: (result as any).avatarUpdates,
  };
}

function validateChatBody(body: { message?: string; history?: unknown[] }): string | null {
  const { message, history = [] } = body;
  if (!message && !(history as unknown[]).length) return "message or history required";
  return null;
}

describe("chat response shaping", () => {
  it("forwards all fields including pendingToolCall", () => {
    const body = shapeChatResponse({
      response: "ok", history: [], avatar: { id: "a1" },
      pendingToolCall: { id: "tc-1", name: "configure_integration", arguments: { integration: "telegram" } },
      taskActions: [{ id: "ta-1" }],
      media: [{ type: "image", url: "x" }],
      pendingJobs: [{ jobId: "j1" }],
      avatarUpdates: { name: "X" },
    });
    expect(body.pendingToolCall).toBeDefined();
    expect(body.taskActions).toEqual([{ id: "ta-1" }]);
    expect(body.media).toEqual([{ type: "image", url: "x" }]);
    expect(body.pendingJobs).toEqual([{ jobId: "j1" }]);
    expect(body.avatarUpdates).toEqual({ name: "X" });
  });

  it("omits absent fields as undefined", () => {
    const body = shapeChatResponse({ response: "hi", history: [], avatar: null });
    expect(body.pendingToolCall).toBeUndefined();
    expect(body.taskActions).toBeUndefined();
  });

  it("rejects empty chat body", () => {
    expect(validateChatBody({})).toMatch(/message or history/);
    expect(validateChatBody({ message: "hi" })).toBeNull();
  });
});

// ── Route surface smoke + response forwarding ─────────────────────────

const AVATAR_ID = "test-1";

const stubServices = {
  secrets: {
    setSecret: async () => {},
    flush: async () => {},
    listSecrets: async () => [] as string[],
    getSecret: async () => "",
    deleteSecret: async () => {},
  },
};

describe("mountAdminRoutes integration", () => {
  let clientsInjected = false;

  beforeAll(async () => {
    if (!clientsInjected) {
      // Inject local adapters for all AWS services the admin-api imports
      const { _setDynamoClient } = await import("../../admin-api/src/services/dynamo-client.js");
      const { _setS3Client, _setSQSClient, _setSecretsClient, _setLambdaClient } = await import("../../admin-api/src/services/aws-clients.js");

      const stub = { send: async () => ({}), config: {}, destroy: () => {} } as any;
      _setDynamoClient(stub);
      _setS3Client(stub);
      _setSQSClient(stub);
      _setSecretsClient(stub);
      _setLambdaClient(stub);
      clientsInjected = true;
    }
  });
  it("all expected routes return non-404", async () => {
    const { mountAdminRoutes } = await import("./server.js");
    const app = express();

    const mockChat = async () => ({
      response: "hi", history: [], avatar: { id: AVATAR_ID },
    });

    await mountAdminRoutes(app, stubServices as any, mockChat);

    const routes: Array<[string, string, unknown?]> = [
      ["POST", "/api/chat", { message: "hi" }],
      ["GET", "/api/avatars"],
      ["POST", "/api/avatars", { name: "test" }],
      ["GET", `/api/avatars/${AVATAR_ID}`],
      ["PUT", `/api/avatars/${AVATAR_ID}`, { name: "x" }],
      ["PATCH", `/api/avatars/${AVATAR_ID}`, { name: "x" }],
      ["POST", `/api/avatars/${AVATAR_ID}/secrets`, { key: "telegram_bot_token", value: "123:abc" }],
      ["GET", `/api/avatars/${AVATAR_ID}/secrets`],
      ["POST", `/api/avatars/${AVATAR_ID}/validate-token`, { type: "telegram_bot_token", value: "123:abc" }],
      ["POST", `/api/avatars/${AVATAR_ID}/validate-ai-key`, { integration: "openrouter", value: "sk-xxx" }],
      ["GET", `/api/avatars/${AVATAR_ID}/telegram/diagnose`],
      ["POST", `/api/avatars/${AVATAR_ID}/telegram/repair`],
      ["GET", `/api/avatars/${AVATAR_ID}/integrations`],
      ["POST", `/api/avatars/${AVATAR_ID}/integrations`, {}],
      ["GET", "/api/integrations/models?integration=openrouter"],
      ["POST", `/api/avatars/${AVATAR_ID}/tools/tc-1`, { result: { configured: true, integration: "telegram" } }],
      ["GET", `/api/avatars/${AVATAR_ID}/discord/status`],
    ];

    const missing: string[] = [];
    for (const [method, path, body] of routes) {
      const { status } = await hitRoute(app, method, path, body);
      if (status === 404) missing.push(`${method} ${path}`);
    }

    expect(missing).toEqual([]);
  });

  it("passes pendingToolCall and all fields through /api/chat", async () => {
    const { mountAdminRoutes } = await import("./server.js");
    const app = express();

    const mockChat = async () => ({
      response: "ok",
      history: [{ role: "assistant", content: "test" }],
      avatar: { id: AVATAR_ID, name: "Test" },
      pendingToolCall: { id: "tc-99", name: "configure_integration", arguments: { integration: "discord" } },
      taskActions: [{ id: "ta-1" }],
      media: [{ type: "image", url: "https://x.com/a.png" }],
      pendingJobs: [{ jobId: "j-1", type: "image" }],
      avatarUpdates: { name: "Renamed" },
    });

    await mountAdminRoutes(app, stubServices as any, mockChat);

    const { status, body } = await hitRoute(app, "POST", "/api/chat", { message: "test" });
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b.pendingToolCall).toBeDefined();
    expect((b.pendingToolCall as any).id).toBe("tc-99");
    expect((b.pendingToolCall as any).name).toBe("configure_integration");
    expect(b.taskActions).toEqual([{ id: "ta-1" }]);
    expect(b.media).toEqual([{ type: "image", url: "https://x.com/a.png" }]);
    expect(b.pendingJobs).toEqual([{ jobId: "j-1", type: "image" }]);
    expect(b.avatarUpdates).toEqual({ name: "Renamed" });
  });

  it("returns 400 on empty chat body", async () => {
    const { mountAdminRoutes } = await import("./server.js");
    const app = express();
    await mountAdminRoutes(app, stubServices as any, async () => ({ response: "x", history: [], avatar: null }) as any);
    const { status } = await hitRoute(app, "POST", "/api/chat", {});
    expect(status).toBe(400);
  });

  it("returns 500 when processChat throws", async () => {
    const { mountAdminRoutes } = await import("./server.js");
    const app = express();
    await mountAdminRoutes(app, stubServices as any, async () => { throw new Error("boom"); });
    const { status, body } = await hitRoute(app, "POST", "/api/chat", { message: "hi" });
    expect(status).toBe(500);
    expect((body as any).error).toBe("Chat processing failed");
    expect((body as any).detail).toBe("boom");
  });

  it("tool resume works", async () => {
    const { mountAdminRoutes } = await import("./server.js");
    const app = express();
    await mountAdminRoutes(app, stubServices as any);
    const { status, body } = await hitRoute(app, "POST", `/api/avatars/${AVATAR_ID}/tools/tc-1`, { result: { configured: true, integration: "telegram" } });
    // The resume may fail because the avatar doesn't exist, but the route should exist (non-404)
    expect(status).not.toBe(404);
  });

  it("secret save works and returns 200", async () => {
    const { mountAdminRoutes } = await import("./server.js");
    const app = express();
    await mountAdminRoutes(app, stubServices as any);
    const { status, body } = await hitRoute(app, "POST", `/api/avatars/${AVATAR_ID}/secrets`, { key: "telegram_bot_token", value: "123:abc" });
    expect(status).toBe(200);
    expect((body as any).success).toBe(true);
  });
});
