//! The typesetter against the recorded TypeScript answers.
//!
//! `packages/canvas-render/src/oracle/typeset.jsonl` holds, per input, the model
//! tree, the width and theme, what the host answered, and what
//! `typesetMdastBlocks` laid out: the scene as text with every double as its
//! IEEE bits (or, for the big sets, its length and FNV digest) and how many
//! times it asked the measurer. Every record must be reproduced exactly; the
//! recording's test fails when the TypeScript stops answering as recorded.

mod typeset_support;

use typeset_support::dump::dump_scene;
use typeset_support::record::{Counting, Record};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_canvas_render::theme::markdown::MarkdownTheme;
use whiteboard_canvas_render::typeset::{TypesetOptions, typeset_mdast_blocks};

fn fnv(text: &str) -> u32 {
    text.encode_utf16()
        .fold(0x811c_9dc5_u32, |state, unit| (state ^ u32::from(unit)).wrapping_mul(16_777_619))
}

/// The record laid out by the port: the scene as text and the measurer's calls.
fn lay_out(record: &Record) -> Result<(String, usize), String> {
    let bits = u64::from_str_radix(&record.width, 16).map_err(|e| format!("a width: {e}"))?;
    let theme = match record.theme.as_str() {
        "node" => MarkdownTheme::node(),
        "document" => MarkdownTheme::document(),
        _ => MarkdownTheme::compact(),
    };
    let measure = Counting::default();
    let syntax = record.syntax.as_ref().map(typeset_support::record::syntax_of);
    let options = TypesetOptions {
        text_fill: record.fill.as_deref(),
        highlight: Some(&record.seams),
        syntax: syntax.as_ref(),
        math: Some(&record.seams),
        diagram: Some(&record.seams),
        ..TypesetOptions::new(&measure, f64::from_bits(bits), "sans-serif", &theme, &record.seams)
    };
    let root = typeset_support::model::root(&record.root)?;
    let scene = typeset_mdast_blocks(&root, &options).map_err(|e| format!("unsupported {e:?}"))?;
    if let Some(miss) = record.seams.misses().first() {
        return Err(format!("the recording holds no {miss}"));
    }
    Ok((dump_scene(&scene)?, measure.calls()))
}

/// How the text differs from what was recorded, or `Ok`.
fn compare_text(record: &Record, text: &str) -> Result<(), String> {
    if record.digest {
        let held = (record.n, record.h);
        let got = (Some(text.encode_utf16().count()), Some(fnv(text)));
        return if held == got {
            Ok(())
        } else {
            Err(format!("held {held:?}, got {got:?}\n{text}"))
        };
    }
    let want = record.scene.as_deref().unwrap_or_default();
    if text == want {
        return Ok(());
    }
    let at = text.chars().zip(want.chars()).take_while(|(a, b)| a == b).count();
    let from = at.saturating_sub(60);
    let tail = |s: &str| s.chars().skip(from).take(160).collect::<String>();
    Err(format!("differs at {at}\n got {}\nwant {}", tail(text), tail(want)))
}

/// What differs for one record, or nothing.
fn replay(record: &Record) -> Option<String> {
    let compared = lay_out(record).and_then(|(text, calls)| {
        if calls != record.calls {
            return Err(format!("measured {calls} times, recorded {}", record.calls));
        }
        compare_text(record, &text)
    });
    compared.err().map(|error| format!("{}: {error}", record.id))
}

#[test]
fn every_recorded_input_is_laid_out_as_the_typescript_laid_it_out() {
    let text = include_str!("../../../../packages/canvas-render/src/oracle/typeset.jsonl");
    let records: Vec<Record> = text
        .lines()
        .skip(1)
        .map(|line| serde_json::from_str(line).unwrap_or_else(|e| panic!("a record: {e}")))
        .collect();
    assert!(records.len() > 2800, "the recording holds {} records", records.len());
    let failures: Vec<String> = records.iter().filter_map(replay).collect();
    assert!(
        failures.is_empty(),
        "{} of {} records differ; first:\n{}",
        failures.len(),
        records.len(),
        failures.first().map_or("", String::as_str)
    );
}
