//! Source-compatible UTF16 span redaction before transcript clipping.
#[derive(Clone, Debug, PartialEq)]
pub struct RedactedText {
    pub text: String,
    pub redactions: usize,
}
#[derive(Clone, Copy, Debug)]
struct Span {
    start: usize,
    end: usize,
}
#[derive(Clone, Copy)]
struct Key {
    start: usize,
    separator: usize,
    quoted: bool,
}
#[derive(Clone, Copy)]
struct Reading {
    yaml: bool,
    flow: bool,
    template: bool,
}
const READINGS: [Reading; 4] = [
    Reading {
        yaml: false,
        flow: false,
        template: false,
    },
    Reading {
        yaml: true,
        flow: false,
        template: false,
    },
    Reading {
        yaml: true,
        flow: true,
        template: false,
    },
    Reading {
        yaml: false,
        flow: false,
        template: true,
    },
];
const MARKER: &[u16] = &[91, 114, 101, 100, 97, 99, 116, 101, 100, 93];
fn ascii(c: u16) -> bool {
    c <= 127 && ((c as u8).is_ascii_alphanumeric() || c == 95)
}
pub fn source_whitespace(c: char) -> bool {
    matches!(c as u32, 0x0009..=0x000d | 0x0020 | 0x00a0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}
fn white(c: u16) -> bool {
    char::from_u32(u32::from(c)).is_some_and(source_whitespace)
}
fn unicode_word(c: u16) -> bool {
    c == 95 || char::from_u32(u32::from(c)).is_some_and(char::is_alphanumeric)
}
fn starts(s: &[u16], at: usize, value: &str) -> bool {
    s.get(at..at + value.len())
        .is_some_and(|v| v.iter().copied().eq(value.encode_utf16()))
}
fn skip(s: &[u16], mut at: usize) -> usize {
    while at < s.len() && white(s[at]) {
        at += 1;
    }
    at
}
fn quoted_end(
    s: &[u16],
    open: usize,
    closed: bool,
    yaml: bool,
    double_single: bool,
) -> Option<usize> {
    let quote = *s.get(open)?;
    let mut at = open + 1;
    while at < s.len() {
        if s[at] == 92 && !(quote == 39 && yaml) {
            at += 2;
            continue;
        }
        if s[at] == quote {
            if quote == 39 && double_single && s.get(at + 1) == Some(&39) {
                at += 2;
                continue;
            }
            return Some(at + 1);
        }
        at += 1;
    }
    (!closed).then_some(s.len())
}
fn parameter_commas(s: &[u16]) -> std::collections::BTreeSet<usize> {
    let mut result = std::collections::BTreeSet::new();
    if !s.windows(2).any(|v| v == [61, 62]) {
        return result;
    }
    let mut stack = Vec::new();
    let mut at = 0;
    while at < s.len() {
        let c = s[at];
        if [34, 39, 96].contains(&c) {
            at = quoted_end(s, at, false, false, false).unwrap_or(s.len());
            continue;
        }
        if [40, 91, 123].contains(&c) {
            stack.push(c);
        } else if [41, 93, 125].contains(&c) {
            stack.pop();
        } else if c == 44 && stack.last() == Some(&40) {
            result.insert(at);
        }
        at += 1;
    }
    result
}
// The source callback exception reads at most 512 JavaScript UTF16 code units.
const CALLBACK_BODY_LIMIT: usize = 512;
fn callback_id_end(s: &[u16], start: usize) -> Option<usize> {
    let first = *s.get(start)?;
    if !(first <= 127 && (first as u8).is_ascii_alphabetic() || first == 95 || first == 36) {
        return None;
    }
    let mut end = start + 1;
    while s.get(end).is_some_and(|c| ascii(*c) || *c == 36) {
        end += 1;
    }
    Some(end)
}
fn callback_identifier(s: &[u16]) -> bool {
    callback_id_end(s, 0) == Some(s.len())
}
fn callback_trim(mut s: &[u16]) -> &[u16] {
    while s.first().is_some_and(|c| white(*c)) {
        s = &s[1..];
    }
    while s.last().is_some_and(|c| white(*c)) {
        s = &s[..s.len() - 1];
    }
    s
}
fn callback_tail(s: &[u16], at: usize) -> bool {
    s.get(skip(s, at)).is_some_and(|c| [44, 41, 59].contains(c))
}
fn callback_declaration(s: &[u16]) -> &[u16] {
    for word in ["const", "let", "var"] {
        if !starts(s, 0, word) || !s.get(word.len()).is_some_and(|c| white(*c)) {
            continue;
        }
        let Some(end) = callback_id_end(s, skip(s, word.len())) else {
            return s;
        };
        let equals = skip(s, end);
        if s.get(equals) == Some(&61) {
            return &s[skip(s, equals + 1)..];
        }
    }
    s
}
/// Only the same positively recognized source JS callback bodies may bypass masking.
fn ordinary_callback_body(s: &[u16], key: Key) -> bool {
    let parameter = callback_trim(&s[key.start..key.separator]);
    if !callback_identifier(parameter) {
        return false;
    }
    let value = skip(s, key.separator + 2);
    let body = &s[value..s.len().min(value.saturating_add(CALLBACK_BODY_LIMIT))];
    if let Some(first_end) = callback_id_end(body, 0) {
        let mut at = first_end;
        let mut called = false;
        while body.get(at) == Some(&46) {
            let Some(end) = callback_id_end(body, at + 1) else {
                break;
            };
            at = end;
            if starts(body, at, "()") {
                called = true;
                at += 2;
            }
            if callback_tail(body, at) {
                return body[..first_end] == *parameter && called;
            }
        }
    }
    if body.first() != Some(&123) {
        return false;
    }
    let Some(close) = body.iter().position(|c| *c == 125) else {
        return false;
    };
    if !callback_tail(body, close + 1) {
        return false;
    }
    let statements = callback_trim(&body[1..close]);
    if statements.last() != Some(&59) {
        return false;
    }
    let mut uses_parameter = false;
    for statement in statements[..statements.len() - 1].split(|c| *c == 59) {
        let call = callback_declaration(callback_trim(statement));
        let Some(open) = call.iter().position(|c| *c == 40) else {
            return false;
        };
        if open == 0
            || call.last() != Some(&41)
            || call[open + 1..call.len() - 1]
                .iter()
                .any(|c| [40, 41].contains(c))
        {
            return false;
        }
        if !call[..open]
            .split(|c| *c == 46)
            .all(|part| callback_identifier(callback_trim(part)))
        {
            return false;
        }
        for argument in call[open + 1..call.len() - 1].split(|c| *c == 44) {
            let argument = callback_trim(argument);
            if !callback_identifier(argument) {
                return false;
            }
            uses_parameter |= argument == parameter;
        }
    }
    uses_parameter
}
fn arrow_parameter(s: &[u16], key: Key, commas: &std::collections::BTreeSet<usize>) -> bool {
    if key.quoted || !starts(s, key.separator, "=>") {
        return false;
    }
    let mut before = key.start;
    while before > 0 && white(s[before - 1]) {
        before -= 1;
    }
    before > 0
        && (s[before - 1] == 40 || commas.contains(&(before - 1)))
        && ordinary_callback_body(s, key)
}
fn keys(s: &[u16], segments: bool, filter_arrow: bool) -> Vec<Key> {
    let mut out = Vec::new();
    let mut at = 0;
    let commas = parameter_commas(s);
    while at < s.len() {
        if !ascii(s[at]) || (at > 0 && ascii(s[at - 1])) {
            at += 1;
            continue;
        }
        let start = at;
        while at < s.len() && ascii(s[at]) {
            at += 1;
        }
        let word = String::from_utf16_lossy(&s[start..at]).to_ascii_lowercase();
        if !["key", "token", "secret", "password"]
            .iter()
            .any(|v| word.contains(v))
        {
            continue;
        }
        let mut end = at;
        if segments {
            for _ in 0..16 {
                if !s.get(end).is_some_and(|c| *c == 46 || *c == 45) {
                    break;
                }
                end += 1;
                while end < s.len() && ascii(s[end]) {
                    end += 1;
                }
            }
        }
        let quoted = s.get(end).is_some_and(|c| *c == 34 || *c == 39);
        if quoted {
            end += 1;
        }
        end = skip(s, end);
        if !s.get(end).is_some_and(|c| *c == 58 || *c == 61) {
            continue;
        }
        let key = Key {
            start,
            separator: end,
            quoted,
        };
        if !filter_arrow || !arrow_parameter(s, key, &commas) {
            out.push(key);
        }
        at = end.max(at);
    }
    out
}
fn value_starts(s: &[u16], key: Key) -> Vec<usize> {
    if starts(s, key.separator, "=>") {
        if key.quoted {
            vec![skip(s, key.separator + 2)]
        } else {
            vec![skip(s, key.separator + 1), skip(s, key.separator + 2)]
        }
    } else {
        vec![skip(s, key.separator + 1)]
    }
}
fn token_character(c: u16) -> bool {
    ascii(c) || [46, 126, 43, 47, 61, 45].contains(&c)
}
fn token_spans(s: &[u16], rule: usize) -> Vec<Span> {
    let mut spans = Vec::new();
    let mut at = 0;
    while at < s.len() {
        let boundary = at == 0 || !ascii(s[at - 1]);
        let mut end = None;
        match rule {
            0 if starts(s, at, "-----BEGIN ") => {
                let mut head = at + 11;
                while head < s.len() && ((65..=90).contains(&s[head]) || s[head] == 32) {
                    head += 1;
                }
                // The greedy label includes PRIVATE KEY; validate the complete header.
                if head >= 11
                    && s.get(head..head + 5) == Some(&[45, 45, 45, 45, 45])
                    && String::from_utf16_lossy(&s[at + 11..head]).ends_with("PRIVATE KEY")
                {
                    let mut close = head + 5;
                    while close < s.len() {
                        if starts(s, close, "-----END ") {
                            let mut label = close + 9;
                            while label < s.len()
                                && ((65..=90).contains(&s[label]) || s[label] == 32)
                            {
                                label += 1;
                            }
                            if starts(s, label, "-----")
                                && String::from_utf16_lossy(&s[close + 9..label])
                                    .ends_with("PRIVATE KEY")
                            {
                                end = Some(label + 5);
                                break;
                            }
                        }
                        close += 1;
                    }
                }
            }
            1 if boundary && (starts(s, at, "Bearer") || starts(s, at, "bearer")) => {
                let token = skip(s, at + 6);
                if token > at + 6 {
                    let mut e = token;
                    while e < s.len() && token_character(s[e]) {
                        e += 1;
                    }
                    if e - token >= 12 {
                        end = Some(e);
                    }
                }
            }
            2 if boundary => {
                for prefix in ["sk-", "ghp-", "gho-", "ghu-", "ghs-", "dsk-"] {
                    if starts(s, at, prefix) {
                        let mut e = at + prefix.len();
                        while e < s.len() && (ascii(s[e]) || s[e] == 45) {
                            e += 1;
                        }
                        if e - at - prefix.len() >= 12 {
                            end = Some(e);
                            break;
                        }
                    }
                }
            }
            3 => {
                for prefix in ["ghp_", "gho_", "ghu_", "ghs_"] {
                    if starts(s, at, prefix) {
                        let mut e = at + prefix.len();
                        while e < s.len() && s[e] <= 127 && (s[e] as u8).is_ascii_alphanumeric() {
                            e += 1;
                        }
                        if e - at - prefix.len() >= 12 {
                            end = Some(e);
                            break;
                        }
                    }
                }
            }
            4 if starts(s, at, "github_pat_") => {
                let mut e = at + 11;
                while e < s.len() && ascii(s[e]) {
                    e += 1;
                }
                if e - at - 11 >= 12 {
                    end = Some(e);
                }
            }
            5 if boundary && starts(s, at, "u_") => {
                let mut e = at + 2;
                while e < s.len() && s[e] <= 127 && (s[e] as u8).is_ascii_hexdigit() {
                    e += 1;
                }
                if e - at - 2 >= 32 && (e == s.len() || !ascii(s[e])) {
                    end = Some(e);
                }
            }
            _ => {}
        }
        if let Some(end) = end {
            spans.push(Span { start: at, end });
            at = end;
        } else {
            at += 1;
        }
    }
    spans
}
fn quoted_spans(s: &[u16], keys: &[Key], closed: bool) -> Vec<Span> {
    let mut out = Vec::new();
    for key in keys {
        for at in value_starts(s, *key) {
            if s.get(at).is_some_and(|c| *c == 34 || *c == 96)
                && let Some(end) = quoted_end(s, at, closed, false, false)
                && end > at
            {
                out.push(Span {
                    start: key.start,
                    end,
                });
            }
        }
    }
    out
}
fn scalar_spans(s: &[u16], keys: &[Key], closed: bool) -> Vec<Span> {
    let mut spans = Vec::new();
    let mut run = (0, 0);
    let mut quoted_run = (0, 0);
    for key in keys {
        for at in value_starts(s, *key) {
            if s.get(at) == Some(&39) {
                for yaml in [true, false] {
                    if let Some(end) = quoted_end(s, at, closed, yaml, true)
                        && end > at
                    {
                        spans.push(Span {
                            start: key.start,
                            end,
                        });
                    }
                }
            }
            if closed || at == s.len() {
                continue;
            }
            if key.quoted && [34, 39, 96, 91, 123].contains(&s[at]) {
                continue;
            }
            let cache = if key.quoted {
                &mut quoted_run
            } else {
                &mut run
            };
            let end = if at >= cache.0 && at < cache.1 {
                cache.1
            } else {
                let mut e = at;
                while e < s.len()
                    && !white(s[e])
                    && (!key.quoted || ![44, 93, 125, 59].contains(&s[e]))
                {
                    e += 1;
                }
                *cache = (at, e);
                e
            };
            if end - at >= 8 {
                spans.push(Span {
                    start: key.start,
                    end,
                });
            }
        }
    }
    spans
}
fn apostrophe_opens(s: &[u16], index: usize) -> bool {
    let mut start = index;
    while start > 0 && index - start < 3 && unicode_word(s[start - 1]) {
        start -= 1;
    }
    if start == index {
        return true;
    }
    if start > 0 && unicode_word(s[start - 1]) {
        return false;
    }
    matches!(
        String::from_utf16_lossy(&s[start..index])
            .to_ascii_lowercase()
            .as_str(),
        "b" | "f"
            | "r"
            | "t"
            | "u"
            | "l"
            | "n"
            | "e"
            | "x"
            | "q"
            | "s"
            | "br"
            | "rb"
            | "fr"
            | "rf"
            | "tr"
            | "rt"
            | "u8"
            | "qq"
    )
}
fn scalar_start(c: u16) -> bool {
    [91, 123, 44, 58].contains(&c)
}
fn opens(s: &[u16], at: usize, r: Reading, start: bool) -> bool {
    let Some(c) = s.get(at) else {
        return false;
    };
    if *c == 96 {
        return r.template;
    }
    if *c != 34 && *c != 39 {
        return false;
    }
    if r.flow {
        return start;
    }
    *c == 34 || apostrophe_opens(s, at)
}
#[derive(Clone)]
struct Scan {
    start: usize,
    depth: i64,
    quote: u16,
    escaped: bool,
}
fn bracketed(s: &[u16], openings: &[(usize, usize)], r: Reading, closed: bool) -> Vec<Span> {
    if closed {
        let mut string_ends = Vec::new();
        for quote in [34, 39, 96] {
            if quote == 96 && !r.template {
                continue;
            }
            let mut ends = vec![None; s.len() + 2];
            for i in (0..s.len()).rev() {
                ends[i] = if s[i] == 92 && !(quote == 39 && r.yaml) {
                    ends[i + 2]
                } else if s[i] == quote {
                    if quote == 39 && s.get(i + 1) == Some(&39) {
                        ends[i + 2]
                    } else {
                        Some(i + 1)
                    }
                } else {
                    ends[i + 1]
                };
            }
            string_ends.push((quote, ends));
        }
        let mut next = vec![None; s.len() + 1];
        for i in (0..s.len()).rev() {
            let mut before = i;
            while before > 0 && s[before - 1] <= 32 {
                before -= 1;
            }
            let start = before > 0 && scalar_start(s[before - 1]);
            let quoted = string_ends.iter().find(|(q, _)| *q == s[i]);
            next[i] = if let Some((_, ends)) = quoted.filter(|_| opens(s, i, r, start)) {
                ends[i + 1].and_then(|end| next[end])
            } else if s[i] == 91 || s[i] == 123 {
                next[i + 1].and_then(|end| next[end])
            } else if s[i] == 93 || s[i] == 125 {
                Some(i + 1)
            } else {
                next[i + 1]
            };
        }
        return openings
            .iter()
            .filter_map(|(start, bracket)| next[bracket + 1].map(|end| Span { start: *start, end }))
            .collect();
    }
    let mut out = Vec::new();
    let mut scans: Vec<Scan> = Vec::new();
    let mut index = 0;
    let mut next = 0;
    let mut previous = 0;
    while index < s.len() {
        if scans.is_empty() {
            if next == openings.len() {
                break;
            }
            index = openings[next].1;
        }
        if openings.get(next).is_some_and(|(_, at)| *at == index) {
            scans.push(Scan {
                start: openings[next].0,
                depth: 0,
                quote: 0,
                escaped: false,
            });
            next += 1;
        }
        for scan in &mut scans {
            let c = s[index];
            if scan.escaped {
                scan.escaped = false;
            } else if scan.quote == 0 {
                if opens(s, index, r, scalar_start(previous)) {
                    scan.quote = c;
                } else if c == 91 || c == 123 {
                    scan.depth += 1;
                } else if c == 93 || c == 125 {
                    scan.depth -= 1;
                }
            } else if c == 92 {
                scan.escaped = scan.quote != 39 || !r.yaml;
            } else if c == scan.quote {
                if c == 39 && s.get(index + 1) == Some(&39) {
                    scan.escaped = true;
                } else {
                    scan.quote = 0;
                }
            }
        }
        if s[index] > 32 {
            previous = s[index];
        }
        index += 1;
        let mut kept: Vec<Scan> = Vec::new();
        for scan in scans.drain(..) {
            if scan.depth == 0 {
                out.push(Span {
                    start: scan.start,
                    end: index,
                });
            } else if let Some(twin) = kept
                .iter_mut()
                .find(|other| other.quote == scan.quote && other.escaped == scan.escaped)
            {
                twin.start = twin.start.min(scan.start);
                twin.depth = twin.depth.max(scan.depth);
            } else {
                kept.push(scan);
            }
        }
        scans = kept;
    }
    out.extend(scans.into_iter().map(|scan| Span {
        start: scan.start,
        end: s.len(),
    }));
    out
}
fn bracket_spans(s: &[u16], keys: &[Key], closed: bool) -> Vec<Span> {
    let mut openings = Vec::new();
    for key in keys {
        for at in value_starts(s, *key) {
            if s.get(at).is_some_and(|c| *c == 91 || *c == 123) {
                openings.push((key.start, at));
            }
        }
    }
    openings.sort_by_key(|(_, at)| *at);
    READINGS
        .iter()
        .flat_map(|r| bracketed(s, &openings, *r, closed))
        .collect()
}
fn merge(mut spans: Vec<Span>) -> Vec<Span> {
    spans.sort_by_key(|s| (s.start, s.end));
    let mut out: Vec<Span> = Vec::new();
    for span in spans {
        if let Some(last) = out.last_mut().filter(|last| span.start < last.end) {
            last.end = last.end.max(span.end);
        } else {
            out.push(span);
        }
    }
    out
}
fn render(s: &[u16], mask: &[Span]) -> (Vec<u16>, Vec<(usize, Span)>) {
    let mut out = Vec::new();
    let mut markers = Vec::new();
    let mut from = 0;
    for span in mask {
        out.extend_from_slice(&s[from..span.start]);
        markers.push((out.len(), *span));
        out.extend_from_slice(MARKER);
        from = span.end;
    }
    out.extend_from_slice(&s[from..]);
    (out, markers)
}
fn source_range(markers: &[(usize, Span)], at: usize) -> Span {
    let count = markers.partition_point(|(start, _)| *start <= at);
    if count == 0 {
        return Span {
            start: at,
            end: at + 1,
        };
    }
    let (start, span) = markers[count - 1];
    if at < start + MARKER.len() {
        return span;
    }
    let index = span.end + at - start - MARKER.len();
    Span {
        start: index,
        end: index + 1,
    }
}
fn previous_quoted(s: &[u16]) -> Vec<Span> {
    keys(s, false, false)
        .into_iter()
        .filter_map(|key| {
            let at = skip(s, key.separator + 1);
            (s.get(at) == Some(&34))
                .then(|| {
                    quoted_end(s, at, true, false, false).map(|end| Span {
                        start: key.start,
                        end,
                    })
                })
                .flatten()
        })
        .collect()
}
fn previous_bare(s: &[u16]) -> Vec<Span> {
    let commas = parameter_commas(s);
    let mut out = Vec::new();
    for key in keys(s, false, false) {
        if key.quoted || arrow_parameter(s, key, &commas) {
            continue;
        }
        let at = skip(s, key.separator + 1);
        let mut end = at;
        while end < s.len() && !white(s[end]) {
            end += 1;
        }
        if end - at >= 8 {
            out.push(Span {
                start: key.start,
                end,
            });
        }
    }
    out
}
fn previous_components(s: &[u16]) -> Vec<Span> {
    let previous = keys(s, false, false);
    let mut openings = Vec::new();
    let mut scalars = Vec::new();
    for key in &previous {
        let at = skip(s, key.separator + 1);
        if s.get(at).is_some_and(|v| *v == 91 || *v == 123) {
            openings.push((key.start, at));
        }
        if s.get(at) == Some(&39) {
            for yaml in [true, false] {
                if let Some(end) = quoted_end(s, at, false, yaml, true) {
                    scalars.push(Span {
                        start: key.start,
                        end,
                    });
                }
            }
        }
    }
    let values = merge(
        READINGS
            .iter()
            .flat_map(|r| bracketed(s, &openings, *r, false))
            .collect(),
    );
    for rule in 0..6 {
        scalars.extend(token_spans(s, rule));
    }
    scalars.extend(previous_quoted(s));
    scalars.extend(previous_bare(s));
    scalars.extend(values.iter().copied());
    merge(scalars)
        .into_iter()
        .filter(|span| {
            values
                .iter()
                .any(|value| value.start < span.end && span.start < value.end)
        })
        .collect()
}
fn sequential(s: &[u16], mask: Vec<Span>) -> (Vec<Span>, usize) {
    let mut current = mask;
    let mut count = 0;
    for rule in 0..8 {
        let (rendered, markers) = render(s, &current);
        let found = match rule {
            0..=5 => token_spans(&rendered, rule),
            6 => previous_quoted(&rendered),
            _ => scalar_spans(&rendered, &keys(&rendered, true, true), false),
        };
        if found.is_empty() {
            continue;
        }
        count += merge(found.clone()).len();
        let mut spans = current;
        spans.extend(
            found
                .into_iter()
                .filter(|v| v.end > v.start)
                .map(|span| Span {
                    start: source_range(&markers, span.start).start,
                    end: source_range(&markers, span.end - 1).end,
                }),
        );
        current = merge(spans);
    }
    (current, count)
}
fn redact_units(s: &[u16], additional: &[Span]) -> RedactedText {
    let keys = keys(s, true, true);
    let mut all = Vec::new();
    for rule in 0..6 {
        all.extend(token_spans(s, rule));
    }
    all.extend(quoted_spans(s, &keys, false));
    all.extend(scalar_spans(s, &keys, false));
    all.extend(bracket_spans(s, &keys, false));
    let previous = sequential(s, Vec::new()).0;
    let components = previous_components(s);
    let (after, count) = sequential(s, components.clone());
    all.extend(previous);
    all.extend(after.iter().copied());
    all.extend_from_slice(additional);
    let mask = merge(all);
    let added = mask
        .iter()
        .filter(|span| {
            !after
                .iter()
                .any(|old| old.start < span.end && span.start < old.end)
        })
        .count();
    RedactedText {
        text: String::from_utf16_lossy(&render(s, &mask).0),
        redactions: components.len() + count + added,
    }
}
pub fn redact(text: &str) -> RedactedText {
    redact_units(&text.encode_utf16().collect::<Vec<_>>(), &[])
}
pub fn redact_parts(parts: &[String]) -> Vec<RedactedText> {
    if parts.len() < 2 {
        return parts.iter().map(|s| redact(s)).collect();
    }
    let joined = parts.join("\n").encode_utf16().collect::<Vec<_>>();
    let keys = keys(&joined, true, true);
    let mut shared = token_spans(&joined, 0);
    shared.extend(quoted_spans(&joined, &keys, true));
    shared.extend(scalar_spans(&joined, &keys, true));
    shared.extend(bracket_spans(&joined, &keys, true));
    let shared = merge(shared);
    let mut offset = 0;
    parts
        .iter()
        .map(|part| {
            let units = part.encode_utf16().collect::<Vec<_>>();
            let start = offset;
            let end = start + units.len();
            offset = end + 1;
            let local = shared
                .iter()
                .filter(|v| v.start < end && v.end > start)
                .map(|v| Span {
                    start: v.start.max(start) - start,
                    end: v.end.min(end) - start,
                })
                .collect::<Vec<_>>();
            redact_units(&units, &local)
        })
        .collect()
}
/// Sanitizes raw visible follow fields together before existing clipping/revision code.
pub fn sanitize_follow_items(items: &serde_json::Value) -> serde_json::Value {
    let Some(raw) = items.as_array() else {
        return items.clone();
    };
    let mut output = raw.clone();
    let mut positions = Vec::new();
    let mut parts = Vec::new();
    for (index, item) in raw.iter().enumerate() {
        let fields = match item.get("type").and_then(serde_json::Value::as_str) {
            Some("agentMessage") => &["text"][..],
            Some("commandExecution") => &["command", "aggregatedOutput"][..],
            _ => &[],
        };
        for field in fields {
            if let Some(text) = item.get(field).and_then(serde_json::Value::as_str) {
                positions.push((index, *field));
                parts.push(text.to_owned());
            }
        }
    }
    for ((index, field), value) in positions.into_iter().zip(redact_parts(&parts)) {
        output[index][field] = serde_json::Value::String(value.text);
    }
    serde_json::Value::Array(output)
}
