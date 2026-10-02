import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The package lists every per-package scan iterates, and the file walk those
 * scans share. Kept out of the test files so the guards that police the lists
 * themselves (workspace completeness, the always-on table) can read the same
 * values `repo-coverage.test.ts` scans with.
 */

export const SHARED_LAYER_PACKAGES = [
  'packages/daemon-client',
  'packages/model',
  'packages/codec',
  'packages/canvas-render',
  'packages/ports',
  'packages/facet-engine',
  'packages/loro-adapter',
  'packages/search',
  'packages/server-core',
  'packages/workspace-index',
  'packages/history',
  'packages/scene',
  'packages/reference-graph',
  // Browser-runtime UI package, not a "shared" model/codec/... layer package
  // in the architecture-map.md sense, but scanned the same way — see its
  // `exemptBoundaryViolationKinds` and `exemptBoundaryFiles` entries in
  // architecture-map.ts for why DOM globals and one build-time `Buffer` use
  // don't trip the scan.
  'packages/canvas-viewer',
  // React packages, scanned for the same reason and with the same caveat as
  // canvas-viewer. Registering a package in `architecture-map.ts` does NOT
  // scan it — a `node:fs` import in `plugin-visual` once passed a full
  // arch-lint run for exactly that reason, and `every workspace is in a
  // per-package scan list` below is what now keeps the next package from
  // repeating it.
  'packages/facet-ui',
  'packages/plugin-visual',
]

/**
 * Composition roots. Their SOURCE is deliberately unscanned for the Node-side
 * ones (`packages/mcp-server`) and the DOM-side one `web-app-boundary.test.ts`
 * polices (`apps/web`) — they are the packages allowed `node:*`, DOM globals
 * and inversify — and their third-party surface is open by design, so they
 * cannot join the list above. Their dependency DIRECTION is still a rule, and
 * it was the one thing nothing checked: `apps/web` was absent from the map
 * entirely, so a shared package taking a dependency on it would have passed.
 */
export const COMPOSITION_ROOTS = ['apps/extension', 'apps/web', 'packages/mcp-server']

/**
 * Composition roots whose source is boundary-scanned like a shared package's:
 * they run only in the browser (a page script and an extension service
 * worker), so a `node:*` or inversify import is a defect in them exactly as in
 * `model`. `apps/extension` was the one root nothing read — a planted
 * `import 'node:fs'` in its relay passed every guard. Its direction and
 * dependency list stay with the composition-root checks, and its DOM globals
 * are exempt in `architecture-map.ts`.
 */
const BOUNDARY_SCANNED_ROOTS = ['apps/extension']

/** Every package whose own source `repo-coverage.test.ts` scans for boundary violations. */
export const BOUNDARY_SCAN_PACKAGES = [...SHARED_LAYER_PACKAGES, ...BOUNDARY_SCANNED_ROOTS]

// `extensions` defaults to `.ts` only, so the existing boundary/direction/
// allowed-deps scans below keep collecting exactly what they always did; the
// cycle scan further down opts into `.tsx` explicitly instead of widening
// this default for everyone.
export function listTsFiles(dir: string, extensions: readonly string[] = ['.ts']): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      // test-utils are dev surface, not shipping modules — the same line the
      // manifests already draw (ports keeps fast-check, daemon-client keeps
      // loro-crdt in devDependencies for exactly these helpers). A contract
      // suite legitimately mints real Loro bytes; holding it to the runtime
      // boundary would ban the test for being a good test. `.test.ts` files
      // are excluded below for the same reason.
      if (entry.name === 'test-utils') continue
      files.push(...listTsFiles(full, extensions))
      continue
    }
    const ext = extensions.find((candidate) => entry.name.endsWith(candidate))
    if (ext === undefined || entry.name.endsWith(`.test${ext}`)) continue
    files.push(full)
  }
  return files
}
