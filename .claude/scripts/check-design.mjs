#!/usr/bin/env node
// Run the design checkpoints against a design document, from ANY execution mode.
//
// The workflow's PlanReview gate enforces these on a design an agent produced. Work done inline in
// the main session goes through no such gate, so the same checkpoints are runnable here — the bar
// belongs to the change, not to whoever happens to be executing it.
//
//   node .claude/scripts/check-design.mjs design.json
//   echo '{...}' | node .claude/scripts/check-design.mjs
//
// Exit 0 when every checkpoint is met, 1 with one line per unmet checkpoint.
import { readFileSync } from 'node:fs'
import { explainDesignShape } from '../workflows/lib/explain-design.mjs'

const file = process.argv[2]
let raw
try {
  raw = file && file !== '-' ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8')
} catch (err) {
  process.stderr.write(`could not read ${file ?? 'stdin'}: ${err.message}\n`)
  process.exit(2)
}

let design
try {
  design = JSON.parse(raw)
} catch (err) {
  process.stderr.write(`not valid JSON: ${err.message}\n`)
  process.exit(2)
}

const problems = explainDesignShape(design)
if (problems.length === 0) {
  process.stdout.write('design checkpoints: all met\n')
  process.exit(0)
}
process.stdout.write(`design checkpoints: ${problems.length} unmet\n`)
for (const p of problems) process.stdout.write(`  - ${p}\n`)
process.exit(1)
