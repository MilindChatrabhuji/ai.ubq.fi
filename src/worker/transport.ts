import { AuthorityError, type AccountBinding, type DispatchProvider, type GatewayRoute, type TerminalEvidence } from "../authority/contracts.ts";

export type ValidatedGatewayInput = Readonly<{ route: GatewayRoute; model: string; stream: boolean; body: Readonly<Record<string, unknown>> }>;
export type UpstreamAttempt = Readonly<{ provider: DispatchProvider; account: AccountBinding | null; maximumExposureMicrocredits: number }>;
export type UpstreamResult = Readonly<{ response: Response; terminal: Promise<TerminalEvidence> }>;
/** Each implementation pins destinations, provider translation, credentials and schema/catalog policy. */
export type UpstreamTransport = {
  validate(route: GatewayRoute, body: Readonly<Record<string, unknown>>): Promise<ValidatedGatewayInput>;
  attempt(input: ValidatedGatewayInput, account: AccountBinding | null): Promise<UpstreamAttempt>;
  /** Resolving onDispatched is mandatory immediately before the actual provider fetch. */
  dispatch(input: ValidatedGatewayInput, attempt: UpstreamAttempt, signal: AbortSignal, onDispatched: () => Promise<void>): Promise<UpstreamResult>;
};

/** Fixed HTTP upstream capability for official Responses/chat pass-through fixtures/adapters. */
export class HttpUpstreamTransport implements UpstreamTransport {
  constructor(
    private readonly _capability: Readonly<{
      provider: DispatchProvider;
      fetch: (request: Request) => Promise<Response>;
      baseUrl: string;
      headers: (account: AccountBinding | null) => Promise<Headers>;
      validate: UpstreamTransport["validate"];
      observe: (response: Response, input: ValidatedGatewayInput) => UpstreamResult;
      maximumExposureMicrocredits: number;
    }>
  ) {
    const base = new URL(this._capability.baseUrl);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== "/")
      throw new AuthorityError("invalid_fixed_upstream", 400);
  }

  async validate(route: GatewayRoute, body: Readonly<Record<string, unknown>>): Promise<ValidatedGatewayInput> {
    const input = await this._capability.validate(route, body);
    if (
      input.route !== route ||
      typeof input.model !== "string" ||
      input.model.length === 0 ||
      input.body.model !== input.model ||
      typeof input.stream !== "boolean"
    )
      throw new AuthorityError("invalid_validated_request", 400);
    return input;
  }

  attempt(_input: ValidatedGatewayInput, account: AccountBinding | null): Promise<UpstreamAttempt> {
    if (this._capability.provider === "codex" && !account) throw new AuthorityError("subscription_unavailable", 503);
    return Promise.resolve({
      provider: this._capability.provider,
      account: this._capability.provider === "codex" ? account : null,
      maximumExposureMicrocredits: this._capability.maximumExposureMicrocredits,
    });
  }

  async dispatch(input: ValidatedGatewayInput, attempt: UpstreamAttempt, signal: AbortSignal, onDispatched: () => Promise<void>): Promise<UpstreamResult> {
    if (attempt.provider !== this._capability.provider) throw new AuthorityError("provider_capability_mismatch", 403);
    const headers = await this._capability.headers(attempt.account);
    headers.set("content-type", "application/json");
    const request = new Request(new URL(input.route, this._capability.baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify(input.body),
      signal,
      redirect: "manual",
    });
    signal.throwIfAborted();
    await onDispatched();
    // Once dispatch intent is durable, ambiguous fetch failures keep accounting pending.
    const fetchUpstream = this._capability.fetch;
    const response = await fetchUpstream(request);
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new AuthorityError("upstream_redirect_refused", 502);
    }
    // Observe one streaming body; cloning would allow a faster terminal reader to buffer unbounded data.
    return this._capability.observe(response, input);
  }
}
