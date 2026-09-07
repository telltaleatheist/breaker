/**
 * The popup: one duration picker and three switches.
 *
 * It holds no credentials and speaks no Pi-hole — every button is an intent sent
 * to the background, and every render is a `get-status` reply. That keeps the
 * password in one context and means closing the popup mid-request cannot leave a
 * change half-applied.
 *
 * Rendering is full-redraw-per-state rather than incremental DOM patching. The
 * popup is small, it is destroyed every time it closes, and a redraw cannot drift
 * out of sync with the state it came from.
 */

import { DURATION_PRESETS } from './core/scopes';
import { REASON_LABELS } from './core/blocked-detect';
import {
  BreakerRequestError,
  send,
  type BreakerStatus,
  type LedgerEntryView
} from './messages';

// ─── element handles ──────────────────────────────────────────────────────────

function must<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`popup.html is missing #${id}`);
  return element as T;
}

const elements = {
  connection: must<HTMLDivElement>('connection'),
  banner: must<HTMLDivElement>('banner'),
  durations: must<HTMLDivElement>('durations'),
  tabSite: must<HTMLSpanElement>('tab-site'),
  tabHosts: must<HTMLDivElement>('tab-hosts'),
  tabActions: must<HTMLDivElement>('tab-actions'),
  tabNote: must<HTMLParagraphElement>('tab-note'),
  tabAllows: must<HTMLDivElement>('tab-allows'),
  deviceState: must<HTMLDivElement>('device-state'),
  deviceButton: must<HTMLButtonElement>('device-button'),
  deviceNote: must<HTMLParagraphElement>('device-note'),
  networkState: must<HTMLDivElement>('network-state'),
  networkButton: must<HTMLButtonElement>('network-button'),
  networkNote: must<HTMLParagraphElement>('network-note'),
  optionsLink: must<HTMLAnchorElement>('options-link')
};

// ─── local state ──────────────────────────────────────────────────────────────

/** Index into DURATION_PRESETS. Defaults to 10 minutes — the least committal. */
let durationIndex = 0;
/** Hosts the user has ticked in the tab list. */
const selected = new Set<string>();
let status: BreakerStatus | null = null;
let tabId: number | null = null;
/** Real seconds elapsed since `status.nowSeconds`, so countdowns tick smoothly. */
let statusReceivedAt = Date.now();
let busy = false;

function chosenDuration(): number | null {
  return DURATION_PRESETS[durationIndex]?.seconds ?? null;
}

/** "now" on the background's clock — never the popup's, which may differ. */
function currentSeconds(): number {
  if (!status) return Math.floor(Date.now() / 1000);
  return status.nowSeconds + Math.floor((Date.now() - statusReceivedAt) / 1000);
}

// ─── formatting ───────────────────────────────────────────────────────────────

/** Compact countdown: "9:58", "1:04:12", "0:07". */
function formatRemaining(seconds: number): string {
  const clamped = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const secs = clamped % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function expiryText(expires: number | null): string {
  if (expires === null) return 'until you say';
  const remaining = expires - currentSeconds();
  return remaining <= 0 ? 'expiring…' : formatRemaining(remaining);
}

// ─── rendering ────────────────────────────────────────────────────────────────

function setBanner(message: string, tone: 'error' | 'warn' | 'ok' | null): void {
  if (tone === null || message === '') {
    elements.banner.textContent = '';
    elements.banner.className = 'banner hidden';
    return;
  }
  elements.banner.textContent = message;
  elements.banner.className = `banner banner-${tone}`;
}

function renderDurations(): void {
  elements.durations.replaceChildren(
    ...DURATION_PRESETS.map((preset, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = index === durationIndex ? 'chip chip-on' : 'chip';
      button.textContent = preset.label;
      button.addEventListener('click', () => {
        durationIndex = index;
        renderDurations();
      });
      return button;
    })
  );
}

function renderConnection(state: BreakerStatus): void {
  const { connection } = state;
  elements.connection.replaceChildren();

  const dot = document.createElement('span');
  dot.className = connection.ok ? 'dot dot-ok' : 'dot dot-bad';
  const label = document.createElement('span');

  if (!connection.configured) {
    label.textContent = 'Not connected';
  } else if (connection.ok) {
    const version = connection.version ?? '';
    const who = connection.identity ? ` · ${connection.identity.ip}` : '';
    label.textContent = `Pi-hole ${version}${who}`;
  } else {
    label.textContent = 'Pi-hole unreachable';
  }

  elements.connection.append(dot, label);
}

function renderTabHosts(state: BreakerStatus): void {
  const { hosts } = state.tab;
  elements.tabHosts.replaceChildren();

  if (hosts.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent =
      'Pi-hole has not blocked anything on this page yet. If the page is broken, reload it ' +
      'with this popup closed, then open the popup again.';
    elements.tabHosts.append(empty);
    return;
  }

  for (const host of hosts) {
    const row = document.createElement('label');
    row.className = 'host';

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = selected.has(host.host);
    box.addEventListener('change', () => {
      if (box.checked) selected.add(host.host);
      else selected.delete(host.host);
      renderTabActions();
    });

    const name = document.createElement('span');
    name.className = 'host-name';
    name.textContent = host.host;
    name.title = host.host;

    const meta = document.createElement('span');
    meta.className = 'host-meta';
    meta.textContent = host.count > 1 ? `×${host.count}` : '';

    const verdict = document.createElement('span');
    verdict.className = `verdict verdict-${host.verdict}`;
    verdict.textContent = verdictLabel(host);
    verdict.title = verdictTitle(host);

    row.append(box, name, meta, verdict);
    elements.tabHosts.append(row);
  }
}

function verdictLabel(entry: LedgerEntryView): string {
  switch (entry.verdict) {
    case 'blocked':
      return 'blocked';
    case 'allowed':
      return 'not Pi-hole';
    case 'unseen':
      return 'unseen';
    case 'unchecked':
      return 'not checked';
  }
}

function verdictTitle(entry: LedgerEntryView): string {
  switch (entry.verdict) {
    case 'blocked':
      return "Pi-hole's query log confirms it blocked this name.";
    case 'allowed':
      return 'Pi-hole answered this name normally — the failure is something else, ' +
        'so allowing it will not help.';
    case 'unseen':
      return 'Pi-hole never saw a query for this name from this device.';
    case 'unchecked':
      return `Not cross-checked yet — Chrome reported that the request ${REASON_LABELS[entry.reason]}.`;
  }
}

function renderTabActions(): void {
  elements.tabActions.replaceChildren();
  const hosts = status?.tab.hosts ?? [];
  if (hosts.length === 0) return;

  const allowSelected = button(
    `Unblock ${selected.size} selected`,
    'primary',
    selected.size === 0,
    () => void allow([...selected])
  );
  const allowAll = button('Unblock all', 'secondary', false, () =>
    void allow(hosts.map((host) => host.host))
  );
  const check = button('Check with Pi-hole', 'ghost', false, () => void crossCheckTab());

  elements.tabActions.append(allowSelected, allowAll, check);
}

function renderTabAllows(state: BreakerStatus): void {
  elements.tabAllows.replaceChildren();
  const forSite = state.allows.filter((allow) => allow.forThisSite);
  const others = state.allows.filter((allow) => !allow.forThisSite);

  if (state.allows.length === 0) return;

  const heading = document.createElement('h3');
  heading.textContent = 'Unblocked for now';
  elements.tabAllows.append(heading);

  for (const grant of [...forSite, ...others]) {
    const row = document.createElement('div');
    row.className = grant.forThisSite ? 'grant grant-here' : 'grant';

    const name = document.createElement('span');
    name.className = 'grant-name';
    name.textContent = grant.domain;
    name.title = `allowed from ${grant.origin}`;

    const timer = document.createElement('span');
    timer.className = 'grant-timer';
    timer.dataset['expires'] = grant.expires === null ? '' : String(grant.expires);
    timer.textContent = expiryText(grant.expires);

    const revokeButton = button('Revoke', 'ghost', false, () => void revokeGrant(grant.domain));
    revokeButton.classList.add('tiny');

    row.append(name, timer, revokeButton);
    elements.tabAllows.append(row);
  }

  const reload = button('Reload page', 'secondary', tabId === null, () => {
    if (tabId !== null) void chrome.tabs.reload(tabId);
    window.close();
  });
  reload.classList.add('wide');
  elements.tabAllows.append(reload);
}

function renderDevice(state: BreakerStatus): void {
  const { device } = state;
  if (!device) {
    // Three different "no device" states, and conflating them would be a lie in two
    // of the three cases. Not-set-up is the normal first-run state, not a fault:
    // Breaker deliberately creates nothing on the Pi-hole until a switch is used.
    if (state.connection.ok) {
      elements.deviceState.textContent = 'Not set up yet';
      elements.deviceState.className = 'state';
      elements.deviceButton.disabled = busy;
      elements.deviceButton.textContent = 'Turn Pi-hole off for this computer';
      elements.deviceNote.textContent =
        'Only this computer. Everyone else stays protected. The first press registers this ' +
        'computer with your Pi-hole.';
    } else {
      elements.deviceState.textContent = state.connection.configured
        ? 'Unavailable while Pi-hole is unreachable.'
        : 'Connect a Pi-hole first.';
      elements.deviceState.className = 'state';
      elements.deviceButton.disabled = true;
      elements.deviceButton.textContent = 'Turn Pi-hole off for this computer';
      elements.deviceNote.textContent = '';
    }
    elements.deviceState.dataset['expires'] = '';
    return;
  }

  elements.deviceState.textContent = device.unfiltered
    ? `Pi-hole is OFF for this computer · ${expiryText(device.expires)}`
    : 'Pi-hole is on for this computer';
  elements.deviceState.className = device.unfiltered ? 'state state-off' : 'state state-on';
  elements.deviceState.dataset['expires'] =
    device.unfiltered && device.expires !== null ? String(device.expires) : '';

  elements.deviceButton.disabled = busy;
  elements.deviceButton.textContent = device.unfiltered
    ? 'Turn Pi-hole back on for this computer'
    : 'Turn Pi-hole off for this computer';

  const identity = device.identity;
  elements.deviceNote.textContent =
    identity.keyedBy === 'mac'
      ? `Only this computer (${identity.ip}). Everyone else stays protected. After turning back on, ads can linger a few minutes until the browser's DNS cache expires.`
      : `Pi-hole has no MAC for this machine, so Breaker is using the address ${identity.ip}. ` +
        `If you are on a VPN or behind another router, that address may be the router — and ` +
        `this switch would then affect everything behind it.`;
}

function renderNetwork(state: BreakerStatus): void {
  const { network } = state;
  if (!network) {
    elements.networkState.textContent = state.connection.configured
      ? 'Unavailable while Pi-hole is unreachable.'
      : 'Connect a Pi-hole first.';
    elements.networkButton.disabled = true;
    elements.networkButton.textContent = 'Turn Pi-hole off for everyone';
    elements.networkNote.textContent = '';
    return;
  }

  const off = network.blocking === 'disabled';
  elements.networkState.className = off ? 'state state-off' : 'state state-on';
  elements.networkState.textContent = off
    ? network.timer === null
      ? 'Pi-hole is OFF for everyone · until you say'
      : `Pi-hole is OFF for everyone · ${formatRemaining(network.timer)}`
    : network.blocking === 'enabled'
      ? 'Pi-hole is on for everyone'
      : `Pi-hole reports "${network.blocking}"`;
  // Pi-hole owns this countdown, so it is rendered from a deadline derived once
  // rather than from a second timer of ours that could disagree with it.
  elements.networkState.dataset['expires'] =
    off && network.timer !== null ? String(currentSeconds() + Math.floor(network.timer)) : '';

  elements.networkButton.disabled = busy;
  elements.networkButton.textContent = off ? 'Turn Pi-hole back on for everyone' : 'Turn Pi-hole off for everyone';
  elements.networkNote.textContent = off
    ? 'Every device in the house is unprotected right now.'
    : 'Every device in the house. Pi-hole runs the countdown itself, so it comes back on ' +
      'even if this browser is closed. After turning back on, ads can linger a few minutes ' +
      'until the browser\'s DNS cache expires.';
}

function render(): void {
  if (!status) return;
  renderConnection(status);
  renderTabHosts(status);
  renderTabActions();
  renderTabAllows(status);
  renderDevice(status);
  renderNetwork(status);

  elements.tabSite.textContent = status.tab.host ?? 'this page';

  if (!status.connection.configured) {
    setBanner('Breaker is not connected to a Pi-hole yet. Open Options to add yours.', 'warn');
  } else if (status.connection.error) {
    setBanner(status.connection.error.message, 'error');
  } else if (status.tab.dohSuspected) {
    setBanner(
      'Chrome may be using Secure DNS (DoH) and bypassing Pi-hole: Pi-hole saw no ' +
        'queries at all from this device. Turn off chrome://settings/security → Use secure DNS.',
      'warn'
    );
  } else {
    setBanner('', null);
  }

  elements.tabNote.textContent =
    'Unblocking here applies to this computer only, for the chosen time. Reload the page afterwards.';
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function button(
  label: string,
  variant: 'primary' | 'secondary' | 'ghost',
  disabled: boolean,
  onClick: () => void
): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = `btn btn-${variant}`;
  element.textContent = label;
  element.disabled = disabled || busy;
  element.addEventListener('click', onClick);
  return element;
}

/** Run an action, showing its failure verbatim rather than swallowing it. */
async function act(action: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  render();
  try {
    await action();
    await refresh();
  } catch (error) {
    setBanner(
      error instanceof BreakerRequestError || error instanceof Error
        ? error.message
        : String(error),
      'error'
    );
  } finally {
    busy = false;
    render();
  }
}

// ─── actions ──────────────────────────────────────────────────────────────────

async function refresh(): Promise<void> {
  status = await send({ kind: 'get-status', tabId });
  statusReceivedAt = Date.now();
  // Drop ticks for hosts that are gone, so the count on the button stays honest.
  const present = new Set(status.tab.hosts.map((host) => host.host));
  for (const host of [...selected]) if (!present.has(host)) selected.delete(host);
}

async function allow(hosts: string[]): Promise<void> {
  const target = tabId;
  if (target === null || hosts.length === 0) return;
  await act(async () => {
    const result = await send({
      kind: 'allow-hosts',
      tabId: target,
      hosts,
      durationSeconds: chosenDuration()
    });
    selected.clear();
    if (result.skipped.length > 0) {
      setBanner(
        result.skipped.map((item) => `${item.domain}: ${item.why}`).join(' · '),
        'warn'
      );
    }
  });
}

async function revokeGrant(domain: string): Promise<void> {
  await act(async () => {
    await send({ kind: 'revoke-allow', domain });
  });
}

async function crossCheckTab(): Promise<void> {
  const target = tabId;
  if (target === null) return;
  await act(async () => {
    const result = await send({ kind: 'cross-check', tabId: target });
    if (!result.dohSuspected && result.verdicts.length === 0) {
      setBanner('Nothing to cross-check on this tab yet.', 'warn');
    }
  });
}

// ─── wiring ───────────────────────────────────────────────────────────────────

elements.deviceButton.addEventListener('click', () => {
  // No device record yet means "not set up": the press is what sets it up, and the
  // only sensible thing it can then do is trip the breaker.
  if (!status || !status.connection.ok) return;
  const unfiltered = status.device ? !status.device.unfiltered : true;
  void act(async () => {
    await send({ kind: 'set-device', unfiltered, durationSeconds: chosenDuration() });
  });
});

elements.networkButton.addEventListener('click', () => {
  const network = status?.network;
  if (!network) return;
  const off = network.blocking === 'disabled';
  void act(async () => {
    await send({
      kind: 'set-network',
      // Tripping the breaker means turning BLOCKING off.
      blockingEnabled: off,
      durationSeconds: chosenDuration()
    });
  });
});

elements.optionsLink.addEventListener('click', (event) => {
  event.preventDefault();
  void chrome.runtime.openOptionsPage();
});

/**
 * Tick the visible countdowns once a second without re-asking the background.
 * Only the text of elements carrying a `data-expires` deadline changes.
 */
setInterval(() => {
  const now = currentSeconds();
  for (const element of document.querySelectorAll<HTMLElement>('[data-expires]')) {
    const raw = element.dataset['expires'];
    if (!raw) continue;
    const remaining = Number(raw) - now;
    if (element.classList.contains('grant-timer')) {
      element.textContent = remaining <= 0 ? 'expiring…' : formatRemaining(remaining);
    } else if (element.classList.contains('state')) {
      const prefix = element.textContent?.split(' · ')[0] ?? '';
      element.textContent = `${prefix} · ${remaining <= 0 ? 'expiring…' : formatRemaining(remaining)}`;
    }
  }
}, 1000);

void (async () => {
  renderDurations();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;
  try {
    await refresh();
  } catch (error) {
    setBanner(error instanceof Error ? error.message : String(error), 'error');
  }
  render();
})();
