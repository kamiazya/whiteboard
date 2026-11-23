//! Time is a port: core never reads a clock.

use whiteboard_det::date::iso_string;

use crate::PortError;

/// The wall clock, synchronous because reading it waits for nothing.
pub trait Clock {
    /// Milliseconds since the epoch, as JavaScript's `Date.now()` counts them.
    /// An `f64` so a fractional value and a time past 2^53 survive the wasm
    /// boundary the way a JS number does.
    fn now_ms(&self) -> f64;

    /// The time as `new Date(now).toISOString()` writes it, refused when the
    /// clock reads a time no `Date` holds. A write checks this before it
    /// writes, since what it stamps is read back through `toISOString`.
    fn now_iso(&self) -> Result<String, PortError> {
        Ok(iso_string(self.now_ms())?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    struct At(f64);

    impl Clock for At {
        fn now_ms(&self) -> f64 {
            self.0
        }
    }

    #[test]
    fn the_clock_reads_as_the_date_object_writes_it() {
        assert_eq!(At(0.0).now_iso().as_deref(), Ok("1970-01-01T00:00:00.000Z"));
        assert_eq!(At(1_700_000_000_123.0).now_iso().as_deref(), Ok("2023-11-14T22:13:20.123Z"));
        assert_eq!(At(-1.0).now_iso().as_deref(), Ok("1969-12-31T23:59:59.999Z"));
        assert_eq!(At(8.64e15).now_iso().as_deref(), Ok("+275760-09-13T00:00:00.000Z"));
    }

    #[test]
    fn a_time_no_date_holds_is_the_invalid_time_error() {
        for ms in [8.64e15 + 1.0, f64::NAN, f64::INFINITY] {
            assert_eq!(At(ms).now_iso(), Err(PortError::InvalidTime), "{ms}");
        }
    }
}
