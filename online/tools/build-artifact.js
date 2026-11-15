#!/usr/bin/env node
/* Bundle the client + rules engine into one self-contained page that can be
 * published as a Claude artifact (it then uses the artifact's shared document
 * store instead of server.js). Usage: node tools/build-artifact.js [out.html] */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const html = read('public/index.html');
const body = html.slice(html.indexOf('<!--app-->') + 10, html.indexOf('<!--/app-->'));
const out = [
  '<title>AI-DnD Online</title>',
  '<meta name="claude:viewport-fit-sides" content="cover">',
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Alegreya+Sans:wght@400;500;700&family=IM+Fell+English+SC&display=swap">',
  '<style>\n' + read('public/style.css') + '</style>',
  body.trim(),
  '<script>window.DND_DATA = ' + JSON.stringify(JSON.parse(read('data.json'))) + ';</script>',
  '<script>\n' + read('engine.js') + '</script>',
  '<script>\n' + read('public/app.js') + '</script>',
  '',
].join('\n');
const target = process.argv[2] || path.join(root, 'artifact.html');
fs.writeFileSync(target, out);
console.log(`wrote ${target} (${(out.length / 1024).toFixed(1)} KB)`);
