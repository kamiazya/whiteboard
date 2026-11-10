import { afterEach, describe, expect, it } from 'vitest'
import { installOkfCore, parseOkf, serializeOkf } from '../../okf/okf-core.js'
import type { OkfMarkdownDocument } from '../../okf/schema.js'
import { installOkfCoreForTests } from './install.js'

describe('installOkfCoreForTests over the staged artifact', () => {
  afterEach(() => installOkfCore(undefined))

  it('installs a core the plain exports then answer through', async () => {
    await installOkfCoreForTests({ okf: 'differential', mismatch: 'throw' })
    expect(parseOkf('---\ntype: note\n---\nbody')).toMatchObject({ ok: true })
    // The core declines a root key the schema does not name, so a throw here is the core being reached.
    const outsideTheType = { frontmatter: { type: 'note', stray: 1 }, body: '' }
    expect(() => serializeOkf(outsideTheType as unknown as OkfMarkdownDocument)).toThrow(
      /OKF core declined/,
    )
  })

  it('answers a decline in TypeScript when mismatches only log', async () => {
    await installOkfCoreForTests({ okf: 'rust', mismatch: 'log' })
    const outsideTheType = { frontmatter: { type: 'note', stray: 1 }, body: '' }
    expect(serializeOkf(outsideTheType as unknown as OkfMarkdownDocument)).toContain('stray')
  })
})
