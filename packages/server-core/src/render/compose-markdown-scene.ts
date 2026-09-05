import type { MdastLayoutOptions, MeasureText, Scene } from '@kamiazya/whiteboard-canvas-render'
import {
  layoutMdastBlocks,
  MARKDOWN_THEME_DOCUMENT,
  SPATIAL_THEME_FONT_FAMILY,
} from '@kamiazya/whiteboard-canvas-render'
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { MCP_SCENE_APPEARANCE } from './compose-canvas-scene.js'

/**
 * The measure a markdown document is laid out to. A page, not an object:
 * the same document theme the web preview uses, at a readable width a
 * consumer can show whole. Fixed rather than a parameter, so a render is a
 * pure function of the document plus what it references.
 */
const MARKDOWN_SCENE_WIDTH_PX = 720

export interface ComposeMarkdownSceneOptions {
  readonly resolveEmbed?: MdastLayoutOptions['resolveEmbed']
  readonly resolveTitle?: MdastLayoutOptions['resolveTitle']
}

/**
 * Composes a document scene from a parsed markdown body — canvas-render's
 * `layoutMdastBlocks`, the same path the web preview, a canvas text node
 * and export all take, with an embedded canvas painted in the pinned light
 * appearance every MCP render uses.
 */
export function composeMarkdownScene(
  root: MdastRoot,
  measure: MeasureText,
  options?: ComposeMarkdownSceneOptions,
): Scene {
  return layoutMdastBlocks(root, {
    measure,
    maxWidth: MARKDOWN_SCENE_WIDTH_PX,
    fontFamily: SPATIAL_THEME_FONT_FAMILY,
    theme: MARKDOWN_THEME_DOCUMENT,
    canvasAppearance: MCP_SCENE_APPEARANCE,
    ...(options?.resolveEmbed !== undefined ? { resolveEmbed: options.resolveEmbed } : {}),
    ...(options?.resolveTitle !== undefined ? { resolveTitle: options.resolveTitle } : {}),
  })
}
