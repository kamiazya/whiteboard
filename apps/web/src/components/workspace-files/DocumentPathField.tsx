import { useId } from 'react'
import { documentPathPrefix, workspacePath } from '../../lib/app-routes.js'

/**
 * A document's path, edited as the tail of the URL it actually is.
 *
 * The two forms that write a path — create and rename — had this field
 * twice, verbatim apart from one sentence of hint, which is the shape that
 * lets two sites quietly stop agreeing. It is one component so the URL head
 * in front of the box cannot appear on one of them alone.
 *
 * That head is READ from the router's own builders rather than written out
 * here, down to the `/w/` and `/d/` separators. A literal would go on reading
 * correctly for as long as it took somebody to move the grammar, and a form
 * that shows the wrong address confidently is worse than one that shows none.
 *
 * Absent when the workspace is not known — a page renders this before its
 * handle resolves, and `/w//d/` is not a truthful half of an address, it is
 * a wrong one.
 */
export function DocumentPathField({
  workspace,
  value,
  onChange,
  hint,
}: {
  /** The handle the address carries, or undefined while it is unknown. */
  workspace?: string | undefined
  value: string
  onChange: (next: string) => void
  /** What this particular form's path change does. */
  hint: string
}) {
  const inputId = useId()
  const prefixId = useId()
  const hintId = useId()
  const known = workspace !== undefined && workspace !== ''
  const prefix = known ? documentPathPrefix(workspace) : null

  // Sliced from the builders' own output, never spelled out: `head` is what
  // `workspacePath` puts before a handle, `handle` is that handle as the URL
  // encodes it, and `tail` is whatever `documentPathPrefix` adds after.
  const head = workspacePath('')
  const handle = known ? workspacePath(workspace).slice(head.length) : ''
  const tail = prefix === null ? '' : prefix.slice(head.length + handle.length)

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-sm font-medium">
        Path
      </label>
      {/* The border is on the ROW so the prefix reads as part of the field
          rather than as a caption sitting beside it. */}
      <div className="focus-within:ring-ring flex items-center rounded-md border bg-background px-2 py-1.5 font-mono text-sm focus-within:ring-1">
        {prefix !== null && (
          // Only the HANDLE gives way. A workspace with no segment is
          // addressed by its 26-character canonical id, and an unshrinkable
          // prefix at that length measured 269px of what had been a 398px
          // row — pushing the row past the dialog's own max width, which on a
          // narrow viewport is an overflow rather than a wide dialog.
          // Truncating the prefix as one string would instead eat `/d/` off
          // the end, which is the half that says where the text lands.
          <span
            id={prefixId}
            title={prefix}
            className="text-muted-foreground flex min-w-0 shrink items-center"
          >
            <span className="shrink-0">{head}</span>
            <span className="min-w-0 truncate">{handle}</span>
            <span className="shrink-0">{tail}</span>
          </span>
        )}
        <input
          id={inputId}
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          // The prefix is DESCRIBED, not aria-hidden. It is the only thing on
          // the form saying a path is an address, so hiding it would leave
          // that fact available to sighted readers alone.
          aria-describedby={prefix === null ? hintId : `${prefixId} ${hintId}`}
          // A floor, so a long handle cannot squeeze the box people type in
          // down to nothing: past this the handle truncates instead.
          className="min-w-[10ch] flex-1 bg-transparent outline-none"
        />
      </div>
      <span id={hintId} className="text-muted-foreground text-xs">
        {hint}
      </span>
    </div>
  )
}
