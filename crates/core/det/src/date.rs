//! `Date.prototype.toISOString`, which a stored timestamp is read back through.

/// A time value no JavaScript `Date` holds, which `toISOString` refuses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidTime;

/// The ECMAScript time range: 100,000,000 days either side of the epoch.
const MAX_TIME_MS: f64 = 8.64e15;

/// `new Date(ms).toISOString()`: the time value truncated toward zero, years
/// outside 0..=9999 as a signed six digit year, and a refusal for what
/// `TimeClip` turns into an invalid date (a non-finite value or one past
/// [`MAX_TIME_MS`] either way).
pub fn iso_string(ms: f64) -> Result<String, InvalidTime> {
    if !ms.is_finite() || ms.abs() > MAX_TIME_MS {
        return Err(InvalidTime);
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
    use whiteboard_proptest::proptest::prelude::{
        Strategy, prop_assert, prop_assert_eq, prop_oneof,
    };
    use whiteboard_proptest::proptest::test_runner::TestCaseError;
    use whiteboard_proptest::{Floor, check};

    /// Each pair is a time value and what `new Date(ms).toISOString()` answered
    /// for it under Node.
    const VECTORS: &[(f64, &str)] = &[
        (0.0, "1970-01-01T00:00:00.000Z"),
        (1.0, "1970-01-01T00:00:00.001Z"),
        (-1.0, "1969-12-31T23:59:59.999Z"),
        (999.0, "1970-01-01T00:00:00.999Z"),
        (1000.0, "1970-01-01T00:00:01.000Z"),
        (-999.0, "1969-12-31T23:59:59.001Z"),
        (-1000.0, "1969-12-31T23:59:59.000Z"),
        (86_399_999.0, "1970-01-01T23:59:59.999Z"),
        (-86_400_000.0, "1969-12-31T00:00:00.000Z"),
        (-86_400_001.0, "1969-12-30T23:59:59.999Z"),
        (951_782_400_000.0, "2000-02-29T00:00:00.000Z"),
        (951_868_800_000.0, "2000-03-01T00:00:00.000Z"),
        (4_107_542_400_000.0, "2100-03-01T00:00:00.000Z"),
        (-2_208_988_800_000.0, "1900-01-01T00:00:00.000Z"),
        (1_700_000_000_123.0, "2023-11-14T22:13:20.123Z"),
        (32_503_680_000_000.0, "3000-01-01T00:00:00.000Z"),
        (253_402_300_799_999.0, "9999-12-31T23:59:59.999Z"),
        (253_402_300_800_000.0, "+010000-01-01T00:00:00.000Z"),
        (-62_135_596_800_000.0, "0001-01-01T00:00:00.000Z"),
        (-62_167_219_200_000.0, "0000-01-01T00:00:00.000Z"),
        (-62_167_219_200_001.0, "-000001-12-31T23:59:59.999Z"),
        (-62_198_755_200_000.0, "-000001-01-01T00:00:00.000Z"),
        (-62_198_755_200_001.0, "-000002-12-31T23:59:59.999Z"),
        (8.64e15, "+275760-09-13T00:00:00.000Z"),
        (8.64e15 - 1.0, "+275760-09-12T23:59:59.999Z"),
        (-8.64e15, "-271821-04-20T00:00:00.000Z"),
        (-8.64e15 + 1.0, "-271821-04-20T00:00:00.001Z"),
    ];

    /// The fractions JavaScript's `ToIntegerOrInfinity` drops toward zero, so a
    /// negative one lands on the millisecond above it, not below.
    const TRUNCATED: &[(f64, &str)] = &[
        (0.5, "1970-01-01T00:00:00.000Z"),
        (-0.5, "1970-01-01T00:00:00.000Z"),
        (1.9, "1970-01-01T00:00:00.001Z"),
        (-1.5, "1969-12-31T23:59:59.999Z"),
        (-1.9, "1969-12-31T23:59:59.999Z"),
    ];

    #[test]
    fn a_time_is_written_as_the_date_object_writes_it() {
        for (ms, expected) in VECTORS.iter().chain(TRUNCATED) {
            assert_eq!(iso_string(*ms).as_deref(), Ok(*expected), "{ms}");
        }
    }

    #[test]
    fn a_time_outside_the_date_range_is_refused() {
        for ms in [8.64e15 + 1.0, -8.64e15 - 1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 1e300]
        {
            assert_eq!(iso_string(ms), Err(InvalidTime), "{ms}");
        }
    }

    /// The calendar's own rule, written independently of the formatter: day
    /// counts that follow one another name dates that follow one another.
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

    /// Times across the whole range and, densely, across years 0..=9999, where
    /// the year is four digits and the other branch of the year rule runs.
    fn any_time() -> impl Strategy<Value = f64> {
        prop_oneof![-8.64e15_f64..=8.64e15, -62_167_219_200_000.0_f64..=253_402_300_799_999.0]
    }

    #[test]
    fn any_time_in_range_is_well_formed_and_truncates_toward_zero() {
        let four_digit_year = Floor::new("a year of four digits");
        let wide_year = Floor::new("a year outside 0..=9999");
        check(any_time(), None, |ms| {
            let Ok(text) = iso_string(ms) else {
                return Err(TestCaseError::fail(format!("refused {ms}")));
            };
            let signed = text.starts_with(['+', '-']);
            four_digit_year.draw(!signed);
            wide_year.draw(signed);
            prop_assert_eq!(iso_string(ms.trunc()), Ok(text.clone()));
            let Some((date, time)) = text.split_once('T') else {
                return Err(TestCaseError::fail(format!("no time in {text}")));
            };
            prop_assert_eq!(date.len(), if signed { 13 } else { 10 }, "{}", text);
            prop_assert_eq!(time.len(), "hh:mm:ss.sssZ".len());
            prop_assert!(text.ends_with('Z'));
            Ok(())
        });
        four_digit_year.assert(20);
        wide_year.assert(20);
    }

    #[test]
    fn a_whole_millisecond_is_refused_exactly_past_the_range() {
        let refused = Floor::new("a time past the range");
        let whole = (-1e16_f64..=1e16).prop_map(f64::trunc);
        check(whole, None, |ms| {
            refused.draw(ms.abs() > 8.64e15);
            prop_assert_eq!(iso_string(ms).is_err(), ms.abs() > 8.64e15);
            Ok(())
        });
        refused.assert(5);
    }
}
