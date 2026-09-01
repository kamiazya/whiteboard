// Run with: node --test .claude/workflows/lib/scriptpath-relative.test.mjs
// The workflow-authoring rule that a composition's `scriptPath` must be
// repo-relative (`.claude/workflows/...`) was prose-only, and the class cost
// a real failure: an unguarded path resolved wrong after a cwd change and
// broke a long run. This is the prose rule's mechanical half — the same
// pattern as local-gate-command.test.ts and vocabulary-check.test.ts: grep
// every workflow's `scriptPath:` literal and reject anything absolute or
// otherwise outside `.claude/workflows/`.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const workflowsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

function collectScriptPathLiterals() {
  const found = []
  for (const name of readdirSync(workflowsDir)) {
    if (!name.endsWith('.workflow.mjs')) continue
    const source = readFileSync(path.join(workflowsDir, name), 'utf8')
    for (const match of source.matchAll(/scriptPath:\s*(['"`])([^'"`]*)\1/g)) {
      found.push({ file: name, value: match[2] })
    }
  }
  return found
}

test('every workflow scriptPath literal is repo-relative under .claude/workflows/', () => {
  for (const { file, value } of collectScriptPathLiterals()) {
    assert.ok(
      value.startsWith('.claude/workflows/'),
      `${file}: scriptPath '${value}' must start with '.claude/workflows/' — an absolute or ` +
        `foreign path resolves wrong the moment the launching session's cwd differs`,
    )
  }
})

// Subject presence: the scan found the compositions that exist today. A
// regex that stops matching would otherwise report "no violations" exactly
// like a clean pass; 4 is the call-site count at the time of writing
// (dev-loop x2, plan-initiative x2), so fewer means the scan broke, not
// that compositions went away silently.
test('the scan still reaches the known composition call sites', () => {
  const found = collectScriptPathLiterals()
  assert.ok(
    found.length >= 4,
    `expected at least 4 scriptPath literals across *.workflow.mjs, found ${found.length} — ` +
      'the scan regex or directory walk is broken, not the workflows',
  )
})
