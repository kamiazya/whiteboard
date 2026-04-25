import { resolve } from 'node:path'

export function getExcalidrawFontCopyTarget(packageRoot: string): {
  src: string
  dest: string
} {
  return {
    // Files under dist/prod/fonts live in subdirectories, so use a recursive glob.
    src: resolve(
      packageRoot,
      'node_modules/@excalidraw/excalidraw/dist/prod/fonts/**/*',
    ),
    dest: 'fonts',
  }
}
