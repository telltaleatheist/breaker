import { describe, expect, it } from 'vitest';

import {
  formatTag,
  isExpired,
  parseTag,
  TAG_PREFIX,
  tagForDuration,
  type BreakerTag
} from '../src/core/tags';

const NOW = 1_756_000_000; // epoch seconds

describe('formatTag', () => {
  it('writes the documented one-line grammar', () => {
    expect(
      formatTag({ expires: 1_756_000_600, scope: 'tab', origin: 'news.example.com' })
    ).toBe('breaker v1 | expires=1756000600 | scope=tab | origin=news.example.com');
  });

  it('writes "never" for a grant with no deadline', () => {
    expect(formatTag({ expires: null, scope: 'device', origin: '14:c6:7d:5d:48:11' })).toBe(
      'breaker v1 | expires=never | scope=device | origin=14:c6:7d:5d:48:11'
    );
  });

  it('strips delimiters out of the origin so the grammar survives', () => {
    const text = formatTag({ expires: null, scope: 'tab', origin: 'a|b\nc' });
    expect(text).toBe('breaker v1 | expires=never | scope=tab | origin=a b c');
    expect(parseTag(text)?.origin).toBe('a b c');
  });

  it('floors a fractional expiry — Pi-hole timestamps are whole seconds', () => {
    expect(formatTag({ expires: 1_756_000_600.9, scope: 'tab', origin: 'x.example' })).toContain(
      'expires=1756000600'
    );
  });
});

describe('parseTag', () => {
  it('round-trips every tag it writes', () => {
    const tags: BreakerTag[] = [
      { expires: NOW + 600, scope: 'tab', origin: 'news.example.com' },
      { expires: null, scope: 'device', origin: '192.168.68.79' },
      { expires: 0, scope: 'tab', origin: '' }
    ];
    for (const tag of tags) {
      expect(parseTag(formatTag(tag))).toEqual(tag);
    }
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseTag('  breaker v1 | expires=never | scope=tab | origin=x  ')).toEqual({
      expires: null,
      scope: 'tab',
      origin: 'x'
    });
  });

  it.each([
    ["someone else's note", 'a hand-written comment'],
    ['breaker v0 | expires=never | scope=tab | origin=x', 'a different format version'],
    ['breaker v1 | expires=never | scope=tab', 'a missing field'],
    ['breaker v1 | expires=never | scope=network | origin=x', 'an unknown scope'],
    ['breaker v1 | expires=soon | scope=tab | origin=x', 'a non-numeric expiry'],
    ['breaker v1 | expires | scope=tab | origin=x', 'a field with no value'],
    ['', 'an empty comment']
  ])('returns null for %s (%s)', (comment) => {
    expect(parseTag(comment)).toBeNull();
  });

  it('returns null for a null or undefined comment', () => {
    expect(parseTag(null)).toBeNull();
    expect(parseTag(undefined)).toBeNull();
  });

  // This is the safety property the sweep depends on: Breaker must never delete an
  // entry it cannot prove it created.
  it('does not claim an entry whose comment merely mentions breaker', () => {
    expect(parseTag('added by breaker, do not remove')).toBeNull();
    expect(parseTag(`${TAG_PREFIX} but nothing else`)).toBeNull();
  });
});

describe('isExpired', () => {
  it('never expires a permanent grant', () => {
    expect(isExpired({ expires: null, scope: 'tab', origin: 'x' }, NOW + 10 ** 9)).toBe(false);
  });

  it('is expired at and after the deadline', () => {
    const tag: BreakerTag = { expires: NOW, scope: 'tab', origin: 'x' };
    expect(isExpired(tag, NOW - 1)).toBe(false);
    expect(isExpired(tag, NOW)).toBe(true);
    expect(isExpired(tag, NOW + 1)).toBe(true);
  });

  // Guards the units bug: milliseconds against a seconds field reads as
  // "expired 55 years ago" or "never", depending on direction.
  it('works in seconds, not milliseconds', () => {
    const tag = tagForDuration('tab', 'x', 600, NOW);
    expect(isExpired(tag, NOW + 599)).toBe(false);
    expect(isExpired(tag, NOW + 601)).toBe(true);
  });
});

describe('tagForDuration', () => {
  it('turns a duration into an absolute deadline', () => {
    expect(tagForDuration('tab', 'news.example.com', 3600, NOW)).toEqual({
      expires: NOW + 3600,
      scope: 'tab',
      origin: 'news.example.com'
    });
  });

  it('treats a null duration as "until I say"', () => {
    expect(tagForDuration('device', 'x', null, NOW).expires).toBeNull();
  });
});
