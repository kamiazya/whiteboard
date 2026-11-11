//! The per-layout measure memo of the measure-seam spike (ADR-0054): one inner
//! call per distinct `(font, text)` for the life of the value.
//!
//! The TypeScript has no such cache, so this is new rather than ported; it is
//! sound only inside one layout, since a face loading mid-session changes a
//! measurer's answers, and it holds no global or static state — dropping the
//! value is the whole of invalidation. A host that wants a longer-lived cache
//! keeps its own.
//!
//! Fonts are interned once into small ids, so the cache's key is the
//! `(font id, text)` the ADR names and the font's strings are hashed once per
//! font rather than once per call. A key distinguishes every field of a
//! descriptor (family, chain, weight bits, style, size bits), because a real
//! measurer reads all of them; `-0` and `0`, and two NaNs of different bits,
//! are different fonts.

use std::cell::RefCell;
use std::collections::BTreeMap;

use crate::measure::{FontDescriptor, FontStyle, Measure, VerticalMetrics};

#[derive(Eq, Ord, PartialEq, PartialOrd)]
struct FontKey {
    family: String,
    fallback_chain: Vec<String>,
    weight_bits: u64,
    style: FontStyle,
    size_bits: u64,
}

impl FontKey {
    fn of(font: &FontDescriptor) -> Self {
        Self {
            family: font.family.clone(),
            fallback_chain: font.fallback_chain.clone(),
            weight_bits: font.weight.to_bits(),
            style: font.style,
            size_bits: font.size_px.to_bits(),
        }
    }
}

#[derive(Default)]
struct Cache {
    fonts: BTreeMap<FontKey, u32>,
    advances: BTreeMap<u32, BTreeMap<String, f64>>,
    verticals: BTreeMap<u32, VerticalMetrics>,
}

pub struct MeasureMemo<M> {
    inner: M,
    cache: RefCell<Cache>,
}

impl<M: Measure> MeasureMemo<M> {
    #[must_use]
    pub fn new(inner: M) -> Self {
        Self { inner, cache: RefCell::new(Cache::default()) }
    }
}

impl Cache {
    /// The id of `font`, minted on first sight.
    fn intern(&mut self, font: &FontDescriptor) -> u32 {
        let key = FontKey::of(font);
        if let Some(id) = self.fonts.get(&key) {
            return *id;
        }
        // Ids are dense from 0, so the next is the count; a layout asks for
        // far fewer than 2^32 fonts, and saturating keeps the call total.
        let id = u32::try_from(self.fonts.len()).unwrap_or(u32::MAX);
        self.fonts.insert(key, id);
        id
    }
}

impl<M: Measure> Measure for MeasureMemo<M> {
    fn advance_width(&self, text: &str, font: &FontDescriptor) -> f64 {
        let mut cache = self.cache.borrow_mut();
        let id = cache.intern(font);
        if let Some(hit) = cache.advances.get(&id).and_then(|by_text| by_text.get(text)) {
            return *hit;
        }
        // The borrow is held across the inner call: a measurer reaching back
        // into this memo would be a cycle, and it panics rather than loops.
        let advance = self.inner.advance_width(text, font);
        cache.advances.entry(id).or_default().insert(text.to_owned(), advance);
        advance
    }

    fn vertical_metrics(&self, font: &FontDescriptor) -> VerticalMetrics {
        let mut cache = self.cache.borrow_mut();
        let id = cache.intern(font);
        if let Some(hit) = cache.verticals.get(&id) {
            return *hit;
        }
        let metrics = self.inner.vertical_metrics(font);
        cache.verticals.insert(id, metrics);
        metrics
    }
}
