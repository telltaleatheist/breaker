import { describe, expect, it } from 'vitest';

import {
  classify,
  ledgerList,
  recordHit,
  REASON_LABELS,
  type TabLedger
} from '../src/core/blocked-detect';

describe('classify', () => {
  it('reads Pi-hole\'s default NULL blocking as the strongest signal', () => {
    // Blocking mode NULL answers 0.0.0.0, and Chrome refuses to connect to it.
    expect(classify('net::ERR_ADDRESS_INVALID', 'https://ads.example.com/tag.js')).toEqual({
      host: 'ads.example.com',
      reason: 'null-ip'
    });
  });

  it.each([
    ['net::ERR_NAME_NOT_RESOLVED', 'nxdomain'],
    ['net::ERR_NAME_RESOLUTION_FAILED', 'nxdomain'],
    ['net::ERR_CONNECTION_REFUSED', 'refused'],
    ['net::ERR_ADDRESS_UNREACHABLE', 'unreachable']
  ])('maps %s to %s', (error, reason) => {
    expect(classify(error, 'https://ads.example.com/x')?.reason).toBe(reason);
  });

  it('accepts the error code with or without the net:: prefix', () => {
    expect(classify('ERR_ADDRESS_INVALID', 'https://a.example/x')?.reason).toBe('null-ip');
  });

  it('lowercases the host so the ledger does not hold two of the same', () => {
    expect(classify('net::ERR_ADDRESS_INVALID', 'https://Ads.Example.COM/x')?.host).toBe(
      'ads.example.com'
    );
  });

  it.each([
    ['net::ERR_ABORTED', 'the user navigated away'],
    ['net::ERR_BLOCKED_BY_CLIENT', 'another content blocker'],
    ['net::ERR_CONNECTION_TIMED_OUT', 'a slow server'],
    ['net::ERR_FAILED', 'anything at all'],
    ['net::ERR_CERT_AUTHORITY_INVALID', 'a TLS problem']
  ])('ignores %s (%s)', (error) => {
    expect(classify(error, 'https://ads.example.com/x')).toBeNull();
  });

  it('ignores schemes that have no DNS to allow', () => {
    expect(classify('net::ERR_ADDRESS_INVALID', 'chrome-extension://abc/page.html')).toBeNull();
    expect(classify('net::ERR_ADDRESS_INVALID', 'data:text/plain,hello')).toBeNull();
    expect(classify('net::ERR_ADDRESS_INVALID', 'file:///tmp/x.html')).toBeNull();
  });

  it('ignores IP literals — an address cannot have been DNS-blocked', () => {
    expect(classify('net::ERR_ADDRESS_INVALID', 'https://192.168.68.85/x')).toBeNull();
    expect(classify('net::ERR_ADDRESS_INVALID', 'https://[2001:db8::1]/x')).toBeNull();
  });

  it('ignores loopback and mDNS names, which never reach Pi-hole', () => {
    expect(classify('net::ERR_CONNECTION_REFUSED', 'http://localhost:3000/x')).toBeNull();
    expect(classify('net::ERR_NAME_NOT_RESOLVED', 'http://printer.local/x')).toBeNull();
  });

  it('ignores a malformed URL rather than throwing', () => {
    expect(classify('net::ERR_ADDRESS_INVALID', 'not a url')).toBeNull();
  });

  it('has a label for every reason it can produce', () => {
    for (const reason of ['null-ip', 'nxdomain', 'refused', 'unreachable'] as const) {
      expect(REASON_LABELS[reason]).toBeTruthy();
    }
  });
});

describe('the per-tab ledger', () => {
  it('counts repeats of one host into a single entry', () => {
    const ledger: TabLedger = new Map();
    recordHit(ledger, { host: 'ads.example.com', reason: 'null-ip' }, 1000);
    recordHit(ledger, { host: 'ads.example.com', reason: 'null-ip' }, 1500);
    recordHit(ledger, { host: 'ads.example.com', reason: 'null-ip' }, 2000);

    expect(ledger.size).toBe(1);
    const entry = ledger.get('ads.example.com')!;
    expect(entry.count).toBe(3);
    expect(entry.firstSeen).toBe(1000);
    expect(entry.lastSeen).toBe(2000);
    expect(entry.verdict).toBe('unchecked');
  });

  it('takes the most recent reason, so a blocking-mode change is reflected', () => {
    const ledger: TabLedger = new Map();
    recordHit(ledger, { host: 'ads.example.com', reason: 'nxdomain' }, 1000);
    recordHit(ledger, { host: 'ads.example.com', reason: 'null-ip' }, 2000);
    expect(ledger.get('ads.example.com')?.reason).toBe('null-ip');
  });

  it('sorts busiest first, then alphabetically, so the list does not shuffle', () => {
    const ledger: TabLedger = new Map();
    recordHit(ledger, { host: 'b.example', reason: 'null-ip' }, 1);
    recordHit(ledger, { host: 'a.example', reason: 'null-ip' }, 1);
    recordHit(ledger, { host: 'busy.example', reason: 'null-ip' }, 1);
    recordHit(ledger, { host: 'busy.example', reason: 'null-ip' }, 2);

    expect(ledgerList(ledger).map((entry) => entry.host)).toEqual([
      'busy.example',
      'a.example',
      'b.example'
    ]);
  });

  it('is empty for an empty ledger', () => {
    expect(ledgerList(new Map())).toEqual([]);
  });
});
