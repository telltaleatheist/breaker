import { describe, expect, it } from 'vitest';

import {
  deviceGroupName,
  ensureDevice,
  findDeviceByIp,
  hostnameForIp,
  identityFor,
  readDevice,
  resolveIdentity,
  sameClientKey
} from '../src/core/device';
import { formatTag, parseTag } from '../src/core/tags';
import { device, FakePihole } from './fake-pihole';

const MAC = 'aa:bb:cc:dd:ee:ff';
const IP = '192.168.68.79';

describe('findDeviceByIp', () => {
  it('finds the device holding the address', () => {
    const devices = [
      device('11:11:11:11:11:11', [{ ip: '192.168.68.10' }]),
      device(MAC, [{ ip: '192.168.68.79', name: 'laptop' }, { ip: 'fe80::1' }])
    ];
    expect(findDeviceByIp(devices, IP)?.hwaddr).toBe(MAC);
  });

  it('returns null when Pi-hole has no record of the address', () => {
    expect(findDeviceByIp([device(MAC, [{ ip: '10.0.0.1' }])], IP)).toBeNull();
    expect(findDeviceByIp([], IP)).toBeNull();
  });
});

describe('hostnameForIp', () => {
  it('reads the hostname attached to that specific address', () => {
    const dev = device(MAC, [
      { ip: '192.168.68.79', name: 'laptop' },
      { ip: 'fe80::1', name: 'laptop6' }
    ]);
    expect(hostnameForIp(dev, IP)).toBe('laptop');
    expect(hostnameForIp(dev, 'fe80::1')).toBe('laptop6');
  });

  it('is null for an unnamed address or no device', () => {
    expect(hostnameForIp(device(MAC, [{ ip: IP }]), IP)).toBeNull();
    expect(hostnameForIp(null, IP)).toBeNull();
  });
});

describe('identityFor', () => {
  it('prefers the MAC as the client key — DHCP leases move, MACs do not', () => {
    const identity = identityFor(IP, device(MAC, [{ ip: IP, name: 'laptop' }]));
    expect(identity).toEqual({
      ip: IP,
      hwaddr: MAC,
      hostname: 'laptop',
      clientKey: MAC,
      keyedBy: 'mac'
    });
  });

  it('falls back to the IP when Pi-hole has no ARP record for us', () => {
    const identity = identityFor(IP, null);
    expect(identity.clientKey).toBe(IP);
    expect(identity.keyedBy).toBe('ip');
    expect(identity.hwaddr).toBeNull();
  });

  it('rejects Pi-hole\'s "ip-…" placeholder hwaddr, which is not a MAC', () => {
    // FTL invents these for devices it has never seen an ARP entry for. Treating
    // one as a durable key would key the client entry on a synthetic string.
    const identity = identityFor(IP, device(`ip-${IP}`, [{ ip: IP }]));
    expect(identity.hwaddr).toBeNull();
    expect(identity.clientKey).toBe(IP);
    expect(identity.keyedBy).toBe('ip');
  });

  it('accepts an uppercase MAC', () => {
    expect(identityFor(IP, device('AA:BB:CC:DD:EE:FF', [{ ip: IP }])).keyedBy).toBe('mac');
  });
});

describe('sameClientKey', () => {
  it('compares MACs case-insensitively', () => {
    expect(sameClientKey('AA:BB:CC:DD:EE:FF', 'aa:bb:cc:dd:ee:ff')).toBe(true);
    expect(sameClientKey(' aa:bb:cc:dd:ee:ff ', 'aa:bb:cc:dd:ee:ff')).toBe(true);
    expect(sameClientKey('aa:bb:cc:dd:ee:ff', '192.168.68.79')).toBe(false);
  });
});

describe('deviceGroupName', () => {
  it('names the group after the hostname when there is one', () => {
    expect(deviceGroupName(identityFor(IP, device(MAC, [{ ip: IP, name: 'laptop' }])))).toBe(
      'Breaker: laptop'
    );
  });

  it('falls back to the IP', () => {
    expect(deviceGroupName(identityFor(IP, null))).toBe(`Breaker: ${IP}`);
  });
});

describe('resolveIdentity', () => {
  it('creates nothing on the Pi-hole', async () => {
    const pi = new FakePihole({ devices: [device(MAC, [{ ip: IP, name: 'laptop' }])] });
    const identity = await resolveIdentity(pi.asClient());

    expect(identity.clientKey).toBe(MAC);
    expect(pi.state.groups).toHaveLength(1); // Default only
    expect(pi.state.clients).toHaveLength(0);
  });
});

describe('readDevice', () => {
  function freshPi() {
    return new FakePihole({ devices: [device(MAC, [{ ip: IP, name: 'laptop' }])] });
  }

  // The property that keeps a popup open from writing to someone's Pi-hole.
  it('creates nothing and reports null before setup', async () => {
    const pi = freshPi();
    const identity = await resolveIdentity(pi.asClient());

    await expect(readDevice(pi.asClient(), identity)).resolves.toBeNull();
    expect(pi.state.groups).toHaveLength(1); // Default only
    expect(pi.state.clients).toHaveLength(0);
  });

  it('reports the context once setup has happened', async () => {
    const pi = freshPi();
    const created = await ensureDevice(pi.asClient());
    const identity = await resolveIdentity(pi.asClient());

    const read = await readDevice(pi.asClient(), identity);
    expect(read).not.toBeNull();
    expect(read?.groupId).toBe(created.groupId);
    expect(read?.groupName).toBe('Breaker: laptop');
    expect(read?.groups).toEqual([0, created.groupId]);
  });

  it('reports null when the group exists but the client entry does not', async () => {
    const pi = freshPi();
    await ensureDevice(pi.asClient());
    pi.state.clients = [];
    const identity = await resolveIdentity(pi.asClient());
    await expect(readDevice(pi.asClient(), identity)).resolves.toBeNull();
  });

  it('sees the unfiltered membership the device switch leaves behind', async () => {
    const pi = freshPi();
    const created = await ensureDevice(pi.asClient());
    pi.state.clients[0]!.groups = [created.groupId];

    const identity = await resolveIdentity(pi.asClient());
    const read = await readDevice(pi.asClient(), identity);
    expect(read?.groups).toEqual([created.groupId]);
  });
});

describe('ensureDevice', () => {
  function freshPi() {
    return new FakePihole({ devices: [device(MAC, [{ ip: IP, name: 'laptop' }])] });
  }

  it('creates the group and the client entry on first use', async () => {
    const pi = freshPi();
    const context = await ensureDevice(pi.asClient());

    expect(context.identity.clientKey).toBe(MAC);
    expect(context.groupName).toBe('Breaker: laptop');

    const group = pi.state.groups.find((candidate) => candidate.name === 'Breaker: laptop');
    expect(group?.enabled).toBe(true);
    expect(parseTag(group?.comment)).toEqual({ expires: null, scope: 'device', origin: MAC });

    // Steady state: Default (so gravity still applies) plus the breaker group (so
    // tab allow-entries reach this client).
    expect(pi.state.clients[0]?.client).toBe(MAC);
    expect(pi.state.clients[0]?.groups).toEqual([0, group?.id]);
    expect(context.groups).toEqual([0, group?.id]);
  });

  it('is idempotent — a second call adds nothing', async () => {
    const pi = freshPi();
    const first = await ensureDevice(pi.asClient());
    const second = await ensureDevice(pi.asClient());

    expect(second.groupId).toBe(first.groupId);
    expect(pi.state.groups.filter((group) => group.name.startsWith('Breaker:'))).toHaveLength(1);
    expect(pi.state.clients).toHaveLength(1);
  });

  it('adopts its group by tag after the machine is renamed', async () => {
    const pi = freshPi();
    const first = await ensureDevice(pi.asClient());

    // Pi-hole learns a new hostname for the same MAC.
    pi.state.devices = [device(MAC, [{ ip: IP, name: 'laptop-renamed' }])];
    const second = await ensureDevice(pi.asClient());

    // Same group, matched on the tag's origin rather than on the name.
    expect(second.groupId).toBe(first.groupId);
    expect(pi.state.groups.filter((group) => group.name.startsWith('Breaker:'))).toHaveLength(1);
  });

  it('adds itself to an existing client entry without disturbing its groups', async () => {
    const pi = freshPi();
    pi.state.clients.push({
      client: MAC,
      comment: "Owen's laptop",
      groups: [0, 3],
      id: 5,
      date_added: 1,
      date_modified: 1
    });

    const context = await ensureDevice(pi.asClient());

    // "Kids" (3) survives, the user's comment survives, the breaker group is added.
    expect(pi.state.clients[0]?.groups).toEqual([0, 3, context.groupId]);
    expect(pi.state.clients[0]?.comment).toBe("Owen's laptop");
  });

  it('leaves an already-correct client entry untouched', async () => {
    const pi = freshPi();
    const first = await ensureDevice(pi.asClient());
    pi.state.clients[0]!.comment = 'edited by hand';

    await ensureDevice(pi.asClient());

    expect(pi.state.clients[0]?.comment).toBe('edited by hand');
    expect(pi.state.clients[0]?.groups).toEqual([0, first.groupId]);
  });

  it('adopts a group the user created with the expected name', async () => {
    const pi = freshPi();
    pi.state.groups.push({
      name: 'Breaker: laptop',
      comment: null,
      enabled: true,
      id: 42,
      date_added: 1,
      date_modified: 1
    });

    const context = await ensureDevice(pi.asClient());
    expect(context.groupId).toBe(42);
    expect(pi.state.groups.filter((group) => group.name.startsWith('Breaker:'))).toHaveLength(1);
  });

  it('refuses to proceed with a disabled group instead of silently doing nothing', async () => {
    const pi = freshPi();
    pi.state.groups.push({
      name: 'Breaker: laptop',
      comment: formatTag({ expires: null, scope: 'device', origin: MAC }),
      enabled: false,
      id: 42,
      date_added: 1,
      date_modified: 1
    });

    await expect(ensureDevice(pi.asClient())).rejects.toThrow(/disabled/);
  });

  it('keys on the IP when Pi-hole has no MAC for this machine', async () => {
    const pi = new FakePihole({ devices: [] });
    const context = await ensureDevice(pi.asClient());

    expect(context.identity.keyedBy).toBe('ip');
    expect(pi.state.clients[0]?.client).toBe(IP);
    expect(context.groupName).toBe(`Breaker: ${IP}`);
  });
});
