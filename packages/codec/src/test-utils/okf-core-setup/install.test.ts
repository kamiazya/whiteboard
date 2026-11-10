import { afterEach, describe, expect, it } from 'vitest'
import { installOkfCore, okfCoreInstalled, parseOkf, serializeOkf } from '../../okf/okf-core.js'
import { installOkfCoreForTests } from './install.js'

describe('installOkfCoreForTests', () => {
  afterEach(() => installOkfCoreForTests())

  it('fails loudly when the artifact is missing, and installs nothing', async () => {
    installOkfCore(undefined)
    await expect(installOkfCoreForTests('/nonexistent/whiteboard_wasm_bg.wasm')).rejects.toThrow(
      /artifact is missing/,
    )
    expect(okfCoreInstalled()).toBe(false)
  })

  it('installs the staged core, which the plain exports then answer through', async () => {
    installOkfCore(undefined)
    await installOkfCoreForTests()
    expect(okfCoreInstalled()).toBe(true)
    expect(parseOkf('---\ntype: note\n---\nbody')).toMatchObject({ ok: true })
    expect(serializeOkf({ frontmatter: { type: 'note' }, body: 'b' })).toBe(
      '---\ntype: note\n---\nb',
    )
  })
})
