# Library-First Workflow

For icon-heavy diagrams, **reach for a library before stacking your own rectangles**.

## Quick Map

- Basic flow: saved library -> catalog -> save -> insert
- Trial insert: when the item name alone is not enough
- Metadata: store aliases / notes / scales
- Brand adaptation: keep provider icons intact and adapt surrounding elements
- Safe to skip: generic flows / matrices / screenshot reviews

## Basic Flow

```js
// 1) Check whether the library is already saved
user_library_list()

// 2) If not, search the official catalog
library_catalog_list({ query: "aws serverless" })
library_catalog_list({ query: "kubernetes" })

// 3) Save a promising library
user_library_save({ name: "aws-serverless", fromUrl: "<item.url>" })

// 4) Inspect contents before inserting
library_list_items({ userLibraryName: "aws-serverless" })
library_insert_item({
  userLibraryName: "aws-serverless",
  itemIndex: 0,
  canvasId,
  target: { x: 200, y: 200 },
})
```

## Trial Insert

Some libraries are hard to judge from `library_list_items` alone.
Do not place uncertain icons straight onto the production canvas. Verify icon identity and scale on a scratch canvas first.

```js
canvas_create({ slug: "gcp-icon-scratch" })

library_insert_batch({
  libraryUrl,
  canvasId: scratchId,
  groupAs: "trial-gcp-icons",
  items: [
    { itemIndex: 0, target: { x: 80,  y: 80 }, groupAs: "trial-row-1" },
    { itemIndex: 1, target: { x: 240, y: 80 }, groupAs: "trial-row-1" },
    { itemIndex: 2, target: { x: 400, y: 80 }, groupAs: "trial-row-1" },
  ],
})

viewport_set({ canvasId: scratchId, mode: "fit", padding: 40 })
export_png({ canvasId: scratchId, padding: 24 })
```

For GCP / AWS / network icon libraries in particular, this extra step materially improves diagram quality.

## What To Judge

Do not stop after finding an index. Check at least these:

- identity: is this actually the service you intended?
- visual scale: does it feel too large or too small next to nearby icons or boxes?

Even inside one library, item bounding boxes and whitespace vary a lot.

## Save Reusable Knowledge

Alias-based insert does not exist yet, so use metadata as the place to store knowledge.

```js
meta = user_library_metadata_get({ name: "gcp-icons" })
user_library_metadata_set({
  name: "gcp-icons",
  revision: meta.revision,
  aliases: { cloud_run: 13 },
  notes: { "13": "2nd row, stateless compute icon. Use smaller than default." },
  scales: { "13": 0.9 },
})
```

- Next time, read `cloud_run -> 13` from metadata and pass that explicit index to `library_insert_item` / `library_insert_batch`
- `scales` are auto-applied when inserting through `userLibraryName`
- `libraryUrl` / `libraryPath` do not carry metadata, so provide explicit `scale` when needed
- Explicit `scale` overrides metadata recommendations

When saving size guidance, leave short context in `notes` such as "default feels oversized" or "keep half a step smaller than the label box," and store the numeric recommendation in `scales`.

## Brand Adaptation

Reflect the brand through labels / frames / legends / palettes, not by altering the icon itself.
Do not recolor or distort provider icons in ways that hurt recognizability.

Principles:

- preserve provider icon recognizability
- if brand color and semantic color conflict, semantic color wins
- use branding as a reading aid, not as decoration

## When To Use A Subagent

If you cannot rely on a dedicated Claude Code subagent, hand [`library-research-prompt-template.md`](./library-research-prompt-template.md) to a General Subagent and let it handle `trial insert -> export -> compare -> metadata save`.

That research should cover not only icon index / scale but also **how the diagram should adapt brand and design guidelines as a composition**.

## Skip This Workflow When

- generic rectangle + arrow flows
- comparison matrices
- before/after diffs
- screenshot annotation

## Must Use This Workflow When

- cloud-provider-specific architecture diagrams
- network topology
- diagrams that communicate primarily through domain-specific icons

If search turns up nothing relevant, that is still useful information. Confirming that there is no good match is enough to justify drawing it manually.
