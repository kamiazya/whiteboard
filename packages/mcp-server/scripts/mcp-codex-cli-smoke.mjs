#!/usr/bin/env node
// Launches Codex CLI as a subprocess and verifies that the Excalidraw MCP
// server behaves correctly for a zero-context Codex client.
//
// Purpose:
// Ensure the Codex subprocess can discover the repo-local Excalidraw MCP and
// complete canvas_create -> annotate -> checkpoint_save. The final response is
// constrained by JSON Schema, and the resulting files under WHITEBOARD_DATA_DIR
// are also verified.
//
// Expected behavior:
// 1. codex returns a JSON object { slug, canvasId, checkpointId }
// 2. tmp data dir contains {sessionId}/{slug}.loro
// 3. tmp data dir contains .checkpoints/{checkpointId}.loro
//
// Notes:
// - This consumes OpenAI API quota, so it does not run in CI. Manual use:
//     node scripts/mcp-codex-cli-smoke.mjs
// - When run inside the Codex sandbox it may fail because it cannot write to
//   ~/.codex/sessions. If that happens, run it outside the sandbox.
// - Set KEEP_SMOKE_TMP=1 to keep the temp directory instead of deleting it.

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const repoRoot = resolve(root, '../..')
const keepTmp = process.env.KEEP_SMOKE_TMP === '1'
const tmpRoot = mkdtempSync(join(tmpdir(), 'whiteboard-codex-smoke-'))
const tmpDataDir = join(tmpRoot, 'data')
const schemaPath = join(tmpRoot, 'result.schema.json')
const outputPath = join(tmpRoot, 'last.json')

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['slug', 'canvasId', 'checkpointId'],
  properties: {
    slug: { type: 'string', const: 'codex-strict-smoke' },
    canvasId: {
      type: 'string',
      pattern: '^[A-Za-z0-9_-]+/codex-strict-smoke$',
    },
    checkpointId: {
      type: 'string',
      pattern: '^[A-Za-z0-9_-]{18}$',
    },
  },
}
writeFileSync(schemaPath, JSON.stringify(schema))

const prompt = [
  'Use the whiteboard MCP server.',
  'Create a canvas with slug "codex-strict-smoke", add one rectangle annotation at absolute target {x:10,y:10} with width 40 and height 20, then save a checkpoint for that canvas.',
  'Return a JSON object with slug, canvasId, and checkpointId only.',
].join(' ')

const configOverride = [
  'mcp_servers.whiteboard={',
  'enabled=true,',
  'transport="stdio",',
  'command="node",',
  `args=["${join(root, 'scripts/mcp-dev-launch.mjs')}"],`,
  `env={WHITEBOARD_DATA_DIR="${tmpDataDir}",WHITEBOARD_DEV="1"}`,
  '}',
].join('')

const args = [
  'exec',
  '--ephemeral',
  '--skip-git-repo-check',
  '-C', repoRoot,
  '-s', 'read-only',
  '--output-schema', schemaPath,
  '-o', outputPath,
  '-c', configOverride,
  prompt,
]

const child = spawn('codex', args, {
  cwd: repoRoot,
  stdio: ['ignore', 'pipe', 'pipe'],
})

let stdout = ''
let stderr = ''
child.stdout.on('data', (chunk) => {
  stdout += chunk.toString()
})
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString()
})

const killTimer = setTimeout(() => {
  child.kill('SIGTERM')
}, 180_000)

function cleanup(keep = keepTmp) {
  if (!keep) {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
}

function fail(message) {
  console.error(`[codex-smoke] FAIL: ${message}`)
  if (stdout.trim()) {
    console.error('--- stdout ---')
    console.error(stdout)
  }
  if (stderr.trim()) {
    console.error('--- stderr ---')
    console.error(stderr)
  }
  console.error(`[codex-smoke] tmpDir=${tmpRoot}`)
  cleanup(true)
  process.exit(1)
}

child.on('exit', (code) => {
  clearTimeout(killTimer)
  if (code !== 0) {
    fail(`codex exited with ${code}`)
  }
  if (!existsSync(outputPath)) {
    fail(`missing output file ${outputPath}`)
  }

  let output
  try {
    output = JSON.parse(readFileSync(outputPath, 'utf8'))
  } catch (error) {
    fail(`invalid JSON output (${error instanceof Error ? error.message : 'unknown error'})`)
  }

  const [sessionId, slug] = String(output.canvasId).split('/')
  const canvasPath = join(tmpDataDir, sessionId, `${slug}.loro`)
  const checkpointPath = join(tmpDataDir, '.checkpoints', `${output.checkpointId}.loro`)
  const canvasExists = existsSync(canvasPath)
  const checkpointExists = existsSync(checkpointPath)
  const canvasSize = canvasExists ? statSync(canvasPath).size : 0
  const checkpointSize = checkpointExists ? statSync(checkpointPath).size : 0

  if (!canvasExists || canvasSize === 0) {
    fail(`canvas file missing or empty: ${canvasPath}`)
  }
  if (!checkpointExists || checkpointSize === 0) {
    fail(`checkpoint file missing or empty: ${checkpointPath}`)
  }

  console.log(
    JSON.stringify({
      ...output,
      sessionId,
      dataDir: tmpDataDir,
      canvasPath,
      canvasSize,
      checkpointPath,
      checkpointSize,
      keptTmpDir: keepTmp,
    }),
  )
  cleanup()
  process.exit(0)
})
