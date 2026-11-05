# nano-context 发布手册（npm + GitHub）

> **目的**：以后发新版（0.4.3、0.5.0 …）照着本文走一遍即可，**一次完成、不反复重试**。
> 本文汇总了 0.4.1 / 0.4.2 两次发布中踩过的所有坑，以及"如何先查状态再动手"的防重试规则。
>
> 源码目录：`F:\dsh-0.2.1-rc.5\plugins\nano-context`
> 包名：`@quekenao/nano-context`（npm scoped 名，**不是** `nano-context`）
> 仓库：`quekenao/nano-context`

---

## 0. 防重试总规则（最重要）

**任何一步动手之前，先查"线上是否已经做完"。** 已经完成的步骤一律跳过，只补缺失的部分。
重复执行同一动作不是"再试一次"，而是制造垃圾（npm E409 报错、GitHub 重复 commit、重复 release）。

| 目标 | 查询命令（只读，不产生任何写入） | 含义 |
|------|--------------------------------|------|
| npm 是否已有某版本 | `npm view @quekenao/nano-context versions` | 列出版本数组；含目标版本 = **npm 端已完成** |
| npm 线上最新版本 | `npm view @quekenao/nano-context version` | 返回单个版本字符串 |
| GitHub 仓库是否存在 | `web_fetch https://api.github.com/repos/quekenao/nano-context` | 200 = 存在 |
| GitHub 某 tag/release 是否存在 | `web_fetch https://api.github.com/repos/quekenao/nano-context/releases/tags/vX.Y.Z` | 200 = **GitHub 端已完成** |
| GitHub main 上某文件是否已是最新 | 见 §5 "单文件 diff" | 本地与远端 sha 相同 = 该文件无需上传 |

**只有当查询结果证明目标尚未完成时，才执行对应动作。每个目标版本：npm publish 最多执行 1 次，GitHub 同步最多执行 1 次。**

### 判定"发布完成"的标准

一个版本（vX.Y.Z）**发布完成** = 以下四项全部成立：

1. `npm view @quekenao/nano-context versions` 包含 `X.Y.Z`；
2. GitHub main 分支上所有源码文件与本地一致（或至少关键文件已上传）；
3. GitHub 存在 tag `vX.Y.Z`；
4. GitHub 存在 release `vX.Y.Z`（非 draft）。

四项都成立时，**不要再执行任何发布命令**。

---

## 1. 发布前检查清单（本地，零副作用）

在 `F:\dsh-0.2.1-rc.5\plugins\nano-context` 目录下：

```bash
# 1) 版本号：package.json 的 version 必须已 bump 到目标版本
node -p "require('./package.json').version"

# 2) 测试：prepublishOnly 会在 npm publish 时自动跑，提前跑一遍确认不挂
npm test
# 期望输出：117 tests / 0 failures（engine 78 + integration 39）

# 3) git 状态：确认改动已提交（npm 发布不要求 commit，但 GitHub 同步以本地文件为准）
git status --short
git log --oneline -3
```

**版本 bump 规则**（semver，npm 不允许覆盖已发布版本）：
- 修 bug / 默认值调整 → `patch`：`0.4.2 → 0.4.3`
- 新增工具 / 配置项（向后兼容） → `minor`：`0.4.2 → 0.5.0`
- 破坏性变更 → `major`

只改 README 这种纯文档更新，如果不想发新版，也可以只推 GitHub（§5）不发 npm。

---

## 2. 发布到 npm（一次，不重试）

### 2.1 前置：登录状态检查（只读）

```bash
npm whoami
```

- 返回 `quekenao` → 已登录，直接 §2.2。
- 返回 401 / `ENEEDAUTH` → **停下来让用户在终端执行 `npm login`**（浏览器 OAuth 或
  `npm login --auth-type=legacy` 输 token）。**不要**用 `npm publish` 去"试探"登录状态——
  失败会留下 E401 噪音，且可能把请求打到 registry 上。

### 2.2 发布

```bash
npm publish
```

`package.json` 已配置：
- `"publishConfig": { "access": "public" }`（scoped 包必须 public，否则默认 private 报错）
- `"prepublishOnly": "npm test"`（发布前自动跑测试，挂了会中止发布）

**成功标志**：输出 `npm notice` 列表 + 最后一行 `+ @quekenao/nano-context@X.Y.Z`。

### 2.3 发布后验证（只读）

```bash
npm view @quekenao/nano-context version time.modified
# 期望：version = 目标版本；time.modified 是刚才的时间
```

### 2.4 出错处理（不要盲目重跑 npm publish）

| 报错 | 原因 | 正确处理 |
|------|------|----------|
| `E409 ... Cannot publish over version` | **版本已发布过**（可能上次已成功，或网络超时后 registry 其实收下了） | **先 `npm view ... versions` 确认**。版本已在线上 = 发布实际成功，直接跳到 §3 补 GitHub；版本不在 = 检查报错详情，不要换版本号硬发 |
| `ENEEDAUTH` / `E401` | 未登录或 token 过期 | `npm whoami` 确认后让用户重新 `npm login` |
| `E403` | 账号无该 scope 权限（`@quekenao` 归账号所有，正常不会遇到） | 检查账号；不要换包名 |
| 网络超时（`ETIMEDOUT` / `ECONNRESET`） | 上传中断，registry 状态未知 | **等 10 秒后只查不写**：`npm view ... versions`。有 = 成功；没有 = 此时才可重跑 `npm publish`（最多再试 1 次） |

> 历史上 npm registry 处理 `0.4.1` 时出现过"publish 成功但响应延迟"的情况——
> 当时反复重试毫无意义，`npm view` 一查就是 live。

### 2.5 本地 profile 安装（npm 发布完成后，如需本地也用上）

本地 DSH 部署通过 **profile** 加载插件（不是全局 npm 安装）。两种做法：

**做法 A：依赖 npm 包（推荐，与发布版本严格一致）**

profile 的 `package.json`（`$DSH_HOME/profiles/web/package.json`）：

```json
{
  "dependencies": {
    "@quekenao/nano-context": "^0.4.2"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "@quekenao/nano-context"]
    }
  }
}
```

然后在 profile 目录 `npm install`，重启 `dsh web`。

**做法 B：junction / 指向本地源码目录（开发期）**

```powershell
# 本地插件源码 → profile 的 node_modules（包名不带 scope，文件夹名 nano-context）
cmd /c mklink /J "F:\dsh-0.2.1-rc.5\dsh-home-local-3097\profiles\web\node_modules\nano-context" "F:\dsh-0.2.1-rc.5\plugins\nano-context"
```

此时 `dsh.profile.bundles` 里写 **`"nano-context"`**（无 scope，与文件夹名一致），
依赖项写 `"nano-context": "file:F:/dsh-0.2.1-rc.5/plugins/nano-context"`。

> **⚠️ 踩过的坑（2026-11-01 真实事故）**：profile 里 `dependencies` 用 `"nano-context"`
> 但 `dsh.profile.bundles` 也写 `"nano-context"`，而 npm 安装出来的包是
> `node_modules/@quekenao/nano-context`（scoped 路径）。DSH 的 `resolveBundleDir`
> 按 bundle 条目名做 node_modules 查找，`nano-context` 查不到 → bundle 被
> **静默跳过**（stderr 只有一行 `skipping profile bundle`，`--dump-config`
> 里没有对应 patch 层）。
>
> **规则：`dsh.profile.bundles` 的条目必须等于 `node_modules` 下实际文件夹名。**
> - npm 安装 → 条目写 `"@quekenao/nano-context"`
> - junction/clone 安装 → 条目写 `"nano-context"`
>
> 验证方法：`node F:\dsh-0.2.1-rc.5\node_modules\@deepseek-ai\dsh\lib\bin.js --profile web --dump-config`
> 输出里应有 `patched by ...plugins\nano-context` 的层；或启动日志里**没有**
> `skipping profile bundle` 行。

### 2.6 cordis.patch.yml 配置（profile 层，与安装方式无关）

bundle 自带的 `patch.yml` 只**注册**插件（插入 layer 栈）；运行参数在 profile 的
`cordis.patch.yml` 里给：

```yaml
- insert:
    - id: nano-context
      name: 'nano-context'
      config:
        contextLimit: 65536     # 必须等于你的模型窗口！大于窗口则 nudge 永不触发
        nudgeThreshold: 0.7     # 70% 触发 nudge（低于原生 compaction 的 75%）
        maxBlocks: 50
```

**插件代码改动必须重启 `dsh web` 进程才生效**（HMR 无法热换触及宿主入口图的插件模块）。

---

## 3. 发布到 GitHub（一次，不重试）

### 3.1 网络约束（本机实测）

| 通道 | 状态 |
|------|------|
| `https://api.github.com` | ✅ 通（所有 GitHub 操作走这里） |
| `https://github.com:443`（网页 / git 协议直连） | ❌ 被网络阻断 → **不要用 `git push`**，走 API |
| `.github/workflows/` 路径（Contents API + Git Data API） | ❌ 服务器端 404（该实例路径级限制）→ **ci.yml 不上 GitHub**，本地保留即可（README 已注明） |

### 3.2 Token

GitHub PAT 只通过**环境变量**传入，不写进任何文件、不进仓库、不进 npm 包：

```powershell
$env:GH_TOKEN = "<token>"
```

- 权限：`repo`（Contents + Git Data + Releases 需要）
- 若用户把 token 粘贴在聊天里，**用完即弃**，不落盘。

### 3.3 同步脚本（幂等，可重跑但不会重复写）

现成脚本在 `F:\dsh-0.2.1-rc.5\dsh-home-local-3097\deepseek-harness\default-workspace\`：

| 脚本 | 用途 | 幂等机制 |
|------|------|----------|
| `github-publish.mjs` | 首版全量上传（12 文件）+ release | 每步先查远端：已存在的文件跳过；release 已存在则不重建 |
| `github-sync-0.4.2.mjs` | 后续版本的**变更文件**同步 + tag + release | 逐文件比对本地 sha1 与远端 blob sha，相同 = 跳过；tag/release 存在 = 跳过 |

**发新版（如 0.4.3）时，复制 `github-sync-0.4.2.mjs` 改三处**：
1. `const files = [...]` → 本次改动的文件列表（`git status --short` 里 M 的文件）
2. tag / release 名 → `v0.4.3`
3. release body → 本次 changelog

执行：

```powershell
$env:GH_TOKEN = "<token>"
node "F:\dsh-0.2.1-rc.5\dsh-home-local-3097\deepseek-harness\default-workspace\github-sync-0.4.2.mjs"
```

脚本内置逻辑（不需要手动操作的部分）：
- 文件上传：Contents API `PUT`，带远端 `sha`（避免并发冲突），base64 内容
- tag：先 `GET refs/tags/vX.Y.Z`，404 才 `POST`（409/422 时 `PATCH force` 兜底）
- release：先 `GET /releases/tags/vX.Y.Z`，404 才 `POST`

**成功标志**：输出 `Files: N updated, M unchanged, 0 failed` + `Done (all ok)`，
退出码 0。

### 3.4 出错处理（不要盲目重跑）

| 现象 | 正确处理 |
|------|----------|
| 某文件 PUT 报 409 | 远端已变（有人/有次运行改过）→ 重跑脚本即可，sha 比对会自动跳过已一致的 |
| tag 创建 409 | tag 已存在 → 脚本已自动走 PATCH 分支；若 PATCH 也 409，说明 tag 指向的 commit 不对，用 `PATCH /git/refs/tags/vX.Y.Z {sha, force:true}` 指到当前 main |
| release 422 `tag_name already exists` | 同 tag 已有 release → `GET /releases/tags/vX.Y.Z` 确认后跳过，或 `PATCH /releases/{id}` 改 body |
| 网络中断 | 重跑脚本即可——所有步骤幂等，只补缺口 |

---

## 4. 端到端验证清单（发完后，全部只读）

```bash
# A. npm 端
npm view @quekenao/nano-context versions
npm view @quekenao/nano-context dist.tarball

# B. GitHub 端（web_fetch 或带 token 的 fetch）
GET https://api.github.com/repos/quekenao/nano-context/releases?per_page=5
#   → 目标版本 release 存在、published_at 非空、非 draft
GET https://api.github.com/repos/quekenao/nano-context/git/trees/main?recursive=1
#   → 关键文件（index.js / engine.js / package.json / patch.yml / README.md / test/*）
#     的 blob sha 与本地文件 sha1 一致

# C. 本地 DSH 端（重启 dsh web 后）
#   1. 启动日志无 "skipping profile bundle" 行
#   2. 新会话中模型可见工具：compress / decompress / search_context / merge / acp_status
#   3. （可选）DSH_NANO_CONTEXT_DEBUG=1 启动，stderr 有 [nano-context] 加载日志
```

A + B + C 全部通过 = **发布完成**。此后不要再跑任何发布命令。

---

## 5. 单文件 diff（判断某文件是否已同步到 GitHub）

Contents API 的 blob sha 就是 git sha1（与本地 `git hash-object` 同值）：

```powershell
# 本地
cd F:\dsh-0.2.1-rc.5\plugins\nano-context
git hash-object engine.js
# 远端
# GET https://api.github.com/repos/quekenao/nano-context/git/trees/main?recursive=1
#   找 path=engine.js 的 sha
# 两者相同 → 已同步
```

---

## 6. 当前状态快照（2026-11-01 17:57 核实）

| 项目 | 状态 |
|------|------|
| npm `@quekenao/nano-context` | ✅ 已发布 **0.4.2**（versions: `0.0.0-stage`, `0.4.1`, `0.4.2`；0.0.0-stage 是早期占位，无害） |
| GitHub 仓库 | ✅ `quekenao/nano-context`，main 分支 13 个源码文件齐全（无 ci.yml，见 §3.1） |
| GitHub release | ✅ v0.4.1 + v0.4.2 均已发布 |
| 本地源码 git | ⚠️ 有未提交改动（README.md, engine.js, index.js, package.json, patch.yml, test/engine.test.js）——**发下一版前先 commit** |
| 本地 DSH profile | ✅ 已装并修正（junction `node_modules\nano-context` + bundle 条目 `nano-context` + cordis insert），**但需重启 `dsh web` 进程才激活**（bundle 名 = 文件夹名，npm 安装则条目要写 `@quekenao/nano-context`，见 §2.5） |

---

## 7. 历史教训（为什么会有这份文档）

1. **npm 0.4.1 发布时**：publish 响应延迟，误以为失败，反复重试。实际 registry
   已收下（`npm view` 一查即知）。→ §0 总规则。
2. **GitHub 首传时**：`git push` 走不通（网络阻断 github.com:443），改走
   api.github.com；`.github/workflows/` 路径被服务器端 404 拦截，ci.yml 放弃上传
   （README 已注明）。→ §3.1。
3. **bundle 名不匹配（2026-11-01）**：`dsh.profile.bundles` 写 `nano-context`，
   实际 npm 包落在 `node_modules/@quekenao/nano-context`，bundle 被静默跳过，
   插件根本没加载，`--dump-config` 里也没有它的 patch 层。→ §2.5 规则。
4. **token 管理**：GitHub PAT 只在环境变量里活过单次会话，从不落盘；
   npm 用浏览器 OAuth 登录，token 存 `~/.npmrc`（本机，不随包发布）。
5. **插件改动要重启**：HMR 只热更 web 前端与纯插件脚本中不触及宿主入口图的部分；
   nano-context 的 `llm/stream` 钩子在进程启动时挂载，改完必须重启 `dsh web`。
