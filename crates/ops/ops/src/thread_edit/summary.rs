//! The line a watching person reads for a batch (`summarizeThreadOps`): each
//! word the batch earned, in the order `COMMENT_SUMMARY_WORDS` lists them,
//! with its count.

use super::ThreadOp;

const WORDS: [&str; 4] = ["commented", "replied", "resolved", "reopened"];

/// The word an op earns; a resolve closes unless it says `resolved: false`.
const fn word_of(op: &ThreadOp) -> usize {
    match op {
        ThreadOp::Add { .. } => 0,
        ThreadOp::Reply { .. } => 1,
        ThreadOp::Resolve { resolved: Some(false), .. } => 3,
        ThreadOp::Resolve { .. } => 2,
    }
}

pub(super) fn of(ops: &[ThreadOp]) -> String {
    let mut counts = [0_usize; WORDS.len()];
    for op in ops {
        if let Some(count) = counts.get_mut(word_of(op)) {
            *count = count.saturating_add(1);
        }
    }
    let said: Vec<String> = WORDS
        .iter()
        .zip(counts)
        .filter(|(_, count)| *count > 0)
        .map(|(word, count)| format!("{word} {count}"))
        .collect();
    said.join(", ")
}
