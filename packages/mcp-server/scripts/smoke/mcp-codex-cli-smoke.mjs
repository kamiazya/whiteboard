#!/usr/bin/env node
// Launches Codex CLI as a subprocess and verifies that the Excalidraw MCP
// server behaves correctly for a zero-context Codex client.
//
// Purpose:
// Ensure the Codex subprocess can discover the repo-local Excalidraw MCP and
// complete wb_document_create -> wb_node_patch -> wb_version_save. The final response is
// constrained by JSON Schema, and the resulting files under WHITEBOARD_DATA_DIR
// are also verified.
//
// Expected behavior:
// 1. codex returns a JSON object { path, documentId, versionId }
// 2. tmp data dir contains a blob for the canvas (under blobs/{ws}/canvas/)
//
// Notes:
// - This consumes OpenAI API quota, so it does not run in CI. Manual use:
//     node scripts/smoke/mcp-codex-cli-smoke.mjs
// - When run inside the Codex sandbox it may fail because it cannot write to
//   ~/.codex/sessions. If that happens, run it outside the sandbox.
// - Set KEEP_SMOKE_TMP=1 to keep the temp directory instead of deleting it.
// - CI images ship without the codex CLI installed (by design — this smoke
//   needs a local install and live API quota), so the release-gate scripts
//   that chain into this one (smoke:distribution:packaged, test:e2e:distribution)
//   would otherwise always fail with `spawn codex ENOENT`. Skip cleanly instead.

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isCliAvailable } from './lib/cli-available.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '../..')
const repoRoot = resolve(root, '../..')

if (!isCliAvailable('codex')) {
  console.log(
    '[codex-smoke] SKIP: codex CLI not found on PATH — this smoke needs a local codex install and API quota (manual/dev-machine check)',
  )
  process.exit(0)
}

const keepTmp = process.env.KEEP_SMOKE_TMP === '1'
const tmpRoot = mkdtempSync(join(tmpdir(), 'whiteboard-codex-smoke-'))
const tmpDataDir = join(tmpRoot, 'data')
const schemaPath = join(tmpRoot, 'result.schema.json')
const outputPath = join(tmpRoot, 'last.json')

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['path', 'documentId', 'versionId'],
  properties: {
    path: { type: 'string', const: 'codex-strict-smoke' },
    documentId: {
      type: 'string',
      pattern: '^[A-Za-z0-9_-]+/codex-strict-smoke$',
    },
    versionId: {
      type: 'string',
      minLength: 1,
    },
  },
}
writeFileSync(schemaPath, JSON.stringify(schema))

const prompt = [
  'Use the whiteboard MCP server.',
  'Create a canvas with path "codex-strict-smoke", add one rectangle annotation at absolute target {x:10,y:10} with width 40 and height 20, then call wb_version_save with label "codex-strict-smoke" for that canvas.',
  'Return a JSON object with path, documentId, and versionId only.',
].join(' ')

const configOverride = [
  'mcp_servers.whiteboard={',
  'enabled=true,',
  'transport="stdio",',
  'command="node",',
  `args=["${join(root, 'scripts/dev/mcp-dev-launch.mjs')}"],`,
  `env={WHITEBOARD_DATA_DIR="${tmpDataDir}",WHITEBOARD_DEV="1",WHITEBOARD_NO_WATCH="1"}`,
  '}',
].join('')

const args = [
  'exec',
  '--ephemeral',
  '--skip-git-repo-check',
  '-C',
  repoRoot,
  '-s',
  'read-only',
  '--output-schema',
  schemaPath,
  '-o',
  outputPath,
  '-c',
  configOverride,
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

  const [sessionId] = String(output.documentId).split('/')
  // A document's blob lands under blobs/{workspaceId}/document/{id}.loro now
  // that the metadata store owns the path -> documentId mapping. We only
  // verify that *some* blob exists for the workspace; the exact filename is a
  // generated id.
  const blobsDir = join(tmpDataDir, 'blobs', sessionId, 'document')
  const blobsExist = existsSync(blobsDir)

  if (!blobsExist) {
    fail(`document blob dir missing: ${blobsDir}`)
  }

  console.log(
    JSON.stringify({
      ...output,
      sessionId,
      dataDir: tmpDataDir,
      blobsDir,
      keptTmpDir: keepTmp,
    }),
  )
  cleanup()
  process.exit(0)
})
