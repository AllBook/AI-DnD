# AI-DnD Online

A co-op tabletop adventure for up to five friends, run by an AI Dungeon Master you
talk to. One person creates a party, everyone else joins with its four-letter code
or the invite link, and the Dungeon Master takes it from there.

- **A Dungeon Master you can talk to.** Type what your character does or says, or
  ask the DM a question. It narrates, plays every NPC, calls for dice rolls and
  starts fights when they break out. The host can steer it with director's notes.
- **A visual tabletop.** Every place has an illustrated backdrop, heroes and
  speaking NPCs stand on it as tokens with health rings, and fights play out on a
  battle mat where you click a monster's token to target it. Hits, heals and d20
  rolls are animated. It is all drawn in code, so it needs no image service.
- **Voiced.** With an ElevenLabs key the narrator and each NPC archetype speak in
  their own voice, and each scene has ambience. Without one, the browser's own
  speech is used. Captions are always shown.
- **Fair.** The DM only proposes; the rules engine owns every number and every die.
  Rewards come in tiers that the engine converts and caps per location, so nobody
  can talk their way into a fortune.
- **The repo's rules and content.** The four classes and their abilities from
  `dnd_game.py`, d20 checks, mana, and the items, spells and loot tables exported
  from `items.py` / `spells.py`.
- **Three adventures plus your own premise**: The Emberpeak Mines, The Drowned
  Lighthouse, Caravan to Saltmarch Pass, or a premise the host writes.
- **No dependencies.** One Node process, nothing to `npm install`.

## Run it

```bash
cd online
node server.js            # http://localhost:3000
```

With no keys the scripted Dungeon Master runs each adventure as a guided crawl and
voices fall back to browser speech. Add keys for the full experience:

```bash
ANTHROPIC_API_KEY=your-key ELEVENLABS_API_KEY=your-key node server.js
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `ANTHROPIC_API_KEY` | – | Dungeon Master brain: Claude (used first when set) |
| `ANTHROPIC_MODEL` | see `providers.js` | Claude model. Smaller models answer faster |
| `GEMINI_API_KEY` | – | Dungeon Master brain: Gemini. Also the voice when there is no ElevenLabs key |
| `GEMINI_MODEL` | see `providers.js` | Gemini model |
| `DM_PROVIDER` | auto | Force `anthropic`, `gemini` or `scripted` |
| `ELEVENLABS_API_KEY` | – | Narrator and NPC voices, generated ambience |
| `ELEVENLABS_MODEL` | `eleven_flash_v2_5` | ElevenLabs speech model |
| `ELEVENLABS_VOICE_<ARCHETYPE>` | built-in cast | Override a voice id, e.g. `ELEVENLABS_VOICE_NARRATOR` |
| `VOICE_PROVIDER` | auto | Force `elevenlabs`, `gemini`, `browser` or `off` |
| `VOICE_CHAR_BUDGET` | `40000` | Characters of speech per party per day |
| `DATA_DIR` | `./data` | Saved parties and the audio cache |

The ElevenLabs key needs the **Text to Speech** permission (and **Sound Effects**
for generated ambience). It does not need to list voices.

## Put it online

The server is one long-running Node process (it keeps a Server-Sent Events stream
per player), so use a host that runs a web service or container, not serverless
functions.

**Render.** The repository root has a `render.yaml` blueprint.

1. Open `https://render.com/deploy?repo=<your repo URL>` (add `/tree/<branch>` to the
   repo URL to deploy a branch) and approve the blueprint.
2. Paste the keys you have when asked: `ANTHROPIC_API_KEY` or `GEMINI_API_KEY` for
   the Dungeon Master, `ELEVENLABS_API_KEY` for voices. Leave the others empty.
3. Share the `https://….onrender.com` address with your friends.

By hand instead: New → Web Service → pick the repo and branch → Root Directory
`online` → Build Command `npm install` → Start Command `node server.js`, then add the
keys under Environment.

**Anything that runs Docker** (Fly.io, Railway, a VPS):

```bash
cd online
docker build -t ai-dnd-online .
docker run -p 3000:3000 -v aidnd-data:/app/data \
  -e ANTHROPIC_API_KEY=your-key -e ELEVENLABS_API_KEY=your-key ai-dnd-online
```

Parties are saved under `DATA_DIR` and restored on restart, and a party can be
resumed by its code for 14 days. On hosts whose disk is wiped on every restart
(Render's free plan is one) a restart ends the parties in progress; attach a
persistent disk or volume to keep them.

## How a session plays

1. **Lobby.** Pick Fighter, Wizard, Rogue or Cleric and, if you like, a one-line
   concept for your character. The host picks the adventure, tone, difficulty and
   language, then begins. Friends can join later too.
2. **The story.** Write what you do (*Do*), speak in character (*Say*), or ask the
   Dungeon Master a question (*Ask*). The first action is answered at once; anything
   the others send while the DM is thinking is answered together in the next reply.
   When the DM calls for a check, the named player rolls the d20. Tap a suggestion
   if you are stuck, rest once per location, trade when a merchant is around.
3. **Battle.** When a fight breaks out the turn-based engine takes over: attack, use
   a class ability, cast, drink a potion, defend, or improvise a stunt. You can
   still ask the DM questions. If someone disconnects or idles for 45 seconds,
   anyone can skip their turn.
4. **Tools.** `/roll 2d6+3`, `/recap`, a journal of quests, people and facts, a
   rejoin code for switching devices, host tools (director's note, kick), a "steer
   away" button for content the table would rather skip, and a story export.

## Files

| File | What it is |
| --- | --- |
| `server.js` | HTTP + SSE server, saves, one Dungeon Master call per room at a time, voice endpoints |
| `engine.js` | The rules. One JSON room, changed by `act()` and by `dmApply()`, which validates and clamps what a Dungeon Master proposes |
| `dm.js` | The adventures, the Dungeon Master prompt and reply schema, and the scripted Dungeon Master |
| `providers.js` | Claude, Gemini and ElevenLabs adapters (plain `fetch`) |
| `data.json` | Items, spells and loot tables, generated by `tools/export_data.py` |
| `public/` | The client: `app.js` (UI), `net.js` (transports), `audio.js` (voices, ambience, effects), `table.js` (the visual tabletop) |
| `test/` | `sim.js` (bot parties play every adventure; anti-cheat checks), `server.test.js` (HTTP end to end), `providers.test.js` (adapters against mock upstreams) |
| `tools/build-artifact.js` | Bundles everything into one page that runs as a Claude artifact |

```bash
npm test
```

After changing `items.py` or `spells.py`, refresh the game data from the repository
root with `python3 online/tools/export_data.py`.

## What was and was not tested

- The engine, the scripted Dungeon Master, the server API, saving and restoring,
  and the browser client were tested automatically.
- ElevenLabs speech and sound effects were called live.
- The Claude and Gemini adapters follow the documented request formats and pass
  tests against local mock servers, but were **not** called live during
  development. If the Dungeon Master falls back to the scripted one on every
  reply, check the server log for the provider's error.

## Not in this version

Movement and range rules on the battle mat (tokens are placed for you),
AI-generated scene art, private whispers to the Dungeon Master, spectators and
accounts.
