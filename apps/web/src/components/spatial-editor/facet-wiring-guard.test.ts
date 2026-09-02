// Core surfaces publish contribution points and know NO facet domain — the
// agreed governance line (spec: "facetのUIを既存面に手で書き足す線形拡張は
// しない"). Two increments shipped hand-wired facet UI anyway, so the rule
// gets an executable rung: the point-owning surfaces must not name a plugin
// namespace, a facet key, or a facet-specific resolver. Domain knowledge is
// allowed exactly one home on this side: the facet-widgets registration
// modules, which ARE the extension side of the seam.

import { describe, expect, it } from 'vitest'
import contextMenuSource from './CanvasContextMenu.tsx?raw'
import displaySettingsSource from './CanvasDisplaySettings.tsx?raw'
import canvasMenuItemsSource from './context-menu-items/canvas-menu-items.tsx?raw'
import colorRowSource from './context-menu-items/color-row.tsx?raw'
import edgeMenuItemsSource from './context-menu-items/edge-menu-items.tsx?raw'
import nodeMenuItemsSource from './context-menu-items/node-menu-items.tsx?raw'

const CORE_SURFACES = [
  ['CanvasContextMenu.tsx', contextMenuSource],
  ['CanvasDisplaySettings.tsx', displaySettingsSource],
  // The context menu's item builders — the facet doorway (nodePropertyItems)
  // moved into node-menu-items.tsx, so a guard left scanning only the old
  // file would go green while the rule it enforces is violated in the new
  // one.
  ['context-menu-items/color-row.tsx', colorRowSource],
  ['context-menu-items/edge-menu-items.tsx', edgeMenuItemsSource],
  ['context-menu-items/canvas-menu-items.tsx', canvasMenuItemsSource],
  ['context-menu-items/node-menu-items.tsx', nodeMenuItemsSource],
] as const

const DOMAIN_MARKS = [
  /'visual\./, // a facet key literal
  /resolveNodeShape/,
  /resolveCanvasEdgeStyle/,
  /VisualShapeFacet/,
  /VISUAL_[A-Z_]*KEY/,
]

describe('facet wiring guard', () => {
  for (const [name, source] of CORE_SURFACES) {
    it(`${name} names no facet domain`, () => {
      for (const mark of DOMAIN_MARKS) {
        expect(mark.test(source), `${name} matches ${mark}`).toBe(false)
      }
    })
  }
})
