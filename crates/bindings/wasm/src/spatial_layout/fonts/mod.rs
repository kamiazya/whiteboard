//! The faces a font-table measurer reads, registered once and named by a
//! handle (owner decision q76), so a layout request carries a number rather
//! than the 1.45 MB of the daemon's four faces on every call.
//!
//! `register_layout_fonts(bytes, faces)` reads `faces` (the value wire of
//! [`crate::json_canvas_wire`]: a list of `{family, bold, italic, from, to}`,
//! each a range of `bytes`), keeps the faces the reader can read and a copy of
//! `bytes` in this instance and answers `["ok", handle]`, or
//! `["refused", code, class]` for an input past its caps or one that is not
//! faces. A face the reader cannot read (a WOFF, a collection, one past
//! [`whiteboard_canvas_render::sfnt::MAX_BYTES`]) is dropped rather than refusing the rest (owner
//! decision q81, D7g): a layout then declares its family nowhere, so a theme
//! naming it reports `font-missing` and draws in the faces that were read.
//! `release_layout_fonts(handle)` forgets them. A handle is never reused, so
//! one released, or minted by an instance since recreated, answers a layout
//! `["refused", "malformed", "font-handle"]` and the host registers again.
//!
//! The measurer borrows the bytes it reads, so each layout re-reads the faces
//! it is handed from the copy held here: the table directory and one
//! validation pass over each `cmap` subtable, allocating nothing past the
//! family list. Every face was proved to parse when it was registered, and the
//! faces' ranges may not add up to more than the bytes registered, so that
//! read is at most one pass over [`MAX_HELD_BYTES`].

use std::sync::{Mutex, MutexGuard, PoisonError};

use wasm_bindgen::prelude::wasm_bindgen;
use whiteboard_canvas_render::font_measure::FontTableMeasurer;
use whiteboard_canvas_render::measure::FontStyle;
use whiteboard_canvas_render::sfnt::Sfnt;

use super::answer::refused;
use super::request::{Face, face_of};
use crate::input_caps::REGISTER_LAYOUT_FONTS;
use crate::json_canvas_wire::{items_of, json_value};

/// The most faces one registration may hold: this entry's `maxNodes`.
pub const MAX_FACES: usize = match REGISTER_LAYOUT_FONTS.max_nodes {
    Some(n) => n,
    None => 0,
};

/// The most registrations an instance holds at once. A surface registers one
/// set of faces per measurer it lays out with, so this is far above any root.
pub const MAX_HANDLES: usize = 64;

/// The most an instance holds across its registrations, the faces' bytes and
/// their family names together: one registration's own `maxBytes`, so a second
/// as large waits for a release.
pub const MAX_HELD_BYTES: usize = REGISTER_LAYOUT_FONTS.max_bytes;

/// Why a registration was refused: a code and a class, as the answer spells them.
type Refusal = (&'static str, &'static str);

struct Held {
    handle: u32,
    faces: Vec<Face>,
    bytes: Vec<u8>,
}

/// The registrations one instance holds.
pub(crate) struct Fonts {
    next: u32,
    held: Vec<Held>,
}

/// The faces of `faces` the reader can read, each a range of `bytes`; a range
/// outside `bytes` is no face of these bytes, and refused.
fn readable(bytes: &[u8], faces: Vec<Face>) -> Result<Vec<Face>, Refusal> {
    let mut read = Vec::with_capacity(faces.len());
    for face in faces {
        let data = bytes.get(face.from..face.to).ok_or(("malformed", "font"))?;
        if Sfnt::parse(data).is_ok() {
            read.push(face);
        }
    }
    Ok(read)
}

/// The measurer over `faces`, each a range of `bytes` that was read when it
/// was registered, so none fails here.
fn measurer<'b>(bytes: &'b [u8], faces: &[Face]) -> Option<FontTableMeasurer<'b>> {
    faces.iter().try_fold(FontTableMeasurer::new(), |measurer, face| {
        let style = if face.italic { FontStyle::Italic } else { FontStyle::Normal };
        let data = bytes.get(face.from..face.to)?;
        measurer.with_face(&face.family, face.bold, style, data).ok()
    })
}

/// What a registration holds: its bytes, and each face's family, which is
/// kept beside them and whose length the wire alone bounds.
fn cost(bytes: &[u8], faces: &[Face]) -> usize {
    faces.iter().fold(bytes.len(), |sum, face| sum.saturating_add(face.family.len()))
}

impl Fonts {
    pub(crate) const fn new() -> Self {
        Self { next: 0, held: Vec::new() }
    }

    fn held_bytes(&self) -> usize {
        self.held.iter().fold(0, |sum, held| sum.saturating_add(cost(&held.bytes, &held.faces)))
    }

    /// Holds `faces` over a copy of `bytes`, answering the handle that names them.
    pub(crate) fn register(&mut self, bytes: &[u8], faces: Vec<Face>) -> Result<u32, Refusal> {
        if faces.len() > MAX_FACES {
            return Err(("input-too-large", "faces"));
        }
        // Every layout over the handle reads each face again, in time linear in
        // its range, so ranges that overlap would charge every layout for the
        // same bytes many times over; the shim places each face once.
        let spans =
            faces.iter().fold(0_usize, |n, f| n.saturating_add(f.to.saturating_sub(f.from)));
        if spans > bytes.len() {
            return Err(("input-too-large", "face-bytes"));
        }
        if self.held.len() >= MAX_HANDLES {
            return Err(("input-too-large", "handles"));
        }
        if self.held_bytes().saturating_add(cost(bytes, &faces)) > MAX_HELD_BYTES {
            return Err(("input-too-large", "held"));
        }
        let faces = readable(bytes, faces)?;
        let handle = self.next;
        self.next = handle.checked_add(1).ok_or(("input-too-large", "handles"))?;
        self.held.push(Held { handle, faces, bytes: bytes.to_vec() });
        Ok(handle)
    }

    /// Forgets a registration; `false` when the handle names none.
    pub(crate) fn release(&mut self, handle: u32) -> bool {
        let before = self.held.len();
        self.held.retain(|held| held.handle != handle);
        self.held.len() < before
    }

    /// The measurer a handle names, or `None` when it names no registration.
    pub(crate) fn measurer(&self, handle: u32) -> Option<FontTableMeasurer<'_>> {
        let held = self.held.iter().find(|held| held.handle == handle)?;
        measurer(&held.bytes, &held.faces)
    }
}

static FONTS: Mutex<Fonts> = Mutex::new(Fonts::new());

/// This instance's registrations. A wasm instance aborts on a panic, so a
/// poisoned lock is reached only natively, where the state it guards is
/// whole between calls.
pub(crate) fn held() -> MutexGuard<'static, Fonts> {
    FONTS.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Registers faces for later layouts; see the module's documentation.
#[wasm_bindgen]
#[must_use]
pub fn register_layout_fonts(bytes: &[u8], faces: &str) -> String {
    if bytes.len().saturating_add(faces.len()) > REGISTER_LAYOUT_FONTS.max_bytes {
        return refused("input-too-large", "too-large");
    }
    let read = serde_json::from_str(faces).ok().as_ref().and_then(json_value);
    let Some(faces) = read.as_ref().and_then(|v| items_of(v, face_of)) else {
        return refused("malformed", "faces");
    };
    match held().register(bytes, faces) {
        Ok(handle) => format!("[\"ok\",{handle}]"),
        Err((code, class)) => refused(code, class),
    }
}

/// Forgets the faces a handle names; `false` when it names none.
#[wasm_bindgen]
#[must_use]
pub fn release_layout_fonts(handle: u32) -> bool {
    held().release(handle)
}

#[cfg(test)]
mod tests;
