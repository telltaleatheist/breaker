/**
 * "Who am I, as far as Pi-hole is concerned?"
 *
 * The device switch works by moving THIS machine's Pi-hole client entry between
 * groups, so before any of that can happen Breaker has to know which client entry
 * is this machine. The chain:
 *
 *   GET /api/info/client  →  remote_addr, the source address of our own request
 *   GET /api/network/devices  →  the device whose `ips[]` contains that address,
 *                                giving its MAC (`hwaddr`) and hostname
 *
 * A MAC-keyed client entry is strictly better than an IP-keyed one: DHCP will
 * hand this machine a different address eventually, and an IP-keyed entry would
 * then silently start governing whichever device inherited the lease. We fall back
 * to the IP only when Pi-hole has no ARP record for us — which is itself
 * informative, and the popup says so.
 *
 * The honest limit, stated in the UI and the README: `remote_addr` is whoever
 * Pi-hole thinks is asking. Behind a VPN, a NAT, or another router, that is the
 * gateway, not this laptop — and then the device switch would affect everything
 * behind that gateway. Breaker shows the address it resolved precisely so the user
 * can see when it is not them.
 */

import type { PiholeClient } from '../api/client';
import type { NetworkDevice, PiholeClientEntry } from '../api/types';
import { DEFAULT_GROUP_ID, withBreakerGroup } from './scopes';
import { formatTag, parseTag } from './tags';

export interface DeviceIdentity {
  /** the address Pi-hole sees this browser coming from */
  ip: string;
  /** MAC from Pi-hole's network table, or null when it has no ARP record for us */
  hwaddr: string | null;
  hostname: string | null;
  /** what the Pi-hole client entry is keyed on: the MAC when known, else the IP */
  clientKey: string;
  /** whether we are working from a MAC (durable) or an IP (leases move) */
  keyedBy: 'mac' | 'ip';
}

/** Everything the device switch needs once the Pi-hole side has been set up. */
export interface DeviceContext {
  identity: DeviceIdentity;
  /** database id of this device's "Breaker: …" group */
  groupId: number;
  groupName: string;
  /** the groups the client entry is in right now */
  groups: number[];
}

/** Pi-hole lowercases MACs, but a hand-created entry may not be. */
export function sameClientKey(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** The device whose address list contains `ip`, or null. */
export function findDeviceByIp(devices: readonly NetworkDevice[], ip: string): NetworkDevice | null {
  for (const device of devices) {
    for (const address of device.ips) {
      if (address.ip === ip) return device;
    }
  }
  return null;
}

/** The hostname Pi-hole has for `ip` on this device, if any. */
export function hostnameForIp(device: NetworkDevice | null, ip: string): string | null {
  if (!device) return null;
  for (const address of device.ips) {
    if (address.ip === ip && address.name) return address.name;
  }
  return null;
}

export function identityFor(ip: string, device: NetworkDevice | null): DeviceIdentity {
  const hwaddr = device?.hwaddr ?? null;
  // Pi-hole invents placeholder hwaddrs like "ip-192.168.68.79" for devices it has
  // no ARP entry for. Those are not MACs and must not be treated as durable keys.
  const isRealMac = typeof hwaddr === 'string' && /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(hwaddr);
  return {
    ip,
    hwaddr: isRealMac ? hwaddr : null,
    hostname: hostnameForIp(device, ip),
    clientKey: isRealMac ? hwaddr : ip,
    keyedBy: isRealMac ? 'mac' : 'ip'
  };
}

/**
 * The group name shown in Pi-hole's own UI. Prefixed so it is obvious who made it
 * and safe to delete by hand; suffixed with the hostname (or IP) so a household
 * running Breaker on three machines gets three legible groups.
 */
export function deviceGroupName(identity: DeviceIdentity): string {
  return `Breaker: ${identity.hostname ?? identity.ip}`;
}

/**
 * Resolve identity WITHOUT creating anything on the Pi-hole. This is what the
 * options page's connect/test runs: showing the user who Pi-hole thinks they are
 * should never be a side-effecting act.
 */
export async function resolveIdentity(api: PiholeClient): Promise<DeviceIdentity> {
  const info = await api.getClientInfo();
  const devices = await api.getNetworkDevices();
  return identityFor(info.remote_addr, findDeviceByIp(devices, info.remote_addr));
}

/**
 * Find this device's Breaker group and client entry, creating NOTHING.
 *
 * The read half of `ensureDevice`, and the one the popup uses. Merely opening the
 * popup must not add a group and a client entry to someone's Pi-hole: setup is a
 * consequence of using a switch, not of looking at one. Returns null when this
 * device has not been set up yet, which the popup reports as such.
 */
export async function readDevice(
  api: PiholeClient,
  identity: DeviceIdentity
): Promise<DeviceContext | null> {
  const groups = await api.getGroups();
  const group =
    groups.find((candidate) => {
      const tag = parseTag(candidate.comment);
      return tag !== null && tag.scope === 'device' && sameClientKey(tag.origin, identity.clientKey);
    }) ?? groups.find((candidate) => candidate.name === deviceGroupName(identity));
  if (!group) return null;

  const clients = await api.getClients();
  const entry = clients.find((candidate) => sameClientKey(candidate.client, identity.clientKey));
  if (!entry) return null;

  return { identity, groupId: group.id, groupName: group.name, groups: entry.groups };
}

/**
 * Make sure this device has a Breaker group and a client entry that is in it.
 *
 * Idempotent: it adopts what already exists rather than adding a second copy. Call
 * it when a switch is USED — `readDevice` is the one to call to merely display
 * state. The group is matched by our own tag first
 * (origin = clientKey) and by name second, so renaming the machine — or Pi-hole
 * learning a hostname it did not have before — does not orphan the old group.
 *
 * Steady state is: client in [Default, breakerGroup]. That membership is what
 * makes the TAB switch work too, because a tab allow-entry is assigned to the
 * breaker group and only applies to clients inside it.
 */
export async function ensureDevice(api: PiholeClient): Promise<DeviceContext> {
  const identity = await resolveIdentity(api);
  const wantedName = deviceGroupName(identity);

  // ── the group ──
  const groups = await api.getGroups();
  let group =
    groups.find((candidate) => {
      const tag = parseTag(candidate.comment);
      return tag !== null && tag.scope === 'device' && sameClientKey(tag.origin, identity.clientKey);
    }) ?? groups.find((candidate) => candidate.name === wantedName);

  if (!group) {
    const comment = formatTag({ expires: null, scope: 'device', origin: identity.clientKey });
    await api.addGroup({ name: wantedName, comment, enabled: true });
    // POST /groups answers with the created rows, but reading the list back is the
    // only way to be certain of the assigned id under a concurrent create.
    const refreshed = await api.getGroups();
    const created = refreshed.find((candidate) => candidate.name === wantedName);
    if (!created) {
      throw new Error(
        `Pi-hole accepted the group "${wantedName}" but does not list it. ` +
          `Check Pi-hole's Groups page.`
      );
    }
    group = created;
  }

  // A disabled group applies none of its allow entries, which would make every
  // tab switch silently do nothing. Enabling it is exactly what the user asked for
  // by using the feature, so we say so rather than failing.
  if (!group.enabled) {
    throw new Error(
      `The Pi-hole group "${group.name}" is disabled, so Breaker's allow entries ` +
        `would have no effect. Enable it in Pi-hole (Groups) and try again.`
    );
  }

  // ── the client entry ──
  const clients = await api.getClients();
  const existing: PiholeClientEntry | undefined = clients.find((candidate) =>
    sameClientKey(candidate.client, identity.clientKey)
  );

  let memberships: number[];
  if (!existing) {
    const comment = formatTag({ expires: null, scope: 'device', origin: identity.clientKey });
    memberships = [DEFAULT_GROUP_ID, group.id];
    await api.addClient({ client: identity.clientKey, comment, groups: memberships });
  } else {
    memberships = withBreakerGroup(existing.groups, group.id);
    if (memberships.length !== existing.groups.length) {
      // Someone else's client entry: keep their comment, only widen the groups.
      await api.updateClient(existing.client, {
        comment: existing.comment,
        groups: memberships
      });
    }
  }

  return { identity, groupId: group.id, groupName: group.name, groups: memberships };
}
