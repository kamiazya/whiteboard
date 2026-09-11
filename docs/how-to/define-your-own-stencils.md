# Define your own stencils

A **stencil** says what a box IS — a datastore, a gateway, a queue — and sets its colour and
silhouette together, so a drawing carries its own vocabulary instead of a colour scheme
invented per board.

Six ship with the bundled `visual` plugin:

| id | what it means | drawn as |
|---|---|---|
| `visual.actor` | whoever the drawing is for: a person, a client, a calling system | an ellipse |
| `visual.gateway` | where traffic enters or is routed: a gateway, a load balancer, a proxy | a hexagon |
| `visual.service` | something that runs and answers: an API, a worker, a function | a rectangle |
| `visual.datastore` | anything that holds state and is read back: a database, a bucket, a cache | a cylinder |
| `visual.queue` | something in flight rather than at rest: a queue, a topic, a stream | a parallelogram |
| `visual.external` | something the drawing does not own: a third-party API, a vendor service | a diamond |

Every pair differs on **both** channels a board draws — colour and silhouette — so the
distinctions survive a projector, a colour-blind reader and a greyscale print.

## Wearing one

`stencil` sits beside `op`, next to `node`, on `node.add` and `node.patch`:

```json
{
  "op": "node.add",
  "node": { "type": "text", "text": "orders", "width": 200, "height": 80 },
  "stencil": "visual.datastore"
}
```

`node.patch` dresses boxes that already exist and takes a selector, so one op can dress every
box in a group. An explicit `color` beside the stencil wins over the stencil's own.

`wb_facet_list` reports the ids this deployment has, and a refusal here lists them too — so
there is no list to memorise and none baked into the tool schema.

## Growing the vocabulary

When a drawing needs a word the six do not have, the workspace can define its own. A
**stencil library is a document**: an ordinary markdown document at the path `stencils`,
carrying the facet `visual.stencils/v0`.

```json
{
  "workspaceId": "<your workspace>",
  "documentIds": ["<the stencils document>"],
  "facets": {
    "visual.stencils/v0": {
      "stencils": {
        "lakehouse": {
          "displayName": "Lakehouse",
          "color": "3",
          "facets": { "visual.shape/v0": { "kind": "hexagon" } }
        }
      }
    }
  }
}
```

That is a `wb_facet_set` call — a library needs no special tool. Its stencils are then
`workspace.<name>`, so the one above is worn as `"stencil": "workspace.lakehouse"`, beside the
bundled six.

Because a library is a document:

- its body is yours, so the vocabulary can explain itself in the same file it is defined in;
- it syncs, versions and forks with the workspace, like anything else you write;
- a stencil in it is validated exactly as a bundled one is — a colour, and facet payloads
  checked against the plugin that owns them.

### What a stencil may not carry

A stencil says what a box is, never where it goes or what it says. Position, size and text are
refused by name. That is what keeps a vocabulary reusable: the same `lakehouse` dresses a box
anywhere on any board.

### Choosing colours and silhouettes

Two stencils a reader cannot tell apart are worth less than one. A board draws exactly two
channels — the node's **colour** and its **silhouette** — so give each member its own of each.
The silhouettes are `ellipse`, `diamond`, `hexagon`, `parallelogram`, `cylinder`, and the
default rectangle when the stencil sets no shape.

**Know the ceiling before you design against it.** JSON Canvas has six colours and there are
six silhouettes, so a set where every pair differs on *both* tops out at six members — and the
bundled six already spend all of both. Anything your library adds therefore repeats a colour
or a silhouette with one of them. That is a real limit of what a board draws, not an oversight,
and nothing refuses it: a library may collide deliberately.

Two ways to live with it:

- **Replace rather than extend.** If your domain has its own six nouns, define all of them in
  the library and use only those on a board. A board that never mixes the two vocabularies
  never shows the collision.
- **Keep the collision far apart.** A `lakehouse` that looks like the bundled `gateway` costs
  nothing on a board that has no gateway on it.

## Limits today

- **One library per workspace**, at the path `stencils`. The facet is what makes a document a
  library, but nothing can yet ask which documents carry a facet, so the path is the rule
  rather than a default.
- **`wb_facet_list` reports the deployment's stencils, not the workspace's.** A library's ids
  work; they are not yet listed. Until that lands, name them from the library document.
- **A stencil sets appearance only.** A default size is defined in
  [ADR-0034](../contributing/adr/0034-stencil-and-recipe.md) and not implemented.

← Back to [How-to guides](README.md)
