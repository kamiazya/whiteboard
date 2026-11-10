import { afterEach, describe, expect, it } from 'vitest'
import { installOkfCore, type OkfCodecCore, okfCodec, parseOkf, serializeOkf } from './okf-core.js'
import { parseOkf as parseOkfTs } from './parse.js'

const answer = { ok: true as const, value: { frontmatter: { type: 'note' }, body: 'from core' } }

const fake = (impl: 'rust' | 'differential'): OkfCodecCore => ({
  okf: { parseOkf: () => answer, serializeOkf: () => 'from core' },
  impl: { parseOkf: impl, serializeOkf: impl },
})

describe('the installed OKF core', () => {
  // The installation is process-global; leaving one behind would answer the next test in the file.
  afterEach(() => installOkfCore(undefined))

  it('answers in TypeScript until a core is installed', () => {
    const text = '---\ntype: note\n---\nbody'
    expect(parseOkf(text)).toEqual(parseOkfTs(text))
  })

  it('routes the plain exports through an installed core under rust', () => {
    installOkfCore(fake('rust'))
    expect(parseOkf('anything')).toBe(answer)
    expect(serializeOkf({ frontmatter: { type: 'note' }, body: '' })).toBe('from core')
  })

  it('answers with the TypeScript under differential and reports the difference', () => {
    const seen: string[] = []
    installOkfCore({ ...fake('differential'), onMismatch: (m) => seen.push(m.fn) })
    const text = '---\ntype: note\n---\nbody'
    expect(parseOkf(text)).toEqual(parseOkfTs(text))
    expect(seen).toEqual(['parseOkf'])
  })

  it('answers an okfCodec given no core through the installed one', () => {
    installOkfCore(fake('rust'))
    expect(okfCodec(undefined).parseOkf('anything')).toBe(answer)
  })

  it('returns to the TypeScript when the installation is removed', () => {
    installOkfCore(fake('rust'))
    installOkfCore(undefined)
    expect(serializeOkf({ frontmatter: { type: 'note' }, body: 'b' })).not.toBe('from core')
  })
})
