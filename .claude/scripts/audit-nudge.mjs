#!/usr/bin/env node
// SessionStart hook: reports when the standing codebase-health audit
// (audit-triage) is overdue. Read-only, fail-open, silent when fresh —
// the same contract as stale-issues.mjs and flake-watch.mjs.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { countUnrecordedWaves, formatNudge, parseAuditLog } from './lib/audit-log.mjs'

const QUIET = process.argv.includes('--quiet')
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')

try {
  let text = ''
  try {
    text = readFileSync(join(ROOT, '.claude/audit-log.jsonl'), 'utf8')
  } catch {
    // Missing file = no run on record; formatNudge says so.
  }
  const entries = parseAuditLog(text)
  const lastAudit = entries.filter((e) => e.kind === 'audit-triage').map((e) => e.at).sort().at(-1)
  const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: 5000 })
  const unrecordedWaves = lastAudit === undefined ? 0 : countUnrecordedWaves(lastAudit, git)
  const out = formatNudge(entries, Date.now(), unrecordedWaves)
  if (out !== '') process.stdout.write(`${out}\n`)
} catch (error) {
  if (!QUIET) process.stderr.write(`[audit-nudge] skipped: ${error.message}\n`)
}
