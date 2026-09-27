// What both bridge smokes share: a real daemon in a scratch data dir, the
// built web app served as its hosting serves it, and an agent's MCP tool call
// over the daemon's socket. Each browser's smoke drives its own browser.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const EXTENSION_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const MCP_SERVER_DIR = resolve(EXTENSION_DIR, '../../packages/mcp-server')
const WEB_DIR = resolve(EXTENSION_DIR, '../web')
const CLI = [process.execPath, '--import', 'tsx/esm', join(MCP_SERVER_DIR, 'src/cli/index.ts')]

/** A scratch dir, a data dir inside it, and a tally of checks. */
export function createSmoke(name) {
  const scratch = mkdtempSync(join(tmpdir(), `whiteboard-${name}-`))
  let failed = false
  return {
    scratch,
    dataDir: join(scratch, 'data'),
    check(ok, what, detail) {
      console[ok ? 'log' : 'error'](`  ${ok ? 'pass' : 'FAIL'}  ${what}${ok ? '' : ` — ${detail}`}`)
      if (!ok) failed = true
    },
    finish() {
      rmSync(scratch, { recursive: true, force: true })
      if (failed) {
        console.error(`[${name}] FAIL`)
        process.exit(1)
      }
      console.log(`[${name}] ok`)
    },
  }
}

export function whiteboard(args) {
  const run = spawnSync(CLI[0], [...CLI.slice(1), ...args], {
    cwd: MCP_SERVER_DIR,
    encoding: 'utf8',
  })
  if (run.status !== 0) throw new Error(`whiteboard ${args.join(' ')} failed: ${run.stderr}`)
  return JSON.parse(run.stdout)
}

/** Builds the extension and the web app, as each smoke loads them. */
export function buildAll() {
  const build = spawnSync('pnpm', ['build'], { cwd: EXTENSION_DIR, stdio: 'inherit' })
  if (build.status !== 0) throw new Error('the extension did not build')
  const webBuild = spawnSync('pnpm', ['exec', 'vite', 'build'], { cwd: WEB_DIR, stdio: 'inherit' })
  if (webBuild.status !== 0) throw new Error('the web app did not build')
}

/** Starts the daemon and answers it with the record it wrote. */
export function startDaemon(dataDir) {
  const daemon = spawn(
    CLI[0],
    [...CLI.slice(1), 'daemon', 'run', '--json', `--data-dir=${dataDir}`, '--no-open'],
    { cwd: MCP_SERVER_DIR, stdio: ['ignore', 'pipe', 'inherit'] },
  )
  return new Promise((ready, fail) => {
    daemon.stdout.once('data', () =>
      ready({ daemon, record: JSON.parse(readFileSync(join(dataDir, 'daemon.json'), 'utf8')) }),
    )
    daemon.once('exit', (code) =>
      fail(new Error(`the daemon exited (${code}) before it was ready`)),
    )
  })
}

export async function stopDaemon(daemon) {
  if (daemon === undefined) return
  daemon.kill('SIGTERM')
  await new Promise((exited) => (daemon.exitCode === null ? daemon.once('exit', exited) : exited()))
}

/** One MCP tool call to the daemon, over its socket, as an agent makes it. */
export function callTool(record, name, args) {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  })
  return new Promise((done, fail) => {
    const req = request(
      {
        socketPath: record.socketPath,
        path: '/mcp',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${record.token}`,
        },
      },
      (res) => {
        let text = ''
        res.on('data', (piece) => {
          text += piece
        })
        res.on('end', () => done(JSON.parse(text).result?.structuredContent))
      },
    )
    req.on('error', fail)
    req.end(body)
  })
}

/** An agent's note on the daemon, for the web app to open; answers its id. */
export async function seedNote(record) {
  const seeded = await callTool(record, 'wb_workspace_edit', {
    workspaceId: 'default',
    createWorkspace: true,
    ops: [
      {
        op: 'document.create',
        path: 'bridge-note',
        kind: 'markdown',
        name: 'Bridge note',
        markdown: '# Bridge note\n\nwritten by an agent',
      },
    ],
  })
  return seeded?.results?.[0]?.documentId
}

/** Polls the daemon until the note holds `text`; answers what it last held. */
export async function daemonNoteContains(record, documentId, text) {
  let content = ''
  for (let i = 0; i < 40 && !content.includes(text); i += 1) {
    await new Promise((later) => setTimeout(later, 250))
    const got = await callTool(record, 'wb_document_get', {
      workspaceId: 'default',
      documentIds: [documentId],
    })
    content = got?.documents?.[0]?.content ?? ''
  }
  return content
}

/** An agent edits the note while the page has it open. */
export function agentEdits(record, documentId) {
  return callTool(record, 'wb_body_edit', {
    workspaceId: 'default',
    documentId,
    mode: 'apply',
    ops: [
      {
        id: 'agent-edit',
        op: 'body.replace',
        anchor: { kind: 'text', start: 0, end: 13, quote: { exact: '# Bridge note' } },
        assumed: '# Bridge note',
        text: '# Edited by an agent',
      },
    ],
  })
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
}

/** Serves `html`, or the built web app with its hosting's single-page fallback. */
export async function serve(html) {
  const root = join(WEB_DIR, 'dist')
  const server = createServer((req, res) => {
    if (html !== undefined) return res.writeHead(200, { 'content-type': 'text/html' }).end(html)
    const path = join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname))
    const file =
      path.startsWith(root) && existsSync(path) && statSync(path).isFile()
        ? path
        : join(root, 'index.html')
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(readFileSync(file))
  })
  await new Promise((listening) => server.listen(0, '127.0.0.1', listening))
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() }
}
