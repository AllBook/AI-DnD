#!/usr/bin/env node
/* Bundle the client, the Dungeon Master brain and the rules engine into one
 * self-contained page that can be published as a Claude artifact. There it
 * uses the artifact's shared document store instead of server.js, the
 * viewer's own Claude as the Dungeon Master, and Claude's built-in voices.
 *
 * Usage: node tools/build-artifact.js [out.html]
 * Capabilities to declare when publishing: db, sample, tts, dictation, downloads. */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const html = read('public/index.html');
const body = html.slice(html.indexOf('<!--app-->') + 10, html.indexOf('<!--/app-->'));
const script = (code) => '<script>\n' + code.replace(/<\/script/gi, '<\\/script') + '\n</script>';
const out = [
  '<title>AI-DnD Online</title>',
  '<meta name="claude:viewport-fit-sides" content="cover">',
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Alegreya+Sans:wght@400;500;700&family=IM+Fell+English+SC&display=swap">',
  '<style>\n' + read('public/style.css') + '</style>',
  body.trim(),
  script('window.DND_DATA = ' + JSON.stringify(JSON.parse(read('data.json'))) + ';'),
  script(read('dm.js')),
  script(read('engine.js')),
  script(read('public/audio.js')),
  script(read('public/net.js')),
  fs.existsSync(path.join(root, 'public/table.js')) ? script(read('public/table.js')) : '',
  script(read('public/app.js')),
  '',
].join('\n');
const target = process.argv[2] || path.join(root, 'artifact.html');
fs.writeFileSync(target, out);
console.log(`wrote ${target} (${(out.length / 1024).toFixed(1)} KB)`);
