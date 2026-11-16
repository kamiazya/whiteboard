//! The content cache a surface keeps in the core (owner decision q56): laid-out
//! bodies kept across layouts, as canvas-render's `SpatialContentCache` keeps
//! them for the TypeScript, so a layout that moved one node lays out only the
//! bodies that changed.
//!
//! A request names its surface as `cache: <id>`, an id the host mints per
//! content cache it holds and never reuses; `release_layout_cache(id)` forgets
//! what the surface kept, which the host calls once its cache is collected. A
//! surface stands for the caller's cache object, so what the caller's contract
//! keeps out of the key (the reference wire, the measurer's fonts, the theme)
//! is kept out here the same way: a caller that changes one hands a new cache,
//! and so names a new surface. The measurer the request names and its mode are
//! in the key besides, so a body measured by the host is never served to a
//! layout measured from a font table, nor a light body to a dark layout.
//!
//! One layout's writes are held back and kept only once it is answered, or
//! asks for fences to tokenise: a layout declined (its host measurer failed,
//! or a body passed the parser's bounds) may have drawn a body with what it was
//! missing, and that must not answer a later layout. Every surface shares one
//! least-recently-used store, held to [`MAX_CACHED_BODIES`] bodies and
//! [`MAX_CACHED_BYTES`] of keys.

use std::cell::RefCell;
use std::sync::{Mutex, MutexGuard, PoisonError};

use wasm_bindgen::prelude::wasm_bindgen;
use whiteboard_canvas_render::compose_node::ContentCache;
use whiteboard_canvas_render::typeset::FittedBlocks;

use super::MAX_BODY_BYTES;
use super::request::MeasureSpec;

/// The most bodies an instance keeps across its surfaces: the cap of the
/// TypeScript's `createSpatialContentCache`, doubled for a page and a worker's
/// surfaces sharing one instance.
pub const MAX_CACHED_BODIES: usize = 4096;

/// The most key bytes an instance keeps: four requests' bodies. A key holds its
/// body's whole text, which the laid-out body's size follows, so this bounds
/// what the store holds where a count of bodies alone would not: 4096 bodies
/// at the request cap are 3 GiB of text.
pub const MAX_CACHED_BYTES: usize = 4 * MAX_BODY_BYTES;

/// A key's FNV-1a hash, compared before the key itself: keys share long
/// prefixes (the measurer, the mode, the box), so a search comparing whole keys
/// costs the square of the bodies times their text.
fn hash_of(key: &str) -> u64 {
    key.bytes().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
    })
}

/// One body kept: whose, under which key, and when it was last used.
struct Kept {
    surface: u32,
    hash: u64,
    key: String,
    used: u64,
    body: FittedBlocks,
}

/// Bodies by surface and key, each stamped with when it was last used. A list
/// searched in order by hash: at most [`MAX_CACHED_BODIES`] of them, and a
/// layout looks up one per body, while a map over them cost the artifact more
/// than the search costs a layout.
pub(crate) struct Resident {
    max_bodies: usize,
    max_bytes: usize,
    clock: u64,
    bytes: usize,
    kept: Vec<Kept>,
}

impl Resident {
    pub(crate) const fn new(max_bodies: usize, max_bytes: usize) -> Self {
        Self { max_bodies, max_bytes, clock: 0, bytes: 0, kept: Vec::new() }
    }

    fn tick(&mut self) -> u64 {
        self.clock = self.clock.saturating_add(1);
        self.clock
    }

    fn at(&self, surface: u32, key: &str) -> Option<usize> {
        let hash = hash_of(key);
        self.kept
            .iter()
            .position(|kept| kept.hash == hash && kept.surface == surface && kept.key == key)
    }

    /// The body `surface` kept under `key`, now its most recently used.
    pub(crate) fn get(&mut self, surface: u32, key: &str) -> Option<FittedBlocks> {
        let now = self.tick();
        let at = self.at(surface, key)?;
        let kept = self.kept.get_mut(at)?;
        kept.used = now;
        Some(kept.body.clone())
    }

    /// Keeps `body` under `key` for `surface`, forgetting the least recently
    /// used bodies of every surface until it fits; a key past the byte cap on
    /// its own is not kept.
    pub(crate) fn set(&mut self, surface: u32, key: String, body: FittedBlocks) {
        if key.len() > self.max_bytes {
            return;
        }
        if let Some(at) = self.at(surface, &key) {
            let replaced = self.kept.swap_remove(at);
            self.bytes = self.bytes.saturating_sub(replaced.key.len());
        }
        while self.kept.len() >= self.max_bodies
            || self.bytes.saturating_add(key.len()) > self.max_bytes
        {
            let oldest = self.kept.iter().enumerate().min_by_key(|(_, kept)| kept.used);
            let Some((at, _)) = oldest else { break };
            let evicted = self.kept.swap_remove(at);
            self.bytes = self.bytes.saturating_sub(evicted.key.len());
        }
        let used = self.tick();
        self.bytes = self.bytes.saturating_add(key.len());
        self.kept.push(Kept { surface, hash: hash_of(&key), key, used, body });
    }

    /// Forgets every body `surface` kept; `false` when it kept none.
    pub(crate) fn release(&mut self, surface: u32) -> bool {
        let before = self.kept.len();
        self.kept.retain(|kept| kept.surface != surface);
        self.bytes = self.kept.iter().fold(0, |sum, kept| sum.saturating_add(kept.key.len()));
        self.kept.len() < before
    }

    /// The bodies kept, and their keys' bytes.
    #[cfg(test)]
    pub(crate) fn held(&self) -> (usize, usize) {
        (self.kept.len(), self.bytes)
    }

    /// Whether `surface` keeps a body under `key`, without using it.
    #[cfg(test)]
    pub(crate) fn holds(&self, surface: u32, key: &str) -> bool {
        self.at(surface, key).is_some()
    }

    /// How many bodies `surface` keeps.
    #[cfg(test)]
    pub(crate) fn kept_by(&self, surface: u32) -> usize {
        self.kept.iter().filter(|kept| kept.surface == surface).count()
    }
}

static RESIDENT: Mutex<Resident> = Mutex::new(Resident::new(MAX_CACHED_BODIES, MAX_CACHED_BYTES));

/// This instance's store. A wasm instance aborts on a panic, so a poisoned lock
/// is reached only natively, where the store is whole between calls.
pub(crate) fn resident() -> MutexGuard<'static, Resident> {
    RESIDENT.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What a key says of the measurer a request names. A font handle is never
/// reused, so it names its faces for the instance's life.
fn measurer_of(spec: &MeasureSpec) -> String {
    match spec {
        MeasureSpec::Fake(factor) => format!("fake:{factor}"),
        MeasureSpec::Ratio => "ratio".to_owned(),
        MeasureSpec::Fonts(handle) => format!("fonts:{handle}"),
        MeasureSpec::Host => "host".to_owned(),
    }
}

/// One layout's view of a surface: what it reads comes from the store or from
/// its own writes, and what it writes reaches the store only through
/// [`Surface::keep`].
pub(super) struct Surface {
    id: u32,
    /// The measurer and the mode, ahead of the composer's key, which starts `[`.
    prefix: String,
    written: RefCell<Vec<(u64, String, FittedBlocks)>>,
}

impl Surface {
    pub(super) fn new(id: u32, measure: &MeasureSpec, dark: bool) -> Self {
        let mode = if dark { "dark" } else { "light" };
        let prefix = format!("{}|{mode}|", measurer_of(measure));
        Self { id, prefix, written: RefCell::default() }
    }

    fn key(&self, key: &str) -> String {
        format!("{}{key}", self.prefix)
    }

    /// Keeps what the layout wrote, once it is known to be answered.
    pub(super) fn keep(self) {
        let mut store = resident();
        for (_, key, body) in self.written.into_inner() {
            store.set(self.id, key, body);
        }
    }
}

impl ContentCache for Surface {
    fn get(&self, key: &str) -> Option<FittedBlocks> {
        let key = self.key(key);
        let hash = hash_of(&key);
        let written = self.written.borrow();
        if let Some((.., body)) = written.iter().find(|(h, held, _)| *h == hash && *held == key) {
            return Some(body.clone());
        }
        drop(written);
        resident().get(self.id, &key)
    }

    fn set(&self, key: &str, body: &FittedBlocks) {
        let key = self.key(key);
        self.written.borrow_mut().push((hash_of(&key), key, body.clone()));
    }
}

/// Forgets what a surface kept; `false` when it kept nothing.
#[wasm_bindgen]
#[must_use]
pub fn release_layout_cache(surface: u32) -> bool {
    resident().release(surface)
}

#[cfg(test)]
mod tests;
