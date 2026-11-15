/*
 * AI-DnD Online — shared rules engine.
 *
 * A turn-based, multi-player port of the combat rules in dnd_game.py
 * (Character abilities, d20 ability checks, mana) with the item, spell and
 * loot data exported from items.py / spells.py into data.json.
 *
 * The whole room is one plain JSON object so it can live in server memory or
 * in a shared document store. Runs in Node (require) and in the browser
 * (window.Engine).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./data.json'));
  else root.Engine = factory(root.DND_DATA);
})(typeof self !== 'undefined' ? self : this, function (DATA) {
  'use strict';

  const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  const d = (n) => rnd(1, n);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const abilityMod = (score) => Math.floor((score - 10) / 2);
  const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

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
  const ITEMS = Object.assign({}, DATA.items, EXTRA_ITEMS);
  const SPELLS = DATA.spells;

  const CLASSES = {
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
      blurb: 'Strips armour with a backstab, stuns with a cheap shot, finds what others miss.',
    },
    Cleric: {
      hp: 38, atk: 5, def: 2, hpPerLevel: 6,
      scores: { STR: 12, DEX: 10, CON: 14, INT: 10, WIS: 16, CHA: 12 },
      gear: { mace: 1, holy_symbol: 1, health_potion: 3, mana_potion: 2 }, equip: ['mace'],
      abilities: ['heal'], learn: { 2: 'rejuvenation', 4: 'resurrection' },
      blurb: 'Keeps the party standing. Healing, a divine shield, and a mace for emphasis.',
    },
  };

  const ABILITIES = {
    heavy_strike: { name: 'Heavy Strike', cd: 2, target: 'enemy', desc: 'Strike for double your attack.' },
    fireball: { name: 'Fireball', cd: 3, target: 'enemy', desc: 'Hurl fire for 15–20 damage. Costs no mana.' },
    backstab: { name: 'Backstab', cd: 2, target: 'enemy', desc: 'Cut 2 defense off the target, then hit for 150%.' },
    cheap_shot: { name: 'Cheap Shot', cd: 2, target: 'enemy', desc: 'Hit for 120% with a 30% chance to stun.' },
    heal: { name: 'Heal', cd: 1, target: 'ally', desc: 'Restore 1–20 HP to an ally. Costs no mana.' },
  };

  const MONSTERS = {
    Goblin: { hp: [18, 26], atk: [6, 8], def: 1, xp: 20, ability: 'fury', loot: 'goblin' },
    Bandit: { hp: [24, 32], atk: [8, 10], def: 2, xp: 30, ability: 'cheap_shot', loot: 'bandit' },
    Skeleton: { hp: [22, 30], atk: [7, 9], def: 2, xp: 30, ability: 'bone_shield', loot: 'skeleton' },
    Orc: { hp: [34, 46], atk: [10, 12], def: 3, xp: 45, ability: 'rage', loot: 'orc' },
    Boss: { hp: [95, 95], atk: [13, 14], def: 4, xp: 150, ability: 'bone_shield', loot: 'boss' },
  };

  const HOME = 'Thornhaven Village';
  const STAGES = [
    { loc: 'Darkwood Forest', make: (p) => [['Goblin', p + 1]],
      intro: 'The road out of Thornhaven narrows under the black boughs of Darkwood. Something chitters in the ferns, and then the goblins are on you.' },
    { loc: 'Emberpeak Mine Entrance', make: (p) => [['Bandit', p], ['Goblin', 1]],
      intro: 'Timber props frame the mouth of the Emberpeak mine. The toll collectors lounging there are no miners, and they have already drawn steel.' },
    { loc: 'Main Mine Shaft', make: (p) => [['Goblin', p], ['Orc', 1]], drop: 'miners_note',
      intro: 'Cart rails run down into lamplit dark. A hulking orc drives a goblin work gang, and all of them turn at the sound of your boots.' },
    { loc: 'Storage Cavern', make: (p) => [['Skeleton', p + 1]],
      intro: 'Crates and barrels, grey with dust. The miners who stacked them never left, and their bones rise rattling from between the shelves.' },
    { loc: 'Deep Mines', make: (p) => [['Orc', Math.ceil(p / 2)], ['Bandit', p, 'Corrupted Miner']],
      intro: 'The rock here glows a sick ember red. Miners with coal-black eyes swing their picks at nothing, until they notice you.' },
    { loc: 'Ancient Crypt', boss: true, make: (p) => [['Boss', 1, 'The Rune Warden'], ['Skeleton', Math.max(1, p - 1)]],
      intro: 'Beyond a broken wall lies a crypt far older than the mine. On its dais the Rune Warden stirs, the shattered rune burning in its ribcage.' },
  ];

  const SHOP = ['health_potion', 'mana_potion', 'greater_health_potion', 'strength_elixir', 'iron_sword', 'leather_armor', 'steel_longsword', 'chainmail'];
  const ABILITY_NAMES = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];
  const MAX_PLAYERS = 6;
  const MAX_LOG = 140;
  const IDLE_SKIP_MS = 45000;

  // ---------- room & players ----------

  function newRoom(code) {
    return {
      code, phase: 'lobby', stage: 0, loop: 0, seq: 0,
      players: {}, order: [], combat: null, camp: { rested: false, searched: {}, tries: {} },
      log: [], created: Date.now(), updated: Date.now(), turnSince: Date.now(),
    };
  }

  function say(room, k, text, extra) {
    const e = Object.assign({ id: ++room.seq, k, text }, extra || {});
    room.log.push(e);
    if (room.log.length > MAX_LOG) room.log.splice(0, room.log.length - MAX_LOG);
    return e;
  }

  function addPlayer(room, id, name) {
    if (room.players[id]) { room.players[id].online = true; return { ok: true }; }
    if (room.order.length >= MAX_PLAYERS) return { ok: false, error: 'This party is full (6 adventurers).' };
    name = clean(name, 20) || 'Adventurer';
    const taken = new Set(room.order.map((pid) => room.players[pid].name.toLowerCase()));
    let n = name, i = 2;
    while (taken.has(n.toLowerCase())) n = name + ' ' + i++;
    room.players[id] = {
      id, name: n, cls: null, level: 1, xp: 0, hp: 0, maxHp: 0, mana: 0, maxMana: 0, atk: 0, def: 0,
      gold: 0, inv: {}, eq: { weapon: null, armor: null }, spells: [], cds: {}, fx: [], alive: true, online: true, scores: {},
    };
    room.order.push(id);
    say(room, 'sys', `${n} joined the party.`);
    return { ok: true };
  }

  function setClass(room, p, cls) {
    const c = CLASSES[cls];
    if (!c) return 'Unknown class.';
    if (p.cls && room.phase !== 'lobby') return 'Your class is already chosen.';
    p.cls = cls;
    p.scores = Object.assign({}, c.scores);
    p.maxHp = p.hp = c.hp;
    p.atk = c.atk; p.def = c.def;
    p.maxMana = p.mana = 50 + Math.max(abilityMod(c.scores.INT), abilityMod(c.scores.WIS)) * 10;
    p.inv = Object.assign({}, c.gear);
    p.eq = { weapon: null, armor: null };
    c.equip.forEach((it) => { p.eq[ITEMS[it].slot] = it; });
    p.gold = rnd(10, 50);
    p.spells = (DATA.startingSpells[cls] || []).slice();
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
    for (const slot in c.eq) { const it = c.eq[slot] && ITEMS[c.eq[slot]]; if (it && it.stats && it.stats[stat]) s += it.stats[stat]; }
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
    target.hp = Math.min(target.maxHp, target.hp + amount);
    return target.hp - before;
  }

  const players = (room) => room.order.map((id) => room.players[id]).filter((p) => p.cls);
  const livingPlayers = (room) => players(room).filter((p) => p.alive);
  const livingEnemies = (room) => (room.combat ? room.combat.enemies.filter((e) => e.alive) : []);
  const locationOf = (room) => (room.phase === 'combat' ? STAGES[room.stage].loc : room.stage === 0 ? HOME : STAGES[Math.min(room.stage, STAGES.length) - 1].loc);

  function addItem(p, item, qty) { p.inv[item] = (p.inv[item] || 0) + qty; }
  function takeItem(p, item) { p.inv[item] -= 1; if (p.inv[item] <= 0) delete p.inv[item]; }
  function lootText(loot) {
    return Object.keys(loot).map((id) => (id === 'gold_coin' ? `${loot[id]} gold` : `${loot[id] > 1 ? loot[id] + '× ' : ''}${ITEMS[id] ? ITEMS[id].name : id}`)).join(', ');
  }
  function rollLoot(table) {
    const t = DATA.loot[table];
    const out = {};
    if (!t) return { gold_coin: rnd(1, 5) };
    if (t.gold[1] > 0) { const g = rnd(t.gold[0], t.gold[1]); if (g > 0) out.gold_coin = g; }
    t.items.forEach((e) => { if (Math.random() < e.chance) out[e.id] = (out[e.id] || 0) + rnd(e.qty[0], e.qty[1]); });
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
        if (spell && !p.spells.includes(spell)) { p.spells.push(spell); line += ` Learned ${SPELLS[spell].name}.`; }
        say(room, 'sys', line);
      }
    });
  }

  // ---------- narration requests ----------

  function context(room) {
    const party = players(room).map((p) => `${p.name} the level ${p.level} ${p.cls} (${p.alive ? `${p.hp}/${p.maxHp} HP` : 'down'})`).join('; ');
    const foes = livingEnemies(room).map((e) => e.name).join(', ');
    return `Setting: ${locationOf(room)}, on the quest to recover the Shattered Rune from the Emberpeak mines.\nParty: ${party || 'nobody yet'}.${foes ? `\nEnemies still standing: ${foes}.` : ''}`;
  }
  function ask(room, narr, entry, event, lines) {
    narr.push({
      id: entry.id,
      prompt: `You are the Dungeon Master of a co-op fantasy tabletop game.\n${context(room)}\n\nWhat just happened: ${event}\n\nNarrate this moment in ${lines || '2-3'} vivid sentences, second person plural, present tense. Stay consistent with the facts above. Do not mention numbers, dice or game mechanics, do not decide what the players do next, and do not use markdown.`,
    });
  }
  function setNarration(room, id, text) {
    const e = room.log.find((x) => x.id === id);
    text = clean(text, 900);
    if (!e || !text) return false;
    e.text = text; e.ai = true; delete e.wait;
    room.updated = Date.now();
    return true;
  }

  // ---------- combat flow ----------

  function startCombat(room, narr) {
    const stage = STAGES[room.stage];
    const p = Math.max(1, players(room).length);
    const scale = 1 + 0.35 * room.loop;
    const enemies = [];
    stage.make(p).forEach(([type, count, alias]) => {
      const m = MONSTERS[type];
      for (let i = 0; i < count && enemies.length < 7; i++) {
        let hp = rnd(m.hp[0], m.hp[1]);
        if (type === 'Boss') hp += 30 * p;
        hp = Math.round(hp * (0.92 + 0.1 * p) * scale);
        const base = alias || type;
        enemies.push({
          id: 'e' + (enemies.length + 1), type, name: count > 1 ? `${base} ${i + 1}` : base,
          hp, maxHp: hp, atk: Math.round(rnd(m.atk[0], m.atk[1]) * scale), def: m.def, fx: [], alive: true, rage: 0, fury: 0, shielded: false, boss: type === 'Boss',
        });
      }
    });
    const order = livingPlayers(room).map((x) => x.id);
    room.phase = 'combat';
    room.combat = { enemies, order, turn: null, round: 1 };
    players(room).forEach((x) => { x.cds = {}; x.fx = []; });
    const e = say(room, 'dm', stage.intro, { title: stage.loc });
    ask(room, narr, e, `The party enters ${stage.loc} and is attacked by ${enemies.map((x) => x.name).join(', ')}. Scene notes: ${stage.intro}`);
    beginTurn(room, order[0], narr);
  }

  function beginTurn(room, pid, narr, guard) {
    const c = room.combat;
    guard = guard || 0;
    const p = room.players[pid];
    c.turn = pid;
    room.turnSince = Date.now();
    if (!p || !p.alive) return advance(room, narr, guard + 1);
    p.mana = Math.min(p.maxMana, p.mana + Math.max(5, Math.round(p.maxMana * 0.1)));
    for (const k in p.cds) { p.cds[k] -= 1; if (p.cds[k] <= 0) delete p.cds[k]; }
    p.fx = p.fx.filter((f) => f.k !== 'guard');
    if (hasFx(p, 'stun')) {
      p.fx = p.fx.filter((f) => f.k !== 'stun');
      say(room, 'act', `${p.name} is stunned and loses the turn.`);
      tickFx(p);
      return advance(room, narr, guard + 1);
    }
  }

  function advance(room, narr, guard) {
    const c = room.combat;
    if (!c) return;
    guard = guard || 0;
    if (!livingEnemies(room).length) return winCombat(room, narr);
    if (!livingPlayers(room).length) return loseCombat(room, narr);
    if (guard > 20) { c.turn = livingPlayers(room)[0].id; room.turnSince = Date.now(); return; }
    const idx = c.order.indexOf(c.turn);
    for (let i = idx + 1; i < c.order.length; i++) {
      const p = room.players[c.order[i]];
      if (p && p.alive) return beginTurn(room, p.id, narr, guard);
    }
    enemyPhase(room);
    if (!livingPlayers(room).length) return loseCombat(room, narr);
    if (!livingEnemies(room).length) return winCombat(room, narr);
    c.round += 1;
    const first = c.order.map((id) => room.players[id]).find((p) => p && p.alive);
    return beginTurn(room, first.id, narr, guard);
  }

  function enemyPhase(room) {
    const c = room.combat;
    for (const e of c.enemies) {
      if (!e.alive) continue;
      const targets = livingPlayers(room);
      if (!targets.length) return;
      if (hasFx(e, 'stun')) { say(room, 'foe', `${e.name} is stunned and cannot act.`); tickFx(e); continue; }
      const t = pick(targets);
      const m = MONSTERS[e.type];
      const special = Math.random() < 0.3;
      if (e.boss && c.round % 3 === 0) {
        const parts = targets.map((p) => `${p.name} ${hit(p, atkOf(e) * 0.7)}`);
        say(room, 'foe', `${e.name} unleashes a rune pulse across the whole party — ${parts.join(', ')} damage.`);
      } else if (special && m.ability === 'fury' && e.fury < 3) {
        e.fury += 1; e.atk += 2;
        const a = hit(t, atkOf(e)), b = t.alive ? hit(t, atkOf(e)) : 0;
        say(room, 'foe', `${e.name} flies into a Fury and slashes ${t.name} twice for ${a + b} damage.`);
      } else if (special && m.ability === 'rage' && e.rage < 2) {
        e.rage += 1; e.atk += 3; e.def += 2;
        say(room, 'foe', `${e.name} bellows with Rage (attack +3, defense +2) and smashes ${t.name} for ${hit(t, atkOf(e) * 1.5)} damage.`);
      } else if (special && m.ability === 'bone_shield' && !e.shielded) {
        e.shielded = true; e.def *= 2;
        say(room, 'foe', `${e.name} knits a Bone Shield, doubling its defense to ${e.def}.`);
      } else if (special && (m.ability === 'cheap_shot' || e.boss)) {
        const dmg = hit(t, atkOf(e) * 1.2);
        const stun = t.alive && Math.random() < 0.3;
        if (stun) addFx(t, 'stun', 0, 1);
        say(room, 'foe', `${e.name} lands a Cheap Shot on ${t.name} for ${dmg} damage${stun ? ' — stunned!' : '.'}`);
      } else {
        const roll = d(6);
        say(room, 'foe', `${e.name} attacks ${t.name} (d6: ${roll}) for ${hit(t, atkOf(e) + roll)} damage.`);
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
    grantXp(room, Math.round((m.xp * (1 + 0.35 * room.loop) * 2) / (players(room).length + 1)));
  }

  function winCombat(room, narr) {
    const stage = STAGES[room.stage];
    const cleared = stage.loc;
    room.combat = null;
    players(room).forEach((p) => {
      p.fx = []; p.cds = {};
      if (!p.alive) { p.alive = true; p.hp = Math.max(1, Math.round(p.maxHp * 0.25)); }
    });
    if (stage.drop) {
      const finder = pick(players(room));
      addItem(finder, stage.drop, 1);
      say(room, 'sys', `${finder.name} finds ${ITEMS[stage.drop].name}: “${ITEMS[stage.drop].description}”`);
    }
    room.stage += 1;
    room.camp = { rested: false, searched: {}, tries: {} };
    if (room.stage >= STAGES.length) {
      room.phase = 'victory';
      const e = say(room, 'dm', 'The Rune Warden collapses into dust and the ember glow drains from the walls. The Shattered Rune is yours, and Emberpeak is quiet for the first time in a generation.', { title: 'Victory' });
      ask(room, narr, e, `The party has defeated the Rune Warden, the final guardian in the ${cleared}, and recovered the Shattered Rune. The adventure is won.`, '3-4');
    } else {
      room.phase = 'camp';
      const e = say(room, 'dm', `The last of them falls and ${cleared} goes still. You make camp among the wreckage, bind your wounds and count the spoils.`, { title: `${cleared} — cleared` });
      ask(room, narr, e, `The party won the fight in ${cleared} and now makes camp there. Next ahead lies ${STAGES[room.stage].loc}.`);
    }
    room.turnSince = Date.now();
  }

  function loseCombat(room, narr) {
    room.phase = 'defeat';
    room.combat = null;
    const e = say(room, 'dm', 'One by one your torches gutter out. The dark closes over the party…', { title: 'Defeat' });
    ask(room, narr, e, `Every member of the party has fallen in ${STAGES[room.stage].loc}. Villagers will drag them back to safety, alive but beaten.`);
  }

  // ---------- actions ----------

  function findTarget(room, action, kind) {
    if (kind === 'enemy') {
      const e = room.combat && room.combat.enemies.find((x) => x.id === action.target && x.alive);
      return e || livingEnemies(room)[0];
    }
    const p = room.players[action.target];
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
    const it = ITEMS[id];
    if (!it || !p.inv[id]) return 'You do not have that item.';
    if (it.type !== 'consumable') return 'That item cannot be used like that.';
    const target = findTarget(room, action, 'ally') || p;
    if (!target.alive) return `${target.name} is down — a potion will not help.`;
    const bits = [];
    it.effects.forEach((fx) => {
      if (fx.type === 'heal') bits.push(`restores ${heal(target, fx.value)} HP`);
      else if (fx.type === 'mana') { const b = target.mana; target.mana = Math.min(target.maxMana, target.mana + fx.value); bits.push(`restores ${target.mana - b} mana`); }
      else if (fx.type === 'buff_attack') { addFx(target, 'str', fx.value, (fx.duration || 3) + 1); bits.push(`grants +${fx.value} attack for ${fx.duration || 3} turns`); }
      else if (fx.type === 'buff_defense') { addFx(target, 'guard', fx.value, (fx.duration || 3) + 1); bits.push(`grants +${fx.value} defense`); }
    });
    takeItem(p, id);
    say(room, 'act', `${p.name} uses ${it.name}${target.id !== p.id ? ` on ${target.name}` : ''}: ${bits.join(', ') || 'no effect'}.`);
    return null;
  }

  function castSpell(room, p, action) {
    const s = SPELLS[action.id];
    if (!s || !p.spells.includes(action.id)) return 'You do not know that spell.';
    if (p.mana < s.mana_cost) return `Not enough mana. ${s.name} needs ${s.mana_cost}.`;
    if (p.cds[action.id]) return `${s.name} is on cooldown for ${p.cds[action.id]} more turn(s).`;
    const bonus = abilityMod(p.scores.INT) + gearStat(p, 'magic_damage');
    if (s.spell_type === 'Damage') {
      if (!room.combat) return 'There is nothing to attack.';
      const targets = s.aoe ? livingEnemies(room) : [findTarget(room, action, 'enemy')];
      if (!targets[0]) return 'There is nothing to attack.';
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
        say(room, 'act', `${p.name} casts Resurrection. ${t.name} rises with ${t.hp} HP!`);
      } else {
        if (!t.alive) return `${t.name} is down. Only Resurrection can help now.`;
        p.mana -= s.mana_cost;
        say(room, 'act', `${p.name} casts ${s.name} on ${t.id === p.id ? 'themself' : t.name}, healing ${heal(t, rnd(s.heal[0], s.heal[1]))} HP.`);
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
    if (s.cooldown) p.cds[action.id] = s.cooldown + 1;
    return null;
  }

  function abilityCheck(p, ability) {
    const roll = d(20);
    const top = Object.keys(p.scores).sort((a, b) => p.scores[b] - p.scores[a]).slice(0, 2);
    const m = abilityMod(p.scores[ability]) + (top.includes(ability) ? 2 : 0);
    return { roll, mod: m, total: roll + m };
  }
  const checkText = (c, ability, dc) => `${ability} check: d20 (${c.roll}) ${c.mod >= 0 ? '+' : '−'} ${Math.abs(c.mod)} = ${c.total} vs DC ${dc}`;

  function combatAction(room, p, a, narr) {
    const c = room.combat;
    if (c.turn !== p.id) return 'It is not your turn.';
    if (!p.alive) return 'You are down.';
    if (a.t === 'attack') {
      const e = findTarget(room, a, 'enemy');
      const roll = d(6);
      strike(room, p, e, atkOf(p) + roll, `${p.name} attacks ${e.name} (d6: ${roll}) for {d} damage.`);
    } else if (a.t === 'ability') {
      const ab = ABILITIES[a.id];
      if (!ab || !CLASSES[p.cls].abilities.includes(a.id)) return 'You do not have that ability.';
      if (p.cds[a.id]) return `${ab.name} is ready in ${p.cds[a.id]} turn(s).`;
      if (a.id === 'heal') {
        const t = findTarget(room, a, 'ally') || p;
        if (!t.alive) return `${t.name} is down. Only Resurrection can help now.`;
        say(room, 'act', `${p.name} lays on hands and heals ${t.id === p.id ? 'themself' : t.name} for ${heal(t, d(20))} HP.`);
      } else {
        const e = findTarget(room, a, 'enemy');
        if (a.id === 'heavy_strike') strike(room, p, e, atkOf(p) * 2, `${p.name} brings down a Heavy Strike on ${e.name} for {d} damage.`);
        else if (a.id === 'fireball') strike(room, p, e, rnd(15, 20), `${p.name} hurls a Fireball at ${e.name} for {d} damage.`);
        else if (a.id === 'backstab') { e.def = Math.max(0, e.def - 2); strike(room, p, e, atkOf(p) * 1.5, `${p.name} slips behind ${e.name} and Backstabs for {d} damage (defense −2).`); }
        else if (a.id === 'cheap_shot') {
          const stun = Math.random() < 0.3;
          strike(room, p, e, atkOf(p) * 1.2, `${p.name} lands a Cheap Shot on ${e.name} for {d} damage${stun ? ' — stunned!' : '.'}`);
          if (stun && e.alive) addFx(e, 'stun', 0, 1);
        }
      }
      p.cds[a.id] = ab.cd + 1;
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
      const ability = ABILITY_NAMES.includes(a.ability) ? a.ability : 'DEX';
      if (!text) return 'Describe what you attempt.';
      const e = findTarget(room, a, 'enemy');
      const dc = 13;
      const chk = abilityCheck(p, ability);
      const ok = chk.total >= dc || chk.roll === 20;
      let outcome;
      if (ok) {
        const dmg = hit(e, (atkOf(p) + d(6) + 5) * (chk.roll === 20 ? 2 : 1));
        addFx(e, 'slow', 3, 2);
        outcome = `Success${chk.roll === 20 ? ' — natural 20!' : '!'} ${e.name} takes ${dmg} damage and is thrown off balance.`;
      } else if (chk.roll === 1) { outcome = `Natural 1. It goes badly, and ${p.name} takes ${hit(p, 4 + defOf(p))} damage.`; }
      else outcome = 'It fails, and the moment is lost.';
      say(room, 'roll', `${p.name} improvises: “${text}” — ${checkText(chk, ability, dc)}. ${outcome}`);
      const dm = say(room, 'dm', ok ? `It works. ${e.name} reels.` : 'The gamble does not pay off.', { wait: true });
      ask(room, narr, dm, `In the middle of the fight, ${p.name} the ${p.cls} tries this against ${e.name}: "${text}". The attempt ${ok ? 'SUCCEEDS and hurts the enemy' : 'FAILS'}${e.alive ? '' : ', and the enemy is killed by it'}.`, '1-2');
      if (!e.alive) onKill(room, p, e);
    } else return 'You cannot do that in combat.';
    tickFx(p);
    advance(room, narr);
    return null;
  }

  function campAction(room, p, a, narr) {
    const camp = room.camp;
    if (a.t === 'travel') {
      if (room.stage >= STAGES.length) return 'The adventure is over.';
      say(room, 'sys', `${p.name} leads the party onward to ${STAGES[room.stage].loc}.`);
      startCombat(room, narr);
    } else if (a.t === 'rest') {
      if (camp.rested) return 'The party has already rested here.';
      camp.rested = true;
      players(room).forEach((m) => { m.alive = true; m.hp = Math.min(m.maxHp, m.hp + Math.ceil(m.maxHp * 0.6)); m.mana = m.maxMana; });
      say(room, 'sys', `${p.name} calls a rest. Everyone recovers 60% HP and all mana.`);
    } else if (a.t === 'search') {
      if (camp.searched[p.id]) return 'You have already searched this place.';
      camp.searched[p.id] = true;
      const dc = 12;
      const chk = abilityCheck(p, 'WIS');
      if (p.cls === 'Rogue') { chk.mod += 2; chk.total += 2; }
      if (chk.total >= dc || chk.roll === 20) {
        const loot = rollLoot(chk.roll === 20 && room.stage >= 3 ? 'chest_rare' : 'chest_common');
        giveLoot(room, p, loot);
        say(room, 'roll', `${p.name} searches the area — ${checkText(chk, 'WIS', dc)}. Found a stash: ${lootText(loot)}.`);
      } else say(room, 'roll', `${p.name} searches the area — ${checkText(chk, 'WIS', dc)}. Nothing but dust.`);
    } else if (a.t === 'buy') {
      const it = ITEMS[a.item];
      if (!it || !SHOP.includes(a.item)) return 'The quartermaster does not stock that.';
      if (p.gold < it.value) return `Not enough gold. ${it.name} costs ${it.value}.`;
      p.gold -= it.value;
      addItem(p, a.item, 1);
      say(room, 'sys', `${p.name} buys ${it.name} for ${it.value} gold.`);
    } else if (a.t === 'use') {
      const err = useItem(room, p, a);
      if (err) return err;
    } else if (a.t === 'spell') {
      const s = SPELLS[a.id];
      if (!s || s.spell_type !== 'Heal') return 'Save that for a fight.';
      const err = castSpell(room, p, a);
      if (err) return err;
    } else if (a.t === 'attempt') {
      const text = clean(a.text, 160);
      const ability = ABILITY_NAMES.includes(a.ability) ? a.ability : 'WIS';
      if (!text) return 'Describe what you attempt.';
      camp.tries[p.id] = (camp.tries[p.id] || 0) + 1;
      const rewarded = camp.tries[p.id] <= 2;
      const dc = pick([10, 12, 15]);
      const chk = abilityCheck(p, ability);
      const ok = chk.total >= dc || chk.roll === 20;
      let outcome = ok ? 'Success!' : 'Failure.';
      if (ok && rewarded) {
        const gold = rnd(6, 15);
        p.gold += gold;
        outcome = `Success! It turns up ${gold} gold`;
        if (chk.roll === 20) { addItem(p, 'health_potion', 1); outcome += ' and a Health Potion — natural 20'; }
        outcome += '.';
      }
      say(room, 'roll', `${p.name} attempts: “${text}” — ${checkText(chk, ability, dc)}. ${outcome}`);
      const dm = say(room, 'dm', ok ? 'It goes just as planned.' : 'It does not go as planned.', { wait: true });
      ask(room, narr, dm, `While the party rests at ${locationOf(room)}, ${p.name} the ${p.cls} attempts: "${text}". The attempt ${ok ? 'SUCCEEDS' : 'FAILS'}.`, '2');
    } else return 'You cannot do that right now.';
    return null;
  }

  /**
   * Apply one player action. Mutates the room.
   * Returns { ok, error?, narr: [{id, prompt}] } — narr lists log entries an
   * AI narrator may rewrite via setNarration(); each already holds usable text.
   */
  function act(room, pid, a) {
    const narr = [];
    const p = room.players[pid];
    const fail = (error) => ({ ok: false, error, narr: [] });
    if (!p) return fail('You are not in this party.');
    if (!a || typeof a.t !== 'string') return fail('Bad action.');
    let err = null;

    if (a.t === 'chat') {
      const text = clean(a.text, 240);
      if (!text) return fail('Say something first.');
      say(room, 'chat', text, { who: p.name });
      if (a.dm) {
        const dm = say(room, 'dm', 'The Dungeon Master considers this…', { wait: true });
        narr.push({ id: dm.id, prompt: `You are the Dungeon Master of a co-op fantasy tabletop game.\n${context(room)}\n\n${p.name}${p.cls ? ' the ' + p.cls : ''} says to you: "${text}"\n\nAnswer in character in 1-3 sentences. You may describe the world, hint, or banter, but do not change HP, gold or items and do not use markdown.` });
      }
    } else if (a.t === 'class') {
      err = setClass(room, p, a.cls);
      if (!err) say(room, 'sys', `${p.name} takes up the mantle of the ${p.cls}.`);
    } else if (a.t === 'equip') {
      const it = ITEMS[a.item];
      if (!it || !p.inv[a.item] || !it.equippable) err = 'You cannot equip that.';
      else { p.eq[it.slot] = a.item; say(room, 'sys', `${p.name} equips ${it.name}.`); }
    } else if (a.t === 'skip') {
      const c = room.combat;
      const cur = c && room.players[c.turn];
      if (!cur) err = 'Nobody to skip.';
      else if (cur.id !== p.id && cur.online !== false && Date.now() - room.turnSince < IDLE_SKIP_MS) err = `${cur.name} still has time to act.`;
      else { say(room, 'sys', `${cur.name}'s turn is skipped.`); tickFx(cur); advance(room, narr); }
    } else if (!p.cls) {
      err = 'Choose a class first.';
    } else if (room.phase === 'lobby') {
      if (a.t !== 'start') err = 'The adventure has not started yet.';
      else {
        room.phase = 'camp'; room.stage = 0;
        room.camp = { rested: false, searched: {}, tries: {} };
        const names = players(room).map((x) => `${x.name} the ${x.cls}`).join(', ');
        const e = say(room, 'dm', `The Rusty Axe Tavern, Thornhaven. Miners have stopped coming home from Emberpeak, and the reeve is paying well for anyone bold enough to find out why. A rune as old as the mountain is said to lie broken at the bottom of it all.`, { title: HOME });
        ask(room, narr, e, `The adventure begins in the Rusty Axe Tavern in ${HOME}. The party (${names}) accepts the reeve's job: miners are vanishing in the Emberpeak mines, where an ancient Shattered Rune is rumoured to lie. Introduce the scene and the heroes.`, '3-4');
      }
    } else if (room.phase === 'combat') {
      err = combatAction(room, p, a, narr);
    } else if (room.phase === 'camp') {
      err = campAction(room, p, a, narr);
    } else if (room.phase === 'defeat') {
      if (a.t !== 'regroup') err = 'The party has fallen.';
      else {
        room.phase = 'camp';
        room.camp = { rested: true, searched: {}, tries: {} };
        players(room).forEach((m) => { m.alive = true; m.hp = Math.ceil(m.maxHp * 0.6); m.mana = m.maxMana; m.gold = Math.floor(m.gold / 2); m.fx = []; m.cds = {}; });
        say(room, 'dm', 'You wake on straw pallets, bandaged and lighter of purse. Whoever dragged you out took half your gold for the trouble. The way ahead is still waiting.', { title: 'Regrouped' });
      }
    } else if (room.phase === 'victory') {
      if (a.t !== 'again') err = 'The adventure is complete.';
      else {
        room.loop += 1; room.stage = 0; room.phase = 'camp';
        room.camp = { rested: false, searched: {}, tries: {} };
        players(room).forEach((m) => { m.hp = m.maxHp; m.mana = m.maxMana; m.alive = true; });
        say(room, 'dm', `Word of your deeds outruns you back to Thornhaven — and so does worse news. The rune's breaking woke things deeper still. (New Journey +${room.loop}: enemies are ${35 * room.loop}% stronger.)`, { title: `${HOME} — Journey +${room.loop}` });
      }
    }

    if (err) return fail(err);
    room.updated = Date.now();
    return { ok: true, narr };
  }

  return {
    ITEMS, SPELLS, CLASSES, ABILITIES, STAGES, SHOP, HOME, ABILITY_NAMES, MAX_PLAYERS, IDLE_SKIP_MS,
    newRoom, addPlayer, act, setNarration, atkOf, defOf, locationOf,
  };
});
