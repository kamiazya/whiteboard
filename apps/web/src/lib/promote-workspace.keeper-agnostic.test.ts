// @vitest-environment node
/**
 * The transfer names its destination a KEEPER, not a daemon.
 *
 * Why this is a test and not only a rename. ADR-0023 makes the destination
 * of a promote the workspace's new keeper, and the keeper axis
 * (`.claude/rules/vocabulary.md`) already has a word for that. The module
 * was written when the only possible destination was the local daemon, so
 * it says `daemonBaseUrl` — and a reader of that name concludes the
 * transfer is daemon-shaped when in fact the destination has always been a
 * plain parameter.
 *
 * The user decision this serves (2026-09-22): a browser transfers DIRECTLY
 * to a SaaS or a self-hosted server, with no daemon hop. Nothing in the
 * transfer's behaviour has to change for that; the name is what was
 * standing in the way of seeing it.
 *
 * Scoped to the transfer path on purpose. `daemonBaseUrl` appears 964 times
 * across 127 files, and almost all of them — connections, settings, replica
 * keys, passkeys, pairing — really are about a daemon and are left alone.
 * `vocabulary.md`: fix what your change touches, never widen a diff to
 * sweep a package you had no reason to open.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(import.meta.dirname, '..', '..', 'src')

/**
 * The transfer's own module, and nothing else.
 *
 * Its CALLER is deliberately out of scope. `PromoteWorkspaceSection` also
 * feeds the passkey surface and the persisted replica registry, both of
 * which are genuinely daemon-shaped, and the registry's `daemonBaseUrl` is
 * a STORED key — renaming one in place discards a reader's whole payload,
 * which `vocabulary.md` records as a measured loss. Those are their own
 * increments with their own migrations.
 */
const TRANSFER_PATH = ['lib/promote-workspace.ts'] as const

/**
 * Comments stripped, because the module's own header has to spell the old
 * name in order to explain the rename — the same exemption `vocabulary.md`
 * takes for itself as "the one place that has to spell the retired words in
 * order to retire them". What the guard is about is the IDENTIFIER.
 */
function source(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('the transfer names its destination a keeper', () => {
  it('reads a tree worth reading', () => {
    // A path that stopped resolving would report every file below as clean.
    for (const rel of TRANSFER_PATH) {
      expect(source(rel).length, rel).toBeGreaterThan(500)
    }
  })

  it.for([...TRANSFER_PATH])('%s names no daemonBaseUrl', (rel) => {
    expect(source(rel)).not.toContain('daemonBaseUrl')
  })

  it.for([...TRANSFER_PATH])('%s names keeperBaseUrl instead', (rel) => {
    // The destination IS the workspace's new keeper (ADR-0023), so the
    // keeper axis already has the word. Nothing is invented here.
    expect(source(rel)).toContain('keeperBaseUrl')
  })

  it('leaves the connection surface alone', () => {
    // A later sweep that renames it fails here and is asked to be its own
    // increment with its own review, per `vocabulary.md`.
    expect(source('lib/replica-store.ts')).toContain('daemonBaseUrl')
  })

  it("does not touch the migration's own spelling of the stored key", () => {
    // Pinned to the DECLARATION rather than to the file, because
    // `user-settings-store.ts` spells `daemonBaseUrl` many times and a
    // `toContain` over the whole file passes while a sweep renames some of
    // them. Measured: renaming four occurrences left the file-level check
    // green — the same membership-versus-count weakness review caught in
    // `chunk-size-one-place.test.ts` earlier the same day.
    //
    // `legacyPromotionResultSchema` is what the v3 migration reads an OLD
    // payload through, so it is untouchable twice over: a stored shape, and
    // a migration's own text, which `vocabulary.md` calls history and never
    // renamed.
    const settings = source('lib/user-settings-store.ts')
    const legacy = /const legacyPromotionResultSchema = z[\s\S]*?\n {2}\}\)/.exec(settings)
    expect(legacy, 'legacyPromotionResultSchema is no longer declared').not.toBeNull()
    expect(legacy?.[0]).toContain('daemonBaseUrl: httpUrl.optional()')
  })

  it('the caller passes the new name without adopting it', () => {
    // One line at the call site: the section keeps its own `daemon`
    // vocabulary, because what it holds IS a daemon, and names the
    // parameter by what the parameter means.
    const caller = source('components/settings/PromoteWorkspaceSection.tsx')
    expect(caller).toContain('keeperBaseUrl: daemon.baseUrl')
  })
})
