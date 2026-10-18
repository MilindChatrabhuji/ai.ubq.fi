use gateway_auth::{
    AuthHost, AuthMethod, AuthRequest, AuthResponse, AuthService, GatewayError,
    crypto::uuid_from_random,
    invalid,
    passkeys::{PasskeyUser, user_wire},
    store,
};
use gateway_core::query::QueryStore;
use serde_json::{Value, json};
use url::Url;

use crate::{AdminHost, AdminInput, AdminOperation, keys::KeyService, match_route};

pub struct AdminService<'a, S, H, A> {
    pub store: &'a S,
    pub host: &'a H,
    pub capabilities: &'a A,
    pub config: &'a gateway_auth::AuthConfig,
    pub release: &'a str,
}

impl<'a, S: QueryStore, H: AuthHost, A: AdminHost> AdminService<'a, S, H, A> {
    pub async fn handle_route(
        &self,
        request: &AuthRequest,
        request_id: &str,
    ) -> Result<Option<AuthResponse>, GatewayError> {
        let url = Url::parse(&request.url).map_err(|_| invalid("Invalid request URL"))?;
        let Some(route) = match_route(&request.method, url.path()) else {
            if url.path().starts_with("/admin/api-keys/") && url.path().ends_with("/paid-fallbacks")
            {
                return Err(GatewayError::new(
                    405,
                    "Method not allowed",
                    Some("method_not_allowed"),
                ));
            }
            return Ok(None);
        };
        // Every console operation, including formerly super-admin-only ones, authenticates first.
        let auth = AuthService::new(self.store, self.host, self.config);
        let actor = auth.authenticate_admin(request).await?;
        let body = if matches!(request.method.as_str(), "GET" | "HEAD") {
            Value::Null
        } else if request.body.is_empty() {
            json!({})
        } else {
            if request.body.len() > 32 * 1024 * 1024 {
                return Err(invalid("Invalid JSON body"));
            }
            let parsed: Value =
                serde_json::from_slice(&request.body).map_err(|_| invalid("Invalid JSON body"))?;
            if !parsed.is_object() {
                return Err(invalid("Invalid JSON body"));
            }
            parsed
        };
        let mut query = std::collections::BTreeMap::<String, Vec<String>>::new();
        for (name, value) in url.query_pairs() {
            query.entry(name.into()).or_default().push(value.into());
        }
        let keys = KeyService {
            store: self.store,
            host: self.host,
            capabilities: self.capabilities,
            release: self.release,
        };
        let response = match route.operation {
            AdminOperation::PasskeyUsersList => {
                crate::reads::passkey_users(self.store, self.host.now_ms()).await?
            }
            AdminOperation::ApiKeysList => {
                crate::reads::api_keys(self.store, self.host.now_ms()).await?
            }
            AdminOperation::ApiKeyChanges => {
                crate::reads::key_changes(self.store, &query, self.host.now_ms()).await?
            }
            AdminOperation::KernelPublicKeysGet => {
                crate::kernel_keys::list(self.store, self.host.now_ms()).await?
            }
            AdminOperation::KernelPublicKeysCreate => {
                crate::kernel_keys::create(self.store, self.host, &body).await?
            }
            AdminOperation::KernelPublicKeysDelete => {
                crate::kernel_keys::delete(self.store, self.host, &query).await?
            }
            AdminOperation::PasskeyUsersUpdate => {
                let id = body
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| invalid("id is required"))?;
                let is_admin = body
                    .get("is_admin")
                    .and_then(Value::as_bool)
                    .ok_or_else(|| invalid("is_admin must be a boolean"))?;
                let key = gateway_auth::passkeys::key("users", id);
                let row = self.store.read(&key).await?;
                let mut user: PasskeyUser = store::decode(row.as_ref(), self.host.now_ms())?
                    .ok_or_else(|| {
                        GatewayError::new(404, "Passkey user not found", Some("not_found"))
                    })?;
                user.is_admin = is_admin;
                user.updated_at_ms = self.host.now_ms();
                let revision = uuid_from_random(&self.host.random_bytes(16)?)?;
                if !store::commit(
                    self.store,
                    vec![store::check(&key, row.as_ref())],
                    vec![store::put(key, &user, None, &revision)?],
                )
                .await?
                {
                    return Err(gateway_auth::conflict(
                        "Passkey user was modified concurrently; retry",
                    ));
                }
                AuthResponse::json(200, json!({"user":user_wire(&user)}))
            }
            AdminOperation::ApiKeysCreate => keys.create(&body, &actor, request_id).await?,
            operation @ (AdminOperation::ApiKeysUpdate
            | AdminOperation::ApiKeysRevoke
            | AdminOperation::ApiKeysUnrevoke
            | AdminOperation::ApiKeysDelete) => {
                keys.mutate(operation, &body, &actor, request_id).await?
            }
            operation => {
                let parameter = if operation == AdminOperation::ApiKeyPaidFallbacks {
                    route
                        .parameter
                        .as_deref()
                        .map(decode_parameter)
                        .transpose()?
                } else {
                    route.parameter
                };
                self.capabilities
                    .execute(
                        operation,
                        AdminInput {
                            parameter,
                            query,
                            body,
                            actor,
                            request_id: request_id.into(),
                            now_ms: self.host.now_ms(),
                        },
                    )
                    .await?
            }
        };
        Ok(Some(response))
    }
}

fn decode_parameter(value: &str) -> Result<String, GatewayError> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let first = bytes
                .get(index + 1)
                .and_then(|b| (*b as char).to_digit(16))
                .ok_or_else(|| invalid("Invalid API key id"))?;
            let second = bytes
                .get(index + 2)
                .and_then(|b| (*b as char).to_digit(16))
                .ok_or_else(|| invalid("Invalid API key id"))?;
            decoded.push((first * 16 + second) as u8);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| invalid("Invalid API key id"))
}

/// A shared credential is never mislabeled as a human identity in the admin audit.
pub fn identified_admin(principal: &gateway_auth::AuthPrincipal) -> Option<(&str, &str)> {
    if let AuthMethod::PasskeySession {
        user_id, handle, ..
    } = &principal.method
    {
        Some((user_id, handle))
    } else {
        None
    }
}
