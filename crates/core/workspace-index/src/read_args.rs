//! A read's arguments held to the TypeScript's `readArgsSchema`: the hosting
//! node of a document, a path, a container, the kind an index row records and
//! the version a since-reader compares against, and nothing else.

use crate::hosted_reads::is_safe_integer;
use whiteboard_crdt::VersionVector;
use whiteboard_model::Value;

/// The arguments of a read the schema accepts.
#[derive(Debug, Default)]
pub(crate) struct ReadArgs {
    pub document_id: Option<String>,
    pub path: Option<String>,
    pub container: Option<String>,
    pub kind: Option<Value>,
    /// `[peer, counter]` pairs, as asked.
    pub since: Vec<(String, f64)>,
}

/// Arguments the schema refuses: a refusal of its own, left to the caller.
#[derive(Debug)]
pub(crate) struct ArgumentsRefused;

fn text(value: &Value) -> Result<String, ArgumentsRefused> {
    match value {
        Value::String(text) => Ok(text.clone()),
        _ => Err(ArgumentsRefused),
    }
}

/// A version as `[peer, counter]` pairs, counters whole and safe.
fn pairs(value: &Value) -> Result<Vec<(String, f64)>, ArgumentsRefused> {
    let Value::Seq(pairs) = value else { return Err(ArgumentsRefused) };
    pairs
        .iter()
        .map(|pair| match pair {
            Value::Seq(held) => match held.as_slice() {
                [Value::String(peer), Value::Number(counter)] if is_safe_integer(*counter) => {
                    Ok((peer.clone(), *counter))
                }
                _ => Err(ArgumentsRefused),
            },
            _ => Err(ArgumentsRefused),
        })
        .collect()
}

/// `entries` held to the schema.
pub(crate) fn read_args_of(entries: &[(String, Value)]) -> Result<ReadArgs, ArgumentsRefused> {
    let mut args = ReadArgs::default();
    for (key, value) in entries {
        match key.as_str() {
            "documentId" => args.document_id = Some(text(value)?),
            "path" => args.path = Some(text(value)?),
            "container" => args.container = Some(text(value)?),
            "since" => args.since = pairs(value)?,
            "kind" if matches!(value, Value::String(k) if k == "spatial" || k == "markdown") => {
                args.kind = Some(value.clone());
            }
            _ => return Err(ArgumentsRefused),
        }
    }
    Ok(args)
}

/// A query's arguments held to the schema: none read as no arguments.
pub(crate) fn read_args(args: Option<&Value>) -> Result<ReadArgs, ArgumentsRefused> {
    match args {
        None => Ok(ReadArgs::default()),
        Some(Value::Map(entries)) => read_args_of(entries),
        Some(_) => Err(ArgumentsRefused),
    }
}

/// The version `since` names, `None` for one this crate leaves to the caller:
/// a peer not written as a canonical u64, or a counter past what a loro
/// version holds, which npm loro-crdt refuses or wraps in its own way.
pub(crate) fn version_of(since: &[(String, f64)]) -> Option<VersionVector> {
    let mut version = VersionVector::new();
    for (peer, counter) in since {
        let id: u64 = peer.parse().ok()?;
        let at: i32 = counter.to_string().parse().ok()?;
        if id.to_string() != *peer || at < 0 {
            return None;
        }
        version.insert(id, at);
    }
    Some(version)
}
