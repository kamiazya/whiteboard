// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { CLUSTER_BUTTON_CLASS } from '@/components/history-cluster/HistoryCluster'
import { TOOL_BUTTON_CLASS } from '@/components/spatial-editor/ToolPalette'
import { DOCK_BUTTON_HEIGHT_CLASS } from './dock-button'

/**
 * The dock is one row assembled from two files that cannot see each other:
 * ToolPalette owns the tool buttons, HistoryCluster owns the leading slot the
 * palette renders. They drifted once already — the cluster grew a
 * `pointer-coarse` step and the palette did not, so a touch device showed a
 * 44px control beside a 36px one in the same row. Nothing failed; the row just
 * looked broken.
 *
 * Sharing the height token is what keeps them equal; these tests are what stop
 * a future edit from re-declaring it locally.
 */
describe('dock button sizing', () => {
  it('gives the palette and the leading cluster the same height token', () => {
    expect(TOOL_BUTTON_CLASS).toContain(DOCK_BUTTON_HEIGHT_CLASS)
    expect(CLUSTER_BUTTON_CLASS).toContain(DOCK_BUTTON_HEIGHT_CLASS)
  })

  it('scales up on coarse pointers, where a 36px target is below the touch floor', () => {
    expect(DOCK_BUTTON_HEIGHT_CLASS).toMatch(/pointer-coarse:h-\d+/)
  })

  it('declares no local size token in either dock source (the drift that caused the mismatch)', async () => {
    const sources = import.meta.glob(
      ['../spatial-editor/ToolPalette.tsx', '../history-cluster/HistoryCluster.tsx'],
      { query: '?raw', import: 'default', eager: true },
    ) as Record<string, string>

    expect(Object.keys(sources)).toHaveLength(2)
    for (const [path, source] of Object.entries(sources)) {
      // `size-*` sets width AND height at once, so a local one silently
      // overrides the shared height. Icon sizing (`size-4` on the lucide
      // glyphs) is a different concern and stays allowed.
      const offenders = [...source.matchAll(/\bsize-(\d+)\b/g)]
        .map((match) => match[1])
        .filter((value) => value !== '4')
      expect(offenders, `${path} re-declares a button size token`).toEqual([])
    }
  })
})
