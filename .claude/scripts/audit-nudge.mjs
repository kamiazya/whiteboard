#!/usr/bin/env node
// SessionStart hook: reports when the standing codebase-health audit
// (audit-triage) is overdue. Read-only, fail-open, silent when fresh —
// the same contract as stale-issues.mjs and flake-watch.mjs.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatNudge, parseAuditLog } from './lib/audit-log.mjs'

const QUIET = process.argv.includes('--quiet')
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')

try {
  let text = ''
  try {
    text = readFileSync(join(ROOT, '.claude/audit-log.jsonl'), 'utf8')
  } catch {
    // Missing file = no run on record; formatNudge says so.
  }
  const out = formatNudge(parseAuditLog(text), Date.now())
  if (out !== '') process.stdout.write(`${out}\n`)
} catch (error) {
  if (!QUIET) process.stderr.write(`[audit-nudge] skipped: ${error.message}\n`)
}
