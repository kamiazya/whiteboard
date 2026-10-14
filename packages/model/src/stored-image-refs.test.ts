import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import type { SpatialCanvas } from './spatial.js'
import { storedImageRefs } from './stored-image-refs.js'
import { fileNode, groupNode, textNode } from './test-utils/index.js'

const canvas: SpatialCanvas = {
  nodes: [
    groupNode({
      id: 'g',
      x: 0,
      y: 0,
      width: 300,
      height: 200,
      label: 'F',
      background: 'asset:frame-bg',
    }),
    groupNode({ id: 'g2', x: 0, y: 0, width: 10, height: 10, background: 'https://x/y.png' }),
    fileNode({ id: 'f', x: 0, y: 0, width: 10, height: 10, file: 'asset:file' }),
    fileNode({ id: 'doc', x: 0, y: 0, width: 10, height: 10, file: 'boards/other' }),
    textNode({ id: 't', x: 0, y: 0, width: 10, height: 10, text: 'a ![x](asset:inline) b' }),
  ],
  edges: [],
}

describe('storedImageRefs', () => {
  it('names image file nodes, frame backgrounds and inline images, and nothing else', () => {
    expect([...storedImageRefs({ canvas })].sort()).toEqual([
      'asset:file',
      'asset:frame-bg',
      'asset:inline',
    ])
  })

  it('reads a markdown body, with a repeat named once', () => {
    expect(
      storedImageRefs({ body: '![a](asset:one) ![b](<asset:two>) ![c](asset:one) ![d](http://x)' }),
    ).toEqual(['asset:one', 'asset:two'])
  })

  it('ends a destination at the space before its title', () => {
    // The title is not part of the URL: a scan that kept it would name the id
    // `abc "A title"`, and blob `abc` would read as unreferenced to the GC.
    expect(storedImageRefs({ body: '![a](asset:abc "A title") and ![b](asset:def)' })).toEqual([
      'asset:abc',
      'asset:def',
    ])
  })

  it('stops at an unclosed angle-bracket destination', () => {
    // Run under a vm timeout: a scan that skipped the unclosed `<` without
    // advancing would spin synchronously, which a vitest timeout cannot
    // interrupt. The vm watchdog terminates it, so a regression fails here
    // instead of hanging the run.
    const scan = () => storedImageRefs({ body: '![a](<asset:abc ![b](asset:def)' })
    expect(runInNewContext('scan()', { scan }, { timeout: 2000 })).toEqual([])
  })

  it('answers nothing for no content', () => {
    expect(storedImageRefs({})).toEqual([])
  })
})
