//! The proposal a call stores its passages in: which one it continues, the id
//! it takes, who and when it is stamped as, and the ceiling on the open
//! changes a document holds across every proposal.

use std::collections::HashSet;

use whiteboard_api_contracts::Refusal;
use whiteboard_model::Value;
use whiteboard_model::crdt::{Write, WriterName};

use super::BodyEditInput;
use crate::content::field;
use crate::text_refusal::phrase;

/// `DOCUMENT_MAX_OPEN_CHANGES`.
const MAX_OPEN_CHANGES: usize = 1000;

fn text<'v>(proposal: &'v Value, key: &str) -> Option<&'v str> {
    match field(proposal, key) {
        Some(Value::String(held)) => Some(held),
        _ => None,
    }
}

fn changes(proposal: &Value) -> &[Value] {
    match field(proposal, "changes") {
        Some(Value::Seq(held)) => held,
        _ => &[],
    }
}

/// The stored proposal under `id`.
pub(super) fn find<'v>(held: &'v [Value], id: &str) -> Option<&'v Value> {
    held.iter().find(|proposal| text(proposal, "id") == Some(id))
}

/// The ids of the changes a stored proposal holds.
pub(super) fn change_ids(proposal: &Value) -> Vec<String> {
    changes(proposal).iter().filter_map(|change| text(change, "id")).map(str::to_owned).collect()
}

/// The first `p<n>` no stored proposal holds.
fn mint(held: &[Value]) -> String {
    let taken: HashSet<&str> = held.iter().filter_map(|proposal| text(proposal, "id")).collect();
    (1_u32..=u32::MAX)
        .map(|n| format!("p{n}"))
        .find(|candidate| !taken.contains(candidate.as_str()))
        .unwrap_or_default()
}

/// How many changes of `proposals` are still open.
fn open_in(changes: &[Value]) -> usize {
    changes.iter().filter(|change| text(change, "status") == Some("open")).count()
}

/// The proposal a call writes: its own fields, which a continuation keeps
/// from the proposal it continues, so a batch that took several calls names
/// the call that opened it.
pub(super) struct Stored {
    pub(super) id: String,
    author: Option<String>,
    created_at: String,
}

impl Stored {
    pub(super) fn of(
        input: &BodyEditInput,
        continuing: Option<&Value>,
        held: &[Value],
        now: &str,
    ) -> Self {
        let kept = |key: &str| continuing.and_then(|proposal| text(proposal, key));
        Self {
            id: input.proposal_id.clone().unwrap_or_else(|| mint(held)),
            author: kept("author").map(str::to_owned).or_else(|| input.author.clone()),
            created_at: kept("createdAt").unwrap_or(now).to_owned(),
        }
    }

    /// Refuses a write that leaves the document holding more open changes
    /// than it may, counted across every proposal it holds: a change written
    /// under an id the proposal holds replaces it.
    pub(super) fn refuse_growth(&self, held: &[Value], added: &[Value]) -> Result<(), Refusal> {
        let before: usize = held.iter().map(|proposal| open_in(changes(proposal))).sum();
        let own = find(held, &self.id).map_or(&[][..], changes);
        let written: HashSet<&str> = added.iter().filter_map(|c| text(c, "id")).collect();
        let kept =
            own.iter().filter(|change| !text(change, "id").is_some_and(|id| written.contains(id)));
        let others: usize = held
            .iter()
            .filter(|proposal| text(proposal, "id") != Some(self.id.as_str()))
            .map(|proposal| open_in(changes(proposal)))
            .sum();
        let after =
            others + kept.filter(|c| text(c, "status") == Some("open")).count() + open_in(added);
        if after > MAX_OPEN_CHANGES && after > before {
            return Err(Refusal::OpenChangesCeiling {
                open: u64::try_from(after).unwrap_or(u64::MAX),
                limit: phrase::OPEN_CHANGES.to_owned(),
            });
        }
        Ok(())
    }

    /// The proposal written, carrying only this call's changes.
    pub(super) fn write(&self, changes: Vec<Value>) -> Write {
        let mut proposal = vec![("id".to_owned(), Value::String(self.id.clone()))];
        if let Some(author) = &self.author {
            proposal.push(("author".to_owned(), Value::String(author.clone())));
        }
        proposal.push(("createdAt".to_owned(), Value::String(self.created_at.clone())));
        proposal.push(("changes".to_owned(), Value::Seq(changes)));
        Write {
            op: WriterName::WriteProposal,
            args: Value::Map(vec![("proposal".to_owned(), Value::Map(proposal))]),
        }
    }
}

#[cfg(test)]
mod tests;
