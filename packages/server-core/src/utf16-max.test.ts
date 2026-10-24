import {
  boundedStringsInExports,
  refusesAstralOverflow,
} from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import * as canvasRenderSvg from './tools/canvas-render-svg.js'
import * as facetSet from './tools/facet-set.schemas.js'
import * as versionRestore from './tools/version-restore.js'
import * as versionEntry from './versions/version-entry.js'

const moduleNamespace = { ...canvasRenderSvg, ...facetSet, ...versionRestore, ...versionEntry }

describe('every bounded string the tools and version entries exports counts UTF-16 units', () => {
  const bounded = boundedStringsInExports(moduleNamespace)

  it('reaches the bounded strings it declares', () => {
    expect(bounded.length).toBeGreaterThanOrEqual(4)
  })

  it.each(bounded)('$name: a limit of $max refuses an astral run over it', (found) => {
    expect(refusesAstralOverflow(found)).toBe(true)
  })
})
