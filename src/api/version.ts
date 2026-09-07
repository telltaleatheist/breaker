/**
 * Version parsing and the v6 gate.
 *
 * Breaker speaks the Pi-hole v6 REST API and nothing else. v5's API was a
 * different animal (`/admin/api.php?disable=...&auth=<hash>`), so there is no
 * shared subset to fall back to and no feature detection worth attempting: we
 * check the version once, at connect time, and say so by name if it is too old.
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** exactly what the Pi-hole reported, for error messages */
  raw: string;
}

/**
 * Parse a Pi-hole component version string.
 *
 * Real shapes seen on the wire: "v6.4.3", "v6.1", "v6.0.5-hotfix",
 * "vDev-955e36a" (custom branch build). Anything without a leading numeric
 * major.minor is unparseable and returns null — we refuse rather than guess.
 */
export function parseVersion(raw: string | null | undefined): ParsedVersion | null {
  if (typeof raw !== 'string') return null;
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(raw.trim());
  if (!match) return null;
  const [, majorText, minorText, patchText] = match;
  return {
    major: Number(majorText),
    minor: Number(minorText),
    patch: patchText === undefined ? 0 : Number(patchText),
    raw: raw.trim()
  };
}

/** Human-readable "v6.4.3" from a parsed version. */
export function formatVersion(version: ParsedVersion): string {
  return `v${version.major}.${version.minor}.${version.patch}`;
}

export class PiholeVersionError extends Error {
  readonly reported: string | null;

  constructor(message: string, reported: string | null) {
    super(message);
    this.name = 'PiholeVersionError';
    this.reported = reported;
  }
}

/**
 * Throw unless the reported Pi-hole Core version is v6.0.0 or newer.
 *
 * Names the offending version in the message — an extension that just says
 * "unsupported" leaves the user with nothing to act on.
 */
export function requireV6(raw: string | null | undefined): ParsedVersion {
  const parsed = parseVersion(raw);
  if (!parsed) {
    throw new PiholeVersionError(
      `Could not read a version number from this Pi-hole (it reported ${
        raw === null || raw === undefined ? 'nothing' : `"${raw}"`
      }). Breaker needs Pi-hole v6 or later.`,
      raw ?? null
    );
  }
  if (parsed.major < 6) {
    throw new PiholeVersionError(
      `This Pi-hole is ${parsed.raw}. Breaker needs Pi-hole v6 or later — v5 and ` +
        `earlier use a completely different API (/admin/api.php) that this extension ` +
        `does not speak. Upgrade Pi-hole, or use an older tool for v5.`,
      parsed.raw
    );
  }
  return parsed;
}
