import type { ThemeFont } from '@kamiazya/whiteboard-canvas-render'

/**
 * Where a family a theme names can be downloaded, or nothing when the
 * catalogue does not know it.
 *
 * A seam rather than a dependency, for the reason `measure` is one: the
 * catalogue lives in `daemon-client`, which this shared layer may not
 * import (it depends on server-core, so the edge would close a cycle).
 * The composition root wires it.
 */
export type ThemeFontSource = (family: string) => ThemeFont | undefined
