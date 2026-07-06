// Run with: node --test .claude/workflows/lib/normalize-dimensions.test.mjs
// No vitest project covers .claude/workflows (it orchestrates AI agents, not app code), so this
// uses node:test directly rather than inventing a mismatched harness.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeDimension } from './normalize-dimensions.mjs'

test('normalizes a legacy plain string to {name, content: null}', () => {
  assert.deepEqual(normalizeDimension('correctness'), { name: 'correctness', content: null })
})

test('normalizes a {name, content} object, defaulting missing content to null', () => {
  assert.deepEqual(normalizeDimension({ name: 'contract' }), { name: 'contract', content: null })
  assert.deepEqual(normalizeDimension({ name: 'contract', content: 'be precise' }), {
    name: 'contract',
    content: 'be precise',
  })
})

test('throws instead of silently producing an undefined name', () => {
  assert.throws(() => normalizeDimension({ content: 'no name here' }), /invalid dimension entry/)
  assert.throws(() => normalizeDimension({ name: '' }), /invalid dimension entry/)
  assert.throws(() => normalizeDimension(null), /invalid dimension entry/)
  assert.throws(() => normalizeDimension(42), /invalid dimension entry/)
})
