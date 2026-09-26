# Changelog

## [0.1.0](https://github.com/kamiazya/whiteboard/compare/whiteboard-plugin-v0.0.19...whiteboard-plugin-v0.1.0) (2026-09-26)


### ⚠ BREAKING CHANGES

* **mcp-server:** stopping the daemon is a signal, and "write this file owner-only" has one definition ([#1666](https://github.com/kamiazya/whiteboard/issues/1666))
* **mcp:** ADR-0038 — a line is ink, text is a resource, and OCIF is a third projection ([#1638](https://github.com/kamiazya/whiteboard/issues/1638))
* **server-core:** tags on boards, nodes and edges through wb_facet_set, search and the in-use listing (ADR-0040 increment 3) ([#1617](https://github.com/kamiazya/whiteboard/issues/1617))
* **versions:** existing saved versions are deleted on upgrade, in both keepers. Documents and their content are untouched.
* **plugin-visual:** a box dressed with a bundled stencil no longer gets a colour. Documents already dressed keep the colour that was written onto them; nothing migrates and nothing needs to.
* **pairing:** a `#wb=` link carries no credential, and the daemon token leaves argv ([#1563](https://github.com/kamiazya/whiteboard/issues/1563))
* the pre-facet `x-whiteboard.edgeRouting` key is retired with no compatibility read, so a document written under it loses its routing on read. Deliberate per the 0.0.x no-compat policy.
* **canvas-render:** `tidy` now moves and resizes inside groups; `TidyMove` gains optional `width`/`height` for a grown frame.
* **mcp:** a text box too short for its text is refused with the height it needs; box sizes say what omitting them buys ([#1518](https://github.com/kamiazya/whiteboard/issues/1518))
* **mcp:** region.set takes member ids; wb_document_resolve is retired; integer and node-extension schemas changed.
* **web:** `GET|PUT /api/workspaces/:id/documents/:path/versions/:id/thumbnail` and `GET .../latest-thumbnail` are removed, and `hasThumbnail` no longer appears on a version entry. Migration 0024 deletes the stored PNGs and cannot be rolled back.
* **mcp:** retire the standalone document CRUD tools into wb_workspace_edit ([#1497](https://github.com/kamiazya/whiteboard/issues/1497))
* **mcp:** retire wb_body_patch into wb_canvas_edit's ops ([#1493](https://github.com/kamiazya/whiteboard/issues/1493))
* **mcp:** wb_facet_set and wb_version_save write to many documents at once ([#1491](https://github.com/kamiazya/whiteboard/issues/1491))
* **mcp:** wb_document_get reads many documents in one call ([#1489](https://github.com/kamiazya/whiteboard/issues/1489))
* **daemon:** retire the branch from storage, per ADR-0029 ([#1471](https://github.com/kamiazya/whiteboard/issues/1471))
* **web:** retire the branch client, and the version list's lane column ([#1470](https://github.com/kamiazya/whiteboard/issues/1470))
* **web:** retire the variation surface, per ADR-0029 ([#1469](https://github.com/kamiazya/whiteboard/issues/1469))
* **server-core:** wb_body_edit's default mode is now propose. A caller that omitted mode got a refusal before (the field was required) and now gets a proposal, so nothing silently changes meaning; a caller passing mode:'apply' is unaffected.
* **server-core:** `wb_canvas_edit` no longer changes a spatial document by default. A batch of node/edge content is stored as a proposal for a person to adopt; pass mode:"apply" to write it. Batches carrying comments, locks, tidy or region.set are unaffected.

### Features

* a body's inline attachment draws its stored picture ([#1580](https://github.com/kamiazya/whiteboard/issues/1580)) ([e21cb8f](https://github.com/kamiazya/whiteboard/commit/e21cb8ff73240347b24ac482c7d29a4485032b50))
* a document body is held to the workspace's tag library (ADR-0040 increment 5c) ([#1628](https://github.com/kamiazya/whiteboard/issues/1628)) ([27bf14e](https://github.com/kamiazya/whiteboard/commit/27bf14e14aa57ffe702357ccd307bc8e4316749b))
* a markdown body names a vendored icon, and the layout paints it ([#1584](https://github.com/kamiazya/whiteboard/issues/1584)) ([33f6514](https://github.com/kamiazya/whiteboard/commit/33f6514e7bd52f6c19777c3341b5c0669cd377a8))
* a server-mode keeper serves the web app, and its entrance signs a person in (ADR-0047 F1) ([#1889](https://github.com/kamiazya/whiteboard/issues/1889)) ([ff5b906](https://github.com/kamiazya/whiteboard/commit/ff5b906959b00dfcc2ece97b215e521a9d47a4d9))
* a theme picker's cards and an auto-placed box's width stop being hand-written ([#1568](https://github.com/kamiazya/whiteboard/issues/1568)) ([6b30f50](https://github.com/kamiazya/whiteboard/commit/6b30f50113c7396468b1688b87c61c19c0046511))
* an administrator's action needs a sign-in at the provider within 15 minutes (ADR-0051 slice 2) ([#1920](https://github.com/kamiazya/whiteboard/issues/1920)) ([0ee32c0](https://github.com/kamiazya/whiteboard/commit/0ee32c084e3d37df5e11d08fbefe2f94febe4d42))
* **annotations:** a comment's body is markdown, and every surface finally agrees ([#1462](https://github.com/kamiazya/whiteboard/issues/1462)) ([b1e8850](https://github.com/kamiazya/whiteboard/commit/b1e885035b2bab9e9924d9000fdd4d9249b875ba))
* **annotations:** focus handoff, message counts, icon-first verbs and resolve motion ([#1448](https://github.com/kamiazya/whiteboard/issues/1448)) ([1de4d48](https://github.com/kamiazya/whiteboard/commit/1de4d48561734d698705d0d9ad87e5eb5ef4e8e3))
* **annotations:** resolving a conversation ramps its canvas chrome out instead of cutting ([#1453](https://github.com/kamiazya/whiteboard/issues/1453)) ([6665824](https://github.com/kamiazya/whiteboard/commit/6665824febc5624094080bb1b4a8bb6441c56d98))
* **annotations:** the markdown markers cross to the resolved look instead of cutting ([#1459](https://github.com/kamiazya/whiteboard/issues/1459)) ([98ccecd](https://github.com/kamiazya/whiteboard/commit/98ccecd3a285bd69830e5e77f7b09eea12e88dcb))
* **arch-lint:** a file read that answers failure with an absence must say what its caller does with it ([#1912](https://github.com/kamiazya/whiteboard/issues/1912)) ([2d1e180](https://github.com/kamiazya/whiteboard/commit/2d1e180d8721f1c62b62fdc4170f6b4754a80471))
* **canvas-render:** a channel says WHICH declared axis it carries ([#1583](https://github.com/kamiazya/whiteboard/issues/1583)) ([270e9fe](https://github.com/kamiazya/whiteboard/commit/270e9fe8d0317b7eb99b65abe9000a60d638b198))
* **canvas-render:** a composition score, judged by four principles with their sources ([#1541](https://github.com/kamiazya/whiteboard/issues/1541)) ([c123b4a](https://github.com/kamiazya/whiteboard/commit/c123b4a93635069001028f66f0a5918637650e81))
* **canvas-render:** a drawing score that judges the board, recorded per board by the tool-surface lane ([#1509](https://github.com/kamiazya/whiteboard/issues/1509)) ([514441f](https://github.com/kamiazya/whiteboard/commit/514441f76c0b82bbff39e130dbfd1d0e2c2a809c))
* **canvas-render:** a frame's margin is an anchor, so frames that line up hold members that line up ([#1540](https://github.com/kamiazya/whiteboard/issues/1540)) ([9a26587](https://github.com/kamiazya/whiteboard/commit/9a26587e3f392e6d3ff60fbcaeff4d399cc46c97))
* **canvas-render:** a third axis — whether a board's appearance says what its document declares ([#1551](https://github.com/kamiazya/whiteboard/issues/1551)) ([8789ebf](https://github.com/kamiazya/whiteboard/commit/8789ebfcebf87ff64802f7eefe06a2215c2e74b9))
* **canvas-render:** a wider box centred on a column, or flush with its far edge, is aligned ([#1524](https://github.com/kamiazya/whiteboard/issues/1524)) ([b3061b6](https://github.com/kamiazya/whiteboard/commit/b3061b61caf679b282972d4008214aa442896de9))
* **canvas-render:** an edge label that would lie over a box slides off the line; room for an inserted box ([#1517](https://github.com/kamiazya/whiteboard/issues/1517)) ([e84eaac](https://github.com/kamiazya/whiteboard/commit/e84eaac8ea313e0d5fcac268b4c5ddf1b8403884))
* **canvas-render:** split `undeclared` out of the facet score's `excess` ([#1636](https://github.com/kamiazya/whiteboard/issues/1636)) ([95f5c0a](https://github.com/kamiazya/whiteboard/commit/95f5c0a38ee8d63f55dbf34ec7e8c68021de8c1f))
* **canvas-render:** the board legend in the editor's corner and in every export (ADR-0040 increment 4b) ([#1619](https://github.com/kamiazya/whiteboard/issues/1619)) ([bb2dcee](https://github.com/kamiazya/whiteboard/commit/bb2dcee5f22a666a088306c7891579524f4c64c5))
* **canvas-render:** the drawing score reads the gap between boxes, and tidy keeps one ([#1514](https://github.com/kamiazya/whiteboard/issues/1514)) ([d238ec6](https://github.com/kamiazya/whiteboard/commit/d238ec69ad86471ef81bb78bae39f1175579cfb7))
* **canvas-render:** the facet score reads scoped tags on boxes and edges (ADR-0040 increment 2) ([#1616](https://github.com/kamiazya/whiteboard/issues/1616)) ([6d0048e](https://github.com/kamiazya/whiteboard/commit/6d0048e591e1054db4360cea41d0e5f4b102777d))
* **canvas-render:** tidy bands on centres and far edges, not only near edges ([#1530](https://github.com/kamiazya/whiteboard/issues/1530)) ([57cbe20](https://github.com/kamiazya/whiteboard/commit/57cbe20dd6ff58bf78ffc8785b4d24604d2df0bd))
* **canvas-render:** tidy orders a row by its edges, so a fan-out hub sits between its targets ([#1534](https://github.com/kamiazya/whiteboard/issues/1534)) ([d96d691](https://github.com/kamiazya/whiteboard/commit/d96d6912bb642df988e4f69fe6cd423dbb356a75))
* **canvas-render:** tidy tidies inside a frame and grows it to hold its members; a band aligns to an immobile neighbour ([#1522](https://github.com/kamiazya/whiteboard/issues/1522)) ([374a44c](https://github.com/kamiazya/whiteboard/commit/374a44c7609d49afaaec5bda4ebb3d34d04b6e0e))
* **daemon-client:** membership and passkey-bound-session wire contracts (ADR-0041) ([#1686](https://github.com/kamiazya/whiteboard/issues/1686)) ([6a2a3dd](https://github.com/kamiazya/whiteboard/commit/6a2a3dd1d5019cbc2826378eec24210762d1a479))
* **daemon-client:** the read plane's content-key derivation and sealed-bytes primitive (ADR-0043 decision 3) ([#1685](https://github.com/kamiazya/whiteboard/issues/1685)) ([31130b8](https://github.com/kamiazya/whiteboard/commit/31130b8e3691b07737ac61268fd381db1ca71342))
* **daemon-client:** the read plane's in-memory session-key holder (ADR-0042) ([#1715](https://github.com/kamiazya/whiteboard/issues/1715)) ([26788e0](https://github.com/kamiazya/whiteboard/commit/26788e0fa10c48f2cc7a189713ef5e14667ab33b))
* **daemon:** a member-gated workspace can be returned to origin trust, and only the daemon's owner can do it (ADR-0041 S5) ([#1771](https://github.com/kamiazya/whiteboard/issues/1771)) ([e52ed82](https://github.com/kamiazya/whiteboard/commit/e52ed82e40a29cad53b6ebbb84a5b8f5801c8c6e))
* **daemon:** a workspace that once had members stays person-gated, so removing the last one is a ban rather than a reopening (ADR-0041 S8, slice 4) ([#1738](https://github.com/kamiazya/whiteboard/issues/1738)) ([e91cf73](https://github.com/kamiazya/whiteboard/commit/e91cf73db089e18b6191e5b5379d76eaa9b2f53d))
* **daemon:** a workspace's read-plane key can be rotated, and every ciphertext sealed under the old pair stops opening (ADR-0042 d1) ([#1766](https://github.com/kamiazya/whiteboard/issues/1766)) ([5f6ed29](https://github.com/kamiazya/whiteboard/commit/5f6ed29d6764a291577144ba4a92067a4dfec6f7))
* **daemon:** a workspace's replica tier can be set and cleared, at the same bar as member management (ADR-0042 d1) ([#1752](https://github.com/kamiazya/whiteboard/issues/1752)) ([4be5588](https://github.com/kamiazya/whiteboard/commit/4be5588bd8dd5b89449d853f0c79058b18e0e764))
* **daemon:** name the device with did:key, and record it as a version's operator ([#1571](https://github.com/kamiazya/whiteboard/issues/1571)) ([7605db1](https://github.com/kamiazya/whiteboard/commit/7605db1ec5a58c876e6ee543c775b2b1093cc12a))
* **daemon:** retire the branch from storage, per ADR-0029 ([#1471](https://github.com/kamiazya/whiteboard/issues/1471)) ([0e7edb2](https://github.com/kamiazya/whiteboard/commit/0e7edb2f69d16e91356d79ebce1898154ea5c452))
* **dev:** the first merge attempt shows the review comments, then gets out of the way ([#1756](https://github.com/kamiazya/whiteboard/issues/1756)) ([10f02cc](https://github.com/kamiazya/whiteboard/commit/10f02cc10dbb5a6f09fa870b5ccc09b5404eb685))
* **document-editor:** the inspector's panes arrive and leave with motion ([#1468](https://github.com/kamiazya/whiteboard/issues/1468)) ([295927d](https://github.com/kamiazya/whiteboard/commit/295927ddd33b75a23d3862915438c741aa7a7ed2))
* **facet-engine:** a picker may be OPEN — visual.symbol offers every emoji, searchable, in a popover ([#1567](https://github.com/kamiazya/whiteboard/issues/1567)) ([f6bc214](https://github.com/kamiazya/whiteboard/commit/f6bc214a883fb6dc449f4abf5db20118aa2354ae))
* **facet-engine:** an asset-ref picker offers what the registry holds, not what the definition listed ([#1559](https://github.com/kamiazya/whiteboard/issues/1559)) ([df5db30](https://github.com/kamiazya/whiteboard/commit/df5db300f4303890e949d57201e6c738644faefb))
* **facets:** say where a badge is drawn, and point at the tag library instead ([#1639](https://github.com/kamiazya/whiteboard/issues/1639)) ([d810230](https://github.com/kamiazya/whiteboard/commit/d810230ea5bb9bd51a1efd74f148aad67514e5b1))
* **history:** a document's branches live on the workspace record, on a plane that merges ([#1423](https://github.com/kamiazya/whiteboard/issues/1423)) ([76e5c91](https://github.com/kamiazya/whiteboard/commit/76e5c91bfa5c7b241145d01043f21a3b65d91bab))
* **lint:** noExcessiveCognitiveComplexity is ON, with the files that still exceed it listed ([#1814](https://github.com/kamiazya/whiteboard/issues/1814)) ([d76193d](https://github.com/kamiazya/whiteboard/commit/d76193da9aee10339e7bd5a99a7b1c0e43d448f9))
* **mcp-server:** a backup mirrors every tenant, and its manifest says whose each blob is ([#1851](https://github.com/kamiazya/whiteboard/issues/1851)) ([7163fdf](https://github.com/kamiazya/whiteboard/commit/7163fdfae3c62534b30ef69361b0d3224bd6dfab))
* **mcp-server:** a composition root chooses the plugin set, which nothing could do ([#1560](https://github.com/kamiazya/whiteboard/issues/1560)) ([32d7194](https://github.com/kamiazya/whiteboard/commit/32d71942424e270b2cefcf0b8cddaafc82de0a6d))
* **mcp-server:** a deactivated user is refused everywhere and keeps their data (ADR-0049 slice 1b) ([#1902](https://github.com/kamiazya/whiteboard/issues/1902)) ([4bfea59](https://github.com/kamiazya/whiteboard/commit/4bfea59f3ef2732409e339a295d6f3ce1e4f1429))
* **mcp-server:** a macaroon whose scopes the daemon actually enforces ([#1647](https://github.com/kamiazya/whiteboard/issues/1647)) ([37fe935](https://github.com/kamiazya/whiteboard/commit/37fe935642f3fc3e7a70e2da543a13504beeb423))
* **mcp-server:** a paired session becomes a person's session by asserting a pinned passkey (ADR-0041) ([#1689](https://github.com/kamiazya/whiteboard/issues/1689)) ([d612dbd](https://github.com/kamiazya/whiteboard/commit/d612dbd801bc0234b83cb357d89f64c53a9df60e))
* **mcp-server:** a profile is a tenant's user of a keeper-wide account (ADR-0045) ([#1878](https://github.com/kamiazya/whiteboard/issues/1878)) ([7c0b0f7](https://github.com/kamiazya/whiteboard/commit/7c0b0f7f319099d14c3a144d3b83f7894b45d953))
* **mcp-server:** a provider with no browser client admits bearers only, and the operator adds users by provider and subject (ADR-0046) ([#1887](https://github.com/kamiazya/whiteboard/issues/1887)) ([2c9fedd](https://github.com/kamiazya/whiteboard/commit/2c9feddd91cbd1142410cb8f06f3d3f54a996e70))
* **mcp-server:** a reverse proxy that already signs people in can be a sign-in provider ([#1897](https://github.com/kamiazya/whiteboard/issues/1897)) ([ee2b59f](https://github.com/kamiazya/whiteboard/commit/ee2b59f7a08c8a2fe925b09c35801b01f9c6a2bf))
* **mcp-server:** a tenant's administrators manage its people on server mode (ADR-0049 slice 2c) ([#1906](https://github.com/kamiazya/whiteboard/issues/1906)) ([2aecf93](https://github.com/kamiazya/whiteboard/commit/2aecf93bee56fdd2e856e0da3188c12ae93729ca))
* **mcp-server:** a tenant's images and files live under its own directory ([#1837](https://github.com/kamiazya/whiteboard/issues/1837)) ([49df403](https://github.com/kamiazya/whiteboard/commit/49df4033028f2634fbce7cc2f0f99edc0fc79106))
* **mcp-server:** a tenant's invitations — one-time links kept hashed, and verified-email invitations (ADR-0046 C) ([#1882](https://github.com/kamiazya/whiteboard/issues/1882)) ([7073045](https://github.com/kamiazya/whiteboard/commit/7073045c7960a3b0042390da839ff837b9cd53de))
* **mcp-server:** a workspace's owners manage its people on server mode (ADR-0049 slice 2a) ([#1903](https://github.com/kamiazya/whiteboard/issues/1903)) ([38b0a4c](https://github.com/kamiazya/whiteboard/commit/38b0a4c3245488c4ad1d24eed8aa097947c19a13))
* **mcp-server:** an administrator deletes a deactivated person (ADR-0051 slice 1) ([#1919](https://github.com/kamiazya/whiteboard/issues/1919)) ([672ac7f](https://github.com/kamiazya/whiteboard/commit/672ac7fa07fb81ef384af897aeefb6e2a0bf1874))
* **mcp-server:** an owner invites a person into a workspace, and accepting joins it (ADR-0049 slice 2b) ([#1904](https://github.com/kamiazya/whiteboard/issues/1904)) ([f44b9be](https://github.com/kamiazya/whiteboard/commit/f44b9be1aeb2e8985e971d5daf9bfa6211fd3de7))
* **mcp-server:** decide what reaches /mcp, and retire a stale comment that misread as a hole ([#1653](https://github.com/kamiazya/whiteboard/issues/1653)) ([fb54fcc](https://github.com/kamiazya/whiteboard/commit/fb54fccb0ca28e38d7bfd978534eb005946d3f5a))
* **mcp-server:** every store reaches the database through a tenant-bound handle ([#1830](https://github.com/kamiazya/whiteboard/issues/1830)) ([e615909](https://github.com/kamiazya/whiteboard/commit/e6159092f7a7ef4b287c3d392b34aee0021cd8d2))
* **mcp-server:** measure what a workspace record costs a 128MB isolate ([#1797](https://github.com/kamiazya/whiteboard/issues/1797)) ([23b8667](https://github.com/kamiazya/whiteboard/commit/23b86676bafb4a5838d167906aa8cb46df9b5b2b))
* **mcp-server:** membership gates every online route of a workspace that has members (ADR-0041 S8, slice 2) ([#1731](https://github.com/kamiazya/whiteboard/issues/1731)) ([6e8048d](https://github.com/kamiazya/whiteboard/commit/6e8048d5af175edbe3a8109afdeb50d38db3d10b))
* **mcp-server:** memberships carry a role, and a tenant keeps its administrators (ADR-0049 slice 1a) ([#1901](https://github.com/kamiazya/whiteboard/issues/1901)) ([53bade4](https://github.com/kamiazya/whiteboard/commit/53bade436b1b27d3232428d1dbede9a2884f95c8))
* **mcp-server:** one workspaceAccess decision gates membership; replica-key uses it (ADR-0041 S8, slice 1) ([#1724](https://github.com/kamiazya/whiteboard/issues/1724)) ([1193c3d](https://github.com/kamiazya/whiteboard/commit/1193c3d1296f0ca5bcae4a97b598b33dbc99191b))
* **mcp-server:** server mode resolves a person per request, gates every workspace by membership, and lets a named client's bearer become a user (ADR-0046 E1) ([#1886](https://github.com/kamiazya/whiteboard/issues/1886)) ([e98d1a3](https://github.com/kamiazya/whiteboard/commit/e98d1a3bd4efa38193a31ccf6546146364083c12))
* **mcp-server:** server mode's /mcp gates every tool call by workspace membership, and a created workspace's first member is its creator (ADR-0046 E2) ([#1888](https://github.com/kamiazya/whiteboard/issues/1888)) ([99aa14b](https://github.com/kamiazya/whiteboard/commit/99aa14be4507c43cbb186a1cb98346e6905fd0d6))
* **mcp-server:** several server-mode instances show each other's edits live ([#1896](https://github.com/kamiazya/whiteboard/issues/1896)) ([28164b3](https://github.com/kamiazya/whiteboard/commit/28164b37f89a0d64acbb98b68be09b0d50b8db8d))
* **mcp-server:** sign in through a configured OIDC provider (ADR-0046 D2) ([#1885](https://github.com/kamiazya/whiteboard/issues/1885)) ([ef81105](https://github.com/kamiazya/whiteboard/commit/ef811057f11f3f8c60e4a8d8217642b09454857c))
* **mcp-server:** sign-in providers are declared by one schema and admitted by one function (ADR-0046 B) ([#1881](https://github.com/kamiazya/whiteboard/issues/1881)) ([1d50c51](https://github.com/kamiazya/whiteboard/commit/1d50c51d3290dd5b953f91b41ea975c1f3a64fab))
* **mcp-server:** stopping the daemon is a signal, and "write this file owner-only" has one definition ([#1666](https://github.com/kamiazya/whiteboard/issues/1666)) ([15c5b6e](https://github.com/kamiazya/whiteboard/commit/15c5b6e106269acb3554f25455eb41380b78d3c0))
* **mcp-server:** the daemon hands a member's session the workspace content key, per tier, and withholds it after L1 removal (ADR-0042) ([#1710](https://github.com/kamiazya/whiteboard/issues/1710)) ([5bc0551](https://github.com/kamiazya/whiteboard/commit/5bc0551dee117f42271c90ebb64d81ef3e6c93a9))
* **mcp-server:** the daemon keeps a branch on the workspace record, not in a row ([#1424](https://github.com/kamiazya/whiteboard/issues/1424)) ([94dc813](https://github.com/kamiazya/whiteboard/commit/94dc813648d206f22b93a30742f52b8b8e47e019))
* **mcp-server:** the daemon's MemberProfile store and a fail-closed workspace-membership seam (ADR-0041) ([#1687](https://github.com/kamiazya/whiteboard/issues/1687)) ([3f023a9](https://github.com/kamiazya/whiteboard/commit/3f023a9952d5931b2a39a89922f0393ac91ad482))
* **mcp-server:** the daemon's membership routes — list, add, and L1-remove a member with a synchronous session kill (ADR-0041) ([#1697](https://github.com/kamiazya/whiteboard/issues/1697)) ([4e25293](https://github.com/kamiazya/whiteboard/commit/4e25293359da79800fedba943ce2a03a228402d8))
* **mcp-server:** the eval lane reads the composition axis, and two changes it rejected are recorded ([#1542](https://github.com/kamiazya/whiteboard/issues/1542)) ([310e273](https://github.com/kamiazya/whiteboard/commit/310e2735fb3922a7eb8c38c46d4032323394af23))
* **mcp-server:** the origin-keyed stores belong to a tenant, not the keeper ([#1840](https://github.com/kamiazya/whiteboard/issues/1840)) ([bbccac6](https://github.com/kamiazya/whiteboard/commit/bbccac6ce0eee4334433c1a2c30b2296ae03bde3))
* **mcp-server:** verified claims become a session in one place — admit, spend the invitation, create the user (ADR-0046 D1) ([#1884](https://github.com/kamiazya/whiteboard/issues/1884)) ([46e5d40](https://github.com/kamiazya/whiteboard/commit/46e5d40ddc38acc8b3c91a2ebcac73ed11c9b815))
* **mcp:** `within` on node.add says what a new group over existing boxes takes ([#1528](https://github.com/kamiazya/whiteboard/issues/1528)) ([3d715e1](https://github.com/kamiazya/whiteboard/commit/3d715e1936d4114c58c8f530d5e815fe6c487a33))
* **mcp:** a deployment's own stencils work, and the vocabulary is discovered rather than enumerated ([#1557](https://github.com/kamiazya/whiteboard/issues/1557)) ([edcfea4](https://github.com/kamiazya/whiteboard/commit/edcfea4ad2ef473c1c670d8a3891b457854e58ba))
* **mcp:** a filtered wb_facet_list answer names what the other scopes hold ([#1601](https://github.com/kamiazya/whiteboard/issues/1601)) ([b10855f](https://github.com/kamiazya/whiteboard/commit/b10855f4ef661361da3f4e905099a04179f99c81))
* **mcp:** a group added without a position is placed around the members added within it, and `within: null` means no group ([#1531](https://github.com/kamiazya/whiteboard/issues/1531)) ([b06c01e](https://github.com/kamiazya/whiteboard/commit/b06c01e3e48d5b16dd63fe2b69c5fbf5eeb65868))
* **mcp:** a misplaced draft key on wb_canvas_edit says where it belongs ([#1535](https://github.com/kamiazya/whiteboard/issues/1535)) ([6300efe](https://github.com/kamiazya/whiteboard/commit/6300efe46d2a767ab3437cae6397be85bcc81b09))
* **mcp:** a registered classification facet for a box's second axis, and the reading that withdrew its inline write path ([#1609](https://github.com/kamiazya/whiteboard/issues/1609)) ([7a55f38](https://github.com/kamiazya/whiteboard/commit/7a55f38b0f8bef9c04bec27b387f7a3ec0484ec8))
* **mcp:** a text box too short for its text is refused with the height it needs; box sizes say what omitting them buys ([#1518](https://github.com/kamiazya/whiteboard/issues/1518)) ([691a155](https://github.com/kamiazya/whiteboard/commit/691a155d532654ea768598644e47360df916338e))
* **mcp:** ADR-0038 — a line is ink, text is a resource, and OCIF is a third projection ([#1638](https://github.com/kamiazya/whiteboard/issues/1638)) ([a994a0d](https://github.com/kamiazya/whiteboard/commit/a994a0d2cf3ec4c57a4f2b81c7cd0c73cbf0ebff))
* **mcp:** describe wb_facet_list's `target`, and withdraw the steer that did not work ([#1592](https://github.com/kamiazya/whiteboard/issues/1592)) ([0604763](https://github.com/kamiazya/whiteboard/commit/0604763b5c57485fd81cea4f2aeaea6886384228))
* **mcp:** document.create takes a bare markdown body and mints the frontmatter ([#1645](https://github.com/kamiazya/whiteboard/issues/1645)) ([e8457b7](https://github.com/kamiazya/whiteboard/commit/e8457b7d9e9ea689ccf1397d2d39b1d9b2cb9736))
* **mcp:** edge sides say what leaving them out buys; two router fixes rejected by the drawing score ([#1512](https://github.com/kamiazya/whiteboard/issues/1512)) ([642d479](https://github.com/kamiazya/whiteboard/commit/642d479bf825a0854d03db6fe3b633debcaf65d9))
* **mcp:** judge the tool surface by an instrument, and the first measured sweep ([#1507](https://github.com/kamiazya/whiteboard/issues/1507)) ([55990d9](https://github.com/kamiazya/whiteboard/commit/55990d90a03003c6c44015d4366cb607f81c965a))
* **mcp:** region.set places a group added without a position around its members ([#1529](https://github.com/kamiazya/whiteboard/issues/1529)) ([dc4a218](https://github.com/kamiazya/whiteboard/commit/dc4a218b543dbed258eb7f1641f7d68bd09645e9))
* **mcp:** retire the standalone document CRUD tools into wb_workspace_edit ([#1497](https://github.com/kamiazya/whiteboard/issues/1497)) ([eeacd53](https://github.com/kamiazya/whiteboard/commit/eeacd533dce523c198eb6f4232754908b0f3adf9))
* **mcp:** retire wb_body_patch into wb_canvas_edit's ops ([#1493](https://github.com/kamiazya/whiteboard/issues/1493)) ([002ed99](https://github.com/kamiazya/whiteboard/commit/002ed991e07a9e4da300a81060d845b609c498b0))
* **mcp:** stencils — name what a box IS, and record it so the drawing says so ([#1555](https://github.com/kamiazya/whiteboard/issues/1555)) ([fe721a4](https://github.com/kamiazya/whiteboard/commit/fe721a47eaa3b53d7302664716964dc5934edf1c))
* **mcp:** wb_canvas_edit accepts `stencil: null` as "this op names none" ([#1629](https://github.com/kamiazya/whiteboard/issues/1629)) ([0429637](https://github.com/kamiazya/whiteboard/commit/04296372e0ab6702530a7f3172e7dc6623356cb3))
* **mcp:** wb_document_get reads many documents in one call ([#1489](https://github.com/kamiazya/whiteboard/issues/1489)) ([26f4ceb](https://github.com/kamiazya/whiteboard/commit/26f4ceb1cfb624b913bdaf612ef2f95b197c3cd9))
* **mcp:** wb_facet_set and wb_version_save write to many documents at once ([#1491](https://github.com/kamiazya/whiteboard/issues/1491)) ([b3b3e24](https://github.com/kamiazya/whiteboard/commit/b3b3e24ffe8edf106f6966214e5fa1380b003859))
* **model:** tags on spatial documents, nodes and edges (ADR-0040 increment 1) ([#1615](https://github.com/kamiazya/whiteboard/issues/1615)) ([15ca90a](https://github.com/kamiazya/whiteboard/commit/15ca90a47faa84ef67a109e6a55cff75d4f587a4))
* **model:** the proposal layer's data shape — anchored changes, decided one at a time ([#1445](https://github.com/kamiazya/whiteboard/issues/1445)) ([84d0c7a](https://github.com/kamiazya/whiteboard/commit/84d0c7a28ffa1e0645c2eef0227b51552bf287ca))
* **model:** what adopting a proposed passage means, and whether it still fits ([#1456](https://github.com/kamiazya/whiteboard/issues/1456)) ([1878a30](https://github.com/kamiazya/whiteboard/commit/1878a305b832dc20916331d6873d01b7c55701cc))
* **pairing:** a `#wb=` link carries no credential, and the daemon token leaves argv ([#1563](https://github.com/kamiazya/whiteboard/issues/1563)) ([95f7d86](https://github.com/kamiazya/whiteboard/commit/95f7d863709b6054ccf28e31f7ad2b636d00fa7d))
* **plugin-visual:** a semantic axis is declared, and the bundled stencils stop spending colour ([#1579](https://github.com/kamiazya/whiteboard/issues/1579)) ([29fa187](https://github.com/kamiazya/whiteboard/commit/29fa187047032998f8105c04498787fc7a0cdac9))
* **plugin-visual:** a symbol marks the surfaces that cannot show the node ([#1490](https://github.com/kamiazya/whiteboard/issues/1490)) ([3b46e29](https://github.com/kamiazya/whiteboard/commit/3b46e2962307d40984b1d92745491ce6c22f7485))
* render theme layer with visual.theme/v0, sketch and neon looks (ADR-0030) ([6db9d16](https://github.com/kamiazya/whiteboard/commit/6db9d162e8bc7819ff11fa16cae2fbc70056551f))
* **review:** a default complexity lane asks for a structural answer, measured by complexity-of.mjs ([#1823](https://github.com/kamiazya/whiteboard/issues/1823)) ([2abd4f1](https://github.com/kamiazya/whiteboard/commit/2abd4f1ebf130bf2cafdb0e6434dfa33ef1dcb23))
* **scripts:** flake-watch keys an unhandled error, and names the leg for what it still cannot key ([#1813](https://github.com/kamiazya/whiteboard/issues/1813)) ([a4a35d1](https://github.com/kamiazya/whiteboard/commit/a4a35d186eb590bf5271538de028731aab13e086))
* **scripts:** flake-watch says whether the file has MOVED since it last failed ([#1740](https://github.com/kamiazya/whiteboard/issues/1740)) ([d850a31](https://github.com/kamiazya/whiteboard/commit/d850a317f3e65526262579b40fa6a4b5e4c668b7))
* **search:** a document is findable by what its emoji is called ([#1576](https://github.com/kamiazya/whiteboard/issues/1576)) ([687c49a](https://github.com/kamiazya/whiteboard/commit/687c49a558b664354b3b49df969fc823e21e37b2))
* **server-core:** a workspace defines its own stencils, as a document ([#1564](https://github.com/kamiazya/whiteboard/issues/1564)) ([7224ee3](https://github.com/kamiazya/whiteboard/commit/7224ee327804b01a71358daa98036b8fdfea04f9))
* **server-core:** an agent proposes a passage by default ([#1460](https://github.com/kamiazya/whiteboard/issues/1460)) ([c2f5306](https://github.com/kamiazya/whiteboard/commit/c2f53060a927d8f314d12528d3208a49241ca8b6))
* **server-core:** an agent proposes content by default ([#1454](https://github.com/kamiazya/whiteboard/issues/1454)) ([1e3e0be](https://github.com/kamiazya/whiteboard/commit/1e3e0bede6f0553f5f0f593abe9c4f7e57d508e0))
* **server-core:** tags on boards, nodes and edges through wb_facet_set, search and the in-use listing (ADR-0040 increment 3) ([#1617](https://github.com/kamiazya/whiteboard/issues/1617)) ([045322c](https://github.com/kamiazya/whiteboard/commit/045322c8b7697a60ef4053389b666ada5ddc0b98))
* **server-core:** wb_body_edit — a document's body edited by the passage ([#1458](https://github.com/kamiazya/whiteboard/issues/1458)) ([3cea93d](https://github.com/kamiazya/whiteboard/commit/3cea93d3d8eaf2e9dee421703a398b7c7d95f516))
* **server-core:** wb_canvas_edit can propose a batch instead of applying it ([#1446](https://github.com/kamiazya/whiteboard/issues/1446)) ([1291a1a](https://github.com/kamiazya/whiteboard/commit/1291a1aee2f8d5f7d5ebf67be82a322c3c5218df))
* **server-core:** wb_facet_list answers a workspace's own stencil vocabulary ([#1566](https://github.com/kamiazya/whiteboard/issues/1566)) ([4681b87](https://github.com/kamiazya/whiteboard/commit/4681b8766d99d7e0d52f67405e923ada765fe7fa))
* the colon completion offers icons, under their own heading ([#1588](https://github.com/kamiazya/whiteboard/issues/1588)) ([dd98e67](https://github.com/kamiazya/whiteboard/commit/dd98e677f1385b6637365a6b6087b4484bb8a117))
* the daemon's export draws by the tag library, and GET /document-tags answers it (ADR-0040 increment 5b-1) ([#1624](https://github.com/kamiazya/whiteboard/issues/1624)) ([5853074](https://github.com/kamiazya/whiteboard/commit/5853074b58e206d45149afe1f4bff8461be6e071))
* the local daemon serves the shared people API and list (ADR-0049 decision 5) ([#1908](https://github.com/kamiazya/whiteboard/issues/1908)) ([999bedd](https://github.com/kamiazya/whiteboard/commit/999bedd9a600e0c41ab355b88441418bc39843cf))
* the render theme layer's polish, and edges whose routing and bends live in facets ([#1547](https://github.com/kamiazya/whiteboard/issues/1547)) ([1088007](https://github.com/kamiazya/whiteboard/commit/10880075631780c75b3f6148cf00b65daec8a26f))
* the workspace tag library — declared keys, admitted values, colour by intent (ADR-0040 increment 5a) ([#1623](https://github.com/kamiazya/whiteboard/issues/1623)) ([7eb48e6](https://github.com/kamiazya/whiteboard/commit/7eb48e685530ceae46724f1a5ee3a04e2dc9acc5))
* **web-pages:** a browser-kept document shows its Connections ([#1864](https://github.com/kamiazya/whiteboard/issues/1864)) ([f0b3aee](https://github.com/kamiazya/whiteboard/commit/f0b3aee8d1b1d754d4d5fb67865b14f600fa30ac))
* **web-pages:** a browser-kept row can be duplicated, and a duplicate means one thing ([#1854](https://github.com/kamiazya/whiteboard/issues/1854)) ([467c237](https://github.com/kamiazya/whiteboard/commit/467c237268b65c910a69b71d88bc6da76fa7d7ca))
* **web:** `:name:` draws as its emoji, and typing `:` offers the name ([#1569](https://github.com/kamiazya/whiteboard/issues/1569)) ([ac3213a](https://github.com/kamiazya/whiteboard/commit/ac3213a0bb85d191ba72e0ba43e0493b0e457a5e))
* **web:** a band takes the relations it gathered both ends of, and the editor's per-kind decisions become one module ([#1649](https://github.com/kamiazya/whiteboard/issues/1649)) ([2e579c6](https://github.com/kamiazya/whiteboard/commit/2e579c6fad2d6abb28a9f1eee0b11ef20bef13e5))
* **web:** a daemon write that has not landed reads as 'Not saved yet', not Reconnecting ([#1894](https://github.com/kamiazya/whiteboard/issues/1894)) ([f1a31ee](https://github.com/kamiazya/whiteboard/commit/f1a31eeb240ad333bffc2d798a01570a856ea4b9))
* **web:** a daemon-kept board can be copied as JSON Canvas from its own page ([#1788](https://github.com/kamiazya/whiteboard/issues/1788)) ([d9bdcc4](https://github.com/kamiazya/whiteboard/commit/d9bdcc4f20de34c3756551db2ef2c2c448a098aa))
* **web:** a daemon-kept document can be deleted from its own page ([#1786](https://github.com/kamiazya/whiteboard/issues/1786)) ([41dda33](https://github.com/kamiazya/whiteboard/commit/41dda33347ba46866dd8555c190a6ed3219688d7))
* **web:** a daemon-kept document can be duplicated from its own page ([#1784](https://github.com/kamiazya/whiteboard/issues/1784)) ([1367040](https://github.com/kamiazya/whiteboard/commit/1367040c6c8a454f79b23731b4c47075f8bda248))
* **web:** a deletion re-asks the completion sources ([#1575](https://github.com/kamiazya/whiteboard/issues/1575)) ([2aa8eb7](https://github.com/kamiazya/whiteboard/commit/2aa8eb7157a5fad5f6993751b08a9a162e876783))
* **web:** a document's symbol marks its tab, its row and its overview ([#1481](https://github.com/kamiazya/whiteboard/issues/1481)) ([955ad83](https://github.com/kamiazya/whiteboard/commit/955ad838f3ed1704634c36e6fffa1a7b28a49bb2))
* **web:** a DocumentStore decorator keeps a daemon-kept replica as ciphertext at rest (ADR-0042 decision 2) ([#1688](https://github.com/kamiazya/whiteboard/issues/1688)) ([72bbd87](https://github.com/kamiazya/whiteboard/commit/72bbd8762ab2c7e51eaa3a003ab6e4fc7d3b1b3a))
* **web:** a finished `:name:` draws as its emoji while you write ([#1573](https://github.com/kamiazya/whiteboard/issues/1573)) ([e458666](https://github.com/kamiazya/whiteboard/commit/e458666529b83936d2bee96d1dc442041d01f312))
* **web:** a keeper can receive a workspace sent from another origin ([#1816](https://github.com/kamiazya/whiteboard/issues/1816)) ([4cde33c](https://github.com/kamiazya/whiteboard/commit/4cde33c004f828c8cea58c079247aa10a572c151))
* **web:** a markdown document's symbol is read by both keepers ([#1494](https://github.com/kamiazya/whiteboard/issues/1494)) ([d4187a8](https://github.com/kamiazya/whiteboard/commit/d4187a8a3e377ed11baa42e6bf863132f3968f82))
* **web:** a markdown note reaches its own history ([#1438](https://github.com/kamiazya/whiteboard/issues/1438)) ([9cfd81c](https://github.com/kamiazya/whiteboard/commit/9cfd81c0b64bfcb778a196abb0ca37be8f61c1c8))
* **web:** a merge Undo that undoes, a badge that keeps its type, and a result that says why ([#1439](https://github.com/kamiazya/whiteboard/issues/1439)) ([eefaf2e](https://github.com/kamiazya/whiteboard/commit/eefaf2ee89075da8036c153dd51f22e7e1316552))
* **web:** a person adopts a proposal from the bubble it is drawn on ([#1450](https://github.com/kamiazya/whiteboard/issues/1450)) ([a1f3294](https://github.com/kamiazya/whiteboard/commit/a1f32945a0bc174f47bc26a436cf85db276e3cf1))
* **web:** a proposal can be decided one change at a time ([#1451](https://github.com/kamiazya/whiteboard/issues/1451)) ([dcf517a](https://github.com/kamiazya/whiteboard/commit/dcf517a4de6a9ba2be383e2e17d3a8be8cf8b111))
* **web:** a remembered replica opens offline on one passkey gesture (ADR-0042 d6) ([#1769](https://github.com/kamiazya/whiteboard/issues/1769)) ([a806924](https://github.com/kamiazya/whiteboard/commit/a806924811dbb5bd30230415efc19866ccec3ece))
* **web:** a transfer to another keeper is confirmed with a passkey ([#1794](https://github.com/kamiazya/whiteboard/issues/1794)) ([0e5320f](https://github.com/kamiazya/whiteboard/commit/0e5320f26f30c1a86ae10246bca9561834a8731c))
* **web:** a workspace in server mode has a shell — the way back, the document's sync state, and who is signed in ([#1893](https://github.com/kamiazya/whiteboard/issues/1893)) ([ce2fd69](https://github.com/kamiazya/whiteboard/commit/ce2fd699317f37aee9331614d72b34ea70bdd2bf))
* **web:** a workspace's members in Settings — add a pinned passkey as a person, remove one behind a confirm (ADR-0041) ([#1708](https://github.com/kamiazya/whiteboard/issues/1708)) ([cff26c5](https://github.com/kamiazya/whiteboard/commit/cff26c5536e1cd21fab216e180262b278dc93096))
* **web:** an administrator deletes a deactivated person from the people page (ADR-0051 slice 3) ([#1921](https://github.com/kamiazya/whiteboard/issues/1921)) ([e1af003](https://github.com/kamiazya/whiteboard/commit/e1af003ed14762c94691125635187bda36bb200b))
* **web:** an end can be moved onto a different box ([#1664](https://github.com/kamiazya/whiteboard/issues/1664)) ([7cb4112](https://github.com/kamiazya/whiteboard/commit/7cb4112ca2aff6bfe31cb5011404b624e6cdfac3))
* **web:** confirm a workspace move with a passkey, and show the verified point in History ([#1612](https://github.com/kamiazya/whiteboard/issues/1612)) ([3a6591b](https://github.com/kamiazya/whiteboard/commit/3a6591be3f384e3fd4024996189747f1e75bfa2d))
* **web:** decide a proposed passage in the body ([#1461](https://github.com/kamiazya/whiteboard/issues/1461)) ([c94f27a](https://github.com/kamiazya/whiteboard/commit/c94f27a37a4e2550f59541f72c749bc9f80777f6))
* **web:** ink gains every verb the model already stored, and the matrix that found them ([#1652](https://github.com/kamiazya/whiteboard/issues/1652)) ([da77efd](https://github.com/kamiazya/whiteboard/commit/da77efdc53a481f3463471143fd72dacb8e3e709))
* **web:** manage a daemon's passkeys from Settings, and record what ADR-0039 actually shipped ([#1627](https://github.com/kamiazya/whiteboard/issues/1627)) ([4d6951e](https://github.com/kamiazya/whiteboard/commit/4d6951e4c70652fb9e4c0778af733d3b4e03e9ef))
* **web:** open a browser-kept variation from the address ([#1437](https://github.com/kamiazya/whiteboard/issues/1437)) ([62aede2](https://github.com/kamiazya/whiteboard/commit/62aede261b2b4d206c40b1f942e1356e97e4fcad))
* **web:** open and edit a workspace in the web app a server-mode keeper serves (ADR-0047 F2) ([#1891](https://github.com/kamiazya/whiteboard/issues/1891)) ([9179909](https://github.com/kamiazya/whiteboard/commit/9179909c0e319ca77d472c6e392d74c21eb5b023))
* **web:** people screens for a server-mode keeper (ADR-0049 slice 3) ([#1907](https://github.com/kamiazya/whiteboard/issues/1907)) ([1730678](https://github.com/kamiazya/whiteboard/commit/1730678747e397c0e67ecfbef876f17ed5aca1ee))
* **web:** retire the branch client, and the version list's lane column ([#1470](https://github.com/kamiazya/whiteboard/issues/1470)) ([642482b](https://github.com/kamiazya/whiteboard/commit/642482bb6ce7176dd04db8f3eec1d620c47c8b04))
* **web:** retire the variation surface, per ADR-0029 ([#1469](https://github.com/kamiazya/whiteboard/issues/1469)) ([b207a3d](https://github.com/kamiazya/whiteboard/commit/b207a3de92af81d76264e98c954538878111e221))
* **web:** retire the version row's thumbnail ([#1499](https://github.com/kamiazya/whiteboard/issues/1499)) ([170ed8a](https://github.com/kamiazya/whiteboard/commit/170ed8a3faddb25ad023a8a578e08042707d8f8b))
* **web:** send the browser workspace to another keeper by its address ([#1825](https://github.com/kamiazya/whiteboard/issues/1825)) ([4e8ef73](https://github.com/kamiazya/whiteboard/commit/4e8ef7304c9e2b2050c483ddbb824cc5df9f5aff))
* **web:** Settings lists every copy this device keeps, and a cached one can be deleted (ADR-0042 d3) ([#1755](https://github.com/kamiazya/whiteboard/issues/1755)) ([e3d53bd](https://github.com/kamiazya/whiteboard/commit/e3d53bd9c770806df71ce43036c9b37e64f21014))
* **web:** Settings shows what this device keeps of a daemon-kept workspace (ADR-0042) ([#1713](https://github.com/kamiazya/whiteboard/issues/1713)) ([3aebffa](https://github.com/kamiazya/whiteboard/commit/3aebffa1cf0a401b7d942bfadc5323f8979fe656))
* **web:** switch between your workspaces from the server-mode shell ([#1895](https://github.com/kamiazya/whiteboard/issues/1895)) ([a2ab7fb](https://github.com/kamiazya/whiteboard/commit/a2ab7fb84371dc0bd780f4f613306c5c1a2b22b3))
* **web:** tag rows in the Facets panel, the canvas settings and the document header (ADR-0040 increment 4a) ([#1618](https://github.com/kamiazya/whiteboard/issues/1618)) ([9cce1a4](https://github.com/kamiazya/whiteboard/commit/9cce1a4c0deb8efc58f2bd4aa3ee1416d953e84a))
* **web:** the browser keeper commits a merge, by adopting the source tip ([#1426](https://github.com/kamiazya/whiteboard/issues/1426)) ([266836e](https://github.com/kamiazya/whiteboard/commit/266836e49c1d1be60e2935589229511bbfd9d077))
* **web:** the browser keeper has variations, and `branches` stops being a capability ([#1425](https://github.com/kamiazya/whiteboard/issues/1425)) ([9414aee](https://github.com/kamiazya/whiteboard/commit/9414aeeb5773650b313d8a411fe871b9a6f13157))
* **web:** the browser keeper takes automatic checkpoints ([#1431](https://github.com/kamiazya/whiteboard/issues/1431)) ([abc07d4](https://github.com/kamiazya/whiteboard/commit/abc07d470007d41cf9d70042dbb8effa27455d82))
* **web:** the Classification form says what to type, and offers what the board already uses ([#1611](https://github.com/kamiazya/whiteboard/issues/1611)) ([ec00212](https://github.com/kamiazya/whiteboard/commit/ec00212ed61ffc60e91c9e7ef83b85d6a8949707))
* **web:** the cross-origin transfer contract, declared once for both ends ([#1800](https://github.com/kamiazya/whiteboard/issues/1800)) ([a629713](https://github.com/kamiazya/whiteboard/commit/a629713a1190c3045490ee8f5f9d851bc9dd291d))
* **web:** the daemon page answers the online membership gate — one passkey bind, then the removed page (ADR-0041 S8, slice 3) ([#1734](https://github.com/kamiazya/whiteboard/issues/1734)) ([831f1b5](https://github.com/kamiazya/whiteboard/commit/831f1b5ceafbef9143cae762a256cdf7905ed73e))
* **web:** the document browser's tag strip is the workspace's vocabulary, grouped by key and counted (ADR-0040 increment 4c) ([#1620](https://github.com/kamiazya/whiteboard/issues/1620)) ([acdc064](https://github.com/kamiazya/whiteboard/commit/acdc064a292385566f5a803751a0f84050bb740f))
* **web:** the editor reads the tag library — colour by intent on the board, every tag row completing from and refusing by the workspace's declaration (ADR-0040 increment 5b-2) ([#1625](https://github.com/kamiazya/whiteboard/issues/1625)) ([675de39](https://github.com/kamiazya/whiteboard/commit/675de3917224972e7dda21d07306171f00e9df90))
* **web:** the four ways to look at a document are one segment ([#1436](https://github.com/kamiazya/whiteboard/issues/1436)) ([ea0bd6a](https://github.com/kamiazya/whiteboard/commit/ea0bd6a1d60ff48148f7f29c0eb0a97305246d89))
* **web:** the Proposals inspector, an index that takes you to the card ([#1475](https://github.com/kamiazya/whiteboard/issues/1475)) ([7e14566](https://github.com/kamiazya/whiteboard/commit/7e1456684ed5a7daad54ae89d3cb3889ea5939a0))
* **web:** the read plane's browser key holder — sealed replicas, passkey session bind, v20 discard (ADR-0042/0043) ([#1719](https://github.com/kamiazya/whiteboard/issues/1719)) ([bd0663f](https://github.com/kamiazya/whiteboard/commit/bd0663f2c1277fd4cb6c2671f94002a2e414945d))
* **web:** the replica page's five states — needs a connection, readable, locked, unpaired, removed (ADR-0042 S5) ([#1720](https://github.com/kamiazya/whiteboard/issues/1720)) ([b2f3e65](https://github.com/kamiazya/whiteboard/commit/b2f3e6557af7c540d8eea08aca883d49736ee1d4))
* **web:** the variation chip is identity, so it sits beside the name ([#1440](https://github.com/kamiazya/whiteboard/issues/1440)) ([f6d3460](https://github.com/kamiazya/whiteboard/commit/f6d34609331f141b04d33f0f267f7764aa2a4363))


### Bug Fixes

* **annotations:** a conversation is a list of messages, and the first one is not special ([#1482](https://github.com/kamiazya/whiteboard/issues/1482)) ([e59824a](https://github.com/kamiazya/whiteboard/commit/e59824a6c871f29922cb658d14c6a4b1445548ce))
* **annotations:** a thread write goes through the reducer, and the gutter marker stops being the only way to reach a conversation ([#1434](https://github.com/kamiazya/whiteboard/issues/1434)) ([f7a81fa](https://github.com/kamiazya/whiteboard/commit/f7a81fa131d16a7bdecc5eb85703e921be630d4c))
* **annotations:** an opened conversation reads as one, in one type scale ([#1474](https://github.com/kamiazya/whiteboard/issues/1474)) ([42e9e99](https://github.com/kamiazya/whiteboard/commit/42e9e993896664fa10a049242ac377cb1ea2e1c6))
* **canvas-render:** a bubble can move away from a crowd, not only around it ([#1486](https://github.com/kamiazya/whiteboard/issues/1486)) ([71c56b4](https://github.com/kamiazya/whiteboard/commit/71c56b4ac838b97ae411490cc60272e3e97863d1))
* **canvas-render:** a code block's lines travel with its panel ([#1508](https://github.com/kamiazya/whiteboard/issues/1508)) ([16869b9](https://github.com/kamiazya/whiteboard/commit/16869b908e69979dfddfbc06b555b9dfec107ddf))
* **canvas-render:** a comment anchors across an inline boundary, and an inline image is painted ([#1578](https://github.com/kamiazya/whiteboard/issues/1578)) ([9d118af](https://github.com/kamiazya/whiteboard/commit/9d118aff47caff376a0751d5f96aec6dfe48c941))
* **canvas-render:** a named side pair whose route runs through the edge's own box is overruled ([#1527](https://github.com/kamiazya/whiteboard/issues/1527)) ([ca10382](https://github.com/kamiazya/whiteboard/commit/ca10382991c3df752526470ae3a7927ad6c498a0))
* **canvas-render:** a proposal's bubble is sized for a count, not for prose ([#1484](https://github.com/kamiazya/whiteboard/issues/1484)) ([1b744d9](https://github.com/kamiazya/whiteboard/commit/1b744d98cd0cf60ef97a74643483daf71750f5c4))
* **canvas-render:** a straight route that cuts back through its own box is an intrusion the search can see ([#1526](https://github.com/kamiazya/whiteboard/issues/1526)) ([3a3e7b6](https://github.com/kamiazya/whiteboard/commit/3a3e7b6aada98933655735bedf7c42ac7b212667))
* **canvas-render:** kinsoku holds across an inline boundary ([#1597](https://github.com/kamiazya/whiteboard/issues/1597)) ([f525d23](https://github.com/kamiazya/whiteboard/commit/f525d23c4cfcb8923ac372b5fc9fd9add8038b60))
* **canvas-render:** land edges on a shaped node's silhouette, mid-drag included ([#1473](https://github.com/kamiazya/whiteboard/issues/1473)) ([c985df4](https://github.com/kamiazya/whiteboard/commit/c985df49625ce7961259a412a5584768d48e9e71))
* **canvas-render:** the board flow is voted proportionally, so an arrow near 45 degrees decides nothing ([#1537](https://github.com/kamiazya/whiteboard/issues/1537)) ([4de54ad](https://github.com/kamiazya/whiteboard/commit/4de54ad1bc022a0b66a7b69c8f78a933d9c07baf))
* **canvas-render:** the frame margin yields to a row it cannot move, found by the eval lane ([#1544](https://github.com/kamiazya/whiteboard/issues/1544)) ([1ed81bf](https://github.com/kamiazya/whiteboard/commit/1ed81bf7e5e2b16ad11f22d40c1a9d96c983542f))
* **canvas-render:** tidy claims a box more than half inside a frame, instead of ejecting the one that straddles its edge ([#1536](https://github.com/kamiazya/whiteboard/issues/1536)) ([afa73d9](https://github.com/kamiazya/whiteboard/commit/afa73d90aff63f23cd77e5d1fa2bd73af5c7d367))
* **canvas-render:** tidy puts back a box whose alignment anchor moved away ([#1581](https://github.com/kamiazya/whiteboard/issues/1581)) ([048b071](https://github.com/kamiazya/whiteboard/commit/048b071d8002231b1caa3fe7a222d7e2ba073e9b))
* **canvas-render:** tidy settles — a board with a frame stops moving on the second tap ([#1548](https://github.com/kamiazya/whiteboard/issues/1548)) ([0095eec](https://github.com/kamiazya/whiteboard/commit/0095eececd9eff1985da677b9ad4471d7c9ac61b))
* **checks:** a null pack entry crashed the release gate instead of failing it ([#1690](https://github.com/kamiazya/whiteboard/issues/1690)) ([b50b0d9](https://github.com/kamiazya/whiteboard/commit/b50b0d91f67d6ead756c4f2384c4520d32a2d15c))
* **checks:** ci-gate waits for the API to catch up instead of failing a green run ([#1492](https://github.com/kamiazya/whiteboard/issues/1492)) ([a1082df](https://github.com/kamiazya/whiteboard/commit/a1082dfce26f170cc2991ef395bec46e509084ff))
* **ci:** main's SonarQube analysis is no longer cancelled by the next merge ([#1696](https://github.com/kamiazya/whiteboard/issues/1696)) ([fbcad92](https://github.com/kamiazya/whiteboard/commit/fbcad9299a008d8fdb63850871ffaf9af322b7a6))
* **cli:** a `--json` result cannot be WIDER than its contract ([#1742](https://github.com/kamiazya/whiteboard/issues/1742)) ([58d9fe6](https://github.com/kamiazya/whiteboard/commit/58d9fe601546b126572275c59259fe3aafbddfcf))
* **daemon-client:** check that an advertised did names the key beside it ([#1572](https://github.com/kamiazya/whiteboard/issues/1572)) ([828d4f1](https://github.com/kamiazya/whiteboard/commit/828d4f1349036a6f90c44b93d9c7c29b4deacc21))
* **daemon:** a caller may not name the device that saved a version ([#1574](https://github.com/kamiazya/whiteboard/issues/1574)) ([146dcba](https://github.com/kamiazya/whiteboard/commit/146dcba070680490a2bc5eb95fe80f7d3d90865c))
* **daemon:** a refusal's reason reaches the reader — one constructor, and a guard that no slot carries the wrong thing ([#1728](https://github.com/kamiazya/whiteboard/issues/1728)) ([e24939b](https://github.com/kamiazya/whiteboard/commit/e24939b2a3ae2dea30e27b6d41b15c07656cad66))
* **daemon:** the api error contract moves below its producer, and /api/v1's 19 refusals answer through it ([#1730](https://github.com/kamiazya/whiteboard/issues/1730)) ([c38b541](https://github.com/kamiazya/whiteboard/commit/c38b54175e4ddb15f883b40b5c1d67f1190523b7))
* **daemon:** the backup marker waits for EVERY refresh, not the one that started last ([#1780](https://github.com/kamiazya/whiteboard/issues/1780)) ([b65c5e3](https://github.com/kamiazya/whiteboard/commit/b65c5e304c9b9475edcb24f50b6db442c10d74b4))
* **deps:** bump knip to clear GHSA-7w5x-hrqm-74c2, and declare the jsdom it finds ([#1599](https://github.com/kamiazya/whiteboard/issues/1599)) ([ea744e4](https://github.com/kamiazya/whiteboard/commit/ea744e46e7e79bb49f404cba1d4200af7c6acce1))
* **deps:** lift sharp, js-yaml and hono past their advisories, and count what an errand costs in tool calls ([#1488](https://github.com/kamiazya/whiteboard/issues/1488)) ([1fd9893](https://github.com/kamiazya/whiteboard/commit/1fd98936b1e2747fa0a1761215b06fad6959dfa8))
* **dev:** the figure gate accepts a reason that starts with a short word, and stops asking a test-util for a picture ([#1765](https://github.com/kamiazya/whiteboard/issues/1765)) ([9011d73](https://github.com/kamiazya/whiteboard/commit/9011d731e6fb7eec032a771f5629922de2cc0d75))
* **docker:** refuse the layer cache on measurement, and fix the cache-mount trap it exposed ([#1449](https://github.com/kamiazya/whiteboard/issues/1449)) ([37672c5](https://github.com/kamiazya/whiteboard/commit/37672c51c249011728c24bd487a766efc914391c))
* **editor-state-property:** the two census floors that flake are chains, so the generator draws their conjunctions denser ([#1877](https://github.com/kamiazya/whiteboard/issues/1877)) ([94632fb](https://github.com/kamiazya/whiteboard/commit/94632fba64e957b2c91ba89c0c70a2f16baff246))
* **eval:** score the canvas the layout would draw, not the one the store holds ([#1641](https://github.com/kamiazya/whiteboard/issues/1641)) ([e09fbc2](https://github.com/kamiazya/whiteboard/commit/e09fbc21bb1e95276c5f7e014b514d66db93a2a8))
* **eval:** the drawing column reads the board as drawn, and round 21 is recorded ([#1642](https://github.com/kamiazya/whiteboard/issues/1642)) ([516c489](https://github.com/kamiazya/whiteboard/commit/516c489a83b24f21cc468faaa698203b04879298))
* **eval:** the lane's verifier read an edge end shape ADR-0038 retired ([#1585](https://github.com/kamiazya/whiteboard/issues/1585)) ([d7f6c56](https://github.com/kamiazya/whiteboard/commit/d7f6c5657cff0e2b968892942d537beab033405d))
* **lint:** anchor the plugin include patterns, and make a stored shape answer for itself ([#1539](https://github.com/kamiazya/whiteboard/issues/1539)) ([a812ddc](https://github.com/kamiazya/whiteboard/commit/a812ddc6df2b3cb14ebb5e171b9b5453fdda70e2))
* **mcp-server:** a daemon record this version cannot interpret stops ensure-daemon while its pid is running ([#1918](https://github.com/kamiazya/whiteboard/issues/1918)) ([50591f0](https://github.com/kamiazya/whiteboard/commit/50591f000b44e5fe0d9d51a1e890c804ae1d165c))
* **mcp-server:** a deactivated bearer is refused at /mcp, and a racing role change is refused rather than a 500 ([#1905](https://github.com/kamiazya/whiteboard/issues/1905)) ([a31c878](https://github.com/kamiazya/whiteboard/commit/a31c878ec027aae1376252616e2dce745dbf50d5))
* **mcp-server:** a record that exists but cannot be read is no longer read as absent ([#1913](https://github.com/kamiazya/whiteboard/issues/1913)) ([670fc38](https://github.com/kamiazya/whiteboard/commit/670fc38dfa54d89e8c80977294f985777b023a1b))
* **mcp-server:** a server-mode session changes nothing from another origin ([#1890](https://github.com/kamiazya/whiteboard/issues/1890)) ([9603447](https://github.com/kamiazya/whiteboard/commit/9603447060a03cb9f70b74975234221210abfa23))
* **mcp-server:** a thrown null turned a token refusal into a crash ([#1677](https://github.com/kamiazya/whiteboard/issues/1677)) ([6d068a4](https://github.com/kamiazya/whiteboard/commit/6d068a4cc725faabc6c1c1921da7b7bd5356e86b))
* **mcp-server:** an unreadable daemon identity or root key stops the start instead of being replaced ([#1910](https://github.com/kamiazya/whiteboard/issues/1910)) ([8c05904](https://github.com/kamiazya/whiteboard/commit/8c05904237eb3bc0320b175a06cb2a92fc4b5728))
* **mcp-server:** answer a caller's mistake with 400 on five daemon routes, found by fuzzing every route ([#1521](https://github.com/kamiazya/whiteboard/issues/1521)) ([7c3f923](https://github.com/kamiazya/whiteboard/commit/7c3f923c0708ea63aab0939c0c67898619d68f97))
* **mcp-server:** back up into a mounted volume, found by promoting the docker smoke ([#1433](https://github.com/kamiazya/whiteboard/issues/1433)) ([25e5794](https://github.com/kamiazya/whiteboard/commit/25e57948ef2068d50bf1728d8faf298593fbf21b))
* **mcp-server:** build the workspace before test:distribution packs a tarball ([#1553](https://github.com/kamiazya/whiteboard/issues/1553)) ([37715f5](https://github.com/kamiazya/whiteboard/commit/37715f538505799e53dce732c98d03149b40e197))
* **mcp-server:** file GC stands down for a backup marker it cannot read while the marker is fresh ([#1917](https://github.com/kamiazya/whiteboard/issues/1917)) ([b5e995d](https://github.com/kamiazya/whiteboard/commit/b5e995d35072fbc47d13f3b74eb05424d05cf838))
* **mcp-server:** grant-member recovers a workspace whose owners are all deactivated ([#1914](https://github.com/kamiazya/whiteboard/issues/1914)) ([d4e4c21](https://github.com/kamiazya/whiteboard/commit/d4e4c21f7654809c46acd5509ee75b81d49fc431))
* **mcp-server:** keep the daemon's two private keys out of backups ([#1648](https://github.com/kamiazya/whiteboard/issues/1648)) ([714ac99](https://github.com/kamiazya/whiteboard/commit/714ac999dcd29e37330d7f63d450e71b439cd2fa))
* **mcp-server:** losing access ends the sync stream a person already holds ([#1923](https://github.com/kamiazya/whiteboard/issues/1923)) ([80881ca](https://github.com/kamiazya/whiteboard/commit/80881caafefa0bde8f4b20a0c3fcf616fdc1fdf6))
* **mcp-server:** refuse a viewport body the browser cannot read with 400, not a 504 ([#1519](https://github.com/kamiazya/whiteboard/issues/1519)) ([8ea106f](https://github.com/kamiazya/whiteboard/commit/8ea106f7e258c6e0900f2a1244598bb94d2a6b59))
* **mcp-server:** resolve one libsql stack, and the 409 that was quietly becoming a 500 ([#1429](https://github.com/kamiazya/whiteboard/issues/1429)) ([ab59c95](https://github.com/kamiazya/whiteboard/commit/ab59c95449f414a8e5a41772a01b27ebaa21c674))
* **mcp-server:** stop `server run` echoing an argument named like an object key ([#1656](https://github.com/kamiazya/whiteboard/issues/1656)) ([cda19d2](https://github.com/kamiazya/whiteboard/commit/cda19d22e3a642f15f009ad67170bf6cd93c5782))
* **mcp-server:** the backup marker writes a whole-millisecond deadline, found by round-tripping every persisted JSON ([#1525](https://github.com/kamiazya/whiteboard/issues/1525)) ([f5f4470](https://github.com/kamiazya/whiteboard/commit/f5f4470959ac34b92afa6f4622cbacc8436a6df0))
* **mcp-server:** the env differential's coverage claim is walked, not drawn ([#1698](https://github.com/kamiazya/whiteboard/issues/1698)) ([59c62a6](https://github.com/kamiazya/whiteboard/commit/59c62a689e4b91a62fc1e436fe5940c12c96f509))
* **mcp-server:** the facet score counted a channel a board does not draw, and node.add dropped a stencil silently ([#1562](https://github.com/kamiazya/whiteboard/issues/1562)) ([6de3c6d](https://github.com/kamiazya/whiteboard/commit/6de3c6d7a7625bcef6dada182d2c3adf3d24fddc))
* **mcp-server:** the read-plane smoke seeded settings on every navigation, erasing the replica registry it was testing; harden its log and key checks ([#1726](https://github.com/kamiazya/whiteboard/issues/1726)) ([c31dc20](https://github.com/kamiazya/whiteboard/commit/c31dc20cfd42e69c33ec7257563dc5413d192ea6))
* **mcp:** the /api/debug ban says what is TRUE — the route was never removed ([#1744](https://github.com/kamiazya/whiteboard/issues/1744)) ([b8c3f9e](https://github.com/kamiazya/whiteboard/commit/b8c3f9e78ebff0f7b816cb58b122f27c22432c57))
* **mcp:** the backup marker is not recreated by its own last refresh ([#1764](https://github.com/kamiazya/whiteboard/issues/1764)) ([7c44fa7](https://github.com/kamiazya/whiteboard/commit/7c44fa7282a937fd1dd5a66e5e32e659eda41205))
* **mcp:** the tool-surface oracle did not resolve $ref, in both directions ([#1593](https://github.com/kamiazya/whiteboard/issues/1593)) ([b907c79](https://github.com/kamiazya/whiteboard/commit/b907c7947348d8cf9d99d66daea853a23a6b2d0e))
* **model:** an unplaceable passage is a conflict, and lint the claim's await ([#1487](https://github.com/kamiazya/whiteboard/issues/1487)) ([3a792bc](https://github.com/kamiazya/whiteboard/commit/3a792bc858165158633c55962d7391500f4e1e39))
* **mutation:** the lane's per-mutant test filter matched no test inside a describe ([#1621](https://github.com/kamiazya/whiteboard/issues/1621)) ([70d5fbf](https://github.com/kamiazya/whiteboard/commit/70d5fbfc46aa9def86cc8d8af83e0555106dffe2))
* **okf:** an OKF refusal names the key that failed, and the shape to send ([#1643](https://github.com/kamiazya/whiteboard/issues/1643)) ([1e1a2ba](https://github.com/kamiazya/whiteboard/commit/1e1a2ba485bdcfa37aabd8fc1ef7489f991276e8))
* **plugin:** declare Apache-2.0 in every distribution manifest ([#1598](https://github.com/kamiazya/whiteboard/issues/1598)) ([7d2cd4f](https://github.com/kamiazya/whiteboard/commit/7d2cd4f6b785dace4ecc19918c5eea9d34867b79))
* **reference-graph:** linking a mention keeps a board's lines and tags, and the browser can link too ([#1869](https://github.com/kamiazya/whiteboard/issues/1869)) ([d78cf22](https://github.com/kamiazya/whiteboard/commit/d78cf228ad807520567dbecabb1750b74cf6126a))
* **render:** sceneDigest sorts by code unit everywhere, as its own header already required ([#1749](https://github.com/kamiazya/whiteboard/issues/1749)) ([2a3d23c](https://github.com/kamiazya/whiteboard/commit/2a3d23c92f2354972b9f1255ce38cc29c73f6a41))
* **repo:** `pnpm lint` fails on a warning, which CONTRIBUTING has claimed all along ([#1750](https://github.com/kamiazya/whiteboard/issues/1750)) ([65c2d6f](https://github.com/kamiazya/whiteboard/commit/65c2d6f311f899a3f908fc7426d7beed662499e0))
* **review:** complexity-of reads its first file without --base, and shows a function that moved files as a move ([#1829](https://github.com/kamiazya/whiteboard/issues/1829)) ([6ef5c64](https://github.com/kamiazya/whiteboard/commit/6ef5c64a4f9a69ac9c54e654e4bc290ea97cb67c))
* **server-core:** a fourth thread op would have been silently ignored ([#1678](https://github.com/kamiazya/whiteboard/issues/1678)) ([dc844cb](https://github.com/kamiazya/whiteboard/commit/dc844cb9ad1c82d70142fd3139ee26427475c088))
* **server-core:** a proposed change can carry a node's text again ([#1799](https://github.com/kamiazya/whiteboard/issues/1799)) ([550ddb9](https://github.com/kamiazya/whiteboard/commit/550ddb94831118b4c68b6e2f109a9a3f38ccd828))
* **server-core:** a proposed node or line removal was covered by nothing ([#1683](https://github.com/kamiazya/whiteboard/issues/1683)) ([7c0dc75](https://github.com/kamiazya/whiteboard/commit/7c0dc75cdf401c5336a554fe625e9258ec967c89))
* **server-core:** answer 400, not 500, when a created markdown body is not OKF ([#1516](https://github.com/kamiazya/whiteboard/issues/1516)) ([1b18b61](https://github.com/kamiazya/whiteboard/commit/1b18b6183b0cbf044620f0ff5e72dafabafa800b))
* **server:** canvas_view names what a canvas's own text nodes embed ([#1421](https://github.com/kamiazya/whiteboard/issues/1421)) ([dd1f460](https://github.com/kamiazya/whiteboard/commit/dd1f460b63de85d7494ec69c7b525e1600948a7d))
* **sonar:** the code-unit sort order is triaged, and the triage is now checked ([#1700](https://github.com/kamiazya/whiteboard/issues/1700)) ([0ce1225](https://github.com/kamiazya/whiteboard/commit/0ce12259b15dc2994caec2c2e69caa295fd277ec))
* **store:** root-cause the compaction flake — the fixture's gain was inside Loro's encoding noise ([#1646](https://github.com/kamiazya/whiteboard/issues/1646)) ([48bd3a3](https://github.com/kamiazya/whiteboard/commit/48bd3a3ffc491f37f9f94924684666f3f8c8e152))
* **test:** the reference property applies its canvas edits, and always makes one ([#1457](https://github.com/kamiazya/whiteboard/issues/1457)) ([066a0b4](https://github.com/kamiazya/whiteboard/commit/066a0b4565ed3eb16ae5c0a4605e55b5884449f6))
* **tooling:** a new worktree stops inheriting the main checkout's built web app ([#1803](https://github.com/kamiazya/whiteboard/issues/1803)) ([11e02e6](https://github.com/kamiazya/whiteboard/commit/11e02e698f962200144a38d105bbd9829c56d875))
* **tooling:** pnpm dev keeps its daemon out of your real ~/.whiteboard ([#1806](https://github.com/kamiazya/whiteboard/issues/1806)) ([015b6b1](https://github.com/kamiazya/whiteboard/commit/015b6b131b62b823e72c0d993b431d06038c9205))
* **tooling:** the stale-issue check was reporting a clean backlog over 57 documents it never read ([#1776](https://github.com/kamiazya/whiteboard/issues/1776)) ([78c2ee2](https://github.com/kamiazya/whiteboard/commit/78c2ee2ad94bc9137f281e2c5f2e363fc68524c9))
* two write paths that failed silently, and the guards that name them ([#1478](https://github.com/kamiazya/whiteboard/issues/1478)) ([0bf0fa2](https://github.com/kamiazya/whiteboard/commit/0bf0fa20b766706303af87c3802530d0807b3c01))
* **versions:** ask whether THIS document changed, not whether the workspace did ([#1577](https://github.com/kamiazya/whiteboard/issues/1577)) ([265e1a9](https://github.com/kamiazya/whiteboard/commit/265e1a9d77a5a712de5ffbfbab1fba8e82a1c307))
* **versions:** mark the previewed version, separate its controls, and stop empty checkpoints ([#1503](https://github.com/kamiazya/whiteboard/issues/1503)) ([64d6a61](https://github.com/kamiazya/whiteboard/commit/64d6a61b4b87dce02dda5cbcaeca762923857ad8))
* **web:** a blob stored with an empty content type reads back instead of vanishing, found by round-tripping every IndexedDB shape ([#1533](https://github.com/kamiazya/whiteboard/issues/1533)) ([082e93f](https://github.com/kamiazya/whiteboard/commit/082e93fa1b3f7bbeddb38faa99ed4007980d45c9))
* **web:** a browser document opened on a variation says so, and both keepers show its chrome ([#1435](https://github.com/kamiazya/whiteboard/issues/1435)) ([2a441c1](https://github.com/kamiazya/whiteboard/commit/2a441c187184ef585f84741fad8e6ec53a6838bb))
* **web:** a completion tap refused inside the interaction delay is asked again ([#1699](https://github.com/kamiazya/whiteboard/issues/1699)) ([bd7f35c](https://github.com/kamiazya/whiteboard/commit/bd7f35cff17b82413076420db68d1f1fb6bdde8b))
* **web:** a daemon deep link no longer loses its own renewal race to the browser keeper; the replica refresh reports a failed pull ([#1732](https://github.com/kamiazya/whiteboard/issues/1732)) ([ffec0c4](https://github.com/kamiazya/whiteboard/commit/ffec0c4e818063df95580c1221a07c2e89dc5612))
* **web:** a daemon identity pin this build cannot read fails closed instead of reading as never pinned ([#1915](https://github.com/kamiazya/whiteboard/issues/1915)) ([b6a8860](https://github.com/kamiazya/whiteboard/commit/b6a8860b29eac4e76edc698d70f49ee9678f5087))
* **web:** a dropped node lands where it was released instead of flying back ([#1472](https://github.com/kamiazya/whiteboard/issues/1472)) ([737bf54](https://github.com/kamiazya/whiteboard/commit/737bf544b3be930a966906dd6ada3a1784e6545b))
* **web:** a duplicated daemon document keeps its kind ([#1767](https://github.com/kamiazya/whiteboard/issues/1767)) ([213e98c](https://github.com/kamiazya/whiteboard/commit/213e98c43ebb7ba03b04edeb59e897b6900cc933))
* **web:** a jsdom test file waits for its late console logs before its environment closes ([#1898](https://github.com/kamiazya/whiteboard/issues/1898)) ([1982efc](https://github.com/kamiazya/whiteboard/commit/1982efc050dd93e6575b1c0398147d75e22c6239))
* **web:** a jsdom test file waits for the dynamic imports it started before its environment is torn down ([#1832](https://github.com/kamiazya/whiteboard/issues/1832)) ([f49b248](https://github.com/kamiazya/whiteboard/commit/f49b248ab0d0e6a966350d0474e0a39a2e09a900))
* **web:** a position that rounds to NEGATIVE zero is stored as zero ([#1733](https://github.com/kamiazya/whiteboard/issues/1733)) ([465df1c](https://github.com/kamiazya/whiteboard/commit/465df1cedbd73ca7751e8ece62e1d67792bd0216))
* **web:** a revealed proposal frames its whole chrome, not just its bubble ([#1479](https://github.com/kamiazya/whiteboard/issues/1479)) ([1cd3cab](https://github.com/kamiazya/whiteboard/commit/1cd3cab2264b2fa03ce5720f2c8da01785b169c3))
* **web:** a store read that FAILED is not the document saying it has no content ([#1849](https://github.com/kamiazya/whiteboard/issues/1849)) ([09a228d](https://github.com/kamiazya/whiteboard/commit/09a228d6b3a2bd9fa29d972ccb9c057c80e3ccaf))
* **web:** a stored render entry is parsed before it is posted as a reply ([#1807](https://github.com/kamiazya/whiteboard/issues/1807)) ([3d2c99b](https://github.com/kamiazya/whiteboard/commit/3d2c99bf889f07aba2283deb432cd24609b42691))
* **web:** a tap on a completion option commits inside a canvas node's editor ([#1706](https://github.com/kamiazya/whiteboard/issues/1706)) ([818ee6f](https://github.com/kamiazya/whiteboard/commit/818ee6ff7e35c575be401486628c719b5c8b51b8))
* **web:** a touch tap on a completion option during the popup's disabled window is no longer dropped ([#1692](https://github.com/kamiazya/whiteboard/issues/1692)) ([57e3840](https://github.com/kamiazya/whiteboard/commit/57e38406d69d2a9f1d7a2e0ceb2969f2e58c9efd))
* **web:** an undo takes back the edit still inside its debounce window ([#1795](https://github.com/kamiazya/whiteboard/issues/1795)) ([93789c0](https://github.com/kamiazya/whiteboard/commit/93789c0b6d8d4b1eebabb86696cc5a838fb21975))
* **web:** element ids fall back to getRandomValues, not Math.random ([#1695](https://github.com/kamiazya/whiteboard/issues/1695)) ([73ebae9](https://github.com/kamiazya/whiteboard/commit/73ebae9a71f7b83235c1eacffd9a0dcd5f596b82))
* **web:** Enter on a file-tree row no longer also selects it, and a browser test says so ([#1680](https://github.com/kamiazya/whiteboard/issues/1680)) ([61b8605](https://github.com/kamiazya/whiteboard/commit/61b8605c7b88552fd89ef0a70457a7bffd3167f2))
* **web:** Enter takes the option the popup is DRAWING, not the newline under it ([#1716](https://github.com/kamiazya/whiteboard/issues/1716)) ([145cec8](https://github.com/kamiazya/whiteboard/commit/145cec884376aac169fa22c91bf8920b7cb227c1))
* **web:** let the inspect group fit its row, and put the settings dot on the gear ([#1506](https://github.com/kamiazya/whiteboard/issues/1506)) ([2635d47](https://github.com/kamiazya/whiteboard/commit/2635d47223abb1c4ec973bb031d28b60af873ec6))
* **web:** mount a settings section once, so two copies of a card cannot diverge ([#1632](https://github.com/kamiazya/whiteboard/issues/1632)) ([084ede0](https://github.com/kamiazya/whiteboard/commit/084ede02a47d85d050f9755702039996a3eed405))
* **web:** one stored entry this build cannot read costs that entry, not every daemon's ([#1911](https://github.com/kamiazya/whiteboard/issues/1911)) ([4e7cf60](https://github.com/kamiazya/whiteboard/commit/4e7cf602b089f75b45cbe6dd2fa3af249c0d1960))
* **web:** order facet suggestions for a reader, and pin the digest's order against that advice ([#1691](https://github.com/kamiazya/whiteboard/issues/1691)) ([20acccf](https://github.com/kamiazya/whiteboard/commit/20acccf8f287546049157203787c60c40698b6d4))
* **web:** patch loro-codemirror so the first keystroke reaches the CRDT ([#1496](https://github.com/kamiazya/whiteboard/issues/1496)) ([008a4ad](https://github.com/kamiazya/whiteboard/commit/008a4adf451e8303585a5e28914c724f2d0211d5))
* **web:** save automatic checkpoints for markdown documents in browser mode ([#1511](https://github.com/kamiazya/whiteboard/issues/1511)) ([4c37757](https://github.com/kamiazya/whiteboard/commit/4c377574b8e6dccf13400b357341422d4eeff512))
* **web:** Shift-Tab puts a line back where Tab took it from, under ragged indentation ([#1781](https://github.com/kamiazya/whiteboard/issues/1781)) ([39423bf](https://github.com/kamiazya/whiteboard/commit/39423bf9d77457a430492667bcbb47f89ad8123b))
* **web:** stop the daemon-page request storm from an unresolved address ping-pong; add the read-plane real-browser smoke ([#1721](https://github.com/kamiazya/whiteboard/issues/1721)) ([fe779d7](https://github.com/kamiazya/whiteboard/commit/fe779d73a0703be78bd2d4e6cbbaebcba6aafa49))
* **web:** the browser keeper's version rows carry `auto` and the variation, and cap the checkpoints ([#1428](https://github.com/kamiazya/whiteboard/issues/1428)) ([d219071](https://github.com/kamiazya/whiteboard/commit/d219071b8a7adb203af127530dd6372433463c57))
* **web:** the changed dot joins the badge blue the app already had ([#1432](https://github.com/kamiazya/whiteboard/issues/1432)) ([281d90a](https://github.com/kamiazya/whiteboard/commit/281d90a08df00366bacde3172a3d2be756783f69))
* **web:** the exit-fullscreen control takes the corner where the width allows ([#1418](https://github.com/kamiazya/whiteboard/issues/1418)) ([10cc5f5](https://github.com/kamiazya/whiteboard/commit/10cc5f5c0fb10998a8cfcba30714419d6d6db829))
* **web:** the markdown editor follows content from elsewhere, and undo stops taking it back ([#1498](https://github.com/kamiazya/whiteboard/issues/1498)) ([1c2c36b](https://github.com/kamiazya/whiteboard/commit/1c2c36b8f50fa3c1014bd7770959cbe7f8c74e2e))
* **web:** the markdown editor remounts when its CRDT binding changes identity ([#1582](https://github.com/kamiazya/whiteboard/issues/1582)) ([397500b](https://github.com/kamiazya/whiteboard/commit/397500b4879c8fda2f21b430db3cd3c6cd129f8b))
* **web:** the offline replica page resolves its own references ([#1430](https://github.com/kamiazya/whiteboard/issues/1430)) ([5eb2da1](https://github.com/kamiazya/whiteboard/commit/5eb2da11757c7781a5bfb89e2ca1e4237e1f240d))
* **web:** the replica refresh and push stop when the page that armed them goes ([#1775](https://github.com/kamiazya/whiteboard/issues/1775)) ([aae3f7c](https://github.com/kamiazya/whiteboard/commit/aae3f7cb7c3707692bf9c877523c75f57c66d9a8))
* **web:** the SSE worker retries a write the keeper did not take, and tells the tab until it lands ([#1892](https://github.com/kamiazya/whiteboard/issues/1892)) ([ffdc8d7](https://github.com/kamiazya/whiteboard/commit/ffdc8d75b68bc198b8e6c016852fdc98b9a7f1be))
* **web:** the version preview draws in the app's theme and can be moved ([#1495](https://github.com/kamiazya/whiteboard/issues/1495)) ([b9b1d7e](https://github.com/kamiazya/whiteboard/commit/b9b1d7e5ae000d84745fa8d0e183e2a469efc7e4))


### Performance Improvements

* **ci:** let a version bump skip the image build it cannot affect ([#1452](https://github.com/kamiazya/whiteboard/issues/1452)) ([647d68e](https://github.com/kamiazya/whiteboard/commit/647d68e32903a61fd29b1c2a0a89563424c8f9b2))
* **web-lib:** one tag read per list read, and the budget could not see it until its fixture answered ([#1856](https://github.com/kamiazya/whiteboard/issues/1856)) ([56c98aa](https://github.com/kamiazya/whiteboard/commit/56c98aa17667c507139c13da5728f359f98b8297))
* **web-pages:** the daemon index screen reads its list and trash once ([#1871](https://github.com/kamiazya/whiteboard/issues/1871)) ([70efff7](https://github.com/kamiazya/whiteboard/commit/70efff70ded95ce19d97decef8a072046aa4c0d2))
* **web:** the files panel reads its list once on a mount, not twice ([#1801](https://github.com/kamiazya/whiteboard/issues/1801)) ([457f47b](https://github.com/kamiazya/whiteboard/commit/457f47bf49d19fcf17033e8250497e3b8263f119))


### Reverts

* the interaction-delay re-ask, whose premise this editor does not have ([#1705](https://github.com/kamiazya/whiteboard/issues/1705)) ([d0e3671](https://github.com/kamiazya/whiteboard/commit/d0e36716039456ba982a4be4e30a5198ccd0e54e))

## [0.0.19](https://github.com/kamiazya/whiteboard/compare/whiteboard-plugin-v0.0.18...whiteboard-plugin-v0.0.19) (2026-07-17)


### Bug Fixes

* **release:** keep npm pack --json parseable when prepack prints its gate message ([#254](https://github.com/kamiazya/whiteboard/issues/254)) ([3513039](https://github.com/kamiazya/whiteboard/commit/35130395a66a35c399c65e72468908f8d1733829))

## [0.0.18](https://github.com/kamiazya/whiteboard/compare/whiteboard-plugin-v0.0.17...whiteboard-plugin-v0.0.18) (2026-07-17)


### Bug Fixes

* **mcp-server:** align distribution smoke expectations with the shipped auth design and fix smoke-harness bugs ([#253](https://github.com/kamiazya/whiteboard/issues/253)) ([cfc5927](https://github.com/kamiazya/whiteboard/commit/cfc5927bbedd41d14668f9e2656fcc480f1fdcd4))
* **mcp-server:** make --data-dir govern all persistence, not just the daemon registry ([#251](https://github.com/kamiazya/whiteboard/issues/251)) ([bce72c9](https://github.com/kamiazya/whiteboard/commit/bce72c9d450a7bae078e85245062cc9f38f684c0))

## [0.0.17](https://github.com/kamiazya/whiteboard/compare/whiteboard-plugin-v0.0.16...whiteboard-plugin-v0.0.17) (2026-07-17)


### Bug Fixes

* **mcp-server:** reject conflicting daemon token sources (env + --token-stdin) ([#249](https://github.com/kamiazya/whiteboard/issues/249)) ([285da81](https://github.com/kamiazya/whiteboard/commit/285da81ba953c634bf9f3e0169d6b75b35e5349d))

## [0.0.16](https://github.com/kamiazya/whiteboard/compare/whiteboard-plugin-v0.0.15...whiteboard-plugin-v0.0.16) (2026-07-17)


### Features

* **mcp-server:** derive per-worktree dev daemon ports and guard daemon identity ([#246](https://github.com/kamiazya/whiteboard/issues/246)) ([90ea8c9](https://github.com/kamiazya/whiteboard/commit/90ea8c92a1b90cae13e3d419c201b214134d2c0b))


### Bug Fixes

* **mcp-server:** exempt the legitimate storage.dataDir value from the backup-restore smoke leak check ([#247](https://github.com/kamiazya/whiteboard/issues/247)) ([713ecf9](https://github.com/kamiazya/whiteboard/commit/713ecf91e7178e0527fd48696dfb4dc99a50a7de))

## [0.0.15](https://github.com/kamiazya/whiteboard/compare/whiteboard-plugin-v0.0.14...whiteboard-plugin-v0.0.15) (2026-07-17)


### Features

* **mcp-server:** isolate dev daemon data under repo-local .dev-data and make DATA_DIR test-injectable ([#243](https://github.com/kamiazya/whiteboard/issues/243)) ([9922f9d](https://github.com/kamiazya/whiteboard/commit/9922f9d98c24ea0f4ae85886235c0d1b09ded0db))


### Bug Fixes

* **mcp-server:** fix backup-restore smoke daemon registration and scrub WHITEBOARD_DEV from packaged smokes ([#245](https://github.com/kamiazya/whiteboard/issues/245)) ([0f5f1a9](https://github.com/kamiazya/whiteboard/commit/0f5f1a97cc99ea1131ad9ce766a6f64f7d1d296a))

## [0.0.14](https://github.com/kamiazya/whiteboard/compare/whiteboard-plugin-v0.0.13...whiteboard-plugin-v0.0.14) (2026-07-17)


### Bug Fixes

* **mcp-server:** skip LLM-CLI smokes when the CLI is absent so release gates pass on CI ([#241](https://github.com/kamiazya/whiteboard/issues/241)) ([1e0067f](https://github.com/kamiazya/whiteboard/commit/1e0067fa61d116d58aeb66d7de7a7b8183ba682a))

## [0.0.13](https://github.com/kamiazya/whiteboard/compare/whiteboard-plugin-v0.0.12...whiteboard-plugin-v0.0.13) (2026-07-17)


### Features

* **mcp-server:** add daemon exact-match hosted-origin allowlist (LNA prerequisite) ([#154](https://github.com/kamiazya/whiteboard/issues/154)) ([e1ea156](https://github.com/kamiazya/whiteboard/commit/e1ea156a93edcdc4f8e9a630a7ee07fafd46cf89))
* **mcp-server:** add the /authorize consent screen and approval flow ([#230](https://github.com/kamiazya/whiteboard/issues/230)) ([fb8b4da](https://github.com/kamiazya/whiteboard/commit/fb8b4da5b27737153fb54c2c107905b121fa6b79))
* **mcp-server:** auto-load .whiteboardrc / .whiteboard/config.yaml config files for the local daemon ([#187](https://github.com/kamiazya/whiteboard/issues/187)) ([4b12e6d](https://github.com/kamiazya/whiteboard/commit/4b12e6da7fcfb8a705ccc0337b6770822ba2717b))
* **mcp-server:** auto-open the browser at the daemon's own origin ([#221](https://github.com/kamiazya/whiteboard/issues/221)) ([1df1f3e](https://github.com/kamiazya/whiteboard/commit/1df1f3e2dd122198a30011f7f6b7ef18fdf0281f))
* **mcp-server:** bridge OAuth grants to WebSocket via short-lived connection tickets ([#232](https://github.com/kamiazya/whiteboard/issues/232)) ([f757485](https://github.com/kamiazya/whiteboard/commit/f757485d1ae0a0a6d6f5122a4a6fae989fc0335a))
* **mcp-server:** create_pairing_link tool — mint #wb= daemon-pairing URLs ([#167](https://github.com/kamiazya/whiteboard/issues/167)) ([e3e32b3](https://github.com/kamiazya/whiteboard/commit/e3e32b3ed4cf956dcf97391393e7d4b16c7ea06c))
* **mcp-server:** declare route/WS scopes in one registry, enforce WS scope per message ([#227](https://github.com/kamiazya/whiteboard/issues/227)) ([558b46f](https://github.com/kamiazya/whiteboard/commit/558b46fcbb336fcb305823645d4cfd52fb1f24d4))
* **mcp-server:** delete the legacy src/app UI — apps/web is now the only frontend (ADR 0001 complete) ([#203](https://github.com/kamiazya/whiteboard/issues/203)) ([b0207f9](https://github.com/kamiazya/whiteboard/commit/b0207f9978a2cad4eabeed0e3ed1dfa6372cb162))
* **mcp-server:** enforce approved OAuth grant scopes on /api/* ([#231](https://github.com/kamiazya/whiteboard/issues/231)) ([164fe01](https://github.com/kamiazya/whiteboard/commit/164fe01fa5769e5fabba502db2b0c98f54115904))
* **mcp-server:** OAuth 2.1 authorization-server skeleton for hosted-origin access ([#229](https://github.com/kamiazya/whiteboard/issues/229)) ([0020619](https://github.com/kamiazya/whiteboard/commit/0020619b8e63fc8d950b1c3671bcc50e527ffde5))
* **mcp-server:** serve the built apps/web as the daemon's same-origin canonical UI (R3 of MCP-UI retirement) ([#198](https://github.com/kamiazya/whiteboard/issues/198)) ([efca6d0](https://github.com/kamiazya/whiteboard/commit/efca6d060402ca339438fa672404fac00d5155c8))
* **mcp-server:** support wildcard subdomain patterns in allowed-origin allowlists ([#186](https://github.com/kamiazya/whiteboard/issues/186)) ([d09687f](https://github.com/kamiazya/whiteboard/commit/d09687fffd8f3323a27bbe92486404504c2e7219))
* **mcp-server:** unify canvas export behind export_canvas, add SVG support ([#220](https://github.com/kamiazya/whiteboard/issues/220)) ([372aec7](https://github.com/kamiazya/whiteboard/commit/372aec792c87234db81b252b7dc86d7fa066e6d1))
* **web,mcp-server:** rename branch/merge UI copy to Variation/Combine ([#185](https://github.com/kamiazya/whiteboard/issues/185)) ([12e1d09](https://github.com/kamiazya/whiteboard/commit/12e1d0990039db5b866a9d2648b19b2729489e52))
* **web:** add daemonConnectionPayloadSchema for the #wb= pairing fragment ([#153](https://github.com/kamiazya/whiteboard/issues/153)) ([d613644](https://github.com/kamiazya/whiteboard/commit/d61364420f1709c341898cf9e4a10fec5fa6eef6))
* **web:** add delete confirmation dialog to browser-local canvas page ([#152](https://github.com/kamiazya/whiteboard/issues/152)) ([de6cf6e](https://github.com/kamiazya/whiteboard/commit/de6cf6e264fbd35b71ffeb611373b132900413f4))
* **web:** add Duplicate canvas to the browser-local page and the daemon gallery ([#195](https://github.com/kamiazya/whiteboard/issues/195)) ([3487529](https://github.com/kamiazya/whiteboard/commit/34875294ff70567591f5300459a284b791d7103b))
* **web:** daemon canvas gallery page with Storage tab and working back navigation ([#184](https://github.com/kamiazya/whiteboard/issues/184)) ([088fb67](https://github.com/kamiazya/whiteboard/commit/088fb673cc51bb4846c0b202ec463053ab63ca99))
* **web:** daemon-detection probe, migration CTA banner, and copy-first browser-local import ([#163](https://github.com/kamiazya/whiteboard/issues/163)) ([c2c46e8](https://github.com/kamiazya/whiteboard/commit/c2c46e89850f3d5007677e7c22562cdbc213e0cc))
* **web:** make canvases addressable — history routing, deep links, and Pages SPA fallback ([#204](https://github.com/kamiazya/whiteboard/issues/204)) ([a023244](https://github.com/kamiazya/whiteboard/commit/a0232444875a02ffe4aca515f6716e6cc01fcb12))
* **web:** make the WS-rejected (live sync off) state unmissable on DaemonCanvasPage ([#171](https://github.com/kamiazya/whiteboard/issues/171)) ([f1fe3ed](https://github.com/kamiazya/whiteboard/commit/f1fe3ed50043bb8a406392711dc23bbeeba62458))
* **web:** migrate the doc-screenshot pipeline to canonical apps/web components (R4 of MCP-UI retirement) ([#197](https://github.com/kamiazya/whiteboard/issues/197)) ([393de85](https://github.com/kamiazya/whiteboard/commit/393de8559543e0c8f5519938bc50756ee09cfac9))
* **web:** probe-based capability tiers with an honest tier-2 notice ([#164](https://github.com/kamiazya/whiteboard/issues/164)) ([52e7e6e](https://github.com/kamiazya/whiteboard/commit/52e7e6e65ddbf6357868638927a863a40f835313))
* **web:** PWA — manifest, service worker precache, prompt-based update flow ([#162](https://github.com/kamiazya/whiteboard/issues/162)) ([feff1ff](https://github.com/kamiazya/whiteboard/commit/feff1ff0524338838905efe01f2b80cbfa3b8b7d))
* **web:** render the real daemon editor for the local-daemon provider state ([#181](https://github.com/kamiazya/whiteboard/issues/181)) ([41f2d83](https://github.com/kamiazya/whiteboard/commit/41f2d83eec89bd23f1ec28317b08ffbd12201cac))
* **web:** surface PNG/SVG export from the canvas header ([#217](https://github.com/kamiazya/whiteboard/issues/217)) ([f717cb3](https://github.com/kamiazya/whiteboard/commit/f717cb3dbf06549b43ef45489136949e7362f1fa))
* **web:** unify page chrome on WorkspaceTopBar and wire remaining components ([#168](https://github.com/kamiazya/whiteboard/issues/168)) ([6e0e3b6](https://github.com/kamiazya/whiteboard/commit/6e0e3b69f2fd02f7f070e8139fdc34d6db162580))
* **web:** unify the top-bar skeleton — WorkspaceTopBar local mode adopted by the browser-local page ([#183](https://github.com/kamiazya/whiteboard/issues/183)) ([503316e](https://github.com/kamiazya/whiteboard/commit/503316e0d6241a4082e5da46b348bd71a9730191))
* **web:** wire branch UI and merge into the daemon-paired canvas page ([#161](https://github.com/kamiazya/whiteboard/issues/161)) ([da6bbeb](https://github.com/kamiazya/whiteboard/commit/da6bbeb69d586203438576fd9d135b1f459c62c4))
* **web:** wire DaemonBackend into apps/web via #wb= pairing fragment ([#159](https://github.com/kamiazya/whiteboard/issues/159)) ([6e4c2a1](https://github.com/kamiazya/whiteboard/commit/6e4c2a146ba6d36e87f129c850f8878e60eed8bb))
* **web:** wire version history (list/restore) into the daemon-paired canvas page ([#160](https://github.com/kamiazya/whiteboard/issues/160)) ([ce4f2cb](https://github.com/kamiazya/whiteboard/commit/ce4f2cbd875d03f3d664277a740e1f6b36e9c8ec))
* **web:** workspace switcher, manual save, authorized thumbnails, and WS auth-loop fix ([#165](https://github.com/kamiazya/whiteboard/issues/165)) ([2c50941](https://github.com/kamiazya/whiteboard/commit/2c50941e18218bdb65ebaa9cee2e80d709092850))


### Bug Fixes

* cleanup-worktrees must not delete never-published lanes ([#172](https://github.com/kamiazya/whiteboard/issues/172)) ([1943acc](https://github.com/kamiazya/whiteboard/commit/1943acce5126efe8124c61db8c643cc727dd470b))
* close the open CodeQL alerts (ReDoS + case-insensitive tag matching) ([#210](https://github.com/kamiazya/whiteboard/issues/210)) ([7fed555](https://github.com/kamiazya/whiteboard/commit/7fed555caa2b921e4a6723d67174a98b755e6c75))
* **mcp-server,web:** keep MergeDialog confirm footer reachable below 800px viewports ([#173](https://github.com/kamiazya/whiteboard/issues/173)) ([08a91ae](https://github.com/kamiazya/whiteboard/commit/08a91ae2d5bc6e4f8e5f336c64b26846593b0c86))
* **mcp-server,web:** root-fix the two recurring CI test flakes ([#180](https://github.com/kamiazya/whiteboard/issues/180)) ([07be557](https://github.com/kamiazya/whiteboard/commit/07be55767efcdcc039066100a17039b47d5653d8))
* **mcp-server:** admit cross-name loopback origins on the WS upgrade ([#169](https://github.com/kamiazya/whiteboard/issues/169)) ([5ce6b62](https://github.com/kamiazya/whiteboard/commit/5ce6b620e885e6555bf912f86dcc000b98ae098f))
* **mcp-server:** allow targetless box-snapped arrows in the annotate tool schema ([#190](https://github.com/kamiazya/whiteboard/issues/190)) ([871dc02](https://github.com/kamiazya/whiteboard/commit/871dc022bca2ba2f2bf30538fa5e3f3be9a88611))
* **mcp-server:** clear request-timeout timers on early resolve in viewport/export routes ([#188](https://github.com/kamiazya/whiteboard/issues/188)) ([1808dfe](https://github.com/kamiazya/whiteboard/commit/1808dfe7ca20bd6495286e9e5dadcea537532bc2))
* **mcp-server:** correct box_with_label wrapping and expose frame names in canvas_inspect ([#219](https://github.com/kamiazya/whiteboard/issues/219)) ([81fce7d](https://github.com/kamiazya/whiteboard/commit/81fce7dd0bed6b94c9f091d8b4bf9ceb7edefd72))
* **mcp-server:** document every MCP tool input field and honor annotate_batch per-item groupAs ([#205](https://github.com/kamiazya/whiteboard/issues/205)) ([7987bc2](https://github.com/kamiazya/whiteboard/commit/7987bc28e275ca52ed1117a17b3acabaccd7ac5a))
* **mcp-server:** harden packaged tarball smoke daemon cold-start with opt-in bounded retry ([#156](https://github.com/kamiazya/whiteboard/issues/156)) ([680e076](https://github.com/kamiazya/whiteboard/commit/680e076dd31cc57299f2fdc045fb3fe9381ebb7a))
* **mcp-server:** harden scope enforcement (file-route write verbs, WS close on scope violation) ([#228](https://github.com/kamiazya/whiteboard/issues/228)) ([87145f5](https://github.com/kamiazya/whiteboard/commit/87145f54ad9c350eedc8f67812249cac441ce40c))
* **mcp-server:** harden WS binary import against malformed Loro frames ([#238](https://github.com/kamiazya/whiteboard/issues/238)) ([f404cbe](https://github.com/kamiazya/whiteboard/commit/f404cbea9dd2d8da004e07414f7397196d32f666))
* **mcp-server:** make auto-compact disposal deterministic against mid-disposal reschedules ([#193](https://github.com/kamiazya/whiteboard/issues/193)) ([de3e961](https://github.com/kamiazya/whiteboard/commit/de3e961d50dd7f7b4f61ff0004f62659288139ff))
* **mcp-server:** make export outputPath rejections name the allowed sandbox root ([#189](https://github.com/kamiazya/whiteboard/issues/189)) ([21ea32f](https://github.com/kamiazya/whiteboard/commit/21ea32fb406b566c0f2f0be6079747940154da03))
* **mcp-server:** make restore overwrite reconcile onto the target instead of replacing it ([#209](https://github.com/kamiazya/whiteboard/issues/209)) ([6a862fa](https://github.com/kamiazya/whiteboard/commit/6a862faa55a6214a39e560d631fc6062f14dd27b))
* **mcp-server:** redact secrets in log output ([#211](https://github.com/kamiazya/whiteboard/issues/211)) ([956dbc9](https://github.com/kamiazya/whiteboard/commit/956dbc93504336a3e837df069a25818e10247a12))
* **mcp-server:** reject update_element text patches on arrows instead of lying ok:true ([#215](https://github.com/kamiazya/whiteboard/issues/215)) ([b20f808](https://github.com/kamiazya/whiteboard/commit/b20f808dd1b1faaef868274a9162b2b46c4d7867))
* **mcp-server:** remove the unused create_canvas issueNumber slug prefix ([#202](https://github.com/kamiazya/whiteboard/issues/202)) ([b1a42cd](https://github.com/kamiazya/whiteboard/commit/b1a42cddad362d475e4126ac85c7e74c7bc76c1e))
* **mcp-server:** require bearer auth on canvas/asset GET routes ([#226](https://github.com/kamiazya/whiteboard/issues/226)) ([f0d94ee](https://github.com/kamiazya/whiteboard/commit/f0d94ee83bb082ea90afdc5d2d510b9b89528e4a))
* **mcp-server:** stop the packaged tarball smoke from inheriting WHITEBOARD_DEV ([#240](https://github.com/kamiazya/whiteboard/issues/240)) ([cdd5d6c](https://github.com/kamiazya/whiteboard/commit/cdd5d6caacd4d7c3f698383cfd24ba784847b93c))
* never treat main-ancestry as a fold signal in cleanup-worktrees ([#177](https://github.com/kamiazya/whiteboard/issues/177)) ([9f5bb89](https://github.com/kamiazya/whiteboard/commit/9f5bb89addd4d791301015aece45a34d31ad7707))
* **release:** narrow npm publish gate to publishability, not correctness ([#157](https://github.com/kamiazya/whiteboard/issues/157)) ([dbe61f9](https://github.com/kamiazya/whiteboard/commit/dbe61f9fa1b3cc8d1ab172e7acc7b6222a5e1002))
* **release:** use un-prefixed root outputs so advance-stable actually runs ([#239](https://github.com/kamiazya/whiteboard/issues/239)) ([52c5359](https://github.com/kamiazya/whiteboard/commit/52c5359793c0c91a02cd94b88b695498b7879788))
* **test:** pre-bundle testing-library deps to stop vitest browser dynamic-import flake ([#158](https://github.com/kamiazya/whiteboard/issues/158)) ([e86f298](https://github.com/kamiazya/whiteboard/commit/e86f2984753b04f8aeb56faf06873061610ffce0))
* **web:** apply theme tokens to page root so dark mode text is readable ([#174](https://github.com/kamiazya/whiteboard/issues/174)) ([5053285](https://github.com/kamiazya/whiteboard/commit/50532855e54e83a35ccb9126c77ab16f9ea2e36c))
* **web:** confirm copy-canvas-URL success/failure instead of failing silently ([#216](https://github.com/kamiazya/whiteboard/issues/216)) ([5f4b657](https://github.com/kamiazya/whiteboard/commit/5f4b657d52082c2dcc37461893a4305f1a6f7d40))
* **web:** give unsupported-browser notice an escape hatch to the daemon origin ([#222](https://github.com/kamiazya/whiteboard/issues/222)) ([2dfbb52](https://github.com/kamiazya/whiteboard/commit/2dfbb52d6ee5c1b98139ba264227011579d09343))
* **web:** keep the unsupported-browser notice and its escape hatch on one line ([#223](https://github.com/kamiazya/whiteboard/issues/223)) ([ebc951b](https://github.com/kamiazya/whiteboard/commit/ebc951bd89d7d9990a606a9e801808d27ff350fb))
* **web:** percent-encode workspaceId and slug in the import fetch paths ([#166](https://github.com/kamiazya/whiteboard/issues/166)) ([f92e7a3](https://github.com/kamiazya/whiteboard/commit/f92e7a3d24035b64b2b0800b04974e14b9c83041))
* **web:** polish the variation/combine UI — dark-mode preview panel, clearer hint copy, menu truncation, tooltip dismissal ([#199](https://github.com/kamiazya/whiteboard/issues/199)) ([cd8a658](https://github.com/kamiazya/whiteboard/commit/cd8a658c0903d0976773880119fb882a2a60565b))
* **web:** route apps/web diagnostics through app-logger and guard console with Biome ([#213](https://github.com/kamiazya/whiteboard/issues/213)) ([23c4dc6](https://github.com/kamiazya/whiteboard/commit/23c4dc6801c60e2a132ad6a3512696ff29458a84))


### Performance Improvements

* **web:** cut apps/web critical-path JS from 555KB to 119KB gz and fix the bundle gate to measure it ([#192](https://github.com/kamiazya/whiteboard/issues/192)) ([8dd0a54](https://github.com/kamiazya/whiteboard/commit/8dd0a54ad9821494b23ed7b162b45edd76e0d4b7))
* **web:** drop the loro-crdt manualChunks rule that dragged it into the entry's critical path ([#196](https://github.com/kamiazya/whiteboard/issues/196)) ([3220a8c](https://github.com/kamiazya/whiteboard/commit/3220a8c07918208e24057e913e71be7e41b45b5c))

## [0.0.12](https://github.com/kamiazya/whiteboard/compare/whiteboard-plugin-v0.0.11...whiteboard-plugin-v0.0.12) (2026-07-10)


### Features

* **mcp-server:** expose api-client/api-contracts subpaths, port pure libs to apps/web ([#140](https://github.com/kamiazya/whiteboard/issues/140)) ([ee277e4](https://github.com/kamiazya/whiteboard/commit/ee277e45b11b4f88be519beadc203f300e4f70cd))
* **mcp-server:** harden local-daemon auth surface ([#141](https://github.com/kamiazya/whiteboard/issues/141)) ([dca3863](https://github.com/kamiazya/whiteboard/commit/dca3863dcf5908da4520393efd59911f019269bf))
* **mcp-server:** move daemonToken out of runtime config into a one-shot TokenStore ([#148](https://github.com/kamiazya/whiteboard/issues/148)) ([8f9039f](https://github.com/kamiazya/whiteboard/commit/8f9039f84a10aba1d0e39b4c1aee7c95a3e10763))
* **web:** capability-gated daemon-feature teasers in apps/web ([#129](https://github.com/kamiazya/whiteboard/issues/129)) ([54362bf](https://github.com/kamiazya/whiteboard/commit/54362bf691823a3af5271d01c125489325bd3bad))
* **web:** editable canvas title with browser-local persistence ([#120](https://github.com/kamiazya/whiteboard/issues/120)) ([6e7eff4](https://github.com/kamiazya/whiteboard/commit/6e7eff4fa74ef48a1866f84020676b3131adbb61))
* **web:** id-addressed multi-canvas foundation for browser-local storage ([#122](https://github.com/kamiazya/whiteboard/issues/122)) ([0729393](https://github.com/kamiazya/whiteboard/commit/0729393804f35472610c2278875fd0be50aef2c1))
* **web:** make useCanvasSync capability-complete for daemon wiring ([#136](https://github.com/kamiazya/whiteboard/issues/136)) ([d231d21](https://github.com/kamiazya/whiteboard/commit/d231d214d401b98e11fa0c40f7e03458ec079463))
* **web:** multi-canvas UI — canvas switcher and New-canvas control ([#123](https://github.com/kamiazya/whiteboard/issues/123)) ([3646e43](https://github.com/kamiazya/whiteboard/commit/3646e43fe4e3fc7f8ae2521ca9ac277a271f5fc8))
* **web:** port branch UI (HeaderBranchChip / HeaderBranchBanner) ([#147](https://github.com/kamiazya/whiteboard/issues/147)) ([59c862f](https://github.com/kamiazya/whiteboard/commit/59c862f0c32fda46190fb8bb5cc8478776e659d0))
* **web:** port merge UI with a Zod-typed merge_committed event contract ([#144](https://github.com/kamiazya/whiteboard/issues/144)) ([8ea48e1](https://github.com/kamiazya/whiteboard/commit/8ea48e17efcc5625155f5241c6bdfb920aee9e4b))
* **web:** port misc UI components (CanvasThumb/ThemeToggle/ErrorBoundary/HeaderSaveDot) ([#143](https://github.com/kamiazya/whiteboard/issues/143)) ([51c7c77](https://github.com/kamiazya/whiteboard/commit/51c7c77133e789491bce9c92c943d9a56bada942))
* **web:** port pure-logic hooks (theme/dirty-state/fullscreen) to apps/web ([#139](https://github.com/kamiazya/whiteboard/issues/139)) ([57a021f](https://github.com/kamiazya/whiteboard/commit/57a021ff35b3abcaa8aee749707dd82c4a6b96e8))
* **web:** port StorageReportCard with Zod-validated storage responses ([#146](https://github.com/kamiazya/whiteboard/issues/146)) ([9393d78](https://github.com/kamiazya/whiteboard/commit/9393d787348f8292ee0cf5a7a2bdfde4680b901e))
* **web:** port useBranches (callback-based) and VersionTimeline ([#145](https://github.com/kamiazya/whiteboard/issues/145)) ([fb6baa3](https://github.com/kamiazya/whiteboard/commit/fb6baa3961233ed7b5c2d6d048119baf5a78649c))
* **web:** port WorkspaceTopBar aggregation component ([#149](https://github.com/kamiazya/whiteboard/issues/149)) ([29ca30e](https://github.com/kamiazya/whiteboard/commit/29ca30e8d7fcb93fabd08543c7e5df87bb9c5de9))


### Bug Fixes

* **audit-triage:** include skill resources/*.md in ai-assets scope ([10240b6](https://github.com/kamiazya/whiteboard/commit/10240b620f120f57abee089ddb8c46f74316f078))
* **claude:** fail fast on malformed dimension entries in audit/review workflows ([a217efc](https://github.com/kamiazya/whiteboard/commit/a217efc84ed88d0febc637664d0f39eb3c487d61))
* **claude:** give coverage-gap advisories the same dimension field as real findings ([55db21c](https://github.com/kamiazya/whiteboard/commit/55db21c46f8ef75c1bb8fd3189ea1aeda5fdd738))
* **claude:** keep review findings whose verify agent died instead of silently dropping ([fbd5c31](https://github.com/kamiazya/whiteboard/commit/fbd5c3136940a64dc7662c20bbba6398be95fac1))
* **claude:** make failed mandatory review lanes gate instead of silently passing ([336784e](https://github.com/kamiazya/whiteboard/commit/336784ed908081217f09c4853eb41d3d06bc5ffc))
* **release:** honour SMOKE_RPC_TIMEOUT in the tarball smoke path too ([#118](https://github.com/kamiazya/whiteboard/issues/118)) ([f8e5d17](https://github.com/kamiazya/whiteboard/commit/f8e5d17aa4294b4c7760cea1518d9387f0b42fb7))
* **web:** allow browser-local mode on Cloudflare Pages preview origins ([#133](https://github.com/kamiazya/whiteboard/issues/133)) ([f0e8b08](https://github.com/kamiazya/whiteboard/commit/f0e8b08581217a1bc506304f4501a8cce6eaeae6))

## [0.0.11](https://github.com/kamiazya/whiteboard/compare/whiteboard-plugin-v0.0.10...whiteboard-plugin-v0.0.11) (2026-07-05)


### Features

* **shared:** MigrationBundle contract + package export ([#116](https://github.com/kamiazya/whiteboard/issues/116)) ([63fa9a3](https://github.com/kamiazya/whiteboard/commit/63fa9a371c85725b2efef25fb44e5ec26c1d1a7a))
* **web:** add UserSettingsStore for non-secret UI prefs ([#112](https://github.com/kamiazya/whiteboard/issues/112)) ([1da4677](https://github.com/kamiazya/whiteboard/commit/1da4677f315ce10a57d572f620eba20b3d46411a))
* **web:** backend configuration chip ([#113](https://github.com/kamiazya/whiteboard/issues/113)) ([74a68ea](https://github.com/kamiazya/whiteboard/commit/74a68ea0311c0462e9a9eb2c8c6ae455e5835c9e))
* **web:** dismissable beta banner ([#115](https://github.com/kamiazya/whiteboard/issues/115)) ([e8a583b](https://github.com/kamiazya/whiteboard/commit/e8a583bb5ec4c936a4f41961761a5971da55c19c))


### Bug Fixes

* **ci:** cache Docker dry-run build, reuse mcp-server dist artifact ([#107](https://github.com/kamiazya/whiteboard/issues/107)) ([f7cbfcb](https://github.com/kamiazya/whiteboard/commit/f7cbfcb490656ad9bb13d27aeb57dad8c6693513))
* **mcp:** guard StorageReportCard async setState against post-unmount crashes ([#111](https://github.com/kamiazya/whiteboard/issues/111)) ([da16f36](https://github.com/kamiazya/whiteboard/commit/da16f362ee5db25be552ad92c3fdafa0eea82b45))
* **release:** extend smoke RPC deadline on CI publish jobs ([#110](https://github.com/kamiazya/whiteboard/issues/110)) ([0d28af5](https://github.com/kamiazya/whiteboard/commit/0d28af55af97e793a8a5c9422a1e2075fdb0e438))
* **release:** gate git-based plugin distribution behind releases via stable branch ([#114](https://github.com/kamiazya/whiteboard/issues/114)) ([5ae5deb](https://github.com/kamiazya/whiteboard/commit/5ae5debab2951a9164351e11ea6f2018dc153d0a))
* **web:** reconnect useCanvasSync on backend swap so reload keeps elements ([#117](https://github.com/kamiazya/whiteboard/issues/117)) ([12e304b](https://github.com/kamiazya/whiteboard/commit/12e304b6f67caeea6cb9d70460681c72f410c11a))

## [0.0.10](https://github.com/kamiazya/whiteboard/compare/whiteboard-plugin-v0.0.9...whiteboard-plugin-v0.0.10) (2026-07-05)


### Bug Fixes

* **deps:** clear runtime security alerts (dompurify, mermaid, otel core) ([#104](https://github.com/kamiazya/whiteboard/issues/104)) ([51a57da](https://github.com/kamiazya/whiteboard/commit/51a57da1e121ddfb3baaeb0a391b83cb322982a0))
* **release:** extend daemon startup timeout on CI publish jobs ([#108](https://github.com/kamiazya/whiteboard/issues/108)) ([6d661b1](https://github.com/kamiazya/whiteboard/commit/6d661b1987aad3c117b0b24a4c0de3b0243a86ee))
* **web:** give BrowserLocalCanvasPage a real layout — editor area was 0px ([#106](https://github.com/kamiazya/whiteboard/issues/106)) ([6233da7](https://github.com/kamiazya/whiteboard/commit/6233da74b426430f78a641b9d8b97b8511dbe2e8))

## [0.0.9](https://github.com/kamiazya/whiteboard/compare/whiteboard-plugin-v0.0.8...whiteboard-plugin-v0.0.9) (2026-07-05)


### Bug Fixes

* **ci:** unbreak publish jobs — validate-step cwd and SBOM generation under pnpm ([#100](https://github.com/kamiazya/whiteboard/issues/100)) ([617eeb9](https://github.com/kamiazya/whiteboard/commit/617eeb92fca5fd1f22b54fcc72eaf03d5b245a5a))
* **web:** address AI review follow-ups from [#100](https://github.com/kamiazya/whiteboard/issues/100) and [#102](https://github.com/kamiazya/whiteboard/issues/102) ([#103](https://github.com/kamiazya/whiteboard/issues/103)) ([583c618](https://github.com/kamiazya/whiteboard/commit/583c618506a5bcb510c0c5056c6bd7f968e1c0ec))
* **web:** unblank the deployed app — CSP wasm-unsafe-eval + self-hosted Excalidraw fonts ([#102](https://github.com/kamiazya/whiteboard/issues/102)) ([4857bb6](https://github.com/kamiazya/whiteboard/commit/4857bb635637add5b7aa41a23c478fe357e9e78f))

## [0.0.8](https://github.com/kamiazya/whiteboard/compare/whiteboard-plugin-v0.0.7...whiteboard-plugin-v0.0.8) (2026-07-05)


### Bug Fixes

* **ci:** unbreak release pipeline (wrangler pnpm fallback, invalid action pins) ([#98](https://github.com/kamiazya/whiteboard/issues/98)) ([c412d00](https://github.com/kamiazya/whiteboard/commit/c412d0095e155d56a63a45f1db964b17efef3ce3))

## [0.0.7](https://github.com/kamiazya/whiteboard/compare/whiteboard-plugin-v0.0.6...whiteboard-plugin-v0.0.7) (2026-07-05)


### Features

* **web:** integrate Excalidraw into BrowserLocalCanvasPage via useCanvasSync ([#70](https://github.com/kamiazya/whiteboard/issues/70)) ([ab0f39a](https://github.com/kamiazya/whiteboard/commit/ab0f39a0fe53cabbe104e3cfd75f17184b1167cb))


### Bug Fixes

* **app:** inject bearer token in Vite dev server and improve 401 error message ([b2ebb04](https://github.com/kamiazya/whiteboard/commit/b2ebb046e898fb104530a739e62155ef1a4433e9))
* **ci:** align vitest ecosystem versions via catalog to fix browser session timeout ([#82](https://github.com/kamiazya/whiteboard/issues/82)) ([dedd961](https://github.com/kamiazya/whiteboard/commit/dedd96149e1cb8ec121798e5e89c691204706006))
* **deps:** pin transitive vulns and bump catalog vite/vitest ([#84](https://github.com/kamiazya/whiteboard/issues/84)) ([71dd317](https://github.com/kamiazya/whiteboard/commit/71dd317011eaadf3721ac39931d0f6944d144699))
* **mcp:** treat text as label alias on arrow annotations in annotate_batch ([86a799e](https://github.com/kamiazya/whiteboard/commit/86a799e9bbc8d1965871542c72802d19e82f7e12))
* stop WebSocket retry loop on auth failure (close code 1008) ([8d36069](https://github.com/kamiazya/whiteboard/commit/8d36069ac03cb0914cecd373866b545c0c209e2e))
* tarball smoke (pnpm pack + tsx/esm + loro-crdt pin) + dogfood findings [#4](https://github.com/kamiazya/whiteboard/issues/4)/[#5](https://github.com/kamiazya/whiteboard/issues/5) ([#56](https://github.com/kamiazya/whiteboard/issues/56)) ([5a9e01c](https://github.com/kamiazya/whiteboard/commit/5a9e01c9c8a5fc2e9e222076cc057eb1f046db21))

## [0.0.6](https://github.com/kamiazya/whiteboard/compare/whiteboard-plugin-v0.0.5...whiteboard-plugin-v0.0.6) (2026-05-03)


### Features

* **mcp:** dev daemon, versioning, headless export, storage, and tracing ([#45](https://github.com/kamiazya/whiteboard/issues/45)) ([d79c94c](https://github.com/kamiazya/whiteboard/commit/d79c94cfda11a9172d7ac1ed79ab061b1abac3a9))


### Bug Fixes

* **mcp:** close PR [#45](https://github.com/kamiazya/whiteboard/issues/45) review follow-ups (6 issues) ([#47](https://github.com/kamiazya/whiteboard/issues/47)) ([1f792b8](https://github.com/kamiazya/whiteboard/commit/1f792b8ebfc42c350f5ffc032082a62ec95280b3))
* **store:** close file-gc Race C and lock version-store.save ([#48](https://github.com/kamiazya/whiteboard/issues/48)) ([42fcdfd](https://github.com/kamiazya/whiteboard/commit/42fcdfd20ef8dc83fc0c5ecd81144f2e2c7783e6))

## [0.0.5](https://github.com/kamiazya/whiteboard/compare/whiteboard-plugin-v0.0.4...whiteboard-plugin-v0.0.5) (2026-04-28)


### Features

* **mcp:** support outputPath and overwrite on export tools ([#32](https://github.com/kamiazya/whiteboard/issues/32)) ([d456517](https://github.com/kamiazya/whiteboard/commit/d4565178fa1d7c9167c58fc2aab0e7db9c332b0c))
* **plugin:** add Claude Code marketplace and restructure README ([#38](https://github.com/kamiazya/whiteboard/issues/38)) ([e0fde71](https://github.com/kamiazya/whiteboard/commit/e0fde7176cae33cf5a34b6a6c4e20fb344ac3b3d))
* **server:** introduce sqlite metadata store (kysely + libsql) ([#35](https://github.com/kamiazya/whiteboard/issues/35)) ([e041240](https://github.com/kamiazya/whiteboard/commit/e041240d39a1d3b347ee5f757b42241e98815651))


### Bug Fixes

* **app:** move onSceneChange debounce out of the render path ([#33](https://github.com/kamiazya/whiteboard/issues/33)) ([dcdb1a5](https://github.com/kamiazya/whiteboard/commit/dcdb1a56d1e3414bac654083a122af09dd4ed50f))
* **mcp:** bind tool handler return type to outputSchema ([#36](https://github.com/kamiazya/whiteboard/issues/36)) ([2298e2e](https://github.com/kamiazya/whiteboard/commit/2298e2e7ba1e2631d635e6c83172181f2f45fa83))
* **mcp:** default box_with_label fillStyle to solid when backgroundColor is themed ([#37](https://github.com/kamiazya/whiteboard/issues/37)) ([373e01f](https://github.com/kamiazya/whiteboard/commit/373e01f53d234d66fc6abce5340a6e860bb3b159))
* **mcp:** dogfood findings, schema-driven contracts, and execute() return types ([#42](https://github.com/kamiazya/whiteboard/issues/42)) ([5c5abda](https://github.com/kamiazya/whiteboard/commit/5c5abda5ac2f6d4b598930d227a06bb141f509f7))
* **mcp:** memoize workspace id and clean up /mcp transport per request ([#28](https://github.com/kamiazya/whiteboard/issues/28)) ([685551d](https://github.com/kamiazya/whiteboard/commit/685551dac880afd2129ceef43de504d2aa1f8a02))

## [0.0.4](https://github.com/kamiazya/whiteboard/compare/whiteboard-plugin-v0.0.3...whiteboard-plugin-v0.0.4) (2026-04-25)


### Bug Fixes

* harden MCP release and dev workflows ([#22](https://github.com/kamiazya/whiteboard/issues/22)) ([acfbcdb](https://github.com/kamiazya/whiteboard/commit/acfbcdb7568d24482482ffbec6ed68eeb65473b4))
* **release-please:** use linked-versions and put server.json at root ([#26](https://github.com/kamiazya/whiteboard/issues/26)) ([14756d4](https://github.com/kamiazya/whiteboard/commit/14756d47129b69738db1836ba6e8a1310f3edd64))

## [0.0.3](https://github.com/kamiazya/whiteboard/compare/whiteboard-plugin-v0.0.2...whiteboard-plugin-v0.0.3) (2026-04-25)


### Bug Fixes

* **release:** inline node-version (tag checkout predates .node-version) ([#20](https://github.com/kamiazya/whiteboard/issues/20)) ([866395a](https://github.com/kamiazya/whiteboard/commit/866395ac0be7bac1bbcb39e9ef71f0582480724a))
* **release:** use Node 24 + add force_publish_tag dispatch input ([#18](https://github.com/kamiazya/whiteboard/issues/18)) ([1c7bdcf](https://github.com/kamiazya/whiteboard/commit/1c7bdcff049252bc02bba6b03345704e16438a3d))
* **smoke:** pass fake DaemonClient to template tool execute (was port number) ([#21](https://github.com/kamiazya/whiteboard/issues/21)) ([a86a279](https://github.com/kamiazya/whiteboard/commit/a86a279a7421f2bf3757e4c97cb0f772ff187a7d))

## [0.0.2](https://github.com/kamiazya/whiteboard/compare/whiteboard-plugin-v0.0.1...whiteboard-plugin-v0.0.2) (2026-04-25)


### Features

* initial release of @kamiazya/whiteboard-mcp ([#4](https://github.com/kamiazya/whiteboard/issues/4)) ([d4c1d55](https://github.com/kamiazya/whiteboard/commit/d4c1d55efc4df56748679891f64858dbdbad85d4))


### Bug Fixes

* **release-please:** pin initial-version to 0.0.1 for both packages ([#9](https://github.com/kamiazya/whiteboard/issues/9)) ([6b35c8b](https://github.com/kamiazya/whiteboard/commit/6b35c8bb911e7e3360569a4aad6f738472bbbc82))
* **release:** force npm upgrade to avoid promise-retry MODULE_NOT_FOUND ([#13](https://github.com/kamiazya/whiteboard/issues/13)) ([f6e736b](https://github.com/kamiazya/whiteboard/commit/f6e736b033788cadef1971ea5e683b0034d59167))

## 0.0.1 (2026-04-25)


### Features

* initial release of @kamiazya/whiteboard-mcp ([#4](https://github.com/kamiazya/whiteboard/issues/4)) ([d4c1d55](https://github.com/kamiazya/whiteboard/commit/d4c1d55efc4df56748679891f64858dbdbad85d4))


### Bug Fixes

* **release-please:** pin initial-version to 0.0.1 for both packages ([#9](https://github.com/kamiazya/whiteboard/issues/9)) ([6b35c8b](https://github.com/kamiazya/whiteboard/commit/6b35c8bb911e7e3360569a4aad6f738472bbbc82))
* **release:** force npm upgrade to avoid promise-retry MODULE_NOT_FOUND ([#13](https://github.com/kamiazya/whiteboard/issues/13)) ([f6e736b](https://github.com/kamiazya/whiteboard/commit/f6e736b033788cadef1971ea5e683b0034d59167))
