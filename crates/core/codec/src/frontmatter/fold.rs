//! `yaml` 2.9's `foldFlowLines`: breaking a long scalar at spaces so no line
//! passes 80 columns. Every width and index is a UTF-16 code unit, because
//! that is what the original counts.

pub(super) type Units = Vec<u16>;

const LINE_WIDTH: isize = 80;
const MIN_CONTENT_WIDTH: isize = 20;
const NEWLINE: u16 = b'\n' as u16;
const SPACE: u16 = b' ' as u16;
const TAB: u16 = b'\t' as u16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Mode {
    Flow,
    Block,
}

/// Folded text, and whether a line was left longer than the width.
pub(super) struct Folded {
    pub(super) text: Units,
    pub(super) overflowed: bool,
}

fn signed(n: usize) -> isize {
    isize::try_from(n).unwrap_or(isize::MAX)
}

/// The unit at `i`, or 0 outside the text (0 never occurs in text this folds:
/// a NUL forces a double-quoted scalar, which is not folded).
fn at(text: &[u16], i: isize) -> u16 {
    usize::try_from(i).ok().and_then(|i| text.get(i)).copied().unwrap_or(0)
}

fn is_blank(unit: u16) -> bool {
    matches!(unit, SPACE | NEWLINE | TAB)
}

/// Where the scan has got to: the column the line must be broken by, the last
/// space it may be broken at, and the breaks chosen so far.
struct Scan {
    end: isize,
    end_step: isize,
    split: Option<isize>,
    previous: u16,
    overflowed: bool,
    folds: Vec<isize>,
}

impl Scan {
    fn new(indent: isize, end_step: isize, indent_at_start: Option<usize>) -> Scan {
        let mut scan = Scan {
            end: LINE_WIDTH.saturating_sub(indent),
            end_step,
            split: None,
            previous: 0,
            overflowed: false,
            folds: Vec::new(),
        };
        if let Some(start) = indent_at_start.map(signed) {
            if start > LINE_WIDTH.saturating_sub(2.max(MIN_CONTENT_WIDTH)) {
                scan.folds.push(0);
            } else {
                scan.end = LINE_WIDTH.saturating_sub(start);
            }
        }
        scan
    }

    /// Reads the unit at `i`, remembering a space that may be broken at and
    /// breaking once the line has run past its width.
    fn step(&mut self, text: &[u16], i: isize, unit: u16) {
        if unit == SPACE && self.previous != 0 && !is_blank(self.previous) {
            let next = at(text, i.saturating_add(1));
            if next != 0 && !is_blank(next) {
                self.split = Some(i);
            }
        }
        if i >= self.end {
            match self.split.filter(|&s| s != 0) {
                Some(s) => {
                    self.folds.push(s);
                    self.end = s.saturating_add(self.end_step);
                    self.split = None;
                }
                None => self.overflowed = true,
            }
        }
    }
}

pub(super) fn fold(
    text: &[u16],
    indent: usize,
    mode: Mode,
    indent_at_start: Option<usize>,
) -> Folded {
    let indent = signed(indent);
    let end_step = MIN_CONTENT_WIDTH
        .saturating_add(1)
        .max(LINE_WIDTH.saturating_sub(indent).saturating_add(1));
    if signed(text.len()) <= end_step {
        return Folded { text: text.to_vec(), overflowed: false };
    }
    let mut scan = Scan::new(indent, end_step, indent_at_start);
    let mut i = -1isize;
    if mode == Mode::Block {
        i = more_indented_end(text, i, indent);
        if i != -1 {
            scan.end = i.saturating_add(end_step);
        }
    }
    loop {
        i = i.saturating_add(1);
        let unit = at(text, i);
        if unit == 0 {
            break;
        }
        if unit == NEWLINE {
            if mode == Mode::Block {
                i = more_indented_end(text, i, indent);
            }
            scan.end = i.saturating_add(indent).saturating_add(end_step);
            scan.split = None;
        } else {
            scan.step(text, i, unit);
        }
        scan.previous = unit;
    }
    Folded { text: apply(text, &scan.folds, indent), overflowed: scan.overflowed }
}

/// The text cut at each fold: a newline and the indent replace the space.
fn apply(text: &[u16], folds: &[isize], indent: isize) -> Units {
    let Some(&first) = folds.first() else { return text.to_vec() };
    let slice = |from: isize, to: isize| -> &[u16] {
        let from = usize::try_from(from).unwrap_or(0);
        let to = usize::try_from(to).unwrap_or(0).min(text.len());
        text.get(from..to).unwrap_or_default()
    };
    let indent_units = || std::iter::repeat_n(SPACE, usize::try_from(indent).unwrap_or(0));
    let mut result: Units = slice(0, first).to_vec();
    for (index, &fold) in folds.iter().enumerate() {
        let end = folds
            .get(index.saturating_add(1))
            .copied()
            .filter(|&f| f != 0)
            .unwrap_or(signed(text.len()));
        if fold == 0 {
            result = std::iter::once(NEWLINE)
                .chain(indent_units())
                .chain(slice(0, end).iter().copied())
                .collect();
        } else {
            result.push(NEWLINE);
            result.extend(indent_units());
            result.extend_from_slice(slice(fold.saturating_add(1), end));
        }
    }
    result
}

/// With `i + 1` at the start of a line: the index of the last newline of the
/// run of lines indented more than `indent`.
fn more_indented_end(text: &[u16], mut i: isize, indent: isize) -> isize {
    let mut end = i;
    let mut start = i.saturating_add(1);
    let mut unit = at(text, start);
    while unit == SPACE || unit == TAB {
        if i < start.saturating_add(indent) {
            i = i.saturating_add(1);
            unit = at(text, i);
        } else {
            loop {
                i = i.saturating_add(1);
                unit = at(text, i);
                if unit == 0 || unit == NEWLINE {
                    break;
                }
            }
            end = i;
            start = i.saturating_add(1);
            unit = at(text, start);
        }
    }
    end
}
