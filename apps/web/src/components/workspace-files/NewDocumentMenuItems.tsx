import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { SlidersHorizontal, Upload } from 'lucide-react'
import { DropdownMenuItem, DropdownMenuSeparator } from '../ui/dropdown-menu.js'
import { DOCUMENT_KIND_CHOICES } from './document-kind-choice.js'

function SpecifyItem({
  disabled,
  onSpecify,
}: {
  disabled?: boolean | undefined
  onSpecify: () => void
}) {
  return (
    <>
      <DropdownMenuSeparator />
      {/* The ellipsis belongs HERE and only here: this is the one entry
        that opens something rather than acting. */}
      <DropdownMenuItem
        data-testid="new-document-specify"
        disabled={disabled}
        onSelect={onSpecify}
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
  )
}

function ExtraItems({
  disabled,
  canSpecify,
  onSpecify,
  onImport,
}: {
  disabled?: boolean | undefined
  canSpecify: boolean
  onSpecify: () => void
  onImport: (() => void) | undefined
}) {
  return (
    <>
      {onImport !== undefined && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid="new-document-import"
            disabled={disabled}
            onSelect={onImport}
            className="gap-2"
          >
            <Upload aria-hidden="true" className="size-4" />
            Import file…
          </DropdownMenuItem>
        </>
      )}
      {canSpecify && <SpecifyItem disabled={disabled} onSpecify={onSpecify} />}
    </>
  )
}

/** The entries of the New dropdown a fine pointer gets; `NewDocumentMenu` owns what they open. */
export function NewDocumentMenuItems({
  disabled,
  onCreate,
  canSpecify,
  onSpecify,
  onImport,
}: {
  disabled?: boolean | undefined
  onCreate: (kind: DocumentKind) => void | Promise<void>
  canSpecify: boolean
  onSpecify: () => void
  onImport: (() => void) | undefined
}) {
  return (
    <>
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
      <ExtraItems
        disabled={disabled}
        canSpecify={canSpecify}
        onSpecify={onSpecify}
        onImport={onImport}
      />
    </>
  )
}
