/**
 * What lets a tag chip offer "Set colour…": the page's way to write the
 * workspace's tag library (ADR-0040 decision 5), provided once above the
 * editor so the Display panel's row, the note header's row and a selection's
 * row all reach it without each growing a prop. Absent — a keeper that cannot
 * write the library, or a surface with no provider — the chip is a plain chip.
 *
 * The provider also speaks the outcome in a polite live region, since the
 * colour lands in another document and the row itself changes nothing the
 * eye would notice.
 */
import type { CanvasColor } from '@kamiazya/whiteboard-model'
import { createContext, type ReactNode, useContext, useMemo } from 'react'
import { presetEntries } from '../../lib/color-presets.js'
import { AnnouncerRegion, useAnnouncer } from '../annotations/announcer.js'

type SetTagColour = (tag: string, colour: CanvasColor | undefined) => Promise<void>

const TagColouringContext = createContext<SetTagColour | null>(null)

export function useTagColouring(): SetTagColour | null {
  return useContext(TagColouringContext)
}

/** The colour's name in the words the colour row uses; a hex stands for itself. */
function colourName(colour: CanvasColor): string {
  return presetEntries.find((entry) => entry.key === colour)?.name.toLowerCase() ?? colour
}

export function TagColouringProvider({
  setTagColour,
  children,
}: {
  readonly setTagColour: SetTagColour | undefined
  readonly children: ReactNode
}) {
  const { announcement, announce } = useAnnouncer()
  const speaking = useMemo<SetTagColour | null>(
    () =>
      setTagColour === undefined
        ? null
        : async (tag, colour) => {
            await setTagColour(tag, colour)
            announce(
              colour === undefined
                ? `Tag '${tag}' colour removed`
                : `Tag '${tag}' coloured ${colourName(colour)}`,
            )
          },
    [setTagColour, announce],
  )
  return (
    <TagColouringContext.Provider value={speaking}>
      {children}
      {speaking !== null && <AnnouncerRegion text={announcement} />}
    </TagColouringContext.Provider>
  )
}
