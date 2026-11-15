//! `FontTableMeasurer` and `ConstantRatioMeasure` against the recorded answers
//! of the Node measurer (opentype.js over the vendored Roboto) and of
//! `constantRatioMeasureText` (`font-measure.jsonl`).
//!
//! Every double is compared by its IEEE bits, marks and joiners included: the
//! Node measurer sums each code point's own advance without GSUB, as this port
//! does. The font bytes are read here, not in the crate.

use serde::Deserialize;
use whiteboard_canvas_render::constant_ratio::ConstantRatioMeasure;
use whiteboard_canvas_render::font_measure::{FontError, FontTableMeasurer};
use whiteboard_canvas_render::measure::{FontDescriptor, FontStyle, Measure, TextMetrics};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

const REGULAR: &[u8] =
    include_bytes!("../../../../packages/mcp-server/assets/fonts/Roboto/Roboto-Regular.ttf");
const BOLD: &[u8] =
    include_bytes!("../../../../packages/mcp-server/assets/fonts/Roboto/Roboto-Bold.ttf");
const ITALIC: &[u8] =
    include_bytes!("../../../../packages/mcp-server/assets/fonts/Roboto/Roboto-Italic.ttf");
const BOLD_ITALIC: &[u8] =
    include_bytes!("../../../../packages/mcp-server/assets/fonts/Roboto/Roboto-BoldItalic.ttf");

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Font {
    family: String,
    fallback_chain: Vec<String>,
    weight: f64,
    style: String,
    size_px: String,
}

#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
enum Measurer {
    Font,
    ConstantRatio,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Record {
    id: String,
    measurer: Measurer,
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

fn roboto() -> Result<FontTableMeasurer<'static>, FontError> {
    FontTableMeasurer::new()
        .with_face("Roboto", false, FontStyle::Normal, REGULAR)?
        .with_face("Roboto", true, FontStyle::Normal, BOLD)?
        .with_face("Roboto", false, FontStyle::Italic, ITALIC)?
        .with_face("Roboto", true, FontStyle::Italic, BOLD_ITALIC)
}

fn same(got: f64, recorded: &str) -> Result<bool, String> {
    Ok(got.to_bits() == bits(recorded)?.to_bits())
}

/// The first field that differs.
fn differs(record: &Record, measure: &dyn Measure) -> Result<Option<&'static str>, String> {
    let font = font_of(&record.font)?;
    let got: TextMetrics = measure.measure(&record.text, &font);
    let fields = [
        ("advanceWidth", got.advance_width, &record.advance_width),
        ("ascent", got.ascent, &record.ascent),
        ("descent", got.descent, &record.descent),
        ("lineGap", got.line_gap, &record.line_gap),
    ];
    for (name, value, recorded) in fields {
        if !same(value, recorded)? {
            return Ok(Some(name));
        }
    }
    Ok(None)
}

#[test]
fn every_recorded_answer_is_reproduced() {
    let text =
        include_str!("../../../../packages/mcp-server/src/server/export/oracle/font-measure.jsonl");
    let Ok(font_measure) = roboto() else { panic!("the vendored faces do not parse") };
    let mut counts = [0_usize; 2];
    let mut failures = Vec::new();
    for line in text.lines() {
        let record: Record = serde_json::from_str(line).unwrap_or_else(|e| panic!("{e}: {line}"));
        let measure: &dyn Measure = match record.measurer {
            Measurer::Font => &font_measure,
            Measurer::ConstantRatio => &ConstantRatioMeasure,
        };
        if let Some(slot) = counts.get_mut(usize::from(record.measurer == Measurer::ConstantRatio))
        {
            *slot += 1;
        }
        match differs(&record, measure) {
            Ok(None) => {}
            Ok(Some(field)) => failures.push(format!("{} differs in {field}", record.id)),
            Err(e) => failures.push(format!("{}: {e}", record.id)),
        }
    }
    assert!(failures.is_empty(), "{} records differ; first: {}", failures.len(), failures[0]);
    assert!(counts[0] >= 554 && counts[1] >= 986, "the recording holds {counts:?} by measurer");
}
