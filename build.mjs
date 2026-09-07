/**
 * Build Breaker into dist/.
 *
 * esbuild, IIFE bundles, one per entry point. IIFE rather than ESM because an MV3
 * service worker registered without `"type": "module"` is a classic script, and the
 * popup/options scripts are plain <script> tags — a bare `export {}` in any of them
 * is a runtime syntax error in Chrome, not a build error here.
 *
 * Icons are generated (scripts/make-icons.mjs) rather than committed as binaries,
 * so a contributor can change the mark by editing code and the repo stays free of
 * opaque blobs.
 */

import * as esbuild from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');
// Distribution build: ship WITHOUT a baked Pi-hole address/password. A developer's
// own build can carry theirs (below) so they never retype it; a build meant for
// other people must not, because it would leak one Pi-hole's credentials into
// everyone's extension and match nobody else's Pi-hole anyway.
const dist = process.argv.includes('--dist');

// Bake this machine's Pi-hole settings into the build so the extension starts
// connected. Read from breaker.local.json in the repo root (gitignored), or the
// file named by BREAKER_CONFIG. Seeded into chrome.storage on first run only —
// see core/settings.ts — so the options page can still override it.
const baked = { baseUrl: '', password: '' };
if (dist) {
  console.log('[build] --dist: no baked Pi-hole settings (each user enters theirs in Options)');
} else {
  const configPath = process.env.BREAKER_CONFIG ?? join(root, 'breaker.local.json');
  if (existsSync(configPath)) {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    baked.baseUrl = typeof config.baseUrl === 'string' ? config.baseUrl : '';
    baked.password = typeof config.password === 'string' ? config.password : '';
    console.log(`[build] baked Pi-hole settings from ${configPath} (${baked.baseUrl || 'no address'})`);
  } else {
    console.log('[build] no breaker.local.json — the build starts unconfigured');
  }
}

// Icons first: dist/ is a copy of static/, so they must exist before the copy.
const iconsDir = join(root, 'static', 'icons');
if (!existsSync(join(iconsDir, 'icon-128.png'))) {
  console.log('[build] generating icons');
  execFileSync(process.execPath, [join(root, 'scripts', 'make-icons.mjs')], { stdio: 'inherit' });
}

rmSync(join(root, 'dist'), { recursive: true, force: true });
mkdirSync(join(root, 'dist'), { recursive: true });
cpSync(join(root, 'static'), join(root, 'dist'), { recursive: true });

/** @type {import('esbuild').BuildOptions} */
const options = {
  absWorkingDir: root,
  entryPoints: ['src/background.ts', 'src/popup.ts', 'src/options.ts'],
  bundle: true,
  format: 'iife',
  // Chrome 116 is the floor declared in the manifest. Keeping the two in step means
  // esbuild will not emit syntax the minimum supported Chrome cannot parse.
  target: 'chrome116',
  outdir: 'dist',
  logLevel: 'info',
  legalComments: 'none',
  sourcemap: watch ? 'inline' : false,
  define: {
    __BREAKER_BAKED__: JSON.stringify(baked)
  }
};

if (watch) {
  // static/ is copied once, at startup: restart the watcher after editing HTML/CSS.
  const context = await esbuild.context(options);
  await context.watch();
  console.log('[build] watching src/ — restart after changing static/');
} else {
  await esbuild.build(options);
  console.log('[build] wrote dist/ — load it with chrome://extensions → Load unpacked');
}
