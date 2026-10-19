use super::*;

#[test]
fn manual_reset_exact_route_rejects_other_methods_and_aliases() {
    let path = "/admin/providers/codex/banked-resets/consume";
    let route = gateway_admin::match_route("POST", path).unwrap();
    assert_eq!(route.operation, AdminOperation::CodexResetConsume);
    assert_eq!(route.operation.capability(), "codex_capacity_authority");
    assert!(gateway_admin::match_route("GET", path).is_none());
    assert!(gateway_admin::match_route("POST", &format!("{path}/")).is_none());
}

#[test]
fn manual_reset_authenticates_before_validating_and_dispatches_only_exact_hash() {
    #[derive(Default)]
    struct Manual {
        calls: RefCell<Vec<String>>,
    }
    impl RuntimeCapabilities for Manual {
        async fn codex(
            &self,
            request: CodexRequest,
            _: Context,
        ) -> Result<AuthResponse, GatewayError> {
            let CodexRequest::ConsumeReset { account_id_hash } = request else {
                panic!("wrong capability")
            };
            self.calls.borrow_mut().push(account_id_hash.clone());
            Ok(AuthResponse::json(
                200,
                json!({"reset_status":"verified","active_account_id_hash":account_id_hash}),
            ))
        }
    }
    let store = Store::default();
    let host = Host::default();
    let capability = Manual::default();
    let config = RuntimeConfig::default();
    let runtime = AdminRuntime {
        store: &store,
        host: &host,
        capabilities: &capability,
        config: &config,
    };
    let mut unauthorized = input(Value::Null);
    unauthorized.actor.is_admin = false;
    assert_eq!(
        run(runtime.execute(AdminOperation::CodexResetConsume, unauthorized))
            .unwrap_err()
            .status,
        401
    );
    assert_eq!(store.reads.get(), 0);
    for body in [
        Value::Null,
        json!({}),
        json!({"account_id_hash":"a".repeat(63)}),
        json!({"account_id_hash":"A".repeat(64)}),
        json!({"account_id_hash":"a".repeat(64),"enabled":true}),
    ] {
        let error =
            run(runtime.execute(AdminOperation::CodexResetConsume, input(body))).unwrap_err();
        assert_eq!(error.status, 400);
        assert_eq!(
            error.envelope.error.message,
            "Only account_id_hash is accepted."
        );
    }
    assert!(capability.calls.borrow().is_empty());
    let hash = "a".repeat(64);
    assert_eq!(
        run(runtime.execute(
            AdminOperation::CodexResetConsume,
            input(json!({"account_id_hash":hash}))
        ))
        .unwrap()
        .status,
        200
    );
    assert_eq!(*capability.calls.borrow(), [hash]);
}
