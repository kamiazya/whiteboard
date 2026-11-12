//! `spatial-palette.ts`: the colour half of the spatial theme layer.
//!
//! Node fill is differentiated per kind; stroke, edge and label colours are
//! each ONE accessible value per mode, so the WCAG contrast guarantee stays
//! testable as a single producer. The floors any replacement must keep are the
//! TypeScript package's tests (stroke >= 3:1 against the mode background,
//! label fill >= 4.5:1 against a preset tint); the values here are held equal
//! to the TypeScript's by the recorded oracle, so they inherit them.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpatialNodeStyle {
    pub fill: String,
    pub stroke: String,
}

/// One preset accent: the strong stroke and the quiet tint fill. A preset
/// colours a node's border strongly and its background as a tint, so body text
/// keeps the theme text colour and readability never depends on the hue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpatialPresetAccent {
    pub stroke: String,
    pub fill: String,
}

/// The fill for each syntax role inside a fenced code block, from the same
/// hues as the preset accents. The blue spark is deliberately absent: the brand
/// reserves it for the AI acting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpatialSyntaxPalette {
    pub keyword: String,
    pub string: String,
    pub number: String,
    pub comment: String,
}

/// The four things a node could be painted as. A frame is painted as `group`:
/// the key is the facet engine's published theme-token contract, which a
/// plugin registers assets against.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpatialNodeStyles {
    pub text: SpatialNodeStyle,
    pub file: SpatialNodeStyle,
    pub link: SpatialNodeStyle,
    pub group: SpatialNodeStyle,
}

/// The six JSON Canvas preset accents, `1` red to `6` purple.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpatialPresets {
    pub n1: SpatialPresetAccent,
    pub n2: SpatialPresetAccent,
    pub n3: SpatialPresetAccent,
    pub n4: SpatialPresetAccent,
    pub n5: SpatialPresetAccent,
    pub n6: SpatialPresetAccent,
}

impl SpatialPresets {
    /// The accent a colour text names: exactly `"1"` to `"6"`, nothing else.
    #[must_use]
    pub fn get(&self, key: &str) -> Option<&SpatialPresetAccent> {
        match key {
            "1" => Some(&self.n1),
            "2" => Some(&self.n2),
            "3" => Some(&self.n3),
            "4" => Some(&self.n4),
            "5" => Some(&self.n5),
            "6" => Some(&self.n6),
            _ => None,
        }
    }
}

/// The comment layer's chrome: the anchor pin and the bubble behind the text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpatialCommentChrome {
    pub pin: SpatialNodeStyle,
    pub bubble: SpatialNodeStyle,
}

/// The proposal layer's chrome: indigo on both modes, against the comment
/// layer's amber, so hue is the whole of what separates "somebody said
/// something" from "somebody wants this changed".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpatialProposalChrome {
    pub edge: String,
    pub bubble_fill: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SpatialPalette {
    pub node: SpatialNodeStyles,
    /// Stroke applied to a routed edge when it carries no authored colour.
    pub edge_stroke: String,
    /// Fill applied to every label run.
    pub label_fill: String,
    /// The canvas surface colour: the label halo colour and the export default
    /// background. Hex, not oklch, because the PNG export parses no oklch.
    pub surface: String,
    /// Uniform corner radius (px) applied to every node's chrome shape.
    pub corner_radius_px: f64,
    pub presets: SpatialPresets,
    pub syntax: SpatialSyntaxPalette,
    pub comment: SpatialCommentChrome,
    pub proposal: SpatialProposalChrome,
    /// The neutral a markdown body's furniture is drawn in. Absent on the
    /// bundled palettes, which keep the markdown theme's own neutral.
    pub markdown_chrome: Option<String>,
}

fn style(fill: &str, stroke: &str) -> SpatialNodeStyle {
    SpatialNodeStyle { fill: fill.to_owned(), stroke: stroke.to_owned() }
}

fn accent(stroke: &str, fill: &str) -> SpatialPresetAccent {
    SpatialPresetAccent { stroke: stroke.to_owned(), fill: fill.to_owned() }
}

fn syntax(keyword: &str, string: &str, number: &str, comment: &str) -> SpatialSyntaxPalette {
    SpatialSyntaxPalette {
        keyword: keyword.to_owned(),
        string: string.to_owned(),
        number: number.to_owned(),
        comment: comment.to_owned(),
    }
}

fn node_styles(
    text_fill: &str,
    file_fill: &str,
    link_fill: &str,
    stroke: &str,
) -> SpatialNodeStyles {
    SpatialNodeStyles {
        text: style(text_fill, stroke),
        file: style(file_fill, stroke),
        link: style(link_fill, stroke),
        // Groups stay unfilled: a filled group rect emitted beside a member
        // node would risk painting over or under it depending on order.
        group: style("none", stroke),
    }
}

impl SpatialPalette {
    /// Quiet-tool direction: strokes at a mid neutral so chrome recedes and
    /// content reads first, clearing the WCAG 1.4.11 non-text floor.
    #[must_use]
    pub fn light() -> Self {
        Self {
            node: node_styles("#ffffff", "#f5f5f5", "#eef4ff", "#737373"),
            edge_stroke: "#737373".to_owned(),
            label_fill: "#404040".to_owned(),
            surface: "#ffffff".to_owned(),
            corner_radius_px: 6.0,
            presets: SpatialPresets {
                n1: accent("#dc2626", "#fee2e2"),
                n2: accent("#ea580c", "#ffedd5"),
                n3: accent("#d97706", "#fef3c7"),
                n4: accent("#059669", "#d1fae5"),
                n5: accent("#0891b2", "#cffafe"),
                n6: accent("#9333ea", "#f3e8ff"),
            },
            syntax: syntax("#7e22ce", "#047857", "#c2410c", "#5b6472"),
            // A neutral card with an amber accent border: an amber-tinted
            // bubble read as a preset-3 content node.
            comment: SpatialCommentChrome {
                pin: style("#d97706", "#ffffff"),
                bubble: style("#ffffff", "#d97706"),
            },
            proposal: SpatialProposalChrome {
                edge: "#4f46e5".to_owned(),
                bubble_fill: "#ffffff".to_owned(),
            },
            markdown_chrome: None,
        }
    }

    /// A desaturated cool grey and near-white pair read against the dark
    /// surface, not the light one inverted. Node fill stays `none`: nodes read
    /// as outlined shapes, and body text stays legible through the document's
    /// root fill rather than per-node fills.
    #[must_use]
    pub fn dark() -> Self {
        Self {
            node: node_styles("none", "none", "none", "#9BA3AF"),
            edge_stroke: "#9BA3AF".to_owned(),
            label_fill: "#E6E8EB".to_owned(),
            surface: "#0a0a0a".to_owned(),
            corner_radius_px: 4.0,
            presets: SpatialPresets {
                n1: accent("#f87171", "#450a0a"),
                n2: accent("#fb923c", "#431407"),
                n3: accent("#fbbf24", "#451a03"),
                n4: accent("#34d399", "#022c22"),
                n5: accent("#22d3ee", "#083344"),
                n6: accent("#c084fc", "#3b0764"),
            },
            syntax: syntax("#c084fc", "#34d399", "#fb923c", "#9ba3af"),
            // An ELEVATED neutral card, one step above the surface so the
            // float reads where a dark shadow cannot.
            comment: SpatialCommentChrome {
                pin: style("#fbbf24", "#0a0a0a"),
                bubble: style("#262626", "#fbbf24"),
            },
            proposal: SpatialProposalChrome {
                edge: "#818cf8".to_owned(),
                bubble_fill: "#262626".to_owned(),
            },
            markdown_chrome: None,
        }
    }
}
