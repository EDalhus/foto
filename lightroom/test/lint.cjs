// Sjekker at alle .lua-filer i pluginen er gyldig Lua 5.1, og at de ikke bruker ukjente globale navn
// (typisk en glemt import eller en skrivefeil, som ellers først merkes i Lightroom).
const fs = require('fs');
const path = require('path');
const luaparse = require('luaparse');
const dir = process.argv[2];
const known = new Set(['import', 'require', 'MAC_ENV', 'WIN_ENV', '_PLUGIN', 'LOC', 'string', 'table', 'math', 'os', 'io',
  'pairs', 'ipairs', 'next', 'type', 'tostring', 'tonumber', 'error', 'assert', 'pcall', 'select', 'setmetatable',
  'getmetatable', 'rawget', 'rawset', 'unpack', 'print', '_G']);
let problems = 0;
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.lua')).sort()) {
  let ast;
  try {
    ast = luaparse.parse(fs.readFileSync(path.join(dir, f), 'utf8'), { luaVersion: '5.1', scope: true, locations: true });
  } catch (e) {
    problems++;
    console.log(`FEIL  ${f}: ${e.message}`);
    continue;
  }
  const globals = new Map();
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.type === 'Identifier' && n.isLocal === false && !known.has(n.name) && !globals.has(n.name)) globals.set(n.name, n.loc.start.line);
    for (const k of Object.keys(n)) if (k !== 'loc' && k !== 'range') walk(n[k]);
  })(ast);
  for (const [name, line] of globals) {
    problems++;
    console.log(`FEIL  ${f}:${line}: ukjent globalt navn «${name}»`);
  }
  if (!globals.size) console.log(`ok    ${f}`);
}
process.exit(problems ? 1 : 0);
