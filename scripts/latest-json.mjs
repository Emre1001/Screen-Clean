// Baut latest.json für tauri-plugin-updater aus den signierten Build-Artefakten.
// Aufruf: node scripts/latest-json.mjs <ordner-mit-artefakten> > latest.json
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const REPO = 'Emre1001/Screen-Clean';
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const PLATFORMS = [
  ['windows-x86_64', /_x64-setup\.exe$/],
  ['linux-x86_64', /\.AppImage$/],
];

const files = [];
(function walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    statSync(p).isDirectory() ? walk(p) : files.push(p);
  }
})(process.argv[2] || '.');

const platforms = {};
for (const [key, pattern] of PLATFORMS) {
  const installer = files.find((f) => pattern.test(f));
  const sig = installer && files.find((f) => f === `${installer}.sig`);
  if (!sig) continue; // ohne Signatur kein Update-Eintrag
  platforms[key] = {
    signature: readFileSync(sig, 'utf8').trim(),
    url: `https://github.com/${REPO}/releases/download/v${version}/${basename(installer)}`,
  };
}
if (!Object.keys(platforms).length) console.error('Keine .sig-Dateien – Secret TAURI_SIGNING_PRIVATE_KEY gesetzt?');
console.log(JSON.stringify({ version, notes: `Screen-Clean ${version}`, pub_date: new Date().toISOString(), platforms }, null, 2));
