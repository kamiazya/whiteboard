import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { FilePlus2, SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DOCUMENT_KIND_CHOICES } from './document-kind-choice.js'
import { NewDocumentDialog } from './NewDocumentDialog.js'

/**
 * The one door to creating a document, wherever creation is offered.
 *
 * A kind is fixed for the document's life — nothing in the codebase writes
 * `kind` a second time, so the only way back from the wrong one is delete
 * and start again, carrying whatever was written across by hand. (The delete
 * itself is recoverable — it evacuates to the Trash — but the KIND is not:
 * restoring returns the same document, of the same wrong kind.) A choice
 * that cannot be taken back must not be committed by a single press on an
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
 * dialog behind this menu's last entry so the two cannot name or draw the
 * same kind differently.
 */
export function NewDocumentMenu({
  onCreate,
  disabled,
  defaultPath,
  createError,
  onDismiss,
}: {
  /**
   * `options` arrives only from the dialog. A plain menu entry sends none,
   * and the host derives the address exactly as it always has — so the two
   * routes to a document differ in what the person said, not in what the
   * host does with their silence.
   */
  onCreate: (
    kind: DocumentKind,
    options?: { path: string; name: string | undefined },
  ) => void | Promise<void>
  /**
   * A create is in flight. Disables the ITEMS rather than the trigger:
   * with a menu in the way the second press lands on an item, and a menu
   * that can still be opened and read while a create resolves says more
   * than a dead button does.
   */
  disabled?: boolean
  /**
   * Where a create with no opinion would put the document. Its absence is
   * what hides the dialog entry: with nothing to pre-fill `Path` with, the
   * form could only open on a guess.
   */
  defaultPath?: string
  /** Shown inside the dialog, which stays open on a refusal. */
  createError?: string | null
  /**
   * The dialog was closed without creating anything. The host clears the
   * failure it was showing — a submission that was abandoned has no business
   * still being reported once the form carrying it is gone.
   */
  onDismiss?: () => void
}) {
  const [dialogOpen, setDialogOpen] = useState(false)
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
            // Voided through a catch, not bare: the host now REJECTS on a
            // refusal so the dialog can stay open, and these entries share
            // that host. An unhandled rejection fails a whole test file, and
            // the host is already reporting the failure its own way.
            onSelect={() => void Promise.resolve(onCreate(kind)).catch(() => {})}
            className="gap-2"
          >
            <Icon aria-hidden="true" className="size-4" />
            {label}
          </DropdownMenuItem>
        ))}
        {defaultPath !== undefined && (
          <>
            <DropdownMenuSeparator />
            {/* The ellipsis belongs HERE and only here: this is the one entry
                that opens something rather than acting. */}
            <DropdownMenuItem
              data-testid="new-document-specify"
              disabled={disabled}
              onSelect={() => setDialogOpen(true)}
              className="gap-2"
            >
              <SlidersHorizontal aria-hidden="true" className="size-4" />
              {/* Says "folder" because that is the word someone looking for
                  one searches the menu for, and this entry is the only place
                  they can put a document in one. Folders here ARE the path
                  (the dialog's Path help says so, and an emptied one is
                  pruned), so there is no "New folder" to offer instead — a
                  folder with nothing in it cannot exist to be created. */}
              Name and folder…
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
      {defaultPath !== undefined && (
        <NewDocumentDialog
          open={dialogOpen}
          defaultPath={defaultPath}
          busy={disabled}
          error={createError}
          onCancel={() => {
            setDialogOpen(false)
            onDismiss?.()
          }}
          // Closed only once the create SUCCEEDS. A refusal — a path
          // collision, most often — is the one a person can fix, and closing
          // on submit threw away the name and path they had typed and left
          // the reason behind a dialog that no longer existed. A host that
          // answers synchronously still closes immediately.
          onSubmit={(kind, options) => {
            void Promise.resolve(onCreate(kind, options)).then(
              () => setDialogOpen(false),
              () => {
                // Left open on purpose; the host reports why through
                // `createError`.
              },
            )
          }}
        />
      )}
    </DropdownMenu>
  )
}
