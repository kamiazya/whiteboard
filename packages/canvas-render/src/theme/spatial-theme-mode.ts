import { z } from 'zod'

// A request or a cache key that names a mode parses against this rather than
// re-spelling the enum, so a mode added here is one a caller can ask for.
// Its own module because the resolver interface names it too
// (spatial-appearance.ts), and spatial-theme.ts already imports that
// interface — declaring it there would close a type-only import cycle.
export const spatialThemeModeSchema = z.enum(['light', 'dark'])
export type SpatialThemeMode = z.infer<typeof spatialThemeModeSchema>
