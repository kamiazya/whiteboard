//! The workspace's one proptest prelude (QR-14b, QR-14d, QR-14e), the Rust
//! side of `packages/model/src/test-utils/fast-check.ts`.
//!
//! Every property goes through [`check`], so three things hold everywhere:
//!
//! - **The case budget is one number.** [`DEFAULT_CASES`] equals fast-check's
//!   `numRuns: 200`; a property that needs another budget passes it to
//!   [`check`], and a measurement belongs beside that argument. A
//!   `ProptestConfig` built anywhere else is refused by arch-lint's
//!   `rust-proptest-prelude.test.ts`.
//! - **No seed is pinned.** The runner's seed is [`RngSeed::Random`] whatever
//!   `PROPTEST_RNG_SEED` says, so a property cannot be held green by one lucky
//!   seed. A failure is pinned the other way: proptest writes the shrunk case
//!   beside the property, as `<file>.proptest-regressions`, which is
//!   committed and replayed first on every later run.
//! - **A property says what it reached.** [`Floor`] counts the draws a
//!   property classifies as the case it is about, and [`Floor::assert`] fails
//!   when fewer than the floor arrived, because a generator that never reaches
//!   the interesting case passes exactly like one that does.

use std::fmt::Debug;
use std::panic::Location;
use std::sync::atomic::{AtomicU32, Ordering};

pub use proptest;
use proptest::strategy::Strategy;
#[cfg(not(any(test, target_arch = "wasm32")))]
use proptest::test_runner::FileFailurePersistence;
use proptest::test_runner::{Config, RngSeed, TestCaseError, TestRunner};

/// fast-check's default `numRuns`, so a property costs the same on both sides.
pub const DEFAULT_CASES: u32 = 200;

/// The runner configuration every property uses, for `cases` cases.
#[must_use]
pub fn config(cases: u32, source_file: &'static str) -> Config {
    let mut config = Config { cases, source_file: Some(source_file), ..Config::default() };
    // Assigned rather than written into the literal above: cargo-mutants
    // 27.1.0 deletes a field from a struct expression whatever `exclude_re`
    // says, and neither of these is observable from a passing test. The seed
    // restates proptest's default so that PROPTEST_RNG_SEED cannot pin it,
    // and a test cannot set that variable (`set_var` is unsafe in edition
    // 2024, and the workspace forbids unsafe).
    config.rng_seed = RngSeed::Random;
    // wasm32 under Node has no filesystem to keep a regression in; the native
    // run of the same property is the one that writes it. This crate's own
    // tests fail on purpose and must not leave one behind.
    #[cfg(any(test, target_arch = "wasm32"))]
    {
        config.failure_persistence = None;
    }
    // Beside the property's own file, wherever that is: proptest's default
    // looks for the crate's `src/lib.rs` above the file, which a property
    // under `tests/` does not have, and warns before falling back to this.
    #[cfg(not(any(test, target_arch = "wasm32")))]
    {
        config.failure_persistence =
            Some(Box::new(FileFailurePersistence::WithSource("proptest-regressions")));
    }
    config
}

/// Runs `test` against `cases` draws of `strategy` (`None` is
/// [`DEFAULT_CASES`]) and panics with the shrunk counterexample on failure.
///
/// # Panics
///
/// When a draw fails `test`, or when the runner rejects too many draws.
#[track_caller]
pub fn check<S>(
    strategy: S,
    cases: Option<u32>,
    test: impl Fn(S::Value) -> Result<(), TestCaseError>,
) where
    S: Strategy,
    S::Value: Debug,
{
    let source = Location::caller().file();
    let mut runner = TestRunner::new(config(cases.unwrap_or(DEFAULT_CASES), source));
    if let Err(failure) = runner.run(&strategy, test) {
        #[expect(
            clippy::panic,
            reason = "a property fails its test the way every test fails, by panicking"
        )]
        {
            panic!("{failure}");
        }
    }
}

/// A reachability floor: how many draws were the interesting case.
#[derive(Debug)]
pub struct Floor {
    what: &'static str,
    reached: AtomicU32,
    drawn: AtomicU32,
}

impl Floor {
    /// A floor counting draws that are `what`.
    #[must_use]
    pub const fn new(what: &'static str) -> Self {
        Self { what, reached: AtomicU32::new(0), drawn: AtomicU32::new(0) }
    }

    /// Records one draw, and whether it was the interesting case.
    pub fn draw(&self, interesting: bool) {
        self.drawn.fetch_add(1, Ordering::Relaxed);
        if interesting {
            self.reached.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// The draws recorded so far, and how many were the interesting case.
    #[must_use]
    pub fn counts(&self) -> (u32, u32) {
        (self.reached.load(Ordering::Relaxed), self.drawn.load(Ordering::Relaxed))
    }

    /// Fails unless at least `min` draws were the interesting case.
    ///
    /// Shrinking re-runs the test on smaller inputs, so the counts include
    /// those runs; that only matters on a run that has already failed.
    ///
    /// # Panics
    ///
    /// When fewer than `min` draws reached it.
    #[track_caller]
    pub fn assert(&self, min: u32) {
        let (reached, drawn) = self.counts();
        assert!(
            reached >= min,
            "{reached} of {drawn} draws were {}, under the floor of {min}: the generator is too \
             sparse for the property to mean anything; make its domain denser, not its runs more",
            self.what,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::{DEFAULT_CASES, Floor, check, config};
    use proptest::prelude::{TestCaseError, any};
    use proptest::test_runner::RngSeed;

    #[test]
    fn the_budget_is_fast_checks_and_the_seed_is_never_fixed() {
        let c = config(DEFAULT_CASES, file!());
        assert_eq!(c.cases, 200);
        assert!(matches!(c.rng_seed, RngSeed::Random));
        assert_eq!(c.source_file, Some(file!()));
        // This crate's own failing properties leave no regression behind.
        assert!(c.failure_persistence.is_none());
    }

    #[test]
    fn a_floor_fails_under_its_minimum_and_passes_at_it() {
        let floor = Floor::new("even");
        check(any::<u8>(), Some(64), |n| {
            floor.draw(n % 2 == 0);
            Ok(())
        });
        let (reached, drawn) = floor.counts();
        assert_eq!(drawn, 64);
        floor.assert(reached);
        assert!(std::panic::catch_unwind(|| floor.assert(reached + 1)).is_err());
    }

    #[test]
    fn a_failing_property_panics() {
        let failed = std::panic::catch_unwind(|| {
            check(any::<u8>(), Some(16), |_| Err(TestCaseError::fail("planted")));
        });
        assert!(failed.is_err());
    }
}
