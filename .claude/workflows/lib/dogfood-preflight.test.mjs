// Run with: node --test .claude/workflows/lib/dogfood-preflight.test.mjs
//
// The dogfood passes drive the app through the Playwright MCP's browser tools, which nothing in
// this repository registers: a session has them only when its user added the server before
// starting it (docs/contributing/development.md). Without them a persona agent cannot reach the
// app, yet each one still ran and reported, and dogfood-triage then spent a triage agent per item
// it produced. So a missing browser stops the run as a skip, before the agents it would waste.
//
// The workflows run in a sandbox with no import, so each is executed here whole, as the runtime
// runs it — an async function body over injected globals — with every agent stubbed by label.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const workflowDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor

/**
 * Runs `file` with `args`; `answer(label, prompt, options)` stands in for each agent. Returns the
 * workflow's result and every agent call in order.
 */
async function runWorkflow(file, args, answer) {
  const source = readFileSync(path.join(workflowDir, file), 'utf8').replace(
    'export const meta = ',
    'const meta = ',
  )
  const calls = []
  const agent = async (prompt, options) => {
    calls.push({ label: options.label, prompt, options })
    return answer(options.label, prompt, options)
  }
  const parallel = async (thunks) => Promise.all(thunks.map((run) => run()))
  const pipeline = async () => []
  const noop = () => {}
  const run = new AsyncFunction(
    'args',
    'agent',
    'workflow',
    'phase',
    'log',
    'parallel',
    'pipeline',
    'budget',
    source,
  )
  const result = await run(JSON.stringify(args), agent, noop, noop, noop, parallel, pipeline, noop)
  return { result, calls }
}

const PERSONAS = {
  personas: ['Ana', 'Ben', 'Cy'].map((name) => ({
    name,
    context: 'c',
    goal: 'g',
    successLooksLike: 's',
  })),
}
const SKIP = { goalAchieved: 'skip', summary: 'no browser tool loaded', friction: [] }

test('dogfood-triage stops at the preflight when no browser tool loads', async () => {
  const { result, calls } = await runWorkflow('dogfood-triage.workflow.mjs', {}, (label) =>
    label === 'preflight' ? { ready: false, reason: 'no browser tool loaded' } : PERSONAS,
  )
  assert.deepEqual(
    calls.map((c) => c.label),
    ['preflight'],
  )
  assert.match(result.skipped, /no browser tool/)
})

test('dogfood-triage stops when the preflight agent itself returns nothing', async () => {
  const { result, calls } = await runWorkflow('dogfood-triage.workflow.mjs', {}, (label) =>
    label === 'preflight' ? null : PERSONAS,
  )
  assert.deepEqual(
    calls.map((c) => c.label),
    ['preflight'],
  )
  assert.equal(typeof result.skipped, 'string')
})

test('dogfood-triage drives no further persona once one reports a skip', async () => {
  const { result, calls } = await runWorkflow('dogfood-triage.workflow.mjs', {}, (label) => {
    if (label === 'preflight') return { ready: true, reason: '' }
    if (label === 'personas') return PERSONAS
    return SKIP
  })
  assert.deepEqual(
    calls.map((c) => c.label),
    ['preflight', 'personas', 'dogfood:Ana'],
  )
  assert.match(result.skipped, /no browser tool/)
})

test('dogfood-triage files a kept item under the name its triage chose', async () => {
  const friction = { kind: 'confusing', severity: 'LOW', title: 't', where: 'w', detail: 'd' }
  const { result, calls } = await runWorkflow(
    'dogfood-triage.workflow.mjs',
    { personaCount: 1 },
    (label) => {
      if (label === 'preflight') return { ready: true, reason: '' }
      if (label === 'personas') return { personas: PERSONAS.personas.slice(0, 1) }
      if (label.startsWith('dogfood:'))
        return { goalAchieved: 'partial', summary: 's', friction: [friction] }
      return {
        isDuplicate: false,
        verifiedReal: true,
        severity: 'LOW',
        disposition: 'backlog',
        rationale: 'r',
        issueName: 'toolbar-label-unclear',
      }
    },
  )
  assert.equal(result.skipped, undefined)
  assert.equal(result.findings[0].issueName, 'toolbar-label-unclear')
  const triage = calls.find((c) => c.label.startsWith('triage:'))
  assert.ok(triage.options.schema.properties.issueName)
  assert.equal(triage.options.schema.properties.issueSlug, undefined)
})

test('every dogfood prompt says to skip, not improvise, when no browser tool loads', async () => {
  const { calls: triageCalls } = await runWorkflow('dogfood-triage.workflow.mjs', {}, (label) =>
    label === 'personas' ? PERSONAS : label === 'preflight' ? { ready: true, reason: '' } : SKIP,
  )
  const { calls: reviewCalls } = await runWorkflow(
    'review.workflow.mjs',
    { dogfood: true, appUrl: 'http://localhost:5173' },
    () => SKIP,
  )
  const prompts = [...triageCalls, ...reviewCalls]
    .filter((c) => c.label === 'preflight' || c.label.startsWith('dogfood:'))
    .map((c) => c.prompt)
  assert.ok(prompts.length >= 3, `found ${prompts.length} dogfood prompts`)
  for (const prompt of prompts) assert.match(prompt, /if no browser tool loads/i)
})

test('review drives no further dogfood persona once one reports a skip', async () => {
  const { result, calls } = await runWorkflow(
    'review.workflow.mjs',
    { dogfood: true, appUrl: 'http://localhost:5173', dogfoodPersonas: 3 },
    () => SKIP,
  )
  assert.deepEqual(
    calls.filter((c) => c.label.startsWith('dogfood:')).map((c) => c.label),
    ['dogfood:p1'],
  )
  assert.equal(result.dogfood[0].goalAchieved, 'skip')
})
