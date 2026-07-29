/**
 * Data-driven mirror of the "May depend on" column in
 * .claude/rules/architecture-map.md. Each entry lists every package this
 * package's non-dev dependencies are allowed to name — a package.json
 * dependency not on its own list is a direction violation. `devDependencies`
 * are exempt (tooling, not runtime coupling) per the same doc.
 */
export const ARCHITECTURE_MAP: Readonly<Record<string, readonly string[]>> = {
  '@kamiazya/whiteboard-canvas-model': [],
  '@kamiazya/whiteboard-canvas-codec': ['@kamiazya/whiteboard-canvas-model'],
  '@kamiazya/whiteboard-canvas-render': ['@kamiazya/whiteboard-canvas-model'],
  '@kamiazya/whiteboard-canvas-ports': ['@kamiazya/whiteboard-canvas-model'],
  '@kamiazya/whiteboard-canvas-workspace': [
    '@kamiazya/whiteboard-canvas-model',
    '@kamiazya/whiteboard-canvas-codec',
    '@kamiazya/whiteboard-canvas-ports',
  ],
  '@kamiazya/whiteboard-server-core': [
    '@kamiazya/whiteboard-canvas-model',
    '@kamiazya/whiteboard-canvas-codec',
    '@kamiazya/whiteboard-canvas-render',
    '@kamiazya/whiteboard-canvas-ports',
    '@kamiazya/whiteboard-canvas-workspace',
  ],
}

export function allowedDependencies(packageName: string): readonly string[] {
  return ARCHITECTURE_MAP[packageName] ?? []
}
