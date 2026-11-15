/*
 * AI-DnD Online — shared rules engine (v2: interactive Dungeon Master).
 *
 * A room is one plain JSON object. Players change it only through
 * act(room, playerId, action); a Dungeon Master brain (an LLM or the scripted
 * brain in dm.js) changes it only through dmApply(), which validates and
 * clamps everything the brain proposes. The engine owns every number and
 * every die.
 *
 * Combat rules are ported from dnd_game.py (class abilities, d20 checks,
 * mana); items, spells and loot tables come from items.py / spells.py via
 * data.json. Runs in Node (require) and in the browser (window.Engine).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./data.json'), require('./dm.js'), require('./maps.js'));
  else root.Engine = factory(root.DND_DATA, root.DMBrain, root.GameMaps);
})(typeof self !== 'undefined' ? self : this, function (DATA, DM, Maps) {
  'use strict';

  const own = (o, k) => o != null && typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
  const table = (...parts) => Object.assign(Object.create(null), ...parts);
  const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  const d = (n) => rnd(1, n);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const abilityMod = (score) => Math.floor(((score || 10) - 10) / 2);
  const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

  // Starting gear that dnd_game.py hands out but items.py never defines.
  const EXTRA_ITEMS = {
    longsword: { name: 'Longsword', type: 'weapon', description: "A soldier's blade, well balanced.", value: 40, equippable: true, slot: 'weapon', stats: { attack: 5 }, effects: [] },
    dagger: { name: 'Dagger', type: 'weapon', description: 'Quick, quiet and sharp.', value: 15, equippable: true, slot: 'weapon', stats: { attack: 3 }, effects: [] },
    mace: { name: 'Mace', type: 'weapon', description: 'A flanged head on an ash haft.', value: 20, equippable: true, slot: 'weapon', stats: { attack: 3 }, effects: [] },
    quarterstaff: { name: 'Quarterstaff', type: 'weapon', description: 'A walking stick with opinions.', value: 5, equippable: true, slot: 'weapon', stats: { attack: 1 }, effects: [] },
    mana_potion: { name: 'Mana Potion', type: 'consumable', description: 'A blue draught that restores 25 mana.', value: 40, equippable: false, slot: null, stats: {}, effects: [{ type: 'mana', value: 25, duration: 0 }] },
    spellbook: { name: 'Spellbook', type: 'tool', description: 'Margins full of frantic notes.', value: 0, equippable: false, slot: null, stats: {}, effects: [] },
    holy_symbol: { name: 'Holy Symbol', type: 'tool', description: 'Worn smooth by prayer.', value: 0, equippable: false, slot: null, stats: {}, effects: [] },
  };
  const ITEMS = table(DATA.items, EXTRA_ITEMS);
  const SPELLS = table(DATA.spells);

  const CLASSES = table({
    Fighter: {
      hp: 44, atk: 6, def: 1, hpPerLevel: 8,
      scores: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 12, CHA: 10 },
      gear: { longsword: 1, chainmail: 1 }, equip: ['longsword', 'chainmail'],
      abilities: ['heavy_strike'], learn: {},
      blurb: 'Front-line bruiser. Chainmail, a longsword and a blow that hits twice as hard.',
    },
    Wizard: {
      hp: 28, atk: 4, def: 1, hpPerLevel: 5,
      scores: { STR: 8, DEX: 12, CON: 12, INT: 16, WIS: 14, CHA: 10 },
      gear: { quarterstaff: 1, spellbook: 1, health_potion: 2, mana_potion: 3 }, equip: ['quarterstaff'],
      abilities: ['fireball'], learn: { 2: 'lightning_bolt', 3: 'fireball', 4: 'chain_lightning', 5: 'blizzard' },
      blurb: 'Fragile, with the deepest spellbook. Missiles, flame and ice from the back row.',
    },
    Rogue: {
      hp: 34, atk: 6, def: 1, hpPerLevel: 6,
      scores: { STR: 10, DEX: 16, CON: 12, INT: 12, WIS: 12, CHA: 14 },
      gear: { dagger: 2, lockpicks: 1, leather_armor: 1 }, equip: ['dagger', 'leather_armor'],
      abilities: ['backstab', 'cheap_shot'], learn: { 2: 'curse_of_weakness', 3: 'life_drain' },
      blurb: 'Strips armour with a backstab, stuns with a cheap shot, talks and sneaks past the rest.',
    },
    Cleric: {
      hp: 38, atk: 5, def: 2, hpPerLevel: 6,
      scores: { STR: 12, DEX: 10, CON: 14, INT: 10, WIS: 16, CHA: 12 },
      gear: { mace: 1, holy_symbol: 1, health_potion: 3, mana_potion: 2 }, equip: ['mace'],
      abilities: ['heal'], learn: { 2: 'rejuvenation', 4: 'resurrection' },
      blurb: 'Keeps the party standing. Healing, a divine shield, and a mace for emphasis.',
    },
  });

  const ABILITIES = table({
    heavy_strike: { name: 'Heavy Strike', cd: 2, target: 'enemy', desc: 'Strike for double your attack.' },
    fireball: { name: 'Fireball', cd: 3, target: 'enemy', desc: 'Hurl fire for 15–20 damage. Costs no mana.' },
    backstab: { name: 'Backstab', cd: 2, target: 'enemy', desc: 'Cut 2 defense off the target, then hit for 150%.' },
    cheap_shot: { name: 'Cheap Shot', cd: 2, target: 'enemy', desc: 'Hit for 120% with a 30% chance to stun.' },
    heal: { name: 'Heal', cd: 1, target: 'ally', desc: 'Restore 1–20 HP to an ally. Costs no mana.' },
  });

  const MONSTERS = table({
    Goblin: { hp: [18, 26], atk: [6, 8], def: 1, xp: 20, ability: 'fury', loot: 'goblin' },
    Wolf: { hp: [16, 22], atk: [7, 9], def: 1, xp: 20, ability: 'fury', loot: null },
    Bandit: { hp: [24, 32], atk: [8, 10], def: 2, xp: 30, ability: 'cheap_shot', loot: 'bandit' },
    Cultist: { hp: [22, 28], atk: [8, 10], def: 1, xp: 30, ability: 'cheap_shot', loot: 'bandit' },
    Skeleton: { hp: [22, 30], atk: [7, 9], def: 2, xp: 30, ability: 'bone_shield', loot: 'skeleton' },
    Spider: { hp: [20, 28], atk: [7, 9], def: 2, xp: 30, ability: 'cheap_shot', loot: null },
    Orc: { hp: [34, 46], atk: [10, 12], def: 3, xp: 45, ability: 'rage', loot: 'orc' },
    Wraith: { hp: [30, 40], atk: [9, 11], def: 4, xp: 55, ability: 'bone_shield', loot: 'skeleton' },
    Ogre: { hp: [55, 70], atk: [12, 14], def: 3, xp: 80, ability: 'rage', loot: 'orc' },
    Boss: { hp: [80, 80], atk: [12, 13], def: 4, xp: 150, ability: 'bone_shield', loot: 'boss' },
  });

  const SHOP = ['health_potion', 'mana_potion', 'greater_health_potion', 'strength_elixir', 'iron_sword', 'leather_armor', 'steel_longsword', 'chainmail'];
  const ABILITY_NAMES = DM.ABILITIES;
  const MAX_PLAYERS = 5;
  const MAX_LOG = 120;
  const IDLE_SKIP_MS = 45000;
  const CHECK_TIMEOUT_MS = 40000;
  const DM_STALE_MS = 45000;
  const TONES = ['family', 'classic', 'grim'];
  const DIFFS = ['story', 'balanced', 'hard'];
  const DIFF = { story: { foe: 0.8, dc: -2 }, balanced: { foe: 1, dc: 0 }, hard: { foe: 1.2, dc: 2 } };
  const DC = { easy: 9, medium: 12, hard: 15, heroic: 18 };
  const BUDGET = { gold: 6, items: 2, heal: 2, xp: 60 };
  const ADVENTURES = DM.ADVENTURES.map((a) => ({ id: a.id, title: a.title, blurb: a.blurb }));

  // ---------- room & players ----------

  function newRoom(code) {
    const adv = DM.adventure('emberpeak');
    return {
      v: 2, code, phase: 'lobby', seq: 0, host: null, ai: false, voice: 'off',
      opts: { adventure: adv.id, premise: '', tone: 'classic', difficulty: 'balanced', lang: 'English' },
      players: {}, order: [],
      scene: { location: adv.start.location, ambience: adv.start.ambience, shop: false, rested: false },
      story: { npcs: [], quests: [], facts: [], notes: [], beats: 0, stage: 0, budget: { gold: 0, items: 0, heal: 0, xp: 0, at: 0 } },
      dm: { seq: 0, busy: null, queue: [], check: null, chips: [], note: '' },
      combat: null, log: [], created: Date.now(), updated: Date.now(), turnSince: Date.now(),
    };
  }

  function say(room, k, text, extra) {
    const e = Object.assign({ id: ++room.seq, k, text }, extra || {});
    room.log.push(e);
    if (room.log.length > MAX_LOG) room.log.splice(0, room.log.length - MAX_LOG);
    return e;
  }

  function addPlayer(room, id, name) {
    if (own(room.players, id)) { room.players[id].online = true; return { ok: true }; }
    if (room.order.length >= MAX_PLAYERS) return { ok: false, error: `This party is full (${MAX_PLAYERS} adventurers).` };
    name = clean(name, 20) || 'Adventurer';
    const taken = new Set(room.order.map((pid) => room.players[pid].name.toLowerCase()));
    let n = name, i = 2;
    while (taken.has(n.toLowerCase()) || same(n, 'party') || same(n, 'narrator')) n = `${name} ${i++}`;
    room.players[id] = {
      id, name: n, cls: null, bio: '', level: 1, xp: 0, hp: 0, maxHp: 0, mana: 0, maxMana: 0, atk: 0, def: 0,
      gold: 0, inv: {}, eq: { weapon: null, armor: null }, spells: [], cds: {}, fx: [], alive: true, online: true, scores: {}, keep: [],
    };
    room.order.push(id);
    if (!room.host || !own(room.players, room.host)) room.host = id;
    say(room, 'sys', `${n} joined the party.`);
    room.updated = Date.now();
    return { ok: true };
  }

  function removePlayer(room, pid, why) {
    const p = room.players[pid];
    if (!p) return;
    room.order = room.order.filter((x) => x !== pid);
    delete room.players[pid];
    room.dm.queue = room.dm.queue.filter((q) => q.pid !== pid);
    if (room.dm.check && room.dm.check.pid === pid) room.dm.check = null;
    if (room.host === pid) room.host = room.order[0] || null;
    say(room, 'sys', `${p.name} ${why}.`);
    const c = room.combat;
    if (c) {
      const wasTurn = c.turn === pid;
      const idx = c.order.indexOf(pid);
      if (idx >= 0) c.order.splice(idx, 1);
      if (!livingPlayers(room).length) { room.combat = null; room.phase = players(room).length ? 'defeat' : 'scene'; } else if (wasTurn) {
        const nextId = c.order[idx] || null;
        if (nextId) beginTurn(room, nextId); else { c.turn = c.order[c.order.length - 1]; advance(room); }
      }
    }
  }

  function setClass(room, p, cls, bio) {
    if (!own(CLASSES, cls)) return 'Unknown class.';
    if (p.cls && room.phase !== 'lobby') return 'Your class is already chosen.';
    const c = CLASSES[cls];
    p.cls = cls;
    if (bio != null) p.bio = clean(bio, 140);
    p.scores = Object.assign({}, c.scores);
    p.maxHp = p.hp = c.hp;
    p.atk = c.atk; p.def = c.def;
    p.maxMana = p.mana = 50 + Math.max(abilityMod(c.scores.INT), abilityMod(c.scores.WIS)) * 10;
    p.inv = Object.assign({}, c.gear);
    p.eq = { weapon: null, armor: null };
    c.equip.forEach((it) => { p.eq[ITEMS[it].slot] = it; });
    p.gold = rnd(10, 50);
    p.spells = (own(DATA.startingSpells, cls) ? DATA.startingSpells[cls] : []).slice();
    p.cds = {}; p.fx = []; p.alive = true; p.level = 1; p.xp = 0;
    if (room.phase === 'combat' && room.combat && !room.combat.order.includes(p.id)) room.combat.order.push(p.id);
    return null;
  }

  // ---------- derived stats & effects ----------

  const fxSum = (c, k) => c.fx.reduce((s, f) => s + (f.k === k ? f.v || 0 : 0), 0);
  const hasFx = (c, k) => c.fx.some((f) => f.k === k);
  function addFx(c, k, v, t) {
    const cur = c.fx.find((f) => f.k === k);
    if (cur) { cur.t = Math.max(cur.t, t); cur.v = Math.max(cur.v || 0, v || 0); } else c.fx.push({ k, v: v || 0, t });
  }
  function tickFx(c) { c.fx.forEach((f) => { f.t -= 1; }); c.fx = c.fx.filter((f) => f.t > 0); }

  function gearStat(c, stat) {
    if (!c.eq) return 0;
    let s = 0;
    for (const slot of ['weapon', 'armor']) { const it = c.eq[slot] && ITEMS[c.eq[slot]]; if (it && it.stats && it.stats[stat]) s += it.stats[stat]; }
    return s;
  }
  const atkOf = (c) => Math.max(1, c.atk + gearStat(c, 'attack') + fxSum(c, 'str') - fxSum(c, 'weak') - fxSum(c, 'slow'));
  const defOf = (c) => Math.max(0, c.def + gearStat(c, 'defense') + fxSum(c, 'guard'));

  /** Apply raw damage through defense, as Character.take_damage does. */
  function hit(target, raw) {
    if (hasFx(target, 'invuln')) return 0;
    const dmg = Math.max(1, Math.round(raw) - defOf(target));
    target.hp = Math.max(0, target.hp - dmg);
    if (target.hp <= 0) target.alive = false;
    return dmg;
  }
  function heal(target, amount) {
    const before = target.hp;
    target.hp = Math.min(target.maxHp, target.hp + Math.max(0, Math.round(amount)));
    return target.hp - before;
  }

  const players = (room) => room.order.map((id) => room.players[id]).filter((p) => p && p.cls);
  const livingPlayers = (room) => players(room).filter((p) => p.alive);
  const livingEnemies = (room) => (room.combat ? room.combat.enemies.filter((e) => e.alive) : []);
  const partyLevel = (room) => { const ps = players(room); return ps.length ? Math.max(1, Math.round(ps.reduce((s, p) => s + p.level, 0) / ps.length)) : 1; };
  const locationOf = (room) => room.scene.location;

  // ---------- the tabletop map ----------

  const SPEED = { Fighter: 6, Wizard: 6, Rogue: 7, Cleric: 6 };
  const ESPEED = { Goblin: 6, Wolf: 8, Bandit: 6, Cultist: 6, Skeleton: 5, Spider: 6, Orc: 6, Wraith: 6, Ogre: 5, Boss: 5 };
  const speedOf = (p) => (p && SPEED[p.cls]) || 6;
  const K = (pos) => Maps.key(pos.x, pos.y);

  function layoutFor(room, wanted) { return Maps.LAYOUTS.includes(wanted) ? wanted : (Maps.FROM_AMBIENCE[room.scene.ambience] || 'dungeon'); }

  /** Squares nobody else may end a move on (and enemies and props cannot be walked through). */
  function blockers(room, exceptId) {
    const all = new Set(), hard = new Set();
    players(room).forEach((p) => { if (p.pos && p.id !== exceptId) all.add(K(p.pos)); });
    livingEnemies(room).forEach((e) => { if (e.pos && e.id !== exceptId) { all.add(K(e.pos)); hard.add(K(e.pos)); } });
    // Characters in the scene can be squeezed past; chests cannot.
    if (room.map) room.map.objects.forEach((o) => { if (o.kind === 'npc' || o.kind === 'chest') all.add(Maps.key(o.x, o.y)); if (o.kind === 'chest') hard.add(Maps.key(o.x, o.y)); });
    return { all, hard };
  }
  const centre = (room) => { const ps = players(room).filter((p) => p.pos); return ps.length ? ps[0].pos : (room.map ? room.map.spawn : { x: 0, y: 0 }); };

  /** Squares heroes should not be dropped onto: props, exits and doorways. */
  function noDrop(room) {
    const t = blockers(room).all;
    room.map.objects.forEach((o) => t.add(Maps.key(o.x, o.y)));
    room.map.tiles.forEach((row, y) => { for (let x = 0; x < row.length; x++) if (row[x] === "'") t.add(Maps.key(x, y)); });
    return t;
  }
  function placeParty(room) {
    const m = room.map;
    if (!m) return;
    players(room).forEach((p) => { delete p.pos; });
    const spots = Maps.freeNear(m, m.spawn, noDrop(room), players(room).length);
    players(room).forEach((p, i) => { p.pos = spots[i] || { x: m.spawn.x, y: m.spawn.y }; });
    Maps.reveal(m, players(room).map((p) => p.pos));
  }
  function ensurePos(room) {
    const m = room.map;
    if (!m || (room.phase !== 'scene' && room.phase !== 'combat')) return;
    const missing = players(room).filter((p) => !p.pos || !Maps.inb(m, p.pos.x, p.pos.y));
    if (!missing.length) return;
    const spots = Maps.freeNear(m, centre(room), noDrop(room), missing.length);
    missing.forEach((p, i) => { p.pos = spots[i] || { x: m.spawn.x, y: m.spawn.y }; });
    Maps.reveal(m, missing.map((p) => p.pos));
  }
  function newMap(room, layout) {
    const id = (room.map ? room.map.id : 0) + 1;
    room.map = Maps.generate(layoutFor(room, layout), `${room.scene.location}|${room.code}|${id}`, id);
    placeParty(room);
  }

  /** Shortest walk for a hero to (x, y) within `max` squares, or null. */
  function findPath(room, p, to, max) {
    const m = room.map;
    if (!m || !p.pos || !Maps.inb(m, to.x, to.y)) return null;
    const b = blockers(room, p.id);
    if (b.all.has(K(to))) return null;
    const seen = Maps.bfs(m, p.pos, { max, blocked: b.hard });
    return seen.has(K(to)) ? Maps.trace(seen, K(to)) : null;
  }
  const inCombatTurn = (room, p) => room.phase === 'combat' && room.combat && room.combat.turn === p.id;
  const moveBudget = (room, p) => (room.phase === 'combat' ? (inCombatTurn(room, p) ? room.combat.left : 0) : 60);

  function pathTo(room, pid, x, y) {
    const p = room.players[pid];
    if (!p) return null;
    return findPath(room, p, { x, y }, moveBudget(room, p));
  }
  function reachable(room, pid) {
    const p = room.players[pid], m = room.map;
    if (!p || !p.pos || !m) return [];
    const b = blockers(room, pid);
    const seen = Maps.bfs(m, p.pos, { max: moveBudget(room, p), blocked: b.hard });
    return [...seen.values()].filter((c) => c.d > 0 && !b.all.has(Maps.key(c.x, c.y)) && m.seen[c.y][c.x] === '1').map((c) => ({ x: c.x, y: c.y }));
  }

  /** Squares of reach for an action (1 = melee). Distance is counted as in D&D 5e: diagonals count 1. */
  function rangeOf(room, pid, a) {
    if (!a) return 1;
    if (a.t === 'ability') return a.id === 'fireball' ? 8 : 1;
    if (a.t === 'spell') {
      const s = own(SPELLS, a.id) ? SPELLS[a.id] : null;
      if (!s) return 1;
      if (a.id === 'resurrection') return 1;
      return s.spell_type === 'Heal' || s.spell_type === 'Buff' ? 6 : 8;
    }
    if (a.t === 'attempt') return 2;
    return 1;
  }

  /** Walk next to (or within `range` of) a square, using what movement there is. */
  function approach(room, p, to, range, label) {
    const m = room.map;
    if (!m || !p.pos || !to) return null;
    if (Maps.dist(p.pos, to) <= range) return null;
    const max = moveBudget(room, p);
    const b = blockers(room, p.id);
    const seen = Maps.bfs(m, p.pos, { max, blocked: b.hard });
    let best = null;
    for (const c of seen.values()) {
      if (c.d === 0 || b.all.has(Maps.key(c.x, c.y)) || Maps.dist(c, to) > range) continue;
      if (!best || c.d < best.d) best = c;
    }
    if (!best) {
      const gap = Maps.dist(p.pos, to) - range;
      return room.phase === 'combat'
        ? `${label} is out of reach: ${gap} more square${gap === 1 ? '' : 's'} than you can cover. Move closer, or end your turn.`
        : `You cannot get to ${label} from here.`;
    }
    p.pos = { x: best.x, y: best.y };
    if (room.phase === 'combat') room.combat.left = Math.max(0, room.combat.left - best.d);
    Maps.reveal(m, [p.pos]);
    return null;
  }

  function doMove(room, p, a) {
    const m = room.map;
    if (!m || !p.pos) return 'There is no map here yet.';
    if (!p.alive) return 'You are down.';
    const x = Math.floor(Number(a.x)), y = Math.floor(Number(a.y));
    if (!Maps.inb(m, x, y)) return 'That is off the map.';
    if (room.phase === 'combat') { if (!inCombatTurn(room, p)) return 'Wait for your turn to move.'; } else if (room.phase !== 'scene') return 'Not right now.';
    if (p.pos.x === x && p.pos.y === y) return null;
    if (m.seen[y][x] !== '1') return 'You have not explored there yet.';
    if (!Maps.walkable(m, x, y)) return 'You cannot stand there.';
    const path = findPath(room, p, { x, y }, moveBudget(room, p));
    if (!path) return room.phase === 'combat' ? `Too far: you have ${room.combat.left} square${room.combat.left === 1 ? '' : 's'} of movement left.` : 'You cannot get there from here.';
    p.pos = { x, y };
    if (room.phase === 'combat') room.combat.left -= path.length;
    Maps.reveal(m, [p.pos]);
    return null;
  }

  function doInteract(room, p, a) {
    const m = room.map;
    if (!m || !p.pos) return 'There is no map here yet.';
    if (!p.alive) return 'You are down.';
    const x = Math.floor(Number(a.x)), y = Math.floor(Number(a.y));
    if (!Maps.inb(m, x, y)) return 'That is off the map.';
    const combat = room.phase === 'combat';
    if (combat) { if (!inCombatTurn(room, p)) return 'Wait for your turn.'; } else if (room.phase !== 'scene') return 'Not right now.';
    const tile = Maps.at(m, x, y);
    const here = m.objects.find((o) => o.x === x && o.y === y);
    if (!here && (tile === '+' || tile === "'")) {
      const err = approach(room, p, { x, y }, 1, 'the door');
      if (err) return err;
      if (tile === "'") {
        if (players(room).some((q) => q.pos && q.pos.x === x && q.pos.y === y) || livingEnemies(room).some((e) => e.pos && e.pos.x === x && e.pos.y === y)) return 'Someone is standing in the doorway.';
        Maps.setTile(m, x, y, '+');
        say(room, 'sys', `${p.name} closes a door.`);
      } else {
        Maps.setTile(m, x, y, "'");
        Maps.reveal(m, [{ x, y }].concat(players(room).filter((q) => q.pos).map((q) => q.pos)));
        say(room, 'sys', `${p.name} opens a door.`, { door: Maps.key(x, y) });
      }
      return null;
    }
    const obj = m.objects.find((o) => o.x === x && o.y === y);
    if (!obj) return 'There is nothing to use there.';
    if (combat) return 'Not in the middle of a fight.';
    if (obj.kind !== 'chest' && room.dm.queue.filter((q) => q.pid === p.id).length >= 2) return 'The Dungeon Master is still catching up with you.';
    const err = approach(room, p, obj, 1, `the ${obj.name}`);
    if (err) return err;
    if (obj.kind === 'chest') {
      if (obj.used) return 'The chest is empty.';
      obj.used = true;
      const loot = rollLoot(room.story.stage >= 3 && Math.random() < 0.35 ? 'chest_rare' : 'chest_common');
      giveLoot(room, p, loot);
      say(room, 'sys', `${p.name} opens the chest: ${lootText(loot) || 'nothing but dust'}.`);
      return null;
    }
    const text = obj.kind === 'exit' ? `${p.name} leads the party onward: ${obj.name}.`
      : obj.kind === 'npc' ? `${p.name} goes over to talk to ${obj.name}.`
        : `${p.name} examines the ${obj.name}.`;
    const shown = obj.kind === 'exit' ? `Heads for the ${obj.name}` : obj.kind === 'npc' ? `Goes over to ${obj.name}` : `Examines the ${obj.name}`;
    say(room, 'you', shown, { who: p.name, mode: 'do' });
    queueIntent(room, { pid: p.id, kind: 'do', text });
    return null;
  }

  /** Put an enemy next to the nearest hero, up to its speed. Returns the hero it can now hit, or null. */
  function moveEnemy(room, e) {
    const heroes = livingPlayers(room).filter((p) => p.pos);
    const m = room.map;
    if (!m || !e.pos || !heroes.length) return null;
    const adjacent = () => heroes.filter((h) => Maps.dist(h.pos, e.pos) <= 1).sort((a, b) => a.hp - b.hp)[0] || null;
    let t = adjacent();
    if (t) return t;
    const b = blockers(room, e.id);
    const wall = new Set(b.hard);
    heroes.forEach((h) => wall.add(K(h.pos)));
    const seen = Maps.bfs(m, e.pos, { max: 40, blocked: wall });
    let goal = null;
    for (const c of seen.values()) if (c.d > 0 && !b.all.has(Maps.key(c.x, c.y)) && heroes.some((h) => Maps.dist(h.pos, c) <= 1) && (!goal || c.d < goal.d)) goal = c;
    if (!goal) return null;
    const path = Maps.trace(seen, Maps.key(goal.x, goal.y));
    const steps = Math.min(path.length, ESPEED[e.type] || 6);
    if (steps > 0) e.pos = path[steps - 1];
    return adjacent();
  }
  function findPlayer(room, name) {
    name = clean(name, 40).toLowerCase();
    if (!name) return null;
    const ps = players(room);
    return ps.find((p) => p.name.toLowerCase() === name) || ps.find((p) => p.id === name) || ps.find((p) => p.name.toLowerCase().startsWith(name) || name.startsWith(p.name.toLowerCase())) || null;
  }

  function addItem(p, item, qty) { p.inv[item] = (p.inv[item] || 0) + qty; }
  function takeItem(p, item) { p.inv[item] -= 1; if (p.inv[item] <= 0) delete p.inv[item]; }
  function lootText(loot) {
    return Object.keys(loot).map((id) => (id === 'gold_coin' ? `${loot[id]} gold` : `${loot[id] > 1 ? loot[id] + '× ' : ''}${ITEMS[id] ? ITEMS[id].name : id}`)).join(', ');
  }
  function rollLoot(tableName) {
    const t = tableName && own(DATA.loot, tableName) ? DATA.loot[tableName] : null;
    const out = {};
    if (!t) return { gold_coin: rnd(1, 6) };
    if (t.gold[1] > 0) { const g = rnd(t.gold[0], t.gold[1]); if (g > 0) out.gold_coin = g; }
    t.items.forEach((e) => { if (ITEMS[e.id] && Math.random() < e.chance) out[e.id] = (out[e.id] || 0) + rnd(e.qty[0], e.qty[1]); });
    return out;
  }
  function giveLoot(room, p, loot) {
    for (const id in loot) {
      if (id === 'gold_coin') {
        const party = players(room);
        const share = Math.floor(loot[id] / party.length);
        party.forEach((m) => { m.gold += share; });
        p.gold += loot[id] - share * party.length;
      } else addItem(p, id, loot[id]);
    }
  }

  function grantXp(room, xp) {
    players(room).forEach((p) => {
      p.xp += xp;
      while (p.xp >= p.level * 60) {
        p.xp -= p.level * 60;
        p.level += 1;
        const c = CLASSES[p.cls];
        p.maxHp += c.hpPerLevel; p.atk += 1; p.maxMana += 10;
        if (p.alive) { p.hp = Math.min(p.maxHp, p.hp + c.hpPerLevel + 6); p.mana = Math.min(p.maxMana, p.mana + 20); }
        let line = `${p.name} reaches level ${p.level}! +${c.hpPerLevel} max HP, +1 attack.`;
        const spell = c.learn[p.level];
        if (spell && SPELLS[spell] && !p.spells.includes(spell)) { p.spells.push(spell); line += ` Learned ${SPELLS[spell].name}.`; }
        say(room, 'sys', line, { up: p.id });
      }
    });
  }

  // ---------- combat flow ----------

  /** enemies: [{type, name, count}] already validated by sanitizeEnemies. */
  function startCombat(room, list, extra) {
    const ps = Math.max(1, players(room).length);
    const lv = partyLevel(room) - 1;
    const foe = DIFF[room.opts.difficulty].foe;
    const scale = (1 + 0.05 * lv) * foe;
    const atkScale = (1 + 0.02 * lv) * foe * (ps === 1 ? 0.85 : 1);   // a lone hero gets a little mercy
    const enemies = [];
    list.forEach((spec) => {
      const m = MONSTERS[spec.type];
      for (let i = 0; i < spec.count && enemies.length < 6; i++) {
        let hp = rnd(m.hp[0], m.hp[1]);
        if (spec.type === 'Boss') hp += 24 * ps;
        hp = Math.round(hp * (0.92 + 0.1 * ps) * scale);
        enemies.push({
          id: 'e' + (enemies.length + 1), type: spec.type, name: spec.count > 1 ? `${spec.name} ${i + 1}` : spec.name,
          hp, maxHp: hp, atk: Math.round(rnd(m.atk[0], m.atk[1]) * atkScale), def: m.def, fx: [], alive: true, rage: 0, fury: 0, shielded: false, boss: spec.type === 'Boss',
        });
      }
    });
    const order = livingPlayers(room).map((x) => x.id);
    if (!order.length || !enemies.length) return false;
    if (room.map) {
      ensurePos(room);
      const spots = Maps.enemySpots(room.map, centre(room), blockers(room).all, enemies.length, Math.random);
      const more = spots.length < enemies.length ? Maps.freeNear(room.map, centre(room), new Set([...blockers(room).all].concat(spots.map(K))), enemies.length - spots.length, 2) : [];
      enemies.forEach((e, i) => { e.pos = spots[i] || more[i - spots.length] || null; });
      Maps.reveal(room.map, enemies.filter((e) => e.pos).map((e) => e.pos));
    }
    room.phase = 'combat';
    room.combat = Object.assign({ enemies, order, turn: null, round: 1, left: 0, acted: false }, extra || {});
    room.dm.check = null;
    room.dm.queue = room.dm.queue.filter((q) => q.kind !== 'do' && q.kind !== 'say');
    players(room).forEach((x) => { x.cds = {}; x.fx = x.fx.filter((f) => f.k === 'str'); });
    say(room, 'sys', `Battle! ${enemies.map((x) => x.name).join(', ')}.`);
    beginTurn(room, order[0]);
    return true;
  }

  function sanitizeEnemies(room, raw) {
    const ps = Math.max(1, players(room).length);
    const cap = Math.min(6, ps + 2);
    const out = [];
    let total = 0, boss = false;
    (Array.isArray(raw) ? raw : []).slice(0, 6).forEach((e) => {
      if (!e || !own(MONSTERS, e.type) || total >= cap) return;
      if (e.type === 'Boss') { if (boss) return; boss = true; }
      const count = e.type === 'Boss' ? 1 : Math.max(1, Math.min(cap - total, Math.floor(Number(e.count)) || 1));
      out.push({ type: e.type, name: clean(e.name, 28) || e.type, count });
      total += count;
    });
    return out.length ? out : [{ type: 'Goblin', name: 'Goblin', count: Math.min(cap, ps + 1) }];
  }

  function beginTurn(room, pid, guard) {
    const c = room.combat;
    guard = guard || 0;
    const p = room.players[pid];
    c.turn = pid;
    c.left = speedOf(p);
    c.acted = false;
    room.turnSince = Date.now();
    if (!p || !p.alive) return advance(room, guard + 1);
    p.mana = Math.min(p.maxMana, p.mana + Math.max(5, Math.round(p.maxMana * 0.1)));
    for (const k in p.cds) { p.cds[k] -= 1; if (p.cds[k] <= 0) delete p.cds[k]; }
    p.fx = p.fx.filter((f) => f.k !== 'guard');
    if (hasFx(p, 'stun')) {
      p.fx = p.fx.filter((f) => f.k !== 'stun');
      say(room, 'act', `${p.name} is stunned and loses the turn.`);
      tickFx(p);
      return advance(room, guard + 1);
    }
  }

  function advance(room, guard) {
    const c = room.combat;
    if (!c) return;
    guard = guard || 0;
    if (!livingEnemies(room).length) return winCombat(room);
    if (!livingPlayers(room).length) return loseCombat(room);
    if (guard > 20) { c.turn = livingPlayers(room)[0].id; room.turnSince = Date.now(); return; }
    const idx = c.order.indexOf(c.turn);
    for (let i = idx + 1; i < c.order.length; i++) {
      const p = room.players[c.order[i]];
      if (p && p.alive) return beginTurn(room, p.id, guard);
    }
    enemyPhase(room);
    if (!livingPlayers(room).length) return loseCombat(room);
    if (!livingEnemies(room).length) return winCombat(room);
    c.round += 1;
    const first = c.order.map((id) => room.players[id]).find((p) => p && p.alive);
    return beginTurn(room, first.id, guard);
  }

  function enemyPhase(room) {
    const c = room.combat;
    for (const e of c.enemies) {
      if (!e.alive) continue;
      const targets = livingPlayers(room);
      if (!targets.length) return;
      if (hasFx(e, 'stun')) { say(room, 'foe', `${e.name} is stunned and cannot act.`); tickFx(e); continue; }
      const onMap = room.map && e.pos;
      const t = onMap ? moveEnemy(room, e) : pick(targets);
      const m = MONSTERS[e.type];
      const special = Math.random() < 0.3;
      const swept = onMap ? targets.filter((p) => p.pos && Maps.dist(p.pos, e.pos) <= 2) : targets;
      if (!t && !(e.boss && c.round % 3 === 0 && swept.length)) {
        const far = onMap && e.type === 'Cultist' ? targets.filter((p) => p.pos && Maps.dist(p.pos, e.pos) <= 5).sort((a, b) => a.hp - b.hp)[0] : null;
        if (far) {
          say(room, 'foe', `${e.name} hurls a bolt of shadow at ${far.name} for ${hit(far, atkOf(e) * 0.8)} damage.`, { hurt: far.id });
          if (!far.alive) say(room, 'foe', `${far.name} falls!`);
        }
        tickFx(e);
        continue;
      }
      if (e.boss && c.round % 3 === 0 && swept.length) {
        const parts = swept.map((p) => `${p.name} ${hit(p, atkOf(e) * 0.7)}`);
        say(room, 'foe', `${e.name} unleashes a devastating sweep — ${parts.join(', ')} damage.`);
        swept.forEach((p) => { if (!p.alive) say(room, 'foe', `${p.name} falls!`); });
        tickFx(e);
        continue;
      } else if (special && m.ability === 'fury' && e.fury < 3) {
        e.fury += 1; e.atk += 2;
        const a = hit(t, atkOf(e)), b = t.alive ? hit(t, atkOf(e)) : 0;
        say(room, 'foe', `${e.name} flies into a Fury and strikes ${t.name} twice for ${a + b} damage.`, { hurt: t.id });
      } else if (special && m.ability === 'rage' && e.rage < 2) {
        e.rage += 1; e.atk += 3; e.def += 2;
        say(room, 'foe', `${e.name} bellows with Rage (attack +3, defense +2) and smashes ${t.name} for ${hit(t, atkOf(e) * 1.5)} damage.`, { hurt: t.id });
      } else if (special && m.ability === 'bone_shield' && !e.shielded) {
        e.shielded = true; e.def *= 2;
        say(room, 'foe', `${e.name} hardens its guard, doubling its defense to ${e.def}.`);
      } else if (special && (m.ability === 'cheap_shot' || e.boss)) {
        const dmg = hit(t, atkOf(e) * 1.2);
        const stun = t.alive && Math.random() < 0.3;
        if (stun) addFx(t, 'stun', 0, 1);
        say(room, 'foe', `${e.name} lands a Cheap Shot on ${t.name} for ${dmg} damage${stun ? ' — stunned!' : '.'}`, { hurt: t.id });
      } else {
        const roll = d(6);
        say(room, 'foe', `${e.name} attacks ${t.name} (d6: ${roll}) for ${hit(t, atkOf(e) + roll)} damage.`, { hurt: t.id });
      }
      if (!t.alive) say(room, 'foe', `${t.name} falls!`);
      tickFx(e);
    }
  }

  function onKill(room, p, e) {
    const m = MONSTERS[e.type];
    const loot = rollLoot(m.loot);
    giveLoot(room, p, loot);
    say(room, 'act', `${e.name} is slain. ${p.name} loots ${lootText(loot) || 'nothing'}.`);
    // Bigger parties meet more enemies, so each kill is worth less per head.
    grantXp(room, Math.round((m.xp * 2) / (players(room).length + 1)));
  }

  function winCombat(room) {
    const c = room.combat;
    const foes = c.enemies.map((e) => e.name).join(', ');
    room.combat = null;
    room.phase = 'scene';
    const revived = [];
    players(room).forEach((p) => {
      p.fx = []; p.cds = {};
      if (!p.alive) { p.alive = true; p.hp = Math.max(1, Math.round(p.maxHp * 0.25)); revived.push(p.name); }
    });
    say(room, 'sys', `Victory at ${room.scene.location}.${revived.length ? ` ${revived.join(' and ')} ${revived.length > 1 ? 'are' : 'is'} helped back up.` : ''}`);
    if (c.stageFight) room.story.stage += 1;
    if (c.keepsake) {
      const finder = pick(players(room));
      if (finder && !finder.keep.includes(c.keepsake)) { finder.keep.push(c.keepsake); say(room, 'sys', `${finder.name} recovers the ${c.keepsake}.`); }
    }
    room.scene.ambience = 'camp';
    room.turnSince = Date.now();
    room.dm.queue.unshift({ pid: null, kind: 'event', text: 'won', detail: `The party won the battle at ${room.scene.location} against ${foes}.${revived.length ? ` ${revived.join(' and ')} went down in the fight and had to be revived.` : ''} Narrate the aftermath in a few sentences and continue the story.` });
  }

  function loseCombat(room) {
    room.phase = 'defeat';
    room.combat = null;
    room.dm.queue = [];
    say(room, 'dm', 'One by one your torches gutter out. The dark closes over the party…', { title: 'Defeat', segs: [{ speaker: 'narrator', voice: 'narrator', text: 'One by one your torches gutter out. The dark closes over the party…' }] });
  }

  // ---------- player actions ----------

  function findTarget(room, action, kind) {
    if (kind === 'enemy') {
      const e = room.combat && room.combat.enemies.find((x) => x.id === action.target && x.alive);
      if (e) return e;
      const me = room.combat && room.players[room.combat.turn];
      const alive = livingEnemies(room);
      return me && me.pos ? alive.filter((x) => x.pos).sort((a, b) => Maps.dist(a.pos, me.pos) - Maps.dist(b.pos, me.pos))[0] || alive[0] : alive[0];
    }
    const p = own(room.players, action.target) ? room.players[action.target] : null;
    return p && p.cls ? p : null;
  }

  function strike(room, p, e, raw, text) {
    const dmg = hit(e, raw);
    say(room, 'act', text.replace('{d}', dmg));
    if (!e.alive) onKill(room, p, e);
    return dmg;
  }

  function useItem(room, p, action) {
    const id = action.item;
    if (!own(ITEMS, id) || !own(p.inv, id)) return 'You do not have that item.';
    const it = ITEMS[id];
    if (it.type !== 'consumable') return 'That item cannot be used like that.';
    const target = findTarget(room, action, 'ally') || p;
    if (!target.alive) return `${target.name} is down — a potion will not help.`;
    const bits = [];
    it.effects.forEach((e) => {
      if (e.type === 'heal') bits.push(`restores ${heal(target, e.value)} HP`);
      else if (e.type === 'mana') { const b = target.mana; target.mana = Math.min(target.maxMana, target.mana + e.value); bits.push(`restores ${target.mana - b} mana`); }
      else if (e.type === 'buff_attack') { addFx(target, 'str', e.value, (e.duration || 3) + 1); bits.push(`grants +${e.value} attack for ${e.duration || 3} turns`); }
      else if (e.type === 'buff_defense') { addFx(target, 'guard', e.value, (e.duration || 3) + 1); bits.push(`grants +${e.value} defense`); }
    });
    takeItem(p, id);
    say(room, 'act', `${p.name} uses ${it.name}${target.id !== p.id ? ` on ${target.name}` : ''}: ${bits.join(', ') || 'no effect'}.`, { healed: target.id });
    return null;
  }

  function castSpell(room, p, action) {
    if (!own(SPELLS, action.id) || !p.spells.includes(action.id)) return 'You do not know that spell.';
    const s = SPELLS[action.id];
    const cdKey = 's:' + action.id;
    if (p.mana < s.mana_cost) return `Not enough mana. ${s.name} needs ${s.mana_cost}.`;
    if (p.cds[cdKey]) return `${s.name} is on cooldown for ${p.cds[cdKey]} more turn(s).`;
    const bonus = abilityMod(p.scores.INT) + gearStat(p, 'magic_damage');
    if (s.spell_type === 'Damage') {
      if (!room.combat) return 'There is nothing to attack.';
      const primary = findTarget(room, action, 'enemy');
      if (!primary) return 'There is nothing to attack.';
      const targets = s.aoe ? livingEnemies(room).filter((e) => e === primary || !e.pos || !primary.pos || Maps.dist(e.pos, primary.pos) <= 1) : [primary];
      p.mana -= s.mana_cost;
      let total = 0;
      const parts = targets.map((e) => {
        const dmg = hit(e, rnd(s.damage[0], s.damage[1]) + bonus);
        total += dmg;
        if (s.effect.slow && e.alive) addFx(e, 'slow', 3, s.effect.slow);
        if (s.effect.freeze && e.alive) addFx(e, 'stun', 0, s.effect.freeze);
        return `${e.name} ${dmg}`;
      });
      let line = `${p.name} casts ${s.name} — ${parts.join(', ')} ${s.school.toLowerCase()} damage.`;
      if (s.effect.slow) line += ' The cold slows its target.';
      if (s.heal[1] > 0) line += ` ${p.name} drains ${heal(p, total)} HP.`;
      say(room, 'act', line);
      targets.forEach((e) => { if (!e.alive) onKill(room, p, e); });
    } else if (s.spell_type === 'Heal') {
      const t = findTarget(room, action, 'ally') || p;
      if (action.id === 'resurrection') {
        if (t.alive) return `${t.name} is still standing. Resurrection is for the fallen.`;
        p.mana -= s.mana_cost;
        t.alive = true; t.hp = Math.min(t.maxHp, s.heal[0]); t.fx = [];
        say(room, 'act', `${p.name} casts Resurrection. ${t.name} rises with ${t.hp} HP!`, { healed: t.id });
      } else {
        if (!t.alive) return `${t.name} is down. Only Resurrection can help now.`;
        p.mana -= s.mana_cost;
        say(room, 'act', `${p.name} casts ${s.name} on ${t.id === p.id ? 'themself' : t.name}, healing ${heal(t, rnd(s.heal[0], s.heal[1]))} HP.`, { healed: t.id });
      }
    } else if (s.spell_type === 'Buff') {
      const t = findTarget(room, action, 'ally') || p;
      if (!t.alive) return `${t.name} is down.`;
      p.mana -= s.mana_cost;
      if (s.effect.invulnerable) addFx(t, 'invuln', 0, s.duration + (t.id === p.id ? 1 : 0));
      say(room, 'act', `${p.name} casts ${s.name} on ${t.id === p.id ? 'themself' : t.name}. ${s.description}.`);
    } else if (s.spell_type === 'Debuff') {
      const e = room.combat && findTarget(room, action, 'enemy');
      if (!e) return 'There is nothing to curse.';
      p.mana -= s.mana_cost;
      if (s.effect.attack_reduction) addFx(e, 'weak', s.effect.attack_reduction, s.duration);
      if (s.effect.rooted) addFx(e, 'stun', 0, 1);
      say(room, 'act', `${p.name} casts ${s.name} on ${e.name}. ${s.description}.`);
    } else return 'That spell fizzles.';
    if (s.cooldown) p.cds[cdKey] = s.cooldown + 1;
    return null;
  }

  function abilityCheck(p, ability) {
    const roll = d(20);
    const top = Object.keys(p.scores).sort((a, b) => p.scores[b] - p.scores[a]).slice(0, 2);
    const m = abilityMod(p.scores[ability]) + (top.includes(ability) ? 2 : 0);
    return { roll, mod: m, total: roll + m };
  }
  const checkText = (c, ability, dc) => `${ability} check: d20 (${c.roll}) ${c.mod >= 0 ? '+' : '−'} ${Math.abs(c.mod)} = ${c.total} vs DC ${dc}`;

  function combatAction(room, p, a) {
    const c = room.combat;
    if (c.turn !== p.id) return 'It is not your turn.';
    if (!p.alive) return 'You are down.';
    if (a.t === 'endturn') { say(room, 'act', `${p.name} ends their turn.`); tickFx(p); advance(room); return null; }
    if (room.map && p.pos) {
      let tgt = null;
      const friendly = (a.t === 'ability' && a.id === 'heal') || (a.t === 'spell' && own(SPELLS, a.id) && ['Heal', 'Buff'].includes(SPELLS[a.id].spell_type)) || a.t === 'use';
      if (['attack', 'ability', 'spell', 'attempt', 'use'].includes(a.t)) tgt = friendly ? findTarget(room, a, 'ally') : findTarget(room, a, 'enemy');
      if (tgt && tgt !== p && tgt.pos) {
        const err = approach(room, p, tgt.pos, a.t === 'use' ? 1 : rangeOf(room, p.id, a), tgt.name);
        if (err) return err;
      }
    }
    if (a.t === 'attack') {
      const e = findTarget(room, a, 'enemy');
      const roll = d(6);
      strike(room, p, e, atkOf(p) + roll, `${p.name} attacks ${e.name} (d6: ${roll}) for {d} damage.`);
    } else if (a.t === 'ability') {
      if (!own(ABILITIES, a.id) || !CLASSES[p.cls].abilities.includes(a.id)) return 'You do not have that ability.';
      const ab = ABILITIES[a.id];
      const cdKey = 'a:' + a.id;
      if (p.cds[cdKey]) return `${ab.name} is ready in ${p.cds[cdKey]} turn(s).`;
      if (a.id === 'heal') {
        const t = findTarget(room, a, 'ally') || p;
        if (!t.alive) return `${t.name} is down. Only Resurrection can help now.`;
        say(room, 'act', `${p.name} lays on hands and heals ${t.id === p.id ? 'themself' : t.name} for ${heal(t, d(20))} HP.`, { healed: t.id });
      } else {
        const e = findTarget(room, a, 'enemy');
        if (a.id === 'heavy_strike') strike(room, p, e, atkOf(p) * 2, `${p.name} brings down a Heavy Strike on ${e.name} for {d} damage.`);
        else if (a.id === 'fireball') strike(room, p, e, rnd(15, 20), `${p.name} hurls a Fireball at ${e.name} for {d} damage.`);
        else if (a.id === 'backstab') { e.def = Math.max(0, e.def - 2); strike(room, p, e, atkOf(p) * 1.5, `${p.name} slips behind ${e.name} and Backstabs for {d} damage (defense −2).`); } else if (a.id === 'cheap_shot') {
          const stun = Math.random() < 0.3;
          strike(room, p, e, atkOf(p) * 1.2, `${p.name} lands a Cheap Shot on ${e.name} for {d} damage${stun ? ' — stunned!' : '.'}`);
          if (stun && e.alive) addFx(e, 'stun', 0, 1);
        }
      }
      p.cds[cdKey] = ab.cd + 1;
    } else if (a.t === 'spell') {
      const err = castSpell(room, p, a);
      if (err) return err;
    } else if (a.t === 'use') {
      const err = useItem(room, p, a);
      if (err) return err;
    } else if (a.t === 'defend') {
      addFx(p, 'guard', 3, 2);
      p.mana = Math.min(p.maxMana, p.mana + 5);
      say(room, 'act', `${p.name} takes a defensive stance (+3 defense until their next turn).`);
    } else if (a.t === 'attempt') {
      const text = clean(a.text, 160);
      const ability = ABILITY_NAMES.includes(a.ability) ? a.ability : DM.classify(text);
      if (!text) return 'Describe what you attempt.';
      const e = findTarget(room, a, 'enemy');
      const dc = 13 + DIFF[room.opts.difficulty].dc;
      const chk = abilityCheck(p, ability);
      const ok = (chk.total >= dc || chk.roll === 20) && chk.roll !== 1;
      let outcome;
      if (ok) {
        const dmg = hit(e, (atkOf(p) + d(6) + 5) * (chk.roll === 20 ? 2 : 1));
        addFx(e, 'slow', 3, 2);
        outcome = `Success${chk.roll === 20 ? ' — natural 20!' : '!'} ${e.name} takes ${dmg} damage and is thrown off balance.`;
      } else if (chk.roll === 1) outcome = `Natural 1. It goes badly, and ${p.name} takes ${hit(p, 4 + defOf(p))} damage.`;
      else outcome = 'It fails, and the moment is lost.';
      say(room, 'roll', `${p.name} improvises: “${text}” — ${checkText(chk, ability, dc)}. ${outcome}`, { die: chk.roll });
      if (!e.alive) onKill(room, p, e);
    } else return 'You cannot do that in combat.';
    tickFx(p);
    advance(room);
    return null;
  }

  function rollDice(expr) {
    const m = /^(\d{0,2})d(\d{1,3})\s*([+-]\s*\d{1,3})?$/i.exec(String(expr).replace(/\s+/g, ''));
    if (!m) return null;
    const n = Math.max(1, Math.min(20, Number(m[1] || 1)));
    const sides = Math.max(2, Math.min(100, Number(m[2])));
    const bonus = m[3] ? Number(m[3].replace(/\s+/g, '')) : 0;
    const rolls = Array.from({ length: n }, () => d(sides));
    return { n, sides, bonus, rolls, total: rolls.reduce((s, x) => s + x, 0) + bonus };
  }

  function resolveCheck(room, p) {
    const c = room.dm.check;
    if (!c) return 'No roll is waiting.';
    const target = room.players[c.pid];
    const late = Date.now() - c.at > CHECK_TIMEOUT_MS;
    if (target && target.cls && p.id !== c.pid && target.online !== false && !late) return `That roll is ${target.name}'s to make.`;
    room.dm.check = null;
    if (!target || !target.cls) return null;
    const chk = abilityCheck(target, c.ability);
    const pass = (chk.total >= c.dc || chk.roll === 20) && chk.roll !== 1;
    say(room, 'roll', `${target.name} rolls to ${c.reason} — ${checkText(chk, c.ability, c.dc)}. ${pass ? (chk.roll === 20 ? 'Natural 20! Success!' : 'Success!') : (chk.roll === 1 ? 'Natural 1. Failure.' : 'Failure.')}`, { die: chk.roll, pass, who: target.name });
    const branch = pass ? c.success : c.failure;
    const text = clean(branch && branch.text, 500) || (pass ? 'It works.' : 'It does not work.');
    say(room, 'dm', text, { segs: [{ speaker: 'narrator', voice: 'narrator', text }], ai: !!c.ai });
    applyEffects(room, branch && branch.effects, {});
    if (pass) grantXp(room, 5);
    return null;
  }

  function sceneAction(room, p, a) {
    if (a.t === 'rest') {
      if (room.scene.rested) return 'The party has already rested here.';
      room.scene.rested = true;
      players(room).forEach((m) => { m.alive = true; m.hp = Math.min(m.maxHp, m.hp + Math.ceil(m.maxHp * 0.6)); m.mana = m.maxMana; });
      say(room, 'sys', `${p.name} calls a rest. Everyone recovers 60% HP and all mana.`, { healed: 'party' });
    } else if (a.t === 'buy') {
      if (!room.scene.shop) return 'There is nobody here to trade with.';
      if (!SHOP.includes(a.item) || !own(ITEMS, a.item)) return 'The merchant does not stock that.';
      const it = ITEMS[a.item];
      if (p.gold < it.value) return `Not enough gold. ${it.name} costs ${it.value}.`;
      p.gold -= it.value;
      addItem(p, a.item, 1);
      say(room, 'sys', `${p.name} buys ${it.name} for ${it.value} gold.`);
    } else if (a.t === 'spell') {
      if (!own(SPELLS, a.id) || SPELLS[a.id].spell_type !== 'Heal') return 'Save that for a fight.';
      const err = castSpell(room, p, a);
      if (err) return err;
    } else return 'You cannot do that right now.';
    return null;
  }

  function queueIntent(room, entry) {
    if (room.dm.queue.length >= 10) room.dm.queue.shift();
    room.dm.queue.push(entry);
  }

  /** Apply one player action. Mutates the room. Returns { ok, error? }. */
  function act(room, pid, a) {
    const fail = (error) => ({ ok: false, error });
    if (!own(room.players, pid)) return fail('You are not in this party.');
    ensurePos(room);
    const p = room.players[pid];
    if (!a || typeof a.t !== 'string') return fail('Bad action.');
    const isHost = room.host === pid;
    let err = null;

    if (a.t === 'chat') {
      const text = clean(a.text, 300);
      if (!text) return fail('Say something first.');
      say(room, 'chat', text, { who: p.name });
    } else if (a.t === 'class') {
      err = setClass(room, p, a.cls, a.bio);
      if (!err) say(room, 'sys', `${p.name} takes up the mantle of the ${p.cls}.`);
    } else if (a.t === 'opts') {
      if (!isHost) err = 'Only the host can change the adventure settings.';
      else {
        if (room.phase === 'lobby') {
          if (typeof a.adventure === 'string' && DM.ADVENTURES.some((x) => x.id === a.adventure)) {
            room.opts.adventure = a.adventure;
            const adv = DM.adventure(a.adventure);
            room.scene.location = adv.start.location; room.scene.ambience = adv.start.ambience;
          }
          if (a.premise != null) room.opts.premise = clean(a.premise, 600);
        }
        if (TONES.includes(a.tone)) room.opts.tone = a.tone;
        if (DIFFS.includes(a.difficulty)) room.opts.difficulty = a.difficulty;
        if (a.lang != null) room.opts.lang = clean(a.lang, 24).replace(/[^\p{L} -]/gu, '') || 'English';
      }
    } else if (a.t === 'equip') {
      if (!own(ITEMS, a.item) || !own(p.inv, a.item) || !ITEMS[a.item].equippable) err = 'You cannot equip that.';
      else { p.eq[ITEMS[a.item].slot] = a.item; say(room, 'sys', `${p.name} equips ${ITEMS[a.item].name}.`); }
    } else if (a.t === 'give') {
      const to = own(room.players, a.to) ? room.players[a.to] : null;
      if (room.phase === 'combat') err = 'Not in the middle of a fight.';
      else if (!to || !to.cls || to.id === p.id) err = 'Choose another party member.';
      else if (a.item != null) {
        if (!own(ITEMS, a.item) || !own(p.inv, a.item)) err = 'You do not have that item.';
        else {
          if (p.eq.weapon === a.item && p.inv[a.item] === 1) p.eq.weapon = null;
          if (p.eq.armor === a.item && p.inv[a.item] === 1) p.eq.armor = null;
          takeItem(p, a.item); addItem(to, a.item, 1);
          say(room, 'sys', `${p.name} gives ${ITEMS[a.item].name} to ${to.name}.`);
        }
      } else {
        const gold = Math.floor(Number(a.gold));
        if (!(gold > 0) || gold > p.gold) err = 'You do not have that much gold.';
        else { p.gold -= gold; to.gold += gold; say(room, 'sys', `${p.name} gives ${gold} gold to ${to.name}.`); }
      }
    } else if (a.t === 'roll' && a.expr != null) {
      const r = rollDice(a.expr);
      if (!r) err = 'Dice look like 2d6+3 or d20.';
      else say(room, 'roll', `${p.name} rolls ${r.n}d${r.sides}${r.bonus ? (r.bonus > 0 ? '+' : '') + r.bonus : ''}: [${r.rolls.join(', ')}]${r.bonus ? ` ${r.bonus > 0 ? '+' : '−'} ${Math.abs(r.bonus)}` : ''} = ${r.total}`, { die: r.rolls[0] });
    } else if (a.t === 'roll') {
      err = resolveCheck(room, p);
    } else if (a.t === 'kick') {
      if (!isHost) err = 'Only the host can remove a player.';
      else if (!own(room.players, a.pid) || a.pid === pid) err = 'Choose another player.';
      else removePlayer(room, a.pid, 'was removed from the party');
    } else if (a.t === 'claimhost') {
      const host = room.players[room.host];
      if (host && host.online !== false) err = `${host.name} is still hosting.`;
      else { room.host = pid; say(room, 'sys', `${p.name} is now the host.`); }
    } else if (a.t === 'leave') {
      removePlayer(room, pid, 'left the party');
    } else if (a.t === 'use' && room.phase !== 'combat') {
      err = p.cls ? useItem(room, p, a) : 'Choose a class first.';
    } else if (a.t === 'nudge') {
      const b = room.dm.busy;
      if (!b) err = 'The Dungeon Master is not busy.';
      else if (Date.now() - b.since < DM_STALE_MS) err = 'Give the Dungeon Master a little longer.';
      else dmFallback(room, b.seq);
    } else if (a.t === 'skip') {
      const c = room.combat;
      const cur = c && room.players[c.turn];
      if (!cur) err = 'Nobody to skip.';
      else if (cur.id !== p.id && cur.online !== false && Date.now() - room.turnSince < IDLE_SKIP_MS) err = `${cur.name} still has time to act.`;
      else { say(room, 'sys', `${cur.name}'s turn is skipped.`); tickFx(cur); advance(room); }
    } else if (!p.cls) {
      err = 'Choose a class first.';
    } else if (a.t === 'move' || a.t === 'interact') {
      ensurePos(room);
      err = a.t === 'move' ? doMove(room, p, a) : doInteract(room, p, a);
    } else if (room.phase === 'lobby') {
      if (a.t !== 'start') err = 'The adventure has not started yet.';
      else if (!isHost) err = 'Only the host can begin the adventure.';
      else {
        const adv = DM.adventure(room.opts.adventure);
        room.phase = 'scene';
        room.scene = { location: adv.start.location, ambience: adv.start.ambience, shop: !!adv.start.shop, rested: false };
        room.story.stage = 0;
        newMap(room, adv.start.layout);
        const names = players(room).map((x) => `${x.name} the ${x.cls}`).join(', ');
        queueIntent(room, { pid: null, kind: 'event', text: 'start', detail: `The adventure begins. Open the story: set the scene at ${adv.start.location}, bring in the heroes (${names}) and present the hook.` });
      }
    } else if (a.t === 'intent') {
      const kind = ['do', 'say', 'ask'].includes(a.kind) ? a.kind : 'do';
      const text = clean(a.text, 400);
      if (!text) err = 'Say what you do first.';
      else if (room.phase === 'defeat') err = 'The party has fallen. Regroup first.';
      else if (room.phase === 'combat' && kind !== 'ask') err = 'In battle, use your actions — or ask the DM a question.';
      else if (room.dm.queue.filter((q) => q.pid === pid).length >= 2) err = 'The Dungeon Master is still catching up with you.';
      else { say(room, 'you', text, { who: p.name, mode: kind }); queueIntent(room, { pid, kind, text }); }
    } else if (a.t === 'director') {
      const text = clean(a.text, 300);
      if (!isHost) err = 'Only the host can direct the Dungeon Master.';
      else if (!text) err = 'Write a note for the Dungeon Master first.';
      else if (room.phase === 'defeat') err = 'Regroup first.';
      else { say(room, 'sys', `${p.name} passes a note to the Dungeon Master.`); queueIntent(room, { pid: null, kind: 'director', text }); }
    } else if (a.t === 'steer') {
      if (room.phase !== 'scene') err = 'Not right now.';
      else { say(room, 'sys', 'Someone asks the table to move on. The Dungeon Master changes course.'); queueIntent(room, { pid: null, kind: 'steer', text: 'Move on from the current content.' }); }
    } else if (a.t === 'recap') {
      if (room.phase === 'defeat') err = 'Regroup first.';
      else if (room.dm.queue.some((q) => q.kind === 'recap')) err = 'A recap is already on its way.';
      else { say(room, 'sys', `${p.name} asks for a recap.`); queueIntent(room, { pid: null, kind: 'recap', text: 'Summarize the story so far in a short paragraph, then remind the party of their open goals.' }); }
    } else if (room.phase === 'combat') {
      err = combatAction(room, p, a);
    } else if (room.phase === 'scene') {
      err = sceneAction(room, p, a);
    } else if (room.phase === 'defeat') {
      if (a.t !== 'regroup') err = 'The party has fallen.';
      else {
        room.phase = 'scene';
        room.scene.rested = true;
        players(room).forEach((m) => { m.alive = true; m.hp = m.maxHp; m.mana = m.maxMana; m.gold = Math.floor(m.gold / 2); m.fx = []; m.cds = {}; });
        placeParty(room);
        say(room, 'sys', 'The party regroups: everyone is back on their feet, and half of each purse is gone.');
        queueIntent(room, { pid: null, kind: 'event', text: 'lost', detail: `The whole party was beaten at ${room.scene.location}. They wake somewhere safe nearby, patched up and poorer. Narrate the waking and offer a way forward.` });
      }
    }

    if (err) return fail(err);
    room.updated = Date.now();
    return { ok: true };
  }

  // ---------- the Dungeon Master: requests ----------

  const budgetWord = (used, cap) => { const left = cap - used; return left <= 0 ? 'none' : left >= cap * 0.6 ? 'plenty' : 'a little'; };
  const allowedItems = (room) => {
    const cap = 60 * partyLevel(room) + 40;
    return Object.keys(ITEMS).filter((id) => ['weapon', 'armor', 'consumable', 'treasure'].includes(ITEMS[id].type) && id !== 'gold_coin' && ITEMS[id].value > 0 && ITEMS[id].value <= cap);
  };

  function dmView(room, intents) {
    const b = room.story.budget;
    const recent = [];
    room.log.slice(-14).forEach((e) => {
      if (e.k === 'dm') recent.push(`DM: ${clean(e.text, 320)}`);
      else if (e.k === 'you') recent.push(`${e.who} (${e.mode}): ${clean(e.text, 200)}`);
      else if (e.k === 'roll' || e.k === 'sys') recent.push(clean(e.text, 160));
    });
    return {
      opts: room.opts, mode: room.phase === 'combat' ? 'combat' : 'story',
      scene: { location: room.scene.location, ambience: room.scene.ambience, shop: room.scene.shop },
      party: players(room).map((p) => ({
        name: p.name, class: p.cls, level: p.level, hp: `${p.hp}/${p.maxHp}`, gold: p.gold, down: !p.alive,
        concept: p.bio || undefined, items: Object.keys(p.inv).map((id) => (ITEMS[id] ? ITEMS[id].name : id)), keepsakes: p.keep,
      })),
      combat: room.combat ? { round: room.combat.round, enemies: livingEnemies(room).map((e) => e.name), acting: (room.players[room.combat.turn] || {}).name } : null,
      npcs: room.story.npcs.map((n) => ({ name: n.name, voice: n.voice, mood: n.mood, note: n.note })),
      quests: room.story.quests, facts: room.story.facts.slice(-14), notes: room.story.notes.slice(-12),
      budget: { gold: budgetWord(b.gold, BUDGET.gold), items: budgetWord(b.items, BUDGET.items), healing: budgetWord(b.heal, BUDGET.heal), experience: budgetWord(b.xp, BUDGET.xp) },
      items: allowedItems(room).map((id) => ({ id, name: ITEMS[id].name })),
      recent: recent.slice(-12),
      intents: intents.map((i) => {
        const p = i.pid && room.players[i.pid];
        return i.detail ? { kind: i.kind, text: i.text, detail: i.detail } : { player: p ? p.name : 'table', kind: i.kind, text: i.text };
      }),
      stage: room.story.stage, players: players(room).length,
      map: room.map ? {
        layout: room.map.layout,
        things: room.map.objects.map((o) => `${o.name} (${o.kind})`),
        closedDoors: room.map.tiles.join('').split('+').length - 1,
      } : null,
    };
  }

  /** True when a Dungeon Master call should be started now. */
  function dmNeeded(room) {
    return !room.dm.busy && !room.dm.check && room.dm.queue.length > 0 && (room.phase === 'scene' || room.phase === 'combat');
  }

  /** Claim the next beat. Returns { seq, system, user, schema, view } or null. */
  function dmBegin(room, by) {
    if (!dmNeeded(room)) return null;
    const intents = room.dm.queue.splice(0, 6);
    const seq = ++room.dm.seq;
    room.dm.busy = { seq, since: Date.now(), by: by || 'server', intents };
    room.dm.note = '';
    room.updated = Date.now();
    const view = dmView(room, intents);
    return { seq, system: DM.SYSTEM, user: DM.buildUser(view), schema: DM.SCHEMA, view };
  }

  // ---------- the Dungeon Master: applying a reply ----------

  const hashVoice = (name) => { let h = 0; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return ['gruff', 'sage', 'young', 'sinister', 'noble', 'cheerful'][h % 6]; };

  function upsertNpc(room, name, patch) {
    name = clean(name, 28);
    if (!name || same(name, 'narrator') || findPlayer(room, name)) return null;
    let n = room.story.npcs.find((x) => same(x.name, name));
    if (!n) {
      n = { name, voice: DM.VOICES.includes(patch.voice) && patch.voice !== 'narrator' ? patch.voice : hashVoice(name), mood: 'neutral', note: '' };
      room.story.npcs.push(n);
      if (room.story.npcs.length > 12) room.story.npcs.shift();
    }
    if (['friendly', 'neutral', 'hostile'].includes(patch.mood)) n.mood = patch.mood;
    if (patch.note) n.note = clean(patch.note, 140);
    return n;
  }

  function scaleRoll(room, lo, hi, perLevel) { return Math.round(rnd(lo, hi) * (1 + perLevel * (partyLevel(room) - 1))); }

  /** Apply a list of proposed effects. Every one is validated and clamped. */
  function applyEffects(room, list, opts) {
    const b = room.story.budget;
    const hurt = {};
    let denied = false;
    (Array.isArray(list) ? list : []).slice(0, 6).forEach((e) => {
      if (!e || typeof e !== 'object' || !DM.EFFECT_TYPES.includes(e.type)) return;
      const tier = DM.TIERS.includes(e.tier) ? e.tier : 'minor';
      const party = same(e.target || '', 'party');
      const target = party ? null : findPlayer(room, e.target);
      const story = e.type === 'npc' || e.type === 'quest' || e.type === 'fact';
      if (opts.cosmetic && !story) return;

      if (e.type === 'npc') upsertNpc(room, e.name || e.target, { mood: e.mood, note: e.note });
      else if (e.type === 'quest') {
        const title = clean(e.name, 60);
        if (!title) return;
        let q = room.story.quests.find((x) => same(x.title, title));
        const status = ['active', 'done', 'failed'].includes(e.status) ? e.status : 'active';
        if (!q) {
          q = { title, status: 'active', note: '' };
          room.story.quests.push(q);
          if (room.story.quests.length > 8) room.story.quests.splice(room.story.quests.findIndex((x) => x.status !== 'active') >= 0 ? room.story.quests.findIndex((x) => x.status !== 'active') : 0, 1);
          say(room, 'sys', `New quest: ${title}.`);
        }
        if (q.status !== status) { q.status = status; say(room, 'sys', `Quest ${status === 'done' ? 'completed' : status === 'failed' ? 'failed' : 'updated'}: ${title}.`); }
        if (e.note) q.note = clean(e.note, 140);
      } else if (e.type === 'fact') {
        const note = clean(e.note || e.name, 160);
        if (note && !room.story.facts.includes(note)) { room.story.facts.push(note); if (room.story.facts.length > 14) room.story.facts.shift(); }
      } else if (e.type === 'damage') {
        if (!target || !target.alive || hurt[target.id]) return;
        hurt[target.id] = 1;
        const amount = tier === 'major' ? scaleRoll(room, 6, 16, 0.15) : tier === 'standard' ? scaleRoll(room, 4, 9, 0.15) : scaleRoll(room, 2, 5, 0.15);
        const before = target.hp;
        target.hp = Math.max(1, target.hp - amount);
        if (before - target.hp > 0) say(room, 'sys', `${target.name} takes ${before - target.hp} damage.`, { hurt: target.id });
      } else if (e.type === 'heal') {
        const cost = party ? 2 : 1;
        if ((!party && !target) || b.heal + cost > BUDGET.heal) { denied = true; return; }
        b.heal += cost;
        const base = tier === 'major' ? [8, 20] : tier === 'standard' ? [5, 13] : [3, 8];
        (party ? players(room) : [target]).filter((p) => p.alive).forEach((p) => {
          const got = heal(p, scaleRoll(room, base[0], base[1], 0.2));
          if (got) say(room, 'sys', `${p.name} recovers ${got} HP.`, { healed: p.id });
        });
      } else if (e.type === 'gold') {
        const cost = { minor: 1, standard: 2, major: 4 };
        const range = { minor: [3, 8], standard: [10, 25], major: [30, 60] };
        let t = tier;
        while (t && b.gold + cost[t] > BUDGET.gold) t = t === 'major' ? 'standard' : t === 'standard' ? 'minor' : null;
        if (!t || (!party && !target)) { denied = true; return; }
        b.gold += cost[t];
        const amount = scaleRoll(room, range[t][0], range[t][1], 0.2);
        if (party) {
          const ps = players(room);
          const each = Math.max(1, Math.round((amount * (0.6 + 0.4 * ps.length)) / ps.length));
          ps.forEach((p) => { p.gold += each; });
          say(room, 'sys', `The party gains ${each} gold each.`);
        } else { target.gold += amount; say(room, 'sys', `${target.name} gains ${amount} gold.`); }
      } else if (e.type === 'lose_gold') {
        if (!target) return;
        const amount = Math.min(target.gold, { minor: 5, standard: 15, major: 40 }[tier]);
        if (amount > 0) { target.gold -= amount; say(room, 'sys', `${target.name} pays ${amount} gold.`); }
      } else if (e.type === 'item') {
        const id = String(e.item || '');
        if (!target || !own(ITEMS, id) || !allowedItems(room).includes(id) || b.items + 1 > BUDGET.items) { denied = true; return; }
        b.items += 1;
        addItem(target, id, 1);
        say(room, 'sys', `${target.name} receives ${ITEMS[id].name}.`);
      } else if (e.type === 'take_item') {
        if (!target) return;
        const id = String(e.item || '');
        const keep = target.keep.findIndex((k) => same(k, e.name || e.item || ''));
        if (own(ITEMS, id) && own(target.inv, id)) {
          if (target.eq.weapon === id && target.inv[id] === 1) target.eq.weapon = null;
          if (target.eq.armor === id && target.inv[id] === 1) target.eq.armor = null;
          takeItem(target, id);
          say(room, 'sys', `${target.name} gives up ${ITEMS[id].name}.`);
        } else if (keep >= 0) { say(room, 'sys', `${target.name} gives up the ${target.keep[keep]}.`); target.keep.splice(keep, 1); }
      } else if (e.type === 'keepsake') {
        const name = clean(e.name, 40);
        if (!target || !name || target.keep.length >= 8 || target.keep.some((k) => same(k, name))) return;
        target.keep.push(name);
        say(room, 'sys', `${target.name} now carries the ${name}.`);
      } else if (e.type === 'xp') {
        const amount = { minor: 10, standard: 25, major: 50 }[tier];
        if (b.xp + amount > BUDGET.xp && !opts.trusted) { denied = true; return; }
        b.xp += amount;
        say(room, 'sys', `The party earns ${amount} experience.`);
        grantXp(room, amount);
      }
    });
    if (denied) room.dm.note = 'A reward the Dungeon Master offered was not granted: the limit for this location has been reached.';
  }

  /**
   * Apply a Dungeon Master reply to the beat `seq`. Returns {ok, entry},
   * {stale: true} when that beat is no longer open, or {invalid: true} when the
   * reply had nothing usable (the caller should then call dmFallback).
   */
  /** Put the NPCs who speak and the things the DM just described onto the map. */
  function placeStory(room, segs, features) {
    const m = room.map;
    const taken = blockers(room).all;
    m.objects.forEach((o) => taken.add(Maps.key(o.x, o.y)));
    const r = Maps.rng(`${m.id}|${room.story.beats}`);
    const names = new Set(m.objects.map((o) => o.name.toLowerCase()));
    segs.forEach((sg) => {
      if (sg.speaker === 'narrator' || names.has(sg.speaker.toLowerCase())) return;
      const npc = room.story.npcs.find((n) => same(n.name, sg.speaker));
      const spot = (m.spots && m.spots.npc || []).find((c) => Maps.walkable(m, c.x, c.y) && !taken.has(Maps.key(c.x, c.y))) || Maps.freeNear(m, centre(room), taken, 1, 2)[0];
      if (!spot) return;
      taken.add(Maps.key(spot.x, spot.y));
      const npcs = m.objects.filter((o) => o.kind === 'npc');
      if (npcs.length >= 6) m.objects.splice(m.objects.indexOf(npcs[0]), 1);
      m.objects.push({ id: 'o' + m.next++, kind: 'npc', x: spot.x, y: spot.y, name: sg.speaker, used: false, voice: sg.voice, mood: npc ? npc.mood : 'neutral' });
      names.add(sg.speaker.toLowerCase());
    });
    m.objects.forEach((o) => { if (o.kind === 'npc') { const n = room.story.npcs.find((x) => same(x.name, o.name)); if (n) o.mood = n.mood; } });
    features.slice(0, 4).forEach((f) => {
      const name = clean(String(f || '').replace(/^(the|a|an)\s+/i, ''), 32);
      if (!name || names.has(name.toLowerCase()) || findPlayer(room, name) || room.story.npcs.some((n) => same(n.name, name))) return;
      const spot = Maps.featureSpot(m, centre(room), taken, r);
      if (!spot) return;
      const feats = m.objects.filter((o) => o.kind === 'feature');
      if (feats.length >= 8) m.objects.splice(m.objects.indexOf(feats[0]), 1);
      m.objects.push({ id: 'o' + m.next++, kind: 'feature', x: spot.x, y: spot.y, name: name.charAt(0).toUpperCase() + name.slice(1), used: false });
      names.add(name.toLowerCase());
    });
  }

  function dmApply(room, seq, resp, opts) {
    opts = opts || {};
    if (!room.dm.busy || room.dm.busy.seq !== seq) return { stale: true };
    if (!resp || typeof resp !== 'object') return { invalid: true };
    const cosmetic = room.phase === 'combat';

    const segs = [];
    let budgetChars = 1800;
    (Array.isArray(resp.segments) ? resp.segments : []).slice(0, 6).forEach((s) => {
      if (!s || typeof s !== 'object') return;
      const raw = clean(String(s.text || '').replace(/[*_#`]/g, ''), Math.min(760, budgetChars + 60));
      let tags = 0;
      const tagged = raw.replace(/\[([^\]]{0,40})\]/g, (m0, t) => (/^[a-z][a-z ,'-]{0,30}$/i.test(t.trim()) && ++tags <= 3 ? `[${t.trim().toLowerCase()}]` : ' ')).replace(/\s+/g, ' ').trim();
      const text = clean(tagged.replace(/\[[^\]]*\]/g, ' '), Math.min(700, budgetChars));
      if (!text) return;
      budgetChars -= text.length;
      let speaker = clean(s.speaker, 28) || 'narrator';
      let voice = DM.VOICES.includes(s.voice) ? s.voice : 'narrator';
      if (same(speaker, 'narrator') || same(speaker, 'dm') || same(speaker, 'dungeon master')) { speaker = 'narrator'; voice = 'narrator'; } else if (findPlayer(room, speaker)) { speaker = 'narrator'; voice = 'narrator'; } else {
        const npc = upsertNpc(room, speaker, { voice });
        if (npc) { speaker = npc.name; voice = npc.voice; } else { speaker = 'narrator'; voice = 'narrator'; }
      }
      segs.push(tagged !== text ? { speaker, voice, text, tts: tagged } : { speaker, voice, text });
    });
    if (!segs.length) return { invalid: true };

    const extra = { segs, ai: !!opts.ai };
    let relayout = !room.map && room.phase === 'scene';
    let wantLayout = null;
    if (!cosmetic && resp.scene && typeof resp.scene === 'object') {
      const loc = clean(resp.scene.location, 48);
      wantLayout = Maps.LAYOUTS.includes(resp.scene.layout) ? resp.scene.layout : null;
      if (loc && !same(loc, room.scene.location)) {
        const words = (t) => new Set(t.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4));
        const before = words(room.scene.location);
        const related = [...words(loc)].some((w) => before.has(w));
        if (!related || (wantLayout && room.map && wantLayout !== room.map.layout)) relayout = true;
        room.scene.location = loc;
        room.scene.rested = false;
        extra.title = loc;
        const b = room.story.budget;
        if (room.story.beats - b.at >= 3) room.story.budget = { gold: 0, items: 0, heal: 0, xp: 0, at: room.story.beats };
      }
      if (DM.AMBIENCE.includes(resp.scene.ambience)) room.scene.ambience = resp.scene.ambience;
      room.scene.shop = resp.scene.shop === true;
    }
    if (relayout && room.phase === 'scene') newMap(room, wantLayout);
    if (!cosmetic && room.map) placeStory(room, segs, resp.scene && Array.isArray(resp.scene.features) ? resp.scene.features : []);
    const entry = say(room, 'dm', segs.map((s) => (s.speaker === 'narrator' ? s.text : `${s.speaker}: “${s.text}”`)).join(' '), extra);

    applyEffects(room, resp.effects, { cosmetic, trusted: !!opts.trusted });

    const ck = resp.check;
    if (!cosmetic && ck && typeof ck === 'object' && ck.needed === true) {
      const target = findPlayer(room, ck.player) || (room.dm.busy.intents.map((i) => i.pid && room.players[i.pid]).filter((x) => x && x.cls && x.alive).pop());
      if (target && target.alive) {
        const outcome = (o) => ({ text: clean(o && o.text, 500), effects: Array.isArray(o && o.effects) ? o.effects.slice(0, 4) : [] });
        room.dm.check = {
          pid: target.id, ability: DM.ABILITIES.includes(ck.ability) ? ck.ability : 'WIS',
          dc: (own(DC, ck.difficulty) ? DC[ck.difficulty] : DC.medium) + DIFF[room.opts.difficulty].dc,
          reason: clean(ck.reason, 80) || 'attempt it', at: Date.now(), ai: !!opts.ai,
          success: outcome(ck.success), failure: outcome(ck.failure),
        };
      }
    }

    const chips = [];
    (Array.isArray(resp.suggestions) ? resp.suggestions : []).forEach((s) => { const t = clean(s, 60); if (t && chips.length < 3 && !chips.some((x) => same(x, t))) chips.push(t); });
    room.dm.chips = chips;
    const memory = clean(resp.memory, 180);
    if (memory) { room.story.notes.push(memory); if (room.story.notes.length > 12) room.story.notes.shift(); }
    room.story.beats += 1;
    room.dm.busy = null;

    if (!cosmetic && !room.dm.check && resp.combat && typeof resp.combat === 'object' && resp.combat.start === true) {
      const stage = opts.trusted && resp._stageFight ? { stageFight: true, keepsake: resp._keepsake || null } : null;
      startCombat(room, sanitizeEnemies(room, resp.combat.enemies), stage);
    }
    room.updated = Date.now();
    return { ok: true, entry: entry.id };
  }

  /** Close the beat `seq` with the scripted Dungeon Master. */
  function dmFallback(room, seq, why) {
    const b = room.dm.busy;
    if (!b || b.seq !== seq) return { stale: true };
    const resp = DM.scripted(dmView(room, b.intents || []));
    const out = dmApply(room, seq, resp, { ai: false, trusted: true });
    if (out.invalid) { room.dm.busy = null; return out; }
    if (room.ai) room.dm.note = why === 'rate_limited' ? 'The AI Dungeon Master is being rate limited, so the scripted DM answered this one.' : 'The AI Dungeon Master did not answer in time, so the scripted DM stepped in for this beat.';
    return out;
  }

  return {
    ITEMS, SPELLS, CLASSES, ABILITIES, MONSTERS, SHOP, ABILITY_NAMES, ADVENTURES, MAX_PLAYERS, IDLE_SKIP_MS, CHECK_TIMEOUT_MS, DM_STALE_MS,
    newRoom, addPlayer, act, atkOf, defOf, locationOf, dmNeeded, dmBegin, dmApply, dmFallback, dmView,
    LAYOUTS: Maps.LAYOUTS, walkable: Maps.walkable, pathTo, reachable, rangeOf, speedOf, dist: Maps.dist,
  };
});
