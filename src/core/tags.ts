/**
 * Breaker's ownership tag, written into Pi-hole's `comment` field.
 *
 * Pi-hole has no place to hang extension metadata, and the extension has no
 * durable place to hang Pi-hole state — the browser can be closed, reinstalled,
 * or replaced by a second machine running Breaker against the same Pi. So the
 * comment IS the record: it says this entry is ours, when it stops being wanted,
 * which switch created it, and what the user was looking at when they flipped it.
 *
 * That makes the sweep possible: on startup Breaker reads the allow list, parses
 * the comments, and deletes what has expired — including grants made by a browser
 * session that never came back. Nothing else in the system would know.
 *
 * Shape (one line, ` | ` separated, order fixed):
 *   breaker v1 | expires=<epoch seconds|never> | scope=<tab|device> | origin=<host>
 *
 * The `v1` is a format version, not the extension's version. Bump it only if the
 * grammar changes, and teach `parseTag` to read both — an old tag on the Pi-hole
 * outlives any single install.
 */

const TAG_VERSION = 'v1';
export const TAG_PREFIX = `breaker ${TAG_VERSION}`;

export type TagScope = 'tab' | 'device';

export interface BreakerTag {
  /** epoch SECONDS at which this entry should be removed, or null for "until I say" */
  expires: number | null;
  scope: TagScope;
  /**
   * The site the user was on when they flipped the switch (tab scope), or the
   * device key (device scope). Free text; only ever displayed, never parsed for
   * meaning. Sanitised of the delimiter so a round-trip is lossless.
   */
  origin: string;
}

/** Strip anything that would break the one-line, ` | `-delimited grammar. */
function sanitise(value: string): string {
  return value.replace(/[|\r\n]+/g, ' ').trim();
}

export function formatTag(tag: BreakerTag): string {
  const expires = tag.expires === null ? 'never' : String(Math.floor(tag.expires));
  return `${TAG_PREFIX} | expires=${expires} | scope=${tag.scope} | origin=${sanitise(tag.origin)}`;
}

/**
 * Parse a Pi-hole comment back into a tag, or null when it is not ours.
 *
 * Strict on purpose. A comment we cannot fully understand is treated as someone
 * else's — Breaker will never delete an entry it cannot prove it created, because
 * the alternative is an extension that quietly eats a user's hand-written
 * allowlist.
 */
export function parseTag(comment: string | null | undefined): BreakerTag | null {
  if (typeof comment !== 'string') return null;
  const trimmed = comment.trim();
  if (!trimmed.startsWith(`${TAG_PREFIX} |`)) return null;

  const fields = new Map<string, string>();
  for (const part of trimmed.split('|').slice(1)) {
    const separator = part.indexOf('=');
    if (separator === -1) return null;
    fields.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }

  const rawExpires = fields.get('expires');
  const rawScope = fields.get('scope');
  const origin = fields.get('origin');
  if (rawExpires === undefined || rawScope === undefined || origin === undefined) return null;
  if (rawScope !== 'tab' && rawScope !== 'device') return null;

  let expires: number | null;
  if (rawExpires === 'never') {
    expires = null;
  } else {
    const parsed = Number(rawExpires);
    if (!Number.isFinite(parsed)) return null;
    expires = Math.floor(parsed);
  }

  return { expires, scope: rawScope, origin };
}

/**
 * @param nowSeconds epoch SECONDS — the same unit `expires` is in. Pi-hole's own
 *   timestamps are seconds, so keeping tags in seconds avoids a units bug at the
 *   one place it would be silently wrong (a x1000 error reads as "never expired").
 */
export function isExpired(tag: BreakerTag, nowSeconds: number): boolean {
  if (tag.expires === null) return false;
  return tag.expires <= nowSeconds;
}

/**
 * Build the tag for a grant starting now.
 * @param durationSeconds null means "until I say" — no expiry.
 */
export function tagForDuration(
  scope: TagScope,
  origin: string,
  durationSeconds: number | null,
  nowSeconds: number
): BreakerTag {
  return {
    expires: durationSeconds === null ? null : Math.floor(nowSeconds + durationSeconds),
    scope,
    origin
  };
}
