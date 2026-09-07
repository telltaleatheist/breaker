/**
 * An in-memory stand-in for a Pi-hole, good enough for the group/domain/client
 * arithmetic the core modules perform.
 *
 * Not a mock framework: it holds real rows and mutates them the way FTL does, so a
 * test can assert on the resulting STATE ("the client ended up in these groups")
 * rather than on a sequence of calls. Call-sequence assertions are what make a
 * refactor break a hundred tests without any behaviour changing.
 */

import type { PiholeClient } from '../src/api/client';
import type {
  ClientCreateRequest,
  ClientUpdateRequest,
  Domain,
  DomainCreateRequest,
  DomainKind,
  DomainType,
  DomainUpdateRequest,
  Group,
  GroupCreateRequest,
  NetworkDevice,
  PiholeClientEntry,
  QueriesParams,
  Query
} from '../src/api/types';

export interface FakePiholeState {
  groups: Group[];
  clients: PiholeClientEntry[];
  domains: Domain[];
  devices: NetworkDevice[];
  queries: Query[];
  remoteAddr: string;
  blocking: { blocking: 'enabled' | 'disabled'; timer: number | null };
}

export class FakePihole {
  readonly state: FakePiholeState;
  private nextId = 100;

  constructor(initial: Partial<FakePiholeState> = {}) {
    this.state = {
      groups: [
        {
          name: 'Default',
          comment: 'The default group',
          enabled: true,
          id: 0,
          date_added: 1,
          date_modified: 1
        }
      ],
      clients: [],
      domains: [],
      devices: [],
      queries: [],
      remoteAddr: '192.168.68.79',
      blocking: { blocking: 'enabled', timer: null },
      ...initial
    };
  }

  /** Hand this to any core function that wants a PiholeClient. */
  asClient(): PiholeClient {
    return this as unknown as PiholeClient;
  }

  // ── info ──
  async getClientInfo() {
    return { remote_addr: this.state.remoteAddr, http_version: '1.1', method: 'GET' };
  }

  async getNetworkDevices(): Promise<NetworkDevice[]> {
    return this.state.devices;
  }

  // ── blocking ──
  async getBlocking() {
    return { ...this.state.blocking };
  }

  async setBlocking(blocking: boolean, timer: number | null) {
    this.state.blocking = { blocking: blocking ? 'enabled' : 'disabled', timer };
    return { ...this.state.blocking };
  }

  // ── groups ──
  async getGroups(): Promise<Group[]> {
    return this.state.groups.map((group) => ({ ...group }));
  }

  async addGroup(request: GroupCreateRequest): Promise<Group[]> {
    if (this.state.groups.some((group) => group.name === request.name)) {
      throw new Error('The item is already present');
    }
    const group: Group = {
      name: request.name,
      comment: request.comment,
      enabled: request.enabled,
      id: this.nextId++,
      date_added: 1,
      date_modified: 1
    };
    this.state.groups.push(group);
    return [group];
  }

  async deleteGroup(name: string): Promise<void> {
    this.state.groups = this.state.groups.filter((group) => group.name !== name);
  }

  // ── clients ──
  async getClients(): Promise<PiholeClientEntry[]> {
    return this.state.clients.map((client) => ({ ...client, groups: [...client.groups] }));
  }

  async addClient(request: ClientCreateRequest): Promise<PiholeClientEntry[]> {
    const client: PiholeClientEntry = {
      client: request.client,
      comment: request.comment,
      groups: [...request.groups],
      id: this.nextId++,
      date_added: 1,
      date_modified: 1
    };
    this.state.clients.push(client);
    return [client];
  }

  async updateClient(key: string, request: ClientUpdateRequest): Promise<PiholeClientEntry[]> {
    const client = this.state.clients.find(
      (candidate) => candidate.client.toLowerCase() === key.toLowerCase()
    );
    if (!client) throw new Error(`no such client: ${key}`);
    client.comment = request.comment;
    client.groups = [...request.groups];
    return [{ ...client }];
  }

  async deleteClient(key: string): Promise<void> {
    this.state.clients = this.state.clients.filter(
      (client) => client.client.toLowerCase() !== key.toLowerCase()
    );
  }

  // ── domains ──
  async getDomains(type: DomainType, kind: DomainKind): Promise<Domain[]> {
    return this.state.domains
      .filter((domain) => domain.type === type && domain.kind === kind)
      .map((domain) => ({ ...domain, groups: [...domain.groups] }));
  }

  async addDomain(
    type: DomainType,
    kind: DomainKind,
    request: DomainCreateRequest
  ): Promise<Domain[]> {
    const exists = this.state.domains.some(
      (domain) =>
        domain.type === type &&
        domain.kind === kind &&
        domain.domain.toLowerCase() === request.domain.toLowerCase()
    );
    if (exists) throw new Error('The item is already present');
    const domain: Domain = {
      domain: request.domain,
      type,
      kind,
      comment: request.comment,
      groups: [...request.groups],
      enabled: request.enabled,
      id: this.nextId++,
      date_added: 1,
      date_modified: 1
    };
    this.state.domains.push(domain);
    return [domain];
  }

  async updateDomain(
    type: DomainType,
    kind: DomainKind,
    key: string,
    request: DomainUpdateRequest
  ): Promise<Domain[]> {
    const domain = this.state.domains.find(
      (candidate) =>
        candidate.type === type &&
        candidate.kind === kind &&
        candidate.domain.toLowerCase() === key.toLowerCase()
    );
    if (!domain) throw new Error(`no such domain: ${key}`);
    domain.type = request.type;
    domain.kind = request.kind;
    domain.comment = request.comment;
    domain.groups = [...request.groups];
    domain.enabled = request.enabled;
    return [{ ...domain }];
  }

  async deleteDomain(type: DomainType, kind: DomainKind, key: string): Promise<void> {
    this.state.domains = this.state.domains.filter(
      (domain) =>
        !(
          domain.type === type &&
          domain.kind === kind &&
          domain.domain.toLowerCase() === key.toLowerCase()
        )
    );
  }

  // ── queries ──
  async getQueries(params: QueriesParams): Promise<Query[]> {
    return this.state.queries.filter((query) => {
      if (params.from !== undefined && query.time < params.from) return false;
      if (params.client_ip !== undefined && query.client.ip !== params.client_ip) return false;
      return true;
    });
  }
}

/** Convenience for building a network device row. */
export function device(
  hwaddr: string,
  ips: { ip: string; name?: string | null }[]
): NetworkDevice {
  return {
    id: 1,
    hwaddr,
    interface: 'eth0',
    firstSeen: 1,
    lastQuery: 2,
    numQueries: 3,
    macVendor: null,
    ips: ips.map((entry) => ({
      ip: entry.ip,
      name: entry.name ?? null,
      lastSeen: 2,
      nameUpdated: 2
    }))
  };
}

/** Convenience for building a query-log row. */
export function query(domain: string, status: string, ip = '192.168.68.79'): Query {
  return {
    time: 1_756_000_000,
    type: 'A',
    domain,
    cname: null,
    status,
    client: { ip, name: null }
  };
}
