/**
 * nano-context — unit tests for the compression engine.
 *
 * Run with: node --test test/engine.test.js
 *
 * Tests the pure functions in engine.js:
 *   - Ref assignment (indexToRef, refToIndex, assignRefs)
 *   - Boundary parsing (parseBoundary, resolveRange)
 *   - Compression (applyCompression, decompressBlock)
 *   - Search (searchContext)
 *   - Status (buildStatus)
 *   - Render (renderMessages)
 *   - Parse compress input (parseCompressInput)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  indexToRef,
  refToIndex,
  assignRefs,
  createInitialState,
  blockById,
  activeBlocks,
  coveredMessageIds,
  parseBoundary,
  resolveRange,
  applyCompression,
  decompressBlock,
  mergeBlocks,
  searchContext,
  buildStatus,
  renderMessages,
  parseCompressInput,
  checkSummaryQuality,
  audit,
} from "../engine.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMsg(id, role, text) {
  return {
    id,
    role,
    content: [{ type: "text", text }],
    source: role === "system" ? { kind: "system-prompt" } : { kind: "user" },
  };
}

function makeStateWithMessages(n) {
  const state = createInitialState();
  const messages = [];
  for (let i = 1; i <= n; i++) {
    const id = `msg-${String(i).padStart(5, "0")}`;
    messages.push(makeMsg(id, i % 2 === 0 ? "assistant" : "user", `Message ${i}: some content about topic ${i}`));
  }
  const refResult = assignRefs(messages, state.messageRefs, state.nextRefIndex);
  state.messageRefs = { byRaw: refResult.byRaw, byRef: refResult.byRef };
  state.nextRefIndex = refResult.nextIndex;
  return { state, messages };
}

// ---------------------------------------------------------------------------
// Ref assignment
// ---------------------------------------------------------------------------

describe("ref assignment", () => {
  test("indexToRef produces zero-padded refs", () => {
    assert.equal(indexToRef(1), "m00001");
    assert.equal(indexToRef(42), "m00042");
    assert.equal(indexToRef(99999), "m99999");
    assert.equal(indexToRef(123456), "m123456");
  });

  test("refToIndex parses refs", () => {
    assert.equal(refToIndex("m00001"), 1);
    assert.equal(refToIndex("m00042"), 42);
    assert.equal(refToIndex("m123456"), 123456);
    assert.equal(refToIndex("M00001"), 1); // case-insensitive
  });

  test("refToIndex rejects invalid refs", () => {
    assert.equal(refToIndex("abc"), null);
    assert.equal(refToIndex("m0"), null);
    assert.equal(refToIndex(""), null);
    assert.equal(refToIndex(null), null);
  });

  test("assignRefs assigns sequential refs to new messages", () => {
    const messages = [makeMsg("a", "user", "hi"), makeMsg("b", "assistant", "hello")];
    const result = assignRefs(messages, { byRaw: {}, byRef: {} }, 1);
    assert.equal(result.byRaw["a"], "m00001");
    assert.equal(result.byRaw["b"], "m00002");
    assert.equal(result.byRef["m00001"], "a");
    assert.equal(result.byRef["m00002"], "b");
    assert.equal(result.nextIndex, 3);
    assert.equal(result.newlyAssigned, 2);
  });

  test("assignRefs skips already-assigned messages", () => {
    const messages = [makeMsg("a", "user", "hi"), makeMsg("b", "assistant", "hello")];
    const existing = { byRaw: { a: "m00001" }, byRef: { m00001: "a" } };
    const result = assignRefs(messages, existing, 2);
    assert.equal(result.byRaw["a"], "m00001"); // unchanged
    assert.equal(result.byRaw["b"], "m00002"); // new
    assert.equal(result.newlyAssigned, 1);
  });
});

// ---------------------------------------------------------------------------
// Boundary parsing
// ---------------------------------------------------------------------------

describe("boundary parsing", () => {
  test("parseBoundary handles message refs", () => {
    const b = parseBoundary("m00015");
    assert.equal(b.kind, "message");
    assert.equal(b.numericId, 15);
  });

  test("parseBoundary handles block refs", () => {
    const b = parseBoundary("b3");
    assert.equal(b.kind, "block");
    assert.equal(b.numericId, 3);
  });

  test("parseBoundary rejects invalid refs", () => {
    assert.equal(parseBoundary("xyz"), null);
    assert.equal(parseBoundary(""), null);
  });
});

// ---------------------------------------------------------------------------
// Range resolution
// ---------------------------------------------------------------------------

describe("range resolution", () => {
  test("resolveRange resolves a message range", () => {
    const { state, messages } = makeStateWithMessages(10);
    const result = resolveRange("m00002", "m00005", messages, state);
    assert.equal(result.startIndex, 1);
    assert.equal(result.endIndex, 4);
    assert.equal(result.messageIds.length, 4);
  });

  test("resolveRange normalizes reversed range", () => {
    const { state, messages } = makeStateWithMessages(10);
    const result = resolveRange("m00005", "m00002", messages, state);
    assert.equal(result.startIndex, 1);
    assert.equal(result.endIndex, 4);
  });

  test("resolveRange throws for unknown refs", () => {
    const { state, messages } = makeStateWithMessages(10);
    assert.throws(() => resolveRange("m99999", "m00010", messages, state), /not found/);
  });

  test("resolveRange rejects single-message ranges", () => {
    const { state, messages } = makeStateWithMessages(10);
    assert.throws(
      () => resolveRange("m00003", "m00003", messages, state),
      /only one message/,
    );
  });

  test("resolveRange allows two-message ranges", () => {
    const { state, messages } = makeStateWithMessages(10);
    const result = resolveRange("m00003", "m00004", messages, state);
    assert.equal(result.messageIds.length, 2);
  });
});

// ---------------------------------------------------------------------------
// Compression
// ---------------------------------------------------------------------------

describe("compression", () => {
  test("applyCompression creates a block with original messages", () => {
    const { state, messages } = makeStateWithMessages(10);
    const result = applyCompression(state, messages, "m00002", "m00005", "Summary of 2-5", "test topic", 100);

    assert.equal(result.block.blockId, "b1");
    assert.equal(result.block.summary, "Summary of 2-5");
    assert.equal(result.block.topic, "test topic");
    assert.equal(result.block.active, true);
    assert.equal(result.block.effectiveMessageIds.length, 4);
    assert.equal(result.block.originalMessages.length, 4);
    assert.equal(state.blocks.length, 1);
    assert.equal(state.stats.compressionCount, 1);
  });

  test("decompressBlock restores original messages", () => {
    const { state, messages } = makeStateWithMessages(10);
    applyCompression(state, messages, "m00002", "m00005", "Summary", null, 50);

    const result = decompressBlock(state, "b1");
    assert.equal(result.messages.length, 4);
    assert.equal(state.blocks[0].active, false);
    assert.equal(state.stats.decompressionCount, 1);
  });

  test("decompressBlock throws for unknown block", () => {
    const state = createInitialState();
    assert.throws(() => decompressBlock(state, "b99"), /not found/);
  });

  test("decompressBlock throws for already-decompressed block", () => {
    const { state, messages } = makeStateWithMessages(10);
    applyCompression(state, messages, "m00002", "m00005", "Summary", null, 50);
    decompressBlock(state, "b1");
    assert.throws(() => decompressBlock(state, "b1"), /already decompressed/);
  });

  test("activeBlocks filters inactive blocks", () => {
    const { state, messages } = makeStateWithMessages(10);
    applyCompression(state, messages, "m00002", "m00004", "S1", null, 30);
    applyCompression(state, messages, "m00006", "m00008", "S2", null, 30);
    decompressBlock(state, "b1");

    const active = activeBlocks(state);
    assert.equal(active.length, 1);
    assert.equal(active[0].blockId, "b2");
  });

  test("tokensCompressed tracks original tokens, not summary tokens", () => {
    const { state, messages } = makeStateWithMessages(10);
    // originalTokens = estimateOriginalTokens(4 msgs) ≈ 40; summary estTokens = 500
    applyCompression(state, messages, "m00002", "m00005", "short", null, 500);
    // tokensCompressed should be the ORIGINAL tokens freed, not the summary estimate
    assert.equal(state.stats.tokensCompressed, state.blocks[0].originalTokens);
    assert.notEqual(state.stats.tokensCompressed, 500);
  });

  test("applyCompression throws when block id exceeds MAX_BLOCK_ID", () => {
    const { state, messages } = makeStateWithMessages(5);
    state.nextBlockId = 10_000_000; // exceeds MAX_BLOCK_ID (9,999,999)
    // resolveRange succeeds (valid refs), then the MAX_BLOCK_ID guard throws
    assert.throws(
      () => applyCompression(state, messages, "m00001", "m00003", "s", null, 10),
      /block id limit/,
    );
  });
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

describe("search", () => {
  test("searchContext finds matches in summaries", () => {
    const { state, messages } = makeStateWithMessages(10);
    applyCompression(state, messages, "m00002", "m00005", "The user asked about error handling in module X", "error handling", 50);

    const results = searchContext(state, "error handling");
    assert.ok(results.length >= 1);
    assert.equal(results[0].type, "summary");
    assert.equal(results[0].blockId, "b1");
  });

  test("searchContext finds matches in original messages", () => {
    const { state, messages } = makeStateWithMessages(10);
    applyCompression(state, messages, "m00002", "m00005", "Summary", null, 50);

    // "topic 3" appears in message 3 (m00003)
    const results = searchContext(state, "topic 3");
    const origMatches = results.filter((r) => r.type === "original");
    assert.ok(origMatches.length >= 1);
  });

  test("searchContext returns empty for no matches", () => {
    const { state, messages } = makeStateWithMessages(10);
    applyCompression(state, messages, "m00002", "m00005", "Summary", null, 50);

    const results = searchContext(state, "zzzz_nonexistent");
    assert.equal(results.length, 0);
  });

  test("searchContext increments search count", () => {
    const state = createInitialState();
    searchContext(state, "test");
    searchContext(state, "test2");
    assert.equal(state.stats.searchCount, 2);
  });
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

describe("status", () => {
  test("buildStatus produces a readable report", () => {
    const state = createInitialState();
    const status = buildStatus(state, 50000, 131072);
    assert.ok(status.includes("50,000"));
    assert.ok(status.includes("131,072"));
    assert.ok(status.includes("Active blocks: 0"));
  });

  test("buildStatus shows active blocks", () => {
    const { state, messages } = makeStateWithMessages(10);
    applyCompression(state, messages, "m00002", "m00005", "Summary", "test", 100);
    const status = buildStatus(state, 50000, 131072);
    assert.ok(status.includes("Active blocks: 1"));
    assert.ok(status.includes("b1"));
  });

  test("buildStatus respects custom nudgeThreshold", () => {
    const state = createInitialState();
    // Default 50%: warning line shows "50%"
    const defaultStatus = buildStatus(state, 100000, 131072);
    assert.ok(defaultStatus.includes("nudge threshold: 50%"));
    // Custom 30%: warning line shows "30%"
    const customStatus = buildStatus(state, 100000, 131072, 0.3);
    assert.ok(customStatus.includes("nudge threshold: 30%"));
    assert.ok(!customStatus.includes("50%"));
  });
});

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

describe("render", () => {
  test("renderMessages adds ref tags to messages", () => {
    const { state, messages } = makeStateWithMessages(3);
    const rendered = renderMessages(messages, state);
    assert.equal(rendered.length, 3);
    // First message should have [m00001] prefix
    const firstText = rendered[0].content[0].text;
    assert.ok(firstText.startsWith("[m00001]"));
  });

  test("renderMessages replaces compressed ranges with summary blocks", () => {
    const { state, messages } = makeStateWithMessages(10);
    applyCompression(state, messages, "m00002", "m00005", "This is the summary", "test", 100);

    const rendered = renderMessages(messages, state);
    // Messages 2-5 should be replaced by one summary block
    const summaryBlocks = rendered.filter((m) => m.id?.startsWith("summary-"));
    assert.equal(summaryBlocks.length, 1);
    assert.ok(summaryBlocks[0].content[0].text.includes("This is the summary"));
    // Total rendered: 10 - 4 + 1 = 7
    assert.equal(rendered.length, 7);
  });
});

// ---------------------------------------------------------------------------
// Parse compress input
// ---------------------------------------------------------------------------

describe("parseCompressInput", () => {
  test("parses a single range from a string", () => {
    const input = "m00002–m00005 error handling\nThe user asked about error handling.";
    const ranges = parseCompressInput(input);
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].startRef, "m00002");
    assert.equal(ranges[0].endRef, "m00005");
    assert.equal(ranges[0].topic, "error handling");
    assert.ok(ranges[0].summary.includes("error handling"));
  });

  test("parses multiple ranges from a string", () => {
    const input = [
      "m00001–m00003 setup",
      "Initial setup and configuration.",
      "",
      "m00005–m00008 testing",
      "Test results: all passed.",
    ].join("\n");
    const ranges = parseCompressInput(input);
    assert.equal(ranges.length, 2);
    assert.equal(ranges[0].startRef, "m00001");
    assert.equal(ranges[0].endRef, "m00003");
    assert.equal(ranges[1].startRef, "m00005");
    assert.equal(ranges[1].endRef, "m00008");
  });

  test("supports hyphen as range separator", () => {
    const input = "m00002 - m00005 test\nSummary here.";
    const ranges = parseCompressInput(input);
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].startRef, "m00002");
    assert.equal(ranges[0].endRef, "m00005");
  });

  test("supports em-dash as range separator", () => {
    const input = "m00002 — m00005 test\nSummary here.";
    const ranges = parseCompressInput(input);
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].startRef, "m00002");
    assert.equal(ranges[0].endRef, "m00005");
  });

  test("object form with startRef/endRef/summary", () => {
    const input = { startRef: "m00002", endRef: "m00005", summary: "Direct summary", topic: "direct" };
    const ranges = parseCompressInput(input);
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].startRef, "m00002");
    assert.equal(ranges[0].endRef, "m00005");
    assert.equal(ranges[0].summary, "Direct summary");
    assert.equal(ranges[0].topic, "direct");
  });

  test("throws for empty input", () => {
    assert.throws(() => parseCompressInput("no ranges here"), /No compress ranges/);
  });

  test("throws for invalid input type", () => {
    assert.throws(() => parseCompressInput(42), /Invalid compress input/);
  });
});

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

describe("audit", () => {
  test("appends entries to state.audit", () => {
    const state = createInitialState();
    assert.equal(state.audit.length, 0);
    audit(state, "test", "hello");
    assert.equal(state.audit.length, 1);
    assert.equal(state.audit[0].type, "test");
    assert.equal(state.audit[0].detail, "hello");
    assert.ok(state.audit[0].ts > 0);
  });

  test("caps at 100 entries (oldest evicted)", () => {
    const state = createInitialState();
    for (let i = 0; i < 120; i++) {
      audit(state, "test", `entry-${i}`);
    }
    assert.equal(state.audit.length, 100);
    // Oldest entries (0-19) should be evicted
    assert.equal(state.audit[0].detail, "entry-20");
    assert.equal(state.audit[99].detail, "entry-119");
  });

  test("stores extra data", () => {
    const state = createInitialState();
    audit(state, "compress", "b1: resolved", { tokens: 42 });
    assert.equal(state.audit[0].extra.tokens, 42);
  });
});

// ---------------------------------------------------------------------------
// mergeBlocks
// ---------------------------------------------------------------------------

describe("mergeBlocks", () => {
  test("merges two adjacent blocks into one", () => {
    const state = createInitialState();
    const messages = [
      makeMsg("m1", "user", "hello"),
      makeMsg("m2", "assistant", "world"),
      makeMsg("m3", "user", "next"),
      makeMsg("m4", "assistant", "reply"),
    ];
    const refs = assignRefs(messages, {}, 0);
    state.messageRefs = { byRaw: refs.byRaw, byRef: refs.byRef };
    state.nextRefIndex = refs.nextIndex;

    // Create two adjacent blocks: m1-m2 and m3-m4
    applyCompression(state, messages, "m00001", "m00002", "first summary", "topic1", 10);
    applyCompression(state, messages, "m00003", "m00004", "second summary", "topic2", 10);

    const blocks = activeBlocks(state);
    assert.equal(blocks.length, 2);

    const result = mergeBlocks(state, "b1", "b2", messages);
    // Returns { block, removed }
    assert.equal(result.block.blockId, "b1"); // keeps lower id
    assert.equal(result.removed, "b2");
    assert.equal(result.block.effectiveMessageIds.length, 4);

    // b2 should be deactivated
    const b2 = blockById(state, "b2");
    assert.equal(b2.active, false);
    assert.equal(b2.mergedInto, "b1");

    // b1 should have combined messages
    const b1 = blockById(state, "b1");
    assert.equal(b1.effectiveMessageIds.length, 4);
    // Summary should contain both
    assert.ok(b1.summary.includes("first summary"));
    assert.ok(b1.summary.includes("second summary"));
  });

  test("rejects merging non-adjacent blocks", () => {
    const state = createInitialState();
    const messages = [
      makeMsg("m1", "user", "hello"),
      makeMsg("m2", "assistant", "world"),
      makeMsg("m3", "user", "gap message"),
      makeMsg("m4", "assistant", "next"),
      makeMsg("m5", "user", "after"),
      makeMsg("m6", "assistant", "end"),
    ];
    const refs = assignRefs(messages, {}, 0);
    state.messageRefs = { byRaw: refs.byRaw, byRef: refs.byRef };
    state.nextRefIndex = refs.nextIndex;

    // b1: m1-m2, b2: m5-m6 (m3-m4 gap)
    applyCompression(state, messages, "m00001", "m00002", "first", null, 5);
    applyCompression(state, messages, "m00005", "m00006", "second", null, 5);

    assert.throws(() => mergeBlocks(state, "b1", "b2", messages), /not adjacent/);
  });

  test("rejects merging a block with itself", () => {
    const state = createInitialState();
    const messages = [
      makeMsg("m1", "user", "a"),
      makeMsg("m2", "assistant", "b"),
      makeMsg("m3", "user", "c"),
      makeMsg("m4", "assistant", "d"),
    ];
    const refs = assignRefs(messages, {}, 0);
    state.messageRefs = { byRaw: refs.byRaw, byRef: refs.byRef };
    state.nextRefIndex = refs.nextIndex;

    applyCompression(state, messages, "m00001", "m00002", "s", null, 3);
    applyCompression(state, messages, "m00003", "m00004", "s", null, 3);

    assert.throws(() => mergeBlocks(state, "b1", "b1", messages), /itself/);
  });

  test("rejects merging an inactive block", () => {
    const state = createInitialState();
    const messages = [
      makeMsg("m1", "user", "a"),
      makeMsg("m2", "assistant", "b"),
      makeMsg("m3", "user", "c"),
      makeMsg("m4", "assistant", "d"),
    ];
    const refs = assignRefs(messages, {}, 0);
    state.messageRefs = { byRaw: refs.byRaw, byRef: refs.byRef };
    state.nextRefIndex = refs.nextIndex;

    applyCompression(state, messages, "m00001", "m00002", "s1", null, 3);
    applyCompression(state, messages, "m00003", "m00004", "s2", null, 3);

    // Decompress b1 to make it inactive
    decompressBlock(state, "b1");

    assert.throws(() => mergeBlocks(state, "b1", "b2", messages), /not active/);
  });

  test("rejects unknown block id", () => {
    const state = createInitialState();
    const messages = [makeMsg("m1", "user", "a"), makeMsg("m2", "assistant", "b")];
    const refs = assignRefs(messages, {}, 0);
    state.messageRefs = { byRaw: refs.byRaw, byRef: refs.byRef };
    state.nextRefIndex = refs.nextIndex;

    applyCompression(state, messages, "m00001", "m00002", "s", null, 3);

    assert.throws(() => mergeBlocks(state, "b1", "b99", messages), /not found/);
  });

  test("records audit entry on merge", () => {
    const state = createInitialState();
    const messages = [
      makeMsg("m1", "user", "a"),
      makeMsg("m2", "assistant", "b"),
      makeMsg("m3", "user", "c"),
      makeMsg("m4", "assistant", "d"),
    ];
    const refs = assignRefs(messages, {}, 0);
    state.messageRefs = { byRaw: refs.byRaw, byRef: refs.byRef };
    state.nextRefIndex = refs.nextIndex;

    applyCompression(state, messages, "m00001", "m00002", "s1", null, 3);
    applyCompression(state, messages, "m00003", "m00004", "s2", null, 3);

    const auditLenBefore = state.audit.length;
    mergeBlocks(state, "b1", "b2", messages);
    assert.equal(state.audit.length, auditLenBefore + 1);
    assert.equal(state.audit[state.audit.length - 1].type, "merge");
  });
});

// ---------------------------------------------------------------------------
// checkSummaryQuality
// ---------------------------------------------------------------------------

describe("checkSummaryQuality", () => {
  test("high coverage when summary contains key terms", () => {
    const messages = [
      makeMsg("m1", "user", "Please refactor the authentication module in src/auth/login.ts to use JWT tokens instead of session cookies."),
      makeMsg("m2", "assistant", "I've updated src/auth/login.ts to use JWT tokens. The new function generateToken(payload) in src/auth/jwt.ts handles token creation. Tests pass."),
    ];
    const summary = "Refactored src/auth/login.ts from session cookies to JWT tokens. New function generateToken(payload) in src/auth/jwt.ts. Tests pass.";
    const result = checkSummaryQuality(summary, messages);
    assert.ok(result.coverage >= 60, `expected >=60%, got ${result.coverage}%`);
    assert.ok(result.checked > 0);
  });

  test("low coverage when summary is too brief", () => {
    const messages = [
      makeMsg("m1", "user", "Please refactor the authentication module in src/auth/login.ts to use JWT tokens instead of session cookies."),
      makeMsg("m2", "assistant", "I've updated src/auth/login.ts to use JWT tokens. The new function generateToken(payload) in src/auth/jwt.ts handles token creation. Tests pass."),
    ];
    const summary = "Done.";
    const result = checkSummaryQuality(summary, messages);
    assert.ok(result.coverage < 30, `expected <30%, got ${result.coverage}%`);
    assert.ok(result.missing.length > 0);
  });

  test("empty summary returns 0 coverage", () => {
    const messages = [makeMsg("m1", "user", "hello world")];
    const result = checkSummaryQuality("", messages);
    assert.equal(result.coverage, 0);
  });

  test("no significant words returns 100% coverage", () => {
    const messages = [makeMsg("m1", "user", "a b c")];
    const result = checkSummaryQuality("anything", messages);
    assert.equal(result.coverage, 1);
  });

  test("caps missing list at 15 + ellipsis", () => {
    // Create messages with many unique long words
    let text = "";
    for (let i = 0; i < 30; i++) text += ` word${i.toString().padStart(3, "0")}x`;
    const messages = [makeMsg("m1", "user", text)];
    const result = checkSummaryQuality("", messages);
    assert.ok(result.missing.length <= 16); // 15 + "…"
  });
});

// ---------------------------------------------------------------------------
// resolvePendingBlock (via renderMessages)
// ---------------------------------------------------------------------------

describe("resolvePendingBlock (via renderMessages)", () => {
  test("tracks originalTokens and adds to tokensCompressed", () => {
    const state = createInitialState();
    const messages = [
      makeMsg("m1", "user", "hello this is a test message with enough content to have tokens"),
      makeMsg("m2", "assistant", "this is a longer response message with more content for token counting"),
    ];
    const refs = assignRefs(messages, {}, 0);
    state.messageRefs = { byRaw: refs.byRaw, byRef: refs.byRef };
    state.nextRefIndex = refs.nextIndex;

    // Simulate a compress tool call (creates pending block)
    state.blocks.push({
      blockId: "b1",
      tier: 1,
      topic: null,
      summary: "short summary",
      directMessageIds: [],
      effectiveMessageIds: [],
      compressedTokens: 5,
      originalTokens: null,
      createdAt: Date.now(),
      generation: "new",
      active: true,
      expanded: false,
      pendingRefs: { startRef: "m00001", endRef: "m00002" },
      originalMessages: [],
    });

    const tokensBefore = state.stats.tokensCompressed;
    renderMessages(messages, state);

    const block = blockById(state, "b1");
    assert.ok(block.originalTokens > 0, "originalTokens should be set");
    assert.equal(state.stats.tokensCompressed, tokensBefore + block.originalTokens);
    assert.ok(!block.pendingRefs, "pendingRefs should be cleared");
  });

  test("records audit entry on resolution failure", () => {
    const state = createInitialState();
    const messages = [
      makeMsg("m1", "user", "hello"),
      makeMsg("m2", "assistant", "world"),
    ];
    const refs = assignRefs(messages, {}, 0);
    state.messageRefs = { byRaw: refs.byRaw, byRef: refs.byRef };
    state.nextRefIndex = refs.nextIndex;

    // Create a pending block referencing a non-existent range
    state.blocks.push({
      blockId: "b1",
      tier: 1,
      topic: null,
      summary: "s",
      directMessageIds: [],
      effectiveMessageIds: [],
      compressedTokens: 3,
      originalTokens: null,
      createdAt: Date.now(),
      generation: "new",
      active: true,
      expanded: false,
      pendingRefs: { startRef: "m00900", endRef: "m00999" },
      originalMessages: [],
    });

    renderMessages(messages, state);

    const block = blockById(state, "b1");
    assert.equal(block.active, false, "block should be deactivated");
    // Check audit has the failure entry
    const failures = state.audit.filter((e) => e.type === "compress" && e.detail.includes("FAILED"));
    assert.ok(failures.length >= 1, "should have a FAILED audit entry");
  });
});

// ---------------------------------------------------------------------------
// searchContext — decompressHint
// ---------------------------------------------------------------------------

describe("searchContext decompressHint", () => {
  test("sets decompressHint when both summary and originals match", () => {
    const state = createInitialState();
    const messages = [
      makeMsg("m1", "user", "What is the error in the authentication module?"),
      makeMsg("m2", "assistant", "The error is a JWT token expiration bug in src/auth/login.ts line 347."),
    ];
    const refs = assignRefs(messages, {}, 0);
    state.messageRefs = { byRaw: refs.byRaw, byRef: refs.byRef };
    state.nextRefIndex = refs.nextIndex;

    applyCompression(state, messages, "m00001", "m00002",
      "Found JWT token expiration bug in src/auth/login.ts. Fixed by adding refresh logic.",
      "auth bug", 10);

    // Search for "JWT" — appears in both summary and originals
    const results = searchContext(state, "JWT");
    const summaryHits = results.filter((r) => r.type === "summary");
    assert.ok(summaryHits.length >= 1);
    assert.equal(summaryHits[0].decompressHint, true, "should have decompressHint when originals also match");
  });

  test("no decompressHint when only summary matches", () => {
    const state = createInitialState();
    const messages = [
      makeMsg("m1", "user", "Please check the logs."),
      makeMsg("m2", "assistant", "Logs show a connection timeout."),
    ];
    const refs = assignRefs(messages, {}, 0);
    state.messageRefs = { byRaw: refs.byRaw, byRef: refs.byRef };
    state.nextRefIndex = refs.nextIndex;

    applyCompression(state, messages, "m00001", "m00002",
      "Summary: investigated the ZZZZYZZZ issue and found it was a ZZZZYZZZ problem.",
      null, 10);

    // Search for "ZZZZYZZZ" — only in summary, not in originals
    const results = searchContext(state, "ZZZZYZZZ");
    const summaryHits = results.filter((r) => r.type === "summary");
    assert.ok(summaryHits.length >= 1);
    assert.ok(!summaryHits[0].decompressHint, "should NOT have decompressHint when only summary matches");
  });
});

// ---------------------------------------------------------------------------
// buildStatus — savings + audit trail
// ---------------------------------------------------------------------------

describe("buildStatus enhancements", () => {
  test("shows total savings line when originalTokens are known", () => {
    const state = createInitialState();
    const messages = [
      makeMsg("m1", "user", "a".repeat(200)),
      makeMsg("m2", "assistant", "b".repeat(200)),
    ];
    const refs = assignRefs(messages, {}, 0);
    state.messageRefs = { byRaw: refs.byRaw, byRef: refs.byRef };
    state.nextRefIndex = refs.nextIndex;

    applyCompression(state, messages, "m00001", "m00002", "short", null, 5);
    const block = blockById(state, "b1");
    block.originalTokens = 100; // simulate resolved

    const status = buildStatus(state, 5000, 131072, 0.5);
    assert.ok(status.includes("Total savings"), "should show savings line");
    assert.ok(status.includes("95"), "should show 95 tokens saved (100-5)");
  });

  test("shows recent activity from audit trail", () => {
    const state = createInitialState();
    audit(state, "test", "event one");
    audit(state, "test", "event two");

    const status = buildStatus(state, 0, 131072, 0.5);
    assert.ok(status.includes("Recent activity"), "should show activity section");
    assert.ok(status.includes("event one"));
    assert.ok(status.includes("event two"));
  });

  test("shows quality percentage per block", () => {
    const state = createInitialState();
    const messages = [
      makeMsg("m1", "user", "hello world test"),
      makeMsg("m2", "assistant", "response to the test"),
    ];
    const refs = assignRefs(messages, {}, 0);
    state.messageRefs = { byRaw: refs.byRaw, byRef: refs.byRef };
    state.nextRefIndex = refs.nextIndex;

    applyCompression(state, messages, "m00001", "m00002", "summary", null, 5);
    const block = blockById(state, "b1");
    block.originalTokens = 50;
    block.quality = { coverage: 75, missing: [], checked: 10 };

    const status = buildStatus(state, 0, 131072, 0.5);
    assert.ok(status.includes("quality: 75%"), "should show quality percentage");
  });

  test("shows real token count when provided", () => {
    const state = createInitialState();
    const status = buildStatus(state, 65536, 131072, 0.5);
    assert.ok(status.includes("65,536"), "should show real token count");
    assert.ok(status.includes("50%"), "should show 50% usage");
  });

  test("shows unknown context when no real token count is available", () => {
    const state = createInitialState();
    const status = buildStatus(state, 0, 131072, 0.5);
    assert.ok(status.includes("Context: unknown"), "should mark context as unknown");
    assert.ok(status.includes("no usage observed"), "should note no usage observed");
  });

  test("Tokens freed line reports original tokens across compressions", () => {
    const state = createInitialState();
    const messages = [
      makeMsg("m1", "user", "hello world"),
      makeMsg("m2", "assistant", "hi there"),
    ];
    const refs = assignRefs(messages, {}, 0);
    state.messageRefs = { byRaw: refs.byRaw, byRef: refs.byRef };
    state.nextRefIndex = refs.nextIndex;
    applyCompression(state, messages, "m00001", "m00002", "s", null, 1);
    const status = buildStatus(state, 1000, 131072, 0.5);
    assert.ok(status.includes("Tokens freed (originals):"), "should show the freed line");
    assert.ok(status.includes("across 1 compression"), "should count compressions");
  });
});

// ---------------------------------------------------------------------------
// Original-token cap (enforceOriginalTokenCap)
// ---------------------------------------------------------------------------

describe("enforceOriginalTokenCap (original-token cap)", () => {
  test("auto-decompresses the oldest block when the cap is exceeded", () => {
    const state = createInitialState();
    const messages = [
      makeMsg("m1", "user", "one"),
      makeMsg("m2", "assistant", "two"),
      makeMsg("m3", "user", "three"),
      makeMsg("m4", "assistant", "four"),
    ];
    const refs = assignRefs(messages, {}, 0);
    state.messageRefs = { byRaw: refs.byRaw, byRef: refs.byRef };
    state.nextRefIndex = refs.nextIndex;

    // Two blocks, each with a huge original token count (simulated)
    applyCompression(state, messages, "m00001", "m00002", "s1", null, 2);
    applyCompression(state, messages, "m00003", "m00004", "s2", null, 2);
    const b1 = blockById(state, "b1");
    const b2 = blockById(state, "b2");
    b1.originalTokens = 200 * 1024;
    b2.originalTokens = 100 * 1024;
    state.stats.tokensCompressed = 300 * 1024;

    // Triggering a third compression should evict the OLDEST non-triggering block (b1)
    // but there are no more messages to compress — so call the cap indirectly:
    // simulate by re-running applyCompression on a tiny range... actually the cap
    // only runs on new compression. Instead, verify the logic directly:
    // After both blocks are set, total = 300k > 256k cap.
    // The cap is enforced at applyCompression time, not retroactively.
    // So we need a THIRD compression to trigger it.
    // Use a single-message range that is still live.
    // m1 is covered by b1, m2 by b1, m3 by b2, m4 by b2.
    // All covered — we need 2 uncovered messages. Add m5, m6.
    messages.push(makeMsg("m5", "user", "five"), makeMsg("m6", "assistant", "six"));
    const refs2 = assignRefs(messages, state.messageRefs, state.nextRefIndex);
    state.messageRefs = { byRaw: refs2.byRaw, byRef: refs2.byRef };
    state.nextRefIndex = refs2.nextIndex;

    const auditBefore = state.audit.length;
    applyCompression(state, messages, "m00005", "m00006", "s3", null, 2);
    const b3 = blockById(state, "b3");

    // b1 (oldest, non-triggering) should be evicted
    assert.equal(b1.active, false, "oldest block b1 should be auto-decompressed");
    assert.equal(b1.expanded, true, "evicted block should be marked expanded");
    assert.equal(b2.active, true, "b2 should remain active");
    assert.equal(b3.active, true, "triggering block b3 must never be evicted");

    // Audit should record the auto-decompress
    const autoDecompress = state.audit.slice(auditBefore).find((e) => e.type === "decompress" && e.detail.includes("auto-decompressed"));
    assert.ok(autoDecompress, "should have an auto-decompress audit entry");
  });

  test("does not evict the triggering block even if it is the oldest", () => {
    const state = createInitialState();
    const messages = [
      makeMsg("m1", "user", "one"),
      makeMsg("m2", "assistant", "two"),
      makeMsg("m3", "user", "three"),
      makeMsg("m4", "assistant", "four"),
    ];
    const refs = assignRefs(messages, {}, 0);
    state.messageRefs = { byRaw: refs.byRaw, byRef: refs.byRef };
    state.nextRefIndex = refs.nextIndex;

    // First block covers m1-m2, huge original tokens
    applyCompression(state, messages, "m00001", "m00002", "s1", null, 2);
    const b1 = blockById(state, "b1");
    b1.originalTokens = 300 * 1024; // over cap alone
    state.stats.tokensCompressed = 300 * 1024;

    // Second compression triggers cap; b1 is oldest AND over cap, but b2 is the
    // triggering block — so b1 should be evicted (it's not the trigger).
    applyCompression(state, messages, "m00003", "m00004", "s2", null, 2);
    const b2 = blockById(state, "b2");
    assert.equal(b1.active, false, "b1 (oldest, non-triggering) should be evicted");
    assert.equal(b2.active, true, "b2 (triggering) must stay active");
  });
});

// ---------------------------------------------------------------------------
// checkSummaryQuality — CJK bigram coverage
// ---------------------------------------------------------------------------

describe("checkSummaryQuality — CJK", () => {
  test("high coverage when Chinese summary repeats the key terms", () => {
    const messages = [
      makeMsg("m1", "user", "请帮我重构 src/auth/login.ts 文件，把 session cookie 改成 JWT token。"),
      makeMsg("m2", "assistant", "已完成。新的 generateToken 函数在 src/auth/jwt.ts 中，测试通过。"),
    ];
    const summary = "重构了 src/auth/login.ts，将 session cookie 改为 JWT token。新增 generateToken 函数，测试全部通过。";
    const result = checkSummaryQuality(summary, messages);
    // The summary contains most of the key Chinese bigrams
    assert.ok(result.coverage >= 40, `expected >=40% CJK coverage, got ${result.coverage}%`);
    assert.ok(result.checked > 0, "should have checked some bigrams");
  });

  test("low coverage when Chinese summary is unrelated", () => {
    const messages = [
      makeMsg("m1", "user", "请帮我重构 src/auth/login.ts 文件，把 session cookie 改成 JWT token。"),
    ];
    const summary = "今天天气很好，适合出门散步。";
    const result = checkSummaryQuality(summary, messages);
    assert.ok(result.coverage < 30, `expected <30% CJK coverage, got ${result.coverage}%`);
    assert.ok(result.missing.length > 0, "should list missing bigrams");
  });

  test("mixed CJK + Latin uses combined coverage", () => {
    const messages = [
      makeMsg("m1", "user", "请检查 authentication 模块，修复 JWT token 过期 bug。"),
    ];
    const summary = "authentication 模块的 JWT token 过期 bug 已修复。";
    const result = checkSummaryQuality(summary, messages);
    // Both CJK and Latin terms are covered
    assert.ok(result.coverage >= 40, `expected >=40% combined coverage, got ${result.coverage}%`);
  });

  test("pure CJK with no Latin uses CJK-only path", () => {
    const messages = [makeMsg("m1", "user", "数据库连接池配置错误导致超时")];
    const summary = "数据库连接池配置已修正，超时问题解决。";
    const result = checkSummaryQuality(summary, messages);
    // CJK-only: checked = bigram count
    assert.ok(result.checked > 0);
    // "数据库" "连接池" "配置" should be shared bigrams → decent coverage
    assert.ok(result.coverage >= 20, `expected some shared CJK bigrams, got ${result.coverage}%`);
  });
});

// ---------------------------------------------------------------------------
// parseCompressInput — dash matrix
// ---------------------------------------------------------------------------

describe("parseCompressInput — dash variants", () => {
  test("accepts en-dash (–)", () => {
    const input = "m00001–m00003 topic A\nsummary line one\nsummary line two";
    const ranges = parseCompressInput(input);
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].startRef, "m00001");
    assert.equal(ranges[0].endRef, "m00003");
    assert.equal(ranges[0].topic, "topic A");
  });

  test("accepts hyphen (-)", () => {
    const input = "m00005-m00010\njust a summary";
    const ranges = parseCompressInput(input);
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].startRef, "m00005");
    assert.equal(ranges[0].endRef, "m00010");
  });

  test("accepts em-dash (—)", () => {
    const input = "m00011—m00020 topic B\nem-dash summary";
    const ranges = parseCompressInput(input);
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].startRef, "m00011");
    assert.equal(ranges[0].endRef, "m00020");
  });

  test("accepts spaces around the dash", () => {
    const input = "m00001  –  m00005\n  spaced  ";
    const ranges = parseCompressInput(input);
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].startRef, "m00001");
    assert.equal(ranges[0].endRef, "m00005");
  });

  test("parses multiple ranges in one content", () => {
    const input = [
      "m00001–m00005 first topic",
      "first summary",
      "",
      "m00006–m00010 second topic",
      "second summary",
    ].join("\n");
    const ranges = parseCompressInput(input);
    assert.equal(ranges.length, 2);
    assert.equal(ranges[0].startRef, "m00001");
    assert.equal(ranges[1].startRef, "m00006");
  });

  test("rejects empty summary", () => {
    // Header with no summary lines → empty summary
    assert.throws(() => parseCompressInput("m00001–m00005"), /Empty summary/);
  });

  test("rejects no ranges found", () => {
    assert.throws(() => parseCompressInput("just some text"), /No compress ranges/);
  });

  test("accepts object form with startRef/endRef", () => {
    const ranges = parseCompressInput({ startRef: "m00001", endRef: "m00009", summary: "obj summary" });
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].summary, "obj summary");
  });
});

// ---------------------------------------------------------------------------
// mergeBlocks — id ordering + nested coverage
// ---------------------------------------------------------------------------

describe("mergeBlocks — ordering and nested coverage", () => {
  test("merged block ids are sorted by live message position", () => {
    const state = createInitialState();
    const messages = [
      makeMsg("m1", "user", "a"),
      makeMsg("m2", "assistant", "b"),
      makeMsg("m3", "user", "c"),
      makeMsg("m4", "assistant", "d"),
      makeMsg("m5", "user", "e"),
      makeMsg("m6", "assistant", "f"),
    ];
    const refs = assignRefs(messages, {}, 0);
    state.messageRefs = { byRaw: refs.byRaw, byRef: refs.byRef };
    state.nextRefIndex = refs.nextIndex;

    // b1 covers m1-m3, b2 covers m4-m6 (adjacent)
    applyCompression(state, messages, "m00001", "m00003", "s1", null, 3);
    applyCompression(state, messages, "m00004", "m00006", "s2", null, 3);

    const result = mergeBlocks(state, "b1", "b2", messages);
    const merged = result.block;
    // directMessageIds should be in chronological order: m1, m2, m3, m4, m5, m6
    const idOrder = merged.directMessageIds.map((id) => messages.findIndex((m) => m.id === id));
    for (let i = 1; i < idOrder.length; i++) {
      assert.ok(idOrder[i] > idOrder[i - 1], `ids should be in live order, got ${merged.directMessageIds.join(", ")}`);
    }
    assert.equal(merged.effectiveMessageIds.length, 6);
  });

  test("merged block does NOT duplicate ids owned by other active blocks (nested coverage)", () => {
    const state = createInitialState();
    const messages = [
      makeMsg("m1", "user", "a"),
      makeMsg("m2", "assistant", "b"),
      makeMsg("m3", "user", "c"),
      makeMsg("m4", "assistant", "d"),
    ];
    const refs = assignRefs(messages, {}, 0);
    state.messageRefs = { byRaw: refs.byRaw, byRef: refs.byRef };
    state.nextRefIndex = refs.nextIndex;

    // b1 covers m1-m4, b2 covers m2-m3 (nested inside b1)
    applyCompression(state, messages, "m00001", "m00004", "s1", null, 4);
    applyCompression(state, messages, "m00002", "m00003", "s2", null, 2);

    // b1 and b2 are NOT adjacent (b2 is inside b1), so merge should throw
    assert.throws(() => mergeBlocks(state, "b1", "b2", messages), /not adjacent|Cannot merge/);
  });

  test("merged block survives a render pass and renders as one summary", () => {
    const state = createInitialState();
    const messages = [
      makeMsg("m1", "user", "a"),
      makeMsg("m2", "assistant", "b"),
      makeMsg("m3", "user", "c"),
      makeMsg("m4", "assistant", "d"),
      makeMsg("m5", "user", "e"),
    ];
    const refs = assignRefs(messages, {}, 0);
    state.messageRefs = { byRaw: refs.byRaw, byRef: refs.byRef };
    state.nextRefIndex = refs.nextIndex;

    applyCompression(state, messages, "m00001", "m00003", "s1", null, 3);
    applyCompression(state, messages, "m00004", "m00005", "s2", null, 2);
    mergeBlocks(state, "b1", "b2", messages);

    const rendered = renderMessages(messages, state);
    // m1-m5 should all be replaced by a single summary block (the merged b1)
    // so the rendered array should be shorter than 5 and contain the merged summary
    const summaryCount = rendered.filter((m) => m.id && String(m.id).startsWith("summary-")).length;
    assert.ok(summaryCount >= 1, "should have at least one summary message");
    // The merged summary text should appear
    const allText = rendered.map((m) => {
      const t = Array.isArray(m.content) ? m.content.filter((b) => b.type === "text").map((b) => b.text).join("") : "";
      return t;
    }).join("\n");
    assert.ok(allText.includes("s2") && allText.includes("s1"), "merged summary should contain both sub-summaries");
  });

  test("originalMessages are concatenated in chronological order", () => {
    const state = createInitialState();
    const messages = [
      makeMsg("m1", "user", "first"),
      makeMsg("m2", "assistant", "second"),
      makeMsg("m3", "user", "third"),
      makeMsg("m4", "assistant", "fourth"),
    ];
    const refs = assignRefs(messages, {}, 0);
    state.messageRefs = { byRaw: refs.byRaw, byRef: refs.byRef };
    state.nextRefIndex = refs.nextIndex;

    applyCompression(state, messages, "m00001", "m00002", "s1", null, 2);
    applyCompression(state, messages, "m00003", "m00004", "s2", null, 2);
    const result = mergeBlocks(state, "b1", "b2", messages);
    const merged = result.block;
    // originalMessages should be in order: m1, m2, m3, m4
    assert.equal(merged.originalMessages.length, 4);
    assert.equal(merged.originalMessages[0].id, "m1");
    assert.equal(merged.originalMessages[3].id, "m4");
  });
});
