/**
 * PiholeClient — the ONLY thing in Breaker that knows Pi-hole exists.
 *
 * Deliberately free of `chrome.*`: it is plain `fetch` over plain types, so the
 * unit tests drive it with a stub fetch and `scripts/live-check.mjs` drives the
 * very same code against a real Pi. Everything above this file (background,
 * popup, options) talks in Breaker's own vocabulary, which is what makes a second
 * backend a matter of adding a sibling module rather than a rewrite.
 *
 * Session handling, and why it looks like this:
 *  - `POST /api/auth {password}` mints a SID that is valid for `validity` seconds
 *    (1800 on a stock v6.4.3). Any authenticated request refreshes it, so a busy
 *    session effectively never expires — but a popup opened an hour later finds a
 *    dead one, and the only honest signal for that is the 401.
 *  - So: keep the SID, re-authenticate exactly ONCE on a 401, retry the request,
 *    and if that 401s too, throw. Retrying forever against a wrong password is how
 *    you get rate-limited (`too_many_requests`) and locked out of your own Pi-hole.
 *  - The password is held to mint sessions and is never written to a log line.
 */

import type {
  AuthResponse,
  BlockingRequest,
  BlockingResponse,
  BlockTtlResponse,
  ClientCreateRequest,
  ClientsResponse,
  ClientUpdateRequest,
  Domain,
  DomainCreateRequest,
  DomainKind,
  DomainsResponse,
  DomainType,
  DomainUpdateRequest,
  Group,
  GroupCreateRequest,
  GroupsResponse,
  InfoClientResponse,
  NetworkDevice,
  NetworkDevicesResponse,
  PiholeClientEntry,
  PiholeErrorBody,
  QueriesParams,
  QueriesResponse,
  Query,
  SessionInfo,
  VersionResponse
} from './types';
import { PiholeVersionError, requireV6, type ParsedVersion } from './version';

export { PiholeVersionError };

// ─── Errors ───────────────────────────────────────────────────────────────────

/** Base for every failure this module raises, so callers can catch one thing. */
export class PiholeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PiholeError';
  }
}

/**
 * The Pi-hole answered, and it answered with a failure. Carries FTL's own
 * `error.key`/`hint` because those are frequently the actionable half — e.g.
 * key "database_error", hint "The item is already present".
 */
export class PiholeHttpError extends PiholeError {
  readonly status: number;
  readonly key: string | null;
  readonly hint: string | null;
  readonly url: string;

  constructor(options: {
    status: number;
    message: string;
    key: string | null;
    hint: string | null;
    url: string;
  }) {
    super(options.message);
    this.name = 'PiholeHttpError';
    this.status = options.status;
    this.key = options.key;
    this.hint = options.hint;
    this.url = options.url;
  }
}

/**
 * Authentication itself failed: wrong password, or 2FA is on and a bare password
 * cannot satisfy it. `totpRequired` is what the options page turns into the
 * "make an app password" advice.
 */
export class PiholeAuthError extends PiholeError {
  readonly totpRequired: boolean;

  constructor(message: string, totpRequired = false) {
    super(message);
    this.name = 'PiholeAuthError';
    this.totpRequired = totpRequired;
  }
}

/**
 * The request never reached a Pi-hole at all (wrong host, wrong port, nothing
 * listening, TLS refused). Distinct from PiholeHttpError on purpose: "I cannot
 * find your Pi-hole" and "your Pi-hole said no" want completely different
 * troubleshooting, and collapsing them into one message wastes the user's time.
 */
export class PiholeNetworkError extends PiholeError {
  readonly url: string;

  constructor(message: string, url: string, cause: unknown) {
    // The underlying TypeError rides along as the standard `cause` rather than a
    // field of our own — it is the same information, and devtools already knows
    // how to unwrap it.
    super(message, { cause });
    this.name = 'PiholeNetworkError';
    this.url = url;
  }
}

// ─── Session ──────────────────────────────────────────────────────────────────

export interface StoredSession {
  /**
   * The SID to send as the `sid` header. NULL means "this Pi-hole has no password
   * and asked for no authentication" — a real, supported state, not a missing value.
   */
  sid: string | null;
  csrf: string | null;
  /** epoch milliseconds at which the SID is known-stale (login time + validity) */
  expiresAt: number;
}

export interface PiholeClientOptions {
  /** e.g. "http://pi.hole" or "http://192.168.68.85" — with or without /api */
  baseUrl: string;
  password: string;
  /** a session recovered from storage, so a service-worker restart does not re-login */
  session?: StoredSession | null;
  /** called whenever the session changes (minted, refreshed, or cleared) */
  onSession?: (session: StoredSession | null) => void | Promise<void>;
  /** injected for tests and for Node, where `fetch` is global but not bound */
  fetchImpl?: typeof fetch;
  /** injected for tests */
  now?: () => number;
}

// ─── URL handling ─────────────────────────────────────────────────────────────

/**
 * Turn whatever the user typed into the API root.
 *
 * People paste the address bar, so the common inputs are "pi.hole",
 * "http://pi.hole/admin", "http://192.168.68.85/admin/settings/api" and
 * "http://pi.hole/api/". All of them mean the same Pi-hole. Bare hosts get http://
 * because Pi-hole's own default listener is plain HTTP on port 80 — a stock box
 * has no certificate, and silently trying https first would just produce a
 * confusing TLS error.
 *
 * @throws PiholeError when the result is not a usable http(s) URL.
 */
export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '') throw new PiholeError('No Pi-hole address given.');

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new PiholeError(`"${input}" is not a valid address.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PiholeError(`"${input}" must be an http:// or https:// address.`);
  }

  // Drop the web-UI and API path suffixes people paste along with the host.
  let path = url.pathname.replace(/\/+$/, '');
  path = path.replace(/\/admin(\/.*)?$/i, '');
  path = path.replace(/\/api$/i, '');

  return `${url.origin}${path}`;
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class PiholeClient {
  readonly baseUrl: string;

  private readonly password: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly onSession: ((session: StoredSession | null) => void | Promise<void>) | undefined;

  private session: StoredSession | null;
  /** de-duplicates concurrent logins: several requests must not each mint a SID */
  private loginInFlight: Promise<StoredSession> | null = null;

  constructor(options: PiholeClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.password = options.password;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => Date.now());
    this.onSession = options.onSession;
    this.session = options.session ?? null;
  }

  /** The session as it stands, for persisting outside this module. */
  getSession(): StoredSession | null {
    return this.session;
  }

  // ── session plumbing ────────────────────────────────────────────────────────

  private async setSession(session: StoredSession | null): Promise<void> {
    this.session = session;
    if (this.onSession) await this.onSession(session);
  }

  /**
   * Mint a session. `POST /api/auth` is the one authenticated-adjacent call that
   * must not carry a SID, and the one place the password is used.
   */
  async login(): Promise<StoredSession> {
    if (this.loginInFlight) return this.loginInFlight;

    const attempt = (async (): Promise<StoredSession> => {
      const url = this.apiUrl('/auth');
      const response = await this.rawFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: this.password })
      });

      const body = await readJson<AuthResponse & Partial<PiholeErrorBody>>(response, url);

      // 429 is FTL's rate limiter or its session-seat limit. Both are real states
      // with real advice, so they get their own message rather than a bare 429.
      if (response.status === 429) {
        const key = body?.error?.key ?? '';
        throw new PiholeAuthError(
          key === 'no_seats'
            ? 'Pi-hole has no free session seats left. Log some sessions out in ' +
              'Pi-hole (Settings → Web interface → Sessions) and try again.'
            : 'Pi-hole is rate-limiting login attempts. Wait a moment before trying again.'
        );
      }

      const session: SessionInfo | undefined = body?.session;
      if (!session || !session.valid) {
        const reported = session?.message ?? body?.error?.message ?? `HTTP ${response.status}`;
        const totpRequired = session?.totp === true;
        throw new PiholeAuthError(
          totpRequired
            ? `Pi-hole rejected the login (${reported}). This Pi-hole has two-factor ` +
              `authentication enabled, and a plain password cannot satisfy it. Create an ` +
              `app password in Pi-hole (Settings → Web interface → App password) and use ` +
              `that here instead.`
            : `Pi-hole rejected the login: ${reported}`,
          totpRequired
        );
      }

      // validity is SECONDS. Shave 30s off so a request is never sent with a SID
      // that expires while it is in flight.
      const lifetimeMs = Math.max(0, (session.validity - 30) * 1000);
      const stored: StoredSession = {
        sid: session.sid,
        csrf: session.csrf,
        expiresAt: this.now() + lifetimeMs
      };
      await this.setSession(stored);
      return stored;
    })();

    this.loginInFlight = attempt;
    try {
      return await attempt;
    } finally {
      this.loginInFlight = null;
    }
  }

  /**
   * `DELETE /api/auth` — invalidates the SID server-side. Worth doing on an
   * explicit disconnect: Pi-hole has a finite number of session seats.
   */
  async logout(): Promise<void> {
    const current = this.session;
    await this.setSession(null);
    if (!current || current.sid === null) return;
    const url = this.apiUrl('/auth');
    // A 404 here means "no session active", which is the state we wanted anyway.
    const response = await this.rawFetch(url, { method: 'DELETE', headers: { sid: current.sid } });
    if (!response.ok && response.status !== 404) {
      await this.fail(response, url);
    }
  }

  // ── request core ────────────────────────────────────────────────────────────

  private apiUrl(path: string, query?: Record<string, string | number | undefined>): string {
    const url = new URL(`${this.baseUrl}/api${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  /** fetch that turns a transport failure into a named error instead of a TypeError. */
  private async rawFetch(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, init);
    } catch (cause) {
      throw new PiholeNetworkError(
        `Could not reach Pi-hole at ${this.baseUrl} — nothing answered. Check the ` +
          `address, that the Pi-hole is running, and that this machine is on the same ` +
          `network.`,
        url,
        cause
      );
    }
  }

  /** Read FTL's error envelope and throw the richest message we can build from it. */
  private async fail(response: Response, url: string): Promise<never> {
    const body = await readJson<Partial<PiholeErrorBody>>(response, url);
    const error = body?.error;
    const parts = [error?.message, error?.hint].filter(
      (part): part is string => typeof part === 'string' && part.length > 0
    );
    throw new PiholeHttpError({
      status: response.status,
      message:
        parts.length > 0
          ? `Pi-hole: ${parts.join(' — ')}`
          : `Pi-hole returned HTTP ${response.status} for ${url}`,
      key: error?.key ?? null,
      hint: error?.hint ?? null,
      url
    });
  }

  /**
   * One authenticated request, with the single re-auth retry.
   *
   * `auth: false` is only for `GET /api/info/client`, which the spec marks
   * `security: []` — we use it before there is any session, to learn our own IP.
   */
  private async request<T>(
    method: string,
    path: string,
    options: {
      query?: Record<string, string | number | undefined>;
      body?: unknown;
      auth?: boolean;
    } = {}
  ): Promise<T> {
    const auth = options.auth !== false;
    const url = this.apiUrl(path, options.query);

    const send = async (): Promise<Response> => {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (options.body !== undefined) headers['content-type'] = 'application/json';
      if (auth) {
        const session = await this.ensureSession();
        // The header is literally `sid`. (X-FTL-SID works too; `sid` is what the
        // spec lists first and what FTL's own web UI sends.)
        if (session.sid !== null) headers['sid'] = session.sid;
      }
      return this.rawFetch(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
      });
    };

    let response = await send();

    if (response.status === 401 && auth) {
      // The SID died (expired, or Pi-hole restarted, or the password changed).
      // Drop it, log in once, retry once. Never more than once.
      await this.setSession(null);
      await this.login();
      response = await send();
      if (response.status === 401) {
        const body = await readJson<Partial<PiholeErrorBody>>(response, url);
        throw new PiholeAuthError(
          `Pi-hole rejected the request even after re-authenticating: ${
            body?.error?.message ?? 'unauthorized'
          }`
        );
      }
    }

    if (!response.ok) await this.fail(response, url);

    // 204 No Content is the documented success for DELETE.
    if (response.status === 204) return undefined as T;
    const parsed = await readJson<T>(response, url);
    if (parsed === null) {
      throw new PiholeHttpError({
        status: response.status,
        message: `Pi-hole returned a non-JSON body for ${url}`,
        key: null,
        hint: null,
        url
      });
    }
    return parsed;
  }

  private async ensureSession(): Promise<StoredSession> {
    const current = this.session;
    if (current && current.expiresAt > this.now()) return current;
    return this.login();
  }

  // ── endpoints ───────────────────────────────────────────────────────────────

  /** `GET /api/info/client` — needs no auth; tells us our own address as Pi-hole sees it. */
  async getClientInfo(): Promise<InfoClientResponse> {
    return this.request<InfoClientResponse>('GET', '/info/client', { auth: false });
  }

  async getVersion(): Promise<VersionResponse> {
    return this.request<VersionResponse>('GET', '/info/version');
  }

  /**
   * Read the Pi-hole Core version and refuse anything below v6, by name.
   * Every connect goes through here — the gate is not optional or cached away.
   */
  async requireSupportedVersion(): Promise<ParsedVersion> {
    const response = await this.getVersion();
    return requireV6(response.version?.core?.local?.version);
  }

  async getBlocking(): Promise<BlockingResponse> {
    return this.request<BlockingResponse>('GET', '/dns/blocking');
  }

  /**
   * @param timerSeconds seconds after which Pi-hole flips back on its own, or
   *   null for "permanent, until something changes it".
   */
  async setBlocking(blocking: boolean, timerSeconds: number | null): Promise<BlockingResponse> {
    const body: BlockingRequest = { blocking, timer: timerSeconds };
    return this.request<BlockingResponse>('POST', '/dns/blocking', { body });
  }

  async getGroups(): Promise<Group[]> {
    const response = await this.request<GroupsResponse>('GET', '/groups');
    return response.groups;
  }

  async addGroup(request: GroupCreateRequest): Promise<Group[]> {
    const response = await this.request<GroupsResponse>('POST', '/groups', { body: request });
    return response.groups;
  }

  async deleteGroup(name: string): Promise<void> {
    await this.request<void>('DELETE', `/groups/${encodeURIComponent(name)}`);
  }

  async getClients(): Promise<PiholeClientEntry[]> {
    const response = await this.request<ClientsResponse>('GET', '/clients');
    return response.clients;
  }

  async addClient(request: ClientCreateRequest): Promise<PiholeClientEntry[]> {
    const response = await this.request<ClientsResponse>('POST', '/clients', { body: request });
    return response.clients;
  }

  async updateClient(client: string, request: ClientUpdateRequest): Promise<PiholeClientEntry[]> {
    const response = await this.request<ClientsResponse>(
      'PUT',
      `/clients/${encodeURIComponent(client)}`,
      { body: request }
    );
    return response.clients;
  }

  async deleteClient(client: string): Promise<void> {
    await this.request<void>('DELETE', `/clients/${encodeURIComponent(client)}`);
  }

  /**
   * `GET /api/network/devices`.
   *
   * The defaults are max_devices=10, max_addresses=3 — a household easily exceeds
   * both, and a truncated list silently loses the very device we are looking for.
   * So we always ask for a generous window rather than accepting the default.
   */
  async getNetworkDevices(maxDevices = 999, maxAddresses = 25): Promise<NetworkDevice[]> {
    const response = await this.request<NetworkDevicesResponse>('GET', '/network/devices', {
      query: { max_devices: maxDevices, max_addresses: maxAddresses }
    });
    return response.devices;
  }

  async getDomains(type: DomainType, kind: DomainKind): Promise<Domain[]> {
    const response = await this.request<DomainsResponse>('GET', `/domains/${type}/${kind}`);
    return response.domains;
  }

  async addDomain(
    type: DomainType,
    kind: DomainKind,
    request: DomainCreateRequest
  ): Promise<Domain[]> {
    const response = await this.request<DomainsResponse>('POST', `/domains/${type}/${kind}`, {
      body: request
    });
    return response.domains;
  }

  /**
   * Replace an existing entry. Used to move a Breaker grant's deadline without
   * losing its row (a delete+add would churn `id` and `date_added`, and briefly
   * un-allow the domain in between).
   */
  async updateDomain(
    type: DomainType,
    kind: DomainKind,
    domain: string,
    request: DomainUpdateRequest
  ): Promise<Domain[]> {
    const response = await this.request<DomainsResponse>(
      'PUT',
      `/domains/${type}/${kind}/${encodeURIComponent(domain)}`,
      { body: request }
    );
    return response.domains;
  }

  async deleteDomain(type: DomainType, kind: DomainKind, domain: string): Promise<void> {
    await this.request<void>('DELETE', `/domains/${type}/${kind}/${encodeURIComponent(domain)}`);
  }

  async getQueries(params: QueriesParams): Promise<Query[]> {
    const response = await this.request<QueriesResponse>('GET', '/queries', {
      query: {
        from: params.from,
        until: params.until,
        length: params.length,
        client_ip: params.client_ip,
        domain: params.domain
      }
    });
    return response.queries;
  }

  /**
   * TTL Pi-hole stamps on a blocked answer, in seconds (2 by default).
   *
   * This is why "allow, then reload the page" works so quickly: the browser's
   * cached NULL answer for the domain is already stale by the time the user has
   * finished clicking.
   */
  async getBlockTtl(): Promise<number> {
    const response = await this.request<BlockTtlResponse>('GET', '/config/dns/blockTTL');
    return response.config.dns.blockTTL;
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse a JSON body, tolerating an empty or non-JSON one (returns null).
 * FTL always sends JSON with an error envelope, but a reverse proxy in front of
 * it may not, and that must not surface as a JSON.parse SyntaxError.
 */
async function readJson<T>(response: Response, url: string): Promise<T | null> {
  let text: string;
  try {
    text = await response.text();
  } catch (cause) {
    throw new PiholeNetworkError(`The response from ${url} could not be read.`, url, cause);
  }
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
