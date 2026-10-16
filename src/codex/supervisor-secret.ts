/**
 * Credential-shaped text in supervisor transcript excerpts.
 *
 * Transcript bytes leave the host for an external summarizer, so redaction is
 * deliberately over-broad: a false positive costs a little context, while a
 * false negative discloses a credential. The patterns stay simple on purpose;
 * this is a bounded sanitizer, not a JSON parser or a secret classifier.
 */

type RedactionSpan = { start: number; end: number };

/** Patterns whose match end is unambiguous, applied to the text in order. */
export const SUPERVISOR_SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{12,}/g,
  /\b(?:sk|ghp|gho|ghu|ghs|dsk)-[A-Za-z0-9_-]{12,}/g,
  /(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{12,}/g,
  /github_pat_\w{12,}/g,
  /\bu_[0-9a-fA-F]{32,}\b/g,
  /\b\w*(?:key|token|secret|password)\w*["']?\s*[:=]\s*"(?:\\.|[^"\\])*"/gi,
];

/** Last-resort fallback: a credential-key assignment with a token-like value. */
const KEYED_ASSIGNMENT = /\b\w*(?:key|token|secret|password)\w*\s*[:=]\s*\S{8,}/gi;

/** Opening of a credential assignment whose value is a single-quoted scalar. */
const SINGLE_QUOTED_ASSIGNMENT = /\b\w*(?:key|token|secret|password)\w*["']?\s*[:=]\s*'/gi;

/** Opening of a credential assignment whose value is an array or object, a quoted key included. */
const BRACKETED_ASSIGNMENT = /\b\w*(?:key|token|secret|password)\w*["']?\s*[:=]\s*[[{]/gi;

/** End of the scalar read as YAML: `''` is an escaped quote and a backslash is content. */
const yamlScalarEnd = (text: string, openQuote: number): number => {
  for (let index = openQuote + 1; index < text.length; index += 1) {
    if (text[index] !== "'") continue;
    if (text[index + 1] === "'") {
      index += 1;
      continue;
    }
    return index + 1;
  }
  // A scalar with no closing quote was clipped, so redact its whole tail.
  return text.length;
};

/** End of the scalar read with the pre-existing rule that `\x` escapes the next character. */
const escapedScalarEnd = (text: string, openQuote: number): number => {
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
  return text.length;
};

/**
 * How one reading treats a quote inside a bracketed value. A JSON or Python
 * string escapes with a backslash. YAML reads a backslash in a single-quoted
 * string as content, and in a flow collection it opens a string only where a
 * scalar starts, so the apostrophe in a plain scalar such as `it's` is
 * content. Every reading's spans are kept, so a reading that misreads a quote
 * can only widen a redaction, never narrow it.
 */
type QuoteReading = { yamlSingleQuotes: boolean; flowScalars: boolean };

const QUOTE_READINGS: readonly QuoteReading[] = [
  // JSON and Python: a backslash escapes in either string kind.
  { yamlSingleQuotes: false, flowScalars: false },
  // YAML quoting, with every quote opening a string.
  { yamlSingleQuotes: true, flowScalars: false },
  // YAML flow: a quote opens a string only where a scalar starts.
  { yamlSingleQuotes: true, flowScalars: true },
];

/** A character after which a YAML flow scalar, and so a quoted string, can start. */
const SCALAR_START = new Set(["[", "{", ",", ":"]);

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
    if ((character === '"' || character === "'") && (scalarStart || !reading.flowScalars)) scan.quote = character;
    else if (character === "[" || character === "{") scan.depth += 1;
    else if (character === "]" || character === "}") scan.depth -= 1;
  } else if (character === "\\") {
    scan.escaped = scan.quote === '"' || !reading.yamlSingleQuotes;
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

/** Replace each span with the marker, measured on the text the spans came from. */
const replaceSpans = (text: string, spans: readonly RedactionSpan[]): string => {
  let redacted = "";
  let cursor = 0;
  for (const span of spans) {
    redacted += text.slice(cursor, span.start) + "[redacted]";
    cursor = span.end;
  }
  return redacted + text.slice(cursor);
};

/** The fallback assignment matches and every single-quoted reading, as spans on one text. */
const assignmentSpans = (text: string): RedactionSpan[] => {
  const spans: RedactionSpan[] = [];
  for (const match of text.matchAll(KEYED_ASSIGNMENT)) {
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  for (const match of text.matchAll(SINGLE_QUOTED_ASSIGNMENT)) {
    const start = match.index;
    const openQuote = start + match[0].length - 1;
    spans.push({ start, end: yamlScalarEnd(text, openQuote) }, { start, end: escapedScalarEnd(text, openQuote) });
  }
  return spans;
};

/**
 * A single-quoted scalar has no single unambiguous end: YAML reads a backslash
 * as ordinary content and `''` as an escaped quote, while the pre-existing
 * support also accepted `\x` as an escape. Every reading's candidate end is
 * collected on the same text, the fallback assignment matches are added, and
 * overlapping spans are merged before replacement, because committing to one
 * longer reading alone can erase the next assignment's key and leave its value
 * behind.
 */
const redactAmbiguousAssignments = (text: string): { text: string; redactions: number } => {
  const merged = mergeSpans(assignmentSpans(text));
  return { text: replaceSpans(text, merged), redactions: merged.length };
};

/**
 * A credential key whose value is an array or object is redacted through the
 * bracket that closes it, nested values included, on the original text: a
 * scalar replacement made first could remove a quote this scan relies on.
 * Every quote reading scans every value from its own opening bracket, all the
 * readings' spans are kept, and every scalar span overlapping one is merged
 * into it. A value written as JSON or as a Python repr, or in YAML flow style
 * where a quote follows `[`, `{`, `,` or `:` exactly when it opens a quoted
 * scalar and no comment holds a quote or bracket, is therefore redacted
 * through its real closing bracket by the reading that matches it. A
 * credential nested in a value that a reading ends too early is still scanned
 * from its own key. Other text, such as code, a YAML comment, or a tag or
 * anchor before a quoted scalar, can hold a quote or bracket that every
 * reading misreads; the value then ends early, and the rest of it is redacted
 * only where another rule matches it.
 */
const redactBracketedAssignments = (text: string): { text: string; redactions: number } => {
  const openings = [...text.matchAll(BRACKETED_ASSIGNMENT)].map((match) => ({
    start: match.index,
    bracket: match.index + match[0].length - 1,
  }));
  if (openings.length === 0) return { text, redactions: 0 };
  const values = QUOTE_READINGS.flatMap((reading) => bracketedValues(text, openings, reading)).sort((left, right) => left.start - right.start);
  const scalars = [...SUPERVISOR_SECRET_PATTERNS].flatMap((pattern) =>
    [...text.matchAll(pattern)].map((match) => ({ start: match.index, end: match.index + match[0].length }))
  );
  // Keep only the merged spans that hold a bracketed value; the scalar rules
  // still own every other span. Both lists are ordered, so one walk decides.
  let next = 0;
  const merged = mergeSpans([...values, ...scalars, ...assignmentSpans(text)]).filter((span) => {
    const holdsValue = next < values.length && values[next].start < span.end;
    while (next < values.length && values[next].start < span.end) next += 1;
    return holdsValue;
  });
  return { text: replaceSpans(text, merged), redactions: merged.length };
};

/** Replace credential-shaped spans with a marker and report how many were removed. */
export const redactSupervisorSecrets = (text: string): { text: string; redactions: number } => {
  const bracketed = redactBracketedAssignments(text);
  let redacted = bracketed.text;
  let redactions = bracketed.redactions;
  for (const pattern of SUPERVISOR_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, () => {
      redactions += 1;
      return "[redacted]";
    });
  }
  const ambiguous = redactAmbiguousAssignments(redacted);
  return { text: ambiguous.text, redactions: redactions + ambiguous.redactions };
};
