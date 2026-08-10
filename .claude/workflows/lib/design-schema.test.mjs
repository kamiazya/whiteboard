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

test('rejects blank/whitespace-only `properties` entries via the item pattern', () => {
  const itemPattern = new RegExp(DESIGN_SCHEMA.properties.properties.items.pattern)
  assert.equal(itemPattern.test(''), false)
  assert.equal(itemPattern.test('   '), false)
  assert.equal(itemPattern.test('parse(serialize(x)) === x'), true)
  assert.equal(itemPattern.test('none: pure UI wiring'), true)
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

test('requires a non-empty `blastRadius` field naming the change\'s impacted call sites', () => {
  const blastRadius = DESIGN_SCHEMA.properties.blastRadius
  assert.equal(blastRadius.type, 'array')
  assert.equal(blastRadius.items.type, 'string')
  assert.equal(blastRadius.minItems, 1)
  assert.ok(DESIGN_SCHEMA.required.includes('blastRadius'))
})

test('rejects blank/whitespace-only `blastRadius` entries via the item pattern', () => {
  const itemPattern = new RegExp(DESIGN_SCHEMA.properties.blastRadius.items.pattern)
  assert.equal(itemPattern.test(''), false)
  assert.equal(itemPattern.test('   '), false)
  assert.equal(itemPattern.test('svg/backend.ts::renderNode — impacted, no direct test'), true)
})

// Both escape hatches must stay documented in the field itself: `none:` is the genuine
// leaf-change answer, `unavailable:` keeps the gate fail-open on a machine with no graph tool
// installed, so a teammate without it is never blocked by a field they cannot fill in.
test('documents the none:/unavailable: escape hatches on `blastRadius`', () => {
  const description = DESIGN_SCHEMA.properties.blastRadius.description || ''
  assert.match(description, /none:/)
  assert.match(description, /unavailable:/)
})

test('requires a non-empty `userReach` field naming how a user reaches the change', () => {
  const userReach = DESIGN_SCHEMA.properties.userReach
  assert.equal(userReach.type, 'array')
  assert.equal(userReach.items.type, 'string')
  assert.equal(userReach.minItems, 1)
  assert.ok(DESIGN_SCHEMA.required.includes('userReach'))
})

test('rejects blank/whitespace-only `userReach` entries via the item pattern', () => {
  const itemPattern = new RegExp(DESIGN_SCHEMA.properties.userReach.items.pattern)
  assert.equal(itemPattern.test(''), false)
  assert.equal(itemPattern.test('   '), false)
  assert.equal(itemPattern.test('registered in tools/index.ts, callable as wb_canvas_list'), true)
})

// A deliberately-unwired foundation slice is legitimate; a SILENTLY unwired one is the defect.
// The sentinel is what forces the difference to be stated, and it must demand the follow-up that
// wires it — an unwired slice with no named successor is exactly the "放置" case this field exists
// to catch.
test('the `userReach` foundation sentinel demands the follow-up that wires it', () => {
  const description = DESIGN_SCHEMA.properties.userReach.description || ''
  assert.match(description, /foundation:/)
  assert.match(description, /follow-up/i)
})
