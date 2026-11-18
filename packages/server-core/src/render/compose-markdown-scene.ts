import type {
  CorePictureAsk,
  LayoutCore,
  LayoutRefusal,
  MeasureText,
  PicturedScene,
  ReferenceSeams,
  SpatialRenderStyle,
} from '@kamiazya/whiteboard-canvas-render'
import { layoutMarkdownDocumentPicture } from '@kamiazya/whiteboard-canvas-render'
import type { TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import { logRefusal } from './refusal-note.js'

/**
 * The measure a markdown document is laid out to. A page, not an object:
 * the same document theme the web preview uses, at a readable width a
 * consumer can show whole. Fixed rather than a parameter, so a render is a
 * pure function of the document plus what it references.
 */
const MARKDOWN_SCENE_WIDTH_PX = 720

export interface ComposeMarkdownSceneOptions {
  /** The bundle `referenceSeams` builds; absent keeps every embed a placeholder. */
  readonly references?: ReferenceSeams
  /**
   * Which look a canvas the body embeds is drawn in. A markdown host has no
   * theme of its own, so this reaches the embed's own `visual.theme/v0`
   * (ADR-0030 decision 5) rather than a host theme; absent draws clean.
   */
  readonly style?: SpatialRenderStyle
  /**
   * Whether a family a theme names may be declared, for the canvases the
   * body embeds — the measurer's answer (`fontAvailableOf`), the same one the
   * board gets rendered on its own. Absent declares the bundled family alone.
   */
  readonly fontAvailable?: (family: string) => boolean
  /**
   * The workspace's tag library, so a canvas the body embeds is coloured by
   * intent as it is rendered on its own (ADR-0040 decision 5).
   */
  readonly tagLibrary?: TagLibrary
  /** Lay out only the section under this heading (`#Heading`). */
  readonly section?: string
  /** The Rust core (`ServerDeps.layoutCore`), which lays the note out. */
  readonly core: LayoutCore
  /** Told when the core refused the note and the scene is the refusal; it is logged either way. */
  readonly onRefused?: (refusal: LayoutRefusal) => void
}

/**
 * A document's picture from its markdown body — canvas-render's
 * `layoutMarkdownDocumentPicture`, the same note layout the web preview takes,
 * answered by the Rust core's markdown entry with the SVG it draws of the
 * scene in the envelope `svg` names, in ONE call, with an embedded canvas
 * painted in the pinned light appearance every MCP render uses. `undefined`
 * for a `section` the body holds no heading for.
 */
export function composeMarkdownPicture(
  body: string,
  measure: MeasureText,
  options: ComposeMarkdownSceneOptions,
  svg: CorePictureAsk,
): PicturedScene | undefined {
  return layoutMarkdownDocumentPicture(body, noteOptionsOf(measure, options), svg)
}

function noteOptionsOf(
  measure: MeasureText,
  options: ComposeMarkdownSceneOptions,
): Parameters<typeof layoutMarkdownDocumentPicture>[1] {
  return {
    measure,
    maxWidth: MARKDOWN_SCENE_WIDTH_PX,
    mode: 'light',
    onRefused: (refusal: LayoutRefusal) => {
      logRefusal(refusal)
      options.onRefused?.(refusal)
    },
    ...(options.references !== undefined ? { references: options.references } : {}),
    ...(options.style !== undefined ? { style: options.style } : {}),
    ...(options.fontAvailable !== undefined ? { fontAvailable: options.fontAvailable } : {}),
    ...(options.tagLibrary !== undefined ? { tagLibrary: options.tagLibrary } : {}),
    ...(options.section !== undefined ? { section: options.section } : {}),
    core: options.core,
  }
}
