/**
 * nano-context — in-process compression engine.
 *
 * A minimal reimplementation of the billion-context kernel's core mechanics,
 * stripped to what a single local DSH + llama.cpp deployment needs:
 *
 *   - Message ref assignment (m00001, m00002, …)
 *   - Block state (compress a range → summary block; decompress → restore)
 *   - Single-tier compression (no tier2/tier3 distillation in v1)
 *   - Keyword search across blocks and original messages
 *   - Status report (tokens, blocks, savings)
 *
 * NO network. NO persistence. NO proxy. State is in-memory, session-scoped.
 *
 * Derived from billion-context (ranxianglei/billion-context) kernel concepts:
 * refs.ts, state.ts, boundaries.ts, compress.ts — all MIT licensed.
 */

// ---------------------------------------------------------------------------
// JSDoc typedefs (S-7) — lightweight, no TypeScript dependency
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} CompressionBlock
 * @property {string} blockId          Unique block id, e.g. "b1", "b2".
 * @property {number} tier             Compression tier (always 1 in v1).
 * @property {string|null} topic       Optional short topic label.
 * @property {string} summary          The LLM-generated summary text.
 * @property {string[]} directMessageIds   Message ids directly in the compressed range.
 * @property {string[]} effectiveMessageIds Message ids effectively covered (after merges).
 * @property {number} compressedTokens Estimated token count of the summary.
 * @property {number} originalTokens   Estimated token count of the original messages.
 * @property {number} createdAt        Epoch ms when the block was created.
 * @property {string} generation       "new" or "merged".
 * @property {boolean} active          Whether the block is active (not decompressed).
 * @property {boolean} expanded        Reserved for future expansion UI.
 * @property {Array} originalMessages  Deep-copied original messages (for decompress).
 * @property {{startRef: string, endRef: string}|null} [pendingRefs] Set before resolution.
 * @property {boolean} [budgetWarning] True when summary exceeds MAX_SUMMARY_RATIO.
 * @property {boolean} [_qualityChecked] Internal: quality check already ran.
 * @property {Object} [quality]        Result of checkSummaryQuality.
 */

/**
 * @typedef {Object} CompressionStats
 * @property {number} tokensCompressed    Cumulative original tokens freed.
 * @property {number} compressionCount    Total compress operations performed.
 * @property {number} decompressionCount  Total decompress operations performed.
 * @property {number} searchCount         Total search operations performed.
 * @property {number} mergeCount          Total merge operations performed.
 * @property {number} nudgeCount          Total nudge events fired.
 * @property {number} totalTokensSeen     Peak context token count observed.
 * @property {number} totalTokensSaved    Cumulative original tokens freed (active blocks).
 * @property {number} totalSummaryTokens  Cumulative summary tokens written (active blocks).
 * @property {number} qualityWarnings     Count of blocks with quality coverage < 30%.
 * @property {number} peakBlocks          High-water mark of simultaneously active blocks.
 */

/**
 * @typedef {Object} CompressionState
 * Per-session compression state. Created by createInitialState(),
 * stored in the module-level sessionStates Map (LRU, max 32).
 * @property {CompressionBlock[]} blocks          All blocks (active + inactive).
 * @property {{byRaw: Object<string,string>, byRef: Object<string,string>}} messageRefs
 *   Bidirectional map: raw DSH message id ↔ ref string (m00001…).
 * @property {number} nextRefIndex   Next ref index to assign.
 * @property {number} nextBlockId    Next block id to assign.
 * @property {CompressionStats} stats    Running statistics.
 * @property {Array<{ts: number, event: string, detail: string}>} audit
 *   Bounded audit trail (max 100 entries, oldest evicted).
 * @property {Map<string, {hash: string, ref: string|null, rendered: Object}>} [_renderCache]
 *   S-6: per-message render cache (populated lazily by renderMessagesIncremental).
 */

/**
 * @typedef {Object} QualityResult
 * @property {number} coverage      0–100, percentage of key terms in summary.
 * @property {number} totalTerms    Total significant terms extracted.
 * @property {number} foundTerms    Terms found in the summary.
 * @property {string[]} missing     Key terms missing from the summary.
 */

/**
 * @typedef {Object} Metrics
 * Flat, JSON-serializable snapshot for programmatic access (acp_status).
 * @property {number} activeBlocks
 * @property {number} totalBlocks
 * @property {number} tokensCompressed
 * @property {number} tokensSaved
 * @property {number} savingsPct
 * @property {number} totalSummaryTokens
 * @property {number} compressionCount
 * @property {number} decompressionCount
 * @property {number} mergeCount
 * @property {number} searchCount
 * @property {number} nudgeCount
 * @property {number} qualityWarnings
 * @property {number} totalTokensSeen
 * @property {number} peakBlocks
 */

/**
 * @typedef {Object} RestartResult
 * @property {Array} cleanedMessages  Messages with stale ref tags stripped.
 * @property {boolean} wasRestart     True if restart was detected and handled.
 */

// ---------------------------------------------------------------------------
// Ref assignment (adapted from kernel/src/refs.ts)
// ---------------------------------------------------------------------------

const REF_WIDTH = 5;
const MIN_INDEX = 1;
const MAX_INDEX = 9_999_999;
const REF_PATTERN = /^m0*(\d{1,7})$/;

export function indexToRef(index) {
  if (!Number.isInteger(index) || index < MIN_INDEX || index > MAX_INDEX) {
    throw new RangeError(`ref index out of bounds: ${index}`);
  }
  return `m${String(index).padStart(REF_WIDTH, "0")}`;
}

export function refToIndex(ref) {
  if (typeof ref !== "string") return null;
  const match = REF_PATTERN.exec(ref.trim().toLowerCase());
  if (!match) return null;
  const index = Number(match[1]);
  if (index < MIN_INDEX || index > MAX_INDEX) return null;
  return index;
}

/**
 * Detect whether a message's content carries a stale `[mNNNNN]` tag that does
 * NOT match the ref currently assigned (or any assigned ref when state is
 * fresh). This happens after a process restart: the conversation history
 * survives, but the in-memory ref table is empty.
 *
 * Returns true if the message content contains at least one `[mNNNNN]` tag.
 */
/** Pattern for [mNNNNN] tags inside message content (any width). */
const REF_CONTENT_PATTERN = /\[m\d{1,7}\]/;

export function hasRefTagInContent(msg) {
  const content = msg?.content;
  if (typeof content === "string") return REF_CONTENT_PATTERN.test(content);
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part?.type === "text" && typeof part.text === "string" && REF_CONTENT_PATTERN.test(part.text)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Strip all `[mNNNNN]` ref tags from a message's content parts.
 * Returns a new message object (does not mutate the original).
 */
export function stripRefTags(msg) {
  if (!msg) return msg;
  const content = msg.content;
  if (typeof content === "string") {
    return { ...msg, content: content.replace(REF_CONTENT_PATTERN, "") };
  }
  if (Array.isArray(content)) {
    const parts = content.map((part) => {
      if (part?.type === "text" && typeof part.text === "string" && REF_CONTENT_PATTERN.test(part.text)) {
        return { ...part, text: part.text.replace(REF_CONTENT_PATTERN, "") };
      }
      return part;
    });
    return { ...msg, content: parts };
  }
  return msg;
}

/**
 * S-4: Graceful restart detection.
 *
 * When the plugin state is fresh (no refs assigned) but the incoming messages
 * already carry `[mNNNNN]` tags from a previous run, we need to:
 *   1. Strip the stale tags so they don't confuse the model.
 *   2. Re-assign fresh refs from m00001.
 *   3. Log a clear restart notice.
 *
 * Returns { cleanedMessages, wasRestart } where `wasRestart` is true when
 * stale tags were found and stripped.
 */
export function detectAndCleanRestart(messages, state) {
  // If state already has refs, this is a normal in-session request — no restart.
  const hasExistingRefs = state?.messageRefs?.byRaw && Object.keys(state.messageRefs.byRaw).length > 0;
  if (hasExistingRefs) return { cleanedMessages: messages, wasRestart: false };

  // State is fresh. Check if any message carries a ref tag.
  let staleFound = false;
  const cleaned = [];
  for (const msg of messages) {
    if (hasRefTagInContent(msg)) {
      staleFound = true;
      cleaned.push(stripRefTags(msg));
    } else {
      cleaned.push(msg);
    }
  }
  return { cleanedMessages: cleaned, wasRestart: staleFound };
}

/**
 * Assign refs to messages that don't have one yet.
 * Returns { byRaw, byRef, nextIndex, newlyAssigned }.
 */
export function assignRefs(messages, existing, nextIndex) {
  const byRaw = { ...(existing?.byRaw || {}) };
  const byRef = { ...(existing?.byRef || {}) };
  let cursor = Number.isInteger(nextIndex) && nextIndex >= MIN_INDEX ? nextIndex : MIN_INDEX;
  let newlyAssigned = 0;

  for (const msg of messages) {
    if (!msg.id) continue;
    if (byRaw[msg.id]) continue; // already assigned
    byRaw[msg.id] = indexToRef(cursor);
    byRef[indexToRef(cursor)] = msg.id;
    cursor++;
    newlyAssigned++;
  }
  return { byRaw, byRef, nextIndex: cursor, newlyAssigned };
}

// ---------------------------------------------------------------------------
// Block state (adapted from kernel/src/state.ts)
// ---------------------------------------------------------------------------

/** Audit trail cap — keep only the last 100 events to bound memory. */
const MAX_AUDIT_ENTRIES = 100;

/**
 * Cap on the sum of originalTokens across all ACTIVE blocks. Blocks pin
 * their original messages for decompress/search, and unbounded growth would
 * let the plugin itself hold hundreds of MB in long sessions. 256k tokens ≈
 * ~25MB of text, well above what a local model context needs to keep searchable.
 */
export const MAX_TOTAL_ORIGINAL_TOKENS = 256 * 1024;

function activeOriginalTokenTotal(blocks) {
  let sum = 0;
  for (const b of blocks) if (b.active && b.expanded !== true) sum += b.originalTokens || 0;
  return sum;
}

export function createInitialState() {
  return {
    blocks: [],
    messageRefs: { byRaw: {}, byRef: {} },
    nextRefIndex: 1,
    nextBlockId: 1,
    stats: {
      tokensCompressed: 0,
      compressionCount: 0,
      decompressionCount: 0,
      searchCount: 0,
      // S-2: structured metrics
      mergeCount: 0,
      nudgeCount: 0,
      totalTokensSeen: 0,       // max token count observed (peak context)
      totalTokensSaved: 0,      // cumulative original tokens freed
      totalSummaryTokens: 0,    // cumulative summary tokens written
      qualityWarnings: 0,       // blocks whose quality check fell below 30%
      peakBlocks: 0,            // high-water mark of active blocks
    },
    audit: [],
  };
}

/**
 * Update running metrics after a state change. Called by the plugin layer
 * (index.js) after each tool execution and nudge event.
 *
 * @param {object} state - CompressionState
 * @param {number} [currentTokens] - current context token count (updates totalTokensSeen)
 */
export function updateMetrics(state, currentTokens) {
  const s = state.stats;
  if (typeof currentTokens === "number" && currentTokens > 0) {
    s.totalTokensSeen = Math.max(s.totalTokensSeen, currentTokens);
  }
  // Recompute cumulative savings from active blocks
  s.totalTokensSaved = state.blocks.reduce(
    (sum, b) => sum + (b.active ? (b.originalTokens || 0) : 0), 0,
  );
  s.totalSummaryTokens = state.blocks.reduce(
    (sum, b) => sum + (b.active ? (b.compressedTokens || 0) : 0), 0,
  );
  const activeCount = state.blocks.filter((b) => b.active).length;
  s.peakBlocks = Math.max(s.peakBlocks, activeCount);
}

/**
 * Build a structured metrics object for programmatic access.
 * Returns a plain object with all compression statistics.
 *
 * @param {object} state - CompressionState
 * @param {number} [currentTokens] - current context token count
 * @returns {object} structured metrics
 */
export function getMetrics(state, currentTokens) {
  updateMetrics(state, currentTokens);
  const s = state.stats;
  const activeBlocks = state.blocks.filter((b) => b.active);
  const totalOrig = activeBlocks.reduce((sum, b) => sum + (b.originalTokens || 0), 0);
  const totalSum = activeBlocks.reduce((sum, b) => sum + (b.compressedTokens || 0), 0);
  const saved = totalOrig - totalSum;
  return {
    activeBlocks: activeBlocks.length,
    totalBlocks: state.blocks.length,
    tokensCompressed: s.tokensCompressed,
    tokensSaved: saved,
    savingsPct: totalOrig > 0 ? Math.round((saved / totalOrig) * 100) : 0,
    totalSummaryTokens: totalSum,
    compressionCount: s.compressionCount,
    decompressionCount: s.decompressionCount,
    mergeCount: s.mergeCount,
    searchCount: s.searchCount,
    nudgeCount: s.nudgeCount,
    qualityWarnings: s.qualityWarnings,
    totalTokensSeen: s.totalTokensSeen,
    peakBlocks: s.peakBlocks,
  };
}

/**
 * Append an entry to the in-session audit trail.
 * Capped at MAX_AUDIT_ENTRIES (oldest evicted).
 * @param {object} state
 * @param {"compress"|"decompress"|"merge"|"search"} type
 * @param {string} detail
 * @param {object} [extra]
 */
/**
 * Append an entry to the state's audit log (capped at MAX_AUDIT_ENTRIES).
 *
 * @param {object} state - CompressionState
 * @param {"compress"|"decompress"|"merge"|"refuse"|"quality-warning"} type
 * @param {string} detail - human-readable one-liner
 * @param {object} [extra] - extra fields stored on the entry
 */
export function audit(state, type, detail, extra = {}) {
  state.audit.push({ type, detail, extra, ts: Date.now() });
  if (state.audit.length > MAX_AUDIT_ENTRIES) {
    state.audit.splice(0, state.audit.length - MAX_AUDIT_ENTRIES);
  }
}

export function blockById(state, blockId) {
  return state.blocks.find((b) => b.blockId === blockId);
}

/** Max block id before indexToRef would throw RangeError (m + 7 digits). */
const MAX_BLOCK_ID = 9_999_999;

/**
 * S-3: Compression budget — a summary should not be larger than the content
 * it replaces. This budget is a WARNING (not a hard rejection) because
 * legitimate cases exist (e.g. compressing 2 very short messages into a
 * structured summary). The nudge text and acp_status surface the ratio.
 */
export const MAX_SUMMARY_RATIO = 1.0; // summary tokens ≤ original tokens

export function activeBlocks(state) {
  return state.blocks.filter((b) => b.active);
}

export function coveredMessageIds(state) {
  const covered = new Set();
  for (const block of state.blocks) {
    if (!block.active) continue;
    for (const id of block.effectiveMessageIds) covered.add(id);
  }
  return covered;
}

// ---------------------------------------------------------------------------
// Boundary resolution (adapted from kernel/src/boundaries.ts)
// ---------------------------------------------------------------------------

const MESSAGE_REF_PATTERN = /^m0*(\d{1,7})$/;
const BLOCK_REF_PATTERN = /^b(\d{1,9})$/;

export function parseBoundary(ref) {
  const normalized = ref.trim().toLowerCase();
  const messageMatch = MESSAGE_REF_PATTERN.exec(normalized);
  if (messageMatch) {
    const numericId = Number(messageMatch[1]);
    if (numericId >= 1 && numericId <= MAX_INDEX) {
      return { kind: "message", numericId, raw: normalized };
    }
  }
  const blockMatch = BLOCK_REF_PATTERN.exec(normalized);
  if (blockMatch) {
    const numericId = Number(blockMatch[1]);
    if (numericId >= 1) return { kind: "block", numericId, raw: normalized };
  }
  return null;
}

/**
 * Resolve a [startRef, endRef] range to message indices.
 * Returns { startIndex, endIndex, messageIds } or throws.
 */
export function resolveRange(startRef, endRef, messages, state) {
  const start = parseBoundary(startRef);
  const end = parseBoundary(endRef);
  if (!start || !end) {
    throw new Error(
      `Invalid boundary ref(s): startRef="${startRef}", endRef="${endRef}". Use mNNNNN or bN.`,
    );
  }

  // Build raw-id → index map
  const indexByMessageId = new Map();
  messages.forEach((msg, i) => indexByMessageId.set(msg.id, i));

  function anchorIndex(boundary, side) {
    if (boundary.kind === "message") {
      const ref = indexToRef(boundary.numericId);
      const rawId = state.messageRefs.byRef[ref];
      if (!rawId) {
        // Check if consumed by a block
        const covered = coveredMessageIds(state);
        if (covered.has(rawId)) {
          throw new Error(`${side} ref ${ref} points to a message consumed by an active block — decompress first`);
        }
        throw new Error(`${side} ref ${ref} not found in current context`);
      }
      const idx = indexByMessageId.get(rawId);
      if (idx === undefined) {
        const covered = coveredMessageIds(state);
        if (covered.has(rawId)) {
          throw new Error(`${side} ref ${ref} is consumed by an active block — decompress first`);
        }
        throw new Error(`${side} ref ${ref} not found in current context`);
      }
      return idx;
    }
    // block boundary
    const block = blockById(state, boundary.raw);
    if (!block || !block.active) {
      throw new Error(`${side} block ref ${boundary.raw} not found or inactive`);
    }
    // For block boundaries, resolve to first/last effective message
    const firstId = block.effectiveMessageIds[0];
    const lastId = block.effectiveMessageIds[block.effectiveMessageIds.length - 1];
    const idx = indexByMessageId.get(firstId);
    if (idx === undefined) throw new Error(`block ${boundary.raw} messages not in current context`);
    return idx;
  }

  let startIdx = anchorIndex(start, "start");
  let endIdx = anchorIndex(end, "end");

  // Normalize ordering
  if (endIdx < startIdx) [startIdx, endIdx] = [endIdx, startIdx];

  // Reject single-message ranges: compressing one message into a summary
  // block is not useful (the summary would be ~the same size as the original).
  if (startIdx === endIdx) {
    throw new Error(
      `Range ${startRef}–${endRef} covers only one message. Compress a range of at least 2 messages.`,
    );
  }

  const messageIds = messages.slice(startIdx, endIdx + 1).map((m) => m.id);
  return { startIndex: startIdx, endIndex: endIdx, messageIds };
}

// ---------------------------------------------------------------------------
// Compression (adapted from kernel/src/compress.ts)
// ---------------------------------------------------------------------------

/**
 * Apply a compression: replace a range of messages with a summary block.
 *
 * NOTE: In the DSH plugin (index.js), compression is applied via the
 * pendingRefs bridge — the model calls compress with refs, a block is
 * created with pendingRefs, and the next llm/stream render pass resolves
 * the refs against the live message array. This function is the engine-level
 * API for direct (non-pending) compression, used by tests and the search
 * index. It resolves the range immediately.
 *
 * @param {object} state - CompressionState
 * @param {Array}  messages - current message array
 * @param {string} startRef - start boundary ref (mNNNNN or bN)
 * @param {string} endRef - end boundary ref
 * @param {string} summary - the summary text the model wrote
 * @param {string} [topic] - optional topic label
 * @param {number} [estTokens] - estimated token count of the compressed range
 * @returns {{ block: object, summaryMessageId: string }}
 */
export function applyCompression(state, messages, startRef, endRef, summary, topic, estTokens) {
  const { startIndex, endIndex, messageIds } = resolveRange(startRef, endRef, messages, state);

  if (state.nextBlockId > MAX_BLOCK_ID) {
    throw new RangeError(`block id limit reached (${MAX_BLOCK_ID}); decompress old blocks first`);
  }

  const blockId = `b${state.nextBlockId}`;
  state.nextBlockId++;

  const originals = messages.slice(startIndex, endIndex + 1);
  const originalTokens = estimateOriginalTokens(originals);
  const block = {
    blockId,
    tier: 1,
    topic: topic || null,
    summary,
    directMessageIds: messageIds,
    effectiveMessageIds: [...messageIds],
    compressedTokens: estTokens || 0,
    originalTokens,
    createdAt: Date.now(),
    generation: "new",
    active: true,
    expanded: false,
    originalMessages: originals.map((m) => ({ ...m })),
  };

  state.blocks.push(block);
  // tokensCompressed tracks the ORIGINAL tokens freed (same semantics as
  // resolvePendingBlock in the plugin path). See buildStatus for display.
  state.stats.tokensCompressed += originalTokens;
  state.stats.compressionCount++;
  const activeCount = state.blocks.filter((b) => b.active).length;
  state.stats.peakBlocks = Math.max(state.stats.peakBlocks, activeCount);
  enforceOriginalTokenCap(state, block);

  // S-3: compression budget check (warning, not rejection)
  const summaryTokens = block.compressedTokens || 0;
  if (originalTokens > 0 && summaryTokens > originalTokens * MAX_SUMMARY_RATIO) {
    block.budgetWarning = true;
    audit(state, "budget-warning", `${block.blockId}: summary (${summaryTokens} tok) exceeds original (${originalTokens} tok) — compression not saving context`);
  }

  const summaryMessageId = `summary-${blockId}`;
  return { block, summaryMessageId, startIndex, endIndex };
}

/**
 * Enforce MAX_TOTAL_ORIGINAL_TOKENS over active compressed blocks.
 * Oldest active block is decompressed first (originals stay in the live
 * message array — nothing is lost, the block just stops pinning a copy).
 * The triggering block is NEVER evicted: callers must not silently drop
 * the result of the operation they just requested.
 */
function enforceOriginalTokenCap(state, triggeringBlock) {
  let total = activeOriginalTokenTotal(state.blocks);
  while (total > MAX_TOTAL_ORIGINAL_TOKENS) {
    const candidates = state.blocks
      .filter((b) => b !== triggeringBlock && b.active && b.expanded !== true)
      .sort((a, b) => (a.createdAt - b.createdAt) || (a.blockId < b.blockId ? -1 : 1));
    if (candidates.length === 0) break;
    const victim = candidates[0];
    victim.active = false;
    victim.expanded = true;
    state.stats.decompressionCount++;
    total -= victim.originalTokens || 0;
    audit(state, "decompress", `${victim.blockId}: auto-decompressed (original-token cap ${MAX_TOTAL_ORIGINAL_TOKENS} reached)`);
  }
}

/**
 * Decompress a block: restore original messages, deactivate the block.
 *
 * @param {object} state - CompressionState
 * @param {string} blockId - the block to restore (bN)
 * @returns {{ messages: Array, blockId: string }}
 */
export function decompressBlock(state, blockId) {
  const block = blockById(state, blockId);
  if (!block) throw new Error(`block ${blockId} not found`);
  if (!block.active) throw new Error(`block ${blockId} is already decompressed`);

  block.active = false;
  block.expanded = true;
  delete block._searchCache;
  state.stats.decompressionCount++;
  audit(state, "decompress", `${blockId}: restored ${block.effectiveMessageIds.length} messages (~${block.originalTokens || block.compressedTokens} tokens released)`);

  return { messages: block.originalMessages, blockId };
}

// ---------------------------------------------------------------------------
// Block merging: combine adjacent active blocks into one
// ---------------------------------------------------------------------------

/**
 * Check whether two blocks cover adjacent message ranges in the live
 * message array (i.e. no uncovered message sits between them).
 */
function blocksAreAdjacent(a, b, messages) {
  const pos = new Map();
  for (let i = 0; i < messages.length; i++) pos.set(messages[i].id, i);

  const aLast = pos.get(a.effectiveMessageIds[a.effectiveMessageIds.length - 1]);
  const bFirst = pos.get(b.effectiveMessageIds[0]);
  if (aLast === undefined || bFirst === undefined) return false;

  // Adjacent: b's first message is immediately after a's last
  return bFirst === aLast + 1;
}

/**
 * Merge two adjacent active blocks into a single block.
 *
 * Both blocks must be active, have no pendingRefs, and cover adjacent
 * message ranges in the live message array. The resulting block:
 *   - keeps the lower block id (b1 merges b2 → b1)
 *   - concatenates summaries (newer block first)
 *   - unions message ids (chronological order)
 *   - sums originalTokens and compressedTokens
 *   - deactivates the absorbed block
 *
 * @param {object} state
 * @param {string} blockIdA
 * @param {string} blockIdB
 * @param {Array}  messages - current live message array (for adjacency check)
 * @returns {{ block: object, removed: string }} the surviving block and removed id
 */
export function mergeBlocks(state, blockIdA, blockIdB, messages) {
  if (blockIdA === blockIdB) throw new Error("Cannot merge a block with itself.");
  const a = blockById(state, blockIdA);
  const b = blockById(state, blockIdB);
  if (!a) throw new Error(`block ${blockIdA} not found`);
  if (!b) throw new Error(`block ${blockIdB} not found`);
  if (!a.active) throw new Error(`block ${blockIdA} is not active`);
  if (!b.active) throw new Error(`block ${blockIdB} is not active`);
  if (a.pendingRefs) throw new Error(`block ${blockIdA} has unresolved pending refs`);
  if (b.pendingRefs) throw new Error(`block ${blockIdB} has unresolved pending refs`);

  if (!messages || !Array.isArray(messages)) {
    throw new Error("mergeBlocks requires the current message array for the adjacency check");
  }

  // Determine order: the block whose messages appear first in the array is "first"
  const aFirst = a.effectiveMessageIds[0];
  const bFirst = b.effectiveMessageIds[0];
  const posA = messages.findIndex((m) => m.id === aFirst);
  const posB = messages.findIndex((m) => m.id === bFirst);
  if (posA === -1 || posB === -1) {
    throw new Error("One of the blocks' messages is not in the current context");
  }

  const [first, second] = posA < posB ? [a, b] : [b, a];
  const removedId = first.blockId === blockIdA ? blockIdB : blockIdA;

  if (!blocksAreAdjacent(first, second, messages)) {
    throw new Error(
      `Blocks ${first.blockId} and ${second.blockId} are not adjacent — an uncovered message sits between them. Cannot merge.`
    );
  }

  // Build merged block (keep the lower/earlier id)
  //
  // ID and message ordering follows the LIVE message array (chronological):
  // `first`'s messages precede `second`'s. effectiveMessageIds is the union
  // of DIRECT ids only — ids owned by other active blocks (nested coverage)
  // must not be duplicated into this block, or renderMessages' coveredBy map
  // would flip ownership.
  const allDirect = [...first.directMessageIds, ...second.directMessageIds];
  const posById = new Map();
  for (let i = 0; i < messages.length; i++) posById.set(messages[i].id, i);
  const order = (x, y) => (posById.get(x) ?? Infinity) - (posById.get(y) ?? Infinity);

  const merged = {
    blockId: first.blockId,
    tier: 1,
    topic: first.topic || second.topic || null,
    // Newer (second) summary first, then older — preserves recency
    summary: `${second.summary}\n\n---\n\n${first.summary}`,
    directMessageIds: [...new Set(allDirect)].sort(order),
    effectiveMessageIds: [...new Set(allDirect)].sort(order),
    compressedTokens: (first.compressedTokens || 0) + (second.compressedTokens || 0),
    originalTokens: (first.originalTokens || 0) + (second.originalTokens || 0),
    createdAt: Math.min(first.createdAt, second.createdAt),
    generation: "merged",
    active: true,
    expanded: false,
    originalMessages: [...first.originalMessages, ...second.originalMessages],
  };

  // Replace the first block in-place, deactivate the second
  const idx = state.blocks.findIndex((blk) => blk.blockId === first.blockId);
  state.blocks[idx] = merged;
  second.active = false;
  second.expanded = true;
  second.mergedInto = first.blockId;
  delete second._searchCache;

  state.stats.mergeCount++;
  const activeAfterMerge = state.blocks.filter((b) => b.active).length;
  state.stats.peakBlocks = Math.max(state.stats.peakBlocks, activeAfterMerge);
  audit(state, "merge", `${first.blockId} absorbed ${second.blockId} (${merged.effectiveMessageIds.length} msgs, ~${merged.originalTokens} orig / ~${merged.compressedTokens} summary)`);

  return { block: merged, removed: removedId };
}

// ---------------------------------------------------------------------------
// Search (simplified CCR)
// ---------------------------------------------------------------------------

/**
 * Search across active blocks' summaries and original messages.
 *
 * @param {object} state - CompressionState
 * @param {string} query - keyword or phrase to search for
 * @returns {Array} matching blocks with context snippets
 */
/**
 * Per-block text cache for search. A block's summary and originalMessages
 * are immutable while it is active (only decompress/merge mutate, and both
 * clear the cache), so lower-cased search text can be built once per block
 * instead of on every query.
 * Returns an array of { id, role, lowerText } for the block's original
 * messages (null if the block is too large to scan).
 */
function getBlockSearchCache(block) {
  if (!block._searchCache) {
    const texts = [];
    if (block.originalMessages && block.originalMessages.length <= 200) {
      for (const msg of block.originalMessages) {
        let text = "";
        if (Array.isArray(msg.content)) {
          for (const b of msg.content) {
            if (b && b.type === "text" && typeof b.text === "string") text += b.text;
          }
        } else if (typeof msg.text === "string") {
          text = msg.text;
        }
        texts.push({ id: msg.id, role: msg.role, lowerText: text.toLowerCase() });
      }
    }
    block._searchCache = {
      summaryLower: block.summary ? block.summary.toLowerCase() : "",
      texts: block.originalMessages && block.originalMessages.length <= 200 ? texts : null,
    };
  }
  return block._searchCache;
}

export function searchContext(state, query) {
  if (!query || !query.trim()) return [];
  const q = query.trim().toLowerCase();
  const results = [];

  for (const block of state.blocks) {
    if (!block.active) continue;
      const cache = getBlockSearchCache(block);

    // Search summary
    if (cache.summaryLower.includes(q)) {
      const idx = cache.summaryLower.indexOf(q);
      const start = Math.max(0, idx - 80);
      const end = Math.min(block.summary.length, idx + q.length + 80);
      const snippet =
        (start > 0 ? "…" : "") + block.summary.slice(start, end) + (end < block.summary.length ? "…" : "");
      results.push({
        type: "summary",
        blockId: block.blockId,
        topic: block.topic,
        snippet,
        messageCount: block.effectiveMessageIds.length,
        compressedTokens: block.compressedTokens,
      });
    }

    // Search original messages (only if block is small enough to scan).
    // The snippet is built from the ORIGINAL text (case preserved); the
    // match position comes from the cached lower-cased copy, which has
    // identical length to the original.
    if (cache.texts) {
      for (let i = 0; i < cache.texts.length; i++) {
        const entry = cache.texts[i];
        const msg = block.originalMessages[i];
        let text = "";
        if (Array.isArray(msg.content)) {
          for (const b of msg.content) {
            if (b && b.type === "text" && typeof b.text === "string") text += b.text;
          }
        } else if (typeof msg.text === "string") {
          text = msg.text;
        }
        if (!entry.lowerText) continue;
        const idx = entry.lowerText.indexOf(q);
        if (idx === -1) continue;
        const start = Math.max(0, idx - 60);
        const end = Math.min(text.length, idx + q.length + 60);
        const snippet =
          (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
        results.push({
          type: "original",
          blockId: block.blockId,
          messageId: msg.id,
          ref: state.messageRefs.byRaw[msg.id] || null,
          role: msg.role,
          snippet,
        });
      }
    }
  }

  state.stats.searchCount++;
  audit(state, "search", `"${query.trim()}" → ${results.length} match(es)`);

  // Add decompress hints: if a match was found in the original messages
  // of a block (not just the summary), the model may want to decompress
  // to see the full context.
  const matchedBlockIds = new Set(results.filter((r) => r.type === "original").map((r) => r.blockId));
  for (const r of results) {
    if (r.type === "summary" && matchedBlockIds.has(r.blockId)) {
      r.decompressHint = true;
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * Build a human-readable status report.
 *
 * @param {object} state - CompressionState
 * @param {number} currentTokens - current context token count
 * @param {number} contextLimit - model context window in tokens
 * @param {number} [nudgeThreshold=0.5] - fraction of contextLimit that triggers a warning
 * @returns {string} formatted status
 */
export function buildStatus(state, currentTokens, contextLimit, nudgeThreshold = 0.5) {
  const blocks = activeBlocks(state);
  const tokenKnown = typeof currentTokens === "number" && currentTokens > 0;
  const pct = tokenKnown && contextLimit > 0 ? Math.round((currentTokens / contextLimit) * 100) : 0;
  const metrics = getMetrics(state, currentTokens);

  const lines = [
    tokenKnown
      ? `Context: ${currentTokens.toLocaleString()} / ${contextLimit.toLocaleString()} tokens (${pct}%)`
      : `Context: unknown / ${contextLimit.toLocaleString()} tokens (no usage observed yet)`,
    `Active blocks: ${metrics.activeBlocks} (peak: ${metrics.peakBlocks})`,
    `Tokens freed (originals): ${metrics.tokensCompressed.toLocaleString()} across ${metrics.compressionCount} compression(s)`,
    `Decompressions: ${metrics.decompressionCount}  |  Merges: ${metrics.mergeCount}  |  Searches: ${metrics.searchCount}  |  Nudges: ${metrics.nudgeCount}`,
  ];

  if (blocks.length > 0) {
    lines.push("", "Blocks:");
    for (const b of blocks) {
      const topic = b.topic ? ` [${b.topic}]` : "";
      const orig = b.originalTokens ? `~${b.originalTokens} orig → ` : "";
      const quality = b.quality ? `, quality: ${b.quality.coverage}%` : "";
      const budget = b.budgetWarning ? ", ⚠ budget exceeded" : "";
      lines.push(
        `  ${b.blockId}: ${b.effectiveMessageIds.length} msgs, ${orig}~${b.compressedTokens} summary, gen: ${b.generation}${quality}${budget}${topic}`,
      );
    }
    // Total savings
    const totalOrig = blocks.reduce((s, b) => s + (b.originalTokens || 0), 0);
    const totalSummary = blocks.reduce((s, b) => s + (b.compressedTokens || 0), 0);
    if (totalOrig > 0) {
      const saved = totalOrig - totalSummary;
      const pctSaved = totalOrig > 0 ? Math.round((saved / totalOrig) * 100) : 0;
      lines.push(`  Total savings: ~${saved.toLocaleString()} tokens (${pctSaved}% reduction)`);
    }
  }

  // S-2: structured metrics line
  if (metrics.qualityWarnings > 0) {
    lines.push(`Quality warnings: ${metrics.qualityWarnings} block(s) with <30% coverage`);
  }
  if (metrics.totalTokensSeen > 0) {
    lines.push(`Peak context observed: ${metrics.totalTokensSeen.toLocaleString()} tokens`);
  }

  // Recent audit trail (last 5 events)
  if (state.audit && state.audit.length > 0) {
    lines.push("", "Recent activity:");
    const recent = state.audit.slice(-5);
    for (const e of recent) {
      lines.push(`  [${e.type}] ${e.detail}`);
    }
  }

  // Nudge threshold check (uses the configured threshold, not hardcoded)
  const threshold = Math.floor(contextLimit * nudgeThreshold);
  if (currentTokens > threshold) {
    lines.push("", `⚠ Context is ${pct}% full (nudge threshold: ${Math.round(nudgeThreshold * 100)}%) — consider compressing consumed ranges.`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Pending block resolution (called by renderMessages)
// ---------------------------------------------------------------------------

/**
 * Resolve a pending block's refs against the current message array.
 * On success, populates directMessageIds, effectiveMessageIds, originalMessages,
 * and originalTokens. On failure, deactivates the block and records the
 * reason in state.audit so the disappearance is traceable.
 *
 * @param {object} block - the block with pendingRefs
 * @param {Array}  messages - current message array (with .id and .content)
 * @param {object} state - CompressionState (for messageRefs)
 * @returns {boolean} true if resolved successfully, false otherwise
 */
function resolvePendingBlock(block, messages, state) {
  if (!block.pendingRefs) return true; // already resolved or no pending
  const { startRef, endRef } = block.pendingRefs;

  try {
    const { startIndex, endIndex, messageIds } = resolveRange(startRef, endRef, messages, state);
    const originals = messages.slice(startIndex, endIndex + 1);
    block.directMessageIds = messageIds;
    block.effectiveMessageIds = [...messageIds];
    block.originalMessages = originals.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      source: m.source,
    }));
    // Track the original token count so we can report actual savings
    block.originalTokens = estimateOriginalTokens(originals);
    // tokensCompressed tracks the ORIGINAL tokens freed (same semantics as
    // applyCompression). See buildStatus for display.
    state.stats.tokensCompressed += block.originalTokens;
    enforceOriginalTokenCap(state, block);
    delete block.pendingRefs;

    // S-3: compression budget check (warning, not rejection)
    const summaryTokens = block.compressedTokens || 0;
    if (block.originalTokens > 0 && summaryTokens > block.originalTokens * MAX_SUMMARY_RATIO) {
      block.budgetWarning = true;
      audit(state, "budget-warning", `${block.blockId}: summary (${summaryTokens} tok) exceeds original (${block.originalTokens} tok) — compression not saving context`);
    }

    audit(state, "compress", `${block.blockId}: resolved ${startRef}–${endRef} (${messageIds.length} msgs, ~${block.originalTokens} orig / ~${block.compressedTokens} summary)`);
    return true;
  } catch (err) {
    // Cannot resolve: deactivate the block (the range may have shifted)
    audit(state, "compress", `${block.blockId}: FAILED to resolve ${startRef}–${endRef} — ${err.message}. Block deactivated.`);
    block.active = false;
    block.pendingRefs = null;
    return false;
  }
}

/**
 * Rough token estimate for an array of DSH messages.
 * CJK ≈ 1 token/char, ASCII ≈ 4 chars/token.
 */
function estimateOriginalTokens(messages) {
  let total = 0;
  for (const msg of messages) {
    if (!msg || !Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      if (b && b.type === "text" && typeof b.text === "string") {
        let cjk = 0, other = 0;
        for (const ch of b.text) {
          const cp = ch.codePointAt(0);
          // CJK Unified Ideographs + Extension A (matches checkSummaryQuality)
          if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf)) cjk++;
          else other++;
        }
        total += cjk + Math.ceil(other / 4);
      }
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Render: transform messages for the model (inject ref tags)
// ---------------------------------------------------------------------------

/**
 * Transform a message array into a ref-tagged view for the model.
 * Each message gets a [mNNNNN] prefix tag in its content so the model can
 * reference specific messages in compress calls.
 *
 * Compressed ranges are replaced with their summary block.
 *
 * DSH message shape: { id, role, content: ContentBlock[], source }
 * where ContentBlock = { type: 'text', text: string } | { type: 'tool-call', ... }
 *
 * @param {Array} messages - raw DSH messages
 * @param {object} state - CompressionState
 * @returns {Array} transformed messages (new array, originals not mutated)
 */
// ---------------------------------------------------------------------------
// renderMessages — split into focused helpers (S-5)
// ---------------------------------------------------------------------------

/**
 * Resolve all pending blocks against the current messages.
 * A block is "pending" when compress() was called but the original messages
 * have not yet been identified (the render pass is what does that).
 */
function resolveAllPendingBlocks(state, messages) {
  for (const block of state.blocks) {
    if (block.active && block.pendingRefs) {
      resolvePendingBlock(block, messages, state);
    }
  }
}

/**
 * Run quality checks on newly resolved blocks (ones that have original
 * messages but haven't been quality-checked yet).
 */
function runQualityChecks(state) {
  for (const block of state.blocks) {
    if (!block.active || block._qualityChecked) continue;
    if (!block.originalMessages || block.originalMessages.length === 0) continue;
    const quality = checkSummaryQuality(block.summary, block.originalMessages);
    block._qualityChecked = true;
    block.quality = quality;
    if (quality.coverage < 30) {
      state.stats.qualityWarnings++;
      audit(state, "quality-warning", `${block.blockId}: summary covers only ${quality.coverage}% of key terms (${quality.missing.length} missing: ${quality.missing.slice(0, 5).join(", ")})`);
    }
  }
}

/**
 * Build a messageId → block Map for O(1) covered-message lookup during
 * the render loop. Only active blocks participate.
 */
function buildCoveredMap(state) {
  const coveredBy = new Map();
  for (const block of state.blocks) {
    if (!block.active) continue;
    for (const id of block.effectiveMessageIds) {
      coveredBy.set(id, block);
    }
  }
  return coveredBy;
}

/**
 * Build the rendered summary message for a compression block.
 */
function renderSummaryBlock(block) {
  const topicPart = block.topic ? `: ${block.topic}` : "";
  return {
    id: `summary-${block.blockId}`,
    role: "assistant",
    content: [{
      type: "text",
      text: `[COMPRESSION BLOCK ${block.blockId}${topicPart} — covers ${block.effectiveMessageIds.length} messages (~${block.compressedTokens} tokens)]\n\n${block.summary}\n\n[To restore original content, use decompress with blockId="${block.blockId}"]`,
    }],
    source: { kind: "system-prompt" },
    summaryOfBlockId: block.blockId,
  };
}

/**
 * Render a single non-covered message with its ref tag prepended to the
 * first text block. Returns a new message object (never mutates input).
 */
function renderNormalMessage(msg, ref) {
  if (ref && Array.isArray(msg.content)) {
    const textIdx = msg.content.findIndex((b) => b && b.type === "text");
    if (textIdx >= 0) {
      const newContent = [...msg.content];
      newContent[textIdx] = {
        ...newContent[textIdx],
        text: `[${ref}] ${newContent[textIdx].text || ""}`,
      };
      return { ...msg, content: newContent, ref };
    }
    // No text block (e.g. tool-call only): pass through with ref
    return { ...msg, ref };
  }
  return { ...msg };
}

// ---------------------------------------------------------------------------
// S-6: Incremental render cache
// ---------------------------------------------------------------------------

/**
 * Cheap content hash for a message: length + first 80 + last 80 chars.
 * Not cryptographic — just a fast change detector for the render cache.
 * O(n) where n = total text length, but only for the first/last slices
 * plus a length check, so it's effectively O(1) for typical messages.
 */
function contentHash(msg) {
  const content = msg?.content;
  if (typeof content === "string") {
    const len = content.length;
    return `${len}:${content.slice(0, 80)}|${content.slice(-80)}`;
  }
  if (Array.isArray(content)) {
    let total = 0;
    let first = "";
    let last = "";
    for (const part of content) {
      if (part?.type === "text" && typeof part.text === "string") {
        total += part.text.length;
        if (first.length < 80) first += part.text.slice(0, 80 - first.length);
        last = (last + part.text).slice(-80);
      }
    }
    return `${total}:${first}|${last}`;
  }
  // Non-text content: hash by part count + types
  const parts = Array.isArray(content) ? content.length : 0;
  return `obj:${parts}:${msg?.role || ""}`;
}

/**
 * S-6: Incremental render with per-message caching.
 *
 * The render cache lives on the session state as `state._renderCache`
 * (a Map of messageId → { hash, ref, rendered }). A message is re-rendered
 * only when:
 *   - its content hash changed (message was edited/streamed)
 *   - its ref changed (new ref assigned)
 *   - it is newly covered by / uncovered from a compression block
 *
 * This avoids O(n) object copies for the full conversation on every
 * llm/stream call. In steady state (no new messages, no compression),
 * the entire render is O(n) hash checks + array assembly, with zero
 * content copies.
 *
 * @param {Array} messages - the original DSH message array
 * @param {object} state - per-session plugin state
 * @returns {Array} rendered messages ready for the model
 */
export function renderMessagesIncremental(messages, state) {
  // Initialize cache on first use
  if (!state._renderCache || typeof state._renderCache !== "object") {
    state._renderCache = new Map();
  }
  const cache = state._renderCache;

  resolveAllPendingBlocks(state, messages);
  runQualityChecks(state);
  const coveredBy = buildCoveredMap(state);

  const result = [];
  const insertedBlocks = new Set();
  const seenIds = new Set();

  for (const msg of messages) {
    const ref = state.messageRefs.byRaw[msg.id];
    seenIds.add(msg.id);

    const coveringBlock = coveredBy.get(msg.id);
    if (coveringBlock) {
      if (!insertedBlocks.has(coveringBlock.blockId)) {
        insertedBlocks.add(coveringBlock.blockId);
        result.push(renderSummaryBlock(coveringBlock));
      }
      // Invalidate cache entry for covered messages (they'll be re-cached
      // when uncovered, e.g. after decompress)
      cache.delete(msg.id);
      continue;
    }

    // Try cache hit
    const cached = cache.get(msg.id);
    const hash = contentHash(msg);
    if (cached && cached.hash === hash && cached.ref === ref) {
      result.push(cached.rendered);
      continue;
    }

    // Cache miss: render and store
    const rendered = renderNormalMessage(msg, ref);
    cache.set(msg.id, { hash, ref, rendered });
    result.push(rendered);
  }

  // Evict stale cache entries (messages no longer in the conversation)
  if (cache.size > seenIds.size * 2 + 20) {
    for (const id of cache.keys()) {
      if (!seenIds.has(id)) cache.delete(id);
    }
  }

  return result;
}

/**
 * Render the full message list for model consumption:
 *   1. Resolve pending compression blocks
 *   2. Run quality checks on newly resolved blocks
 *   3. Build the covered-message lookup
 *   4. Walk messages, substituting summary blocks for compressed ranges
 *      and prepending ref tags to normal messages
 *
 * @param {Array} messages - the original DSH message array
 * @param {object} state - per-session plugin state
 * @returns {Array} rendered messages ready for the model
 */
export function renderMessages(messages, state) {
  resolveAllPendingBlocks(state, messages);
  runQualityChecks(state);
  const coveredBy = buildCoveredMap(state);

  const result = [];
  const insertedBlocks = new Set();

  for (const msg of messages) {
    const ref = state.messageRefs.byRaw[msg.id];

    const coveringBlock = coveredBy.get(msg.id);
    if (coveringBlock) {
      if (!insertedBlocks.has(coveringBlock.blockId)) {
        insertedBlocks.add(coveringBlock.blockId);
        result.push(renderSummaryBlock(coveringBlock));
      }
      continue; // skip covered messages
    }

    result.push(renderNormalMessage(msg, ref));
  }

  return result;
}

// ---------------------------------------------------------------------------
// Summary quality check (keyword coverage)
// ---------------------------------------------------------------------------

/**
 * Check whether a summary covers the key content of the original messages.
 * Extracts significant words (≥4 chars, non-stopword) from the originals
 * and reports what fraction appears in the summary.
 *
 * @param {string} summary - the model's summary text
 * @param {Array}  originalMessages - DSH messages that were compressed
 * @returns {{ coverage: number, missing: string[], checked: number }}
 */
export function checkSummaryQuality(summary, originalMessages) {
  if (!summary || !originalMessages || originalMessages.length === 0) {
    return { coverage: 0, missing: [], checked: 0 };
  }

  const STOPWORDS = new Set([
    "the", "and", "for", "are", "but", "not", "you", "all", "can", "was",
    "were", "this", "that", "with", "from", "have", "has", "had", "will",
    "would", "could", "should", "there", "their", "what", "when", "where",
    "which", "who", "whom", "how", "why", "then", "than", "into", "over",
    "under", "after", "before", "between", "because", "while", "during",
    "about", "against", "through", "above", "below", "up", "down", "out",
    "off", "again", "further", "once", "here", "any", "each", "few", "more",
    "most", "other", "some", "such", "only", "own", "same", "so", "too",
    "very", "just", "also", "may", "might", "must", "shall", "per", "via",
    "请", "的", "了", "是", "在", "我", "有", "和", "就", "不", "人", "都",
    "一", "上", "也", "很", "到", "说", "要", "去", "你", "会", "着",
    "没有", "看", "好", "自己", "这", "他", "她", "它", "们", "那", "些",
    "什么", "怎么", "可以", "能", "如果", "因为", "所以", "但是", "而",
  ]);

  const summaryLower = summary.toLowerCase();
  const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff]+/g;

  // --- Extract: CJK character runs (for bigrams) + Latin words ---
  const cjkRuns = [];
  const latinWords = new Set();
  for (const msg of originalMessages) {
    if (!msg || !Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      if (!b || b.type !== "text" || typeof b.text !== "string") continue;
      for (const run of b.text.match(CJK_RUN) || []) cjkRuns.push(run);
      const words = b.text.split(/[^a-zA-Z]+/);
      for (const w of words) {
        const lower = w.toLowerCase();
        if (lower.length >= 4 && !STOPWORDS.has(lower)) latinWords.add(lower);
      }
    }
  }

  // --- CJK: character bigrams ---
  // Word segmentation is unavailable, and splitting a run on punctuation
  // would treat entire unbroken stretches as single "words" (structurally
  // skewed coverage). Bigrams are the standard segmentation-free proxy:
  // they are meaningful units in Chinese, and set coverage is a sane signal.
  const cjkBigrams = new Set();
  for (const run of cjkRuns) {
    if (run.length === 1) cjkBigrams.add(run);
    for (let i = 0; i < run.length - 1; i++) cjkBigrams.add(run.slice(i, i + 2));
  }
  const cjkMissing = [];
  let cjkFound = 0;
  for (const bg of cjkBigrams) {
    if (summary.includes(bg)) cjkFound++;
    else if (cjkMissing.length < 15) cjkMissing.push(bg);
  }

  // --- Latin: words ≥ 4 chars, non-stopword ---
  const latinMissing = [];
  let latinFound = 0;
  for (const kw of latinWords) {
    if (summaryLower.includes(kw)) latinFound++;
    else if (latinMissing.length < 15) latinMissing.push(kw);
  }

  // --- Combine ---
  if (cjkBigrams.size === 0 && latinWords.size === 0) {
    return { coverage: 1, missing: [], checked: 0 };
  }
  if (latinWords.size === 0) {
    return {
      coverage: cjkBigrams.size > 0 ? Math.round((cjkFound / cjkBigrams.size) * 100) : 1,
      missing: cjkMissing,
      checked: cjkBigrams.size,
    };
  }
  if (cjkBigrams.size === 0) {
    return {
      coverage: Math.round((latinFound / latinWords.size) * 100),
      missing: latinMissing,
      checked: latinWords.size,
    };
  }

  const total = cjkBigrams.size + latinWords.size;
  const found = cjkFound + latinFound;
  const missing = [...cjkMissing, ...latinMissing];
  if (missing.length > 25) {
    missing.length = 25;
    missing.push("…");
  }

  return {
    coverage: Math.round((found / total) * 100),
    missing,
    checked: total,
  };
}

// ---------------------------------------------------------------------------
// Parse compress input (simplified from kernel parse-compress-input.ts)
//
// The model calls compress with a single `content` string containing one or
// more range blocks, each starting with a header line:
//   m00015–m00025 optional topic
// followed by the summary markdown.
//
// We parse this into an array of { startRef, endRef, summary, topic }.
// ---------------------------------------------------------------------------

/**
 * Parse the compress tool's `content` argument into range objects.
 *
 * Accepted formats (in order of preference):
 * 1. Multi-line string with "mNNNNN–mNNNNN topic\nsummary..." blocks
 * 2. Single range: { startRef, endRef, summary, topic } object
 * 3. Legacy: { startId, endId, summary } object
 *
 * @param {string|object} input - the compress tool argument
 * @returns {Array<{startRef: string, endRef: string, summary: string, topic?: string}>}
 */
export function parseCompressInput(input) {
  // Object form
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const startRef = input.startRef || input.startId;
    const endRef = input.endRef || input.endId;
    const summary = input.summary;
    if (startRef && endRef && typeof summary === "string") {
      return [{ startRef, endRef, summary, topic: input.topic }];
    }
    // content field inside object
    if (typeof input.content === "string") {
      return parseCompressContent(input.content);
    }
    throw new Error("Invalid compress input: need startRef/endRef + summary, or content string");
  }

  // String form (or array of strings)
  if (typeof input === "string") {
    return parseCompressContent(input);
  }

  if (Array.isArray(input)) {
    // Array of strings: concatenate and parse
    const text = input.filter((s) => typeof s === "string").join("\n");
    return parseCompressContent(text);
  }

  throw new Error("Invalid compress input: expected string, object, or array");
}

/**
 * Parse a multi-line content string into range blocks.
 */
function parseCompressContent(text) {
  const lines = text.split("\n");
  const ranges = [];
  let current = null;

  // Header pattern: mNNNNN–mNNNNN [topic]
  // Supports both – (en-dash), - (hyphen), and — (em-dash) as range separators
  const headerPattern = /^(m\d{1,7})\s*[–—-]\s*(m\d{1,7})\s*(.*)$/i;

  for (const line of lines) {
    const match = headerPattern.exec(line.trim());
    if (match) {
      if (current) ranges.push(current);
      const rest = match[3].trim();
      current = {
        startRef: match[1],
        endRef: match[2],
        topic: rest || undefined,
        summaryLines: [],
      };
    } else if (current) {
      current.summaryLines.push(line);
    }
    // Lines before the first header are ignored (or could be a preamble)
  }
  if (current) ranges.push(current);

  // Finalize: join summary lines
  for (const r of ranges) {
    r.summary = r.summaryLines.join("\n").trim();
    delete r.summaryLines;
    if (!r.summary) {
      throw new Error(`Empty summary for range ${r.startRef}–${r.endRef}`);
    }
  }

  if (ranges.length === 0) {
    throw new Error("No compress ranges found in content. Expected format: 'm00015–m00025 topic\\nsummary text'");
  }

  return ranges;
}
