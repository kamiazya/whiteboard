// The single font family name every spatial-theme label run declares
// (`resolveLabel().fontFamily` in spatial-theme.ts). mcp-server's export
// measurer and canvas-viewer's browser measurer both vendor a
// byte-identical Roboto face under a matching constant of their own
// (`EXPORT_FONT_FAMILY` / `VIEWER_FONT_FAMILY`) — they cannot import this
// package's constant directly without pulling their font-loading modules
// into canvas-render, so the two composition-root constants must keep
// naming this exact string. A prior drift here (export declared
// `'sans-serif'` while its measurer measured Roboto) shipped SVG whose
// coordinates were computed from one font's metrics but whose `font-family`
// attribute named another.
export const SPATIAL_THEME_FONT_FAMILY = 'Roboto'
