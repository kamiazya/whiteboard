import { afterEach, describe, expect, it } from 'vitest'
import { installOkfCore, okfCoreInstalled, parseOkf, serializeOkf } from '../../okf/okf-core.js'
import {
  installSpatialCore,
  parseSpatial,
  serializeSpatial,
  spatialCoreInstalled,
} from '../../spatial/spatial-core.js'
import { installCoreForTests } from './install.js'

describe('installCoreForTests', () => {
  afterEach(() => installCoreForTests())

  it('fails loudly when the artifact is missing, and installs nothing', async () => {
    installOkfCore(undefined)
    installSpatialCore(undefined)
    await expect(installCoreForTests('/nonexistent/whiteboard_wasm_bg.wasm')).rejects.toThrow(
      /artifact is missing/,
    )
    expect(okfCoreInstalled()).toBe(false)
    expect(spatialCoreInstalled()).toBe(false)
  })

  it('installs the staged core, which the plain exports then answer through', async () => {
    installOkfCore(undefined)
    installSpatialCore(undefined)
    await installCoreForTests()
    expect(okfCoreInstalled()).toBe(true)
    expect(spatialCoreInstalled()).toBe(true)
    expect(parseSpatial('{}')).toMatchObject({ ok: true })
    expect(JSON.parse(serializeSpatial({ nodes: [], edges: [] }, 'extended'))).toEqual({
      nodes: [],
      edges: [],
    })
    expect(parseOkf('---\ntype: note\n---\nbody')).toMatchObject({ ok: true })
    expect(serializeOkf({ frontmatter: { type: 'note' }, body: 'b' })).toBe(
      '---\ntype: note\n---\nb',
    )
  })
})
