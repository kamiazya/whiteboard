use std::sync::{Mutex, MutexGuard, PoisonError};

use whiteboard_ports::{ClientNotifier, RestoreProgress};

/// A notifier that keeps every restore event it was told, in order, for a
/// test to read back; a page that was told something answers nothing.
#[derive(Debug, Default)]
pub struct RecordingNotifier {
    told: Mutex<Vec<RestoreProgress>>,
}

impl RecordingNotifier {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Every event told so far, leaving none behind, so a test reads what one
    /// call told.
    #[must_use]
    pub fn take(&self) -> Vec<RestoreProgress> {
        std::mem::take(&mut *self.locked())
    }

    /// A poisoned list is still a consistent one: a push cannot panic part way.
    fn locked(&self) -> MutexGuard<'_, Vec<RestoreProgress>> {
        self.told.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl ClientNotifier for RecordingNotifier {
    fn restore_progress(&self, event: &RestoreProgress) {
        self.locked().push(event.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use whiteboard_ports::RestorePhase;

    fn event(path: &str, phase: RestorePhase) -> RestoreProgress {
        RestoreProgress { workspace_id: "w".into(), path: path.into(), phase, label: None }
    }

    #[test]
    fn it_keeps_what_it_was_told_until_taken() {
        let notifier = RecordingNotifier::new();
        notifier.restore_progress(&event("a", RestorePhase::Started));
        notifier.restore_progress(&event("a", RestorePhase::Complete));
        assert_eq!(
            notifier.take(),
            vec![event("a", RestorePhase::Started), event("a", RestorePhase::Complete)]
        );
        assert!(notifier.take().is_empty());
    }
}
