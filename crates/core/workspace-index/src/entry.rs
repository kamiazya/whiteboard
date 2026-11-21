//! The entry a port answers for a found document.

/// What a tree-backed index found about one document.
#[derive(Debug, Clone, PartialEq)]
pub struct Found {
    pub document_id: String,
    pub path: String,
    pub kind: Option<String>,
    pub name: Option<String>,
    pub shadowed: Option<bool>,
    pub created_at: Option<f64>,
    pub updated_at: Option<f64>,
    pub content_digest: String,
}

/// The entry a port answers; absent fields stay absent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentEntry {
    pub document_id: String,
    pub path: String,
    pub kind: Option<String>,
    pub name: Option<String>,
    pub shadowed: Option<bool>,
    pub updated_at: Option<String>,
    pub content_digest: String,
}

/// A timestamp no JavaScript `Date` holds, which `toISOString` refuses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryError {
    InvalidTime,
}

/// The ECMAScript time range: 100,000,000 days either side of the epoch.
const MAX_TIME_MS: f64 = 8.64e15;

/// `entryOf`. A create and a content write stamp `updatedAt`; a rename or a
/// move does not, so the stamp falls back to `createdAt` for a record written
/// before timestamps landed, and is absent for one that predates both.
pub fn entry_of(found: &Found) -> Result<DocumentEntry, EntryError> {
    let updated_at = match found.updated_at.or(found.created_at) {
        Some(stamp) => Some(iso_string(stamp)?),
        None => None,
    };
    Ok(DocumentEntry {
        document_id: found.document_id.clone(),
        path: found.path.clone(),
        kind: found.kind.clone(),
        name: found.name.clone(),
        shadowed: found.shadowed,
        updated_at,
        content_digest: found.content_digest.clone(),
    })
}

/// `new Date(ms).toISOString()`: the time value truncated toward zero, years
/// outside 0..=9999 as a signed six digit year.
fn iso_string(ms: f64) -> Result<String, EntryError> {
    if !ms.is_finite() || ms.abs() > MAX_TIME_MS {
        return Err(EntryError::InvalidTime);
    }
    #[expect(clippy::cast_possible_truncation, reason = "bounded by MAX_TIME_MS, which i64 holds")]
    let ms = ms.trunc() as i64;
    let days = ms.div_euclid(86_400_000);
    let of_day = ms.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    let (hour, minute) = (of_day.div_euclid(3_600_000), of_day.div_euclid(60_000).rem_euclid(60));
    let (second, milli) = (of_day.div_euclid(1000).rem_euclid(60), of_day.rem_euclid(1000));
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{}{:06}", if year < 0 { '-' } else { '+' }, year.unsigned_abs())
    };
    Ok(format!("{year}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{milli:03}Z"))
}

/// The proleptic Gregorian date of a day count from 1970-01-01.
#[expect(
    clippy::arithmetic_side_effects,
    reason = "days is within +-1e8, so every intermediate fits i64 by orders of magnitude"
)]
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn a_time_is_written_as_the_date_object_writes_it() {
        assert_eq!(iso_string(0.0).as_deref(), Ok("1970-01-01T00:00:00.000Z"));
        assert_eq!(iso_string(1_700_000_000_123.0).as_deref(), Ok("2023-11-14T22:13:20.123Z"));
        assert_eq!(iso_string(-1.0).as_deref(), Ok("1969-12-31T23:59:59.999Z"));
        assert_eq!(iso_string(8.64e15).as_deref(), Ok("+275760-09-13T00:00:00.000Z"));
        assert_eq!(iso_string(-8.64e15).as_deref(), Ok("-271821-04-20T00:00:00.000Z"));
        assert_eq!(iso_string(951_782_400_000.0).as_deref(), Ok("2000-02-29T00:00:00.000Z"));
    }

    /// The calendar's own rule, written independently of the port: day counts
    /// that follow one another name dates that follow one another.
    fn days_in_month(year: i64, month: i64) -> i64 {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        match month {
            2 if leap => 29,
            2 => 28,
            4 | 6 | 9 | 11 => 30,
            _ => 31,
        }
    }

    #[test]
    fn consecutive_days_are_consecutive_dates_across_centuries() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        let mut previous = civil_from_days(-300_000);
        for days in -299_999..=300_000 {
            let (year, month, day) = previous;
            let expected = if day < days_in_month(year, month) {
                (year, month, day + 1)
            } else if month < 12 {
                (year, month + 1, 1)
            } else {
                (year + 1, 1, 1)
            };
            let next = civil_from_days(days);
            assert_eq!(next, expected, "day {days}");
            previous = next;
        }
    }

    #[test]
    fn a_time_outside_the_date_range_is_refused() {
        assert_eq!(iso_string(8.64e15 + 1.0), Err(EntryError::InvalidTime));
        assert_eq!(iso_string(f64::NAN), Err(EntryError::InvalidTime));
    }

    #[test]
    fn the_stamp_falls_back_to_created_at_and_may_be_absent() {
        let mut found = Found {
            document_id: "d".to_owned(),
            path: "a".to_owned(),
            kind: None,
            name: None,
            shadowed: None,
            created_at: Some(0.0),
            updated_at: None,
            content_digest: "x".to_owned(),
        };
        assert_eq!(
            entry_of(&found).map(|entry| entry.updated_at),
            Ok(Some("1970-01-01T00:00:00.000Z".to_owned()))
        );
        found.created_at = None;
        assert_eq!(entry_of(&found).map(|entry| entry.updated_at), Ok(None));
    }
}
