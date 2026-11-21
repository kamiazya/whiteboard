//! A markdown request (`kind: 'markdown'`): a document's body laid out as a
//! note, with the options a surface hands `layoutMdastBlocks` as data; and a
//! comment's prose (`kind: 'comment'`), which a surface hands
//! `layoutCommentBody` with nothing but its width and density. Read as
//! strictly as a canvas request.

use whiteboard_canvas_render::comments::body::CommentDensity;
use whiteboard_canvas_render::references::{FenceTokens, ReferenceWire};
use whiteboard_canvas_render::typeset::Rendered;
use whiteboard_model::Value;
use whiteboard_plugin_visual::visual::TagLibrary;

use super::code::code_tokens_of;
use super::fragments::fragments_of;
use super::measure::{measure_of, surface_of};
use super::options::{dark_of, style_of, tag_key_of};
use super::references::references_of;
use super::svg::{SvgAsk, svg_of};
use super::{MeasureSpec, Style, entries_of, strings_of};
use crate::json_canvas_wire::{Fields, number_of, string_of};

/// What a note is laid out with besides its body and width.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Note {
    pub(crate) dark: bool,
    pub(crate) style: Style,
    pub(crate) font_families: Vec<String>,
    pub(crate) tags: Option<TagLibrary>,
    /// The documents the note points at; `None` resolves no embed at all, so
    /// a paragraph that is only an embed is set as prose.
    pub(crate) references: Option<ReferenceWire>,
    pub(crate) code_tokens: Vec<FenceTokens>,
    pub(crate) fragments: Option<Vec<(String, Rendered)>>,
    /// The heading whose section alone is laid out (`#Heading`).
    pub(crate) section: Option<String>,
    pub(crate) cache: Option<u32>,
    /// The SVG the answer carries beside its scene; `None` answers the scene alone.
    pub(crate) svg: Option<SvgAsk>,
}

/// Which body a markdown request lays out.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Prose {
    Note(Box<Note>),
    /// A comment's prose at its density, the documents its `[[references]]`
    /// resolve to (`None` resolves none) and the SVG its answer carries.
    Comment(CommentDensity, Option<ReferenceWire>, Option<SvgAsk>),
}

/// A markdown request.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct MarkdownRequest {
    pub(crate) body: String,
    pub(crate) max_width: f64,
    pub(crate) measure: MeasureSpec,
    pub(crate) prose: Prose,
}

fn density_of(value: &Value) -> Option<CommentDensity> {
    match string_of(value)?.as_str() {
        "comfortable" => Some(CommentDensity::Comfortable),
        "compact" => Some(CommentDensity::Compact),
        _ => None,
    }
}

fn note_of(f: &mut Fields<'_>) -> Option<Note> {
    Some(Note {
        dark: f.field("mode", dark_of)??,
        style: f.field("style", style_of)?.unwrap_or_default(),
        font_families: f.field("fontFamilies", strings_of)?.unwrap_or_default(),
        tags: f.field("tagLibrary", |v| entries_of(v, tag_key_of))?,
        references: f.field("references", references_of)?,
        code_tokens: f.field("codeTokens", code_tokens_of)?.unwrap_or_default(),
        fragments: f.field("fragments", fragments_of)?,
        section: f.field("section", string_of)?,
        cache: f.field("cache", surface_of)?,
        svg: f.field("svg", svg_of)?,
    })
}

/// The markdown request a value stands for: `None` when it names another
/// kind, or is none.
pub(crate) fn markdown_request_of(value: &Value) -> Option<MarkdownRequest> {
    let mut f = Fields::of(value)?;
    let kind = f.field("kind", string_of)??;
    let body = f.field("body", string_of)??;
    let max_width = f.field("maxWidth", number_of)??;
    let measure = f.field("measure", measure_of)??;
    let prose = match kind.as_str() {
        "markdown" => Prose::Note(Box::new(note_of(&mut f)?)),
        "comment" => Prose::Comment(
            f.field("density", density_of)??,
            f.field("references", references_of)?,
            f.field("svg", svg_of)?,
        ),
        _ => return None,
    };
    f.all_named().then_some(MarkdownRequest { body, max_width, measure, prose })
}
