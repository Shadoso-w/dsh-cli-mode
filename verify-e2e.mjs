// Temporary end-to-end exerciser for the live Host half: mounts the real plugin
// with a stubbed session gate and a stubbed session store, drives the actual
// route handlers, and runs REAL commands through the composed ctx.shell.
import { apply } from './lib/index.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail === '' ? '' : ' — ' + detail))
}

const routes = new Map()
const logs = []
const session = { header: { cwd: process.cwd() } }
const sessionId = 'session-e2e'

// Minimal ctx.shell stand-in implementing the service contract the plugin
// relies on: resolve() applies defaults and run() reports a non-throwing
// outcome with exitCode/stdout/stderr. It really runs the command, so the
// route→service→result plumbing is exercised for real; the live deployment
// supplies the production executor behind the same interface.
const shell = {
  resolve(request) {
    return {
      command: request.command,
      workdir: request.workdir ?? process.cwd(),
      timeoutMs: request.timeoutMs ?? 120000,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 120000,
    }
  },
  async run(spec) {
    const started = Date.now()
    try {
      const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', spec.command], {
        cwd: spec.workdir,
        timeout: Math.min(spec.timeoutMs, 60000),
        maxBuffer: spec.stdoutMaxBytes,
        windowsHide: true,
      })
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        timeoutMs: spec.timeoutMs,
        stdout: { text: out.stdout ?? '', truncated: false },
        stderr: { text: out.stderr ?? '', truncated: false },
        sandbox: { mode: 'workspace-write', denied: false },
      }
    } catch (error) {
      return {
        exitCode: typeof error.code === 'number' ? error.code : 1,
        signal: null,
        timedOut: error.killed === true,
        aborted: false,
        timeoutMs: spec.timeoutMs,
        stdout: { text: error.stdout ?? '', truncated: false },
        stderr: { text: error.stderr ?? (error.message ?? ''), truncated: false },
        sandbox: { mode: 'workspace-write', denied: false },
      }
    }
  },
}

const ctx = {
  effect: (factory) => factory(),
  logger: { info: (m) => logs.push('info:' + m), warn: (m) => logs.push('warn:' + m) },
  inject: (names, callback) => callback({
    webServer: { register: (r) => { routes.set(r.path, r.handler); return () => {} } },
    // Stub gate: the live deployment proved the real one resolves (probe says
    // connectionResolved:true); this stands in for the browser cookie.
    get: (key) => (key === 'connection' ? { isAuthenticated: () => true } : undefined),
    parent: undefined,
  }),
  get: (key) => {
    if (key === 'sessions') return { get: (id) => (id === sessionId ? session : undefined) }
    if (key === 'shell') return shell
    return undefined
  },
}
apply(ctx)

async function post(path, body, headers = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }) {
  const chunks = [Buffer.from(JSON.stringify(body), 'utf8')]
  const req = {
    method: 'POST',
    headers,
    on() {},
    off() {},
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c },
  }
  let done
  const settled = new Promise((r) => { done = r })
  const res = {
    status: 0, payload: undefined, writableEnded: false, destroyed: false,
    writeHead(status) { this.status = status },
    end(buffer) {
      this.writableEnded = true
      try { this.payload = JSON.parse(Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer)) } catch { this.payload = undefined }
      done()
    },
  }
  await routes.get(path)(req, res)
  await settled
  return { status: res.status, payload: res.payload }
}

check('all four routes mounted', routes.size === 4, [...routes.keys()].join(', '))
check('gate resolved at apply time', logs.some((l) => l.includes('gate resolved')), logs.join(' | '))

const wd = await post('/cli-mode/workdir', { sessionId })
check('workdir resolves from the session header', wd.status === 200 && wd.payload?.workdir === process.cwd(), JSON.stringify(wd.payload))

// No shell executor: the plugin must refuse with an actionable message rather
// than pretend the command ran.
const noShell = new Map()
apply({
  effect: (factory) => factory(),
  logger: { info: () => {}, warn: () => {} },
  inject: (n, cb) => cb({
    webServer: { register: (r) => { noShell.set(r.path, r.handler); return () => {} } },
    get: (k) => (k === 'connection' ? { isAuthenticated: () => true } : undefined),
    parent: undefined,
  }),
  get: (k) => (k === 'sessions' ? { get: (id) => (id === sessionId ? session : undefined) } : undefined),
})
{
  const chunks = [Buffer.from('{"command":"!npm --version","sessionId":"' + sessionId + '"}', 'utf8')]
  const req = { method: 'POST', headers: { host: '127.0.0.1:3080' }, on() {}, off() {}, async *[Symbol.asyncIterator]() { for (const c of chunks) yield c } }
  let done
  const settled = new Promise((r) => { done = r })
  const res = { status: 0, payload: undefined, writableEnded: false, destroyed: false, writeHead(s) { this.status = s }, end(b) { this.writableEnded = true; try { this.payload = JSON.parse(String(b)) } catch {} done() } }
  await noShell.get('/cli-mode/exec')(req, res)
  await settled
  check('missing shell executor is reported, not faked', res.payload?.ok === false && /shell/.test(res.payload?.message ?? ''), String(res.payload?.message))
}

const ok = await post('/cli-mode/exec', { command: '!npm --version', sessionId })
check('real command executes through the composed shell', ok.status === 200 && ok.payload?.ok === true, JSON.stringify(ok.payload?.stdout))
check('success message names the command', ok.payload?.message === '`npm --version` 命令已执行', String(ok.payload?.message))
check('stdout is captured', typeof ok.payload?.stdout === 'string' && ok.payload.stdout.length > 0, String(ok.payload?.stdout))
check('workdir travels into the spec', ok.payload?.workdir === process.cwd(), String(ok.payload?.workdir))

const bad = await post('/cli-mode/exec', { command: '!git stauts', sessionId })
check('a failing command reports failure', bad.status === 200 && bad.payload?.ok === false, String(bad.payload?.exitCode))
check('suggestions travel only in the array, not folded into message', (bad.payload?.suggestions?.length ?? 0) > 0 && !/下一步建议/.test(bad.payload?.message ?? ''), String(bad.payload?.suggestions?.[0]?.slice(0, 30)))
check('failure message is the heading, not the folded error body', /命令执行失败/.test(bad.payload?.message ?? ''), String(bad.payload?.message?.slice(0, 40)))

const denied = await post('/cli-mode/exec', { command: '!echo box', sessionId }, { host: 'evil.example.com' })
check('origin fence still applies with the gate open', denied.status === 403, String(denied.status))

const histWrite = await post('/cli-mode/history', { sessionId, entries: ['npm --version', 'git status'] })
const histRead = await post('/cli-mode/history', { sessionId })
check('history persists to disk and reads back', histWrite.status === 200 && JSON.stringify(histRead.payload?.entries) === JSON.stringify(['npm --version', 'git status']), JSON.stringify(histRead.payload))

const failed = results.filter((r) => !r.ok)
console.log('\n' + String(results.length - failed.length) + '/' + String(results.length) + ' end-to-end checks passed')
if (failed.length > 0) {
  console.log('FAILED: ' + failed.map((f) => f.label).join('; '))
  process.exitCode = 1
}
