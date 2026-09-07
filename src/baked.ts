/**
 * The Pi-hole settings baked in at build time.
 *
 * `__BREAKER_BAKED__` is substituted by esbuild (see build.mjs `define`): a local
 * build carries the developer's breaker.local.json, a `--dist` build carries empty
 * strings. This is the only file that names the global, so the rest of the code
 * sees an ordinary constant.
 */

import type { SeedableSettings } from './core/settings';

declare const __BREAKER_BAKED__: SeedableSettings;

export const BAKED_SETTINGS: SeedableSettings = __BREAKER_BAKED__;
