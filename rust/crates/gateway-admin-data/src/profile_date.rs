//! Gregorian Date math covering the complete ECMAScript TimeClip range.
pub fn iso_millis(text: &str) -> Option<i64> {
    let year_len = if text.starts_with('+') || text.starts_with('-') {
        7
    } else {
        4
    };
    let year = text.get(..year_len)?.parse::<i64>().ok()?;
    if text.starts_with("-000000") {
        return None;
    }
    let tail = text.get(year_len..)?;
    if tail.get(..1) != Some("-") {
        return None;
    }
    let month = tail.get(1..3)?.parse::<i64>().ok()?;
    let day = tail.get(4..6)?.parse::<i64>().ok()?;
    if tail.get(3..4) != Some("-") || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let remainder = tail.get(6..)?;
    let mut millis = days_from_civil(year, month, day).checked_mul(86_400_000)?;
    if remainder.is_empty() {
        return within(millis);
    }
    let time = remainder
        .strip_prefix('T')
        .or_else(|| remainder.strip_prefix('t'))?;
    let hour = time.get(..2)?.parse::<i64>().ok()?;
    let minute = time.get(3..5)?.parse::<i64>().ok()?;
    if time.get(2..3) != Some(":") || hour > 24 || minute > 59 {
        return None;
    }
    let mut tail = time.get(5..)?;
    let mut second = 0;
    if let Some(rest) = tail.strip_prefix(':') {
        second = rest.get(..2)?.parse::<i64>().ok()?;
        tail = rest.get(2..)?;
    }
    if second > 59 {
        return None;
    }
    let mut fraction = 0;
    if let Some(rest) = tail.strip_prefix('.') {
        let count = rest.bytes().take_while(u8::is_ascii_digit).count();
        if count == 0 {
            return None;
        }
        let mut digits = rest[..count].chars().take(3).collect::<String>();
        while digits.len() < 3 {
            digits.push('0');
        }
        fraction = digits.parse::<i64>().ok()?;
        tail = &rest[count..];
    }
    if hour == 24 && (minute != 0 || second != 0 || fraction != 0) {
        return None;
    }
    millis = millis.checked_add(((hour * 60 + minute) * 60 + second) * 1_000 + fraction)?;
    if tail == "Z" || tail == "z" {
        return within(millis);
    }
    let sign = if tail.starts_with('+') {
        1
    } else if tail.starts_with('-') {
        -1
    } else {
        return None;
    };
    let zone = tail.get(1..)?;
    let h = zone.get(..2)?.parse::<i64>().ok()?;
    let m = if zone.get(2..3) == Some(":") {
        zone.get(3..5)?.parse::<i64>().ok()?
    } else {
        zone.get(2..4)?.parse::<i64>().ok()?
    };
    if h > 23 || m > 59 || !(zone.len() == 4 || zone.len() == 5) {
        return None;
    }
    within(millis.checked_sub(sign * (h * 60 + m) * 60_000)?)
}
fn within(value: i64) -> Option<i64> {
    (value.unsigned_abs() <= 8_640_000_000_000_000).then_some(value)
}
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = year - i64::from(month <= 2);
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let m = month + if month > 2 { -3 } else { 9 };
    let doy = (153 * m + 2) / 5 + day - 1;
    era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468
}
pub fn format_iso(value: i64) -> String {
    let days = value.div_euclid(86_400_000);
    let time = value.rem_euclid(86_400_000);
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!(
            "{}{abs:06}",
            if year < 0 { "-" } else { "+" },
            abs = year.unsigned_abs()
        )
    };
    format!(
        "{year}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        time / 3_600_000,
        time / 60_000 % 60,
        time / 1_000 % 60,
        time % 1_000
    )
}
