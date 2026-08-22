import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { FilePlus2 } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DOCUMENT_KIND_CHOICES } from './document-kind-choice.js'

/**
 * The one door to creating a document, wherever creation is offered.
 *
 * A kind is fixed for the document's life — nothing in the codebase writes
 * `kind` a second time, so the only way back from the wrong one is delete
 * (behind a "there is no undo" confirmation) and start again. An
 * irreversible choice must not be committed by a single press on an
 * unlabeled glyph, which is what the two icon buttons this replaces did:
 * their names lived in tooltips, and a tooltip needs a pointer that a phone
 * does not have.
 *
 * So the press opens rather than commits, and every kind is confirmed
 * against a word. That also retires the icon-vocabulary problem instead of
 * solving it: the glyphs sit BESIDE text here, so no glyph has to be
 * legible enough at 16px to carry a meaning on its own.
 *
 * The kinds themselves come from `DOCUMENT_KIND_CHOICES`, shared with the
 * switcher's own creation entries so the two cannot drift apart again.
 */
export function NewDocumentMenu({
  onCreate,
  disabled,
}: {
  onCreate: (kind: DocumentKind) => void
  /**
   * A create is in flight. Disables the ITEMS rather than the trigger:
   * with a menu in the way the second press lands on an item, and a menu
   * that can still be opened and read while a create resolves says more
   * than a dead button does.
   */
  disabled?: boolean
}) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              // Holds the visible "New" inside it (WCAG 2.5.3), so a voice
              // user saying "click New" reaches the same control a sighted
              // one points at.
              aria-label="New document"
              className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 rounded border p-1.5 sm:pr-2.5"
            >
              <FilePlus2 aria-hidden="true" className="size-4" />
              {/* Free where there is room, dropped where the toolbar is
                  already fighting the search box for width. Below `sm` the
                  name is still one press away, on the menu this opens. */}
              <span className="hidden text-xs font-medium sm:inline">New</span>
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>New document</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        {/* No description line beside either kind: whoever reaches this menu
            has already met the empty-state chooser, and re-teaching on every
            create costs a phone two rows of height for nothing. */}
        {DOCUMENT_KIND_CHOICES.map(({ kind, label, Icon }) => (
          <DropdownMenuItem
            key={kind}
            data-testid={`new-document-${kind}`}
            disabled={disabled}
            onSelect={() => onCreate(kind)}
            className="gap-2"
          >
            <Icon aria-hidden="true" className="size-4" />
            {label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
