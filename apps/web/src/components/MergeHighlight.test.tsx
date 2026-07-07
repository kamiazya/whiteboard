import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import { MergeHighlight } from './MergeHighlight.js'
import { MERGE_COMMITTED_EVENT, dispatchMergeCommitted } from '@/lib/merge-committed-event'

afterEach(() => cleanup())

function makeElement(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
): ExcalidrawElement {
  return { id, x, y, width, height } as unknown as ExcalidrawElement
}

function stubApi(elements: ExcalidrawElement[]): ExcalidrawImperativeAPI {
  return {
    getSceneElements: () => elements,
    getAppState: () => ({ scrollX: 0, scrollY: 0, zoom: { value: 1 } }),
  } as unknown as ExcalidrawImperativeAPI
}

describe('MergeHighlight', () => {
  it('resolves boxes for new and conflict element ids from the scene', () => {
    const apiRef = {
      current: stubApi([makeElement('a', 10, 20, 30, 40), makeElement('b', 1, 2, 3, 4)]),
    }
    render(<MergeHighlight workspaceId="w1" slug="c1" apiRef={apiRef} />)
    act(() => {
      dispatchMergeCommitted({
        workspaceId: 'w1',
        slug: 'c1',
        sourceName: 'feature',
        targetName: 'main',
        newCount: 1,
        changedCount: 0,
        conflictCount: 1,
        newElementIds: ['a'],
        conflictElementIds: ['b'],
      })
    })
    expect(screen.getByTestId('merge-highlight-new')).toBeTruthy()
    expect(screen.getByTestId('merge-highlight-conflict')).toBeTruthy()
  })

  it('skips unknown element ids without throwing', () => {
    const apiRef = { current: stubApi([]) }
    render(<MergeHighlight workspaceId="w1" slug="c1" apiRef={apiRef} />)
    expect(() => {
      act(() => {
        dispatchMergeCommitted({
          workspaceId: 'w1',
          slug: 'c1',
          sourceName: 'feature',
          targetName: 'main',
          newCount: 1,
          changedCount: 0,
          conflictCount: 0,
          newElementIds: ['missing'],
          conflictElementIds: [],
        })
      })
    }).not.toThrow()
    expect(screen.queryByTestId('merge-highlight-layer')).toBeNull()
  })

  it('ignores events for a different workspace/slug', () => {
    const apiRef = { current: stubApi([makeElement('a', 0, 0, 1, 1)]) }
    render(<MergeHighlight workspaceId="w1" slug="c1" apiRef={apiRef} />)
    act(() => {
      dispatchMergeCommitted({
        workspaceId: 'other',
        slug: 'c1',
        sourceName: 'feature',
        targetName: 'main',
        newCount: 1,
        changedCount: 0,
        conflictCount: 0,
        newElementIds: ['a'],
        conflictElementIds: [],
      })
    })
    expect(screen.queryByTestId('merge-highlight-layer')).toBeNull()
  })

  it('does nothing when apiRef.current is null', () => {
    const apiRef = { current: null }
    render(<MergeHighlight workspaceId="w1" slug="c1" apiRef={apiRef} />)
    expect(() => {
      act(() => {
        dispatchMergeCommitted({
          workspaceId: 'w1',
          slug: 'c1',
          sourceName: 'feature',
          targetName: 'main',
          newCount: 1,
          changedCount: 0,
          conflictCount: 0,
          newElementIds: ['a'],
          conflictElementIds: [],
        })
      })
    }).not.toThrow()
    expect(screen.queryByTestId('merge-highlight-layer')).toBeNull()
  })

  it('leaves previously-shown boxes untouched when a malformed detail follows a valid one', () => {
    const apiRef = { current: stubApi([makeElement('a', 5, 6, 7, 8)]) }
    render(<MergeHighlight workspaceId="w1" slug="c1" apiRef={apiRef} />)
    act(() => {
      dispatchMergeCommitted({
        workspaceId: 'w1',
        slug: 'c1',
        sourceName: 'feature',
        targetName: 'main',
        newCount: 1,
        changedCount: 0,
        conflictCount: 0,
        newElementIds: ['a'],
        conflictElementIds: [],
      })
    })
    expect(screen.getByTestId('merge-highlight-new')).toBeTruthy()
    act(() => {
      window.dispatchEvent(
        new CustomEvent(MERGE_COMMITTED_EVENT, {
          detail: { workspaceId: 'w1', slug: 'c1', newCount: 'nope' },
        }),
      )
    })
    // Malformed detail must be ignored: the valid highlight box survives unchanged.
    expect(screen.getByTestId('merge-highlight-new')).toBeTruthy()
  })

  it('is a no-op when apiRef is undefined at listener-registration time but window is defined', () => {
    // Guard against throwing before mount effects run.
    expect(() =>
      render(<MergeHighlight workspaceId="w1" slug="c1" apiRef={{ current: null }} />),
    ).not.toThrow()
  })
})
