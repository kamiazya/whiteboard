//! The caps of `crates/input-caps.json`, generated into each language that
//! enforces them (QR-28b), so the TypeScript and the Rust refuse the same
//! inputs because they read the same numbers.
//!
//! An entry is emitted when its crate has a target below and it is not the
//! template, whose caps bound the fuzzer rather than a refusal. The refusal
//! codes are defined here once and emitted with the TypeScript half, the
//! half that reports them; the Rust export answers a refusal as an empty
//! array, and the shim names its code.

use std::fmt::Write as _;

use std::collections::BTreeMap;

use super::emit::{header, within_width};
use crate::inputs::{Caps, LEDGER_PATH};

/// A crate whose entries are enforced on both sides of its boundary, and
/// where each half of its caps is written.
pub(super) struct Target {
    pub(super) krate: &'static str,
    pub(super) ts: &'static str,
    pub(super) rust: &'static str,
}

pub(super) const TARGETS: &[Target] = &[Target {
    krate: "whiteboard-wasm",
    ts: "packages/core-wasm/src/generated/input-caps.ts",
    rust: "crates/bindings/wasm/src/generated/input_caps.rs",
}];

/// Every reason an untrusted-input entry refuses its input, with what it means.
pub(super) const REFUSAL_CODES: &[(&str, &str)] = &[
    ("input-too-large", "the input is past one of its entry's caps, refused before it is parsed"),
    ("malformed", "the input is within its caps but not what the entry reads"),
];

/// One entry's caps, every required one present.
struct Resolved<'a> {
    key: &'a str,
    name: String,
    max_bytes: u64,
    max_depth: u64,
    max_millis: u64,
    max_nodes: Option<u64>,
}

/// The entry's function name, upper-cased: the last segment of
/// `whiteboard-wasm::spatial_edges::edge_route_layout` names
/// `EDGE_ROUTE_LAYOUT`.
fn const_name(key: &str) -> Result<String, String> {
    let last = key.rsplit("::").next().unwrap_or_default();
    let ok = last.starts_with(|c: char| c.is_ascii_lowercase())
        && last.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
    if ok {
        Ok(last.to_ascii_uppercase())
    } else {
        Err(format!("{key}: its last segment is not a lowercase identifier"))
    }
}

fn resolve<'a>(key: &'a str, caps: &Caps) -> Result<Resolved<'a>, String> {
    let need = |cap: &str, value: Option<u64>| value.ok_or(format!("{key}: declares no {cap}"));
    Ok(Resolved {
        key,
        name: const_name(key)?,
        max_bytes: need("maxBytes", caps.max_bytes)?,
        max_depth: need("maxDepth", caps.max_depth)?,
        max_millis: need("maxMillis", caps.max_millis)?,
        max_nodes: caps.max_nodes,
    })
}

/// A Rust integer literal clippy pedantic accepts: digits grouped by three
/// from the right once there are five or more.
pub(super) fn rust_int(n: u64) -> String {
    let digits = n.to_string();
    if digits.len() < 5 {
        return digits;
    }
    let chars: Vec<char> = digits.chars().collect();
    let mut groups: Vec<String> = chars.rchunks(3).map(|c| c.iter().collect()).collect();
    groups.reverse();
    groups.join("_")
}

fn ts(entries: &[Resolved<'_>]) -> String {
    let mut out = header(LEDGER_PATH);
    out.push_str("\n/**\n * Why an untrusted-input entry refused its input:\n");
    for (code, meaning) in REFUSAL_CODES {
        let _ = writeln!(out, " * - `{code}`: {meaning}.");
    }
    let codes: Vec<String> = REFUSAL_CODES.iter().map(|(code, _)| format!("'{code}'")).collect();
    let _ = writeln!(out, " */\nexport type RefusalCode = {}", codes.join(" | "));
    for e in entries {
        let _ = write!(
            out,
            "\n/** The caps of `{}`. */\nexport const {}_CAPS = Object.freeze({{\n  maxBytes: {},\n  maxDepth: {},\n  maxMillis: {},\n",
            e.key, e.name, e.max_bytes, e.max_depth, e.max_millis
        );
        if let Some(nodes) = e.max_nodes {
            let _ = writeln!(out, "  maxNodes: {nodes},");
        }
        out.push_str("} as const)\n");
    }
    out
}

const RUST_PRELUDE: &str = "
//! The caps `crates/input-caps.json` declares for this crate's untrusted-input
//! entries (QR-28b): the same numbers the TypeScript half refuses by.

/// What an untrusted-input entry will read, nest and spend.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InputCaps {
    /// The most bytes of input the entry reads.
    pub max_bytes: usize,
    /// The deepest the input nests.
    pub max_depth: usize,
    /// The longest the entry may run, in milliseconds.
    pub max_millis: u64,
    /// The most nodes the entry builds, where its input length does not bound them.
    pub max_nodes: Option<usize>,
}
";

fn rust(entries: &[Resolved<'_>]) -> String {
    let mut out = header(LEDGER_PATH);
    out.push_str(RUST_PRELUDE);
    for e in entries {
        let nodes = e.max_nodes.map_or("None".to_owned(), |n| format!("Some({})", rust_int(n)));
        let _ = write!(
            out,
            "\n/// The caps of `{}`.\npub const {}: InputCaps = InputCaps {{ max_bytes: {}, max_depth: {}, max_millis: {}, max_nodes: {nodes} }};\n",
            e.key,
            e.name,
            rust_int(e.max_bytes),
            rust_int(e.max_depth),
            rust_int(e.max_millis),
        );
    }
    out
}

/// Every caps output, as `(repo-relative path, content, is the Rust half)`,
/// the Rust half not yet formatted.
pub(super) fn generate(
    entries: &BTreeMap<String, Caps>,
) -> Result<Vec<(String, String, bool)>, Vec<String>> {
    let mut files = Vec::new();
    let mut v = Vec::new();
    for target in TARGETS {
        let mut resolved = Vec::new();
        for (key, caps) in entries {
            if caps.template || caps.krate.as_deref() != Some(target.krate) {
                continue;
            }
            match resolve(key, caps) {
                Ok(entry) => resolved.push(entry),
                Err(e) => v.push(format!("{LEDGER_PATH}: {e}")),
            }
        }
        match within_width(ts(&resolved)) {
            Ok(text) => files.push((target.ts.to_owned(), text, false)),
            Err(long) => v.extend(long.into_iter().map(|e| format!("{}: {e}", target.ts))),
        }
        files.push((target.rust.to_owned(), rust(&resolved), true));
    }
    if v.is_empty() { Ok(files) } else { Err(v) }
}
