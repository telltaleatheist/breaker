import { describe, expect, it } from 'vitest';

import { formatVersion, parseVersion, PiholeVersionError, requireV6 } from '../src/api/version';

describe('parseVersion', () => {
  it('reads the shape a real Pi-hole reports', () => {
    expect(parseVersion('v6.4.3')).toEqual({ major: 6, minor: 4, patch: 3, raw: 'v6.4.3' });
  });

  it('accepts a two-part version and defaults the patch', () => {
    expect(parseVersion('v6.1')).toEqual({ major: 6, minor: 1, patch: 0, raw: 'v6.1' });
  });

  it('accepts a version without the v prefix', () => {
    expect(parseVersion('6.0.5')).toEqual({ major: 6, minor: 0, patch: 5, raw: '6.0.5' });
  });

  it('ignores a build suffix', () => {
    expect(parseVersion('v6.0.5-hotfix')?.patch).toBe(5);
  });

  it('trims surrounding whitespace', () => {
    expect(parseVersion('  v6.4.3 ')?.major).toBe(6);
  });

  it.each([
    ['vDev-955e36a', 'a custom branch build'],
    ['', 'an empty string'],
    ['nonsense', 'free text'],
    [null, 'null'],
    [undefined, 'undefined']
  ])('returns null for %s (%s)', (raw: string | null | undefined, _why: string) => {
    expect(parseVersion(raw)).toBeNull();
  });
});

describe('formatVersion', () => {
  it('renders a canonical vX.Y.Z', () => {
    expect(formatVersion({ major: 6, minor: 4, patch: 3, raw: 'v6.4.3' })).toBe('v6.4.3');
  });
});

describe('requireV6', () => {
  it('passes v6 and later', () => {
    expect(requireV6('v6.4.3').major).toBe(6);
    expect(requireV6('v7.0.0').major).toBe(7);
    expect(requireV6('v6.0').major).toBe(6);
  });

  it('refuses v5 and names it in the message', () => {
    let thrown: unknown;
    try {
      requireV6('v5.17.3');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PiholeVersionError);
    const error = thrown as PiholeVersionError;
    // The whole point of the gate is that the user learns WHICH version they have
    // and what to do about it.
    expect(error.message).toContain('v5.17.3');
    expect(error.message).toContain('v6');
    expect(error.reported).toBe('v5.17.3');
  });

  it('refuses an unreadable version rather than assuming it is new enough', () => {
    expect(() => requireV6('vDev-955e36a')).toThrow(PiholeVersionError);
    expect(() => requireV6(null)).toThrow(PiholeVersionError);
    expect(() => requireV6(null)).toThrow(/nothing/);
  });
});
