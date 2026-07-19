// Run with: node --test .claude/workflows/lib/design-schema.test.mjs
// No vitest project covers .claude/workflows (it orchestrates AI agents, not app code), so this
// uses node:test directly, mirroring normalize-dimensions.test.mjs.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DESIGN_SCHEMA } from './design-schema.mjs'

test('requires a non-empty `properties` field pinning invariants/round-trips/metamorphic relations', () => {
  const properties = DESIGN_SCHEMA.properties.properties
  assert.equal(properties.type, 'array')
  assert.equal(properties.items.type, 'string')
  assert.equal(properties.minItems, 1)
  assert.ok(DESIGN_SCHEMA.required.includes('properties'))
})

test('describes the invariant intent and the none:<reason> escape hatch for stateless changes', () => {
  const description = DESIGN_SCHEMA.properties.properties.description || ''
  assert.match(description, /invariant/i)
  assert.match(description, /none:/)
})

test('keeps the existing required fields intact', () => {
  assert.ok(DESIGN_SCHEMA.required.includes('completionCriteria'))
  assert.ok(DESIGN_SCHEMA.required.includes('scope'))
  assert.ok(DESIGN_SCHEMA.required.includes('testScenarios'))
})
