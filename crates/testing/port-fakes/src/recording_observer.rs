use std::future::{Future, ready};
use std::sync::{Mutex, MutexGuard, PoisonError};

use whiteboard_ports::{DocumentWritten, MaybeSend, WriteObserver};

/// A write observer that keeps every document it was told of, in order, for
/// a test to read back.
#[derive(Debug, Default)]
pub struct RecordingObserver {
    told: Mutex<Vec<DocumentWritten>>,
}

impl RecordingObserver {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Every write told so far, leaving none behind.
    #[must_use]
    pub fn take(&self) -> Vec<DocumentWritten> {
        std::mem::take(&mut *self.locked())
    }

    /// A poisoned list is still a consistent one: a push cannot panic part way.
    fn locked(&self) -> MutexGuard<'_, Vec<DocumentWritten>> {
        self.told.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl WriteObserver for RecordingObserver {
    fn document_written(&self, written: &DocumentWritten) -> impl Future<Output = ()> + MaybeSend {
        self.locked().push(written.clone());
        ready(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::block_on;

    #[test]
    fn it_keeps_what_it_was_told_until_taken() {
        let observer = RecordingObserver::new();
        let written = |path: &str| DocumentWritten {
            workspace_id: "w".into(),
            document_id: "d".into(),
            path: path.into(),
        };
        block_on(observer.document_written(&written("a")));
        block_on(observer.document_written(&written("b")));
        assert_eq!(observer.take(), vec![written("a"), written("b")]);
        assert!(observer.take().is_empty());
    }
}
