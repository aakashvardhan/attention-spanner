import { execSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const release = join(root, 'release');

console.log('▸ building…');
execSync('npm run build', { cwd: root, stdio: 'inherit' });

const manifest = JSON.parse(readFileSync(join(root, 'dist/manifest.json'), 'utf8'));
const version = manifest.version;

rmSync(release, { recursive: true, force: true });
mkdirSync(release, { recursive: true });

const zipName = `reader-extension-v${version}.zip`;
const zipPath = join(release, zipName);
console.log(`▸ zipping dist → release/${zipName}`);
execSync(`cd "${join(root, 'dist')}" && zip -qr "${zipPath}" .`, { cwd: root });

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
TMP_ZIP="$(mktemp -t reader-ext).zip"
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
