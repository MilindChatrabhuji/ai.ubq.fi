//! A receipt cell, never an executor or stored I/O future.
use std::{cell::RefCell,future::Future,pin::Pin,rc::Rc,task::{Context,Poll,Waker}};
struct State<T>{value:Option<T>,waiters:Vec<Waker>}
pub(crate) struct Completion<T>(Rc<RefCell<State<T>>>);
impl<T> Clone for Completion<T>{fn clone(&self)->Self{Self(self.0.clone())}}
impl<T> Completion<T>{
    pub(crate) fn new()->Self{Self(Rc::new(RefCell::new(State{value:None,waiters:Vec::new()})))}
    pub(crate) fn same(&self,other:&Self)->bool{Rc::ptr_eq(&self.0,&other.0)}
    pub(crate) fn finish(&self,value:T){
        let waiters={let mut state=self.0.borrow_mut();if state.value.is_some(){return}state.value=Some(value);std::mem::take(&mut state.waiters)};
        for waker in waiters{waker.wake()}
    }
}
impl<T:Clone> Future for Completion<T>{
    type Output=T;
    fn poll(self:Pin<&mut Self>,cx:&mut Context<'_>)->Poll<T>{
        let mut state=self.0.borrow_mut();if let Some(value)=state.value.clone(){return Poll::Ready(value)}
        if !state.waiters.iter().any(|w|w.will_wake(cx.waker())){state.waiters.push(cx.waker().clone());}Poll::Pending
    }
}
