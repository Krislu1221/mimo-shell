#!/usr/bin/env node
/**
 * Build the macOS bundle with @electron/packager.
 *
 * Hand-assembling Electron.app by hand (renaming the bundle, rewriting
 * Info.plist, ad-hoc signing) produces nested signatures macOS rejects at
 * launch:
 *
 *   ERROR:electron/shell/common/mac/codesign_util.cc:79]
 *     task_name_for_pid: (os/kern) failure (5)
 *
 * It only shows up when LaunchServices starts the app — running the binary
 * directly still works, which makes it easy to misdiagnose. The official
 * packager renames the framework and helpers consistently and re-signs them.
 */

import { packager } from '@electron/packager'
import { existsSync, rmSync, mkdirSync, readdirSync, renameSync, chmodSync, cpSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve, basename } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/*
 * Build straight into ~/Applications.
 *
 * Launchpad indexes every .app bundle it can find under the user's folders —
 * not just /Applications. Leaving the build output inside the project put a
 * second, stale-icon copy in Launchpad on every repackage, which is how three
 * copies of "Mimo Shell" ended up sitting next to each other.
 */
const BUILD_DIR = join(tmpdir(), 'mimocode-build')

if (!existsSync(join(ROOT, 'web', 'dist', 'index.html'))) {
  console.log('→ 构建前端…')
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' })
}
// Where the finished app is installed. Override with MIMO_INSTALL_DIR.
const INSTALL_DIR = process.env.MIMO_INSTALL_DIR || '/Applications'

// Build into a scratch directory, never into an Applications folder.
// `rmSync(dir, {recursive:true})` deletes the folder itself — pointing that at
// ~/Applications or /Applications would wipe every other app the user has.

rmSync(BUILD_DIR, { recursive: true, force: true })
mkdirSync(BUILD_DIR, { recursive: true })

console.log('→ 打包…')
const paths = await packager({
  dir: ROOT,
  out: BUILD_DIR,
  platform: 'darwin',
  arch: process.arch === 'arm64' ? 'arm64' : 'x64',
  appVersion: '0.1.0',
  appName: 'Mimo Shell',
  appBundleId: 'com.mimo.shell',
  appCategoryType: 'public.app-category.developer-tools',
  // No extension: packager appends the per-platform one (.icns on macOS).
  icon: existsSync(join(ROOT, 'build', 'icon.icns')) ? join(ROOT, 'build', 'icon') : undefined,
  // Ship only what the main process loads: node built-ins, the gateway module,
  // and the built frontend. There are no runtime dependencies at all, so the
  // whole node_modules tree goes.
  //
  // NOTE: @electron/packager matches ignore patterns against paths relative to
  // the app dir, which always start with '/'. Patterns without it silently
  // match nothing — that mistake packs the entire node_modules tree (1.2 GB).
  ignore: [
    /^\/node_modules/,
    /^\/dist/,
    /^\/release/,
    /^\/\.git/,
    /^\/build\/icon\.iconset/,
    /^\/\.env$/,
    /\/\.DS_Store$/,
    /(^|\/)(verify|verify_models|verify_error)\.py$/,
    /^\/\.github/,
  ],
  asar: false, // the payload is a few files; an asar buys nothing
  overwrite: true,
  derefSymlinks: true,
})

// @electron/packager v20 returns the *outer* directory (…-darwin-arm64), not the
// bundle inside it. Resolve the real .app instead of trusting the return value.
function resolveBundle(p) {
  if (existsSync(join(p, 'Contents', 'Info.plist'))) return p
  for (const entry of readdirSync(p)) {
    if (entry.endsWith('.app') && existsSync(join(p, entry, 'Contents', 'Info.plist'))) {
      return join(p, entry)
    }
  }
  throw new Error(`在 ${p} 里找不到 .app bundle`)
}

const app = resolveBundle(paths[0])
// Ad-hoc signature so Gatekeeper treats it as a local build rather than a
// downloaded, damaged one. Replace with a Developer ID to ship it anywhere.
// Sign nested code first, then the bundle. `--deep` is deprecated and refuses
// to run on some toolchains; inner-first ordering is what Apple documents.
try {
  const inner = execFileSync('find', [app, '-type', 'd', '-name', '*.app'], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean).reverse()
  for (const nested of inner) {
    execFileSync('codesign', ['--force', '--sign', '-', nested], { stdio: 'ignore' })
  }
  execFileSync('codesign', ['--force', '--sign', '-', app], { stdio: 'ignore' })
  console.log('  ✓ 已临时签名')
} catch (e) {
  console.log('  ! 签名失败（首次启动需右键→打开）：', e.message.split('\n')[0])
}

/* ------------------------------------------------------------------ *
 * Post-process: naming, icon, signature.
 *
 * @electron/packager names the bundle after package.json's `name` and ignores
 * `appName` for CFBundleName, and it wants an extension-less icon path that
 * still does not resolve for .icns. Both are fixed here, after the fact.
 * ------------------------------------------------------------------ */

function renameBundle(appPath, from, to) {
  const c = (p) => join(p, 'Contents')
  // executable inside the main bundle
  const binOld = join(c(appPath), 'MacOS', from)
  const binNew = join(c(appPath), 'MacOS', to)
  if (existsSync(binOld)) {
    rmSync(binNew, { force: true })
    renameSync(binOld, binNew)
    chmodSync(binNew, 0o755)
  }
  // framework + helper apps, using the same scheme packager applied
  const fwOld = join(c(appPath), 'Frameworks', `${from} Framework.framework`)
  const fwNew = join(c(appPath), 'Frameworks', `${to} Framework.framework`)
  if (existsSync(fwOld)) {
    rmSync(fwNew, { recursive: true, force: true })
    renameSync(fwOld, fwNew)
  }
  for (const suffix of ['Helper', 'Helper (Renderer)', 'Helper (GPU)', 'Helper (Plugin)']) {
    const hOld = join(c(appPath), 'Frameworks', `${from} ${suffix}.app`)
    const hNew = join(c(appPath), 'Frameworks', `${to} ${suffix}.app`)
    if (existsSync(hOld)) {
      rmSync(hNew, { recursive: true, force: true })
      renameSync(hOld, hNew)
    }
  }
  // the bundle directory itself
  const renamed = join(dirname(appPath), `${to}.app`)
  rmSync(renamed, { recursive: true, force: true })
  renameSync(appPath, renamed)
  return renamed
}

/** Re-sign after mutating anything inside the bundle. */
function resign(appPath) {
  // Inner-first, never `--deep`: codesign's deep flag is unreliable for nested
  // bundles and produced "Unable to find helper app" at launch.
  const sh = (args) => execFileSync('/bin/sh', ['-c', args + ' 2>/dev/null || true'], { stdio: 'ignore' })
  const q = `'${appPath}'`
  sh(`find ${q} -name '*.dylib' -type f -print0 | while IFS= read -r -d '' f; do codesign --force --sign - --timestamp=none "$f"; done`)
  sh(`find ${q} -name '*.framework' -type d -print0 | while IFS= read -r -d '' f; do codesign --force --sign - --timestamp=none "$f"; done`)
  // deepest first so containers are sealed after their contents
  sh(
    `find ${q} -type d -name '*.app' ! -path ${q} -print0 | tr '\\0' '\\n' | ` +
      `awk '{print gsub("/", "/"), $0}' | sort -rn | cut -d' ' -f2- | ` +
      `while read -r n; do codesign --force --sign - --timestamp=none "$n"; done`,
  )
  execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', appPath], { stdio: 'ignore' })
}

function postProcess(appPath) {
  const TO = 'Mimo Shell'
  const plist = join(appPath, 'Contents', 'Info.plist')

  console.log('→ 设置显示名与图标…')
  const set = (k, v) => {
    try {
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${k} ${v}`, plist], { stdio: 'ignore' })
    } catch {
      try {
        execFileSync('/usr/libexec/PlistBuddy', ['-c', `Delete :${k}`, plist], { stdio: 'ignore' })
      } catch { /* absent */ }
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${k} string ${v}`, plist], { stdio: 'ignore' })
    }
  }
  // ONLY the display name changes.
  //
  // CFBundleName must stay as packager set it. Electron resolves its helper
  // bundles by that name (`<CFBundleName> Helper.app` inside Contents/Frameworks),
  // so renaming it — even together with the helpers — yields
  //   FATAL: Unable to find helper app
  // and no window. Finder, the Dock and Spotlight all read CFBundleDisplayName,
  // so the user still sees "Mimo Shell".
  set('CFBundleDisplayName', `"${TO}"`)
  set('CFBundleIconFile', 'icon.icns')
  for (const k of ['ElectronTeamID', 'ElectronMacConfig']) {
    try {
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Delete :${k}`, plist], { stdio: 'ignore' })
    } catch { /* absent */ }
  }

  const icns = join(ROOT, 'build', 'icon.icns')
  if (existsSync(icns)) {
    cpSync(icns, join(appPath, 'Contents', 'Resources', 'icon.icns'))
  } else {
    console.log('  ! 没有 build/icon.icns，跳过图标')
  }

  console.log('→ 重新签名…')
  resign(appPath)
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'ignore' })
  return appPath
}

/*
 * The single user-facing entry.
 *
 * An ad-hoc-signed Electron app cannot start through LaunchServices on this
 * machine — Electron's own downloaded Electron.app fails identically with
 * `codesign_util.cc: task_name_for_pid: (os/kern) failure (5)`, so nothing we
 * do causes it, and `security find-identity` reports 0 valid identities so the
 * signature cannot be upgraded either.
 *
 * A plain shell-script app launches fine, so the entry is a wrapper whose
 * executable execs the real binary. Keeping the Electron app *inside* the
 * wrapper's Resources holds Launchpad at exactly one "Mimo Shell": nested
 * bundles are not indexed — the four helper apps inside Contents/Frameworks
 * never appear there either.
 */
function makeEntry(appPath) {
  // /Applications, not ~/Applications: it is the conventional home for an app,
  // and it is reachable no matter which user session launched it. Both are
  // Launchpad-indexed; only one entry exists either way because the Electron
  // payload is nested inside this wrapper.
  const dir = join(INSTALL_DIR, 'Mimo Shell.app')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'Contents', 'MacOS'), { recursive: true })
  mkdirSync(join(dir, 'Contents', 'Resources', 'engine'), { recursive: true })

  writeFileSync(
    join(dir, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Mimo Shell</string>
  <key>CFBundleDisplayName</key><string>Mimo Shell</string>
  <key>CFBundleExecutable</key><string>launch</string>
  <key>CFBundleIdentifier</key><string>com.mimo.shell</string>
  <key>CFBundleIconFile</key><string>icon.icns</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <!-- Marks the bundle as Apple Silicon native. Without it macOS cannot read the
       architecture and shows the "即将结束对 Intel 芯片 App 的支持" notice. -->
  <key>LSRequiresNativeExecution</key><true/>
</dict></plist>
`,
  )

  const execName = execFileSync('/usr/libexec/PlistBuddy', [
    '-c', 'Print :CFBundleExecutable', join(appPath, 'Contents', 'Info.plist'),
  ], { encoding: 'utf8' }).trim()

  // Move, never copy: the payload is ~290 MB.
  renameSync(appPath, join(dir, 'Contents', 'Resources', 'engine', `${execName}.app`))

  // A compiled arm64 binary, not a #!/bin/sh script: macOS reads the bundle's
  // architecture from the main executable's Mach-O header, and a shell script
  // has none — the app then gets flagged as a possible Intel app.
  const csrc = join(ROOT, 'scripts', 'launcher.c')
  const cbin = join(dir, 'Contents', 'MacOS', 'launch')
  execFileSync('/usr/bin/clang', [
    '-arch', 'arm64', '-O2', '-Wall',
    `-DMIMO_ENGINE="${execName}"`,
    '-o', cbin, csrc,
  ], { stdio: 'inherit' })
  chmodSync(cbin, 0o755)

  const icns = join(ROOT, 'build', 'icon.icns')
  if (existsSync(icns)) cpSync(icns, join(dir, 'Contents', 'Resources', 'icon.icns'))

  execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', dir], { stdio: 'ignore' })
  return dir
}

const entry = makeEntry(postProcess(app))

const size = execFileSync('du', ['-sh', entry], { encoding: 'utf8' }).trim().split(/\s+/)[0]
console.log(`\n✓ ${entry}   (${size})`)
console.log(`\n  已装在 ${INSTALL_DIR}，Launchpad 里只有一个「Mimo Shell」，双击即可启动。`)
