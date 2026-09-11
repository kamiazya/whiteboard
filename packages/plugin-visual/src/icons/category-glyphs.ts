/**
 * One line-drawn glyph per emoji CATEGORY, on the lucide 24-grid beside the
 * vendored badge set (`icons.ts`, and see its README for provenance and
 * licence — these come from the same lucide version by the same recipe).
 *
 * Why not the category's own first emoji, which needs no geometry at all:
 * it made the chooser a row of nine unrelated pictures at nine different
 * weights, some full-colour and some black-and-white, because that is what
 * `🐵 🍇 🌍 👓 🏧 🏁` are. A person reads that as a mixed sample of the
 * content rather than as a control — and the panel around it is a monochrome
 * stroke language, so the row also read as the one place the app forgot its
 * own drawing.
 *
 * So the CHROME is monochrome stroke and the CONTENT is colour, and the
 * boundary between them is visible: everything you can browse WITH is drawn
 * the way the rest of the inspector is drawn; everything you can browse TO
 * is the emoji itself.
 *
 * A `line` in lucide's source is written here as a two-point `path`, because
 * `LucideIconElement` has no line arm and the stroked result is identical —
 * the round cap that turns `x1 9 -> x2 9.01` into a dot survives the
 * rewrite, which is what draws `smile`'s eyes.
 */
import type { LucideIconElement } from './icons.js'

export const CATEGORY_GLYPHS: Readonly<Record<string, ReadonlyArray<LucideIconElement>>> = {
  // The band holding this build's own vendored geometry. `shapes` rather
  // than one of the six themselves: a category pictured by its own first
  // member says "database" where it means "the icons".
  'category-icons': [
    {
      tag: 'path',
      d: 'M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z',
    },
    { tag: 'rect', x: 3, y: 14, width: 7, height: 7, rx: 1 },
    { tag: 'circle', cx: 17.5, cy: 17.5, r: 3.5 },
  ],
  'category-smileys': [
    { tag: 'circle', cx: 12, cy: 12, r: 10 },
    { tag: 'path', d: 'M8 14s1.5 2 4 2 4-2 4-2' },
    { tag: 'path', d: 'M9 9 L9.01 9' },
    { tag: 'path', d: 'M15 9 L15.01 9' },
  ],
  'category-people': [
    { tag: 'path', d: 'M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2' },
    { tag: 'path', d: 'M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2' },
    { tag: 'path', d: 'M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8' },
    {
      tag: 'path',
      d: 'M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15',
    },
  ],
  'category-nature': [
    {
      tag: 'path',
      d: 'M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z',
    },
    { tag: 'path', d: 'M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12' },
  ],
  'category-food': [
    { tag: 'path', d: 'm16 2-2.3 2.3a3 3 0 0 0 0 4.2l1.8 1.8a3 3 0 0 0 4.2 0L22 8' },
    { tag: 'path', d: 'M15 15 3.3 3.3a4.2 4.2 0 0 0 0 6l7.3 7.3c.7.7 2 .7 2.8 0L15 15Zm0 0 7 7' },
    { tag: 'path', d: 'm2.1 21.8 6.4-6.3' },
    { tag: 'path', d: 'm19 5-7 7' },
  ],
  'category-travel': [
    {
      tag: 'path',
      d: 'M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z',
    },
  ],
  'category-activities': [
    { tag: 'path', d: 'M11 7a16 16 20 0 1 10.98 4.362' },
    { tag: 'path', d: 'M12 12a13 13 0 0 1-8.66 5' },
    { tag: 'path', d: 'M16.83 13.634a16 16 0 0 1-9.267 7.328' },
    { tag: 'path', d: 'M20.66 17A13 13 0 0 0 12 12a13 13 0 0 1 0-10' },
    { tag: 'path', d: 'M8.17 15.366a16 16 0 0 1-1.713-11.69' },
    { tag: 'circle', cx: 12, cy: 12, r: 10 },
  ],
  'category-objects': [
    {
      tag: 'path',
      d: 'M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5',
    },
    { tag: 'path', d: 'M9 18h6' },
    { tag: 'path', d: 'M10 22h4' },
  ],
  'category-symbols': [
    { tag: 'path', d: 'M4 9 L20 9' },
    { tag: 'path', d: 'M4 15 L20 15' },
    { tag: 'path', d: 'M10 3 L8 21' },
    { tag: 'path', d: 'M16 3 L14 21' },
  ],
  'category-flags': [
    {
      tag: 'path',
      d: 'M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528',
    },
  ],
}
