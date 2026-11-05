/**
 * nano-context — in-process context compression plugin for DSH.
 *
 * A minimal reimplementation of billion-context's model-driven compression,
 * scoped to a single local DSH + llama.cpp deployment:
 *
 *   - NO proxy, NO network egress, NO auto-update, NO MITM certs
 *   - In-process compression engine (refs, blocks, compress, decompress, search, status)
 *   - DSH-only (no multi-client adapters)
 *   - In-memory state (no MySQL, no file persistence)
 *
 * Complementary to (NOT replacing) DSH native dsh-compaction-basic:
 *   - Native compaction stays active as deterministic safety net
 *     (threshold trigger + CONTEXT_WINDOW_EXCEEDED overflow recovery + /compact)
 *   - This plugin adds model-driven, reversible, searchable compression
 *
 * Architecture (DSH 0.2.1-rc.5 / Cordis ~4.0.5):
 *   1. ctx.tools.register() — register compress/decompress/search_context/acp_status
 *   2. ctx.on("llm/stream") — waterfall: render messages (ref tags + compression)
 *   3. ctx.on("agent/assistant-stream") — observe token usage, trigger nudge
 *
 * Plugin contract:
 *   export default { name, Config, async apply(ctx, config, meta) }
 *
 * SCOPE:
 *   DSH + llama.cpp + local model, Web surface only (see README "Scope /
 *   compatibility").
 *   In-process, pure local. No external dependencies beyond cordis + zod.
 */

import { z } from "zod";
import {
  createInitialState,
  assignRefs,
  renderMessages,
  searchContext,
  buildStatus,
  parseCompressInput,
  activeBlocks,
  decompressBlock,
  blockById,
  mergeBlocks,
  audit,
  updateMetrics,
  getMetrics,
  detectAndCleanRestart,
  renderMessagesIncremental,
} from "./engine.js";
import {
  buildSystemPromptBlock,
  buildNudge,
  TOOL_DESCRIPTIONS,
} from "./prompts.js";

// ---------------------------------------------------------------------------
// Per-session state
// ---------------------------------------------------------------------------

const DEBUG_ON = !!process.env.DSH_NANO_CONTEXT_DEBUG;

function debugLog(...args) {
  if (DEBUG_ON) console.error("[nano-context]", ...args);
}

const sessionStates = new Map(); // sessionId → CompressionState (insertion order = LRU order)
const MAX_SESSIONS = 32;

/** Track the last known real token count per session (from the nudge observer). */
const lastKnownTokens = new Map(); // sessionId → number
const MAX_TOKEN_ENTRIES = 64;

/** Last token count at which each session was nudged (cooldown tracking). */
const lastNudgeTokens = new Map(); // sessionId → number
const MAX_NUDGE_ENTRIES = 64;
const NUDGE_COOLDOWN_FACTOR = 1.1;

/**
 * Evict a session's plugin state. Eviction drops its blocks, refs, and
 * stats — if that session is still active, the model will see refs it just
 * used "vanish". Log loudly so this is never invisible, and clean up the
 * per-session token maps so they can't outlive their session.
 */
function evictSession(sessionId, reason) {
  const state = sessionStates.get(sessionId);
  sessionStates.delete(sessionId);
  lastKnownTokens.delete(sessionId);
  lastNudgeTokens.delete(sessionId);
  const activeBlocks = state ? state.blocks.filter((b) => b.active).length : 0;
  console.error(
    `[nano-context] WARNING: session state for "${sessionId}" was evicted ` +
      `(${reason}, ${activeBlocks} active block(s) lost). If this session is still active, its compression refs are gone.`,
  );
  debugLog(`evicted ${sessionId}: ${reason}, ${activeBlocks} active block(s)`);
}

function getSessionState(sessionId) {
  if (!sessionId) throw new Error("nano-context: no session id");
  let state = sessionStates.get(sessionId);
  if (!state) {
    state = createInitialState();
    // LRU prune BEFORE inserting the new session: evict the least-recently-used
    if (sessionStates.size >= MAX_SESSIONS) {
      const lruKey = sessionStates.keys().next().value;
      evictSession(lruKey, "session limit reached");
    }
    sessionStates.set(sessionId, state);
  } else if (sessionStates.size > 1) {
    // Touch: move to end (most recently used)
    sessionStates.delete(sessionId);
    sessionStates.set(sessionId, state);
  }
  return state;
}

// ---------------------------------------------------------------------------
// Token estimation (rough: ~4 chars per token for mixed CJK/ASCII content)
// ---------------------------------------------------------------------------

function estimateTokens(text) {
  if (!text) return 0;
  // CJK chars are roughly 1 token each; ASCII is ~4 chars per token.
  // A rough heuristic: count CJK chars as 1 token, others as 0.25.
  let cjk = 0, other = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf)) cjk++;
    else other++;
  }
  return Math.max(1, cjk + Math.ceil(other / 4));
}

// ---------------------------------------------------------------------------
// Config defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONTEXT_LIMIT = 131072;
const DEFAULT_NUDGE_THRESHOLD = 0.7;
const DEFAULT_MAX_BLOCKS = 50;
// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export default {
  name: "nano-context",

  Config: z
    .object({
      contextLimit: z.number().int().min(4096).max(1_000_000).default(DEFAULT_CONTEXT_LIMIT),
      nudgeThreshold: z.number().min(0.1).max(0.95).default(DEFAULT_NUDGE_THRESHOLD),
      maxBlocks: z.number().int().min(1).max(200).default(DEFAULT_MAX_BLOCKS),
    })
    .default({
      contextLimit: DEFAULT_CONTEXT_LIMIT,
      nudgeThreshold: DEFAULT_NUDGE_THRESHOLD,
      maxBlocks: DEFAULT_MAX_BLOCKS,
    }),

  async apply(ctx, config, _meta) {
    const logger = ctx.logger;

    function logSafe(msg) {
      if (logger) logger.info("[nano-context] " + msg);
      if (DEBUG_ON) {
        try { process.stderr.write(`[nano-context] ${msg}\n`); } catch (_) {}
      }
    }

    // Resolve config (cordis passes validated config; fall back to defaults)
    const cfg = config && typeof config === "object" ? config : {};
    const contextLimit = cfg.contextLimit || DEFAULT_CONTEXT_LIMIT;
    const nudgeThreshold = cfg.nudgeThreshold || DEFAULT_NUDGE_THRESHOLD;
    const maxBlocks = cfg.maxBlocks || DEFAULT_MAX_BLOCKS;

    // Pre-compute the stable system prompt block (prefix-cache anchor)
    const SYSTEM_PROMPT_BLOCK = buildSystemPromptBlock();

    // -----------------------------------------------------------------------
    // 1. Register compression tools
    // -----------------------------------------------------------------------
    let toolsRegistered = false;

    function toolDefinition(toolName) {
      const desc = TOOL_DESCRIPTIONS[toolName];
      return {
        name: desc.name,
        description: desc.description,
        parameters: desc.parameters,
        output: {
          schema: { type: "string" },
          render: (_args, value) => [
            { type: "text", text: typeof value === "string" ? value : String(value ?? "") },
          ],
        },
        execute: async (args, exec) => {
          const sid = exec?.agent?.session?.id;
          if (typeof sid !== "string" || sid.length === 0) {
            throw new Error("nano-context tool requires an owning agent session");
          }
          return executeTool(toolName, args, sid, contextLimit, nudgeThreshold, maxBlocks);
        },
      };
    }

    function registerAllTools() {
      if (toolsRegistered) return;
      for (const toolName of ["compress", "decompress", "search_context", "merge", "acp_status"]) {
        try {
          ctx.tools.register(toolDefinition(toolName));
        } catch (err) {
          const msg = String(err?.message || err);
          if (msg.includes("already registered")) continue;
          if (msg.includes("inactive context")) { logSafe("context inactive, stopping tool registration"); return; }
          throw err;
        }
      }
      toolsRegistered = true;
      logSafe("tools registered: compress, decompress, search_context, merge, acp_status");
    }

    try {
      registerAllTools();
    } catch (err) {
      logSafe(`initial tool registration deferred: ${err.message}`);
    }

    // -----------------------------------------------------------------------
    // 2. llm/stream waterfall: render messages with ref tags + compression
    // -----------------------------------------------------------------------
    if (typeof ctx.on === "function") {
      ctx.on("llm/stream", function lwCompressRender(options, next) {
        // Absolute guard: NO error in this intercept may block the request.
        // Any failure → pass through with the original (frozen) options.
        let sid, messages, state;
        try {
          sid = options?.sessionId;
          if (!sid) return next();
          messages = options?.messages;
          if (!Array.isArray(messages) || messages.length === 0) return next();
          state = getSessionState(sid);
        } catch (_) {
          return next();
        }

        // Retry tool registration if it was deferred
        if (!toolsRegistered) {
          try { registerAllTools(); } catch (_) {}
        }

        try {
          // Step 0 (S-4): graceful restart detection.
          // If state is fresh but messages carry stale [mNNNNN] tags from a
          // previous run, strip them and re-baseline from m00001.
          const { cleanedMessages, wasRestart } = detectAndCleanRestart(messages, state);
          if (wasRestart) {
            logSafe(`session "${sid}": detected restart — stripped stale ref tags, re-baselining from m00001. All prior compression blocks were lost.`);
            audit(state, "restart-rebaseline", { strippedMessages: messages.length });
          }
          const effectiveMessages = wasRestart ? cleanedMessages : messages;

          // Step 1: assign refs to new messages
          const refResult = assignRefs(effectiveMessages, state.messageRefs, state.nextRefIndex);
          state.messageRefs = { byRaw: refResult.byRaw, byRef: refResult.byRef };
          state.nextRefIndex = refResult.nextIndex;

          // Store last-seen message ids for merge adjacency check.
          // Ids only — holding a reference to the live array would pin the
          // full originals (including compressed ranges) in plugin state.
          state._lastMessageIds = effectiveMessages.map((m) => m.id);

          // Step 2: build the transformed messages for the model
          // S-6: use incremental render (per-message cache) instead of
          // full re-render on every request.
          const rendered = renderMessagesIncremental(effectiveMessages, state);

          // Step 3: inject the system prompt block as the first message
          const systemMsg = {
            id: `nano-context-system-${sid}`,
            role: "system",
            content: [{ type: "text", text: SYSTEM_PROMPT_BLOCK }],
          };
          const transformed = [systemMsg, ...rendered];

          // Build new options (shallow copy, replace messages)
          // NEVER mutate the deep-frozen options object.
          const newOptions = { ...options, messages: transformed };

          return next.call(this, newOptions);
        } catch (err) {
          // Non-fatal: pass through unmodified if rendering fails
          if (DEBUG_ON) {
            try { process.stderr.write(`[nano-context] render failed, passing through: ${err?.message || err}\n`); } catch (_) {}
          }
          return next();
        }
      });
    }

    // -----------------------------------------------------------------------
    // 3. Observe assistant stream for token usage → nudge
    // -----------------------------------------------------------------------
    if (typeof ctx.on === "function") {
      ctx.on("agent/assistant-stream", ({ agent, frame }) => {
        if (!frame || typeof frame !== "object") return;

        // Look for token usage in the frame (end frames carry usage)
        const chunk = frame.chunk;
        if (!chunk || chunk.type !== "finish") return;

        const sid = agent?.session?.id;
        if (!sid) return;

        // Extract usage from the frame
        const usage = frame.usage || frame.usageInfo || (chunk && chunk.usage) || null;
        const currentTokens =
          usage?.totalTokens || usage?.total_tokens || usage?.inputTokens || 0;
        if (currentTokens === 0) return;

        // Record real token count for acp_status reporting
        recordTokenUsage(sid, currentTokens);

        const nudgeAt = Math.floor(contextLimit * nudgeThreshold);
        if (currentTokens <= nudgeAt) return;

        // Cooldown: re-nudge only when tokens grow 10%+
        const last = lastNudgeTokens.get(sid) || 0;
        if (last > 0 && currentTokens < last * NUDGE_COOLDOWN_FACTOR) return;
        lastNudgeTokens.set(sid, currentTokens);
        // Cap the map: evict the oldest entry (its session is either gone or stale)
        if (lastNudgeTokens.size > MAX_NUDGE_ENTRIES) {
          const firstKey = lastNudgeTokens.keys().next().value;
          lastNudgeTokens.delete(firstKey);
        }

        try {
          const state = getSessionState(sid);
          const blocks = activeBlocks(state).length;
          const nudgeText = buildNudge(currentTokens, contextLimit, blocks);
          if (typeof agent?.steer === "function") {
            agent.steer(nudgeText);
            state.stats.nudgeCount++;
            updateMetrics(state, currentTokens);
            logSafe(`nudge injected (${currentTokens}/${contextLimit} tokens, ${blocks} blocks)`);
          }
        } catch (err) {
          if (DEBUG_ON) {
            try { process.stderr.write(`[nano-context] nudge failed: ${err.message}\n`); } catch (_) {}
          }
        }
      });
    }

    logSafe(`apply() completed (contextLimit=${contextLimit}, nudgeThreshold=${nudgeThreshold}, maxBlocks=${maxBlocks})`);
  },
};

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

/**
 * Called by the nudge observer to record the real token count.
 * Makes it available to executeStatus (which can't read it from the tool context).
 * Map is capped; eviction also happens in evictSession() when a session ends.
 */
function recordTokenUsage(sessionId, tokens) {
  if (!sessionId || tokens <= 0) return;
  lastKnownTokens.set(sessionId, tokens);
  if (lastKnownTokens.size > MAX_TOKEN_ENTRIES) {
    const firstKey = lastKnownTokens.keys().next().value;
    lastKnownTokens.delete(firstKey);
  }
}

async function executeTool(toolName, args, sessionId, contextLimit, nudgeThreshold, maxBlocks) {
  const state = getSessionState(sessionId);

  switch (toolName) {
    case "compress":
      return executeCompress(state, args, maxBlocks);
    case "decompress":
      return executeDecompress(state, args);
    case "search_context":
      return executeSearch(state, args);
    case "merge":
      return executeMerge(state, args);
    case "acp_status":
      return executeStatus(state, contextLimit, nudgeThreshold, sessionId);
    default:
      throw new Error(`unknown tool: ${toolName}`);
  }
}

function executeCompress(state, args, maxBlocks) {
  const content = args?.content;
  if (!content || typeof content !== "string") {
    throw new Error("compress requires a `content` string argument");
  }

  const ranges = parseCompressInput(content);
  if (!Array.isArray(ranges) || ranges.length === 0) {
    throw new Error("compress: no valid ranges found in content (expected 'mNNNNN–mNNNNN [topic]' headers)");
  }

  const results = [];
  const cap = maxBlocks || DEFAULT_MAX_BLOCKS;

  for (const range of ranges) {
    // Enforce block cap: refuse new blocks when at limit
    const activeCount = activeBlocks(state).length;
    if (activeCount >= cap) {
      results.push(
        `⚠ REFUSED ${range.startRef}–${range.endRef}: block limit reached (${cap}). ` +
        `Decompress or search an existing block first. Use decompress with blockId to restore an older block.`
      );
      continue;
    }

    // Block ID cap: mNNNNNNN format supports up to 9,999,999
    if (state.nextBlockId > 9_999_999) {
      results.push(
        `⚠ REFUSED ${range.startRef}–${range.endRef}: block id limit reached. ` +
        `Decompress old blocks first.`
      );
      continue;
    }

    const blockId = `b${state.nextBlockId}`;
    state.nextBlockId++;

    const block = {
      blockId,
      tier: 1,
      topic: range.topic || null,
      summary: range.summary,
      // These will be filled by the render pass on the next llm/stream call
      directMessageIds: [],
      effectiveMessageIds: [],
      compressedTokens: estimateTokens(range.summary),
      originalTokens: null, // filled by render pass after pendingRefs resolve
      createdAt: Date.now(),
      generation: "new",
      active: true,
      expanded: false,
      // Store the range refs so the render pass can resolve them
      pendingRefs: { startRef: range.startRef, endRef: range.endRef },
      originalMessages: [], // filled by render pass
    };

    state.blocks.push(block);
    state.stats.compressionCount++;

    // The quality check (summary vs. key terms of the original range) runs
    // in the render pass once pendingRefs resolve, because the original
    // messages are only known at that point.

    results.push(
      `Compressed ${range.startRef}–${range.endRef} as ${blockId}` +
      (range.topic ? ` [${range.topic}]` : "") +
      ` (summary ~${block.compressedTokens} tokens)` +
      ` [quality check pending — will report after next render]`,
    );

    audit(state, "compress", `${range.startRef}–${range.endRef} → ${blockId}`, {
      summaryTokens: block.compressedTokens,
    });
  }

  return results.join("\n");
}

function executeDecompress(state, args) {
  const blockId = args?.blockId;
  if (!blockId || typeof blockId !== "string") {
    throw new Error("decompress requires a `blockId` string argument (e.g. \"b1\")");
  }

  const result = decompressBlock(state, blockId);
  return `Decompressed ${blockId}: ${result.messages.length} original messages restored. The original content will appear in the next model request.`;
}

function executeSearch(state, args) {
  const query = args?.query;
  if (!query || typeof query !== "string") {
    throw new Error("search_context requires a `query` string argument");
  }

  const results = searchContext(state, query);
  if (results.length === 0) {
    return `No matches for "${query}" in ${state.blocks.length} block(s).`;
  }

  const lines = [`Found ${results.length} match(es) for "${query}":`, ""];
  for (const r of results) {
    if (r.type === "summary") {
      const hint = r.decompressHint ? " ⚠ decompress this block to see the matched details" : "";
      lines.push(`  [summary] ${r.blockId}${r.topic ? ` [${r.topic}]` : ""} (${r.messageCount} msgs, ~${r.compressedTokens} tok)${hint}`);
      lines.push(`    ${r.snippet}`);
    } else {
      lines.push(`  [original] ${r.blockId} / ${r.ref || r.messageId} (${r.role})`);
      lines.push(`    ${r.snippet}`);
    }
  }
  return lines.join("\n");
}

function executeMerge(state, args) {
  const blockIdA = args?.blockIdA;
  const blockIdB = args?.blockIdB;
  if (!blockIdA || !blockIdB || typeof blockIdA !== "string" || typeof blockIdB !== "string") {
    throw new Error("merge requires `blockIdA` and `blockIdB` string arguments (e.g. \"b1\", \"b2\")");
  }
  if (blockIdA === blockIdB) {
    throw new Error("merge: blockIdA and blockIdB must be different");
  }

  try {
    // The render pass stores the last-seen message id sequence. The
    // adjacency check only needs ids in live order — build stubs so the
    // engine's positional lookups work without pinning the message array.
    // Note: the sequence is one render pass stale (tool calls happen
    // between renders); this is documented and acceptable because new
    // messages only appear AFTER both blocks' ranges.
    const ids = state._lastMessageIds;
    if (!Array.isArray(ids) || ids.length === 0) {
      return "⚠ Merge failed: no rendered messages available for the adjacency check yet (call after the next model request).";
    }
    const stubs = ids.map((id) => ({ id }));
    const result = mergeBlocks(state, blockIdA, blockIdB, stubs);
    return `Merged ${blockIdA} + ${blockIdB} → ${result.block.blockId} (${result.block.effectiveMessageIds.length} msgs, ~${result.block.compressedTokens} tok)`;
  } catch (err) {
    return `⚠ Merge failed: ${err.message}`;
  }
}

function executeStatus(state, contextLimit, nudgeThreshold, sessionId) {
  const knownTokens = (sessionId && lastKnownTokens.get(sessionId)) || 0;
  const status = buildStatus(state, knownTokens, contextLimit, nudgeThreshold);
  // S-2: append structured metrics as a JSON line for programmatic access
  const metrics = getMetrics(state, knownTokens);
  return `${status}\n\nMetrics: ${JSON.stringify(metrics)}`;
}

// ---------------------------------------------------------------------------
// Test support: reset all module-level state (session-scoped data)
// ---------------------------------------------------------------------------

/**
 * Reset all module-level state. Intended for test isolation only.
 * Clears session states, token tracking, and nudge cooldown maps.
 */
export function __resetForTests() {
  sessionStates.clear();
  lastKnownTokens.clear();
  lastNudgeTokens.clear();
}
