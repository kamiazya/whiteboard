// A registered theme asset's palette (the engine's token contract, ADR-0030
// decision 3) turned into the renderer's `SpatialPalette` for a mode. The two
// shapes are meant to be one, and the contract lives in
// the engine only so that ADR-0013 decision 8 can build on it without moving
// anything. The mapping is explicit field by field rather than a cast, which
// makes a REQUIRED field missing here a type error — and only that: a key
// optional on either side is absent from the literal without complaint. What
// ties the whole key set, optional keys and nested objects included, is the
// key-set type assertion in theme-asset.test.ts, which fails `tsc`; the
// round-trips there catch a bundled value the contract would strip.

import type { PaletteTokens } from '@kamiazya/whiteboard-facet-engine'
import type { SpatialPalette } from './spatial-palette.js'

export function paletteFromTokens(tokens: PaletteTokens): SpatialPalette {
  return {
    node: {
      text: { fill: tokens.node.text.fill, stroke: tokens.node.text.stroke },
      file: { fill: tokens.node.file.fill, stroke: tokens.node.file.stroke },
      link: { fill: tokens.node.link.fill, stroke: tokens.node.link.stroke },
      group: { fill: tokens.node.group.fill, stroke: tokens.node.group.stroke },
    },
    edgeStroke: tokens.edgeStroke,
    labelFill: tokens.labelFill,
    surface: tokens.surface,
    cornerRadiusPx: tokens.cornerRadiusPx,
    presets: {
      '1': { stroke: tokens.presets['1'].stroke, fill: tokens.presets['1'].fill },
      '2': { stroke: tokens.presets['2'].stroke, fill: tokens.presets['2'].fill },
      '3': { stroke: tokens.presets['3'].stroke, fill: tokens.presets['3'].fill },
      '4': { stroke: tokens.presets['4'].stroke, fill: tokens.presets['4'].fill },
      '5': { stroke: tokens.presets['5'].stroke, fill: tokens.presets['5'].fill },
      '6': { stroke: tokens.presets['6'].stroke, fill: tokens.presets['6'].fill },
    },
    syntax: {
      keyword: tokens.syntax.keyword,
      string: tokens.syntax.string,
      number: tokens.syntax.number,
      comment: tokens.syntax.comment,
    },
    comment: {
      pin: { fill: tokens.comment.pin.fill, stroke: tokens.comment.pin.stroke },
      bubble: { fill: tokens.comment.bubble.fill, stroke: tokens.comment.bubble.stroke },
    },
    proposal: { edge: tokens.proposal.edge, bubbleFill: tokens.proposal.bubbleFill },
    // Spread rather than assigned: the bundled palettes declare none, and a
    // present-but-undefined key would make the two shapes differ by a key.
    ...(tokens.markdownChrome === undefined ? {} : { markdownChrome: tokens.markdownChrome }),
  }
}
