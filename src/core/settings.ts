/**
 * First-run seeding of the Pi-hole settings from a build-time value.
 *
 * A developer's own build can carry their Pi-hole address and app password
 * (build.mjs reads breaker.local.json), so the extension starts connected instead
 * of asking for the same two strings on every reinstall. The rules that keep that
 * from ever surprising anyone:
 *
 *  - It seeds ONLY when nothing has ever been saved. `stored === undefined` means
 *    "never saved"; a saved record with an empty address means "the user
 *    disconnected on purpose", and re-seeding over that would make Disconnect a
 *    button that does nothing.
 *  - A saved record always wins over the baked value, so Options can override it.
 *  - A distribution build bakes empty strings, and empty strings never seed.
 */

export interface SeedableSettings {
  baseUrl: string;
  password: string;
}

export interface SeedResult {
  settings: SeedableSettings;
  /** true when the baked value was used and should now be persisted */
  seeded: boolean;
}

export function seedSettings(
  stored: Partial<SeedableSettings> | undefined,
  baked: SeedableSettings
): SeedResult {
  if (stored !== undefined) {
    return {
      settings: { baseUrl: stored.baseUrl ?? '', password: stored.password ?? '' },
      seeded: false
    };
  }
  if (baked.baseUrl.trim() === '') {
    return { settings: { baseUrl: '', password: '' }, seeded: false };
  }
  return { settings: { baseUrl: baked.baseUrl, password: baked.password }, seeded: true };
}
