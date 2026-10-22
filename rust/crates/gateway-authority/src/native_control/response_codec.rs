//! Read each fence from the original deserializer, never Serde's buffered Content.
//! Its source-preserving context decoder needs serde_json's raw token support.
use super::{NativeRenewalAuthorityResponse as Response, NativeRenewalFence, NativeRenewalMode};
use serde::{
    Deserialize, Deserializer,
    de::{Error, MapAccess, Visitor},
};
use std::fmt;

const ALL: &[&str] = &[
    "operation",
    "v",
    "action_ref",
    "operation_id",
    "claim_ref",
    "start_permit",
    "publication_revision",
    "mode",
    "deadline_ms",
    "fence",
];
#[derive(Default)]
struct Fields {
    operation: Option<String>,
    v: Option<u8>,
    action_ref: Option<String>,
    operation_id: Option<String>,
    claim_ref: Option<String>,
    start_permit: Option<Option<String>>,
    publication_revision: Option<Option<String>>,
    mode: Option<NativeRenewalMode>,
    deadline_ms: Option<i64>,
    fence: Option<NativeRenewalFence>,
}
fn set<T, E: Error>(slot: &mut Option<T>, value: T, name: &'static str) -> Result<(), E> {
    if slot.replace(value).is_some() {
        return Err(E::duplicate_field(name));
    }
    Ok(())
}
fn take<T, E: Error>(value: Option<T>, name: &'static str) -> Result<T, E> {
    value.ok_or_else(|| E::missing_field(name))
}
impl Fields {
    fn reject_extra<E: Error>(&self, allowed: &'static [&'static str]) -> Result<(), E> {
        for (key, present) in [
            ("action_ref", self.action_ref.is_some()),
            ("operation_id", self.operation_id.is_some()),
            ("claim_ref", self.claim_ref.is_some()),
            ("start_permit", self.start_permit.is_some()),
            ("publication_revision", self.publication_revision.is_some()),
            ("mode", self.mode.is_some()),
            ("deadline_ms", self.deadline_ms.is_some()),
            ("fence", self.fence.is_some()),
        ] {
            if present && !allowed.contains(&key) {
                return Err(E::unknown_field(key, allowed));
            }
        }
        Ok(())
    }
    fn finish<E: Error>(mut self) -> Result<Response, E> {
        let operation = take(self.operation.take(), "operation")?;
        let v = take(self.v.take(), "v")?;
        match operation.as_str() {
            "claim" => {
                self.reject_extra::<E>(ALL)?;
                Ok(Response::Claim {
                    v,
                    action_ref: take(self.action_ref, "action_ref")?,
                    operation_id: take(self.operation_id, "operation_id")?,
                    claim_ref: take(self.claim_ref, "claim_ref")?,
                    start_permit: self.start_permit.flatten(),
                    publication_revision: self.publication_revision.flatten(),
                    mode: take(self.mode, "mode")?,
                    deadline_ms: take(self.deadline_ms, "deadline_ms")?,
                    fence: take(self.fence, "fence")?,
                })
            }
            "start" => {
                self.reject_extra::<E>(&["mode"])?;
                Ok(Response::Start {
                    v,
                    mode: take(self.mode, "mode")?,
                })
            }
            "recheck" => {
                self.reject_extra::<E>(&["fence"])?;
                Ok(Response::Recheck {
                    v,
                    fence: take(self.fence, "fence")?,
                })
            }
            "published" => {
                self.reject_extra::<E>(&["publication_revision"])?;
                Ok(Response::Published {
                    v,
                    publication_revision: take(
                        self.publication_revision.flatten(),
                        "publication_revision",
                    )?,
                })
            }
            "unknown" => {
                self.reject_extra::<E>(&[])?;
                Ok(Response::Unknown { v })
            }
            _ => Err(E::unknown_variant(
                &operation,
                &["claim", "start", "recheck", "published", "unknown"],
            )),
        }
    }
}
impl<'de> Deserialize<'de> for Response {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ResponseVisitor;
        impl<'de> Visitor<'de> for ResponseVisitor {
            type Value = Response;
            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a fixed native renewal authority response object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Response, A::Error> {
                let mut fields = Fields::default();
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "operation" => set(&mut fields.operation, map.next_value()?, "operation")?,
                        "v" => set(&mut fields.v, map.next_value()?, "v")?,
                        "action_ref" => {
                            set(&mut fields.action_ref, map.next_value()?, "action_ref")?
                        }
                        "operation_id" => {
                            set(&mut fields.operation_id, map.next_value()?, "operation_id")?
                        }
                        "claim_ref" => set(&mut fields.claim_ref, map.next_value()?, "claim_ref")?,
                        "start_permit" => {
                            set(&mut fields.start_permit, map.next_value()?, "start_permit")?
                        }
                        "publication_revision" => set(
                            &mut fields.publication_revision,
                            map.next_value()?,
                            "publication_revision",
                        )?,
                        "mode" => set(&mut fields.mode, map.next_value()?, "mode")?,
                        "deadline_ms" => {
                            set(&mut fields.deadline_ms, map.next_value()?, "deadline_ms")?
                        }
                        "fence" => set(&mut fields.fence, map.next_value()?, "fence")?,
                        _ => return Err(A::Error::unknown_field(&key, ALL)),
                    }
                }
                fields.finish()
            }
        }
        deserializer.deserialize_map(ResponseVisitor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_control::NativeRenewalContext;
    use gateway_core::{js_string::JsString16, model::ModelId};

    fn fence() -> NativeRenewalFence {
        NativeRenewalFence {
            v: 2,
            owner_id: "owner".into(),
            owner_epoch: "epoch".into(),
            owner_revision: "revision".into(),
            native_owner_id: "native-owner".into(),
            source_revision: "source-r1".into(),
            normalized_revision: "normalized-r1".into(),
            account_id_hash: "hash".into(),
            credential_version: "opaque-access".into(),
            source_native_generation: "opaque-native".into(),
            access_generation: "opaque-access".into(),
            access_expires_at_ms: None,
            native_refreshed_at: None,
            principal: "principal".into(),
            principal_policy_digest: "digest".into(),
            original_request_id: "request".into(),
            context: NativeRenewalContext::LiveMapped {
                call_id: "call".into(),
                mapping_revision: "mapping".into(),
            },
        }
    }
    #[test]
    fn actual_fence_decodes_direct_and_in_original_response_with_source_model_tokens() {
        for units in [
            vec![0xd800],
            vec![0xdc00],
            vec![0xfffd],
            vec![0xd83d, 0xde80],
            vec![0, 10, 34, 92],
            r"\ud800".encode_utf16().collect(),
            vec![u16::from(b'm'); 4097],
        ] {
            let mut expected = fence();
            expected.context = NativeRenewalContext::Inference {
                attempt_id: "attempt".into(),
                original_admission_digest: "admission".into(),
                model: ModelId::from_source(JsString16::from_units(units)),
                slot: 1,
            };
            let bytes = serde_json::to_vec(&expected).unwrap();
            assert_eq!(
                serde_json::from_slice::<NativeRenewalFence>(&bytes).unwrap(),
                expected
            );
            for body in [
                format!(
                    r#"{{"operation":"recheck","v":1,"fence":{}}}"#,
                    std::str::from_utf8(&bytes).unwrap()
                ),
                format!(
                    r#"{{"fence":{},"v":1,"operation":"recheck"}}"#,
                    std::str::from_utf8(&bytes).unwrap()
                ),
            ] {
                let Response::Recheck { v: 1, fence } = serde_json::from_str(&body).unwrap() else {
                    panic!("original recheck response");
                };
                assert_eq!(fence, expected);
                assert_eq!(
                    serde_json::to_vec(&Response::Recheck { v: 1, fence }).unwrap(),
                    [
                        br#"{"operation":"recheck","v":1,"fence":"#.as_slice(),
                        &bytes,
                        b"}"
                    ]
                    .concat()
                );
            }
        }
    }
    #[test]
    fn response_variants_and_nullable_claim_fields_keep_exact_serialization() {
        for body in [
            r#"{"operation":"start","v":1,"mode":"renew_once"}"#,
            r#"{"operation":"published","v":1,"publication_revision":"r1"}"#,
            r#"{"operation":"unknown","v":1}"#,
        ] {
            let response: Response = serde_json::from_str(body).unwrap();
            assert_eq!(serde_json::to_string(&response).unwrap(), body);
        }
        let raw = serde_json::to_string(&fence()).unwrap();
        let body = format!(
            r#"{{"operation":"claim","v":1,"action_ref":"action","operation_id":"operation","claim_ref":"claim","start_permit":null,"publication_revision":null,"mode":"reconcile_only","deadline_ms":123,"fence":{raw}}}"#
        );
        let response: Response = serde_json::from_str(&body).unwrap();
        assert_eq!(serde_json::to_string(&response).unwrap(), body);
        // Existing Option fields accept omission as well as an explicit null.
        let absent = body
            .replace(",\"start_permit\":null", "")
            .replace(",\"publication_revision\":null", "");
        assert!(matches!(
            serde_json::from_str::<Response>(&absent).unwrap(),
            Response::Claim {
                start_permit: None,
                publication_revision: None,
                ..
            }
        ));
    }
    #[test]
    fn response_missing_duplicate_unknown_cross_variant_null_and_bad_fence_versions_refuse() {
        let raw = serde_json::to_string(&fence()).unwrap();
        let valid = format!(r#"{{"operation":"recheck","v":1,"fence":{raw}}}"#);
        for body in [
            "null".into(),
            "[]".into(),
            r#"{"operation":"unknown"}"#.into(),
            r#"{"v":1}"#.into(),
            r#"{"operation":"other","v":1}"#.into(),
            r#"{"operation":"unknown","operation":"unknown","v":1}"#.into(),
            r#"{"operation":"unknown","v":1,"v":1}"#.into(),
            r#"{"operation":"unknown","v":null}"#.into(),
            r#"{"operation":"unknown","v":256}"#.into(),
            r#"{"operation":"unknown","v":1,"extra":null}"#.into(),
            r#"{"operation":"unknown","v":1,"start_permit":null}"#.into(),
            r#"{"operation":"start","v":1,"mode":null}"#.into(),
            r#"{"operation":"start","v":1}"#.into(),
            r#"{"operation":"recheck","v":1,"fence":null}"#.into(),
            r#"{"operation":"published","v":1,"publication_revision":null}"#.into(),
            format!(r#"{{"operation":"recheck","v":1,"fence":{raw},"fence":{raw}}}"#),
            valid.replacen("\"v\":2", "\"v\":1", 1),
            valid.replace("\"access_expires_at_ms\":null,", ""),
            valid.replace("\"native_refreshed_at\":null,", ""),
            valid.replace("\"fence\":", "\"mode\":\"renew_once\",\"fence\":"),
        ] {
            assert!(serde_json::from_str::<Response>(&body).is_err(), "{body}");
        }
    }
}
