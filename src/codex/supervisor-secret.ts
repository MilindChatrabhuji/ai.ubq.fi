/**
 * Credential-shaped text in supervisor transcript excerpts.
 *
 * Transcript bytes leave the host for an external summarizer, so redaction is
 * deliberately over-broad: a false positive costs a little context, while a
 * false negative discloses a credential. The patterns stay simple on purpose;
 * this is a bounded sanitizer, not a JSON parser or a secret classifier.
 */

type RedactionSpan = { start: number; end: number };

const MARKER = "[redacted]";

const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

/** Credential shapes recognized without a key. */
const TOKEN_PATTERNS: readonly RegExp[] = [
  PRIVATE_KEY_PATTERN,
  /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{12,}/g,
  /\b(?:sk|ghp|gho|ghu|ghs|dsk)-[A-Za-z0-9_-]{12,}/g,
  /(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{12,}/g,
  /github_pat_\w{12,}/g,
  /\bu_[0-9a-fA-F]{32,}\b/g,
];

/**
 * A credential key, up to the `:`, `=` or `=>` that assigns its value. The key
 * is a whole word holding a credential word, and it may run on through up to
 * sixteen `.` or `-` segments (`tokens-v2`, `secret.values`). It may close a
 * quote (`"api_keys"`, PHP `'password'`), which the second group captures.
 * The word is taken whole, without backtracking, and the segments are
 * bounded, so a long run of word characters, dots or dashes costs linear time.
 */
const CREDENTIAL_KEY = /\b(?=\w*(?:key|token|secret|password))(?=(\w*))\1(?:[.-]\w*){0,16}(["']?)\s*(?=[:=])/gi;

/** The shortest unquoted value the fallback rule treats as token-like. */
const MIN_BARE_VALUE = 8;

const WHITESPACE = /\s/;
const QUOTED_BARE_END = /[\s,\]};]/;

/** End of a quoted value where a backslash escapes the next character. */
const quotedEnd = (text: string, openQuote: number, closedOnly = false): number => {
  for (let index = openQuote + 1; index < text.length; index += 1) {
    if (text[index] === "\\") index += 1;
    else if (text[index] === text[openQuote]) return index + 1;
  }
  // Only a per-record reading may redact an unclosed value through its tail.
  return closedOnly ? -1 : text.length;
};

/** End of the scalar read as YAML: `''` is an escaped quote and a backslash is content. */
const yamlScalarEnd = (text: string, openQuote: number, closedOnly = false): number => {
  for (let index = openQuote + 1; index < text.length; index += 1) {
    if (text[index] !== "'") continue;
    if (text[index + 1] === "'") {
      index += 1;
      continue;
    }
    return index + 1;
  }
  // Only a per-record reading may redact an unclosed scalar through its tail.
  return closedOnly ? -1 : text.length;
};

/** End of the scalar read with the pre-existing rule that `\x` escapes the next character. */
const escapedScalarEnd = (text: string, openQuote: number, closedOnly = false): number => {
  for (let index = openQuote + 1; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character !== "'") continue;
    if (text[index + 1] === "'") {
      index += 1;
      continue;
    }
    return index + 1;
  }
  return closedOnly ? -1 : text.length;
};

/**
 * How one reading treats a quote inside a bracketed value. A JSON, Python or
 * JavaScript string escapes with a backslash, and JavaScript also quotes with
 * a backtick. YAML reads a backslash in a single-quoted string as content,
 * and in a flow collection it opens a string only where a scalar starts, so
 * the apostrophe in a plain scalar such as `it's` is content. Every reading's
 * spans are kept, so a reading that misreads a quote can only widen a
 * redaction, never narrow it.
 */
type QuoteReading = { yamlSingleQuotes: boolean; flowScalars: boolean; templateLiterals: boolean };

const QUOTE_READINGS: readonly QuoteReading[] = [
  // Keep the JSON/Python reading: a backtick is plain text, as before.
  { yamlSingleQuotes: false, flowScalars: false, templateLiterals: false },
  // YAML quoting, with every quote opening a string.
  { yamlSingleQuotes: true, flowScalars: false, templateLiterals: false },
  // YAML flow: a quote opens a string only where a scalar starts.
  { yamlSingleQuotes: true, flowScalars: true, templateLiterals: false },
  // JavaScript adds template literals without narrowing any existing reading.
  { yamlSingleQuotes: false, flowScalars: false, templateLiterals: true },
];

/** A character after which a YAML flow scalar, and so a quoted string, can start. */
const SCALAR_START = new Set(["[", "{", ",", ":"]);

const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

/** Python/C/SQL prefixes plus Perl, Ruby and Elixir forms such as `q'…'`, `%q'…'` and `~s'…'`. */
const STRING_PREFIX = /^(?:[bfrtulnexqs]|br|rb|fr|rf|tr|rt|u8|qq)$/i;

/**
 * Whether an apostrophe opens a string: always, unless it follows a word
 * character. There it never does in JSON, JavaScript or YAML, and in Python,
 * C, SQL, Perl, Ruby or Elixir only after a string prefix. Prose and comments write one inside a
 * word (`it's`, `don't`, `users'`), and reading it as a string would carry
 * the value on to the end of the text.
 */
const apostropheOpensString = (text: string, index: number): boolean => {
  let wordStart = index;
  while (wordStart > 0 && index - wordStart < 3 && WORD_CHARACTER.test(text[wordStart - 1])) wordStart -= 1;
  if (wordStart === index) return true;
  if (wordStart > 0 && WORD_CHARACTER.test(text[wordStart - 1])) return false;
  return STRING_PREFIX.test(text.slice(wordStart, index));
};

/** Whether the quote character at `index` opens a string in this reading. */
const opensString = (text: string, index: number, reading: QuoteReading, scalarStart: boolean): boolean => {
  const character = text[index];
  if (character === "`") return reading.templateLiterals;
  if (character !== '"' && character !== "'") return false;
  if (reading.flowScalars) return scalarStart;
  return character === '"' || apostropheOpensString(text, index);
};

/** Where a credential assignment starts and where its bracketed value opens. */
type ValueOpening = { start: number; bracket: number };

/** One scan through a bracketed value: its depth, and the string it is inside, if any. */
type ValueScan = { start: number; depth: number; quote: string; escaped: boolean };

/** Advance a scan over the character at `index`, read one way. */
const advanceScan = (scan: ValueScan, text: string, index: number, reading: QuoteReading, scalarStart: boolean): void => {
  const character = text[index];
  if (scan.escaped) {
    scan.escaped = false;
  } else if (scan.quote === "") {
    if (opensString(text, index, reading, scalarStart)) scan.quote = character;
    else if (character === "[" || character === "{") scan.depth += 1;
    else if (character === "]" || character === "}") scan.depth -= 1;
  } else if (character === "\\") {
    scan.escaped = scan.quote !== "'" || !reading.yamlSingleQuotes;
  } else if (character === scan.quote) {
    // A doubled quote inside a single-quoted string is an escaped quote.
    if (character === "'" && text[index + 1] === "'") scan.escaped = true;
    else scan.quote = "";
  }
};

/** The first of the `count` scans that is in the same string state as `scan`, if any. */
const twinScan = (scans: readonly ValueScan[], count: number, scan: ValueScan): ValueScan | undefined => {
  for (let at = 0; at < count; at += 1) {
    if (scans[at].quote === scan.quote && scans[at].escaped === scan.escaped) return scans[at];
  }
  return undefined;
};

/**
 * Record each scan whose value closed just before `end`, and merge the rest in
 * place. Two scans in the same string state read every later character alike,
 * so the one with the greater depth ends no earlier; one scan with the earlier
 * start and the greater depth then covers exactly the union of their values.
 */
const settleScans = (scans: ValueScan[], end: number, values: RedactionSpan[]): void => {
  let kept = 0;
  for (const scan of scans) {
    if (scan.depth === 0) {
      values.push({ start: scan.start, end });
      continue;
    }
    const twin = twinScan(scans, kept, scan);
    if (twin) {
      twin.start = Math.min(twin.start, scan.start);
      twin.depth = Math.max(twin.depth, scan.depth);
    } else {
      scans[kept] = scan;
      kept += 1;
    }
  }
  scans.length = kept;
};

/**
 * Every bracketed value read one way: from each opening bracket through the
 * bracket that closes it, with any bracket inside a string skipped, or through
 * the end of the text when the value was clipped. Each opening gets its own
 * scan, so a value this reading ends inside a nested credential cannot hide
 * that credential. Merged scans leave at most one per string state, which keeps
 * the scan linear.
 */
const bracketedValues = (text: string, openings: readonly ValueOpening[], reading: QuoteReading): RedactionSpan[] => {
  const values: RedactionSpan[] = [];
  const scans: ValueScan[] = [];
  let next = 0;
  let previous = "";
  let index = 0;
  while (index < text.length) {
    if (scans.length === 0) {
      if (next === openings.length) break;
      index = openings[next].bracket;
    }
    if (openings[next]?.bracket === index) {
      scans.push({ start: openings[next].start, depth: 0, quote: "", escaped: false });
      next += 1;
    }
    const scalarStart = SCALAR_START.has(previous);
    for (const scan of scans) advanceScan(scan, text, index, reading, scalarStart);
    // YAML separates tokens with spaces, tabs and line breaks.
    if (text[index] > " ") previous = text[index];
    index += 1;
    settleScans(scans, index, values);
  }
  for (const scan of scans) values.push({ start: scan.start, end: text.length });
  return values;
};

/** The non-whitespace run starting at `from`, remembered so that keys sharing one run read it once. */
type RunCache = { start: number; end: number };

const runEnd = (text: string, from: number, cache: RunCache, stop: RegExp = WHITESPACE): number => {
  if (from >= cache.start && from < cache.end) return cache.end;
  let end = from;
  while (end < text.length && !stop.test(text[end])) end += 1;
  cache.start = from;
  cache.end = end;
  return end;
};

const skipWhitespace = (text: string, from: number): number => {
  let index = from;
  while (index < text.length && WHITESPACE.test(text[index])) index += 1;
  return index;
};

/** A credential key: where it starts, where its separator is, and whether it closed a quote. */
type CredentialKey = { start: number; separator: number; quoted: boolean };

/** Commas inside a call/parameter list, not commas separating hash entries. */
const parameterCommas = (text: string): ReadonlySet<number> => {
  const commas = new Set<number>();
  if (!text.includes("=>")) return commas;
  const brackets: string[] = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if ("\"'`".includes(character)) {
      index = quotedEnd(text, index);
      continue;
    }
    if ("([{".includes(character)) brackets.push(character);
    else if (")]}".includes(character)) brackets.pop();
    else if (character === "," && brackets.at(-1) === "(") commas.add(index);
    index += 1;
  }
  return commas;
};

/** A bare key in parameter position before `=>` is not a hash key. */
const isArrowParameter = (text: string, key: CredentialKey, commas: ReadonlySet<number>): boolean => {
  if (key.quoted || !text.startsWith("=>", key.separator)) return false;
  let before = key.start - 1;
  while (before >= 0 && WHITESPACE.test(text[before])) before -= 1;
  return text[before] === "(" || commas.has(before);
};

const credentialKeys = (text: string): CredentialKey[] => {
  const commas = parameterCommas(text);
  return [...text.matchAll(CREDENTIAL_KEY)]
    .map((match) => ({ start: match.index, separator: match.index + match[0].length, quoted: match[2] !== "" }))
    .filter((key) => !isArrowParameter(text, key, commas));
};

/**
 * Where a key's value can start: past the separator and any whitespace. `=>`
 * (PHP, Perl, Ruby) also retains the old `=` reading for unquoted keys,
 * where a bare value started with `>`. Arrow parameters are excluded above.
 */
const valueStarts = (text: string, key: CredentialKey): number[] => {
  const starts = [skipWhitespace(text, key.separator + 1)];
  if (text.startsWith("=>", key.separator)) {
    if (key.quoted) return [skipWhitespace(text, key.separator + 2)];
    starts.push(skipWhitespace(text, key.separator + 2));
  }
  return starts;
};

const patternSpans = (text: string, pattern: RegExp): RedactionSpan[] =>
  [...text.matchAll(pattern)].map((match) => ({ start: match.index, end: match.index + match[0].length }));

/** Each key's double-quoted value or JavaScript template literal, through the end of the text when it never closes. */
const quotedValueSpans = (text: string, keys: readonly CredentialKey[], closedOnly = false): RedactionSpan[] => {
  const spans: RedactionSpan[] = [];
  for (const key of keys) {
    for (const value of valueStarts(text, key)) {
      if (text[value] === '"' || text[value] === "`") {
        const end = quotedEnd(text, value, closedOnly);
        if (end > value) spans.push({ start: key.start, end });
      }
    }
  }
  return spans;
};

/** Each key's single-quoted scalar, read both ways, or token-like bare value. */
const scalarValueSpans = (text: string, keys: readonly CredentialKey[], closedOnly = false): RedactionSpan[] => {
  const cache: RunCache = { start: 0, end: 0 };
  const quotedCache: RunCache = { start: 0, end: 0 };
  return keys.flatMap((key) =>
    valueStarts(text, key).flatMap((value) => {
      const spans =
        text[value] === "'"
          ? [yamlScalarEnd(text, value, closedOnly), escapedScalarEnd(text, value, closedOnly)]
              .filter((end) => end > value)
              .map((end) => ({ start: key.start, end }))
          : [];
      if (closedOnly || value === text.length) return spans;
      // Quoted keys may have bare YAML/JSON/PHP values, but their fallback
      // must not eat an adjacent field or reinterpret a quoted/flow value.
      if (key.quoted && "\"'`[{".includes(text[value])) return spans;
      const end = key.quoted ? runEnd(text, value, quotedCache, QUOTED_BARE_END) : runEnd(text, value, cache);
      if (end - value >= MIN_BARE_VALUE) spans.push({ start: key.start, end });
      return spans;
    })
  );
};

/** For each string-content position, the end of its string, or -1 if it is clipped. */
const stringContentEnds = (text: string, quote: string, yamlSingleQuotes: boolean): Int32Array => {
  const ends = new Int32Array(text.length + 2).fill(-1);
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (text[index] === "\\" && !(quote === "'" && yamlSingleQuotes)) ends[index] = ends[index + 2];
    else if (text[index] === quote) ends[index] = quote === "'" && text[index + 1] === "'" ? ends[index + 2] : index + 1;
    else ends[index] = ends[index + 1];
  }
  return ends;
};

const flowScalarStartsAt = (text: string, index: number): boolean => {
  let before = index - 1;
  while (before >= 0 && text[before] <= " ") before -= 1;
  return SCALAR_START.has(text[before]);
};

const followingClose = (ends: Int32Array, end: number): number => (end < 0 ? -1 : ends[end]);

/**
 * Closed values only, in linear time. Resolve suffixes backwards so a clipped
 * outer value cannot absorb the scan for a closed nested credential. This is
 * the bounded reading used across records, never across prompt framing.
 */
const nextBracketCloses = (text: string, reading: QuoteReading): Int32Array => {
  const quotes = reading.templateLiterals ? ['"', "'", "`"] : ['"', "'"];
  const stringEnds = new Map(quotes.map((quote) => [quote, stringContentEnds(text, quote, reading.yamlSingleQuotes)]));
  const nextClose = new Int32Array(text.length + 1).fill(-1);
  for (let index = text.length - 1; index >= 0; index -= 1) {
    const character = text[index];
    const quoted = stringEnds.get(character);
    if (quoted && opensString(text, index, reading, flowScalarStartsAt(text, index))) {
      nextClose[index] = followingClose(nextClose, quoted[index + 1]);
    } else if (character === "[" || character === "{") {
      nextClose[index] = followingClose(nextClose, nextClose[index + 1]);
    } else {
      nextClose[index] = character === "]" || character === "}" ? index + 1 : nextClose[index + 1];
    }
  }
  return nextClose;
};

const closedBracketedValues = (text: string, openings: readonly ValueOpening[], reading: QuoteReading): RedactionSpan[] => {
  const nextClose = nextBracketCloses(text, reading);
  return openings.flatMap((opening) => {
    const end = nextClose[opening.bracket + 1];
    return end < 0 ? [] : [{ start: opening.start, end }];
  });
};

/** Each key's array or object value, read every quote way. */
const bracketedValueSpans = (text: string, keys: readonly CredentialKey[], closedOnly = false): RedactionSpan[] => {
  const openings: ValueOpening[] = [];
  for (const key of keys) {
    for (const value of valueStarts(text, key)) {
      if (text[value] === "[" || text[value] === "{") openings.push({ start: key.start, bracket: value });
    }
  }
  if (openings.length === 0) return [];
  // The scan walks the text once, so it takes the openings in bracket order.
  openings.sort((left, right) => left.bracket - right.bracket);
  return QUOTE_READINGS.flatMap((reading) => (closedOnly ? closedBracketedValues(text, openings, reading) : bracketedValues(text, openings, reading)));
};

/** Merge overlapping spans so one replacement can never cut through another secret. */
const mergeSpans = (spans: readonly RedactionSpan[]): RedactionSpan[] => {
  const ordered = [...spans].sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: RedactionSpan[] = [];
  for (const span of ordered) {
    const previous = merged.at(-1);
    if (previous && span.start < previous.end) {
      previous.end = Math.max(previous.end, span.end);
      continue;
    }
    merged.push({ ...span });
  }
  return merged;
};

/** The text with each masked span replaced by the marker, and where each marker sits in it. */
type Rendering = { text: string; markers: { at: number; span: RedactionSpan }[] };

const render = (text: string, mask: readonly RedactionSpan[]): Rendering => {
  let rendered = "";
  let cursor = 0;
  const markers: Rendering["markers"] = [];
  for (const span of mask) {
    rendered += text.slice(cursor, span.start);
    markers.push({ at: rendered.length, span });
    rendered += MARKER;
    cursor = span.end;
  }
  return { text: rendered + text.slice(cursor), markers };
};

/** Where a rendered position falls in the original text: a marker stands for its whole span. */
const sourceRange = (rendering: Rendering, position: number): RedactionSpan => {
  let low = 0;
  let high = rendering.markers.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (rendering.markers[middle].at <= position) low = middle + 1;
    else high = middle;
  }
  if (low === 0) return { start: position, end: position + 1 };
  const marker = rendering.markers[low - 1];
  const offset = position - marker.at - MARKER.length;
  if (offset < 0) return marker.span;
  return { start: marker.span.end + offset, end: marker.span.end + offset + 1 };
};

type Rule = (text: string) => RedactionSpan[];

const TOKEN_RULES: readonly Rule[] = TOKEN_PATTERNS.map((pattern) => (text: string) => patternSpans(text, pattern));

/**
 * The key-value rules in the shapes they had before a key could run on
 * through `.` or `-`, take `=>`, or hold a template literal. A value that a
 * broader rule replaced first could hide a key whose bare value runs on past
 * it, so every step that runs before another rule keeps these shapes; the
 * broader rules run on the original text and as the last step. Each key word
 * is taken whole, as above, which matches the same text without backtracking
 * through it.
 */
const PREVIOUS_QUOTED_ASSIGNMENT = /\b(?=\w*(?:key|token|secret|password))(?=(\w*))\1["']?\s*[:=]\s*"(?:\\.|[^"\\])*"/gi;
const PREVIOUS_BARE_ASSIGNMENT = /\b(?=\w*(?:key|token|secret|password))(?=(\w*))\1\s*[:=]\s*\S{8,}/gi;
const PREVIOUS_SINGLE_QUOTED_OPENING = /\b(?=\w*(?:key|token|secret|password))(?=(\w*))\1["']?\s*[:=]\s*'/gi;
const PREVIOUS_BRACKETED_OPENING = /\b(?=\w*(?:key|token|secret|password))(?=(\w*))\1["']?\s*[:=]\s*[[{]/gi;

const previousQuotedRule: Rule = (text) => patternSpans(text, PREVIOUS_QUOTED_ASSIGNMENT);

// The legacy bare rule must also leave no-space arrow parameters alone.
const previousBareRule: Rule = (text) => {
  const commas = parameterCommas(text);
  return [...text.matchAll(PREVIOUS_BARE_ASSIGNMENT)]
    .filter((match) => !isArrowParameter(text, { start: match.index, separator: skipWhitespace(text, match.index + match[1].length), quoted: false }, commas))
    .map((match) => ({ start: match.index, end: match.index + match[0].length }));
};

/**
 * The first pass the bracketed rule made before: each array or object value
 * of a key in the previous shapes, merged with every token and previous-shape
 * scalar span that overlaps it, all found on the original text. A scalar
 * replaced on its own could remove a quote the bracket scan relies on, or
 * leave a scalar's tail after the value's marker.
 */
const previousBracketedComponents = (text: string): RedactionSpan[] => {
  const openings = patternSpans(text, PREVIOUS_BRACKETED_OPENING).map((span) => ({ start: span.start, bracket: span.end - 1 }));
  const values = mergeSpans(QUOTE_READINGS.flatMap((reading) => bracketedValues(text, openings, reading)));
  const scalars = [...TOKEN_RULES, previousQuotedRule].flatMap((rule) => rule(text));
  scalars.push(...previousBareRule(text));
  for (const opening of patternSpans(text, PREVIOUS_SINGLE_QUOTED_OPENING)) {
    const quote = opening.end - 1;
    scalars.push({ start: opening.start, end: yamlScalarEnd(text, quote) }, { start: opening.start, end: escapedScalarEnd(text, quote) });
  }
  let next = 0;
  return mergeSpans([...values, ...scalars]).filter((span) => {
    while (next < values.length && values[next].end <= span.start) next += 1;
    return next < values.length && values[next].start < span.end;
  });
};

const scalarValueRule: Rule = (text) => scalarValueSpans(text, credentialKeys(text));

/** The order the token and scalar rules have always run in, each on the output of the rules before it. */
const PREVIOUS_ORDER: readonly Rule[] = [...TOKEN_RULES, previousQuotedRule, scalarValueRule];

/** Everything one order of the rules removed, and how many separate spans its steps found. */
type Removal = { mask: RedactionSpan[]; count: number };

/**
 * Apply each rule to the text redacted so far, starting from `mask`, and
 * return everything removed as spans on the original text. A marker stands in
 * for whatever it replaced, so a later rule can match through it: a bare value
 * runs on through a marker that replaced whitespace, and a scalar ends at a
 * later quote when a marker replaced the one it would have stopped at.
 */
const sequentialMask = (text: string, mask: readonly RedactionSpan[], rules: readonly Rule[]): Removal => {
  let current = [...mask];
  let count = 0;
  let rendering = render(text, current);
  for (const rule of rules) {
    const found = rule(rendering.text);
    if (found.length === 0) continue;
    count += mergeSpans(found).length;
    const spans = found.map((span) => ({ start: sourceRange(rendering, span.start).start, end: sourceRange(rendering, span.end - 1).end }));
    current = mergeSpans([...current, ...spans]);
    rendering = render(text, current);
  }
  return { mask: current, count };
};

/** Union the full per-record rules with any projected cross-record spans. */
const redactSecrets = (text: string, additionalSpans: readonly RedactionSpan[] = []): { text: string; redactions: number } => {
  const keys = credentialKeys(text);
  const tokens = TOKEN_RULES.flatMap((rule) => rule(text));
  const everyRule = [...tokens, ...quotedValueSpans(text, keys), ...scalarValueSpans(text, keys), ...bracketedValueSpans(text, keys)];
  const previousOrder = sequentialMask(text, [], PREVIOUS_ORDER).mask;
  const components = previousBracketedComponents(text);
  const afterBracketedValues = sequentialMask(text, components, PREVIOUS_ORDER);
  const mask = mergeSpans([...everyRule, ...previousOrder, ...afterBracketedValues.mask, ...additionalSpans]);
  let next = 0;
  const added = mask.filter((span) => {
    while (next < afterBracketedValues.mask.length && afterBracketedValues.mask[next].end <= span.start) next += 1;
    return next === afterBracketedValues.mask.length || afterBracketedValues.mask[next].start >= span.end;
  }).length;
  return { text: render(text, mask).text, redactions: components.length + afterBracketedValues.count + added };
};

/**
 * Replace credential-shaped spans with a marker and report how many were
 * removed. A replacement can hide a key from a later rule, and it
 * can also let a later rule's value run on through its marker, so no single
 * order of the rules removes everything. The spans of three orders are merged
 * on the original text before anything is replaced:
 *
 * - every rule on the original text at once, so no match can hide the next
 *   key's own value;
 * - the previous order of the token and scalar rules;
 * - the same order after the first pass the bracketed rule made before.
 *
 * The result removes everything any one of them would. The count follows
 * the previous rules' steps, each step of the last order counting the
 * separate spans it found, plus one for each span only another order found.
 * Rare structured inputs can differ by one from the previous count even
 * when the redacted text is identical; this is not a count of merged spans.
 */
export const redactSupervisorSecrets = (text: string): { text: string; redactions: number } => redactSecrets(text);

/**
 * Redact record texts before any of them is clipped or loses a credential key.
 * Only closed PEM/quoted/flow values may cross records. Project their spans
 * back onto the original records and union with each record's full rules, so
 * neither a cross-record replacement nor an unclosed value can hide a match.
 */
export const redactSupervisorSecretParts = (parts: readonly string[]): { text: string; redactions: number }[] => {
  if (parts.length < 2) return parts.map(redactSupervisorSecrets);
  const text = parts.join("\n");
  const keys = credentialKeys(text);
  const mask = mergeSpans([
    ...patternSpans(text, PRIVATE_KEY_PATTERN),
    ...quotedValueSpans(text, keys, true),
    ...scalarValueSpans(text, keys, true),
    ...bracketedValueSpans(text, keys, true),
  ]);
  let offset = 0;
  let next = 0;
  return parts.map((part) => {
    const start = offset;
    offset += part.length + 1;
    const end = start + part.length;
    while (next < mask.length && mask[next].end <= start) next += 1;
    const spans: RedactionSpan[] = [];
    for (let at = next; at < mask.length && mask[at].start < end; at += 1) {
      spans.push({ start: Math.max(start, mask[at].start) - start, end: Math.min(end, mask[at].end) - start });
    }
    return redactSecrets(part, spans);
  });
};
