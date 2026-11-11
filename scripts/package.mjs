import { execSync } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

/**
 * `npm run package` — build the extension and produce shareable artifacts in
 * release/ so end users never touch npm:
 *
 *   1. reader-extension-v<version>.zip   — extract + "Load unpacked" (any OS)
 *   2. install-reader.command            — single self-extracting installer for
 *      macOS (double-click) / Linux (`sh install-reader.command`): unpacks the
 *      embedded zip to ~/ReaderExtension and opens chrome://extensions with
 *      instructions. Chrome forbids programmatic installs outside the Web
 *      Store, so "Load unpacked" is the one manual step left.
 *
 * The command itself runs on any OS too: the zip is written here, in Node,
 * rather than by a `zip` binary Windows does not have.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const release = join(root, 'release');

console.log('▸ building…');
execSync('npm run build:ext', { cwd: root, stdio: 'inherit' });
const dist = join(root, 'rust/ext/dist/chromium');

const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
const version = manifest.version;

rmSync(release, { recursive: true, force: true });
mkdirSync(release, { recursive: true });

const zipName = `reader-extension-v${version}.zip`;
const zipPath = join(release, zipName);
console.log(`▸ zipping rust/ext/dist/chromium → release/${zipName}`);
writeFileSync(zipPath, zip(dist));

console.log('▸ writing release/install-reader.command');
const payload = readFileSync(zipPath).toString('base64').replace(/(.{76})/g, '$1\n');

const installer = `#!/bin/sh
# Reader — self-extracting Chrome extension installer (v${version}).
# macOS: double-click this file. Linux: run \`sh install-reader.command\`.
# It unpacks the extension to ~/ReaderExtension; Chrome then loads it via
# "Load unpacked" (Chrome does not allow installs outside the Web Store).
set -e

TARGET="$HOME/ReaderExtension"
echo ""
echo "📖 Reader — Chrome extension installer (v${version})"
echo ""

PAYLOAD_LINE=$(awk '/^__ARCHIVE_BELOW__$/ { print NR + 1; exit 0 }' "$0")
TMP_ZIP="$(mktemp "\${TMPDIR:-/tmp}/reader-ext.XXXXXX")"
tail -n +"$PAYLOAD_LINE" "$0" | base64 -d > "$TMP_ZIP" 2>/dev/null \\
  || tail -n +"$PAYLOAD_LINE" "$0" | base64 -D > "$TMP_ZIP"

# Replace a previous install, but only a folder that really is this extension
if [ -f "$TARGET/manifest.json" ]; then
  rm -rf "$TARGET"
elif [ -e "$TARGET" ]; then
  echo "✗ $TARGET exists but doesn't look like a previous install — move it aside and rerun."
  rm -f "$TMP_ZIP"
  exit 1
fi
mkdir -p "$TARGET"
unzip -qo "$TMP_ZIP" -d "$TARGET"
rm -f "$TMP_ZIP"

echo "✓ Extension unpacked to: $TARGET"
echo "  (keep this folder — Chrome loads the extension from it)"
echo ""
echo "Finish in Chrome (one time):"
echo "  1. Go to chrome://extensions"
echo "  2. Turn ON \\"Developer mode\\" (top-right toggle)"
echo "  3. Click \\"Load unpacked\\" and pick the ReaderExtension folder"
echo ""

if [ "$(uname)" = "Darwin" ]; then
  open -a "Google Chrome" "chrome://extensions/" 2>/dev/null || true
  open "$TARGET" 2>/dev/null || true
else
  (google-chrome "chrome://extensions/" || chromium "chrome://extensions/") >/dev/null 2>&1 &
fi
exit 0
__ARCHIVE_BELOW__
${payload}
`;

const installerPath = join(release, 'install-reader.command');
writeFileSync(installerPath, installer);
chmodSync(installerPath, 0o755);

console.log(`\n✓ release/ ready:\n  - ${zipName} (any OS: extract + Load unpacked)\n  - install-reader.command (macOS double-click / Linux sh)`);

/** Every file under `dir`, as a zip (deflate, no extras): what `zip -qr` made, without the binary. */
function zip(dir) {
  const files = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(dir);
  const local = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(relative(dir, file).split(sep).join('/'));
    const data = readFileSync(file);
    const packed = deflateRawSync(data);
    const crc = crc32(data);
    const head = (sig, extra) => {
      const b = Buffer.alloc(extra);
      b.writeUInt32LE(sig, 0);
      return b;
    };
    // Version 2.0, UTF-8 names (flag 11), deflate, a fixed 1980-01-01 stamp so the zip is reproducible.
    const fields = (b, at) => {
      b.writeUInt16LE(20, at);
      b.writeUInt16LE(0x0800, at + 2);
      b.writeUInt16LE(8, at + 4);
      b.writeUInt16LE(0, at + 6);
      b.writeUInt16LE(0x21, at + 8);
      b.writeUInt32LE(crc, at + 10);
      b.writeUInt32LE(packed.length, at + 14);
      b.writeUInt32LE(data.length, at + 18);
      b.writeUInt16LE(name.length, at + 22);
    };
    const lh = head(0x04034b50, 30);
    fields(lh, 4);
    local.push(lh, name, packed);
    const ch = head(0x02014b50, 46);
    ch.writeUInt16LE(20, 4);
    fields(ch, 6);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + packed.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
