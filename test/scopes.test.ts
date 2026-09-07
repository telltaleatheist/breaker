import { describe, expect, it } from 'vitest';

import {
  allowHosts,
  crossCheck,
  DEFAULT_GROUP_ID,
  domainsToGrants,
  DURATION_PRESETS,
  expiredAllowDomains,
  isUnfiltered,
  listBreakerAllows,
  restoredGroups,
  revokeAllow,
  setDeviceUnfiltered,
  setNetworkBlocking,
  sweepExpiredAllows,
  sweepExpiredDeviceGrants,
  unfilteredGroups,
  withBreakerGroup
} from '../src/core/scopes';
import { formatTag } from '../src/core/tags';
import { FakePihole, query } from './fake-pihole';
import type { Domain } from '../src/api/types';

const NOW = 1_756_000_000;
const BREAKER_GROUP = 7;

// ─── group arithmetic ─────────────────────────────────────────────────────────
//
// This block is the reason scopes.ts separates arithmetic from I/O: a wrong
// `groups` array does not throw, it silently un-filters a device or drops it out
// of a group the user set by hand.

describe('withBreakerGroup', () => {
  it('adds the group and keeps every other membership', () => {
    expect(withBreakerGroup([0, 3], BREAKER_GROUP)).toEqual([0, 3, 7]);
  });

  it('is idempotent', () => {
    expect(withBreakerGroup([0, 7], BREAKER_GROUP)).toEqual([0, 7]);
    expect(withBreakerGroup(withBreakerGroup([0], 7), 7)).toEqual([0, 7]);
  });

  it('normalises order and duplicates so two equal sets compare equal', () => {
    expect(withBreakerGroup([7, 3, 0, 3], BREAKER_GROUP)).toEqual([0, 3, 7]);
  });

  it('handles an empty starting membership', () => {
    expect(withBreakerGroup([], BREAKER_GROUP)).toEqual([7]);
  });
});

describe('unfilteredGroups', () => {
  it('is the breaker group ALONE — never an empty list', () => {
    // An empty `groups` in Pi-hole falls back to Default, which is the exact
    // opposite of "unfiltered".
    expect(unfilteredGroups(BREAKER_GROUP)).toEqual([7]);
    expect(unfilteredGroups(BREAKER_GROUP)).not.toEqual([]);
  });
});

describe('restoredGroups', () => {
  it('puts back exactly what was recorded, plus the breaker group', () => {
    // A client the user had placed in "Kids" (3) must still be in "Kids".
    expect(restoredGroups([0, 3], BREAKER_GROUP)).toEqual([0, 3, 7]);
  });

  it('falls back to Default + breaker when nothing was recorded', () => {
    expect(restoredGroups(null, BREAKER_GROUP)).toEqual([DEFAULT_GROUP_ID, 7]);
    expect(restoredGroups([], BREAKER_GROUP)).toEqual([DEFAULT_GROUP_ID, 7]);
    expect(restoredGroups(undefined, BREAKER_GROUP)).toEqual([DEFAULT_GROUP_ID, 7]);
  });

  it('refuses to "restore" to the unfiltered state', () => {
    // If the recorded membership is itself the unfiltered one — a double-trip, or
    // a record written at the wrong moment — restoring it verbatim would leave the
    // device permanently open. Default is the only safe reading.
    expect(restoredGroups([BREAKER_GROUP], BREAKER_GROUP)).toEqual([DEFAULT_GROUP_ID, 7]);
  });

  it('always leaves the breaker group present, so tab allows keep working', () => {
    expect(restoredGroups([0], BREAKER_GROUP)).toContain(BREAKER_GROUP);
  });
});

describe('isUnfiltered', () => {
  it('is true only for the breaker group alone', () => {
    expect(isUnfiltered([7], BREAKER_GROUP)).toBe(true);
    expect(isUnfiltered([7, 7], BREAKER_GROUP)).toBe(true);
    expect(isUnfiltered([0, 7], BREAKER_GROUP)).toBe(false);
    expect(isUnfiltered([0], BREAKER_GROUP)).toBe(false);
    expect(isUnfiltered([], BREAKER_GROUP)).toBe(false);
    expect(isUnfiltered([3], BREAKER_GROUP)).toBe(false);
  });
});

describe('DURATION_PRESETS', () => {
  it('offers the four documented durations, ending with "until I say"', () => {
    expect(DURATION_PRESETS.map((preset) => preset.seconds)).toEqual([600, 3600, 86400, null]);
  });
});

// ─── network scope ────────────────────────────────────────────────────────────

describe('network scope', () => {
  it('disables blocking with the chosen timer', async () => {
    const pi = new FakePihole();
    await setNetworkBlocking(pi.asClient(), false, 600);
    expect(pi.state.blocking).toEqual({ blocking: 'disabled', timer: 600 });
  });

  it('disables permanently when the duration is "until I say"', async () => {
    const pi = new FakePihole();
    await setNetworkBlocking(pi.asClient(), false, null);
    expect(pi.state.blocking).toEqual({ blocking: 'disabled', timer: null });
  });

  it('always re-enables permanently — the reset is not another scheduled change', async () => {
    const pi = new FakePihole({ blocking: { blocking: 'disabled', timer: 300 } });
    await setNetworkBlocking(pi.asClient(), true, 600);
    expect(pi.state.blocking).toEqual({ blocking: 'enabled', timer: null });
  });
});

// ─── device scope ─────────────────────────────────────────────────────────────

describe('device scope', () => {
  function piWithClient(groups: number[], comment: string | null) {
    return new FakePihole({
      groups: [
        { name: 'Default', comment: null, enabled: true, id: 0, date_added: 1, date_modified: 1 },
        {
          name: 'Breaker: laptop',
          comment: formatTag({ expires: null, scope: 'device', origin: 'aa:bb:cc:dd:ee:ff' }),
          enabled: true,
          id: BREAKER_GROUP,
          date_added: 1,
          date_modified: 1
        }
      ],
      clients: [
        {
          client: 'aa:bb:cc:dd:ee:ff',
          comment,
          groups,
          id: 5,
          date_added: 1,
          date_modified: 1
        }
      ]
    });
  }

  it('trips the breaker by moving the client into the breaker group alone', async () => {
    const pi = piWithClient([0, BREAKER_GROUP], null);
    const result = await setDeviceUnfiltered(pi.asClient(), {
      clientKey: 'aa:bb:cc:dd:ee:ff',
      breakerGroupId: BREAKER_GROUP,
      unfiltered: true,
      previousGroups: null,
      durationSeconds: 600,
      nowSeconds: NOW,
      existingComment: null
    });

    expect(result.groups).toEqual([BREAKER_GROUP]);
    expect(result.expires).toBe(NOW + 600);
    expect(pi.state.clients[0]?.groups).toEqual([BREAKER_GROUP]);
    // The deadline is written to the Pi-hole too, so the sweep can finish the job
    // even if this browser never comes back.
    expect(pi.state.clients[0]?.comment).toBe(
      `breaker v1 | expires=${NOW + 600} | scope=device | origin=aa:bb:cc:dd:ee:ff`
    );
  });

  it('resets to the recorded membership and clears the deadline', async () => {
    const pi = piWithClient([BREAKER_GROUP], formatTag({ expires: NOW, scope: 'device', origin: 'aa:bb:cc:dd:ee:ff' }));
    const result = await setDeviceUnfiltered(pi.asClient(), {
      clientKey: 'aa:bb:cc:dd:ee:ff',
      breakerGroupId: BREAKER_GROUP,
      unfiltered: false,
      previousGroups: [0, 3],
      durationSeconds: null,
      nowSeconds: NOW,
      existingComment: null
    });

    expect(result.groups).toEqual([0, 3, BREAKER_GROUP]);
    expect(result.expires).toBeNull();
    expect(pi.state.clients[0]?.comment).toContain('expires=never');
  });

  it('leaves a user-written comment on their own client entry alone', async () => {
    const pi = piWithClient([0, BREAKER_GROUP], "Owen's laptop");
    await setDeviceUnfiltered(pi.asClient(), {
      clientKey: 'aa:bb:cc:dd:ee:ff',
      breakerGroupId: BREAKER_GROUP,
      unfiltered: true,
      previousGroups: null,
      durationSeconds: 600,
      nowSeconds: NOW,
      existingComment: "Owen's laptop"
    });
    expect(pi.state.clients[0]?.comment).toBe("Owen's laptop");
    // The membership change still happened — only the note was preserved.
    expect(pi.state.clients[0]?.groups).toEqual([BREAKER_GROUP]);
  });
});

// ─── tab scope ────────────────────────────────────────────────────────────────

describe('tab scope', () => {
  it('adds allow entries scoped to the breaker group only', async () => {
    const pi = new FakePihole();
    const result = await allowHosts(pi.asClient(), {
      hosts: ['ads.example.com', 'cdn.example.net'],
      breakerGroupId: BREAKER_GROUP,
      origin: 'news.example.com',
      durationSeconds: 600,
      nowSeconds: NOW
    });

    expect(result.added.sort()).toEqual(['ads.example.com', 'cdn.example.net']);
    expect(pi.state.domains).toHaveLength(2);
    for (const domain of pi.state.domains) {
      expect(domain.type).toBe('allow');
      expect(domain.kind).toBe('exact');
      // Scoped to the breaker group ALONE: the rest of the house stays filtered.
      expect(domain.groups).toEqual([BREAKER_GROUP]);
      expect(domain.comment).toBe(
        `breaker v1 | expires=${NOW + 600} | scope=tab | origin=news.example.com`
      );
    }
  });

  it('de-duplicates and lowercases the requested hosts', async () => {
    const pi = new FakePihole();
    const result = await allowHosts(pi.asClient(), {
      hosts: ['Ads.Example.com', 'ads.example.com', ' ads.example.com '],
      breakerGroupId: BREAKER_GROUP,
      origin: 'x.example',
      durationSeconds: null,
      nowSeconds: NOW
    });
    expect(result.added).toEqual(['ads.example.com']);
    expect(pi.state.domains).toHaveLength(1);
  });

  it('extends its own grant rather than failing on "already present"', async () => {
    const pi = new FakePihole();
    await allowHosts(pi.asClient(), {
      hosts: ['ads.example.com'],
      breakerGroupId: BREAKER_GROUP,
      origin: 'news.example.com',
      durationSeconds: 600,
      nowSeconds: NOW
    });

    const result = await allowHosts(pi.asClient(), {
      hosts: ['ads.example.com'],
      breakerGroupId: BREAKER_GROUP,
      origin: 'other.example.com',
      durationSeconds: 3600,
      nowSeconds: NOW + 60
    });

    expect(result.added).toEqual([]);
    expect(result.extended).toEqual(['ads.example.com']);
    expect(pi.state.domains).toHaveLength(1);
    expect(pi.state.domains[0]?.comment).toContain(`expires=${NOW + 60 + 3600}`);
  });

  it('never touches an allow entry the user made themselves', async () => {
    const pi = new FakePihole({
      domains: [
        {
          domain: 'ads.example.com',
          type: 'allow',
          kind: 'exact',
          comment: 'needed for work',
          groups: [0],
          enabled: true,
          id: 1,
          date_added: 1,
          date_modified: 1
        }
      ]
    });

    const result = await allowHosts(pi.asClient(), {
      hosts: ['ads.example.com'],
      breakerGroupId: BREAKER_GROUP,
      origin: 'news.example.com',
      durationSeconds: 600,
      nowSeconds: NOW
    });

    expect(result.added).toEqual([]);
    expect(result.extended).toEqual([]);
    expect(result.skipped[0]?.domain).toBe('ads.example.com');
    expect(result.skipped[0]?.why).toMatch(/not managed by Breaker/);
    // Untouched: same comment, same groups. It already allows the domain anyway.
    expect(pi.state.domains[0]?.comment).toBe('needed for work');
    expect(pi.state.domains[0]?.groups).toEqual([0]);
  });

  it('rejects a hostname that is not one, before it reaches Pi-hole', async () => {
    const pi = new FakePihole();
    const result = await allowHosts(pi.asClient(), {
      hosts: ['not a host', '.leading.dot', 'trailing.dot.', 'localhost'],
      breakerGroupId: BREAKER_GROUP,
      origin: 'x.example',
      durationSeconds: null,
      nowSeconds: NOW
    });
    expect(result.added).toEqual([]);
    expect(result.skipped).toHaveLength(4);
    expect(pi.state.domains).toHaveLength(0);
  });

  it('does nothing at all for an empty host list', async () => {
    const pi = new FakePihole();
    const result = await allowHosts(pi.asClient(), {
      hosts: [],
      breakerGroupId: BREAKER_GROUP,
      origin: 'x.example',
      durationSeconds: null,
      nowSeconds: NOW
    });
    expect(result).toEqual({ added: [], extended: [], skipped: [] });
  });

  it('lists only its own tab grants', async () => {
    const pi = new FakePihole({
      domains: [
        makeDomain('mine.example', formatTag({ expires: NOW + 60, scope: 'tab', origin: 'a' })),
        makeDomain('theirs.example', 'hand written'),
        makeDomain('device.example', formatTag({ expires: null, scope: 'device', origin: 'b' }))
      ]
    });

    const grants = await listBreakerAllows(pi.asClient());
    expect(grants.map((grant) => grant.domain)).toEqual(['mine.example']);
  });

  it('revokes its own grant and refuses to delete anyone else\'s entry', async () => {
    const pi = new FakePihole({
      domains: [
        makeDomain('mine.example', formatTag({ expires: NOW + 60, scope: 'tab', origin: 'a' })),
        makeDomain('theirs.example', 'hand written')
      ]
    });

    await expect(revokeAllow(pi.asClient(), 'mine.example')).resolves.toBe(true);
    await expect(revokeAllow(pi.asClient(), 'theirs.example')).resolves.toBe(false);
    await expect(revokeAllow(pi.asClient(), 'absent.example')).resolves.toBe(false);

    expect(pi.state.domains.map((domain) => domain.domain)).toEqual(['theirs.example']);
  });
});

// ─── sweeps ───────────────────────────────────────────────────────────────────

function makeDomain(name: string, comment: string | null): Domain {
  return {
    domain: name,
    type: 'allow',
    kind: 'exact',
    comment,
    groups: [BREAKER_GROUP],
    enabled: true,
    id: 1,
    date_added: 1,
    date_modified: 1
  };
}

describe('expiredAllowDomains', () => {
  it('picks exactly the tab grants past their deadline', () => {
    const domains = [
      makeDomain('expired.example', formatTag({ expires: NOW - 1, scope: 'tab', origin: 'a' })),
      makeDomain('due-now.example', formatTag({ expires: NOW, scope: 'tab', origin: 'a' })),
      makeDomain('live.example', formatTag({ expires: NOW + 60, scope: 'tab', origin: 'a' })),
      makeDomain('forever.example', formatTag({ expires: null, scope: 'tab', origin: 'a' })),
      makeDomain('theirs.example', 'hand written'),
      makeDomain('other-scope.example', formatTag({ expires: NOW - 1, scope: 'device', origin: 'a' }))
    ];

    expect(expiredAllowDomains(domains, NOW)).toEqual(['expired.example', 'due-now.example']);
  });
});

describe('sweepExpiredAllows', () => {
  it('deletes expired grants and leaves everything else standing', async () => {
    const pi = new FakePihole({
      domains: [
        makeDomain('expired.example', formatTag({ expires: NOW - 1, scope: 'tab', origin: 'a' })),
        makeDomain('live.example', formatTag({ expires: NOW + 600, scope: 'tab', origin: 'a' })),
        makeDomain('theirs.example', 'hand written')
      ]
    });

    const removed = await sweepExpiredAllows(pi.asClient(), NOW);

    expect(removed).toEqual(['expired.example']);
    expect(pi.state.domains.map((domain) => domain.domain)).toEqual([
      'live.example',
      'theirs.example'
    ]);
  });
});

describe('sweepExpiredDeviceGrants', () => {
  function piWithExpiredDevice(clientGroups: number[], expires: number) {
    return new FakePihole({
      groups: [
        { name: 'Default', comment: null, enabled: true, id: 0, date_added: 1, date_modified: 1 },
        {
          name: 'Breaker: laptop',
          comment: formatTag({ expires: null, scope: 'device', origin: 'aa:bb:cc:dd:ee:ff' }),
          enabled: true,
          id: BREAKER_GROUP,
          date_added: 1,
          date_modified: 1
        }
      ],
      clients: [
        {
          client: 'aa:bb:cc:dd:ee:ff',
          comment: formatTag({ expires, scope: 'device', origin: 'aa:bb:cc:dd:ee:ff' }),
          groups: clientGroups,
          id: 5,
          date_added: 1,
          date_modified: 1
        }
      ]
    });
  }

  // The browser-was-closed case: no alarm ever fired, and the only surviving
  // record of the deadline is the comment on the Pi-hole.
  it('restores a device whose window closed while the browser was shut', async () => {
    const pi = piWithExpiredDevice([BREAKER_GROUP], NOW - 1);
    const restored = await sweepExpiredDeviceGrants(pi.asClient(), NOW, () => null);

    expect(restored).toEqual(['aa:bb:cc:dd:ee:ff']);
    expect(pi.state.clients[0]?.groups).toEqual([DEFAULT_GROUP_ID, BREAKER_GROUP]);
    expect(pi.state.clients[0]?.comment).toContain('expires=never');
  });

  it('uses the recorded previous membership when there is one', async () => {
    const pi = piWithExpiredDevice([BREAKER_GROUP], NOW - 1);
    await sweepExpiredDeviceGrants(pi.asClient(), NOW, () => [0, 3]);
    expect(pi.state.clients[0]?.groups).toEqual([0, 3, BREAKER_GROUP]);
  });

  it('leaves a device whose window is still open', async () => {
    const pi = piWithExpiredDevice([BREAKER_GROUP], NOW + 600);
    await expect(sweepExpiredDeviceGrants(pi.asClient(), NOW, () => null)).resolves.toEqual([]);
    expect(pi.state.clients[0]?.groups).toEqual([BREAKER_GROUP]);
  });

  it('does not touch a device that is already filtered', async () => {
    // Expired tag, but the membership says filtered — someone restored it by hand.
    const pi = piWithExpiredDevice([0, BREAKER_GROUP], NOW - 1);
    await expect(sweepExpiredDeviceGrants(pi.asClient(), NOW, () => null)).resolves.toEqual([]);
  });
});

// ─── cross-check ──────────────────────────────────────────────────────────────

describe('crossCheck', () => {
  it('separates what Pi-hole blocked from what it merely saw', () => {
    const result = crossCheck(
      ['ads.example.com', 'api.example.com', 'never.example.com'],
      [query('ads.example.com', 'GRAVITY'), query('api.example.com', 'FORWARDED')]
    );

    expect(result.verdicts.get('ads.example.com')).toBe('blocked');
    expect(result.verdicts.get('api.example.com')).toBe('allowed');
    expect(result.verdicts.get('never.example.com')).toBe('unseen');
    expect(result.noQueriesSeen).toBe(false);
  });

  it.each(['GRAVITY', 'REGEX', 'DENYLIST', 'GRAVITY_CNAME', 'EXTERNAL_BLOCKED_NULL', 'SPECIAL_DOMAIN'])(
    'counts %s as blocked',
    (status) => {
      const result = crossCheck(['x.example'], [query('x.example', status)]);
      expect(result.verdicts.get('x.example')).toBe('blocked');
    }
  );

  it.each(['FORWARDED', 'CACHE', 'CACHE_STALE', 'RETRIED', 'IN_PROGRESS'])(
    'counts %s as answered normally',
    (status) => {
      const result = crossCheck(['x.example'], [query('x.example', status)]);
      expect(result.verdicts.get('x.example')).toBe('allowed');
    }
  );

  it('treats any blocked answer for a name as blocked', () => {
    // A reload commonly yields both a blocked A and a cached second answer.
    const result = crossCheck(
      ['x.example'],
      [query('x.example', 'CACHE'), query('x.example', 'GRAVITY')]
    );
    expect(result.verdicts.get('x.example')).toBe('blocked');
  });

  it('matches case-insensitively and ignores a trailing dot', () => {
    const result = crossCheck(['Ads.Example.com'], [query('ads.example.com.', 'GRAVITY')]);
    expect(result.verdicts.get('ads.example.com')).toBe('blocked');
  });

  it('flags an empty query log — the DoH / VPN bypass signal', () => {
    const result = crossCheck(['ads.example.com'], []);
    expect(result.noQueriesSeen).toBe(true);
    expect(result.verdicts.get('ads.example.com')).toBe('unseen');
  });
});

// ─── domainsToGrants ──────────────────────────────────────────────────────────

describe('domainsToGrants', () => {
  it('sorts alphabetically so the popup list is stable', () => {
    const grants = domainsToGrants([
      makeDomain('z.example', formatTag({ expires: NOW, scope: 'tab', origin: 'a' })),
      makeDomain('a.example', formatTag({ expires: NOW, scope: 'tab', origin: 'a' }))
    ]);
    expect(grants.map((grant) => grant.domain)).toEqual(['a.example', 'z.example']);
  });
});
