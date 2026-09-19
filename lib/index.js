/**
 * dsh-cli-mode — the Host half.
 *
 * Command-line mode for the Web GUI composer: a marked line (`！cmd` / `!cmd`)
 * runs as a real single command line in the session workspace instead of being
 * sent to the model. This half owns the execution plane and persists the
 * command history; the browser half owns the composer takeover and the result
 * card, and talks to these routes over plain JSON HTTP.
 *
 * Routes (all POST, JSON in / JSON out):
 * - `/cli-mode/exec`    { command, sessionId, timeoutMs? } -> exec result
 * - `/cli-mode/workdir` { sessionId }                      -> { workdir }
 * - `/cli-mode/history` { sessionId, entries? }             -> { entries }
 *
 * A cordis plugin module: `apply(ctx)` registers the routes on the Web carrier
 * and removes them with the plugin's own fiber.
 * @module dsh-cli-mode
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { MARKERS, renderFailure, stripMarker, suggestionsFor } from './suggest.js'

export const name = 'cli-mode'

/** Timeout bounds for one command line. */
const MIN_TIMEOUT_MS = 1000
const MAX_TIMEOUT_MS = 600000
const DEFAULT_TIMEOUT_MS = 120000
/** Per-stream capture budget handed to the shell executor. */
const STDOUT_MAX_BYTES = 120000
/** Request body cap: bodies are command lines and small JSON, never payloads. */
const BODY_LIMIT = 65536
/** Command history bounds. */
const HISTORY_MAX = 200
const HISTORY_RESPONSE_LIMIT = 50

/** Response helper: one JSON body with explicit framing. */
function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Read and parse one JSON request body.
 * @returns the parsed value, or null when the body is absent, oversized, or not JSON.
 */
async function readJsonBody(req) {
  try {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > BODY_LIMIT) return null
      chunks.push(buffer)
    }
    if (size === 0) return null
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : null
  } catch {
    // An unreadable or malformed body is a client error, never a route throw.
    return null
  }
}

/** The Harness home (`$DSH_HOME`, else `~/.dsh`) — where plugin state lives. */
function resolveHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : undefined
  return fromEnv ?? join(homedir(), '.dsh')
}

/** One history file per session, derived from an opaque id. */
function historyFile(home, sessionId) {
  const key = String(sessionId === undefined || sessionId === null ? '' : sessionId)
  const safe = (key === '' ? 'no-session' : key).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
  return join(home, 'cli-mode', 'history', safe + '.json')
}

/** Read the persisted command history for one session. */
async function readHistory(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry) => typeof entry === 'string').slice(0, HISTORY_MAX)
  } catch {
    return []
  }
}

/** Persist the command history for one session, best effort. */
async function writeHistory(file, entries) {
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(entries.slice(0, HISTORY_MAX), null, 2) + '\n', 'utf8')
  } catch {
    // History is a convenience: an unwritable home must not fail a command.
  }
}

/** Clamp one requested timeout into the supported bounds. */
function resolveTimeout(requested) {
  const value = Number(requested)
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS
  return Math.min(Math.max(Math.round(value), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS)
}

/** Whether one hostname denotes this machine. */
function isLoopbackHost(hostname) {
  const value = String(hostname).toLowerCase().replace(/^\[|\]$/g, '')
  if (value === 'localhost' || value === '::1') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)
}

/**
 * Whether a request may run a command.
 *
 * These routes execute arbitrary command lines, so "same origin" is assumed
 * only after checking it: a page on another site must not be able to POST here
 * through the user's browser (DNS rebinding and cross-site posts both arrive
 * with a foreign Host or Origin). A loopback Host plus a same-host Origin is
 * required, and `sec-fetch-site: cross-site` is refused outright.
 *
 * This makes the feature loopback-only. To drive it from another machine on a
 * LAN, relax this function deliberately — and read the security note in the
 * README first.
 * @param req - the incoming request.
 * @returns true when the request is trusted to execute.
 */
function isTrustedRequest(req) {
  const hostHeader = req.headers?.host
  if (typeof hostHeader !== 'string' || hostHeader === '') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + hostHeader)
  } catch {
    return false
  }
  if (!isLoopbackHost(hostUrl.hostname)) return false
  if (req.headers?.['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers?.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** Refusal body for a request that failed the trust fence. */
const REFUSAL = Object.freeze({ error: 'cli-mode routes are loopback-only' })

/** Refusal body for a request without this deployment's browser session. */
const UNAUTHORIZED = Object.freeze({ error: 'dsh web authentication required' })

/**
 * Whether the deployment's browser session authorizes this request.
 *
 * `dsh web` protects the page and its assets with a signed, authority-bound
 * cookie minted by the `connection` service, and that guard does not cover
 * plugin routes — an unfenced plugin route is reachable by any local process
 * without a token. These routes execute commands, so they must reuse the
 * deployment's own verdict instead of inventing a second scheme.
 *
 * The service offers two doors and both are tried, because either alone can be
 * wrong here: `requestRejection(req)` is the exact policy the deployment
 * applies to its own API routes — it consults the configured trusted hosts
 * *and* the browser cookie and returns `undefined`, `401`, or `403`. Its
 * narrower `isAuthenticated(req)` covers the cookie only. A request passes when
 * whichever door exists says so; when neither door exists the answer is
 * "deny".
 * @param connection - the connection service, when this deployment has one.
 * @param req - the incoming request.
 * @returns true only for a request the deployment's own policy accepts.
 */
function isAuthenticated(connection, req) {
  if (connection === undefined || connection === null) return false
  const reject = connection.requestRejection
  if (typeof reject === 'function') {
    try {
      return Reflect.apply(reject, connection, [req]) === undefined
    } catch {
      // Fall through to the narrower check rather than failing the route.
    }
  }
  const check = connection.isAuthenticated
  if (typeof check !== 'function') return false
  try {
    return Reflect.apply(check, connection, [req]) === true
  } catch {
    return false
  }
}

/** Which gate doors the resolved service actually exposes (diagnostics only). */
function gateShape(connection) {
  if (connection === undefined || connection === null) return 'none'
  const doors = []
  if (typeof connection.requestRejection === 'function') doors.push('requestRejection')
  if (typeof connection.isAuthenticated === 'function') doors.push('isAuthenticated')
  if (typeof connection.authorizeIndex === 'function') doors.push('authorizeIndex')
  return doors.length === 0 ? 'resolved-without-doors' : doors.join('+')
}

/**
 * Resolve the deployment's session gate, walking up from the scoped context.
 *
 * The service is process-wide, but its exact mounting scope is a composition
 * detail (and it is absent from the live service catalog, so it cannot be
 * assumed reachable from any one context). Lookup is a single bounded climb —
 * at most a handful of parent links, no recursion — from the context that
 * carries the routes, then from the plugin's own context.
 * @param scope - the scoped context that owns the route registrations.
 * @param outer - the plugin's own context.
 * @returns the connection service, or undefined when this deployment has none.
 */
function resolveConnection(scope, outer) {
  try {
    const visited = new Set()
    let current = scope
    for (let hops = 0; hops < 8 && current !== undefined && current !== null; hops += 1) {
      if (visited.has(current)) break
      visited.add(current)
      if (typeof current.get === 'function') {
        const service = current.get('connection')
        if (service !== undefined && service !== null) return service
      }
      current = current.parent
    }
    if (outer !== undefined && outer !== null && !visited.has(outer)) {
      if (typeof outer.get === 'function') {
        const service = outer.get('connection')
        if (service !== undefined && service !== null) return service
      }
      const above = outer.parent
      if (above !== undefined && above !== null && typeof above.get === 'function') {
        const service = above.get('connection')
        if (service !== undefined && service !== null) return service
      }
    }
  } catch {
    // An unresolvable context chain must degrade to "no gate", which the route
    // answers with 401 — never to a throw that would take the routes with it.
  }
  return undefined
}

/** Trim captured output for transport. */
function textOf(stream) {
  const value = stream === undefined || stream === null || typeof stream.text !== 'string' ? '' : stream.text
  return value.trim()
}

/**
 * Run one command line through the composed shell executor.
 * @param ctx - the plugin context (services are read with `ctx.get`).
 * @param line - the raw marked line.
 * @param sessionId - originating session, for cwd and sandbox policy.
 * @param timeoutMs - requested timeout.
 * @param signal - aborted when the browser disconnects.
 * @returns a lossless-JSON result for the browser half.
 */
async function execute(ctx, line, sessionId, timeoutMs, signal) {
  const command = stripMarker(line)
  if (command === '') {
    return {
      ok: false,
      kind: 'infra',
      workdir: null,
      message: '未读取到要执行的命令内容，请重新输入「' + MARKERS[0] + '命令」后回车。',
      suggestions: ['示例：' + MARKERS[0] + 'npm --version', '示例：!git status'],
    }
  }
  const shell = ctx.get('shell')
  if (shell === undefined) {
    return {
      ok: false,
      kind: 'infra',
      workdir: null,
      message: '当前环境没有挂载 shell 执行服务，无法执行命令行。',
      suggestions: ['确认部署中包含 bash/pwsh 执行插件后重试。'],
    }
  }

  let session
  let workdir
  if (typeof sessionId === 'string' && sessionId !== '') {
    const sessions = ctx.get('sessions')
    if (sessions !== undefined) {
      const found = sessions.get(sessionId)
      if (found !== undefined) {
        session = found
        workdir = found.header.cwd
      }
    }
  }

  const policyService = ctx.get('sandboxPolicy')
  const sandboxPolicy = policyService === undefined
    ? undefined
    : policyService.resolve(session === undefined ? {} : { session })

  let result
  try {
    const spec = shell.resolve({
      command,
      ...(workdir === undefined ? {} : { workdir }),
      timeoutMs: resolveTimeout(timeoutMs),
      stdoutMaxBytes: STDOUT_MAX_BYTES,
      signal,
      ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
    })
    result = await shell.run(spec)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      kind: 'infra',
      workdir: workdir === undefined ? null : workdir,
      message: '命令执行通道失败：' + message,
      suggestions: ['确认沙箱与执行器状态后重试。', '如需放宽文件限制，请先在会话中调整沙箱模式。'],
    }
  }

  const stdout = textOf(result.stdout)
  const stderr = textOf(result.stderr)
  const sandbox = result.sandbox === undefined
    ? undefined
    : { mode: result.sandbox.mode, denied: result.sandbox.denied === true }
  const timedOut = result.timedOut === true
  const failed = timedOut || result.aborted === true || result.exitCode !== 0

  if (!failed) {
    return {
      ok: true,
      kind: 'success',
      command,
      exitCode: result.exitCode,
      stdout,
      stderr,
      truncated: result.stdout.truncated === true || result.stderr.truncated === true,
      workdir: workdir === undefined ? null : workdir,
      message: '`' + command + '` 命令已执行',
    }
  }

  const notes = []
  if (result.aborted === true) notes.push('命令已被中断（发起方断开或主动停止）')
  if (sandbox !== undefined && sandbox.denied === true) notes.push('沙箱拒绝了该命令的文件访问')

  const report = renderFailure(command, stderr, stdout, result.exitCode, timedOut, sandbox)
  return {
    ok: false,
    kind: 'failure',
    command,
    exitCode: result.exitCode,
    timedOut,
    aborted: result.aborted === true,
    stdout,
    stderr,
    truncated: result.stdout.truncated === true || result.stderr.truncated === true,
    sandbox: sandbox === undefined ? null : sandbox,
    workdir: workdir === undefined ? null : workdir,
    // `message` is the heading plus any process-level note only — stdout,
    // stderr, and the suggestions each travel in their own field and the
    // browser renders each exactly once. Folding them in here duplicated every
    // one of them in the card.
    message: notes.length === 0 ? report : report + '；' + notes.join('；'),
    suggestions: suggestionsFor(command, stderr, stdout, result.exitCode, timedOut, sandbox),
  }
}

/**
 * Register the command-line-mode routes on the Web carrier.
 *
 * The routes ride a scoped `ctx.inject(['webServer'], …)` rather than
 * `ctx.get('webServer')`: this cordis has no optional-inject form, and a
 * bundle layer can apply before the Web carrier publishes its service — a
 * `ctx.get` read there returns undefined and the routes would silently never
 * register. The scoped closure runs when the service appears (and never runs
 * where it does not, e.g. a headless profile), and its effect owns the routes,
 * so unloading the plugin removes them.
 * @param ctx - the owning plugin context.
 */
export function apply(ctx) {
  const home = resolveHome()

  const registerRoutes = (scope, webServer, connection) => {
    const getConnection = () => connection ?? resolveConnection(scope, ctx)
    const mounted = []
    const failed = []
    // Register one route in isolation: a single unusable route must not prevent
    // the others from mounting, and must never take the whole plugin row down.
    const mount = (route) => {
      try {
        mounted.push(webServer.register(route))
      } catch (error) {
        failed.push(route.path + ': ' + (error instanceof Error ? error.message : String(error)))
      }
    }

    mount({
      kind: 'exact',
      path: '/cli-mode/exec',
      handler: async (req, res) => {
        if (!isAuthenticated(getConnection(), req)) {
          sendJson(res, 401, UNAUTHORIZED)
          return
        }
        if (!isTrustedRequest(req)) {
          sendJson(res, 403, REFUSAL)
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'use POST' })
          return
        }
        const body = await readJsonBody(req)
        if (body === null) {
          sendJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        const controller = new AbortController()
        const onClose = () => controller.abort()
        req.on('close', onClose)
        try {
          const result = await execute(ctx, body.command, body.sessionId, body.timeoutMs, controller.signal)
          if (res.writableEnded || res.destroyed) return
          sendJson(res, 200, result)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (!res.writableEnded && !res.destroyed) {
            sendJson(res, 200, {
              ok: false,
              kind: 'infra',
              workdir: null,
              message: '命令执行失败：' + message,
              suggestions: ['请重试一次；若持续失败，检查 Host 侧的 shell 服务。'],
            })
          }
        } finally {
          req.off('close', onClose)
        }
      },
    })

    mount({
      kind: 'exact',
      path: '/cli-mode/workdir',
      handler: async (req, res) => {
        if (!isAuthenticated(getConnection(), req)) {
          sendJson(res, 401, UNAUTHORIZED)
          return
        }
        if (!isTrustedRequest(req)) {
          sendJson(res, 403, REFUSAL)
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'use POST' })
          return
        }
        const body = await readJsonBody(req)
        const sessionId = body === null ? undefined : body.sessionId
        let workdir = null
        if (typeof sessionId === 'string' && sessionId !== '') {
          const sessions = ctx.get('sessions')
          const session = sessions === undefined ? undefined : sessions.get(sessionId)
          if (session !== undefined && session.header.cwd !== undefined) workdir = session.header.cwd
        }
        sendJson(res, 200, { workdir })
      },
    })

    mount({
      kind: 'exact',
      path: '/cli-mode/history',
      handler: async (req, res) => {
        if (!isAuthenticated(getConnection(), req)) {
          sendJson(res, 401, UNAUTHORIZED)
          return
        }
        if (!isTrustedRequest(req)) {
          sendJson(res, 403, REFUSAL)
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'use POST' })
          return
        }
        const body = await readJsonBody(req)
        if (body === null) {
          sendJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        const file = historyFile(home, body.sessionId)
        if (Array.isArray(body.entries)) {
          const entries = body.entries.filter((entry) => typeof entry === 'string' && entry.trim() !== '')
          await writeHistory(file, entries)
          sendJson(res, 200, { entries: entries.slice(0, HISTORY_RESPONSE_LIMIT) })
          return
        }
        const entries = await readHistory(file)
        sendJson(res, 200, { entries: entries.slice(0, HISTORY_RESPONSE_LIMIT) })
      },
    })

    // Read-only gate diagnostics. Deliberately unauthenticated: it is how a
    // deployment proves whether the session gate resolved, which door it
    // exposes, and whether the browser's own requests carry a cookie it
    // accepts. It executes nothing and discloses no path, header VALUE, or
    // secret — only header names and the shape of this decision.
    mount({
      kind: 'exact',
      path: '/cli-mode/probe',
      handler: async (req, res) => {
        const resolved = getConnection()
        const headerNames = Object.keys(req.headers ?? {}).sort()
        sendJson(res, 200, {
          authenticated: isAuthenticated(resolved, req),
          connectionResolved: resolved !== undefined && resolved !== null,
          gateShape: gateShape(resolved),
          loopback: isTrustedRequest(req),
          cookiePresent: headerNames.includes('cookie'),
          headerNames: headerNames.join(','),
          host: typeof req.headers?.host === 'string' ? req.headers.host : null,
          origin: typeof req.headers?.origin === 'string' ? req.headers.origin : null,
          secFetchSite: typeof req.headers?.['sec-fetch-site'] === 'string' ? req.headers['sec-fetch-site'] : null,
        })
      },
    })

    const level = failed.length === 0 ? 'info' : 'warn'
    ctx.logger?.[level]?.(
      'cli-mode: routes live at /cli-mode/{exec,workdir,history,probe}' +
        (failed.length === 0 ? '' : ' (failed: ' + failed.join('; ') + ')'),
    )
    return () => {
      for (const release of mounted) {
        try {
          release()
        } catch {
          // A route already released by a carrier reload must not fail the unload.
        }
      }
    }
  }

  // `webServer` is waited on rather than read with `ctx.get`: this cordis has no
  // optional-inject form, and a bundle layer can apply before the Web carrier
  // publishes — a `ctx.get` read there returns undefined and the routes would
  // silently never register.
  //
  // `connection` is NOT a second injection. Waiting on a service that this
  // deployment might not publish from a reachable scope would leave the routes
  // unregistered forever, which is indistinguishable from a broken plugin. It
  // is resolved at registration and again per request, and a request that
  // cannot be verified is refused (401) — a command route without a session
  // gate must never execute, but it may exist and say so.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope) => {
      if (scope.webServer === undefined || scope.webServer === null) {
        ctx.logger?.warn?.('cli-mode: webServer injection delivered no service — routes not registered')
        return
      }
      const connection = resolveConnection(scope, ctx)
      if (connection === undefined) {
        ctx.logger?.warn?.('cli-mode: no connection service reachable — routes register but refuse every request with 401 (probe /cli-mode/probe for diagnostics)')
      } else {
        ctx.logger?.info?.('cli-mode: browser-session gate resolved from the connection service')
      }
      return registerRoutes(scope, scope.webServer, connection)
    })
  } else {
    const webServer = ctx.get('webServer')
    if (webServer === undefined) {
      ctx.logger?.warn?.('cli-mode: no webServer service and no ctx.inject — command-line mode is inactive')
      return
    }
    registerRoutes(ctx, webServer, ctx.get('connection'))
  }
}

