#!/usr/bin/env node
/**
 * Launcher that clears ELECTRON_RUN_AS_NODE before exec'ing Electron.
 *
 * That variable is set by DeepSeek Harness in shared shells; if it leaks into
 * Electron, the binary silently degrades to plain Node and no window appears.
 */
import { spawn } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bin = resolve(ROOT, 'node_modules', 'electron', 'cli.js')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(process.execPath, [bin, ...process.argv.slice(2)], {
  cwd: ROOT,
  env,
  stdio: 'inherit',
})
child.on('exit', (code) => process.exit(code ?? 0))
