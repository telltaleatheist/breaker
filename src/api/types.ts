/**
 * Pi-hole v6 wire types.
 *
 * Transcribed from the Pi-hole v6 OpenAPI spec (auth/dns/domains/clients/groups/
 * queries/info/network .yaml) — only the fields Breaker actually reads or sends.
 * Deliberately NOT a generated full-surface client: a smaller hand-kept surface is
 * a smaller thing to re-verify when Pi-hole v7 lands, and everything here has been
 * seen on the wire of a real v6.4.3 / FTL 6.7.
 *
 * Every response also carries `took` (seconds the server spent); we never use it,
 * so it is not modelled.
 */

// ─── Errors as Pi-hole reports them ───────────────────────────────────────────

/**
 * The error envelope FTL returns on 4xx/5xx. `key` is the machine-readable type
 * ("unauthorized", "bad_request", "database_error", ...), `message` is meant for
 * humans, `hint` is sometimes the useful half (e.g. "The item is already present").
 */
export interface PiholeErrorBody {
  error: {
    key: string;
    message: string;
    hint: string | null;
  };
}

// ─── /auth ────────────────────────────────────────────────────────────────────

export interface SessionInfo {
  /** true when this response represents an authenticated session */
  valid: boolean;
  /** whether 2FA (TOTP) is enabled on this Pi-hole — the login needs a TOTP code */
  totp: boolean;
  /**
   * Session ID, sent back as the `sid` request header.
   * NULL is not an error: a Pi-hole with no password answers `valid:true, sid:null`
   * ("no auth for local user"), and then no header is needed at all.
   */
  sid: string | null;
  /** CSRF token — only required for cookie auth, which we do not use */
  csrf: string | null;
  /** remaining lifetime in SECONDS (1800 on a default v6.4.3) */
  validity: number;
  /** human-readable status, e.g. "correct password" / "password incorrect" */
  message: string | null;
}

export interface AuthResponse {
  session: SessionInfo;
}

// ─── /info ────────────────────────────────────────────────────────────────────

/**
 * `GET /api/info/client` — the ONE endpoint that needs no authentication
 * (`security: []` in info.yaml). It reports the request's own source address,
 * which is how Breaker learns which client Pi-hole thinks this browser is.
 */
export interface InfoClientResponse {
  remote_addr: string;
  http_version: string;
  method: string;
}

export interface VersionBranch {
  branch?: string | null;
  version: string | null;
  hash?: string | null;
}

export interface VersionComponent {
  local: VersionBranch;
  remote: VersionBranch;
}

export interface VersionResponse {
  version: {
    core: VersionComponent;
    web: VersionComponent;
    ftl: VersionComponent;
  };
}

// ─── /dns/blocking ────────────────────────────────────────────────────────────

export type BlockingStatus = 'enabled' | 'disabled' | 'failed' | 'unknown';

export interface BlockingResponse {
  blocking: BlockingStatus;
  /**
   * Seconds until Pi-hole flips the mode back on its own, or null when the
   * current mode is permanent. Pi-hole owns this countdown — Breaker displays it
   * rather than running a second timer that could disagree.
   */
  timer: number | null;
}

export interface BlockingRequest {
  blocking: boolean;
  timer: number | null;
}

// ─── /groups ──────────────────────────────────────────────────────────────────

export interface Group {
  name: string;
  comment: string | null;
  enabled: boolean;
  id: number;
  date_added: number;
  date_modified: number;
}

export interface GroupsResponse {
  groups: Group[];
}

export interface GroupCreateRequest {
  name: string;
  comment: string | null;
  enabled: boolean;
}

// ─── /clients ─────────────────────────────────────────────────────────────────

export interface PiholeClientEntry {
  /** IP, MAC, hostname or interface — whatever the entry was created with */
  client: string;
  /** hostname, only populated when `client` is an IP address */
  name?: string | null;
  comment: string | null;
  /** group IDs this client belongs to. 0 is "Default". */
  groups: number[];
  id: number;
  date_added: number;
  date_modified: number;
}

export interface ClientsResponse {
  clients: PiholeClientEntry[];
}

export interface ClientCreateRequest {
  client: string;
  comment: string | null;
  groups: number[];
}

/** PUT /clients/{client} — the URL carries the identity, the body the rest. */
export interface ClientUpdateRequest {
  comment: string | null;
  groups: number[];
}

// ─── /domains ─────────────────────────────────────────────────────────────────

export type DomainType = 'allow' | 'deny';
export type DomainKind = 'exact' | 'regex';

export interface Domain {
  domain: string;
  unicode?: string;
  type: DomainType;
  kind: DomainKind;
  comment: string | null;
  groups: number[];
  enabled: boolean;
  id: number;
  date_added: number;
  date_modified: number;
}

export interface DomainsResponse {
  domains: Domain[];
}

export interface DomainCreateRequest {
  domain: string;
  comment: string | null;
  groups: number[];
  enabled: boolean;
}

/**
 * `PUT /domains/{type}/{kind}/{domain}` — a full replacement, not a patch.
 *
 * `type` and `kind` must BOTH be sent even when unchanged: the spec uses them to
 * move an entry between lists (deny→allow), so omitting one is how you accidentally
 * relocate a rule. Any field left out is dropped from the stored entry.
 */
export interface DomainUpdateRequest {
  type: DomainType;
  kind: DomainKind;
  comment: string | null;
  groups: number[];
  enabled: boolean;
}

// ─── /queries ─────────────────────────────────────────────────────────────────

export interface Query {
  /** epoch SECONDS, fractional */
  time: number;
  type: string;
  domain: string;
  cname: string | null;
  status: string | null;
  client: {
    ip: string;
    name: string | null;
  };
}

export interface QueriesResponse {
  queries: Query[];
  cursor: number;
  recordsTotal: number;
  recordsFiltered: number;
}

export interface QueriesParams {
  /** epoch seconds — only queries at or after this time */
  from?: number;
  until?: number;
  length?: number;
  client_ip?: string;
  domain?: string;
}

/**
 * Query statuses that mean "Pi-hole itself refused this name".
 *
 * The full status list is in stats.yaml (`status` counters). Everything not in
 * this set — FORWARDED, CACHE, CACHE_STALE, RETRIED, IN_PROGRESS, DBBUSY,
 * UNKNOWN — means the name was answered normally, so a page failure with one of
 * those statuses is NOT something allowing the domain will fix.
 */
export const BLOCKED_QUERY_STATUSES: ReadonlySet<string> = new Set([
  'GRAVITY',
  'REGEX',
  'DENYLIST',
  'GRAVITY_CNAME',
  'REGEX_CNAME',
  'DENYLIST_CNAME',
  'EXTERNAL_BLOCKED_IP',
  'EXTERNAL_BLOCKED_NULL',
  'EXTERNAL_BLOCKED_NXRA',
  'EXTERNAL_BLOCKED_EDE15',
  'SPECIAL_DOMAIN'
]);

// ─── /network/devices ─────────────────────────────────────────────────────────

export interface NetworkDeviceAddress {
  ip: string;
  name: string | null;
  lastSeen: number;
  nameUpdated: number;
}

export interface NetworkDevice {
  id: number;
  hwaddr: string;
  interface: string;
  firstSeen: number;
  lastQuery: number;
  numQueries: number;
  macVendor: string | null;
  ips: NetworkDeviceAddress[];
}

export interface NetworkDevicesResponse {
  devices: NetworkDevice[];
}

// ─── /config/dns/blockTTL ─────────────────────────────────────────────────────

/**
 * `GET /api/config/dns/blockTTL` answers with the config tree pruned to the
 * requested element, i.e. `{config:{dns:{blockTTL:2}}}` — not a bare number.
 */
export interface BlockTtlResponse {
  config: {
    dns: {
      blockTTL: number;
    };
  };
}
