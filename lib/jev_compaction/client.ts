/**
 * Ported from 0x4007/fast-jev-compaction (MIT), commit
 * c1eab5fdbd6bde7d67f2da070116496558836884, `src/client.ts`. Mechanical changes:
 * Deno `.ts` specifiers, repository formatting, credential injected by the
 * gateway instead of read from `process.env`, and an optional caller signal
 * forwarded to the transport so cancellation stops the Jev call. See ./LICENSE.
 */
import { buildJevRequest, parseJevResponse } from "./request.ts";
import type { JevAsker, JevQuestions, JevResponse, JevState } from "./types.ts";

export type JevFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type JevClientOptions = {
  /** Resolved by the caller; an absent key fails the call explicitly. */
  apiKey: string;
  /** Defaults to `jev-latest`. */
  model?: string;
  /** Defaults to the System One endpoint. */
  baseUrl?: string;
  /** Defaults to the global `fetch`. */
  fetch?: JevFetch;
  /** Caller-owned abort signal, forwarded to the underlying request. */
  signal?: AbortSignal;
};

/** Asks Jev over HTTP with the global `fetch` (or an injected one). */
export class JevClient implements JevAsker {
  private readonly apiKey: string;
  private readonly model: string | undefined;
  private readonly baseUrl: string | undefined;
  private readonly fetcher: JevFetch;
  private readonly signal: AbortSignal | undefined;

  constructor(options: JevClientOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = options.baseUrl;
    this.fetcher = options.fetch ?? fetch;
    this.signal = options.signal;
  }

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    if (!this.apiKey) throw new Error("TYPESAFE_API_KEY is not configured");
    const request = buildJevRequest({ apiKey: this.apiKey, model: this.model, baseUrl: this.baseUrl }, state, questions);
    const response = await this.fetcher(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      ...(this.signal ? { signal: this.signal } : {}),
    });
    return parseJevResponse(response.status, response.ok, await response.text());
  }
}
