# ADR-0016: OKF v0.2's trust family — a declared actor, a server-stamped time, and a bucket of its own

**Status:** Accepted — daemon write path implemented; the `apps/web` write path is not (see Consequences)

## Context

[OKF v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
adds a trust family to concept frontmatter, and states why in its own §1:
a knowledge corpus is no longer authored once and then read, it is
*continuously written and maintained by agents*, so a consumer needs to know
what a document was created from, how much to trust it, and whether it is
still true.

That is a description of this project. A whiteboard workspace is a document
store whose documents are written by agents over MCP; the human is often
reading what an agent wrote rather than writing it. Of the five questions
v0.2 raises, the two this ADR answers are its trust pair:

- **`generated: { by, at }`** — how the current content was produced.
- **`verified: [{ by, at }]`** — who or what has confirmed it against its
  sources.

They are deliberately independent (§5.2): content can change without being
re-confirmed, and a fact can be re-confirmed without being regenerated. Both
name an **actor** using one convention (§7): `<producer>/<version>` for an
agent or tool, `human:<id>` for a person, `process:<id>` for an automated
process. Consumers derive a trust tier from `verified` alone — absent is
*unverified*, non-`human:` actors are *machine-confirmed*, a `human:` actor is
*human-reviewed* (§5.3).

Since the fix in `packages/codec/src/okf` this codebase already **preserves**
both families through a round trip without modelling them. This ADR is about
the next step: producing them.

### The obvious design does not work here

An MCP client announces itself at `initialize` with
`clientInfo: { name, version }`, which lines up so exactly with OKF's
`<producer>/<version>` that the design writes itself: read the client's
identity from the session and stamp it. Three findings say otherwise, and each
was checked rather than assumed.

1. **`/mcp` builds a fresh `McpServer` per request.** `app.ts` does so
   deliberately — the SDK throws `Already connected` if one `Server` is bound
   to two transports — so `getClientVersion()` is populated only on the request
   that carried `initialize`. A `tools/call` arrives at a server that has never
   seen one.

2. **A stdio-configured client does not escape that.** Dev sessions and
   packaged clients reach the daemon through
   `scripts/dev/mcp-http-stdio-proxy.mjs`, where one stdin line becomes one
   stateless POST. That statelessness is load-bearing: it is what lets the
   proxy retry across a watch restart with no protocol session to lose.

3. **The per-call context carries no client identity.** `RequestHandlerExtra`
   (SDK 1.30) hands a tool handler `authInfo`, `requestInfo`, `_meta`,
   `sessionId` and `requestId` — and no `clientInfo`. `authInfo` does not
   substitute for it in the deployment that matters most: `local-daemon` mode
   authenticates every client on the machine with **one shared bearer token**,
   so it is the same `authInfo` for the agent, the browser, and the Inspector.
   Only `server-mode`, with OAuth, carries a subject that distinguishes callers.

There is a fourth constraint that is not about MCP at all: **there are two
independent write paths.** `apps/web` writes browser-kept documents straight
through `loro-adapter` (`use-markdown-document.ts`,
`document-sync-session.ts`); `server-core`'s tools write daemon-kept ones. A
stamp implemented in one of them is a field that is present or absent
depending on which surface the user happened to edit from, which is worse than
not having it.

## Decision

### 1. `generated.by` is declared by the writer, never inferred by the server

The write tools take an optional `actor` string, validated against the §7
convention. `apps/web` supplies a `human:` actor for edits a person makes in
its editor. What a caller does not supply, the server does not invent.

This is not a concession to the constraints above; it is what the spec asks
for. §7 states the obligation on the producer — *"producers MUST use it for
hand-authored or human-confirmed content"* — and §5.3 says trust tiers are
**advisory signals, not access control**. A self-reported actor is exactly as
trustworthy as OKF already assumes actors are. Inferring one from a shared
bearer token would not have been more truthful, only more confident.

A `server-mode` deployment SHOULD prefer its authenticated OAuth subject over
the declared actor, because there it has a real one. That is a refinement of
this rule, not an exception to it: the field means the same thing either way.

### 2. A declared `generated` is honoured; only a stamp the server makes uses
the server's clock

If the OKF being written already carries a `generated`, it is kept. That is
the truth about how the content was produced (§5.2), and importing a bundle
did not author what is in it — restamping would destroy exactly the provenance
this family exists to carry.

What the server stamps is the other case: content whose origin is this write.
There the clock is the server's, because a client that could name its own
write time could date a document into the future or the past, and
`generated.at` is precisely the field a consumer uses to tell a recent edit
from a stale fact.

`generated.by` requires a value (§5.2), so a stamp has to name someone. With
no actor declared it names `process:whiteboard-server` — the honest answer is
the server the write came through, not a guess at which agent was driving.

**Amended: "already carries" means a stamp this server did not write.**

The rule as first stated honoured any declared `generated`, and that is wrong
on the ordinary editing path rather than an exotic one. `wb_document_set`
replaces the ENTIRE content, so an agent changing one paragraph must read the
document first — and the read hands back the `generated` block this server
wrote. Honouring it unconditionally freezes the stamp at the first write, and
every later edit, by any actor, keeps it.

Measured on the branch before the amendment: body `first body` -> `SECOND
body`, actor `reference_agent/a` -> `human:someone-else`, five months apart,
and `generated` unchanged at `reference_agent/a` / `2026-01-01`. That is not a
lost signal but a false one, and it defeats the reason this decision gives for
the server owning the clock.

So a declared `generated` is honoured unless it is BOTH identical to the one
already stored AND accompanied by a changed body. Each half carries weight:

- Differing from the stored stamp is what makes the import case work — a stamp
  this server did not write is someone else's account of how the content was
  produced, and it survives however different the incoming content is.
- Requiring a changed body is what stops a rewrite that changes nothing from
  counting as an origin event, so re-importing the same bundle twice does not
  lose its provenance to the second import.

The comparison is the BODY, not the frontmatter: §5.2 says `generated` records
how the current CONTENT was produced, and for a markdown document that is the
body. A metadata-only edit must not claim the content was regenerated.

### 3. `verified` is never a side effect of a write

Confirming a document is a deliberate act and gets its own tool. Writing
content and confirming content are the two things §5.2 exists to keep apart;
a tool that did both would make `verified` mean nothing more than
`generated`, and would let an agent mark its own output human-reviewed by
passing a `human:` actor to a write.

Verification appends rather than replaces — §5.2's list captures independent
checks, and "how recently" is the latest `at`.

### 4. The trust family gets its own storage bucket

Not `coreFacetsSchema`. `writeCoreFacets` **replaces the whole core bucket**,
deleting any field the caller omitted — a deliberate convention that matches
`writeFacets`, and the reason `apps/web`'s property editor takes care to pass
`facetsRaw` through untouched. A server-stamped field living in that bucket
would be erased by any client that rewrote its own tags.

So the trust family follows the `facets` precedent instead: its own storage
key and its own read/write pair, so one domain's CRDT merge never overwrites
another's. On serialise it is projected to the frontmatter root, where OKF
puts it, exactly as `title` is projected from the workspace name (ADR-0009
decision 2). It is not an extension facet either — extension facets are
`{namespace}.{name}/v{n}` under `facets:` (ADR-0013), and these are root keys
OKF itself defines.

### 5. Markdown documents only, and said out loud

`readCoreFacets` answers `undefined` for a spatial document, and ADR-0013 kept
that invariant when it superseded ADR-0009 decision 3 — *extension* facets on a
spatial document are on their way in, but core facets never live on one. The
trust family inherits the core half, and for the right reason rather than by
inheritance: OKF's trust family are **root frontmatter keys**, and a JSON
Canvas document has no frontmatter to project them into. So a diagram carries
no provenance.

An OKF bundle is markdown, so this is consistent rather than merely convenient.
But "an agent drew this diagram, and here is what from" is a real thing to
want, and it needs a design this ADR does not have — most likely a
registered facet under ADR-0013's grammar rather than a smuggled root key.
Recording the gap is the point of this paragraph.

## Consequences

- A document written by an agent through MCP carries who wrote it and when,
  and a consumer outside this project can read that with no whiteboard-specific
  knowledge — it is OKF frontmatter.
- `verified` gives the repo's own ticketing flow something it lost when the
  `issue/1` facet domain was retired: a machine-readable confirmation event
  with an agreed schema, which is OKF's rather than one invented in passing.
  Note it is not an issue *status* — OKF's `status` is `draft`/`stable`/
  `deprecated`, a document lifecycle, and conflating the two would repeat the
  mistake that retired `issue/1`.
- **The `apps/web` write path deliberately does not stamp.** The browser writes
  browser-kept documents straight through `loro-adapter`, so a document edited
  there carries no `generated` while the same document edited through MCP does.
  That asymmetry is accepted for now rather than closed, because closing it
  means answering what `human:<id>` identifies in an app with no accounts —
  `user-settings-store` holds no identity — and **an identity minted locally
  today would have to be reconciled with whatever a hosted product brings**.
  Inventing `human:local` now buys one field and risks an identity model that
  contradicts the real one later; the daemon half stands on its own until
  there is an identity worth writing down.

  (The cadence question is the smaller half and has an answer waiting:
  `writeMarkdownBody` runs on every keystroke in the editor, so a stamp would
  ride save/blur, never a keystroke.)
- **A schema carrying a `transform` cannot be published.** The widening §5.2
  requires — read a bare `verified` mapping as a one-element list — was written
  first as a `z.union(...).transform()` on the frontmatter schema. That schema
  reaches `wb_document_get`'s `outputSchema`, which the MCP SDK converts to
  JSON Schema for `tools/list`, and the whole listing failed with *"Transforms
  cannot be represented in JSON Schema"*. The widening therefore happens in
  `parseOkf`, on the way in, and every published schema states the single shape
  it holds. Worth knowing before adding a `transform` to anything under
  `okfMarkdownFrontmatterSchema`.
- Self-verification is possible: nothing stops a client writing
  `verified: { by: human:… }` in the OKF it hands to `wb_document_set`, and
  nothing should — a bundle's verification history has to survive an import.
  Decision 3 buys that verification is never an *implicit* side effect of a
  write, not that it is authenticated. §5.3 says trust tiers are advisory
  signals rather than access control, so this is the spec's posture, not a gap
  in the implementation.
- The field is a self-report, and a consumer that treats it as authenticated
  provenance will be wrong. This is inherent to OKF's actor convention, not to
  this decision — but it belongs in the user docs, not only here.

## Alternatives considered

**Make `/mcp` stateful so `clientInfo` survives to the tool call.** Rejected.
The stateless-per-request property is what makes the stdio proxy sound across
a watch restart, and a session would have to be reconstructed on every
reconnect. It trades a load-bearing property for a string the client can
simply be asked for.

**Derive the actor from the bearer token.** Rejected as the general
mechanism, because `local-daemon` mode has one shared token and therefore one
identity for every caller on the machine. Kept as the `server-mode`
refinement in decision 1, where the subject is real.

**Have the stdio proxy capture `clientInfo` at `initialize` and forward it as
a header.** Rejected as the primary mechanism: it works only for clients
routed through this repo's own proxy, leaves a direct HTTP client with
nothing, and is still a self-report one hop further from the writer.

**Stamp nothing; leave both families to producers.** Rejected. For an agent
write over MCP this project *is* the producer, so "the producer will fill it
in" means the field is always empty for exactly the documents v0.2 was written
for.

**Model them as an extension facet under `facets:`.** Rejected. They are root
keys in the spec, and a consumer reading the bundle would have to know this
project's plugin namespace to find them — which is the opposite of what
adopting an open format is for.
