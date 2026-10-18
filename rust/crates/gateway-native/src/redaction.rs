//! Conservative credential span sanitization. Redaction happens before clipping or external transfer.

#[derive(Clone,Debug,Eq,PartialEq)]
pub struct RedactedText{pub text:String,pub redactions:usize}

fn is_word(byte:u8)->bool{byte.is_ascii_alphanumeric()||byte==b'_'}
fn quoted_end(bytes:&[u8],start:usize)->Option<usize>{
    let quote=bytes[start];let mut index=start+1;
    while index<bytes.len(){if bytes[index]==b'\\'{index+=2;continue;}if bytes[index]==quote{return Some(index+1);}index+=1;}None
}

fn spans(text:&str,closed_only:bool)->Vec<(usize,usize)>{
    let bytes=text.as_bytes();let lower=text.to_ascii_lowercase();let mut found=Vec::new();let mut index=0;
    while index<bytes.len(){
        if !is_word(bytes[index]){index+=1;continue;}
        let start=index;while index<bytes.len()&&(is_word(bytes[index])||matches!(bytes[index],b'.'|b'-')){index+=1;}
        let name=&lower[start..index];let credential=["key","token","secret","password"].iter().any(|part|name.contains(part));let mut separator=index;
        if bytes.get(separator).is_some_and(|b|matches!(b,b'\''|b'"')){separator+=1;}
        while bytes.get(separator).is_some_and(u8::is_ascii_whitespace){separator+=1;}
        if credential&&bytes.get(separator).is_some_and(|b|matches!(b,b':'|b'=')){
            let arrow=bytes.get(separator..separator+2)==Some(b"=>");let mut value=separator+if arrow{2}else{1};while bytes.get(value).is_some_and(u8::is_ascii_whitespace){value+=1;}
            if arrow&&matches!(name,"key"|"token"|"secret")&&bytes.get(value).is_some_and(|b|!matches!(b,b'\''|b'"'|b'`')){continue;}
            let Some(first)=bytes.get(value).copied()else{continue;};
            let end=if matches!(first,b'\''|b'"'|b'`'){quoted_end(bytes,value)}else if matches!(first,b'['|b'{'){
                let mut stack=vec![first];let mut at=value+1;let mut end=None;
                while at<bytes.len(){match bytes[at]{b'\''|b'"'|b'`'=>{if let Some(next)=quoted_end(bytes,at){at=next;continue;}break;},b'['|b'{'=>stack.push(bytes[at]),b']'|b'}'=>{let opening=stack.pop();if !matches!((opening,bytes[at]),(Some(b'['),b']')|(Some(b'{'),b'}')){break;}if stack.is_empty(){end=Some(at+1);break;}},_=>{}}at+=1;}end
            }else{let mut end=value;while end<bytes.len()&&!bytes[end].is_ascii_whitespace()&&!matches!(bytes[end],b','|b']'|b'}'|b';'){end+=1;}if end-value>=8{Some(end)}else{None}};
            if let Some(end)=end{found.push((start,end));}else if !closed_only&&matches!(first,b'\''|b'"'|b'`'|b'['|b'{'){found.push((start,bytes.len()));}
        }
        let word=&text[start..index];
        if word.len()>=12&&(word.starts_with("sk-")||word.starts_with("ghp_")||word.starts_with("github_pat_")||word.starts_with("dsk-")||word.starts_with("u_")){found.push((start,index));}
        if name=="bearer"{let mut end=index;while bytes.get(end).is_some_and(u8::is_ascii_whitespace){end+=1;}let token=end;while bytes.get(end).is_some_and(|b|b.is_ascii_alphanumeric()||matches!(b,b'.'|b'_'|b'~'|b'+'|b'/'|b'='|b'-')){end+=1;}if end-token>=12{found.push((start,end));}}
    }
    let mut offset=0;while let Some(start)=text[offset..].find("-----BEGIN ").map(|s|s+offset){let Some(header_end)=text[start..].find("PRIVATE KEY-----").map(|s|s+start+15)else{break;};let end=text[header_end..].find("-----END ").map(|s|s+header_end).and_then(|s|text[s..].find("PRIVATE KEY-----").map(|end|s+end+15));if let Some(end)=end{found.push((start,end));offset=end;}else{if !closed_only{found.push((start,text.len()));}break;}}
    found
}

fn render(text:&str,mut spans:Vec<(usize,usize)>)->RedactedText{
    spans.sort_unstable();let mut merged:Vec<(usize,usize)>=Vec::new();for(start,end)in spans{if let Some(last)=merged.last_mut().filter(|last|start<=last.1){last.1=last.1.max(end);}else{merged.push((start,end));}}
    let mut output=String::new();let mut offset=0;for(start,end)in &merged{if !text.is_char_boundary(*start)||!text.is_char_boundary(*end){continue;}output.push_str(&text[offset..*start]);output.push_str("[redacted]");offset=*end;}output.push_str(&text[offset..]);RedactedText{text:output,redactions:merged.len()}
}

pub fn redact(text:&str)->RedactedText{render(text,spans(text,false))}

pub fn redact_parts(parts:&[String])->Vec<RedactedText>{
    let joined=parts.join("\n");let shared=spans(&joined,true);let mut offset=0;
    parts.iter().map(|part|{let start=offset;let end=start+part.len();offset=end+1;let mut local=spans(part,false);for(a,b)in &shared{if *a<end&&*b>start{local.push((a.saturating_sub(start),(*b).min(end)-start));}}render(part,local)}).collect()
}
