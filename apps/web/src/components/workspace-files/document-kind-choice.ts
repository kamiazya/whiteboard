import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { FileText, LayoutDashboard, type LucideIcon } from 'lucide-react'

/**
 * What each kind is called and drawn as, wherever a person chooses one.
 *
 * One table because the surfaces that offer the choice kept inventing their
 * own: the document browser drew a canvas as a grid (the same glyph as the
 * view-layout toggle beside it) while the switcher drew BOTH kinds with the
 * same file-plus icon, which tells a reader nothing at all.
 *
 * The glyphs are the ones the LISTING surfaces already settled on for these
 * kinds (`ConnectionsChip`), so what you pick here is what you recognise in
 * the list afterwards.
 *
 * Canvas first: it is the order the empty-state chooser teaches the two
 * kinds in, and that chooser is where most people meet them.
 */
export const DOCUMENT_KIND_CHOICES: readonly {
  kind: DocumentKind
  label: string
  Icon: LucideIcon
}[] = [
  { kind: 'spatial', label: 'Canvas', Icon: LayoutDashboard },
  { kind: 'markdown', label: 'Markdown note', Icon: FileText },
]
