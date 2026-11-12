//! The in-house sfnt reader on fonts built here byte by byte, well formed and
//! not: what it reads, which `cmap` subtable it chooses, and that a malformed
//! font is an error and never a panic.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_canvas_render::sfnt::{MAX_BYTES, Sfnt, SfntError};
use whiteboard_proptest::proptest::prelude::{Strategy, any, prop, prop_assert, prop_oneof};
use whiteboard_proptest::{Floor, check};

type Table = ([u8; 4], Vec<u8>);

fn be16(v: u16) -> [u8; 2] {
    v.to_be_bytes()
}

fn be32(v: u32) -> [u8; 4] {
    v.to_be_bytes()
}

/// The directory and the tables, in the order given.
fn font(tables: &[Table]) -> Vec<u8> {
    let count = u16::try_from(tables.len()).unwrap_or(0);
    let mut out = Vec::new();
    out.extend(be32(0x0001_0000));
    out.extend(be16(count));
    out.extend([0_u8; 6]);
    let mut offset = 12 + 16 * tables.len();
    for (tag, bytes) in tables {
        out.extend(tag);
        out.extend(be32(0));
        out.extend(be32(u32::try_from(offset).unwrap_or(0)));
        out.extend(be32(u32::try_from(bytes.len()).unwrap_or(0)));
        offset += bytes.len();
    }
    for (_, bytes) in tables {
        out.extend(bytes);
    }
    out
}

fn head(units_per_em: u16) -> Table {
    let mut b = vec![0_u8; 54];
    b[18..20].copy_from_slice(&be16(units_per_em));
    (*b"head", b)
}

fn hhea(ascender: i16, descender: i16, line_gap: i16, metrics: u16) -> Table {
    let mut b = vec![0_u8; 36];
    b[4..6].copy_from_slice(&ascender.to_be_bytes());
    b[6..8].copy_from_slice(&descender.to_be_bytes());
    b[8..10].copy_from_slice(&line_gap.to_be_bytes());
    b[34..36].copy_from_slice(&be16(metrics));
    (*b"hhea", b)
}

fn maxp(glyphs: u16) -> Table {
    let mut b = vec![0_u8; 6];
    b[4..6].copy_from_slice(&be16(glyphs));
    (*b"maxp", b)
}

fn hmtx(advances: &[u16]) -> Table {
    let b = advances.iter().flat_map(|a| [be16(*a), [0, 0]].concat()).collect();
    (*b"hmtx", b)
}

/// A format 12 subtable of `(start, end, first glyph)` groups.
fn format_12(groups: &[(u32, u32, u32)]) -> Vec<u8> {
    let mut b = Vec::new();
    b.extend(be16(12));
    b.extend(be16(0));
    b.extend(be32(0));
    b.extend(be32(0));
    b.extend(be32(u32::try_from(groups.len()).unwrap_or(0)));
    for (s, e, g) in groups {
        b.extend([be32(*s), be32(*e), be32(*g)].concat());
    }
    b
}

/// A format 4 subtable of `(start, end, delta, range offset)` segments and a
/// glyph id array; the caller ends the list with the 0xFFFF terminator.
fn format_4(segments: &[(u16, u16, u16, u16)], glyph_ids: &[u16]) -> Vec<u8> {
    let n = segments.len();
    let mut b = Vec::new();
    b.extend(be16(4));
    b.extend(be16(0));
    b.extend(be16(0));
    b.extend(be16(u16::try_from(n * 2).unwrap_or(0)));
    b.extend([0_u8; 6]);
    for s in segments {
        b.extend(be16(s.1));
    }
    b.extend(be16(0));
    for s in segments {
        b.extend(be16(s.0));
    }
    for s in segments {
        b.extend(be16(s.2));
    }
    for s in segments {
        b.extend(be16(s.3));
    }
    for g in glyph_ids {
        b.extend(be16(*g));
    }
    b
}

/// A `cmap` of `(platform, encoding, subtable)` records.
fn cmap(subtables: &[(u16, u16, Vec<u8>)]) -> Table {
    let mut b = Vec::new();
    b.extend(be16(0));
    b.extend(be16(u16::try_from(subtables.len()).unwrap_or(0)));
    let mut offset = 4 + 8 * subtables.len();
    for (p, e, sub) in subtables {
        b.extend(be16(*p));
        b.extend(be16(*e));
        b.extend(be32(u32::try_from(offset).unwrap_or(0)));
        offset += sub.len();
    }
    for (_, _, sub) in subtables {
        b.extend(sub);
    }
    (*b"cmap", b)
}

fn valid() -> Vec<Table> {
    vec![
        head(2048),
        hhea(1900, -500, 7, 3),
        maxp(5),
        hmtx(&[600, 1000, 1200]),
        cmap(&[(3, 10, format_12(&[(0x41, 0x43, 1), (0x1f600, 0x1f601, 3)]))]),
    ]
}

fn with(tables: &[Table], replace: Table) -> Vec<Table> {
    let mut out: Vec<Table> = tables.iter().filter(|t| t.0 != replace.0).cloned().collect();
    out.push(replace);
    out
}

fn without(tables: &[Table], tag: [u8; 4]) -> Vec<Table> {
    tables.iter().filter(|t| t.0 != tag).cloned().collect()
}

fn parse(tables: &[Table]) -> Result<(), SfntError> {
    Sfnt::parse(&font(tables)).map(|_| ())
}

#[test]
fn a_well_formed_font_answers_its_tables() {
    let bytes = font(&valid());
    let Ok(f) = Sfnt::parse(&bytes) else { panic!("a well-formed font parses") };
    assert_eq!(f.units_per_em(), 2048);
    assert_eq!(f.hhea(), (1900, -500, 7));
    assert_eq!(f.glyph_index('A'), 1);
    assert_eq!(f.glyph_index('C'), 3);
    assert_eq!(f.glyph_index('D'), 0);
    assert_eq!(f.glyph_index('@'), 0);
    assert_eq!(f.glyph_index('\u{1f601}'), 4);
}

#[test]
fn an_advance_repeats_the_last_metric_and_a_glyph_past_the_count_is_notdef() {
    let bytes = font(&valid());
    let Ok(f) = Sfnt::parse(&bytes) else { panic!("a well-formed font parses") };
    assert_eq!([f.advance(0), f.advance(1), f.advance(2)], [600, 1000, 1200]);
    assert_eq!([f.advance(3), f.advance(4)], [1200, 1200]);
    assert_eq!(f.advance(5), 600);
    assert_eq!(f.advance(u32::MAX), 600);
}

#[test]
fn more_metrics_than_glyphs_reads_only_the_glyphs() {
    let tables = with(&valid(), hhea(1900, -500, 0, 9));
    let tables = with(&tables, maxp(2));
    let bytes = font(&tables);
    let Ok(f) = Sfnt::parse(&bytes) else { panic!("parses") };
    assert_eq!([f.advance(0), f.advance(1), f.advance(2)], [600, 1000, 600]);
    let short = with(&tables, hmtx(&[600]));
    assert_eq!(parse(&short), Err(SfntError::Truncated(*b"hmtx")));
}

#[test]
fn the_last_accepted_cmap_record_wins_and_an_unaccepted_one_is_skipped() {
    let bmp = format_4(&[(0x41, 0x41, 0xffff, 0), (0xffff, 0xffff, 1, 0)], &[]);
    let wide = format_12(&[(0x41, 0x41, 9)]);
    let two = cmap(&[(3, 1, bmp.clone()), (3, 10, wide.clone())]);
    let reversed = cmap(&[(3, 10, wide.clone()), (3, 1, bmp.clone())]);
    let skipped = cmap(&[(3, 1, bmp), (3, 2, format_12(&[(0x41, 0x41, 7)]))]);
    for (table, want) in
        [(two, 9), (reversed, 0x41_u32.wrapping_add(0xffff) & 0xffff), (skipped, 64)]
    {
        let bytes = font(&with(&valid(), table));
        let Ok(f) = Sfnt::parse(&bytes) else { panic!("parses") };
        assert_eq!(f.glyph_index('A'), want);
    }
}

#[test]
fn a_format_4_subtable_maps_by_delta_and_by_range_offset() {
    // Segment 0 maps 0x41..=0x42 by delta; segment 1 maps 0x50..=0x51 through
    // the glyph id array, whose second entry is 0 (no glyph); the terminator
    // is skipped, as opentype.js skips it.
    let segments = [(0x41, 0x42, 0xfff0, 0), (0x50, 0x51, 5, 4), (0xffff, 0xffff, 1, 0)];
    let sub = format_4(&segments, &[7, 0]);
    let bytes = font(&with(&valid(), cmap(&[(3, 1, sub)])));
    let Ok(f) = Sfnt::parse(&bytes) else { panic!("parses") };
    assert_eq!(f.glyph_index('A'), 0x41_u32.wrapping_add(0xfff0) & 0xffff);
    assert_eq!(f.glyph_index('B'), 0x42_u32.wrapping_add(0xfff0) & 0xffff);
    assert_eq!(f.glyph_index('P'), 12);
    assert_eq!(f.glyph_index('Q'), 0);
    assert_eq!(f.glyph_index('C'), 0);
    assert_eq!(f.glyph_index('\u{ffff}'), 0);
    assert_eq!(f.glyph_index('\u{1f600}'), 0);
}

#[test]
fn bytes_that_are_not_an_outline_font_are_refused() {
    assert_eq!(Sfnt::parse(&[]).err(), Some(SfntError::BadMagic));
    assert_eq!(Sfnt::parse(b"ttcf\0\x01\0\0").err(), Some(SfntError::BadMagic));
    let mut collection = font(&valid());
    collection[..4].copy_from_slice(b"ttcf");
    assert_eq!(Sfnt::parse(&collection).err(), Some(SfntError::BadMagic));
    assert_eq!(Sfnt::parse(&[0, 1, 0, 0]).err(), Some(SfntError::Truncated(*b"sfnt")));
}

#[test]
fn an_absent_table_is_named() {
    for tag in [b"head", b"hhea", b"maxp", b"hmtx", b"cmap"] {
        assert_eq!(parse(&without(&valid(), *tag)), Err(SfntError::MissingTable(*tag)));
    }
}

#[test]
fn a_zero_count_is_refused() {
    assert_eq!(parse(&with(&valid(), head(0))), Err(SfntError::ZeroCount));
    assert_eq!(parse(&with(&valid(), maxp(0))), Err(SfntError::ZeroCount));
    assert_eq!(parse(&with(&valid(), hhea(1, -1, 0, 0))), Err(SfntError::ZeroCount));
}

#[test]
fn a_truncated_table_is_refused_at_every_length() {
    let whole = font(&valid());
    let mut refused = 0;
    for len in 0..whole.len() {
        if Sfnt::parse(&whole[..len]).is_err() {
            refused += 1;
        }
    }
    assert!(refused > whole.len() - 8, "{refused} of {} truncations refused", whole.len());
    for (tag, cut) in [(*b"head", 10), (*b"hhea", 20), (*b"maxp", 3)] {
        let table = valid().into_iter().find(|t| t.0 == tag).map(|t| (t.0, t.1[..cut].to_vec()));
        let Some(table) = table else { panic!("table") };
        assert_eq!(parse(&with(&valid(), table)), Err(SfntError::Truncated(tag)), "{tag:?}");
    }
}

#[test]
fn an_offset_or_length_past_the_file_is_refused_or_clamped() {
    let mut bytes = font(&valid());
    // The head record's offset (bytes 20..24) pointing past the end.
    let at = 12 + 8;
    bytes[at..at + 4].copy_from_slice(&be32(u32::MAX));
    assert!(Sfnt::parse(&bytes).is_err());
    let mut long = font(&valid());
    long[12 + 12..12 + 16].copy_from_slice(&be32(u32::MAX));
    assert!(Sfnt::parse(&long).is_ok(), "a length past the end is clamped to the file");
}

#[test]
fn huge_counts_are_refused_without_reading_or_allocating_them() {
    let mut many = font(&without(&valid(), *b"cmap"));
    many[4..6].copy_from_slice(&be16(u16::MAX));
    assert_eq!(Sfnt::parse(&many).err(), Some(SfntError::Truncated(*b"sfnt")));
    let mut groups = format_12(&[(0x41, 0x41, 1)]);
    groups[12..16].copy_from_slice(&be32(u32::MAX));
    assert_eq!(parse(&with(&valid(), cmap(&[(3, 10, groups)]))), Err(SfntError::BadCmap));
    let mut segments = format_4(&[(0x41, 0x41, 0, 0), (0xffff, 0xffff, 1, 0)], &[]);
    segments[6..8].copy_from_slice(&be16(0xfffe));
    assert_eq!(parse(&with(&valid(), cmap(&[(3, 1, segments)]))), Err(SfntError::BadCmap));
    let mut records = cmap(&[(3, 10, format_12(&[]))]);
    records.1[2..4].copy_from_slice(&be16(u16::MAX));
    assert_eq!(parse(&with(&valid(), records)), Err(SfntError::BadCmap));
}

#[test]
fn a_cmap_that_cannot_be_read_is_refused() {
    let ok = format_12(&[(0x41, 0x41, 1)]);
    let none = Table::from((*b"cmap", [be16(0), be16(0)].concat()));
    assert_eq!(parse(&with(&valid(), none)), Err(SfntError::BadCmap));
    let wrong_version = Table::from((*b"cmap", [be16(1), be16(0)].concat()));
    assert_eq!(parse(&with(&valid(), wrong_version)), Err(SfntError::BadCmap));
    let unaccepted = cmap(&[(2, 1, ok.clone())]);
    assert_eq!(parse(&with(&valid(), unaccepted)), Err(SfntError::BadCmap));
    let mut offset = cmap(&[(3, 10, ok.clone())]);
    offset.1[8..12].copy_from_slice(&be32(u32::MAX));
    assert_eq!(parse(&with(&valid(), offset)), Err(SfntError::BadCmap));
    let mut zero_format = ok.clone();
    zero_format[..2].copy_from_slice(&be16(0));
    let table = cmap(&[(1, 0, zero_format)]);
    assert_eq!(parse(&with(&valid(), table)), Err(SfntError::UnsupportedCmapFormat(0)));
    let tiny = cmap(&[(3, 10, vec![0])]);
    assert_eq!(parse(&with(&valid(), tiny)), Err(SfntError::BadCmap));
}

#[test]
fn unsorted_overlapping_or_inverted_ranges_are_refused() {
    let wide = |g: &[(u32, u32, u32)]| parse(&with(&valid(), cmap(&[(3, 10, format_12(g))])));
    assert_eq!(wide(&[(0x50, 0x60, 1), (0x41, 0x43, 4)]), Err(SfntError::BadCmap));
    assert_eq!(wide(&[(0x41, 0x50, 1), (0x50, 0x60, 4)]), Err(SfntError::BadCmap));
    assert_eq!(wide(&[(0x50, 0x41, 1)]), Err(SfntError::BadCmap));
    assert_eq!(wide(&[]), Ok(()));
    let narrow =
        |s: &[(u16, u16, u16, u16)]| parse(&with(&valid(), cmap(&[(3, 1, format_4(s, &[]))])));
    let end = (0xffff, 0xffff, 1, 0);
    assert_eq!(narrow(&[(0x50, 0x60, 0, 0), (0x41, 0x43, 0, 0), end]), Err(SfntError::BadCmap));
    assert_eq!(narrow(&[(0x41, 0x50, 0, 0), (0x50, 0x60, 0, 0), end]), Err(SfntError::BadCmap));
    assert_eq!(narrow(&[(0x41, 0x43, 0, 0), (0x50, 0x60, 0, 0), end]), Ok(()));
    assert_eq!(narrow(&[(0x41, 0x50, 0, 0), (0x45, 0x50, 0, 0), end]), Err(SfntError::BadCmap));
    assert_eq!(narrow(&[(0x41, 0x43, 0, 0), (0x44, 0x44, 0, 0), end]), Ok(()));
    assert_eq!(narrow(&[(0x41, 0x43, 0, 0), (0x43, 0x50, 0, 0), end]), Err(SfntError::BadCmap));
    assert_eq!(narrow(&[(0x41, 0x43, 0, 0), (0x60, 0x50, 0, 0), end]), Ok(()));
}

#[test]
fn a_font_over_the_size_cap_is_refused_before_it_is_read() {
    let mut at_cap = font(&valid());
    at_cap.resize(MAX_BYTES, 0);
    assert!(Sfnt::parse(&at_cap).is_ok(), "a font of exactly the cap is read");
    at_cap.push(0);
    assert_eq!(Sfnt::parse(&at_cap).err(), Some(SfntError::TooLarge));
}

#[test]
fn the_cap_is_the_one_the_input_registry_declares() {
    let registry: serde_json::Value =
        serde_json::from_str(include_str!("../../../input-caps.json"))
            .unwrap_or(serde_json::Value::Null);
    let declared =
        registry["entries"]["whiteboard-canvas-render::sfnt::Sfnt::parse"]["maxBytes"].as_u64();
    assert_eq!(declared, u64::try_from(MAX_BYTES).ok());
}

#[test]
fn only_the_platform_and_encoding_pairs_opentype_reads_are_read() {
    let wide = format_12(&[(0x41, 0x41, 1)]);
    let reads = |platform, encoding| {
        parse(&with(&valid(), cmap(&[(platform, encoding, wide.clone())]))).is_ok()
    };
    for (platform, encoding) in
        [(3, 0), (3, 1), (3, 10), (0, 0), (0, 1), (0, 2), (0, 3), (0, 4), (0, 6), (1, 0)]
    {
        assert!(reads(platform, encoding), "({platform}, {encoding}) is read");
    }
    for (platform, encoding) in [(3, 2), (3, 3), (3, 11), (0, 5), (0, 7), (1, 1), (2, 0), (4, 0)] {
        assert!(!reads(platform, encoding), "({platform}, {encoding}) is not read");
    }
}

fn mutated() -> impl Strategy<Value = Vec<u8>> {
    let seed = font(&valid());
    let flips = prop::collection::vec((0..seed.len(), any::<u8>()), 0..6);
    (flips, prop::option::of(0..seed.len())).prop_map(move |(flips, cut)| {
        let mut bytes = seed.clone();
        for (at, value) in flips {
            bytes[at] = value;
        }
        if let Some(len) = cut {
            bytes.truncate(len);
        }
        bytes
    })
}

fn arbitrary() -> impl Strategy<Value = Vec<u8>> {
    prop_oneof![
        3 => mutated(),
        1 => prop::collection::vec(any::<u8>(), 0..400),
    ]
}

#[test]
fn any_bytes_parse_to_an_answer_or_an_error_and_every_lookup_on_one_is_total() {
    let parsed = Floor::new("a mutated font that still parses");
    let refused = Floor::new("a mutated font that is refused");
    check(arbitrary(), None, |bytes| {
        let Ok(f) = Sfnt::parse(&bytes) else {
            parsed.draw(false);
            refused.draw(true);
            return Ok(());
        };
        parsed.draw(true);
        refused.draw(false);
        for ch in ['\0', 'A', 'z', '\u{ffff}', '\u{10000}', '\u{1f600}', '\u{10ffff}'] {
            let glyph = f.glyph_index(ch);
            prop_assert!(f.glyph_index(ch) == glyph, "a lookup answers the same twice");
            let _ = f.advance(glyph);
        }
        for glyph in [0, 1, 4, 5, 0xffff, u32::MAX] {
            let _ = f.advance(glyph);
        }
        let _ = (f.units_per_em(), f.hhea());
        Ok(())
    });
    parsed.assert(30);
    refused.assert(30);
}
