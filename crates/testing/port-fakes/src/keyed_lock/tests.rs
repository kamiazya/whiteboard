use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Wake, Waker};

use whiteboard_ports::WorkspaceLock;
use whiteboard_proptest::proptest::prelude::{Strategy, any, prop, prop_assert, prop_assert_eq};
use whiteboard_proptest::{Floor, check};

use super::{Acquire, KeyedGuard, KeyedLock};
use crate::block_on;
use crate::within::within;

#[derive(Default)]
struct Wakes(AtomicUsize);

impl Wake for Wakes {
    fn wake(self: Arc<Self>) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

/// Polls `future` once with a waker that counts its wakes.
fn poll_once<F: std::future::Future + Unpin>(future: &mut F) -> (Poll<F::Output>, Arc<Wakes>) {
    let counter = Arc::new(Wakes::default());
    let waker = Waker::from(Arc::clone(&counter));
    let polled = Pin::new(future).poll(&mut Context::from_waker(&waker));
    (polled, counter)
}

fn granted(acquire: &mut Acquire) -> KeyedGuard {
    match poll_once(acquire).0 {
        Poll::Ready(guard) => guard,
        Poll::Pending => unreachable!("expected the lock to be granted"),
    }
}

fn waiting(acquire: &mut Acquire) -> Arc<Wakes> {
    let (polled, wakes) = poll_once(acquire);
    assert!(polled.is_pending(), "expected to wait");
    wakes
}

fn woken(wakes: &Arc<Wakes>) -> usize {
    wakes.0.load(Ordering::SeqCst)
}

#[test]
fn an_unheld_key_is_granted_at_once() {
    let lock = KeyedLock::new();
    assert_eq!(lock.pending_keys(), 0);
    let mut a = lock.acquire("k");
    assert_eq!(lock.pending_keys(), 1);
    let _guard = granted(&mut a);
    assert_eq!(lock.pending_keys(), 1);
}

#[test]
fn a_second_caller_for_a_held_key_waits_until_the_guard_drops() {
    let lock = KeyedLock::new();
    let mut first = lock.acquire("k");
    let mut second = lock.acquire("k");
    let guard = granted(&mut first);
    let wakes = waiting(&mut second);
    assert_eq!(woken(&wakes), 0);

    drop(guard);
    assert_eq!(woken(&wakes), 1);
    let _next = granted(&mut second);
}

#[test]
fn a_different_key_never_waits_for_a_held_one() {
    let lock = KeyedLock::new();
    let mut held = lock.acquire("held");
    let _guard = granted(&mut held);
    let mut free = lock.acquire("free");
    let _other = granted(&mut free);
    assert_eq!(lock.pending_keys(), 2);
}

#[test]
fn waiters_are_granted_in_the_order_they_asked_whatever_the_order_they_poll() {
    let lock = KeyedLock::new();
    let mut a = lock.acquire("k");
    let mut b = lock.acquire("k");
    let mut c = lock.acquire("k");
    // c polls before b, which must not let it past.
    let guard_a = granted(&mut a);
    let c_wakes = waiting(&mut c);
    let b_wakes = waiting(&mut b);

    drop(guard_a);
    assert_eq!((woken(&b_wakes), woken(&c_wakes)), (1, 0));
    // Polled again, c is still behind b, and its newest waker is the one kept.
    let c_wakes = waiting(&mut c);
    let guard_b = granted(&mut b);

    drop(guard_b);
    assert_eq!(woken(&c_wakes), 1);
    let _guard_c = granted(&mut c);
}

#[test]
fn the_place_is_taken_when_the_lock_is_asked_for_not_when_it_is_polled() {
    let lock = KeyedLock::new();
    let mut early = lock.acquire("k");
    let mut late = lock.acquire("k");
    let _late_waits = waiting(&mut late);
    // `early` has never been polled, and still goes first.
    let guard = granted(&mut early);
    assert!(poll_once(&mut late).0.is_pending());
    drop(guard);
    let _guard = granted(&mut late);
}

#[test]
fn a_waiter_that_gives_up_does_not_stall_those_behind_it() {
    let lock = KeyedLock::new();
    let mut a = lock.acquire("k");
    let mut b = lock.acquire("k");
    let mut c = lock.acquire("k");
    let guard_a = granted(&mut a);
    let _b_waits = waiting(&mut b);
    let c_wakes = waiting(&mut c);

    drop(b);
    assert_eq!(woken(&c_wakes), 0, "the holder is still a");
    drop(guard_a);
    assert_eq!(woken(&c_wakes), 1);
    let _guard_c = granted(&mut c);
}

#[test]
fn a_place_dropped_unpolled_at_the_front_hands_on_when_the_holder_lets_go() {
    let lock = KeyedLock::new();
    let mut a = lock.acquire("k");
    let b = lock.acquire("k");
    let mut c = lock.acquire("k");
    let guard_a = granted(&mut a);
    let c_wakes = waiting(&mut c);

    drop(guard_a);
    // b is next and has never been polled; giving up must pass c the lock.
    drop(b);
    assert!(woken(&c_wakes) >= 1);
    let _guard_c = granted(&mut c);
}

#[test]
fn dropping_the_holders_future_after_it_was_granted_does_not_release_its_guard() {
    let lock = KeyedLock::new();
    let mut a = lock.acquire("k");
    let mut b = lock.acquire("k");
    let guard_a = granted(&mut a);
    let _b_waits = waiting(&mut b);

    drop(a);
    assert!(poll_once(&mut b).0.is_pending(), "the guard still holds the key");
    drop(guard_a);
    let _guard_b = granted(&mut b);
}

#[test]
fn every_settled_key_is_forgotten() {
    let lock = KeyedLock::new();
    let mut a = lock.acquire("a");
    let mut b = lock.acquire("b");
    let guard_a = granted(&mut a);
    let guard_b = granted(&mut b);
    assert_eq!(lock.pending_keys(), 2);
    drop(guard_a);
    assert_eq!(lock.pending_keys(), 1);
    drop(guard_b);
    assert_eq!(lock.pending_keys(), 0);

    // Giving up before ever being granted forgets the key too.
    let waiter = lock.acquire("c");
    assert_eq!(lock.pending_keys(), 1);
    drop(waiter);
    assert_eq!(lock.pending_keys(), 0);
}

#[test]
fn a_key_is_usable_again_after_it_was_forgotten() {
    let lock = KeyedLock::new();
    drop(granted(&mut lock.acquire("k")));
    let mut again = lock.acquire("k");
    let _guard = granted(&mut again);
    assert_eq!(lock.pending_keys(), 1);
}

#[test]
fn a_clone_is_the_same_lock() {
    let lock = KeyedLock::new();
    let other = lock.clone();
    let mut first = lock.acquire("k");
    let mut second = other.acquire("k");
    let guard = granted(&mut first);
    assert!(poll_once(&mut second).0.is_pending());
    drop(guard);
    let _guard = granted(&mut second);
}

#[test]
fn the_port_lock_resolves_through_block_on_and_releases_on_drop() {
    let lock = KeyedLock::new();
    let through_port = lock.clone();
    let guard = within(move || block_on(through_port.lock("w")));
    let mut waiter = lock.acquire("w");
    assert!(poll_once(&mut waiter).0.is_pending());
    drop(guard);
    drop(within(move || block_on(waiter)));
    assert_eq!(lock.pending_keys(), 0);
}

#[test]
#[cfg(not(target_arch = "wasm32"))]
fn a_holder_that_panics_releases_the_key() {
    let lock = KeyedLock::new();
    let holder = lock.clone();
    let outcome = std::thread::spawn(move || {
        let _guard = granted(&mut holder.acquire("k"));
        // The panic is the point: unwinding must run the guard's drop.
        std::panic::panic_any("holder failed");
    })
    .join();
    assert!(outcome.is_err());
    assert_eq!(lock.pending_keys(), 0);
    let next = lock.acquire("k");
    drop(within(move || block_on(next)));
}

#[test]
#[cfg(not(target_arch = "wasm32"))]
fn a_poisoned_state_is_still_usable() {
    let lock = KeyedLock::new();
    let poisoner = Arc::clone(&lock.state);
    let _ = std::thread::spawn(move || {
        let _held = poisoner.lock().unwrap();
        std::panic::panic_any("poison");
    })
    .join();
    assert!(lock.state.is_poisoned());
    let next = lock.acquire("k");
    drop(within(move || block_on(next)));
    assert_eq!(lock.pending_keys(), 0);
}

/// Pending once, then ready: lets other tasks run in between.
struct Yield(bool);

impl std::future::Future for Yield {
    type Output = ();

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        if self.0 {
            return Poll::Ready(());
        }
        self.0 = true;
        cx.waker().wake_by_ref();
        Poll::Pending
    }
}

#[derive(Debug, Clone)]
struct Op {
    key: u8,
    yields: u8,
}

fn ops() -> impl Strategy<Value = Vec<Op>> {
    // Three keys over up to twenty operations, so most runs queue several
    // behind each other on one key and interleave the keys.
    prop::collection::vec((0_u8..3, 0_u8..5).prop_map(|(key, yields)| Op { key, yields }), 1..=20)
}

/// Runs every task to completion by polling each in turn, so tasks interleave
/// at every await the way a single-threaded executor would.
fn run_all(mut tasks: Vec<Option<Pin<Box<dyn std::future::Future<Output = ()>>>>>) {
    let waker = Waker::from(Arc::new(Wakes::default()));
    let mut cx = Context::from_waker(&waker);
    // Every task finishes within a few rounds; a bound turns a lock that never
    // grants into a failure rather than a spin.
    for _ in 0..1_000 {
        if tasks.iter().all(Option::is_none) {
            return;
        }
        for slot in &mut tasks {
            if let Some(task) = slot
                && task.as_mut().poll(&mut cx).is_ready()
            {
                *slot = None;
            }
        }
    }
    panic!("the tasks did not finish: a place in line was never granted");
}

#[test]
fn one_key_runs_in_submission_order_without_overlap_and_drains_its_map() {
    let queued_behind = Floor::new("an operation submitted behind another on its key");
    check(ops(), None, |ops| {
        let lock = KeyedLock::new();
        let started = Arc::new(Mutex::new(Vec::<(u8, usize)>::new()));
        let running = Arc::new(Mutex::new([0_u32; 3]));
        let overlapped = Arc::new(Mutex::new(false));
        let mut tasks: Vec<Option<Pin<Box<dyn std::future::Future<Output = ()>>>>> = Vec::new();
        for (index, op) in ops.iter().enumerate() {
            let key = op.key;
            queued_behind.draw(ops[..index].iter().any(|earlier| earlier.key == key));
            // Asked for here, in submission order, before any task is polled.
            let place = lock.acquire(&key.to_string());
            let (started, running, overlapped) =
                (Arc::clone(&started), Arc::clone(&running), Arc::clone(&overlapped));
            let yields = op.yields;
            tasks.push(Some(Box::pin(async move {
                let _guard = place.await;
                started.lock().unwrap().push((key, index));
                let slot = usize::from(key);
                running.lock().unwrap()[slot] += 1;
                if running.lock().unwrap()[slot] > 1 {
                    *overlapped.lock().unwrap() = true;
                }
                for _ in 0..yields {
                    Yield(false).await;
                }
                running.lock().unwrap()[slot] -= 1;
            })));
        }
        run_all(tasks);

        prop_assert!(!*overlapped.lock().unwrap());
        for key in 0..3_u8 {
            let submitted: Vec<usize> =
                ops.iter().enumerate().filter(|(_, op)| op.key == key).map(|(i, _)| i).collect();
            let order: Vec<usize> = started
                .lock()
                .unwrap()
                .iter()
                .filter(|(k, _)| *k == key)
                .map(|(_, i)| *i)
                .collect();
            prop_assert_eq!(order, submitted);
        }
        prop_assert_eq!(lock.pending_keys(), 0);
        Ok(())
    });
    queued_behind.assert(100);
}

#[test]
fn giving_up_at_any_point_never_stalls_the_rest_of_the_line() {
    let abandoned_mid_line = Floor::new("a place given up with others behind it");
    check((1_usize..8, prop::collection::vec(any::<bool>(), 8)), None, |(count, abandon)| {
        let lock = KeyedLock::new();
        let mut places: Vec<Acquire> = (0..count).map(|_| lock.acquire("k")).collect();
        let mut kept = Vec::new();
        for (index, place) in places.drain(..).enumerate() {
            let give_up = abandon[index];
            abandoned_mid_line.draw(give_up && index + 1 < count);
            if give_up {
                drop(place);
            } else {
                kept.push(place);
            }
        }
        // Whoever stayed is granted in turn, each by the one before dropping.
        for place in kept {
            drop(within(move || block_on(place)));
        }
        prop_assert_eq!(lock.pending_keys(), 0);
        Ok(())
    });
    abandoned_mid_line.assert(20);
}
