import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface VitestProject {
  configPath: string
  name: string | undefined
  isBrowser: boolean
}

// Every vitest project root vitest.config.ts wires up. The path regex matches
// any quoted `*.config.ts` rather than a `packages|apps` prefix, so tools/
// projects (tools/arch-lint) are included too.
export function readVitestProjects(repoRoot: string): VitestProject[] {
  const rootVitestConfig = readFileSync(join(repoRoot, 'vitest.config.ts'), 'utf8')
  const configPaths = [...rootVitestConfig.matchAll(/'([^']+\.config\.ts)'/g)].map(
    (match) => match[1],
  )
  return configPaths.map((configPath) => {
    const configContent = readFileSync(join(repoRoot, configPath), 'utf8')
    return {
      configPath,
      name: configContent.match(/name:\s*'([^']+)'/)?.[1],
      isBrowser: /browser:\s*\{\s*\n?\s*enabled:\s*true/.test(configContent),
    }
  })
}

// Names of the vitest projects with `browser.enabled: true`. This is the
// shared ground truth that docs-contract.test.ts (docs enumeration) and
// ci-verify-coverage.test.ts (package.json test:browser script) each check
// their own surface against, so none of the three can drift apart silently.
export function readBrowserProjectNames(repoRoot: string): string[] {
  return readVitestProjects(repoRoot)
    .filter((project) => project.isBrowser)
    .map((project) => {
      if (!project.name) {
        throw new Error(`${project.configPath} enables browser mode but declares no test.name`)
      }
      return project.name
    })
}
