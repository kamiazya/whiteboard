import { describe, expect, it } from 'vitest'
import { VERSION_LABEL_MAX_LENGTH, versionLabelSchema } from './version-label.js'

describe('versionLabelSchema', () => {
  it.each([
    ['one character', 'x', true],
    ['exactly the maximum length', 'x'.repeat(VERSION_LABEL_MAX_LENGTH), true],
    ['empty', '', false],
    ['one past the maximum length', 'x'.repeat(VERSION_LABEL_MAX_LENGTH + 1), false],
  ])('%s: accepted is %s', (_name, label, accepted) => {
    expect(versionLabelSchema.safeParse(label).success).toBe(accepted)
  })

  it('keeps the ceiling at 200 characters', () => {
    expect(VERSION_LABEL_MAX_LENGTH).toBe(200)
  })
})
