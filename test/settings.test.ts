import { describe, expect, it } from 'vitest';
import { seedSettings } from '../src/core/settings';

const baked = { baseUrl: 'http://pi.hole', password: 'app-pw' };

describe('seedSettings', () => {
  it('seeds from the baked value when nothing was ever saved', () => {
    expect(seedSettings(undefined, baked)).toEqual({ settings: baked, seeded: true });
  });

  it('never seeds when the baked value is empty (a --dist build)', () => {
    expect(seedSettings(undefined, { baseUrl: '', password: '' })).toEqual({
      settings: { baseUrl: '', password: '' },
      seeded: false
    });
    expect(seedSettings(undefined, { baseUrl: '   ', password: 'x' }).seeded).toBe(false);
  });

  it('a saved record wins over the baked value', () => {
    const stored = { baseUrl: 'http://192.168.1.5', password: 'mine' };
    expect(seedSettings(stored, baked)).toEqual({ settings: stored, seeded: false });
  });

  it('a deliberate disconnect (saved but empty) is not overwritten by the baked value', () => {
    expect(seedSettings({ baseUrl: '', password: '' }, baked)).toEqual({
      settings: { baseUrl: '', password: '' },
      seeded: false
    });
  });

  it('fills missing fields of a partial record with empty strings, not baked ones', () => {
    expect(seedSettings({ baseUrl: 'http://pi.hole' }, baked)).toEqual({
      settings: { baseUrl: 'http://pi.hole', password: '' },
      seeded: false
    });
  });
});
