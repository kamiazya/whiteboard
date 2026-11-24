//! The most one call answers with, summed over its documents: each one's
//! content plus its threads and proposals as serialised, in UTF-16 code
//! units as JavaScript counts a string's length.
//!
//! The first document read is always answered, however large, so any
//! document stays readable by asking for it alone; its annotation layer is
//! what is trimmed to fit (`annotationsTruncated`).

use whiteboard_codec::json_canvas::json_text;
use whiteboard_model::Value;

use super::{DocumentGetOutput, FailedRead, ReadDocument};

/// `MARKDOWN_MAX_CHARS`: the longest markdown body.
const MARKDOWN_MAX_CHARS: usize = 256 * 1024;

/// Four maximal markdown bodies.
pub(super) const MAX_CONTENT_CHARS: usize = 4 * MARKDOWN_MAX_CHARS;

fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

/// The length of `JSON.stringify(value)`. A value the engine answers is plain
/// JSON, so the writer's refusals (a bigint, nesting past its cap) are none
/// it meets; one would count as nothing.
fn json_units(value: &Value) -> usize {
    json_text(value).map_or(0, |text| units(&text))
}

/// What one read costs: its content and each annotation list it holds.
fn charged(read: &ReadDocument) -> usize {
    let list = |items: &[Value]| {
        if items.is_empty() { 0 } else { json_units(&Value::Seq(items.to_vec())) }
    };
    units(&read.content).saturating_add(list(&read.threads)).saturating_add(list(&read.proposals))
}

/// The leading `items` whose serialised length fits `room`, which shrinks by
/// what they take. Leading rather than newest because the stored order is
/// the only order both lists share.
fn take(items: Vec<Value>, room: &mut usize) -> Vec<Value> {
    let mut kept = Vec::new();
    for item in items {
        let cost = json_units(&item);
        if cost > *room {
            break;
        }
        *room = room.saturating_sub(cost);
        kept.push(item);
    }
    kept
}

/// A read alone over the budget: its content whole, and as many leading
/// threads, then proposals, as the rest of the budget holds.
fn trimmed(read: ReadDocument) -> ReadDocument {
    let mut room = MAX_CONTENT_CHARS.saturating_sub(units(&read.content));
    let threads = take(read.threads, &mut room);
    let proposals = take(read.proposals, &mut room);
    ReadDocument { threads, proposals, annotations_truncated: true, ..read }
}

/// The answer as it is built, and what it has spent.
#[derive(Default)]
pub(super) struct Budget {
    output: DocumentGetOutput,
    used: usize,
    spent: bool,
}

impl Budget {
    /// Whether a document has already been turned away or trimmed.
    pub(super) fn spent(&self) -> bool {
        self.spent
    }

    /// A document reported unread because the answer is full.
    pub(super) fn unread(&mut self, document_id: String) {
        let reason = format!(
            "Not read: this call's answer reached its {MAX_CONTENT_CHARS}-character budget (content and comments) before {document_id}. Read it alone, or in a smaller batch."
        );
        self.output.failed.push(FailedRead { document_id, reason });
    }

    pub(super) fn fail(&mut self, failed: FailedRead) {
        self.output.failed.push(failed);
    }

    /// A read, kept whole when it fits; trimmed when it is the first and does
    /// not; reported unread when it neither fits nor is the first.
    pub(super) fn offer(&mut self, read: ReadDocument) {
        let cost = charged(&read);
        if self.used.saturating_add(cost) <= MAX_CONTENT_CHARS {
            self.used = self.used.saturating_add(cost);
            self.output.documents.push(read);
            return;
        }
        self.spent = true;
        if self.output.documents.is_empty() {
            self.output.documents.push(trimmed(read));
        } else {
            self.unread(read.document_id);
        }
    }

    pub(super) fn finish(self) -> DocumentGetOutput {
        self.output
    }
}

#[cfg(test)]
mod tests;
