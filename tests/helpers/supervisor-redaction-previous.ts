/**
 * The supervisor redaction rules as they stood before arrays and objects were
 * redacted (`src/codex/supervisor-secret.ts` at 6e14d507^), kept verbatim as
 * the reference for a differential test: the current rules must remove
 * everything these removed.
 */

type RedactionSpan = { start: number; end: number };

/** Patterns whose match end is unambiguous, applied to the text in order. */
const SUPERVISOR_SECRET_PATTERNS: readonly RegExp[] = [
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
  const spans: RedactionSpan[] = [];
  for (const match of text.matchAll(KEYED_ASSIGNMENT)) {
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  for (const match of text.matchAll(SINGLE_QUOTED_ASSIGNMENT)) {
    const start = match.index;
    const openQuote = start + match[0].length - 1;
    spans.push({ start, end: yamlScalarEnd(text, openQuote) }, { start, end: escapedScalarEnd(text, openQuote) });
  }
  const merged = mergeSpans(spans);
  return { text: replaceSpans(text, merged), redactions: merged.length };
};

/** Replace credential-shaped spans with a marker and report how many were removed, as the previous rules did. */
export const redactWithPreviousRules = (text: string): { text: string; redactions: number } => {
  let redacted = text;
  let redactions = 0;
  for (const pattern of SUPERVISOR_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, () => {
      redactions += 1;
      return "[redacted]";
    });
  }
  const ambiguous = redactAmbiguousAssignments(redacted);
  return { text: ambiguous.text, redactions: redactions + ambiguous.redactions };
};
