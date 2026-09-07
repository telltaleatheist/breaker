/**
 * Breaker's service worker: the only context that talks to Pi-hole.
 *
 * It owns four things:
 *  1. the credentials and the Pi-hole session,
 *  2. the per-tab ledger of DNS-shaped request failures,
 *  3. every scheduled reset (chrome.alarms) plus the catch-up sweep,
 *  4. the toolbar badge.
 *
 * MV3 note that shapes most of the code below: this worker is NOT persistent.
 * Chrome stops it after ~30s idle and restarts it on the next event, so anything
 * that must outlive an idle period lives in chrome.storage (session for the SID
 * and the ledger, local for settings and the device record) and anything that must
 * happen later is a chrome.alarms alarm, never a setTimeout — a timeout dies with
 * the worker and the reset would simply never happen.
 */

import {
  normalizeBaseUrl,
  PiholeAuthError,
  PiholeClient,
  PiholeError,
  PiholeHttpError,
  PiholeNetworkError,
  type StoredSession
} from './api/client';
import { formatVersion, PiholeVersionError } from './api/version';
import { BAKED_SETTINGS } from './baked';
import { seedSettings } from './core/settings';
import {
  classify,
  ledgerList,
  recordHit,
  type LedgerEntry,
  type TabLedger
} from './core/blocked-detect';
import {
  ensureDevice,
  readDevice,
  resolveIdentity,
  type DeviceContext,
  type DeviceIdentity
} from './core/device';
import {
  allowHosts,
  crossCheck,
  isUnfiltered,
  listBreakerAllows,
  revokeAllow,
  setDeviceUnfiltered,
  setNetworkBlocking,
  sweepExpiredAllows,
  sweepExpiredDeviceGrants
} from './core/scopes';
import { isExpired, parseTag } from './core/tags';
import {
  DEFAULT_SETTINGS,
  STORAGE_KEYS,
  type AllowResultView,
  type AllowView,
  type BreakerError,
  type BreakerRequest,
  type BreakerResponse,
  type BreakerSettings,
  type BreakerStatus,
  type ConnectResult,
  type DeviceRecord,
  type DeviceView,
  type IdentityView,
  type NetworkView,
  type RequestKind,
  type ResponsePayloads,
  type SweepResult,
  type TabView
} from './messages';

// ─── constants ────────────────────────────────────────────────────────────────

const ALARM_SWEEP = 'breaker:sweep';
const ALARM_DEVICE = 'breaker:device';
const ALARM_NETWORK = 'breaker:network';
const ALARM_ALLOW_PREFIX = 'breaker:allow:';

/**
 * How often the catch-up sweep runs. Alarms do not fire while the browser is
 * closed, so this is the mechanism that cleans up after a machine that was shut
 * down overnight with a 10-minute grant outstanding.
 */
const SWEEP_PERIOD_MINUTES = 10;

/**
 * How far back the cross-check looks in Pi-hole's query log. Long enough to cover
 * the page load that produced the ledger, short enough that "Pi-hole saw nothing"
 * remains a meaningful signal.
 */
const CROSS_CHECK_WINDOW_SECONDS = 15 * 60;

const BADGE_RED = '#c62828';
const BADGE_AMBER = '#ef6c00';
const BADGE_GREY = '#546e7a';

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

// ─── per-tab ledger ───────────────────────────────────────────────────────────

const ledgers = new Map<number, TabLedger>();

/** Hosts a cross-check found Pi-hole never saw, per tab. Drives the DoH warning. */
const dohSuspected = new Set<number>();

type SerialisedLedgers = Record<string, LedgerEntry[]>;

/**
 * Mirror the ledger into chrome.storage.session.
 *
 * Without this, every idle-shutdown of the worker would empty the "blocked on this
 * tab" list while the user is still looking at the page — the observation is real,
 * the worker's lifetime is an implementation detail, and the user should not be
 * able to tell the difference.
 */
let persistHandle: ReturnType<typeof setTimeout> | null = null;
function persistLedgers(): void {
  if (persistHandle !== null) clearTimeout(persistHandle);
  // Coalesce: a page load can produce dozens of failures in a few hundred ms.
  persistHandle = setTimeout(() => {
    persistHandle = null;
    const serialised: SerialisedLedgers = {};
    for (const [tabId, ledger] of ledgers) {
      if (ledger.size > 0) serialised[String(tabId)] = [...ledger.values()];
    }
    void chrome.storage.session.set({ [STORAGE_KEYS.ledgers]: serialised });
  }, 250);
}

const ledgersRestored = (async (): Promise<void> => {
  const stored = await chrome.storage.session.get(STORAGE_KEYS.ledgers);
  const serialised = stored[STORAGE_KEYS.ledgers] as SerialisedLedgers | undefined;
  if (!serialised) return;
  for (const [tabIdText, entries] of Object.entries(serialised)) {
    const tabId = Number(tabIdText);
    // Anything recorded since this worker started wins: it is newer.
    const ledger = ledgers.get(tabId) ?? new Map();
    for (const entry of entries) {
      if (!ledger.has(entry.host)) ledger.set(entry.host, entry);
    }
    ledgers.set(tabId, ledger);
  }
})();

function clearTab(tabId: number): void {
  ledgers.delete(tabId);
  dohSuspected.delete(tabId);
  persistLedgers();
}

// ─── settings, session, client ────────────────────────────────────────────────

async function loadSettings(): Promise<BreakerSettings> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  const record = stored[STORAGE_KEYS.settings] as Partial<BreakerSettings> | undefined;
  const { settings, seeded } = seedSettings(record, BAKED_SETTINGS);
  // Persist the seed so it becomes an ordinary saved record: from here on the user
  // owns it, and Disconnect (which saves an empty record) sticks.
  if (seeded) await saveSettings(settings);
  return settings;
}

async function saveSettings(settings: BreakerSettings): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });
}

async function loadDeviceRecord(): Promise<DeviceRecord | null> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.device);
  return (stored[STORAGE_KEYS.device] as DeviceRecord | undefined) ?? null;
}

async function saveDeviceRecord(record: DeviceRecord | null): Promise<void> {
  if (record === null) await chrome.storage.local.remove(STORAGE_KEYS.device);
  else await chrome.storage.local.set({ [STORAGE_KEYS.device]: record });
}

/**
 * Thrown when the extension has not been set up yet. Distinct from a Pi-hole
 * error: nothing is wrong, the user simply has not entered an address.
 */
class NotConfiguredError extends Error {
  constructor() {
    super('Breaker is not connected to a Pi-hole yet. Open Options and add yours.');
    this.name = 'NotConfiguredError';
  }
}

/**
 * The live client, cached across events within one worker lifetime so a burst of
 * popup requests shares a single session.
 */
let cachedClient: { key: string; client: PiholeClient } | null = null;

async function getClient(settingsOverride?: BreakerSettings): Promise<PiholeClient> {
  const settings = settingsOverride ?? (await loadSettings());
  if (settings.baseUrl.trim() === '') throw new NotConfiguredError();

  // NUL as the separator: it cannot occur in a URL or a password, so two different
  // settings pairs can never collide into one cache key.
  const key = `${settings.baseUrl}\u0000${settings.password}`;
  if (cachedClient && cachedClient.key === key) return cachedClient.client;

  const stored = await chrome.storage.session.get(STORAGE_KEYS.session);
  const session = (stored[STORAGE_KEYS.session] as StoredSession | undefined) ?? null;

  const client = new PiholeClient({
    baseUrl: settings.baseUrl,
    password: settings.password,
    session,
    // Persisting the SID (not the password) into storage.session means a worker
    // restart resumes the session instead of logging in again — which matters,
    // because Pi-hole has a finite number of session seats.
    onSession: async (next) => {
      if (next === null) await chrome.storage.session.remove(STORAGE_KEYS.session);
      else await chrome.storage.session.set({ [STORAGE_KEYS.session]: next });
    }
  });

  cachedClient = { key, client };
  return client;
}

/** Forget the cached client so the next call rebuilds it from fresh settings. */
function invalidateClient(): void {
  cachedClient = null;
}

// ─── error classification ─────────────────────────────────────────────────────

function toBreakerError(error: unknown): BreakerError {
  if (error instanceof NotConfiguredError) {
    return { message: error.message, kind: 'config' };
  }
  if (error instanceof PiholeAuthError) {
    return { message: error.message, kind: 'auth', totpRequired: error.totpRequired };
  }
  if (error instanceof PiholeVersionError) {
    return { message: error.message, kind: 'version' };
  }
  if (error instanceof PiholeNetworkError) {
    return { message: error.message, kind: 'network' };
  }
  if (error instanceof PiholeHttpError || error instanceof PiholeError) {
    return { message: error.message, kind: 'http' };
  }
  // Never swallow an unexpected failure into a friendly non-message: the real text
  // is the only thing that will let anyone diagnose it.
  return { message: error instanceof Error ? error.message : String(error), kind: 'unknown' };
}

// ─── device state ─────────────────────────────────────────────────────────────

function toIdentityView(identity: DeviceIdentity): IdentityView {
  return {
    ip: identity.ip,
    hwaddr: identity.hwaddr,
    hostname: identity.hostname,
    clientKey: identity.clientKey,
    keyedBy: identity.keyedBy
  };
}

/**
 * Project a resolved device context into the view, and bring the local record in
 * line with what the Pi-hole actually says.
 *
 * The Pi-hole is the authority: someone may have moved the client back into
 * Default from the Pi-hole's own UI, or a second browser may have tripped the
 * switch. Reading the truth on every status refresh is cheaper than being wrong.
 */
async function projectDevice(client: PiholeClient, context: DeviceContext): Promise<DeviceView> {
  const stored = await loadDeviceRecord();
  const unfiltered = isUnfiltered(context.groups, context.groupId);

  // The deadline lives on the Pi-hole (the client's comment), so it survives a
  // reinstall and is visible from a second machine.
  const clients = await client.getClients();
  const entry = clients.find(
    (candidate) => candidate.client.toLowerCase() === context.identity.clientKey.toLowerCase()
  );
  const tag = parseTag(entry?.comment);
  const expires = unfiltered && tag && tag.scope === 'device' ? tag.expires : null;

  const record: DeviceRecord = {
    clientKey: context.identity.clientKey,
    groupId: context.groupId,
    groupName: context.groupName,
    previousGroups: unfiltered ? (stored?.previousGroups ?? null) : null,
    unfilteredUntil: expires
  };
  await saveDeviceRecord(record);

  return {
    groupName: context.groupName,
    groupId: context.groupId,
    unfiltered,
    expires,
    identity: toIdentityView(context.identity)
  };
}

/** Create the Pi-hole side if needed, then report it. Used by the switches. */
async function refreshDevice(client: PiholeClient): Promise<DeviceView> {
  return projectDevice(client, await ensureDevice(client));
}

/**
 * Report the device WITHOUT creating anything; null when it is not set up yet.
 * This is what a popup open uses — see `readDevice`.
 */
async function peekDevice(client: PiholeClient, identity: DeviceIdentity): Promise<DeviceView | null> {
  const context = await readDevice(client, identity);
  return context === null ? null : projectDevice(client, context);
}

// ─── badge ────────────────────────────────────────────────────────────────────

/**
 * The last state the badge was drawn from. Cached in the worker rather than
 * re-fetched: the badge repaints on every tab switch, and that must not become an
 * HTTP request to the Pi-hole.
 */
let badgeState: { networkOff: boolean; deviceUnfiltered: boolean } = {
  networkOff: false,
  deviceUnfiltered: false
};

async function paintBadge(tabId: number): Promise<void> {
  let text: string;
  let colour: string;

  if (badgeState.networkOff) {
    // Whole-house breaker tripped. The most alarming state, so it wins.
    text = 'OFF';
    colour = BADGE_RED;
  } else if (badgeState.deviceUnfiltered) {
    text = 'DEV';
    colour = BADGE_AMBER;
  } else {
    const count = ledgers.get(tabId)?.size ?? 0;
    text = count === 0 ? '' : String(count);
    colour = BADGE_GREY;
  }

  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: colour });
    await chrome.action.setBadgeText({ tabId, text });
  } catch {
    // The tab closed between the query and the paint. Nothing to do, and nothing
    // worth reporting.
  }
}

async function paintAllBadges(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map((tab) => (tab.id === undefined ? Promise.resolve() : paintBadge(tab.id)))
  );
}

/**
 * Re-read the two global states from Pi-hole and repaint every badge.
 * Silent on failure — an unreachable Pi-hole must not spam the console on a timer,
 * and the popup already reports the connection error in a place the user is looking.
 */
async function refreshGlobalState(): Promise<void> {
  try {
    const client = await getClient();
    const blocking = await client.getBlocking();
    badgeState.networkOff = blocking.blocking === 'disabled';

    const record = await loadDeviceRecord();
    if (record) {
      const clients = await client.getClients();
      const entry = clients.find(
        (candidate) => candidate.client.toLowerCase() === record.clientKey.toLowerCase()
      );
      badgeState.deviceUnfiltered = entry ? isUnfiltered(entry.groups, record.groupId) : false;
    } else {
      badgeState.deviceUnfiltered = false;
    }

    // Repaint when Pi-hole's own countdown lapses, so "OFF" does not linger.
    if (blocking.timer !== null && blocking.timer > 0) {
      chrome.alarms.create(ALARM_NETWORK, { when: Date.now() + (blocking.timer + 2) * 1000 });
    }
  } catch {
    badgeState = { networkOff: false, deviceUnfiltered: false };
  }
  await paintAllBadges();
}

// ─── alarms ───────────────────────────────────────────────────────────────────

function allowAlarmName(domain: string): string {
  return `${ALARM_ALLOW_PREFIX}${domain}`;
}

function scheduleAllowExpiry(domain: string, expiresSeconds: number | null): void {
  const name = allowAlarmName(domain);
  if (expiresSeconds === null) {
    void chrome.alarms.clear(name);
    return;
  }
  // Chrome clamps a delay under ~30s; our shortest preset is 10 minutes, so this
  // only matters for a grant that was already nearly expired when re-scheduled.
  chrome.alarms.create(name, { when: expiresSeconds * 1000 });
}

function scheduleDeviceExpiry(expiresSeconds: number | null): void {
  if (expiresSeconds === null) {
    void chrome.alarms.clear(ALARM_DEVICE);
    return;
  }
  chrome.alarms.create(ALARM_DEVICE, { when: expiresSeconds * 1000 });
}

/**
 * Delete every expired grant and restore every expired device.
 *
 * Idempotent and safe to run at any time; it re-reads the deadlines from the
 * Pi-hole rather than trusting local state.
 */
async function runSweep(): Promise<SweepResult> {
  const client = await getClient();
  const now = nowSeconds();
  const record = await loadDeviceRecord();

  const allowsRemoved = await sweepExpiredAllows(client, now);
  const devicesRestored = await sweepExpiredDeviceGrants(client, now, (clientKey) =>
    record && record.clientKey.toLowerCase() === clientKey.toLowerCase()
      ? record.previousGroups
      : null
  );

  for (const domain of allowsRemoved) void chrome.alarms.clear(allowAlarmName(domain));
  if (devicesRestored.length > 0 && record) {
    await saveDeviceRecord({ ...record, previousGroups: null, unfilteredUntil: null });
    void chrome.alarms.clear(ALARM_DEVICE);
  }

  return { allowsRemoved, devicesRestored };
}

chrome.alarms.onAlarm.addListener((alarm) => {
  void (async () => {
    try {
      if (alarm.name === ALARM_SWEEP) {
        await runSweep();
        await refreshGlobalState();
        return;
      }
      if (alarm.name === ALARM_NETWORK) {
        await refreshGlobalState();
        return;
      }
      if (alarm.name === ALARM_DEVICE) {
        await runSweep();
        await refreshGlobalState();
        return;
      }
      if (alarm.name.startsWith(ALARM_ALLOW_PREFIX)) {
        const domain = alarm.name.slice(ALARM_ALLOW_PREFIX.length);
        const client = await getClient();
        // Confirm from the Pi-hole that it really is expired: the user may have
        // extended the grant since this alarm was set, and honouring a stale alarm
        // would revoke a grant the user just renewed.
        const grants = await listBreakerAllows(client);
        const grant = grants.find((candidate) => candidate.domain === domain);
        if (grant && isExpired(grant.tag, nowSeconds())) {
          await revokeAllow(client, domain);
        }
      }
    } catch {
      // A failed scheduled reset is retried by the 10-minute sweep. Throwing out of
      // an alarm handler achieves nothing except an unhandled rejection.
    }
  })();
});

// ─── observation ──────────────────────────────────────────────────────────────

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    if (details.tabId < 0) return; // not attributable to a tab (favicon prefetch, etc.)
    const candidate = classify(details.error, details.url);
    if (!candidate) return;

    const ledger = ledgers.get(details.tabId) ?? new Map();
    recordHit(ledger, candidate, Date.now());
    ledgers.set(details.tabId, ledger);
    persistLedgers();
    void paintBadge(details.tabId);
  },
  { urls: ['<all_urls>'] }
);

chrome.webNavigation.onCommitted.addListener((details) => {
  // Main frame only: a sub-frame navigating is part of the same page, and clearing
  // on it would drop the very hosts the user is about to look at.
  if (details.frameId !== 0) return;
  clearTab(details.tabId);
  void paintBadge(details.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTab(tabId);
});

chrome.tabs.onActivated.addListener((info) => {
  void paintBadge(info.tabId);
});

// ─── request handlers ─────────────────────────────────────────────────────────

async function buildStatus(tabId: number | null): Promise<BreakerStatus> {
  await ledgersRestored;
  const settings = await loadSettings();
  const configured = settings.baseUrl.trim() !== '';

  let tabUrl: string | null = null;
  let tabHost: string | null = null;
  if (tabId !== null) {
    try {
      const tab = await chrome.tabs.get(tabId);
      tabUrl = tab.url ?? null;
      if (tabUrl) {
        const parsed = new URL(tabUrl);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          tabHost = parsed.hostname.toLowerCase();
        }
      }
    } catch {
      // The tab went away while the popup was opening.
    }
  }

  const tab: TabView = {
    tabId,
    url: tabUrl,
    host: tabHost,
    hosts: tabId === null ? [] : ledgerList(ledgers.get(tabId) ?? new Map()),
    dohSuspected: tabId !== null && dohSuspected.has(tabId)
  };

  const base: BreakerStatus = {
    connection: {
      configured,
      ok: false,
      baseUrl: settings.baseUrl,
      version: null,
      identity: null,
      error: configured ? null : { message: '', kind: 'config' }
    },
    network: null,
    device: null,
    tab,
    allows: [],
    nowSeconds: nowSeconds()
  };

  if (!configured) return base;

  try {
    const client = await getClient(settings);
    const version = await client.requireSupportedVersion();
    const network = await client.getBlocking();
    // Read-only: opening the popup must not write anything to the Pi-hole.
    const identity = await resolveIdentity(client);
    const device = await peekDevice(client, identity);
    const grants = await listBreakerAllows(client);

    if (tabId !== null) {
      try {
        await crossCheckTab(client, identity, tabId);
      } catch {
        // Pi-hole's query log was unavailable; the hosts stay "not checked".
      }
    }

    badgeState = {
      networkOff: network.blocking === 'disabled',
      deviceUnfiltered: device?.unfiltered ?? false
    };
    await paintAllBadges();

    const allows: AllowView[] = grants.map((grant) => ({
      domain: grant.domain,
      expires: grant.tag.expires,
      origin: grant.tag.origin,
      forThisSite: tabHost !== null && grant.tag.origin.toLowerCase() === tabHost
    }));

    return {
      ...base,
      connection: {
        configured: true,
        ok: true,
        baseUrl: settings.baseUrl,
        version: formatVersion(version),
        identity: toIdentityView(identity),
        error: null
      },
      network: { blocking: network.blocking, timer: network.timer } satisfies NetworkView,
      device,
      allows,
      // Re-read: the cross-check above may have set the DoH flag after `tab` was built.
      tab: { ...tab, dohSuspected: tabId !== null && dohSuspected.has(tabId) },
      nowSeconds: nowSeconds()
    };
  } catch (error) {
    return { ...base, connection: { ...base.connection, error: toBreakerError(error) } };
  }
}

async function handleConnect(baseUrl: string, password: string): Promise<ConnectResult> {
  // Normalise and validate the address up front, so a typo fails as a typo rather
  // than as a mystery "could not reach" later on.
  const settings: BreakerSettings = { baseUrl: normalizeBaseUrl(baseUrl), password };

  await saveSettings(settings);
  await chrome.storage.session.remove(STORAGE_KEYS.session);
  invalidateClient();

  const client = await getClient(settings);
  const version = await client.requireSupportedVersion();
  // Read-only, like the popup: connecting proves the credentials and shows who
  // Pi-hole thinks we are. The group and client entry are created by the first
  // switch that needs them, not by looking.
  const identity = await resolveIdentity(client);
  const blockTtl = await client.getBlockTtl();

  await refreshGlobalState();
  return { version: formatVersion(version), identity: toIdentityView(identity), blockTtl };
}

async function handleDisconnect(): Promise<null> {
  try {
    const client = await getClient();
    await client.logout();
  } catch {
    // Already unreachable or already logged out. Forgetting the credentials
    // locally is the part the user asked for and must happen regardless.
  }
  // Save an EMPTY record rather than removing the key: "never saved" is what lets
  // a baked build seed itself, and a disconnect must not be undone by the next load.
  await saveSettings(DEFAULT_SETTINGS);
  await chrome.storage.local.remove(STORAGE_KEYS.device);
  await chrome.storage.session.remove(STORAGE_KEYS.session);
  invalidateClient();
  badgeState = { networkOff: false, deviceUnfiltered: false };
  await paintAllBadges();
  return null;
}

async function handleSetNetwork(
  blockingEnabled: boolean,
  durationSeconds: number | null
): Promise<NetworkView> {
  const client = await getClient();
  const result = await setNetworkBlocking(client, blockingEnabled, durationSeconds);
  badgeState.networkOff = result.blocking === 'disabled';
  await paintAllBadges();
  if (result.timer !== null && result.timer > 0) {
    chrome.alarms.create(ALARM_NETWORK, { when: Date.now() + (result.timer + 2) * 1000 });
  } else {
    void chrome.alarms.clear(ALARM_NETWORK);
  }
  return { blocking: result.blocking, timer: result.timer };
}

async function handleSetDevice(
  unfiltered: boolean,
  durationSeconds: number | null
): Promise<DeviceView> {
  const client = await getClient();
  const context = await ensureDevice(client);

  const clients = await client.getClients();
  const entry = clients.find(
    (candidate) => candidate.client.toLowerCase() === context.identity.clientKey.toLowerCase()
  );
  if (!entry) {
    throw new Error(
      `Pi-hole has no client entry for ${context.identity.clientKey}, which Breaker just created. ` +
        `Check Pi-hole's Clients page.`
    );
  }

  const stored = await loadDeviceRecord();
  // Record the membership BEFORE tripping, so the reset can put back exactly what
  // was there — including groups the user assigned by hand.
  const previousGroups = unfiltered ? entry.groups : (stored?.previousGroups ?? null);

  const result = await setDeviceUnfiltered(client, {
    clientKey: context.identity.clientKey,
    breakerGroupId: context.groupId,
    unfiltered,
    previousGroups,
    durationSeconds,
    nowSeconds: nowSeconds(),
    existingComment: entry.comment
  });

  await saveDeviceRecord({
    clientKey: context.identity.clientKey,
    groupId: context.groupId,
    groupName: context.groupName,
    previousGroups: unfiltered ? previousGroups : null,
    unfilteredUntil: result.expires
  });

  scheduleDeviceExpiry(result.expires);
  badgeState.deviceUnfiltered = result.unfiltered;
  await paintAllBadges();

  return {
    groupName: context.groupName,
    groupId: context.groupId,
    unfiltered: result.unfiltered,
    expires: result.expires,
    identity: toIdentityView(context.identity)
  };
}

async function handleAllowHosts(
  tabId: number,
  hosts: string[],
  durationSeconds: number | null
): Promise<AllowResultView> {
  const client = await getClient();
  const context = await ensureDevice(client);

  let origin = 'unknown';
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url) origin = new URL(tab.url).hostname.toLowerCase();
  } catch {
    // The tab closed; the grant is still valid, it just records an unknown origin.
  }

  const now = nowSeconds();
  const result = await allowHosts(client, {
    hosts,
    breakerGroupId: context.groupId,
    origin,
    durationSeconds,
    nowSeconds: now
  });

  const expiresAt = durationSeconds === null ? null : now + durationSeconds;
  for (const domain of [...result.added, ...result.extended]) {
    scheduleAllowExpiry(domain, expiresAt);
  }

  return result;
}

async function handleRevokeAllow(domain: string): Promise<null> {
  const client = await getClient();
  const removed = await revokeAllow(client, domain);
  if (!removed) {
    throw new Error(
      `"${domain}" is no longer a Breaker allow entry — it may have expired already, ` +
        `or been edited in Pi-hole.`
    );
  }
  void chrome.alarms.clear(allowAlarmName(domain));
  return null;
}

/**
 * Ask Pi-hole's query log which of a tab's failures Pi-hole actually caused, and
 * write the verdicts onto the ledger. Runs as part of every status build for a tab
 * with something in its ledger, so the popup opens with hosts already labelled.
 * Failure here must never break the status: the hosts simply stay "not checked".
 */
async function crossCheckTab(client: PiholeClient, identity: DeviceIdentity, tabId: number): Promise<void> {
  const ledger = ledgers.get(tabId);
  if (!ledger || ledger.size === 0) return;
  const hosts = [...ledger.keys()];

  const queries = await client.getQueries({
    from: nowSeconds() - CROSS_CHECK_WINDOW_SECONDS,
    client_ip: identity.ip,
    length: 5000
  });

  const result = crossCheck(hosts, queries);
  for (const [host, verdict] of result.verdicts) {
    const entry = ledger.get(host);
    if (entry) entry.verdict = verdict;
  }
  persistLedgers();

  // "The ledger has hosts but Pi-hole saw nothing from this IP" is the DoH tell.
  if (hosts.length > 0 && result.noQueriesSeen) dohSuspected.add(tabId);
  else dohSuspected.delete(tabId);
}

/**
 * Reload a tab a little later. The delay covers Pi-hole's 2 s TTL on blocked
 * answers, so a reload straight after an allow does not re-use the cached block.
 */
function reloadTabLater(tabId: number, delayMs: number): void {
  setTimeout(() => {
    void chrome.tabs.reload(tabId, { bypassCache: true }).catch(() => {
      // The tab closed in the meantime. Nothing to reload.
    });
  }, Math.max(0, delayMs));
}

// ─── message router ───────────────────────────────────────────────────────────

async function route(request: BreakerRequest): Promise<ResponsePayloads[RequestKind]> {
  switch (request.kind) {
    case 'get-status':
      return buildStatus(request.tabId);
    case 'connect':
      return handleConnect(request.baseUrl, request.password);
    case 'disconnect':
      return handleDisconnect();
    case 'ensure-device': {
      const client = await getClient();
      return refreshDevice(client);
    }
    case 'set-network':
      return handleSetNetwork(request.blockingEnabled, request.durationSeconds);
    case 'set-device':
      return handleSetDevice(request.unfiltered, request.durationSeconds);
    case 'allow-hosts':
      return handleAllowHosts(request.tabId, request.hosts, request.durationSeconds);
    case 'revoke-allow':
      return handleRevokeAllow(request.domain);
    case 'reload-tab':
      reloadTabLater(request.tabId, request.delayMs);
      return null;
    case 'sweep-now':
      return runSweep();
  }
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const request = message as BreakerRequest;
  if (typeof request?.kind !== 'string') return false;

  route(request)
    .then((data) => sendResponse({ ok: true, data } satisfies BreakerResponse))
    .catch((error: unknown) =>
      sendResponse({ ok: false, error: toBreakerError(error) } satisfies BreakerResponse)
    );

  // Keep the message channel open for the async reply. Returning anything falsy
  // here closes it and the popup gets `undefined`.
  return true;
});

// ─── lifecycle ────────────────────────────────────────────────────────────────

/**
 * Startup work, run on every worker start — not only on onStartup/onInstalled,
 * which do not fire when Chrome revives an idle worker.
 */
function boot(): void {
  chrome.alarms.create(ALARM_SWEEP, { periodInMinutes: SWEEP_PERIOD_MINUTES, delayInMinutes: 1 });
  void (async () => {
    await ledgersRestored;
    try {
      // Catch up on anything that expired while the browser was closed, before the
      // first periodic sweep would have run.
      await runSweep();
    } catch {
      // Not configured, or the Pi-hole is unreachable right now. The periodic
      // sweep retries; the popup reports the connection problem where it is visible.
    }
    await refreshGlobalState();
  })();
}

chrome.runtime.onInstalled.addListener((details) => {
  // FIRST install only. This event also fires on every update, and hijacking a tab
  // each time Chrome updates the extension is exactly the behaviour that gets an
  // extension uninstalled.
  if (details.reason !== 'install') return;
  // Send the user somewhere useful instead of leaving them at a popup that can
  // only say "not connected".
  void chrome.runtime.openOptionsPage();
});

boot();
