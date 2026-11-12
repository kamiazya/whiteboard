//! One line of `typeset.jsonl`, and the seams it answers from.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicUsize, Ordering};

use serde::Deserialize;
use serde_json::Value;
use whiteboard_canvas_render::measure::{FontDescriptor, Measure, VerticalMetrics};
use whiteboard_canvas_render::typeset::{
    CanvasMiniature, CanvasSummary, CodeToken, CodeTokenLines, CodeTokenizer, DiagramRenderer,
    EmbedBox, EmbedResolver, Embedded, IconRange, ImageRef, InlineSeams, MathRenderer, Miniature,
    Rendered, SyntaxFills, TokenRole,
};
use whiteboard_scene::{BoundingBox, SceneNode, ShapeSceneNode};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Icon {
    from: usize,
    to: usize,
    name: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Image {
    href: String,
    width: Option<f64>,
    height: Option<f64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Token {
    text: String,
    role: Option<String>,
}

/// A renderer's answer as recorded: `s` is the markup form, the other the object form.
#[derive(Deserialize)]
#[serde(untagged)]
enum Wire {
    Markup { s: String },
    Fragment { svg: String, width: Option<f64>, height: Option<f64> },
}

impl Wire {
    fn rendered(&self) -> Rendered {
        match self {
            Self::Markup { s } => Rendered::Markup(s.clone()),
            Self::Fragment { svg, width, height } => {
                Rendered::Fragment { svg: svg.clone(), width: *width, height: *height }
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmbeddedWire {
    kind: String,
    title: Option<String>,
    root: Option<Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CanvasWire {
    elements: usize,
    empty: bool,
}

/// `Math.min`, which a NaN on either side answers with.
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.min(b) }
}

fn key(lang: &str, value: &str) -> String {
    format!("{lang}\u{0}{value}")
}

/// The host's answers for every question this input can ask. A question the
/// table does not hold is a hole in the recording, and a panic.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Seams {
    icons: BTreeMap<String, Vec<Icon>>,
    emoji: BTreeMap<String, String>,
    titles: BTreeMap<String, Option<String>>,
    embeds: BTreeMap<String, Option<String>>,
    pending: BTreeSet<String>,
    images: BTreeMap<String, Option<Image>>,
    highlight: BTreeMap<String, Option<Vec<Vec<Token>>>>,
    math: BTreeMap<String, Option<Wire>>,
    diagram: BTreeMap<String, Option<Wire>>,
    embedded: BTreeMap<String, Option<EmbeddedWire>>,
    canvases: BTreeMap<String, Option<CanvasWire>>,
    miniatures: BTreeMap<String, String>,
    /// Questions the tables could not answer: a hole in the recording, which
    /// the replay reports rather than reading as an answer.
    #[serde(skip)]
    misses: RefCell<Vec<String>>,
}

impl Seams {
    pub(crate) fn misses(&self) -> Vec<String> {
        self.misses.borrow().clone()
    }

    fn held<'a, T: Default>(
        &self,
        table: &'a BTreeMap<String, T>,
        what: &str,
        key: &str,
    ) -> Option<&'a T> {
        let found = table.get(key);
        if found.is_none() {
            self.misses.borrow_mut().push(format!("{what} for {key:?}"));
        }
        found
    }
}

impl InlineSeams for Seams {
    fn expand_emoji(&self, text: &str) -> String {
        self.held(&self.emoji, "emoji expansion", text).cloned().unwrap_or_default()
    }

    fn icon_ranges(&self, text: &str) -> Vec<IconRange> {
        let found = self.held(&self.icons, "icon ranges", text);
        found
            .into_iter()
            .flatten()
            .map(|i| IconRange { from: i.from, to: i.to, name: i.name.clone() })
            .collect()
    }

    fn document_title(&self, id: &str) -> Option<String> {
        self.held(&self.titles, "title", id).cloned().flatten()
    }

    fn embed_name(&self, id: &str) -> Option<String> {
        self.held(&self.embeds, "embed name", id).cloned().flatten()
    }

    fn embed_pending(&self, id: &str) -> bool {
        self.pending.contains(id)
    }

    fn image_reference(&self, url: &str) -> Option<ImageRef> {
        let found = self.held(&self.images, "image", url).and_then(Option::as_ref);
        found.map(|i| ImageRef { href: i.href.clone(), width: i.width, height: i.height })
    }
}

impl CodeTokenizer for Seams {
    fn tokenize(&self, lang: &str, value: &str) -> Option<CodeTokenLines> {
        let found = self.held(&self.highlight, "highlight", &key(lang, value));
        let lines = found.and_then(Option::as_ref)?;
        let role = |name: &Option<String>| {
            name.as_deref().map(|n| match n {
                "keyword" => TokenRole::Keyword,
                "string" => TokenRole::String,
                "number" => TokenRole::Number,
                _ => TokenRole::Comment,
            })
        };
        Some(
            lines
                .iter()
                .map(|line| {
                    line.iter()
                        .map(|t| CodeToken { text: t.text.clone(), role: role(&t.role) })
                        .collect()
                })
                .collect(),
        )
    }
}

impl EmbedResolver for Seams {
    fn resolve_embed(&self, document_id: &str, fragment: Option<&str>) -> Option<Embedded> {
        let wire = self.held(&self.embedded, "embed target", document_id)?.as_ref()?;
        if wire.kind == "document" {
            let root = wire.root.as_ref().map(super::model::root)?;
            let Ok(root) = root else {
                self.misses.borrow_mut().push(format!("a readable body for {document_id:?}"));
                return None;
            };
            return Some(Embedded::Document { title: wire.title.clone(), root });
        }
        let at = format!(
            "{document_id}\u{0}{}",
            fragment.map_or_else(|| "u".to_owned(), |f| format!("s{f}"))
        );
        let summary = self.held(&self.canvases, "canvas summary", &at)?;
        let canvas =
            summary.as_ref().map(|c| CanvasSummary { elements: c.elements, empty: c.empty });
        Some(Embedded::Canvas { title: wire.title.clone(), canvas })
    }
}

impl CanvasMiniature for Seams {
    fn miniature(
        &self,
        document_id: &str,
        _fragment: Option<&str>,
        space: &EmbedBox,
        _path: &[String],
    ) -> Option<Miniature> {
        let mode = self.held(&self.miniatures, "miniature mode", document_id)?;
        let tall = match mode.as_str() {
            "shape" => false,
            "tall" => true,
            _ => return None,
        };
        let w = if tall { space.max_width } else { js_min(space.max_width, 120.0) };
        let h = if tall { space.max_height } else { js_min(space.max_height, 80.0) };
        let shape = ShapeSceneNode {
            truncated: false,
            overflows: false,
            id: None,
            bbox: BoundingBox { x: space.x, y: space.y, w, h },
            comment_chrome: false,
            proposal_chrome: None,
            radius: Some(3.0),
            shape: None,
            appearance: None,
            task_box: None,
            ink: None,
        };
        Some(Miniature { nodes: vec![SceneNode::Shape(Box::new(shape))], w, h })
    }
}

impl MathRenderer for Seams {
    fn render_math(&self, value: &str) -> Option<Rendered> {
        self.held(&self.math, "math", value).and_then(Option::as_ref).map(Wire::rendered)
    }
}

impl DiagramRenderer for Seams {
    fn render_diagram(&self, lang: &str, value: &str) -> Option<Rendered> {
        let found = self.held(&self.diagram, "diagram", &key(lang, value));
        found.and_then(Option::as_ref).map(Wire::rendered)
    }
}

/// The recorded palette, as the typesetter reads it.
pub(crate) fn syntax_of(palette: &BTreeMap<String, String>) -> SyntaxFills {
    let get = |role: &str| palette.get(role).cloned();
    SyntaxFills {
        keyword: get("keyword"),
        string: get("string"),
        number: get("number"),
        comment: get("comment"),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Record {
    pub(crate) id: String,
    pub(crate) root: Value,
    pub(crate) width: String,
    pub(crate) theme: String,
    pub(crate) fill: Option<String>,
    pub(crate) embeds: String,
    pub(crate) syntax: Option<BTreeMap<String, String>>,
    pub(crate) digest: bool,
    pub(crate) seams: Seams,
    pub(crate) calls: usize,
    pub(crate) scene: Option<String>,
    pub(crate) n: Option<usize>,
    pub(crate) h: Option<u32>,
}

/// The fake measurer, counting the times it is asked for an advance: the
/// TypeScript's count of calls, since each of its calls answers one.
#[derive(Default)]
pub(crate) struct Counting {
    inner: whiteboard_canvas_render::fake_measure::FakeMeasure,
    calls: AtomicUsize,
}

impl Counting {
    pub(crate) fn calls(&self) -> usize {
        self.calls.load(Ordering::Relaxed)
    }
}

impl Measure for Counting {
    fn advance_width(&self, text: &str, font: &FontDescriptor) -> f64 {
        self.calls.fetch_add(1, Ordering::Relaxed);
        self.inner.advance_width(text, font)
    }

    fn vertical_metrics(&self, font: &FontDescriptor) -> VerticalMetrics {
        self.inner.vertical_metrics(font)
    }
}
