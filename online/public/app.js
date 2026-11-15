/* AI-DnD Online — browser client. Talks to server.js over SSE + POST, or,
 * when published as a Claude artifact, to the artifact's shared document store. */
(function () {
  'use strict';
  const E = window.Engine;
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const k in props || {}) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'disabled' || k === 'checked' || k === 'selected') el[k] = !!v;
      else el.setAttribute(k, v);
    }
    kids.flat().forEach((c) => { if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c))); });
    return el;
  }

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };

  // ---------------- transports ----------------

  function serverTransport() {
    let es = null, creds = null;
    const post = async (url, body) => {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return res.json().catch(() => ({ error: 'The server gave an unreadable answer.' }));
    };
    return {
      kind: 'server',
      create: (name) => post('/api/create', { name }),
      join: (code, name, token) => post('/api/join', { code, name, token }),
      listen(c, onState, onLost) {
        creds = c;
        if (es) es.close();
        es = new EventSource(`/api/events?code=${encodeURIComponent(c.code)}&token=${encodeURIComponent(c.token)}`);
        es.onopen = () => setConn(true);
        es.onmessage = (ev) => { setConn(true); onState(JSON.parse(ev.data)); };
        es.onerror = () => { setConn(false); if (es.readyState === 2) onLost(); };
      },
      act: (action) => post('/api/action', { code: creds.code, token: creds.token, action }),
      stop() { if (es) es.close(); es = null; },
      inviteText: (code) => `${location.origin}${location.pathname}#${code}`,
    };
  }

  function artifactTransport(db, sample) {
    let myId = (store.get('aidnd.id') || 'p' + Math.random().toString(36).slice(2, 12));
    store.set('aidnd.id', myId);
    let code = null, unsub = null, aiOn = !!sample;
    const ref = (c) => db.doc('rooms/' + c);
    const clone = (o) => JSON.parse(JSON.stringify(o));

    async function mutate(c, fn) {
      let held = false;
      for (let i = 0; i < 12 && !held; i++) {
        held = (await ref(c).acquire({ holder: myId, ttlMs: 1500 })).acquired;
        if (!held) await sleep(200 + Math.random() * 250);
      }
      if (!held) return { ok: false, error: 'The table is busy. Try again.' };
      const snap = await ref(c).get();
      const data = snap.exists ? snap.data() : null;
      const room = data && data.state ? clone(data.state) : null;
      const out = fn(room);
      if (out && out.ok && out.room) await ref(c).set({ state: out.room });
      return out;
    }
    const explain = (e) => ({ error: e && e.code === 'invalid_argument'
      ? 'You have view-only access to this page. Ask its owner to invite you by email as an Editor so you can play.'
      : 'Could not reach the shared table. Try again.' });

    function narrate(reqs) {
      if (!aiOn) return;
      reqs.slice(0, 2).forEach(async (req) => {
        try {
          const { text } = await sample(req.prompt, { modelTier: 'quick', cache: false });
          await mutate(code, (room) => (room && E.setNarration(room, req.id, text) ? { ok: true, room } : { ok: false }));
        } catch (e) {
          if (e && ['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed'].includes(e.code)) { aiOn = false; render(); }
        }
      });
    }

    return {
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
            if (out.ok) return { code: c, playerId: myId, token: myId };
            if (!out.taken) return { error: out.error };
          }
          return { error: 'Could not create a party. Try again.' };
        } catch (e) { return explain(e); }
      },
      async join(c, name) {
        try {
          const out = await mutate(c, (room) => {
            if (!room) return { ok: false, error: `No party with the code ${c}. Check the code, or create a new party.` };
            const r = E.addPlayer(room, myId, name);
            return r.ok ? { ok: true, room } : r;
          });
          return out.ok ? { code: c, playerId: myId, token: myId } : { error: out.error };
        } catch (e) { return explain(e); }
      },
      listen(c, onState, onLost) {
        code = c.code;
        if (unsub) unsub();
        const timer = setTimeout(() => setConn(false), 10000);
        unsub = ref(code).onSnapshot((snap) => {
          const data = snap.exists ? snap.data() : null;
          if (!data || !data.state) return;
          clearTimeout(timer); setConn(true);
          onState(Object.assign(clone(data.state), { ai: aiOn }));
        }, () => { clearTimeout(timer); setConn(false); });
      },
      async act(action) {
        try {
          const out = await mutate(code, (room) => {
            if (!room) return { ok: false, error: 'This party no longer exists.' };
            const r = E.act(room, myId, action);
            return r.ok ? { ok: true, room, narr: r.narr } : r;
          });
          if (out.ok && out.narr) narrate(out.narr);
          return out;
        } catch (e) { return explain(e); }
      },
      stop() { if (unsub) unsub(); unsub = null; },
      inviteText: (c) => c,
    };
  }

  // ---------------- state ----------------

  let T = null;            // transport
  let state = null;        // latest room snapshot
  let myId = null;
  let session = null;      // { code, token, name }
  const sel = { enemy: null, ally: null };
  let panel = null;        // 'shop' | 'attempt' | null
  let busy = false;
  const logEls = new Map();

  function setConn(ok) {
    const chip = $('connChip');
    chip.textContent = ok ? 'Connected' : 'Reconnecting…';
    chip.className = 'chip ' + (ok ? 'good' : 'bad');
  }
  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
  }

  async function send(action) {
    if (busy) return;
    busy = true;
    document.body.classList.add('busy');
    try {
      const r = await T.act(action);
      if (r && r.ok === false && r.error) toast(r.error);
      else if (r && r.error) toast(r.error);
    } catch (e) { toast('Could not reach the table. Check your connection.'); }
    busy = false;
    document.body.classList.remove('busy');
  }
  // Ignore clicks while an action is in flight (body.busy dims the buttons).

  function enter(res, name) {
    session = { code: res.code, token: res.token, name };
    myId = res.playerId;
    store.set('aidnd.session', session);
    try { history.replaceState(null, '', '#' + res.code); } catch (e) { location.hash = res.code; }
    T.listen(session, (s) => { state = s; render(); }, async () => {
      const again = await T.join(session.code, session.name, session.token).catch(() => null);
      if (again && again.token) T.listen(session, (s) => { state = s; render(); }, leave);
      else leave('That party has ended. Start a new one.');
    });
    render();
  }

  function leave(msg) {
    if (T) T.stop();
    state = null; session = null; myId = null; logEls.clear();
    $('log').replaceChildren();
    store.set('aidnd.session', null);
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
    $('joinNote').textContent = typeof msg === 'string' ? msg : '';
    render();
  }

  // ---------------- rendering ----------------

  const pct = (a, b) => Math.max(0, Math.min(100, b ? (a / b) * 100 : 0)) + '%';
  const bar = (cls, a, b) => h('div', { class: 'bar ' + cls }, h('i', { style: 'width:' + pct(a, b) }));
  const FX = { stun: ['Stunned', 'bad'], slow: ['Slowed', 'warn'], weak: ['Weakened', 'warn'], invuln: ['Shielded', 'good'], str: ['Empowered', 'good'], guard: ['Guarding', 'good'] };
  const fxTags = (c) => (c.fx || []).map((f) => h('span', { class: 'tag ' + (FX[f.k] || ['', ''])[1] }, (FX[f.k] || [f.k])[0]));

  function me() { return state && state.players[myId]; }
  function myTurn() { return state.phase === 'combat' && state.combat && state.combat.turn === myId; }

  function renderParty() {
    const cur = state.combat && state.combat.turn;
    $('party').replaceChildren(...state.order.map((id) => {
      const p = state.players[id];
      const cls = ['pc', cur === id && 'turn', sel.ally === id && 'sel', p.cls && !p.alive && 'down'].filter(Boolean).join(' ');
      return h('button', { class: cls, type: 'button', title: 'Target this ally', onclick: () => { sel.ally = sel.ally === id ? null : id; render(); } },
        h('div', { class: 'nm' },
          h('b', null, h('i', { class: 'dot' + (p.online === false ? ' off' : '') }), p.name + (id === myId ? ' (you)' : '')),
          h('span', null, p.cls ? `${p.cls} · Lv ${p.level}` : 'choosing…')),
        p.cls && bar('hp', p.hp, p.maxHp),
        p.cls && bar('mp', p.mana, p.maxMana),
        p.cls && h('div', { class: 'nums' }, h('span', null, `HP ${p.hp}/${p.maxHp}`), h('span', null, `MP ${p.mana}/${p.maxMana}`)),
        h('div', { class: 'tags' }, p.cls && !p.alive && h('span', { class: 'tag bad' }, 'Down'), cur === id && h('span', { class: 'tag warn' }, 'Acting'), fxTags(p)));
    }));
  }

  function renderScene() {
    $('locName').textContent = state.phase === 'lobby' ? 'The Rusty Axe Tavern' : E.locationOf(state);
    const here = state.phase === 'combat' ? state.stage + 1 : state.stage;
    $('pips').replaceChildren(...[E.HOME].concat(E.STAGES.map((s) => s.loc)).map((loc, i) =>
      h('li', { title: loc, class: [i < here && 'done', i === here && 'here', i === E.STAGES.length && 'boss'].filter(Boolean).join(' ') })));
    const foes = state.combat ? state.combat.enemies : [];
    if (state.combat && !(foes.find((e) => e.id === sel.enemy && e.alive))) sel.enemy = (foes.find((e) => e.alive) || {}).id || null;
    $('foes').replaceChildren(...foes.map((e) =>
      h('button', { class: ['foe', e.boss && 'boss', !e.alive && 'dead', sel.enemy === e.id && 'sel'].filter(Boolean).join(' '), type: 'button', disabled: !e.alive, onclick: () => { sel.enemy = e.id; render(); } },
        h('span', { class: 'nm' }, e.name),
        bar('hp', e.hp, e.maxHp),
        h('div', { class: 'nums' }, h('span', null, `HP ${e.hp}/${e.maxHp}`), h('span', null, `ATK ${E.atkOf(e)} DEF ${E.defOf(e)}`)),
        h('div', { class: 'tags' }, fxTags(e)))));
  }

  function btn(label, small, action, opts) {
    opts = opts || {};
    return h('button', { type: 'button', class: opts.cls, disabled: opts.disabled, title: opts.title, onclick: typeof action === 'function' ? action : () => send(action) }, label, small && h('small', null, small));
  }

  function classPicker(p) {
    return h('div', { class: 'classes' }, Object.keys(E.CLASSES).map((name) => {
      const c = E.CLASSES[name];
      return h('button', { class: 'cls' + (p.cls === name ? ' sel' : ''), type: 'button', onclick: () => send({ t: 'class', cls: name }) },
        h('b', null, name), h('span', null, c.blurb),
        h('code', null, `HP ${c.hp} · ATK ${c.atk + E.ITEMS[c.equip[0]].stats.attack} · DEF ${c.def + (c.equip[1] ? E.ITEMS[c.equip[1]].stats.defense : 0)}`));
    }));
  }

  function spellButtons(p, healOnly) {
    return p.spells.filter((id) => !healOnly || E.SPELLS[id].spell_type === 'Heal').map((id) => {
      const s = E.SPELLS[id];
      const cd = p.cds[id];
      const ally = s.spell_type === 'Heal' || s.spell_type === 'Buff';
      return btn(s.name, cd ? `ready in ${cd}` : `${s.mana_cost} MP${s.aoe ? ' · all foes' : ''}`,
        { t: 'spell', id, target: ally ? sel.ally || myId : sel.enemy },
        { disabled: !!cd || p.mana < s.mana_cost, title: s.description });
    });
  }

  function attemptPanel(inCombat) {
    const input = h('input', { type: 'text', id: 'attemptText', maxlength: 160, placeholder: inCombat ? 'e.g. kick the brazier over onto it' : 'e.g. pick the lock on the foreman’s strongbox' });
    const ability = h('select', { id: 'attemptAbility', 'aria-label': 'Ability' }, E.ABILITY_NAMES.map((a) => h('option', { value: a, selected: a === (inCombat ? 'DEX' : 'WIS') }, a)));
    const go = () => { if (!input.value.trim()) return toast('Describe what you attempt.'); panel = null; send({ t: 'attempt', text: input.value, ability: ability.value, target: sel.enemy }); };
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); go(); } });
    return h('div', { class: 'sub' },
      h('p', { class: 'hint' }, inCombat ? 'Describe a stunt against your target. A d20 check decides it; success hits hard and staggers the foe, failure wastes the turn.' : 'Describe anything you want to try. Pick the ability it leans on and the dice decide.'),
      h('div', { class: 'row' }, input, ability, h('button', { type: 'button', class: 'primary', onclick: go }, 'Roll d20')));
  }

  function renderActions() {
    const box = $('actions');
    const keep = document.activeElement && document.activeElement.id === 'attemptText' ? document.activeElement.value : null;
    const p = me();
    const kids = [];
    if (!p) { box.replaceChildren(h('p', { class: 'hint' }, 'Joining…')); return; }

    if (state.phase === 'lobby' || !p.cls) {
      kids.push(h('div', { class: 'turn' }, p.cls ? 'Choose your class — or change your mind' : 'Choose your class'), classPicker(p));
      if (state.phase === 'lobby') {
        const ready = state.order.filter((id) => state.players[id].cls).length;
        kids.push(h('p', { class: 'hint' }, `${ready} of ${state.order.length} ready. Friends can join with the code ${state.code}, even after you set out.`),
          h('div', { class: 'btns' }, btn('Begin the adventure', null, { t: 'start' }, { cls: 'primary', disabled: !p.cls })));
      }
    } else if (state.phase === 'camp') {
      const next = E.STAGES[state.stage];
      kids.push(h('div', { class: 'turn' }, 'At camp'),
        h('div', { class: 'btns' },
          btn(`Travel to ${next.loc}`, next.boss ? 'final battle' : 'next encounter', { t: 'travel' }, { cls: 'primary' }),
          btn('Rest', state.camp.rested ? 'already rested' : '+60% HP, full MP', { t: 'rest' }, { disabled: state.camp.rested }),
          btn('Search the area', state.camp.searched[myId] ? 'already searched' : 'WIS check, DC 12', { t: 'search' }, { disabled: !!state.camp.searched[myId] }),
          btn('Quartermaster', `${p.gold} gold`, () => { panel = panel === 'shop' ? null : 'shop'; render(); }, { cls: panel === 'shop' ? 'on' : '' }),
          btn('Attempt something…', 'free-form d20', () => { panel = panel === 'attempt' ? null : 'attempt'; render(); }, { cls: panel === 'attempt' ? 'on' : '' }),
          spellButtons(p, true)));
      if (panel === 'shop') kids.push(h('div', { class: 'sub' }, h('div', { class: 'btns' }, E.SHOP.map((id) => {
        const it = E.ITEMS[id];
        const stat = it.stats.attack ? `+${it.stats.attack} ATK · ` : it.stats.defense ? `+${it.stats.defense} DEF · ` : '';
        return btn(it.name, `${stat}${it.value} gold`, { t: 'buy', item: id }, { disabled: p.gold < it.value, title: it.description });
      }))));
      if (panel === 'attempt') kids.push(attemptPanel(false));
    } else if (state.phase === 'combat') {
      const cur = state.players[state.combat.turn];
      if (myTurn()) {
        const foe = state.combat.enemies.find((e) => e.id === sel.enemy);
        const ally = state.players[sel.ally] || p;
        kids.push(h('div', { class: 'turn mine' }, `Round ${state.combat.round} — your turn`),
          h('p', { class: 'hint' }, `Target: ${foe ? foe.name : '—'} · Ally: ${ally.id === myId ? 'yourself' : ally.name}. Tap a foe or a party member to change.`),
          h('div', { class: 'btns' },
            btn('Attack', `${E.atkOf(p)} + d6`, { t: 'attack', target: sel.enemy }, { cls: 'primary' }),
            E.CLASSES[p.cls].abilities.map((id) => {
              const a = E.ABILITIES[id];
              return btn(a.name, p.cds[id] ? `ready in ${p.cds[id]}` : 'ability', { t: 'ability', id, target: a.target === 'ally' ? sel.ally || myId : sel.enemy }, { disabled: !!p.cds[id], title: a.desc });
            }),
            spellButtons(p, false),
            btn('Defend', '+3 DEF, +5 MP', { t: 'defend' }),
            btn('Improvise…', 'free-form d20', () => { panel = panel === 'attempt' ? null : 'attempt'; render(); }, { cls: panel === 'attempt' ? 'on' : '' })));
        if (panel === 'attempt') kids.push(attemptPanel(true));
      } else {
        const idle = Date.now() - state.turnSince > E.IDLE_SKIP_MS;
        const canSkip = cur && (cur.online === false || idle);
        kids.push(h('div', { class: 'turn' }, `Round ${state.combat.round} — ${cur ? cur.name : '…'}'s turn`),
          h('p', { class: 'hint' }, p.alive ? 'Wait for your turn. You can still chat, and equip gear from your pack.' : 'You are down. A Cleric’s Resurrection can raise you, or you will get up when the fight is won.'));
        if (canSkip) kids.push(h('div', { class: 'btns' }, btn(`Skip ${cur.name}'s turn`, cur.online === false ? 'disconnected' : 'idle', { t: 'skip' })));
      }
    } else if (state.phase === 'defeat') {
      kids.push(h('div', { class: 'turn' }, 'The party has fallen'), h('p', { class: 'hint' }, 'Regroup at camp with 60% HP. It costs each of you half your gold.'),
        h('div', { class: 'btns' }, btn('Regroup', null, { t: 'regroup' }, { cls: 'primary' })));
    } else if (state.phase === 'victory') {
      kids.push(h('div', { class: 'turn mine' }, 'The Shattered Rune is recovered'), h('p', { class: 'hint' }, 'Keep your levels and gear and walk the road again against tougher foes.'),
        h('div', { class: 'btns' }, btn(`Begin Journey +${state.loop + 1}`, 'enemies +35%', { t: 'again' }, { cls: 'primary' })));
    }
    box.replaceChildren(...kids);
    if (keep != null && $('attemptText')) { $('attemptText').value = keep; $('attemptText').focus(); }
  }

  function renderSheet() {
    const p = me();
    $('sheetBox').hidden = !p || !p.cls;
    if (!p || !p.cls) return;
    const canUse = state.phase === 'camp' || myTurn();
    const items = Object.keys(p.inv).map((id) => {
      const it = E.ITEMS[id] || { name: id, type: 'misc', stats: {} };
      const equipped = p.eq.weapon === id || p.eq.armor === id;
      const stat = it.stats && it.stats.attack ? ` +${it.stats.attack} ATK` : it.stats && it.stats.defense ? ` +${it.stats.defense} DEF` : '';
      return h('li', { title: it.description || '' },
        h('span', null, `${it.name}${p.inv[id] > 1 ? ' ×' + p.inv[id] : ''}`, h('small', null, stat + (equipped ? ' · equipped' : ''))),
        it.type === 'consumable' ? h('button', { type: 'button', disabled: !canUse, onclick: () => send({ t: 'use', item: id, target: sel.ally || myId }) }, 'Use')
          : it.equippable && !equipped ? h('button', { type: 'button', onclick: () => send({ t: 'equip', item: id }) }, 'Equip') : null);
    });
    $('sheet').replaceChildren(
      h('div', { class: 'stats' },
        h('span', null, 'ATK ', h('b', null, E.atkOf(p))), h('span', null, 'DEF ', h('b', null, E.defOf(p))),
        h('span', null, 'Gold ', h('b', null, p.gold)), h('span', null, 'XP ', h('b', null, `${p.xp}/${p.level * 60}`))),
      bar('xp', p.xp, p.level * 60),
      h('ul', { class: 'inv' }, items.length ? items : h('li', null, h('small', null, 'Your pack is empty.'))));
  }

  function logLine(e) {
    if (e.k === 'dm') return h('p', { class: 'dm' + (e.wait ? ' wait' : '') }, e.title && h('b', null, e.title), e.text, e.ai && h('em', null, 'AI DM'));
    if (e.k === 'chat') return h('p', { class: 'chat-line chat' }, h('b', null, e.who + ': '), e.text);
    return h('p', { class: e.k === 'foe' ? 'foe-line' : e.k }, e.text);
  }
  function renderLog() {
    const log = $('log');
    const pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    const live = new Set();
    state.log.forEach((e) => {
      live.add(e.id);
      const key = e.text + '|' + (e.ai ? 1 : 0) + (e.wait ? 1 : 0);
      const old = logEls.get(e.id);
      if (old && old.key === key) return;
      const el = logLine(e);
      if (old) old.el.replaceWith(el); else log.append(el);
      logEls.set(e.id, { el, key });
    });
    for (const [id, v] of logEls) if (!live.has(id)) { v.el.remove(); logEls.delete(id); }
    if (pinned) log.scrollTop = log.scrollHeight;
  }

  function render() {
    const inGame = !!(session && state);
    $('joinView').hidden = inGame;
    $('gameView').hidden = !inGame;
    $('topMeta').hidden = !inGame;
    if (!inGame) {
      if (session && !state) $('joinNote').textContent = 'Joining…';
      return;
    }
    $('codeBtn').textContent = state.code;
    const ai = $('aiChip');
    ai.textContent = state.ai ? 'AI Dungeon Master on' : 'Scripted narrator';
    ai.className = 'chip ' + (state.ai ? 'good' : '');
    ai.title = state.ai ? 'Scenes are narrated live by an AI model.' : 'No AI key is configured, so built-in narration is used.';
    renderParty(); renderScene(); renderActions(); renderSheet(); renderLog();
  }

  // ---------------- wiring ----------------

  async function boot() {
    if (window.claude && typeof window.claude.use === 'function') {
      const [db, sample] = await Promise.all([window.claude.use('db'), window.claude.use('sample')]);
      if (!db) { $('joinNote').textContent = 'Sign in to Claude to play: the shared table is not available in this view.'; return; }
      T = artifactTransport(db, sample);
      const hint = $('modeHint');
      hint.textContent = 'Playing inside Claude: everyone opens this same page and uses the party code. Friends need a Claude account and an Editor invite from the page owner to take a seat.';
      hint.hidden = false;
    } else T = serverTransport();

    const hash = (location.hash || '').replace('#', '').toUpperCase().slice(0, 4);
    const saved = store.get('aidnd.session');
    if (saved && saved.name) $('nameInput').value = saved.name;
    if (/^[A-Z]{4}$/.test(hash)) $('codeInput').value = hash;
    if (saved && saved.code && (!hash || hash === saved.code)) {
      const res = await T.join(saved.code, saved.name, saved.token).catch(() => null);
      if (res && res.token) return enter(res, saved.name);
      store.set('aidnd.session', null);
    }
  }

  async function start(create) {
    if (!T) return;
    const name = $('nameInput').value.trim();
    const code = $('codeInput').value.trim().toUpperCase();
    if (!name) { $('joinNote').textContent = 'Give your adventurer a name first.'; $('nameInput').focus(); return; }
    if (!create && !/^[A-Z]{4}$/.test(code)) { $('joinNote').textContent = 'Enter the four-letter party code your friend shared.'; $('codeInput').focus(); return; }
    $('joinNote').textContent = '';
    $('createBtn').disabled = $('joinBtn').disabled = true;
    try {
      const res = create ? await T.create(name) : await T.join(code, name);
      if (res && res.token) enter(res, name);
      else $('joinNote').textContent = (res && res.error) || 'Could not reach the server.';
    } catch (e) { $('joinNote').textContent = 'Could not reach the server. Check your connection.'; }
    $('createBtn').disabled = $('joinBtn').disabled = false;
  }

  $('createBtn').addEventListener('click', () => start(true));
  $('joinForm').addEventListener('submit', (ev) => { ev.preventDefault(); start(false); });
  $('leaveBtn').addEventListener('click', () => leave());
  $('codeBtn').addEventListener('click', async () => {
    const text = T.inviteText(state.code);
    try { await navigator.clipboard.writeText(text); toast(T.kind === 'server' ? 'Invite link copied.' : 'Party code copied.'); }
    catch (e) { toast(T.kind === 'server' ? `Invite link: ${text}` : `Party code: ${text}`); }
  });
  $('chatForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const input = $('chatInput');
    if (!input.value.trim()) return;
    const action = { t: 'chat', text: input.value, dm: $('askDm').checked };
    input.value = '';
    send(action);
  });
  setInterval(() => { if (state && state.phase === 'combat' && !myTurn()) renderActions(); }, 5000);

  boot();
})();
