#!/usr/bin/env node
// Appends one run record to .claude/audit-log.jsonl. The integrator runs
// this after folding an audit's survivors:  node .claude/scripts/record-audit.mjs audit-triage
import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseScriptArgs } from './script-flags.mjs'

// audit-nudge.mjs reads this log by kind, so a kind nothing reads is a row that
// misleads rather than records. That is why dogfood-triage is not one: no
// cadence check reads it, and its runs need a browser MCP a session may not
// have, so a nudge to run it would be one nobody could act on.
const KINDS = ['audit-triage']
const usage = `usage: record-audit.mjs <kind>   (kind: ${KINDS.join(' | ')})`

const {
  positionals: [kind],
} = parseScriptArgs({ argv: process.argv.slice(2), usage, maxPositionals: 1 })
if (!KINDS.includes(kind)) {
  process.stderr.write(
    `${kind === undefined ? 'missing kind' : `unknown kind ${kind}`}\n${usage}\n`,
  )
  process.exit(2)
}
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
appendFileSync(
  join(ROOT, '.claude/audit-log.jsonl'),
  `${JSON.stringify({ kind, at: new Date().toISOString() })}\n`,
)
process.stdout.write(`[record-audit] recorded ${kind}\n`)
