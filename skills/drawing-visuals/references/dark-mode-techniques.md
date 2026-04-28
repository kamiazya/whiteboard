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

## If Stuck

- For the base rules, see [`../style-reference.md`](../style-reference.md)
- If the main subject is infra / boundaries, see [`./cloud-and-network-zones.md`](./cloud-and-network-zones.md)
- If the main subject is trust crossings, see [`./trust-boundary-and-security.md`](./trust-boundary-and-security.md)
