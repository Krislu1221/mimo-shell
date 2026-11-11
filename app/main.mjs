/**
 * Mimo Shell — desktop shell for the mimo serve engine.
 *
 * Same shape as DeepSeek Harness: a native window in front of the same engine.
 * The whole web layer runs inside this process (Electron bundles Node), so the
 * packaged app needs no runtime and no separate server command.
 *
 * Lifecycle, in order:
 *   1. resolve the MiMo binary and the built frontend
 *   2. read the API key from the macOS keychain (never from disk)
 *   3. start `mimo serve` unless one is already listening
 *   4. start the gateway in-process and point the window at it
 *   5. on quit, stop only what this process started
 */

import { app, BrowserWindow, Menu, shell, dialog } from 'electron'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'

import { startGateway } from '../server/gateway.mjs'
import { startFeishuBridge } from '../server/feishu-bridge.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
// Same relative location in both layouts: the packaged app copies web/dist
// alongside app/ and server/ inside Contents/Resources/app.
const DIST = resolve(HERE, '..', 'web', 'dist')

const MIMO_BIN = process.env.MIMO_BIN || join(app.getPath('home'), '.mimocode', 'bin', 'mimo')
const MIMO_PORT = Number(process.env.MIMO_PORT || 4096)
const MIMO_HOST = '127.0.0.1'

/*
 * Title bar: hiddenInset by default — one integrated window like DSH.
 * No chrome strip across the top; traffic lights float over the sidebar.
 * Set MIMO_TITLEBAR=default to force the old framed title bar back.
 */
const INSET_TITLEBAR = process.env.MIMO_TITLEBAR !== 'default'
const ENGINE_KEY = 'mimo-coding-plan'
const ENGINE_CWD = process.env.MIMO_WORKDIR || app.getPath('home')

/** @type {import('electron').BrowserWindow|null} */
let win = null
/** @type {import('node:child_process').ChildProcess|null} */
let engine = null
let gateway = null
/** Only stop the engine if this process is the one that started it. */
let weStartedEngine = false

/* ------------------------------------------------------------------ utils */

const log = (...a) => console.log('[mimo]', ...a)

function portListening(port) {
  return new Promise((ok) => {
    const req = http.get(
      { host: MIMO_HOST, port, path: '/global/health', timeout: 1200 },
      (res) => {
        res.resume()
        ok(true)
      },
    )
    req.on('error', () => ok(false))
    req.on('timeout', () => {
      req.destroy()
      ok(false)
    })
  })
}

/**
 * Read the API key from the macOS keychain.
 *
 * The stored item has no account attribute, so `-a "$USER"` matches nothing —
 * query by service only. Returns '' rather than throwing when absent; the app
 * stays usable, the Coding Plan models just are not available.
 */
function readKeychainKey() {
  for (const args of [
    ['find-generic-password', '-s', ENGINE_KEY, '-w'],
    ['find-generic-password', '-a', process.env.USER || '', '-s', ENGINE_KEY, '-w'],
  ]) {
    try {
      const out = execFileSync('/usr/bin/security', args, {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      if (out) return out
    } catch {
      /* not found, or the keychain is locked — try the next form */
    }
  }
  return ''
}

/* ----------------------------------------------------------------- engine */

async function ensureEngine() {
  if (await portListening(MIMO_PORT)) {
    log(`复用已在 ${MIMO_PORT} 运行的引擎`)
    return true
  }
  if (!existsSync(MIMO_BIN)) return false

  const key = readKeychainKey()
  const env = { ...process.env }
  if (key) {
    env.MIMO_API_KEY = key
    env.MIMO_BASE_URL = 'https://token-plan-cn.xiaomimimo.com/v1'
    log(`已从钥匙链注入 MIMO_API_KEY（${key.slice(0, 3)}*** ${key.length} 字符）`)
  } else {
    log('钥匙链里没有 MiMo key，Coding Plan 模型将不可用')
  }

  engine = spawn(MIMO_BIN, ['serve', '--port', String(MIMO_PORT), '--hostname', MIMO_HOST], {
    cwd: ENGINE_CWD,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  })
  weStartedEngine = true

  engine.stdout.on('data', (d) => process.stdout.write(`[mimo] ${d}`))
  engine.stderr.on('data', (d) => {
    const s = String(d)
    // The binary logs a huge minified chunk on some paths; keep only the tail.
    if (s.includes('error:') || s.includes('Warning:')) process.stderr.write(`[mimo] ${s.slice(-400)}\n`)
  })
  engine.on('error', (e) => log('引擎启动失败：', e.message))
  engine.on('exit', (code) => {
    log('引擎退出，code =', code)
    engine = null
    weStartedEngine = false
  })

  for (let i = 0; i < 80; i++) {
    if (await portListening(MIMO_PORT)) {
      log(`引擎就绪：http://${MIMO_HOST}:${MIMO_PORT}`)
      return true
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

function stopEngine() {
  if (engine && !engine.killed) {
    log('停止引擎')
    engine.kill('SIGTERM')
    setTimeout(() => {
      if (engine && !engine.killed) engine.kill('SIGKILL')
    }, 2000)
  }
  engine = null
  weStartedEngine = false
}

function mimoVersion() {
  try {
    return execFileSync(MIMO_BIN, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

/** Restart only the engine this process owns (never a pre-existing one). */
async function restartEngine() {
  if (!weStartedEngine) {
    // Something else owns :4096 — we cannot safely bounce it. Still fine to
    // tell the UI the config is on disk; the operator restarts the engine.
    log('引擎不是本进程拉起的，跳过重启')
    return false
  }
  stopEngine()
  // Give the port a beat to free before ensureEngine tries to bind again.
  await new Promise((r) => setTimeout(r, 400))
  return ensureEngine()
}

/* ------------------------------------------------------------------ window */

async function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    title: 'Mimo Shell',
    backgroundColor: '#1a1814', // paper dark base (matches CSS --bg)
    titleBarStyle: INSET_TITLEBAR ? 'hiddenInset' : 'default',
    ...(INSET_TITLEBAR ? { trafficLightPosition: { x: 16, y: 16 } } : {}),
    ...(INSET_TITLEBAR ? { titleBarOverlay: false } : {}),
    webPreferences: {
      // The frontend talks to its own origin over plain fetch/EventSource, so
      // no preload bridge is needed — and none is granted.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  // External links belong in the real browser, never inside the shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  log(`标题栏模式：${INSET_TITLEBAR ? 'inset（需前端声明拖拽区）' : 'default（原生标题栏）'}`)
  const engineOk = await ensureEngine()
  if (!engineOk && !existsSync(MIMO_BIN)) {
    dialog.showErrorBox(
      '找不到 mimo 引擎',
      `没有在 ${MIMO_BIN} 找到 mimo 可执行文件。\n\n请先安装：\n` +
        `  curl -fsSL https://mimo.xiaomi.com/install | bash -s -- --no-modify-path\n`,
    )
  }

  gateway = await startGateway({
    upstream: `http://${MIMO_HOST}:${MIMO_PORT}`,
    root: DIST,
    port: 0, // OS-assigned: the app window is the interface, no fixed port needed
    host: MIMO_HOST,
    meta: () => ({
      enginePort: MIMO_PORT,
      engineHost: MIMO_HOST,
      workdir: ENGINE_CWD,
      version: mimoVersion(),
      weStartedEngine,
      titlebar: INSET_TITLEBAR ? 'inset' : 'default',
    }),
    restartEngine,
  })
  log('网关：', gateway.url)

  // Feishu bot long-connection (optional). Failures are non-fatal.
  startFeishuBridge().then((r) => {
    if (r?.ok) log('飞书机器人长连接已启动')
    else if (r?.reason !== 'not_configured') log('飞书桥未启动：', r?.reason || r)
  }).catch((e) => log('飞书桥异常：', e.message))

  // The flag rides on the page URL: it needs no preload bridge, and the
  // frontend's API calls are same-origin regardless of the query string.
  await win.loadURL(INSET_TITLEBAR ? gateway.url : `${gateway.url}/?titlebar=default`)
  win.on('closed', () => {
    win = null
  })
}

/* -------------------------------------------------------------------- menu */

function buildMenu() {
  const isMac = process.platform === 'darwin'
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '会话',
      submenu: [
        {
          label: '新建会话',
          accelerator: 'CmdOrCtrl+N',
          click: () => win?.webContents.executeJavaScript('window.dispatchEvent(new Event("mimo:new"))'),
        },
        {
          label: '设置…',
          accelerator: 'CmdOrCtrl+,',
          click: () => win?.webContents.executeJavaScript('window.dispatchEvent(new Event("mimo:settings"))'),
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'editMenu' },
    {
      label: '视图',
      submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    {
      label: '窗口',
      submenu: isMac ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] : [{ role: 'minimize' }, { role: 'close' }],
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'MiMo Code 文档',
          click: () => shell.openExternal('https://github.com/XiaomiMiMo/MiMo-Code'),
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/* --------------------------------------------------------------- lifecycle */

// One instance only: a second launch should focus the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    buildMenu()
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    stopEngine()
    gateway?.close()
  })
}
