//! A spatial document created (`wbDocumentCreate`'s spatial arm): placed by
//! the index under an id minted as `generateDocumentId` mints one, then given
//! its first content, a copy that records the kind (`withNewDocument`), which
//! the record takes as the content the new node holds.

use whiteboard_crdt::{ExportMode, LoroDoc, MoreWriters, WriteAnswer, write_batch};
use whiteboard_model::Value;
use whiteboard_model::crdt::{Write, WriteJudge, WriterName};
use whiteboard_model::encoding::bytes_to_base64;
use whiteboard_ports::{Clock, DocumentWritten, IdMint};
use whiteboard_workspace_index::display_name::js_trim;
use whiteboard_workspace_index::{CreateDocument, WorkspaceWriters, create_document};

use super::{Batch, Halt, refused};
use crate::Ports;

/// The Crockford base32 alphabet a ULID is written in.
const ENCODING: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// How many characters a ULID's time and its randomness take.
const TIME_CHARS: usize = 10;
const RANDOM_CHARS: usize = 16;

/// The kind a spatial create records.
const SPATIAL: &str = "spatial";

/// The document created at `path`, named `name` unless it is blank: its id and
/// the path it was placed at.
pub(super) fn spatial<P: Ports>(
    ports: &P,
    batch: &mut Batch<'_>,
    path: &str,
    name: Option<&str>,
) -> Result<(String, String), Halt> {
    let now_ms = ports.clock().now_ms();
    let name = name.map(js_trim).filter(|name| !name.is_empty());
    let input = CreateDocument { workspace_id: batch.workspace_id, path, kind: SPATIAL, name };
    // A clock no ULID can spell is answered by the index's own time check.
    let mut mint =
        || document_id(now_ms, &ports.mint().random_bytes(RANDOM_CHARS)).unwrap_or_default();
    let created = create_document(&batch.record, &input, &mut mint, now_ms).map_err(refused::of)?;
    let entry = created.value;
    fill(ports, &batch.record, &entry.document_id, now_ms)?;
    batch.written.push(DocumentWritten {
        workspace_id: batch.workspace_id.to_owned(),
        document_id: entry.document_id.clone(),
        path: entry.path.clone(),
    });
    Ok((entry.document_id, entry.path))
}

/// `generateDocumentId`: the time in milliseconds as ten base32 characters,
/// most significant first, then one character per random byte, the byte
/// taken modulo the alphabet; `None` for a time no digit spells (not a whole
/// number of milliseconds, or before the epoch).
pub(super) fn document_id(now_ms: f64, random: &[u8]) -> Option<String> {
    let mut time = Vec::with_capacity(TIME_CHARS);
    let mut remaining = now_ms;
    for _ in 0..TIME_CHARS {
        time.push(digit(remaining % 32.0));
        remaining = (remaining / 32.0).floor();
    }
    time.reverse();
    let random = random.iter().map(|byte| ENCODING.get(usize::from(byte % 32)).copied());
    time.into_iter().chain(random).map(|c| c.map(char::from)).collect()
}

/// The character of a base32 digit held as a double, as the alphabet indexed
/// by it answers.
fn digit(value: f64) -> Option<u8> {
    (0u8..32)
        .find(|d| f64::from(*d).total_cmp(&value).is_eq())
        .and_then(|d| ENCODING.get(usize::from(d)).copied())
}

/// The new document's first content, written to a copy of its own (a replica
/// the `IdMint` names) and taken by the record as the content its node holds.
fn fill<P: Ports>(
    ports: &P,
    record: &whiteboard_workspace_index::WorkspaceRecord,
    document_id: &str,
    now_ms: f64,
) -> Result<(), Halt> {
    let empty = LoroDoc::new().export(ExportMode::Snapshot).map_err(|_| Halt::Pending)?;
    let kind = Value::Map(vec![("kind".to_owned(), Value::String(SPATIAL.to_owned()))]);
    let writes = [Write { op: WriterName::WriteDocumentKind, args: kind }];
    let written = write_batch(&empty, ports.mint().peer_id(), &writes, WriteJudge::None)
        .ok_or(Halt::Pending)?;
    if !matches!(written.answer, WriteAnswer::Applied(_)) {
        return Err(Halt::Pending);
    }
    let content = written.doc.export(ExportMode::Snapshot).map_err(|_| Halt::Pending)?;
    let source = Value::Map(vec![
        ("documentId".to_owned(), Value::String(document_id.to_owned())),
        ("source".to_owned(), Value::String(bytes_to_base64(&content))),
    ]);
    let step = WorkspaceWriters { now_ms }.apply(
        record.doc(),
        WriterName::WriteDocumentContentAndName,
        &source,
    );
    record.doc().commit();
    // A write the content sync declines (one changing more than one of a
    // document's roots), or one the engine throws on, is not answered here.
    match step {
        Some(Ok(())) => Ok(()),
        Some(Err(_)) | None => Err(Halt::Pending),
    }
}
