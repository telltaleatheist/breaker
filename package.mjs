/**
 * Zip dist/ into a distributable archive.
 *
 * Run after `node build.mjs` (the `package` npm script does both). The zip wraps
 * dist/ in a named folder so a user unzips it and gets one clean directory to point
 * "Load unpacked" at. For a Chrome Web Store upload you would zip the CONTENTS of
 * dist/ at the archive root instead — the store rejects a nested wrapper.
 *
 * Uses the platform zip tool rather than a dependency: on macOS `ditto` avoids the
 * __MACOSX / AppleDouble entries that confuse Chrome's unpacked loader, and
 * elsewhere `zip -r -X` does the same job.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const FOLDER = 'breaker';

const manifestPath = join(root, 'dist', 'manifest.json');
let version;
try {
  version = JSON.parse(readFileSync(manifestPath, 'utf8')).version;
} catch {
  console.error('[package] dist/ is not built — run `node build.mjs` first.');
  process.exit(1);
}

const zipName = `${FOLDER}-${version}.zip`;
const zipPath = join(root, zipName);

// Stage under a named wrapper folder so the archive extracts to one directory.
const staging = join(root, '.package-staging');
const stage = join(staging, FOLDER);
rmSync(staging, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(join(root, 'dist'), stage, { recursive: true });

rmSync(zipPath, { force: true });
if (process.platform === 'darwin') {
  execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', stage, zipPath], {
    stdio: 'inherit'
  });
} else {
  execFileSync('zip', ['-r', '-q', '-X', zipPath, FOLDER], { cwd: staging, stdio: 'inherit' });
}
rmSync(staging, { recursive: true, force: true });

const kb = (statSync(zipPath).size / 1024).toFixed(1);
console.log(
  `[package] wrote ${zipName} (${kb} KB) — unzip, then chrome://extensions → ` +
    `Developer mode → Load unpacked → ${FOLDER}/`
);
