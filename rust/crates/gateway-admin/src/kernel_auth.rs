//! Source kernel auth projection and missing-policy queue, on the common authority.
use std::cmp::Ordering;

use gateway_admin_data::migration::kernel::normalize_policy;
use gateway_auth::{AuthHost, crypto::base64url, store};
use gateway_authority::keys;
use gateway_core::{GatewayError, state::AuthorityStore};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KernelPrincipalState {
    pub limit_scope: String,
    pub has_policy: bool,
    /// None when policy exists; false records source best-effort queue failure.
    pub queue_recorded: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
struct QueueItem {
    owner: String,
    repo: String,
    request_count: f64,
    first_seen_at_ms: f64,
    last_seen_at_ms: f64,
    last_route: Option<String>,
}

fn text(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned()
}

fn number(value: Option<&Value>, fallback: f64) -> f64 {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .map_or(fallback, f64::trunc)
}

fn queue_items(value: &Value, now: i64) -> Vec<QueueItem> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|value| {
            let row = value.as_object()?;
            let owner = text(row.get("owner"));
            let repo = text(row.get("repo"));
            if owner.is_empty() || repo.is_empty() {
                return None;
            }
            let route = text(row.get("last_route"));
            Some(QueueItem {
                owner,
                repo,
                request_count: number(row.get("request_count"), 0.0).max(0.0),
                first_seen_at_ms: number(row.get("first_seen_at_ms"), now as f64),
                last_seen_at_ms: number(row.get("last_seen_at_ms"), now as f64),
                last_route: (!route.is_empty()).then_some(route),
            })
        })
        .collect()
}

pub struct KernelAuthService<'a, S, H> {
    pub store: &'a S,
    pub host: &'a H,
}

impl<S: AuthorityStore, H: AuthHost> KernelAuthService<'_, S, H> {
    /// Call only after the bearer, GitHub repository and kernel JWT have verified.
    /// This reads policy and queues discovery; it never reserves inference quota.
    pub async fn resolve(
        &self,
        owner: &str,
        repo: &str,
        path: &str,
    ) -> Result<KernelPrincipalState, GatewayError> {
        let now = self.host.now_ms();
        let repo_row = self
            .store
            .read(&keys::kernel_policy(owner, Some(repo)))
            .await?;
        let org_row = self.store.read(&keys::kernel_policy(owner, None)).await?;
        let repo_policy =
            store::decode::<Value>(repo_row.as_ref(), now)?.filter(|value| !value.is_null());
        let org_policy =
            store::decode::<Value>(org_row.as_ref(), now)?.filter(|value| !value.is_null());
        // Validate both, even when a valid repo row would take precedence. Policy
        // expiry is not storage expiry and does not make a present row disappear.
        if repo_policy
            .as_ref()
            .is_some_and(|value| normalize_policy(value, "repo", owner, Some(repo)).is_none())
            || org_policy
                .as_ref()
                .is_some_and(|value| normalize_policy(value, "org", owner, None).is_none())
        {
            return Err(GatewayError::unavailable(
                "Kernel quota is unavailable",
                "server_error",
            ));
        }
        let has_policy = repo_policy.is_some() || org_policy.is_some();
        let queue_recorded = if has_policy {
            None
        } else {
            Some(self.record_queue(owner, repo, path, now).await.is_ok())
        };
        Ok(KernelPrincipalState {
            limit_scope: if repo_policy.is_some() {
                "repo".into()
            } else {
                "org".into()
            },
            has_policy,
            queue_recorded,
        })
    }

    async fn record_queue(
        &self,
        owner: &str,
        repo: &str,
        route: &str,
        now: i64,
    ) -> Result<(), GatewayError> {
        let owner = owner.trim();
        let repo = repo.trim();
        if owner.is_empty() || repo.is_empty() {
            return Ok(());
        }
        let route = route.trim();
        let route = (!route.is_empty()).then(|| route.to_owned());
        let key = store::key(json!(["uos_ai", "kernel_policy_queue"]));
        for _ in 0..3 {
            let row = self.store.read(&key).await?;
            let value: Option<Value> = store::decode(row.as_ref(), now)?;
            let mut items = value
                .as_ref()
                .map_or_else(Vec::new, |value| queue_items(value, now));
            if let Some(item) = items
                .iter_mut()
                .find(|item| item.owner == owner && item.repo == repo)
            {
                item.request_count += 1.0;
                item.last_seen_at_ms = now as f64;
                item.last_route = route.clone().or_else(|| item.last_route.clone());
            } else {
                items.insert(
                    0,
                    QueueItem {
                        owner: owner.to_owned(),
                        repo: repo.to_owned(),
                        request_count: 1.0,
                        first_seen_at_ms: now as f64,
                        last_seen_at_ms: now as f64,
                        last_route: route.clone(),
                    },
                );
            }
            items.sort_by(|left, right| {
                right
                    .last_seen_at_ms
                    .partial_cmp(&left.last_seen_at_ms)
                    .unwrap_or(Ordering::Equal)
            });
            items.truncate(200);
            let random = self.host.random_bytes(24)?;
            if random.len() != 24 {
                return Err(GatewayError::unavailable(
                    "Kernel queue revision entropy is unavailable",
                    "server_error",
                ));
            }
            let mutation = store::put(key.clone(), &items, None, &base64url(&random))?;
            if store::commit(
                self.store,
                vec![store::check(&key, row.as_ref())],
                vec![mutation],
            )
            .await?
            {
                return Ok(());
            }
        }
        Err(GatewayError::unavailable(
            "Kernel policy queue changed concurrently",
            "server_error",
        ))
    }
}
