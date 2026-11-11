# Bundled assets

The four JSON files here are the values of the `visual` plugin's asset tables
(`visual.themes`, `visual.icons`, `visual.stencils`) and the ONLY place those
values are written. TypeScript reads them through `../asset-table.ts`, which
judges each entry against the engine's schema and hands back the original
object; the Rust core embeds the same bytes (`crates/core/plugin-visual`). A
number or a key moved here moves both realms and nothing else.

**Key order is part of the file.** A registry lists assets in registration
order and a picker draws them in it, and a payload keeps the order its schema
gives. Do not let a formatter sort these files; `pnpm lint` does not. There
is no comment syntax, so the design reasoning is below, beside the file it
explains.

## themes.json

The two theme assets (ADR-0030 decision 1), as values of the engine's token
contract. A document names one by id (`visual.sketch`, `visual.neon`) through
`visual.theme/v0`; nothing here is stored in a document.

Every asset carries BOTH mode palettes, because the canvas surface follows the
UI, never the theme: a neon document in a light UI is that file's light half,
a pale ground with saturated strokes and a coloured halo, not a forced dark
rectangle. Each half keeps the floors the bundled palettes already pin
(`themes.test.ts`): non-text strokes at least 3:1 against the surface (WCAG
1.4.11), label text at least 4.5:1 against every fill it can sit on (1.4.3).
Hex only: the export rasterizer parses no oklch.

**sketch** is pencil on paper and chalk on a board. Hand-drawn: two-pass
jittered outlines, hatched colour, a handwriting face where one is installed
(ADR-0011/0012 provide it by family name; a surface without it declares the
bundled family and says so), and a dashed group frame by default. Yomogi (OFL)
rather than a Latin-only handwriting face, because a label on this product's
boards mixes Japanese and English and a family covering one script hands the
other to the system font, so one label would be written by two hands.

- The stroke is 1.4px, a pencil line and not a hairline: the two passes are
  painted at this weight and a lighter second one, and a 1px stroke doubled
  read as a ruled line drawn twice.
- Routing defaults to `straight`: a pencil changes how a line is drawn, not
  where it goes, and the routing a person picks stays theirs. Curved was tried
  and read as a second decision the theme was making on the author's behalf.
- Light: warm off-white paper; corner radius 2 (a hand draws no fillet; the
  crisp fill underlay follows the strokes); Tailwind 600 strokes over 100
  tints, with the hatch drawn in the stroke so the tint only shows through the
  lines; a warm pencil grey for markdown furniture, drawn in the same hand as
  the boxes around it.
- Dark: Tailwind 400 strokes over 950 tints, chalk on a board; the same warm
  neutral for furniture, lifted to read on the board.

**neon** is bright strokes with a halo, on a deep ground or a pale one: crisp
geometry, a soft halo on every stroke, symbol and label in its own colour, and
orthogonal routing by default so edges read as traces.

- The halo is the element's own paint blurred, so a hairline has almost
  nothing to bloom from: at 1px the peak of the blur is a quarter of the
  stroke's opacity. Hence 1.8px.
- Dark: Tailwind 300 strokes per kind (sky, violet, emerald), because the halo
  repeats the stroke colour and a grey one read as a smudge: an unpainted board
  was the one thing on the theme that did not glow. The kinds tell apart by hue
  rather than by fill, which stays near-black so the glow is the brightest
  thing on the node. Presets are brighter than the bundled dark palette's 400s
  for the same reason, over tints dark enough to keep that true.
- Light: the same three hues at 600 over faint tints, and a sky edge: on a pale
  ground the halo is a highlighter, so the stroke under it carries the colour
  itself.
- Markdown furniture is slate in both halves, deliberately NOT one of the
  theme's lit hues: a code panel and a quote rail are furniture, and a board
  whose every rule glows leaves the strokes nothing to be brighter than.

## stencils.json

The stencil assets ([ADR-0034](../../../../docs/contributing/adr/0034-stencil-and-recipe.md)):
a stencil is a named appearance a drawing applies to ONE box, so that a
vocabulary is authored once rather than invented per board. The measurement
that made this worth building is ADR-0033's first reading: across the whole
drawing corpus every board spends ONE treatment and owes every construct it
declares. The channel was not under-used, it was unopened.

**Why these six and not more.** ADR-0034's granularity rule: a stencil earns
its place when a reader of the finished drawing would name the box as a KIND,
and when more than one drawing would use it. These are the nouns an
architecture diagram is made of. A larger set is not a better one: ADR-0033's
columns charge a treatment that carries no declared distinction as `excess`,
so a vocabulary grows when a drawing needs a word it does not have.

**No default SIZE, deliberately.** ADR-0034 defines a stencil as an appearance
plus a default size; the size half is omitted because it would move
`density`, `envelopePx` and the gap columns at the same time as the facet
columns, and the scoreboard is meant to say whether the appearance channel
alone helps. Size lands additively when a stencil needs one (ADR-0013: an
optional field needs no version bump).

**No emoji badges**, though `visual.symbol` allows them. The PNG export path
rasterises through resvg against the vendored Roboto alone (ADR-0011), so an
emoji badge exports as tofu, and a bundled vocabulary must draw the same
everywhere it is drawn. A user-authored library may spend emoji knowing that.

**Every member spends SILHOUETTE and nothing else**
([ADR-0036](../../../../docs/contributing/adr/0036-semantic-axes.md) §5). A
channel carries at most one semantic axis, and the kind axis has one of its
own; colour therefore belongs to whatever second axis the drawing declares,
healthy-versus-failing on an infrastructure board being the case that named
the rule. Colour is the channel most often lost (a projector, a colour-blind
reader, a greyscale print), so a set leaning on both really leans on
silhouette for any reader who lost it.

The badge is not a channel either, but every member carries one, drawn at the
top of the box (`render.ts`). Two kinds that differ by silhouette alone, an
octagon beside a hexagon, are hard to tell apart at a glance, and a mark is
the second signal that survives a lost colour channel. It stays out of the
discriminability count because the same symbol reaches the minimap and a file
row, where it is the only thing that can say which kind a box is.

Every silhouette is distinct, which puts the set at the CEILING of the
silhouette vocabulary: six kinds, six members, none of them the plain rect an
undressed box already draws. A seventh stencil needs a seventh silhouette,
not a seventh entry.

- `datastore`: anything that holds state and is read back (database, bucket,
  cache). Cylinder.
- `service`: something that runs and answers (an API, a worker, a function).
  The octagon, because it is the polygon nearest the rounded rectangle every
  notation draws a running component as, and `NodeOutline` has no rounded-rect
  kind; it is also the calmest silhouette available, which suits the box an
  architecture drawing has most of. A stencil with no silhouette and no colour
  is indistinguishable from an undressed box, which ADR-0033 scores as
  `deficit`.
- `gateway`: where traffic enters or is routed. Hexagon.
- `queue`: something in flight rather than at rest. Parallelogram.
- `actor`: whoever the drawing is FOR. Ellipse.
- `external`: something the drawing does not own. The diamond by elimination,
  the silhouette the other five leave; it reads acceptably because nothing
  else in an architecture drawing is a diamond, which is what "not ours" wants
  to say.

## icons-lucide.json

The vendored lucide geometry; provenance and the extend-me recipe are
`../icons/README.md`. Keys are sorted, which `BUILT_IN_ICON_NAMES` (the
published list of what a node may wear as a badge) relies on, and
`assets.test.ts` holds.

## icons-glyphs.json

Registered geometry that is not a badge a node may wear, in registration order
after the lucide set.

- `edge-*`, `line-jumps-*`: what `visual.edges/v0`'s own picker draws with, one
  specimen per routing style and one per line-jump setting. Drawn rather than
  vendored because lucide has none, and because these are pictures of what
  THIS facet does, so the plugin that owns the vocabulary owns the drawing.
  The lucide 24-grid and its stroke conventions, so a row of these sits beside
  the vendored icons. Each routing specimen runs the same corner-to-corner span
  and differs only in HOW it gets there, the one thing the option is choosing.
  Both jump specimens share a crossed line kept short of the box's edges, so the
  hop's shoulders read as a hop and not as an arrowhead on a long shaft.
- `category-*`: one line-drawn glyph per emoji CATEGORY. Not the category's own
  first emoji, which needed no geometry: it made the chooser a row of nine
  unrelated pictures at nine weights, some colour and some not, which reads as
  a sample of the content rather than a control. The CHROME is monochrome
  stroke and the CONTENT is colour. `category-icons` is `shapes` and not one of
  the six themselves: a category pictured by its own first member says
  "database" where it means "the icons". A lucide `line` is written as a
  two-point `path`, since the element set has no line and the stroked result is
  identical; the round cap that turns a zero-length segment into a dot
  survives, which is what draws `smile`'s eyes.
- `signature`: the product's squiggle, which `visual.theme/v0`'s picker draws
  once per theme in that theme's own ink, so the row says "the whiteboard,
  drawn this way". A node would be the wrong specimen: a rounded rectangle at
  16px shows a theme's corner radius and nothing else, while what a person
  chooses is how a LINE is put down. The path is the one `apps/web/BRAND.md`
  governs, which `tools/arch-lint`'s `brand-signature.test.ts` holds equal. It
  carries its own box, cropped to the mark plus room for a halo rather than
  BRAND.md's 88x56 frame: at the 16px a picker gives a glyph the standard frame
  spends nearly half its width on margin and the squiggle comes out a hairline.
  The mark spans x 20 to 68 and y 25 to 44 (the second curve's own extremum,
  not its control point), and ten units of margin is what the glow pass needs
  at its width without clipping. Registered separately because it does not
  share the lucide 24-grid.
