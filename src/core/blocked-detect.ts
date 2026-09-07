/**
 * Turning Chrome's network errors into "Pi-hole probably blocked this".
 *
 * An extension cannot see DNS. What it CAN see is `chrome.webRequest.onErrorOccurred`,
 * and the shape of the error tells you which way the name failed:
 *
 *  - Pi-hole's default blocking mode is NULL: a blocked name resolves to `0.0.0.0`
 *    (and `::`). Chrome will not connect to the unspecified address, so the request
 *    dies as `net::ERR_ADDRESS_INVALID`. This is by far the most common signal and
 *    is close to diagnostic — normal sites do not resolve to 0.0.0.0.
 *  - Blocking mode NXDOMAIN gives `net::ERR_NAME_NOT_RESOLVED`, which is much less
 *    specific: a typo'd hostname or a dead CDN looks identical.
 *  - Blocking mode IP / IP-NODATA-AAAA points at the Pi itself, which answers with
 *    a closed port or is unreachable: `net::ERR_CONNECTION_REFUSED` /
 *    `net::ERR_ADDRESS_UNREACHABLE`.
 *
 * So this classifier produces CANDIDATES, never verdicts. The popup can promote a
 * candidate to a confirmed block by cross-checking Pi-hole's own query log
 * (`GET /api/queries`), which is the only source that actually knows. Everything
 * else — ERR_ABORTED (the user navigated away), ERR_BLOCKED_BY_CLIENT (another
 * content blocker), ERR_FAILED, timeouts — is dropped, because offering to allow a
 * domain that Pi-hole never touched is a promise Breaker cannot keep.
 */

export type BlockReason = 'null-ip' | 'nxdomain' | 'refused' | 'unreachable';

export interface BlockedCandidate {
  host: string;
  reason: BlockReason;
}

/** Human wording for each reason, used in the popup's per-host hint. */
export const REASON_LABELS: Readonly<Record<BlockReason, string>> = {
  'null-ip': 'resolved to 0.0.0.0 (Pi-hole default block)',
  nxdomain: 'name did not resolve',
  refused: 'connection refused',
  unreachable: 'address unreachable'
};

/**
 * Which errors map to which reason. Chrome prefixes them with `net::`; we accept
 * the string with or without it because the exact formatting has moved between
 * Chrome versions.
 */
const ERROR_REASONS: Readonly<Record<string, BlockReason>> = {
  ERR_ADDRESS_INVALID: 'null-ip',
  ERR_NAME_NOT_RESOLVED: 'nxdomain',
  ERR_NAME_RESOLUTION_FAILED: 'nxdomain',
  ERR_CONNECTION_REFUSED: 'refused',
  ERR_ADDRESS_UNREACHABLE: 'unreachable'
};

/** An IPv4/IPv6 literal cannot have been DNS-blocked, so it is never a candidate. */
function isIpLiteral(host: string): boolean {
  if (host.startsWith('[')) return true; // bracketed IPv6 as it appears in a URL host
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  return host.includes(':');
}

/**
 * Hosts that are never interesting: the loopback names, and `.local`/mDNS names
 * that never reach Pi-hole in the first place.
 */
function isUninteresting(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local')) return true;
  return host === '';
}

/**
 * Classify one webRequest failure.
 *
 * @param error Chrome's `details.error`, e.g. "net::ERR_ADDRESS_INVALID"
 * @param url   the request URL, `details.url`
 * @returns the candidate, or null when this failure is not DNS-shaped
 */
export function classify(error: string, url: string): BlockedCandidate | null {
  const code = error.startsWith('net::') ? error.slice('net::'.length) : error;
  const reason = ERROR_REASONS[code];
  if (reason === undefined) return null;

  let host: string;
  try {
    const parsed = new URL(url);
    // Only http(s) can be un-blocked by allowing a domain. ws:// and wss:// share
    // the same DNS, but Chrome does not surface them through webRequest, and
    // chrome-extension:// / data: have no DNS at all.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    host = parsed.hostname.toLowerCase();
  } catch {
    return null;
  }

  if (isUninteresting(host) || isIpLiteral(host)) return null;
  return { host, reason };
}

// ─── Per-tab ledger ───────────────────────────────────────────────────────────

export interface LedgerEntry {
  host: string;
  /** how many requests to this host failed this way since the ledger was cleared */
  count: number;
  /** epoch MILLISECONDS (Date.now) — the browser side of the world runs in ms */
  firstSeen: number;
  lastSeen: number;
  reason: BlockReason;
  /**
   * Pi-hole's own verdict, once a cross-check has run:
   *  - 'blocked'   — the query log says Pi-hole refused this name
   *  - 'allowed'   — Pi-hole saw the query and answered it (so the failure is
   *                  something else, and allowing the domain will not help)
   *  - 'unseen'    — Pi-hole never saw a query for it from this client at all
   *  - 'unchecked' — no cross-check has run
   */
  verdict: 'blocked' | 'allowed' | 'unseen' | 'unchecked';
}

/** host → entry. One of these per tab, held in the service worker's memory. */
export type TabLedger = Map<string, LedgerEntry>;

/** Record a hit, creating or updating the host's entry. Returns the entry. */
export function recordHit(
  ledger: TabLedger,
  candidate: BlockedCandidate,
  nowMs: number
): LedgerEntry {
  const existing = ledger.get(candidate.host);
  if (existing) {
    existing.count += 1;
    existing.lastSeen = nowMs;
    // The most recent failure wins: a blocking-mode change mid-session should not
    // leave the first-ever reason stuck on the entry.
    existing.reason = candidate.reason;
    return existing;
  }
  const entry: LedgerEntry = {
    host: candidate.host,
    count: 1,
    firstSeen: nowMs,
    lastSeen: nowMs,
    reason: candidate.reason,
    verdict: 'unchecked'
  };
  ledger.set(candidate.host, entry);
  return entry;
}

/**
 * The ledger as the popup draws it: busiest host first, ties broken
 * alphabetically so the list does not shuffle between renders.
 */
export function ledgerList(ledger: TabLedger): LedgerEntry[] {
  return [...ledger.values()].sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));
}
