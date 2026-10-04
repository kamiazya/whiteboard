import { describe, expect, it } from 'vitest'
import { versionLabelSchema } from './version-label.js'

describe('versionLabelSchema', () => {
  it.each([
    ['one character', 'x', true],
    ['exactly 200 characters', 'x'.repeat(200), true],
    ['empty', '', false],
    ['201 characters', 'x'.repeat(201), false],
  ])('%s: accepted is %s', (_name, label, accepted) => {
    expect(versionLabelSchema.safeParse(label).success).toBe(accepted)
  })
})
