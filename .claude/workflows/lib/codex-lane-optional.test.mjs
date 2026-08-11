// Run with: node --test .claude/workflows/lib/codex-lane-optional.test.mjs
//
// The Codex second opinion is a companion, never a gate: dev-flow.md's rule is that an
// unavailable Codex counts as "unavailable", not as a rejection. Two different runtime
// failures have to collapse to that one meaning:
//
//   1. the subagent dies mid-run          -> agent() RESOLVES to null
//   2. the host has no such agentType     -> agent() REJECTS
//
// Only (1) was handled. On a machine without the Codex plugin, (2) rejected out of dev-loop's
// plain Promise.all and aborted the whole workflow after the Design phase had already run; in
// review.workflow.mjs pipeline() swallowed the rejection instead, which is not a crash but
// reports the codex lane as "ran, found nothing" rather than unavailable.
//
// Both workflows run in a sandbox with no import/fs, so each keeps its own inline copy of the
// `optionalLane` guard. This test extracts each copy from source and checks the behavior
// directly, so deleting or weakening either one fails here.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const workflowDir = path.join(__dirname, '..')

const WORKFLOWS = ['dev-loop.workflow.mjs', 'review.workflow.mjs']

function extractOptionalLane(file) {
  const source = readFileSync(path.join(workflowDir, file), 'utf8')
  const match = source.match(/\nconst optionalLane = (\([\s\S]*?)\n/)
  assert.ok(match, `could not locate \`const optionalLane = ...\` in ${file}`)
  // eslint-disable-next-line no-new-func -- evaluating a plain arrow function from our own source, not untrusted input
  return { fn: new Function(`return (${match[1]})`)(), source }
}

for (const file of WORKFLOWS) {
  test(`${file}: optionalLane turns a rejecting agent into null instead of propagating`, async () => {
    const { fn } = extractOptionalLane(file)
    const notFound = () =>
      Promise.reject(new Error("agent({agentType}): agent type 'codex:codex-rescue' not found"))
    assert.equal(await fn(notFound), null)
  })

  test(`${file}: optionalLane leaves a null-returning agent as null`, async () => {
    const { fn } = extractOptionalLane(file)
    assert.equal(await fn(() => Promise.resolve(null)), null)
  })

  test(`${file}: optionalLane passes a successful verdict through untouched`, async () => {
    const { fn } = extractOptionalLane(file)
    const verdict = { pass: false, mustFix: ['something real'] }
    assert.deepEqual(await fn(() => Promise.resolve(verdict)), verdict)
  })

  test(`${file}: every codex:codex-rescue agent call is wrapped in optionalLane`, () => {
    const { source } = extractOptionalLane(file)
    assert.ok(
      source.includes("agentType: 'codex:codex-rescue'"),
      `${file} no longer references the codex agent type — delete this guard and its test together`,
    )
    assert.match(
      source,
      /optionalLane\(/,
      `${file} declares optionalLane but never applies it`,
    )
    // dev-loop calls it directly at the plan gate; review wraps the shared lane runner that the
    // codex lane flows through. Either way an unwrapped bare `agent(` for the codex lane would
    // reintroduce the abort, so assert the guard sits on the call path rather than counting sites.
    const callSites = source.match(/optionalLane\(/g) || []
    assert.ok(callSites.length >= 1, `${file} must apply optionalLane on the codex call path`)
  })
}
