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
import {
  readDaemonRecord,
  requestDaemon,
} from '../../packages/mcp-server/scripts/dev/dev-daemon-socket-lib.mjs'
import { resolveDevDataDirEnv } from '../../packages/mcp-server/scripts/dev/with-dev-data-dir-lib.mjs'
import {
  collectStaleIssues,
  formatFindings,
  issueDocumentsFrom,
  unwrapToolResult,
} from './stale-issues-lib.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}
const QUIET = process.argv.includes('--quiet')
const WORKSPACE = arg('workspace', 'default')
/** `wb_document_get` refuses more than this per call. */
// One tool call's answer budget. The SessionStart hook's own timeout (settings.json) is the outer
// bound; this one makes a wedged daemon end the check with a reason instead of the hook's kill.
const REQUEST_TIMEOUT_MS = 5000
const DOCUMENTS_PER_READ = 20

function repoRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: SCRIPT_DIR,
    encoding: 'utf-8',
  }).trim()
}

/**
 * The checkout whose daemon holds the backlog.
 *
 * Per-worktree dev daemons each get their OWN data dir, so a worktree's
 * daemon has no `default` workspace at all — while the session's MCP client
 * reaches the MAIN checkout's daemon whichever worktree the work is in, which
 * is not a coincidence: `new-worktree.mjs` says outright that a per-worktree
 * MCP registration is not something the CLI can express (`~/.claude.json`
 * holds one project key per repository). The ticket store is therefore always
 * the main checkout's, and asking this worktree's daemon asks a daemon nobody
 * files issues into. `WHITEBOARD_DATA_DIR` still overrides, for a session that
 * really does point its client elsewhere.
 */
function mainCheckoutRoot(root) {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: root,
    encoding: 'utf-8',
  }).trim()
  return resolve(common, '..')
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
    const out = execFileSync('git', ['log', '--format=%cI', `--since=${sinceIso}`, '--', path], {
      cwd: root,
      encoding: 'utf-8',
    }).trim()
    return out === '' ? 'unchanged' : 'changed'
  }
}

async function main() {
  const root = repoRoot()
  const dataDir = resolveDevDataDirEnv(process.env, mainCheckoutRoot(root)).WHITEBOARD_DATA_DIR
  const token = process.env.WHITEBOARD_TOKEN ?? 'whiteboard-dev'

  let nextId = 1

  /**
   * SessionStart runs the daemon-ensure hook and this one, and nothing orders
   * them, so a cold start can reach here while the daemon is still binding.
   * Without this the check would be silent on exactly the session that starts
   * the machine's day. Bounded hard: three attempts over a second, and only
   * for a daemon with no record yet or one that refused the connection — a
   * daemon that is genuinely absent must not tax every session start.
   *
   * A daemon that accepts and never answers is not retried either: the request
   * is bounded, and a wedged daemon must cost one bound, not three, because
   * this runs under a hook timeout.
   */
  async function post(body) {
    for (let attempt = 0; ; attempt++) {
      try {
        const record = readDaemonRecord(dataDir)
        if (record === null) throw new Error('the dev daemon is not running (no daemon.json)')
        return await requestDaemon(record, {
          method: 'POST',
          path: '/mcp',
          timeoutMs: REQUEST_TIMEOUT_MS,
          ...body,
        })
      } catch (error) {
        if (attempt >= 2 || /^no answer within/.test(error.message)) throw error
        await new Promise((done) => setTimeout(done, 500))
      }
    }
  }

  async function call(name, args) {
    const { text } = await post({
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
    const payload = JSON.parse(text.startsWith('data:') ? text.slice(text.indexOf('{')) : text)
    return unwrapToolResult(name, payload)
  }

  const listed = await call('wb_document_list', { workspaceId: WORKSPACE })
  const entries = listed.documents ?? []
  // ONE batch read. `wb_document_get` takes `documentIds` and answers
  // `{ documents, failed }`; a document it could not read lands in `failed`
  // rather than failing the call, so it has to be looked at rather than
  // inferred from a short `documents` array.
  // The tool caps `documentIds` at 20 per call, so the read is chunked rather
  // than sent whole — found by the unwrap above, which reported the refusal a
  // silent reader had been discarding.
  const fetched = { documents: [], failed: [] }
  for (let at = 0; at < entries.length; at += DOCUMENTS_PER_READ) {
    const page = await call('wb_document_get', {
      workspaceId: WORKSPACE,
      documentIds: entries.slice(at, at + DOCUMENTS_PER_READ).map((entry) => entry.documentId),
    })
    fetched.documents.push(...(page.documents ?? []))
    fetched.failed.push(...(page.failed ?? []))
  }
  const { documents, unreadableSources, failed } = issueDocumentsFrom(entries, fetched)

  const findings = collectStaleIssues(documents, inspectorFor(root))
  const report = formatFindings(findings, documents.length)
  // A document the daemon could not read, or one whose `sources` this check
  // cannot parse, is said OUT LOUD even in quiet mode: each is a declaration
  // that looks made and is not being judged, which is the failure this whole
  // check exists to stop being silent about.
  for (const entry of failed) {
    process.stderr.write(
      `[stale-issues] could not read ${entry.documentId}: ${entry.reason ?? 'no reason given'}\n`,
    )
  }
  for (const path of unreadableSources) {
    process.stderr.write(
      `[stale-issues] ${path} declares sources this check cannot read — OKF wants ` +
        `\`- resource: <path>\` entries, not bare strings\n`,
    )
  }
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
  // Fail-open, and say why — IN QUIET MODE TOO. The hook passes `--quiet` to
  // mean "say nothing when there is nothing to report", and that used to
  // swallow the reason as well, so a check that could not look at anything
  // was indistinguishable from one that looked and found nothing. That is
  // exactly how this went unnoticed: a daemon that is down, a workspace that
  // does not exist on it, or a tool whose arguments have moved on.
  process.stderr.write(`[stale-issues] skipped: ${error.message}\n`)
})
