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
import { DESIGN_SCHEMA } from './design-schema.mjs'

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
  const match = source.match(/\nfunction isValidDesignShape\(d\) \{[\s\S]*?\n\}\n/)
  assert.ok(match, 'could not locate `function isValidDesignShape(d) {...}` in dev-loop.workflow.mjs')
  // eslint-disable-next-line no-new-func -- evaluating a plain function declaration extracted from our own source, not untrusted input
  return new Function(`${match[0]}\nreturn isValidDesignShape`)()
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
    }),
    true,
  )
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
