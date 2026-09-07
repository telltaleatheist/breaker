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
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

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
  sourcemap: watch ? 'inline' : false
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
