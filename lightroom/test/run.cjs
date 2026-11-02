// Kjører Lightroom-pluginen i fengari med etterlignede Lightroom-moduler (se test2.lua).
// HTTP går via curl mot den lokale testserveren; __sql leser testserverens database direkte.
const { lua, lauxlib, lualib, to_luastring } = require('fengari');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const L = lauxlib.luaL_newstate();
lualib.luaL_openlibs(L);
const str = (i) => lua.lua_tojsstring(L, i);
const pushStr = (s) => lua.lua_pushstring(L, to_luastring(String(s)));
function reg(name, fn) { lua.lua_pushjsfunction(L, fn); lua.lua_setglobal(L, to_luastring(name)); }
reg('__http', (L) => {
  const method = str(1), url = str(2), headers = str(3).split('\n').filter(Boolean);
  const body = lua.lua_isnil(L, 4) ? null : str(4);
  const form = lua.lua_isnil(L, 5) ? null : JSON.parse(str(5));
  const args = ['-s', '-X', method, '-w', '\n%{http_code}', '--max-time', '60'];
  for (const h of headers) args.push('-H', h);
  if (form) for (const f of form) { if (f.filePath) args.push('-F', `${f.name}=@${f.filePath};filename=${f.fileName};type=${f.contentType}`); else args.push('--form-string', `${f.name}=${f.value}`); }
  else if (body !== null) args.push('--data-binary', '@-');
  args.push(url);
  try {
    const out = execFileSync('curl', args, { input: body ?? '', maxBuffer: 1 << 26 }).toString('utf8');
    const i = out.lastIndexOf('\n');
    const status = Number(out.slice(i + 1));
    if (!status) { lua.lua_pushnil(L); pushStr('cannotConnectToHost'); return 2; }
    pushStr(out.slice(0, i)); lua.lua_pushinteger(L, status); return 2;
  } catch (e) { lua.lua_pushnil(L); pushStr('cannotConnectToHost'); return 2; }
});
reg('__sql', (L) => {
  const query = str(1);
  let db;
  try {
    db = new DatabaseSync(process.env.DB, { readOnly: true });
    pushStr(JSON.stringify(db.prepare(query).all()));
  } catch (e) {
    lauxlib.luaL_error(L, to_luastring(`SQL-feil: ${e.message} (${query})`));
  } finally {
    db?.close();
  }
  return 1;
});
reg('__md5', (L) => { pushStr(crypto.createHash('md5').update(str(1)).digest('hex')); return 1; });
reg('__rm', (L) => { fs.rmSync(str(1), { force: true }); return 0; });
reg('__copy', (L) => { fs.copyFileSync(str(1), str(2)); return 0; });
// «Nettleseren»: logger inn som testadmin (egen cookie-fil) og gjør GET eller POST mot en side. Gir (status, body).
reg('__browser', (L) => {
  const method = str(1), url = str(2), loggedIn = lua.lua_toboolean(L, 3);
  const jar = path.join(process.env.TMP, 'cookies.txt');
  const origin = new URL(url).origin;
  if (loggedIn && !fs.existsSync(jar)) {
    execFileSync('curl', ['-s', '-o', '/dev/null', '-c', jar, '-H', `Origin: ${origin}`, '--data-urlencode', `email=${process.env.ADMIN_EMAIL}`,
      '--data-urlencode', `password=${process.env.ADMIN_PASSWORD}`, `${origin}/login`]);
  }
  const args = ['-s', '-w', '\n%{http_code}', '-X', method, '-H', `Origin: ${origin}`];
  if (loggedIn) args.push('-b', jar);
  if (method === 'POST') args.push('-H', 'x-sveltekit-action: true', '-H', 'content-type: application/x-www-form-urlencoded', '--data', '');
  args.push(url);
  const out = execFileSync('curl', args).toString('utf8');
  const i = out.lastIndexOf('\n');
  lua.lua_pushinteger(L, Number(out.slice(i + 1))); pushStr(out.slice(0, i)); return 2;
});
reg('__exists', (L) => { lua.lua_pushboolean(L, fs.existsSync(str(1))); return 1; });
reg('__append', (L) => { fs.appendFileSync(str(1), str(2)); return 0; });
reg('__read', (L) => { if (!fs.existsSync(str(1))) { lua.lua_pushnil(L); return 1; } pushStr(fs.readFileSync(str(1), 'utf8')); return 1; });
reg('__size', (L) => { lua.lua_pushinteger(L, fs.existsSync(str(1)) ? fs.statSync(str(1)).size : -1); return 1; });
reg('__rename', (L) => { try { fs.renameSync(str(1), str(2)); } catch {} return 0; });
const code = fs.readFileSync(process.argv[2], 'utf8');
if (lauxlib.luaL_loadbuffer(L, to_luastring(code), null, to_luastring('=test')) !== lua.LUA_OK || lua.lua_pcall(L, 0, 0, 0) !== lua.LUA_OK) {
  console.error('LUA-FEIL:', lua.lua_tojsstring(L, -1)); process.exit(1);
}
