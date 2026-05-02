# Dark Mode Techniques

Dark mode is not about splashing bright colors onto a black background. It is about drawing so that **meaning survives across themes**.

## Good Fits

- boards viewed in both dark and light mode
- screenshots or exports where the background color may change
- dense infra / architecture / review boards
- cases where you want glow or fill without breaking meaning

## Core Rules

- do not make meaning depend on canvas background color
- keep role colors stable across themes
- use stroke-first for containers / boundaries
- evaluate both `text vs box` contrast and `box vs canvas` contrast
- dark-mode decoration is optional; structure and labels come first

## Switch-Safe Drawing

- Read primary boxes through stroke and labels before fill
- Keep grouping / zone fill at low opacity
- Use glow only for emphasis, never as the meaning itself
- Neutral text disappears easily on dark backgrounds, so do not weaken subtitles too far
- Dashed / dotted differences are easier to miss in dark mode; reinforce the meaning with labels too

## Techniques That Work Well On A Dark Canvas

- On dense boards, use transparent or near-transparent cards
- Let boundaries read through labels more than through stroke weight
- Place zone / boundary labels as separate top-left text
- Raise fill intensity on only the emphasized box and leave the others stroke-first
- If you use glow, confine it to one main-path location

## Constraints That Keep It Safe In Light Mode Too

- Do not rely too much on pure black / pure white contrast
- Do not build hierarchy from faint gray alone
- Do not over-recolor provider icons or logos to match the theme
- Do not express optional / future-state only through opacity
- Do not express warning / danger only through background fill

## Palette Mindset

- Decide `primary / success / warning / danger / info / neutral` roles first
- Even if the dark-mode appearance changes, do not change those semantic mappings
- Absorb theme differences mainly through brightness / opacity / stroke weight rather than hue
- Do not let the same role drift semantically, such as blue in light mode and purple in dark mode

## Quality Check

- Can the main path still be followed in 5 seconds in both dark and light mode?
- Does any neutral text disappear?
- Are dashed / dotted lines still legible?
- If you remove the glow, does the meaning remain?
- Does exported PNG still preserve zone / boundary presence?

## Theme-Switched Export For Review

`export_png` accepts `theme: "light" | "dark"`. Use it to verify the canvas
survives a theme switch without changing the persisted appState:

```js
export_png({ canvasId, theme: "light", outputPath: "/abs/path/board-light.png" })
export_png({ canvasId, theme: "dark",  outputPath: "/abs/path/board-dark.png", overwrite: true })
```

Inspect the two PNGs side by side and walk the **Quality Check** above against
each one. Dashed / dotted strokes and low-opacity fills are usually the first
things to disappear under dark; if they do, reinforce them with labels or stop
relying on stroke style alone.

### Pre-Export Review Checklist

Walk this list against both PNGs before committing the canvas. Each item names
a concrete failure mode the export should *not* show.

- [ ] every box readable from labels alone — strip fills mentally and check that
      titles still carry meaning
- [ ] no neutral text below the equivalent of `text-muted-foreground` weight on
      a stroke-only container — those titles vanish in dark
- [ ] no light-grey fill (`#f1f5f9` family) used to mean "background / muted"
      — it inverts to glaring near-white in dark
- [ ] dashed / dotted strokes carry a label echoing their meaning (e.g.
      "optional", "future") — dashing alone is too thin in dark
- [ ] glow / shadow is the *secondary* signal, not the primary — removing it
      mentally must not break the meaning
- [ ] semantic colors (`primary`, `success`, `warning`, `danger`) keep the
      same role in both PNGs — no blue→purple or success→muted drift

If any item fails, fix it in the canvas, not in the export.

## Failure Modes Seen In The Wild

These are concrete patterns observed in real exported diagrams; treat each as a smell.

| Pattern in light | What dark mode does to it | Fix |
| --- | --- | --- |
| stroke-only rect with dark text title (`color: "neutral"` or `#475569`) | title and body text both fall under the dark canvas → unreadable | bump text to a higher-contrast role (`color: "primary"` against transparent stays legible), or fill the box softly so text reads against fill |
| light grey fill `#f1f5f9` used as "muted" / "secondary" | dark inverts to a near-white block that visually dominates the strong-fill main path | drop the fill to transparent and lean on stroke + label, or use `muted` semantic so the variable flips |
| dashed border alone for "optional / planned" | dashing pixels disappear into the dark background, the box reads as solid | keep dashing for redundancy but add an explicit label like `(future)` or `[optional]` |
| primary fill with `#ffffff` text (`Main path` style) | survives both themes unchanged — this is the safe default | use this combo for the canvas's main subject |

Regenerate light and dark exports with `export_png({ theme: ... })` against
the board you are reviewing, then compare them against the checklist above.

## If Stuck

- For the base rules, see [`../style-reference.md`](../style-reference.md)
- If the main subject is infra / boundaries, see [`./cloud-and-network-zones.md`](./cloud-and-network-zones.md)
- If the main subject is trust crossings, see [`./trust-boundary-and-security.md`](./trust-boundary-and-security.md)
