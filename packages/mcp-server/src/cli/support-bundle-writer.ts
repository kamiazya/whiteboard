import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inspectOutputPath } from '../server/backup-restore.js'
import {
  type SupportBundle,
  supportBundleManifestSchema,
} from '../shared/diagnostics/support-bundle.js'
import { operatorJsonLine } from './operator-json.js'

// The one writer of a support bundle, for `daemon support-bundle` and
// `server support-bundle` alike: the same output-folder check, the same
// refusal sentences, and a file set read off the manifest's own `sections`.
//
// The folder is judged by `inspectOutputPath` (`requireDirectory`), which
// refuses a symlink ANYWHERE in the path, not only as its deepest existing
// part: `--output-dir` is the operator's own choice rather than a sandbox, but
// a link planted above it would still carry the bundle somewhere the operator
// did not name. A path that cannot be examined is a failure, never a refusal.
//
// The folder is checked, and created when missing, BEFORE the bundle is
// collected, so a slow doctor run is never spent on a folder that will be
// refused. The emptiness check and the writes are therefore apart in time;
// every write uses `wx`, so a file that appears in between is never
// overwritten. Nothing written is rolled back: deleting files in a folder the
// operator named is more dangerous than leaving a partial bundle there.
//
// The messages carry no path: a filesystem error names the path it failed
// on, so no error text ever reaches them.

const REFUSED_UNSAFE =
  'Could not write support bundle. The output path must be a directory, and no part of it a symlink.'
const REFUSED_NOT_EMPTY = 'Could not write support bundle. The output directory must be empty.'
const FAILED = 'Could not write support bundle.'

export type SupportBundleWriteOutcome =
  | { readonly kind: 'written'; readonly files: readonly string[] }
  | { readonly kind: 'not-written'; readonly message: string }

const notWritten = (message: string): SupportBundleWriteOutcome => ({
  kind: 'not-written',
  message,
})

export async function writeSupportBundle(
  outputDir: string,
  collect: () => Promise<SupportBundle>,
): Promise<SupportBundleWriteOutcome> {
  try {
    const state = await inspectOutputPath(outputDir, { requireDirectory: true })
    if (state === 'unsafe') return notWritten(REFUSED_UNSAFE)
    if (state === 'present' && (await readdir(outputDir)).length > 0) {
      return notWritten(REFUSED_NOT_EMPTY)
    }
    if (state === 'missing') await mkdir(outputDir, { recursive: true })
  } catch {
    return notWritten(FAILED)
  }

  const bundle = await collect()
  const sections: Readonly<Record<string, string>> = bundle.sections
  // The manifest goes last, so a reader that finds it can trust every section
  // it lists is already on disk.
  const files = [
    ...bundle.manifest.sections.map(
      (name: string) => [name, sectionContent(sections, name)] as const,
    ),
    ['manifest.json', operatorJsonLine(supportBundleManifestSchema, bundle.manifest)] as const,
  ]

  try {
    for (const [name, content] of files) {
      await writeFile(join(outputDir, name), content, { encoding: 'utf-8', flag: 'wx' })
    }
  } catch {
    return notWritten(FAILED)
  }
  return { kind: 'written', files: files.map(([name]) => name) }
}

function sectionContent(sections: Readonly<Record<string, string>>, name: string): string {
  const content = sections[name]
  // The type keys `sections` by the manifest's own names, so this is a broken
  // caller rather than an operator's mistake: thrown, not answered as a refusal.
  if (content === undefined) throw new Error(`support bundle section ${name} has no content`)
  return content
}
