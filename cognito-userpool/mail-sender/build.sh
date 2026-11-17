#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  NODE_VERSION="$(<.nvmrc)"
  printf 'nvm not found at NVM_DIR=%s; this build requires Node %s from .nvmrc\n' \
    "$NVM_DIR" "$NODE_VERSION" >&2
  exit 1
fi

# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm use

VERSION="$(node -e "console.log(JSON.parse(require('node:fs').readFileSync('package.json', 'utf8')).version)")"
ZIP_PATH="$SCRIPT_DIR/dist/cognito-userpool-mail-sender-${VERSION}.zip"

npm install --no-audit --no-fund --package-lock=false
mkdir -p .build "$(dirname "$ZIP_PATH")"
./node_modules/.bin/esbuild src/index.mjs \
  --bundle \
  --platform=node \
  --format=esm \
  --target=node22 \
  --outfile=.build/index.mjs

MAIL_SENDER_BUNDLE="$SCRIPT_DIR/.build/index.mjs" \
MAIL_SENDER_ZIP="$ZIP_PATH" \
node --input-type=module <<'NODE'
import { createWriteStream } from 'node:fs';
import archiver from 'archiver';

const output = createWriteStream(process.env.MAIL_SENDER_ZIP);
const archive = archiver('zip', { zlib: { level: 9 } });

await new Promise((resolve, reject) => {
  output.on('close', resolve);
  output.on('error', reject);
  archive.on('error', reject);
  archive.on('warning', (error) => {
    if (error.code !== 'ENOENT') {
      reject(error);
    }
  });
  archive.pipe(output);
  archive.file(process.env.MAIL_SENDER_BUNDLE, { name: 'index.mjs' });
  archive.finalize();
});

console.log(`Created ${process.env.MAIL_SENDER_ZIP}`);
NODE
