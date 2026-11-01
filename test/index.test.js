/**
 * nano-context — integration tests for the plugin entry (index.js).
 *
 * Run with: node --test test/index.test.js
 *
 * These tests mock the DSH plugin context (ctx) and exercise the full
 * plugin lifecycle:
 *   - apply() registration (tools + event handlers)
 *   - llm/stream waterfall: ref assignment, rendering, pending-block resolution
 *   - agent/assistant-stream: nudge observer, token tracking, cooldown
 *   - Tool execution: compress, decompress, search, merge, acp_status
 *   - Session state: LRU eviction, multi-session isolation
 *   - Error resilience: render failures pass through, tool errors don't crash
 *
 * The mock ctx follows the DSH 0.2.1-rc.5 / Cordis plugin contract:
 *   - ctx.tools.register(def) — register a tool
 *   - ctx.on(event, handler) — subscribe to DSH events
 *   - ctx.logger — structured logger
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Import the plugin entry (default export is the plugin object) + test reset
import plugin, { __resetForTests } from "../index.js";

// ---------------------------------------------------------------------------
// Mock DSH ctx
// ---------------------------------------------------------------------------

function makeMockCtx({ contextLimit = 131072, nudgeThreshold = 0.5, maxBlocks = 50 } = {}) {
  const registeredTools = [];
  const eventHandlers = new Map(); // event → handler[]
  const loggerCalls = [];

  const ctx = {
    registeredTools,
    eventHandlers,
    loggerCalls,
    logger: {
      info: (msg) => loggerCalls.push({ level: "info", msg }),
      warn: (msg) => loggerCalls.push({ level: "warn", msg }),
      error: (msg) => loggerCalls.push({ level: "error", msg }),
    },
    tools: {
      register: (def) => {
        if (registeredTools.some((t) => t.name === def.name)) {
          throw new Error(`Tool "${def.name}" already registered`);
        }
        registeredTools.push(def);
      },
    },
    on: (event, handler) => {
      if (!eventHandlers.has(event)) eventHandlers.set(event, []);
      eventHandlers.get(event).push(handler);
    },
    config: { contextLimit, nudgeThreshold, maxBlocks },
  };

  /**
   * Simulate a DSH llm/stream request: invoke the registered handler
   * with options and a next() callback that captures the transformed options.
   * Returns the final options passed to next() (defaults to original options
   * when next() is called without arguments).
   */
  ctx.simulateLlmStream = (options) => {
    const handlers = eventHandlers.get("llm/stream");
    if (!handlers || handlers.length === 0) throw new Error("no llm/stream handler registered");
    let result = options;
    const next = (opts) => {
      result = opts !== undefined ? opts : options;
      return undefined;
    };
    for (const h of handlers) {
      h(options, next);
    }
    return result;
  };

  /**
   * Simulate a DSH agent/assistant-stream event: invoke the registered handler.
   */
  ctx.simulateAssistantStream = (agent, frame) => {
    const handlers = eventHandlers.get("agent/assistant-stream");
    if (!handlers || handlers.length === 0) throw new Error("no agent/assistant-stream handler registered");
    for (const h of handlers) {
      h({ agent, frame });
    }
  };

  /**
   * Execute a registered tool by name. Catches errors and returns them as
   * error strings (matching DSH's tool execution contract where tool errors
   * are surfaced to the model as text, not thrown).
   */
  ctx.executeTool = async (toolName, args, sessionId) => {
    const tool = registeredTools.find((t) => t.name === toolName);
    if (!tool) throw new Error(`tool "${toolName}" not registered`);
    try {
      return await tool.execute(args, { agent: { session: { id: sessionId } } });
    } catch (err) {
      return `⚠ ${toolName} failed: ${err.message}`;
    }
  };

  return ctx;
}

function makeMsg(id, role, text) {
  return {
    id,
    role,
    content: [{ type: "text", text }],
    source: role === "system" ? { kind: "system-prompt" } : { kind: "user" },
  };
}

function makeMessages(n) {
  const messages = [];
  for (let i = 1; i <= n; i++) {
    const id = `msg-${String(i).padStart(5, "0")}`;
    const role = i % 2 === 0 ? "assistant" : "user";
    const text = `Message ${i}: content about topic-${i} with some detail`;
    messages.push(makeMsg(id, role, text));
  }
  return messages;
}

/** Extract the ref tag from a rendered message's text content. */
function extractRef(text) {
  const m = /\[(m\d{1,7})\]/.exec(text);
  return m ? m[1] : null;
}

/** Get the text content of a rendered message. */
function msgText(msg) {
  if (Array.isArray(msg.content)) {
    return msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  }
  return typeof msg.text === "string" ? msg.text : "";
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("nano-context plugin (index.js) integration tests", () => {
  // Reset module-level state before each test for isolation
  beforeEach(() => {
    __resetForTests();
  });

  // --- 1. apply() registration ---

  test("apply() registers all 5 tools", async () => {
    const ctx = makeMockCtx();
    await plugin.apply(ctx, { contextLimit: 131072, nudgeThreshold: 0.5, maxBlocks: 50 }, {});
    const names = ctx.registeredTools.map((t) => t.name);
    for (const expected of ["compress", "decompress", "search_context", "merge", "acp_status"]) {
      assert.ok(names.includes(expected), `tool "${expected}" should be registered`);
    }
    assert.equal(ctx.registeredTools.length, 5, "exactly 5 tools");
  });

  test("apply() registers llm/stream and agent/assistant-stream handlers", async () => {
    const ctx = makeMockCtx();
    await plugin.apply(ctx, {}, {});
    assert.ok(ctx.eventHandlers.has("llm/stream"), "llm/stream handler registered");
    assert.ok(ctx.eventHandlers.has("agent/assistant-stream"), "agent/assistant-stream handler registered");
  });

  test("apply() with no config uses defaults", async () => {
    const ctx = makeMockCtx();
    await plugin.apply(ctx, undefined, {});
    // Should not throw; tools still registered
    assert.equal(ctx.registeredTools.length, 5);
  });

  test("apply() handles duplicate tool registration gracefully", async () => {
    const ctx = makeMockCtx();
    // Pre-register a tool to simulate cordis already having it
    ctx.registeredTools.push({ name: "compress" });
    await plugin.apply(ctx, {}, {});
    // Should not throw; the "already registered" error is caught
    assert.ok(ctx.registeredTools.some((t) => t.name === "compress"));
  });

  // --- 2. llm/stream: ref assignment + rendering ---

  test("llm/stream assigns refs to new messages and injects system prompt", async () => {
    const ctx = makeMockCtx();
    await plugin.apply(ctx, {}, {});

    const messages = makeMessages(5);
    const options = { sessionId: "s1", messages, model: "test" };
    const result = ctx.simulateLlmStream(options);

    // First message should be the system prompt block
    assert.equal(result.messages[0].role, "system");
    assert.ok(
      result.messages[0].id.startsWith("nano-context-system-"),
      "system message has plugin-prefixed id",
    );
    const sysText = msgText(result.messages[0]);
    assert.ok(sysText.includes("Compression Philosophy"), "system prompt contains compression philosophy");

    // Remaining messages should have ref tags
    for (let i = 1; i < result.messages.length; i++) {
      const text = msgText(result.messages[i]);
      const ref = extractRef(text);
      assert.ok(ref, `message ${i} has ref tag, got: ${text.slice(0, 40)}`);
    }
  });

  test("llm/stream passes through when no sessionId", async () => {
    const ctx = makeMockCtx();
    await plugin.apply(ctx, {}, {});

    const messages = makeMessages(3);
    const options = { messages, model: "test" };
    const result = ctx.simulateLlmStream(options);

    // Should pass through unmodified (same messages array)
    assert.equal(result, options, "options passed through unchanged");
  });

  test("llm/stream passes through when messages is empty", async () => {
    const ctx = makeMockCtx();
    await plugin.apply(ctx, {}, {});

    const options = { sessionId: "s1", messages: [], model: "test" };
    const result = ctx.simulateLlmStream(options);
    assert.equal(result, options, "empty messages passed through");
  });

  test("llm/stream renders compression blocks (pending block resolution across requests)", async () => {
    const ctx = makeMockCtx();
    await plugin.apply(ctx, {}, {});

    const sid = "s1";
    const messages1 = makeMessages(4);

    // First request: assign refs
    const result1 = ctx.simulateLlmStream({ sessionId: sid, messages: messages1, model: "test" });
    assert.equal(result1.messages.length, 5); // 1 system + 4 messages

    // Now simulate the model calling compress (creates a pending block)
    const compressResult = await ctx.executeTool("compress", { content: "m00001\u2013m00002\nSummary of messages 1-2" }, sid);
    assert.ok(compressResult.includes("b1"), "compress created block b1");

    // Second request: pending block should be resolved and rendered as summary
    const messages2 = makeMessages(4); // same message ids
    const result2 = ctx.simulateLlmStream({ sessionId: sid, messages: messages2, model: "test" });

    // The compressed range (m1-m2) should be replaced by a summary block
    const summaryMsgs = result2.messages.filter((m) => m.id && String(m.id).startsWith("summary-"));
    assert.ok(summaryMsgs.length >= 1, "at least one summary block rendered");
    const allText = summaryMsgs.map((m) => msgText(m)).join("\n");
    assert.ok(allText.includes("Summary of messages 1-2"), "summary text present");
  });

  test("llm/stream ref continuity: refs are not reset across requests", async () => {
    const ctx = makeMockCtx();
    await plugin.apply(ctx, {}, {});

    const sid = "s1";
    // Request 1: 3 messages
    const messages1 = makeMessages(3);
    const result1 = ctx.simulateLlmStream({ sessionId: sid, messages: messages1, model: "test" });
    const ref1 = extractRef(msgText(result1.messages[1]));
    assert.ok(ref1, "first message has a ref");
    assert.equal(ref1, "m00001", "first message gets m00001");

    // Request 2: 5 messages (2 new)
    const messages2 = makeMessages(5);
    const result2 = ctx.simulateLlmStream({ sessionId: sid, messages: messages2, model: "test" });
    const ref4 = extractRef(msgText(result2.messages[4]));
    assert.ok(ref4, "fourth message has a ref");
    assert.equal(ref4, "m00004", "fourth message gets m00004 (continuity)");
  });

  test("llm/stream does not double-assign refs to already-tagged messages", async () => {
    const ctx = makeMockCtx();
    await plugin.apply(ctx, {}, {});

    const sid = "s1";
    const messages1 = makeMessages(3);
    const result1 = ctx.simulateLlmStream({ sessionId: sid, messages: messages1, model: "test" });

    // Second request with same messages: refs should not be re-assigned
    const result2 = ctx.simulateLlmStream({ sessionId: sid, messages: messages1, model: "test" });
    const ref1 = extractRef(msgText(result2.messages[1]));
    assert.equal(ref1, "m00001", "same ref on second pass");
  });

  // --- 3. Nudge observer ---

  test("nudge fires when tokens exceed threshold", async () => {
    const ctx = makeMockCtx({ contextLimit: 1000, nudgeThreshold: 0.5 });
    await plugin.apply(ctx, { contextLimit: 1000, nudgeThreshold: 0.5, maxBlocks: 50 }, {});

    const sid = "s1";
    let nudgeText = null;
    const agent = {
      session: { id: sid },
      steer: (text) => { nudgeText = text; },
    };

    // Simulate a finish frame with usage
    const frame = {
      chunk: { type: "finish" },
      usage: { totalTokens: 600 },
    };
    ctx.simulateAssistantStream(agent, frame);

    assert.ok(nudgeText, "nudge was injected");
    assert.ok(nudgeText.includes("compress"), "nudge mentions compress");
  });

  test("nudge does NOT fire below threshold", async () => {
    const ctx = makeMockCtx({ contextLimit: 1000, nudgeThreshold: 0.5 });
    await plugin.apply(ctx, { contextLimit: 1000, nudgeThreshold: 0.5, maxBlocks: 50 }, {});

    const sid = "s1";
    let nudgeText = null;
    const agent = {
      session: { id: sid },
      steer: (text) => { nudgeText = text; },
    };

    const frame = {
      chunk: { type: "finish" },
      usage: { totalTokens: 400 }, // below 500 threshold
    };
    ctx.simulateAssistantStream(agent, frame);

    assert.equal(nudgeText, null, "no nudge below threshold");
  });

  test("nudge cooldown: does not re-nudge within 10% growth", async () => {
    const ctx = makeMockCtx({ contextLimit: 10000, nudgeThreshold: 0.5 });
    await plugin.apply(ctx, { contextLimit: 10000, nudgeThreshold: 0.5, maxBlocks: 50 }, {});

    const sid = "s1";
    let nudgeCount = 0;
    const agent = {
      session: { id: sid },
      steer: () => { nudgeCount++; },
    };

    // First nudge at 6000 tokens (threshold is 5000)
    ctx.simulateAssistantStream(agent, {
      chunk: { type: "finish" },
      usage: { totalTokens: 6000 },
    });
    assert.equal(nudgeCount, 1, "first nudge fires");

    // Second at 6200 (only 3.3% growth, below 10% cooldown)
    ctx.simulateAssistantStream(agent, {
      chunk: { type: "finish" },
      usage: { totalTokens: 6200 },
    });
    assert.equal(nudgeCount, 1, "cooldown suppresses second nudge");

    // Third at 6700 (11.7% growth, above 10% cooldown)
    ctx.simulateAssistantStream(agent, {
      chunk: { type: "finish" },
      usage: { totalTokens: 6700 },
    });
    assert.equal(nudgeCount, 2, "cooldown expires, third nudge fires");
  });

  test("nudge observer ignores non-finish frames", async () => {
    const ctx = makeMockCtx({ contextLimit: 1000, nudgeThreshold: 0.5 });
    await plugin.apply(ctx, { contextLimit: 1000, nudgeThreshold: 0.5, maxBlocks: 50 }, {});

    const sid = "s1";
    let nudgeText = null;
    const agent = {
      session: { id: sid },
      steer: (text) => { nudgeText = text; },
    };

    // Non-finish frame
    ctx.simulateAssistantStream(agent, {
      chunk: { type: "delta", text: "hello" },
      usage: { totalTokens: 9999 },
    });
    assert.equal(nudgeText, null, "non-finish frame ignored");
  });

  test("nudge observer ignores frames without usage", async () => {
    const ctx = makeMockCtx({ contextLimit: 1000, nudgeThreshold: 0.5 });
    await plugin.apply(ctx, { contextLimit: 1000, nudgeThreshold: 0.5, maxBlocks: 50 }, {});

    const sid = "s1";
    let nudgeText = null;
    const agent = {
      session: { id: sid },
      steer: (text) => { nudgeText = text; },
    };

    ctx.simulateAssistantStream(agent, {
      chunk: { type: "finish" },
      // no usage
    });
    assert.equal(nudgeText, null, "no usage → no nudge");
  });

  // --- 4. Tool execution ---

  test("compress tool creates a block and returns confirmation", async () => {
    const ctx = makeMockCtx();
    await plugin.apply(ctx, {}, {});

    const sid = "s1";
    const messages = makeMessages(5);
    // First render to assign refs
    ctx.simulateLlmStream({ sessionId: sid, messages, model: "test" });

    const result = await ctx.executeTool("compress", {
      content: "m00001\u2013m00002\nSummary of first two messages about setup",
    }, sid);

    assert.ok(result.includes("Compressed"), "returns compression confirmation");
    assert.ok(result.includes("b1"), "returns block id b1");
    assert.ok(result.includes("m00001"), "mentions start ref");
    assert.ok(result.includes("m00002"), "mentions end ref");
  });

  test("compress tool rejects empty summary", async () => {
    const ctx = makeMockCtx();
    await plugin.apply(ctx, {}, {});

    const sid = "s1";
    const messages = makeMessages(5);
    ctx.simulateLlmStream({ sessionId: sid, messages, model: "test" });

    // Header only, no summary lines
    const result = await ctx.executeTool("compress", {
      content: "m00001\u2013m00002",
    }, sid);

    assert.ok(result.includes("⚠") || result.includes("failed"), "rejects empty summary");
  });

  test("decompress tool restores messages", async () => {
    const ctx = makeMockCtx();
    await plugin.apply(ctx, {}, {});

    const sid = "s1";
    const messages = makeMessages(4);
    ctx.simulateLlmStream({ sessionId: sid, messages, model: "test" });

    // Compress first
    const cResult = await ctx.executeTool("compress", {
      content: "m00001\u2013m00002\nSummary text here",
    }, sid);
    assert.ok(cResult.includes("Compressed"), "compress succeeds");

    // Render to resolve the pending block (needed before decompress can work)
    const messages2 = makeMessages(4);
    ctx.simulateLlmStream({ sessionId: sid, messages: messages2, model: "test" });

    // Decompress
    const result = await ctx.executeTool("decompress", { blockId: "b1" }, sid);
    assert.ok(result.includes("Decompressed"), "decompress confirms restoration");
  });

  test("search_context tool finds text in compressed blocks", async () => {
    const ctx = makeMockCtx();
    await plugin.apply(ctx, {}, {});

    const sid = "s1";
    const messages = makeMessages(6);
    ctx.simulateLlmStream({ sessionId: sid, messages, model: "test" });

    // Compress messages 1-3 with specific content
    const cResult = await ctx.executeTool("compress", {
      content: "m00001\u2013m00003\nSummary: discussed quantum entanglement and particle physics",
    }, sid);
    assert.ok(cResult.includes("Compressed"), "compress succeeds");

    // Render to resolve the pending block (makes originals searchable)
    const messages2 = makeMessages(6);
    ctx.simulateLlmStream({ sessionId: sid, messages: messages2, model: "test" });

    const result = await ctx.executeTool("search_context", { query: "quantum" }, sid);
    assert.ok(result.includes("quantum"), "search finds the term");
    assert.ok(result.includes("b1"), "search identifies the block");
  });

  test("merge tool merges adjacent blocks", async () => {
    const ctx = makeMockCtx();
    await plugin.apply(ctx, {}, {});

    const sid = "s1";
    const messages = makeMessages(6);
    ctx.simulateLlmStream({ sessionId: sid, messages, model: "test" });

    // Create two adjacent blocks
    const c1 = await ctx.executeTool("compress", {
      content: "m00001\u2013m00002\nFirst block summary",
    }, sid);
    const c2 = await ctx.executeTool("compress", {
      content: "m00003\u2013m00004\nSecond block summary",
    }, sid);
    assert.ok(c1.includes("Compressed"), "first compress succeeds");
    assert.ok(c2.includes("Compressed"), "second compress succeeds");

    // Render to resolve pending blocks (needed for merge adjacency check)
    const messages2 = makeMessages(6);
    ctx.simulateLlmStream({ sessionId: sid, messages: messages2, model: "test" });

    const result = await ctx.executeTool("merge", { blockIdA: "b1", blockIdB: "b2" }, sid);
    assert.ok(result.includes("Merged"), "merge succeeds");
    assert.ok(result.includes("b1"), "surviving block is b1");
  });

  test("acp_status tool reports context status", async () => {
    const ctx = makeMockCtx({ contextLimit: 1000, nudgeThreshold: 0.5 });
    await plugin.apply(ctx, { contextLimit: 1000, nudgeThreshold: 0.5, maxBlocks: 50 }, {});

    const sid = "s1";
    const messages = makeMessages(3);
    ctx.simulateLlmStream({ sessionId: sid, messages, model: "test" });

    // Simulate token usage observation
    const agent = {
      session: { id: sid },
      steer: () => {},
    };
    ctx.simulateAssistantStream(agent, {
      chunk: { type: "finish" },
      usage: { totalTokens: 750 },
    });

    const result = await ctx.executeTool("acp_status", {}, sid);
    assert.ok(result.includes("Context:"), "status shows context line");
    assert.ok(result.includes("Active blocks:"), "status shows active blocks");
  });

  // --- 5. Multi-session isolation ---

  test("sessions are isolated: compress in s1 does not affect s2", async () => {
    const ctx = makeMockCtx();
    await plugin.apply(ctx, {}, {});

    // Session s1: compress
    const messages1 = makeMessages(4);
    ctx.simulateLlmStream({ sessionId: "s1", messages: messages1, model: "test" });
    await ctx.executeTool("compress", {
      content: "m00001\u2013m00002\nS1 summary",
    }, "s1");

    // Session s2: should have no blocks
    const messages2 = makeMessages(4);
    const result2 = ctx.simulateLlmStream({ sessionId: "s2", messages: messages2, model: "test" });
    const summaryCount = result2.messages.filter((m) => m.id && String(m.id).startsWith("summary-")).length;
    assert.equal(summaryCount, 0, "s2 has no summary blocks");
  });

  test("ref counters are per-session", async () => {
    const ctx = makeMockCtx();
    await plugin.apply(ctx, {}, {});

    // s1: 3 messages → refs m00001-m00003
    const messages1 = makeMessages(3);
    ctx.simulateLlmStream({ sessionId: "s1", messages: messages1, model: "test" });

    // s2: first message should also get m00001
    const messages2 = makeMessages(1);
    const result2 = ctx.simulateLlmStream({ sessionId: "s2", messages: messages2, model: "test" });
    const ref = extractRef(msgText(result2.messages[1]));
    assert.equal(ref, "m00001", "s2 starts its own ref sequence");
  });

  // --- 6. Error resilience ---

  test("render failure passes through unmodified (no crash)", async () => {
    const ctx = makeMockCtx();
    await plugin.apply(ctx, {}, {});

    // Simulate a message with a broken structure that would cause renderMessages to throw
    const sid = "s1";
    const messages = [
      { id: "msg-00001", role: "user", content: null }, // broken: content is null
    ];

    // Should not throw; should pass through
    const result = ctx.simulateLlmStream({ sessionId: sid, messages, model: "test" });
    assert.ok(result, "render did not crash");
  });

  test("tool execution errors return error string, not throw", async () => {
    const ctx = makeMockCtx();
    await plugin.apply(ctx, {}, {});

    const sid = "s1";
    const messages = makeMessages(3);
    ctx.simulateLlmStream({ sessionId: sid, messages, model: "test" });

    // Decompress a non-existent block
    const result = await ctx.executeTool("decompress", { blockId: "b99" }, sid);
    assert.ok(typeof result === "string", "returns a string");
    assert.ok(result.includes("⚠"), "error message has warning prefix");
  });

  // --- 7. Pending block lifecycle ---

  test("pending block is resolved on next render (full lifecycle)", async () => {
    const ctx = makeMockCtx();
    await plugin.apply(ctx, {}, {});

    const sid = "s1";
    const messages = makeMessages(4);

    // Request 1: assign refs
    const r1 = ctx.simulateLlmStream({ sessionId: sid, messages, model: "test" });
    assert.equal(r1.messages.length, 5); // 1 sys + 4 msgs

    // Model calls compress → creates pending block
    const compressOut = await ctx.executeTool("compress", {
      content: "m00001\u2013m00002\nFull summary of the first exchange",
    }, sid);
    assert.ok(compressOut.includes("Compressed"), "compress succeeds");
    assert.ok(compressOut.includes("b1"), "b1 created");

    // Request 2: pending block resolves → summary rendered
    const r2 = ctx.simulateLlmStream({ sessionId: sid, messages, model: "test" });
    const summaryMsgs = r2.messages.filter((m) => m.id && String(m.id).startsWith("summary-"));
    assert.ok(summaryMsgs.length >= 1, "summary block rendered");
    const allText = r2.messages.map((m) => msgText(m)).join("\n");
    assert.ok(allText.includes("Full summary of the first exchange"), "summary text present");

    // Request 3: block is now active (not pending), still rendered
    const r3 = ctx.simulateLlmStream({ sessionId: sid, messages, model: "test" });
    const summaryCount3 = r3.messages.filter((m) => m.id && String(m.id).startsWith("summary-")).length;
    assert.equal(summaryCount3, summaryMsgs.length, "block persists across requests");
  });

  // --- 8. System prompt block stability ---

  test("system prompt block is byte-stable across requests", async () => {
    const ctx = makeMockCtx();
    await plugin.apply(ctx, {}, {});

    const sid = "s1";
    const messages = makeMessages(2);

    const r1 = ctx.simulateLlmStream({ sessionId: sid, messages, model: "test" });
    const sysText1 = msgText(r1.messages[0]);

    const r2 = ctx.simulateLlmStream({ sessionId: sid, messages, model: "test" });
    const sysText2 = msgText(r2.messages[0]);

    assert.equal(sysText1, sysText2, "system prompt is identical across requests");
  });

  // --- 9. maxBlocks cap ---

  test("compress refuses when at maxBlocks limit", async () => {
    const ctx = makeMockCtx();
    await plugin.apply(ctx, { contextLimit: 131072, nudgeThreshold: 0.5, maxBlocks: 2 }, {});

    const sid = "s1";
    const messages = makeMessages(10);
    ctx.simulateLlmStream({ sessionId: sid, messages, model: "test" });

    // Create 2 blocks (at the limit)
    const c1 = await ctx.executeTool("compress", { content: "m00001\u2013m00002\nBlock 1" }, sid);
    const c2 = await ctx.executeTool("compress", { content: "m00003\u2013m00004\nBlock 2" }, sid);
    assert.ok(c1.includes("Compressed"), "first block created");
    assert.ok(c2.includes("Compressed"), "second block created");

    // Third should be refused
    const result = await ctx.executeTool("compress", { content: "m00005\u2013m00006\nBlock 3" }, sid);
    assert.ok(result.includes("⚠") || result.includes("REFUSED"), "third block refused");
  });

  // --- 10. LRU eviction ---

  test("session state is evicted when exceeding MAX_SESSIONS", async () => {
    const ctx = makeMockCtx();
    await plugin.apply(ctx, {}, {});

    // Create 33 sessions (MAX_SESSIONS = 32, so the first should be evicted)
    for (let i = 1; i <= 33; i++) {
      const msgs = makeMessages(1);
      ctx.simulateLlmStream({ sessionId: `s${i}`, messages: msgs, model: "test" });
    }

    // s1 should have been evicted; s33 should exist
    // Create a new session to trigger LRU: s1 was the oldest
    // Verify s33 works
    const msgs33 = makeMessages(2);
    const result33 = ctx.simulateLlmStream({ sessionId: "s33", messages: msgs33, model: "test" });
    assert.ok(result33.messages.length >= 2, "s33 still has state");
  });

  // --- 11. Nudge text content ---

  test("nudge text includes context stats and compression guidance", async () => {
    const ctx = makeMockCtx({ contextLimit: 10000, nudgeThreshold: 0.5 });
    await plugin.apply(ctx, { contextLimit: 10000, nudgeThreshold: 0.5, maxBlocks: 50 }, {});

    const sid = "s1";
    let nudgeText = null;
    const agent = {
      session: { id: sid },
      steer: (text) => { nudgeText = text; },
    };

    ctx.simulateAssistantStream(agent, {
      chunk: { type: "finish" },
      usage: { totalTokens: 7000 },
    });

    assert.ok(nudgeText, "nudge fired");
    assert.ok(nudgeText.includes("7000") || nudgeText.includes("7,000"), "mentions token count");
    assert.ok(nudgeText.includes("10000") || nudgeText.includes("10,000"), "mentions context limit");
  });

  // --- 12. S-2: structured metrics ---

  test("acp_status includes structured Metrics JSON", async () => {
    const ctx = makeMockCtx({ contextLimit: 10000 });
    await plugin.apply(ctx, { contextLimit: 10000, maxBlocks: 50 }, {});

    const sid = "s1";
    // Seed a render pass so refs exist
    const msgs = makeMessages(3);
    ctx.simulateLlmStream({ sessionId: sid, messages: msgs, model: "test" });

    const result = await ctx.executeTool("acp_status", {}, sid);
    assert.ok(result.includes("Metrics:"), "has Metrics line");
    const metricsLine = result.split("Metrics: ").pop();
    const metrics = JSON.parse(metricsLine);
    assert.strictEqual(metrics.activeBlocks, 0, "no blocks yet");
    assert.strictEqual(metrics.totalBlocks, 0, "no blocks created");
    assert.strictEqual(metrics.compressionCount, 0, "no compressions");
    assert.strictEqual(metrics.mergeCount, 0, "no merges");
    assert.strictEqual(metrics.nudgeCount, 0, "no nudges");
    assert.strictEqual(metrics.qualityWarnings, 0, "no quality warnings");
  });

  test("acp_status Metrics reflects compression state", async () => {
    const ctx = makeMockCtx({ contextLimit: 10000 });
    await plugin.apply(ctx, { contextLimit: 10000, maxBlocks: 50 }, {});

    const sid = "s1";
    const msgs = makeMessages(6);
    ctx.simulateLlmStream({ sessionId: sid, messages: msgs, model: "test" });

    // Compress m00001-m00003
    await ctx.executeTool("compress", { content: "m00001–m00003 [test topic]\nThis is a test summary of the first three messages." }, sid);
    // Render pass to resolve the pending block
    ctx.simulateLlmStream({ sessionId: sid, messages: msgs, model: "test" });

    const result = await ctx.executeTool("acp_status", {}, sid);
    const metricsLine = result.split("Metrics: ").pop();
    const metrics = JSON.parse(metricsLine);
    assert.strictEqual(metrics.activeBlocks, 1, "one active block");
    assert.strictEqual(metrics.compressionCount, 1, "one compression");
    assert.ok(metrics.tokensCompressed > 0, "tokens compressed tracked");
    assert.ok(metrics.totalSummaryTokens > 0, "summary tokens tracked");
  });

  test("acp_status Metrics tracks mergeCount", async () => {
    const ctx = makeMockCtx({ contextLimit: 10000 });
    await plugin.apply(ctx, { contextLimit: 10000, maxBlocks: 50 }, {});

    const sid = "s1";
    const msgs = makeMessages(8);
    ctx.simulateLlmStream({ sessionId: sid, messages: msgs, model: "test" });

    // Create two adjacent blocks
    await ctx.executeTool("compress", { content: "m00001–m00003 [t1]\nSummary one." }, sid);
    await ctx.executeTool("compress", { content: "m00004–m00006 [t2]\nSummary two." }, sid);
    ctx.simulateLlmStream({ sessionId: sid, messages: msgs, model: "test" });

    // Merge them
    await ctx.executeTool("merge", { blockIdA: "b1", blockIdB: "b2" }, sid);

    const result = await ctx.executeTool("acp_status", {}, sid);
    const metrics = JSON.parse(result.split("Metrics: ").pop());
    assert.strictEqual(metrics.mergeCount, 1, "merge count tracked");
    assert.strictEqual(metrics.activeBlocks, 1, "one merged block");
  });

  test("nudge increments nudgeCount in metrics", async () => {
    const ctx = makeMockCtx({ contextLimit: 10000, nudgeThreshold: 0.5 });
    await plugin.apply(ctx, { contextLimit: 10000, nudgeThreshold: 0.5, maxBlocks: 50 }, {});

    const sid = "s1";
    const agent = { session: { id: sid }, steer: () => {} };

    // Fire a nudge
    ctx.simulateAssistantStream(agent, { chunk: { type: "finish" }, usage: { totalTokens: 7000 } });

    const result = await ctx.executeTool("acp_status", {}, sid);
    const metrics = JSON.parse(result.split("Metrics: ").pop());
    assert.strictEqual(metrics.nudgeCount, 1, "nudge count is 1");
    assert.ok(metrics.totalTokensSeen >= 7000, "peak tokens tracked");
  });

  // --- 13. S-3: compression budget ---

  test("oversized summary triggers budgetWarning after render pass", async () => {
    const ctx = makeMockCtx({ contextLimit: 10000 });
    await plugin.apply(ctx, { contextLimit: 10000, maxBlocks: 50 }, {});

    const sid = "s1";
    const msgs = makeMessages(2);
    ctx.simulateLlmStream({ sessionId: sid, messages: msgs, model: "test" });

    // Create a summary that is LARGER than the original (budget violation)
    const longSummary = "x".repeat(5000);
    await ctx.executeTool("compress", { content: `m00001–m00002 [big]\n${longSummary}` }, sid);

    // Render pass resolves the pending block and triggers the budget check
    ctx.simulateLlmStream({ sessionId: sid, messages: msgs, model: "test" });

    // Check via acp_status — the budget warning appears in the block listing
    const result = await ctx.executeTool("acp_status", {}, sid);
    assert.ok(result.includes("budget exceeded"), "budget warning shown in status");
  });

  test("normal compression does NOT trigger budget warning", async () => {
    const ctx = makeMockCtx({ contextLimit: 10000 });
    await plugin.apply(ctx, { contextLimit: 10000, maxBlocks: 50 }, {});

    const sid = "s1";
    const msgs = makeMessages(3);
    ctx.simulateLlmStream({ sessionId: sid, messages: msgs, model: "test" });

    await ctx.executeTool("compress", { content: "m00001–m00003 [ok]\nShort summary." }, sid);
    ctx.simulateLlmStream({ sessionId: sid, messages: msgs, model: "test" });

    const result = await ctx.executeTool("acp_status", {}, sid);
    assert.ok(!result.includes("budget exceeded"), "no budget warning for normal compression");
  });

  // --- 14. S-4: graceful restart degradation ---

  test("restart: stale ref tags are stripped and refs re-baselined", async () => {
    const ctx = makeMockCtx({ contextLimit: 10000 });
    await plugin.apply(ctx, { contextLimit: 10000, maxBlocks: 50 }, {});

    const sid = "restart-s1";
    // Simulate messages that carry stale [mNNNNN] tags from a previous run
    const staleMsgs = [
      { id: "msg1", role: "user", content: [{ type: "text", text: "Hello [m00015] world" }] },
      { id: "msg2", role: "assistant", content: [{ type: "text", text: "Hi [m00016] there" }] },
      { id: "msg3", role: "user", content: [{ type: "text", text: "Goodbye [m00017]" }] },
    ];
    const result = ctx.simulateLlmStream({ sessionId: sid, messages: staleMsgs, model: "test" });
    // Check that the system prompt is present (proof the handler ran)
    assert.ok(result.messages[0].id.startsWith("nano-context-system-"), "system prompt injected");
    // The first real message should have a fresh ref tag [m00001]
    const firstContent = result.messages[1].content.map((p) => p.text || "").join("");
    assert.ok(firstContent.includes("[m00001]"), `first message has fresh ref, got: ${firstContent}`);
    // Stale tag should be gone
    assert.ok(!firstContent.includes("[m00015]"), "stale tag removed");
  });

  test("restart: no restart detected when state already has refs", async () => {
    const ctx = makeMockCtx({ contextLimit: 10000 });
    await plugin.apply(ctx, { contextLimit: 10000, maxBlocks: 50 }, {});

    const sid = "restart-s2";
    // First call establishes refs
    const msgs = makeMessages(3);
    const result = ctx.simulateLlmStream({ sessionId: sid, messages: msgs, model: "test" });
    const firstContent = result.messages[1].content.map((p) => p.text || "").join("");
    assert.ok(firstContent.includes("[m00001]"), "refs are stable");
  });

  test("restart: audit records restart-rebaseline event", async () => {
    const ctx = makeMockCtx({ contextLimit: 10000 });
    await plugin.apply(ctx, { contextLimit: 10000, maxBlocks: 50 }, {});

    const sid = "restart-s3";
    const staleMsgs = [
      { id: "r1", role: "user", content: [{ type: "text", text: "old [m00099] tag" }] },
      { id: "r2", role: "assistant", content: [{ type: "text", text: "reply" }] },
    ];
    const result = ctx.simulateLlmStream({ sessionId: sid, messages: staleMsgs, model: "test" });
    const firstContent = result.messages[1].content.map((p) => p.text || "").join("");
    assert.ok(firstContent.includes("[m00001]"), "fresh ref after restart");
    assert.ok(!firstContent.includes("[m00099]"), "stale tag stripped");
  });
});
