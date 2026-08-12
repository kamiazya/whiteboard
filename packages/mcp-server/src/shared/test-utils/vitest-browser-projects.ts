import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Names of the vitest projects with `browser.enabled: true`, derived from the
// config files root vitest.config.ts wires up. This is the shared ground truth
// that docs-contract.test.ts (docs enumeration) and ci-verify-coverage.test.ts
// (package.json test:browser script) each check their own surface against, so
// none of the three can drift apart silently.
export function readBrowserProjectNames(repoRoot: string): string[] {
  const rootVitestConfig = readFileSync(join(repoRoot, 'vitest.config.ts'), 'utf8')
  const projectConfigPaths = [...rootVitestConfig.matchAll(/'((?:packages|apps)\/[^']+)'/g)].map(
    (match) => match[1],
  )
  return projectConfigPaths.flatMap((relativePath) => {
    const configContent = readFileSync(join(repoRoot, relativePath), 'utf8')
    if (!/browser:\s*\{\s*\n?\s*enabled:\s*true/.test(configContent)) return []
    const nameMatch = configContent.match(/name:\s*'([^']+)'/)
    if (!nameMatch) {
      throw new Error(`${relativePath} enables browser mode but declares no test.name`)
    }
    return [nameMatch[1]]
  })
}
