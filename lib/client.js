// Browser half of the dsh-cli-mode plugin: command-line mode for the composer.
//
// DESIGN (v2 — DOM listener, no composer takeover):
// The composer-chain takeover proved unusable here: every slot that could host
// a result card (`conversation.input.dock`, `conversation.composer.dock`) is
// declared INSIDE the composer bar, so a chain election hides them with
// `display:none` along with the bar — "no result" — and the draft mirror the
// election depended on lagged one render pass, so leaving command mode walked
// straight back in — "Esc does nothing". This half therefore no longer replaces
// the composer at all. It:
//
//   1. watches the live draft from a null-rendering component parked in
//      `conversation.input.overlay`, toggling `body[data-cli-mode]` so the
//      resident composer's text turns red while a marker is present;
//   2. intercepts Enter (capture phase, document level — the same mechanism the
//      shipped modlens plugin uses for paste) and runs the marked line on the
//      Host, then clears the draft; Escape clears a marked draft to leave mode;
//   3. renders the result card in `conversation.composer.dock`, which is always
//      visible now that the composer is never taken over.
//
// Hand-written in the lazy-CJS bundle protocol (window.__ModuleLoader__.load):
// `require` only reaches the platform seed module `react`, Host communication is
// same-origin fetch to this plugin's own routes, and no build step is needed.
window.__ModuleLoader__.load({
  id: 'dsh-cli-mode',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var CFG = {
      prefix: 'dsh-cli-mode',
      exec: '/cli-mode/exec',
      workdir: '/cli-mode/workdir',
      history: '/cli-mode/history',
      timeoutMs: 120000,
      outputLimit: 4000,
    }

    var CSS = [
      // Red command-line text on the resident composer while a marker is live.
      'body[data-cli-mode="on"] [data-composer-input]{color:#e5484d!important;caret-color:#e5484d!important}',
      // Result card below the composer (now always visible: no takeover).
      '.' + CFG.prefix + '-card{width:100%;border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:8px 10px;display:flex;flex-direction:column;gap:6px;box-sizing:border-box}',
      '.' + CFG.prefix + '-card[data-state="running"]{border-left-color:var(--dsw-alias-brand-primary)}',
      '.' + CFG.prefix + '-card[data-state="ok"]{border-left-color:var(--dsw-alias-state-success-primary)}',
      '.' + CFG.prefix + '-card[data-state="fail"]{border-left-color:var(--dsw-alias-state-error-primary)}',
      '.' + CFG.prefix + '-head{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.' + CFG.prefix + '-head[data-state="ok"]{color:var(--dsw-alias-state-success-primary)}',
      '.' + CFG.prefix + '-head[data-state="fail"]{color:var(--dsw-alias-state-error-primary)}',
      '.' + CFG.prefix + '-spacer{flex:1}',
      '.' + CFG.prefix + '-close{border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;padding:2px 4px;border-radius:6px}',
      '.' + CFG.prefix + '-close:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.' + CFG.prefix + '-cmd{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--dsw-alias-label-primary);word-break:break-all}',
      '.' + CFG.prefix + '-note{font-size:12px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}',
      '.' + CFG.prefix + '-out{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:6px 8px;max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-all}',
      '.' + CFG.prefix + '-sug{margin:0;padding-left:18px;font-size:12px;line-height:1.6;color:var(--dsw-alias-state-warn-primary)}',
      '.' + CFG.prefix + '-path{font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--dsw-alias-label-secondary);word-break:break-all}',
    ].join('\n')

    function normalizeHead(text) {
      return String(text === undefined || text === null ? '' : text).replace(/^[\s\u3000]+/u, '')
    }

    function hasMarker(text) {
      var head = normalizeHead(text)
      if (head === '') return false
      var first = head.codePointAt(0)
      return first === 0xff01 || first === 0x21
    }

    function stripMarker(text) {
      var head = normalizeHead(text)
      var first = head.codePointAt(0)
      if (first === 0xff01 || first === 0x21) return head.slice(1).trim()
      return head.trim()
    }

    function clip(text, max) {
      var value = String(text === undefined || text === null ? '' : text)
      return value.length <= max ? value : value.slice(0, max) + '\n…（输出过长，已截断显示）'
    }

    function post(url, body, signal) {
      return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal,
      }).then(function (response) {
        if (response.status === 401) throw new Error('HTTP 401：本页会话未被服务端接受，请用 dsh web 打印的带 token 地址重新打开页面')
        if (response.status === 403) throw new Error('HTTP 403：请求来源不被信任（需从 dsh web 打印的本机地址访问）')
        if (!response.ok) throw new Error('HTTP ' + String(response.status))
        return response.json()
      })
    }

    function resolveDocument() {
      var candidates = []
      try { candidates.push(document) } catch (error) { /* no bare binding */ }
      try { candidates.push(window.document) } catch (error) { /* no window */ }
      try { candidates.push(globalThis.window && globalThis.window.document) } catch (error) { /* no globalThis window */ }
      for (var i = 0; i < candidates.length; i += 1) {
        var candidate = candidates[i]
        if (candidate && typeof candidate.createElement === 'function') return candidate
      }
      return undefined
    }

    function insertStyles(doc) {
      var element = doc.createElement('style')
      element.dataset.plugin = CFG.prefix
      element.textContent = CSS
      var parent = doc.head || doc.documentElement || doc.body
      if (parent && typeof parent.appendChild === 'function') parent.appendChild(element)
      else if (typeof doc.head.append === 'function') doc.head.append(element)
      else throw new Error('no style host')
      return element
    }

    function apply(ctx) {
      var React = require('react')

      // ---- module-scope shared state (one instance per page) ----
      var results = {}
      var workdirs = {}
      var listeners = new Set()
      var gate = { sessionId: '', actions: null, draft: '' }

      function notify() {
        listeners.forEach(function (listener) {
          try { listener() } catch (error) { console.error('[cli-mode] listener failed', error) }
        })
      }
      function keyOf(sessionId) {
        return typeof sessionId === 'string' && sessionId !== '' ? sessionId : 'no-session'
      }
      function setResult(sessionId, next) {
        var key = keyOf(sessionId)
        if (next === null || next === undefined) delete results[key]
        else results[key] = next
        notify()
      }

      // ---- styles ----
      var doc = resolveDocument()
      var styleElement
      if (doc !== undefined) {
        try {
          styleElement = insertStyles(doc)
          ctx.effect(function () { return function () { styleElement.remove() } }, 'cli-mode: styles')
        } catch (error) {
          console.error('[cli-mode] stylesheet insertion failed; the resident composer will not turn red', error)
        }
      } else {
        console.error('[cli-mode] no document reachable; command-line mode cannot style or intercept the composer')
      }

      // ---- draft watcher (red mode + session context) ----
      // `conversation.input.overlay` is a list slot inside the composer card; it
      // has no election, so its entry really receives the standard session props
      // and re-renders on every draft change.
      function ModeWatcher(props) {
        var useInput = props.useInput
        var draft = typeof useInput === 'function'
          ? useInput(function (state) { return state === undefined ? '' : state.draft }, function (l, r) { return l === r })
          : ''
        gate.draft = draft
        gate.sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
        gate.actions = props.inputActions === undefined || props.inputActions === null ? null : props.inputActions
        React.useEffect(function () {
          var root = resolveDocument()
          if (!root || !root.body) return undefined
          if (hasMarker(draft)) root.body.setAttribute('data-cli-mode', 'on')
          else root.body.removeAttribute('data-cli-mode')
          return function () { root.body.removeAttribute('data-cli-mode') }
        }, [draft])
        return null
      }

      // ---- result card (composer.dock is always visible: no takeover) ----
      function useResult(sessionId) {
        var key = keyOf(sessionId)
        var subscribe = React.useCallback(function (onChange) {
          listeners.add(onChange)
          return function () { listeners.delete(onChange) }
        }, [])
        var snapshot = React.useCallback(function () { return results[key] }, [key])
        return React.useSyncExternalStore(subscribe, snapshot, snapshot)
      }

      function useWorkdir(sessionId) {
        var key = keyOf(sessionId)
        var state = React.useState(function () { return key in workdirs ? workdirs[key] : null })
        var workdir = state[0]
        var setWorkdir = state[1]
        React.useEffect(function () {
          if (key in workdirs) return undefined
          var live = true
          post(CFG.workdir, { sessionId: typeof sessionId === 'string' ? sessionId : '' }, undefined)
            .then(function (value) {
              var resolved = typeof value.workdir === 'string' ? value.workdir : null
              workdirs[key] = resolved
              if (live) setWorkdir(resolved)
            })
            .catch(function (error) { console.error('[cli-mode] workdir lookup failed', error) })
          return function () { live = false }
        }, [key])
        return workdir
      }

      function CommandDock(props) {
        var result = useResult(props.sessionId)
        var workdir = useWorkdir(props.sessionId)
        if (result === undefined || result === null) return null
        var state = result.state
        var headText = state === 'running' ? '命令执行中' : (state === 'ok' ? '命令已执行' : '命令执行失败')
        var children = []
        children.push(React.createElement('div', { className: CFG.prefix + '-head', 'data-state': state, key: 'head' },
          React.createElement('span', null, headText),
          React.createElement('span', { className: CFG.prefix + '-spacer' }),
          React.createElement('button', { type: 'button', className: CFG.prefix + '-close', onClick: function () { setResult(props.sessionId, null) } }, '清除'),
        ))
        children.push(React.createElement('div', { className: CFG.prefix + '-cmd', key: 'cmd' }, '$ ' + String(result.command === undefined ? '' : result.command)))
        if (state === 'running') {
          children.push(React.createElement('div', { className: CFG.prefix + '-note', key: 'note' }, '命令已在后台执行，完成后会自动更新结果。'))
        }
        if (typeof result.summary === 'string' && result.summary !== '') {
          children.push(React.createElement('div', { className: CFG.prefix + '-note', key: 'summary' }, result.summary))
        }
        if (Array.isArray(result.suggestions) && result.suggestions.length > 0) {
          children.push(React.createElement('ol', { className: CFG.prefix + '-sug', key: 'sug' },
            result.suggestions.map(function (item, index) { return React.createElement('li', { key: 's' + String(index) }, item) }),
          ))
        }
        if (typeof result.stdout === 'string' && result.stdout !== '') {
          children.push(React.createElement('pre', { className: CFG.prefix + '-out', key: 'out' },
            clip(result.stdout, CFG.outputLimit) + (result.truncated === true ? '\n…（输出已截断）' : ''),
          ))
        }
        if (typeof result.stderr === 'string' && result.stderr !== '') {
          children.push(React.createElement('pre', { className: CFG.prefix + '-out', key: 'err' },
            clip(result.stderr, CFG.outputLimit) + (result.truncated === true ? '\n…（输出已截断）' : ''),
          ))
        }
        var pathText = typeof result.workdir === 'string' ? result.workdir : workdir
        if (typeof pathText === 'string' && pathText !== '') {
          children.push(React.createElement('div', { className: CFG.prefix + '-path', key: 'path' }, 'cwd: ' + pathText))
        }
        return React.createElement('div', { className: CFG.prefix + '-card', 'data-state': state }, children)
      }

      // ---- Host execution ----
      function runCommand(command, sessionId, actions) {
        if (command === '') return
        var key = keyOf(sessionId)
        setResult(key, { state: 'running', command: command, workdir: workdirs[key] === undefined ? null : workdirs[key] })
        var controller = new AbortController()
        post(CFG.exec, { command: command, sessionId: typeof sessionId === 'string' ? sessionId : '', timeoutMs: CFG.timeoutMs }, controller.signal)
          .then(function (result) {
            if (result === null || result === undefined || typeof result !== 'object') {
              setResult(key, { state: 'fail', command: command, summary: '执行通道返回了空结果。', suggestions: ['请重试一次；若持续失败，请检查 Host 侧的 shell 服务。'] })
            } else if (result.ok === true) {
              setResult(key, {
                state: 'ok',
                command: command,
                workdir: typeof result.workdir === 'string' ? result.workdir : null,
                summary: typeof result.message === 'string' ? result.message : '`' + command + '` 命令已执行',
                stdout: typeof result.stdout === 'string' ? result.stdout : '',
                truncated: result.truncated === true,
              })
            } else {
              setResult(key, {
                state: 'fail',
                command: command,
                workdir: typeof result.workdir === 'string' ? result.workdir : null,
                summary: typeof result.message === 'string' ? result.message : '`' + command + '` 执行失败。',
                stdout: typeof result.stdout === 'string' ? result.stdout : '',
                stderr: typeof result.stderr === 'string' ? result.stderr : '',
                truncated: result.truncated === true,
                suggestions: Array.isArray(result.suggestions) ? result.suggestions.filter(function (item) { return typeof item === 'string' }) : [],
              })
            }
          })
          .catch(function (error) {
            var message = error instanceof Error ? error.message : String(error)
            setResult(key, { state: 'fail', command: command, summary: message, suggestions: ['确认 Host 进程仍在运行、Web 服务可访问，然后重试。'] })
          })
          .then(function () {
            // Clear the composer so the marked line does not linger (and the red
            // tint clears through the watcher).
            if (actions) actions.setDraft('')
          })
      }

      // ---- keyboard interception (capture phase, document level) ----
      function onDocumentKeyDown(event) {
        var target = event.target
        var editor = target && typeof target.closest === 'function' ? target.closest('[data-composer-input]') : null
        if (!editor) return
        var text = String(editor.innerText || editor.textContent || '').trim()

        if (event.key === 'Enter' && !event.shiftKey) {
          if (!hasMarker(text)) return
          event.preventDefault()
          event.stopPropagation()
          runCommand(stripMarker(text), gate.sessionId, gate.actions)
          return
        }

        if (event.key === 'Escape') {
          if (!hasMarker(text)) return
          event.preventDefault()
          event.stopPropagation()
          if (gate.actions) gate.actions.setDraft('')
        }
      }

      // ---- slot registrations ----
      var disposers = []
      if (typeof ctx.inject === 'function') {
        ctx.inject(['slots'], function (scope) {
          if (scope.slots === undefined || scope.slots === null) return
          disposers.push(scope.slots.inject('conversation.input.overlay', function () {
            return scope.slots.register({ name: 'conversation.input.overlay', id: 'cli-mode-watcher', order: 0, label: '命令行模式' }, ModeWatcher)
          }))
          disposers.push(scope.slots.inject('conversation.composer.dock', function () {
            return scope.slots.register({ name: 'conversation.composer.dock', id: 'cli-mode-result', order: 50, label: '命令行执行结果' }, CommandDock)
          }))
        })
      } else {
        console.error('[cli-mode] ctx.inject unavailable; command-line mode cannot mount')
      }

      // document-level listener, owned by the plugin fiber
      if (doc !== undefined && typeof doc.addEventListener === 'function') {
        doc.addEventListener('keydown', onDocumentKeyDown, true)
        ctx.effect(function () {
          return function () { doc.removeEventListener('keydown', onDocumentKeyDown, true) }
        }, 'cli-mode: keydown')
      }
    }

    exports.name = 'cli-mode-client'
    exports.apply = apply
    exports.inject = []
    return module.exports
  },
})
