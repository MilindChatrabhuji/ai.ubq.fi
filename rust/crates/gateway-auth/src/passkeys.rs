use gateway_core::state::{AuthorityStore, RecordKey, RecordMutation};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    AuthConfig, AuthHost, AuthRequest, AuthResponse, GatewayError, RELAY_COOKIE, conflict, invalid,
    unauthorized,
};
use crate::{
    crypto::{base64url, decode_base64url, sha256_hex, uuid_from_random},
    origin::{passkey_meta, request_audience, trusted_relay_origin},
    store,
};

pub const CHALLENGE_TTL_MS: i64 = 300_000;
pub const SESSION_TTL_MS: i64 = 604_800_000;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct PasskeyUser {
    pub id: String,
    pub handle: String,
    pub is_admin: bool,
    pub credential_ids: Vec<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct PasskeyCredential {
    pub credential_id: String,
    pub user_id: String,
    pub public_key: String,
    pub sign_count: u32,
    pub transports: Vec<String>,
    pub created_at_ms: i64,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct PasskeySession {
    pub token: String,
    pub user_id: String,
    pub created_at_ms: i64,
    pub expires_at_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audience_origin: Option<String>,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct PasskeyChallenge {
    pub challenge: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub origin: String,
    pub rp_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audience_origin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_admin: Option<bool>,
    pub created_at_ms: i64,
    pub expires_at_ms: i64,
}
#[derive(Clone, Debug)]
pub struct SessionView {
    pub session: PasskeySession,
    pub user: PasskeyUser,
}
#[derive(Clone, Debug)]
pub struct RegistrationVerification {
    pub response: Value,
    pub challenge: String,
    pub origin: String,
    pub rp_id: String,
    pub require_user_verification: bool,
}
#[derive(Clone, Debug)]
pub struct VerifiedRegistration {
    pub credential_id: String,
    pub public_key: Vec<u8>,
    pub sign_count: u32,
    pub transports: Vec<String>,
}
#[derive(Clone, Debug)]
pub struct AssertionVerification {
    pub response: Value,
    pub challenge: String,
    pub origin: String,
    pub rp_id: String,
    pub require_user_verification: bool,
    pub credential: PasskeyCredential,
}

pub fn key(kind: &str, id: &str) -> RecordKey {
    store::key(json!(["uos_ai", "auth", kind, id]))
}
pub fn user_wire(user: &PasskeyUser) -> Value {
    json!({"id":user.id,"handle":user.handle,"is_admin":user.is_admin,"credential_count":user.credential_ids.len(),"created_at_ms":user.created_at_ms,"updated_at_ms":user.updated_at_ms})
}

pub fn normalize_handle(value: &str) -> String {
    let mut result = String::new();
    let mut separator = false;
    for ch in value.trim().to_lowercase().chars() {
        let ch = if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
            ch
        } else {
            '-'
        };
        if ch == '-' {
            if result.is_empty() || separator {
                continue;
            }
            separator = true;
        } else {
            separator = false;
        }
        result.push(ch);
    }
    result.trim_matches('-').chars().take(96).collect()
}
pub fn token_handle(seed: &str) -> String {
    if seed.trim().is_empty() {
        String::new()
    } else {
        format!("uos-passkey-{}", &sha256_hex(seed.trim().as_bytes())[..16])
    }
}

pub fn cookie_token(request: &AuthRequest) -> Option<String> {
    for part in request.header("cookie")?.split(';') {
        let Some((name, value)) = part.split_once('=') else {
            continue;
        };
        if name.trim() != RELAY_COOKIE {
            continue;
        }
        let value = value.trim();
        if value.is_empty() {
            return None;
        }
        // Generated session tokens need no escaping; decode valid percent encodings without treating + as a space.
        let mut bytes = Vec::new();
        let raw = value.as_bytes();
        let mut index = 0;
        while index < raw.len() {
            if raw[index] == b'%' {
                let a = (*raw.get(index + 1)? as char).to_digit(16)?;
                let b = (*raw.get(index + 2)? as char).to_digit(16)?;
                bytes.push((a * 16 + b) as u8);
                index += 3;
            } else {
                bytes.push(raw[index]);
                index += 1;
            }
        }
        return String::from_utf8(bytes).ok();
    }
    None
}

pub struct PasskeyService<'a, S, H> {
    pub store: &'a S,
    pub host: &'a H,
    pub config: &'a AuthConfig,
}

impl<'a, S: AuthorityStore, H: AuthHost> PasskeyService<'a, S, H> {
    fn revision(&self) -> Result<String, GatewayError> {
        uuid_from_random(&self.host.random_bytes(16)?)
    }
    fn uuid(&self) -> Result<String, GatewayError> {
        self.revision()
    }
    fn challenge(&self) -> Result<String, GatewayError> {
        let bytes = self.host.random_bytes(32)?;
        if bytes.len() != 32 {
            return Err(GatewayError::unavailable(
                "Random source returned the wrong length",
                "auth_random_unavailable",
            ));
        }
        Ok(base64url(&bytes))
    }
    pub async fn session(
        &self,
        request: &AuthRequest,
        override_token: Option<&str>,
    ) -> Result<Option<SessionView>, GatewayError> {
        let cookie = cookie_token(request);
        let Some(token) = override_token
            .or_else(|| request.bearer())
            .or(cookie.as_deref())
        else {
            return Ok(None);
        };
        let session_key = key("sessions", token);
        let record = self.store.read(&session_key).await?;
        let session: Option<PasskeySession> = store::decode(record.as_ref(), self.host.now_ms())?;
        let Some(session) = session else {
            return Ok(None);
        };
        if session.expires_at_ms <= self.host.now_ms() {
            self.delete_session(token, record.as_ref()).await?;
            return Ok(None);
        }
        if session.audience_origin.as_ref().is_some_and(|audience| {
            request_audience(request, self.config).as_ref() != Some(audience)
        }) {
            return Ok(None);
        }
        let user: Option<PasskeyUser> = store::decode(
            self.store
                .read(&key("users", &session.user_id))
                .await?
                .as_ref(),
            self.host.now_ms(),
        )?;
        Ok(user.map(|user| SessionView { session, user }))
    }
    async fn delete_session(
        &self,
        token: &str,
        record: Option<&gateway_core::state::StoredRecord>,
    ) -> Result<bool, GatewayError> {
        let session_key = key("sessions", token);
        let index_key = crate::session_index::index_key(&crate::session_index::digest(token))?;
        let index = self.store.read(&index_key).await?;
        store::commit(
            self.store,
            vec![
                store::check(&session_key, record),
                store::check(&index_key, index.as_ref()),
            ],
            vec![
                RecordMutation::Delete { key: session_key },
                RecordMutation::Delete { key: index_key },
            ],
        )
        .await
    }
    async fn user_by_handle(&self, handle: &str) -> Result<Option<PasskeyUser>, GatewayError> {
        let id: Option<String> = store::decode(
            self.store.read(&key("handles", handle)).await?.as_ref(),
            self.host.now_ms(),
        )?;
        let Some(id) = id else {
            return Ok(None);
        };
        store::decode(
            self.store.read(&key("users", &id)).await?.as_ref(),
            self.host.now_ms(),
        )
    }
    async fn save_challenge(&self, challenge: &PasskeyChallenge) -> Result<(), GatewayError> {
        let k = key("challenges", &challenge.challenge);
        let old = self.store.read(&k).await?;
        if !store::commit(
            self.store,
            vec![store::check(&k, old.as_ref())],
            vec![store::put(
                k,
                challenge,
                Some(challenge.expires_at_ms),
                &self.revision()?,
            )?],
        )
        .await?
        {
            return Err(conflict(
                "Passkey challenge was modified concurrently; retry",
            ));
        }
        Ok(())
    }
    async fn consume_challenge(
        &self,
        id: &str,
        kind: &str,
    ) -> Result<PasskeyChallenge, GatewayError> {
        let k = key("challenges", id);
        let row = self.store.read(&k).await?;
        let challenge: PasskeyChallenge = store::decode(row.as_ref(), self.host.now_ms())?
            .ok_or_else(|| invalid("Invalid passkey challenge"))?;
        if challenge.expires_at_ms <= self.host.now_ms()
            || !store::commit(
                self.store,
                vec![store::check(&k, row.as_ref())],
                vec![RecordMutation::Delete { key: k }],
            )
            .await?
        {
            return Err(invalid("Invalid passkey challenge"));
        }
        if challenge.kind != kind {
            return Err(invalid("Invalid passkey challenge"));
        }
        Ok(challenge)
    }
    async fn create_session(
        &self,
        user_id: String,
        audience_origin: Option<String>,
    ) -> Result<PasskeySession, GatewayError> {
        let now = self.host.now_ms();
        let session = PasskeySession {
            token: format!("uos_ai_session_{}", self.uuid()?),
            user_id,
            created_at_ms: now,
            expires_at_ms: now + SESSION_TTL_MS,
            audience_origin,
        };
        let k = key("sessions", &session.token);
        let revision = self.revision()?;
        let index = crate::session_index::record_for_session(
            &session,
            &revision,
            Some(session.expires_at_ms),
        )?;
        let index_key =
            crate::session_index::index_key(&crate::session_index::digest(&session.token))?;
        if !store::commit(
            self.store,
            vec![store::check(&k, None), store::check(&index_key, None)],
            vec![
                store::put(k, &session, Some(session.expires_at_ms), &revision)?,
                RecordMutation::Put {
                    key: index_key,
                    record: index,
                },
            ],
        )
        .await?
        {
            return Err(conflict("Passkey session was modified concurrently; retry"));
        }
        Ok(session)
    }
    pub async fn login_start(&self, request: &AuthRequest) -> Result<AuthResponse, GatewayError> {
        let raw = crate::upstream::parse_json_body(request, true)?;
        let audience_raw = raw
            .get("relay_origin")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let audience = if audience_raw.is_empty() {
            None
        } else {
            Some(
                trusted_relay_origin(audience_raw, self.config)
                    .ok_or_else(|| invalid("Invalid passkey relay origin"))?,
            )
        };
        let now = self.host.now_ms();
        let window = now.div_euclid(60_000) * 60_000;
        let k = store::key(json!(["uos_ai", "auth", "login-start-throttle", window]));
        let mut allowed = false;
        for _ in 0..10 {
            let row = self.store.read(&k).await?;
            let current: Option<Value> = store::decode(row.as_ref(), now)?;
            let count = current
                .as_ref()
                .and_then(|v| v.get("count"))
                .and_then(Value::as_u64)
                .unwrap_or(0);
            if count >= 10 {
                break;
            }
            if store::commit(
                self.store,
                vec![store::check(&k, row.as_ref())],
                vec![store::put(
                    k.clone(),
                    &json!({"window_start_ms":window,"count":count+1}),
                    Some(window + 120_000),
                    &self.revision()?,
                )?],
            )
            .await?
            {
                allowed = true;
                break;
            }
        }
        if !allowed {
            let mut response = AuthResponse::error(
                GatewayError::new(
                    429,
                    "Too many passkey login attempts; retry after the current window",
                    Some("rate_limit_exceeded"),
                )
                .with_type("rate_limit_error"),
            );
            response.headers.insert(
                "retry-after".into(),
                ((window + 60_000 - now + 999) / 1000).max(1).to_string(),
            );
            return Ok(response);
        }
        let handle = normalize_handle(raw.get("handle").and_then(Value::as_str).unwrap_or(""));
        let user = if handle.is_empty() {
            None
        } else {
            self.user_by_handle(&handle).await?
        };
        let mut public_key = json!({"challenge":self.challenge()?,"timeout":CHALLENGE_TTL_MS,"userVerification":"required"});
        if let Some(user) = user.filter(|user| !user.credential_ids.is_empty()) {
            public_key["allowCredentials"] = json!(
                user.credential_ids
                    .iter()
                    .map(|id| json!({"id":id,"type":"public-key"}))
                    .collect::<Vec<_>>()
            );
            public_key["userVerification"] = json!(if user.is_admin {
                "required"
            } else {
                "preferred"
            });
        }
        let (origin, rp_id) = passkey_meta(
            request,
            raw.get("client_origin").and_then(Value::as_str),
            self.config,
        );
        public_key["rpId"] = json!(rp_id);
        let challenge = PasskeyChallenge {
            challenge: public_key["challenge"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
            kind: "authentication".into(),
            origin,
            rp_id,
            audience_origin: audience,
            user_id: None,
            handle: None,
            is_admin: None,
            created_at_ms: now,
            expires_at_ms: now + CHALLENGE_TTL_MS,
        };
        self.save_challenge(&challenge).await?;
        Ok(AuthResponse::json(200, json!({"publicKey":public_key})))
    }
    pub async fn login_finish(&self, request: &AuthRequest) -> Result<AuthResponse, GatewayError> {
        let raw = crate::upstream::parse_json_body(request, false)?;
        let response = raw
            .get("response")
            .filter(|v| v.is_object())
            .ok_or_else(|| invalid("Invalid passkey response"))?;
        let id = response
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| invalid("Invalid passkey response"))?;
        let client = client_data(response)?;
        let challenge_id = client
            .get("challenge")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("Invalid passkey response"))?;
        let challenge = self
            .consume_challenge(challenge_id, "authentication")
            .await?;
        let k = key("credentials", id);
        let row = self.store.read(&k).await?;
        let credential: PasskeyCredential = store::decode(row.as_ref(), self.host.now_ms())?
            .ok_or_else(|| invalid("Unknown passkey"))?;
        let user: PasskeyUser = store::decode(
            self.store
                .read(&key("users", &credential.user_id))
                .await?
                .as_ref(),
            self.host.now_ms(),
        )?
        .ok_or_else(unauthorized)?;
        let counter = crate::webauthn::verify_assertion(
            self.host,
            AssertionVerification {
                response: response.clone(),
                challenge: challenge.challenge,
                origin: challenge.origin,
                rp_id: challenge.rp_id,
                require_user_verification: user.is_admin,
                credential: credential.clone(),
            },
        )
        .await?;
        if (counter > 0 || credential.sign_count > 0) && counter <= credential.sign_count {
            return Err(invalid("Invalid passkey assertion"));
        }
        let mut next = credential.clone();
        next.sign_count = counter;
        if !store::commit(
            self.store,
            vec![store::check(&k, row.as_ref())],
            vec![store::put(k, &next, None, &self.revision()?)?],
        )
        .await?
        {
            return Err(conflict(
                "Passkey credential was modified concurrently; retry",
            ));
        }
        let session = self
            .create_session(credential.user_id, challenge.audience_origin)
            .await?;
        let relay = session.audience_origin.is_some();
        let mut body = json!({"user_id":user.id,"handle":user.handle,"credential_count":user.credential_ids.len(),"expires_at_ms":session.expires_at_ms});
        if relay {
            body["relay_session"] = json!(true);
        } else {
            body["token"] = json!(session.token);
        }
        let mut result = AuthResponse::json(200, body);
        if relay {
            result.set_cookies.push(format!(
                "{RELAY_COOKIE}={}; Path=/; Max-Age={}; HttpOnly; Secure; SameSite=None",
                session.token,
                (session.expires_at_ms - self.host.now_ms() + 999).max(0) / 1000
            ));
        }
        Ok(result)
    }
    pub async fn register_start(
        &self,
        request: &AuthRequest,
        authenticated_token: Option<&str>,
    ) -> Result<AuthResponse, GatewayError> {
        let raw = crate::upstream::parse_json_body(request, false)?;
        let token = authenticated_token
            .or_else(|| request.bearer())
            .unwrap_or("");
        let session = if token.is_empty() {
            None
        } else {
            self.session(request, authenticated_token).await?
        };
        if authenticated_token.is_some() && session.is_none() {
            return Err(unauthorized());
        }
        let handle = normalize_handle(raw.get("handle").and_then(Value::as_str).unwrap_or(""));
        let fallback = token_handle(token);
        let requested = if handle.is_empty() {
            None
        } else {
            self.user_by_handle(&handle).await?
        };
        let token_user = if fallback.is_empty() {
            None
        } else {
            self.user_by_handle(&fallback).await?
        };
        if requested.as_ref().is_some_and(|user| {
            session.as_ref().map(|s| &s.user.id) != Some(&user.id)
                && token_user.as_ref().map(|s| &s.id) != Some(&user.id)
        }) {
            return Err(conflict(
                "A passkey account already exists for this username",
            ));
        }
        let existing = session
            .as_ref()
            .map(|s| s.user.clone())
            .or(token_user)
            .or(requested);
        let user_id = match &existing {
            Some(user) => user.id.clone(),
            None => self.uuid()?,
        };
        let handle = session
            .as_ref()
            .map(|s| s.user.handle.clone())
            .filter(|s| !s.is_empty())
            .or((!handle.is_empty()).then_some(handle))
            .or((!fallback.is_empty()).then_some(fallback))
            .unwrap_or_else(|| token_handle(&user_id));
        let is_admin = existing.as_ref().is_none_or(|user| user.is_admin);
        let (origin, rp_id) = passkey_meta(
            request,
            raw.get("client_origin").and_then(Value::as_str),
            self.config,
        );
        let now = self.host.now_ms();
        let challenge = self.challenge()?;
        self.save_challenge(&PasskeyChallenge {
            challenge: challenge.clone(),
            kind: "registration".into(),
            origin,
            rp_id: rp_id.clone(),
            audience_origin: None,
            user_id: Some(user_id.clone()),
            handle: Some(handle.clone()),
            is_admin: Some(is_admin),
            created_at_ms: now,
            expires_at_ms: now + CHALLENGE_TTL_MS,
        })
        .await?;
        Ok(AuthResponse::json(
            200,
            json!({"publicKey":{"rp":{"id":rp_id,"name":"UbiquityOS AI Gateway"},"user":{"id":base64url(user_id.as_bytes()),"name":handle,"displayName":handle},"challenge":challenge,"pubKeyCredParams":[{"type":"public-key","alg":-7},{"type":"public-key","alg":-257}],"timeout":CHALLENGE_TTL_MS,"attestation":"none","authenticatorSelection":{"residentKey":"required","userVerification":if is_admin{"required"}else{"preferred"}},"excludeCredentials":existing.as_ref().map(|u|u.credential_ids.iter().map(|id|json!({"id":id,"type":"public-key"})).collect::<Vec<_>>()).unwrap_or_default()},"handle":handle}),
        ))
    }
    pub async fn register_finish(
        &self,
        request: &AuthRequest,
    ) -> Result<AuthResponse, GatewayError> {
        let raw = crate::upstream::parse_json_body(request, false)?;
        let response = raw
            .get("response")
            .filter(|v| v.is_object())
            .ok_or_else(|| invalid("Invalid passkey response"))?;
        let client = client_data(response)?;
        let challenge_id = client
            .get("challenge")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| invalid("Invalid passkey response"))?;
        let challenge = self.consume_challenge(challenge_id, "registration").await?;
        let user_id = challenge
            .user_id
            .ok_or_else(|| invalid("Invalid passkey challenge"))?;
        let handle = normalize_handle(challenge.handle.as_deref().unwrap_or(""));
        if handle.is_empty() {
            return Err(invalid("username is required"));
        }
        let verified = crate::webauthn::verify_registration(
            self.host,
            RegistrationVerification {
                response: response.clone(),
                challenge: challenge.challenge,
                origin: challenge.origin,
                rp_id: challenge.rp_id,
                require_user_verification: challenge.is_admin == Some(true),
            },
            self.host.now_ms(),
        )
        .await?;
        let uk = key("users", &user_id);
        let hk = key("handles", &handle);
        let ck = key("credentials", &verified.credential_id);
        let ur = self.store.read(&uk).await?;
        let hr = self.store.read(&hk).await?;
        let cr = self.store.read(&ck).await?;
        let claimed: Option<String> = store::decode(hr.as_ref(), self.host.now_ms())?;
        if claimed.as_ref().is_some_and(|id| id != &user_id) {
            return Err(conflict(
                "A passkey account already exists for this username",
            ));
        }
        let old: Option<PasskeyUser> = store::decode(ur.as_ref(), self.host.now_ms())?;
        let now = self.host.now_ms();
        let mut user = old.clone().unwrap_or(PasskeyUser {
            id: user_id.clone(),
            handle: handle.clone(),
            is_admin: challenge.is_admin == Some(true),
            credential_ids: Vec::new(),
            created_at_ms: now,
            updated_at_ms: now,
        });
        user.handle = handle;
        user.updated_at_ms = now;
        if !user.credential_ids.contains(&verified.credential_id) {
            user.credential_ids.push(verified.credential_id.clone());
        }
        let credential = PasskeyCredential {
            credential_id: verified.credential_id,
            user_id: user_id.clone(),
            public_key: base64url(&verified.public_key),
            sign_count: verified.sign_count,
            transports: verified.transports,
            created_at_ms: now,
        };
        let rev = self.revision()?;
        let mut checks = vec![
            store::check(&uk, ur.as_ref()),
            store::check(&hk, hr.as_ref()),
            store::check(&ck, cr.as_ref()),
        ];
        let mut writes = vec![
            store::put(uk, &user, None, &rev)?,
            store::put(hk, &user_id, None, &rev)?,
            store::put(ck, &credential, None, &rev)?,
        ];
        if let Some(old) = old.filter(|old| old.handle != user.handle) {
            let old_key = key("handles", &old.handle);
            let old_row = self.store.read(&old_key).await?;
            checks.push(store::check(&old_key, old_row.as_ref()));
            writes.push(RecordMutation::Delete { key: old_key });
        }
        if !store::commit(self.store, checks, writes).await? {
            return Err(conflict("Passkey account was modified concurrently; retry"));
        }
        let session = self.create_session(user_id, None).await?;
        Ok(AuthResponse::json(
            200,
            json!({"token":session.token,"user_id":user.id,"handle":user.handle,"credential_count":user.credential_ids.len(),"expires_at_ms":session.expires_at_ms}),
        ))
    }
    pub async fn session_response(
        &self,
        request: &AuthRequest,
        override_token: Option<&str>,
    ) -> Result<AuthResponse, GatewayError> {
        let view = self
            .session(request, override_token)
            .await?
            .ok_or_else(unauthorized)?;
        Ok(AuthResponse::json(
            200,
            json!({"user":{"id":view.user.id,"handle":view.user.handle,"is_admin":view.user.is_admin,"credential_count":view.user.credential_ids.len()},"session":{"created_at_ms":view.session.created_at_ms,"expires_at_ms":view.session.expires_at_ms}}),
        ))
    }
    pub async fn logout(
        &self,
        request: &AuthRequest,
        override_token: Option<&str>,
    ) -> Result<AuthResponse, GatewayError> {
        if let Some(view) = self.session(request, override_token).await? {
            let k = key("sessions", &view.session.token);
            let row = self.store.read(&k).await?;
            if !self
                .delete_session(&view.session.token, row.as_ref())
                .await?
            {
                return Err(conflict(
                    "Passkey session was modified concurrently; retry logout",
                ));
            }
        }
        let mut response = AuthResponse::json(204, Value::Null);
        response.set_cookies.push(format!(
            "{RELAY_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None"
        ));
        Ok(response)
    }
}

pub fn client_data(response: &Value) -> Result<Value, GatewayError> {
    let encoded = response
        .get("response")
        .and_then(|v| v.get("clientDataJSON"))
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("Invalid passkey response"))?;
    let bytes = decode_base64url(encoded).map_err(|_| invalid("Invalid passkey response"))?;
    serde_json::from_slice(&bytes).map_err(|_| invalid("Invalid passkey response"))
}

#[cfg(test)]
#[path = "../tests/session_index_cases/mod.rs"]
mod session_index_cases;
