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

  // ---------------- characters: races, backgrounds, looks (from the engine, with fallbacks) ----------------

  const DATA = window.DND_DATA || {};
  const own = (o, k) => o != null && typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
  const RACES = E.RACES || { Human: { bonus: { STR: 1, DEX: 1, CON: 1, INT: 1, WIS: 1, CHA: 1 }, trait: 'Versatile', desc: '+1 to every ability score.' } };
  const BACKGROUNDS = E.BACKGROUNDS || {};
  const LOOK = E.LOOK || {};
  const STD_ARRAY = Array.isArray(E.STANDARD_ARRAY) ? E.STANDARD_ARRAY : [15, 14, 13, 12, 10, 8];
  const POINT_COST = E.POINT_COST || { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };
  const POINTS = 27;
  const RACE_NOTE = {
    Human: 'Ambitious, adaptable and found everywhere.',
    Elf: 'Graceful and long-lived, with eyes for the dark.',
    Dwarf: 'Stout, stubborn and hard as the mountain.',
    Halfling: 'Small, cheerful and improbably lucky.',
    'Half-Orc': 'Fierce, strong and very hard to put down.',
    Tiefling: 'Horned heirs of an infernal bargain.',
    Dragonborn: 'Proud draconic kin with fire in their lungs.',
    Gnome: 'Tiny, clever tinkerers and tricksters.',
  };
  const ABILITY_USE = { STR: 'melee blows, lifting, forcing doors', DEX: 'aim, stealth, quick hands', CON: 'hit points and grit', INT: 'lore, arcana, puzzles; mana', WIS: 'perception, insight, survival; mana', CHA: 'persuasion, deceit, presence; mana' };
  const LOOK_ORDER = ['frame', 'body', 'skin', 'hair', 'hairStyle', 'beard', 'eyes', 'outfit', 'accent', 'mark'];
  const LOOK_LABEL = { frame: 'Frame', body: 'Build', skin: 'Skin', hair: 'Hair colour', hairStyle: 'Hair style', beard: 'Beard', eyes: 'Eyes', outfit: 'Outfit', accent: 'Trim and metal', mark: 'Distinguishing mark' };
  const LOOK_COLOR = { skin: 1, hair: 1, eyes: 1, outfit: 1, accent: 1 };
  const COLOR_NAMES = {
    skin: ['pale', 'fair', 'tan', 'brown', 'dark brown', 'deep brown', 'sage green', 'slate blue', 'russet', 'lilac'],
    hair: ['black', 'dark brown', 'brown', 'auburn', 'blond', 'flaxen', 'red', 'grey', 'white', 'blue', 'green', 'violet'],
    eyes: ['brown', 'blue', 'green', 'hazel', 'grey', 'red', 'gold', 'violet'],
    outfit: ['crimson', 'navy', 'forest green', 'ochre', 'violet', 'charcoal', 'tan', 'linen'],
    accent: ['gold', 'silver', 'copper', 'black iron', 'bone'],
  };
  const CHIP_NAME = { 'horns-small': 'Small horns', none: 'None', warpaint: 'War paint', eyepatch: 'Eye patch', topknot: 'Top knot' };
  const chipName = (v) => CHIP_NAME[v] || String(v).charAt(0).toUpperCase() + String(v).slice(1).replace(/-/g, ' ');
  const TRAIT_IDEAS = ['Laughs loudest when things go wrong.', 'Never breaks a promise, however foolish.', 'Collects a trinket from every place they visit.',
    'Quotes old proverbs, usually wrong.', 'Suspicious of anyone too friendly.', 'Cannot resist a dare.', 'Hums when nervous.',
    'Feeds every stray animal on the road.', 'Keeps a careful tally of every debt.', 'Talks to their weapon as if it were a friend.'];
  const abilitiesOf = (p) => {
    try { if (typeof E.abilitiesOf === 'function') return E.abilitiesOf(p).filter((id) => ABILITIES[id]); } catch (e) { /* fall through */ }
    return ((CLASSES[p.cls] || {}).abilities || []).concat(p.race === 'Dragonborn' ? ['breath_weapon'] : []).filter((id) => ABILITIES[id]);
  };
  const speedOf = (p) => { try { if (typeof E.speedOf === 'function') return E.speedOf(p); } catch (e) { /* fall through */ } return (CLASSES[p.cls] || {}).speed || 6; };
  const classSpells = (cls) => { const c = CLASSES[cls] || {}; return (c.spells || ((DATA.startingSpells || {})[cls]) || []).filter((id) => SPELLS[id]); };
  const raceOf = (p) => (p && own(RACES, p.race) ? p.race : 'Human');
  const bonusText = (race) => {
    const b = (RACES[race] || {}).bonus || {};
    const ks = ABILITY_NAMES.filter((k) => b[k]);
    if (ks.length === 6 && ks.every((k) => b[k] === b.STR)) return `+${b.STR} to every score`;
    return ks.sort((a, z) => b[z] - b[a]).map((k) => `+${b[k]} ${k}`).join(', ');
  };
  function defaultLook() {
    const out = {};
    // the same defaults the engine's cleanLook uses
    for (const k in LOOK) out[k] = LOOK[k][k === 'frame' ? 2 : k === 'skin' || k === 'hairStyle' || k === 'body' ? 1 : 0];
    return out;
  }
  function lookOf(p) {
    const out = defaultLook();
    const l = (p && p.look) || {};
    for (const k in out) if (Array.isArray(LOOK[k]) && LOOK[k].includes(l[k])) out[k] = l[k];
    return out;
  }
  const pickOf = (arr) => arr[Math.floor(Math.random() * arr.length)];
  function randomLook(race) {
    const out = {};
    for (const k in LOOK) out[k] = pickOf(LOOK[k]);
    // natural-looking odds: mostly human skin tones (except for tieflings), fewer beards on feminine frames, marks are rarer
    if (LOOK.skin && race !== 'Tiefling' && race !== 'Dragonborn' && Math.random() < 0.8) out.skin = pickOf(LOOK.skin.slice(0, 6));
    if (LOOK.beard && out.frame === 'feminine' && Math.random() < 0.85) out.beard = 'none';
    if (LOOK.mark && Math.random() < 0.5) out.mark = 'none';
    if (LOOK.hair && Math.random() < 0.7) out.hair = pickOf(LOOK.hair.slice(0, 9));
    return out;
  }
  // The gear a class starts with, by slot (for the creator's preview).
  function classEq(cls) {
    const eq = { weapon: null, armor: null, offhand: null, trinket: null };
    ((CLASSES[cls] || {}).equip || []).forEach((id) => { const it = ITEMS[id]; if (it && it.slot) eq[it.slot] = id; });
    return eq;
  }

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
    cc.open = false; cc.d = null; cc.err = ''; cc.busy = false;
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

  // ---------------- character figures ----------------
  // window.CharacterFigure (public/figure.js) draws the hero. Every call is guarded: when the
  // script is missing or throws, a plain silhouette stands in so the page never breaks.

  const CF = () => { try { const f = window.CharacterFigure; return f && typeof f.svg === 'function' ? f : null; } catch (e) { return null; } };
  const cfVer = () => { const f = CF(); return f ? f.version || 1 : 0; };
  function silhouette(o) {
    const full = o.view === 'full';
    const box = full ? '0 0 60 120' : o.view === 'token' ? '0 0 60 60' : '6 0 48 48';
    const w = full ? Math.round(o.size / 2) : o.size;
    const kids = [sv('circle', { cx: 30, cy: 14, r: 10 }),
      sv('path', { d: 'M14 30 Q30 24 46 30 L50 64 L43 64 L41 42 L40 70 L42 114 L33 114 L30 76 L27 114 L18 114 L20 70 L19 42 L17 64 L10 64 Z' })];
    return sv('svg', { viewBox: box, width: w, height: o.size, class: 'cf-fallback' + (o.pose === 'down' ? ' down' : '') },
      o.view === 'token' ? sv('g', { transform: 'translate(15 6) scale(.5)' }, kids) : kids);
  }
  /** A character picture: player { race, cls, look, eq, name }, opts { view, size, pose, facing, animate }. */
  function figureOf(p, opts) {
    const o = Object.assign({ view: 'bust', size: 48, pose: 'idle', facing: 'right', animate: false }, opts || {});
    const who = { race: raceOf(p), look: p && p.look ? p.look : undefined, name: (p && p.name) || '' };
    if (p && p.cls) who.cls = p.cls;
    if (p && p.eq) who.eq = p.eq;
    let el = null;
    const f = CF();
    if (f) { try { el = f.svg(who, o); } catch (e) { el = null; } }
    if (!el || !el.nodeType) el = silhouette(o);
    try { el.setAttribute('aria-hidden', 'true'); el.setAttribute('focusable', 'false'); } catch (e) { /* not an element */ }
    return h('span', { class: `cfig cfig-${o.view}${o.pose === 'down' ? ' is-down' : ''}${f ? '' : ' cfig-plain'}` }, el);
  }
  const narrow = () => { try { return window.matchMedia('(max-width: 620px)').matches; } catch (e) { return false; } };
  const heroLine = (p) => (p.cls ? `${raceOf(p)} ${p.cls}` : 'creating a character…');

  // ---------------- character creator ----------------
  // A stepped wizard with a live preview. Its working copy lives here (cc.d) until "Create
  // character" sends {t:'character'} to the table; the engine checks it and answers.

  const STEPS = [['race', 'Race'], ['class', 'Class'], ['background', 'Background'], ['abilities', 'Abilities'], ['look', 'Appearance'], ['details', 'Details']];
  const cc = { open: false, step: 0, d: null, err: '', busy: false };
  const isStdArray = (sc) => !!sc && ABILITY_NAMES.map((k) => sc[k]).sort((a, b) => b - a).every((v, i) => v === STD_ARRAY[i]);
  const buyCost = (sc) => ABILITY_NAMES.reduce((t, k) => t + (POINT_COST[sc[k]] == null ? 99 : POINT_COST[sc[k]]), 0);
  const ccBase = (d) => (d.method === 'buy' ? d.buy : d.arr);
  const modN = (score) => Math.floor(((score || 10) - 10) / 2);

  /** The standard array placed on a class's key abilities first, then by the class's own leanings. */
  function suggestedArr(cls) {
    const c = CLASSES[cls];
    const pri = ((c && c.primary) || []).filter((k) => ABILITY_NAMES.includes(k));
    const lean = (k) => (c && c.scores && c.scores[k]) || 0;
    const rest = ABILITY_NAMES.filter((k) => !pri.includes(k)).sort((a, b) => lean(b) - lean(a));
    const out = {};
    pri.concat(rest).forEach((k, i) => { out[k] = STD_ARRAY[i]; });
    return out;
  }

  function ccInit(p) {
    const has = !!(p && p.cls);
    const base = p && p.base && ABILITY_NAMES.every((k) => p.base[k] >= 8 && p.base[k] <= 15) ? Object.assign({}, p.base) : null;
    const arrOk = isStdArray(base);
    const arr = arrOk ? base : suggestedArr(has ? p.cls : null);
    const race = raceOf(p);
    cc.d = {
      race, cls: has && CLASSES[p.cls] ? p.cls : null,
      background: p && own(BACKGROUNDS, p.background) ? p.background : (own(BACKGROUNDS, 'Folk Hero') ? 'Folk Hero' : Object.keys(BACKGROUNDS)[0] || null),
      method: base && !arrOk ? 'buy' : 'array', arr, buy: base && !arrOk ? base : Object.assign({}, arr),
      look: p && p.look ? lookOf(p) : randomLook(race),
      bio: (p && p.bio) || '', traits: (p && p.traits) || '', pronouns: (p && p.pronouns) || '', touched: has,
    };
    cc.step = 0; cc.err = ''; cc.busy = false;
  }
  function ccSet(patch) {
    Object.assign(cc.d, patch);
    cc.err = '';
    renderCreator();
  }
  function ccGo(step) {
    cc.step = Math.max(0, Math.min(STEPS.length - 1, step));
    cc.err = '';
    renderCreator();
    const head = document.querySelector('#creator .cc-body');
    if (head) { try { head.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
    const top = document.getElementById('creator');
    if (top && top.getBoundingClientRect().top < 0) { try { top.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (e) { top.scrollIntoView(); } }
  }
  function ccPickClass(cls) {
    const d = cc.d;
    const patch = { cls };
    // until the player sets scores by hand, keep them on the new class's key abilities
    if (!d.touched) { const s = suggestedArr(cls); patch.arr = s; patch.buy = Object.assign({}, s); }
    ccSet(patch);
  }
  function ccSuggest() {
    if (!cc.d.cls) return;
    const s = suggestedArr(cc.d.cls);
    ccSet({ method: 'array', arr: s, touched: true });
  }
  // Each array value is used once: picking a value another ability holds swaps the two.
  function ccSetArr(k, v) {
    const arr = Object.assign({}, cc.d.arr);
    const other = ABILITY_NAMES.find((x) => x !== k && arr[x] === v);
    if (other) arr[other] = arr[k];
    arr[k] = v;
    ccSet({ arr, touched: true });
  }
  function ccBuy(k, delta) {
    const buy = Object.assign({}, cc.d.buy);
    const v = buy[k] + delta;
    if (v < 8 || v > 15) return;
    buy[k] = v;
    if (buyCost(buy) > POINTS) { cc.err = `Not enough points for ${ABILITY_FULL[k]} ${v}.`; renderCreator(); return; }
    ccSet({ buy, touched: true });
  }
  function ccMethod(m) {
    const d = cc.d;
    if (m === d.method) return;
    if (m === 'buy') {
      // start the point buy from the current array (the standard array costs exactly 27)
      const from = buyCost(d.arr) <= POINTS ? d.arr : null;
      ccSet({ method: 'buy', buy: Object.assign({}, from || d.buy) });
    } else ccSet({ method: 'array' });
  }

  /** What the engine will make of the current choices (mirrors Engine setClass). */
  function ccStats(d) {
    const rb = (RACES[d.race] || {}).bonus || {};
    const base = ccBase(d);
    const scores = {};
    ABILITY_NAMES.forEach((k) => { scores[k] = Math.min(20, (base[k] || 8) + (rb[k] || 0)); });
    const out = { scores, base, rb };
    const c = CLASSES[d.cls];
    if (!c) return out;
    const m = (k) => modN(scores[k]);
    const prime = c.primary ? c.primary[0] : 'STR';
    const eq = classEq(d.cls);
    const dwarf = d.race === 'Dwarf' ? 1 : 0;
    const raw = { atk: Math.max(2, c.atk + m(prime) - 2), def: c.def + dwarf, eq, fx: [] };
    const gear = Object.keys(c.gear || {}).map((id) => [id, c.gear[id]]);
    const bgi = (BACKGROUNDS[d.background] || {}).item;
    if (bgi && ITEMS[bgi]) { const g = gear.find((x) => x[0] === bgi); if (g) g[1] += 1; else gear.push([bgi, 1]); }
    return Object.assign(out, {
      prime, eq, gear,
      hp: c.hp + 2 * m('CON') + dwarf, mana: 50 + Math.max(m('INT'), m('WIS'), m('CHA')) * 10,
      atk: atkOf(raw), def: defOf(raw), speed: speedOf({ cls: d.cls }),
      abilities: abilitiesOf({ cls: d.cls, race: d.race }), spells: classSpells(d.cls),
    });
  }

  async function ccSubmit() {
    const d = cc.d;
    if (!d || cc.busy) return;
    if (!d.cls) { cc.err = 'Choose a class first.'; cc.step = 1; renderCreator(); return; }
    const base = ccBase(d);
    if (d.method === 'buy' && buyCost(base) > POINTS) { cc.err = `Those scores cost ${buyCost(base)} points; you have ${POINTS}.`; cc.step = 3; renderCreator(); return; }
    const read = (name, fallback) => { const el = document.querySelector(`#creator [data-keep="${name}"]`); return el ? el.value : fallback; };
    d.bio = read('cc-bio', d.bio); d.traits = read('cc-traits', d.traits); d.pronouns = read('cc-pron', d.pronouns);
    const action = {
      t: 'character', cls: d.cls, race: d.race, background: d.background, scores: Object.assign({}, base), look: Object.assign({}, d.look),
      bio: d.bio.trim(), traits: d.traits.trim(), pronouns: d.pronouns.trim(),
    };
    const editing = !!(me() && me().cls);
    cc.busy = true; cc.err = '';
    renderCreator();
    const r = await act(action);
    cc.busy = false;
    if (r.ok) {
      cc.open = false; cc.d = null; cc.err = '';
      A.call('sfx', 'send');
      toast(editing ? 'Character updated.' : `${(me() || {}).name || 'Your hero'} is ready. Welcome to the party!`, 'info');
      delete sigs.cc;
      render();
      const card = document.getElementById('myChar');
      if (card) { try { card.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
    } else { cc.err = r.error; renderCreator(); }
  }

  const choice = (k, on, onclick, kids, extra) => h('button', Object.assign({ type: 'button', class: 'pick' + (on ? ' sel' : ''), 'data-k': k, 'aria-pressed': String(!!on), onclick }, extra || {}), kids);

  function ccRaceStep(d) {
    return [h('p', { class: 'hint' }, 'Your people shape your scores and give you one special trait.'),
      h('div', { class: 'picks' }, Object.keys(RACES).map((r) => {
        const R = RACES[r];
        return choice('cc-race-' + r, d.race === r, () => ccSet({ race: r }), [
          h('span', { class: 'pick-top' }, figureOf({ race: r, look: d.look, cls: d.cls, eq: d.cls ? classEq(d.cls) : null }, { view: 'bust', size: 56 }),
            h('span', { class: 'pick-name' }, h('b', null, r), h('code', null, bonusText(r)))),
          h('span', { class: 'pick-desc' }, RACE_NOTE[r] || ''),
          h('span', { class: 'pick-fx' }, h('em', null, R.trait), ' — ', R.desc)]);
      }))];
  }
  function ccClassStep(d) {
    return [h('p', { class: 'hint' }, 'Your class decides how you fight, what you can cast and what you carry.'),
      h('div', { class: 'picks' }, Object.keys(CLASSES).map((name) => {
        const c = CLASSES[name];
        const eq = classEq(name);
        const raw = { atk: c.atk, def: c.def, eq, fx: [] };
        const abil = abilitiesOf({ cls: name, race: d.race }).map((id) => ABILITIES[id].name);
        const sp = classSpells(name).map((id) => SPELLS[id].name);
        return choice('cc-cls-' + name, d.cls === name, () => ccPickClass(name), [
          h('span', { class: 'pick-top' }, figureOf({ race: d.race, look: d.look, cls: name, eq }, { view: 'bust', size: 56 }),
            h('span', { class: 'pick-name' }, h('b', null, name), h('code', null, `HP ${c.hp} · ATK ${atkOf(raw)} · DEF ${defOf(raw)} · Move ${c.speed || 6}`))),
          h('span', { class: 'pick-desc' }, c.blurb || ''),
          h('span', { class: 'pick-fx' }, h('em', null, 'Key: '), (c.primary || []).join(', '), ' · ', abil.concat(sp).join(', '))]);
      }))];
  }
  function ccBackgroundStep(d) {
    return [h('p', { class: 'hint' }, 'Where you come from: a skill you are good at, a keepsake and some starting coin.'),
      h('div', { class: 'picks' }, Object.keys(BACKGROUNDS).map((b) => {
        const B = BACKGROUNDS[b];
        const it = ITEMS[B.item];
        return choice('cc-bg-' + b, d.background === b, () => ccSet({ background: b }), [
          h('span', { class: 'pick-name' }, h('b', null, b), h('code', null, `${B.skill} checks +2`)),
          h('span', { class: 'pick-desc' }, B.desc),
          h('span', { class: 'pick-fx' }, h('em', null, 'Starts with: '), `${it ? it.name : B.item} · +${B.gold || 0} gold`)]);
      }))];
  }
  function ccAbilityStep(d, st) {
    const c = CLASSES[d.cls];
    const buy = d.method === 'buy';
    const spent = buyCost(d.buy);
    const left = POINTS - spent;
    const pri = (c && c.primary) || [];
    const rows = ABILITY_NAMES.map((k) => {
      const v = ccBase(d)[k];
      const bonus = st.rb[k] || 0;
      const fin = st.scores[k];
      const nextCost = v < 15 ? POINT_COST[v + 1] - POINT_COST[v] : null;
      const ctl = buy
        ? h('span', { class: 'stepper' },
          btn('−', null, () => ccBuy(k, -1), { k: 'cc-dn-' + k, disabled: v <= 8, title: `Lower ${ABILITY_FULL[k]}`, cls: 'ghost' }),
          h('b', { 'aria-live': 'polite' }, String(v)),
          btn('+', null, () => ccBuy(k, 1), { k: 'cc-up-' + k, disabled: v >= 15 || nextCost > left, title: v >= 15 ? 'Point buy goes up to 15' : `Raise ${ABILITY_FULL[k]} (${nextCost} point${nextCost === 1 ? '' : 's'})`, cls: 'ghost' }))
        : h('select', { 'data-k': 'cc-arr-' + k, 'aria-label': `${ABILITY_FULL[k]} score`, onchange: (ev) => ccSetArr(k, Number(ev.target.value)) },
          STD_ARRAY.map((n) => h('option', { value: n, selected: n === v }, String(n))));
      return h('div', { class: 'ab-row' + (pri.includes(k) ? ' key' : '') },
        h('span', { class: 'ab-name' }, h('b', null, ABILITY_FULL[k]), pri.includes(k) && h('span', { class: 'tag warn' }, k === pri[0] ? 'attack' : 'key'),
          h('small', null, ABILITY_USE[k])),
        ctl,
        h('span', { class: 'ab-bonus' + (bonus ? ' on' : ''), title: `${d.race} bonus` }, bonus ? `+${bonus}` : '—'),
        h('span', { class: 'ab-final' }, h('b', null, String(fin)), h('small', null, mod(fin))),
        buy && h('span', { class: 'ab-cost', title: 'Point cost' }, `${POINT_COST[v]} pt`));
    });
    return [
      h('div', { class: 'modes ab-method', role: 'radiogroup', 'aria-label': 'How to set ability scores' },
        [['array', 'Standard array'], ['buy', 'Point buy']].map(([m, l]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(d.method === m), 'data-k': 'cc-m-' + m, onclick: () => ccMethod(m) }, l))),
      h('p', { class: 'hint' }, buy
        ? `Spend ${POINTS} points. Every score starts at 8 and goes up to 15; 14 and 15 cost more.`
        : `Place ${STD_ARRAY.join(', ')} once each. Picking a number another ability has swaps the two.`),
      h('div', { class: 'row ab-tools' },
        btn(c ? `Suggested for ${d.cls}` : 'Suggested (pick a class first)', null, ccSuggest, { k: 'cc-suggest', disabled: !c, title: c ? `Put the highest scores on ${pri.join(' and ')}` : '' }),
        buy && btn('All 8s', null, () => ccSet({ buy: ABILITY_NAMES.reduce((o, k) => Object.assign(o, { [k]: 8 }), {}), touched: true }), { k: 'cc-reset', cls: 'ghost' }),
        buy && h('span', { class: 'points' + (left === 0 ? ' done' : ''), role: 'status' }, h('b', null, String(left)), ` of ${POINTS} points left`)),
      h('div', { class: 'ab-table' + (buy ? ' buy' : '') },
        h('div', { class: 'ab-row ab-headrow', 'aria-hidden': 'true' }, h('span', null, 'Ability'), h('span', null, 'Base'), h('span', null, 'Race'), h('span', null, 'Score'), buy && h('span', null, 'Cost')),
        rows),
      c && h('p', { class: 'hint' }, `${d.cls}: attacks use ${ABILITY_FULL[st.prime]}. Constitution adds hit points; the best of Intelligence, Wisdom and Charisma sets your mana.`)];
  }
  function ccLookStep(d) {
    const groups = LOOK_ORDER.filter((k) => Array.isArray(LOOK[k]) && LOOK[k].length).map((k) => {
      const color = !!LOOK_COLOR[k];
      return h('div', { class: 'look-group', role: 'group', 'aria-label': LOOK_LABEL[k] || k },
        h('span', { class: 'lbl' }, LOOK_LABEL[k] || k),
        h('div', { class: color ? 'swatches' : 'chipset' }, LOOK[k].map((v, i) => {
          const on = d.look[k] === v;
          const name = color ? ((COLOR_NAMES[k] || [])[i] || `${LOOK_LABEL[k]} ${i + 1}`) : chipName(v);
          return h('button', {
            type: 'button', class: color ? 'swatch' + (on ? ' sel' : '') : 'chipbtn' + (on ? ' sel' : ''), 'data-k': `cc-look-${k}-${i}`, 'aria-pressed': String(on),
            'aria-label': color ? `${LOOK_LABEL[k]}: ${name}` : null, title: color ? name : null,
            onclick: () => ccSet({ look: Object.assign({}, d.look, { [k]: v }) }),
          }, color ? h('span', { style: { background: v } }) : name);
        })));
    });
    return [h('div', { class: 'row' }, btn('Randomise look', null, () => ccSet({ look: randomLook(d.race) }), { k: 'cc-random' }),
      h('span', { class: 'hint' }, 'Your figure on the left changes as you choose.')),
    h('div', { class: 'looks' }, groups)];
  }
  function ccDetailStep(d, p) {
    const text = (key, label, field, max, ph) => h('div', { class: 'field' },
      h('label', { for: 'f-' + key }, label),
      h('input', { id: 'f-' + key, type: 'text', maxlength: max, 'data-keep': key, value: d[field] || '', placeholder: ph, autocomplete: 'off',
        oninput: (ev) => { d[field] = ev.target.value; },
        onkeydown: (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); ccSubmit(); } } }));
    return [
      h('div', { class: 'field' }, h('span', null, 'Name'), h('p', { class: 'cc-name' }, p.name, h('small', null, ' (the name you joined with)'))),
      h('div', { class: 'field' },
        h('label', { for: 'f-cc-pron' }, 'Pronouns (optional)'),
        h('div', { class: 'row' },
          h('input', { id: 'f-cc-pron', type: 'text', maxlength: 20, 'data-keep': 'cc-pron', value: d.pronouns || '', placeholder: 'e.g. she/her', autocomplete: 'off', oninput: (ev) => { d.pronouns = ev.target.value; } }),
          ['she/her', 'he/him', 'they/them'].map((x) => btn(x, null, () => { d.pronouns = x; const el = document.querySelector('#creator [data-keep="cc-pron"]'); if (el) el.value = x; renderCreator(); }, { k: 'cc-pron-' + x, cls: 'ghost mini' })))),
      text('cc-bio', 'Concept (one line)', 'bio', 160, 'e.g. a retired smuggler looking for her brother'),
      h('div', { class: 'field' },
        h('label', { for: 'f-cc-traits' }, 'Personality trait'),
        h('div', { class: 'row' },
          h('input', { id: 'f-cc-traits', type: 'text', maxlength: 160, 'data-keep': 'cc-traits', value: d.traits || '', placeholder: 'e.g. hums when nervous', autocomplete: 'off', oninput: (ev) => { d.traits = ev.target.value; } }),
          btn('Inspire me', null, () => { d.traits = pickOf(TRAIT_IDEAS); const el = document.querySelector('#creator [data-keep="cc-traits"]'); if (el) el.value = d.traits; renderCreator(); }, { k: 'cc-trait-idea', cls: 'ghost mini' }))),
      h('p', { class: 'hint' }, 'The Dungeon Master reads your concept and trait, and plays the world around them.')];
  }

  function ccQuick(d, st, p) {
    const c = CLASSES[d.cls];
    const pill = (lbl, v, cls) => h('span', { class: 'pill' + (cls ? ' ' + cls : '') }, h('small', null, lbl), h('b', null, String(v)));
    return h('div', { class: 'cc-quick' },
      h('div', { class: 'who' }, h('b', null, p.name), h('span', null, [d.race, d.cls || '(no class yet)'].join(' '), d.background ? ` · ${d.background}` : '')),
      h('div', { class: 'scores' }, ABILITY_NAMES.map((a) => h('span', { title: `${ABILITY_FULL[a]} ${st.base[a]}${st.rb[a] ? ` + ${st.rb[a]} (${d.race})` : ''}`, class: st.rb[a] ? 'boosted' : null },
        a, h('b', null, String(st.scores[a])), h('small', null, mod(st.scores[a]))))),
      c && h('div', { class: 'pills' }, pill('HP', st.hp), pill('MP', st.mana), pill('ATK', st.atk, 'atk'), pill('DEF', st.def, 'def'), pill('Move', st.speed)));
  }
  function ccSummary(d, st) {
    const c = CLASSES[d.cls];
    const R = RACES[d.race] || {};
    const B = BACKGROUNDS[d.background];
    const sec = (title, kids) => h('section', { class: 'cc-sec' }, h('h4', null, title), kids);
    const list = (items) => h('ul', null, items);
    return h('div', { class: 'cc-sum', 'aria-label': 'Character summary' },
      c ? sec('Abilities and spells', list([
        st.abilities.map((id) => { const a = ABILITIES[id]; return h('li', null, h('b', null, a.name), h('small', null, ` ability · ${a.cd >= 20 ? 'once per fight' : a.cd <= 1 ? 'every turn' : 'every ' + a.cd + ' turns'}${a.range ? ' · range ' + a.range : ''}`), h('p', null, a.desc)); }),
        st.spells.map((id) => { const s = SPELLS[id]; return h('li', null, h('b', null, s.name), h('small', null, ` spell · ${s.mana_cost || 0} MP`), h('p', null, s.description || '')); }),
      ])) : sec('Abilities and spells', h('p', { class: 'hint' }, 'Choose a class to see what you can do.')),
      c && sec('Starting gear', list(st.gear.map(([id, n]) => {
        const it = itemOf(id);
        const worn = SLOT_LIST.some((s) => st.eq[s] === id);
        return h('li', { class: 'gear' }, itemIcon(id, 22), h('span', null, h('b', null, qtyLabel(n, it.name)), worn && h('span', { class: 'tag good' }, 'equipped'), statLine(it) && h('small', null, ' ' + statLine(it))));
      }))),
      sec('Racial trait', h('p', null, h('b', null, `${R.trait || '—'}`), ` (${d.race}): ${R.desc || ''}`)),
      B && sec('Background feature', h('p', null, h('b', null, d.background), `: ${B.desc} Starts with ${(ITEMS[B.item] || { name: B.item }).name} and ${B.gold || 0} extra gold.`)));
  }

  function creatorView(p, lobby) {
    const d = cc.d;
    const st = ccStats(d);
    const editing = !!p.cls;
    const phone = narrow();
    const last = cc.step === STEPS.length - 1;
    const body = [ccRaceStep, ccClassStep, ccBackgroundStep, ccAbilityStep, ccLookStep, ccDetailStep][cc.step];
    const preview = figureOf({ race: d.race, cls: d.cls, look: d.look, eq: d.cls ? classEq(d.cls) : null, name: p.name }, { view: 'full', size: phone ? 200 : 300, pose: 'ready', animate: true });
    const done = (i) => (i === 1 ? !!d.cls : i < cc.step || (i === 3 && d.touched));
    const createLabel = cc.busy ? 'Saving…' : editing ? 'Save changes' : 'Create character';
    return h('div', { class: 'cc', id: 'creator' },
      h('div', { class: 'cc-head' },
        h('h3', null, editing ? 'Edit your character' : lobby ? 'Create your character' : 'Create your character to join the story'),
        editing && btn('Cancel', null, () => { cc.open = false; cc.d = null; delete sigs.cc; render(); }, { cls: 'ghost mini', k: 'cc-cancel' })),
      h('div', { class: 'cc-grid' },
        h('div', { class: 'cc-side' }, h('div', { class: 'cc-stage', role: 'img', 'aria-label': `Preview of ${p.name}, ${d.race}${d.cls ? ' ' + d.cls : ''}` }, preview), ccQuick(d, st, p)),
        h('div', { class: 'cc-main' },
          h('ol', { class: 'cc-steps', 'aria-label': 'Steps' }, STEPS.map(([k, l], i) => h('li', null,
            h('button', { type: 'button', 'data-k': 'cc-step-' + k, class: (i === cc.step ? 'on' : '') + (done(i) ? ' done' : ''), 'aria-current': i === cc.step ? 'step' : null, onclick: () => ccGo(i) },
              h('span', { class: 'n', 'aria-hidden': 'true' }, String(i + 1)), l)))),
          h('div', { class: 'cc-body', tabindex: '-1', role: 'group', 'aria-label': `Step ${cc.step + 1} of ${STEPS.length}: ${STEPS[cc.step][1]}` }, body(d, cc.step === 3 ? st : p, p)),
          !!cc.err && h('p', { class: 'note cc-err', role: 'alert' }, cc.err),
          h('div', { class: 'cc-nav' },
            btn('Back', null, () => ccGo(cc.step - 1), { k: 'cc-back', disabled: cc.step === 0, cls: 'ghost' }),
            !last && btn(cc.step === 1 && !d.cls ? 'Pick a class to continue' : `Next: ${STEPS[cc.step + 1][1]}`, null, () => ccGo(cc.step + 1), { k: 'cc-next', disabled: cc.step === 1 && !d.cls }),
            btn(createLabel, !d.cls ? 'choose a class first' : null, ccSubmit, { k: 'cc-create', cls: 'primary' + (last ? ' big' : ''), disabled: !d.cls || cc.busy })),
          ccSummary(d, st))));
  }

  function myCharCard(p, lobby) {
    const B = BACKGROUNDS[p.background];
    const R = RACES[raceOf(p)] || {};
    const abil = abilitiesOf(p).map((id) => ABILITIES[id].name).concat((p.spells || []).filter((id) => SPELLS[id]).map((id) => SPELLS[id].name));
    return h('div', { class: 'mychar', id: 'myChar', tabindex: '-1' },
      figureOf(p, { view: 'full', size: narrow() ? 150 : 190, pose: 'idle', animate: true }),
      h('div', { class: 'mychar-tx' },
        h('h3', null, 'Your character'),
        h('p', { class: 'mychar-name' }, h('b', null, p.name), ` — ${raceOf(p)} ${p.cls}`, p.background ? `, ${p.background}` : '', p.pronouns ? ` (${p.pronouns})` : ''),
        !!p.bio && h('p', { class: 'bio' }, p.bio),
        !!p.traits && h('p', { class: 'hint' }, p.traits),
        h('div', { class: 'pills' },
          [['HP', p.maxHp], ['MP', p.maxMana], ['ATK', atkOf(p), 'atk'], ['DEF', defOf(p), 'def'], ['Move', speedOf(p)]].map(([l, v, c]) => h('span', { class: 'pill' + (c ? ' ' + c : '') }, h('small', null, l), h('b', null, String(v))))),
        h('div', { class: 'tags' },
          R.trait && h('span', { class: 'tag warn', title: R.desc || '' }, R.trait),
          B && h('span', { class: 'tag', title: B.desc }, `${p.background}: ${B.skill} +2`),
          abil.map((n) => h('span', { class: 'tag good' }, n))),
        lobby && h('div', { class: 'btns' }, btn('Edit character', 'race, class, scores, look', () => { ccInit(p); cc.open = true; delete sigs.cc; render(); const b = document.querySelector('#creator .cc-body'); if (b) { try { b.focus(); } catch (e) { /* ignore */ } } }, { k: 'cc-edit' }))));
  }

  function renderCreator() {
    const box = $('ccBox');
    const p = me();
    if (!box || !p || !state) return;
    const lobby = state.phase === 'lobby';
    const wizard = !p.cls || (lobby && cc.open);
    if (!wizard) { cc.open = false; cc.d = null; }
    else if (!cc.d) ccInit(p);
    const phone = narrow();
    paint('cc', box, wizard ? ['w', cc.step, cc.d, cc.err, cc.busy, p.name, p.cls, lobby, phone, cfVer()] : ['card', p, lobby, phone, cfVer()],
      () => (wizard ? creatorView(p, lobby) : myCharCard(p, lobby)));
  }

  // ---------------- lobby ----------------

  function optSelect(label, key, pairs, cur) {
    const list = pairs.some((x) => x[0] === cur) || !cur ? pairs : pairs.concat([[cur, cur]]);
    return h('label', { class: 'field' }, h('span', null, label),
      h('select', { 'data-k': 'opt-' + key, onchange: async (ev) => { if (!(await send({ t: 'opts', [key]: ev.target.value }))) { delete sigs.lobby; render(); } } },
        list.map((x) => h('option', { value: x[0], selected: x[0] === cur }, x[1]))));
  }

  // Host switches for who can find and join the table.
  function tableToggle(key, on, label, help) {
    return h('label', { class: 'tick toggle' },
      h('input', { type: 'checkbox', 'data-k': 'opt-' + key, checked: on,
        onchange: async (ev) => { const v = !!ev.target.checked; if (!(await send({ t: 'opts', [key]: v }))) { ev.target.checked = !v; } else toast(key === 'listed' ? (v ? 'Your table is listed on the front page.' : 'Your table is private now.') : (v ? 'Table locked: no new players can join.' : 'Table unlocked.'), 'info'); } }),
      h('span', null, h('b', null, label), h('small', null, help)));
  }
  function tableOpts(o) {
    return h('div', { class: 'table-opts' },
      !isArtifact() && tableToggle('listed', o.listed !== false, 'List this table publicly', 'It appears under Open tables on the front page, so anyone can see it and take a free seat. Off: only people with your code or link can join.'),
      tableToggle('locked', !!o.locked, 'Lock table', 'Nobody new can join, not even with the code. Players already seated can always come back to their seat.'));
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
    const p = me();
    const lobby = state.phase === 'lobby';
    const on = lobby || (!!p && !p.cls);
    box.hidden = !on;
    if (!on) {
      if (box.firstChild) box.replaceChildren();
      delete sigs.lobbyTop; delete sigs.lobby; delete sigs.cc; cc.open = false; cc.d = null;
      return;
    }
    if (!$('ccBox') || !box.contains($('ccBox'))) {
      box.replaceChildren(h('div', { id: 'lobbyTop', class: 'lobby-part' }), h('div', { id: 'ccBox', class: 'lobby-part' }), h('div', { id: 'lobbyRest', class: 'lobby-part' }));
      delete sigs.lobbyTop; delete sigs.lobby; delete sigs.cc;
    }
    $('lobbyTop').hidden = !lobby;
    $('lobbyRest').hidden = !lobby;
    renderCreator();
    if (!lobby) return;
    const seats = state.order.filter((id) => state.players[id]);
    const roster = seats.map((id) => { const q = state.players[id]; return [id, q.name, q.cls, q.race, q.look, q.online, q.eq, q.level]; });
    paint('lobbyTop', $('lobbyTop'), [roster, state.host, myId, cfVer(), !!(state.opts || {}).locked], () => [
      h('h2', null, 'The party gathers'),
      h('ul', { class: 'roster' }, seats.map((id) => {
        const q = state.players[id];
        return h('li', { class: 'rs' + (q.cls ? ' ready' : ' pending') + (id === myId ? ' me' : '') },
          figureOf(q, { view: 'bust', size: 64 }),
          h('span', { class: 'rs-tx' },
            h('b', null, h('i', { class: 'dot' + (q.online === false ? ' off' : ''), title: q.online === false ? 'Offline' : 'Online' }), q.name + (id === myId ? ' (you)' : '')),
            h('span', null, heroLine(q)),
            h('span', { class: 'tags' }, id === state.host && h('span', { class: 'tag warn' }, 'Host'), h('span', { class: 'tag ' + (q.cls ? 'good' : '') }, q.cls ? 'ready' : 'choosing'))));
      }), seats.length < MAX_PLAYERS && h('li', { class: 'rs open' },
        h('span', { class: 'cfig cfig-bust seat-empty', 'aria-hidden': 'true' }),
        h('span', { class: 'rs-tx' }, h('b', null, plural(MAX_PLAYERS - seats.length, 'open seat', 'open seats')), h('span', null, (state.opts || {}).locked ? 'locked by the host' : 'invite a friend below')))),
      h('p', { class: 'hint' }, `${seats.length} of ${MAX_PLAYERS} seats taken. Friends can also join after you set out.`)]);

    paint('lobby', $('lobbyRest'), [roster, state.host, state.opts, state.code, session.rejoin, myId, isArtifact()], () => {
      const o = state.opts || {};
      const host = isHost();
      const hostP = state.players[state.host];
      const ready = seats.filter((id) => state.players[id].cls).length;
      const advs = ADVENTURES.some((a) => a.id === 'custom') ? ADVENTURES
        : ADVENTURES.concat([{ id: 'custom', title: 'Your own premise', blurb: 'Describe the adventure you want and the Dungeon Master will run it.' }]);
      const adv = advs.find((a) => a.id === o.adventure);
      const kids = [];

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
        kids.push(h('h3', null, 'Who can join'), tableOpts(o));
      } else {
        const label = (pairs, v) => (pairs.find((x) => x[0] === v) || [v, v || '—'])[1];
        kids.push(h('div', { class: 'summary' },
          h('p', null, h('b', null, adv ? adv.title : 'Not chosen yet'), adv && adv.blurb ? ' — ' + adv.blurb : ''),
          o.adventure === 'custom' && !!o.premise && h('p', { class: 'premise' }, o.premise),
          h('p', { class: 'hint' }, `Tone: ${label(TONES, o.tone)} · Difficulty: ${label(DIFFS, o.difficulty)} · Language: ${o.lang || 'English'}`),
          h('p', { class: 'hint' }, [isArtifact() ? null : (o.listed === false ? 'Private table' : 'Listed publicly'), o.locked ? 'locked to new players' : null].filter(Boolean).join(' · '))));
      }

      if (host) {
        kids.push(h('div', { class: 'btns' }, btn('Begin the adventure', `${ready} of ${seats.length} ready`, { t: 'start' }, { cls: 'primary big', disabled: ready === 0 })),
          ready === 0 && h('p', { class: 'hint' }, 'At least one adventurer needs a character before you can begin.'));
      } else {
        kids.push(h('p', { class: 'hint' }, `Waiting for ${hostP ? hostP.name : 'the host'} to begin the adventure.`));
        if (hostP && hostP.online === false) kids.push(h('div', { class: 'btns' }, btn('Claim host', `${hostP.name} is offline`, { t: 'claimhost' })));
      }

      kids.push(h('h3', null, 'Invite your friends'), inviteBlock());
      return kids;
    });
  }

  // ---------------- open tables (join screen, server mode) ----------------
  // GET /api/tables lists the parties whose host lets them be found. Refreshed every 10 s
  // while the join screen shows.

  const tbl = { data: null, err: '', at: 0, loading: false, want: null };
  const tablesOn = () => netReady && !!N && !isArtifact() && !(session && state);
  const ago = (t) => {
    const s = Math.max(0, (Date.now() - Number(t || 0)) / 1000);
    if (s < 60) return 'active just now';
    if (s < 3600) return `active ${Math.round(s / 60)} min ago`;
    if (s < 86400) return `active ${Math.round(s / 3600)} h ago`;
    return `active ${Math.round(s / 86400)} d ago`;
  };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const PHASE_LINE = { lobby: 'Gathering in the lobby', scene: 'Adventuring', combat: 'In a fight', defeat: 'Regrouping after a defeat', victory: 'Celebrating a victory' };

  async function loadTables() {
    if (!tablesOn() || tbl.loading) { renderTables(); return; }
    tbl.loading = true;
    try {
      const r = await fetch('/api/tables', { cache: 'no-store' });
      if (!r.ok) throw new Error('status ' + r.status);
      const j = await r.json();
      tbl.data = j && Array.isArray(j.tables) ? j : { tables: [], playing: 0, parties: 0 };
      tbl.err = '';
    } catch (e) { tbl.err = 'Could not load the open tables. Retrying shortly.'; }
    tbl.loading = false;
    tbl.at = Date.now();
    renderTables();
  }

  function joinTable(t) {
    const saved = store.get('aidnd.session');
    const mine = !!saved && saved.code === t.code && !!saved.token;
    $('codeInput').value = t.code;
    if (!mine && !$('nameInput').value.trim()) {
      tbl.want = t.code;
      renderTables();
      joinNote(`Type your adventurer's name first, then press Join to sit down at “${t.title}”.`);
      $('nameInput').focus();
      return;
    }
    tbl.want = null;
    start(false);
  }

  function tableCard(t, savedCode) {
    const mine = savedCode === t.code;
    const full = t.seats <= 0;
    const why = mine ? null : t.locked ? 'The host has locked this table' : full ? 'This table is full' : null;
    const where = t.phase === 'lobby' ? PHASE_LINE.lobby : `${PHASE_LINE[t.phase] || 'Adventuring'}: ${t.location || 'somewhere unknown'}`;
    const tone = (TONES.find((x) => x[0] === t.tone) || [0, t.tone || ''])[1];
    const diff = (DIFFS.find((x) => x[0] === t.difficulty) || [0, t.difficulty || ''])[1];
    const players = Array.isArray(t.players) ? t.players : [];
    return h('article', { class: 'tcard' + (t.online > 0 ? ' live' : '') + (why ? ' closed' : '') + (tbl.want === t.code ? ' want' : ''), 'aria-label': t.title },
      h('div', { class: 'tc-head' },
        h('h3', null, t.title || 'An adventure'),
        h('span', { class: 'chip ' + (t.online > 0 ? 'good' : '') }, h('i', { class: 'dot' + (t.online > 0 ? '' : ' off'), 'aria-hidden': 'true' }), t.online > 0 ? `${t.online} online now` : 'nobody online')),
      h('p', { class: 'tc-where' }, where),
      h('p', { class: 'tc-meta' }, [tone, diff, t.lang && t.lang !== 'English' ? t.lang : null, t.host ? `host ${t.host}` : null, ago(t.updated)].filter(Boolean).join(' · ')),
      h('ul', { class: 'tc-party', 'aria-label': 'The party' },
        players.map((q) => h('li', { class: q.online ? 'on' : 'off' },
          figureOf(q, { view: 'bust', size: 46 }),
          h('span', { class: 'tc-who' },
            h('b', null, h('i', { class: 'dot' + (q.online ? '' : ' off'), title: q.online ? 'Online now' : 'Away' }), q.name),
            h('small', null, q.cls ? `${q.race || 'Human'} ${q.cls} · Lv ${q.level || 1}` : 'creating a character')))),
        t.seats > 0 && h('li', { class: 'seat' }, h('span', { class: 'cfig cfig-bust seat-empty', 'aria-hidden': 'true' }),
          h('span', { class: 'tc-who' }, h('small', null, t.seats === 1 ? 'Open seat' : 'Open seats')))),
      h('div', { class: 'tc-foot' },
        h('span', { class: 'tc-seats' + (why ? ' bad' : '') }, why || (mine ? 'Your seat is waiting' : plural(t.seats, 'seat free', 'seats free'))),
        h('button', { type: 'button', class: 'primary big', 'data-k': 'tjoin-' + t.code, disabled: !!why, onclick: () => joinTable(t) }, mine ? 'Rejoin your seat' : 'Join this table')));
  }

  function renderTables() {
    const box = $('tablesBox');
    if (!box) return;
    const show = tablesOn();
    box.hidden = !show;
    $('joinView').classList.toggle('with-tables', show);
    if (!show) { delete sigs.tables; return; }
    const d = tbl.data;
    const saved = store.get('aidnd.session');
    const savedCode = saved && saved.token ? saved.code : null;
    const tables = d ? d.tables : [];
    const live = tables.filter((t) => t.online > 0);
    const listedOnline = tables.reduce((n, t) => n + (t.online || 0), 0);
    const priv = Math.max(0, ((d && d.playing) || 0) - listedOnline);
    $('tablesCount').textContent = !d ? (tbl.err || 'Looking for open tables…')
      : (listedOnline ? `${plural(listedOnline, 'person', 'people')} playing now in ${plural(live.length, 'party', 'parties')}` : 'Nobody is at an open table right now')
        + (priv ? ` · ${priv} more at private tables` : '');
    const minute = Math.floor(Date.now() / 60000);
    paint('tables', $('tablesList'), [tables, tbl.err, tbl.want, savedCode, minute, cfVer(), !!d], () => {
      if (!d) return h('p', { class: 'hint' }, tbl.err || 'Loading…');
      const kids = [];
      if (tbl.err) kids.push(h('p', { class: 'note' }, tbl.err));
      if (!tables.length) kids.push(h('div', { class: 'tables-empty' }, h('b', null, 'No open tables right now.'), h('span', null, 'Create one and your friends can find it here.')));
      return kids.concat(tables.map((t) => tableCard(t, savedCode)));
    });
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
        kids.push(h('div', { class: 'turn' }, 'Create your character to join the story'),
          h('p', { class: 'hint' }, 'Finish the character creator and press Create character. You join the party straight away.'));
        return kids;
      }
      if (ph === 'scene') {
        const sc = state.scene || {};
        const heals = (p.spells || []).filter((id) => SPELLS[id] && SPELLS[id].spell_type === 'Heal');
        kids.push(h('div', { class: 'btns qa' },
          btn('Rest', sc.rested ? 'already rested here' : 'once per location', { t: 'rest' }, { disabled: !!sc.rested }),
          !!sc.shop && btn('Trade with the merchant', `${p.gold} gold`, openTrade, { cls: 'primary', k: 'trade-open' }),
          heals.map((id) => spellBtn(p, id)),
          others().some((id) => !!state.players[id].cls) && btn('Give…', 'item or gold', () => { ui.give = ui.give || { what: 'gold' }; openPack('sheetBox'); }),
          btn('Recap', 'the story so far', { t: 'recap' }),
          btn('Steer away', 'move the story on', { t: 'steer' }),
          isHost() && toggleBtn('Director’s note', 'host only', 'director')));
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
              abilitiesOf(p).map((id) => {
                const a = ABILITIES[id];
                const cd = cdOf(p, 'a', id);
                const spent = id === 'breath_weapon' && !!(p.used && p.used.breath);
                const note = spent || cd > 20 ? 'used this fight' : cd ? `ready in ${cd}` : a.range ? `ability · range ${a.range}` : 'ability';
                return btn(a.name, note, { t: 'ability', id, target: a.target === 'ally' ? (state.players[sel.ally] ? sel.ally : myId) : sel.enemy },
                  { disabled: cd > 0 || spent, title: a.desc, k: 'abil-' + id });
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

  const TRADE_WORDS = /\b(buy|buying|bought|sell|selling|trade|trading|wares|shop|shopping|purchase|haggle|barter|merchant|goods|stock)\b/i;
  async function sendChip(text) {
    if (busy) return;
    if (shopNow() && TRADE_WORDS.test(text)) openTrade();
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
      else if (cmd === 'trade' || cmd === 'shop' || cmd === 'buy' || cmd === 'sell') { ta.value = ''; growSay(); sayNote(''); openTrade(); return; }
      else if (cmd === 'ooc') {
        if (!rest) { sayNote('Add your message after /ooc.'); return; }
        action = { t: 'chat', text: rest };
      } else { sayNote(`Unknown command /${cmd}. Try /roll 2d6+3, /recap, /ooc or /help.`); return; }
    } else action = ui.mode === 'talk' ? { t: 'chat', text } : { t: 'intent', kind: ui.mode, text };
    // Talking shop with a merchant present: open the trade window as well as telling the DM.
    const wantsTrade = ui.mode !== 'talk' && text[0] !== '/' && shopNow() && TRADE_WORDS.test(text);

    if (wantsTrade) openTrade();
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
    paint('party', $('party'), [state.players, state.order, state.host, cur, sel.ally, ui.kick, myId, lobby, cfVer()], () => {
      const kids = seats.map((id) => {
        const p = state.players[id];
        const cls = ['pc', cur === id && 'turn', sel.ally === id && 'sel', p.cls && !p.alive && 'down'].filter(Boolean).join(' ');
        return h('div', { class: cls },
          h('button', { class: 'pc-main', type: 'button', 'data-k': 'pc-' + id, 'aria-pressed': String(sel.ally === id), title: 'Target this ally for heals, items and gifts',
            onclick: () => { sel.ally = sel.ally === id ? null : id; render(); } },
          h('div', { class: 'pc-row' },
            figureOf(p, { view: 'bust', size: 52, pose: p.cls && !p.alive ? 'down' : 'idle' }),
            h('div', { class: 'nm' },
              h('b', null, h('i', { class: 'dot' + (p.online === false ? ' off' : '') }), p.name + (id === myId ? ' (you)' : '')),
              h('span', null, p.cls ? `${raceOf(p)} ${p.cls} · Lv ${p.level}` : 'creating a character…'))),
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

  // ---------------- inventory: icons ----------------
  // Small item pictures drawn as inline SVG (no image files). Shapes by type, colours by material/effect.

  const SVGNS = 'http://www.w3.org/2000/svg';
  function sv(tag, attrs, ...kids) {
    const el = document.createElementNS(SVGNS, tag);
    for (const k in attrs || {}) if (attrs[k] != null) el.setAttribute(k, String(attrs[k]));
    kids.flat(Infinity).forEach((c) => { if (c) el.append(c); });
    return el;
  }
  const C = { steel: '#c3c9c6', steelDk: '#6f7a78', wood: '#8a5a34', woodDk: '#5a3a20', gold: '#d1a94f', goldDk: '#8d6a22', leather: '#9a6b42', glass: '#d9e4e6', paper: '#e6dcc0', ink: '#12171b' };
  const POTION = { heal: '#d0453a', mana: '#3f86d6', buff_attack: '#e0902f', buff_defense: '#9aa7a4' };

  function blade(len, w) {
    // a sword pointing up, then turned 45 degrees
    const top = 28 - len;
    return sv('g', { transform: 'rotate(45 16 16)' },
      sv('path', { d: `M${16 - w / 2} 20 L${16 - w / 2} ${top + 3} L16 ${top} L${16 + w / 2} ${top + 3} L${16 + w / 2} 20 Z`, fill: C.steel, stroke: C.steelDk, 'stroke-width': 0.8 }),
      sv('rect', { x: 10.5, y: 19.5, width: 11, height: 2.4, rx: 1, fill: C.gold }),
      sv('rect', { x: 15, y: 21.9, width: 2, height: 4.6, fill: C.wood }),
      sv('circle', { cx: 16, cy: 27.6, r: 1.7, fill: C.gold }));
  }
  function itemIcon(id, size) {
    const it = ITEMS[id] || { type: 'misc', effects: [] };
    const k = String(id);
    let g;
    if (it.type === 'weapon') {
      if (/staff/.test(k)) g = sv('g', { transform: 'rotate(45 16 16)' }, sv('rect', { x: 14.8, y: 4, width: 2.4, height: 25, rx: 1.2, fill: C.wood }), sv('circle', { cx: 16, cy: 5, r: 3, fill: C.woodDk }));
      else if (/mace/.test(k)) g = sv('g', { transform: 'rotate(45 16 16)' }, sv('rect', { x: 14.9, y: 11, width: 2.2, height: 18, fill: C.wood }), sv('circle', { cx: 16, cy: 9, r: 5, fill: C.steel, stroke: C.steelDk, 'stroke-width': 1, 'stroke-dasharray': '2 1.4' }));
      else if (/dagger/.test(k)) g = blade(13, 3.4);
      else g = blade(22, 3.6);
      if (/enchanted/.test(k)) g = sv('g', null, sv('circle', { cx: 16, cy: 16, r: 13, fill: '#4f93d6', opacity: 0.18 }), g);
    } else if (it.slot === 'offhand') {
      if (/buckler/.test(k)) g = sv('g', null, sv('circle', { cx: 16, cy: 16, r: 11, fill: C.wood, stroke: C.steel, 'stroke-width': 2 }), sv('circle', { cx: 16, cy: 16, r: 3.4, fill: C.steel }));
      else if (/tower/.test(k)) g = sv('g', null, sv('path', { d: 'M8 3 H24 V22 Q24 27 16 30 Q8 27 8 22 Z', fill: C.wood, stroke: C.steel, 'stroke-width': 1.8 }), sv('path', { d: 'M16 4 V29 M9 13 H23', stroke: C.steelDk, 'stroke-width': 1.4 }));
      else g = sv('g', null, sv('path', { d: 'M6 6 Q16 2 26 6 L26 15 Q26 24 16 29 Q6 24 6 15 Z', fill: C.wood, stroke: C.steel, 'stroke-width': 1.8 }), sv('circle', { cx: 16, cy: 14, r: 3.2, fill: C.steel }));
    } else if (it.type === 'armor') {
      const fill = /leather/.test(k) ? C.leather : /plate/.test(k) ? '#dfe3e0' : C.steel;
      g = sv('g', null,
        sv('path', { d: 'M10 5 L13 4 Q16 7 19 4 L22 5 L27 10 L24 14 L23 13 L23 27 Q16 29 9 27 L9 13 L8 14 L5 10 Z', fill, stroke: C.steelDk, 'stroke-width': 1 }),
        /chain/.test(k) && sv('path', { d: 'M11 15 H21 M11 19 H21 M11 23 H21', stroke: C.steelDk, 'stroke-width': 1, 'stroke-dasharray': '1.5 1.2' }),
        /plate/.test(k) && sv('path', { d: 'M16 8 V27 M10 16 Q16 18 22 16', stroke: C.steelDk, 'stroke-width': 1, fill: 'none' }));
    } else if (it.type === 'trinket') {
      if (/ring/.test(k)) g = sv('g', null, sv('circle', { cx: 16, cy: 19, r: 7.5, fill: 'none', stroke: C.gold, 'stroke-width': 3 }), sv('path', { d: 'M12.5 11.5 L16 7 L19.5 11.5 L16 14 Z', fill: '#c8493d', stroke: C.goldDk, 'stroke-width': 0.8 }));
      else if (/amulet/.test(k)) g = sv('g', null, sv('path', { d: 'M8 4 Q16 17 24 4', fill: 'none', stroke: C.steel, 'stroke-width': 1.4, 'stroke-dasharray': '2 1' }), sv('circle', { cx: 16, cy: 20, r: 6.5, fill: C.steel, stroke: C.steelDk }), sv('circle', { cx: 16, cy: 20, r: 3, fill: '#4f93d6' }));
      else g = sv('g', null, sv('path', { d: 'M16 3 V11', stroke: C.wood, 'stroke-width': 1.4 }), sv('ellipse', { cx: 16, cy: 19, rx: 5.5, ry: 8, fill: '#cdb89a', stroke: '#8c7558' }), sv('circle', { cx: 13, cy: 26, r: 1.6, fill: '#8c7558' }), sv('circle', { cx: 16, cy: 27, r: 1.6, fill: '#8c7558' }), sv('circle', { cx: 19, cy: 26, r: 1.6, fill: '#8c7558' }));
    } else if (it.type === 'consumable') {
      const fx = (it.effects || [])[0];
      const col = (fx && POTION[fx.type]) || '#77b06c';
      const r = /greater/.test(k) ? 10 : 8.5;
      g = sv('g', null,
        sv('rect', { x: 13, y: 5, width: 6, height: 8, fill: C.glass, opacity: 0.85 }),
        sv('rect', { x: 12.3, y: 2.5, width: 7.4, height: 3.4, rx: 1, fill: C.wood }),
        sv('circle', { cx: 16, cy: 30 - r - 0.5, r, fill: col, stroke: C.glass, 'stroke-width': 1.4 }),
        sv('ellipse', { cx: 12.6, cy: 30 - r - 3, rx: 1.8, ry: 2.8, fill: '#fff', opacity: 0.45 }));
    } else if (it.type === 'tool') {
      if (/torch/.test(k)) g = sv('g', null, sv('rect', { x: 14.5, y: 14, width: 3, height: 15, rx: 1, fill: C.wood }), sv('path', { d: 'M16 3 Q22 10 18.5 14 H13.5 Q10 10 16 3 Z', fill: '#e0902f' }), sv('path', { d: 'M16 8 Q18.5 11 17 13.5 H15 Q13.5 11 16 8 Z', fill: '#f4d36b' }));
      else if (/rope/.test(k)) g = sv('g', { fill: 'none', stroke: '#c9a46a', 'stroke-width': 2.2 }, sv('circle', { cx: 16, cy: 16, r: 11 }), sv('circle', { cx: 16, cy: 16, r: 6.5 }), sv('path', { d: 'M27 16 Q29 24 24 28' }));
      else if (/book/.test(k)) g = sv('g', null, sv('rect', { x: 7, y: 5, width: 18, height: 23, rx: 2, fill: '#6b3d8a', stroke: '#3e2152' }), sv('rect', { x: 9.5, y: 7, width: 13.5, height: 19, fill: C.paper, opacity: 0.25 }), sv('circle', { cx: 16, cy: 16, r: 3.5, fill: 'none', stroke: C.gold, 'stroke-width': 1.4 }));
      else if (/holy/.test(k)) g = sv('g', null, sv('circle', { cx: 16, cy: 16, r: 6, fill: C.gold }), sv('path', { d: 'M16 3 V8 M16 24 V29 M3 16 H8 M24 16 H29 M7 7 L10.5 10.5 M21.5 21.5 L25 25 M25 7 L21.5 10.5 M10.5 21.5 L7 25', stroke: C.gold, 'stroke-width': 2, 'stroke-linecap': 'round' }));
      else g = sv('g', { stroke: C.steel, 'stroke-width': 2, fill: 'none', 'stroke-linecap': 'round' }, sv('circle', { cx: 10, cy: 10, r: 5 }), sv('path', { d: 'M13.5 13.5 L27 27 M22 22 L25 19 M25 25 L28 22' }));
    } else if (it.type === 'treasure') {
      if (/coin/.test(k)) {
        const ancient = /ancient/.test(k);
        g = sv('g', null, sv('circle', { cx: 16, cy: 16, r: 11, fill: ancient ? '#9a8a5a' : C.gold, stroke: ancient ? '#5e5434' : C.goldDk, 'stroke-width': 1.6 }),
          ancient ? sv('rect', { x: 13, y: 13, width: 6, height: 6, fill: C.ink }) : sv('circle', { cx: 16, cy: 16, r: 6.5, fill: 'none', stroke: C.goldDk, 'stroke-width': 1.2 }));
      } else g = sv('g', null, sv('path', { d: 'M7 12 L11.5 6 H20.5 L25 12 L16 27 Z', fill: '#c8493d', stroke: '#7d221a', 'stroke-width': 1 }), sv('path', { d: 'M7 12 H25 M11.5 6 L14 12 L16 27 L18 12 L20.5 6', fill: 'none', stroke: '#f0a49b', 'stroke-width': 0.8 }));
    } else if (it.type === 'quest') {
      g = sv('g', null,
        sv('rect', { x: 8, y: 6.5, width: 16, height: 19, fill: C.paper, stroke: '#8c7558' }),
        sv('rect', { x: 6, y: 4, width: 20, height: 4, rx: 2, fill: '#b9a57e', stroke: '#8c7558' }),
        sv('rect', { x: 6, y: 24, width: 20, height: 4, rx: 2, fill: '#b9a57e', stroke: '#8c7558' }),
        sv('path', { d: 'M11 12 H21 M11 15.5 H21 M11 19 H18', stroke: '#6b5a3e', 'stroke-width': 1.2 }));
    } else {
      g = sv('path', { d: 'M10 10 Q16 4 22 10 L25 26 Q16 30 7 26 Z', fill: C.leather, stroke: C.woodDk });
    }
    return sv('svg', { viewBox: '0 0 32 32', width: size || 32, height: size || 32, 'aria-hidden': 'true', focusable: 'false', class: 'icon' }, g);
  }
  // Empty equipment slot: a faint outline of what belongs there.
  const SLOT_SAMPLE = { weapon: 'iron_sword', armor: 'leather_armor', offhand: 'shield', trinket: 'ring_of_might' };


  // ---------------- inventory: data helpers ----------------

  const SLOT_LIST = Array.isArray(E.SLOTS) ? E.SLOTS : ['weapon', 'armor', 'offhand', 'trinket'];
  const CAP = E.CAPACITY || 20;
  const SLOT_NAMES = { weapon: 'Weapon', armor: 'Armour', offhand: 'Off-hand', trinket: 'Trinket' };
  const RARITY = { common: 'Common', uncommon: 'Uncommon', rare: 'Rare', epic: 'Epic', legendary: 'Legendary' };
  const STAT_LABEL = [['attack', 'ATK'], ['defense', 'DEF'], ['magic_damage', 'Spell power']];
  const TYPE_ORDER = ['weapon', 'armor', 'offhand', 'trinket', 'consumable', 'tool', 'treasure', 'quest'];
  const TYPE_NAMES = { weapon: 'Weapon', armor: 'Armour', offhand: 'Shield', trinket: 'Trinket', consumable: 'Consumable', tool: 'Tool', treasure: 'Treasure', quest: 'Quest item' };
  const FILTERS = [['all', 'All'], ['gear', 'Gear'], ['consumable', 'Consumables'], ['valuable', 'Valuables'], ['quest', 'Quest']];
  const SORTS = [['type', 'Type'], ['name', 'Name'], ['value', 'Value']];
  const itemOf = (id) => ITEMS[id] || { name: String(id), type: 'misc', description: '', value: 0, stats: {}, effects: [] };
  const rarityOf = (it) => (RARITY[it.rarity] ? it.rarity : 'common');
  const typeKey = (it) => (it.slot === 'offhand' ? 'offhand' : it.type);
  const typeName = (it) => TYPE_NAMES[typeKey(it)] || 'Item';
  const inFilter = (it, f) => f === 'all' || (f === 'gear' ? ['weapon', 'armor', 'trinket', 'tool'].includes(it.type) : f === 'valuable' ? it.type === 'treasure' : it.type === f);
  const statLine = (it) => STAT_LABEL.filter(([k]) => (it.stats || {})[k]).map(([k, l]) => `+${it.stats[k]} ${l}`).join(' · ');
  const effectText = (e) => (e.type === 'heal' ? `Restores ${e.value} HP` : e.type === 'mana' ? `Restores ${e.value} mana`
    : e.type === 'buff_attack' ? `+${e.value} attack for ${e.duration || 3} turns` : e.type === 'buff_defense' ? `+${e.value} defense for ${e.duration || 3} turns` : `${e.type} ${e.value}`);
  const shortInfo = (it) => statLine(it) || ((it.effects || [])[0] ? effectText(it.effects[0]) : typeName(it));
  const sellOf = (id) => { try { return E.sellPrice(id); } catch (e) { const it = ITEMS[id]; return it && it.type !== 'quest' ? Math.floor((it.value || 0) / 2) : 0; } };
  const slotOf = (p, id) => SLOT_LIST.find((s) => (p.eq || {})[s] === id) || null;
  const packKinds = (p) => Object.keys(p.inv || {}).length;
  const packFullFor = (p, id) => !(p.inv || {})[id] && packKinds(p) >= CAP;
  const signed = (d) => (d > 0 ? '+' : d < 0 ? '−' : '±') + Math.abs(d);
  const qtyLabel = (n, name) => `${n > 1 ? n + '× ' : ''}${name}`;

  // How many of an item can be bought in one go: stacks of consumables, one of anything else.
  const buyMax = (p, id) => { const it = ITEMS[id]; return it && it.type === 'consumable' && it.value > 0 ? Math.max(1, Math.min(10, Math.floor(p.gold / it.value))) : 1; };
  // One-line "versus what you wear" for gear: "ATK net +2".
  function netLine(p, id) {
    const it = itemOf(id);
    if (!it.equippable || !SLOT_LIST.includes(it.slot)) return null;
    const curId = (p.eq || {})[it.slot];
    if (curId === id) return { text: 'equipped', cls: 'same' };
    const cur = curId && ITEMS[curId] ? ITEMS[curId] : null;
    let sum = 0;
    const bits = STAT_LABEL.map(([k, l]) => { const d = ((it.stats || {})[k] || 0) - ((cur && cur.stats && cur.stats[k]) || 0); sum += d; return d ? `${l} ${signed(d)}` : null; }).filter(Boolean);
    return { text: (cur ? 'vs ' + cur.name + ': ' : 'slot empty: ') + (bits.join(', ') || 'no change'), cls: sum > 0 ? 'up' : sum < 0 ? 'down' : 'same' };
  }
  const inv = Object.assign({ filter: 'all', sort: 'type', stashOpen: true, tradeTab: 'buy' }, store.get('aidnd.inv') || {}, { sel: null, src: 'pack', qty: 1, confirm: false });
  const saveInv = () => store.set('aidnd.inv', { filter: inv.filter, sort: inv.sort, stashOpen: inv.stashOpen, tradeTab: inv.tradeTab });

  function selectItem(id, src, noToggle) {
    const same = !noToggle && inv.sel === id && inv.src === src;
    inv.sel = same ? null : id; inv.src = src; inv.qty = 1; inv.confirm = false;
    render();
    if (!same) {
      const d = $('invDetail');
      if (d && d.scrollIntoView) { try { d.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { d.scrollIntoView(); } }
    }
  }
  async function invSend(action, okMsg) {
    const ok = await send(action);
    if (ok) {
      inv.confirm = false; inv.qty = 1;
      if (okMsg) toast(okMsg, 'info');
    }
    render();
    return ok;
  }
  function openPack(anchor) {
    ui.tab = 'pack';
    render();
    const el = $(anchor) || $('sheetBox');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start' });
  }

  // Keep the selection valid as the pack, the stash and the merchant change under it.
  function checkSelection(p, shopOpen) {
    if (!inv.sel) return;
    let have = 0;
    if (inv.src === 'pack' || inv.src === 'sell') have = (p.inv || {})[inv.sel] || 0;
    else if (inv.src === 'stash') have = (state.stash || {})[inv.sel] || 0;
    else if (inv.src === 'shop') have = shopOpen && SHOP.includes(inv.sel) && ITEMS[inv.sel] ? buyMax(p, inv.sel) : 0;
    if (inv.src === 'sell' && have && sellOf(inv.sel) <= 0) have = 0;
    if (!have) { inv.sel = null; inv.confirm = false; inv.qty = 1; return; }
    inv.qty = Math.max(1, Math.min(have, inv.qty || 1));
  }

  // ---------------- inventory: sections ----------------

  function heroCard(p, canGive) {
    const scores = p.scores || {};
    const pill = (lbl, v, cls) => h('span', { class: 'pill' + (cls ? ' ' + cls : '') }, h('small', null, lbl), h('b', null, String(v)));
    const R = RACES[raceOf(p)] || {};
    const B = BACKGROUNDS[p.background];
    return h('div', { class: 'inv-hero' },
      h('div', { class: 'hero-top' },
        h('div', { class: 'hero-fig', role: 'img', 'aria-label': `${p.name}, ${raceOf(p)} ${p.cls}${p.alive === false ? ', down' : ''}` },
          figureOf(p, { view: 'full', size: 190, pose: p.alive === false ? 'down' : 'idle', animate: true })),
        h('div', { class: 'hero-tx' },
          h('div', { class: 'who' }, h('b', null, p.name), h('span', null, `${raceOf(p)} ${p.cls} · Level ${p.level}`)),
          (p.background || p.pronouns) && h('p', { class: 'hint' }, [p.background, p.pronouns].filter(Boolean).join(' · ')),
          !!p.bio && h('p', { class: 'bio' }, p.bio),
          !!p.traits && h('p', { class: 'hint trait' }, p.traits),
          h('div', { class: 'tags' },
            R.trait && h('span', { class: 'tag warn', title: R.desc || '' }, R.trait),
            B && h('span', { class: 'tag', title: B.desc }, `${B.skill} +2`),
            h('span', { class: 'tag', title: 'Squares you can move on your turn in a fight' }, `Move ${speedOf(p)}`)))),
      h('div', { class: 'hero-bars' },
        h('div', null, h('div', { class: 'nums' }, h('span', null, 'HP'), h('span', null, `${p.hp}/${p.maxHp}`)), bar('hp', p.hp, p.maxHp)),
        h('div', null, h('div', { class: 'nums' }, h('span', null, 'MP'), h('span', null, `${p.mana}/${p.maxMana}`)), bar('mp', p.mana, p.maxMana))),
      h('div', { class: 'pills' },
        pill('ATK', atkOf(p), 'atk'), pill('DEF', defOf(p), 'def'), pill('Gold', p.gold, 'gold'), pill('XP', p.xp),
        canGive && !ui.give && btn('Give gold…', null, () => { ui.give = { what: 'gold' }; render(); }, { cls: 'ghost mini', k: 'give-open' })),
      canGive && givePanel(p),
      h('div', { class: 'scores' }, ABILITY_NAMES.filter((a) => scores[a] != null).map((a) =>
        h('span', { title: ABILITY_FULL[a] || a }, a, h('b', null, String(scores[a])), h('small', null, mod(scores[a]))))),
      h('div', { class: 'tags' },
        abilitiesOf(p).map((id) => h('span', { class: 'tag good', title: ABILITIES[id].desc || '' }, ABILITIES[id].name)),
        (p.spells || []).filter((id) => SPELLS[id]).map((id) => h('span', { class: 'tag', title: SPELLS[id].description || '' }, SPELLS[id].name))));
  }

  function dollPanel(p) {
    const eq = p.eq || {};
    const slotTile = (slot) => {
      const id = eq[slot] && ITEMS[eq[slot]] ? eq[slot] : null;
      const it = id ? ITEMS[id] : null;
      const on = !!id && inv.sel === id && inv.src === 'pack';
      return h('button', {
        type: 'button', class: `slot slot-${slot} ${it ? 'r-' + rarityOf(it) : 'empty'}${on ? ' sel' : ''}`, 'data-k': 'slot-' + slot,
        'aria-pressed': String(on), 'aria-label': it ? `${SLOT_NAMES[slot]}: ${it.name}${statLine(it) ? ', ' + statLine(it) : ''}` : `${SLOT_NAMES[slot]}: empty`,
        onclick: () => {
          if (id) { selectItem(id, 'pack', true); return; }
          inv.filter = 'gear'; inv.sel = null; saveInv(); render();
          toast(`Nothing in your ${SLOT_NAMES[slot].toLowerCase()} slot. Pick gear from your pack and press Equip.`, 'info');
        },
      },
      h('span', { class: 'slot-ic' }, itemIcon(id || SLOT_SAMPLE[slot], 30)),
      h('span', { class: 'slot-tx' },
        h('span', { class: 'slot-lbl' }, SLOT_NAMES[slot]),
        h('span', { class: 'slot-nm' }, it ? it.name : 'Empty'),
        !!it && !!statLine(it) && h('span', { class: 'slot-st' }, statLine(it))));
    };
    return h('div', { class: 'doll', role: 'group', 'aria-label': 'Equipment' },
      slotTile('weapon'), slotTile('offhand'), slotTile('armor'), slotTile('trinket'));
  }

  function itemTile(p, id, qty, src) {
    const it = itemOf(id);
    const on = inv.sel === id && inv.src === src;
    const worn = src === 'pack' && !!slotOf(p, id);
    return h('button', {
      type: 'button', class: `itile r-${rarityOf(it)}${on ? ' sel' : ''}${worn ? ' worn' : ''}`, 'data-k': `${src}-tile-${id}`, title: it.name,
      'aria-pressed': String(on), 'aria-label': `${it.name}, ${qty}, ${typeName(it).toLowerCase()}${worn ? ', equipped' : ''}`,
      onclick: () => selectItem(id, src),
    },
    itemIcon(id, 30),
    qty > 1 && h('span', { class: 'qty', 'aria-hidden': 'true' }, String(qty)),
    worn && h('span', { class: 'worn-mark', 'aria-hidden': 'true' }, 'E'),
    h('span', { class: 'iname', 'aria-hidden': 'true' }, it.name));
  }

  // Arrow keys move between tiles in a grid.
  function gridKeys(ev) {
    const tiles = Array.from(ev.currentTarget.querySelectorAll('.itile'));
    const i = tiles.indexOf(document.activeElement);
    if (i < 0) return;
    const cols = Math.max(1, tiles.filter((t) => t.offsetTop === tiles[0].offsetTop).length);
    const j = { ArrowRight: i + 1, ArrowLeft: i - 1, ArrowDown: i + cols, ArrowUp: i - cols, Home: 0, End: tiles.length - 1 }[ev.key];
    if (j == null) return;
    ev.preventDefault();
    if (tiles[j]) tiles[j].focus();
  }

  function packPanel(p, ctx) {
    const ids = Object.keys(p.inv || {}).filter((id) => p.inv[id] > 0);
    const kinds = packKinds(p);
    const count = (f) => ids.filter((id) => inFilter(itemOf(id), f)).length;
    const rank = (id) => { const i = TYPE_ORDER.indexOf(typeKey(itemOf(id))); return i < 0 ? 99 : i; };
    const byName = (a, b) => itemOf(a).name.localeCompare(itemOf(b).name);
    const cmp = inv.sort === 'name' ? byName
      : inv.sort === 'value' ? (a, b) => ((itemOf(b).value || 0) - (itemOf(a).value || 0)) || byName(a, b)
        : (a, b) => (rank(a) - rank(b)) || byName(a, b);
    const shown = ids.filter((id) => inFilter(itemOf(id), inv.filter)).sort(cmp);
    const keep = Array.isArray(p.keep) ? p.keep : [];
    const full = kinds >= CAP;
    return h('section', { class: 'inv-sec', 'aria-labelledby': 'packHead' },
      h('div', { class: 'sec-head' },
        h('h4', { id: 'packHead' }, 'Pack'),
        h('div', { class: 'cap' + (full ? ' full' : kinds >= CAP - 2 ? ' near' : ''), title: `Your pack holds ${CAP} kinds of item. Stacks of the same item count once.` },
          h('span', { class: 'cap-num' }, `${kinds} / ${CAP}`),
          h('span', { class: 'cap-bar', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': CAP, 'aria-valuenow': kinds, 'aria-label': `Pack space: ${kinds} of ${CAP} kinds of item` }, h('i', { style: { width: pct(kinds, CAP) } })))),
      h('div', { class: 'inv-tools' },
        h('div', { class: 'fchips', role: 'group', 'aria-label': 'Show' }, FILTERS.map(([f, label]) => {
          const n = f === 'all' ? ids.length : count(f);
          return h('button', { type: 'button', class: 'fchip', 'data-k': 'filter-' + f, 'aria-pressed': String(inv.filter === f),
            onclick: () => { inv.filter = f; saveInv(); render(); } }, label, h('span', { class: 'n' }, String(n)));
        })),
        h('label', { class: 'sortby' }, h('span', null, 'Sort'),
          h('select', { 'data-k': 'inv-sort', onchange: (ev) => { inv.sort = ev.target.value; saveInv(); render(); } },
            SORTS.map(([v, label]) => h('option', { value: v, selected: inv.sort === v }, label))))),
      shown.length
        ? h('div', { class: 'igrid', role: 'group', 'aria-label': 'Items in your pack', onkeydown: gridKeys }, shown.map((id) => itemTile(p, id, p.inv[id], 'pack')))
        : h('p', { class: 'hint empty-note' }, ids.length ? 'Nothing of that kind in your pack.' : 'Your pack is empty.'),
      full && h('p', { class: 'hint warn' }, 'Your pack is full. New loot goes to the party stash; sell, stash or drop something to make room.'),
      inv.sel && inv.src === 'pack' && detailPanel(p, ctx),
      keep.length > 0 && h('div', { class: 'keep' }, h('span', { class: 'lbl' }, 'Keepsakes'),
        h('ul', null, keep.map((k) => h('li', null, k)))));
  }

  function compareBlock(p, id) {
    const it = itemOf(id);
    const slot = it.slot;
    if (!it.equippable || !SLOT_LIST.includes(slot)) return null;
    const curId = (p.eq || {})[slot];
    if (curId === id) return h('p', { class: 'cmp-note' }, `Worn in your ${SLOT_NAMES[slot].toLowerCase()} slot.`);
    const cur = curId && ITEMS[curId] ? ITEMS[curId] : null;
    const totals = { attack: atkOf(p), defense: defOf(p) };
    const rows = STAT_LABEL.filter(([k]) => (it.stats || {})[k] || (cur && (cur.stats || {})[k])).map(([k, l]) => {
      const a = (cur && cur.stats && cur.stats[k]) || 0;
      const b = (it.stats || {})[k] || 0;
      const d = b - a;
      return h('li', { class: d > 0 ? 'up' : d < 0 ? 'down' : 'same' },
        h('span', null, `${l} +${a} → +${b}`),
        h('b', null, d === 0 ? 'no change' : `net ${signed(d)}`),
        totals[k] != null && d !== 0 && h('small', null, `${l} ${totals[k]} → ${totals[k] + d}`));
    });
    return h('div', { class: 'cmp' },
      h('span', { class: 'lbl' }, cur ? `Compared with your ${cur.name}` : `Your ${SLOT_NAMES[slot].toLowerCase()} slot is empty`),
      rows.length ? h('ul', null, rows) : h('p', { class: 'hint' }, 'No stat difference.'));
  }

  function stepper(max) {
    if (max <= 1) return null;
    const set = (n) => { inv.qty = Math.max(1, Math.min(max, n)); inv.confirm = false; render(); };
    return h('div', { class: 'stepper', role: 'group', 'aria-label': 'Quantity' },
      h('span', { class: 'lbl' }, 'Qty'),
      btn('−', null, () => set(inv.qty - 1), { k: 'qty-dec', disabled: inv.qty <= 1, title: 'One fewer' }),
      h('output', { 'aria-live': 'polite', 'aria-label': `Quantity ${inv.qty} of ${max}` }, `${inv.qty}`),
      btn('+', null, () => set(inv.qty + 1), { k: 'qty-inc', disabled: inv.qty >= max, title: 'One more' }),
      btn('All', null, () => set(max), { k: 'qty-all', disabled: inv.qty >= max, cls: 'ghost' }),
      h('small', null, `of ${max}`));
  }

  function detailPanel(p, ctx) {
    const id = inv.sel;
    const it = itemOf(id);
    const src = inv.src;
    const rar = rarityOf(it);
    const owned = (p.inv || {})[id] || 0;
    const stashed = (state.stash || {})[id] || 0;
    const worn = slotOf(p, id);
    const price = sellOf(id);
    const quest = it.type === 'quest';
    const qty = inv.qty;
    const { inCombat, turn, shopOpen, people } = ctx;
    const canGear = !inCombat || turn;
    const notes = [];
    const acts = [];

    const whole = src === 'pack';      // the full set of actions; 'sell' is the trade window's short list
    if (src === 'pack' || src === 'sell') {
      if (it.equippable && SLOT_LIST.includes(it.slot)) {
        if (worn) acts.push(btn('Unequip', SLOT_NAMES[worn], () => invSend({ t: 'unequip', slot: worn }), { k: 'd-unequip', disabled: !canGear }));
        else acts.push(btn('Equip', SLOT_NAMES[it.slot], () => invSend({ t: 'equip', item: id }), { cls: 'primary', k: 'd-equip', disabled: !canGear }));
      }
      if (whole && it.type === 'consumable') {
        const tgt = state.players[sel.ally] && state.players[sel.ally].cls ? sel.ally : myId;
        acts.push(btn(tgt === myId ? 'Use on yourself' : `Use on ${nameOf(tgt)}`, null, () => invSend({ t: 'use', item: id, target: tgt }), { cls: worn ? '' : 'primary', k: 'd-use', disabled: !canGear }));
        if (people.length) notes.push(tgt === myId ? 'To use it on an ally, target them on the Party tab.' : `Targeting ${nameOf(tgt)}. Change the target on the Party tab.`);
      }
      if (shopOpen && !quest && price > 0) acts.push(btn(`Sell${qty > 1 ? ' ' + qty : ''}`, `${price * qty} gold`, () => invSend({ t: 'sell', item: id, qty }, `Sold ${qtyLabel(qty, it.name)} for ${price * qty} gold.`), { k: 'd-sell', disabled: inCombat }));
      if (whole) acts.push(btn(`Stash${qty > 1 ? ' ' + qty : ''}`, 'party stash', () => invSend({ t: 'stash', item: id, qty }, `${qtyLabel(qty, it.name)} put in the party stash.`), { k: 'd-stash', disabled: inCombat }));
      if (whole && !quest) acts.push(btn('Drop…', null, () => { inv.confirm = true; render(); const y = document.querySelector('[data-k="d-drop-yes"]'); if (y) y.focus(); }, { cls: 'ghost warnbtn', k: 'd-drop', disabled: inCombat || inv.confirm }));
      if (inCombat) notes.push(turn ? 'Mid-fight you can change gear and use items. Trading, stashing and dropping wait until the fight is over.' : 'Wait for your turn to change gear or use items.');
      if (quest) notes.push(whole ? 'Quest items cannot be dropped or sold. You can keep them in the party stash.' : 'Quest items cannot be sold.');
      if (worn && owned === 1 && !inCombat) notes.push(whole ? 'Selling, stashing, giving or dropping it takes it off.' : 'Selling it takes it off.');
    } else if (src === 'shop') {
      const full = packFullFor(p, id);
      const poor = p.gold < (it.value || 0);
      acts.push(btn(`Buy${qty > 1 ? ' ' + qty : ''}`, `${it.value * qty} gold`, () => buyMany(id, qty), { cls: 'primary', k: 'd-buy', disabled: poor || full || inCombat }));
      if (poor) notes.push(`You need ${it.value - p.gold} more gold.`);
      if (full) notes.push(`Your pack is full (${CAP} kinds of item).`);
      if (owned) notes.push(`You carry ${owned}.`);
    } else if (src === 'stash') {
      const full = packFullFor(p, id);
      acts.push(btn(`Take${qty > 1 ? ' ' + qty : ''}`, 'into your pack', () => invSend({ t: 'unstash', item: id, qty }, `Took ${qtyLabel(qty, it.name)} from the stash.`), { cls: 'primary', k: 'd-take', disabled: inCombat || full }));
      if (full) notes.push(`Your pack is full (${CAP} kinds of item).`);
      if (inCombat) notes.push('The stash opens again when the fight is over.');
    }

    const giveTo = people.includes(sel.ally) ? sel.ally : people[0];
    const giveRow = whole && people.length > 0 && h('div', { class: 'give-row' },
      h('label', null, h('span', { class: 'lbl' }, 'Give one to'),
        h('select', { 'data-keep': 'invGiveTo', 'aria-label': 'Who receives it', disabled: inCombat },
          people.map((pid) => h('option', { value: pid, selected: pid === giveTo }, nameOf(pid))))),
      btn('Give', null, () => {
        const to = keepVal('invGiveTo') || giveTo;
        invSend({ t: 'give', to, item: id }, `Gave ${it.name} to ${nameOf(to)}.`);
      }, { k: 'd-give', disabled: inCombat }));

    const confirm = whole && inv.confirm && h('div', { class: 'confirm', role: 'group', 'aria-label': 'Confirm drop' },
      h('p', null, `Drop ${qtyLabel(qty, it.name)}? It is gone for good.`),
      h('div', { class: 'btns' },
        btn(`Drop ${qty > 1 ? qty : 'it'}`, null, () => invSend({ t: 'drop', item: id, qty }, `Dropped ${qtyLabel(qty, it.name)}.`), { cls: 'danger', k: 'd-drop-yes' }),
        btn('Keep it', null, () => { inv.confirm = false; render(); }, { k: 'd-drop-no' })));

    const max = src === 'pack' || src === 'sell' ? owned : src === 'stash' ? stashed : buyMax(p, id);
    return h('div', { class: `detail r-${rar}`, id: 'invDetail', role: 'region', 'aria-label': `${it.name} details` },
      h('div', { class: 'd-head' },
        h('span', { class: 'd-ic' }, itemIcon(id, 44)),
        h('div', { class: 'd-title' },
          h('b', null, it.name),
          h('span', null, h('span', { class: 'rar r-' + rar }, RARITY[rar]), ` · ${typeName(it)}`,
 (src === 'pack' || src === 'sell') && owned > 1 ? ` · ×${owned}` : '', src === 'shop' && owned ? ` · you have ${owned}` : '', src === 'stash' ? ` · ×${stashed} in stash` : '', worn ? ' · equipped' : '')),
        btn('×', null, () => { inv.sel = null; inv.confirm = false; render(); }, { cls: 'ghost close', k: 'd-close', title: 'Close details' })),
      !!it.description && h('p', { class: 'd-desc' }, it.description),
      (statLine(it) || (it.effects || []).length > 0) && h('ul', { class: 'd-stats' },
        STAT_LABEL.filter(([k]) => (it.stats || {})[k]).map(([k, l]) => h('li', null, `+${it.stats[k]} ${l}`)),
        (it.effects || []).map((e) => h('li', { class: 'fx' }, effectText(e)))),
      h('p', { class: 'd-value' }, `Value ${it.value || 0} gold`, ' · ', quest ? 'cannot be sold' : price > 0 ? `sells for ${price} each` : 'worthless to a merchant'),
      compareBlock(p, id),
      stepper(max),
      h('div', { class: 'btns d-acts' }, acts),
      giveRow,
      confirm,
      notes.map((n) => h('p', { class: 'hint' }, n)));
  }

  async function buyMany(id, n) {
    const it = itemOf(id);
    let got = 0;
    for (let i = 0; i < n; i++) {
      if (!(await send({ t: 'buy', item: id }))) break;
      got++;
    }
    inv.qty = 1;
    if (got) toast(`Bought ${qtyLabel(got, it.name)} for ${got * (it.value || 0)} gold.`, 'info');
    render();
  }

  // The trade window: buy from Engine.SHOP, sell from your pack.
  function tradePanel(p, ctx) {
    const sellable = Object.keys(p.inv || {}).filter((id) => p.inv[id] > 0).sort((a, b) => (sellOf(b) - sellOf(a)) || itemOf(a).name.localeCompare(itemOf(b).name));
    const kinds = packKinds(p);
    const row = (id, src, sub, right, extra) => {
      const it = itemOf(id);
      const on = inv.sel === id && inv.src === src;
      const nl = netLine(p, id);
      return h('li', { class: `trow r-${rarityOf(it)}${on ? ' sel' : ''}${extra && extra.dim ? ' dim' : ''}` },
        h('button', { type: 'button', class: 'trow-main', 'data-k': `${src}-row-${id}`, 'aria-pressed': String(on),
          'aria-label': `${it.name}, ${typeName(it).toLowerCase()}, ${sub}. Show details`, onclick: () => selectItem(id, src) },
        itemIcon(id, 28),
        h('span', { class: 'tn' },
          h('span', null, it.name),
          h('small', null, sub),
          !!nl && src === 'shop' && h('small', { class: 'net ' + nl.cls }, nl.text))),
        right);
    };
    const tabBtn = (t, label) => h('button', { type: 'button', role: 'tab', 'data-k': 'ttab-' + t, 'aria-selected': String(inv.tradeTab === t),
      onclick: () => { inv.tradeTab = t; saveInv(); render(); } }, label);
    return [
      h('div', { class: 'trade-top' },
        h('span', { class: 'pill gold' }, h('small', null, 'Gold'), h('b', null, String(p.gold))),
        h('span', { class: 'cap' + (kinds >= CAP ? ' full' : kinds >= CAP - 2 ? ' near' : '') }, h('span', { class: 'cap-num' }, `Pack ${kinds} / ${CAP}`)),
        h('span', { class: 'hint' }, 'Merchants pay half an item’s value.')),
      h('div', { class: 'trade-tabs', role: 'tablist', 'aria-label': 'Buy or sell' }, tabBtn('buy', 'Buy'), tabBtn('sell', 'Sell')),
      h('div', { class: 'trade-cols', 'data-show': inv.tradeTab },
        h('div', { class: 'tcol buy' }, h('span', { class: 'lbl' }, 'Buy'),
          h('ul', { class: 'tlist' }, SHOP.filter((id) => ITEMS[id]).map((id) => {
            const it = ITEMS[id];
            const poor = p.gold < it.value;
            const full = packFullFor(p, id);
            const have = (p.inv || {})[id] || 0;
            const why = poor ? `need ${it.value - p.gold} more gold` : full ? 'pack full' : '';
            const sub = [shortInfo(it), have ? `have ${have}` : '', why].filter(Boolean).join(' · ');
            return row(id, 'shop', sub, h('button', { type: 'button', class: 'tprice buy', 'data-k': 'buy-' + id, disabled: poor || full || ctx.inCombat,
              title: poor ? `You need ${it.value - p.gold} more gold` : full ? 'Your pack is full' : `Buy ${it.name}`,
              'aria-label': `Buy ${it.name} for ${it.value} gold${why ? ' (' + why + ')' : ''}`, onclick: () => buyMany(id, 1) }, `${it.value} g`), { dim: poor || full });
          }))),
        h('div', { class: 'tcol sell' }, h('span', { class: 'lbl' }, 'Sell'),
          sellable.length
            ? h('ul', { class: 'tlist' }, sellable.map((id) => {
              const it = itemOf(id);
              const price = sellOf(id);
              const quest = it.type === 'quest';
              const worn = slotOf(p, id);
              const sub = [p.inv[id] > 1 ? `×${p.inv[id]}` : '', worn ? 'equipped' : '', quest ? 'quest item, not for sale' : price <= 0 ? 'worthless here' : `${price} g each`].filter(Boolean).join(' · ');
              return row(id, 'sell', sub, quest || price <= 0
                ? h('span', { class: 'tprice none', 'aria-hidden': 'true' }, '—')
                : h('button', { type: 'button', class: 'tprice sell', 'data-k': 'sell-' + id, disabled: ctx.inCombat,
                  'aria-label': `Sell one ${it.name} for ${price} gold${worn ? ' (equipped)' : ''}`,
                  onclick: () => invSend({ t: 'sell', item: id, qty: 1 }, `Sold ${it.name} for ${price} gold.`) }, `${price} g`), { dim: quest || price <= 0 });
            }))
            : h('p', { class: 'hint' }, 'Your pack is empty.'),
          h('p', { class: 'hint' }, 'Select an item to sell several at once.'))),
      inv.sel && (inv.src === 'shop' || inv.src === 'sell') && detailPanel(p, ctx),
    ];
  }

  const shopNow = () => !!state && state.phase === 'scene' && !!(state.scene || {}).shop && !!me() && !!me().cls;
  function openTrade() {
    if (!shopNow()) { toast('There is no merchant here. Ask around: when one is present, the trade window opens.'); return; }
    if (inv.src !== 'shop' && inv.src !== 'sell') { inv.sel = null; }
    delete sigs.trade;
    openDlg('tradeDlg');
    renderTrade();
  }
  const typing = () => { const a = document.activeElement; return !!a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && a.type !== 'checkbox' && a.type !== 'range')) && !!a.value.trim(); };

  function renderTrade() {
    const flag = !!(state.scene || {}).shop;
    const open = shopNow();
    $('tradeCta').hidden = !open;
    $('shopMark').hidden = !open;
    // A merchant appears during play: offer the trade window once.
    if (ui.shopWas === false && flag && state.phase === 'scene' && open && liveLoad) {
      toast('A merchant is ready to trade.', 'info');
      if (!typing() && !$('tradeDlg').open && !document.querySelector('dialog[open]')) openTrade();
    }
    ui.shopWas = state.phase === 'lobby' ? undefined : flag;
    const d = $('tradeDlg');
    if (!d.open) return;
    if (!open) { closeDlg('tradeDlg'); toast(state.phase === 'combat' ? 'Trading stops: a fight breaks out!' : 'The merchant is no longer here.'); return; }
    const p = me();
    $('tradeGold').textContent = `${p.gold} gold`;
    const people = others().filter((id) => !!state.players[id].cls);
    if (inv.src === 'shop' || inv.src === 'sell') checkSelection(p, true);
    const ctx = { inCombat: false, turn: false, shopOpen: true, people };
    paint('trade', $('tradeBody'), [p, inv, state.phase], () => tradePanel(p, ctx));
  }

  function stashPanel(p, ctx) {
    const st = state.stash || {};
    const ids = Object.keys(st).filter((id) => st[id] > 0).sort((a, b) => itemOf(a).name.localeCompare(itemOf(b).name));
    const open = !!inv.stashOpen;
    return h('section', { class: 'inv-sec stash', 'aria-labelledby': 'stashHead' },
      h('div', { class: 'sec-head' },
        h('h4', { id: 'stashHead' },
          h('button', { type: 'button', class: 'sec-toggle', 'data-k': 'stash-toggle', 'aria-expanded': String(open),
            onclick: () => { inv.stashOpen = !open; saveInv(); render(); } }, h('span', { class: 'chev', 'aria-hidden': 'true' }, open ? '▾' : '▸'), 'Party stash')),
        h('span', { class: 'hint' }, ids.length ? `${ids.length} kind${ids.length === 1 ? '' : 's'} of item` : 'empty')),
      open && [
        ids.length
          ? h('ul', { class: 'tlist slist' }, ids.map((id) => {
            const it = itemOf(id);
            const full = packFullFor(p, id);
            const on = inv.sel === id && inv.src === 'stash';
            return h('li', { class: `trow r-${rarityOf(it)}${on ? ' sel' : ''}` },
              h('button', { type: 'button', class: 'trow-main', 'data-k': 'stash-row-' + id, 'aria-pressed': String(on), 'aria-label': `${it.name}, ${st[id]}, ${typeName(it).toLowerCase()}. Show details`, onclick: () => selectItem(id, 'stash') },
                itemIcon(id, 24), h('span', { class: 'tn' }, h('span', null, `${it.name}${st[id] > 1 ? ' ×' + st[id] : ''}`), h('small', null, shortInfo(it)))),
              h('span', { class: 'trow-btns' },
                h('button', { type: 'button', class: 'tprice', 'data-k': 'take-' + id, disabled: ctx.inCombat || full, title: full ? 'Your pack is full' : '', 'aria-label': `Take one ${it.name}`,
                  onclick: () => invSend({ t: 'unstash', item: id, qty: 1 }, `Took ${it.name} from the stash.`) }, 'Take'),
                st[id] > 1 && h('button', { type: 'button', class: 'tprice ghost', 'data-k': 'takeall-' + id, disabled: ctx.inCombat || full, 'aria-label': `Take all ${st[id]} ${it.name}`,
                  onclick: () => invSend({ t: 'unstash', item: id, qty: st[id] }, `Took ${st[id]}× ${it.name} from the stash.`) }, 'All')));
          }))
          : null,
        h('p', { class: 'hint' }, 'Shared by the whole party. Select an item in your pack and press Stash to leave it here; loot that does not fit in a full pack lands here too.'),
        inv.sel && inv.src === 'stash' && detailPanel(p, ctx),
      ]);
  }

  function renderSheet() {
    const p = me();
    const inCombat = state.phase === 'combat';
    const turn = myTurn();
    const sc = state.scene || {};
    const shopOpen = state.phase === 'scene' && !!sc.shop;
    const people = others().filter((id) => !!state.players[id].cls);
    const roster = people.map((id) => [id, nameOf(id)]);
    if (p && p.cls && inv.src !== 'shop' && inv.src !== 'sell') checkSelection(p, shopOpen);
    paint('sheet', $('sheet'), [p, state.stash, shopOpen, inCombat, turn, sel.ally, ui.give, roster, state.phase, inv, cfVer()], () => {
      if (!p || !p.cls) return h('p', { class: 'hint' }, 'Create your character and your sheet appears here.');
      const ctx = { inCombat, turn, shopOpen, people };
      const canGive = !inCombat && people.length > 0;
      return h('div', { class: 'inventory' },
        heroCard(p, canGive),
        dollPanel(p),
        packPanel(p, ctx),
        shopOpen && h('div', { class: 'trade-banner' }, h('span', null, 'A merchant is here.'),
          btn('Trade with the merchant', 'buy and sell', openTrade, { cls: 'primary', k: 'pack-trade' })),
        stashPanel(p, ctx));
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
      renderTables();
      if (tablesOn() && !tbl.loading && Date.now() - tbl.at > 10000) loadTables();
      return;
    }
    if (ui.give && state.phase === 'combat') ui.give = null;
    renderHeader(); renderTabs(); renderScene(); renderLobby(); renderDm(); renderDock();
    renderComposer(); renderParty(); renderSheet(); renderTrade(); renderJournal(); renderLog();
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
    $('saveFileBtn').hidden = isArtifact();
    const o = (state && state.opts) || {};
    $('tableSet').hidden = !isHost();
    $('listedRow').hidden = isArtifact();
    $('listedBox').checked = o.listed !== false;
    $('lockedBox').checked = !!o.locked;
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

  // ---------------- campaign save files ----------------
  // A save file holds the whole party plus your rejoin code, so a campaign can be resumed on any
  // server, any device, even after the server forgot it.
  function downloadSave() {
    if (!state || isArtifact()) return;
    const data = JSON.stringify({ kind: 'ai-dnd-save', v: 1, at: Date.now(), code: state.code, rejoin: (session && session.rejoin) || '', name: (session && session.name) || '', room: state });
    try {
      const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
      const a = h('a', { href: url, download: `ai-dnd-${String(state.code).toLowerCase()}-save.json`, hidden: true });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast('Campaign saved to your downloads. Keep it to resume this party any time.', 'info');
    } catch (e) { toast('The save could not be downloaded.'); }
  }
  async function loadSaveFile(file) {
    if (!file || !N || !N.restore) return;
    let save = null;
    try { save = JSON.parse(await file.text()); } catch (e) { save = null; }
    if (!save || save.kind !== 'ai-dnd-save' || !save.room || !save.code) { joinNote('That file is not an AI-DnD campaign save.'); return; }
    const name = $('nameInput').value.trim() || save.name || 'Adventurer';
    const prior = store.get('aidnd.session');
    const token = prior && prior.code === save.code && prior.token ? prior.token : save.rejoin;
    if (!token) { joinNote('That save has no rejoin code in it, so it cannot reclaim a seat.'); return; }
    joinNote('Resuming your campaign…', true);
    setJoinBusy(true);
    try {
      const res = await N.restore(save.code, name, token, save.room);
      if (res && res.token) { enter(res, save.name || name, Object.assign({}, prior || {}, { code: save.code, rejoin: save.rejoin })); toast(res.restored ? 'Campaign restored from your save file.' : 'Welcome back to your party.', 'info'); }
      else joinNote((res && res.error) || 'That save could not be resumed.');
    } catch (e) { joinNote('Could not reach the server. Check your connection.'); }
    setJoinBusy(false);
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
    loadTables();
    if (isArtifact()) {
      const hint = $('modeHint');
      hint.textContent = 'Playing inside Claude: everyone opens this same page and uses the party code. Friends need a Claude account and access to this page to take a seat.';
      hint.hidden = false;
      $('loadSaveRow').hidden = true;
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
  $('saveFileBtn').addEventListener('click', downloadSave);
  $('loadSaveBtn').addEventListener('click', () => $('loadSave').click());
  $('loadSave').addEventListener('change', (ev) => { const f = ev.target.files && ev.target.files[0]; ev.target.value = ''; loadSaveFile(f); });
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

  $('tradeCta').addEventListener('click', openTrade);
  $('shopMark').addEventListener('click', openTrade);
  $('tradeDlg').addEventListener('close', () => {
    if (inv.src === 'shop' || inv.src === 'sell') { inv.sel = null; inv.confirm = false; inv.qty = 1; }
    if (state) render();
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

  ['listedBox', 'lockedBox'].forEach((id) => $(id).addEventListener('change', async (ev) => {
    const key = id === 'listedBox' ? 'listed' : 'locked';
    const v = !!ev.target.checked;
    if (!(await send({ t: 'opts', [key]: v }))) ev.target.checked = !v;
  }));
  $('tablesRefresh').addEventListener('click', () => { tbl.at = 0; loadTables(); });
  // The open tables refresh every 10 s while the join screen shows (and at once when the tab comes back).
  setInterval(() => { if (document.visibilityState !== 'hidden' && tablesOn()) loadTables(); }, 10000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && tablesOn() && Date.now() - tbl.at > 5000) loadTables(); });
  // The creator and figures are sized for the window: redraw them when it crosses the phone breakpoint.
  try {
    const mq = window.matchMedia('(max-width: 620px)');
    const again = () => { delete sigs.cc; if (session && state) render(); };
    if (mq.addEventListener) mq.addEventListener('change', again); else if (mq.addListener) mq.addListener(again);
  } catch (e) { /* optional */ }

  // Once a second: the DM timer, and time-based buttons (nudge, roll for an absent player, skip).
  setInterval(() => {
    if (!session || !state) return;
    renderDm();
    if (state.phase === 'combat') renderDock();
  }, 1000);

  boot();
})();
