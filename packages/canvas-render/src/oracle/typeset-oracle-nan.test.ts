import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { describe, expect, it } from 'vitest'
import { type TypesetInput, typesetAnswer } from '../test-utils/typeset-oracle/oracle.js'

const NEGATIVE_NAN = 'fff8000000000000'

const inputOf = (value: string, width: string): TypesetInput => {
  const root: MdastRoot = {
    type: 'root',
    children: [{ type: 'paragraph', children: [{ type: 'text', value }] }],
  }
  return {
    id: 'nan',
    root,
    width,
    theme: 'document',
    fill: null,
    embeds: 'none',
    syntax: null,
    digest: false,
  }
}

const sceneOf = (input: TypesetInput): string => {
  const answer = typesetAnswer(input)
  if (!('scene' in answer) || typeof answer.scene !== 'string') throw new Error('no scene text')
  return answer.scene
}

describe('the typeset oracle', () => {
  // A NaN's sign is canonicalised where a NUMBER is written; a string that spells the same hex
  // is content, and rewriting it would make two different scenes compare equal.
  it('canonicalises a negative NaN number but leaves a string spelling it untouched', () => {
    const scene = sceneOf(inputOf(`#${NEGATIVE_NAN}`, NEGATIVE_NAN))
    expect(scene).toContain(JSON.stringify(`#${NEGATIVE_NAN}`))
    expect(scene).toContain('#7ff8000000000000')
    expect(scene.replaceAll(JSON.stringify(`#${NEGATIVE_NAN}`), '')).not.toContain(NEGATIVE_NAN)
  })
})
