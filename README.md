# nano-context

> **Scope**: This is a DSH (deepseek-harness) **Web-surface plugin**, validated
> for DSH `0.2.1-rc.5` with a llama.cpp local-model backend. It is **not** a
> generic npm package: it will not install or run outside a DSH runtime
> (`dsh web`). The CLI/client surface is **not** supported. It is intended to
> run at the **host level** (top-level `insert` in the profile's
> `cordis.patch.yml`) so that it intercepts `llm/stream` for every session.
> See [Scope / compatibility](#scope--compatibility) for the full matrix.

Nano-scale in-process context compression for [DSH](https://github.com/deepseek-ai/deepseek-harness). No proxy, no network, reversible. A minimal reimplementation of [billion-context](https://github.com/ranxianglei/billion-context)'s model-driven compression, scoped to a single local DSH + llama.cpp deployment.

**In-process. Pure local. No proxy. No network egress. No auto-update. Complementary to native compaction.**

## Design: complementary, not replacement

This plugin does **NOT** disable or replace DSH's built-in `dsh-compaction-basic`.
Both mechanisms coexist:

| | Native `dsh-compaction-basic` | `nano-context` (this plugin) |
|---|---|---|
| Trigger | Deterministic (80% threshold, 65K headroom) | Model-driven (tool call) + nudge at 50% |
| Reversible | No (originals replaced permanently) | Yes (`decompress` restores originals) |
| Searchable | No | Yes (`search_context`) |
| Targeting | Uniform (retain newest 16%) | Model chooses what to compress |
| Safety net | Yes (overflow recovery on CONTEXT_WINDOW_EXCEEDED) | No (depends on model remembering to call) |
| `/compact` | Yes | No |

**Why both?** Native compaction covers the "model 跑偏 / forgets to call the tool"
failure mode with a deterministic trigger. This plugin adds targeted, reversible,
searchable compression that the model can control. If the model never calls
`compress`, native compaction still fires at the threshold.

## What it does

When your local model's context grows, the model itself decides what to
compress. This plugin gives the model five tools:

| Tool | Purpose |
|------|---------|
| `compress` | Replace consumed conversation ranges with self-contained summaries the model writes |
| `decompress` | Restore original messages from a compressed block |
| `search_context` | Keyword search across compressed blocks (summaries + originals). Results include `decompressHint` when a block's originals also matched — decompress to see full details. |
| `merge` | Merge two adjacent blocks into one (reduces block count, keeps combined summaries) |
| `acp_status` | Report token usage, active blocks, per-block quality, total savings, and recent activity trail |

The model is nudged to compress when context exceeds 50% of the limit (with a 10%
cooldown between nudges). Compressed ranges are replaced with the model's summary
in subsequent requests. Originals are preserved in-memory for decompression.

## Why "nano"

Compared to billion-context (2.6MB kernel, 239 files, multi-client adapters,
proxy, MySQL, auto-update, MITM certs):

| | billion-context | nano-context |
|---|---|---|
| Files | 239 | 5 |
| Clients | pi, opencode, codex, claude, kimi, zcode, hermes, dsh | DSH only |
| Network | Proxy + auto-update + advisory | None |
| Persistence | MySQL | In-memory |
| Proxy | Local HTTP proxy | None (in-process) |
| MITM certs | Yes | No |
| Tiers | 3 (tier1/tier2/tier3) | 1 (tier1) |
| Native compaction | Replaces it | Complements it |

## Architecture

```
DSH agent loop
  │
  ├── dsh-compaction-basic (native, always active)
  │     └── Deterministic trigger at 80%, overflow recovery, /compact
  │
  ├── llm/stream waterfall
  │     └── nano-context intercept
  │           ├── Assign refs (m00001, m00002, …) to new messages
  │           ├── Resolve pending compression blocks
  │           ├── Replace compressed ranges with summary blocks
  │           ├── Prepend [mNNNNN] ref tags to text blocks
  │           └── Inject system prompt block (compression philosophy + rules)
  │
  ├── agent/assistant-stream
  │     └── nano-context observer
  │           └── Token usage > 50% → agent.steer(nudge text) [10% cooldown]
  │
  └── Tool execution (compress / decompress / search_context / acp_status)
        └── nano-context engine (in-memory state per session, LRU 32)
```

### Data flow

1. **First request**: All messages get ref tags. System prompt block is injected.
2. **Model compresses**: Calls `compress` with a content string. Engine creates
   a block with `pendingRefs` (start/end refs). Block is not yet resolved.
3. **Next request**: `llm/stream` intercept resolves the block's refs against
   the current message array, stores original messages, marks the range as covered.
   Covered messages are replaced with the summary block in the rendered output.
4. **Model decompresses**: Calls `decompress` with a blockId. Block is deactivated.
   Original messages reappear in the next request.
5. **Model searches**: Calls `search_context`. If a block's originals also
   matched, the result carries `decompressHint: true` — the model should
   `decompress` that block to see the full matched context.
6. **Model merges**: Calls `merge` on two adjacent blocks to reduce block
   count. The surviving block keeps the lower id; summaries are concatenated
   (newer first, `---` separator).
7. **Nudge**: When token usage exceeds 50%, a nudge is injected via `agent.steer()`.
8. **Overflow**: If context still overflows, native compaction fires as safety net.

## Robustness & safety

### Fault tolerance

- **`llm/stream` intercept**: Wrapped in a full outer try/catch. ANY error
  (including state corruption, missing session, engine bugs) causes the
  original frozen options to pass through unchanged. The plugin NEVER blocks
  a model request.
- **Deep-frozen options**: The loop-built request options are deep-frozen.
  The plugin never mutates them — it builds a new options object and calls
  `next.call(this, newOptions)`.
- **Tool errors**: All tool execution errors (invalid refs, missing args,
  block not found) surface as tool error text to the model, not as crashes.
- **Block cap**: `maxBlocks` (default 50) is enforced — new compress calls
  are refused at the cap with a message suggesting decompress/search.
- **Session LRU**: Per-session state is capped at 32 sessions (oldest evicted
  with a WARNING log showing active-block count). `lastKnownTokens` and
  `lastNudgeTokens` maps are capped at 64 entries each (FIFO eviction).
- **Nudge cooldown**: 10% token growth required between nudges — prevents
  steer storms.
- **Search cache**: Per-block search index (`_searchCache`) is built lazily
  on first search and invalidated on decompress/merge. Avoids re-scanning
  originals on every search call.

### Security

- **No network egress**: The plugin makes zero network calls. No fetch, no
  DNS, no sockets. All operations are on in-memory strings.
- **No file I/O**: The plugin reads and writes no files at runtime.
- **Untrusted content boundary**: The system prompt instructs the model to
  treat all tool-output-derived content in summaries as DATA, not instructions.
  Embedded injection attempts ("ignore previous", "system:") are not propagated
  as directives.
- **Session isolation**: Each session has its own compression state. Tools
  can only access their owning session's blocks (enforced by `sessionId`
  scoping in `executeTool`).
- **No auto-update, no advisory package, no MITM certs**: The plugin has no
  mechanism to fetch, update, or verify external content.

### Original-token cap (memory bound)

The sum of `originalTokens` across all **active** compressed blocks is capped
at **256 000 tokens** (`MAX_TOTAL_ORIGINAL_TOKENS`, exported from engine.js).
When the cap is exceeded on a new compression, the **oldest** active
non-triggering block is auto-decompressed (lossless — originals remain in the
live message array). The triggering block is never evicted. Each eviction
appends an audit entry (`decompress: auto-decompressed (original-token cap)`).

This bounds the in-memory footprint of the block store in very long sessions
while keeping the mechanism lossless.

### Compression quality verification (CJK-aware)

After a compression block is resolved (on the next `llm/stream` render pass),
the engine runs `checkSummaryQuality()` — a lightweight coverage check that
compares significant terms from the original messages against the summary:

- **CJK text** (U+4E00–U+9FFF, U+3400–U+4DBF): character **bigrams** are
  extracted (single characters count as unigrams). No segmentation needed.
- **Latin text**: words ≥ 4 chars, non-stopword.
- **Combined**: if both CJK and Latin terms are present, coverage is the
  combined found/total ratio.

Per-block quality is stored as `block.quality = { coverage, missing, checked }`.
The missing list is capped at 25 entries (combined) or 15 (single-language),
with a `…` sentinel when truncated.

- **Quality ≥ 30%**: no action.
- **Quality < 30%**: an audit warning is logged. The `acp_status` report
  shows the missing terms so the model can re-compress with a better summary.
- Quality is displayed per-block in `acp_status`: `quality: 75%`.

### Compression history / audit trail

Every significant operation appends an entry to `state.audit[]`:

| Event | detail example |
|-------|---------------|
| `compress` | `b1: resolved (12 msgs, ~450 orig / ~12 summary)` |
| `compress` (failure) | `b3: FAILED — refs m00900..m00999 not found` |
| `decompress` | `b2: decompressed (8 msgs restored)` |
| `merge` | `b1 absorbed b2 (16 msgs, ~800 orig / ~25 summary)` |
| `search` | `"JWT" → 3 match(es)` |
| `quality` (warning) | `b4: quality 12% — missing: token, expiration, refresh` |

Entries are capped at 100 (oldest evicted). The `acp_status` report shows the
last 5 entries under **Recent activity**.

### Graceful restart (S-4)

When the DSH process restarts, in-memory state is lost. On the next
`llm/stream` request, if the message array carries `[mNNNNN]` ref tags
(left over from the previous session's render) but the plugin's state is
fresh (no refs assigned), `detectAndCleanRestart()` strips the stale tags,
re-baselines refs from `m00001`, logs a restart notice, and records an
audit entry (`restart-rebaseline`). This prevents stale ref tags from
confusing the model or causing ref collisions.

### Compression budget (S-3)

`MAX_SUMMARY_RATIO` (default 1.0, exported) defines the maximum allowed
ratio of summary tokens to original tokens. When a compression block's
summary exceeds `originalTokens × MAX_SUMMARY_RATIO`, the block is flagged
with `budgetWarning: true` and an audit entry (`budget-warning`) is
recorded. This is a **warning only** — the compression is not rejected.
The `acp_status` report shows `⚠ budget exceeded` per flagged block,
alerting the model to consider a more concise summary.

### Incremental render (S-6)

`renderMessagesIncremental()` (exported from engine.js, used by the
`llm/stream` handler) maintains a per-message render cache
(`state._renderCache`). A message is re-rendered only when its content
hash changes, its ref changes, or its coverage status changes (block
created/decompressed). In steady state (no new messages, no compression),
the render pass is O(n) hash checks with zero content copies. The cache
is lazily initialized and evicts stale entries when it grows beyond
2× the message count + 20.

### Structured metrics (S-2)

`updateMetrics(state, currentTokens)` and `getMetrics(state, currentTokens)`
are exported from engine.js. `acp_status` now appends a `Metrics:` line
with a JSON object containing: `activeBlocks`, `totalBlocks`,
`tokensCompressed`, `tokensSaved`, `savingsPct`, `totalSummaryTokens`,
`compressionCount`, `decompressionCount`, `mergeCount`, `searchCount`,
`nudgeCount`, `qualityWarnings`, `totalTokensSeen`, `peakBlocks`.
This enables programmatic monitoring and integration with external
tooling.

### Known limitations

- **In-memory only**: State is lost when the DSH process restarts. No session
  persistence. For a single local session this is usually fine. Graceful
  restart detection (S-4) strips stale ref tags on the next request, but
  compression blocks themselves are lost.
- **Model-dependent**: `compress` only fires when the model calls the tool.
  If the model forgets, native compaction covers the gap.
- **Single-tier**: No tier2/tier3 distillation. At 128K window with maxBlocks=50,
  summary accumulation is capped at a few thousand tokens — tier recursion is
  unnecessary and would degrade quality with a small local model.
- **Token estimation**: Uses a CJK-aware heuristic (~1 token/char CJK,
  ~4 chars/token ASCII). Approximate, not exact. Real token counts from the
  nudge observer override the estimate in `acp_status` when available.
- **Quality check is heuristic**: Coverage (CJK bigrams + Latin words) is a
  proxy, not a semantic evaluation. A summary can pass with low coverage if
  it paraphrases well, or fail with high coverage if it lists terms without
  substance.
- **Merge staleness**: `merge` uses the `_lastMessageIds` snapshot from the
  previous render pass for the adjacency check. Messages created after the
  last render (but before the merge call) are not visible to the check. This
  is acceptable: new messages only appear *after* both blocks' ranges, so
  they cannot break adjacency.
- **Budget warning is advisory**: The compression budget (S-3) only warns;
  it does not reject. The model is expected to self-correct by writing a
  more concise summary on the next compress call.

## Files

```
nano-context/
├── index.js              # Plugin entry: Config, apply(), tools, llm/stream, nudge
├── engine.js             # Compression engine: refs, blocks, compress, decompress, merge,
│                         #   search, status, render (incremental), quality, audit, cap,
│                         #   restart detection, metrics, budget
├── prompts.js            # System prompt block, nudge text, tool descriptions
├── package.json          # DSH plugin contract + npm metadata
├── patch.yml             # Bundle patch (layer stack insertion)
├── LICENSE               # MIT + billion-context attribution
├── .gitignore
├── .github/
│   ├── workflows/ci.yml  # CI: node --test on push + PR
│   └── ISSUE_TEMPLATE/
│       └── bug_report.md
└── test/
    ├── engine.test.js    # Unit tests (78 tests)
    └── index.test.js     # Integration tests (39 tests)
```

## Install

### npm (inside a DSH profile)

Add the package to your profile's `package.json` and to its
`dsh.profile.bundles` list:

```json
{
  "dependencies": {
    "@quekenao/nano-context": "^0.4.1"
  },
  "dsh": {
    "profile": {
      "bundles": ["<existing bundles…>", "nano-context"]
    }
  }
}
```

Then run `npm install` in the profile directory and restart `dsh web`.

### Local (symlink or copy)

```bash
# Option 1: symlink
ln -s /path/to/nano-context $DSH_HOME/profiles/<your-profile>/node_modules/nano-context

# Option 2: copy
cp -r /path/to/nano-context $DSH_HOME/profiles/<your-profile>/node_modules/nano-context
```

Both approaches still require adding `"nano-context"` to the profile's
`dsh.profile.bundles` and an `insert` entry in the profile's
`cordis.patch.yml` (see Configuration below).

The bundle patch (`patch.yml`) is applied automatically by DSH's layer stack
once the bundle is listed. Restart `dsh web` to activate — HMR cannot load
plugin code whose import edges reach the host entry graph.

## Configuration

Add an `insert` entry to the profile's `cordis.patch.yml` (the bundle's own
`patch.yml` only declares the plugin; config is passed here):

```yaml
- insert:
    - id: nano-context
      name: 'nano-context'
      config:
        contextLimit: 65536     # model context window in tokens (match your model!)
        nudgeThreshold: 0.5     # nudge at 50% of context
        maxBlocks: 50           # max active blocks (hard cap)
```

| Config | Default | Description |
|--------|---------|-------------|
| `contextLimit` | 131072 | Model context window in tokens (used for nudge + status). **Must match your actual model window** — a limit larger than the window means the nudge never fires. |
| `nudgeThreshold` | 0.5 | Fraction of contextLimit at which a nudge fires |
| `maxBlocks` | 50 | Hard cap on active blocks; new compress refused at cap |

## Debug

Set `DSH_NANO_CONTEXT_DEBUG=1` to enable stderr logging:

```bash
DSH_NANO_CONTEXT_DEBUG=1 dsh web
```

## Scope / compatibility

**This plugin is a DSH plugin. It does not work outside a DSH runtime.**

- **Topology**: DSH + llama.cpp + local model
- **Required DSH version**: 0.2.1-rc.5
- **Required Cordis**: ~4.0.5
- **Required dsh-llm**: >= 0.2.1-rc.5
- **Required dsh-web-app**: >= 0.2.1-rc.5
- **Surface**: Web surface only (`dsh web`)
- **Node.js**: >= 24

### Usage boundaries

**Supported** (validated):

- DSH **Web surface** (`dsh web`) on the `0.2.1-rc.5` release line.
- **Local model backends**: llama.cpp serving a local model (any window size —
  set `contextLimit` to your model's window).
- **Host-level installation**: the plugin is intended to run at the host level
  (a top-level `insert` in the profile's `cordis.patch.yml`), intercepting
  `llm/stream` for every session regardless of which agent preset the session
  uses.

**Not supported** (out of scope):

- **DSH CLI / client surface** (`dsh run`, TUI, etc.) — the plugin is not
  adapted for non-Web surfaces; `clientSupported: false` in `package.json`.
- **Remote / cloud model providers** — the design targets in-process local
  inference; it technically works against any DSH LLM endpoint, but it has
  not been validated there.
- **Other DSH versions** — the plugin depends on DSH-internal packages
  (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-llm`,
  `@deepseek-ai/dsh-web-app`) and the 0.2.1-rc.5 plugin contract. It may
  break on newer or older releases.
- **Multi-process / cluster deployments** — state is in-memory per process.

The `@deepseek-ai/*` peer dependencies are DSH-internal packages resolved by the
DSH plugin loader at runtime. They are marked `optional` in `peerDependenciesMeta`
so that `npm install` does not fail outside a DSH environment — but the plugin
will not function without a running DSH instance providing these packages.

## Changelog

### 0.4.1 (2026-11-01)

- **README**: added a top-of-file scope note and a dedicated *Usage
  boundaries* section (supported surfaces, host-level installation
  guidance, explicit out-of-scope list: CLI/client surface, remote
  providers, other DSH versions, cluster deployments).
- **README / package.json**: removed deployment-specific references
  (concrete model size, local endpoints) from the description text;
  removed the unreleased GitHub repository field from `package.json`.

### 0.4.0 (2026-11-01)

**Rename: `dsh-lw-compress` → `nano-context`**
- New name: nano-scale in-process context compression. Direct contrast with
  billion-context (10⁹ vs 10⁻⁹). Concise, memorable, search-friendly.
- Directory renamed to `nano-context/`.
- Plugin name, package name, patch.yml id, all log prefixes updated.
- Debug env var: `DSH_NANO_CONTEXT_DEBUG`.

**Publish-readiness**
- `LICENSE`: standalone MIT file with billion-context attribution (satisfies
  MIT + additional attribution term from the upstream LICENSE).
- `.gitignore`: node_modules, logs, .DS_Store, .env, coverage.
- `.github/workflows/ci.yml`: `node --test` on push + PR (Node 24).
- `.github/ISSUE_TEMPLATE/bug_report.md`: minimal bug report template.
- `package.json`: `name` (no `@local/` scope), `engines`, `keywords`,
  `repository`, `sideEffects`, `scripts` (test + prepublishOnly), `license`,
  `files` includes LICENSE.

**Attribution**
- README: billion-context credit with link (satisfies the upstream
  attribution-on-product-surfaces term).
- LICENSE: explicit attribution section.

### 0.3.1 (2026-07-21)

**P3-fix — TDZ dead zone cleanup**
- Moved `REF_CONTENT_PATTERN` declaration above `hasRefTagInContent` in
  engine.js to eliminate a theoretical TDZ (temporal dead zone) hazard.
  The constant was declared after the function that references it; while
  runtime-safe (the function is only called post-module-evaluation), the
  ordering was corrected for code hygiene. Zero functional change.

### 0.3.0 (2026-07-21)

**S-1 — Integration tests**
- New `test/index.test.js`: 30 integration tests covering the full plugin
  surface (apply, tool registration, llm/stream intercept, nudge, compress,
  decompress, search, merge, status, session isolation, LRU eviction,
  error handling, pending-block lifecycle, byte-stable system prompt,
  maxBlocks cap). Total test count: 78 + 30 = 108 (now 117 with S-2/S-3/S-4).

**S-2 — Structured metrics**
- `updateMetrics(state, currentTokens)`: updates peak context tokens,
  cumulative savings, peak block count.
- `getMetrics(state, currentTokens)`: returns a flat JSON-serializable
  object with 14 metrics (activeBlocks, totalBlocks, tokensCompressed,
  tokensSaved, savingsPct, totalSummaryTokens, compressionCount,
  decompressionCount, mergeCount, searchCount, nudgeCount,
  qualityWarnings, totalTokensSeen, peakBlocks).
- `acp_status` appends `Metrics: {...}` JSON line.
- `createInitialState` stats extended with mergeCount, nudgeCount,
  totalTokensSeen, totalTokensSaved, totalSummaryTokens, qualityWarnings,
  peakBlocks.

**S-3 — Compression budget**
- `MAX_SUMMARY_RATIO = 1.0` exported from engine.js.
- Budget check in both `applyCompression` and `resolvePendingBlock`:
  when summary tokens exceed originalTokens × ratio, block gets
  `budgetWarning: true` + audit entry. Warning only, not rejection.
- `buildStatus` shows `⚠ budget exceeded` per flagged block.

**S-4 — Graceful restart**
- `detectAndCleanRestart(messages, state)`: detects stale `[mNNNNN]` tags
  when state is fresh, strips them, re-baselines refs from m00001, logs
  restart notice, records `restart-rebaseline` audit entry.
- `hasRefTagInContent(msg)`, `stripRefTags(msg)` exported helpers.
- Wired into `llm/stream` handler as Step 0 before `assignRefs`.

**S-5 — renderMessages refactor**
- Monolithic ~80-line `renderMessages` decomposed into 5 focused helpers:
  `resolveAllPendingBlocks`, `runQualityChecks`, `buildCoveredMap`,
  `renderSummaryBlock`, `renderNormalMessage`.
- `renderMessages` is now a ~25-line orchestrator.

**S-6 — Incremental render**
- `renderMessagesIncremental(messages, state)`: per-message render cache
  (`state._renderCache`). Content-hash based (length + first/last 80 chars).
  Messages re-rendered only on content/ref/coverage change.
- `llm/stream` handler uses `renderMessagesIncremental` instead of
  `renderMessages`.
- Cache evicts stale entries when > 2× message count + 20.

**S-7 — JSDoc typedefs**
- 7 typedefs added: `CompressionBlock`, `CompressionStats`,
  `CompressionState`, `QualityResult`, `Metrics`, `RestartResult`.
- All exported functions use `@param {CompressionState}` etc.

**S-8 — Version + docs**
- Version 0.2.0 → 0.3.0.
- README updated: new sections for S-2/S-3/S-4/S-6, updated files list,
  updated known limitations.

**S-9 — Test suite**
- 117 tests total: 78 engine + 39 integration (30 original + 6 S-2/S-3
  + 3 S-4). All passing.

### 0.2.0 (2026-07-20)

**P1 — Original-token cap**
- Added `MAX_TOTAL_ORIGINAL_TOKENS` (256k tokens, exported). When the sum of
  `originalTokens` across active blocks exceeds the cap, the oldest
  non-triggering block is auto-decompressed (lossless). Triggering block is
  never evicted. Audit entry logged per eviction.

**P2 — Search cache + CJK quality**
- Per-block `_searchCache` built lazily, invalidated on decompress/merge.
- `checkSummaryQuality` rewritten: CJK character bigrams (U+3400–U+9FFF)
  + Latin words ≥ 4 chars; combined coverage when both present; missing
  list capped (25 combined / 15 single-language) with `…` sentinel.
- `decompressHint` on `search_context` results when originals also matched.

**P3 — Robustness & cleanup**
- `mergeBlocks`: `directMessageIds` / `effectiveMessageIds` = deduped union
  of DIRECT ids (not effective), sorted by live-message position.
  `originalMessages` concatenated in chronological order.
- Session eviction: LRU with WARNING log (active-block count);
  `lastKnownTokens` / `lastNudgeTokens` capped at 64 (FIFO).
- `buildStatus`: `Context: unknown` when no real token count available;
  `Tokens freed (originals): N across M compression(s)`.
- `tokensCompressed` semantics unified: counts ORIGINAL tokens freed.
- CJK range in token estimators extended to include Extension A
  (U+3400–U+4DBF), consistent with `checkSummaryQuality`.
- `survivedCount` field removed from all block shapes (dead weight).
- `parseCompressInput` header regex supports en-dash `–`, em-dash `—`,
  hyphen `-` (with optional surrounding spaces).
- JSDoc added to `audit()`, `enforceOriginalTokenCap()`, `evictSession()`.
- `patch.yml` comment fixed: `maxBlocks` = max active blocks before
  REFUSAL (default 50).
- Version bumped 0.1.0 → 0.2.0.

**P4 — Tests**
- 20 new tests (58 → 78): original-token cap (auto-decompress, triggering
  block protection), CJK quality (high/low/mixed/pure coverage),
  `parseCompressInput` dash matrix (en-dash, hyphen, em-dash, spaces,
  multi-range, empty-summary rejection, object form), `mergeBlocks`
  (id ordering, nested-coverage rejection, render survival,
  originalMessages chronology), `buildStatus` (unknown context,
  tokens-freed line).

### 0.1.0 (2026-07-19)

Initial release. Five tools: compress, decompress, search_context, merge,
acp_status. Complementary to native `dsh-compaction-basic`. In-process,
pure local, no network.

## License

MIT. See [LICENSE](LICENSE).

**Attribution**: nano-context is derived from [billion-context](https://github.com/ranxianglei/billion-context)
(MIT License, © 2026 ranxianglei). Compression philosophy, ref-tag mechanics,
block state model, and kernel concepts from billion-context are used under the
terms of the MIT License, including its additional attribution term.
