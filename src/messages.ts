/**
 * The popup/options ↔ background contract.
 *
 * One discriminated union in, one `{ok}` envelope out, and a `send()` helper that
 * maps a request kind to its response payload. The point of the mapped type is
 * that adding a request without handling it, or reading the wrong payload shape
 * off a response, is a compile error rather than an `undefined` at runtime.
 *
 * Only the background talks to Pi-hole. The popup has no PiholeClient, no
 * password, and no session — it asks for state and sends intents. That keeps the
 * credential in exactly one context and means a popup that closes mid-request
 * cannot leave a half-finished change behind.
 */

import type { BlockingStatus } from './api/types';
import type { LedgerEntry } from './core/blocked-detect';

/**
 * Re-exported under a view name so the popup imports its whole vocabulary from one
 * module. It is the ledger entry verbatim — there is nothing to translate, and a
 * parallel near-identical type would only drift.
 */
export type LedgerEntryView = LedgerEntry;

// ─── stored settings ──────────────────────────────────────────────────────────

export const STORAGE_KEYS = {
  /** chrome.storage.local — survives a browser restart */
  settings: 'breaker.settings',
  device: 'breaker.device',
  /** chrome.storage.session — survives a service-worker restart, dies with the browser */
  session: 'breaker.session',
  ledgers: 'breaker.ledgers'
} as const;

export interface BreakerSettings {
  /** normalised API root, e.g. "http://pi.hole" */
  baseUrl: string;
  /**
   * The Pi-hole password, or (recommended) an app password.
   *
   * chrome.storage.local is not encrypted — anything with filesystem access to the
   * Chrome profile can read it. That is exactly why the options page recommends an
   * app password: it is revocable in one click and it is not the user's real
   * Pi-hole password. Said plainly in the UI and the README rather than implied.
   */
  password: string;
}

export const DEFAULT_SETTINGS: BreakerSettings = { baseUrl: '', password: '' };

/**
 * What Breaker remembers about this device's Pi-hole side, so the popup does not
 * re-derive it on every open.
 */
export interface DeviceRecord {
  clientKey: string;
  groupId: number;
  groupName: string;
  /**
   * Group membership as it was BEFORE the device breaker was tripped — the thing
   * to put back. Null when the device is filtered (nothing to restore).
   */
  previousGroups: number[] | null;
  /** epoch SECONDS at which filtering should come back, or null */
  unfilteredUntil: number | null;
}

// ─── shared view models ───────────────────────────────────────────────────────

export type BreakerErrorKind = 'auth' | 'version' | 'http' | 'network' | 'config' | 'unknown';

export interface BreakerError {
  message: string;
  kind: BreakerErrorKind;
  /** set on an auth error caused by 2FA, so the UI can point at app passwords */
  totpRequired?: boolean;
}

export interface IdentityView {
  ip: string;
  hwaddr: string | null;
  hostname: string | null;
  clientKey: string;
  keyedBy: 'mac' | 'ip';
}

export interface ConnectionView {
  configured: boolean;
  ok: boolean;
  baseUrl: string;
  /** e.g. "v6.4.3" — null until a successful version check */
  version: string | null;
  identity: IdentityView | null;
  error: BreakerError | null;
}

export interface NetworkView {
  blocking: BlockingStatus;
  /** seconds Pi-hole says remain on ITS timer, or null for permanent */
  timer: number | null;
}

export interface DeviceView {
  groupName: string;
  groupId: number;
  unfiltered: boolean;
  /** epoch SECONDS */
  expires: number | null;
  identity: IdentityView;
}

export interface TabView {
  tabId: number | null;
  url: string | null;
  /** the site in the address bar, which is what a tab grant is tagged with */
  host: string | null;
  hosts: LedgerEntry[];
  /**
   * A cross-check found the ledger non-empty but Pi-hole saw no queries at all
   * from this client — i.e. DNS is bypassing Pi-hole (Chrome Secure DNS, or a VPN).
   */
  dohSuspected: boolean;
}

export interface AllowView {
  domain: string;
  /** epoch SECONDS, or null for "until I say" */
  expires: number | null;
  origin: string;
  /** granted from the site currently in the address bar */
  forThisSite: boolean;
}

export interface BreakerStatus {
  connection: ConnectionView;
  network: NetworkView | null;
  device: DeviceView | null;
  tab: TabView;
  allows: AllowView[];
  /**
   * The background's clock in epoch SECONDS at the moment it built this.
   * Countdowns are rendered against it rather than the popup's own Date.now(), so
   * a clock skew between contexts cannot show a negative timer.
   */
  nowSeconds: number;
}

export interface ConnectResult {
  version: string;
  identity: IdentityView;
  /** Pi-hole's blocked-answer TTL in seconds — why a reload is enough after allowing */
  blockTtl: number;
}

export interface AllowResultView {
  added: string[];
  extended: string[];
  skipped: { domain: string; why: string }[];
}

export interface CrossCheckView {
  verdicts: { host: string; verdict: 'blocked' | 'allowed' | 'unseen' }[];
  dohSuspected: boolean;
}

export interface SweepResult {
  allowsRemoved: string[];
  devicesRestored: string[];
}

// ─── requests ─────────────────────────────────────────────────────────────────

export type BreakerRequest =
  /** everything the popup draws, for the given tab */
  | { kind: 'get-status'; tabId: number | null }
  /** save credentials, then auth → version gate → identity */
  | { kind: 'connect'; baseUrl: string; password: string }
  /** log the session out and forget the credentials */
  | { kind: 'disconnect' }
  /** create (or adopt) this device's Pi-hole group and client entry */
  | { kind: 'ensure-device' }
  | { kind: 'set-network'; blockingEnabled: boolean; durationSeconds: number | null }
  | { kind: 'set-device'; unfiltered: boolean; durationSeconds: number | null }
  | { kind: 'allow-hosts'; tabId: number; hosts: string[]; durationSeconds: number | null }
  | { kind: 'revoke-allow'; domain: string }
  /** ask Pi-hole's query log which of this tab's failures it actually caused */
  | { kind: 'cross-check'; tabId: number }
  | { kind: 'sweep-now' };

export type RequestKind = BreakerRequest['kind'];

/** Response payload for each request kind. */
export interface ResponsePayloads {
  'get-status': BreakerStatus;
  connect: ConnectResult;
  disconnect: null;
  'ensure-device': DeviceView;
  'set-network': NetworkView;
  'set-device': DeviceView;
  'allow-hosts': AllowResultView;
  'revoke-allow': null;
  'cross-check': CrossCheckView;
  'sweep-now': SweepResult;
}

export type BreakerResponse<K extends RequestKind = RequestKind> =
  | { ok: true; data: ResponsePayloads[K] }
  | { ok: false; error: BreakerError };

// ─── the client side of the bus ───────────────────────────────────────────────

/**
 * An error that arrived from the background, carrying the classification the
 * background made. Thrown by `send()` so callers use ordinary try/catch instead of
 * unwrapping an envelope at every call site.
 */
export class BreakerRequestError extends Error {
  readonly kind: BreakerErrorKind;
  readonly totpRequired: boolean;

  constructor(error: BreakerError) {
    super(error.message);
    this.name = 'BreakerRequestError';
    this.kind = error.kind;
    this.totpRequired = error.totpRequired === true;
  }
}

/**
 * Send one request and get its typed payload back.
 *
 * A service worker that is asleep, or one that threw before replying, surfaces as
 * `chrome.runtime.lastError` / an undefined response. Both become a named error —
 * a silent undefined here would render as an empty popup with no explanation.
 */
export async function send<K extends RequestKind>(
  request: Extract<BreakerRequest, { kind: K }>
): Promise<ResponsePayloads[K]> {
  let response: BreakerResponse<K> | undefined;
  try {
    response = (await chrome.runtime.sendMessage(request)) as BreakerResponse<K> | undefined;
  } catch (error) {
    throw new BreakerRequestError({
      message: `Breaker's background service worker did not answer (${
        error instanceof Error ? error.message : String(error)
      }). Try reloading the extension at chrome://extensions.`,
      kind: 'unknown'
    });
  }

  if (!response) {
    throw new BreakerRequestError({
      message:
        "Breaker's background service worker returned nothing. Try reloading the " +
        'extension at chrome://extensions.',
      kind: 'unknown'
    });
  }
  if (!response.ok) throw new BreakerRequestError(response.error);
  return response.data;
}
