//! Which constructs the parser reads.
//!
//! The dialect is the one `packages/codec` parses with: `CommonMark`, GFM and
//! math. Front matter and MDX are not part of the vendored copy.

/// Toggles of the syntax the tokenizer tries; one flag a construct.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Constructs {
    pub(crate) attention: bool,
    pub(crate) autolink: bool,
    pub(crate) block_quote: bool,
    pub(crate) character_escape: bool,
    pub(crate) character_reference: bool,
    pub(crate) code_indented: bool,
    pub(crate) code_fenced: bool,
    pub(crate) code_text: bool,
    pub(crate) definition: bool,
    pub(crate) gfm_autolink_literal: bool,
    pub(crate) gfm_footnote_definition: bool,
    pub(crate) gfm_label_start_footnote: bool,
    pub(crate) gfm_strikethrough: bool,
    pub(crate) gfm_table: bool,
    pub(crate) gfm_task_list_item: bool,
    pub(crate) hard_break_escape: bool,
    pub(crate) hard_break_trailing: bool,
    pub(crate) heading_atx: bool,
    pub(crate) heading_setext: bool,
    pub(crate) html_flow: bool,
    pub(crate) html_text: bool,
    pub(crate) label_start_image: bool,
    pub(crate) label_start_link: bool,
    pub(crate) label_end: bool,
    pub(crate) list_item: bool,
    pub(crate) math_flow: bool,
    pub(crate) math_text: bool,
    pub(crate) thematic_break: bool,
}

impl Default for Constructs {
    /// `CommonMark` only.
    fn default() -> Self {
        Self {
            attention: true,
            autolink: true,
            block_quote: true,
            character_escape: true,
            character_reference: true,
            code_indented: true,
            code_fenced: true,
            code_text: true,
            definition: true,
            gfm_autolink_literal: false,
            gfm_footnote_definition: false,
            gfm_label_start_footnote: false,
            gfm_strikethrough: false,
            gfm_table: false,
            gfm_task_list_item: false,
            hard_break_escape: true,
            hard_break_trailing: true,
            heading_atx: true,
            heading_setext: true,
            html_flow: true,
            html_text: true,
            label_start_image: true,
            label_start_link: true,
            label_end: true,
            list_item: true,
            math_flow: false,
            math_text: false,
            thematic_break: true,
        }
    }
}

impl Constructs {
    /// `CommonMark` with GFM and math: what `packages/codec` parses.
    pub(crate) fn dialect() -> Self {
        Self {
            gfm_autolink_literal: true,
            gfm_footnote_definition: true,
            gfm_label_start_footnote: true,
            gfm_strikethrough: true,
            gfm_table: true,
            gfm_task_list_item: true,
            math_flow: true,
            math_text: true,
            ..Self::default()
        }
    }
}

/// How to read markdown.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ParseOptions {
    /// Which constructs are tried.
    pub(crate) constructs: Constructs,
    /// Whether a single `~` opens strikethrough.
    pub(crate) gfm_strikethrough_single_tilde: bool,
    /// Whether a single `$` opens inline math.
    pub(crate) math_text_single_dollar: bool,
}

impl Default for ParseOptions {
    /// The dialect of `packages/codec`, with remark's single-tilde and single-dollar readings.
    fn default() -> Self {
        Self {
            constructs: Constructs::dialect(),
            gfm_strikethrough_single_tilde: true,
            math_text_single_dollar: true,
        }
    }
}
