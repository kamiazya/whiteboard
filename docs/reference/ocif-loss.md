<!-- Generated from packages/codec/src/spatial/ocif-projection.ts. Do not edit by hand:
     `pnpm vitest run --project codec-node loss-table -u` regenerates it. -->

# What an OCIF export keeps, and what it costs

[OCIF v0.7.0](https://spec.canvasprotocol.org/) is a **third projection** of a whiteboard
document ([ADR-0036](../contributing/adr/0036-ocif-projection.md)), beside JSON Canvas 1.0 and
OKF Markdown. The claim first-party support makes is the same one ADR-0035 made for JSON
Canvas: a round-trip property over the expressible subset, and this table for everything else.

The model can hold **45** field positions. **24** of them are something OCIF can
state in its own vocabulary; the remaining **21** ride an extension of ours.

**Nothing is dropped**, and that is the difference worth knowing before choosing a format.
OCIF’s conformance rules require a reader to preserve an extension it does not understand, so a
document that goes out to a foreign tool and comes back still holds every position it left
with. A strict JSON Canvas export, by contrast, deletes its extension key outright.

Read this beside [the JSON Canvas table](json-canvas-loss.md): the rows are the same positions,
and where the two disagree is where the choice of format costs a reader something real.

## Stated by OCIF v0.7.0 — 15

A conforming reader gets these and UNDERSTANDS them. A facet bucket is in here because OCIF’s `data[]` is the same mechanism — one ordinary extension per facet, keyed by the facet key — not because it is tolerated on a vendor key.

| field | what a reader gets |
| --- | --- |
| `edges[].facets/*` | stated by the format |
| `edges[].from.node` | stated by the format |
| `edges[].id` | stated by the format |
| `edges[].to.node` | stated by the format |
| `facets/*` | stated by the format |
| `nodes[].embed.documentId` | stated by the format |
| `nodes[].facets/*` | stated by the format |
| `nodes[].file` | stated by the format |
| `nodes[].height` | stated by the format |
| `nodes[].id` | stated by the format |
| `nodes[].text` | stated by the format |
| `nodes[].url` | stated by the format |
| `nodes[].width` | stated by the format |
| `nodes[].x` | stated by the format |
| `nodes[].y` | stated by the format |

## Stated, but not in the same shape — 9

The format has somewhere to put the value and not the same shape for it. What a reader gets instead is named per row, and this projection reads it back the same way, so the row is what a round trip through a foreign tool really costs.

| field | what a reader gets |
| --- | --- |
| `edges[].from.end` | crosses as @ocif/edge's single `directed` boolean — the format has no per-end marker on a relation |
| `edges[].from.kind` | crosses as the node's resource and extensions — OCIF has no node type field, so what a node IS comes from what it shows and what it carries |
| `edges[].from.point.x` | crosses as an @ocif/arrow shape — OCIF edges must run between two node ids, so a line to a bare point is a drawing rather than a relation |
| `edges[].from.point.y` | crosses as an @ocif/arrow shape — OCIF edges must run between two node ids, so a line to a bare point is a drawing rather than a relation |
| `edges[].to.end` | crosses as @ocif/edge's single `directed` boolean — the format has no per-end marker on a relation |
| `edges[].to.kind` | crosses as the node's resource and extensions — OCIF has no node type field, so what a node IS comes from what it shows and what it carries |
| `edges[].to.point.x` | crosses as an @ocif/arrow shape — OCIF edges must run between two node ids, so a line to a bare point is a drawing rather than a relation |
| `edges[].to.point.y` | crosses as an @ocif/arrow shape — OCIF edges must run between two node ids, so a line to a bare point is a drawing rather than a relation |
| `nodes[].type` | crosses as the node's resource and extensions — OCIF has no node type field, so what a node IS comes from what it shows and what it carries |

## Carried on a `@whiteboard/*` extension — 21

A conforming reader must PRESERVE an extension it does not understand, so a round trip through a foreign tool deletes none of these. What is lost is comprehension, not data: the tool carries the bytes and cannot act on them. There is no second mode here that drops the key — that is JSON Canvas’s `strict`, and OCIF has no equivalent.

| field | what a reader gets |
| --- | --- |
| `comments[].author` | preserved, not understood |
| `comments[].createdAt` | preserved, not understood |
| `comments[].id` | preserved, not understood |
| `comments[].resolved` | preserved, not understood |
| `comments[].targetEdgeId` | preserved, not understood |
| `comments[].targetNodeId` | preserved, not understood |
| `comments[].text` | preserved, not understood |
| `comments[].x` | preserved, not understood |
| `comments[].y` | preserved, not understood |
| `edges[].bends[].x` | preserved, not understood |
| `edges[].bends[].y` | preserved, not understood |
| `edges[].color` | preserved, not understood |
| `edges[].from.side` | preserved, not understood |
| `edges[].label` | preserved, not understood |
| `edges[].to.side` | preserved, not understood |
| `nodes[].background` | preserved, not understood |
| `nodes[].backgroundStyle` | preserved, not understood |
| `nodes[].color` | preserved, not understood |
| `nodes[].embed.versionRef` | preserved, not understood |
| `nodes[].label` | preserved, not understood |
| `nodes[].subpath` | preserved, not understood |

## Cannot cross at all — 0

Named here so an absence would be a decision rather than a surprise.

_None today._

## What this table does not cover

- **What is inside a facet bucket.** A `…/*` row is one entry. Unlike the JSON Canvas table,
  here that is a statement about scope rather than about loss: each facet crosses as its own
  OCIF extension, so its contents survive whatever they are — this table simply cannot
  enumerate what a deployment’s plugins put there.
- **What OCIF can state that this model cannot hold.** Rotation, 3D positions, ports,
  inheritance and pages are all in the specification and have no position here to lose. A
  document arriving with them keeps them as unread extension data.
- **OKF Markdown.** This is the spatial side only.

← Back to [reference](README.md)
