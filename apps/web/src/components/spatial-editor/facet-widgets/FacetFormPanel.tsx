/**
 * The tier-1 editor's vessel: every facet a node can carry, rendered from
 * the form the engine derives from each schema.
 *
 * This is what closes the gap a quick band leaves — an agent may write any
 * registered facet through `wb_facet_set`, and before this panel a facet
 * with no hand-written widget was invisible to the person looking at the
 * canvas. A facet whose schema is outside the derivable vocabulary shows
 * its stored value read-only and says so, rather than pretending to edit
 * half of it.
 *
 * Writes go through the REGISTRY's own validation, so this panel can never
 * store a payload `wb_facet_set` would refuse.
 */
import { type FacetRegistry, resolveFacetContributions } from '@kamiazya/whiteboard-facet-engine'
import { DerivedFacetForm, type FacetEditor } from '@kamiazya/whiteboard-facet-ui'
import type { SpatialNode } from '@kamiazya/whiteboard-model'

const storedFacets = (node: SpatialNode): Record<string, unknown> =>
  node['x-whiteboard']?.facets ?? {}

import { cn } from '../../../lib/utils.js'
import { NODE_FACET_EDITORS } from './index.js'

export interface FacetFormPanelProps {
  /**
   * The node whose stored values the panel SHOWS. Writes go to the whole
   * selection (see `onWrite`) — the same split the context-menu bands had,
   * where the row reflected the node you opened on and applied to every
   * selected node.
   */
  /** `undefined` when nothing is selected: the inspector says so and stays open. */
  readonly node: SpatialNode | undefined
  /**
   * Tier-3 editors by facet key. A facet with one registered renders it
   * instead of the derived form — the picker the declared vocabulary
   * cannot yet express (today: the icon-plus-emoji badge picker).
   */
  readonly editors?: Readonly<Record<string, FacetEditor>>
  readonly registry: FacetRegistry
  /** `undefined` payload clears the facet, matching set-node-facet. */
  readonly onWrite: (key: string, payload: unknown) => void
  /**
   * Where the inspector sits: a column beside the canvas, or a sheet under
   * it. Decided from the EDITOR SHELL's width — the panel's own column comes
   * out of the canvas, so a breakpoint read off the canvas re-decides itself
   * every time it opens.
   */
  readonly variant?: 'dock' | 'sheet'
}

export function FacetFormPanel({
  node,
  registry,
  onWrite,
  editors = NODE_FACET_EDITORS,
  variant = 'dock',
}: FacetFormPanelProps) {
  const groups = node === undefined ? [] : resolveFacetContributions(registry, 'inspector.node')
  const stored = node === undefined ? {} : storedFacets(node)
  const body =
    node === undefined ? (
      <p className="text-xs text-muted-foreground">Select a node to edit its facets.</p>
    ) : (
      <div className="flex flex-col gap-3">
        {groups.map((group) => (
          <div key={group.namespace} className="flex flex-col gap-2">
            <span className="text-[0.65rem] font-medium tracking-wide text-muted-foreground">
              {group.displayName}
            </span>
            {group.facets.map((facet) => {
              const Editor = editors[facet.key]
              return Editor !== undefined ? (
                <div key={`${node.id}:${facet.key}`} className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium">{facet.definition.displayName}</span>
                  {/* RENDERED, not called. Calling it would splice a plugin's
                      hooks into this panel's own sequence, so two editors in
                      the same position share a hook slot — measured: swapping
                      one editor for another left the second reading the
                      first's state. */}
                  <Editor
                    value={stored[facet.key]}
                    // Straight through the registry, exactly like the derived
                    // form's own writer — a hand-written editor gets no shorter
                    // path to storage than a declared one.
                    write={(payload) => {
                      if (payload === undefined) return onWrite(facet.key, undefined)
                      const result = registry.validateFacetWrite(facet.key, payload)
                      if (result.ok) onWrite(facet.key, result.value)
                    }}
                  />
                </div>
              ) : (
                <DerivedFacetForm
                  // Keyed by NODE too: a draft belongs to the node it was typed
                  // against. Retargeting the panel without this reuses the
                  // instance, so an abandoned edit on one node would be shown —
                  // and saved — as another node's value.
                  key={`${node.id}:${facet.key}`}
                  facetKey={facet.key}
                  title={facet.definition.displayName}
                  stored={stored[facet.key]}
                  registry={registry}
                  onWrite={onWrite}
                />
              )
            })}
          </div>
        ))}
      </div>
    )
  // Same vessel convention as the other canvas overlays: hand-rolled and
  // inline-positioned, so it behaves identically where the app stylesheet
  // is absent (browser-mode component tests), and marked
  // `data-editor-overlay` so canvas gesture handlers ignore presses inside.
  return (
    <aside
      data-editor-overlay
      data-testid="facet-form-panel"
      aria-label="Facets"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.stopPropagation()
        const root = event.currentTarget.closest('[data-testid="spatial-editor"]')
        if (root instanceof HTMLElement) root.focus()
      }}
      className={cn('bg-background p-3 shadow-lg', variant === 'sheet' ? 'border-t' : 'border-l')}
      // A SIBLING of the canvas, not an overlay on it: the editor root is the
      // pointer surface, so a panel drawn over it swallows the press that
      // would have selected what is underneath. Measured at 540..892 of a
      // 900px editor before this — about 18% of the canvas unreachable.
      style={
        variant === 'sheet'
          ? {
              flex: '0 0 auto',
              maxHeight: '45%',
              overflowY: 'auto',
              paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))',
            }
          : {
              flex: '0 0 auto',
              width: 'min(22rem, 40%)',
              overflowY: 'auto',
            }
      }
    >
      {/* No dismiss control of its own. The panel is ABOUT the selected node,
          so deselecting is what closes it — the same thing a press on blank
          canvas already does to the context menu, and one semantic instead of
          two. Writes land as they are made, so there is nothing here to
          confirm either. */}
      <div className="pb-2">
        <span className="text-xs font-medium">Facets</span>
      </div>
      {body}
    </aside>
  )
}
