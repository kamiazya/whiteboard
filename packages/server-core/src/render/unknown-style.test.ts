import { describe, expect, test } from 'vitest'
import { unknownStyleRefusal } from './unknown-style.js'

describe('unknownStyleRefusal', () => {
  test.each([
    undefined,
    'clean',
    'document',
    'visual.sketch',
    'visual.neon',
  ] as const)('lets %s through', (style) => {
    expect(unknownStyleRefusal(style)).toBeUndefined()
  })

  test('names the id asked for and every registered one', () => {
    const refusal = unknownStyleRefusal('visual.nope')
    expect(refusal).toContain('"visual.nope"')
    expect(refusal).toContain('visual.sketch, visual.neon')
  })

  // A namespaced id with a real namespace is still refused when its name is
  // not in the table: the check is on the whole id, not the plugin prefix.
  test('refuses a registered namespace with an unregistered name', () => {
    expect(unknownStyleRefusal('visual.sktech')).toBeDefined()
  })
})
