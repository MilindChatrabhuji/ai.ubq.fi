//! Native-only source import body data. No admission, store, validation or effect.
use gateway_core::{
    js_string::JsString16, source_json::SourceJson, source_serialization as source,
};

pub const AUTH_MAX_BYTES: usize = 32 * 1024 * 1024;
#[cfg(unix)]
pub const PROFILE_MAX_BYTES: usize = 5 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AuthReadFailure {
    Empty,
    Invalid,
    TooLarge,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BodyError {
    AuthBody,
    #[cfg(unix)]
    ProfileSelector,
    #[cfg(unix)]
    ProfileTooLarge,
    #[cfg(unix)]
    ProfileWriteConflict,
}
impl BodyError {
    pub fn status(self) -> u16 {
        match self {
            Self::AuthBody => 400,
            #[cfg(unix)]
            Self::ProfileTooLarge => 413,
            #[cfg(unix)]
            Self::ProfileSelector | Self::ProfileWriteConflict => 400,
        }
    }
    pub fn message(self) -> &'static str {
        match self {
            Self::AuthBody => "Body does not look like a Codex auth.json",
            #[cfg(unix)]
            Self::ProfileSelector => "profile must be local or prod",
            #[cfg(unix)]
            Self::ProfileTooLarge => "Migration body is too large",
            #[cfg(unix)]
            Self::ProfileWriteConflict => "dry_run and write are mutually exclusive",
        }
    }
    pub fn code(self) -> &'static str {
        "invalid_request_error"
    }
}

/// This is the existing Request.text()/TextDecoder boundary, not source-string
/// normalization. Escaped JSON lone units remain inside SourceJson unchanged.
fn request_text(raw: &[u8]) -> String {
    String::from_utf8_lossy(raw.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(raw)).into_owned()
}

/// The same source header guard serves guarded ingress and the one decoder.
pub(crate) fn check_auth_content_length(
    content_length: Option<&str>,
) -> Result<(), AuthReadFailure> {
    if let Some(length) = content_length {
        if length.is_empty()
            || (length.len() > 1 && length.starts_with('0'))
            || !length.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(AuthReadFailure::Invalid);
        }
        let length = length
            .parse::<u64>()
            .ok()
            .filter(|n| *n <= 9_007_199_254_740_991)
            .ok_or(AuthReadFailure::Invalid)?;
        if length > AUTH_MAX_BYTES as u64 {
            return Err(AuthReadFailure::TooLarge);
        }
    }
    Ok(())
}

pub fn read_auth_json(
    raw: &[u8],
    content_length: Option<&str>,
) -> Result<SourceJson, AuthReadFailure> {
    check_auth_content_length(content_length)?;
    if raw.len() > AUTH_MAX_BYTES {
        return Err(AuthReadFailure::TooLarge);
    }
    if raw.is_empty() {
        return Err(AuthReadFailure::Empty);
    }
    let text = request_text(raw);
    SourceJson::parse(text.trim_matches(|c| matches!(c, ' ' | '\n' | '\r' | '\t')))
        .map_err(|_| AuthReadFailure::Invalid)
}

/// Deliberately no Debug/Serialize/Clone for a credential-bearing result.
pub struct AuthBody<'a> {
    raw: &'a [u8],
    auth: SourceJson,
    client_version: Option<JsString16>,
}
impl AuthBody<'_> {
    pub fn raw_body(&self) -> &[u8] {
        self.raw
    }
    pub fn auth(&self) -> &SourceJson {
        &self.auth
    }
    pub fn client_version(&self) -> Option<&JsString16> {
        self.client_version.as_ref()
    }
}
pub fn decode_auth<'a>(
    raw: &'a [u8],
    content_length: Option<&str>,
) -> Result<AuthBody<'a>, BodyError> {
    let document = read_auth_json(raw, content_length).map_err(|_| BodyError::AuthBody)?;
    let auth = source::member(&document, "auth").unwrap_or_else(|| document.clone());
    if source::member(&auth, "auth_mode")
        .as_ref()
        .and_then(source::string)
        .is_some_and(|mode| {
            mode.as_units()
                .iter()
                .copied()
                .eq("chatgptAuthTokens".encode_utf16())
        })
    {
        return Err(BodyError::AuthBody);
    }
    let tokens = source::member(&auth, "tokens").ok_or(BodyError::AuthBody)?;
    for name in ["access_token", "refresh_token", "account_id"] {
        if !source::member(&tokens, name)
            .as_ref()
            .and_then(source::string)
            .is_some_and(|text| !text.as_units().is_empty())
        {
            return Err(BodyError::AuthBody);
        }
    }
    let client_version = source::member(&document, "models").and_then(|models| {
        source::member(&models, "client_version")
            .as_ref()
            .and_then(source::string)
            .or_else(|| {
                source::member(&models, "clientVersion")
                    .as_ref()
                    .and_then(source::string)
            })
    });
    Ok(AuthBody {
        raw,
        auth,
        client_version,
    })
}

// PROFILE has no authorized live projection/consumer in the current native scope.
#[cfg(unix)]
#[doc(hidden)]
pub mod profile {
    use super::*;

    fn js_space(value: char) -> bool {
        matches!(value, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
        | '\u{205f}' | '\u{3000}' | '\u{feff}')
    }
    fn trim(value: &str) -> &str {
        value.trim_matches(js_space)
    }
    /// Source Number on this one HTTP header. NaN/infinities are not a finite
    /// declared-size rejection; unsigned radix forms and decimal/exponent forms
    /// retain their source meaning. No whole-document numeric projection occurs.
    fn declared_profile_number(raw: &str) -> Option<f64> {
        let value = trim(raw);
        if value.is_empty() {
            return Some(0.0);
        }
        let radix = if value.starts_with("0x") || value.starts_with("0X") {
            Some(16)
        } else if value.starts_with("0b") || value.starts_with("0B") {
            Some(2)
        } else if value.starts_with("0o") || value.starts_with("0O") {
            Some(8)
        } else {
            None
        };
        if let Some(radix) = radix {
            if value.len() == 2 {
                return None;
            }
            let mut number = 0.0;
            for digit in value[2..].chars() {
                number = number * f64::from(radix) + f64::from(digit.to_digit(radix)?);
            }
            Some(number)
        } else {
            value.parse::<f64>().ok()
        }
    }
    fn first(query: &str, name: &str) -> Option<String> {
        url::form_urlencoded::parse(query.strip_prefix('?').unwrap_or(query).as_bytes())
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    }
    fn boolean(query: &str, name: &str) -> Option<bool> {
        let value = first(query, name)?;
        let value = trim(&value);
        if ["1", "true", "yes", "on"]
            .iter()
            .any(|name| value.eq_ignore_ascii_case(name))
        {
            Some(true)
        } else if ["0", "false", "no", "off"]
            .iter()
            .any(|name| value.eq_ignore_ascii_case(name))
        {
            Some(false)
        } else {
            None
        }
    }
    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub struct ProfileOptions {
        pub profile: &'static str,
        pub include_cache: bool,
        pub include_legacy: bool,
        pub overwrite: bool,
        pub dry_run: bool,
    }
    /// Non-authoritative pre-body field data. Only profile/declared size are read.
    pub struct ProfileBodyPlan<'a> {
        query: &'a str,
        profile: &'static str,
    }
    pub fn profile_plan<'a>(
        query: &'a str,
        content_length: Option<&str>,
    ) -> Result<ProfileBodyPlan<'a>, BodyError> {
        let selected = first(query, "profile");
        let profile = match selected.as_deref().map(trim) {
            Some("local") => "local",
            None | Some("" | "prod") => "prod",
            _ => return Err(BodyError::ProfileSelector),
        };
        if content_length
            .and_then(declared_profile_number)
            .is_some_and(|n| n.is_finite() && n > PROFILE_MAX_BYTES as f64)
        {
            return Err(BodyError::ProfileTooLarge);
        }
        Ok(ProfileBodyPlan { query, profile })
    }
    impl ProfileBodyPlan<'_> {
        pub fn profile(&self) -> &'static str {
            self.profile
        }
        pub fn decode<'a>(&self, raw: &'a [u8]) -> Result<ProfileBody<'a>, BodyError> {
            let text = request_text(raw);
            if text.len() > PROFILE_MAX_BYTES {
                return Err(BodyError::ProfileTooLarge);
            }
            let write = boolean(self.query, "write") == Some(true);
            let dry_run = boolean(self.query, "dry_run");
            if write && dry_run == Some(true) {
                return Err(BodyError::ProfileWriteConflict);
            }
            let options = ProfileOptions {
                profile: self.profile,
                include_cache: boolean(self.query, "include_cache") == Some(true),
                include_legacy: boolean(self.query, "include_legacy")
                    .unwrap_or(self.profile == "local"),
                overwrite: boolean(self.query, "overwrite") == Some(true),
                dry_run: !write,
            };
            Ok(ProfileBody { raw, text, options })
        }
    }
    /// Deliberately no Debug/Serialize/Clone for native profile/refresh-bearing text.
    pub struct ProfileBody<'a> {
        raw: &'a [u8],
        text: String,
        options: ProfileOptions,
    }
    impl ProfileBody<'_> {
        pub fn raw_body(&self) -> &[u8] {
            self.raw
        }
        pub fn text(&self) -> &str {
            &self.text
        }
        pub fn options(&self) -> &ProfileOptions {
            &self.options
        }
    }
}
