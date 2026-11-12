import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { describe, expect, it } from 'vitest'
import { f64Hex } from '../test-utils/render-oracle/scene-dump.js'
import { type TypesetInput, typesetAnswer } from '../test-utils/typeset-oracle/oracle.js'

const inputOf = (value: string, digest: boolean): TypesetInput => {
  const root: MdastRoot = {
    type: 'root',
    children: [{ type: 'paragraph', children: [{ type: 'text', value }] }],
  }
  return {
    id: 'lone-surrogate',
    root,
    width: f64Hex(1000),
    theme: 'document',
    fill: null,
    syntax: null,
    digest,
  }
}

describe('the typeset oracle', () => {
  // `JSON.stringify` writes a lone surrogate as the six characters `\ud83d`, so a scan of the
  // dumped text cannot see one; the scene's own strings are what must be read.
  it.each([true, false])('refuses a scene holding half a pair (digest %s)', (digest) => {
    expect(() => typesetAnswer(inputOf('a\ud83d', digest))).toThrow(/half a pair/)
  })

  it('answers a whole pair', () => {
    const answer = typesetAnswer(inputOf('a\u{1f44d}', false))
    expect(JSON.stringify(answer)).toContain('\u{1f44d}')
  })
})
