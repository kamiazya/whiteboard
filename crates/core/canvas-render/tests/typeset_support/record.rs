//! One line of `typeset.jsonl`, and the seams it answers from.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicUsize, Ordering};

use serde::Deserialize;
use serde_json::Value;
use whiteboard_canvas_render::measure::{FontDescriptor, Measure, VerticalMetrics};
use whiteboard_canvas_render::typeset::{IconRange, ImageRef, InlineSeams};

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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Record {
    pub(crate) id: String,
    pub(crate) root: Value,
    pub(crate) width: String,
    pub(crate) theme: String,
    pub(crate) fill: Option<String>,
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
