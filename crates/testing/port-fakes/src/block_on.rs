use std::future::Future;
use std::pin::pin;
use std::sync::Arc;
use std::task::{Context, Poll, Wake, Waker};
use std::thread::{self, Thread};

struct Unpark(Thread);

impl Wake for Unpark {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }
}

/// Drives `future` to completion on the calling thread, parking between polls.
///
/// std only, so a test needs no executor crate: the waker unparks the thread
/// the future is being polled from. A wake that arrives before the park is not
/// lost, since an unpark leaves a token the next park consumes.
pub fn block_on<F: Future>(future: F) -> F::Output {
    let mut future = pin!(future);
    let waker = Waker::from(Arc::new(Unpark(thread::current())));
    let mut cx = Context::from_waker(&waker);
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut cx) {
            return value;
        }
        thread::park();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::within::within;
    use std::task::Poll;

    /// Pending until polled `n` more times, waking itself each time.
    struct Spin(u32);

    impl Future for Spin {
        type Output = &'static str;

        fn poll(mut self: std::pin::Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
            if self.0 == 0 {
                return Poll::Ready("done");
            }
            self.0 -= 1;
            cx.waker().wake_by_ref();
            Poll::Pending
        }
    }

    #[test]
    fn a_ready_future_returns_its_value() {
        assert_eq!(block_on(std::future::ready(7)), 7);
    }

    #[test]
    fn a_future_that_wakes_itself_is_polled_until_ready() {
        assert_eq!(within(|| block_on(Spin(5))), "done");
        let nested = within(|| block_on(async { Spin(2).await.len() + Spin(1).await.len() }));
        assert_eq!(nested, 8);
    }

    #[test]
    #[cfg(not(target_arch = "wasm32"))]
    fn a_wake_from_another_thread_ends_the_wait() {
        use std::sync::Mutex;

        struct Shared {
            done: bool,
            waker: Option<Waker>,
        }
        struct Gate(Arc<Mutex<Shared>>);
        impl Future for Gate {
            type Output = u8;
            fn poll(self: std::pin::Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<u8> {
                let mut shared = self.0.lock().unwrap();
                if shared.done {
                    return Poll::Ready(42);
                }
                shared.waker = Some(cx.waker().clone());
                Poll::Pending
            }
        }

        let shared = Arc::new(Mutex::new(Shared { done: false, waker: None }));
        let opener = Arc::clone(&shared);
        let handle = thread::spawn(move || {
            loop {
                let mut shared = opener.lock().unwrap();
                if let Some(waker) = shared.waker.take() {
                    shared.done = true;
                    drop(shared);
                    waker.wake();
                    return;
                }
            }
        });
        assert_eq!(within(move || block_on(Gate(shared))), 42);
        handle.join().unwrap();
    }
}
