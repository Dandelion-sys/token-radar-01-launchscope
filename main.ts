// LaunchScope: build the token launch radar and write the graded outputs.
//
//   node main.ts [--input <snapshot.json|directory>] [--output <directory>]
//
// Reads the sealed snapshot (default /input/snapshot.json, or the directory
// holding it), scores every pre-token protocol with lib/radar.ts, and writes
// to the output directory (default $MAKEFUN_OUTPUT_DIR, else /output):
//   board.json    the ranked board, one row per pre-token protocol
//   data.js       the same board as a script the dashboard loads
//   dashboard/    the static page, copied from this repository
//   screenshots/  the three dashboard views, copied from this repository
//   dossier.json  the judge's dossier, built by vendor/makefun-board.ts
//
// Node 22, standard library only. No network, no clock, no randomness:
// two runs over the same snapshot write the same bytes.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/radar.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));

/** Caps the scorer holds the dossier to; the text cap shapes the bytes. */
const DOSSIER_TEXT_MAX = 65_536;
const SHOT_LIMITS = { max: 4, max_bytes: 524_288 };
const DASH_LIMITS = { max_files: 400, max_bytes: 4_194_304 };
const SHOT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function die(message: string): never {
  process.stderr.write(`launchscope: ${message}\n`);
  process.exit(1);
}

/** The value after `--name`, in `--name value` or `--name=value` form. */
function flag(name: string, fallback: string): string {
  const argv = process.argv;
  const at = argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1]!;
  const joined = argv.find((a) => a.startsWith(`--${name}=`));
  return joined === undefined ? fallback : joined.slice(name.length + 3);
}

const inputGiven = flag('input', '/input');
const snapshotPath = inputGiven.endsWith('.json') ? inputGiven : join(inputGiven, 'snapshot.json');
if (!existsSync(snapshotPath)) {
  die(`no snapshot at ${snapshotPath}; pass --input <snapshot.json|directory>`);
}
const outDir = flag('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(snapshotPath, 'utf8'));
const radar = buildRadar(snapshot);
const problem = boardIssue(radar, snapshot);
if (problem !== null) die(`the model wrote a board the gate refuses: ${problem}`);

/** Copy every regular file of a directory into `dest`, skipping dot-names. */
function copyDir(from: string, dest: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(dest, { recursive: true });
  const names: string[] = [];
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const src = join(from, entry.name);
    const dst = join(dest, entry.name);
    if (entry.isDirectory()) {
      names.push(...copyDir(src, dst).map((n) => `${entry.name}/${n}`));
    } else if (entry.isFile()) {
      copyFileSync(src, dst);
      names.push(entry.name);
    }
  }
  return names.sort();
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: radar.rows })}\n`);
writeFileSync(join(outDir, 'data.js'), dataScript(radar));

const dashboardFiles = copyDir(join(repoRoot, 'dashboard'), join(outDir, 'dashboard'));
const shotFiles = copyDir(join(repoRoot, 'screenshots'), join(outDir, 'screenshots'));
if (shotFiles.length < 3) {
  die(`screenshots/ holds ${shotFiles.length} image${shotFiles.length === 1 ? '' : 's'}; hand in 3: the board, a detail view and a filtered view`);
}
for (const name of shotFiles) {
  if (!SHOT_NAME.test(name)) die(`screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`);
}
const dashCount = dashboardFiles.length;
if (dashCount === 0 || !dashboardFiles.includes('index.html')) die('dashboard/ holds no index.html');

// The dossier is written last: the scorer rebuilds it from this output and compares bytes.
writeFileSync(
  join(outDir, 'dossier.json'),
  buildDossier(outDir, { text_max_bytes: DOSSIER_TEXT_MAX, screenshots: SHOT_LIMITS, dashboard: DASH_LIMITS }),
);

process.stdout.write(
  `launchscope: ${snapshot.protocols.length} protocols in the snapshot, ${snapshot.watchlist.length} on the watchlist\n` +
    `launchscope: ${radar.rows.length} pre-token rows ranked (${radar.early_size} below the floor, ${radar.live_size} live comps)\n` +
    `launchscope: wrote ${join(outDir, 'board.json')}, ${join(outDir, 'data.js')}, dashboard/ (${dashCount} files), screenshots/ (${shotFiles.length} images) and dossier.json\n`,
);
