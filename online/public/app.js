/* AI-DnD Online v2: browser client.
 * Talks to the room through window.Net (public/net.js), plays sound through
 * window.GameAudio (public/audio.js) and reads the rules tables from window.Engine.
 * Every string from players, the DM or the server is untrusted and is only ever
 * placed with textContent (through the h() helper). */
(function () {
  'use strict';
  const E = window.Engine || {};
  const N = window.Net || null;
  const $ = (id) => document.getElementById(id);

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const k in props || {}) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'disabled' || k === 'checked' || k === 'selected' || k === 'hidden') el[k] = !!v;
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    kids.flat(Infinity).forEach((c) => {
      if (c == null || c === false || c === true || c === '') return;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    });
    return el;
  }

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };

  // ---------------- rules tables (read-only, with safe fallbacks) ----------------

  const CLASSES = E.CLASSES || {};
  const ABILITIES = E.ABILITIES || {};
  const ITEMS = E.ITEMS || {};
  const SPELLS = E.SPELLS || {};
  const SHOP = Array.isArray(E.SHOP) ? E.SHOP : [];
  const ABILITY_NAMES = Array.isArray(E.ABILITY_NAMES) ? E.ABILITY_NAMES : ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];
  const ADVENTURES = Array.isArray(E.ADVENTURES) ? E.ADVENTURES : [];
  const MAX_PLAYERS = E.MAX_PLAYERS || 5;
  const IDLE_SKIP_MS = E.IDLE_SKIP_MS || 45000;
  const CHECK_TIMEOUT_MS = E.CHECK_TIMEOUT_MS || 30000;
  const NUDGE_MS = E.DM_STALE_MS || 45000;
  const atkOf = (c) => { try { return E.atkOf(c); } catch (e) { return c.atk; } };
  const defOf = (c) => { try { return E.defOf(c); } catch (e) { return c.def; } };

  const ABILITY_FULL = { STR: 'Strength', DEX: 'Dexterity', CON: 'Constitution', INT: 'Intelligence', WIS: 'Wisdom', CHA: 'Charisma' };
  const AMBIENCE = { tavern: 'Tavern', town: 'Town', forest: 'Forest', cave: 'Cave', dungeon: 'Dungeon', crypt: 'Crypt', mountain: 'Mountain', storm: 'Storm', camp: 'Camp', combat: 'Battle', none: 'Quiet' };
  const MODES = {
    do: { verb: 'does', hint: 'What do you do?', tip: 'Describe what your character does. The Dungeon Master answers.' },
    say: { verb: 'says', hint: 'What do you say?', tip: 'Speak in character. The Dungeon Master and the people in the scene hear it.' },
    ask: { verb: 'asks the DM', hint: 'Ask the DM…', tip: 'Ask the Dungeon Master a question about the scene or the rules.' },
    talk: { verb: 'table talk', hint: 'Talk to the table…', tip: 'Chat with the other players. The Dungeon Master does not read this.' },
  };
  const TONES = [['family', 'Family friendly'], ['classic', 'Classic fantasy'], ['grim', 'Grim']];
  const DIFFS = [['story', 'Story (gentle)'], ['balanced', 'Balanced'], ['hard', 'Hard']];
  const LANGS = ['English', 'Spanish', 'French', 'German', 'Italian', 'Portuguese', 'Dutch', 'Polish', 'Swedish', 'Turkish', 'Japanese', 'Korean', 'Chinese'];
  const FX = { stun: ['Stunned', 'bad'], slow: ['Slowed', 'warn'], weak: ['Weakened', 'warn'], invuln: ['Shielded', 'good'], str: ['Empowered', 'good'], guard: ['Guarding', 'good'] };

  // ---------------- safe wrappers: audio and transport may be partly missing ----------------

  const A = {
    call(name, ...args) {
      try { const g = window.GameAudio; if (g && typeof g[name] === 'function') return g[name](...args); } catch (e) { /* audio must never break the UI */ }
      return undefined;
    },
    has() { return !!window.GameAudio; },
    get() { const v = A.call('get'); return v && typeof v === 'object' ? v : { master: 0.8, voice: 1, ambience: 0.5, effects: 0.7, autoplay: false }; },
    mic() { try { const m = window.GameAudio && window.GameAudio.mic; return m && m.available && typeof m.start === 'function' ? m : null; } catch (e) { return null; } },
  };
  const caps = () => (N && N.caps) || {};
  const netCall = (name, ...args) => { try { return N && typeof N[name] === 'function' ? N[name](...args) : null; } catch (e) { return null; } };
  const isArtifact = () => !!N && N.kind === 'artifact';

  // ---------------- state ----------------

  let state = null;        // latest room snapshot
  let myId = null;
  let session = null;      // { code, token, name, rejoin }
  let netReady = false;
  let connOk = true;
  let busy = false;        // a button action is in flight
  const sel = { enemy: null, ally: null };
  const ui = { tab: 'story', want: 'do', mode: 'do', panel: null, kick: null, give: null, unread: false, pinned: true };
  const logEls = new Map();
  const sigs = {};
  const seen = {};         // local clocks for "since" timers
  let lastLogId = 0;
  let liveLoad = false;    // true once the first snapshot has been painted
  let audioMode;           // last mode given to GameAudio.init
  let ambience;            // last ambience given to GameAudio
  let audioHooked = false;
  let gestured = false;
  let aud = { playing: null, seg: null };
  const narrQ = [];
  let narrLock = 0;
  let leaving = false;     // an explicit Leave is in flight: ignore stream events
  let forcePin = false;    // keep the feed pinned across a tab switch

  const me = () => (state && state.players ? state.players[myId] : null);
  const isHost = () => !!state && state.host === myId;
  const myTurn = () => !!state && state.phase === 'combat' && !!state.combat && state.combat.turn === myId;
  const nameOf = (pid) => { const p = state && state.players[pid]; return p ? p.name : 'someone'; };
  const others = () => (state ? state.order.filter((id) => id !== myId && state.players[id]) : []);
  const canVoice = () => A.has() && !!state && !!state.voice && state.voice !== 'off';

  // Elapsed time for a server-stamped event. Live events are timed on the local
  // clock (immune to clock skew, and never ahead of the server); events already
  // running when the page loaded fall back to the server stamp.
  function sinceSeen(tag, key, stamp) {
    const now = Date.now();
    if (!seen[tag] || seen[tag].key !== key) {
      seen[tag] = { key, t0: liveLoad ? now : Math.min(now, Number(stamp) || now) };
    }
    return now - seen[tag].t0;
  }

  // ---------------- toast, title flash, dialogs ----------------

  let toastTimer = null;
  function toast(msg, kind) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (kind === 'info' ? ' info' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4600);
  }

  const baseTitle = document.title;
  let flashTimer = null;
  function attention(msg) {
    if (!document.hidden) return;
    let on = true;
    document.title = msg;
    clearInterval(flashTimer);
    flashTimer = setInterval(() => { on = !on; document.title = on ? msg : baseTitle; }, 1000);
  }
  function calm() {
    if (flashTimer) { clearInterval(flashTimer); flashTimer = null; }
    if (document.title !== baseTitle) document.title = baseTitle;
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) calm(); });
  window.addEventListener('focus', calm);

  function openDlg(id) {
    const d = $(id);
    if (!d) return;
    try { if (typeof d.showModal === 'function') { if (!d.open) d.showModal(); } else d.setAttribute('open', ''); }
    catch (e) { d.setAttribute('open', ''); }
  }
  function closeDlg(id) {
    const d = $(id);
    if (!d) return;
    try { if (typeof d.close === 'function') d.close(); else d.removeAttribute('open'); }
    catch (e) { d.removeAttribute('open'); }
  }

  async function copyText(text, okMsg, label) {
    try { await navigator.clipboard.writeText(text); toast(okMsg, 'info'); }
    catch (e) { toast(`${label}: ${text}`, 'info'); }
  }

  // ---------------- sending ----------------

  async function act(action) {
    if (!N) return { ok: false, error: 'The game is not connected.' };
    try {
      const r = await N.act(action);
      if (r && r.ok) return r;
      return { ok: false, error: (r && r.error) || 'That did not work. Try again.' };
    } catch (e) { return { ok: false, error: 'Could not reach the table. Check your connection.' }; }
  }

  // Button actions: one at a time (body.busy dims the buttons meanwhile).
  async function send(action) {
    if (busy) return false;
    busy = true;
    document.body.classList.add('busy');
    const r = await act(action);
    busy = false;
    document.body.classList.remove('busy');
    if (!r.ok) toast(r.error);
    return r.ok;
  }

  // ---------------- session ----------------

  function joinNote(msg, soft) {
    const n = $('joinNote');
    n.textContent = msg || '';
    n.className = 'note' + (soft ? ' soft' : '');
  }
  function setJoinBusy(on) { $('createBtn').disabled = $('joinBtn').disabled = !!on; }

  function hashCode() {
    const c = (location.hash || '').replace('#', '').toUpperCase().slice(0, 4);
    return /^[A-Z]{4}$/.test(c) ? c : null;
  }

  function enter(res, name, prior) {
    const keep = prior && prior.code === res.code ? prior.rejoin : null;
    session = { code: res.code, token: res.token, name, rejoin: res.rejoin || keep || null };
    myId = res.playerId;
    store.set('aidnd.session', session);
    try { history.replaceState(null, '', '#' + res.code); } catch (e) { try { location.hash = res.code; } catch (e2) { /* sandboxed */ } }
    joinNote('');
    listen(onLost);
    render();
  }

  function listen(lost) {
    try { N.listen({ code: session.code, token: session.token }, onRoom, lost); }
    catch (e) { leaveLocal('Could not open the table. Try again.', true); }
  }

  async function onLost() {
    const s = session;
    if (!s || leaving) return;
    let again = null;
    try { again = await joinOrRestore(s.code, s.name, s.token); } catch (e) { again = null; }
    if (session !== s || leaving) return;
    if (again && again.token) {
      s.token = again.token;
      if (again.rejoin) s.rejoin = again.rejoin;
      myId = again.playerId;
      store.set('aidnd.session', s);
      listen(() => leaveLocal('The connection to that party was lost. Press Join to go straight back to your seat.', true));
    } else leaveLocal((again && again.error) || 'Could not reach your party. Press Join to try again.', true);
  }

  function leaveLocal(msg, keepSeat) {
    const kept = keepSeat ? session : null;
    leaving = false;
    netCall('stop');
    narrQ.length = 0;
    A.call('stop');
    A.call('setAmbience', 'none');
    ambience = 'none';
    state = null; session = null; myId = null;
    logEls.clear();
    lastLogId = 0; liveLoad = false;
    Object.keys(sigs).forEach((k) => { delete sigs[k]; });
    Object.keys(seen).forEach((k) => { delete seen[k]; });
    $('log').replaceChildren();
    ui.panel = null; ui.kick = null; ui.give = null; ui.unread = false; ui.tab = 'story';
    sel.enemy = null; sel.ally = null;
    // Losing the connection must never lose the seat: keep the token so "Join" brings you straight back.
    if (kept) { store.set('aidnd.session', kept); $('codeInput').value = kept.code; if (kept.name) $('nameInput').value = kept.name; } else store.set('aidnd.session', null);
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
    ['settingsDlg', 'leaveDlg'].forEach(closeDlg);
    calm();
    render();
    joinNote(typeof msg === 'string' ? msg : '');
  }

  // ---------------- party backup ----------------
  // Free hosting can wipe the server's saved parties when it restarts. Every browser keeps the
  // latest copy of its party, and the first player back brings the party back from it.
  let copyTimer = null;
  function keepCopy(room) {
    if (!room || !room.seatKeys || N.kind !== 'server') return;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => store.set('aidnd.room.' + room.code, { at: Date.now(), room }), 800);
  }
  function savedCopy(code) {
    const c = store.get('aidnd.room.' + code);
    return c && c.room && c.room.code === code && Date.now() - c.at < 30 * 86400000 ? c.room : null;
  }
  /** Join, and if the server has forgotten the party, restore it from this browser's copy. */
  async function joinOrRestore(code, name, token) {
    let res = await N.join(code, name, token);
    if (res && res.token) return res;
    const rejoinOnly = /^[A-Z0-9]{6}$/.test(code);
    const s = store.get('aidnd.session');
    const partyCode = rejoinOnly ? (s && s.rejoin === code ? s.code : null) : code;
    const seatToken = rejoinOnly ? (s && s.token) || code : token || (s && s.code === code ? s.token : null);
    const copy = partyCode && seatToken && N.restore ? savedCopy(partyCode) : null;
    if (copy && res && /No party|No seat/.test(res.error || '')) {
      const back = await N.restore(partyCode, name, seatToken, copy);
      if (back && back.token) { toast('The server had restarted, so your party was restored from this device.'); return back; }
      return back;
    }
    return res;
  }

  function onRoom(room) {
    if (!session || !room || leaving) return;
    if (!room.players || !room.players[myId]) { leaveLocal('You are no longer in that party.'); return; }
    const old = state;
    state = room;
    keepCopy(room);
    syncAudio(room);
    detect(old, room);
    render();
    liveLoad = true;
  }

  // ---------------- audio wiring ----------------

  function syncAudio(s) {
    const mode = s.voice || 'off';
    if (mode !== audioMode) {
      audioMode = mode;
      A.call('init', {
        mode,
        ttsUrl: (id, i) => netCall('ttsUrl', id, i),
        sfxUrl: (name) => netCall('sfxUrl', name),
        caps: caps(),
      });
      if (gestured) A.call('unlock');
      if (!audioHooked && A.has()) {
        audioHooked = true;
        A.call('onState', (st) => {
          aud = st && typeof st === 'object' ? st : { playing: null, seg: null };
          if (aud.playing != null) narrLock = 0;
          applyReading();
          if (aud.playing == null) pumpNarr();
        });
      }
    }
    const amb = s.phase === 'combat' ? 'combat' : ((s.scene && s.scene.ambience) || 'none');
    if (amb !== ambience) { ambience = amb; A.call('setAmbience', amb); }
  }

  // DM replies are narrated one after another; GameAudio.narrate itself would
  // let a newer reply cut off an older one, so replies queue here.
  let pumpTimer = null;
  function pumpNarr() {
    if (!narrQ.length) return;
    const wait = narrLock - Date.now();
    if (aud.playing != null || wait > 0) {
      clearTimeout(pumpTimer);
      pumpTimer = setTimeout(pumpNarr, Math.max(300, wait));
      return;
    }
    const e = narrQ.shift();
    narrLock = Date.now() + 1500;
    A.call('narrate', e.id, e.segs);
    if (narrQ.length) { clearTimeout(pumpTimer); pumpTimer = setTimeout(pumpNarr, 1600); }
  }
  function stopNarration() {
    narrQ.length = 0;
    narrLock = 0;
    A.call('stop');
  }

  function segsOf(e) {
    return Array.isArray(e.segs) && e.segs.length ? e.segs : [{ speaker: '', voice: 'narrator', text: e.text || '' }];
  }
  const isNarrator = (s) => !s.speaker || s.voice === 'narrator' || /^(the )?(narrator|dm|dungeon master)$/i.test(String(s.speaker).trim());

  // Compare the new snapshot with the previous one: sounds, narration, title flash.
  function detect(old, s) {
    const log = Array.isArray(s.log) ? s.log : [];
    const fresh = log.filter((e) => e.id > lastLogId);
    fresh.forEach((e) => { if (e.id > lastLogId) lastLogId = e.id; });
    if (!old) return;
    const dmNew = fresh.filter((e) => e.k === 'dm');
    if (fresh.some((e) => e.k === 'roll')) A.call('sfx', 'dice');
    if (dmNew.length) {
      attention('The DM replied · AI-DnD');
      if (canVoice() && A.get().autoplay) {
        dmNew.forEach((e) => narrQ.push({ id: e.id, segs: segsOf(e) }));
        while (narrQ.length > 4) narrQ.shift();
        pumpNarr();
      }
    }
    if (fresh.length && ui.tab !== 'story') ui.unread = true;

    const p = s.players[myId];
    const q = old.players && old.players[myId];
    if (p && q) {
      if (p.level > q.level) A.call('sfx', 'levelup');
      else if (p.hp < q.hp) A.call('sfx', 'hit');
      else if (p.hp > q.hp) A.call('sfx', 'heal');
    }
    const turnNow = s.phase === 'combat' && !!s.combat && s.combat.turn === myId;
    const turnWas = old.phase === 'combat' && !!old.combat && old.combat.turn === myId;
    if (turnNow && !turnWas) { A.call('sfx', 'turn'); attention('Your turn! · AI-DnD'); }
    const ck = s.dm && s.dm.check;
    const ok = old.dm && old.dm.check;
    if (ck && ck.pid === myId && !(ok && ok.pid === myId && ok.at === ck.at)) { A.call('sfx', 'notify'); attention('Roll for it! · AI-DnD'); }
  }

  // ---------------- rendering helpers ----------------

  const pct = (a, b) => Math.max(0, Math.min(100, b ? (a / b) * 100 : 0)) + '%';
  const bar = (cls, a, b) => h('div', { class: 'bar ' + cls }, h('i', { style: { width: pct(a, b) } }));
  const fxTags = (c) => (c.fx || []).map((f) => h('span', { class: 'tag ' + (FX[f.k] || ['', ''])[1] }, (FX[f.k] || [f.k])[0]));
  const cdOf = (p, kind, id) => ((p.cds || {})[kind + ':' + id]) || 0;
  const mod = (score) => { const m = Math.floor((score - 10) / 2); return (m >= 0 ? '+' : '') + m; };

  function btn(label, small, action, opts) {
    opts = opts || {};
    return h('button', {
      type: 'button', class: opts.cls, disabled: opts.disabled, title: opts.title, 'data-k': opts.k || label,
      'aria-expanded': opts.expanded == null ? null : String(!!opts.expanded),
      onclick: typeof action === 'function' ? action : () => send(action),
    }, label, !!small && h('small', null, small));
  }
  function toggleBtn(label, small, panel) {
    const on = ui.panel === panel;
    return btn(label, small, () => { ui.panel = on ? null : panel; render(); }, { cls: on ? 'on' : '', expanded: on });
  }

  // Repaint a region only when its inputs changed; keep typed text and focus.
  function paint(key, box, sig, build) {
    const s = JSON.stringify(sig);
    if (sigs[key] === s) return;
    sigs[key] = s;
    const keyOf = (el) => el.getAttribute('data-keep') || el.getAttribute('data-k');
    const ae = document.activeElement;
    const focusKey = ae && box.contains(ae) ? keyOf(ae) : null;
    const saved = {};
    box.querySelectorAll('[data-keep]').forEach((el) => { saved[el.getAttribute('data-keep')] = { v: el.value, a: el.selectionStart, b: el.selectionEnd }; });
    box.replaceChildren(...[build()].flat(Infinity).filter((x) => x != null && x !== false && x !== true && x !== ''));
    box.querySelectorAll('[data-keep]').forEach((el) => {
      const old = saved[el.getAttribute('data-keep')];
      if (!old) return;
      if (el.tagName === 'SELECT' && !Array.from(el.options).some((o) => o.value === old.v)) return;
      el.value = old.v;
    });
    if (focusKey) {
      const el = Array.from(box.querySelectorAll('[data-keep],[data-k]')).find((x) => keyOf(x) === focusKey);
      if (el && !el.disabled) {
        try { el.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
        const old = saved[focusKey];
        if (old && el.setSelectionRange && old.a != null) { try { el.setSelectionRange(old.a, old.b); } catch (e) { /* not a text field */ } }
      }
    }
  }
  const keepVal = (name) => { const el = document.querySelector(`[data-keep="${name}"]`); return el ? el.value : ''; };
  const keepSet = (name, v) => { const el = document.querySelector(`[data-keep="${name}"]`); if (el) el.value = v; };

  // ---------------- header, tabs, scene ----------------

  function setChip(el, text, cls, title) {
    el.textContent = text;
    el.className = 'chip' + (cls ? ' ' + cls : '');
    if (title) el.title = title; else el.removeAttribute('title');
  }

  function renderConn() {
    const chip = $('connChip');
    chip.className = 'chip conn ' + (connOk ? 'good' : 'bad');
    $('connText').textContent = connOk ? 'Connected' : 'Reconnecting…';
  }

  function renderHeader() {
    $('codeBtn').textContent = state.code;
    setChip($('aiChip'), state.ai ? 'AI DM' : 'Scripted DM', state.ai ? 'good' : '',
      state.ai ? 'A live AI model runs the Dungeon Master.' : 'No AI model is connected, so the built-in scripted Dungeon Master is running.');
    const v = state.voice || 'off';
    const voiced = A.has() && v !== 'off';
    if (voiced && state.voiceIssue) {
      setChip($('voiceChip'), 'Voice problem', 'bad', state.voiceIssue + ' Until then your browser reads the narration.');
      if (ui.voiceIssue !== state.voiceIssue) { ui.voiceIssue = state.voiceIssue; toast('Premium voice unavailable: ' + state.voiceIssue); }
    } else setChip($('voiceChip'), !voiced ? 'Voice off' : v === 'browser' ? 'Browser voice' : 'Voiced', voiced ? (v === 'browser' ? '' : 'good') : '',
      !voiced ? 'Narration is not being read aloud.' : v === 'browser' ? 'Your browser reads the narration aloud. Add an ElevenLabs key on the server for real voices.' : 'The Dungeon Master and characters are voiced.');
    renderConn();
  }

  function renderTabs() {
    const game = $('gameView');
    game.setAttribute('data-tab', ui.tab);
    $('tabs').querySelectorAll('button').forEach((b) => {
      const t = b.getAttribute('data-tab');
      b.setAttribute('aria-pressed', String(t === ui.tab));
      b.classList.toggle('unread', t === 'story' && ui.unread && ui.tab !== 'story');
    });
  }

  function renderScene() {
    const lobby = state.phase === 'lobby';
    $('sceneBox').hidden = lobby;
    if (lobby) return;
    const sc = state.scene || {};
    $('locName').textContent = sc.location || 'Somewhere unknown';
    const amb = state.phase === 'combat' ? 'combat' : (sc.ambience || 'none');
    const chip = $('ambChip');
    chip.textContent = AMBIENCE[amb] || amb;
    chip.className = 'chip amb' + (amb === 'combat' ? ' bad' : '');
    chip.title = 'Ambience: ' + (AMBIENCE[amb] || amb);

    const foes = state.combat && Array.isArray(state.combat.enemies) ? state.combat.enemies : [];
    if (foes.length && !foes.find((e) => e.id === sel.enemy && e.alive)) sel.enemy = (foes.find((e) => e.alive) || {}).id || null;
    paint('foes', $('foes'), [foes, sel.enemy], () => foes.map((e) =>
      h('button', {
        class: ['foe', e.boss && 'boss', !e.alive && 'dead', sel.enemy === e.id && 'sel'].filter(Boolean).join(' '),
        type: 'button', disabled: !e.alive, 'data-k': 'foe-' + e.id, 'aria-pressed': String(sel.enemy === e.id),
        onclick: () => { sel.enemy = e.id; render(); },
      },
      h('span', { class: 'nm' }, e.name),
      bar('hp', e.hp, e.maxHp),
      h('div', { class: 'nums' }, h('span', null, `HP ${e.hp}/${e.maxHp}`), h('span', null, `ATK ${atkOf(e)} DEF ${defOf(e)}`)),
      h('div', { class: 'tags' }, fxTags(e)))));
  }

  // ---------------- lobby ----------------

  function classPicker(p) {
    return h('div', { class: 'classes' }, Object.keys(CLASSES).map((name) => {
      const c = CLASSES[name];
      const eq = c.equip || [];
      const wa = eq[0] && ITEMS[eq[0]] && ITEMS[eq[0]].stats ? ITEMS[eq[0]].stats.attack || 0 : 0;
      const ar = eq[1] && ITEMS[eq[1]] && ITEMS[eq[1]].stats ? ITEMS[eq[1]].stats.defense || 0 : 0;
      const on = !!p && p.cls === name;
      return h('button', {
        class: 'cls' + (on ? ' sel' : ''), type: 'button', 'data-k': 'cls-' + name, 'aria-pressed': String(on),
        onclick: () => { const bio = keepVal('bio').trim(); send(bio ? { t: 'class', cls: name, bio } : { t: 'class', cls: name }); },
      },
      h('b', null, name), h('span', null, c.blurb || ''),
      h('code', null, `HP ${c.hp} · ATK ${(c.atk || 0) + wa} · DEF ${(c.def || 0) + ar}`));
    }));
  }

  function optSelect(label, key, pairs, cur) {
    const list = pairs.some((x) => x[0] === cur) || !cur ? pairs : pairs.concat([[cur, cur]]);
    return h('label', { class: 'field' }, h('span', null, label),
      h('select', { 'data-k': 'opt-' + key, onchange: async (ev) => { if (!(await send({ t: 'opts', [key]: ev.target.value }))) { delete sigs.lobby; render(); } } },
        list.map((x) => h('option', { value: x[0], selected: x[0] === cur }, x[1]))));
  }

  function inviteBlock() {
    const text = netCall('inviteText', state.code) || state.code;
    const art = isArtifact();
    return h('div', { class: 'invite' },
      h('div', { class: 'invite-row' },
        h('span', { class: 'lbl' }, art ? 'Party code' : 'Invite link'),
        h('code', null, text),
        btn('Copy', null, () => copyText(text, art ? 'Party code copied.' : 'Invite link copied.', art ? 'Party code' : 'Invite link'), { k: 'copy-invite' })),
      !!session.rejoin && h('div', { class: 'invite-row' },
        h('span', { class: 'lbl' }, 'Your rejoin code'),
        h('code', null, session.rejoin),
        btn('Copy', null, () => copyText(session.rejoin, 'Rejoin code copied.', 'Rejoin code'), { k: 'copy-rejoin' })),
      !!session.rejoin && h('p', { class: 'hint' }, 'Your rejoin code is yours alone: type it into the code box on another device to get this character back.'));
  }

  function renderLobby() {
    const box = $('lobby');
    const on = state.phase === 'lobby';
    box.hidden = !on;
    if (!on) { delete sigs.lobby; return; }
    paint('lobby', box, [state.players, state.order, state.host, state.opts, state.code, session.rejoin, myId], () => {
      const p = me();
      const o = state.opts || {};
      const host = isHost();
      const hostP = state.players[state.host];
      const seats = state.order.filter((id) => state.players[id]);
      const ready = seats.filter((id) => state.players[id].cls).length;
      const advs = ADVENTURES.some((a) => a.id === 'custom') ? ADVENTURES
        : ADVENTURES.concat([{ id: 'custom', title: 'Your own premise', blurb: 'Describe the adventure you want and the Dungeon Master will run it.' }]);
      const adv = advs.find((a) => a.id === o.adventure);
      const kids = [];

      kids.push(h('h2', null, 'The party gathers'),
        h('ul', { class: 'roster' }, seats.map((id) => {
          const q = state.players[id];
          return h('li', null,
            h('i', { class: 'dot' + (q.online === false ? ' off' : '') }),
            h('b', null, q.name + (id === myId ? ' (you)' : '')),
            id === state.host && h('span', { class: 'tag warn' }, 'Host'),
            h('span', { class: 'tag ' + (q.cls ? 'good' : '') }, q.cls ? `${q.cls} · ready` : 'choosing…'));
        })),
        h('p', { class: 'hint' }, `${seats.length} of ${MAX_PLAYERS} seats taken. Friends can also join after you set out.`));

      kids.push(h('h3', null, p && p.cls ? 'Your class (tap another to change)' : 'Choose your class'), classPicker(p),
        h('div', { class: 'field' },
          h('label', { for: 'bioInput' }, 'Character concept (optional, one line)'),
          h('div', { class: 'row' },
            h('input', { id: 'bioInput', type: 'text', maxlength: 120, 'data-keep': 'bio', value: (p && p.bio) || '', placeholder: 'e.g. a retired smuggler looking for her brother',
              onkeydown: (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); saveBio(); } } }),
            btn('Save', null, saveBio, { k: 'save-bio' }))));

      kids.push(h('h3', null, 'The adventure'));
      if (host) {
        kids.push(h('div', { class: 'classes advs' }, advs.map((a) => h('button', {
          class: 'cls adv' + (o.adventure === a.id ? ' sel' : ''), type: 'button', 'data-k': 'adv-' + a.id, 'aria-pressed': String(o.adventure === a.id),
          onclick: () => send({ t: 'opts', adventure: a.id }),
        }, h('b', null, a.title), h('span', null, a.blurb || '')))));
        if (o.adventure === 'custom') {
          kids.push(h('div', { class: 'field' },
            h('label', { for: 'premiseInput' }, 'Your premise'),
            h('textarea', { id: 'premiseInput', rows: 3, maxlength: 600, 'data-keep': 'premise', value: o.premise || '', placeholder: 'e.g. A flooded city, a missing bell, and a heist on the night of the regatta.' }),
            h('div', { class: 'row' }, btn('Save premise', null, () => send({ t: 'opts', premise: keepVal('premise').trim() }), { k: 'save-premise' }))));
        }
        kids.push(h('div', { class: 'setup' },
          optSelect('Tone', 'tone', TONES, o.tone),
          optSelect('Difficulty', 'difficulty', DIFFS, o.difficulty),
          optSelect('Language', 'lang', LANGS.map((l) => [l, l]), o.lang)));
      } else {
        const label = (pairs, v) => (pairs.find((x) => x[0] === v) || [v, v || '—'])[1];
        kids.push(h('div', { class: 'summary' },
          h('p', null, h('b', null, adv ? adv.title : 'Not chosen yet'), adv && adv.blurb ? ' — ' + adv.blurb : ''),
          o.adventure === 'custom' && !!o.premise && h('p', { class: 'premise' }, o.premise),
          h('p', { class: 'hint' }, `Tone: ${label(TONES, o.tone)} · Difficulty: ${label(DIFFS, o.difficulty)} · Language: ${o.lang || 'English'}`)));
      }

      if (host) {
        kids.push(h('div', { class: 'btns' }, btn('Begin the adventure', `${ready} of ${seats.length} ready`, { t: 'start' }, { cls: 'primary big', disabled: ready === 0 })),
          ready === 0 && h('p', { class: 'hint' }, 'At least one adventurer needs a class before you can begin.'));
      } else {
        kids.push(h('p', { class: 'hint' }, `Waiting for ${hostP ? hostP.name : 'the host'} to begin the adventure.`));
        if (hostP && hostP.online === false) kids.push(h('div', { class: 'btns' }, btn('Claim host', `${hostP.name} is offline`, { t: 'claimhost' })));
      }

      kids.push(h('h3', null, 'Invite your friends'), inviteBlock());
      return kids;
    });
  }

  function saveBio() {
    const p = me();
    if (!p || !p.cls) { toast('Pick a class first, then save your concept.'); return; }
    send({ t: 'class', cls: p.cls, bio: keepVal('bio').trim() });
  }

  // ---------------- DM status and check card ----------------

  function rollButton(label) {
    return h('button', {
      type: 'button', class: 'primary rollbtn', 'data-k': 'roll-check',
      onclick: (ev) => { ev.currentTarget.classList.add('rolling'); A.call('unlock'); send({ t: 'roll' }); },
    }, h('span', { class: 'die', 'aria-hidden': 'true' }), label);
  }

  // Queued intents. Table requests (host note, steer, recap) carry no player and no quoted text.
  const QUEUE_NOTES = { director: ['host note', 'A note from the host for the Dungeon Master'], steer: ['steer', 'A request to move the story on'], recap: ['recap', 'A recap of the story so far'] };
  function queueLine(it) {
    const note = QUEUE_NOTES[it.kind];
    if (note) return h('li', null, h('span', { class: 'tag' }, note[0]), ' ', note[1]);
    if (!it.pid || !state.players[it.pid]) return h('li', null, h('span', { class: 'tag' }, 'table'), ' ', it.text);
    return h('li', null, h('b', null, nameOf(it.pid)), ' ', h('span', { class: 'tag' }, (MODES[it.kind] || MODES.do).verb), ' ', it.text);
  }

  function renderDm() {
    const box = $('dmBox');
    const dm = state.dm || {};
    const lobby = state.phase === 'lobby';
    const busyFor = dm.busy ? sinceSeen('busy', String(dm.busy.seq) + ':' + dm.busy.since, dm.busy.since) : 0;
    const nudge = !!dm.busy && busyFor >= NUDGE_MS;
    const ck = lobby ? null : dm.check;
    const who = ck ? state.players[ck.pid] : null;
    const mine = !!ck && ck.pid === myId;
    const late = !!ck && sinceSeen('check', ck.pid + ':' + ck.at, ck.at) > CHECK_TIMEOUT_MS;
    const open = !!ck && !mine && (!who || who.online === false || late);
    const queue = Array.isArray(dm.queue) ? dm.queue : [];
    const names = state.order.map((id) => [id, nameOf(id)]);

    paint('dm', box, [dm.busy, queue, ck, dm.note, nudge, mine, open, names, lobby], () => {
      const kids = [];
      if (ck) {
        const whoName = who ? who.name : 'a missing adventurer';
        kids.push(h('div', { class: 'check' + (mine ? ' mine' : '') },
          h('div', { class: 'check-head' },
            h('b', null, `${ABILITY_FULL[ck.ability] || ck.ability || 'Ability'} check`),
            h('span', null, mine ? 'for you' : `for ${whoName}`),
            typeof ck.dc === 'number' && h('span', { class: 'dc' }, `DC ${ck.dc}`)),
          !!ck.reason && h('p', null, ck.reason),
          mine ? rollButton('Roll d20')
            : open ? [h('p', { class: 'hint' }, `${whoName} has not rolled. Anyone may roll for them now.`), rollButton(`Roll d20 for ${whoName}`)]
              : h('p', { class: 'hint' }, `Waiting for ${whoName} to roll…`)));
      }
      if (dm.busy) {
        kids.push(h('div', { class: 'thinking' },
          h('span', { class: 'dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
          h('span', null, 'The Dungeon Master is thinking…'),
          h('span', { class: 'elapsed', id: 'dmElapsed' }, ''),
          nudge && btn('Carry on without the AI', null, { t: 'nudge' }, { k: 'nudge' })));
      }
      if (queue.length) {
        kids.push(h('div', { class: 'queue' },
          h('span', { class: 'lbl' }, 'Waiting for the next reply:'),
          h('ul', null, queue.map(queueLine))));
      }
      if (dm.note && !lobby) kids.push(h('p', { class: 'dm-note' }, dm.note));
      return kids;
    });
    const el = $('dmElapsed');
    if (el) el.textContent = dm.busy ? `${Math.max(0, Math.floor(busyFor / 1000))} s` : '';
  }

  // ---------------- dock: scene quick actions, combat, defeat ----------------

  function spellBtn(p, id) {
    const s = SPELLS[id];
    if (!s) return null;
    const cd = cdOf(p, 's', id);
    const friendly = s.spell_type === 'Heal' || s.spell_type === 'Buff';
    const tgt = friendly ? (state.players[sel.ally] ? sel.ally : myId) : sel.enemy;
    const cost = s.mana_cost || 0;
    const to = friendly ? ` → ${tgt === myId ? 'you' : nameOf(tgt)}` : (s.aoe ? ' · all foes' : '');
    return btn(s.name, cd ? `ready in ${cd}` : `${cost} MP${to}`, { t: 'spell', id, target: tgt },
      { disabled: cd > 0 || (p.mana || 0) < cost, title: s.description, k: 'spell-' + id });
  }

  function attemptPanel() {
    const go = async () => {
      const text = keepVal('attempt').trim();
      if (!text) { toast('Describe what you attempt.'); return; }
      const okSent = await send({ t: 'attempt', text, ability: keepVal('attemptAb') || 'DEX', target: sel.enemy });
      if (okSent) { keepSet('attempt', ''); ui.panel = null; render(); }
    };
    return h('div', { class: 'sub' },
      h('p', { class: 'hint' }, 'Describe a stunt against your target and pick the ability it leans on. A d20 decides it.'),
      h('div', { class: 'row' },
        h('input', { type: 'text', maxlength: 160, 'data-keep': 'attempt', 'aria-label': 'Your stunt', placeholder: 'e.g. kick the brazier over onto it',
          onkeydown: (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); go(); } } }),
        h('select', { 'data-keep': 'attemptAb', 'aria-label': 'Ability' }, ABILITY_NAMES.map((a) => h('option', { value: a, selected: a === 'DEX' }, a))),
        btn('Roll d20', null, go, { cls: 'primary', k: 'attempt-go' })));
  }

  function consumables(p) {
    return Object.keys(p.inv || {}).filter((id) => p.inv[id] > 0 && ITEMS[id] && ITEMS[id].type === 'consumable');
  }

  function shopPanel(p) {
    return h('div', { class: 'sub' },
      h('p', { class: 'hint' }, `You have ${p.gold} gold.`),
      h('div', { class: 'btns' }, SHOP.filter((id) => ITEMS[id]).map((id) => {
        const it = ITEMS[id];
        const st = it.stats || {};
        const stat = st.attack ? `+${st.attack} ATK · ` : st.defense ? `+${st.defense} DEF · ` : '';
        return btn(it.name, `${stat}${it.value} gold`, { t: 'buy', item: id }, { disabled: p.gold < it.value, title: it.description, k: 'buy-' + id });
      })));
  }

  function directorPanel() {
    const go = async () => {
      const text = keepVal('director').trim();
      if (!text) { toast('Write a note for the Dungeon Master first.'); return; }
      const okSent = await send({ t: 'director', text });
      if (okSent) { keepSet('director', ''); ui.panel = null; render(); toast('Note sent to the Dungeon Master.', 'info'); }
    };
    return h('div', { class: 'sub' },
      h('p', { class: 'hint' }, 'Host only. An out-of-character instruction to the Dungeon Master: steer the story, change the pace, set a boundary. The other players do not see it as story.'),
      h('textarea', { rows: 2, maxlength: 400, 'data-keep': 'director', 'aria-label': 'Director’s note', placeholder: 'e.g. Wrap up the tavern and get us on the road.' }),
      h('div', { class: 'row' }, btn('Send to the DM', null, go, { cls: 'primary', k: 'director-go' })));
  }

  function renderDock() {
    const box = $('dock');
    const p = me();
    const ph = state.phase;
    if (ph === 'lobby' || !p) { box.hidden = true; delete sigs.dock; return; }
    box.hidden = false;
    const c = state.combat;
    const idle = ph === 'combat' && !!c ? sinceSeen('turn', c.turn + ':' + state.turnSince, state.turnSince) > IDLE_SKIP_MS : false;
    const roster = state.order.map((id) => { const q = state.players[id]; return q ? [id, q.name, q.online] : [id]; });

    paint('dock', box, [ph, p, state.scene, c, ui.panel, sel, idle, state.host, roster], () => {
      const kids = [];
      if (!p.cls) {
        kids.push(h('div', { class: 'turn' }, 'Choose your class to join the story'), classPicker(p));
        return kids;
      }
      if (ph === 'scene') {
        const sc = state.scene || {};
        const heals = (p.spells || []).filter((id) => SPELLS[id] && SPELLS[id].spell_type === 'Heal');
        kids.push(h('div', { class: 'btns qa' },
          btn('Rest', sc.rested ? 'already rested here' : 'once per location', { t: 'rest' }, { disabled: !!sc.rested }),
          !!sc.shop && toggleBtn('Shop', `${p.gold} gold`, 'shop'),
          heals.map((id) => spellBtn(p, id)),
          others().some((id) => !!state.players[id].cls) && btn('Give…', 'item or gold', () => { ui.give = ui.give || { what: 'gold' }; ui.tab = 'pack'; render(); const el = $('sheetBox'); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' }); }),
          btn('Recap', 'the story so far', { t: 'recap' }),
          btn('Steer away', 'move the story on', { t: 'steer' }),
          isHost() && toggleBtn('Director’s note', 'host only', 'director')));
        if (ui.panel === 'shop' && sc.shop) kids.push(shopPanel(p));
        if (ui.panel === 'director' && isHost()) kids.push(directorPanel());
      } else if (ph === 'combat' && c) {
        const cur = state.players[c.turn];
        if (myTurn()) {
          const foe = (c.enemies || []).find((e) => e.id === sel.enemy);
          const ally = state.players[sel.ally] || p;
          const pots = consumables(p);
          kids.push(h('div', { class: 'turn mine' }, `Round ${c.round} — your turn`),
            h('p', { class: 'hint' }, `Target: ${foe ? foe.name : '—'} · Ally: ${ally.id === myId ? 'yourself' : ally.name}`,
              h('span', { class: 'wide' }, '. Tap a foe or a party member to change.')),
            h('div', { class: 'btns' },
              btn('Attack', `ATK ${atkOf(p)}`, { t: 'attack', target: sel.enemy }, { cls: 'primary' }),
              ((CLASSES[p.cls] || {}).abilities || []).filter((id) => ABILITIES[id]).map((id) => {
                const a = ABILITIES[id];
                const cd = cdOf(p, 'a', id);
                return btn(a.name, cd ? `ready in ${cd}` : 'ability', { t: 'ability', id, target: a.target === 'ally' ? (state.players[sel.ally] ? sel.ally : myId) : sel.enemy },
                  { disabled: cd > 0, title: a.desc, k: 'abil-' + id });
              }),
              (p.spells || []).map((id) => spellBtn(p, id)),
              btn('Defend', 'brace this round', { t: 'defend' }),
              btn('End turn', c.left > 0 ? `${c.left} sq. unused` : 'pass', { t: 'endturn' }, { k: 'endturn' }),
              toggleBtn('Improvise…', 'free-form d20', 'attempt'),
              pots.length > 0 && toggleBtn('Items', `${pots.length} usable`, 'items')));
          if (ui.panel === 'attempt') kids.push(attemptPanel());
          if (ui.panel === 'items' && pots.length) {
            kids.push(h('div', { class: 'sub' }, h('div', { class: 'btns' }, pots.map((id) =>
              btn(ITEMS[id].name, `×${p.inv[id]} → ${ally.id === myId ? 'you' : ally.name}`, { t: 'use', item: id, target: ally.id }, { title: ITEMS[id].description, k: 'use-' + id })))));
          }
        } else {
          const canSkip = !!cur && (cur.online === false || idle);
          kids.push(h('div', { class: 'turn' }, `Round ${c.round} — ${cur ? cur.name : '…'}’s turn`),
            h('p', { class: 'hint' }, p.alive ? 'Wait for your turn. You can still ask the DM a question, talk to the table and equip gear.' : 'You are down. An ally can raise you, or you will get up when the fight is won.'));
          if (canSkip) kids.push(h('div', { class: 'btns' }, btn(`Skip ${cur.name}’s turn`, cur.online === false ? 'disconnected' : 'idle', { t: 'skip' }, { k: 'skip' })));
        }
      } else if (ph === 'defeat') {
        kids.push(h('div', { class: 'turn' }, 'The party has fallen'),
          h('p', { class: 'hint' }, 'All is not lost. Regroup to pick yourselves up and carry on.'),
          h('div', { class: 'btns' }, btn('Regroup', null, { t: 'regroup' }, { cls: 'primary' })));
      }
      return kids;
    });
  }

  // ---------------- composer ----------------

  function allowedModes() {
    const p = me();
    if (!state || !p) return ['talk'];
    if (state.phase === 'scene' && p.cls) return ['do', 'say', 'ask', 'talk'];
    if (state.phase === 'combat' && p.cls) return ['ask', 'talk'];
    return ['talk'];
  }

  function renderComposer() {
    const ok = allowedModes();
    ui.mode = ok.includes(ui.want) ? ui.want : ok[0];
    $('modes').querySelectorAll('button').forEach((b) => {
      const m = b.getAttribute('data-mode');
      b.setAttribute('aria-checked', String(m === ui.mode));
      b.disabled = !ok.includes(m);
      b.title = ok.includes(m) ? MODES[m].tip : state.phase === 'combat' ? 'In a fight, use the action buttons. You can still ask the DM.' : 'Not available right now.';
    });
    const ta = $('sayInput');
    ta.placeholder = MODES[ui.mode].hint;
    ta.maxLength = ui.mode === 'talk' ? 300 : 400;
    ta.title = MODES[ui.mode].tip;
    $('sendBtn').textContent = ui.mode === 'ask' ? 'Ask' : ui.mode === 'talk' ? 'Talk' : 'Send';
    $('micBtn').hidden = !A.mic();

    const p = me();
    const chips = state.phase === 'scene' && p && p.cls && state.dm && Array.isArray(state.dm.chips) ? state.dm.chips.slice(0, 3) : [];
    paint('chips', $('chips'), [chips], () => chips.map((text, i) =>
      h('button', { type: 'button', class: 'chipbtn', 'data-k': 'chip-' + i, title: 'Do this', onclick: () => sendChip(text) }, text)));
  }

  async function sendChip(text) {
    if (busy) return;
    const okSent = await send({ t: 'intent', kind: 'do', text });
    if (okSent) { A.call('sfx', 'send'); sayNote(''); }
  }

  function sayNote(msg) { $('sayNote').textContent = msg || ''; }
  // The message box grows with what is typed, up to a few lines.
  function growSay() {
    const ta = $('sayInput');
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight + 2, 150) + 'px';
  }

  function canRollCheck() {
    const ck = state && state.dm && state.dm.check;
    if (!ck) return false;
    if (ck.pid === myId) return true;
    const who = state.players[ck.pid];
    return !who || who.online === false || sinceSeen('check', ck.pid + ':' + ck.at, ck.at) > CHECK_TIMEOUT_MS;
  }

  let sending = false;
  async function submitSay() {
    if (sending || !state) return;
    const ta = $('sayInput');
    const raw = ta.value;
    const text = raw.trim();
    if (!text) return;
    let action;
    if (text[0] === '/') {
      const m = /^\/([a-zA-Z]+)\s*([\s\S]*)$/.exec(text);
      const cmd = m ? m[1].toLowerCase() : '';
      const rest = m ? m[2].trim() : '';
      if (cmd === 'help') { ta.value = ''; growSay(); sayNote(''); openDlg('helpDlg'); return; }
      else if (cmd === 'roll') action = rest ? { t: 'roll', expr: rest } : (canRollCheck() ? { t: 'roll' } : { t: 'roll', expr: '1d20' });
      else if (cmd === 'recap') action = { t: 'recap' };
      else if (cmd === 'ooc') {
        if (!rest) { sayNote('Add your message after /ooc.'); return; }
        action = { t: 'chat', text: rest };
      } else { sayNote(`Unknown command /${cmd}. Try /roll 2d6+3, /recap, /ooc or /help.`); return; }
    } else action = ui.mode === 'talk' ? { t: 'chat', text } : { t: 'intent', kind: ui.mode, text };

    sending = true;
    $('sendBtn').disabled = true;
    const r = await act(action);
    sending = false;
    $('sendBtn').disabled = false;
    if (r.ok) {
      // Clear only what was sent; anything typed while waiting stays.
      if (ta.value === raw) ta.value = '';
      else if (ta.value.startsWith(raw)) ta.value = ta.value.slice(raw.length).replace(/^\s+/, '');
      growSay();
      sayNote('');
      A.call('sfx', 'send');
      ui.pinned = true;
      scrollLogDown();
    } else {
      sayNote(r.error + ' Your text is still here.');
    }
  }

  let micOn = false;
  function setMic(on) {
    micOn = !!on;
    const b = $('micBtn');
    b.setAttribute('aria-pressed', String(micOn));
    b.classList.toggle('on', micOn);
    b.textContent = micOn ? 'Stop' : 'Mic';
  }
  function toggleMic() {
    const mic = A.mic();
    if (!mic) return;
    const ta = $('sayInput');
    if (micOn) { try { mic.stop(); } catch (e) { /* ignore */ } setMic(false); return; }
    const base = ta.value ? ta.value.replace(/\s*$/, ' ') : '';
    try {
      mic.start((text) => { if (typeof text === 'string') { ta.value = (base + text).slice(0, 400); growSay(); } }, () => setMic(false));
      setMic(true);
    } catch (e) { setMic(false); toast('The microphone is not available.'); }
  }

  // ---------------- party, sheet, journal ----------------

  function renderParty() {
    const cur = state.phase === 'combat' && state.combat ? state.combat.turn : null;
    const host = isHost();
    const hostP = state.players[state.host];
    const lobby = state.phase === 'lobby';
    const seats = state.order.filter((id) => state.players[id]);
    paint('party', $('party'), [state.players, state.order, state.host, cur, sel.ally, ui.kick, myId, lobby], () => {
      const kids = seats.map((id) => {
        const p = state.players[id];
        const cls = ['pc', cur === id && 'turn', sel.ally === id && 'sel', p.cls && !p.alive && 'down'].filter(Boolean).join(' ');
        return h('div', { class: cls },
          h('button', { class: 'pc-main', type: 'button', 'data-k': 'pc-' + id, 'aria-pressed': String(sel.ally === id), title: 'Target this ally for heals, items and gifts',
            onclick: () => { sel.ally = sel.ally === id ? null : id; render(); } },
          h('div', { class: 'nm' },
            h('b', null, h('i', { class: 'dot' + (p.online === false ? ' off' : '') }), p.name + (id === myId ? ' (you)' : '')),
            h('span', null, p.cls ? `${p.cls} · Lv ${p.level}` : 'choosing…')),
          !!p.cls && bar('hp', p.hp, p.maxHp),
          !!p.cls && bar('mp', p.mana, p.maxMana),
          !!p.cls && h('div', { class: 'nums' }, h('span', null, `HP ${p.hp}/${p.maxHp}`), h('span', null, `MP ${p.mana}/${p.maxMana}`)),
          h('div', { class: 'tags' },
            id === state.host && h('span', { class: 'tag warn' }, 'Host'),
            p.online === false && h('span', { class: 'tag' }, 'Offline'),
            lobby && h('span', { class: 'tag ' + (p.cls ? 'good' : '') }, p.cls ? 'Ready' : 'Choosing'),
            !!p.cls && !p.alive && h('span', { class: 'tag bad' }, 'Down'),
            cur === id && h('span', { class: 'tag warn' }, 'Acting'),
            sel.ally === id && h('span', { class: 'tag good' }, 'Targeted'),
            fxTags(p))),
          host && id !== myId && h('div', { class: 'pc-tools' },
            ui.kick === id
              ? [h('span', null, `Remove ${p.name} from the party?`),
                btn('Yes, kick', null, async () => { ui.kick = null; await send({ t: 'kick', pid: id }); render(); }, { cls: 'danger', k: 'kick-yes-' + id }),
                btn('No', null, () => { ui.kick = null; render(); }, { k: 'kick-no-' + id })]
              : btn('Kick', null, () => { ui.kick = id; render(); }, { cls: 'ghost', k: 'kick-' + id })));
      });
      if (!host && hostP && hostP.online === false) {
        kids.push(h('div', { class: 'btns' }, btn('Claim host', `${hostP.name} is offline`, { t: 'claimhost' }, { k: 'claimhost' })));
      }
      return kids;
    });
  }

  function givePanel(p) {
    const g = ui.give;
    const people = others().filter((id) => !!state.players[id].cls);
    if (!g || !people.length) return null;
    const items = Object.keys(p.inv || {}).filter((id) => p.inv[id] > 0);
    const go = async () => {
      const to = keepVal('giveTo');
      const what = (ui.give && ui.give.what) || 'gold';
      if (!to) { toast('Choose who receives it.'); return; }
      let action;
      if (what === 'gold') {
        const n = Math.floor(Number(keepVal('giveGold')));
        if (!(n > 0)) { toast('Enter how much gold to give.'); return; }
        action = { t: 'give', to, gold: n };
      } else action = { t: 'give', to, item: what };
      const okSent = await send(action);
      if (okSent) { ui.give = null; render(); }
    };
    return h('div', { class: 'sub give' },
      h('b', null, 'Give to another player'),
      h('div', { class: 'row' },
        h('select', { 'data-k': 'give-what', 'aria-label': 'What to give', onchange: (ev) => { ui.give = { what: ev.target.value }; render(); } },
          h('option', { value: 'gold', selected: g.what === 'gold' }, `Gold (you have ${p.gold})`),
          items.map((id) => h('option', { value: id, selected: g.what === id }, `${(ITEMS[id] || { name: id }).name}${p.inv[id] > 1 ? ' ×' + p.inv[id] : ''}`))),
        g.what === 'gold' && h('input', { type: 'number', min: 1, max: Math.max(1, p.gold), step: 1, 'data-keep': 'giveGold', 'aria-label': 'Gold amount', placeholder: 'amount', inputmode: 'numeric' }),
        h('select', { 'data-keep': 'giveTo', 'aria-label': 'Who receives it' },
          people.map((id) => h('option', { value: id, selected: sel.ally === id }, nameOf(id))))),
      h('div', { class: 'row' },
        btn('Give', null, go, { cls: 'primary', k: 'give-go' }),
        btn('Cancel', null, () => { ui.give = null; render(); }, { k: 'give-cancel' })));
  }

  function renderSheet() {
    const p = me();
    const inCombat = state.phase === 'combat';
    const turn = myTurn();
    const roster = others().filter((id) => !!state.players[id].cls).map((id) => [id, nameOf(id)]);
    paint('sheet', $('sheet'), [p, inCombat, turn, sel.ally, ui.give, roster, state.phase], () => {
      if (!p || !p.cls) return h('p', { class: 'hint' }, 'Choose a class and your sheet appears here.');
      const canUse = !inCombat || turn;
      const canGive = !inCombat && roster.length > 0;
      const ally = state.players[sel.ally] ? sel.ally : myId;
      const eq = p.eq || {};
      const items = Object.keys(p.inv || {}).filter((id) => p.inv[id] > 0).map((id) => {
        const it = ITEMS[id] || { name: id, type: 'misc', stats: {} };
        const equipped = eq.weapon === id || eq.armor === id;
        const st = it.stats || {};
        const stat = st.attack ? ` +${st.attack} ATK` : st.defense ? ` +${st.defense} DEF` : '';
        return h('li', { title: it.description || '' },
          h('span', null, `${it.name}${p.inv[id] > 1 ? ' ×' + p.inv[id] : ''}`, h('small', null, stat + (equipped ? ' · equipped' : ''))),
          h('span', { class: 'inv-btns' },
            it.type === 'consumable' && h('button', { type: 'button', disabled: !canUse, 'data-k': 'use-' + id, title: ally === myId ? 'Use on yourself' : `Use on ${nameOf(ally)}`, onclick: () => send({ t: 'use', item: id, target: ally }) }, 'Use'),
            it.type !== 'consumable' && !!it.equippable && !equipped && h('button', { type: 'button', 'data-k': 'equip-' + id, onclick: () => send({ t: 'equip', item: id }) }, 'Equip'),
            canGive && !equipped && h('button', { type: 'button', class: 'ghost', 'data-k': 'give-' + id, onclick: () => { ui.give = { what: id }; render(); } }, 'Give')));
      });
      const scores = p.scores || {};
      const keep = Array.isArray(p.keep) ? p.keep : [];
      return [
        h('div', { class: 'who' }, h('b', null, p.name), h('span', null, `${p.cls} · Level ${p.level}`)),
        !!p.bio && h('p', { class: 'bio' }, p.bio),
        bar('hp', p.hp, p.maxHp),
        bar('mp', p.mana, p.maxMana),
        h('div', { class: 'stats' },
          h('span', null, 'HP ', h('b', null, `${p.hp}/${p.maxHp}`)), h('span', null, 'MP ', h('b', null, `${p.mana}/${p.maxMana}`)),
          h('span', null, 'ATK ', h('b', null, String(atkOf(p)))), h('span', null, 'DEF ', h('b', null, String(defOf(p)))),
          h('span', null, 'Gold ', h('b', null, String(p.gold))), h('span', null, 'XP ', h('b', null, String(p.xp)))),
        h('div', { class: 'scores' }, ABILITY_NAMES.filter((a) => scores[a] != null).map((a) =>
          h('span', { title: ABILITY_FULL[a] || a }, a, h('b', null, String(scores[a])), h('small', null, mod(scores[a]))))),
        (p.spells || []).length > 0 && h('div', { class: 'tags' }, (p.spells || []).filter((id) => SPELLS[id]).map((id) =>
          h('span', { class: 'tag', title: SPELLS[id].description || '' }, SPELLS[id].name))),
        h('ul', { class: 'inv' }, items.length ? items : h('li', null, h('small', null, 'Your pack is empty.'))),
        keep.length > 0 && h('div', { class: 'keep' }, h('span', { class: 'lbl' }, 'Keepsakes'), h('ul', null, keep.map((k) => h('li', null, k)))),
        canGive && !ui.give && h('div', { class: 'row' }, btn('Give gold or an item…', null, () => { ui.give = { what: 'gold' }; render(); }, { k: 'give-open' })),
        canGive && givePanel(p),
      ];
    });
  }

  function renderJournal() {
    const st = state.story || {};
    const quests = Array.isArray(st.quests) ? st.quests : [];
    const npcs = Array.isArray(st.npcs) ? st.npcs : [];
    const facts = Array.isArray(st.facts) ? st.facts : [];
    paint('journal', $('journal'), [quests, npcs, facts], () => {
      if (!quests.length && !npcs.length && !facts.length) return h('p', { class: 'hint' }, 'Nothing yet. Quests, the people you meet and what you learn are written down here as the story unfolds.');
      const rank = { active: 0, done: 1, failed: 2 };
      const qs = quests.slice().sort((a, b) => (rank[a.status] || 0) - (rank[b.status] || 0));
      const moodCls = { friendly: 'good', hostile: 'bad', neutral: '' };
      const qCls = { active: 'warn', done: 'good', failed: 'bad' };
      return [
        qs.length > 0 && h('div', { class: 'jsec' }, h('span', { class: 'lbl' }, 'Quests'), h('ul', null, qs.map((q) =>
          h('li', { class: 'q-' + (q.status || 'active') }, h('b', null, q.title), ' ', h('span', { class: 'tag ' + (qCls[q.status] || '') }, q.status || 'active'), !!q.note && h('p', null, q.note))))),
        npcs.length > 0 && h('div', { class: 'jsec' }, h('span', { class: 'lbl' }, 'People'), h('ul', null, npcs.map((n) =>
          h('li', null, h('b', null, n.name), ' ', !!n.mood && h('span', { class: 'tag ' + (moodCls[n.mood] || '') }, n.mood), !!n.note && h('p', null, n.note))))),
        facts.length > 0 && h('div', { class: 'jsec' }, h('span', { class: 'lbl' }, 'What you know'), h('ul', { class: 'facts' }, facts.map((f) => h('li', null, f)))),
      ];
    });
  }

  // ---------------- story feed ----------------

  function logLine(e, voiceOn) {
    if (e.k === 'dm') {
      const segs = segsOf(e);
      return h('article', { class: 'dm' },
        !!e.title && h('h4', null, e.title),
        segs.map((s, i) => (isNarrator(s)
          ? h('p', { class: 'seg', 'data-seg': i }, s.text)
          : h('p', { class: 'seg npc', 'data-seg': i }, h('b', null, s.speaker), s.text))),
        h('div', { class: 'dm-foot' },
          h('span', { class: 'mark' + (e.ai ? ' ai' : ''), title: e.ai ? 'Written by the AI Dungeon Master' : 'Written by the built-in scripted Dungeon Master' }, e.ai ? 'AI' : 'scripted'),
          voiceOn && h('button', { type: 'button', class: 'replay', 'aria-label': 'Read this reply aloud', onclick: () => replay(e.id, segs) }, 'Read aloud')));
    }
    if (e.k === 'you') {
      const m = MODES[e.mode] || MODES.do;
      return h('p', { class: 'you mode-' + (MODES[e.mode] ? e.mode : 'do') }, h('b', null, e.who || 'Someone'), h('span', { class: 'tag' }, m.verb), e.text);
    }
    if (e.k === 'chat') return h('p', { class: 'chat-line' }, h('b', null, (e.who || 'Someone') + ': '), e.text);
    if (e.k === 'roll') return h('p', { class: 'roll' }, h('span', { class: 'die', 'aria-hidden': 'true' }), h('span', null, e.text));
    return h('p', { class: e.k === 'foe' ? 'foe-line' : e.k === 'act' ? 'act' : 'sys' }, e.text);
  }

  function replay(id, segs) {
    A.call('unlock');
    if (aud.playing != null && String(aud.playing) === String(id)) { stopNarration(); return; }
    narrQ.length = 0;
    narrLock = Date.now() + 1500;
    A.call('narrate', id, segs);
  }

  function applyReading() {
    const log = $('log');
    if (!log) return;
    log.querySelectorAll('.reading').forEach((el) => {
      el.classList.remove('reading');
      const b = el.querySelector('.replay');
      if (b) b.textContent = 'Read aloud';
    });
    log.querySelectorAll('.now').forEach((el) => el.classList.remove('now'));
    if (aud.playing == null) return;
    const rec = logEls.get(aud.playing) || logEls.get(Number(aud.playing)) || logEls.get(String(aud.playing));
    if (!rec) return;
    rec.el.classList.add('reading');
    const b = rec.el.querySelector('.replay');
    if (b) b.textContent = 'Stop';
    if (aud.seg != null) {
      const seg = rec.el.querySelectorAll('.seg')[Number(aud.seg)];
      if (seg) seg.classList.add('now');
    }
  }

  const logPinned = () => { const log = $('log'); return log.scrollHeight - log.scrollTop - log.clientHeight < 80; };
  function scrollLogDown() {
    const log = $('log');
    log.scrollTop = log.scrollHeight;
    $('jumpBtn').hidden = true;
  }

  function renderLog() {
    const log = $('log');
    const pinned = forcePin || ui.pinned;
    forcePin = false;
    const voiceOn = canVoice();
    const live = new Set();
    let added = 0;
    (Array.isArray(state.log) ? state.log : []).forEach((e) => {
      live.add(e.id);
      const key = [e.k, e.text, e.ai ? 1 : 0, e.title || '', e.segs ? e.segs.length : 0, voiceOn ? 1 : 0, e.who || '', e.mode || ''].join('|');
      const old = logEls.get(e.id);
      if (old && old.key === key) return;
      const el = logLine(e, voiceOn);
      if (old) old.el.replaceWith(el);
      else { log.append(el); added++; if (liveLoad) el.classList.add('fresh'); }
      logEls.set(e.id, { el, key });
    });
    for (const [id, v] of logEls) if (!live.has(id)) { v.el.remove(); logEls.delete(id); }
    if (pinned) { ui.pinned = true; scrollLogDown(); }
    else if (added) $('jumpBtn').hidden = false;
    if (added) applyReading();
  }

  // ---------------- top-level render ----------------

  function render() {
    const inGame = !!(session && state);
    $('joinView').hidden = inGame;
    $('gameView').hidden = !inGame;
    $('topMeta').hidden = !inGame;
    document.body.classList.toggle('in-game', inGame);
    document.body.classList.toggle('playing', inGame && state.phase !== 'lobby');
    document.body.classList.toggle('combat', inGame && state.phase === 'combat');
    if (!inGame) {
      if (session && !state) joinNote('Joining…', true);
      return;
    }
    if (ui.give && state.phase === 'combat') ui.give = null;
    renderHeader(); renderTabs(); renderScene(); renderLobby(); renderDm(); renderDock();
    renderComposer(); renderParty(); renderSheet(); renderJournal(); renderLog();
  }

  // ---------------- settings and export ----------------

  function applyTextSize(n) {
    const v = n != null && [0, 1, 2].includes(Number(n)) ? Number(n) : 1;
    document.documentElement.setAttribute('data-ts', String(v));
    $('textSize').querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(Number(b.getAttribute('data-size')) === v)));
    return v;
  }

  function canExport() {
    if (!state) return false;
    if (!isArtifact()) return true;
    const d = caps().downloads;
    return !!d && typeof d.save === 'function';
  }

  function openSettings() {
    const vols = A.get();
    const hasAudio = A.has();
    document.querySelectorAll('#settingsDlg [data-vol]').forEach((el) => {
      const v = Number(vols[el.getAttribute('data-vol')]);
      el.value = String(Math.round((isFinite(v) ? v : 0.7) * 100));
      el.disabled = !hasAudio;
    });
    $('autoplayBox').checked = !!vols.autoplay;
    $('autoplayBox').disabled = !hasAudio;
    $('audioNote').hidden = hasAudio;
    $('exportBtn').hidden = !canExport();
    const rj = session && session.rejoin;
    $('seatSet').hidden = !rj;
    $('rejoinCode').textContent = rj || '';
    openDlg('settingsDlg');
  }

  function storyMarkdown() {
    const s = state;
    const L = [];
    const adv = ADVENTURES.find((a) => a.id === (s.opts || {}).adventure);
    L.push(`# ${adv ? adv.title : 'An AI-DnD Online adventure'}`, '', `Party ${s.code} · exported ${new Date().toISOString().slice(0, 10)}`, '', '## The party', '');
    s.order.forEach((id) => {
      const p = s.players[id];
      if (p) L.push(`- **${p.name}**${p.cls ? ` — ${p.cls}, level ${p.level}` : ''}${p.bio ? `: ${p.bio}` : ''}`);
    });
    const quests = (s.story && Array.isArray(s.story.quests)) ? s.story.quests : [];
    if (quests.length) {
      L.push('', '## Quests', '');
      quests.forEach((q) => L.push(`- **${q.title}** (${q.status || 'active'})${q.note ? `: ${q.note}` : ''}`));
    }
    L.push('', '## The story', '');
    (Array.isArray(s.log) ? s.log : []).forEach((e) => {
      if (e.k === 'dm') {
        if (e.title) L.push(`### ${e.title}`, '');
        segsOf(e).forEach((sg) => L.push(isNarrator(sg) ? sg.text : `**${sg.speaker}:** ${sg.text}`, ''));
      } else if (e.k === 'you') L.push(`> **${e.who || 'Someone'}** (${(MODES[e.mode] || MODES.do).verb}): ${e.text}`, '');
      else if (e.k === 'roll') L.push(`*Dice: ${e.text}*`, '');
      else if (e.k === 'act' || e.k === 'foe') L.push(`- ${e.text}`, '');
    });
    return L.join('\n') + '\n';
  }

  async function exportStory() {
    if (!state) return;
    const data = storyMarkdown();
    const filename = `ai-dnd-${String(state.code).toLowerCase()}-story.md`;
    if (isArtifact()) {
      const d = caps().downloads;
      if (!d || typeof d.save !== 'function') return;
      try { await d.save({ filename, data }); toast('Story saved.', 'info'); }
      catch (e) { toast('The story could not be saved.'); }
      return;
    }
    try {
      const url = URL.createObjectURL(new Blob([data], { type: 'text/markdown;charset=utf-8' }));
      const a = h('a', { href: url, download: filename, hidden: true });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) { toast('The story could not be exported.'); }
  }

  // ---------------- join screen ----------------

  // The code box takes a four-letter party code, or a rejoin code. A bare rejoin code is
  // sent as the code itself (the transport finds the seat by it) and as the join token;
  // "ABCD-XXXXXX" or "ABCD XXXXXX" sends the party code plus the rejoin code as the token.
  function parseCodeBox(raw) {
    const v = String(raw || '').trim();
    const link = /#([A-Za-z]{4})$/.exec(v);
    if (link) return { code: link[1].toUpperCase() };
    if (/^[A-Za-z]{4}$/.test(v)) return { code: v.toUpperCase() };
    const both = /^([A-Za-z]{4})[\s\-:_/.#]+([A-Za-z0-9]{5,})$/.exec(v);
    if (both) return { code: both[1].toUpperCase(), token: both[2].toUpperCase() };
    if (/^[A-Za-z0-9]{5,}$/.test(v)) return { code: v.toUpperCase(), token: v.toUpperCase() };
    return { error: 'Enter the four-letter party code your friend shared, or your own rejoin code.' };
  }

  async function start(create) {
    if (!N || !netReady) { joinNote('Still connecting. Try again in a moment.'); return; }
    const name = $('nameInput').value.trim();
    if (!name) { joinNote('Give your adventurer a name first.'); $('nameInput').focus(); return; }
    const saved = store.get('aidnd.session');
    let code = null;
    let token;
    if (!create) {
      const parsed = parseCodeBox($('codeInput').value);
      if (parsed.error) { joinNote(parsed.error); $('codeInput').focus(); return; }
      code = parsed.code;
      token = parsed.token || (saved && saved.code === code ? saved.token : undefined);
    }
    joinNote(create ? 'Setting the table…' : 'Joining…', true);
    setJoinBusy(true);
    try {
      const res = create ? await N.create(name) : await joinOrRestore(code, name, token);
      if (res && res.token) enter(res, name, saved);
      else {
        // A stored seat that the table no longer knows must not block joining afresh.
        if (!create && saved && saved.code === code && token === saved.token) store.set('aidnd.session', null);
        joinNote((res && res.error) || 'Could not reach the table. Try again.');
      }
    } catch (e) { joinNote('Could not reach the table. Check your connection.'); }
    setJoinBusy(false);
  }

  async function boot() {
    applyTextSize(store.get('aidnd.textsize'));
    const hash = hashCode();
    const saved = store.get('aidnd.session');
    if (saved && saved.name) $('nameInput').value = saved.name;
    if (hash) $('codeInput').value = hash;
    if (!N) { joinNote('The game could not load. Reload the page to try again.'); setJoinBusy(true); return; }
    joinNote('Connecting…', true);
    setJoinBusy(true);
    try { await Promise.resolve(N.ready); }
    catch (e) { joinNote((e && e.message) || 'The shared table is not available in this view.'); return; }
    netReady = true;
    setJoinBusy(false);
    joinNote('');
    netCall('onConn', (ok) => { connOk = !!ok; if (session && state) renderConn(); });
    if (isArtifact()) {
      const hint = $('modeHint');
      hint.textContent = 'Playing inside Claude: everyone opens this same page and uses the party code. Friends need a Claude account and access to this page to take a seat.';
      hint.hidden = false;
    }
    if (saved && saved.code && saved.token && (!hash || hash === saved.code)) {
      joinNote('Rejoining your party…', true);
      let res = null;
      let failed = false;
      try { res = await joinOrRestore(saved.code, saved.name, saved.token); } catch (e) { failed = true; }
      if (res && res.token) { enter(res, saved.name, saved); return; }
      if (failed) joinNote('Could not reach your party. Check your connection and reload to try again.');
      else { joinNote((res && res.error) || ''); $('codeInput').value = (saved.rejoin) || hash || ''; }
    }
  }

  // ---------------- wiring ----------------

  const onEnter = (el, fn) => el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); fn(); } });

  $('createBtn').addEventListener('click', () => start(true));
  $('joinBtn').addEventListener('click', () => start(false));
  onEnter($('nameInput'), () => start(!$('codeInput').value.trim()));
  onEnter($('codeInput'), () => start(false));
  $('howBtn').addEventListener('click', () => openDlg('helpDlg'));

  $('codeBtn').addEventListener('click', () => {
    if (!state) return;
    const text = netCall('inviteText', state.code) || state.code;
    copyText(text, isArtifact() ? 'Party code copied.' : 'Invite link copied.', isArtifact() ? 'Party code' : 'Invite link');
  });
  $('settingsBtn').addEventListener('click', openSettings);
  $('leaveBtn').addEventListener('click', () => openDlg('leaveDlg'));
  $('leaveYes').addEventListener('click', async () => {
    $('leaveYes').disabled = true;
    leaving = true;
    await act({ t: 'leave' });
    $('leaveYes').disabled = false;
    leaveLocal('You left the party.');
  });
  $('helpBtn').addEventListener('click', () => openDlg('helpDlg'));
  $('exportBtn').addEventListener('click', exportStory);
  $('rejoinCopy').addEventListener('click', () => { if (session && session.rejoin) copyText(session.rejoin, 'Rejoin code copied.', 'Rejoin code'); });

  document.querySelectorAll('dialog').forEach((d) => {
    d.addEventListener('click', (ev) => { if (ev.target === d) closeDlg(d.id); });
    d.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeDlg(d.id)));
  });
  document.querySelectorAll('#settingsDlg [data-vol]').forEach((el) => {
    el.addEventListener('input', () => A.call('set', { [el.getAttribute('data-vol')]: Number(el.value) / 100 }));
  });
  $('autoplayBox').addEventListener('change', (ev) => A.call('set', { autoplay: !!ev.target.checked }));
  $('textSize').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-size]');
    if (b) store.set('aidnd.textsize', applyTextSize(b.getAttribute('data-size')));
  });

  $('tabs').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-tab]');
    if (!b || !state) return;
    ui.tab = b.getAttribute('data-tab');
    if (ui.tab === 'story') { ui.unread = false; forcePin = ui.pinned; }
    render();
  });
  $('modes').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-mode]');
    if (!b || b.disabled || !state) return;
    ui.want = b.getAttribute('data-mode');
    renderComposer();
    $('sayInput').focus();
  });
  $('sayInput').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); submitSay(); }
  });
  $('sayInput').addEventListener('input', growSay);
  $('sendBtn').addEventListener('click', submitSay);
  $('micBtn').addEventListener('click', toggleMic);
  $('log').addEventListener('scroll', () => {
    if ($('log').clientHeight === 0) return;
    ui.pinned = logPinned();
    if (ui.pinned) $('jumpBtn').hidden = true;
  });
  $('jumpBtn').addEventListener('click', () => { ui.pinned = true; scrollLogDown(); });
  // The feed is resized by the status cards under it: stay on the newest line when pinned.
  if (typeof ResizeObserver === 'function') {
    try { new ResizeObserver(() => { if (ui.pinned && $('log').clientHeight > 0) scrollLogDown(); }).observe($('log')); } catch (e) { /* optional */ }
  }

  const gesture = () => { if (!gestured) { gestured = true; A.call('unlock'); } };
  ['pointerdown', 'keydown', 'touchstart'].forEach((t) => document.addEventListener(t, gesture, { passive: true }));
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') stopNarration(); });

  // Once a second: the DM timer, and time-based buttons (nudge, roll for an absent player, skip).
  setInterval(() => {
    if (!session || !state) return;
    renderDm();
    if (state.phase === 'combat') renderDock();
  }, 1000);

  boot();
})();
