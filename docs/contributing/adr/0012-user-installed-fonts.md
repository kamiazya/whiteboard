# ADR-0012: A user installs a font by naming it, and the daemon keeps it

**Status:** Accepted — implemented (daemon route + settings picker)

## Context

[ADR-0011](0011-font-distribution.md) decided that fonts beyond the Latin
default are installed by whoever needs them, and named npm packages as the
channel. That serves a deployment. It does not serve the case this ADR is
about: **someone using the app wants a different font** — a CJK face so their
exports stop being tofu, or a handwritten one because the diagram should look
handwritten.

Two facts make the shape of the answer non-obvious.

**`@resvg/resvg-js@2.6.2` accepts `fontFiles` and `fontDirs` and nothing else.**
There is no `fontBuffers`, and no CSS font loading, so a font embedded in the
SVG as `@font-face` or a `data:` URI is ignored (verified against the installed
type definitions). A font the export path can use must exist **as a file on
disk**.

**The editor and the exporter are already required to agree.**
`canvas-viewer/src/font-loading.ts` loads the vendored Roboto as a real webfont
for exactly this reason, and says so: without it, "Canvas 2D silently falls
back to a system font, and the editor's on-screen layout diverges from what a
user exports." A font that reaches only the browser re-creates that divergence
on purpose.

Together those say the same thing from both ends: a font the user picks has to
land **as bytes on the daemon's disk**, not only in the browser.

This introduces something the product has never had. Every MCP tool today
operates headlessly on persisted documents; **none makes an outbound network
request**. Font installation would be the first, so its trigger and its
destination are a security-model decision, not an implementation detail.

## Decision

**A user installs a font by naming a family. The daemon fetches it, verifies
it, and keeps it under its data directory, where both the measurer and resvg
read it as a file.**

Google Fonts is the source. It is the one the user knows, and picking a single
well-known catalogue keeps the first version legible.

Concretely, the pinned template resolves against **`google/fonts` on
`raw.githubusercontent.com`** — the Google Fonts catalogue's own repository —
because that serves the real `.ttf` in ONE hop. Decided while implementing;
the two alternatives both fail on this ADR's own terms. `fonts.googleapis.com`
is the two-hop shape decision 1 rejects, and it only offers `woff2`, which
resvg's font database cannot decode. `fonts.gstatic.com` addresses files by a
version-and-hash path that cannot be derived from a family name, so a template
built on it would not be a template.

### 1. The input is a family NAME, never a URL

```
installFont({ family: 'Noto Sans JP' })     ← the daemon builds the URL
installFont({ url: 'https://…' })           ← rejected by construction
```

A domain allowlist is the obvious control and is **the weaker form of this
one**. An allowlist validates an input an attacker can influence; taking a
family name means there is no such input. The daemon constructs the request
from a pinned template, so "which hosts can this reach" is a property of our
code rather than of a validator someone has to keep correct.

This also avoids following Google Fonts' two-hop shape, where
`fonts.googleapis.com` returns CSS naming files on `fonts.gstatic.com` — a
fetch whose destination comes from a response body is the thing worth not
building.

### 2. Only a human triggers it — it is NOT an MCP tool

This is the control that matters most, and it is about the trigger rather than
the destination.

The daemon is driven by AI agents, and agents act on instructions found in the
documents they read. An MCP tool that fetches a URL completes a chain:
malicious canvas → agent calls the tool → daemon issues a request to somewhere
on the user's network. Restricting *where* it can go limits the damage; keeping
the trigger human removes the chain.

Font installation is therefore a user action in the browser UI, authenticated
to the daemon like any other mutation. Exposing it to MCP later is a separate
decision that must re-examine this paragraph, not a natural extension.

### 3. The fetch is bounded, and its result is verified before it is kept

- **Redirects are not followed.** An allowlisted host that answers `302` can
  otherwise send the daemon anywhere, which would undo decision 1.
- **The on-disk name is derived by us**, never from the URL or a
  `Content-Disposition` header — the same rule as the existing "export and
  upload flows stay within daemon-controlled storage paths".
- **Size cap and timeout**, so a hostile or broken response cannot exhaust
  disk or hang the daemon.
- **It must parse as a font before it is installed.** `opentype.js` parses the
  bytes, and a failure means nothing is written. This doubles as the check that
  the measurer can actually use what was downloaded — the file lands only if
  both halves of ADR-0011 decision 4 can read it.

### 4. Installed state is per-surface, and both sides report it

The browser registers a `FontFace`; the daemon keeps a file. **Either can be
present without the other**, and each single-sided state is visibly wrong in a
different direction:

| | on screen | exported |
|---|---|---|
| daemon only | system fallback | the chosen font |
| browser only | the chosen font | tofu |

So a font is not a boolean. Each surface reports what it resolved, the same
discipline `undrawable` already follows for the export path: a missing font is
a **declared degradation**, never silence.

## Consequences

- **The daemon makes outbound requests for the first time.** That is a change
  to the trust boundary and is recorded in `docs/explanation/security-model.md`
  alongside this ADR, not only here.
- Offline use is unaffected. ADR-0011 rejected fetching at startup or at render
  time; this is neither. A user pressing "install" is not a render, and once the
  file is on disk every later render is local. The widget's zero-network
  assertion continues to hold unchanged.
- A font the user installed is available to `wb_scene_render` and PNG export
  without any MCP tool having network access.
- Licensing follows ADR-0011 decision 6, with a wrinkle worth stating: fonts
  fetched at runtime are **not redistributed by us**, so the obligation is to
  surface the license to the user rather than to ship its text in the package.

## Alternatives considered

**A domain allowlist over user-supplied URLs.** The user's own proposal, and
correct in instinct. Rejected as the primary control because decision 1 achieves
the same goal structurally: an allowlist is a validator that must stay right,
where a pinned template cannot be wrong. The allowlist survives as the
host-pinning inside that template.

**Expose installation as an MCP tool.** Convenient — an agent could fix its own
tofu export. It also hands the prompt-injection surface a network primitive, on
a daemon whose tools have deliberately never had one. Not now.

**Browser-only download.** Simplest, and it breaks the property
`font-loading.ts` exists to protect: the editor would show the chosen font while
every export ignored it. That is the divergence, not a step toward fixing it.

**Bundle a font picker's worth of fonts.** ADR-0011 measured this: the published
`dist` is 5.2 MB and one CJK face is 18.6 MB. A picker implies many.
