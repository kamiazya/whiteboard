//! The mdast subset a layout reads, as types: `packages/model`'s `./mdast`
//! content model (flow, phrasing, list, table), ported.
//!
//! Plain data, no serde: the model crate holds no third-party dependency, and
//! the one producer of this tree (the parser's conversion) and its readers are
//! both in-process. A table cell's phrasing is [`Phrasing`] too; the
//! TypeScript's narrower `CellPhrasingContent` differs only by omitting `break`,
//! which a producer simply never puts in a cell.
//!
//! An absent and a `null` string are one thing here (`None`), as every reader
//! treats them alike. `Some("")` is kept apart from `None` where a reader tells
//! them apart: a wiki link's `alias` and `fragment` are tested for presence by
//! one reader and for truth by another.

/// How a reference link was written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReferenceType {
    Shortcut,
    Collapsed,
    Full,
}

/// A table column's alignment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Align {
    Left,
    Right,
    Center,
}

/// Inline content.
#[derive(Debug, Clone, PartialEq)]
pub enum Phrasing {
    Text {
        value: String,
    },
    Emphasis {
        children: Vec<Phrasing>,
    },
    Strong {
        children: Vec<Phrasing>,
    },
    InlineCode {
        value: String,
    },
    Break,
    Html {
        value: String,
    },
    Link {
        url: String,
        title: Option<String>,
        children: Vec<Phrasing>,
    },
    Image {
        url: String,
        title: Option<String>,
        alt: Option<String>,
    },
    LinkReference {
        identifier: String,
        label: Option<String>,
        reference_type: ReferenceType,
        children: Vec<Phrasing>,
    },
    ImageReference {
        identifier: String,
        label: Option<String>,
        reference_type: ReferenceType,
        alt: Option<String>,
    },
    Delete {
        children: Vec<Phrasing>,
    },
    InlineMath {
        value: String,
    },
    WikiLink {
        document_id: String,
        alias: Option<String>,
        fragment: Option<String>,
    },
    Embed {
        document_id: String,
        fragment: Option<String>,
    },
}

/// One cell of a table row.
#[derive(Debug, Clone, PartialEq)]
pub struct TableCell {
    pub children: Vec<Phrasing>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TableRow {
    pub children: Vec<TableCell>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ListItem {
    /// `Some` for a task item, in its state.
    pub checked: Option<bool>,
    pub spread: bool,
    pub children: Vec<Flow>,
}

/// Block content.
#[derive(Debug, Clone, PartialEq)]
pub enum Flow {
    Paragraph {
        children: Vec<Phrasing>,
    },
    /// `depth` is 1 to 6.
    Heading {
        depth: u8,
        children: Vec<Phrasing>,
    },
    Blockquote {
        children: Vec<Flow>,
    },
    List {
        ordered: Option<bool>,
        start: Option<f64>,
        spread: bool,
        children: Vec<ListItem>,
    },
    Code {
        value: String,
        lang: Option<String>,
        meta: Option<String>,
    },
    Html {
        value: String,
    },
    ThematicBreak,
    Definition {
        identifier: String,
        label: Option<String>,
        url: String,
        title: Option<String>,
    },
    Table {
        align: Vec<Option<Align>>,
        children: Vec<TableRow>,
    },
    Math {
        value: String,
        meta: Option<String>,
    },
}

/// A document: flow content only, the application subset the TypeScript fixes.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Root {
    pub children: Vec<Flow>,
}
