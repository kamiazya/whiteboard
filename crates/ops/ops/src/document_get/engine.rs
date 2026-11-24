//! A document's content queries asked of the workspace record that hosts it,
//! and a refusal the engine answers by class re-raised as the TypeScript's
//! `readRestoringRefusal` re-raises it.

use whiteboard_api_contracts::Refusal;
use whiteboard_model::Value;
use whiteboard_model::crdt::{Query, QueryName};
use whiteboard_workspace_index::{WorkspaceRecord, answer_workspace_query};

use super::{Pending, Stop};

/// What a refusal that the retired-shape question cannot name is named as.
const UNNAMED_RETIRED_SHAPE: &str = "a markdown body stored as a canvas text node";

/// Why a read has no value.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum Fault {
    /// The document holds a shape an older version stored: a failure of this
    /// document alone, reported beside the others.
    Retired(String),
    /// The whole call stops.
    Stop(Stop),
}

/// The document a read is asked of, in the record that hosts it.
#[derive(Clone, Copy)]
pub(super) struct Hosted<'a> {
    pub(super) record: &'a WorkspaceRecord,
    pub(super) document_id: &'a str,
}

impl Hosted<'_> {
    /// The answer of `query` with `args` beside the document's id, as the
    /// engine gives it: `Ok` with the value, `Err` with the class it refused
    /// with. A query the record leaves undecided stops the call as pending.
    fn raw(self, query: QueryName, args: &[(&str, Value)]) -> Result<Result<Value, String>, Stop> {
        let mut entries = vec![("documentId".to_owned(), Value::String(self.document_id.into()))];
        entries.extend(args.iter().map(|(key, value)| ((*key).to_owned(), value.clone())));
        let asked = Query { query, args: Some(Value::Map(entries)) };
        let undecided = || Stop::Pending(Pending::UndecidedRead(self.document_id.to_owned()));
        let Some(answer) = answer_workspace_query(self.record.doc(), &asked) else {
            return Err(undecided());
        };
        // The engine's contract: `{ ok: value }` or `{ err: class }`.
        match answer.value {
            Value::Map(mut entries) => match entries.pop() {
                Some((key, value)) if key == "ok" => Ok(Ok(value)),
                Some((_, Value::String(class))) => Ok(Err(class)),
                _ => Err(undecided()),
            },
            _ => Err(undecided()),
        }
    }

    /// `query`'s value, a refusal re-raised as the class it stands for.
    pub(super) fn read(self, query: QueryName, args: &[(&str, Value)]) -> Result<Value, Fault> {
        let class = match self.raw(query, args).map_err(Fault::Stop)? {
            Ok(value) => return Ok(value),
            Err(class) => class,
        };
        if class == "RetiredStoredShapeError" {
            let found = self.read(QueryName::RetiredStoredShape, args)?;
            return Err(Fault::Retired(match found {
                Value::String(found) => found,
                _ => UNNAMED_RETIRED_SHAPE.to_owned(),
            }));
        }
        // A count, so never below none.
        if class == "RetiredCommentPlaneError"
            && let Value::Number(rows) = self.read(QueryName::RetiredCommentRows, args)?
            && rows != 0.0
        {
            let refusal = Refusal::RetiredCommentPlane { rows: count(rows) };
            return Err(Fault::Stop(Stop::Refused(refusal)));
        }
        // Any other refusal is thrown on as the engine's `Error`, whose text
        // the tool answers verbatim.
        let message = format!("{} was refused: {class}", query.as_str());
        Err(Fault::Stop(Stop::Refused(Refusal::CorruptStoredData { message })))
    }
}

/// A count of rows a record holds, which the engine answers as a whole
/// number: read through its digits, which a whole double prints without a
/// fraction.
fn count(rows: f64) -> u64 {
    format!("{rows}").parse().unwrap_or(u64::MAX)
}

/// `value` unless it is the engine's mark for no value.
pub(super) fn defined(value: Value) -> Option<Value> {
    match &value {
        Value::Map(entries) if matches!(entries.as_slice(), [(key, _)] if key == "$undefined") => {
            None
        }
        _ => Some(value),
    }
}
