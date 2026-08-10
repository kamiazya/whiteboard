// Run with: node --test .claude/workflows/lib/dev-loop-design-schema-sync.test.mjs
// dev-loop.workflow.mjs runs inside a sandbox with no import/fs, so it keeps its own duplicated
// copy of DESIGN_SCHEMA (and an isValidDesignShape guard) instead of importing design-schema.mjs.
// This test extracts both inline literals straight from the workflow source and diffs them
// against the single-sourced module/behavior, so an edit to one copy that forgets the other
// fails here instead of drifting silently (the same class of bug AGENTS.md's Zod-discipline
// section calls out for schema/runtime drift elsewhere in the repo).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  DESIGN_SCHEMA,
  isValidDesignShape as sharedIsValidDesignShape,
  shouldBlockOnFailedPlanReview as sharedShouldBlockOnFailedPlanReview,
  shouldGenerateDesign as sharedShouldGenerateDesign,
} from './design-schema.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const workflowPath = path.join(__dirname, '..', 'dev-loop.workflow.mjs')
const source = readFileSync(workflowPath, 'utf8')

function extractInlineDesignSchema() {
  const match = source.match(/\nconst DESIGN_SCHEMA = (\{[\s\S]*?\n\})\n\nconst PLAN_VERDICT_SCHEMA/)
  assert.ok(match, 'could not locate the inline `const DESIGN_SCHEMA = {...}` literal in dev-loop.workflow.mjs')
  // eslint-disable-next-line no-new-func -- evaluating a plain object literal extracted from our own source, not untrusted input
  return new Function(`return (${match[1]})`)()
}

function extractIsValidDesignShape() {
  const match = source.match(
    /\nconst nonBlankItem = new RegExp\(DESIGN_SCHEMA[\s\S]*?\nfunction isValidDesignShape\(d\) \{[\s\S]*?\n\}\n/,
  )
  assert.ok(
    match,
    'could not locate `nonBlankItem` + `function isValidDesignShape(d) {...}` in dev-loop.workflow.mjs',
  )
  // eslint-disable-next-line no-new-func -- evaluating our own source (DESIGN_SCHEMA + a plain function declaration), not untrusted input
  return new Function('DESIGN_SCHEMA', `${match[0]}\nreturn isValidDesignShape`)(DESIGN_SCHEMA)
}

function extractShouldGenerateDesign() {
  const match = source.match(/\nfunction shouldGenerateDesign\(\{[\s\S]*?\n\}\n/)
  assert.ok(match, 'could not locate `function shouldGenerateDesign({...}) {...}` in dev-loop.workflow.mjs')
  // eslint-disable-next-line no-new-func -- evaluating a plain function declaration extracted from our own source, not untrusted input
  return new Function(`${match[0]}\nreturn shouldGenerateDesign`)()
}

function extractShouldBlockOnFailedPlanReview() {
  const match = source.match(/\nfunction shouldBlockOnFailedPlanReview\(\{[\s\S]*?\n\}\n/)
  assert.ok(
    match,
    'could not locate `function shouldBlockOnFailedPlanReview({...}) {...}` in dev-loop.workflow.mjs',
  )
  // eslint-disable-next-line no-new-func -- evaluating a plain function declaration extracted from our own source, not untrusted input
  return new Function(`${match[0]}\nreturn shouldBlockOnFailedPlanReview`)()
}

test('inline DESIGN_SCHEMA in dev-loop.workflow.mjs matches the exported design-schema.mjs module', () => {
  const inline = extractInlineDesignSchema()
  assert.deepEqual(inline, DESIGN_SCHEMA)
})

test('isValidDesignShape accepts a well-formed caller-provided designDoc', () => {
  const isValidDesignShape = extractIsValidDesignShape()
  assert.equal(
    isValidDesignShape({
      completionCriteria: ['does the thing'],
      scope: 'small',
      testScenarios: { unit: ['covers the thing'] },
      properties: ['none: pure UI wiring, no state/parser/store surface'],
      blastRadius: ['none: new leaf module, no existing callers'],
      userReach: ['rendered by CanvasList, reachable from /w/:ws'],
    }),
    true,
  )
})

test('isValidDesignShape rejects a designDoc missing the required `userReach` field', () => {
  const isValidDesignShape = extractIsValidDesignShape()
  const designWithoutUserReach = {
    completionCriteria: ['does the thing'],
    scope: 'small',
    testScenarios: { unit: ['covers the thing'] },
    properties: ['none: pure UI wiring, no state/parser/store surface'],
    blastRadius: ['none: new leaf module, no existing callers'],
  }
  assert.equal(isValidDesignShape(designWithoutUserReach), false)
  assert.equal(sharedIsValidDesignShape(designWithoutUserReach), false)
})

test('isValidDesignShape rejects a designDoc missing the required `blastRadius` field', () => {
  const isValidDesignShape = extractIsValidDesignShape()
  const designWithoutBlastRadius = {
    completionCriteria: ['does the thing'],
    scope: 'small',
    testScenarios: { unit: ['covers the thing'] },
    properties: ['none: pure UI wiring, no state/parser/store surface'],
  }
  assert.equal(isValidDesignShape(designWithoutBlastRadius), false)
  assert.equal(sharedIsValidDesignShape(designWithoutBlastRadius), false)
})

test('isValidDesignShape rejects a whitespace-only `blastRadius` entry', () => {
  const isValidDesignShape = extractIsValidDesignShape()
  const designWithBlankBlastRadius = {
    completionCriteria: ['does the thing'],
    scope: 'small',
    testScenarios: { unit: ['covers the thing'] },
    properties: ['none: pure UI wiring, no state/parser/store surface'],
    blastRadius: ['   '],
    userReach: ['rendered by CanvasList'],
  }
  assert.equal(isValidDesignShape(designWithBlankBlastRadius), false)
  assert.equal(sharedIsValidDesignShape(designWithBlankBlastRadius), false)
})

test('isValidDesignShape rejects a designDoc missing the required `properties` invariant field', () => {
  const isValidDesignShape = extractIsValidDesignShape()
  assert.equal(
    isValidDesignShape({
      completionCriteria: ['does the thing'],
      scope: 'small',
      testScenarios: { unit: ['covers the thing'] },
    }),
    false,
  )
})

test('isValidDesignShape rejects a designDoc with an empty `properties` array', () => {
  const isValidDesignShape = extractIsValidDesignShape()
  assert.equal(
    isValidDesignShape({
      completionCriteria: ['does the thing'],
      scope: 'small',
      testScenarios: { unit: ['covers the thing'] },
      properties: [],
    }),
    false,
  )
})

test('isValidDesignShape rejects a non-object and a null designDoc', () => {
  const isValidDesignShape = extractIsValidDesignShape()
  assert.equal(isValidDesignShape(null), false)
  assert.equal(isValidDesignShape('not an object'), false)
})

test('isValidDesignShape rejects a whitespace-only `properties` entry, matching DESIGN_SCHEMA\'s `\\S` pattern', () => {
  const isValidDesignShape = extractIsValidDesignShape()
  const designWithBlankProperty = {
    completionCriteria: ['does the thing'],
    scope: 'small',
    testScenarios: { unit: ['covers the thing'] },
    properties: ['   '],
  }
  assert.equal(isValidDesignShape(designWithBlankProperty), false)
  assert.equal(sharedIsValidDesignShape(designWithBlankProperty), false)
})

test('isValidDesignShape rejects non-string elements in completionCriteria and testScenarios.unit', () => {
  const isValidDesignShape = extractIsValidDesignShape()
  const designWithNonStringCompletionCriteria = {
    completionCriteria: [42],
    scope: 'small',
    testScenarios: { unit: ['covers the thing'] },
    properties: ['none: pure UI wiring, no state/parser/store surface'],
  }
  const designWithNonStringTestScenario = {
    completionCriteria: ['does the thing'],
    scope: 'small',
    testScenarios: { unit: [42] },
    properties: ['none: pure UI wiring, no state/parser/store surface'],
  }
  assert.equal(isValidDesignShape(designWithNonStringCompletionCriteria), false)
  assert.equal(sharedIsValidDesignShape(designWithNonStringCompletionCriteria), false)
  assert.equal(isValidDesignShape(designWithNonStringTestScenario), false)
  assert.equal(sharedIsValidDesignShape(designWithNonStringTestScenario), false)
})

test('the duplicated inline isValidDesignShape agrees with the single-sourced design-schema.mjs export across a table of designs', () => {
  const isValidDesignShape = extractIsValidDesignShape()
  const cases = [
    {
      completionCriteria: ['does the thing'],
      scope: 'small',
      testScenarios: { unit: ['covers the thing'] },
      properties: ['none: pure UI wiring, no state/parser/store surface'],
    },
    { completionCriteria: ['x'], scope: 's', testScenarios: { unit: ['u'] }, properties: ['   '] },
    { completionCriteria: [42], scope: 's', testScenarios: { unit: ['u'] }, properties: ['x'] },
    { completionCriteria: ['x'], scope: 's', testScenarios: { unit: [42] }, properties: ['x'] },
    { completionCriteria: ['x'], scope: 's', testScenarios: { unit: ['u'] }, properties: [] },
    null,
  ]
  for (const design of cases) {
    assert.equal(isValidDesignShape(design), sharedIsValidDesignShape(design), `mismatch for ${JSON.stringify(design)}`)
  }
})

test('isValidDesignShape rejects values forbidden by DESIGN_SCHEMA even when the required fields are present', () => {
  const isValidDesignShape = extractIsValidDesignShape()
  const base = {
    completionCriteria: ['does the thing'],
    scope: 'small',
    testScenarios: { unit: ['covers the thing'] },
    properties: ['none: pure UI wiring, no state/parser/store surface'],
  }
  const cases = [
    { ...base, contractChanges: 42 },
    { ...base, testScenarios: { ...base.testScenarios, browser: 42 } },
    { ...base, unknownTopLevel: 'nope' },
    { ...base, testScenarios: { ...base.testScenarios, unknownNested: 'nope' } },
  ]
  for (const design of cases) {
    assert.equal(isValidDesignShape(design), false, `expected inline validator to reject ${JSON.stringify(design)}`)
    assert.equal(sharedIsValidDesignShape(design), false, `expected shared validator to reject ${JSON.stringify(design)}`)
  }
})

test('shouldBlockOnFailedPlanReview blocks implementation when a design was reviewed and the gate never passed', () => {
  const shouldBlockOnFailedPlanReview = extractShouldBlockOnFailedPlanReview()
  const input = { hasDesign: true, pass: false }
  assert.equal(shouldBlockOnFailedPlanReview(input), true)
  assert.equal(sharedShouldBlockOnFailedPlanReview(input), true)
})

test('shouldBlockOnFailedPlanReview does not block when the plan-review gate passed', () => {
  const shouldBlockOnFailedPlanReview = extractShouldBlockOnFailedPlanReview()
  const input = { hasDesign: true, pass: true }
  assert.equal(shouldBlockOnFailedPlanReview(input), false)
  assert.equal(sharedShouldBlockOnFailedPlanReview(input), false)
})

test('shouldBlockOnFailedPlanReview does not block when design/PlanReview was skipped entirely', () => {
  const shouldBlockOnFailedPlanReview = extractShouldBlockOnFailedPlanReview()
  const input = { hasDesign: false, pass: false }
  assert.equal(shouldBlockOnFailedPlanReview(input), false)
  assert.equal(sharedShouldBlockOnFailedPlanReview(input), false)
})

test('shouldGenerateDesign regenerates when skipDesign is set but the provided designDoc was just discarded as invalid', () => {
  const shouldGenerateDesign = extractShouldGenerateDesign()
  const input = { hasDesign: false, skipDesign: true, discardedInvalidProvidedDesign: true }
  assert.equal(shouldGenerateDesign(input), true)
  assert.equal(sharedShouldGenerateDesign(input), true)
})

test('shouldGenerateDesign does not regenerate when skipDesign is set and no design was ever provided', () => {
  const shouldGenerateDesign = extractShouldGenerateDesign()
  const input = { hasDesign: false, skipDesign: true, discardedInvalidProvidedDesign: false }
  assert.equal(shouldGenerateDesign(input), false)
  assert.equal(sharedShouldGenerateDesign(input), false)
})

test('shouldGenerateDesign never regenerates once a valid design is already present', () => {
  const shouldGenerateDesign = extractShouldGenerateDesign()
  const input = { hasDesign: true, skipDesign: false, discardedInvalidProvidedDesign: false }
  assert.equal(shouldGenerateDesign(input), false)
  assert.equal(sharedShouldGenerateDesign(input), false)
})

test('shouldGenerateDesign generates when design was never skipped and none is present', () => {
  const shouldGenerateDesign = extractShouldGenerateDesign()
  const input = { hasDesign: false, skipDesign: false, discardedInvalidProvidedDesign: false }
  assert.equal(shouldGenerateDesign(input), true)
  assert.equal(sharedShouldGenerateDesign(input), true)
})
