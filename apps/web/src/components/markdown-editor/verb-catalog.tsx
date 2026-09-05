/**
 * The editing catalog as menu rows — every verb in `MARKDOWN_EDITOR_VERBS`,
 * bands separated, the heading levels as one options row — for whichever
 * vessel opens it: the note editor's ⋯ and right-click, and the spatial
 * node editor's right-click. One builder, so a verb added to the table
 * reaches every catalog without a second edit, and so the two editors
 * cannot offer different verbs for the same text.
 *
 * The interactive verb takes the host's seam: a link picker that may be
 * absent (no targets to pick from → the verb's bracket wrap). Comment is
 * deliberately OUTSIDE the verb table (it writes nothing into the body; it
 * opens a conversation beside it) and rides in as its own seam, present
 * only when the host has a selection to be about.
 */
import type { StateCommand } from '@codemirror/state'
import { MessageSquarePlus } from 'lucide-react'
import type { ContextMenuItem } from '../spatial-editor/ContextMenu.js'
import {
  levelCommand,
  MARKDOWN_EDITOR_VERBS,
  type MarkdownVerbBand,
  selfContainedCommand,
} from './editor-verbs.js'
import { VERB_ICONS } from './verb-icons.js'

export interface VerbCatalogHost {
  /** Heading level of the caret's line, for the options row's selected entry. */
  readonly headingLevel: number
  /** Runs a document transform; the catalog closes itself around it. */
  readonly run: (command: StateCommand) => void
  /** Opens the host's link picker; absent when there is nothing to pick from. */
  readonly openLinkPicker?: () => void
  /** Opens a conversation about the selection; absent with no selection or no layer. */
  readonly composeThread?: () => void
  /** Called before any row's action, so the vessel can close. */
  readonly close: () => void
}

export function verbCatalogItems(host: VerbCatalogHost): readonly ContextMenuItem[] {
  const run = (command: StateCommand) => () => {
    host.close()
    host.run(command)
  }
  const items: ContextMenuItem[] = []
  let band: MarkdownVerbBand | null = null
  for (const spec of MARKDOWN_EDITOR_VERBS) {
    if (band !== null && spec.band !== band) items.push({ kind: 'separator' })
    band = spec.band

    if (spec.action.kind === 'levels') {
      items.push({
        kind: 'options',
        label: spec.label,
        options: spec.action.levels.map((option) => ({
          label: option.label,
          selected: host.headingLevel === option.level,
          onSelect: run(levelCommand(option.level)),
        })),
      })
      continue
    }

    // The one verb that asks before it writes. With nothing to pick from
    // there is nothing to ask, and it falls through to the wrap the table
    // declares for exactly that case.
    const icon = VERB_ICONS[spec.id]
    if (spec.action.kind === 'interactive' && host.openLinkPicker !== undefined) {
      const open = host.openLinkPicker
      items.push({
        label: spec.label,
        icon,
        onSelect: () => {
          host.close()
          open()
        },
      })
      continue
    }

    const command = selfContainedCommand(spec)
    // A verb with neither a dialog nor a self-contained command has no
    // plain row to render. Only `levels` is that today, and it returned
    // above; this is what keeps a future action kind from rendering a
    // dead menu item.
    if (command === null) continue
    items.push({ label: spec.label, icon, onSelect: run(command) })
  }

  if (host.composeThread !== undefined) {
    const compose = host.composeThread
    items.push({ kind: 'separator' })
    items.push({
      label: 'Comment on this',
      icon: <MessageSquarePlus aria-hidden />,
      onSelect: () => {
        host.close()
        compose()
      },
    })
  }
  return items
}
