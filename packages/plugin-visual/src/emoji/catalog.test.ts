/**
 * The net under a DEFERRED catalog.
 *
 * A listed picker option is parsed by its facet's own schema at
 * `defineFacet` time, so a typo stops the plugin. A catalog's rows cannot
 * be — a loader is not loaded then, deliberately, because the definition
 * travels into the renderer, the layout worker and the MCP server. The
 * engine says as much and says whose job this is: the rows are this
 * plugin's data, so this plugin owes the check.
 *
 * Without it a generated row the schema refuses would ship as a cell that
 * silently does nothing — the exact failure a declared picker exists to
 * make impossible, reintroduced one level down.
 */
import { describe, expect, it } from 'vitest'
import { bundledFacetRegistry, visualPlugin, visualSymbolFacetSchema } from '../data.js'
import { EMOJI_VERSION } from './catalog-data.js'
import { EMOJI_JA, EMOJI_JA_TAG } from './catalog-ja.js'
import { emojiSections } from './sections.js'
import { emojiSlug } from './slug.js'

const sections = emojiSections()
const options = sections.flatMap((section) => section.options)

const symbolFacet = visualPlugin.facets.find((facet) => facet.name === 'symbol')
const listed = symbolFacet?.editor?.picker?.options ?? []

/**
 * The WHOLE catalog, which is this build's own icons plus Unicode's bands.
 * The two are checked differently: everything above is about the generated
 * Unicode data, and the category pictures are about the catalog a person
 * actually opens.
 */
const catalogSections = (await symbolFacet?.editor?.picker?.catalog?.load()) ?? []

describe('the generated emoji catalog', () => {
  /**
   * A floor on both dimensions, so a generator that silently produced an
   * empty table cannot report itself as "every row is valid". Well under
   * the 1914 of Unicode 17.0 — adding emoji is what Unicode does, and this
   * guard should welcome a bigger table rather than fail it.
   */
  it('carries the whole published set, in the categories it publishes', () => {
    expect(sections.length).toBeGreaterThanOrEqual(8)
    expect(options.length).toBeGreaterThanOrEqual(1500)
    expect(EMOJI_VERSION).toMatch(/^\d+\.\d+$/)
  })

  it('writes a payload the facet accepts for every single row', () => {
    const refused = options
      .filter((option) => !visualSymbolFacetSchema.safeParse(option.payload).success)
      .map((option) => option.label)
    expect(refused).toEqual([])
  })

  it('gives every row a name to search by and a character to draw', () => {
    const broken = options
      .filter(
        (option) =>
          option.label.trim() === '' ||
          option.glyph?.kind !== 'char' ||
          option.glyph.value.trim() === '',
      )
      .map((option) => option.label)
    expect(broken).toEqual([])
  })

  /**
   * Two cells writing one payload both light up when it is stored, and a
   * person cannot tell which of them they picked. `normalizePicker` refuses
   * this among LISTED options; nothing above can refuse it here.
   */
  it('offers each symbol once, across every category', () => {
    const chars = options.map((option) =>
      option.glyph?.kind === 'char' ? option.glyph.value : option.label,
    )
    expect(chars.length - new Set(chars).size).toBe(0)
  })

  /**
   * The five hardcoded emoji this catalog replaced sat in the listed
   * options, and leaving them there would have drawn each of them twice —
   * once in the always-visible row and once in the grid.
   */
  it('repeats nothing the definition already lists inline', () => {
    const inline = new Set(listed.map((option) => JSON.stringify(option.payload)))
    const repeated = options
      .filter((option) => inline.has(JSON.stringify(option.payload)))
      .map((option) => option.label)
    expect(repeated).toEqual([])
  })

  /**
   * A category chooser pictured by each band's FIRST EMOJI is what this
   * replaced, and it looked like a spilled palette: nine unrelated samples
   * at nine weights, some colour and some black-and-white, in a panel whose
   * every other control is a monochrome stroke. Guarded from both sides —
   * a Unicode release adding a group must not fall back to that silently,
   * and a mapping entry naming a group the data no longer has is a hole
   * somebody would write the next one into.
   */
  it('pictures every category in the panel own stroke language, and none it does not have', () => {
    const unpictured = catalogSections
      .filter((section) => section.glyph?.kind !== 'asset')
      .map((section) => section.label)
    expect(unpictured).toEqual([])
    const ids = catalogSections.map((section) =>
      section.glyph?.kind === 'asset' ? section.glyph.id : '',
    )
    const registered = new Set(bundledFacetRegistry.assetIds('icons'))
    expect(ids.filter((id) => !registered.has(id))).toEqual([])
    // And the geometry is registered for the categories that exist, not for
    // a tenth one left behind by a rename.
    const spare = [...registered].filter(
      (id) => id.startsWith('visual.category-') && !ids.includes(id),
    )
    expect(spare).toEqual([])
  })

  /**
   * And names each band in Japanese, which no per-emoji index can give:
   * CLDR annotates emoji, and its keywords are specific. Measured before
   * this, `食べ物` found 7 of Food & Drink's 131 rows and `旅行` 3 of 219.
   */
  it('names every category in Japanese too, since CLDR annotates emoji and not groups', () => {
    const unnamed = catalogSections
      .filter((section) => (section.keywords ?? []).join('').trim() === '')
      .map((section) => section.label)
    expect(unnamed).toEqual([])
  })

  /**
   * The vendored icons are a BAND rather than an always-visible row (user
   * decision, 2026-09-11): a row of monochrome line drawings directly above
   * a grid of full-colour emoji reads as two unrelated palettes, and it was
   * also indistinguishable from the category row below it, which picks a
   * view rather than a value. As a band, a grid is all monochrome or all
   * colour and never half of each.
   *
   * Guarded from both sides — the icons must be IN the catalog, and OUT of
   * the listed options — because putting them back in either place is a
   * one-line change that nothing else would notice.
   */
  it('offers this build own icons as the first band, and lists none of them inline', () => {
    expect(catalogSections[0]?.label).toBe('Icons')
    expect(catalogSections[0]?.options.length).toBeGreaterThanOrEqual(6)
    const inlineIcons = listed.filter(
      (option) => (option.payload as { kind?: string } | null)?.kind === 'icon',
    )
    expect(inlineIcons).toEqual([])
    // Absence is the one choice that belongs to no category, so it stays.
    expect(listed.map((option) => option.label)).toEqual(['No symbol'])
  })

  /**
   * The Japanese index, from both sides.
   *
   * CLDR's base file strips U+FE0F from every `cp` and the derived file
   * carries the sequences the base one lacks, so the generator does two
   * lookups and a union — each of which can silently half-miss. A locale
   * index covering half the catalog is a search that answers nothing for
   * the other half, and the shortfall is invisible in the generated file
   * and in the picker alike: a query just finds less than it should.
   */
  it('indexes every row in Japanese, and indexes nothing this build does not have', () => {
    const unindexed = options
      .filter((option) => (option.keywords ?? []).length < 3)
      .map((option) => option.label)
    expect(unindexed).toEqual([])
    const chars = new Set(
      options.map((option) => (option.glyph?.kind === 'char' ? option.glyph.value : '')),
    )
    const spare = EMOJI_JA.split('\n')
      .map((row) => row.slice(0, row.indexOf('\t')))
      .filter((char) => !chars.has(char))
    expect(spare).toEqual([])
    expect(EMOJI_JA_TAG).toMatch(/^release-\d+$/)
  })

  /**
   * What the index is FOR, asserted on the terms rather than on a count: a
   * full index of the wrong words would pass the case above. CLDR calls ⭐
   * スター and files 星 among its keywords, and 👍 carries いいね — which is
   * the whole reason keywords are indexed beside the display name.
   */
  it('carries the words a person actually types, not only the display name', () => {
    const termsFor = (char: string) =>
      options.find((option) => option.glyph?.kind === 'char' && option.glyph.value === char)
        ?.keywords?.[2] ?? ''
    expect(termsFor('⭐')).toContain('星')
    expect(termsFor('👍')).toContain('いいね')
    expect(termsFor('🚀')).toContain('ロケット')
  })

  /**
   * The shortcode vocabulary, which `:name:` will be written against.
   *
   * UNIQUENESS is the assertion that matters, over the whole table rather
   * than a sample: a slug naming two emoji is the one defect this
   * vocabulary must not have, and it is not hypothetical — stripping
   * punctuation outright collides `keycap: #` with `keycap: *`. A future
   * Unicode release that introduces a collision fails here instead of
   * shipping an ambiguous shortcode.
   */
  it('derives one shortcode per row, and no shortcode for two rows', () => {
    const slugs = options.map((option) => emojiSlug(option.label))
    expect(slugs.filter((slug) => slug === '')).toEqual([])
    const duplicated = slugs.filter((slug, at) => slugs.indexOf(slug) !== at)
    expect(duplicated).toEqual([])
    expect(slugs.length).toBe(new Set(slugs).size)
  })

  it('spells a shortcode the way a person would type it', () => {
    expect(emojiSlug('grinning face')).toBe('grinning_face')
    expect(emojiSlug('thumbs up')).toBe('thumbs_up')
    expect(emojiSlug('flag: Japan')).toBe('flag_japan')
    // An apostrophe JOINS rather than splits, and both spellings of one
    // appear in the published data.
    expect(emojiSlug('man\u2019s shoe')).toBe('mans_shoe')
    // The two characters that carry meaning are spelled out, which is what
    // keeps the two keycaps apart.
    expect(emojiSlug('keycap: #')).toBe('keycap_hash')
    expect(emojiSlug('keycap: *')).toBe('keycap_asterisk')
  })

  it('makes the shortcode findable, since a search splits on whitespace', () => {
    const thumbsUp = options.find(
      (option) => option.glyph?.kind === 'char' && option.glyph.value === '\u{1F44D}',
    )
    expect(thumbsUp?.keywords?.[0]).toBe('thumbs_up')
  })

  it('reaches the picker through the loader the definition declares', () => {
    // Unicode's bands, plus this build's own icons in front of them.
    expect(catalogSections.length).toBe(sections.length + 1)
    expect(catalogSections.slice(1)).toEqual(sections)
  })

  /** Built once: a picker mounts on every node selection. */
  it('builds its rows once, however many pickers ask for them', () => {
    expect(emojiSections()).toBe(sections)
  })
})
