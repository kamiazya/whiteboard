/**
 * The two theme ASSETS the bundled plugin ships (ADR-0030 decision 1), as
 * values of the engine's token contract. A document names one by id —
 * `visual.sketch`, `visual.neon` — through `visual.theme/v0`; nothing here
 * is stored in a document.
 *
 * Every asset carries BOTH mode palettes, because the canvas surface follows
 * the UI, never the theme: a neon document in a light UI is this file's
 * light half — a pale ground with saturated strokes and a coloured halo —
 * not a forced dark rectangle. Each half keeps the floors the bundled
 * palettes already pin (themes.test.ts): non-text strokes ≥ 3:1 against
 * the surface (WCAG 1.4.11), label text ≥ 4.5:1 against every fill it can
 * sit on (1.4.3). Hex only — the export rasterizer parses no oklch.
 */
import type { PaletteTokens, ThemeTokens } from '@kamiazya/whiteboard-facet-engine'

// ---- sketch: pencil on paper, chalk on a board ------------------------------

const SKETCH_LIGHT: PaletteTokens = {
  node: {
    text: { fill: '#ffffff', stroke: '#3d3d3d' },
    file: { fill: '#f5f5f5', stroke: '#3d3d3d' },
    link: { fill: '#eef4ff', stroke: '#3d3d3d' },
    group: { fill: 'none', stroke: '#3d3d3d' },
  },
  edgeStroke: '#3d3d3d',
  labelFill: '#2a2a2a',
  // Warm off-white: paper, against the app's neutral ground.
  surface: '#fffdf7',
  // A hand draws no fillet; the crisp fill underlay follows the strokes.
  cornerRadiusPx: 2,
  // Tailwind 600 strokes over 100 tints, as the bundled light palette — the
  // hatch is drawn in the stroke, so the tint only shows through the lines.
  presets: {
    '1': { stroke: '#dc2626', fill: '#fee2e2' },
    '2': { stroke: '#ea580c', fill: '#ffedd5' },
    '3': { stroke: '#d97706', fill: '#fef3c7' },
    '4': { stroke: '#059669', fill: '#d1fae5' },
    '5': { stroke: '#0891b2', fill: '#cffafe' },
    '6': { stroke: '#9333ea', fill: '#f3e8ff' },
  },
  syntax: { keyword: '#7e22ce', string: '#047857', number: '#c2410c', comment: '#5b6472' },
  comment: {
    pin: { fill: '#d97706', stroke: '#ffffff' },
    bubble: { fill: '#ffffff', stroke: '#d97706' },
  },
  proposal: { edge: '#4f46e5', bubbleFill: '#ffffff' },
}

const SKETCH_DARK: PaletteTokens = {
  node: {
    text: { fill: '#141414', stroke: '#d4d4d4' },
    file: { fill: '#1f1f1f', stroke: '#d4d4d4' },
    link: { fill: '#1f1f1f', stroke: '#d4d4d4' },
    group: { fill: 'none', stroke: '#d4d4d4' },
  },
  edgeStroke: '#d4d4d4',
  labelFill: '#ececec',
  surface: '#141414',
  cornerRadiusPx: 2,
  // Tailwind 400 strokes over 950 tints: chalk on a board.
  presets: {
    '1': { stroke: '#f87171', fill: '#450a0a' },
    '2': { stroke: '#fb923c', fill: '#431407' },
    '3': { stroke: '#fbbf24', fill: '#451a03' },
    '4': { stroke: '#34d399', fill: '#022c22' },
    '5': { stroke: '#22d3ee', fill: '#083344' },
    '6': { stroke: '#c084fc', fill: '#3b0764' },
  },
  syntax: { keyword: '#c084fc', string: '#34d399', number: '#fb923c', comment: '#9ba3af' },
  comment: {
    pin: { fill: '#fbbf24', stroke: '#141414' },
    bubble: { fill: '#262626', stroke: '#fbbf24' },
  },
  proposal: { edge: '#818cf8', bubbleFill: '#262626' },
}

/**
 * Hand-drawn: two-pass jittered outlines, hatched colour, a handwriting
 * face where one is installed (ADR-0011/0012 provide it by family name; a
 * surface without it declares the bundled family and says so), curved
 * routing and a dashed group frame by default.
 *
 * Yomogi (OFL) rather than a Latin-only handwriting face: a label on this
 * product's boards mixes Japanese and English, and a family that covers
 * only one script hands the other to the system font, so one label is
 * written by two hands. Chosen from a thirteen-face specimen of the same
 * canvas; the runner-up, Zen Kurenaido, is thinner and quieter.
 */
export const VISUAL_THEME_SKETCH: ThemeTokens = {
  ink: 'sketch',
  fontFamily: 'Yomogi',
  palette: { light: SKETCH_LIGHT, dark: SKETCH_DARK },
  defaults: {
    edgeRouting: 'curved',
    groupFrame: { strokeDasharray: '7 5' },
  },
}

// ---- neon: bright strokes with a halo, on a deep ground or a pale one ------

const NEON_DARK: PaletteTokens = {
  node: {
    text: { fill: '#0b1220', stroke: '#a5b4c7' },
    file: { fill: '#0b1220', stroke: '#a5b4c7' },
    link: { fill: '#0b1220', stroke: '#a5b4c7' },
    group: { fill: 'none', stroke: '#64748b' },
  },
  edgeStroke: '#7890ad',
  labelFill: '#f5fbff',
  surface: '#030711',
  cornerRadiusPx: 6,
  // Tailwind 300 strokes — brighter than the bundled dark palette's 400s,
  // because the halo repeats the stroke colour and a duller hue reads as a
  // smudge — over 950-ish tints dark enough to keep the glow the brightest
  // thing on the node.
  presets: {
    '1': { stroke: '#fda4af', fill: '#3f0d17' },
    '2': { stroke: '#fdba74', fill: '#431407' },
    '3': { stroke: '#fcd34d', fill: '#2a2008' },
    '4': { stroke: '#5eead4', fill: '#042f2e' },
    '5': { stroke: '#67e8f9', fill: '#062a33' },
    '6': { stroke: '#c4b5fd', fill: '#2e1065' },
  },
  syntax: { keyword: '#c4b5fd', string: '#5eead4', number: '#fdba74', comment: '#94a3b8' },
  comment: {
    pin: { fill: '#fbbf24', stroke: '#030711' },
    bubble: { fill: '#0f172a', stroke: '#fbbf24' },
  },
  proposal: { edge: '#a5b4fc', bubbleFill: '#0f172a' },
}

const NEON_LIGHT: PaletteTokens = {
  node: {
    text: { fill: '#ffffff', stroke: '#0284c7' },
    file: { fill: '#ffffff', stroke: '#0284c7' },
    link: { fill: '#ffffff', stroke: '#0284c7' },
    group: { fill: 'none', stroke: '#64748b' },
  },
  edgeStroke: '#64748b',
  labelFill: '#0f172a',
  surface: '#f8fafc',
  cornerRadiusPx: 6,
  // Tailwind 600 strokes over 100 tints: on a pale ground the halo reads
  // as a highlighter rather than a light, which is the honest light half.
  presets: {
    '1': { stroke: '#e11d48', fill: '#ffe4e6' },
    '2': { stroke: '#ea580c', fill: '#ffedd5' },
    '3': { stroke: '#d97706', fill: '#fef3c7' },
    '4': { stroke: '#0d9488', fill: '#ccfbf1' },
    '5': { stroke: '#0891b2', fill: '#cffafe' },
    '6': { stroke: '#7c3aed', fill: '#ede9fe' },
  },
  syntax: { keyword: '#6d28d9', string: '#0f766e', number: '#c2410c', comment: '#64748b' },
  comment: {
    pin: { fill: '#d97706', stroke: '#ffffff' },
    bubble: { fill: '#ffffff', stroke: '#d97706' },
  },
  proposal: { edge: '#4f46e5', bubbleFill: '#ffffff' },
}

/**
 * Neon: crisp geometry, a soft halo on every stroke, symbol and label in its
 * own colour, orthogonal routing by default so edges read as traces.
 */
export const VISUAL_THEME_NEON: ThemeTokens = {
  ink: 'clean',
  glow: { radiusPx: 6 },
  palette: { light: NEON_LIGHT, dark: NEON_DARK },
  defaults: { edgeRouting: 'orthogonal' },
}

/** The bundled theme assets by BARE name; the registry namespaces them to `visual.<name>`. */
export const VISUAL_THEMES = {
  sketch: VISUAL_THEME_SKETCH,
  neon: VISUAL_THEME_NEON,
} as const
