#!/usr/bin/env node
/**
 * CLI entry point for the gateway. The Electron app calls startGateway()
 * directly and does not use this file.
 */

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { startGateway } from './gateway.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = resolve(HERE, '..', 'web', 'dist')

const upstream = process.env.MIMO_UPSTREAM || 'http://127.0.0.1:4096'
const port = Number(process.env.PORT || 5178)
const host = process.env.HOST || '127.0.0.1'
const token = process.env.MIMO_WEBUI_TOKEN || ''

const gw = await startGateway({ upstream, root: DIST, port, host, token })

process.stdout.write(
  `\n  MiMo Web UI\n` +
  `  ────────────────────────────────────────\n` +
  `  本机访问:   ${gw.url}\n` +
  `  上游 MiMo:  ${upstream}\n` +
  (token ? `  访问令牌:   已启用\n` : `  访问令牌:   未启用（仅监听 ${host}）\n`) +
  `\n`,
)

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => gw.close().then(() => process.exit(0)))
}
