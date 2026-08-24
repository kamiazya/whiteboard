#!/usr/bin/env node
// Report open issues whose declared `sources` have changed since the document
// was written. Read-only, and silent when there is nothing to say.
//
//   node .claude/scripts/stale-issues.mjs [--workspace default] [--quiet]
//
// Why this exists: in one session, six issue documents were read, acted on,
// and found already resolved — each costing a measurement to discover. Four of
// them named a file that had since changed or been deleted, so git already
// knew. `generated.at` (OKF v0.2's trust family, ADR-0016) supplies the "since
// when"; `sources` supplies the "what about". Nothing new is stored.
//
// The judgement is deliberately narrow. It reports "what this is about moved",
// never "this is resolved" — a human or agent still re-reads before closing
// anything. It cannot see a fix that landed in a file the issue never named
// (two of the six), and nothing can see a document that was wrong when written.
//
// Exit code is always 0: this is information, not a gate.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectStaleIssues, formatFindings } from './stale-issues-lib.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}
const QUIET = process.argv.includes('--quiet')
const WORKSPACE = arg('workspace', 'default')

function repoRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: SCRIPT_DIR,
    encoding: 'utf-8',
  }).trim()
}

/**
 * `git log --since` reads the AUTHOR date, which a rebase or an imported patch
 * can leave older than when the commit actually landed here. `--since` on the
 * COMMIT date is what "changed after this document was written" means, so the
 * range is filtered on `%cI` instead.
 */
function inspectorFor(root) {
  return (path, sinceIso) => {
    if (!existsSync(join(root, path))) return 'missing'
    const out = execFileSync(
      'git',
      ['log', '--format=%cI', `--since=${sinceIso}`, '--', path],
      { cwd: root, encoding: 'utf-8' },
    ).trim()
    return out === '' ? 'unchanged' : 'changed'
  }
}

async function main() {
  const { deriveDevPort, isMainCheckout } = await import(
    '../../packages/mcp-server/scripts/dev/dev-port-lib.mjs'
  )
  const root = repoRoot()
  const port = deriveDevPort({
    repoRoot: root,
    isMainCheckout: isMainCheckout(root),
    env: process.env,
  })
  const token = process.env.WHITEBOARD_TOKEN ?? 'whiteboard-dev'

  let nextId = 1

  /**
   * SessionStart runs the daemon-ensure hook and this one, and nothing orders
   * them, so a cold start can reach here while the daemon is still binding.
   * Without this the check would be silent on exactly the session that starts
   * the machine's day. Bounded hard: three attempts over a second, and only
   * for a connection that was refused — a daemon that is genuinely absent must
   * not tax every session start.
   */
  async function post(body) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fetch(`http://127.0.0.1:${port}/mcp`, body)
      } catch (error) {
        if (attempt >= 2) throw error
        await new Promise((done) => setTimeout(done, 500))
      }
    }
  }

  async function call(name, args) {
    const res = await post({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    })
    const text = await res.text()
    const payload = JSON.parse(text.startsWith('data:') ? text.slice(text.indexOf('{')) : text)
    if (payload.error) throw new Error(`${name}: ${payload.error.message}`)
    return payload.result?.structuredContent ?? {}
  }

  const listed = await call('wb_document_list', { workspaceId: WORKSPACE })
  const documents = []
  for (const entry of listed.documents ?? []) {
    const got = await call('wb_document_get', {
      workspaceId: WORKSPACE,
      documentId: entry.documentId,
    })
    const front = got.frontmatter ?? {}
    if (front.type !== 'issue') continue
    documents.push({
      documentId: entry.documentId,
      path: entry.path,
      ...(entry.name === undefined ? {} : { name: entry.name }),
      ...(front.generated?.at === undefined ? {} : { generatedAt: front.generated.at }),
      ...(front.generated?.by === undefined ? {} : { generatedBy: front.generated.by }),
      // Unmodelled root keys ride in `facetsRaw` (ADR-0016); a document that
      // predates that, or that never declared any, simply has none.
      sources: front.facetsRaw?.sources ?? [],
    })
  }

  const findings = collectStaleIssues(documents, inspectorFor(root))
  const report = formatFindings(findings, documents.length)
  if (report !== '') process.stdout.write(`${report}\n`)
  else if (!QUIET) {
    const judged = documents.filter((d) => d.sources.length > 0 && d.generatedAt !== undefined)
    process.stdout.write(
      `[stale-issues] nothing to report — ${judged.length} of ${documents.length} issue(s) could be judged` +
        `${judged.length < documents.length ? ' (the rest declare no sources, or predate the trust family)' : ''}\n`,
    )
  }
}

main().catch((error) => {
  // Fail-open, and say why rather than exiting silently: the daemon being
  // down, or an older one without the trust family, must not look like a
  // workspace with nothing stale in it.
  if (!QUIET) process.stderr.write(`[stale-issues] skipped: ${error.message}\n`)
})
