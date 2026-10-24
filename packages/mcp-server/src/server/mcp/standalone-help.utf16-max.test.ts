import {
  boundedStringsInExports,
  refusesAstralOverflow,
} from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import * as standaloneHelp from './standalone-help.js'

const moduleNamespace = { ...standaloneHelp }

describe('every bounded string the standalone prompts exports counts UTF-16 units', () => {
  const bounded = boundedStringsInExports(moduleNamespace)

  it('reaches the bounded strings it declares', () => {
    expect(bounded.length).toBeGreaterThanOrEqual(2)
  })

  it.each(bounded)('$name: a limit of $max refuses an astral run over it', (found) => {
    expect(refusesAstralOverflow(found)).toBe(true)
  })
})
