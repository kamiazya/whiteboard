//! The smallest native binary built with the release profile a shipped
//! native binary uses (`dist-native`), so the release gates — the hardening
//! check, the reproducibility check, the embedded dependency list and the
//! third-party notices — run against a real artifact before the daemon
//! exists. It goes when `whiteboard-daemon` takes its place in those gates.

use std::io::Write;
use std::process::ExitCode;

fn main() -> ExitCode {
    match writeln!(std::io::stdout().lock(), "whiteboard-native-fixture") {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => ExitCode::FAILURE,
    }
}
