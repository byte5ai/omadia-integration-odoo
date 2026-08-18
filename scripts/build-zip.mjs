#!/usr/bin/env node
/**
 * build-zip.mjs — stage the built plugin into an uploadable ZIP.
 *
 *     npm run build && npm run package     # → out/<id>-<version>.zip
 *
 * ## Why this exists
 *
 * This repository could not produce its own release artifact. The ZIP was cut
 * by `scripts/package-all.mjs` in the `omadia-byte5-plugins` monorepo — which
 * stopped being the source of truth when the packages were split into their
 * own repositories, and is now archived. A repo that cannot build its own
 * artifact is a repo whose releases keep flowing through a tree nobody edits
 * any more; that is exactly how @omadia/integration-odoo ended up published from a commit
 * that lived only on a frozen branch.
 *
 * ## It does NOT bundle
 *
 * Plain `tsc` output ships as-is. `omadia-channel-telegram` esbuild-bundles
 * because it pulls in dependencies the Omadia host does not ship; this package
 * resolves everything through host-provided peers, and every published
 * @omadia/integration-odoo release so far shipped unbundled. Bundling would change dependency
 * resolution for something already installed in production, which is not a
 * decision a packaging script should make on its own.
 *
 * ## Archive layout: FLAT, on purpose
 *
 * `manifest.yaml`, `package.json` and `dist/` sit at the archive root — no
 * wrapping `<id>-<version>-package/` directory. Verified by unpacking the live
 * 0.2.0 artifact from the hub and diffing against this script's output.
 * The Telegram script nests its payload one level deeper; the two shapes are
 * not interchangeable, so this one is pinned to what the hub has always
 * received from this package.
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const pkgRoot = process.cwd();

/** Everything the host needs at runtime. `node_modules` must never be in here. */
const REQUIRED_FILES = ['manifest.yaml'];
const REQUIRED_DIRS = ['dist'];
const OPTIONAL_FILES = ['README.md', 'LICENSE', 'NOTICE', 'INTEGRATION.md'];
const OPTIONAL_DIRS = ['assets', 'skills'];

/** The manifest's `lifecycle.entry`. Its absence means `tsc` did not finish. */
const REQUIRED_IN_DIST = ['plugin.js'];

const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
if (!pkg.name || !pkg.version) {
  throw new Error('package.json: "name" and "version" are required');
}

// --- version drift guard ---------------------------------------------------
// The version lives in two files and the hub reads the MANIFEST, not
// package.json. When they disagree, the published artifact carries a different
// version than the repository believes it cut — which is how a release ends up
// unattributable to a commit. Measured drift of exactly this kind is why the
// check is here rather than in a reviewer's head.
const manifestText = readFileSync(join(pkgRoot, 'manifest.yaml'), 'utf8');
const manifestVersion = manifestText.match(/^\s{2}version:\s*["']?([^"'\s]+)/m)?.[1];
if (!manifestVersion) {
  throw new Error('manifest.yaml: could not read identity.version');
}
if (manifestVersion !== pkg.version) {
  throw new Error(
    `version drift: package.json says ${pkg.version}, manifest.yaml says ${manifestVersion}. ` +
      'The hub reads the manifest — bump both.',
  );
}

// --- stage -----------------------------------------------------------------
const safeName = pkg.name.replace(/^@/, '').replace(/\//g, '-');
const outDir = join(pkgRoot, 'out');
const stageDir = join(outDir, `${safeName}-${pkg.version}-stage`);
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

for (const rel of REQUIRED_FILES) {
  const src = join(pkgRoot, rel);
  if (!existsSync(src)) throw new Error(`missing required file: ${rel}`);
  cpSync(src, join(stageDir, rel));
  console.log(`  + ${rel}`);
}

// --- package.json, without devDependencies ---------------------------------
// devDependencies are meaningless inside a published artifact — nothing ever
// installs them from a plugin ZIP — and in these repos they point at sibling
// checkouts (`file:../odoo-bot/middleware/...`). Shipping those paths embeds
// one machine's directory layout in a public artifact, and any host that did
// run an install against it would fail on a path that exists nowhere but here.
// Every artifact the hub has received so far was cut from the monorepo, whose
// package.json carried no devDependencies at all — so stripping them keeps the
// output matching what has always been published instead of silently changing
// it the first time a release is cut from this repo.
const stagedPkg = { ...pkg };
delete stagedPkg.devDependencies;
writeFileSync(join(stageDir, 'package.json'), `${JSON.stringify(stagedPkg, null, 2)}\n`);
console.log('  + package.json (devDependencies stripped)');

for (const rel of REQUIRED_DIRS) {
  const src = join(pkgRoot, rel);
  if (!existsSync(src)) {
    throw new Error(`missing required dir: ${rel}/ — run \`npm run build\` first`);
  }
  cpSync(src, join(stageDir, rel), { recursive: true });
  console.log(`  + ${rel}/`);
}

for (const rel of [...OPTIONAL_FILES, ...OPTIONAL_DIRS]) {
  const src = join(pkgRoot, rel);
  if (!existsSync(src)) continue;
  cpSync(src, join(stageDir, rel), { recursive: true });
  console.log(`  + ${rel}${statSync(src).isDirectory() ? '/' : ''}`);
}

for (const rel of REQUIRED_IN_DIST) {
  if (!existsSync(join(stageDir, 'dist', rel))) {
    throw new Error(`staged dist/ is missing ${rel} — the build artefact is incomplete`);
  }
}

// --- zip -------------------------------------------------------------------
const zipPath = join(outDir, `${safeName}-${pkg.version}.zip`);
rmSync(zipPath, { force: true });
createFlatZip({ zipPath, stageDir });

console.log(`✓ built ${zipPath} (${statSync(zipPath).size} bytes)`);

/**
 * Archive the CONTENTS of `stageDir` at the archive root, using whichever
 * zipper this machine has. `zip` is tried first; on Windows it is usually
 * absent, so 7-Zip and PowerShell's `Compress-Archive` follow. All three are
 * invoked so the payload lands flat — `Compress-Archive` needs the `/*` glob
 * for that, since pointing it at the directory itself would nest one level.
 */
function createFlatZip({ zipPath, stageDir }) {
  const EXCLUDES = ['*.DS_Store', 'node_modules/*', '*.tsbuildinfo'];
  const strategies = [
    {
      label: 'zip',
      cmd: 'zip',
      args: ['-r', '-q', zipPath, '.', ...EXCLUDES.flatMap((p) => ['-x', p])],
      opts: { cwd: stageDir, stdio: 'inherit' },
    },
    {
      label: '7z',
      cmd: '7z',
      args: ['a', '-tzip', '-bd', '-bso0', zipPath, '.'],
      opts: { cwd: stageDir, stdio: 'inherit' },
    },
    {
      label: 'Compress-Archive',
      cmd: process.platform === 'win32' ? 'powershell' : 'pwsh',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Compress-Archive -Path '${stageDir.replace(/'/g, "''")}/*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`,
      ],
      opts: { stdio: 'inherit' },
    },
  ];

  const attempted = [];
  for (const s of strategies) {
    const res = spawnSync(s.cmd, s.args, s.opts);
    if (res.error?.code === 'ENOENT') {
      attempted.push(`${s.label} (not found)`);
      continue;
    }
    if (res.error) {
      attempted.push(`${s.label} (${res.error.message})`);
      continue;
    }
    if (res.status === 0 && existsSync(zipPath)) return;
    attempted.push(`${s.label} (exit ${res.status})`);
  }

  throw new Error(
    `could not create ${zipPath} — no working zip tool. Tried: ${attempted.join(', ')}. ` +
      'Install `zip`, install 7-Zip (`7z`), or ensure PowerShell (Compress-Archive) is available.',
  );
}
