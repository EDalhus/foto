#!/usr/bin/env bash
# Tester Lightroom-pluginen: først syntaks og globale navn, så hele pluginen i fengari mot en
# midlertidig lokal Foto-server (egen database, lagring på disk). Ingenting rører produksjon.
#
#   cd lightroom/test && bash kjor.sh
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(cd ../.. && pwd)
APP="$ROOT/app"
PLUGIN="$ROOT/lightroom/foto.lrplugin"

[ -d node_modules ] || npm install --silent --no-audit --no-fund
echo "== Syntaks og globale navn"
node lint.cjs "$PLUGIN"

[ -f "$APP/build/index.js" ] || (cd "$APP" && npm run build >/dev/null)

WORK=$(mktemp -d)
SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT
mkdir -p "$WORK/data" "$WORK/img" "$WORK/run/home/Library/Logs"

PORT=$(node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
PW=$(node -e "console.log(require('crypto').randomBytes(12).toString('hex'))")
HOST=127.0.0.1 PORT=$PORT ORIGIN="http://127.0.0.1:$PORT" DATA_DIR="$WORK/data" ADMIN_EMAIL=test@example.com \
	ADMIN_PASSWORD="$PW" STORAGE_DRIVER=local BODY_SIZE_LIMIT=400M NODE_NO_WARNINGS=1 \
	node "$APP/build/index.js" >"$WORK/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 100); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.1; done

node lag-testbilder.mjs "$APP" "$WORK/img"
TOKEN=$(DB="$WORK/data/foto.db" node -e "
const { DatabaseSync } = require('node:sqlite'); const c = require('crypto');
const db = new DatabaseSync(process.env.DB);
const u = db.prepare('SELECT id FROM users LIMIT 1').get();
const t = 'fto_' + c.randomBytes(24).toString('hex');
db.prepare('INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, created_at) VALUES (?,?,?,?,?,?)')
  .run('test', u.id, 'test', c.createHash('sha256').update(t).digest('hex'), t.slice(0, 10), Date.now());
console.log(t);" 2>/dev/null)

echo "== Pluginen mot testserver på port $PORT"
ADMIN_EMAIL=test@example.com ADMIN_PASSWORD="$PW" PLUGIN="$PLUGIN" IMG="$WORK/img" TMP="$WORK/run" SERVER="http://127.0.0.1:$PORT" TOKEN="$TOKEN" DB="$WORK/data/foto.db" \
	NODE_NO_WARNINGS=1 node run.cjs plugin.test.lua
