import {
  boundedStringsInExports,
  refusesAstralOverflow,
} from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import * as transferProtocol from './cross-origin-transfer-protocol.js'
import * as userSettings from './user-settings-store.js'

const moduleNamespace = { ...transferProtocol, ...userSettings }

describe('every bounded string the web settings and transfer contracts export counts UTF-16 units', () => {
  const bounded = boundedStringsInExports(moduleNamespace)

  it('reaches the bounded strings they declare', () => {
    expect(bounded.length).toBeGreaterThanOrEqual(2)
  })

  it.each(bounded)('$name: a limit of $max refuses an astral run over it', (found) => {
    expect(refusesAstralOverflow(found)).toBe(true)
  })
})
