/**
 * Integration check against a REAL Pi-hole v6.
 *
 *   PIHOLE_URL=http://pi.hole PIHOLE_PASSWORD=… npm run live-check
 *
 * The unit tests prove the logic against a stub; this proves the wire format
 * against an actual FTL. It exercises the same modules the extension ships —
 * `src/api/client.ts` and `src/core/*` are bundled with esbuild and imported here,
 * so there is exactly one implementation and this script cannot drift away from it.
 *
 * IT LEAVES THE PI-HOLE EXACTLY AS IT FOUND IT. Every mutation registers an undo
 * before it happens, and the undos run in reverse in a `finally` — so an assertion
 * failing halfway through still restores the blocking mode and deletes the
 * scratch group, client and domain. Anything it could not undo is reported loudly
 * rather than left silently behind.
 *
 * The scratch names are chosen to be unmistakable and collision-free:
 * the client is 192.0.2.123 (TEST-NET-1, RFC 5737 — never a real host) and the
 * domain ends in .invalid (RFC 2606 — never resolvable).
 */

import * as esbuild from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// ─── scratch identities ───────────────────────────────────────────────────────

const SCRATCH_GROUP = 'Breaker live-check';
const SCRATCH_CLIENT = '192.0.2.123';
const SCRATCH_DOMAIN = 'breaker-live-check.invalid';

// ─── arguments ────────────────────────────────────────────────────────────────

const USAGE = `
Breaker live check — exercises the Pi-hole v6 API end to end.

Usage:
  PIHOLE_URL=<url> PIHOLE_PASSWORD=<password> node scripts/live-check.mjs

Environment:
  PIHOLE_URL       Your Pi-hole address, e.g. http://pi.hole or http://192.168.1.5
  PIHOLE_PASSWORD  Your Pi-hole password. An app password is recommended
                   (Pi-hole → Settings → Web interface → App password).

It creates a scratch group, client (${SCRATCH_CLIENT}) and allow entry
(${SCRATCH_DOMAIN}), briefly disables blocking with a timer, and undoes
all of it before exiting.
`.trim();

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}

const url = process.env['PIHOLE_URL'];
const password = process.env['PIHOLE_PASSWORD'];

if (!url || !password) {
  const missing = [!url && 'PIHOLE_URL', !password && 'PIHOLE_PASSWORD'].filter(Boolean);
  console.error(
    `live-check: ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set.\n`
  );
  console.error(USAGE);
  process.exit(1);
}

// ─── build the extension's own modules and import them ────────────────────────

const buildDir = mkdtempSync(join(tmpdir(), 'breaker-live-'));
const bundlePath = join(buildDir, 'breaker.mjs');

await esbuild.build({
  absWorkingDir: root,
  stdin: {
    contents: `
      export * from './src/api/client.ts';
      export * from './src/api/version.ts';
      export * from './src/core/scopes.ts';
      export * from './src/core/device.ts';
      export * from './src/core/tags.ts';
    `,
    resolveDir: root,
    loader: 'ts'
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile: bundlePath,
  logLevel: 'warning'
});

const breaker = await import(pathToFileURL(bundlePath).href);
const {
  PiholeClient,
  allowHosts,
  crossCheck,
  deviceGroupName,
  expiredAllowDomains,
  findDeviceByIp,
  formatTag,
  formatVersion,
  identityFor,
  isUnfiltered,
  parseTag,
  restoredGroups,
  revokeAllow,
  setNetworkBlocking,
  unfilteredGroups
} = breaker;

// ─── harness ──────────────────────────────────────────────────────────────────

/** @type {{name: string, ok: boolean, detail: string}[]} */
const results = [];
/** @type {{label: string, run: () => Promise<void>}[]} */
const undos = [];

function pass(name, detail = '') {
  results.push({ name, ok: true, detail });
  console.log(`  ok    ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, detail) {
  results.push({ name, ok: false, detail });
  console.log(`  FAIL  ${name} — ${detail}`);
}

/** Run one named check; a throw becomes a FAIL and the run continues. */
async function check(name, run) {
  try {
    const detail = await run();
    pass(name, typeof detail === 'string' ? detail : '');
    return true;
  } catch (error) {
    fail(name, error instanceof Error ? error.message : String(error));
    return false;
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function undo(label, run) {
  undos.push({ label, run });
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

// ─── the run ──────────────────────────────────────────────────────────────────

const client = new PiholeClient({ baseUrl: url, password });
console.log(`\nBreaker live check → ${client.baseUrl}\n`);

let groupId = null;
let identity = null;

try {
  await check('auth: POST /api/auth mints a session', async () => {
    const session = await client.login();
    expect(session.sid !== undefined, 'no session returned');
    undo('auth: log the session out', () => client.logout());
    return session.sid === null ? 'no password required by this Pi-hole' : 'sid received';
  });

  await check('version: GET /api/info/version passes the v6 gate', async () => {
    const version = await client.requireSupportedVersion();
    return formatVersion(version);
  });

  await check('info: GET /api/info/client reports our address (no auth)', async () => {
    const info = await client.getClientInfo();
    expect(typeof info.remote_addr === 'string' && info.remote_addr.length > 0, 'no remote_addr');
    return info.remote_addr;
  });

  await check('network: GET /api/network/devices resolves this machine', async () => {
    const info = await client.getClientInfo();
    const devices = await client.getNetworkDevices();
    identity = identityFor(info.remote_addr, findDeviceByIp(devices, info.remote_addr));
    return (
      `${devices.length} devices; we are ${identity.clientKey} ` +
      `(by ${identity.keyedBy}), group would be “${deviceGroupName(identity)}”`
    );
  });

  await check('config: GET /api/config/dns/blockTTL', async () => {
    const ttl = await client.getBlockTtl();
    expect(typeof ttl === 'number', 'blockTTL is not a number');
    return `${ttl}s`;
  });

  // ── blocking: read, change with a timer, restore ──
  await check('blocking: GET /api/dns/blocking', async () => {
    const state = await client.getBlocking();
    expect(
      ['enabled', 'disabled', 'failed', 'unknown'].includes(state.blocking),
      `unexpected status "${state.blocking}"`
    );

    // Registered BEFORE the change, so a failure below still restores it.
    const original = state;
    undo('blocking: restore the original mode', async () => {
      await setNetworkBlocking(client, original.blocking !== 'disabled', original.timer);
    });

    return `${state.blocking}, timer ${state.timer === null ? 'none' : `${state.timer}s`}`;
  });

  await check('blocking: POST disables with a 60s timer', async () => {
    const result = await setNetworkBlocking(client, false, 60);
    expect(result.blocking === 'disabled', `expected disabled, got "${result.blocking}"`);
    expect(result.timer !== null && result.timer > 0, 'no timer came back');
    const readBack = await client.getBlocking();
    expect(readBack.blocking === 'disabled', 'read-back does not agree with the write');
    return `disabled, ${Math.round(readBack.timer)}s remaining`;
  });

  await check('blocking: POST re-enables permanently', async () => {
    const result = await setNetworkBlocking(client, true, null);
    expect(result.blocking === 'enabled', `expected enabled, got "${result.blocking}"`);
    expect(result.timer === null, 'a timer survived the re-enable');
    return 'enabled, no timer';
  });

  // ── groups ──
  await check('groups: POST /api/groups creates a tagged group', async () => {
    const existing = await client.getGroups();
    expect(
      !existing.some((group) => group.name === SCRATCH_GROUP),
      `"${SCRATCH_GROUP}" already exists — delete it in Pi-hole and re-run`
    );

    const comment = formatTag({ expires: null, scope: 'device', origin: SCRATCH_CLIENT });
    await client.addGroup({ name: SCRATCH_GROUP, comment, enabled: true });
    undo(`groups: delete "${SCRATCH_GROUP}"`, () => client.deleteGroup(SCRATCH_GROUP));

    const groups = await client.getGroups();
    const created = groups.find((group) => group.name === SCRATCH_GROUP);
    expect(created !== undefined, 'the created group is not in the list');
    expect(created.enabled === true, 'the created group is disabled');

    const tag = parseTag(created.comment);
    expect(tag !== null, `the tag did not survive the round trip: ${created.comment}`);
    expect(tag.scope === 'device', 'the tag scope changed in transit');

    groupId = created.id;
    return `id ${groupId}, tag parsed back`;
  });

  // ── clients ──
  await check('clients: POST creates a client in Default + the breaker group', async () => {
    expect(groupId !== null, 'skipped: no scratch group');
    const existing = await client.getClients();
    expect(
      !existing.some((entry) => entry.client === SCRATCH_CLIENT),
      `${SCRATCH_CLIENT} already exists as a client — delete it in Pi-hole and re-run`
    );

    const comment = formatTag({ expires: null, scope: 'device', origin: SCRATCH_CLIENT });
    await client.addClient({ client: SCRATCH_CLIENT, comment, groups: [0, groupId] });
    undo(`clients: delete ${SCRATCH_CLIENT}`, () => client.deleteClient(SCRATCH_CLIENT));

    const clients = await client.getClients();
    const created = clients.find((entry) => entry.client === SCRATCH_CLIENT);
    expect(created !== undefined, 'the created client is not in the list');
    expect(
      created.groups.includes(0) && created.groups.includes(groupId),
      `groups came back as [${created.groups}]`
    );
    return `groups [${created.groups.join(', ')}]`;
  });

  await check('clients: PUT moves it to the unfiltered membership and back', async () => {
    expect(groupId !== null, 'skipped: no scratch group');

    await client.updateClient(SCRATCH_CLIENT, {
      comment: formatTag({ expires: nowSeconds() + 60, scope: 'device', origin: SCRATCH_CLIENT }),
      groups: unfilteredGroups(groupId)
    });

    let entry = (await client.getClients()).find((row) => row.client === SCRATCH_CLIENT);
    expect(isUnfiltered(entry.groups, groupId), `expected [${groupId}], got [${entry.groups}]`);

    await client.updateClient(SCRATCH_CLIENT, {
      comment: formatTag({ expires: null, scope: 'device', origin: SCRATCH_CLIENT }),
      groups: restoredGroups([0], groupId)
    });

    entry = (await client.getClients()).find((row) => row.client === SCRATCH_CLIENT);
    expect(!isUnfiltered(entry.groups, groupId), 'the restore did not take');
    expect(entry.groups.includes(0), 'Default did not come back');
    return `unfiltered [${groupId}] → restored [${entry.groups.join(', ')}]`;
  });

  // ── domains ──
  await check('domains: POST /api/domains/allow/exact adds a tagged grant', async () => {
    expect(groupId !== null, 'skipped: no scratch group');
    const existing = await client.getDomains('allow', 'exact');
    expect(
      !existing.some((domain) => domain.domain === SCRATCH_DOMAIN),
      `${SCRATCH_DOMAIN} already allowed — delete it in Pi-hole and re-run`
    );

    const result = await allowHosts(client, {
      hosts: [SCRATCH_DOMAIN],
      breakerGroupId: groupId,
      origin: 'live-check.example',
      durationSeconds: 600,
      nowSeconds: nowSeconds()
    });
    undo(`domains: delete ${SCRATCH_DOMAIN}`, () =>
      client.deleteDomain('allow', 'exact', SCRATCH_DOMAIN)
    );

    expect(result.added.includes(SCRATCH_DOMAIN), `not added: ${JSON.stringify(result)}`);

    const domains = await client.getDomains('allow', 'exact');
    const created = domains.find((domain) => domain.domain === SCRATCH_DOMAIN);
    expect(created !== undefined, 'the created domain is not in the list');
    expect(
      created.groups.length === 1 && created.groups[0] === groupId,
      `scoped to [${created.groups}] instead of [${groupId}] — it would apply network-wide`
    );

    const tag = parseTag(created.comment);
    expect(tag !== null, `the tag did not survive: ${created.comment}`);
    expect(tag.scope === 'tab', 'the tag scope changed in transit');
    return `id ${created.id}, expires in ${tag.expires - nowSeconds()}s`;
  });

  await check('domains: PUT extends the grant rather than duplicating it', async () => {
    expect(groupId !== null, 'skipped: no scratch group');
    const result = await allowHosts(client, {
      hosts: [SCRATCH_DOMAIN],
      breakerGroupId: groupId,
      origin: 'live-check.example',
      durationSeconds: 3600,
      nowSeconds: nowSeconds()
    });
    expect(result.extended.includes(SCRATCH_DOMAIN), `not extended: ${JSON.stringify(result)}`);

    const domains = await client.getDomains('allow', 'exact');
    const matches = domains.filter((domain) => domain.domain === SCRATCH_DOMAIN);
    expect(matches.length === 1, `${matches.length} copies of the domain exist`);
    const tag = parseTag(matches[0].comment);
    expect(tag.expires - nowSeconds() > 3000, 'the deadline did not move');
    return `one row, now expires in ${tag.expires - nowSeconds()}s`;
  });

  await check('sweep: an expired grant is identified from real wire data', async () => {
    expect(groupId !== null, 'skipped: no scratch group');
    // Rewrite our own grant to be already expired, then ask the pure sweep rule
    // what it would delete. Deliberately NOT running the global sweep: that would
    // also remove any genuinely expired grants of the user's, and this script
    // changes nothing it did not create.
    await client.updateDomain('allow', 'exact', SCRATCH_DOMAIN, {
      type: 'allow',
      kind: 'exact',
      comment: formatTag({ expires: nowSeconds() - 1, scope: 'tab', origin: 'live-check.example' }),
      groups: [groupId],
      enabled: true
    });

    const domains = await client.getDomains('allow', 'exact');
    const expired = expiredAllowDomains(domains, nowSeconds());
    expect(expired.includes(SCRATCH_DOMAIN), 'the sweep would not have removed it');

    // Everything else on the allowlist must be left alone.
    const foreign = domains.filter((domain) => parseTag(domain.comment) === null);
    for (const domain of foreign) {
      expect(
        !expired.includes(domain.domain),
        `the sweep would delete an entry Breaker does not own: ${domain.domain}`
      );
    }
    return (
      `${expired.length} expired, ` +
      `${foreign.length} untagged ${foreign.length === 1 ? 'entry' : 'entries'} untouched`
    );
  });

  await check('domains: DELETE removes the grant', async () => {
    const removed = await revokeAllow(client, SCRATCH_DOMAIN);
    expect(removed === true, 'revokeAllow reported nothing to remove');
    const domains = await client.getDomains('allow', 'exact');
    expect(
      !domains.some((domain) => domain.domain === SCRATCH_DOMAIN),
      'the domain is still listed after the delete'
    );
    // Already gone — drop the undo so the teardown does not report a phantom failure.
    const index = undos.findIndex((entry) => entry.label.includes(SCRATCH_DOMAIN));
    if (index !== -1) undos.splice(index, 1);
    return 'gone';
  });

  // ── queries ──
  await check('queries: GET /api/queries returns this device\'s recent lookups', async () => {
    expect(identity !== null, 'skipped: identity unknown');
    const queries = await client.getQueries({
      from: nowSeconds() - 900,
      client_ip: identity.ip,
      length: 200
    });
    const statuses = new Set(queries.map((entry) => entry.status));
    const sample = queries.slice(0, 50).map((entry) => entry.domain);
    const verdicts = crossCheck(sample, queries);
    const blocked = [...verdicts.verdicts.values()].filter((verdict) => verdict === 'blocked');
    return (
      `${queries.length} queries in 15 min from ${identity.ip}; ` +
      `statuses {${[...statuses].slice(0, 6).join(', ')}}; ` +
      `${blocked.length}/${sample.length} sampled names blocked`
    );
  });
} catch (error) {
  fail('run', error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  // ── teardown, newest first ──
  if (undos.length > 0) console.log('\nRestoring:');
  for (const entry of undos.reverse()) {
    try {
      await entry.run();
      console.log(`  ok    ${entry.label}`);
    } catch (error) {
      // Loud, not silent: something was left behind and the user must know what.
      console.log(
        `  FAIL  ${entry.label} — ${error instanceof Error ? error.message : String(error)}`
      );
      results.push({
        name: `restore: ${entry.label}`,
        ok: false,
        detail: 'COULD NOT UNDO — clean this up in Pi-hole by hand'
      });
    }
  }
  rmSync(buildDir, { recursive: true, force: true });
}

// ─── report ───────────────────────────────────────────────────────────────────

const width = Math.max(...results.map((result) => result.name.length), 4);
console.log(`\n${'─'.repeat(width + 8)}`);
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name.padEnd(width)}  ${result.detail}`);
}
const failed = results.filter((result) => !result.ok).length;
console.log(`${'─'.repeat(width + 8)}`);
console.log(`${results.length - failed}/${results.length} passed\n`);

process.exit(failed === 0 ? 0 : 1);
