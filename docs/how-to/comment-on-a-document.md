# Comment on a document

Leave feedback anchored to a place in a document, and read the
conversations already on it. Works on both document kinds and with either
keeper — a workspace your browser holds, or one the daemon holds.

Comments are an annotation **layer**: they float above the content and are
never part of what the document says. Editing a document never tidies them,
and a document's own text never changes because someone commented on it.

## Open the conversations on a document

Every document's header carries a **Comments** button, with the number of
conversations still open on it. Press it to open the rail down the right
side.

The rail's filter starts on **Open**, because "what still needs an answer"
is the question a reader usually has. **Resolved** and **All** are one
press away. Press a row to expand a conversation and read its replies.

The rail is the surface a whole document has, so it reaches everything —
including a conversation whose subject has since been deleted, which is
marked `anchor gone` rather than hidden.

## Comment on a passage of markdown

Select the text you want to talk about, then either right-click it or press
**⋯ (Editing actions)** in the toolbar, and choose **Comment on this**.

The rail opens with the passage quoted and a box to write in. Nothing is
stored until you press **Comment** — a conversation cannot exist with
nothing said in it, so the passage is only a pending selection until then.
**Cancel** abandons it.

Once created, the passage is highlighted in the body and a marker appears
in the gutter beside it. Press the marker to open that conversation in the
rail; press a rail row to scroll the body to its passage.

There is no **Comment on this** row when nothing is selected. Every
formatting verb works out its own scope from the word under the caret,
which is right for a wrap you can see and undo — and wrong for an anchor
that gets stored, because the word under a caret is a guess about what you
meant.

## Comment on a canvas

Right-click a node for **Comment on this**, or empty canvas for **Comment
here**. The comment is drawn as a pin with a bubble, connected by a dotted
leader, and it also appears in the rail like any other conversation. Drag
a pin to move where its comment points.

## Reply, and close the conversation

Expanding a conversation in the rail shows a **Reply** box. A reply
inherits the conversation's anchor — it is the conversation that gets
closed, not an individual remark.

**Resolve** closes a conversation; **Reopen** brings it back. Resolving is
the only way to close one: nothing deletes a comment, because what a
conversation accumulates is the reason a decision was taken.

## What happens when the text moves

A markdown comment stores the passage it quotes plus a little of the text
on either side, so an edit elsewhere in the document does not lose it. When
the quoted passage itself is edited away, the conversation is not deleted —
it is marked `anchor gone` and stays reachable in the rail.

← Back to [how-to guides](README.md)
