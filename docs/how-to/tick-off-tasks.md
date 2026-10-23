# Tick off a task list

Keep a checklist in a markdown document and tick items off from the preview,
without going back to the source to edit `[ ]`.

## Write the list

A task item is a list item that starts with `[ ]` (open) or `[x]` (done):

```markdown
- [ ] draft the outline
- [x] pick a title
  - [ ] a nested item works the same way
```

The preview draws a box where a bullet would be, with a tick inside it once the
item is done. `-`, `*`, `+` and numbered markers all work, and so does a list
inside a quote.

## Tick an item

In **Split** and **Read** view, click the box. The item's `[ ]` becomes `[x]`
(or back) in the source, and nothing else on the line changes: the marker, the
indentation and the text stay as you wrote them.

From the keyboard, Tab to a box and press Enter or Space. Focus stays on the
same box after the toggle. A screen reader reads each box by its item's text and
announces the result, for example "draft the outline: checked".

The preview is read-only elsewhere, so version previews show the boxes but do
not respond to clicks. A box inside an embedded document (`![[path]]`) is part of
that document: open it to tick it. If a document has one, the boxes in it do not
respond, because the preview can no longer tell which source line each one is.

← Back to [How-to guides](README.md)
