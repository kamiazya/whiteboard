import {
  boundedStringsInExports,
  refusesAstralOverflow,
} from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import * as extensionBridge from './extension-bridge.js'
import * as syncSseContract from './sync-sse-contract.js'

const moduleNamespace = { ...extensionBridge, ...syncSseContract }

describe('every bounded string the sync and bridge contracts exports counts UTF-16 units', () => {
  const bounded = boundedStringsInExports(moduleNamespace)

  it('reaches the bounded strings it declares', () => {
    expect(bounded.length).toBeGreaterThanOrEqual(3)
  })

  it.each(bounded)('$name: a limit of $max refuses an astral run over it', (found) => {
    expect(refusesAstralOverflow(found)).toBe(true)
  })
})
