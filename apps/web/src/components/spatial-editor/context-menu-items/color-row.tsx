/** Swatch/custom-hex color row shared by the edge and node context menus. */
import type { SpatialPresetKey } from '@kamiazya/whiteboard-canvas-render'
import { SPATIAL_DARK_PALETTE, SPATIAL_LIGHT_PALETTE } from '@kamiazya/whiteboard-canvas-render'
import type { CanvasColor } from '@kamiazya/whiteboard-model'
import { SquareDashed } from 'lucide-react'
import type { ResolvedTheme } from '../../../hooks/useThemeMode.js'
import type { ContextMenuOptionsItem } from '../ContextMenu.js'

export const presetEntries: readonly {
  readonly key: SpatialPresetKey
  readonly name: string
}[] = [
  { key: '1', name: 'Red' },
  { key: '2', name: 'Orange' },
  { key: '3', name: 'Yellow' },
  { key: '4', name: 'Green' },
  { key: '5', name: 'Cyan' },
  { key: '6', name: 'Purple' },
]

export function colorRow(
  theme: ResolvedTheme,
  current: CanvasColor | undefined,
  apply: (color: CanvasColor | undefined) => void,
): ContextMenuOptionsItem {
  // The swatch chips preview the CURRENT mode's preset strokes so
  // the picker shows what will actually render; the stored value
  // stays the semantic slot ('1'..'6'), never a resolved hex.
  const presetSwatches = (theme === 'dark' ? SPATIAL_DARK_PALETTE : SPATIAL_LIGHT_PALETTE).presets
  return {
    kind: 'options' as const,
    label: 'Color',
    options: [
      {
        label: 'default',
        ariaLabel: 'Default',
        icon: <SquareDashed />,
        selected: current === undefined,
        onSelect: () => apply(undefined),
      },
      ...presetEntries.map((entry) => ({
        label: entry.key,
        ariaLabel: entry.name,
        icon: (
          // Paint-critical props are inline, not utility classes:
          // a default-inline span ignores width/height entirely
          // (it laid out 0x0 live), and the chip must also paint
          // where the app stylesheet is absent.
          <span
            style={{
              display: 'block',
              width: 14,
              height: 14,
              borderRadius: '50%',
              backgroundColor: presetSwatches[entry.key].stroke,
            }}
          />
        ),
        selected: current === entry.key,
        onSelect: () => apply(entry.key),
      })),
    ],
    // The JSON Canvas color union is presets OR a 6-digit hex;
    // the native color input covers the hex half the swatches
    // cannot.
    customColor: {
      value: current?.startsWith('#') === true ? current : '#808080',
      ariaLabel: 'Custom color',
      selected: current?.startsWith('#') === true,
      onPick: (hex: string) => apply(hex as CanvasColor),
    },
  }
}
