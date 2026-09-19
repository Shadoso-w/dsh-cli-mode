// Client-half exerciser (v2 — DOM listener design): loads the shipped lazy-CJS
// bundle and verifies the behaviors that the composer-chain version could not:
// red mode via body[data-cli-mode], document-level Enter/Escape interception,
// and the always-visible result card.
import { readFileSync } from 'node:fs'

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail === '' ? '' : ' — ' + detail))
}

// ---- fake document ----
const bodyAttrs = {}
const keydownListeners = []
const styles = []
const fakeDocument = {
  body: {
    setAttribute: (k, v) => { bodyAttrs[k] = v },
    removeAttribute: (k) => { delete bodyAttrs[k] },
  },
  head: { appendChild: (el) => { styles.push(el) } },
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  addEventListener: (name, fn, capture) => { keydownListeners.push({ name, fn, capture }) },
  removeEventListener: (name, fn) => { for (let i = keydownListeners.length - 1; i >= 0; i--) if (keydownListeners[i].fn === fn) keydownListeners.splice(i, 1) },
}

// ---- fake React ----
function createFakeReact() {
  const runtime = { hooks: [], cursor: 0, dirty: false }
  const cell = (init) => {
    const index = runtime.cursor++
    if (runtime.hooks.length <= index) runtime.hooks[index] = init()
    return runtime.hooks[index]
  }
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat().filter((c) => c !== null && c !== undefined && c !== false) }
    },
    useState(initial) {
      const c = cell(() => ({ value: typeof initial === 'function' ? initial() : initial }))
      return [c.value, (next) => { const v = typeof next === 'function' ? next(c.value) : next; if (!Object.is(v, c.value)) { c.value = v; runtime.dirty = true } }]
    },
    useRef(initial) { return cell(() => ({ current: initial })) },
    useCallback(fn, deps) {
      const c = cell(() => ({ deps: undefined, fn }))
      if (c.deps === undefined || deps === undefined || c.deps.length !== deps.length || !deps.every((d, i) => d === c.deps[i])) { c.fn = fn; c.deps = deps }
      return c.fn
    },
    useEffect(fn, deps) {
      const c = cell(() => ({ deps: undefined, cleanup: undefined, ran: false }))
      if (c.ran && deps !== undefined && c.deps !== undefined && deps.length === c.deps.length && deps.every((d, i) => d === c.deps[i])) return
      if (c.ran && typeof c.cleanup === 'function') c.cleanup()
      c.deps = deps; c.ran = true; c.cleanup = fn()
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      cell(() => { subscribe(() => { runtime.dirty = true }); return {} })
      return typeof getSnapshot === 'function' ? getSnapshot() : undefined
    },
  }
  return {
    React,
    rerender(render) {
      let tree = null, guard = 0
      do { runtime.cursor = 0; runtime.dirty = false; tree = render(); guard += 1 } while (runtime.dirty && guard < 30)
      return tree
    },
  }
}

// ---- load the bundle ----
const registered = []
globalThis.window = { __ModuleLoader__: { load: (r) => registered.push(r) } }
globalThis.document = fakeDocument
const fetchCalls = []
globalThis.fetch = (url, options) => {
  const body = options && options.body ? JSON.parse(options.body) : undefined
  fetchCalls.push({ url, body })
  if (url.endsWith('/workdir')) return Promise.resolve({ ok: true, json: async () => ({ workdir: '/workspace/demo' }) })
  if (url.endsWith('/exec')) return Promise.resolve({ ok: true, json: async () => ({ ok: true, command: body.command, stdout: 'fixture-stdout', workdir: '/workspace/demo', message: '`' + body.command + '` 命令已执行' }) })
  if (url.endsWith('/history')) return Promise.resolve({ ok: true, json: async () => ({ entries: [] }) })
  return Promise.resolve({ ok: true, json: async () => ({}) })
}

new Function(readFileSync(new URL('./lib/client.js', import.meta.url), 'utf8'))()
check('bundle registers itself', registered.length === 1 && registered[0].id === 'dsh-cli-mode', String(registered.length))

const fake = createFakeReact()
let React = fake.React
const exportsObject = registered[0].factory((specifier) => {
  if (specifier === 'react') return React
  throw new Error('unexpected require: ' + specifier)
})
check('exports apply and an empty hard-injection list', typeof exportsObject.apply === 'function' && exportsObject.inject.length === 0)

// ---- mount through the slot API ----
const entries = []
const addressed = []
const slots = {
  inject(key, callback) { addressed.push(key); callback(); return () => {} },
  register(options, component) { entries.push({ options, component }); return () => {} },
}
const effects = []
exportsObject.apply({
  inject(names, callback) { callback({ slots }) },
  effect(factory) { effects.push(factory()) },
})
check('both slots are addressed', addressed.join(',') === 'conversation.input.overlay,conversation.composer.dock', addressed.join(','))
check('two entries are registered', entries.length === 2, entries.map((e) => e.options.name).join(', '))

const watcher = entries.find((e) => e.options.id === 'cli-mode-watcher')
const dock = entries.find((e) => e.options.id === 'cli-mode-result')
check('watcher sits in the composer overlay', watcher.options.name === 'conversation.input.overlay', watcher.options.name)
check('result card sits in the always-visible composer dock', dock.options.name === 'conversation.composer.dock', dock.options.name)

// ---- ModeWatcher: red mode + gate capture ----
const setDraftCalls = []
let draft = 'hello'
const watcherProps = {
  sessionId: 'session-client',
  inputActions: { setDraft: (t) => setDraftCalls.push(t) },
  useInput: (selector) => selector({ draft, phase: 'plain', attachmentIds: [], occurrences: [], queue: [] }),
}
fake.rerender(() => watcher.component(watcherProps))
check('unmarked draft does not turn red', bodyAttrs['data-cli-mode'] !== 'on', JSON.stringify(bodyAttrs))

draft = '!npm --version'
fake.rerender(() => watcher.component(watcherProps))
check('marked draft turns the resident composer red', bodyAttrs['data-cli-mode'] === 'on', JSON.stringify(bodyAttrs))

draft = 'hello'
fake.rerender(() => watcher.component(watcherProps))
check('red mode clears when the marker disappears', bodyAttrs['data-cli-mode'] !== 'on', JSON.stringify(bodyAttrs))

// ---- document-level keydown interception ----
check('keydown listener is registered in capture phase', keydownListeners.length === 1 && keydownListeners[0].capture === true, 'count=' + String(keydownListeners.length))

function makeEvent(key, text, shiftKey = false) {
  const target = {
    closest: (selector) => (selector === '[data-composer-input]' ? { innerText: text, textContent: text } : null),
  }
  const calls = {}
  return {
    key,
    shiftKey,
    target,
    preventDefault() { calls.preventDefault = true },
    stopPropagation() { calls.stopPropagation = true },
    calls,
  }
}

// Enter on a marked line: run + clear
const enterEvent = makeEvent('Enter', '!npm --version')
keydownListeners[0].fn(enterEvent)
check('Enter on a marked line is prevented and stopped', enterEvent.calls.preventDefault === true && enterEvent.calls.stopPropagation === true)
await new Promise((r) => setTimeout(r, 20))
check('exec request reached the host route', fetchCalls.some((c) => c.url.endsWith('/exec') && c.body?.command === 'npm --version'), JSON.stringify(fetchCalls.map((c) => c.url)))
check('the composer is cleared after execution', setDraftCalls.length === 1 && setDraftCalls[0] === '', JSON.stringify(setDraftCalls))

// Enter on a normal line: untouched
const normalEnter = makeEvent('Enter', 'hello there')
keydownListeners[0].fn(normalEnter)
check('Enter on a plain line is left alone', normalEnter.calls.preventDefault !== true && normalEnter.calls.stopPropagation !== true)

// Escape on a marked line: clear the draft (exit command mode)
const escEvent = makeEvent('Escape', '!')
keydownListeners[0].fn(escEvent)
check('Escape on a marked line clears the draft', escEvent.calls.preventDefault === true && setDraftCalls.length === 2 && setDraftCalls[1] === '', JSON.stringify(setDraftCalls))

// Escape on a plain line: untouched
const escPlain = makeEvent('Escape', 'normal')
keydownListeners[0].fn(escPlain)
check('Escape on a plain line is left alone', escPlain.calls.preventDefault !== true)

// ---- result card store (shared through the module) ----
const dockTree = fake.rerender(() => dock.component({ sessionId: 'session-client' }))
const deepText = (node, out = []) => {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const c of node) deepText(c, out); return out }
  if (typeof node === 'object' && node.type !== undefined) { for (const c of node.children ?? []) deepText(c, out) }
  return out
}
const text = deepText(dockTree).join(' | ')
check('result card reports the executed command', text.includes('命令已执行') && text.includes('npm --version') && text.includes('fixture-stdout'), text.slice(0, 200))

const failed = results.filter((r) => !r.ok)
console.log('\n' + String(results.length - failed.length) + '/' + String(results.length) + ' client-half checks passed')
if (failed.length > 0) {
  console.log('FAILED: ' + failed.map((f) => f.label).join('; '))
  process.exitCode = 1
}
