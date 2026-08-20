# Install fonts so exports are not empty boxes

Your canvas reads fine on screen but exports as rows of `□□□`? The daemon draws exports with the
fonts **it** has, and it ships with a Latin face only. Any script it has no glyph for — Japanese,
Chinese, Korean, Thai, Devanagari, Arabic, Hebrew — is painted as an empty box.

This is a property of the daemon, not of your canvas or your browser: the text is intact, and an
SVG export still carries it as text that any viewer with the font can read. Only the rasterised
formats (PNG) bake in what the daemon could draw.

## Install one

1. Connect the web app to a local daemon (see
   [connect-to-local-daemon](connect-to-local-daemon.md)). Fonts live on the daemon, so this
   screen has nothing to offer without one.
2. Open **Settings → Fonts**.
3. Press **Install** next to the font covering the script you write in.

The daemon downloads it, checks it really is a font, and keeps it. Every later export uses it —
no restart, no configuration.

| Script | Font |
|---|---|
| Japanese | Noto Sans JP |
| Chinese (Simplified / Traditional) | Noto Sans SC / TC |
| Korean | Noto Sans KR |
| Thai, Devanagari, Arabic, Hebrew | Noto Sans Thai / Devanagari / Arabic / Hebrew |

A CJK font is 9–18 MB, because it carries thousands of glyphs. The others are under 1 MB.

All of them come from [Google Fonts](https://fonts.google.com/) and are licensed under the
[SIL Open Font License 1.1](https://openfontlicense.org/). Whiteboard does not redistribute
them; your daemon fetches them when you ask it to.

## Install one that is not listed

Any font already on your machine works. Copy the `.ttf`, `.otf`, or `.ttc` into the daemon's
`fonts` directory and it participates in the next export:

```
~/.whiteboard/fonts/
```

That is the location on every platform. If you set `WHITEBOARD_DATA_DIR`, it is
`$WHITEBOARD_DATA_DIR/fonts/` instead. (Where the home directory is not writable — some
sandboxes — the daemon falls back to `<temp>/.whiteboard`.)

`.woff2` is deliberately **not** accepted: the export renderer cannot decode it, so a file
dropped in that format would sit there and never draw anything.

## Why the app does not just download the font it needs

Installing reaches the network, and the daemon is also driven by AI agents that act on
instructions found in the documents they read. Making this an agent-callable action would let a
malicious canvas talk an agent into making the daemon fetch things. So it is a button a person
presses, and the only thing it accepts is a name from the list above — never a URL, not even
yours. The reasoning is recorded in
[ADR-0012](../contributing/adr/0012-user-installed-fonts.md).

← Back to [How-to guides](README.md)
