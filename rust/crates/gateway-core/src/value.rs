//! Explicit tree value codec. Type metadata belongs to the record, never to guessed JSON shapes.
use serde::{Deserialize,Serialize};
use serde_json::{Value,json};
use crate::GatewayError;

#[derive(Clone,Copy,Debug,Default,Deserialize,Eq,PartialEq,Serialize)]
pub enum ValueEncoding {
    #[default]
    #[serde(rename="json")]
    Json,
    #[serde(rename="profile-v1")]
    ProfileV1,
}

/// Number bits and integer decimal strings avoid JSON numeric coercion.
/// Binary views retain their entire backing buffer and original view coordinates.
#[derive(Clone,Debug,Deserialize,PartialEq,Serialize)]
#[serde(tag="type",content="value",rename_all="snake_case",deny_unknown_fields)]
pub enum PortableValue {
    Undefined, Null, Boolean(bool), String(String), NumberBits(String), BigInt(String), KvU64(String),
    Binary { kind:String, bytes:Vec<u8>, byte_offset:u64, byte_length:u64 },
    Date { epoch_ms:Option<i64> },
    RegExp { source:String, flags:String },
    Array(Vec<Self>), Object(Vec<(String,Self)>), Map(Vec<(Self,Self)>), Set(Vec<Self>),
    Error { kind:String, message:String, stack:Option<String>, cause:Option<Box<Self>> },
}

impl PortableValue {
    pub fn number(value:f64)->Self {Self::NumberBits(format!("{:016x}",value.to_bits()))}
    pub fn from_json(value:&Value)->Self {
        match value {
            Value::Null=>Self::Null,Value::Bool(v)=>Self::Boolean(*v),Value::String(v)=>Self::String(v.clone()),
            Value::Number(v)=>Self::number(v.as_f64().unwrap_or(f64::NAN)),
            Value::Array(v)=>Self::Array(v.iter().map(Self::from_json).collect()),
            Value::Object(v)=>Self::Object(v.iter().map(|(k,v)|(k.clone(),Self::from_json(v))).collect()),
        }
    }
    pub fn number_value(&self)->Option<f64> {
        let Self::NumberBits(bits)=self else{return None;};
        if bits.len()!=16 || !bits.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)){return None;}
        u64::from_str_radix(bits,16).ok().map(f64::from_bits)
    }
    pub fn to_json_lossless(&self)->Option<Value>{
        match self {
            Self::Null=>Some(Value::Null),Self::Boolean(v)=>Some(json!(v)),Self::String(v)=>Some(json!(v)),
            Self::NumberBits(_)=>self.number_value().filter(|v|v.is_finite()&&!(*v==0.0&&v.is_sign_negative())).map(|v|if v.fract()==0.0&&v.abs()<=9_007_199_254_740_991.0{json!(v as i64)}else{json!(v)}),
            Self::Array(items)=>items.iter().map(Self::to_json_lossless).collect::<Option<Vec<_>>>().map(Value::Array),
            Self::Object(items)=>items.iter().map(|(k,v)|Some((k.clone(),v.to_json_lossless()?))).collect::<Option<serde_json::Map<_,_>>>().map(Value::Object),
            _=>None,
        }
    }
    pub fn validate(&self)->Result<(),GatewayError>{
        let bad=||GatewayError::unavailable("The typed value payload is malformed.","portable_value_invalid");
        match self {
            Self::NumberBits(_)=>{if self.number_value().is_none(){return Err(bad());}},
            Self::BigInt(v)|Self::KvU64(v)=>{
                let digits=v.strip_prefix('-').unwrap_or(v);
                if digits.is_empty()||!digits.bytes().all(|b|b.is_ascii_digit())||(digits.len()>1&&digits.starts_with('0'))||v=="-0"{return Err(bad());}
                if matches!(self,Self::KvU64(_))&&v.parse::<u64>().is_err(){return Err(bad());}
            },
            Self::Binary{kind,bytes,byte_offset,byte_length}=>{
                let alignment=match kind.as_str(){"ArrayBuffer"|"DataView"|"Int8Array"|"Uint8Array"|"Uint8ClampedArray"=>1,"Int16Array"|"Uint16Array"=>2,"Int32Array"|"Uint32Array"|"Float32Array"=>4,"Float64Array"|"BigInt64Array"|"BigUint64Array"=>8,_=>return Err(bad())};
                if byte_offset.checked_add(*byte_length).is_none_or(|end|end>bytes.len() as u64)||!byte_offset.is_multiple_of(alignment)||!byte_length.is_multiple_of(alignment)||(kind=="ArrayBuffer"&&(*byte_offset!=0||*byte_length!=bytes.len() as u64)){return Err(bad());}
            },
            Self::Date{epoch_ms:Some(v)} if v.unsigned_abs()>8_640_000_000_000_000=>return Err(bad()),
            Self::RegExp{flags,..}=>{
                let mut seen=std::collections::BTreeSet::new();
                for flag in flags.chars(){if !"dgimsuvy".contains(flag)||!seen.insert(flag){return Err(bad());}}
                if seen.contains(&'u')&&seen.contains(&'v'){return Err(bad());}
            },
            Self::Array(items)|Self::Set(items)=>for item in items{item.validate()?;},
            Self::Object(items)=>{let mut seen=std::collections::BTreeSet::new();for (key,item) in items{if !seen.insert(key){return Err(bad());}item.validate()?;}},
            Self::Map(items)=>for (key,value) in items{key.validate()?;value.validate()?;},
            Self::Error{kind,cause,..}=>{if !["Error","EvalError","RangeError","ReferenceError","SyntaxError","TypeError","URIError"].contains(&kind.as_str()){return Err(bad());}if let Some(cause)=cause{cause.validate()?;}},
            _=>{},
        }
        Ok(())
    }
    /// Source Bun storage refuses Error.cause anywhere in the graph.
    pub fn validate_for_storage(&self)->Result<(),GatewayError>{
        self.validate()?;
        match self {
            Self::Error{cause:Some(_),..}=>return Err(GatewayError::unavailable("Bun KV cannot preserve Error.cause; persist an explicit error record instead","portable_value_cause_unsupported")),
            Self::Array(v)|Self::Set(v)=>for item in v{item.validate_for_storage()?;},
            Self::Object(v)=>for (_,item) in v{item.validate_for_storage()?;},
            Self::Map(v)=>for (key,item) in v{key.validate_for_storage()?;item.validate_for_storage()?;},
            _=>{},
        }
        Ok(())
    }
}
