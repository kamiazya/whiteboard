import type { RefObject } from 'react'
import type { Point } from '../../lib/spatial/viewport.js'
import type { GestureResult } from './gestures.js'

export interface ImageFileInputProps {
  readonly inputRef: RefObject<HTMLInputElement | null>
  readonly onAddImage: (file: File) => Promise<string | undefined>
  /** Set by "Set background image…": the group the picked file paints. */
  readonly pendingBackgroundGroupIdRef: RefObject<string | null>
  /** Set by the empty-canvas menu: where the picked image lands. */
  readonly pendingImagePointRef: RefObject<Point | null>
  readonly addImageFile: (file: File, at?: Point) => void
  readonly apply: (result: GestureResult) => void
}

/**
 * The one hidden file input every "add an image" affordance opens. A pick
 * either paints a group's background — when a group asked for one — or
 * becomes an image node, at the point the menu recorded or the free spot.
 * Both refs are spent on every pick, so a cancelled request cannot steer
 * the next one.
 */
export function ImageFileInput(props: ImageFileInputProps) {
  const { inputRef, pendingBackgroundGroupIdRef, pendingImagePointRef } = props
  return (
    <input
      ref={inputRef}
      data-editor-overlay
      data-testid="image-file-input"
      type="file"
      accept="image/*"
      className="hidden"
      onChange={(e) => {
        const file = e.target.files?.[0]
        // Cleared so picking the same file again still fires `change`.
        e.target.value = ''
        if (file === undefined) return
        const backgroundGroupId = pendingBackgroundGroupIdRef.current
        pendingBackgroundGroupIdRef.current = null
        if (backgroundGroupId !== null) {
          paintBackground(props, file, backgroundGroupId)
          return
        }
        props.addImageFile(file, pendingImagePointRef.current ?? undefined)
        pendingImagePointRef.current = null
      }}
    />
  )
}

function paintBackground(props: ImageFileInputProps, file: File, groupId: string): void {
  if (!file.type.startsWith('image/')) return
  void props.onAddImage(file).then((ref) => {
    if (ref === undefined) return
    props.apply({
      state: { kind: 'idle' },
      commands: [{ kind: 'set-group-background', id: groupId, background: ref }],
    })
  })
}
