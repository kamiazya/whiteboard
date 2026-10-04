/**
 * "New workspace" for the signed-in person's workspace list in the web app a
 * server-mode keeper serves (ADR-0047).
 *
 * It asks the same `KeeperWorkspaces` seam the daemon's switcher menu is built
 * on (`hooks/use-shell-workspaces.ts`) rather than posting on its own, so a
 * workspace made here and one made there are the same call. The keeper makes
 * the caller the first member and owner, which is why this is the way a fresh
 * server's first person gets anywhere: nothing else in the app creates one.
 */
import { useEffect, useRef, useState } from 'react'
import { useCreateWorkspace } from '../../hooks/use-create-workspace.js'
import { isImeComposingKeydown } from '../../lib/ime-keydown.js'
import type { KeeperWorkspaces } from '../../lib/workspace-switcher-source.js'
import { Button } from '../ui/button.js'

function NameField({
  value,
  error,
  onChange,
  onEscape,
}: Readonly<{
  value: string
  error: string | null
  onChange: (next: string) => void
  onEscape: () => void
}>) {
  // The form exists because the person asked for it, so moving focus into
  // it is following them rather than taking it.
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
  }, [])
  return (
    <>
      <label htmlFor="new-workspace-name" className="text-sm text-muted-foreground">
        New workspace name
      </label>
      <input
        id="new-workspace-name"
        ref={input}
        enterKeyHint="done"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          // A conversion-confirming Enter is not "I am done".
          if (event.key === 'Enter' && isImeComposingKeydown(event.nativeEvent)) {
            event.preventDefault()
          }
          if (event.key === 'Escape') onEscape()
        }}
        aria-invalid={error !== null}
        aria-describedby={error === null ? undefined : 'new-workspace-error'}
        className="rounded-md border bg-background px-2 py-1 text-sm"
      />
      {error !== null && (
        <p id="new-workspace-error" role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </>
  )
}

function NewWorkspaceForm({
  workspaces,
  onCancel,
}: Readonly<{
  workspaces: KeeperWorkspaces
  onCancel: () => void
}>) {
  const [name, setName] = useState('')
  const { busy, error, submit, clearError } = useCreateWorkspace(workspaces)
  return (
    <form
      className="flex w-full max-w-md flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        submit(name)
      }}
    >
      <NameField
        value={name}
        error={error}
        onChange={setName}
        onEscape={() => {
          clearError()
          onCancel()
        }}
      />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || name.trim() === ''}>
          Create
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

export function NewWorkspaceControl({ workspaces }: Readonly<{ workspaces: KeeperWorkspaces }>) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  if (workspaces.source.create === undefined) return null
  if (open) {
    return (
      <NewWorkspaceForm
        workspaces={workspaces}
        onCancel={() => {
          setOpen(false)
          // The control that opened the form is where the person was.
          queueMicrotask(() => trigger.current?.focus())
        }}
      />
    )
  }
  return (
    <Button ref={trigger} variant="outline" onClick={() => setOpen(true)}>
      New workspace
    </Button>
  )
}
