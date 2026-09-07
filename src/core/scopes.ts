/**
 * The three switches, expressed against PiholeClient.
 *
 * Breaker's whole model is "trip a breaker, it resets itself":
 *
 *  - NETWORK — `POST /api/dns/blocking {blocking:false, timer:600}`. Pi-hole owns
 *    the countdown and flips itself back. Nothing to clean up, nothing to leak if
 *    the browser dies mid-timer. This is the one scope where the reset is not ours
 *    to run, so we display Pi-hole's remaining timer rather than a timer of our own.
 *
 *  - DEVICE — move this machine's client entry OUT of the Default group and into
 *    its Breaker group alone. Gravity (the blocklists) is attached to Default, and
 *    the Breaker group has no lists, so a client in only the Breaker group resolves
 *    everything. Reset = put the previous groups back.
 *
 *  - TAB — add the failing hostnames to the allowlist, assigned to the Breaker
 *    group ONLY. An allow entry scoped to a group applies to the clients in that
 *    group and nobody else, so "allow doubleclick for 10 minutes" affects this
 *    machine and leaves the rest of the house filtered. Reset = delete the entry.
 *
 * Group arithmetic is separated out and unit-tested because it is the part that
 * can silently ruin someone's Pi-hole configuration: an off-by-one in a `groups`
 * array does not throw, it just quietly un-filters a device forever, or drops a
 * client out of a group the user put it in by hand.
 */

import type { PiholeClient } from '../api/client';
import type { BlockingResponse, Domain, Query } from '../api/types';
import { BLOCKED_QUERY_STATUSES } from '../api/types';
import { formatTag, isExpired, parseTag, tagForDuration, type BreakerTag } from './tags';

/** Pi-hole's built-in "Default" group, which carries the gravity blocklists. */
export const DEFAULT_GROUP_ID = 0;

// ─── Durations ────────────────────────────────────────────────────────────────

export interface DurationPreset {
  label: string;
  /** seconds, or null for "until I say" (no automatic reset) */
  seconds: number | null;
}

/** The popup's duration picker. Null is deliberately last and visually distinct. */
export const DURATION_PRESETS: readonly DurationPreset[] = [
  { label: '10 min', seconds: 10 * 60 },
  { label: '1 hour', seconds: 60 * 60 },
  { label: '24 hours', seconds: 24 * 60 * 60 },
  { label: 'Until I say', seconds: null }
];

// ─── Group arithmetic (pure) ──────────────────────────────────────────────────

/** Sorted, de-duplicated — so two equal membership sets compare equal. */
function normaliseGroups(groups: readonly number[]): number[] {
  return [...new Set(groups)].sort((a, b) => a - b);
}

/** Ensure the client is in the Breaker group, keeping every other membership. */
export function withBreakerGroup(groups: readonly number[], breakerGroupId: number): number[] {
  return normaliseGroups([...groups, breakerGroupId]);
}

/**
 * Membership for "this device is unfiltered": the Breaker group and nothing else.
 *
 * Not `[]`. An empty group list in Pi-hole means the client falls back to the
 * Default group, which is the exact opposite of what was asked for. The Breaker
 * group must also stay present so any tab allow-entries keep applying.
 */
export function unfilteredGroups(breakerGroupId: number): number[] {
  return [breakerGroupId];
}

/**
 * Membership to restore when the device switch resets.
 *
 * `previous` is what we recorded before tripping the breaker. It is put back
 * verbatim (so a client the user had placed in "Kids" stays in "Kids"), with the
 * Breaker group re-added so tab allows keep working. When we have no record —
 * a reinstall, cleared storage, a restore driven by the tag sweep — the only
 * defensible reconstruction is the shape Breaker itself creates: Default plus
 * the Breaker group.
 */
export function restoredGroups(
  previous: readonly number[] | null | undefined,
  breakerGroupId: number
): number[] {
  const base =
    previous && previous.length > 0 && !isUnfiltered(previous, breakerGroupId)
      ? previous
      : [DEFAULT_GROUP_ID];
  return withBreakerGroup(base, breakerGroupId);
}

/** True when this membership means "unfiltered": the Breaker group alone. */
export function isUnfiltered(groups: readonly number[], breakerGroupId: number): boolean {
  const normalised = normaliseGroups(groups);
  return normalised.length === 1 && normalised[0] === breakerGroupId;
}

// ─── Network scope ────────────────────────────────────────────────────────────

/**
 * Trip (or reset) the network-wide breaker.
 *
 * @param blockingEnabled true = filtering ON (breaker closed), false = OFF (tripped)
 * @param durationSeconds how long the requested state lasts before Pi-hole flips
 *   back, or null for permanent. Pi-hole accepts a timer in either direction, so
 *   re-enabling with a timer is legal too — we simply never offer it, because
 *   "block ads for ten minutes and then stop" is not a thing anyone wants.
 */
export async function setNetworkBlocking(
  api: PiholeClient,
  blockingEnabled: boolean,
  durationSeconds: number | null
): Promise<BlockingResponse> {
  // Turning blocking back ON is always permanent: the point of the reset is to
  // return to the steady state, not to schedule another change.
  const timer = blockingEnabled ? null : durationSeconds;
  return api.setBlocking(blockingEnabled, timer);
}

// ─── Device scope ─────────────────────────────────────────────────────────────

export interface DeviceSwitchResult {
  groups: number[];
  unfiltered: boolean;
  /** epoch seconds at which Breaker will restore filtering, or null */
  expires: number | null;
}

/**
 * Trip or reset the device breaker by rewriting the client's group membership.
 *
 * The client's comment carries the expiry tag as well as `previousGroups` living
 * in extension storage. That redundancy is deliberate: extension storage can be
 * lost (reinstall, new profile, a second machine), and a device left permanently
 * unfiltered because the only record of the deadline was in a browser that never
 * came back is the worst failure this extension could have. The tag on the Pi-hole
 * lets `sweepExpiredDeviceGrants` finish the job regardless.
 */
export async function setDeviceUnfiltered(
  api: PiholeClient,
  options: {
    clientKey: string;
    breakerGroupId: number;
    unfiltered: boolean;
    /** membership recorded before tripping — used only on the reset path */
    previousGroups: readonly number[] | null;
    durationSeconds: number | null;
    nowSeconds: number;
    /** the client's existing comment, so a reset restores a non-Breaker one intact */
    existingComment: string | null;
  }
): Promise<DeviceSwitchResult> {
  const groups = options.unfiltered
    ? unfilteredGroups(options.breakerGroupId)
    : restoredGroups(options.previousGroups, options.breakerGroupId);

  const tag: BreakerTag = options.unfiltered
    ? tagForDuration('device', options.clientKey, options.durationSeconds, options.nowSeconds)
    : { expires: null, scope: 'device', origin: options.clientKey };

  // Only overwrite a comment that is ours (or absent). A user's own note on their
  // client entry is not Breaker's to consume.
  const keepForeignComment =
    options.existingComment !== null &&
    options.existingComment.trim() !== '' &&
    parseTag(options.existingComment) === null;
  const comment = keepForeignComment ? options.existingComment : formatTag(tag);

  await api.updateClient(options.clientKey, { comment, groups });

  return {
    groups,
    unfiltered: options.unfiltered,
    expires: options.unfiltered ? tag.expires : null
  };
}

// ─── Tab scope ────────────────────────────────────────────────────────────────

export interface AllowGrant {
  domain: string;
  tag: BreakerTag;
  /** Pi-hole's row id, for display/debugging */
  id: number;
  groups: number[];
}

export interface AllowResult {
  added: string[];
  /** already granted by Breaker; the expiry was moved to the new deadline */
  extended: string[];
  /** not touched, and why — an entry that is not ours, or a bad hostname */
  skipped: { domain: string; why: string }[];
}

/** Reject anything that is not a plausible hostname before it reaches Pi-hole. */
function isPlausibleHost(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  if (host.startsWith('.') || host.endsWith('.')) return false;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(host);
}

/**
 * Allow a set of hostnames for this device, for a while.
 *
 * Exact-match allow entries, assigned to the Breaker group only. Exact rather than
 * regex because the hosts come from observed requests: we know the precise name
 * that failed, and a generated regex is a much bigger blast radius than the user
 * agreed to.
 */
export async function allowHosts(
  api: PiholeClient,
  options: {
    hosts: readonly string[];
    breakerGroupId: number;
    origin: string;
    durationSeconds: number | null;
    nowSeconds: number;
  }
): Promise<AllowResult> {
  const result: AllowResult = { added: [], extended: [], skipped: [] };
  const wanted = [...new Set(options.hosts.map((host) => host.trim().toLowerCase()))];
  if (wanted.length === 0) return result;

  const existing = await api.getDomains('allow', 'exact');
  const byDomain = new Map(existing.map((entry) => [entry.domain.toLowerCase(), entry]));

  for (const host of wanted) {
    if (!isPlausibleHost(host)) {
      result.skipped.push({ domain: host, why: 'not a valid hostname' });
      continue;
    }

    const tag = tagForDuration('tab', options.origin, options.durationSeconds, options.nowSeconds);
    const comment = formatTag(tag);
    const current = byDomain.get(host);

    if (current) {
      if (parseTag(current.comment) === null) {
        // Someone else's allowlist entry. It already allows the domain, so there
        // is nothing to do — and rewriting it would silently take ownership of a
        // permanent rule and later delete it.
        result.skipped.push({
          domain: host,
          why: 'already on your allowlist (not managed by Breaker)'
        });
        continue;
      }
      await api.updateDomain('allow', 'exact', host, {
        type: 'allow',
        kind: 'exact',
        comment,
        groups: [options.breakerGroupId],
        enabled: true
      });
      result.extended.push(host);
      continue;
    }

    await api.addDomain('allow', 'exact', {
      domain: host,
      comment,
      groups: [options.breakerGroupId],
      enabled: true
    });
    result.added.push(host);
  }

  return result;
}

/** Every allow entry Breaker owns, newest deadline last. */
export async function listBreakerAllows(api: PiholeClient): Promise<AllowGrant[]> {
  const domains = await api.getDomains('allow', 'exact');
  return domainsToGrants(domains);
}

/** Pure half of `listBreakerAllows`, so the mapping is testable without a client. */
export function domainsToGrants(domains: readonly Domain[]): AllowGrant[] {
  const grants: AllowGrant[] = [];
  for (const domain of domains) {
    const tag = parseTag(domain.comment);
    if (!tag || tag.scope !== 'tab') continue;
    grants.push({ domain: domain.domain, tag, id: domain.id, groups: domain.groups });
  }
  return grants.sort((a, b) => a.domain.localeCompare(b.domain));
}

/** Revoke one grant. Refuses to delete an entry Breaker does not own. */
export async function revokeAllow(api: PiholeClient, domain: string): Promise<boolean> {
  const domains = await api.getDomains('allow', 'exact');
  const entry = domains.find((candidate) => candidate.domain.toLowerCase() === domain.toLowerCase());
  if (!entry) return false;
  if (parseTag(entry.comment) === null) return false;
  await api.deleteDomain('allow', 'exact', entry.domain);
  return true;
}

// ─── Expiry sweeps ────────────────────────────────────────────────────────────

/**
 * Which Breaker-owned allow entries are past their deadline. Pure, so the sweep's
 * decision is testable without touching a Pi-hole.
 */
export function expiredAllowDomains(domains: readonly Domain[], nowSeconds: number): string[] {
  const expired: string[] = [];
  for (const domain of domains) {
    const tag = parseTag(domain.comment);
    if (!tag || tag.scope !== 'tab') continue;
    if (isExpired(tag, nowSeconds)) expired.push(domain.domain);
  }
  return expired;
}

/**
 * Delete every expired tab grant.
 *
 * Runs on service-worker startup and every 10 minutes, not only from the per-grant
 * alarm — alarms do not fire while the browser is closed, and a machine shut down
 * for the night must not wake up with yesterday's allowlist still in force.
 */
export async function sweepExpiredAllows(
  api: PiholeClient,
  nowSeconds: number
): Promise<string[]> {
  const domains = await api.getDomains('allow', 'exact');
  const expired = expiredAllowDomains(domains, nowSeconds);
  for (const domain of expired) {
    await api.deleteDomain('allow', 'exact', domain);
  }
  return expired;
}

/**
 * Restore any device whose unfiltered window has closed.
 *
 * Reads the state off the Pi-hole itself (the client comment's tag plus the
 * client's group membership), so it works after a reinstall, from a second
 * machine, or after the browser was closed for the whole duration.
 */
export async function sweepExpiredDeviceGrants(
  api: PiholeClient,
  nowSeconds: number,
  previousGroupsFor: (clientKey: string) => readonly number[] | null
): Promise<string[]> {
  const [clients, groups] = await Promise.all([api.getClients(), api.getGroups()]);

  // origin (client key) → Breaker group id, from the group's own tag.
  const breakerGroupByOrigin = new Map<string, number>();
  for (const group of groups) {
    const tag = parseTag(group.comment);
    if (tag && tag.scope === 'device') breakerGroupByOrigin.set(tag.origin.toLowerCase(), group.id);
  }

  const restored: string[] = [];
  for (const client of clients) {
    const tag = parseTag(client.comment);
    if (!tag || tag.scope !== 'device' || !isExpired(tag, nowSeconds)) continue;

    const groupId = breakerGroupByOrigin.get(client.client.toLowerCase());
    if (groupId === undefined) continue;
    if (!isUnfiltered(client.groups, groupId)) continue;

    await api.updateClient(client.client, {
      comment: formatTag({ expires: null, scope: 'device', origin: client.client }),
      groups: restoredGroups(previousGroupsFor(client.client), groupId)
    });
    restored.push(client.client);
  }
  return restored;
}

// ─── Cross-check against Pi-hole's query log ──────────────────────────────────

export type HostVerdict = 'blocked' | 'allowed' | 'unseen';

export interface CrossCheckResult {
  verdicts: Map<string, HostVerdict>;
  /**
   * Pi-hole saw NOT ONE query from this client in the window. With a browser that
   * is visibly loading pages, that means DNS is not going through Pi-hole at all —
   * almost always Chrome's Secure DNS (DoH), occasionally a VPN. The popup turns
   * this into a warning, because in that state none of the three switches can work
   * and no amount of allowlisting will change anything.
   */
  noQueriesSeen: boolean;
}

/**
 * Decide, from Pi-hole's own log, which observed failures Pi-hole actually caused.
 *
 * Pure: `queries` is whatever `GET /api/queries?client_ip=…&from=…` returned.
 */
export function crossCheck(hosts: readonly string[], queries: readonly Query[]): CrossCheckResult {
  const verdicts = new Map<string, HostVerdict>();
  const seen = new Map<string, boolean>(); // host → was blocked

  for (const query of queries) {
    const domain = query.domain.toLowerCase().replace(/\.$/, '');
    const blocked = query.status !== null && BLOCKED_QUERY_STATUSES.has(query.status);
    // Any single blocked answer for the name is enough: a page reload can produce
    // both a blocked A and a cached NODATA for the same host.
    seen.set(domain, (seen.get(domain) ?? false) || blocked);
  }

  for (const host of hosts) {
    const key = host.toLowerCase();
    const wasBlocked = seen.get(key);
    verdicts.set(key, wasBlocked === undefined ? 'unseen' : wasBlocked ? 'blocked' : 'allowed');
  }

  return { verdicts, noQueriesSeen: queries.length === 0 };
}
