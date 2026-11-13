// Zips dist/ into the file the Chrome Web Store takes: lamport-warden-<version>.zip, manifest.json at its root.
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version, description } = JSON.parse(readFileSync(join(root, 'dist', 'manifest.json'), 'utf8'));
if (description.length > 132) throw new Error(`the manifest description is ${description.length} characters; the store takes 132`);
const out = join(root, `lamport-warden-${version}.zip`);
rmSync(out, { force: true });
// -X: no extra file attributes, so the same sources give the same archive
execFileSync('zip', ['-q', '-r', '-X', out, '.'], { cwd: join(root, 'dist') });
console.log(`${out}\nupload this file in the Chrome Web Store developer dashboard`);
