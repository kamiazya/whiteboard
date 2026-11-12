//! markdown syntax tree: [mdast][].
//!
//! [mdast]: https://github.com/syntax-tree/mdast

use crate::vendored::unist::Position;
use alloc::{
    fmt,
    string::{String, ToString},
    vec::Vec,
};

/// Explicitness of a reference.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReferenceKind {
    /// The reference is implicit, its identifier inferred from its content.
    Shortcut,
    /// The reference is explicit, its identifier inferred from its content.
    Collapsed,
    /// The reference is explicit, its identifier explicitly set.
    Full,
}

/// GFM: alignment of phrasing content.
///
/// Used to align the contents of table cells within a table.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AlignKind {
    /// Left alignment.
    ///
    /// See the `left` value of the `text-align` CSS property.
    ///
    /// ```markdown
    ///   | | aaa |
    /// > | | :-- |
    ///       ^^^
    /// ```
    Left,
    /// Right alignment.
    ///
    /// See the `right` value of the `text-align` CSS property.
    ///
    /// ```markdown
    ///   | | aaa |
    /// > | | --: |
    ///       ^^^
    /// ```
    Right,
    /// Center alignment.
    ///
    /// See the `center` value of the `text-align` CSS property.
    ///
    /// ```markdown
    ///   | | aaa |
    /// > | | :-: |
    ///       ^^^
    /// ```
    Center,
    /// No alignment.
    ///
    /// Phrasing content is aligned as defined by the host environment.
    ///
    /// ```markdown
    ///   | | aaa |
    /// > | | --- |
    ///       ^^^
    /// ```
    None,
}

/// Nodes.
#[derive(Clone, Eq, PartialEq)]
pub enum Node {
    // Document:
    /// Root.
    Root(Root),

    // Container:
    /// Block quote.
    Blockquote(Blockquote),
    /// Footnote definition.
    FootnoteDefinition(FootnoteDefinition),
    /// List.
    List(List),

    // Phrasing:
    /// Break.
    Break(Break),
    /// Code (phrasing).
    InlineCode(InlineCode),
    /// Math (phrasing).
    InlineMath(InlineMath),
    /// Delete.
    Delete(Delete),
    /// Emphasis.
    Emphasis(Emphasis),
    /// Footnote reference.
    FootnoteReference(FootnoteReference),
    /// Html (phrasing).
    Html(Html),
    /// Image.
    Image(Image),
    /// Image reference.
    ImageReference(ImageReference),
    /// Link.
    Link(Link),
    /// Link reference.
    LinkReference(LinkReference),
    /// Strong
    Strong(Strong),
    /// Text.
    Text(Text),

    // Flow:
    /// Code (flow).
    Code(Code),
    /// Math (flow).
    Math(Math),
    /// Heading.
    Heading(Heading),
    /// Html (flow).
    // Html(Html),
    /// Table.
    Table(Table),
    /// Thematic break.
    ThematicBreak(ThematicBreak),

    // Table content.
    /// Table row.
    TableRow(TableRow),

    // Row content.
    /// Table cell.
    TableCell(TableCell),

    // List content.
    /// List item.
    ListItem(ListItem),

    // Content.
    /// Definition.
    Definition(Definition),
    /// Paragraph.
    Paragraph(Paragraph),
}

impl fmt::Debug for Node {
    // Debug the wrapped struct.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Node::Root(x) => x.fmt(f),
            Node::Blockquote(x) => x.fmt(f),
            Node::FootnoteDefinition(x) => x.fmt(f),
            Node::List(x) => x.fmt(f),
            Node::Break(x) => x.fmt(f),
            Node::InlineCode(x) => x.fmt(f),
            Node::InlineMath(x) => x.fmt(f),
            Node::Delete(x) => x.fmt(f),
            Node::Emphasis(x) => x.fmt(f),
            Node::FootnoteReference(x) => x.fmt(f),
            Node::Html(x) => x.fmt(f),
            Node::Image(x) => x.fmt(f),
            Node::ImageReference(x) => x.fmt(f),
            Node::Link(x) => x.fmt(f),
            Node::LinkReference(x) => x.fmt(f),
            Node::Strong(x) => x.fmt(f),
            Node::Text(x) => x.fmt(f),
            Node::Code(x) => x.fmt(f),
            Node::Math(x) => x.fmt(f),
            Node::Heading(x) => x.fmt(f),
            Node::Table(x) => x.fmt(f),
            Node::ThematicBreak(x) => x.fmt(f),
            Node::TableRow(x) => x.fmt(f),
            Node::TableCell(x) => x.fmt(f),
            Node::ListItem(x) => x.fmt(f),
            Node::Definition(x) => x.fmt(f),
            Node::Paragraph(x) => x.fmt(f),
        }
    }
}

fn children_to_string(children: &[Node]) -> String {
    children.iter().map(ToString::to_string).collect()
}

// To do: clippy may be right but that’s a breaking change.
impl ToString for Node {
    fn to_string(&self) -> String {
        match self {
            // Parents.
            Node::Root(x) => children_to_string(&x.children),
            Node::Blockquote(x) => children_to_string(&x.children),
            Node::FootnoteDefinition(x) => children_to_string(&x.children),
            Node::List(x) => children_to_string(&x.children),
            Node::Delete(x) => children_to_string(&x.children),
            Node::Emphasis(x) => children_to_string(&x.children),
            Node::Link(x) => children_to_string(&x.children),
            Node::LinkReference(x) => children_to_string(&x.children),
            Node::Strong(x) => children_to_string(&x.children),
            Node::Heading(x) => children_to_string(&x.children),
            Node::Table(x) => children_to_string(&x.children),
            Node::TableRow(x) => children_to_string(&x.children),
            Node::TableCell(x) => children_to_string(&x.children),
            Node::ListItem(x) => children_to_string(&x.children),
            Node::Paragraph(x) => children_to_string(&x.children),

            Node::InlineCode(x) => x.value.clone(),
            Node::InlineMath(x) => x.value.clone(),
            Node::Html(x) => x.value.clone(),
            Node::Text(x) => x.value.clone(),
            Node::Code(x) => x.value.clone(),
            Node::Math(x) => x.value.clone(),

            // Voids.
            Node::Break(_)
            | Node::FootnoteReference(_)
            | Node::Image(_)
            | Node::ImageReference(_)
            | Node::ThematicBreak(_)
            | Node::Definition(_) => String::new(),
        }
    }
}

impl Node {
    #[must_use]
    pub fn children(&self) -> Option<&Vec<Node>> {
        match self {
            // Parent.
            Node::Root(x) => Some(&x.children),
            Node::Paragraph(x) => Some(&x.children),
            Node::Heading(x) => Some(&x.children),
            Node::Blockquote(x) => Some(&x.children),
            Node::List(x) => Some(&x.children),
            Node::ListItem(x) => Some(&x.children),
            Node::Emphasis(x) => Some(&x.children),
            Node::Strong(x) => Some(&x.children),
            Node::Link(x) => Some(&x.children),
            Node::LinkReference(x) => Some(&x.children),
            Node::FootnoteDefinition(x) => Some(&x.children),
            Node::Table(x) => Some(&x.children),
            Node::TableRow(x) => Some(&x.children),
            Node::TableCell(x) => Some(&x.children),
            Node::Delete(x) => Some(&x.children),
            // Non-parent.
            _ => None,
        }
    }

    pub fn children_mut(&mut self) -> Option<&mut Vec<Node>> {
        match self {
            // Parent.
            Node::Root(x) => Some(&mut x.children),
            Node::Paragraph(x) => Some(&mut x.children),
            Node::Heading(x) => Some(&mut x.children),
            Node::Blockquote(x) => Some(&mut x.children),
            Node::List(x) => Some(&mut x.children),
            Node::ListItem(x) => Some(&mut x.children),
            Node::Emphasis(x) => Some(&mut x.children),
            Node::Strong(x) => Some(&mut x.children),
            Node::Link(x) => Some(&mut x.children),
            Node::LinkReference(x) => Some(&mut x.children),
            Node::FootnoteDefinition(x) => Some(&mut x.children),
            Node::Table(x) => Some(&mut x.children),
            Node::TableRow(x) => Some(&mut x.children),
            Node::TableCell(x) => Some(&mut x.children),
            Node::Delete(x) => Some(&mut x.children),
            // Non-parent.
            _ => None,
        }
    }

    #[must_use]
    pub fn position(&self) -> Option<&Position> {
        match self {
            Node::Root(x) => x.position.as_ref(),
            Node::Blockquote(x) => x.position.as_ref(),
            Node::FootnoteDefinition(x) => x.position.as_ref(),
            Node::List(x) => x.position.as_ref(),
            Node::Break(x) => x.position.as_ref(),
            Node::InlineCode(x) => x.position.as_ref(),
            Node::InlineMath(x) => x.position.as_ref(),
            Node::Delete(x) => x.position.as_ref(),
            Node::Emphasis(x) => x.position.as_ref(),
            Node::FootnoteReference(x) => x.position.as_ref(),
            Node::Html(x) => x.position.as_ref(),
            Node::Image(x) => x.position.as_ref(),
            Node::ImageReference(x) => x.position.as_ref(),
            Node::Link(x) => x.position.as_ref(),
            Node::LinkReference(x) => x.position.as_ref(),
            Node::Strong(x) => x.position.as_ref(),
            Node::Text(x) => x.position.as_ref(),
            Node::Code(x) => x.position.as_ref(),
            Node::Math(x) => x.position.as_ref(),
            Node::Heading(x) => x.position.as_ref(),
            Node::Table(x) => x.position.as_ref(),
            Node::ThematicBreak(x) => x.position.as_ref(),
            Node::TableRow(x) => x.position.as_ref(),
            Node::TableCell(x) => x.position.as_ref(),
            Node::ListItem(x) => x.position.as_ref(),
            Node::Definition(x) => x.position.as_ref(),
            Node::Paragraph(x) => x.position.as_ref(),
        }
    }

    pub fn position_mut(&mut self) -> Option<&mut Position> {
        match self {
            Node::Root(x) => x.position.as_mut(),
            Node::Blockquote(x) => x.position.as_mut(),
            Node::FootnoteDefinition(x) => x.position.as_mut(),
            Node::List(x) => x.position.as_mut(),
            Node::Break(x) => x.position.as_mut(),
            Node::InlineCode(x) => x.position.as_mut(),
            Node::InlineMath(x) => x.position.as_mut(),
            Node::Delete(x) => x.position.as_mut(),
            Node::Emphasis(x) => x.position.as_mut(),
            Node::FootnoteReference(x) => x.position.as_mut(),
            Node::Html(x) => x.position.as_mut(),
            Node::Image(x) => x.position.as_mut(),
            Node::ImageReference(x) => x.position.as_mut(),
            Node::Link(x) => x.position.as_mut(),
            Node::LinkReference(x) => x.position.as_mut(),
            Node::Strong(x) => x.position.as_mut(),
            Node::Text(x) => x.position.as_mut(),
            Node::Code(x) => x.position.as_mut(),
            Node::Math(x) => x.position.as_mut(),
            Node::Heading(x) => x.position.as_mut(),
            Node::Table(x) => x.position.as_mut(),
            Node::ThematicBreak(x) => x.position.as_mut(),
            Node::TableRow(x) => x.position.as_mut(),
            Node::TableCell(x) => x.position.as_mut(),
            Node::ListItem(x) => x.position.as_mut(),
            Node::Definition(x) => x.position.as_mut(),
            Node::Paragraph(x) => x.position.as_mut(),
        }
    }

    pub fn position_set(&mut self, position: Option<Position>) {
        match self {
            Node::Root(x) => x.position = position,
            Node::Blockquote(x) => x.position = position,
            Node::FootnoteDefinition(x) => x.position = position,
            Node::List(x) => x.position = position,
            Node::Break(x) => x.position = position,
            Node::InlineCode(x) => x.position = position,
            Node::InlineMath(x) => x.position = position,
            Node::Delete(x) => x.position = position,
            Node::Emphasis(x) => x.position = position,
            Node::FootnoteReference(x) => x.position = position,
            Node::Html(x) => x.position = position,
            Node::Image(x) => x.position = position,
            Node::ImageReference(x) => x.position = position,
            Node::Link(x) => x.position = position,
            Node::LinkReference(x) => x.position = position,
            Node::Strong(x) => x.position = position,
            Node::Text(x) => x.position = position,
            Node::Code(x) => x.position = position,
            Node::Math(x) => x.position = position,
            Node::Heading(x) => x.position = position,
            Node::Table(x) => x.position = position,
            Node::ThematicBreak(x) => x.position = position,
            Node::TableRow(x) => x.position = position,
            Node::TableCell(x) => x.position = position,
            Node::ListItem(x) => x.position = position,
            Node::Definition(x) => x.position = position,
            Node::Paragraph(x) => x.position = position,
        }
    }
}

/// Document.
///
/// ```markdown
/// > | a
///     ^
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Root {
    // Parent.
    /// Content model.
    pub children: Vec<Node>,
    /// Positional info.
    pub position: Option<Position>,
}

/// Paragraph.
///
/// ```markdown
/// > | a
///     ^
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Paragraph {
    // Parent.
    /// Content model.
    pub children: Vec<Node>,
    /// Positional info.
    pub position: Option<Position>,
}

/// Heading.
///
/// ```markdown
/// > | # a
///     ^^^
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Heading {
    // Parent.
    /// Content model.
    pub children: Vec<Node>,
    /// Positional info.
    pub position: Option<Position>,
    // Extra.
    /// Rank (between `1` and `6`, both including).
    pub depth: u8,
}

/// Thematic break.
///
/// ```markdown
/// > | ***
///     ^^^
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ThematicBreak {
    // Void.
    /// Positional info.
    pub position: Option<Position>,
}

/// Block quote.
///
/// ```markdown
/// > | > a
///     ^^^
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Blockquote {
    // Parent.
    /// Content model.
    pub children: Vec<Node>,
    /// Positional info.
    pub position: Option<Position>,
}

/// List.
///
/// ```markdown
/// > | * a
///     ^^^
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct List {
    // Parent.
    /// Content model.
    pub children: Vec<Node>,
    /// Positional info.
    pub position: Option<Position>,
    // Extra.
    /// Ordered (`true`) or unordered (`false`).
    pub ordered: bool,
    /// Starting number of the list.
    /// `None` when unordered.
    pub start: Option<u32>,
    /// One or more of its children are separated with a blank line from its
    /// siblings (when `true`), or not (when `false`).
    pub spread: bool,
}

/// List item.
///
/// ```markdown
/// > | * a
///     ^^^
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ListItem {
    // Parent.
    /// Content model.
    pub children: Vec<Node>,
    /// Positional info.
    pub position: Option<Position>,
    // Extra.
    /// The item contains two or more children separated by a blank line
    /// (when `true`), or not (when `false`).
    pub spread: bool,
    /// GFM: whether the item is done (when `true`), not done (when `false`),
    /// or indeterminate or not applicable (`None`).
    pub checked: Option<bool>,
}

/// Html (flow or phrasing).
///
/// ```markdown
/// > | <a>
///     ^^^
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Html {
    // Text.
    /// Content model.
    pub value: String,
    /// Positional info.
    pub position: Option<Position>,
}

/// Code (flow).
///
/// ```markdown
/// > | ~~~
///     ^^^
/// > | a
///     ^
/// > | ~~~
///     ^^^
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Code {
    // Text.
    /// Content model.
    pub value: String,
    /// Positional info.
    pub position: Option<Position>,
    // Extra.
    /// The language of computer code being marked up.
    pub lang: Option<String>,
    /// Custom info relating to the node.
    pub meta: Option<String>,
}

/// Math (flow).
///
/// ```markdown
/// > | $$
///     ^^
/// > | a
///     ^
/// > | $$
///     ^^
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Math {
    // Text.
    /// Content model.
    pub value: String,
    /// Positional info.
    pub position: Option<Position>,
    // Extra.
    /// Custom info relating to the node.
    pub meta: Option<String>,
}

/// Definition.
///
/// ```markdown
/// > | [a]: b
///     ^^^^^^
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Definition {
    // Void.
    /// Positional info.
    pub position: Option<Position>,
    // Resource.
    /// URL to the referenced resource.
    pub url: String,
    /// Advisory info for the resource, such as something that would be
    /// appropriate for a tooltip.
    pub title: Option<String>,
    // Association.
    /// Value that can match another node.
    /// `identifier` is a source value: character escapes and character references
    /// are *not* parsed.
    /// Its value must be normalized.
    pub identifier: String,
    /// `label` is a string value: it works just like `title` on a link or a
    /// `lang` on code: character escapes and character references are parsed.
    ///
    /// To normalize a value, collapse markdown whitespace (`[\t\n\r ]+`) to a
    /// space, trim the optional initial and/or final space, and perform
    /// case-folding.
    pub label: Option<String>,
}

/// Text.
///
/// ```markdown
/// > | a
///     ^
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Text {
    // Text.
    /// Content model.
    pub value: String,
    /// Positional info.
    pub position: Option<Position>,
}

/// Emphasis.
///
/// ```markdown
/// > | *a*
///     ^^^
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Emphasis {
    // Parent.
    /// Content model.
    pub children: Vec<Node>,
    /// Positional info.
    pub position: Option<Position>,
}

/// Strong.
///
/// ```markdown
/// > | **a**
///     ^^^^^
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Strong {
    // Parent.
    /// Content model.
    pub children: Vec<Node>,
    /// Positional info.
    pub position: Option<Position>,
}

/// Code (phrasing).
///
/// ```markdown
/// > | `a`
///     ^^^
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InlineCode {
    // Text.
    /// Content model.
    pub value: String,
    /// Positional info.
    pub position: Option<Position>,
}

/// Math (phrasing).
///
/// ```markdown
/// > | $a$
///     ^^^
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InlineMath {
    // Text.
    /// Content model.
    pub value: String,
    /// Positional info.
    pub position: Option<Position>,
}

/// Break.
///
/// ```markdown
/// > | a\
///      ^
///   | b
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Break {
    // Void.
    /// Positional info.
    pub position: Option<Position>,
}

/// Link.
///
/// ```markdown
/// > | [a](b)
///     ^^^^^^
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Link {
    // Parent.
    /// Content model.
    pub children: Vec<Node>,
    /// Positional info.
    pub position: Option<Position>,
    // Resource.
    /// URL to the referenced resource.
    pub url: String,
    /// Advisory info for the resource, such as something that would be
    /// appropriate for a tooltip.
    pub title: Option<String>,
}

/// Image.
///
/// ```markdown
/// > | ![a](b)
///     ^^^^^^^
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Image {
    // Void.
    /// Positional info.
    pub position: Option<Position>,
    // Alternative.
    /// Equivalent content for environments that cannot represent the node as
    /// intended.
    pub alt: String,
    // Resource.
    /// URL to the referenced resource.
    pub url: String,
    /// Advisory info for the resource, such as something that would be
    /// appropriate for a tooltip.
    pub title: Option<String>,
}

/// Link reference.
///
/// ```markdown
/// > | [a]
///     ^^^
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LinkReference {
    // Parent.
    /// Content model.
    pub children: Vec<Node>,
    /// Positional info.
    pub position: Option<Position>,
    // Reference.
    /// Explicitness of a reference.
    pub reference_kind: ReferenceKind,
    // Association.
    /// Value that can match another node.
    /// `identifier` is a source value: character escapes and character references
    /// are *not* parsed.
    /// Its value must be normalized.
    pub identifier: String,
    /// `label` is a string value: it works just like `title` on a link or a
    /// `lang` on code: character escapes and character references are parsed.
    ///
    /// To normalize a value, collapse markdown whitespace (`[\t\n\r ]+`) to a
    /// space, trim the optional initial and/or final space, and perform
    /// case-folding.
    pub label: Option<String>,
}

/// Image reference.
///
/// ```markdown
/// > | ![a]
///     ^^^^
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ImageReference {
    // Void.
    /// Positional info.
    pub position: Option<Position>,
    // Alternative.
    /// Equivalent content for environments that cannot represent the node as
    /// intended.
    pub alt: String,
    // Reference.
    /// Explicitness of a reference.
    pub reference_kind: ReferenceKind,
    // Association.
    /// Value that can match another node.
    /// `identifier` is a source value: character escapes and character references
    /// are *not* parsed.
    /// Its value must be normalized.
    pub identifier: String,
    /// `label` is a string value: it works just like `title` on a link or a
    /// `lang` on code: character escapes and character references are parsed.
    ///
    /// To normalize a value, collapse markdown whitespace (`[\t\n\r ]+`) to a
    /// space, trim the optional initial and/or final space, and perform
    /// case-folding.
    pub label: Option<String>,
}

/// GFM: footnote definition.
///
/// ```markdown
/// > | [^a]: b
///     ^^^^^^^
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FootnoteDefinition {
    // Parent.
    /// Content model.
    pub children: Vec<Node>,
    /// Positional info.
    pub position: Option<Position>,
    // Association.
    /// Value that can match another node.
    /// `identifier` is a source value: character escapes and character references
    /// are *not* parsed.
    /// Its value must be normalized.
    pub identifier: String,
    /// `label` is a string value: it works just like `title` on a link or a
    /// `lang` on code: character escapes and character references are parsed.
    ///
    /// To normalize a value, collapse markdown whitespace (`[\t\n\r ]+`) to a
    /// space, trim the optional initial and/or final space, and perform
    /// case-folding.
    pub label: Option<String>,
}

/// GFM: footnote reference.
///
/// ```markdown
/// > | [^a]
///     ^^^^
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FootnoteReference {
    // Void.
    /// Positional info.
    pub position: Option<Position>,
    // Association.
    /// Value that can match another node.
    /// `identifier` is a source value: character escapes and character references
    /// are *not* parsed.
    /// Its value must be normalized.
    pub identifier: String,
    /// `label` is a string value: it works just like `title` on a link or a
    /// `lang` on code: character escapes and character references are parsed.
    ///
    /// To normalize a value, collapse markdown whitespace (`[\t\n\r ]+`) to a
    /// space, trim the optional initial and/or final space, and perform
    /// case-folding.
    pub label: Option<String>,
}

/// GFM: table.
///
/// ```markdown
/// > | | a |
///     ^^^^^
/// > | | - |
///     ^^^^^
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Table {
    // Parent.
    /// Content model.
    pub children: Vec<Node>,
    /// Positional info.
    pub position: Option<Position>,
    // Extra.
    /// Represents how cells in columns are aligned.
    pub align: Vec<AlignKind>,
}

/// GFM: table row.
///
/// ```markdown
/// > | | a |
///     ^^^^^
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TableRow {
    // Parent.
    /// Content model.
    pub children: Vec<Node>,
    /// Positional info.
    pub position: Option<Position>,
}

/// GFM: table cell.
///
/// ```markdown
/// > | | a |
///     ^^^^^
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TableCell {
    // Parent.
    /// Content model.
    pub children: Vec<Node>,
    /// Positional info.
    pub position: Option<Position>,
}

/// GFM: delete.
///
/// ```markdown
/// > | ~~a~~
///     ^^^^^
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Delete {
    // Parent.
    /// Content model.
    pub children: Vec<Node>,
    /// Positional info.
    pub position: Option<Position>,
}
