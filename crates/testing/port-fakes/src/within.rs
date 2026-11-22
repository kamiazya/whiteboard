//! A test's guard against a lost wake: a hang is a failure, not a stuck run.

/// How long `block_on` may take in a test before a wake is called lost.
#[cfg(not(target_arch = "wasm32"))]
const DEADLINE: std::time::Duration = std::time::Duration::from_secs(10);

/// Runs `work` on its own thread and fails the test when it has not finished by
/// the deadline. `block_on` parks until a wake arrives, so a defect that loses
/// the wake would otherwise hang the test binary instead of failing the test.
/// wasm32 has no thread to spawn and runs `work` in place.
pub(crate) fn within<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
    #[cfg(target_arch = "wasm32")]
    {
        work()
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let (done, finished) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = done.send(work());
        });
        finished.recv_timeout(DEADLINE).expect("the work did not finish: a wake was lost")
    }
}
