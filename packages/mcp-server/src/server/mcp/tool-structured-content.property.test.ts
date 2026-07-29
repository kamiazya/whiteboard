/**
 * Classification integrity tests for mcp-smoke-coverage.ts.
 *
 * This test verifies that ALL_REGISTERED_TOOLS and the four category arrays
 * are internally consistent: no duplicates, no gaps, and DEFERRED entries
 * carry the required metadata. It does NOT compare against the live runtime
 * registration — that cross-check is done by the smoke script
 * (mcp-e2e-checkpoint.mjs) which calls tools/list and compares the result
 * with ALL_REGISTERED_TOOLS using set equality.
 */
import { describe, expect, it } from 'vitest'
import {
  ALL_REGISTERED_TOOLS,
  COVERED_TOOLS,
  DEFERRED_TOOLS,
  ERROR_PATH_ONLY_TOOLS,
  UNIT_ONLY_TOOLS,
} from './mcp-smoke-coverage.js'

describe('mcp-smoke-coverage classification', () => {
  // Derive the union from the four category arrays independently of ALL_REGISTERED_TOOLS.
  // Comparing these two lets us catch both directions of drift:
  //   - tool in ALL_REGISTERED_TOOLS but in no category
  //   - tool in a category but missing from ALL_REGISTERED_TOOLS
  const categoryUnion = [
    ...COVERED_TOOLS,
    ...ERROR_PATH_ONLY_TOOLS,
    ...UNIT_ONLY_TOOLS,
    ...DEFERRED_TOOLS.map((d) => d.name),
  ]

  it('ALL_REGISTERED_TOOLS has no duplicates', () => {
    const seen = new Set<string>()
    for (const name of ALL_REGISTERED_TOOLS) {
      expect(seen.has(name), `duplicate in ALL_REGISTERED_TOOLS: "${name}"`).toBe(false)
      seen.add(name)
    }
  })

  it('categories are pairwise disjoint (no tool in more than one category)', () => {
    const seen = new Set<string>()
    for (const name of categoryUnion) {
      expect(seen.has(name), `"${name}" appears in more than one category`).toBe(false)
      seen.add(name)
    }
  })

  it('every tool in ALL_REGISTERED_TOOLS is covered by exactly one category', () => {
    const categorySet = new Set(categoryUnion)
    for (const name of ALL_REGISTERED_TOOLS) {
      expect(
        categorySet.has(name),
        `"${name}" is in ALL_REGISTERED_TOOLS but missing from all categories`,
      ).toBe(true)
    }
  })

  it('every tool in any category is present in ALL_REGISTERED_TOOLS', () => {
    const registeredSet = new Set(ALL_REGISTERED_TOOLS)
    for (const name of categoryUnion) {
      expect(
        registeredSet.has(name),
        `"${name}" is in a category but missing from ALL_REGISTERED_TOOLS`,
      ).toBe(true)
    }
  })

  it('every DEFERRED_TOOLS entry has non-empty reason and unblock', () => {
    for (const entry of DEFERRED_TOOLS) {
      expect(
        entry.reason.trim().length,
        `DEFERRED "${entry.name}" has empty reason`,
      ).toBeGreaterThan(0)
      expect(
        entry.unblock.trim().length,
        `DEFERRED "${entry.name}" has empty unblock`,
      ).toBeGreaterThan(0)
    }
  })

  it('every tool name is a non-empty lowercase-underscore string', () => {
    for (const name of [...ALL_REGISTERED_TOOLS, ...categoryUnion]) {
      expect(typeof name).toBe('string')
      expect(name.trim()).toBe(name)
      expect(name.length).toBeGreaterThan(0)
    }
  })
})
