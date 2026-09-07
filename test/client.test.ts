import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  normalizeBaseUrl,
  PiholeAuthError,
  PiholeClient,
  PiholeError,
  PiholeHttpError,
  PiholeNetworkError,
  type StoredSession
} from '../src/api/client';

// ─── a scriptable fetch ───────────────────────────────────────────────────────

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Responder = (call: Call) => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

/** A fetch stub that records calls and answers from a queue of responders. */
function stubFetch(responders: Responder[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    };
    calls.push(call);
    const responder = responders[index];
    if (!responder) throw new Error(`unexpected extra request: ${call.method} ${call.url}`);
    index += 1;
    return responder(call);
  }) as typeof fetch;
  return { fetch: impl, calls };
}

const LOGIN_OK: Responder = () =>
  json({
    session: {
      valid: true,
      totp: false,
      sid: 'SID-1',
      csrf: 'CSRF-1',
      validity: 1800,
      message: 'correct password'
    }
  });

function makeClient(
  responders: Responder[],
  overrides: Partial<ConstructorParameters<typeof PiholeClient>[0]> = {}
) {
  const stub = stubFetch(responders);
  const client = new PiholeClient({
    baseUrl: 'http://pi.hole',
    password: 'hunter2',
    fetchImpl: stub.fetch,
    now: () => 1_000_000,
    ...overrides
  });
  return { client, calls: stub.calls };
}

// ─── URL normalisation ────────────────────────────────────────────────────────

describe('normalizeBaseUrl', () => {
  it.each([
    ['http://pi.hole', 'http://pi.hole'],
    ['pi.hole', 'http://pi.hole'],
    ['http://pi.hole/', 'http://pi.hole'],
    ['http://pi.hole/api', 'http://pi.hole'],
    ['http://pi.hole/api/', 'http://pi.hole'],
    ['http://pi.hole/admin', 'http://pi.hole'],
    ['http://192.168.68.85/admin/settings/api', 'http://192.168.68.85'],
    ['https://pi.hole:8443', 'https://pi.hole:8443'],
    ['  http://192.168.68.85:8080  ', 'http://192.168.68.85:8080']
  ])('normalises %s to %s', (input, expected) => {
    expect(normalizeBaseUrl(input)).toBe(expected);
  });

  it('refuses an empty address', () => {
    expect(() => normalizeBaseUrl('   ')).toThrow(PiholeError);
  });

  it('refuses a non-http scheme rather than guessing', () => {
    expect(() => normalizeBaseUrl('ftp://pi.hole')).toThrow(/http/);
  });
});

// ─── authentication ───────────────────────────────────────────────────────────

describe('authentication', () => {
  it('logs in once and sends the sid header on subsequent calls', async () => {
    const { client, calls } = makeClient([
      LOGIN_OK,
      () => json({ blocking: 'enabled', timer: null }),
      () => json({ blocking: 'enabled', timer: null })
    ]);

    await client.getBlocking();
    await client.getBlocking();

    expect(calls).toHaveLength(3);
    expect(calls[0]?.url).toBe('http://pi.hole/api/auth');
    expect(calls[0]?.method).toBe('POST');
    // The header name is literally `sid` — see main.yaml's header_sid scheme.
    expect(calls[1]?.headers['sid']).toBe('SID-1');
    expect(calls[2]?.headers['sid']).toBe('SID-1');
  });

  it('never puts the password anywhere but the login body', async () => {
    const { client, calls } = makeClient([LOGIN_OK, () => json({ blocking: 'enabled', timer: null })]);
    await client.getBlocking();

    expect(calls[0]?.body).toEqual({ password: 'hunter2' });
    expect(calls[1]?.url).not.toContain('hunter2');
    expect(JSON.stringify(calls[1]?.headers)).not.toContain('hunter2');
  });

  it('reports the session through onSession so it can be persisted', async () => {
    const onSession = vi.fn();
    const { client } = makeClient([LOGIN_OK, () => json({ blocking: 'enabled', timer: null })], {
      onSession
    });
    await client.getBlocking();

    expect(onSession).toHaveBeenCalledTimes(1);
    const stored = onSession.mock.calls[0]?.[0] as StoredSession;
    expect(stored.sid).toBe('SID-1');
    // validity 1800s, minus the 30s safety shave, from the injected clock.
    expect(stored.expiresAt).toBe(1_000_000 + 1770 * 1000);
  });

  it('reuses a session handed in from storage without logging in again', async () => {
    const { client, calls } = makeClient([() => json({ blocking: 'enabled', timer: null })], {
      session: { sid: 'SID-RESTORED', csrf: null, expiresAt: 2_000_000 }
    });

    await client.getBlocking();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers['sid']).toBe('SID-RESTORED');
  });

  it('logs in again when the restored session has already expired', async () => {
    const { client, calls } = makeClient([LOGIN_OK, () => json({ blocking: 'enabled', timer: null })], {
      session: { sid: 'SID-STALE', csrf: null, expiresAt: 999 }
    });

    await client.getBlocking();

    expect(calls[0]?.url).toContain('/auth');
    expect(calls[1]?.headers['sid']).toBe('SID-1');
  });

  it('does not mint several sessions for concurrent requests', async () => {
    const { client, calls } = makeClient([
      LOGIN_OK,
      () => json({ blocking: 'enabled', timer: null }),
      () => json({ groups: [] })
    ]);

    await Promise.all([client.getBlocking(), client.getGroups()]);

    const logins = calls.filter((call) => call.url.endsWith('/api/auth'));
    expect(logins).toHaveLength(1);
  });

  it('surfaces a rejected password verbatim', async () => {
    const { client } = makeClient([
      () =>
        json(
          {
            session: {
              valid: false,
              totp: false,
              sid: null,
              csrf: null,
              validity: -1,
              message: 'password incorrect'
            }
          },
          401
        )
    ]);

    // Pi-hole's own wording reaches the user; we do not replace it with a
    // friendlier lie about what went wrong.
    await expect(client.getBlocking()).rejects.toThrowError(
      expect.objectContaining({
        name: 'PiholeAuthError',
        message: expect.stringContaining('password incorrect')
      })
    );
  });

  it('points a 2FA Pi-hole at app passwords', async () => {
    const { client } = makeClient([
      () =>
        json(
          {
            session: {
              valid: false,
              totp: true,
              sid: null,
              csrf: null,
              validity: -1,
              message: 'no password or TOTP token supplied'
            }
          },
          401
        )
    ]);

    let thrown: unknown;
    try {
      await client.getBlocking();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PiholeAuthError);
    expect((thrown as PiholeAuthError).totpRequired).toBe(true);
    expect((thrown as PiholeAuthError).message).toMatch(/app password/i);
  });

  it('names the session-seat limit rather than showing a bare 429', async () => {
    const { client } = makeClient([
      () => json({ error: { key: 'no_seats', message: 'no more seats', hint: null } }, 429)
    ]);
    await expect(client.getBlocking()).rejects.toThrow(/seats/i);
  });

  it('handles a Pi-hole with no password at all (sid: null)', async () => {
    const { client, calls } = makeClient([
      () =>
        json({
          session: {
            valid: true,
            totp: false,
            sid: null,
            csrf: null,
            validity: -1,
            message: 'no auth for local user'
          }
        }),
      () => json({ blocking: 'enabled', timer: null })
    ]);

    await expect(client.getBlocking()).resolves.toEqual({ blocking: 'enabled', timer: null });
    expect(calls[1]?.headers['sid']).toBeUndefined();
  });
});

// ─── the single 401 retry ─────────────────────────────────────────────────────

describe('401 handling', () => {
  it('re-authenticates exactly once and retries the request', async () => {
    const { client, calls } = makeClient([
      LOGIN_OK,
      () => json({ error: { key: 'unauthorized', message: 'Unauthorized', hint: null } }, 401),
      () =>
        json({
          session: {
            valid: true,
            totp: false,
            sid: 'SID-2',
            csrf: null,
            validity: 1800,
            message: 'correct password'
          }
        }),
      () => json({ blocking: 'disabled', timer: 42 })
    ]);

    const result = await client.getBlocking();

    expect(result).toEqual({ blocking: 'disabled', timer: 42 });
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'POST /api/auth',
      'GET /api/dns/blocking',
      'POST /api/auth',
      'GET /api/dns/blocking'
    ]);
    // The retry carries the NEW sid, not the dead one.
    expect(calls[3]?.headers['sid']).toBe('SID-2');
  });

  it('gives up after one retry instead of hammering the login endpoint', async () => {
    const unauthorized: Responder = () =>
      json({ error: { key: 'unauthorized', message: 'Unauthorized', hint: null } }, 401);
    const { client, calls } = makeClient([LOGIN_OK, unauthorized, LOGIN_OK, unauthorized]);

    await expect(client.getBlocking()).rejects.toThrow(PiholeAuthError);
    // Two logins and two attempts — and no third. Looping here is how a wrong
    // password turns into an FTL rate-limit lockout.
    expect(calls).toHaveLength(4);
  });
});

// ─── error surfacing ──────────────────────────────────────────────────────────

describe('errors', () => {
  it('carries FTL key, hint and status on an HTTP failure', async () => {
    const { client } = makeClient([
      LOGIN_OK,
      () =>
        json(
          {
            error: {
              key: 'database_error',
              message: 'Could not add domain',
              hint: 'The item is already present'
            }
          },
          400
        )
    ]);

    let thrown: unknown;
    try {
      await client.addDomain('allow', 'exact', {
        domain: 'ads.example',
        comment: null,
        groups: [1],
        enabled: true
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PiholeHttpError);
    const error = thrown as PiholeHttpError;
    expect(error.status).toBe(400);
    expect(error.key).toBe('database_error');
    expect(error.hint).toBe('The item is already present');
    expect(error.message).toContain('Could not add domain');
    expect(error.message).toContain('The item is already present');
  });

  it('distinguishes "cannot reach the Pi-hole" from "the Pi-hole said no"', async () => {
    const { client } = makeClient([
      () => {
        throw new TypeError('Failed to fetch');
      }
    ]);

    let thrown: unknown;
    try {
      await client.getClientInfo();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PiholeNetworkError);
    expect((thrown as PiholeNetworkError).message).toContain('http://pi.hole');
    expect((thrown as PiholeNetworkError).cause).toBeInstanceOf(TypeError);
  });

  it('reports a non-JSON body as such instead of throwing a SyntaxError', async () => {
    const { client } = makeClient([
      LOGIN_OK,
      () => new Response('<html>gateway timeout</html>', { status: 200 })
    ]);
    await expect(client.getBlocking()).rejects.toThrow(/non-JSON/);
  });
});

// ─── endpoint shapes ──────────────────────────────────────────────────────────

describe('endpoints', () => {
  let calls: Call[];
  let client: PiholeClient;

  beforeEach(() => {
    const made = makeClient([
      LOGIN_OK,
      () => json({ blocking: 'disabled', timer: 600 }),
      () => new Response(null, { status: 204 }),
      () => json({ queries: [], cursor: 0, recordsTotal: 0, recordsFiltered: 0 }),
      () => json({ devices: [] }),
      () => json({ config: { dns: { blockTTL: 2 } } })
    ]);
    client = made.client;
    calls = made.calls;
  });

  it('posts a blocking change with the timer in seconds', async () => {
    await client.setBlocking(false, 600);
    expect(calls[1]?.method).toBe('POST');
    expect(calls[1]?.body).toEqual({ blocking: false, timer: 600 });
  });

  it('treats 204 No Content as success for a delete', async () => {
    await client.setBlocking(false, 600);
    await expect(client.deleteDomain('allow', 'exact', 'ads.example')).resolves.toBeUndefined();
    expect(calls[2]?.method).toBe('DELETE');
    expect(calls[2]?.url).toBe('http://pi.hole/api/domains/allow/exact/ads.example');
  });

  it('builds the queries query string from the given filters only', async () => {
    await client.setBlocking(false, 600);
    await client.deleteDomain('allow', 'exact', 'ads.example');
    await client.getQueries({ from: 1_700_000_000, client_ip: '192.168.68.79', length: 500 });

    const url = new URL(calls[3]!.url);
    expect(url.pathname).toBe('/api/queries');
    expect(url.searchParams.get('from')).toBe('1700000000');
    expect(url.searchParams.get('client_ip')).toBe('192.168.68.79');
    expect(url.searchParams.get('length')).toBe('500');
    // Absent filters must not be sent as the string "undefined".
    expect(url.searchParams.has('domain')).toBe(false);
    expect(url.searchParams.has('until')).toBe(false);
  });

  it('asks for the whole device table, not the default first ten', async () => {
    await client.setBlocking(false, 600);
    await client.deleteDomain('allow', 'exact', 'ads.example');
    await client.getQueries({});
    await client.getNetworkDevices();

    const url = new URL(calls[4]!.url);
    expect(url.searchParams.get('max_devices')).toBe('999');
    expect(url.searchParams.get('max_addresses')).toBe('25');
  });

  it('unwraps the nested config tree for blockTTL', async () => {
    await client.setBlocking(false, 600);
    await client.deleteDomain('allow', 'exact', 'ads.example');
    await client.getQueries({});
    await client.getNetworkDevices();
    await expect(client.getBlockTtl()).resolves.toBe(2);
  });
});

describe('url encoding', () => {
  it('encodes a domain that would otherwise break the path', async () => {
    const { client, calls } = makeClient([LOGIN_OK, () => new Response(null, { status: 204 })]);
    await client.deleteDomain('deny', 'regex', '^ads\\..*\\.example$');
    expect(calls[1]?.url).toBe(
      'http://pi.hole/api/domains/deny/regex/%5Eads%5C..*%5C.example%24'
    );
  });

  it('encodes a MAC client key', async () => {
    const { client, calls } = makeClient([LOGIN_OK, () => json({ clients: [] })]);
    await client.updateClient('14:c6:7d:5d:48:11', { comment: null, groups: [0] });
    expect(calls[1]?.url).toBe('http://pi.hole/api/clients/14%3Ac6%3A7d%3A5d%3A48%3A11');
  });
});

describe('logout', () => {
  it('deletes the session and clears it locally', async () => {
    const onSession = vi.fn();
    const { client, calls } = makeClient(
      [LOGIN_OK, () => json({ blocking: 'enabled', timer: null }), () => new Response(null, { status: 204 })],
      { onSession }
    );

    await client.getBlocking();
    await client.logout();

    expect(calls[2]?.method).toBe('DELETE');
    expect(calls[2]?.headers['sid']).toBe('SID-1');
    expect(client.getSession()).toBeNull();
    expect(onSession).toHaveBeenLastCalledWith(null);
  });

  it('accepts a 404 (no session active) as already logged out', async () => {
    const { client } = makeClient([LOGIN_OK, () => new Response(null, { status: 404 })], {
      session: { sid: 'SID-X', csrf: null, expiresAt: 2_000_000 }
    });
    await expect(client.logout()).resolves.toBeUndefined();
  });
});

describe('version gate', () => {
  it('reads the core version and accepts v6', async () => {
    const { client } = makeClient([
      LOGIN_OK,
      () =>
        json({
          version: {
            core: { local: { branch: 'master', version: 'v6.4.3', hash: 'abc' }, remote: { version: 'v6.4.3', hash: 'abc' } },
            web: { local: { version: 'v6.4' }, remote: { version: 'v6.4' } },
            ftl: { local: { version: 'v6.7' }, remote: { version: 'v6.7' } }
          }
        })
    ]);

    await expect(client.requireSupportedVersion()).resolves.toMatchObject({ major: 6, minor: 4 });
  });

  it('refuses a v5 Pi-hole by name', async () => {
    const { client } = makeClient([
      LOGIN_OK,
      () =>
        json({
          version: {
            core: { local: { version: 'v5.17.3' }, remote: { version: 'v5.17.3' } },
            web: { local: { version: 'v5.21' }, remote: { version: 'v5.21' } },
            ftl: { local: { version: 'v5.25' }, remote: { version: 'v5.25' } }
          }
        })
    ]);

    await expect(client.requireSupportedVersion()).rejects.toThrow(/v5\.17\.3/);
  });
});
