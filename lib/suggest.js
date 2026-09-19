/**
 * Command-line-mode analysis: marker parsing, failure rendering, and the
 * failure-to-next-step suggestion engine.
 *
 * Pure functions over plain strings: no cordis context, no node builtins, no
 * I/O. `lib/index.js` owns every side effect; this module exists so the
 * decision table can be reviewed and tested on its own.
 * @module dsh-cli-mode/suggest
 */

/** Command-line markers accepted at the very start of a composer draft. */
export const MARKERS = Object.freeze(['！', '!'])

/** Default next step when a failure matches no specific fingerprint. */
export const FALLBACK_SUGGESTION =
  '确认命令拼写与参数后重试；如需确认当前环境，可执行 pwd 或 Get-ChildItem 查看工作目录内容。'

/** Whether the platform separators imply a Windows shell. */
function isWindows() {
  try {
    return typeof process !== 'undefined' && process !== null && process.platform === 'win32'
  } catch {
    return false
  }
}

/**
 * Strip leading whitespace (ASCII and ideographic space) before looking for a
 * marker, so `！ cmd`, `! cmd`, and `   ! cmd` all enter command-line mode.
 * @param text - raw draft or raw line.
 * @returns the text with leading whitespace removed.
 */
export function normalizeHead(text) {
  return String(text === undefined || text === null ? '' : text).replace(/^[\s\u3000]+/u, '')
}

/** Whether the text opens command-line mode. */
export function hasMarker(text) {
  const head = normalizeHead(text)
  if (head === '') return false
  const first = head.codePointAt(0)
  return first === 0xff01 || first === 0x21
}

/**
 * Extract the command from a marked line.
 * @param line - raw line, with or without a marker.
 * @returns the command text; empty when the line carries no command.
 */
export function stripMarker(line) {
  const head = normalizeHead(line)
  const first = head.codePointAt(0)
  if (first === 0xff01 || first === 0x21) return head.slice(1).trim()
  return head.trim()
}

/** Heading line for a failed run. */
export function failureHeading(command, exitCode, timedOut) {
  if (timedOut) return '命令超时被终止：' + command
  if (exitCode === null || exitCode === undefined) return '命令执行失败：' + command
  return '命令执行失败，退出码 ' + String(exitCode) + '：' + command
}

/**
 * Derive ordered, concrete next steps from one failed run.
 * @param command - the command line that ran.
 * @param stderr - captured standard error.
 * @param stdout - captured standard output.
 * @param exitCode - process exit code, or null when unavailable.
 * @param timedOut - whether the run was killed by the timeout.
 * @param sandbox - observed sandbox outcome, when the executor reported one.
 * @returns one to four suggestions, never empty.
 */
export function suggestionsFor(command, stderr, stdout, exitCode, timedOut, sandbox) {
  if (timedOut) {
    return [
      '该命令超过超时上限被终止；确认它是否需要交互式输入（无终端环境下这类命令无法完成）。',
      '缩小命令范围后重试，例如只处理单个文件或单个目录。',
      '需要长时间运行的进程，请改用带后台执行的 bash 工具（run_in_background）。',
    ]
  }
  const rawText = String(stderr === undefined || stderr === null ? '' : stderr)
  const text = (rawText + '\n' + String(stdout === undefined || stdout === null ? '' : stdout)).toLowerCase()
  const out = []
  const windows = isWindows()

  if (sandbox !== null && sandbox !== undefined && sandbox.denied === true) {
    out.push(
      '该命令被文件沙箱拒绝（当前模式：' + String(sandbox.mode) +
        '）；写操作需要 workspace-write 或 danger-full-access 权限，请调整沙箱模式后重试，或把目标改到工作区内。',
    )
  }
  if (
    text.includes('is not recognized') ||
    text.includes('command not found') ||
    text.includes('not recognized as an internal') ||
    text.includes('无法将')
  ) {
    out.push('命令或别名不存在：先用 where / Get-Command（Windows）或 which / command -v（bash）确认可执行文件位置。')
    out.push('检查 PATH 是否包含该工具目录，或改用绝对路径重试。')
    out.push('若是 Node 工具，确认依赖已在当前项目安装。')
  } else if (
    text.includes('permission denied') ||
    text.includes('access is denied') ||
    text.includes('eacces') ||
    text.includes('拒绝访问')
  ) {
    out.push('权限不足：确认目标文件未被其他进程占用，或改用有写权限的目录。')
    if (windows) out.push('Windows 下可尝试以管理员身份运行，或先解除只读属性（attrib -r <文件>）。')
    else out.push('POSIX 下先看属主与权限位（ls -l），必要时用 chmod 调整。')
  } else if (
    text.includes('enoent') ||
    text.includes('no such file or directory') ||
    text.includes('cannot find path') ||
    text.includes('找不到路径') ||
    text.includes('系统找不到指定的文件')
  ) {
    out.push('路径不存在：先执行 pwd / Get-Location 确认当前工作目录。')
    out.push('用 ls / Get-ChildItem 列出目录内容，核对文件名拼写与大小写。')
  } else if (text.includes('is a directory') || text.includes('directory not empty')) {
    out.push('目标是目录：补全具体文件名，或为递归操作加上 -Recurse / -r 参数。')
  } else if (text.includes('already exists') || text.includes('已存在')) {
    out.push('目标已存在：确认是否要覆盖（-Force / --force），或先改名再重试。')
  } else if (
    text.includes('term is not recognized') ||
    text.includes('commandnotfoundexception') ||
    text.includes('objectnotfound') ||
    text.includes('parameterbindingexception')
  ) {
    out.push('PowerShell 未识别该命令或参数：用 Get-Command <名称> 查真实命令名，用 Get-Help <命令> -Examples 看用法。')
    out.push('核对参数名与参数类型（例如 -Path / -Name / -Recurse），避免混用 cmd 与 PowerShell 语法。')
  } else if (
    text.includes('syntaxerror') ||
    text.includes('unexpected token') ||
    text.includes('parsererror') ||
    text.includes('无法识别')
  ) {
    out.push('语法或参数有误：核对引号与括号是否成对，路径含空格时用引号包裹。')
    if (windows) out.push('PowerShell 下可执行 Get-Help <命令> -Examples 查看正确用法。')
    else out.push('可执行 <命令> --help 查看正确参数。')
  } else if (text.includes('not a git repository')) {
    out.push('当前目录不是 Git 仓库：先切换到仓库根目录，或执行 git init 初始化。')
  } else if (text.includes('eaddrinuse') || text.includes('address already in use')) {
    out.push('端口已被占用：先查出占用进程（netstat -ano | findstr :端口）再结束它，或改用其他端口。')
  } else if (
    text.includes('modulenotfound') ||
    text.includes('cannot find module') ||
    text.includes('no module named')
  ) {
    out.push('缺少依赖模块：先安装依赖（npm install / pip install），或改用项目内的相对路径。')
  } else if (text.includes('no such file or directory: package.json')) {
    out.push('当前目录没有 package.json：先切到项目根目录，或执行 npm init -y 初始化。')
  } else if (
    text.includes('missing script') ||
    text.includes('unknown command') ||
    text.includes('未知命令') ||
    text.includes('npm error')
  ) {
    out.push('npm 脚本或命令不存在：先执行 npm run 列出可用脚本，再核对脚本名。')
    out.push('确认在正确的项目目录下执行（package.json 所在目录）。')
  } else if (exitCode === null || exitCode === undefined || exitCode !== 0) {
    out.push('命令以非零状态结束：先单独执行命令中最关键的那一段，缩小失败范围。')
    out.push('在命令后追加 2>&1 合并错误输出，或加上 -v / --verbose 之类的详细日志参数，通常能直接定位原因。')
  }
  if (out.length === 0) out.push(FALLBACK_SUGGESTION)
  return out.slice(0, 4)
}

/**
 * Render the failure line shown in the result card: the system error only.
 *
 * The next-step suggestions are NOT part of this text — they travel in the
 * `suggestions` array and the browser renders them once as the yellow numbered
 * list. Folding them into the message as well produced the duplicate report
 * the user saw (once in grey body text, once in the yellow list).
 * @returns the failure heading line.
 */
export function renderFailure(command, stderr, stdout, exitCode, timedOut, sandbox) {
  return failureHeading(command, exitCode, timedOut)
}
