import type { PaletteTokens, ThemeTokens } from '../theme-tokens.js'

const SAMPLE_LIGHT: PaletteTokens = {
  node: {
    text: { fill: '#ffffff', stroke: '#3d3d3d' },
    file: { fill: '#f5f5f5', stroke: '#3d3d3d' },
    link: { fill: '#eef4ff', stroke: '#3d3d3d' },
    group: { fill: 'none', stroke: '#3d3d3d' },
  },
  edgeStroke: '#3d3d3d',
  labelFill: '#2a2a2a',
  surface: '#fffdf7',
  cornerRadiusPx: 2,
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

const SAMPLE_DARK: PaletteTokens = {
  node: {
    text: { fill: '#141414', stroke: '#d4d4d4' },
    file: { fill: '#1f1f1f', stroke: '#d4d4d4' },
    link: { fill: '#1f1f1f', stroke: '#d4d4d4' },
    group: { fill: 'none', stroke: '#d4d4d4' },
  },
  edgeStroke: '#d4d4d4',
  labelFill: '#ececec',
  surface: '#0a0a0a',
  cornerRadiusPx: 2,
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
    pin: { fill: '#fbbf24', stroke: '#0a0a0a' },
    bubble: { fill: '#262626', stroke: '#fbbf24' },
  },
  proposal: { edge: '#818cf8', bubbleFill: '#262626' },
}

/**
 * A complete, valid token bundle for tests in this package and in every
 * consumer (the `./testing` subpath) — a fixture that satisfies the contract by construction, so a
 * test about registries or write validation never has to author a palette.
 */
export const SAMPLE_THEME_TOKENS: ThemeTokens = {
  ink: 'sketch',
  fontFamily: 'Patrick Hand',
  palette: { light: SAMPLE_LIGHT, dark: SAMPLE_DARK },
  defaults: { edgeRouting: 'curved' },
}
