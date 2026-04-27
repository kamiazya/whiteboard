# Library Research Prompt Template

Template for when you want a General Subagent to research both **library item identity** and **natural visual scale**.
This is written as a reusable worksheet that can be pasted into any Claude Code environment, even without a dedicated subagent.
It also covers **how the diagram should absorb brand / design guidelines** rather than focusing on icon research alone.

## Quick Map

- When to use it: icon index or scale is ambiguous
- Expected outputs: `recommended_indices`, `recommended_scales`, `notes`, `recheck_needed`
- Evaluation criteria: identity / visual scale / bbox bias / consistency / brand adaptation
- Paste-ready prompt: body text you can hand directly to a General Subagent
- Metadata example: how to save the result through `user_library_metadata_set`

## When To Use It

- The item names in a GCP / AWS / network / UML library are not enough to choose confidently
- You already did a `trial insert`, but the default scale still feels wrong
- You expect to reuse the same library and want to preserve knowledge in `aliases` / `notes` / `scales`
- You need to decide not just which index to use, but also how much to shrink or enlarge it
- You want to keep provider icons intact while adapting the surrounding diagram to brand / design guidelines

## Expected Output

At minimum, ask the subagent to return:

- `recommended_indices`
- `recommended_scales`
- `notes`
- `recheck_needed`

Optional additions:

- `rejected_indices`
- `follow_up_actions`
- `brand_guideline_notes`

## Evaluation Criteria

The General Subagent should evaluate at least:

- **identity**: is the icon actually the intended service?
- **visual scale**: does it feel oversized or undersized relative to nearby icons and labels?
- **bbox bias**: does transparent whitespace or bbox shape make the icon look visually too big or too small?
- **diagram context**: is it playing the role of edge / compute / data / async?
- **consistency**: does it match the relative scale of similar icons?
- **brand adaptation**: can the surrounding labels / frame / palette / legend absorb the brand without damaging the icon itself?

## Principles For Brand / Design Guideline Application

- Do **not** recolor or distort external provider icons in ways that hurt recognizability
- Handle brand adaptation mainly through `palette_set`, label colors, frames, legends, and annotation tone
- If company / product typography or emphasis rules exist, reflect them in the surrounding text rather than on the icon
- An infrastructure diagram is not a marketing banner; prioritize reading order and semantic separation over brand expression
- If strong brand colors would break semantic color meaning for data paths or trust boundaries, preserve semantic color and shift brand expression into supporting elements

## Workflow

1. Inspect the candidate library
2. Create a scratch canvas
3. Arrange candidate indices with `library_insert_batch`
4. Use `viewport_set` and `export_png` to make comparison easy
5. Narrow candidates by identity and visual scale
6. If needed, run another trial insert with explicit `scale`
7. Save the adopted result into `aliases` / `notes` / `scales` via `user_library_metadata_set`
8. Decide how palette / frame / label treatment should follow the brand / design guidance
9. In production, insert via `userLibraryName` with metadata as the baseline

## Paste-Ready Prompt

Fill in the placeholders and send the following directly to a General Subagent.

```md
You are researching Excalidraw library items for a diagram. Your job is not just to find the correct icon index, but also to determine a natural-looking scale for the diagram context.

Goal:
- Identify the correct library item(s) for <target services>
- Determine whether each item looks too large or too small at default size
- Propose recommended scales and short notes that can be saved into user library metadata
- Propose how the final diagram should reflect brand/design guidelines without breaking icon recognizability

Context:
- Library source: <userLibraryName | libraryUrl | libraryPath>
- Diagram type: <e.g. GCP web architecture, network topology, UML deployment>
- Visual role mapping: <e.g. edge=blue, compute=green, data=violet, async=orange>
- Candidate item indices: <e.g. 10,11,12,13,14,15>
- Target canvas: <canvasId or "scratch only">
- Optional neighboring elements to compare against: <labels / boxes / icons already on canvas>
- Brand / design guidance: <brand colors, typography, diagram conventions, logo usage constraints>

Operating rules:
- Use scratch canvas / trial insert first. Do not place uncertain icons directly into the production composition.
- Evaluate both identity and visual scale.
- Assume library items may have inconsistent bbox padding; do not trust default size blindly.
- If default size looks wrong, propose a specific numeric scale.
- Prefer a small number of strong recommendations over a vague long list.
- Keep notes short and reusable for future inserts.
- Do not recolor or distort third-party service icons just to match the brand.
- Adapt the surrounding diagram treatment instead: labels, frames, legend, semantic palette, and annotation tone.

Workflow:
1. Inspect the library and choose a small batch of candidate indices.
2. Trial insert them into a scratch canvas with library_insert_batch.
3. Fit the viewport and export PNG for visual review.
4. Compare candidates by:
   - correctness of icon meaning
   - apparent size relative to neighboring elements
   - bbox / whitespace bias
   - consistency with other selected icons
   - compatibility with brand/design guidelines
5. Decide which parts should follow brand styling versus provider-native icon styling.
6. If needed, run a second trial with explicit scale overrides.
7. Return final metadata suggestions suitable for user_library_metadata_set, plus brand adaptation notes.

Output format:
- recommended_indices:
  - <alias>: <itemIndex>
- recommended_scales:
  - "<itemIndex>": <scale>
- notes:
  - "<itemIndex>": "<short reusable note>"
- recheck_needed:
  - true | false
- rejected_indices:
  - <itemIndex>: "<why rejected>"
- brand_guideline_notes:
  - "<short rule or adjustment>"
- follow_up_actions:
  - <next action>

Quality bar:
- Do not stop at “this seems like the right icon”.
- Explicitly state whether the default size is acceptable.
- Explicitly state whether the diagram should preserve provider-native icon styling or adapt surrounding elements only.
- If scale remains uncertain, say what needs to be compared next.
```

## Metadata Example

```js
meta = user_library_metadata_get({ name: "gcp-icons" })
user_library_metadata_set({
  name: "gcp-icons",
  revision: meta.revision,
  aliases: {
    cloud_run: 13,
    cloud_sql: 22,
  },
  scales: {
    "13": 0.72,
    "22": 0.78,
  },
  notes: {
    "13": "Default feels oversized. Keep slightly smaller than edge icon.",
    "22": "Looks balanced near Cloud Run when kept under 0.8.",
  },
})
```

## Operating Notes

- Treat scale as the multiplier that feels least awkward inside the diagram, not as a geometrically "correct" number
- It is normal not to settle this in one pass; assume a two-step trial-insert workflow
- When in doubt, bias slightly smaller. In infrastructure diagrams, oversized icons make relationships harder to read
- Push brand adaptation into the diagram's presentation layer. Avoid changes that break icon recognizability or semantic color meaning
