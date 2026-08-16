# @kamiazya/whiteboard-model

OpenCanvas data-model Zod schemas (meta / facets / spatial / markdown /
workspace-tree / mdast subset). Named `model` — sibling to
`packages/canvas-viewer` in this monorepo's per-concern `packages/*`
layout — to make clear this package is the pure data-model contract, not
rendering or serialization. Private; not published to npm.

## What's here

- `meta.ts` — canvas envelope metadata (`format`, `schemaVersion`).
- `facets.ts` — core facets (`type`/`title`/`tags`/`view`), the
  `{domain}/{version}`-keyed extension facet bucket, and `facetsRaw` for
  unrecognized root frontmatter keys. The schema layer enforces that a key
  can never legally live in more than one of these buckets.
- `spatial.ts` — JSON Canvas 1.0-aligned node/edge schemas plus the
  `x-whiteboard` namespaced extension (canvas embeds only).
- `markdown.ts` — the markdown-format canvas envelope (plain-text body).
- `workspace-tree.ts` — the payload carried by each node of the workspace's
  Loro movable-tree, plus workspace-level metadata.
- `ids.ts` — canvas ID (canonical ULID) and node ID (nanoid-shaped) schemas.
- `mdast/` — an **internal, versioned** mdast subset (CommonMark + GFM +
  math + the `wikiLink`/`embed` custom nodes), reached through this
  package's `./internal` subpath export rather than the stable public `.`
  export. It is not published as a standalone contract yet.

## Types

Every exported type is `z.infer<typeof someSchema>` — there is no
hand-written type that parallels a schema. The one deliberate exception is
`mdast/index.ts`'s `MdastNode`: mdast is self-referential (a paragraph's
children can contain a link whose children are more phrasing content), and
Zod's `z.lazy()` cannot infer a recursive type back through itself without
an explicit type parameter to break the cycle for the compiler. `MdastNode`
is the type the schema is written against (`z.ZodType<MdastNode>`), and
`src/types.test.ts` pins that the two stay in sync.

## Testing

```bash
pnpm --filter @kamiazya/whiteboard-model test
pnpm --filter @kamiazya/whiteboard-model typecheck
```

Shared fast-check arbitraries live in `src/test-utils/` and are imported by
example and property tests rather than duplicated per file.
