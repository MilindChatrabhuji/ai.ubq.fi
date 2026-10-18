//! A receipt cell, never an executor or stored I/O future.
use std::{
    cell::RefCell,
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    rc::Rc,
    task::{Context, Poll, Waker},
};
struct State<T> {
    value: Option<T>,
    waiters: BTreeMap<u64, Waker>,
    next_waiter: u64,
}
pub(crate) struct Completion<T> {
    state: Rc<RefCell<State<T>>>,
    waiter: Option<u64>,
}
impl<T> Clone for Completion<T> {
    fn clone(&self) -> Self {
        Self {
            state: self.state.clone(),
            waiter: None,
        }
    }
}
impl<T> Completion<T> {
    pub(crate) fn new() -> Self {
        Self {
            state: Rc::new(RefCell::new(State {
                value: None,
                waiters: BTreeMap::new(),
                next_waiter: 0,
            })),
            waiter: None,
        }
    }
    pub(crate) fn same(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.state, &other.state)
    }
    pub(crate) fn finish(&self, value: T) {
        let waiters = {
            let mut state = self.state.borrow_mut();
            if state.value.is_some() {
                return;
            }
            state.value = Some(value);
            std::mem::take(&mut state.waiters)
        };
        for waker in waiters.into_values() {
            waker.wake()
        }
    }
}
impl<T> Drop for Completion<T> {
    fn drop(&mut self) {
        if let Some(id) = self.waiter {
            self.state.borrow_mut().waiters.remove(&id);
        }
    }
}
impl<T: Clone> Future for Completion<T> {
    type Output = T;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<T> {
        let this = self.get_mut();
        let mut state = this.state.borrow_mut();
        if let Some(value) = state.value.clone() {
            if let Some(id) = this.waiter.take() {
                state.waiters.remove(&id);
            }
            return Poll::Ready(value);
        }
        let id = match this.waiter {
            Some(id) => id,
            None => {
                loop {
                    state.next_waiter = state.next_waiter.wrapping_add(1);
                    if !state.waiters.contains_key(&state.next_waiter) {
                        break;
                    }
                }
                let id = state.next_waiter;
                this.waiter = Some(id);
                id
            }
        };
        if state
            .waiters
            .get(&id)
            .is_none_or(|w| !w.will_wake(cx.waker()))
        {
            state.waiters.insert(id, cx.waker().clone());
        }
        Poll::Pending
    }
}
