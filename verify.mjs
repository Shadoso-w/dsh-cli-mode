// Temporary verification harness for the dsh-cli-mode plugin package.
// Exercises: module evaluation, plugin export shape, the handler-independent
// suggestion engine (including the two real commands used during development),
// the client bundle's lazy-CJS registration, and a stub-driven `apply` that
// proves both routes register and that exec refuses an unmarked/empty line.
import { readFileSync } from 'node:fs'

const root = new URL('./', import.meta.url)
const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail })
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail === '' ? '' : ' — ' + detail))
}

// Synthetic request authority for the trust-fence cases below. This is NOT
// deployment configuration: the handlers are called directly with fabricated
// `req` objects, and the fence only compares this Host against the request
// Origin, so any loopback authority works and no server is ever contacted.
const TEST_HOST = '127.0.0.1:3080'
const TEST_ORIGIN = 'http://' + TEST_HOST

// --- Host half -------------------------------------------------------------
const host = await import(new URL('lib/index.js', root).href)
check('host exports name', host.name === 'cli-mode', host.name)
check('host exports apply', typeof host.apply === 'function')

const routes = new Map()
const logged = []
const injected = []
const webServer = {
  register(route) {
    if (route.kind !== 'exact') throw new Error('expected exact route')
    if (routes.has(route.path)) throw new Error('duplicate route ' + route.path)
    routes.set(route.path, route.handler)
    return () => routes.delete(route.path)
  },
}
// The deployment's browser-session gate: the shared connection service. Kept
// out of the loopback fence's concern so the two refusals stay distinguishable.
// The shape below is what a live `dsh web` actually reports —
// `gateShape: requestRejection+authorizeIndex`, notably WITHOUT
// `isAuthenticated`. That missing door is modelled deliberately: a gate that
// only knew the narrower cookie method answered 401 to the browser's own
// requests against a perfectly valid session. A second stub covers the
// cookie-only deployment.
const connection = {
  requestRejection(req) {
    return req.headers['x-test-authed'] === 'yes' ? undefined : 401
  },
  authorizeIndex() {
    return false
  },
}
const logger = {
  info: (message) => logged.push('info:' + message),
  warn: (message) => logged.push('warn:' + message),
}
const scope = { webServer, get: (key) => (key === 'connection' ? connection : undefined) }
const ctx = {
  effect(factory) {
    const dispose = factory()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  logger,
  // Mirrors the real contract: no optional-inject form, so the routes must ride
  // a scoped injection waiting for the service instead of a bare ctx.get.
  inject(names, callback) {
    injected.push(names.join(','))
    return callback(scope)
  },
  get() {
    return undefined
  },
}
host.apply(ctx)
check('host waits on webServer by injection', injected.length === 1 && injected[0] === 'webServer', injected.join('|'))
check('host registers four routes (incl. read-only probe)', routes.size === 4 && routes.has('/cli-mode/probe'), [...routes.keys()].join(', '))
check('host logs the live routes', logged.some((line) => line.includes('routes live')), logged.join(' | '))
check('host reports the resolved session gate', logged.some((line) => line.includes('gate resolved')), logged.join(' | '))

// Fail closed: without the session gate every command route must refuse, and
// the plugin must still register so the refusal is observable.
const noGateRoutes = new Map()
const noGateLog = []
const noGateWebServer = { register: (route) => { noGateRoutes.set(route.path, route.handler); return () => {} } }
host.apply({
  effect: (factory) => factory(),
  logger: { info: () => {}, warn: (message) => noGateLog.push(message) },
  inject: (names, callback) => callback({ get: () => undefined, webServer: noGateWebServer }),
  get: () => undefined,
})
check('no session gate still registers and warns', noGateRoutes.size === 4 && noGateLog.some((line) => line.includes('no connection service')), noGateLog.join(' | '))

/** Build a minimal IncomingMessage/ServerResponse pair over one JSON body. */
function callRoute(path, body, method = 'POST', headers = { host: TEST_HOST, origin: TEST_ORIGIN, 'x-test-authed': 'yes' }) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const req = {
    method,
    headers,
    on() {},
    off() {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
  let resolve
  const done = new Promise((r) => { resolve = r })
  const res = {
    status: 0,
    payload: undefined,
    body: '',
    writableEnded: false,
    destroyed: false,
    writeHead(status) { this.status = status },
    end(buffer) {
      this.body = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer ?? '')
      this.writableEnded = true
      try { this.payload = JSON.parse(this.body) } catch { this.payload = undefined }
      resolve()
    },
  }
  const handler = routes.get(path)
  const pending = handler(req, res)
  return Promise.resolve(pending).then(() => done).then(() => ({ status: res.status, payload: res.payload }))
}

const execEmpty = await callRoute('/cli-mode/exec', { command: '   ', sessionId: '' })
check('exec refuses an empty command', execEmpty.payload?.ok === false && /未读取到/.test(execEmpty.payload.message), JSON.stringify(execEmpty.payload?.kind))
const execNoShell = await callRoute('/cli-mode/exec', { command: '!npm --version', sessionId: '' })
check('exec reports the missing shell service', /shell/.test(execNoShell.payload?.message ?? ''), execNoShell.payload?.message?.slice(0, 40))

// Session gate first: an unauthenticated caller must not even reach the fence.
const unauthenticated = await callRoute('/cli-mode/exec', { command: '!echo hi', sessionId: '' }, 'POST', { host: TEST_HOST, origin: TEST_ORIGIN })
check('unauthenticated request is refused with 401', unauthenticated.status === 401, String(unauthenticated.status))
const unauthenticatedWorkdir = await callRoute('/cli-mode/workdir', { sessionId: '' }, 'POST', { host: TEST_HOST })
check('workdir is gated too', unauthenticatedWorkdir.status === 401, String(unauthenticatedWorkdir.status))

// Trust fence: a page that is not this GUI must not be able to run commands.
const foreignHost = await callRoute('/cli-mode/exec', { command: '!echo hi', sessionId: '' }, 'POST', { host: 'evil.example.com', 'x-test-authed': 'yes' })
check('foreign Host is refused', foreignHost.status === 403, String(foreignHost.status))
const crossSite = await callRoute('/cli-mode/exec', { command: '!echo hi', sessionId: '' }, 'POST', { host: TEST_HOST, origin: 'http://evil.example.com', 'x-test-authed': 'yes' })
check('cross-site Origin is refused', crossSite.status === 403, String(crossSite.status))
const crossSiteFetch = await callRoute('/cli-mode/exec', { command: '!echo hi', sessionId: '' }, 'POST', { host: TEST_HOST, 'sec-fetch-site': 'cross-site', 'x-test-authed': 'yes' })
check('sec-fetch-site cross-site is refused', crossSiteFetch.status === 403, String(crossSiteFetch.status))
const noOrigin = await callRoute('/cli-mode/workdir', { sessionId: '' }, 'POST', { host: TEST_HOST, 'x-test-authed': 'yes' })
check('authenticated request without Origin is accepted', noOrigin.status === 200, String(noOrigin.status))

const workdir = await callRoute('/cli-mode/workdir', { sessionId: '' })
check('workdir answers null without a session', workdir.status === 200 && workdir.payload?.workdir === null)

const historyWrite = await callRoute('/cli-mode/history', { sessionId: 'session-verify', entries: ['npm --version', '', 42, '! git status'] })
check('history filters non-strings', Array.isArray(historyWrite.payload?.entries) && historyWrite.payload.entries.length === 2, JSON.stringify(historyWrite.payload))
const historyRead = await callRoute('/cli-mode/history', { sessionId: 'session-verify' })
check('history round-trips', JSON.stringify(historyRead.payload?.entries) === JSON.stringify(['npm --version', '! git status']), JSON.stringify(historyRead.payload))

const wrongMethod = await callRoute('/cli-mode/exec', undefined, 'GET')
check('non-POST answers 405', wrongMethod.status === 405)

// Read-only probe: the deployment diagnostic for the session gate.
const probe = await callRoute('/cli-mode/probe', undefined, 'POST', { host: TEST_HOST, 'x-test-authed': 'yes', cookie: 'dsh=abc' })
check('probe reports a resolved gate', probe.payload?.connectionResolved === true && probe.payload?.authenticated === true, JSON.stringify(probe.payload))
const probeAnon = await callRoute('/cli-mode/probe', undefined, 'POST', { host: TEST_HOST })
check('probe reports an unauthenticated caller', probeAnon.payload?.authenticated === false && probeAnon.payload?.connectionResolved === true, JSON.stringify(probeAnon.payload))
check('probe names the gate doors it found', probe.payload?.gateShape === 'requestRejection+authorizeIndex', String(probe.payload?.gateShape))
check('probe reports cookie presence without its value', probe.payload?.cookiePresent === true && !JSON.stringify(probe.payload).includes('dsh=abc'), JSON.stringify(probe.payload))
check('probe discloses no path or secret', !JSON.stringify(probe.payload).includes('history') && !JSON.stringify(probe.payload).includes('cookie='), JSON.stringify(probe.payload))

// A service exposing ONLY the narrow cookie check must still gate correctly:
// this is the shape that produced a live 401 against the browser's own request.
{
  const narrowRoutes = new Map()
  host.apply({
    effect: (f) => f(),
    logger: { info: () => {}, warn: () => {} },
    inject: (n, cb) => cb({
      webServer: { register: (r) => { narrowRoutes.set(r.path, r.handler); return () => {} } },
      get: (k) => (k === 'connection' ? { isAuthenticated: (req) => req.headers['x-test-authed'] === 'yes' } : undefined),
      parent: undefined,
    }),
    get: () => undefined,
  })
  const chunks = [Buffer.from('{}', 'utf8')]
  const req = { method: 'POST', headers: { host: TEST_HOST, 'x-test-authed': 'yes' }, on() {}, off() {}, async *[Symbol.asyncIterator]() { for (const c of chunks) yield c } }
  let done
  const settled = new Promise((r) => { done = r })
  const res = { status: 0, writableEnded: false, destroyed: false, writeHead(s) { this.status = s }, end() { this.writableEnded = true; done() } }
  await narrowRoutes.get('/cli-mode/workdir')(req, res)
  await settled
  check('cookie-only gate door still accepts an authenticated caller', res.status === 200, String(res.status))
}

// --- Suggestion engine ----------------------------------------------------
const suggest = await import(new URL('lib/suggest.js', root).href)
check('marker: full-width', suggest.hasMarker('！npm --version'))
check('marker: half-width', suggest.hasMarker('!npm --version'))
check('marker: leading space', suggest.hasMarker('   ! npm --version'))
check('marker: absent', !suggest.hasMarker('npm --version'))
check('strip: keeps the command', suggest.stripMarker('！  npm --version') === 'npm --version', suggest.stripMarker('！  npm --version'))
check('strip: idempotent without marker', suggest.stripMarker('git status') === 'git status')
check('suggest: command not found', suggest.suggestionsFor('foo', 'foo : The term \'foo\' is not recognized', '', 1, false).some((item) => item.includes('PATH')))
check('suggest: git typo', suggest.suggestionsFor('git stauts', "git: 'stauts' is not a git command", '', 1, false).length >= 1)
check('suggest: timeout branch', suggest.suggestionsFor('sleep 999', '', '', null, true)[0].includes('超时'))
check('suggest: sandbox denial', suggest.suggestionsFor('rm x', '', '', 1, false, { mode: 'read-only', denied: true })[0].includes('沙箱'))
check('suggest: never empty', suggest.suggestionsFor('x', '', '', 1, false).length > 0)
const report = suggest.renderFailure('npm --version', 'npm ERR!', '', 1, false)
check('failure report is the heading only (no folded suggestions)', report.includes('命令执行失败') && !report.includes('下一步建议') && !report.includes('1. '), JSON.stringify(report))

// --- Client bundle --------------------------------------------------------
const registered = []
globalThis.window = {
  __ModuleLoader__: {
    load(registration) { registered.push(registration) },
  },
}
globalThis.document = {
  head: { append() {} },
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
}
const source = readFileSync(new URL('lib/client.js', root), 'utf8')
new Function(source)()
check('client registers one bundle', registered.length === 1, 'count=' + String(registered.length))
const registration = registered[0]
check('client bundle id matches the package', registration.id === 'dsh-cli-mode', registration.id)
const exportsObject = registration.factory((specifier) => {
  if (specifier === 'react') return { createElement: () => null, useState: () => [undefined, () => {}], useEffect: () => {}, useCallback: (fn) => fn, useRef: () => ({ current: null }), useSyncExternalStore: () => undefined }
  throw new Error('unexpected require: ' + specifier)
})
check('client exports apply', typeof exportsObject.apply === 'function')
check('client inject is optional-only', Array.isArray(exportsObject.inject) && exportsObject.inject.length === 0)

const clientInjected = []
exportsObject.apply({
  effect(factory) { return factory() },
  inject(names, callback) { clientInjected.push(names.join(',')); callback({ slots: undefined }) },
})
check('client injects slots', clientInjected.length === 1 && clientInjected[0] === 'slots', clientInjected.join('|'))

const failed = results.filter((entry) => !entry.ok)
console.log('\n' + String(results.length - failed.length) + '/' + String(results.length) + ' checks passed')
if (failed.length > 0) {
  console.log('FAILED: ' + failed.map((entry) => entry.label).join('; '))
  process.exitCode = 1
}
