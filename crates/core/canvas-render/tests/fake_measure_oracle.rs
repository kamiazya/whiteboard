//! `FakeMeasure` against the recorded answers of the TypeScript's
//! `createFakeMeasure`: every double is compared by its IEEE bits, so a
//! last-bit difference in the order of a multiplication, a `-0`, or a NaN's
//! payload is a failure (`fake-measure.jsonl`).

use serde::Deserialize;
use whiteboard_canvas_render::fake_measure::FakeMeasure;
use whiteboard_canvas_render::measure::{FontDescriptor, FontStyle, Measure};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Font {
    family: String,
    fallback_chain: Vec<String>,
    weight: f64,
    style: String,
    size_px: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Record {
    id: String,
    factor: String,
    text: String,
    font: Font,
    advance_width: String,
    ascent: String,
    descent: String,
    line_gap: String,
}

fn bits(hex: &str) -> Result<f64, String> {
    u64::from_str_radix(hex, 16).map(f64::from_bits).map_err(|e| format!("{hex}: {e}"))
}

fn font_of(wire: &Font) -> Result<FontDescriptor, String> {
    let style = match wire.style.as_str() {
        "normal" => FontStyle::Normal,
        "italic" => FontStyle::Italic,
        other => return Err(format!("unknown style {other}")),
    };
    Ok(FontDescriptor {
        family: wire.family.clone(),
        fallback_chain: wire.fallback_chain.clone(),
        weight: wire.weight,
        style,
        size_px: bits(&wire.size_px)?,
    })
}

/// The id of the first field that differs, or `None`.
fn differs(record: &Record) -> Result<Option<&'static str>, String> {
    let measure = FakeMeasure::new(bits(&record.factor)?);
    let font = font_of(&record.font)?;
    let got = measure.measure(&record.text, &font);
    let fields = [
        ("advanceWidth", got.advance_width, &record.advance_width),
        ("ascent", got.ascent, &record.ascent),
        ("descent", got.descent, &record.descent),
        ("lineGap", got.line_gap, &record.line_gap),
    ];
    for (name, value, recorded) in fields {
        if value.to_bits() != bits(recorded)?.to_bits() {
            return Ok(Some(name));
        }
    }
    Ok(None)
}

#[test]
fn every_recorded_answer_is_reproduced_to_the_last_bit() {
    let text = include_str!("../../../../packages/canvas-render/src/oracle/fake-measure.jsonl");
    let mut count = 0_usize;
    let mut failures = Vec::new();
    for line in text.lines() {
        let record: Record = serde_json::from_str(line).unwrap_or_else(|e| panic!("{e}: {line}"));
        match differs(&record) {
            Ok(None) => {}
            Ok(Some(field)) => failures.push(format!("{} differs in {field}", record.id)),
            Err(e) => failures.push(format!("{}: {e}", record.id)),
        }
        count += 1;
    }
    assert!(count >= 488, "the recording holds {count} records");
    assert!(failures.is_empty(), "{} records differ; first: {}", failures.len(), failures[0]);
}
