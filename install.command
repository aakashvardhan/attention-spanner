#!/bin/sh
# Reader — one-click installer for people who cloned this repo from GitHub.
#
#   macOS:  double-click this file (install.command) in Finder.
#   Linux:  run  sh install.command
#
# It builds the extension from source and then walks you through the single
# manual step Chrome requires ("Load unpacked" — Chrome does not allow
# installs from outside the Web Store). No prior setup needed except Node.js,
# which it checks for and points you to if it is missing.
set -e

# Double-clicking runs from your home folder, so move into the repo the script
# lives in — everything below assumes we are at the project root.
cd "$(dirname "$0")"

echo ""
echo "📖  Reader — installing the Chrome extension from this folder"
echo ""

# --- 1. Make sure Node.js / npm are available -------------------------------
if ! command -v npm >/dev/null 2>&1; then
  echo "✗  Node.js is not installed — the build needs it."
  echo ""
  echo "   Install it once (free, ~30 seconds):"
  echo "     1. Go to  https://nodejs.org  and download the \"LTS\" version"
  echo "     2. Open the downloaded installer and click through it"
  echo "     3. Come back and double-click install.command again"
  echo ""
  if [ "$(uname)" = "Darwin" ]; then
    open "https://nodejs.org/en/download/prebuilt-installer" 2>/dev/null || true
  fi
  echo "Press Return to close."
  read _ || true
  exit 1
fi

# --- 2. Build the extension -------------------------------------------------
echo "▸  Installing dependencies (first run downloads a bit — please wait)…"
npm install

echo ""
echo "▸  Building the extension…"
npm run build

echo ""
echo "✓  Built. The extension is the  dist  folder inside this project."
echo ""

# --- 3. Hand off to Chrome for the one manual step --------------------------
DIST="$(pwd)/dist"
echo "Finish in Chrome (one time, ~15 seconds):"
echo "  1. Chrome will open to  chrome://extensions"
echo "  2. Turn ON \"Developer mode\" (toggle, top-right)"
echo "  3. Click \"Load unpacked\""
echo "  4. Pick this folder:"
echo "        $DIST"
echo ""

if [ "$(uname)" = "Darwin" ]; then
  open -a "Google Chrome" "chrome://extensions/" 2>/dev/null || true
  open "$DIST" 2>/dev/null || true   # Finder window so the folder is easy to pick
else
  (google-chrome "chrome://extensions/" || chromium "chrome://extensions/") >/dev/null 2>&1 &
fi

echo "Done — you can close this window."
echo ""
# Keep the window open when double-clicked so the instructions stay readable.
if [ "$(uname)" = "Darwin" ]; then
  echo "Press Return to close."
  read _ || true
fi
exit 0
