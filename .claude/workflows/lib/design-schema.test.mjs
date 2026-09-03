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

// `properties` asks what stays TRUE, `blastRadius` who this reaches, `userReach` whether a user
// reaches it at all — and none of the three asks what the change is WORTH. A design can clear
// every one of them while its author has never decided whether the benefit is a delta, a
// relocation or an elimination, and that decision is what picks the instrument: an end-to-end
// duration cannot see a relocation, so pointing one at it reports a null result about a change
// that did exactly what it was for. The prefix is enforced rather than described, because a
// description asking someone to choose a column is a description they can answer in prose.
test('requires a `benefit` naming which kind of benefit the change claims', () => {
  const benefit = DESIGN_SCHEMA.properties.benefit
  assert.equal(benefit.type, 'string')
  assert.ok(DESIGN_SCHEMA.required.includes('benefit'))
})

test('the `benefit` pattern admits exactly the four claim kinds, and no bare prose', () => {
  const pattern = new RegExp(DESIGN_SCHEMA.properties.benefit.pattern)
  assert.equal(pattern.test('delta: p95 layout 66ms -> 40ms, pnpm bench interleaved'), true)
  assert.equal(
    pattern.test('relocation: main thread stops paying 24-92ms of decode per list; clone of the bytes unmeasurable'),
    true,
  )
  assert.equal(pattern.test('elimination: a new document kind cannot miss a surface — Record<DocumentKind> fails the build'), true)
  assert.equal(pattern.test('obvious: fixes a crash on an empty body, visible in the diff'), true)
  // The whole point of the field is that a column is CHOSEN. Prose that names no column is the
  // answer this rejects, along with a prefix carrying nothing after it.
  assert.equal(pattern.test('makes the list feel faster'), false)
  assert.equal(pattern.test('relocation:'), false)
  assert.equal(pattern.test('relocation:   '), false)
  assert.equal(pattern.test(''), false)
})

test('the `benefit` description names the instrument each kind needs', () => {
  const description = DESIGN_SCHEMA.properties.benefit.description || ''
  assert.match(description, /relocation/)
  assert.match(description, /elimination/)
  assert.match(description, /measured-change/)
})
