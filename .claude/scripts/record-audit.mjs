#!/usr/bin/env node
// Appends one run record to .claude/audit-log.jsonl. The integrator runs
// this after folding an audit's survivors:  node .claude/scripts/record-audit.mjs audit-triage
import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const kind = process.argv[2]
if (!kind || !/^[a-z0-9-]+$/.test(kind)) {
  process.stderr.write('usage: record-audit.mjs <kind>   (e.g. audit-triage, dogfood-triage)\n')
  process.exit(1)
}
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
appendFileSync(join(ROOT, '.claude/audit-log.jsonl'), `${JSON.stringify({ kind, at: new Date().toISOString() })}\n`)
process.stdout.write(`[record-audit] recorded ${kind}\n`)
