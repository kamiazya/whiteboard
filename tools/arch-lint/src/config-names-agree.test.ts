// Two kinds of name a reader or a bot is handed are read against what defines
// them rather than compared against a second hand-written list: the docker
// names the docs tell a person to type, and the dependency groups
// `.github/dependabot.yml` asks the bot to open.
//
// The docker names a self-hoster or a maintainer is told to type are DERIVED
// from what the compose file and the release workflow define, rather than
// compared against a second hand-written list.
//
// Three names had drifted apart with every test green: the compose file built
// `whiteboard-server:local` into a container nobody had named, the backup and
// restore commands stopped `whiteboard-server` and ran
// `whiteboard-server:latest` (neither exists after the quick start), and the
// cosign line verified `ghcr.io/<org>/whiteboard-server`, an image the release
// workflow never pushes. A recovery path whose first command fails is found at
// the moment it is needed, so the commands are read against their definitions.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { codeText } from './markdown-code.js'
import { REPO_ROOT, workspaceDirs } from './scan-roots.js'

function read(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), 'utf-8')
}

interface Compose {
  services: Record<string, { image?: string; container_name?: string }>
}

interface Workflow {
  jobs: Record<string, { steps?: { uses?: string; with?: { tags?: string } }[] }>
}

/** `owner/name` of this repository, which `${{ github.repository }}` resolves to. */
function repositorySlug(): string {
  const url = (JSON.parse(read('package.json')) as { repository: { url: string } }).repository.url
  const slug = /github\.com[/:]([^/]+\/[^/.]+)/.exec(url)?.[1]
  if (slug === undefined)
    throw new Error(`package.json repository.url names no GitHub slug: ${url}`)
  return slug
}

function defined(): { container: string; localImage: string; publishedRepos: Set<string> } {
  const service = (parseYaml(read('docker-compose.server.yml')) as Compose).services.whiteboard
  const steps = (parseYaml(read('.github/workflows/release.yml')) as Workflow).jobs[
    'docker-publish-sign'
  ]?.steps
  const tags = steps?.find((step) => step.uses?.startsWith('docker/build-push-action@'))?.with?.tags
  const publishedRepos = new Set(
    (tags ?? '')
      .replace(/\$\{\{\s*github\.repository\s*\}\}/g, repositorySlug())
      .split(',')
      .map((tag) => tag.trim().split(':')[0] ?? ''),
  )
  return {
    container: service?.container_name ?? '',
    localImage: service?.image ?? '',
    publishedRepos,
  }
}

const DOCKER_VERBS = new Set(['stop', 'start', 'restart', 'exec', 'logs', 'rm', 'kill', 'inspect'])
/** `docker run` flags that consume the next token, so it is not mistaken for the image. */
const VALUE_FLAGS = new Set(['-v', '-p', '-e', '--env-file', '--name', '--network', '--user'])

/** The container named by each `docker <verb>` command and the image named by each `docker run`. */
export function dockerNames(commands: string): { containers: string[]; images: string[] } {
  const containers: string[] = []
  const images: string[] = []
  for (const line of commands.replaceAll(/\\\n/g, ' ').split('\n')) {
    const words = line.trim().split(/\s+/)
    if (words[0] !== 'docker') continue
    const verb = words[1] ?? ''
    const rest = words.slice(2)
    const positional: string[] = []
    for (let i = 0; i < rest.length; i++) {
      const word = rest[i] ?? ''
      if (word.startsWith('-')) {
        if (VALUE_FLAGS.has(word)) i++
        continue
      }
      positional.push(word)
    }
    if (DOCKER_VERBS.has(verb) && positional[0] !== undefined) containers.push(positional[0])
    if (verb === 'run' && positional[0] !== undefined) images.push(positional[0])
  }
  return { containers, images }
}

/** Every `ghcr.io/...` reference a reader is told to type, with its tag when it has one. */
export function registryReferences(commands: string): { repo: string; tag: string | undefined }[] {
  return [...commands.matchAll(/\bghcr\.io\/([^\s:\\]+)(?::([^\s\\]+))?/g)].map((m) => ({
    repo: `ghcr.io/${m[1]}`,
    tag: m[2],
  }))
}

const DOCS = ['docs/how-to/self-host-with-docker.md', 'docs/contributing/releasing.md'] as const

const snippets = DOCS.map((path) => ({ path, commands: codeText(read(path)) }))

describe('the docker names the docs tell a reader to type', () => {
  const { container, localImage, publishedRepos } = defined()

  it('are defined by the compose file and the release workflow', () => {
    expect(container, 'a container_name on the compose service').not.toBe('')
    expect(localImage).not.toBe('')
    expect([...publishedRepos]).toEqual([`ghcr.io/${repositorySlug()}`])
  })

  it('reach the docs: the scan finds commands to check', () => {
    const found = snippets.flatMap(({ commands }) => {
      const names = dockerNames(commands)
      return [...names.containers, ...names.images, ...registryReferences(commands)]
    })
    expect(found.length).toBeGreaterThan(5)
  })

  it.each(snippets)('$path stops, execs into and reads logs of the compose container', ({
    commands,
  }) => {
    expect(dockerNames(commands).containers.filter((name) => name !== container)).toEqual([])
  })

  it.each(snippets)('$path runs only an image the compose file builds or the release pushes', ({
    commands,
  }) => {
    const unknown = dockerNames(commands).images.filter((image) => {
      const [repo = '', tag] = image.split(':')
      return image !== localImage && !(publishedRepos.has(repo) && tag !== undefined)
    })
    expect(unknown).toEqual([])
  })

  it.each(snippets)('$path pulls and verifies only the image the release pushes', ({
    commands,
  }) => {
    const unknown = registryReferences(commands).filter(({ repo }) => !publishedRepos.has(repo))
    expect(unknown).toEqual([])
  })

  it('a fabricated snippet naming an unknown container and image is flagged', () => {
    const names = dockerNames(
      'docker stop nowhere\ndocker exec -it nowhere node x\ndocker run --rm -d \\\n  -v /a:/data \\\n  --env-file .env \\\n  nowhere:latest',
    )
    expect(names.containers).toEqual(['nowhere', 'nowhere'])
    expect(names.images).toEqual(['nowhere:latest'])
    expect(registryReferences('cosign verify ghcr.io/o/nowhere:t')).toEqual([
      { repo: 'ghcr.io/o/nowhere', tag: 't' },
    ])
  })
})

interface DependabotConfig {
  updates: {
    'package-ecosystem': string
    groups?: Record<string, { patterns?: string[] }>
  }[]
}

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const

/** Every dependency name any workspace manifest, the root's included, declares. */
function declaredDependencyNames(): Set<string> {
  const names = new Set<string>()
  for (const dir of ['.', ...workspaceDirs()]) {
    const manifest = JSON.parse(read(`${dir}/package.json`)) as Record<
      string,
      Record<string, string> | undefined
    >
    for (const field of DEPENDENCY_FIELDS) {
      for (const name of Object.keys(manifest[field] ?? {})) names.add(name)
    }
  }
  return names
}

/** Dependabot's `*` matches any run of characters, including `/`. */
export function matchesPattern(pattern: string, name: string): boolean {
  const body = pattern
    .split('*')
    .map((part) => part.replaceAll(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${body}$`).test(name)
}

describe('dependabot.yml groups', () => {
  const config = parseYaml(read('.github/dependabot.yml')) as DependabotConfig
  const names = declaredDependencyNames()
  const groups = config.updates
    .filter((update) => update['package-ecosystem'] === 'npm')
    .flatMap((update) => Object.entries(update.groups ?? {}))
    .flatMap(([group, { patterns = [] }]) => patterns.map((pattern) => ({ group, pattern })))

  it('reach the manifests: the scan finds groups and declared dependencies', () => {
    expect(groups.length).toBeGreaterThan(4)
    expect(names.size).toBeGreaterThan(100)
  })

  // A group whose dependency was retired keeps reading as live config while
  // grouping nothing, and nothing else ever says so.
  it.each(groups)('$group pattern "$pattern" matches a declared dependency', ({ pattern }) => {
    expect([...names].some((name) => matchesPattern(pattern, name))).toBe(true)
  })

  it('a pattern is a glob over the whole name', () => {
    expect(matchesPattern('@types/*', '@types/node')).toBe(true)
    expect(matchesPattern('vite', 'vitest')).toBe(false)
    expect(matchesPattern('vite-*', 'vite-plugin-pwa')).toBe(true)
    expect(matchesPattern('@excalidraw/*', '@types/excalidraw')).toBe(false)
  })
})

// `linked-versions` merges the plugin and mcp-server components into one
// release PR, and release-please titles a grouped PR `chore: release main`:
// neither a component nor a version appears in it. A doc that promises a
// component-and-version title describes a PR that is never opened.
describe('the release PR title', () => {
  const RETIRED_FORM = /chore\(main\): release/
  const DESCRIBERS = [
    'CONTRIBUTING.md',
    'docs/contributing/releasing.md',
    '.github/workflows/release.yml',
    'tools/check-pr-title.mjs',
  ] as const

  it('is grouped by the linked-versions plugin the docs rely on', () => {
    const config = JSON.parse(read('release-please-config.json')) as {
      plugins?: { type: string }[]
    }
    expect(config.plugins?.some((plugin) => plugin.type === 'linked-versions')).toBe(true)
  })

  it.each(DESCRIBERS)('%s names the grouped title, not a per-component one', (path) => {
    const text = read(path)
    expect(text).toContain('chore: release main')
    expect(text).not.toMatch(RETIRED_FORM)
  })
})
