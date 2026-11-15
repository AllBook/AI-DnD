// Bot playthroughs: 1-6 players run the whole campaign through the rules engine.
// Run with: npm test
const E = require('../engine.js');
function run(n) {
  const room = E.newRoom('TEST');
  const cls = ['Fighter', 'Wizard', 'Cleric', 'Rogue', 'Fighter', 'Wizard'];
  for (let i = 0; i < n; i++) { E.addPlayer(room, 'p' + i, 'Bot' + i); E.act(room, 'p' + i, { t: 'class', cls: cls[i] }); }
  let r = E.act(room, 'p0', { t: 'start' }); if (!r.ok) throw new Error(r.error);
  let steps = 0, defeats = 0, narr = r.narr.length;
  while (room.phase !== 'victory' && steps++ < 5000) {
    if (room.phase === 'camp') {
      if (!room.camp.rested) E.act(room, 'p0', { t: 'rest' });
      for (let i = 0; i < n; i++) { E.act(room, 'p' + i, { t: 'search' }); const p = room.players['p' + i]; for (const it of Object.keys(p.inv)) { const d = E.ITEMS[it]; if (d && d.equippable && d.stats && ((d.stats.attack || 0) > ((E.ITEMS[p.eq.weapon] || {stats:{}}).stats.attack || 0) || (d.stats.defense || 0) > ((E.ITEMS[p.eq.armor] || {stats:{}}).stats.defense || 0))) E.act(room, p.id, { t: 'equip', item: it }); } while (p.gold >= 50 && (p.inv.health_potion || 0) < 3) E.act(room, p.id, { t: 'buy', item: 'health_potion' }); }
      r = E.act(room, 'p0', { t: 'attempt', text: 'look for trouble', ability: 'WIS' }); narr += r.narr.length;
      r = E.act(room, 'p0', { t: 'travel' }); if (!r.ok) throw new Error(r.error); narr += r.narr.length;
    } else if (room.phase === 'combat') {
      const p = room.players[room.combat.turn];
      const foes = room.combat.enemies.filter((e) => e.alive);
      const hurt = Object.values(room.players).filter((x) => x.alive && x.hp < x.maxHp * 0.5)[0];
      let a = { t: 'attack', target: foes[0].id };
      if (p.hp < p.maxHp * 0.35 && p.inv.health_potion) a = { t: 'use', item: 'health_potion' };
      else if (p.cls === 'Cleric' && hurt && p.mana >= 10) a = { t: 'spell', id: 'heal', target: hurt.id };
      else if (p.cls === 'Cleric' && hurt && !p.cds.heal) a = { t: 'ability', id: 'heal', target: hurt.id };
      else if (p.cls === 'Wizard') { const s = p.spells.filter((id) => E.SPELLS[id].mana_cost <= p.mana && !p.cds[id]).pop(); a = s ? { t: 'spell', id: s, target: foes[0].id } : (!p.cds.fireball ? { t: 'ability', id: 'fireball', target: foes[0].id } : a); }
      else { const ab = E.CLASSES[p.cls].abilities.find((id) => !p.cds[id] && id !== 'heal'); if (ab) a = { t: 'ability', id: ab, target: foes[0].id }; else if (Math.random() < 0.1) a = { t: 'attempt', text: 'swing from the rafters', ability: 'DEX', target: foes[0].id }; }
      r = E.act(room, p.id, a);
      if (!r.ok) { r = E.act(room, p.id, { t: 'attack', target: foes[0].id }); if (!r.ok) throw new Error('stuck: ' + r.error + ' ' + JSON.stringify(a)); }
      narr += r.narr.length;
    } else if (room.phase === 'defeat') { defeats++; E.act(room, 'p0', { t: 'regroup' }); if (defeats > 30) break; }
  }
  JSON.parse(JSON.stringify(room));
  const lv = Object.values(room.players).map((p) => p.cls[0] + p.level).join(' ');
  return `${n}p: phase=${room.phase} stage=${room.stage} steps=${steps} defeats=${defeats} levels=[${lv}] narr=${narr} bytes=${JSON.stringify(room).length}`;
}
for (const n of [1, 2, 3, 4, 6]) { const out = []; for (let k = 0; k < 4; k++) out.push(run(n)); console.log(out.join('\n')); }
// rule checks
const room = E.newRoom('X'); E.addPlayer(room, 'a', 'A'); E.addPlayer(room, 'b', 'B');
console.log('start w/o class:', E.act(room, 'a', { t: 'start' }).error);
E.act(room, 'a', { t: 'class', cls: 'Fighter' }); E.act(room, 'b', { t: 'class', cls: 'Wizard' }); E.act(room, 'a', { t: 'start' }); E.act(room, 'a', { t: 'travel' });
console.log('out of turn:', E.act(room, 'b', { t: 'attack' }).error, '| skip too early:', E.act(room, 'b', { t: 'skip' }).error, '| bad action:', E.act(room, 'a', { t: 'nope' }).error, '| stranger:', E.act(room, 'zz', { t: 'chat', text: 'hi' }).error);
console.log('ok');
