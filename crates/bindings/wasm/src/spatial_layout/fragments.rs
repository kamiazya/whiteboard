//! The math and diagram renderers over a request's `fragments` table: what
//! canvas-render's `withFragmentTable` answers in the TypeScript, a source the
//! table does not hold drawn as the renderer's fallback and recorded, once
//! each in the order asked, for the answer to carry back.

use std::cell::{Cell, RefCell};
use std::collections::BTreeSet;

use whiteboard_canvas_render::typeset::{DiagramRenderer, MathRenderer, Rendered};

use super::MAX_ELEMENTS;
use crate::input_caps::LAYOUT_SPATIAL_CANVAS;

/// The most rows a table may hold: the element cap. A host renders what a
/// layout asked for, and a board asking for more distinct sources than it
/// has elements is no board a person draws.
pub const MAX_FRAGMENTS: usize = MAX_ELEMENTS;

/// The most fragment markup one layout may place, in bytes: as much as a
/// request may hold. The table's own bytes are held by the request's cap, but
/// one row is placed once per block that asks for it, so a small body
/// repeating one source could otherwise draw the table many times over.
pub const MAX_PLACED_BYTES: usize = LAYOUT_SPATIAL_CANVAS.max_bytes;

/// A source a layout asked for, as canvas-render's `FragmentAsk`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Ask {
    Math(String),
    Diagram { lang: String, value: String },
}

impl Ask {
    /// The table's key for this source (`fragmentAskKey`).
    pub(crate) fn key(&self) -> String {
        match self {
            Self::Math(value) => format!("math:{value}"),
            Self::Diagram { lang, value } => format!("fence:{lang}:{value}"),
        }
    }
}

/// Whether `bytes` more markup still fits beside `placed`.
const fn fits(placed: usize, bytes: usize) -> bool {
    bytes <= MAX_PLACED_BYTES.saturating_sub(placed)
}

/// The asks, in the order met and as a set of keys.
#[derive(Default)]
struct Asked {
    order: Vec<Ask>,
    seen: BTreeSet<String>,
}

/// The renderers over one table, and what one layout through them asked.
pub(crate) struct FragmentTable<'r> {
    /// The rows, a later one answering first. Searched rather than indexed:
    /// at most [`MAX_FRAGMENTS`] of them, and a map's own code costs more of
    /// the artifact than the search costs a layout at the caps.
    rows: &'r [(String, Rendered)],
    asked: RefCell<Asked>,
    placed: Cell<usize>,
    over: Cell<bool>,
}

impl<'r> FragmentTable<'r> {
    pub(crate) fn new(rows: &'r [(String, Rendered)]) -> Self {
        Self { rows, asked: RefCell::default(), placed: Cell::new(0), over: Cell::new(false) }
    }

    /// What the layout asked for and the table did not hold.
    pub(crate) fn asked(&self) -> Vec<Ask> {
        self.asked.borrow().order.clone()
    }

    /// Whether the layout placed more markup than [`MAX_PLACED_BYTES`].
    pub(crate) fn over(&self) -> bool {
        self.over.get()
    }

    fn answer(&self, ask: Ask) -> Option<Rendered> {
        let key = ask.key();
        let Some((_, found)) = self.rows.iter().rev().find(|(row, _)| *row == key) else {
            let mut asked = self.asked.borrow_mut();
            if asked.seen.insert(key) {
                asked.order.push(ask);
            }
            return None;
        };
        let bytes = match found {
            Rendered::Markup(svg) | Rendered::Fragment { svg, .. } => svg.len(),
        };
        if !fits(self.placed.get(), bytes) {
            self.over.set(true);
            return None;
        }
        self.placed.set(self.placed.get() + bytes);
        Some(found.clone())
    }
}

impl MathRenderer for FragmentTable<'_> {
    fn render_math(&self, value: &str) -> Option<Rendered> {
        self.answer(Ask::Math(value.to_owned()))
    }
}

impl DiagramRenderer for FragmentTable<'_> {
    fn render_diagram(&self, lang: &str, value: &str) -> Option<Rendered> {
        self.answer(Ask::Diagram { lang: lang.to_owned(), value: value.to_owned() })
    }
}

#[cfg(test)]
mod tests;
