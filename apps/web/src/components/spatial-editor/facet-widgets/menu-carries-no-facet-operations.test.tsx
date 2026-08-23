// The node context menu is an ACTION surface: entries run once and close it.
// A facet is state, not an action, so the menu carries a doorway to the
// inspector and nothing else — no band, no picker, no per-domain row.
//
// This is the rule that answers the next domain too: whatever ticketing or
// due-dates want, the menu's answer is the same doorway.
import { bundledFacetRegistry } from '@kamiazya/whiteboard-facet-engine'
import { describe, expect, it } from 'vitest'
import { nodePropertyItems } from './index.js'

describe('the node context menu', () => {
  const items = nodePropertyItems(bundledFacetRegistry, { openPanel: () => {} })

  it('offers a doorway and nothing that edits a facet', () => {
    // `options` rows ARE the editing affordance — one would put a facet
    // value one tap away from the action menu, which is the leak.
    expect(items.filter((i) => i.kind === 'options')).toEqual([])
    expect(items.filter((i) => i.kind === 'heading')).toEqual([])
  })

  it('is one entry, so a fifth domain does not make it a fifth line longer', () => {
    const entries = items.filter((i) => i.kind === undefined || i.kind === 'action')
    expect(entries).toHaveLength(1)
  })
})
