//! The folding and tokenizing against the recorded answers of the TypeScript.
//!
//! `packages/search/src/oracle/search.jsonl` is that recording, frozen: the
//! TypeScript that wrote it is deleted. This replays what this crate ports: `foldForSearch`,
//! `findFolded` and the two tokenizers, text by text, and the three tables
//! over every code point those are built from. The TypeScript's Unicode
//! tables are its runtime's (17.0); the crates' are their own, so a code point
//! the two answer differently is in `unicode_table_diff.json`, held from both
//! sides: a difference not in it fails, and so does an entry that no longer
//! differs. A text holding a ledgered code point is replayed but may differ.

use serde_json::Value as Json;
use support::{Tally, ledger, ranges_json, ranges_of, replay, strings, table_diffs};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_search::{find_folded, fold_for_search, tokenize, tokenize_for_index};

/// The recording's readers: not tests, so the core lints on `expect` apply to
/// them unless they sit in test code.
#[cfg(test)]
mod support {
    use serde_json::Value as Json;
    use std::collections::{BTreeMap, BTreeSet};
    use whiteboard_search::fold::fold_code_point;
    use whiteboard_search::unicode::{is_mark, is_word};

    const RECORDING: &str = include_str!("../../../../packages/search/src/oracle/search.jsonl");
    const LEDGER: &str = include_str!("unicode_table_diff.json");

    pub(crate) fn ledger() -> Json {
        serde_json::from_str(LEDGER).expect("the ledger")
    }

    pub(crate) fn records(kind: &str) -> Vec<Json> {
        RECORDING
            .lines()
            .map(|line| serde_json::from_str::<Json>(line).expect("a recorded line"))
            .filter(|record| record["kind"] == kind)
            .collect()
    }

    pub(crate) fn scalar_values() -> impl Iterator<Item = char> {
        (0..=0x0010_ffff_u32).filter_map(char::from_u32)
    }

    pub(crate) fn ranges_of(value: &Json) -> BTreeSet<u32> {
        let mut set = BTreeSet::new();
        for range in value.as_array().expect("ranges") {
            let from = u32::try_from(range[0].as_u64().expect("from")).expect("a code point");
            let to = u32::try_from(range[1].as_u64().expect("to")).expect("a code point");
            set.extend(from..=to);
        }
        set
    }

    pub(crate) fn ranges_json(set: &BTreeSet<u32>) -> String {
        let mut out: Vec<(u32, u32)> = Vec::new();
        for &cp in set {
            match out.last_mut() {
                Some((_, to)) if *to + 1 == cp => *to = cp,
                _ => out.push((cp, cp)),
            }
        }
        let parts: Vec<String> = out.iter().map(|(a, b)| format!("[{a},{b}]")).collect();
        format!("[{}]", parts.join(","))
    }

    /// The code points the recorded table and the crates' table disagree on.
    pub(crate) fn table_diffs() -> [(&'static str, BTreeSet<u32>); 3] {
        let fold = &records("fold-table")[0];
        let mut recorded_fold: BTreeMap<u32, (String, bool)> = BTreeMap::default();
        for entry in fold["entries"].as_array().expect("entries") {
            let cp = u32::try_from(entry[0].as_u64().expect("cp")).expect("a code point");
            recorded_fold.insert(
                cp,
                (entry[1].as_str().expect("out").to_owned(), entry[2].as_bool().expect("latin")),
            );
        }
        let word = ranges_of(&records("word-table")[0]["ranges"]);
        let mark = ranges_of(&records("mark-table")[0]["ranges"]);
        let (mut fold_diff, mut word_diff, mut mark_diff) =
            (BTreeSet::new(), BTreeSet::new(), BTreeSet::new());
        for c in scalar_values() {
            let cp = u32::from(c);
            let own = fold_code_point(c);
            let identity = (c.to_string(), false);
            let theirs = recorded_fold.get(&cp).cloned().unwrap_or(identity);
            if own != theirs {
                fold_diff.insert(cp);
            }
            if is_word(c) != word.contains(&cp) {
                word_diff.insert(cp);
            }
            if is_mark(c) != mark.contains(&cp) {
                mark_diff.insert(cp);
            }
        }
        [("fold", fold_diff), ("word", word_diff), ("mark", mark_diff)]
    }

    /// What a replay of one kind of record did, pinned so a change in either side
    /// of the generator or the ported code shows as a count.
    #[derive(Default, Debug, PartialEq, Eq)]
    pub(crate) struct Tally {
        pub(crate) replayed: usize,
        /// An input holding an unpaired surrogate, which a `&str` cannot hold.
        pub(crate) ill_formed: usize,
        /// An answer that differs, from a text holding a ledgered code point.
        pub(crate) tolerated: usize,
    }

    pub(crate) fn ledgered_code_points() -> BTreeSet<u32> {
        let ledger = ledger();
        ["fold", "word", "mark"]
            .iter()
            .flat_map(|table| ranges_of(&ledger[table]["ranges"]))
            .collect()
    }

    pub(crate) fn text_of(value: &Json) -> Option<&str> {
        value.as_str()
    }

    pub(crate) fn holds_ledgered(ledgered: &BTreeSet<u32>, texts: &[&str]) -> bool {
        texts.iter().any(|text| text.chars().any(|c| ledgered.contains(&u32::from(c))))
    }

    /// Replays `kind`: `inputs` names the fields that are the question,
    /// `answer` computes this crate's answer as the record writes it.
    pub(crate) fn replay(
        kind: &str,
        inputs: &[&str],
        answer: impl Fn(&[&str]) -> Json,
        answer_field: &[&str],
    ) -> Tally {
        let ledgered = ledgered_code_points();
        let mut tally = Tally::default();
        for record in records(kind) {
            let Some(questions) =
                inputs.iter().map(|name| text_of(&record[*name])).collect::<Option<Vec<_>>>()
            else {
                tally.ill_formed += 1;
                continue;
            };
            let got = answer(&questions);
            let recorded: Vec<&Json> = answer_field.iter().map(|name| &record[*name]).collect();
            let got = got.as_array().expect("an answer per field");
            let same = got.iter().zip(&recorded).all(|(a, b)| a == *b);
            if !same {
                assert!(
                    holds_ledgered(&ledgered, &questions),
                    "{kind} {questions:?}: got {got:?}, recorded {recorded:?}"
                );
                tally.tolerated += 1;
            }
            tally.replayed += 1;
        }
        tally
    }

    pub(crate) fn strings(tokens: Vec<String>) -> Json {
        Json::from(tokens)
    }
}

#[test]
fn the_tables_differ_from_the_typescripts_at_exactly_the_ledgered_code_points() {
    let ledger = ledger();
    for (table, diff) in table_diffs() {
        let ledgered = ranges_of(&ledger[table]["ranges"]);
        assert_eq!(
            ranges_json(&diff),
            ranges_json(&ledgered),
            "{table}: the code points the tables differ at, against the ledger"
        );
        assert_eq!(
            u64::try_from(diff.len()).expect("a count"),
            ledger[table]["count"].as_u64().expect("count"),
            "{table}: the pinned count"
        );
    }
}

#[test]
fn every_recorded_fold_is_answered_as_the_typescript_answered() {
    let tally =
        replay("fold", &["in"], |q| Json::from(vec![Json::from(fold_for_search(q[0]))]), &["out"]);
    assert_eq!(tally, Tally { replayed: 3200, ill_formed: 300, tolerated: 1 });
}

#[test]
fn every_recorded_find_is_answered_as_the_typescript_answered() {
    let tally = replay(
        "find",
        &["text", "needle"],
        |q| {
            let at =
                find_folded(q[0], q[1]).map_or(Json::Null, |f| Json::from(vec![f.index, f.length]));
            Json::from(vec![at])
        },
        &["at"],
    );
    assert_eq!(tally, Tally { replayed: 2131, ill_formed: 369, tolerated: 0 });
}

#[test]
fn every_recorded_tokenization_is_answered_as_the_typescript_answered() {
    let tally = replay(
        "tokens",
        &["in"],
        |q| Json::from(vec![strings(tokenize(q[0])), strings(tokenize_for_index(q[0]))]),
        &["query", "index"],
    );
    assert_eq!(tally, Tally { replayed: 3241, ill_formed: 259, tolerated: 8 });
}
