/**
 * What highlight.js is handed. Its javascript, typescript and bash grammars
 * cost the SQUARE of each identifier-like run's length, and yaml's the square
 * of each line's, so the tokeniser is counted rather than timed: a fence that
 * would take seconds to highlight must never reach it, and the count says so
 * without paying those seconds.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { highlightCode } from './lowlight.js'

const handed = vi.hoisted(() => [] as { lang: string; length: number }[])

vi.mock('lowlight', async (importOriginal) => {
  const original = await importOriginal<typeof import('lowlight')>()
  return {
    ...original,
    createLowlight: (...args: Parameters<typeof original.createLowlight>) => {
      const instance = original.createLowlight(...args)
      return {
        ...instance,
        highlight: (
          lang: string,
          value: string,
          options?: Parameters<typeof instance.highlight>[2],
        ) => {
          handed.push({ lang, length: value.length })
          return instance.highlight(lang, value, options)
        },
      }
    },
  }
})

beforeEach(() => {
  handed.length = 0
})

describe('the tokeniser cost budget', () => {
  it('renders a fence holding one very long identifier plain, without tokenising it', () => {
    for (const lang of ['ts', 'js', 'bash']) {
      expect(highlightCode(lang, `const ${'a'.repeat(32_768)} = 1`)).toBeUndefined()
    }
    expect(handed).toEqual([])
  })

  it('renders a fence of many long identifiers plain, since the cost is their squares summed', () => {
    const source = `${'a'.repeat(3_000)}\n`.repeat(64)
    expect(highlightCode('typescript', source)).toBeUndefined()
    expect(handed).toEqual([])
  })

  it('renders a yaml fence with one very long line plain', () => {
    expect(highlightCode('yaml', `key: ${'a '.repeat(32_768)}`)).toBeUndefined()
    expect(handed).toEqual([])
  })

  it('still tokenises ordinary code, however long the fence', () => {
    const line = 'export const someLongerIdentifierName = computeValue(input, "text") // note\n'
    const source = line.repeat(Math.ceil(262_144 / line.length))
    for (const lang of ['ts', 'js', 'bash', 'yaml', 'python']) {
      expect(highlightCode(lang, source)).toBeDefined()
    }
    expect(handed).toHaveLength(5)
  })

  it('still tokenises a fence whose identifiers stay inside the budget', () => {
    expect(highlightCode('ts', `const ${'a'.repeat(2_048)} = 1`)).toBeDefined()
    expect(handed).toHaveLength(1)
  })
})
