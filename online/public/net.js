/* AI-DnD Online — network layer (window.Net).
 *
 * Two transports behind one interface:
 *   server   — the Node server: Server-Sent Events for state, POST for actions.
 *              The server runs the Dungeon Master and the voices.
 *   artifact — the page published as a Claude artifact: one shared document
 *              per party in the artifact's db, and the Dungeon Master runs in
 *              the browser of whichever player's action opened the beat, using
 *              that viewer's own Claude through the `sample` capability.
 */
(function () {
  'use strict';
  const E = window.Engine;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };
  const connSubs = [];
  let connected = null;
  function setConn(ok) { if (ok === connected) return; connected = ok; connSubs.forEach((cb) => { try { cb(ok); } catch (e) { /* ignore */ } }); }
  const Net = { kind: 'server', me: null, caps: { tts: null, dictation: null, downloads: null }, onConn(cb) { connSubs.push(cb); if (connected != null) cb(connected); } };

  // Extra listeners for room state (the visual tabletop uses this): cb(room | null, myPlayerId).
  const roomSubs = [];
  const emitRoom = (room) => roomSubs.forEach((cb) => { try { cb(room, Net.me); } catch (e) { /* a listener must never break the game */ } });
  Net.onRoom = (cb) => { roomSubs.push(cb); };
  function wrap() {
    const { create, join, listen, stop } = Net;
    const seat = (r) => { if (r && r.playerId) Net.me = r.playerId; return r; };
    Net.create = async (name) => seat(await create(name));
    Net.join = async (code, name, token) => seat(await join(code, name, token));
    Net.listen = (session, onState, onLost) => listen(session, (room) => { onState(room); emitRoom(room); }, onLost);
    Net.stop = () => { stop(); emitRoom(null); };
  }

  // ---------------------------------------------------------------- server

  function useServer() {
    let es = null, creds = null;
    const post = async (url, body) => {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return res.json().catch(() => ({ ok: false, error: 'The server gave an unreadable answer.' }));
    };
    Object.assign(Net, {
      kind: 'server',
      create: (name) => post('/api/create', { name }),
      join: (code, name, token) => post('/api/join', { code, name, token }),
      listen(session, onState, onLost) {
        creds = session;
        if (es) es.close();
        es = new EventSource(`/api/events?code=${encodeURIComponent(session.code)}&token=${encodeURIComponent(session.token)}`);
        es.onopen = () => setConn(true);
        es.onmessage = (ev) => { setConn(true); onState(JSON.parse(ev.data)); };
        es.onerror = () => { setConn(false); if (es && es.readyState === 2) onLost(); };
      },
      act: (action) => (creds ? post('/api/action', { code: creds.code, token: creds.token, action }) : Promise.resolve({ ok: false, error: 'Not in a party.' })),
      stop() { if (es) es.close(); es = null; creds = null; },
      inviteText: (code) => `${location.origin}${location.pathname}#${code}`,
      ttsUrl: (entryId, seg) => (creds ? `/api/tts?code=${encodeURIComponent(creds.code)}&token=${encodeURIComponent(creds.token)}&entry=${encodeURIComponent(entryId)}&seg=${encodeURIComponent(seg)}` : null),
      sfxUrl: (name) => `/api/sfx?name=${encodeURIComponent(name)}`,
    });
    wrap();
    return Promise.resolve();
  }

  // ---------------------------------------------------------------- artifact

  async function useArtifact(claude) {
    const [db, sample, tts, dictation, downloads] = await Promise.all(['db', 'sample', 'tts', 'dictation', 'downloads'].map((n) => claude.use(n).catch(() => null)));
    if (!db) throw { message: 'Sign in to Claude to play: the shared table is not available in this view.' };
    Net.caps = { tts, dictation, downloads };
    const myId = store.get('aidnd.id') || 'p' + Math.random().toString(36).slice(2, 12);
    store.set('aidnd.id', myId);
    const tab = myId + '-' + Math.random().toString(36).slice(2, 8);   // lease holder: one per open page
    let code = null, unsub = null, aiOn = !!sample, latest = null, running = false, watch = null, evicted = null;
    const ref = (c) => db.doc('rooms/' + c);
    const clone = (o) => JSON.parse(JSON.stringify(o));
    const AI_OFF = ['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed', 'session_expired'];

    /** Read-modify-write one room under a short cooperative lease. */
    async function mutate(c, fn) {
      let held = false;
      for (let i = 0; i < 14 && !held; i++) {
        held = (await ref(c).acquire({ holder: tab, ttlMs: 2000 })).acquired;
        if (!held) await sleep(180 + Math.random() * 260);
      }
      if (!held) return { ok: false, error: 'The table is busy. Try again.' };
      const snap = await ref(c).get();
      const data = snap.exists ? snap.data() : null;
      const room = data && data.state ? clone(data.state) : null;
      const out = fn(room);
      if (out && out.ok && out.room) await ref(c).set({ state: out.room });
      return out;
    }
    const explain = (e) => ({ ok: false, error: e && e.code === 'invalid_argument'
      ? 'You can watch but not play here yet. Ask the page owner to invite you by email as an Editor (and to keep public-link sharing off).'
      : 'Could not reach the shared table. Try again.' });

    /** Run Dungeon Master beats until none is waiting. Only one tab wins each beat. */
    async function runDM() {
      if (running || !code) return;
      running = true;
      const c = code;
      try {
        for (let n = 0; n < 6; n++) {
          let req = null;
          await mutate(c, (room) => {
            if (!room) return { ok: false };
            req = E.dmBegin(room, tab);
            return req ? { ok: true, room } : { ok: false };
          });
          if (!req) break;
          let reply = null, why = null;
          if (aiOn) {
            try { reply = await sample.json(req.system + '\n\n' + req.user, { modelTier: 'quick', cache: false }); } catch (e) {
              why = e && e.code;
              if (AI_OFF.includes(why)) aiOn = false;
            }
          } else await sleep(350);
          await mutate(c, (room) => {
            if (!room) return { ok: false };
            room.ai = aiOn;
            let r = reply ? E.dmApply(room, req.seq, reply, { ai: true }) : { invalid: true };
            if (r.invalid) r = E.dmFallback(room, req.seq, why);
            return r.ok ? { ok: true, room } : { ok: false };
          });
        }
      } catch (e) { /* the watchdog in another tab, or the next action, recovers */ }
      running = false;
    }

    /** Keep the table moving when the tab that should have acted is gone. */
    function watchdog() {
      const room = latest;
      if (!room || !code) return;
      const now = Date.now();
      if (room.dm.busy && room.dm.busy.by !== tab && now - room.dm.busy.since > 60000) {
        const seq = room.dm.busy.seq;
        mutate(code, (r) => (r && E.dmFallback(r, seq).ok ? { ok: true, room: r } : { ok: false })).catch(() => {});
      } else if (room.dm.busy && room.dm.busy.by === tab && !running && now - room.dm.busy.since > 20000) {
        const seq = room.dm.busy.seq;   // this tab reloaded mid-call
        mutate(code, (r) => (r && E.dmFallback(r, seq).ok ? { ok: true, room: r } : { ok: false })).catch(() => {});
      } else if (E.dmNeeded(room)) setTimeout(runDM, Math.random() * 500);
      else if (room.dm.check && now - room.dm.check.at > E.CHECK_TIMEOUT_MS + 8000 && room.players[myId]) Net.act({ t: 'roll' });
    }

    Object.assign(Net, {
      kind: 'artifact',
      async create(name) {
        try {
          for (let tries = 0; tries < 5; tries++) {
            const c = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]).join('');
            const out = await mutate(c, (room) => {
              if (room) return { ok: false, taken: true };
              const fresh = E.newRoom(c);
              E.addPlayer(fresh, myId, name);
              return { ok: true, room: fresh };
            });
            if (out.ok) return { code: c, playerId: myId, token: myId, rejoin: '' };
            if (!out.taken) return { error: out.error };
          }
          return { error: 'Could not create a party. Try again.' };
        } catch (e) { return { error: explain(e).error }; }
      },
      async join(c, name, token) {
        c = String(c || '').toUpperCase();
        if (token && evicted === c) return { error: 'You are no longer in this party.' };
        try {
          const out = await mutate(c, (room) => {
            if (!room) return { ok: false, error: `No party with the code ${c}. Check the code, or create a new party.` };
            const r = E.addPlayer(room, myId, name);
            return r.ok ? { ok: true, room } : r;
          });
          return out.ok ? { code: c, playerId: myId, token: myId, rejoin: '' } : { error: out.error };
        } catch (e) { return { error: explain(e).error }; }
      },
      listen(session, onState, onLost) {
        code = session.code;
        if (unsub) unsub();
        clearInterval(watch);
        const timer = setTimeout(() => setConn(false), 10000);
        unsub = ref(code).onSnapshot((snap) => {
          const data = snap.exists ? snap.data() : null;
          if (!data || !data.state) return;
          clearTimeout(timer); setConn(true);
          const room = clone(data.state);
          if (!room.players[myId]) { evicted = code; onLost(); return; }
          room.ai = aiOn; room.voice = 'artifact';
          latest = room;
          onState(room);
        }, () => { clearTimeout(timer); setConn(false); });
        watch = setInterval(watchdog, 5000);
      },
      async act(action) {
        if (!code) return { ok: false, error: 'Not in a party.' };
        try {
          const out = await mutate(code, (room) => {
            if (!room) return { ok: false, error: 'This party no longer exists.' };
            const r = E.act(room, myId, action);
            return r.ok ? { ok: true, room } : r;
          });
          if (out.ok) runDM();
          return { ok: !!out.ok, error: out.error };
        } catch (e) { return explain(e); }
      },
      stop() { if (unsub) unsub(); unsub = null; clearInterval(watch); code = null; latest = null; },
      inviteText: (c) => c,
      ttsUrl: () => null,
      sfxUrl: () => null,
    });
    wrap();
  }

  Net.ready = (window.claude && typeof window.claude.use === 'function' ? useArtifact(window.claude) : useServer());
  Net.ready.catch(() => {});
  window.Net = Net;
})();
