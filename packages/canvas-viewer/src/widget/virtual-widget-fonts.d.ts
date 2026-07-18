// Ambient declaration for the build-time virtual module produced by the
// `widget-fonts` Vite plugin in vite.widget.config.ts (see
// build-fonts-module.ts for the generated shape). TypeScript has no other
// way to resolve a virtual module id.
declare module 'virtual:widget-fonts' {
  interface WidgetFontDescriptor {
    family: string
    weight?: string
    style?: string
    unicodeRange?: string
    dataUri: string
  }

  export const WIDGET_FONTS: readonly WidgetFontDescriptor[]
  export const FONT_FILENAME_MAP: Readonly<Record<string, string>>
}
