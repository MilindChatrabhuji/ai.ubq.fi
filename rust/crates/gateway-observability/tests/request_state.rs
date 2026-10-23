mod support;
use gateway_core::GatewayError;
use gateway_observability::{
    ObservabilityRuntime, ObservabilityState,
    host_types::*,
    types::{HealthEvent as E, HealthTarget, HealthWrite as W, ObservabilityHost},
};
use std::{
    cell::Cell,
    future::Future,
    rc::Rc,
    task::{Context, Poll, Waker},
};
use support::{Host, Memory, run};
struct RequestHost {
    base: Host,
    drops: Rc<Cell<usize>>,
    random_calls: Rc<Cell<usize>>,
    probes: Rc<Cell<usize>>,
    pause_probe: Rc<Cell<bool>>,
}
impl Drop for RequestHost {
    fn drop(&mut self) {
        self.drops.set(self.drops.get() + 1)
    }
}
impl ObservabilityHost for RequestHost {
    fn source_string_collator(
        &self,
    ) -> std::sync::Arc<dyn gateway_schema::aliases::SourceStringCollator> {
        self.base.source_string_collator()
    }
    fn now_ms(&self) -> i64 {
        self.base.now_ms()
    }
    fn random_bytes(&self, n: usize) -> Result<Vec<u8>, GatewayError> {
        self.random_calls.set(self.random_calls.get() + 1);
        self.base.random_bytes(n)
    }
    async fn wait_ms(&self, n: u32) -> Result<(), GatewayError> {
        self.base.wait_ms(n).await
    }
    fn build_identity(&self) -> Result<BuildIdentity, GatewayError> {
        Ok(BuildIdentity {
            git_sha: "a".repeat(40),
            deployment_id: "fixture-build".into(),
        })
    }
    async fn probe_upstream_health(
        &self,
        deadline: i64,
    ) -> Result<UpstreamHealthEvidence, GatewayError> {
        assert_eq!(deadline, self.now_ms() + 3000);
        self.probes.set(self.probes.get() + 1);
        std::future::poll_fn(|_| {
            if self.pause_probe.get() {
                Poll::Pending
            } else {
                Poll::Ready(())
            }
        })
        .await;
        Ok(UpstreamHealthEvidence {
            auth: Some(CodexAuthMetadata {
                source: CredentialSource::Kv,
                updated_at_ms: Some(1),
                access_token_exp_ms: Some(9000000),
                accounts: vec![CodexAuthAccount {
                    account_id: "fixture-account".into(),
                    slot: 1,
                    updated_at_ms: Some(1),
                    access_token_exp_ms: Some(9000000),
                    refresh_sha256: Some("b".repeat(64)),
                    native_owner_codex_home: None,
                }],
            }),
            codex: ActiveProbe {
                status: 200,
                provider: ProbeProvider::ChatgptCodex,
                content_type: Some("application/json".into()),
                error: None,
            },
            metered_quota: None,
            claude_subscription: Some(ActiveProbe {
                status: 503,
                provider: ProbeProvider::ClaudeSubscription,
                content_type: None,
                error: Some("fixture unavailable".into()),
            }),
            claude_workspace: None,
        })
    }
}
type RequestFixture = (
    RequestHost,
    Rc<Cell<usize>>,
    Rc<Cell<usize>>,
    Rc<Cell<usize>>,
    Rc<Cell<bool>>,
);
fn request_host(base: &Host) -> RequestFixture {
    let drops = Rc::new(Cell::new(0));
    let random = Rc::new(Cell::new(0));
    let probes = Rc::new(Cell::new(0));
    let pause = Rc::new(Cell::new(false));
    (
        RequestHost {
            base: base.clone(),
            drops: drops.clone(),
            random_calls: random.clone(),
            probes: probes.clone(),
            pause_probe: pause.clone(),
        },
        drops,
        random,
        probes,
        pause,
    )
}
#[test]
fn rebound_runtime_shares_heartbeat_data_and_never_retains_a_finished_request_host() {
    let memory = Memory::default();
    let clock = Host::default();
    clock.at.set(1000);
    let state = ObservabilityState::default();
    let (host, a_drops, _, _, _) = request_host(&clock);
    let a = ObservabilityRuntime::with_state(memory.clone(), host, state.clone());
    let target = HealthTarget::codex("account");
    assert_eq!(
        run(a.observe_provider(target.clone(), E::Success, Some(200), None)),
        W::Stored
    );
    drop(a);
    assert_eq!(a_drops.get(), 1);
    let (host, b_drops, b_random, _, _) = request_host(&clock);
    let b = ObservabilityRuntime::with_state(memory, host, state);
    assert_eq!(
        run(b.observe_provider(target.clone(), E::Success, Some(200), None)),
        W::Throttled
    );
    assert_eq!(b_random.get(), 0);
    assert_eq!(
        run(b.observe_provider(target, E::UpstreamError, Some(503), None)),
        W::Stored
    );
    assert_eq!(b_random.get(), 2);
    assert_eq!(a_drops.get(), 1);
    drop(b);
    assert_eq!(b_drops.get(), 1);
}
#[test]
fn cancelled_producer_drops_its_host_and_releases_data_only_health_waiters() {
    let memory = Memory::default();
    memory.pause.set(true);
    let clock = Host::default();
    clock.at.set(1000);
    let state = ObservabilityState::default();
    let (host, a_drops, _, _, _) = request_host(&clock);
    let a = ObservabilityRuntime::with_state(memory.clone(), host, state.clone());
    let (host, _, b_random, _, _) = request_host(&clock);
    let b = ObservabilityRuntime::with_state(memory.clone(), host, state);
    let target = HealthTarget::codex("account");
    let mut first = Box::pin(a.observe_provider(target.clone(), E::Success, Some(200), None));
    let mut same = Box::pin(b.observe_provider(target.clone(), E::Success, Some(200), None));
    let mut cx = Context::from_waker(Waker::noop());
    assert!(matches!(first.as_mut().poll(&mut cx), Poll::Pending));
    assert!(matches!(same.as_mut().poll(&mut cx), Poll::Pending));
    drop(first);
    drop(a);
    assert_eq!(a_drops.get(), 1);
    assert_eq!(run(same), W::Unavailable);
    assert_eq!(memory.commits.get(), 0);
    assert_eq!(b_random.get(), 0);
    memory.pause.set(false);
    assert_eq!(
        run(b.observe_provider(target, E::UpstreamError, Some(503), None)),
        W::Stored
    );
    assert_eq!(b_random.get(), 2);
}
#[test]
fn active_health_coalesces_only_a_receipt_and_never_reuses_an_old_io_host() {
    let memory = Memory::default();
    let clock = Host::default();
    clock.at.set(1000);
    let state = ObservabilityState::default();
    let (host, a_drops, _, a_probes, pause) = request_host(&clock);
    pause.set(true);
    let a = ObservabilityRuntime::with_state(memory.clone(), host, state.clone());
    let (host, _, _, b_probes, _) = request_host(&clock);
    let b = ObservabilityRuntime::with_state(memory, host, state);
    let mut first = Box::pin(a.upstream_health_response());
    let mut second = Box::pin(b.upstream_health_response());
    let mut cx = Context::from_waker(Waker::noop());
    assert!(matches!(first.as_mut().poll(&mut cx), Poll::Pending));
    assert!(matches!(second.as_mut().poll(&mut cx), Poll::Pending));
    assert_eq!((a_probes.get(), b_probes.get()), (1, 0));
    drop(first);
    drop(a);
    assert_eq!(a_drops.get(), 1);
    assert_eq!(
        run(second).unwrap_err().envelope.error.code.as_deref(),
        Some("active_upstream_health_interrupted")
    );
    assert_eq!(b_probes.get(), 0);
    let response = run(b.upstream_health_response()).unwrap();
    assert_eq!(response.status, 200);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&response.body.to_bytes().unwrap()).unwrap()["probes"]
            ["claude_subscription"]["status"],
        503
    );
    assert_eq!(b_probes.get(), 1);
}
#[test]
fn cancelled_coalescer_releases_its_executor_waker_while_the_producer_remains_pending() {
    #[derive(Default)]
    struct Executor(std::sync::atomic::AtomicUsize);
    impl std::task::Wake for Executor {
        fn wake(self: std::sync::Arc<Self>) {
            self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
    }
    let executor = std::sync::Arc::new(Executor::default());
    let waker = Waker::from(executor.clone());
    let mut cx = Context::from_waker(&waker);
    let memory = Memory::default();
    memory.pause.set(true);
    let runtime = ObservabilityRuntime::new(memory.clone(), Host::default());
    let target = HealthTarget::codex("fixture");
    let mut producer =
        Box::pin(runtime.observe_provider(target.clone(), E::Success, Some(200), None));
    let mut noop = Context::from_waker(Waker::noop());
    assert!(matches!(producer.as_mut().poll(&mut noop), Poll::Pending));
    let mut waiter = Box::pin(runtime.observe_provider(target, E::Success, Some(200), None));
    assert!(matches!(waiter.as_mut().poll(&mut cx), Poll::Pending));
    assert_eq!(std::sync::Arc::strong_count(&executor), 3);
    drop(waiter);
    assert_eq!(std::sync::Arc::strong_count(&executor), 2);
    memory.pause.set(false);
    assert_eq!(run(producer), W::Stored);
}
