import { useCallback, useState } from 'react'
import { pictureExportOptionsOf } from '../lib/picture-export-options.js'
import type { PictureExportOptions } from '../lib/spatial/picture-options.js'
import { createUserSettingsStore } from '../lib/user-settings-store.js'

/**
 * The picture entries' remembered options. The page reads the store again at
 * the moment of an export, so this only has to keep the menu's checkboxes and
 * the store saying the same thing.
 */
export function usePictureExportPreferences(): {
  readonly options: PictureExportOptions
  readonly setScale: (scale: 1 | 2) => void
  readonly setBackground: (background: boolean) => void
} {
  const [store] = useState(() => createUserSettingsStore())
  const [options, setOptions] = useState(() => pictureExportOptionsOf(store.load()))

  const write = useCallback(
    (next: PictureExportOptions) => {
      store.update((current) => ({
        ...current,
        pictureExport: { doubleResolution: next.scale === 2, background: next.background },
      }))
      setOptions(next)
    },
    [store],
  )
  const setScale = useCallback((scale: 1 | 2) => write({ ...options, scale }), [write, options])
  const setBackground = useCallback(
    (background: boolean) => write({ ...options, background }),
    [write, options],
  )
  return { options, setScale, setBackground }
}
