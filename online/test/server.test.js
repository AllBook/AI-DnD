// Server test: boots server.js with the scripted Dungeon Master (no keys) on a
// spare port, plays through the HTTP API with two players, restarts the server
// and checks the party was saved. Run with: node test/server.test.js
'use strict';
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 4300 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aidnd-test-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function boot() {
  const env = Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR, DM_PROVIDER: 'scripted', VOICE_PROVIDER: 'browser' });
  for (const k of ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ELEVENLABS_API_KEY']) delete env[k];
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(child); });
    child.on('exit', (c) => reject(new Error('server exited ' + c)));
    setTimeout(() => reject(new Error('server did not start')), 8000);
  });
}
const post = async (url, body) => (await fetch(BASE + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();

/** Hold one SSE stream and expose the latest room snapshot. */
function listen(code, token) {
  const ctl = new AbortController();
  const s = { room: null, close: () => ctl.abort(), status: 0 };
  s.done = (async () => {
    const res = await fetch(`${BASE}/api/events?code=${code}&token=${token}`, { signal: ctl.signal });
    s.status = res.status;
    if (!res.ok) return;
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        if (frame.startsWith('data: ')) s.room = JSON.parse(frame.slice(6));
      }
    }
  })().catch(() => {});
  return s;
}
async function until(fn, what, ms) {
  const end = Date.now() + (ms || 6000);
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(40); }
  throw new Error('timed out waiting for ' + what);
}

(async () => {
  let server = await boot();
  try {
    for (const p of ['/', '/app.js', '/net.js', '/engine.js', '/dm.js', '/data.js', '/style.css']) assert.strictEqual((await fetch(BASE + p)).status, 200, p);
    const health = await (await fetch(BASE + '/healthz')).json();
    assert.strictEqual(health.dm, 'scripted');

    const a = await post('/api/create', { name: 'Aria' });
    assert.ok(/^[A-Z]{4}$/.test(a.code) && a.token && /^[A-Z0-9]{6}$/.test(a.rejoin), 'create returns code, token and rejoin code');
    const b = await post('/api/join', { code: a.code, name: 'Borin' });
    assert.ok(b.token && b.playerId !== a.playerId);
    assert.ok((await post('/api/join', { code: 'QQQQ', name: 'X' })).error);
    assert.ok((await post('/api/join', { code: a.code, name: 'X', token: 'not-a-real-token' })).error, 'an unknown token does not create a seat');
    const again = await post('/api/join', { code: b.rejoin, name: 'whoever' });
    assert.strictEqual(again.token, b.token, 'a rejoin code reclaims the seat');
    assert.strictEqual((await fetch(`${BASE}/api/events?code=${a.code}&token=nope`)).status, 404);

    const sa = listen(a.code, a.token), sb = listen(a.code, b.token);
    await until(() => sa.room && sb.room && sa.room.order.length === 2, 'both players in the room');
    const act = (who, action) => post('/api/action', { code: a.code, token: who.token, action });
    assert.ok(!(await act(b, { t: 'start' })).ok, 'only the host can start');
    assert.ok((await act(a, { t: 'class', cls: 'Rogue', bio: 'a locksmith on the run' })).ok);
    await sleep(60);
    assert.ok((await act(b, { t: 'class', cls: 'Cleric' })).ok);
    assert.ok((await act(a, { t: 'opts', adventure: 'lighthouse', tone: 'grim', lang: 'English' })).ok);
    await sleep(60);
    assert.ok((await act(a, { t: 'start' })).ok);
    const opened = await until(() => sa.room.phase === 'scene' && !sa.room.dm.busy && sa.room.log.find((e) => e.k === 'dm'), 'the opening narration');
    assert.ok(opened.segs.length >= 2 && opened.segs[1].speaker !== 'narrator', 'opening has an NPC line');
    assert.strictEqual(sa.room.ai, false);
    assert.strictEqual(sa.room.voice, 'browser');
    assert.strictEqual(sa.room.opts.adventure, 'lighthouse');
    assert.ok(sa.room.story.quests.length === 1 && sa.room.story.npcs.length === 1 && sa.room.dm.chips.length > 0);
    assert.ok(sb.room.players[a.playerId].online && sb.room.players[b.playerId].online);

    // Two players act at once: both intents are answered, one DM call at a time.
    await Promise.all([act(a, { t: 'intent', kind: 'do', text: 'I search the harbour wall' }), act(b, { t: 'intent', kind: 'say', text: 'Who was the keeper?' })]);
    await until(() => !sa.room.dm.busy && (sa.room.dm.check || (sa.room.dm.queue.length === 0 && sa.room.log.filter((e) => e.k === 'dm').length >= 2)), 'the beat to resolve');
    assert.strictEqual(sa.room.log.filter((e) => e.k === 'you').length, 2);
    if (sa.room.dm.check) {
      assert.ok(!('success' in sa.room.dm.check), 'check outcomes are not sent to clients');
      const pid = sa.room.dm.check.pid;
      const other = pid === a.playerId ? b : a;
      assert.ok(!(await act(other, { t: 'roll' })).ok, 'only the named player rolls');
      await sleep(60);
      assert.ok((await act(pid === a.playerId ? a : b, { t: 'roll' })).ok);
      await until(() => !sa.room.dm.check && sa.room.log.some((e) => e.k === 'roll'), 'the roll');
    }
    await until(() => !sa.room.dm.busy && !sa.room.dm.check && sa.room.dm.queue.length === 0, 'the queued intent to be answered');
    await sleep(80);
    assert.ok((await act(a, { t: 'roll', expr: '2d6+1' })).ok);
    assert.strictEqual((await fetch(`${BASE}/api/tts?code=${a.code}&token=${a.token}&entry=${opened.id}&seg=0`)).status, 404, 'no server voice without a key');
    assert.strictEqual((await fetch(`${BASE}/api/sfx?name=tavern`)).status, 404);

    // Move on: the scripted Dungeon Master starts the first fight.
    await sleep(80);
    await until(() => !sa.room.dm.busy, 'DM idle');
    assert.ok((await act(a, { t: 'intent', kind: 'do', text: 'We set out and continue along the docks' })).ok);
    await until(() => sa.room.phase === 'combat', 'combat to start');
    assert.ok(sa.room.combat.enemies.length >= 2);
    assert.ok(!(await act(b, { t: 'intent', kind: 'do', text: 'run' })).ok, 'only questions go to the DM during combat');
    for (let i = 0; i < 80 && sa.room.phase === 'combat'; i++) {
      const turn = sa.room.combat.turn;
      const foe = sa.room.combat.enemies.find((e) => e.alive);
      await act(turn === a.playerId ? a : b, { t: 'attack', target: foe.id });
      await sleep(70);
    }
    assert.ok(['scene', 'defeat'].includes(sa.room.phase), 'the fight ended');
    if (sa.room.phase === 'defeat') { await sleep(60); assert.ok((await act(a, { t: 'regroup' })).ok); }
    await until(() => sa.room.phase === 'scene' && !sa.room.dm.busy && sa.room.dm.queue.length === 0, 'aftermath narration');
    const beats = sa.room.story.beats;
    assert.ok(beats >= 3);

    // Kick: the seat stops working.
    await sleep(80);
    assert.ok((await act(a, { t: 'kick', pid: b.playerId })).ok);
    await until(() => !sa.room.players[b.playerId], 'the kick');
    assert.ok(!(await act(b, { t: 'chat', text: 'still here?' })).ok);
    sb.close();

    // Restart: the party is restored from disk and the old token still works.
    await sleep(2000);
    sa.close();
    server.kill();
    await sleep(300);
    server = await boot();
    const back = await post('/api/join', { code: a.code, name: 'Aria', token: a.token });
    assert.strictEqual(back.playerId, a.playerId, 'the seat survives a restart');
    const sc = listen(a.code, a.token);
    await until(() => sc.room, 'state after restart');
    assert.strictEqual(sc.room.story.beats, beats);
    assert.strictEqual(sc.room.phase, 'scene');
    sc.close();
    console.log('server ok');
  } finally {
    server.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
})().catch((err) => { console.error('SERVER TEST FAILED:', err); process.exit(1); });
