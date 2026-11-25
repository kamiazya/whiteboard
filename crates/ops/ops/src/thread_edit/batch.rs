//! A batch's ops applied, in order, to what the document held when the batch
//! began: the writes they gather, and the first op that cannot be applied.

use std::collections::{BTreeMap, BTreeSet};

use whiteboard_api_contracts::Refusal;
use whiteboard_model::Value;
use whiteboard_model::crdt::{QueryName, Write, WriterName};
use whiteboard_reference_graph::text_limit::grows_past;

use super::anchor::{Content, stored};
use super::{Halt, ThreadOp};
use crate::content::field;
use crate::document_get::engine::Hosted;

/// `DOCUMENT_MAX_OPEN_THREADS`, and the phrase its refusal ends in.
const OPEN_THREADS_MAX: usize = 500;
const OPEN_THREADS_PHRASE: &str =
    "the limit of 500 open comment threads for one document; resolve some first";

/// `THREAD_MAX_MESSAGES`, and the phrase its refusal ends in.
const THREAD_MESSAGES_MAX: usize = 1000;
const THREAD_MESSAGES_PHRASE: &str =
    "the limit of 1000 messages in one comment thread; open a new thread to continue";

/// What `trim` takes off a string in JavaScript: its white space and its line
/// terminators, which is not the set `str::trim` takes (it takes the next-line
/// character and leaves the byte order mark).
pub const fn is_js_space(c: char) -> bool {
    matches!(c,
        '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
        | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

/// One thread as the batch tracks it, read once at load and kept current by
/// the ops, so no op re-reads the whole layer: every message of every thread,
/// resolved ones included, neither of which is bounded.
struct Tracked {
    open: bool,
    /// The ids of the readable messages.
    messages: BTreeSet<String>,
    /// Messages stored, unreadable ones included: what the ceiling counts.
    stored: usize,
}

/// The threads the document holds.
pub(super) struct Held {
    threads: BTreeMap<String, Tracked>,
}

fn text_of(value: Option<&Value>) -> Option<&str> {
    match value {
        Some(Value::String(text)) => Some(text),
        _ => None,
    }
}

impl Held {
    /// The annotation layer's threads and what each stores.
    pub(super) fn read(hosted: Hosted<'_>) -> Result<Self, Halt> {
        let threads = hosted.read(QueryName::Annotations, &[])?;
        let counts = hosted.read(QueryName::ThreadMessageCounts, &[])?;
        let stored = |id: &str| match field(&counts, id) {
            Some(Value::Number(n)) => format!("{n}").parse().unwrap_or(0),
            _ => 0,
        };
        let Value::Seq(threads) = threads else { return Ok(Self { threads: BTreeMap::new() }) };
        let tracked = threads.iter().filter_map(|thread| {
            let id = text_of(field(thread, "id"))?;
            let messages = match field(thread, "messages") {
                Some(Value::Seq(held)) => held
                    .iter()
                    .filter_map(|message| text_of(field(message, "id")).map(str::to_owned))
                    .collect(),
                _ => BTreeSet::new(),
            };
            let open = text_of(field(thread, "status")) == Some("open");
            Some((id.to_owned(), Tracked { open, messages, stored: stored(id) }))
        });
        Ok(Self { threads: tracked.collect() })
    }

    fn open(&self) -> usize {
        self.threads.values().filter(|thread| thread.open).count()
    }
}

/// What a batch wrote, in op order, and the threads it touched.
pub(super) struct Applied {
    pub(super) writes: Vec<Write>,
    /// The threads opened, replied to, resolved or reopened, by id in UTF-16
    /// order, which is how `Array.prototype.sort` orders strings.
    pub(super) touched: Vec<String>,
}

/// The first thread id `t<n>` the document does not hold: among the first
/// one more than it holds, since that many ids cannot all be taken.
fn minted(held: &Held) -> String {
    let free = (1..=held.threads.len().saturating_add(1)).map(|n| format!("t{n}"));
    free.into_iter().find(|id| !held.threads.contains_key(id)).unwrap_or_default()
}

fn write(op: WriterName, args: Vec<(&str, Value)>) -> Write {
    Write {
        op,
        args: Value::Map(args.into_iter().map(|(key, value)| (key.to_owned(), value)).collect()),
    }
}

fn text(s: &str) -> Value {
    Value::String(s.to_owned())
}

/// A message as the engine's writer takes it: id, body, then author and time.
fn message(id: &str, body: &str, author: Option<&String>, now: &str) -> Value {
    let mut members = vec![("id".to_owned(), text(id)), ("body".to_owned(), text(body))];
    members.push(("createdAt".to_owned(), text(now)));
    members.extend(author.map(|a| ("author".to_owned(), text(a))));
    Value::Map(members)
}

fn refuse(index: usize, op: &str, detail: String) -> Halt {
    Halt::Refused(Refusal::ThreadEditOpRefused {
        detail,
        op: op.to_owned(),
        op_index: u64::try_from(index).unwrap_or(u64::MAX),
    })
}

/// Why a message body says nothing, or `None` when it says something.
fn blank(body: &str) -> Option<String> {
    body.chars()
        .all(is_js_space)
        .then(|| "the message body is blank; write what the comment says".to_owned())
}

/// What one op is applied against.
struct Context<'a> {
    content: &'a Content,
    held: Held,
    writes: Vec<Write>,
    touched: BTreeSet<String>,
    now: &'a str,
}

/// Every op applied; a refusal names the op and keeps nothing.
pub(super) fn apply(
    ops: &[ThreadOp],
    content: &Content,
    held: Held,
    now: &str,
) -> Result<Applied, Halt> {
    let open_at_load = held.open();
    let mut ctx = Context { content, held, writes: Vec::new(), touched: BTreeSet::new(), now };
    for (index, op) in ops.iter().enumerate() {
        let name = match op {
            ThreadOp::Add { .. } => "thread.add",
            ThreadOp::Reply { .. } => "message.add",
            ThreadOp::Resolve { .. } => "thread.resolve",
        };
        ctx.apply(op).map_err(|detail| refuse(index, name, detail))?;
        // A reply opens nothing, so only the two ops that can are counted.
        if !matches!(op, ThreadOp::Reply { .. })
            && let Some(detail) = open_ceiling(open_at_load, ctx.held.open())
        {
            return Err(refuse(index, name, detail));
        }
    }
    let mut touched: Vec<String> = ctx.touched.into_iter().collect();
    touched.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    Ok(Applied { writes: ctx.writes, touched })
}

/// Why an edit that leaves `after` threads open, from `before`, is refused.
fn open_ceiling(before: usize, after: usize) -> Option<String> {
    grows_past(OPEN_THREADS_MAX, before, after).then(|| {
        format!("the document would hold {after} open comment threads, past {OPEN_THREADS_PHRASE}")
    })
}

impl Context<'_> {
    fn apply(&mut self, op: &ThreadOp) -> Result<(), String> {
        match op {
            ThreadOp::Add { thread_id, anchor, body, author } => {
                self.add(thread_id.as_ref(), anchor, body, author.as_ref())
            }
            ThreadOp::Reply { thread_id, body, author } => {
                self.reply(thread_id, body, author.as_ref())
            }
            ThreadOp::Resolve { thread_id, resolved } => self.resolve(thread_id, *resolved),
        }
    }

    fn add(
        &mut self,
        thread_id: Option<&String>,
        anchor: &super::ThreadAnchor,
        body: &str,
        author: Option<&String>,
    ) -> Result<(), String> {
        let id = thread_id.cloned().unwrap_or_else(|| minted(&self.held));
        if self.held.threads.contains_key(&id) {
            return Err(format!("thread \"{id}\" is already on this document"));
        }
        if let Some(detail) = blank(body) {
            return Err(detail);
        }
        let anchor = stored(anchor, self.content)?;
        let first = format!("{id}-m1");
        let thread = Value::Map(vec![
            ("id".to_owned(), text(&id)),
            ("anchor".to_owned(), anchor),
            ("status".to_owned(), text("open")),
            ("createdAt".to_owned(), text(self.now)),
            ("messages".to_owned(), Value::Seq(vec![message(&first, body, author, self.now)])),
        ]);
        self.writes.push(write(WriterName::WriteCommentThread, vec![("thread", thread)]));
        let tracked = Tracked { open: true, messages: BTreeSet::from([first]), stored: 1 };
        self.held.threads.insert(id.clone(), tracked);
        self.touched.insert(id);
        Ok(())
    }

    fn reply(
        &mut self,
        thread_id: &str,
        body: &str,
        author: Option<&String>,
    ) -> Result<(), String> {
        if let Some(detail) = blank(body) {
            return Err(detail);
        }
        // Refused rather than silently accepted: the writer is a no-op for a
        // thread this replica does not hold, since opening a container is the
        // one write that cannot merge, and a quiet no-op would report success
        // over a lost reply.
        let Some(thread) = self.held.threads.get_mut(thread_id) else {
            return Err(format!("thread \"{thread_id}\" is not on this document"));
        };
        // Minted against the ids the thread HOLDS, not its message count: a
        // peer's reply that merged in leaves the two disagreeing, and reusing
        // an id overwrites someone else's message instead of replying.
        let mut suffix = thread.messages.len().saturating_add(1);
        while thread.messages.contains(&format!("{thread_id}-m{suffix}")) {
            suffix = suffix.saturating_add(1);
        }
        let id = format!("{thread_id}-m{suffix}");
        let after = thread.stored.saturating_add(1);
        if grows_past(THREAD_MESSAGES_MAX, thread.stored, after) {
            return Err(format!(
                "thread \"{thread_id}\" would hold {after} messages, past {THREAD_MESSAGES_PHRASE}"
            ));
        }
        thread.stored = after;
        thread.messages.insert(id.clone());
        let message = message(&id, body, author, self.now);
        let args = vec![("threadId", text(thread_id)), ("message", message)];
        self.writes.push(write(WriterName::WriteThreadMessage, args));
        self.touched.insert(thread_id.to_owned());
        Ok(())
    }

    fn resolve(&mut self, thread_id: &str, resolved: Option<bool>) -> Result<(), String> {
        let Some(thread) = self.held.threads.get_mut(thread_id) else {
            return Err(format!("thread \"{thread_id}\" is not on this document"));
        };
        let reopened = resolved == Some(false);
        thread.open = reopened;
        let status = text(if reopened { "open" } else { "resolved" });
        self.writes.push(write(
            WriterName::SetCommentThreadStatus,
            vec![("threadId", text(thread_id)), ("status", status)],
        ));
        self.touched.insert(thread_id.to_owned());
        Ok(())
    }
}
