import { installOkfCore, type OkfCore } from '@kamiazya/whiteboard-codec'
import { afterEach, describe, expect, it } from 'vitest'
import { OkfParseError, parseWritableOkf } from './document-set.js'

describe('parseWritableOkf', () => {
  // The realm's core is put back, since the installation is process-global.
  let real: OkfCore | undefined
  afterEach(() => installOkfCore(real))

  // Only a value YAML cannot carry is the author's to fix. Naming any other
  // throw a frontmatter fault sends the author to repair content that is fine.
  it('lets a serialiser failure that is not about the content keep its own name', () => {
    // The real reader with a writer that fails for a reason that is not the content.
    real = installOkfCore(undefined)
    if (real === undefined) throw new Error('the test realm installs the core')
    installOkfCore({
      parseOkf: real.parseOkf,
      serializeOkf: () => {
        throw new Error('serialiser defect')
      },
    })
    const attempt = () => parseWritableOkf('---\ntype: note\n---\nbody')

    expect(attempt).toThrow('serialiser defect')
    expect(attempt).not.toThrow(OkfParseError)
  })
})
