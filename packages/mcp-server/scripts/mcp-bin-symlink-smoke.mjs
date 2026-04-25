#!/usr/bin/env node
// Smoke test: install the packed tarball into a tmp dir and start the MCP server
// through node_modules/.bin/whiteboard-mcp (a symlink). This is how `npx`,
// `claude mcp add ... -- npx`, and Codex's `command = "npx"` invoke the binary.
//
// Catches the regression where `process.argv[1] === fileURLToPath(import.meta.url)`
// silently returns false through symlinks and main() never runs.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkgDir = resolve(__dirname, '..')
const distEntry = join(pkgDir, 'dist/server/mcp/index.js')
if (!existsSync(distEntry)) {
  console.error('[bin-smoke] FAIL: dist not found at', distEntry, '— run pnpm build first')
  process.exit(1)
}

const workDir = mkdtempSync(join(tmpdir(), 'whiteboard-bin-smoke-'))
let exitCode = 1

function cleanup() {
  try {
    rmSync(workDir, { recursive: true, force: true })
  } catch {}
}

try {
  console.log('[bin-smoke] pack into', workDir)
  const packResult = spawnSync('npm', ['pack', '--pack-destination', workDir, '--silent'], {
    cwd: pkgDir,
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf-8',
  })
  if (packResult.status !== 0) throw new Error(`npm pack failed: ${packResult.status}`)
  const tarball = packResult.stdout.trim().split('\n').pop()
  if (!tarball) throw new Error('npm pack produced no tarball name')
  const tarballPath = join(workDir, tarball)

  console.log('[bin-smoke] install', tarball)
  const npmInit = spawnSync('npm', ['init', '-y'], { cwd: workDir, stdio: 'ignore' })
  if (npmInit.status !== 0) throw new Error(`npm init failed: ${npmInit.status}`)
  const installResult = spawnSync('npm', ['install', '--no-fund', '--no-audit', '--silent', tarballPath], {
    cwd: workDir,
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  if (installResult.status !== 0) throw new Error(`npm install failed: ${installResult.status}`)

  const binPath = join(workDir, 'node_modules/.bin/whiteboard-mcp')
  if (!existsSync(binPath)) throw new Error(`bin not present at ${binPath}`)

  console.log('[bin-smoke] spawn via .bin symlink')
  const child = spawn(binPath, [], { stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', (d) => { out += d.toString() })
  child.stderr.on('data', (d) => { err += d.toString() })

  const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n')
  await new Promise((r) => setTimeout(r, 1000))
  send({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bin-smoke', version: '1' } },
  })
  await new Promise((r) => setTimeout(r, 4000))
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  await new Promise((r) => setTimeout(r, 200))
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  await new Promise((r) => setTimeout(r, 3000))
  child.kill()
  await new Promise((r) => setTimeout(r, 200))

  const responses = out
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)
  const init = responses.find((r) => r.id === 1)
  const list = responses.find((r) => r.id === 2)

  if (!init?.result?.serverInfo) {
    console.error('[bin-smoke] FAIL: no initialize response')
    if (err) console.error('stderr:', err.slice(0, 500))
    throw new Error('no initialize response')
  }
  console.log(`[bin-smoke] init OK (${init.result.serverInfo.name} ${init.result.serverInfo.version})`)

  const tools = list?.result?.tools ?? []
  if (tools.length === 0) {
    console.error('[bin-smoke] FAIL: empty tools list')
    throw new Error('empty tools list')
  }
  console.log(`[bin-smoke] tools/list OK (${tools.length} tools)`)
  console.log('[bin-smoke] ALL OK')
  exitCode = 0
} catch (e) {
  console.error('[bin-smoke] FAIL:', e.message)
} finally {
  cleanup()
  process.exit(exitCode)
}
