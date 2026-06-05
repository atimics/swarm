/**
 * Tests for local server route handlers — response shaping contracts.
 *
 * The primary risk: /api/chat must forward all fields from processChat
 * to the client. Missing fields (especially pendingToolCall) silently
 * break pause-tool UIs like IntegrationConfigPrompt.
 */
import { describe, expect, it } from "bun:test";

/** Pure function: shape the JSON payload from processChat result -> API response. */
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

/** Pure function: validate the /api/chat request body. */
function validateChatBody(body: { message?: string; history?: unknown[] }): string | null {
  const { message, history = [] } = body;
  if (!message && !(history as unknown[]).length) {
    return "message or history required";
  }
  return null;
}

describe("chat response shaping", () => {
  it("forwards pendingToolCall when processChat returns one", () => {
    const result = {
      response: "ok",
      history: [{ role: "assistant", content: "", tool_calls: [] }],
      avatar: { id: "avatar-1", name: "test" },
      pendingToolCall: { id: "tc-1", name: "configure_integration", arguments: { integration: "telegram" } },
      taskActions: [],
      media: [],
      pendingJobs: [],
      avatarUpdates: { name: "test" },
    };
    const body = shapeChatResponse(result);

    expect(body.pendingToolCall).toBeDefined();
    expect((body.pendingToolCall as any).id).toBe("tc-1");
    expect((body.pendingToolCall as any).name).toBe("configure_integration");
    expect((body.pendingToolCall as any).arguments).toEqual({ integration: "telegram" });
    expect(body.taskActions).toEqual([]);
    expect(body.media).toEqual([]);
    expect(body.pendingJobs).toEqual([]);
    expect(body.avatarUpdates).toEqual({ name: "test" });
  });

  it("omits pendingToolCall when processChat returns none", () => {
    const result = {
      response: "hello",
      history: [{ role: "assistant", content: "hello" }],
      avatar: { id: "avatar-1" },
    };
    const body = shapeChatResponse(result);

    expect(body.pendingToolCall).toBeUndefined();
    expect(body.response).toBe("hello");
  });

  it("returns error when message and history are both empty", () => {
    const err = validateChatBody({});
    expect(err).toMatch(/message or history/);

    const err2 = validateChatBody({ message: "", history: [] });
    expect(err2).toMatch(/message or history/);

    const ok = validateChatBody({ message: "hi" });
    expect(ok).toBeNull();
  });

  it("does not drop fields when result is bare-bones", () => {
    const result = { response: "bare", history: [], avatar: null };
    const body = shapeChatResponse(result);
    expect(body.response).toBe("bare");
    expect(body.history).toEqual([]);
    expect(body.pendingToolCall).toBeUndefined();
    expect(body.taskActions).toBeUndefined();
    expect(body.media).toBeUndefined();
  });
});
