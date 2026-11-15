#!/usr/bin/env node
/*
 * AI-DnD Online — multiplayer server. No dependencies: `node server.js`.
 *
 *   PORT                 port to listen on (default 3000)
 *   ANTHROPIC_API_KEY    Dungeon Master brain: Claude (preferred)
 *   GEMINI_API_KEY       Dungeon Master brain: Gemini (also a voice when no ElevenLabs key)
 *   ELEVENLABS_API_KEY   Dungeon Master and NPC voices, generated ambience
 *   DATA_DIR             saves and audio cache (default ./data)
 *   VOICE_CHAR_BUDGET    characters of speech per party per day (default 40000)
 *   See README.md for the full list.
 *
 * Players create a party, share its code or link, and every browser holds one
 * Server-Sent Events stream of the room. Actions are POSTed. The server runs
 * at most one Dungeon Master call per room at a time; with no AI key the
 * scripted Dungeon Master in dm.js answers instead.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Engine = require('./engine.js');
const DM = require('./dm.js');
const DATA = require('./data.json');

let Providers = null;
try { Providers = require('./providers.js'); } catch (err) { console.warn('providers.js could not be loaded; running with the scripted Dungeon Master and browser voices.', err.message); }

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ROOM_DIR = path.join(DATA_DIR, 'rooms');
const MAX_ROOMS = 500;
const ROOM_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const VOICE_CHAR_BUDGET = Number(process.env.VOICE_CHAR_BUDGET) || 40000;

const safe = (fn) => { try { return fn(); } catch (err) { console.warn('provider setup failed:', err.message); return null; } };
const dm = Providers ? safe(() => Providers.createDM(process.env)) : null;
const voice = Providers ? safe(() => Providers.createVoice(process.env, { dataDir: DATA_DIR })) : null;
const VOICE_MODE = voice ? 'server' : (String(process.env.VOICE_PROVIDER || '').toLowerCase() === 'off' ? 'off' : 'browser');

/** code -> { room, seats: Map<pid, {token, rejoin}>, clients: Set<{res, pid}>, pumping, last, spoken: {day, n}, saveTimer } */
const rooms = new Map();

const STATIC = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/index.html': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/net.js': ['public/net.js', 'text/javascript; charset=utf-8'],
  '/audio.js': ['public/audio.js', 'text/javascript; charset=utf-8'],
  '/table.js': ['public/table.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['public/style.css', 'text/css; charset=utf-8'],
  '/engine.js': ['engine.js', 'text/javascript; charset=utf-8'],
  '/maps.js': ['maps.js', 'text/javascript; charset=utf-8'],
  '/dm.js': ['dm.js', 'text/javascript; charset=utf-8'],
};
const dataJs = 'window.DND_DATA = ' + JSON.stringify(DATA) + ';';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function randomCode(n, alphabet) { let c = ''; for (let i = 0; i < n; i++) c += alphabet[crypto.randomInt(alphabet.length)]; return c; }
function newCode() { for (;;) { const c = randomCode(4, LETTERS); if (!rooms.has(c)) return c; } }

const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex').slice(0, 32);
/** A seat: the secret token, the six-character rejoin code, and their hashes (sent to clients for restores). */
function makeSeat(token, rejoin, th, rh) { return { token: token || null, rejoin: rejoin || null, th: th || (token ? sha(token) : ''), rh: rh || (rejoin ? sha(rejoin) : '') }; }
/** Does `given` (a token or a rejoin code) open this seat? */
function opens(st, given) {
  const g = String(given || '').trim(), G = g.toUpperCase();
  if (!g) return false;
  return (st.token && st.token === g) || (st.rejoin && st.rejoin === G) || (st.th && st.th === sha(g)) || (st.rh && st.rh === sha(G));
}
/** Hand out the seat's token, minting one if the seat came from a restore and only its hash is known. */
function claim(st, given, pid) {
  if (!st.token) { st.token = crypto.randomBytes(16).toString('hex'); st.th = sha(st.token); }
  const G = String(given || '').trim().toUpperCase();
  if (!st.rejoin && st.rh && sha(G) === st.rh) st.rejoin = G;
  return { token: st.token, playerId: pid, rejoin: st.rejoin || '' };
}

function newEntry(room) { return { room, seats: new Map(), clients: new Set(), pumping: false, last: {}, spoken: { day: '', n: 0 }, saveTimer: null }; }

// ---------------------------------------------------------------- persistence

function save(entry) {
  if (entry.saveTimer) return;
  entry.saveTimer = setTimeout(() => {
    entry.saveTimer = null;
    const file = path.join(ROOM_DIR, entry.room.code + '.json');
    const body = JSON.stringify({ room: entry.room, seats: [...entry.seats].map(([pid, s]) => [pid, s.token, s.rejoin, s.th, s.rh]), spoken: entry.spoken });
    fs.mkdir(ROOM_DIR, { recursive: true }, (err) => {
      if (err) return;
      fs.writeFile(file + '.tmp', body, (err2) => { if (!err2) fs.rename(file + '.tmp', file, () => {}); });
    });
  }, 1500);
  entry.saveTimer.unref();
}

function loadRooms() {
  let files = [];
  try { files = fs.readdirSync(ROOM_DIR).filter((f) => /^[A-Z]{4}\.json$/.test(f)); } catch (err) { return; }
  for (const f of files) {
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(ROOM_DIR, f), 'utf8'));
      const room = saved.room;
      if (!room || room.v !== 2 || room.code !== f.slice(0, 4) || Date.now() - room.updated > ROOM_TTL_MS) { fs.unlink(path.join(ROOM_DIR, f), () => {}); continue; }
      // A Dungeon Master call that was in flight when the server stopped is asked again.
      if (room.dm.busy) { room.dm.queue = (room.dm.busy.intents || []).concat(room.dm.queue); room.dm.busy = null; }
      const entry = newEntry(room);
      (saved.seats || []).forEach(([pid, token, rejoin, th, rh]) => { if (room.players[pid]) entry.seats.set(pid, makeSeat(token, rejoin, th, rh)); });
      if (saved.spoken) entry.spoken = saved.spoken;
      rooms.set(room.code, entry);
    } catch (err) { console.warn('could not restore', f, err.message); }
  }
  if (rooms.size) console.log(`Restored ${rooms.size} saved ${rooms.size === 1 ? 'party' : 'parties'}.`);
}

// ---------------------------------------------------------------- state fan-out

function snapshot(entry) {
  const room = entry.room;
  const check = room.dm.check ? { pid: room.dm.check.pid, ability: room.dm.check.ability, dc: room.dm.check.dc, reason: room.dm.check.reason, at: room.dm.check.at } : null;
  const seatKeys = {};
  for (const [pid, st] of entry.seats) seatKeys[pid] = [st.th, st.rh];
  return JSON.stringify(Object.assign({}, room, { dm: Object.assign({}, room.dm, { check }), seatKeys }));
}

function broadcast(entry) {
  const room = entry.room;
  room.ai = !!dm;
  room.voice = VOICE_MODE;
  const vi = voiceIssue();
  room.voiceIssue = vi ? vi.why : '';
  // Seats of players who left or were removed stop working.
  for (const pid of [...entry.seats.keys()]) if (!room.players[pid]) entry.seats.delete(pid);
  for (const c of [...entry.clients]) if (!room.players[c.pid]) { c.res.end(); entry.clients.delete(c); }
  const online = new Set([...entry.clients].map((c) => c.pid));
  for (const id in room.players) room.players[id].online = online.has(id);
  const msg = `data: ${snapshot(entry)}\n\n`;
  for (const c of entry.clients) c.res.write(msg);
}

// ---------------------------------------------------------------- voice health

let lastVoiceError = null;
function voiceFailed(err) {
  const msg = String((err && err.message) || '');
  let why = 'The voice service did not answer.';
  if (/unusual|abuse|free tier|free_tier|detected_unusual_activity/i.test(msg)) why = 'ElevenLabs refused this free-plan key from a cloud server ("unusual activity"). A paid ElevenLabs plan, even the cheapest, fixes this.';
  else if (err && err.code === 'auth') why = 'ElevenLabs rejected the API key: check ELEVENLABS_API_KEY and that it has the Text to Speech permission.';
  else if (err && err.code === 'quota') why = 'The ElevenLabs account is out of characters for this month.';
  else if (/paid_plan|402/i.test(msg)) why = 'This ElevenLabs plan cannot use these voices through the API.';
  lastVoiceError = { why, code: (err && err.code) || 'error', detail: msg.slice(0, 200), at: Date.now() };
}
function voiceOk() { lastVoiceError = null; }
const voiceIssue = () => (lastVoiceError && Date.now() - lastVoiceError.at < 15 * 60 * 1000 ? lastVoiceError : null);

// ---------------------------------------------------------------- the Dungeon Master pump

function voiceBudget(entry) {
  const day = new Date().toISOString().slice(0, 10);
  if (entry.spoken.day !== day) entry.spoken = { day, n: 0 };
  return VOICE_CHAR_BUDGET - entry.spoken.n;
}

async function speak(entry, seg) {
  if (!voice) return null;
  if (voiceBudget(entry) < seg.text.length) { const e = new Error('voice budget used up'); e.code = 'budget'; throw e; }
  const before = voice.chars || 0;
  const out = await voice.speak({ text: seg.tts || seg.text, voice: seg.voice, lang: entry.room.opts.lang });
  entry.spoken.n += Math.max(0, (voice.chars || 0) - before);
  return out;
}

/** Generate the audio for a fresh Dungeon Master reply before anyone asks for it. */
async function prewarm(entry, entryId) {
  const e = entry.room.log.find((x) => x.id === entryId);
  if (!voice || !e || !e.segs || !entry.clients.size) return;
  for (const seg of e.segs) { try { await speak(entry, seg); } catch (err) { return; } }
}

async function pump(entry) {
  if (entry.pumping) return;
  entry.pumping = true;
  try {
    for (let req = Engine.dmBegin(entry.room, 'server'); req; req = Engine.dmBegin(entry.room, 'server')) {
      broadcast(entry);
      let out;
      if (dm) {
        try {
          const reply = await dm.complete({ system: req.system, user: req.user, schema: req.schema });
          out = Engine.dmApply(entry.room, req.seq, reply, { ai: true });
          if (out.invalid) out = Engine.dmFallback(entry.room, req.seq, 'bad_json');
        } catch (err) {
          console.warn(`[${entry.room.code}] Dungeon Master call failed: ${err.code || 'error'} ${String(err.message || '').slice(0, 200)}`);
          out = Engine.dmFallback(entry.room, req.seq, err.code);
        }
      } else {
        await sleep(400);
        out = Engine.dmFallback(entry.room, req.seq);
      }
      if (out && out.ok) prewarm(entry, out.entry).catch(() => {});
      broadcast(entry);
      save(entry);
    }
  } catch (err) {
    console.error(`[${entry.room.code}] pump error:`, err);
    if (entry.room.dm.busy) Engine.dmFallback(entry.room, entry.room.dm.busy.seq);
    broadcast(entry);
  } finally { entry.pumping = false; }
}

// ---------------------------------------------------------------- http helpers

function readJson(req, limit) {
  limit = limit || 8192;
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > limit) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function auth(code, token) {
  const entry = rooms.get(String(code || '').toUpperCase());
  if (!entry || !token) return {};
  for (const [pid, s] of entry.seats) if (s.token && s.token === token) return { entry, pid };
  return { entry };
}

function seat(entry, name, token) {
  const given = String(token || '').trim();
  if (given) {
    for (const [pid, s] of entry.seats) if (opens(s, given)) return claim(s, given, pid);
    return { error: 'That code does not match a seat in this party. Check your rejoin code (Settings, in the game), or join as a new adventurer by leaving the code box with just the party code.', badToken: true };
  }
  // Someone with the same name already sits here: almost always the same person on a new device.
  const clash = entry.room.order.map((id) => entry.room.players[id]).find((p) => p && p.name.toLowerCase() === String(name || '').trim().toLowerCase());
  if (clash) return { error: `${clash.name} already has a seat at this table. If that is you, type your rejoin code into the code box to take it back. Otherwise pick another name.`, nameTaken: true };
  const playerId = 'p' + crypto.randomBytes(5).toString('hex');
  const r = Engine.addPlayer(entry.room, playerId, name);
  if (!r.ok) return { error: r.error };
  const s = makeSeat(crypto.randomBytes(16).toString('hex'), randomCode(6, LETTERS + '23456789'));
  entry.seats.set(playerId, s);
  return { token: s.token, playerId, rejoin: s.rejoin };
}

// ---------------------------------------------------------------- routes

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      const stream = fs.createReadStream(path.join(__dirname, file));
      stream.on('error', () => { if (!res.headersSent) send(res, 404, { error: 'Not found' }); else res.end(); });
      stream.once('open', () => res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' }));
      return stream.pipe(res);
    }
    if (req.method === 'GET' && url.pathname === '/data.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(dataJs);
    }
    if (req.method === 'GET' && url.pathname === '/healthz') {
      const out = { ok: true, rooms: rooms.size, dm: dm ? dm.name : 'scripted', voice: voice ? voice.name : VOICE_MODE, voiceModel: voice ? voice.model : null };
      // /healthz?voice=1 speaks one short word through the voice service to show whether it works.
      if (url.searchParams.get('voice') === '1' && voice) {
        try { const a = await voice.speak({ text: 'Ready.', voice: 'narrator' }); voiceOk(); out.voiceTest = `ok (${a.buffer.length} bytes of ${a.mime})`; } catch (err) { voiceFailed(err); out.voiceTest = 'failed'; }
      }
      out.voiceError = voiceIssue();
      return send(res, 200, out);
    }

    if (req.method === 'POST' && url.pathname === '/api/create') {
      const body = await readJson(req);
      if (rooms.size >= MAX_ROOMS) return send(res, 503, { error: 'The server is full. Try again later.' });
      const code = newCode();
      const entry = newEntry(Engine.newRoom(code));
      rooms.set(code, entry);
      const s = seat(entry, body.name);
      save(entry);
      return send(res, 200, Object.assign({ code }, s));
    }

    if (req.method === 'POST' && url.pathname === '/api/join') {
      const body = await readJson(req);
      const code = String(body.code || '').toUpperCase().trim();
      if (code.length === 6) {
        // A rejoin code: reclaim an existing seat from any device.
        for (const [roomCode, e] of rooms) for (const [pid, st] of e.seats) if (opens(st, code) && (st.rejoin === code || st.rh === sha(code))) { const out = claim(st, code, pid); save(e); return send(res, 200, Object.assign({ code: roomCode }, out)); }
        return send(res, 404, { error: 'No seat has that rejoin code. Check it, or join with the four-letter party code.' });
      }
      const entry = rooms.get(code);
      if (!entry) return send(res, 404, { error: `No party with the code ${code || '…'}. Check the code, or create a new party.` });
      const s = seat(entry, body.name, body.token);
      if (s.error) return send(res, 409, { error: s.error });
      broadcast(entry);
      save(entry);
      return send(res, 200, Object.assign({ code }, s));
    }

    if (req.method === 'POST' && url.pathname === '/api/restore') {
      // After a server restart that lost saved parties (free hosting wipes the disk), a returning
      // player brings back the party from the copy their browser kept. Seats are matched by hash.
      const body = await readJson(req, 600 * 1024);
      const code = String(body.code || '').toUpperCase().trim();
      const room = body.room;
      if (rooms.has(code)) {
        const s = seat(rooms.get(code), body.name, body.token);
        if (s.error) return send(res, 409, { error: s.error });
        return send(res, 200, Object.assign({ code }, s));
      }
      if (!/^[A-Z]{4}$/.test(code) || !room || typeof room !== 'object' || room.v !== 2 || room.code !== code || !room.players || !Array.isArray(room.order) || !room.seatKeys) return send(res, 400, { error: 'That saved party cannot be restored.' });
      if (rooms.size >= MAX_ROOMS) return send(res, 503, { error: 'The server is full. Try again later.' });
      const keys = room.seatKeys;
      delete room.seatKeys;
      delete room.voiceIssue;
      const entry = newEntry(room);
      for (const pid of room.order) if (room.players[pid] && Array.isArray(keys[pid])) entry.seats.set(pid, makeSeat(null, null, String(keys[pid][0] || ''), String(keys[pid][1] || '')));
      let mine = null;
      for (const [pid, st] of entry.seats) if (opens(st, body.token)) mine = claim(st, body.token, pid);
      if (!mine) return send(res, 403, { error: 'Your saved seat does not match this party.' });
      if (room.dm && room.dm.busy) { room.dm.queue = (room.dm.busy.intents || []).concat(room.dm.queue || []); room.dm.busy = null; }
      for (const id in room.players) room.players[id].online = false;
      room.updated = Date.now();
      rooms.set(code, entry);
      save(entry);
      console.log(`[${code}] party restored from a player's saved copy`);
      return send(res, 200, Object.assign({ code, restored: true }, mine));
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      const { entry, pid } = auth(url.searchParams.get('code'), url.searchParams.get('token'));
      if (!pid) return send(res, 404, { error: 'This party no longer exists.' });
      res.writeHead(200, {
        'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive', 'x-accel-buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      const client = { res, pid };
      entry.clients.add(client);
      broadcast(entry);
      pump(entry);
      req.on('close', () => { entry.clients.delete(client); broadcast(entry); });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/action') {
      const body = await readJson(req);
      const { entry, pid } = auth(body.code, body.token);
      if (!pid) return send(res, 404, { error: 'This party no longer exists.' });
      const now = Date.now();
      if (now - (entry.last[pid] || 0) < 40) return send(res, 429, { ok: false, error: 'Slow down a little.' });
      entry.last[pid] = now;
      const result = Engine.act(entry.room, pid, body.action);
      if (!result.ok) return send(res, 200, { ok: false, error: result.error });
      broadcast(entry);
      save(entry);
      pump(entry);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/tts') {
      const { entry, pid } = auth(url.searchParams.get('code'), url.searchParams.get('token'));
      if (!pid || !voice) return send(res, 404, { error: 'No voice here.' });
      const e = entry.room.log.find((x) => x.id === Number(url.searchParams.get('entry')));
      const seg = e && e.segs && e.segs[Number(url.searchParams.get('seg'))];
      if (!seg) return send(res, 404, { error: 'No such line.' });
      try {
        const out = await speak(entry, seg);
        voiceOk();
        res.writeHead(200, { 'content-type': out.mime, 'content-length': out.buffer.length, 'cache-control': 'private, max-age=86400' });
        return res.end(out.buffer);
      } catch (err) {
        if (err.code !== 'budget') { voiceFailed(err); broadcast(entry); }
        if (err.code !== 'budget') console.warn(`[${entry.room.code}] voice failed: ${err.code || 'error'} ${String(err.message || '').slice(0, 160)}`);
        return send(res, err.code === 'budget' ? 429 : 502, { error: err.code === 'budget' ? 'The voice budget for today is used up.' : 'The voice service did not answer.' });
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/sfx') {
      const name = String(url.searchParams.get('name') || '');
      if (!voice || typeof voice.sfx !== 'function' || !DM.AMBIENCE.includes(name) || name === 'none') return send(res, 404, { error: 'No such sound.' });
      const out = await voice.sfx(name).catch(() => null);
      if (!out) return send(res, 404, { error: 'No such sound.' });
      res.writeHead(200, { 'content-type': out.mime, 'content-length': out.buffer.length, 'cache-control': 'public, max-age=604800' });
      return res.end(out.buffer);
    }

    send(res, 404, { error: 'Not found' });
  } catch (err) {
    if (!res.headersSent) send(res, 400, { error: 'Bad request' });
    else res.end();
  }
});

// Housekeeping: keep streams alive, roll abandoned checks, drop idle rooms.
let tick = 0;
setInterval(() => {
  const now = Date.now();
  tick += 1;
  for (const [code, entry] of rooms) {
    if (tick % 3 === 0) for (const c of entry.clients) c.res.write(': ping\n\n');
    const check = entry.room.dm.check;
    if (check && now - check.at > Engine.CHECK_TIMEOUT_MS + 5000) {
      const roller = entry.room.players[check.pid] ? check.pid : entry.room.order[0];
      if (roller) Engine.act(entry.room, roller, { t: 'roll' }); else entry.room.dm.check = null;
      broadcast(entry); save(entry); pump(entry);
    }
    if (!entry.clients.size && now - entry.room.updated > ROOM_TTL_MS) {
      rooms.delete(code);
      fs.unlink(path.join(ROOM_DIR, code + '.json'), () => {});
    }
  }
}, 5000).unref();

loadRooms();
server.listen(PORT, () => {
  console.log(`AI-DnD Online listening on http://localhost:${PORT}`);
  console.log(dm ? `Dungeon Master: ${dm.name} (${dm.model})` : 'Dungeon Master: scripted — set ANTHROPIC_API_KEY or GEMINI_API_KEY for the AI Dungeon Master.');
  console.log(voice ? `Voice: ${voice.name}` : `Voice: ${VOICE_MODE === 'off' ? 'off' : 'browser speech — set ELEVENLABS_API_KEY for narrated voices.'}`);
});
