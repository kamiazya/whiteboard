# @kamiazya/whiteboard-model

Whiteboard document-model Zod schemas (document identity / facets / spatial /
markdown / annotations and proposals / mdast subset). Named `model` — sibling to
`packages/canvas-viewer` in this monorepo's per-concern `packages/*`
layout — to make clear this package is the pure data-model contract, not
rendering or serialization. Private; not published to npm.

## What's here

- `ids.ts` — document and workspace identity (canonical ULIDs, the workspace
  segment and display name, a document's path) and the node ID schema.
- `document-kind.ts` — what a document is, and so which structure it carries.
- `facets.ts` — core facets (`type`/`title`/`tags`/`view`), the
  `{domain}/{version}`-keyed extension facet bucket, and `facetsRaw` for
  unrecognized root frontmatter keys. The schema layer enforces that a key
  can never legally live in more than one of these buckets.
- `spatial.ts` — JSON Canvas 1.0-aligned node/edge schemas plus the
  `x-whiteboard` namespaced extension (canvas embeds only).
- `markdown.ts` — the markdown-format document envelope (plain-text body).
- `annotation.ts`, `text-anchor.ts`, `proposal.ts`, `proposal-apply.ts` — the
  annotation layer's identifiers, anchors and proposed changes.
- `mdast/` — an **internal, versioned** mdast subset (CommonMark + GFM +
  math + the `wikiLink`/`embed` custom nodes), reached through this
  package's `./mdast` subpath export rather than the stable public `.`
  export. It is not published as a standalone contract yet.

The rest of `src/` is small shared vocabulary (tags, trust, clipboard,
node content and resources, encoding helpers); `src/index.ts` is the list of
what the public export carries.

## Types

Every exported type is `z.infer<typeof someSchema>` — there is no
hand-written type that parallels a schema. The deliberate exception is the
mdast subset: mdast is self-referential (a paragraph's children can contain a
link whose children are more phrasing content), and Zod's `z.lazy()` cannot
infer a recursive type back through itself without an explicit type parameter
to break the cycle for the compiler. Each recursive content category in
`mdast/index.ts` (`MdastPhrasingContent`, `MdastFlowContent`, …) is the type
its schema is written against (`z.ZodType<…>`), and the annotation turns any
drift into a compile error.

## Testing

```bash
pnpm --filter @kamiazya/whiteboard-model test
pnpm --filter @kamiazya/whiteboard-model typecheck
```

Shared fast-check arbitraries live in `src/test-utils/` and are imported by
example and property tests rather than duplicated per file.
