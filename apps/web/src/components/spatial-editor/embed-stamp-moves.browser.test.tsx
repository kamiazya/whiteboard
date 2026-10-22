/**
 * A note embedded in a board stays drawn while it is edited elsewhere, and
 * the board ends on its newest revision.
 *
 * Three costs were cut under this flow, each with a way to get it wrong
 * that a user sees: the prefetch cache forgets a note's older revisions (an
 * eviction too eager blanks the embed while the new one loads), the layout
 * worker keeps one request in flight (a lost waiting input leaves an old
 * revision on screen), and the worker keys its body cache on a revision token
 * rather than the wire's bytes (a token that failed to move would serve the
 * old body). The board is past the offload threshold, so it is laid out in
 * the real worker.
 */

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { useDocumentFileSeams } from '../../hooks/use-document-file-seams.js'
import type { DocumentFileAdapter, LoadedFileDocument } from '../../lib/document-file-contract.js'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(() => {
  cleanup()
})

const NOTE = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

const canvas: SpatialCanvas = {
  nodes: [
    textNode({ id: 'embed', x: 0, y: 0, width: 360, height: 160, text: `![[${NOTE}]]` }),
    ...Array.from({ length: 13 }, (_, i) =>
      textNode({
        id: `n${i}`,
        x: (i % 5) * 220,
        y: 240 + Math.floor(i / 5) * 140,
        width: 200,
        height: 100,
        text: `box ${i}`,
      }),
    ),
  ],
  edges: [],
}
const bodies: readonly string[] = []
const MOVES = 5

/** Each revision answers after a beat, so the old one has to hold the embed meanwhile. */
function revisionAdapter(revisionOf: () => number): DocumentFileAdapter {
  return {
    fileScope: 'test',
    isImageRef: () => false,
    loadDocument: (ref: string) =>
      new Promise<LoadedFileDocument | undefined>((resolve) => {
        const answer = ref === NOTE ? { name: 'Plan', body: `REVISION ${revisionOf()}` } : undefined
        setTimeout(() => resolve(answer), 30)
      }),
    loadImageUrl: async () => undefined,
    loadImageBlob: async () => undefined,
    storeImage: async () => ({ ok: false, reason: 'unused' }),
  }
}

let revision = 0
const adapter = revisionAdapter(() => revision)

function Harness() {
  const [stamp, setStamp] = useState(0)
  const stampOf = new Map([[NOTE, `v${stamp}`]])
  const { references } = useDocumentFileSeams({ canvas, adapter, stampOf, bodies })
  return (
    <>
      <button
        type="button"
        onClick={() => {
          revision += 1
          setStamp((s) => s + 1)
        }}
      >
        edit the note elsewhere
      </button>
      <div className="relative h-[600px] w-[1200px]">
        <SpatialEditor canvas={canvas} onChange={() => {}} theme="light" references={references} />
      </div>
    </>
  )
}

const drawnText = (container: HTMLElement) =>
  [...container.querySelectorAll('svg text')].map((node) => node.textContent ?? '').join(' ')

describe('a note embedded in a worker-laid-out board', () => {
  it('stays drawn while edited elsewhere and ends on its newest revision', async () => {
    revision = 0
    const { container, getByRole } = render(<Harness />)
    await waitFor(() => expect(drawnText(container)).toContain('REVISION 0'))
    for (let i = 1; i <= MOVES; i += 1) {
      await userEvent.click(getByRole('button', { name: 'edit the note elsewhere' }))
      // The previous revision holds the embed until this one lands.
      expect(drawnText(container)).toMatch(/REVISION \d/)
    }
    await waitFor(() => expect(drawnText(container)).toContain(`REVISION ${MOVES}`))
    expect(drawnText(container)).not.toContain(`REVISION ${MOVES - 1}`)
  })
})
