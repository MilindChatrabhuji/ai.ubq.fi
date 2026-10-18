//! Registry-bound Unix websocket adapter. This module never launches a process or refreshes OAuth itself.
use std::{cell::RefCell,collections::BTreeMap,fs,net::Shutdown,os::unix::net::UnixStream,path::{Path,PathBuf},time::{Duration,Instant}};

use gateway_core::GatewayError;
use serde_json::{Value,json};
use tungstenite::{Message,WebSocket,client::{IntoClientRequest,client_with_config},protocol::WebSocketConfig};

use crate::{NativeCredentials,NativeOwnerId,NativeOwnerTransport,RenewalStep,SupervisorMethod,SupervisorTransport,owner_unavailable,parse_native_document,supervisor::{RENEWAL_FRAME_LIMIT,SUPERVISOR_FRAME_LIMIT}};

struct Socket{socket:WebSocket<UnixStream>,serial:u64,call_timeout:Duration}
impl Socket{
    fn open(path:&Path,max_payload:usize,call_timeout:Duration)->Result<Self,GatewayError>{
        let stream=UnixStream::connect(path).map_err(|_|owner_unavailable())?;
        stream.set_read_timeout(Some(Duration::from_secs(3))).map_err(|_|owner_unavailable())?;stream.set_write_timeout(Some(Duration::from_secs(3))).map_err(|_|owner_unavailable())?;
        let mut request="ws://localhost/".into_client_request().map_err(|_|owner_unavailable())?;
        request.headers_mut().insert("host",tungstenite::http::HeaderValue::from_static("localhost"));
        // No Sec-WebSocket-Extensions offer: permessage-deflate stays disabled.
        let config=WebSocketConfig::default().max_message_size(Some(max_payload)).max_frame_size(Some(max_payload));
        let(socket,_)=client_with_config(request,stream,Some(config)).map_err(|_|owner_unavailable())?;
        Ok(Self{socket,serial:0,call_timeout})
    }
    fn notify_initialized(&mut self)->Result<(),GatewayError>{self.socket.send(Message::Text(json!({"method":"initialized"}).to_string().into())).map_err(|_|owner_unavailable())}
    fn call(&mut self,method:&str,params:Value)->Result<Value,GatewayError>{
        self.serial=self.serial.checked_add(1).ok_or_else(owner_unavailable)?;let id=self.serial;
        let deadline=Instant::now()+self.call_timeout;
        self.socket.get_mut().set_read_timeout(Some(self.call_timeout)).map_err(|_|owner_unavailable())?;self.socket.get_mut().set_write_timeout(Some(self.call_timeout)).map_err(|_|owner_unavailable())?;
        self.socket.send(Message::Text(json!({"id":id,"method":method,"params":params}).to_string().into())).map_err(|_|owner_unavailable())?;
        loop{
            let remaining=deadline.saturating_duration_since(Instant::now());if remaining.is_zero(){return Err(owner_unavailable());}
            self.socket.get_mut().set_read_timeout(Some(remaining)).map_err(|_|owner_unavailable())?;
            let message=self.socket.read().map_err(|_|owner_unavailable())?;
            let text=match message{Message::Text(text)=>text.to_string(),Message::Binary(bytes)=>String::from_utf8(bytes.to_vec()).map_err(|_|owner_unavailable())?,Message::Ping(_)=>{self.socket.flush().map_err(|_|owner_unavailable())?;continue;},Message::Close(_)=>return Err(owner_unavailable()),_=>continue};
            let Ok(reply)=serde_json::from_str::<Value>(&text)else{continue;};if reply.get("id").and_then(Value::as_u64)!=Some(id){continue;}
            if reply.get("error").is_some(){return Err(owner_unavailable());}return Ok(reply.get("result").cloned().unwrap_or(Value::Null));
        }
    }
    fn close(&mut self){let grace=Duration::from_millis(250);let _=self.socket.get_mut().set_read_timeout(Some(grace));let _=self.socket.get_mut().set_write_timeout(Some(grace));let _=self.socket.close(None);let _=self.socket.flush();let _=self.socket.read();let _=self.socket.get_mut().shutdown(Shutdown::Both);}
}
impl Drop for Socket{fn drop(&mut self){let _=self.socket.get_mut().shutdown(Shutdown::Both);}}

/// Constructed only from local operator-owned configuration, never HTTP payloads.
#[derive(Clone,Debug)]
pub struct NativeOwnerLocation{pub owner:NativeOwnerId,home:PathBuf}
impl NativeOwnerLocation{
    pub fn configured(owner:NativeOwnerId,home:PathBuf)->Result<Self,GatewayError>{if !home.is_absolute()||owner.0.is_empty(){return Err(owner_unavailable());}Ok(Self{owner,home})}
}

pub struct UnixOwnerTransport{locations:BTreeMap<String,PathBuf>,sockets:RefCell<BTreeMap<String,Socket>>}
impl UnixOwnerTransport{
    pub fn new(locations:Vec<NativeOwnerLocation>)->Result<Self,GatewayError>{
        if locations.len()>2{return Err(owner_unavailable());}let mut homes=BTreeMap::new();
        for location in locations{if homes.insert(location.owner.0,location.home).is_some(){return Err(owner_unavailable());}}
        Ok(Self{locations:homes,sockets:RefCell::new(BTreeMap::new())})
    }
    fn home(&self,owner:&NativeOwnerId)->Result<&PathBuf,GatewayError>{self.locations.get(&owner.0).ok_or_else(owner_unavailable)}
}

impl NativeOwnerTransport for UnixOwnerTransport{
    async fn read_credentials(&self,owner:&NativeOwnerId)->Result<NativeCredentials,GatewayError>{
        let home=self.home(owner)?;let path=home.join("auth.json");let metadata=fs::metadata(&path).map_err(|_|owner_unavailable())?;if !metadata.is_file()||metadata.len()>1_048_576{return Err(owner_unavailable());}
        let bytes=fs::read(path).map_err(|_|owner_unavailable())?;let value=serde_json::from_slice(&bytes).map_err(|_|owner_unavailable())?;parse_native_document(&value)
    }
    async fn request(&self,owner:&NativeOwnerId,step:RenewalStep)->Result<Value,GatewayError>{
        let home=self.home(owner)?;let mut sockets=self.sockets.borrow_mut();
        if step==RenewalStep::Initialize{
            if let Some(mut old)=sockets.remove(&owner.0){old.close();}
            let socket=Socket::open(&home.join("app-server-control/app-server-control.sock"),RENEWAL_FRAME_LIMIT,Duration::from_secs(12))?;sockets.insert(owner.0.clone(),socket);
        }
        let socket=sockets.get_mut(&owner.0).ok_or_else(owner_unavailable)?;let(method,params)=step.wire();socket.call(method,params)
    }
    async fn verify_initialized_home(&self,owner:&NativeOwnerId,reply:&Value)->Result<(),GatewayError>{
        let configured=fs::canonicalize(self.home(owner)?).map_err(|_|owner_unavailable())?;let reported=reply.get("codexHome").and_then(Value::as_str).ok_or_else(owner_unavailable)?;
        if fs::canonicalize(reported).map_err(|_|owner_unavailable())?!=configured{return Err(owner_unavailable());}Ok(())
    }
    async fn initialized(&self,owner:&NativeOwnerId)->Result<(),GatewayError>{self.sockets.borrow_mut().get_mut(&owner.0).ok_or_else(owner_unavailable)?.notify_initialized()}
    async fn close(&self,owner:&NativeOwnerId)->Result<(),GatewayError>{if let Some(mut socket)=self.sockets.borrow_mut().remove(&owner.0){socket.close();}Ok(())}
}

pub struct UnixSupervisor{socket:Socket}
impl UnixSupervisor{
    /// Path comes only from the trusted native source registry, never a public request.
    pub fn configured_socket(path:&Path)->Result<Self,GatewayError>{
        if !path.is_absolute(){return Err(owner_unavailable());}
        let mut socket=Socket::open(path,SUPERVISOR_FRAME_LIMIT,Duration::from_secs(4))?;
        socket.call(SupervisorMethod::Initialize.as_str(),json!({"clientInfo":{"name":"uos_supervisor","version":"1"},"capabilities":{"experimentalApi":true}}))?;socket.notify_initialized()?;Ok(Self{socket})
    }
}
impl SupervisorTransport for UnixSupervisor{
    async fn call(&mut self,method:SupervisorMethod,params:Value)->Result<Value,GatewayError>{self.socket.call(method.as_str(),params)}
    async fn close(&mut self)->Result<(),GatewayError>{self.socket.close();Ok(())}
}
