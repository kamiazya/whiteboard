/**
 * One carried tag as a chip. A scoped tag on a surface that can write the
 * workspace's tag library opens a small menu — "Set colour…" over the colour
 * row's swatches, plus "No colour" — and shows the colour the library
 * declares for it; any other chip is the label alone.
 */
import { SPATIAL_DARK_PALETTE, SPATIAL_LIGHT_PALETTE } from '@kamiazya/whiteboard-canvas-render'
import { type CanvasColor, parseScopedTag } from '@kamiazya/whiteboard-model'
import { declaredColourOf, type TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import { Check, SquareDashed, X } from 'lucide-react'
import { useState } from 'react'
import { presetEntries } from '../../lib/color-presets.js'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu.js'
import { useTagColouring } from './tag-colouring.js'

type Preset = (typeof presetEntries)[number]['key']

const isPreset = (colour: CanvasColor | undefined): colour is Preset =>
  colour !== undefined && colour in SPATIAL_LIGHT_PALETTE.presets

/** A swatch in the strokes the board draws, light or dark by the document's `.dark` class. */
function Swatch({ preset }: { readonly preset: Preset }) {
  const dot = (stroke: string, className: string) => (
    <span
      aria-hidden
      className={className}
      style={{ width: 14, height: 14, borderRadius: '50%', backgroundColor: stroke }}
    />
  )
  return (
    <>
      {dot(SPATIAL_LIGHT_PALETTE.presets[preset].stroke, 'block dark:hidden')}
      {dot(SPATIAL_DARK_PALETTE.presets[preset].stroke, 'hidden dark:block')}
    </>
  )
}

/** The menu's second view: no colour, then each preset, the current one marked. */
function ColourChoices({
  declared,
  apply,
}: {
  readonly declared: CanvasColor | undefined
  readonly apply: (colour: CanvasColor | undefined) => void
}) {
  return (
    <>
      <DropdownMenuItem onSelect={() => apply(undefined)}>
        <SquareDashed aria-hidden />
        No colour
        {declared === undefined && <Check aria-hidden className="ml-auto" />}
      </DropdownMenuItem>
      {presetEntries.map((entry) => (
        <DropdownMenuItem key={entry.key} onSelect={() => apply(entry.key)}>
          <Swatch preset={entry.key} />
          {entry.name}
          {declared === entry.key && <Check aria-hidden className="ml-auto" />}
        </DropdownMenuItem>
      ))}
    </>
  )
}

function ColourMenu({
  tag,
  declared,
  apply,
}: {
  readonly tag: string
  readonly declared: CanvasColor | undefined
  readonly apply: (colour: CanvasColor | undefined) => void
}) {
  const [view, setView] = useState<'root' | 'colour'>('root')
  return (
    <DropdownMenu onOpenChange={(open) => open && setView('root')}>
      <DropdownMenuTrigger
        aria-label={`Tag ${tag} menu`}
        className="inline-flex items-center gap-1 hover:text-foreground"
      >
        {isPreset(declared) && <Swatch preset={declared} />}
        {tag}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {view === 'root' ? (
          <DropdownMenuItem
            onSelect={(event) => {
              // Keeps the menu open: the swatches are the same menu's next view.
              event.preventDefault()
              setView('colour')
            }}
          >
            Set colour…
          </DropdownMenuItem>
        ) : (
          <ColourChoices declared={declared} apply={apply} />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function TagChip({
  tag,
  library,
  onRemove,
  onColourFailed,
}: {
  readonly tag: string
  readonly library: TagLibrary | undefined
  readonly onRemove: () => void
  readonly onColourFailed: (message: string) => void
}) {
  const setTagColour = useTagColouring()
  const scoped = parseScopedTag(tag)
  const declared =
    scoped === undefined || library === undefined ? undefined : declaredColourOf(library, scoped)
  const apply = (colour: CanvasColor | undefined) => {
    setTagColour?.(tag, colour).catch((err: unknown) =>
      onColourFailed(
        `Could not save the colour for ${tag}${err instanceof Error ? `: ${err.message}` : ''}`,
      ),
    )
  }
  return (
    <span className="bg-muted text-muted-foreground inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs">
      {scoped !== undefined && setTagColour !== null ? (
        <ColourMenu tag={tag} declared={declared} apply={apply} />
      ) : (
        tag
      )}
      <button
        type="button"
        aria-label={`Remove tag ${tag}`}
        onClick={onRemove}
        className="hover:text-foreground"
      >
        <X aria-hidden className="size-3" />
      </button>
    </span>
  )
}
