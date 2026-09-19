// Development aid: verify that this bundle is wired into a local DSH profile
// exactly as the boot path reads it — bundle resolution from the install
// anchor, the bundle's own cordis.patch.yml overlay, and the profile's user
// patch layer. A pass here means the row will mount on the next start.
//
// This check is deployment-specific by nature (it inspects an installed
// profile), so it never assumes a machine layout. Discovery, in order:
//
//   DSH_INSTALL  absolute path to the installed `@deepseek-ai/dsh/package.json`
//   DSH_HOME     Harness home (default: ~/.dsh)
//   DSH_PROFILE  profile to inspect (default: web)
//
// When no DSH installation can be found the script SKIPS with exit code 0:
// "cannot check" must not read as "broken" in CI or in a fresh clone.
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const PACKAGE = 'dsh-cli-mode'
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROFILE = process.env.DSH_PROFILE ?? 'web'
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE)

/** Locate the installed `@deepseek-ai/dsh/package.json`, or undefined. */
function findInstallAnchor() {
  const explicit = process.env.DSH_INSTALL
  if (typeof explicit === 'string' && existsSync(explicit)) return resolve(explicit)

  // A co-located development checkout, or a global install reachable from here.
  const require = createRequire(import.meta.url)
  const probes = ['@deepseek-ai/dsh/package.json']
  for (const probe of probes) {
    try {
      return require.resolve(probe)
    } catch {
      // fall through to the well-known global roots
    }
  }
  const roots = [
    process.env.APPDATA === undefined ? undefined : join(process.env.APPDATA, 'npm', 'node_modules'),
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
  ]
  for (const root of roots) {
    if (root === undefined) continue
    const candidate = join(root, '@deepseek-ai', 'dsh', 'package.json')
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

const anchor = findInstallAnchor()
if (anchor === undefined) {
  console.log('SKIP: no DSH installation found — set DSH_INSTALL to its package.json to run this check.')
  process.exit(0)
}
if (!existsSync(PROFILE_DIR)) {
  console.log(`SKIP: profile "${PROFILE}" not found at ${PROFILE_DIR} — set DSH_HOME/DSH_PROFILE, or install the bundle first.`)
  process.exit(0)
}

// Import the launcher's own app-boot helpers by absolute path: resolving the
// package by name would need the caller's module graph, and these are exactly
// the functions the boot uses, so the check cannot drift from production.
const appBootEntry = join(dirname(anchor), 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')
const appBoot = existsSync(appBootEntry) ? await import(pathToFileURL(appBootEntry).href) : undefined
if (appBoot === undefined) {
  console.log(`SKIP: app-boot helpers not found beside the installation (${appBootEntry}).`)
  process.exit(0)
}

const { loadOverlayPatches, loadProfile, readProfileManifest, resolveBundleDir } = appBoot
const anchorArg = anchor.replace(/\\/g, '/')
const profileArg = PROFILE_DIR.replace(/\\/g, '/')

const problems = []
const report = (label, ok, detail = '') => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail === '' ? '' : ' — ' + detail))
  if (!ok) problems.push(label)
}

const manifest = readProfileManifest('dsh', PROFILE_DIR)
const bundles = manifest.dsh?.profile?.bundles ?? []
report('profile lists the bundle', bundles.includes(PACKAGE), bundles.join(', '))
report('profile declares the dependency', Object.keys(manifest.dependencies ?? {}).includes(PACKAGE), String(manifest.dependencies?.[PACKAGE]))

const dir = resolveBundleDir('dsh', PACKAGE, anchor, PROFILE_DIR)
report('bundle resolves from the install/profile anchors', dir.replace(/\\/g, '/').endsWith(PACKAGE), dir)

const declared = readProfileManifest('dsh', dir).dsh?.bundle?.patch
report('bundle declares dsh.bundle.patch', declared === './cordis.patch.yml', String(declared))

const patches = loadOverlayPatches('dsh', join(dir, 'cordis.patch.yml').replace(/\\/g, '/'))
const inserted = patches.flatMap((patch) => patch.insert ?? [])
const row = inserted.find((entry) => entry.id === PACKAGE)
report('bundle patch inserts the row', row !== undefined, JSON.stringify(inserted))
report('row name is the resolvable package name', row?.name === PACKAGE, String(row?.name))

// The full profile load performs the same resolution the boot does for every
// layer; it throws on a malformed layer, so reaching here validates the whole
// layer stack with this bundle appended.
const profile = loadProfile('dsh', PROFILE, anchor, undefined, {})
const layerNames = profile.layers.map((layer) => layer.packageName)
report('profile loads all layers', layerNames.includes(PACKAGE), layerNames.join(', '))

// The user patch layer is free to hold other rows (an MCP client, a theme, …).
// What must NOT happen is that it inserts this bundle a second time: the bundle
// already contributes the row, and a duplicate id is a composition error.
const userInserted = (profile.patches ?? []).flatMap((patch) => patch.insert ?? [])
report('user patch layer does not duplicate the row', !userInserted.some((entry) => entry.id === PACKAGE), JSON.stringify(userInserted.map((entry) => entry.id)))

console.log(problems.length === 0 ? '\nprofile wiring OK' : '\nFAILED: ' + problems.join('; '))
if (problems.length > 0) process.exitCode = 1
