# dsh-cli-mode

> Command-line mode for the DeepSeek Harness Web GUI composer.
> 在 Web UI 对话框中以 `！` 或 `!` 开头时，整行作为真实命令行在会话工作目录中执行，不再发送给模型。

## What it does

| | |
| --- | --- |
| **Enter** | 在输入框首字符输入 `！` 或 `!`（可带前导空格，如 `! npm --version`）即进入命令行模式 |
| **Red input** | 命令行模式激活时，输入区文字变红（`#e5484d`） |
| **Run** | `Enter` 执行 · `Shift+Enter` 换行 · `Esc` 清除该行并退出命令行模式 |
| **Feedback** | 成功：`命令已执行` + `` `cmd` 命令已执行 `` + 标准输出 + `cwd`；失败：系统报错原文 + **「下一步建议」** 编号清单 |
| **No model turn** | 命令不会进入模型上下文，不产生对话轮次；结果卡显示在输入区下方，可点「清除」 |

## Architecture

```
dsh-cli-mode/
├── lib/
│   ├── index.js      Host 半：cordis 插件，注册 /cli-mode/* 路由 + 通过 ctx.shell 执行 + 历史持久化
│   ├── suggest.js    纯函数：标记解析、失败渲染、报错指纹 → 下一步建议
│   └── client.js     浏览器半：lazy-CJS 客户端包（无需构建），DOM 监听 + 输入区变红 + 结果卡
├── cordis.patch.yml  bundle 层：insert 一行 `dsh-cli-mode`
├── dsh.plugin.json   插件清单（市场/工具可读的元数据）
└── package.json      声明 dsh.bundle.patch 与 dsh.client
```

- **Host 半**是普通 ESM cordis 插件（`export const name` + `export function apply(ctx)`），只通过 `ctx.get()` 读取 `webServer` / `shell` / `sessions` / `sandboxPolicy`，不引入任何 `@deepseek-ai/*` 依赖。
- **浏览器半**手写在 lazy-CJS 客户端包协议里（`window.__ModuleLoader__.load({ id, factory })`），因此**不需要构建步骤**；`require` 只取平台种子模块（`react`），与 Host 的通信使用同源 `fetch` 到插件自己的路由。
- 两个插槽：`conversation.composer`（chain，检测到标记时接管输入区）与 `conversation.composer.dock`（list，结果卡）。

### Host routes

| Route | Body | Response |
| --- | --- | --- |
| `POST /cli-mode/exec` | `{ command, sessionId, timeoutMs? }` | `{ ok, kind, command?, stdout?, stderr?, truncated?, workdir, message, suggestions? }` |
| `POST /cli-mode/workdir` | `{ sessionId }` | `{ workdir }` |
| `POST /cli-mode/history` | `{ sessionId }` 读取 / `{ sessionId, entries }` 写入 | `{ entries }` |

命令历史按会话持久化在 `${DSH_HOME:-~/.dsh}/cli-mode/history/<session>.json`（最多 200 条）。

### Failure suggestions

`suggest.js` 按报错指纹给出可执行的下一步，覆盖：命令/别名不存在、权限不足、路径不存在、目标是目录、目标已存在、PowerShell 命令或参数无法识别、语法与引号错误、非 Git 仓库、端口占用、缺依赖模块、缺少 `package.json`、npm 脚本不存在、沙箱拒绝、超时，以及兜底建议。

## Install into a profile

The plugin is a **bundle**: a profile picks it up by listing it in `dsh.profile.bundles`.

```sh
# 1. hand the package to the profile (a symlink is enough for local development)
#    <DSH_HOME>/profiles/<profile>/node_modules/dsh-cli-mode -> this directory

# 2. add the dependency and the bundle layer to
#    <DSH_HOME>/profiles/<profile>/package.json
#      "dependencies": { "dsh-cli-mode": "link:<this directory>" }
#      "dsh": { "profile": { "bundles": [ ..., "dsh-cli-mode" ] } }

# 3. restart the profile so the Host mounts the row and the Web shell loads the client bundle
dsh web
```

A publishable install is the same command the market uses:

```sh
dsh plugin --profile web add <package-or-tarball-or-git-url>
```

`dsh plugin add` runs pnpm in the profile directory and then reconciles
`dsh.profile.bundles` from the installed state, so a package that declares
`dsh.bundle` joins the layer stack automatically.

## Configuration

Edit the constants at the top of each half — no settings schema, so an
unwritable settings file can never disable the command line:

| Constant | File | Default | Meaning |
| --- | --- | --- | --- |
| `DEFAULT_TIMEOUT_MS` | `lib/index.js` | `120000` | default per-command timeout |
| `MAX_TIMEOUT_MS` | `lib/index.js` | `600000` | hard ceiling for a requested timeout |
| `STDOUT_MAX_BYTES` | `lib/index.js` | `120000` | per-stream capture budget |
| `CFG.timeoutMs` | `lib/client.js` | `120000` | timeout the browser requests |
| `CFG.outputLimit` | `lib/client.js` | `4000` | characters of stdout shown in the card |

## Security notes

Three independent gates stand in front of a command, and all three must pass:

1. **The deployment's browser session.** `dsh web` mints a signed,
   authority-bound cookie through the `connection` service and guards the page
   with it — but that guard does **not** cover plugin routes. The routes
   therefore reuse the deployment's own verdict rather than inventing a second
   scheme, and they try **both** doors that service exposes:
   `requestRejection(req)` (the exact policy its own API routes use: trusted
   hosts *and* cookie, answering `undefined`/`401`/`403`) and the narrower
   `isAuthenticated(req)` (cookie only). A request passes when whichever door
   exists accepts it; neither door means deny. A request without the session is
   refused with **401**. This matters: before this gate existed, any local
   process (`curl` with no Origin header included) could run a command here even
   though the GUI itself demanded a token.
2. **Origin fence** (`isTrustedRequest`): a loopback `Host` plus a same-host
   `Origin`, with `sec-fetch-site: cross-site` refused — **403**. This stops a
   page on another site, or a DNS-rebound name, from driving the command line
   through the user's browser. It makes the feature **loopback-only**; a LAN
   deployment must relax that function deliberately.
3. **The file sandbox.** The command runs through `ctx.shell` with the session's
   resolved sandbox policy, so a blocked write comes back as a sandbox-denied
   failure with a suggestion to widen the mode.

`connection` is resolved by climbing a bounded number of parent links from the
scoped context (it is absent from the live service catalog, so no single context
can be assumed to expose it). When it cannot be resolved, the routes still
register but refuse every request with 401 and log a warning — a command route
that cannot verify the session must never execute, but it must be *observable*
rather than silently absent.

**Never assume a method name from a Service Definition.** The service class
defines `isAuthenticated` and `requestRejection`, but the object a deployment
actually publishes need not expose both: a live `dsh web` here reports

```json
"gateShape": "requestRejection+authorizeIndex"
```

— `isAuthenticated` is simply **absent**. A gate that called only that method
fell through to `false` on every request and answered 401 to the browser's own
authenticated session, with the feature looking like an auth failure when it was
a wrong method name. The lesson generalizes: probe the object's shape at runtime
(the `gateShape` field exists for exactly this) and accept any documented door
that is present rather than requiring one specific name.

`GET`/`POST /cli-mode/probe` is deliberately unauthenticated and read-only. It
answers `{ authenticated, connectionResolved, gateShape, loopback,
cookiePresent, host, origin, secFetchSite, headerNames }` so a deployment can
prove *which* gate door resolved, whether the browser's own request carries a
cookie at all, and whether the Origin/`Sec-Fetch-Site` headers look same-origin.
It executes nothing and discloses no path, header value, or secret — header
**names** only.

From the browser console, where the page's own cookie is present, this is the
fastest way to tell "the gate is wrong" from "the browser sent no cookie":

```js
await (await fetch('/cli-mode/probe', { method: 'POST' })).json()
```

A `401` on the command routes while this answers `cookiePresent: true` and
`authenticated: false` means the resolved service is not the deployment's real
`connection` (check `gateShape`); `cookiePresent: false` means the page's
session was never established (reopen the URL `dsh web` printed).

## Failure is visible, never silent

Two rules shape the Host half. Both come from a real debugging session in which
the plugin reported itself mounted while every route was absent, and the only
symptom was a `405` from the SPA fallback:

1. **Registration must not depend on anything that can throw.** The routes
   register first, inside a scoped `ctx.inject(['webServer'], …)`; each
   registration is isolated, so one unusable route leaves the other three
   mounted and names the offender in the log
   (`routes live … (failed: /cli-mode/workdir: <reason>)`). `resolveConnection`
   and `readJsonBody` are individually guarded: a context chain that cannot be
   walked degrades to "no gate", a malformed body to a `400`.
2. **A route that cannot verify the session refuses; it never disappears.**
   With no reachable gate the routes still register and answer **401**, and the
   probe stays available. A missing route (`405`/`404`) therefore means exactly
   one thing: the row did not mount.

The browser half follows the same principle, from its own real failure:

3. **Never assume a global the bundle protocol does not guarantee.** A standard
   client bundle is not the dynamic-plugin sandbox: `document` is **not** a
   guaranteed binding. The first shipped build opened `apply` with
   `document.createElement('style')` and therefore died with
   `ReferenceError: document is not defined` before registering anything — the
   Host half stayed perfectly healthy (probe 200, `connectionResolved:true`,
   routes enforced 401) while the composer never turned red. The fix is
   two-part: resolve the document defensively (bare binding, `window.document`,
   `globalThis.window.document`) and make styling an **enhancement** — the
   command line's red text, monospace, and layout are inline styles on the
   plugin's own elements, so the stylesheet only adds the global override (the
   resident composer's text colour) and a nicer surface. `verify-client.mjs`
   keeps a no-document case precisely so this cannot regress.

4. **A chain selector receives only the owner share — and the composer chain is
   the wrong tool for this feature.** The renderer elects with
   `entry.select(ownerProps)`, where `ownerProps` is `{ sessionId, session,
   pendingInteraction }`; the standard session props (`useInput`,
   `inputActions`) are not there, so a selector that reads the draft must get it
   out-of-band. Worse: *both* dock slots near the composer
   (`conversation.input.dock` and `conversation.composer.dock`) are declared
   inside the composer bar, so a chain election that takes the composer over
   hides them with `display:none`. The result was exactly the field report —
   "command mode opens, Enter produces no result, Esc cannot exit" — because the
   result card was invisible and the draft mirror the election depended on lagged
   one render pass, walking the takeover straight back in.

   The browser half therefore **does not take the composer over**. It uses the
   mechanism a shipped third-party plugin (modlens) already proves: a
   document-level `keydown` listener in capture phase reads the live draft from
   the composer's own `[data-composer-input]` element and intercepts Enter/Esc,
   while a null-rendering watcher in `conversation.input.overlay` (a list slot
   with no election, so it really does receive the standard props) flips
   `body[data-cli-mode]` to make the resident composer's text red. The result
   card lives in `conversation.composer.dock`, now always visible because the
   composer is never hidden.

   The generic rule still holds: a selector must be pure over the owner share,
   and a throwing selector fails *silently* — but for this feature the fix was
   to avoid the chain entirely rather than feed it a draft mirror.

## Troubleshooting

| Symptom | Meaning | Fix |
| --- | --- | --- |
| `405` on `POST /cli-mode/exec` | The row did not mount (or the profile was not restarted after an edit) | Confirm `dsh-cli-mode` is in `dsh.profile.bundles`, then restart the profile |
| `401` on every route | The session gate did not resolve | Check `POST /cli-mode/probe` → `connectionResolved: false`; report the warning line from the plugin log |
| `403` from a browser | The page is not this GUI (foreign Origin/Host) | Use the URL printed by `dsh web` |
| `404` on a `GET` to a route | Routes are POST-only | Use POST with a JSON body |
| Input box never turns red | The browser half did not load or did not register | Open DevTools and check for a `cli-mode` error; the classic cause is a missing global (`document`) throwing at the top of `apply`, which the current build guards against |

## Why the routes ride `ctx.inject`

This cordis has no optional-inject form (`ctx.get` is the only optional read),
and a bundle layer can apply *before* the Web carrier publishes `webServer`. A
`ctx.get('webServer')` read at apply time therefore returns `undefined` and the
routes silently never register — the whole feature looks inert while the plugin
reports itself mounted. The routes must ride a scoped
`ctx.inject(['webServer'], (scope) => …)`, which runs when the service appears,
never runs where it does not (a headless profile), and owns the registrations
through its own effect.

The same trap applies to any optional service a bundle row consumes at apply
time: read it with `ctx.inject` when its absence must be *recoverable*, and
treat a bare `ctx.get` miss as "not available in this deployment" — but do not
chain the whole feature behind a service that may never publish, or a missing
dependency becomes an unexplained dead plugin.

## Development

Three self-contained verification scripts run on plain Node (no test framework,
no build step):

```sh
node verify.mjs          # package-level: exports, route set, session gate and
                         # origin fence refusals, per-route failure isolation,
                         # history round-trip, suggestion fingerprints, client
                         # bundle protocol + registration
node verify-profile.mjs  # profile wiring against the launcher's own app-boot
                         # helpers: bundle resolution, patch overlay, layer stack
node verify-e2e.mjs      # drives the REAL route handlers with a stubbed session
                         # gate and a shell stand-in, running actual commands:
                         # success path, failure + suggestions, missing-executor
                         # refusal, workdir, origin fence, history persistence
node verify-client.mjs   # loads the shipped bundle, mounts its two entries the
                         # way the renderer does, drives the chain `select` and
                         # the component through a small fake React, and fires
                         # Enter: asserts the request that reaches the host
```

`verify-client.mjs` deliberately stops at the request boundary. The fake
runtime's `useSyncExternalStore` is **not** React's — asserting the result card
through it would report a harness artifact as a plugin defect. The card, the red
input, and the takeover itself are browser facts; verify them there (type
`!npm --version` in the composer, then check that a `POST /cli-mode/exec`
appears in the Network panel).

All three print `PASS`/`FAIL` per assertion and exit non-zero on any failure.
They are development aids, not part of the shipped runtime. The e2e harness can
only stand in for what the live process supplies (`ctx.shell`); confirm the
composer path itself in the browser, where `/cli-mode/probe` answers whether the
deployment ever resolved the session gate.

Because the browser half is a hand-written lazy-CJS bundle and the Host half is a
plain ESM module with no `@deepseek-ai/*` imports, there is **nothing to build**:
edit `lib/*.js`, then **restart the profile**.

### There is no live mount in this build

The profile declares `patchReload: live`, but the shipped `dsh-app-boot` only
*exports* `watchUserPatches` — nothing calls it. A row written into
`cordis.patch.yml` at runtime is therefore not picked up (verified: the route
stayed 404 after the write), and editing the plugin package has the same
requirement. **Every change needs a profile restart.** Do not "fix" this by
inserting the row into `cordis.patch.yml` as well: the bundle already inserts it,
and a second insert composes the same row twice.

## Verify a deployment

After a restart, the routes are observable without the browser:

```sh
curl -s -X POST http://127.0.0.1:3080/cli-mode/probe
# -> {"authenticated":false,"connectionResolved":true,...}
#    connectionResolved:false means the session gate did not resolve (routes 401)
#    a 405/404 here means the row did not mount

curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3080/cli-mode/exec \
  -H 'content-type: application/json' -d '{"command":"!npm --version","sessionId":""}'
# -> 401    the session gate is enforced (expected from a bare shell)

curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3080/cli-mode/exec \
  -H 'host: evil.example.com' -H 'content-type: application/json' -d '{"command":"!echo hi"}'
# -> 401 or 403   never 200; the gate holds

curl -s -X POST http://127.0.0.1:3080/cli-mode/exec \
  -H 'content-type: application/json' -H "cookie: <the browser cookie>" \
  -d '{"command":"!npm --version","sessionId":""}'
# -> {"ok":true,...,"message":"`npm --version` 命令已执行","stdout":"11.19.0",...}
```

To exercise the full path from a shell, copy the authenticated URL printed by
`dsh web` (it carries the launch token), let it set the cookie, then reuse that
cookie with `curl -b`. From the GUI the browser sends it automatically.

A `405` on the exec route with a valid body is the signature of the
`ctx.get('webServer')` miss described above — check that the route registration
goes through `ctx.inject`.

## Known limits

- One command line per submission; there is no shell state across calls (each
  run is a fresh shell, exactly like the `bash` tool).
- Interactive commands cannot be driven: stdin is not connected, so a prompt
  waits until the timeout kills the run.
- Output is captured, not streamed; the card appears when the command settles
  (with a “命令执行中” state while it runs).
