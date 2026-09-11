// `pnpm test:distribution` has to build the WHOLE workspace, not this package.
//
// The suite it runs packs a tarball, and the prepack gate refuses without
// `dist/web-app/index.html` — which apps/web's postbuild copies in. This
// package's own build cleans `dist/` first, so building only this package
// deletes the very file the pack then demands:
//
//     ls dist/web-app/index.html                    -> present
//     pnpm --filter @kamiazya/whiteboard-mcp build  -> exit 0
//     ls dist/web-app/index.html                    -> No such file or directory
//
// The script read `pnpm build` for a long time and was therefore incapable of
// passing: it destroyed its own precondition every run. Nothing caught it
// because CI runs `test:distribution:only` after a full build (ci.yml) and
// never the wrapper, so its whole symptom was a manual command nobody had a
// reason to run. That is what this guard is for — the failure mode is
// silence, and a string is the only rung available short of running a
// multi-minute build here.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const scripts = (
  JSON.parse(readFileSync(join(__dirname, '../../../package.json'), 'utf-8')) as {
    scripts: Record<string, string>
  }
).scripts

describe('pnpm test:distribution', () => {
  it('exists, so a rename fails here rather than reporting a vacuous pass', () => {
    expect(scripts['test:distribution']).toBeDefined()
    expect(scripts['test:distribution:only']).toBeDefined()
  })

  it('builds the whole workspace before packing, not just this package', () => {
    const script = scripts['test:distribution'] ?? ''
    expect(
      script,
      'test:distribution must build from the workspace root (`pnpm -w run build`). ' +
        "This package's own build cleans dist/, taking apps/web's copied-in " +
        "dist/web-app with it, and the tarball smoke's prepack gate then refuses.",
    ).toContain('pnpm -w run build')
    expect(script).not.toMatch(/(^|&&\s*)pnpm build(\s|$)/)
  })
})
