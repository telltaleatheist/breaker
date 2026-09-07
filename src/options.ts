/**
 * Options: connect to a Pi-hole, and show what Breaker resolved about this device.
 *
 * Two jobs, and the second is the one people underestimate. Every scope except the
 * network one depends on Pi-hole correctly identifying THIS machine, and when it
 * does not — VPN, a second router, Chrome's Secure DNS — nothing works and the
 * failure is invisible. So the page states, in plain words, the address Pi-hole
 * saw and whether it found a MAC for it, and the user can judge whether that is
 * really them.
 */

import { normalizeBaseUrl, PiholeError } from './api/client';
import {
  BreakerRequestError,
  send,
  STORAGE_KEYS,
  type BreakerSettings,
  type BreakerStatus,
  type ConnectResult,
  type DeviceView
} from './messages';

function must<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`options.html is missing #${id}`);
  return element as T;
}

const elements = {
  form: must<HTMLFormElement>('connect-form'),
  url: must<HTMLInputElement>('url'),
  password: must<HTMLInputElement>('password'),
  reveal: must<HTMLInputElement>('reveal'),
  connect: must<HTMLButtonElement>('connect'),
  disconnect: must<HTMLButtonElement>('disconnect'),
  result: must<HTMLDivElement>('result'),
  identity: must<HTMLDivElement>('identity'),
  identityBody: must<HTMLDivElement>('identity-body'),
  setupDevice: must<HTMLButtonElement>('setup-device'),
  sweep: must<HTMLButtonElement>('sweep')
};

let busy = false;

// ─── output ───────────────────────────────────────────────────────────────────

function setResult(message: string, tone: 'ok' | 'error' | 'warn' | 'info'): void {
  elements.result.className = `result result-${tone}`;
  elements.result.replaceChildren();

  for (const line of message.split('\n')) {
    const paragraph = document.createElement('p');
    paragraph.textContent = line;
    elements.result.append(paragraph);
  }
}

function appendAppPasswordAdvice(): void {
  const paragraph = document.createElement('p');
  paragraph.append(
    document.createTextNode(
      'This Pi-hole has two-factor authentication on. Create an app password instead: ' +
        'in the Pi-hole web interface, Settings → Web interface → App password. Paste that ' +
        'here in place of your login password.'
    )
  );
  elements.result.append(paragraph);
}

function setBusy(value: boolean): void {
  busy = value;
  elements.connect.disabled = value;
  elements.disconnect.disabled = value;
  elements.setupDevice.disabled = value;
  elements.sweep.disabled = value;
  elements.connect.textContent = value ? 'Connecting…' : 'Connect';
}

// ─── identity panel ───────────────────────────────────────────────────────────

function renderIdentity(device: DeviceView | null): void {
  elements.identityBody.replaceChildren();
  if (!device) {
    elements.identity.hidden = true;
    return;
  }
  elements.identity.hidden = false;

  const rows: [string, string][] = [
    ['Address Pi-hole sees', device.identity.ip],
    ['Hostname', device.identity.hostname ?? '—'],
    [
      'MAC',
      device.identity.hwaddr ??
        'not known to Pi-hole (Breaker will use the address above instead)'
    ],
    ['Pi-hole client entry', device.identity.clientKey],
    ['Pi-hole group', `${device.groupName} (id ${device.groupId})`],
    ['Filtering', device.unfiltered ? 'currently OFF for this device' : 'on']
  ];

  for (const [label, value] of rows) {
    const row = document.createElement('div');
    row.className = 'kv';
    const key = document.createElement('span');
    key.className = 'kv-key';
    key.textContent = label;
    const val = document.createElement('span');
    val.className = 'kv-value';
    val.textContent = value;
    row.append(key, val);
    elements.identityBody.append(row);
  }

  if (device.identity.keyedBy === 'ip') {
    const warning = document.createElement('p');
    warning.className = 'note note-warn';
    warning.textContent =
      'Pi-hole has no MAC address for this machine, so Breaker is keying on the IP. ' +
      'That still works, but a DHCP lease change will move it. If the address above is ' +
      'not this computer — a VPN endpoint, or your router — then the device and tab ' +
      'switches would affect everything behind it, and you should use the network ' +
      'switch instead.';
    elements.identityBody.append(warning);
  }
}

// ─── load ─────────────────────────────────────────────────────────────────────

async function loadSettings(): Promise<BreakerSettings> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  const settings = stored[STORAGE_KEYS.settings] as Partial<BreakerSettings> | undefined;
  return { baseUrl: settings?.baseUrl ?? '', password: settings?.password ?? '' };
}

async function refresh(): Promise<void> {
  // Ask the background first: on a build with baked settings, its first load is
  // what seeds storage, and reading storage before that would show empty fields
  // for a Pi-hole that is in fact already connected.
  let status: BreakerStatus | null = null;
  let statusError: unknown = null;
  try {
    status = await send({ kind: 'get-status', tabId: null });
  } catch (error) {
    statusError = error;
  }

  const settings = await loadSettings();
  elements.url.value = settings.baseUrl;
  elements.password.value = settings.password;
  elements.disconnect.hidden = settings.baseUrl === '';

  if (settings.baseUrl === '') {
    setResult(
      'Enter your Pi-hole address and password, then Connect.\n' +
        'The address is whatever you use for the Pi-hole web interface — for example ' +
        'http://pi.hole or http://192.168.1.5.',
      'info'
    );
    renderIdentity(null);
    return;
  }

  try {
    if (status === null) throw statusError;
    if (status.connection.ok) {
      const identity = status.connection.identity;
      setResult(
        `Connected to Pi-hole ${status.connection.version} at ${status.connection.baseUrl}` +
          (identity ? `, as ${identity.ip}` : '') +
          (identity?.hwaddr ? ` (MAC ${identity.hwaddr})` : ''),
        'ok'
      );
      renderIdentity(status.device);
    } else {
      setResult(status.connection.error?.message ?? 'Pi-hole is unreachable.', 'error');
      renderIdentity(null);
    }
  } catch (error) {
    setResult(describe(error), 'error');
    renderIdentity(null);
  }
}

function describe(error: unknown): string {
  if (error instanceof BreakerRequestError || error instanceof Error) return error.message;
  return String(error);
}

// ─── actions ──────────────────────────────────────────────────────────────────

async function connect(): Promise<void> {
  if (busy) return;

  const rawUrl = elements.url.value;
  // Validate the address here so a typo is reported as a typo, before it becomes a
  // confusing "could not reach" from the background.
  let baseUrl: string;
  try {
    baseUrl = normalizeBaseUrl(rawUrl);
  } catch (error) {
    setResult(error instanceof PiholeError ? error.message : describe(error), 'error');
    return;
  }
  elements.url.value = baseUrl;

  setBusy(true);
  setResult('Connecting…', 'info');
  try {
    const result: ConnectResult = await send({
      kind: 'connect',
      baseUrl,
      password: elements.password.value
    });

    const identity = result.identity;
    setResult(
      `Connected to Pi-hole ${result.version} as ${identity.ip}` +
        (identity.hwaddr ? ` (MAC ${identity.hwaddr})` : ' (no MAC known to Pi-hole)') +
        `\nBlocked answers carry a ${result.blockTtl}s TTL, so a page reload is enough ` +
        `after allowing a domain.`,
      'ok'
    );
    elements.disconnect.hidden = false;
    await refresh();
  } catch (error) {
    setResult(describe(error), 'error');
    if (error instanceof BreakerRequestError && error.totpRequired) appendAppPasswordAdvice();
    renderIdentity(null);
  } finally {
    setBusy(false);
  }
}

async function disconnect(): Promise<void> {
  if (busy) return;
  setBusy(true);
  try {
    await send({ kind: 'disconnect' });
    elements.url.value = '';
    elements.password.value = '';
    elements.disconnect.hidden = true;
    renderIdentity(null);
    setResult('Disconnected. The session was logged out and the password forgotten.', 'info');
  } catch (error) {
    setResult(describe(error), 'error');
  } finally {
    setBusy(false);
  }
}

async function setupDevice(): Promise<void> {
  if (busy) return;
  setBusy(true);
  try {
    const device = await send({ kind: 'ensure-device' });
    renderIdentity(device);
    setResult(
      `This device is set up: Pi-hole group “${device.groupName}”, client entry ` +
        `${device.identity.clientKey}.`,
      'ok'
    );
  } catch (error) {
    setResult(describe(error), 'error');
  } finally {
    setBusy(false);
  }
}

async function sweepNow(): Promise<void> {
  if (busy) return;
  setBusy(true);
  try {
    const result = await send({ kind: 'sweep-now' });
    const parts: string[] = [];
    if (result.allowsRemoved.length > 0) {
      parts.push(`Removed ${result.allowsRemoved.length} expired allow entry/entries: ` +
        result.allowsRemoved.join(', '));
    }
    if (result.devicesRestored.length > 0) {
      parts.push(`Restored filtering for: ${result.devicesRestored.join(', ')}`);
    }
    setResult(parts.length > 0 ? parts.join('\n') : 'Nothing had expired.', 'ok');
  } catch (error) {
    setResult(describe(error), 'error');
  } finally {
    setBusy(false);
  }
}

// ─── wiring ───────────────────────────────────────────────────────────────────

elements.form.addEventListener('submit', (event) => {
  event.preventDefault();
  void connect();
});

elements.disconnect.addEventListener('click', () => void disconnect());
elements.setupDevice.addEventListener('click', () => void setupDevice());
elements.sweep.addEventListener('click', () => void sweepNow());

elements.reveal.addEventListener('change', () => {
  elements.password.type = elements.reveal.checked ? 'text' : 'password';
});

void refresh();
