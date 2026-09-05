/**
 * The editing catalog as menu rows — every verb in `MARKDOWN_EDITOR_VERBS`,
 * bands separated, the heading levels as one options row — for whichever
 * vessel opens it: the note editor's ⋯ and right-click, and the spatial
 * node editor's right-click. One builder, so a verb added to the table
 * reaches every catalog without a second edit, and so the two editors
 * cannot offer different verbs for the same text.
 *
 * Interactive verbs take the host's seams: a link picker that may be
 * absent (no targets to pick from → the verb's bracket wrap), and a comment
 * composer that may be absent (→ the verb is left off; there is no wrap to
 * degrade to).
 */
import type { StateCommand } from '@codemirror/state'
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
  /** Opens the host's comment composer on the caret's scope; absent on a host without one. */
  readonly openCommentComposer?: () => void
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

    const icon = VERB_ICONS[spec.id]
    if (spec.action.kind === 'interactive') {
      const open = spec.action.hook === 'link' ? host.openLinkPicker : host.openCommentComposer
      if (open !== undefined) {
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
    }

    const command = selfContainedCommand(spec)
    // A verb with neither a surface nor a self-contained command has no
    // plain row to render: `levels` returned above, and an interactive verb
    // with no seam and no wrap is left off rather than drawn dead.
    if (command === null) continue
    items.push({ label: spec.label, icon, onSelect: run(command) })
  }
  return items
}
