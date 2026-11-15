# AI-DnD Online

A co-op tabletop adventure for up to five friends, run by an AI Dungeon Master you
talk to. One person creates a party, everyone else joins with its four-letter code
or the invite link, and the Dungeon Master takes it from there.

- **A Dungeon Master you can talk to.** Type what your character does or says, or
  ask the DM a question. It narrates, plays every NPC, calls for dice rolls and
  starts fights when they break out. The host can steer it with director's notes.
- **A walkable tabletop.** Every location is a top-down map: the tavern's tables,
  bar and hearth; dungeon rooms, corridors and doors; forests, caves, mines,
  crypts, towns, docks and camps. Click to walk, open doors to lift the fog of war,
  loot chests, click NPCs to talk and story features to examine them. Things the
  DM describes appear on the map. Fights play out on the same grid with movement,
  reach and range, as in D&D. All drawn in code, no image service needed.
- **Voiced.** With an ElevenLabs key the narrator and each NPC archetype speak in
  their own voice, acted with emotion tags such as [whispers] on ElevenLabs v4, and each scene has ambience. Without one, the browser's own
  speech is used. Captions are always shown.
- **Fair.** The DM only proposes; the rules engine owns every number and every die.
  Rewards come in tiers that the engine converts and caps per location, so nobody
  can talk their way into a fortune.
- **Deep character creation.** Twelve classes, eight races and eight backgrounds;
  standard array or 27-point buy; body, colours, hair, beard and marks. Every hero
  is drawn as a full figure (in the lobby, the party list and their sheet) and as a
  matching token on the map.
- **A campaign that grows.** Level-up choices (ability increases, new spells,
  feats), chapters, a threat clock, reputation per place, a companion who fights
  beside you, named magic items with quirks, conditions, death saves, short and
  long rests, and achievements. Download an illustrated journal of the campaign.
- **An open lobby.** See every open table and who is playing right now, and jump
  in with one click. Hosts can unlist or lock their table.
- **The repo's rules and content.** d20 checks, mana, and the items, spells and
  loot tables exported from `items.py` / `spells.py`, extended.
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
| `ELEVENLABS_MODEL` | `eleven_v4` | ElevenLabs speech model. `eleven_flash_v2_5` is faster and half the price, without emotion tags |
| `ELEVENLABS_VOICE_<ARCHETYPE>` | built-in cast | Override a voice id, e.g. `ELEVENLABS_VOICE_NARRATOR` |
| `SOPRANO_URL` | – | Use a self-hosted [Soprano](https://github.com/ekwek1/soprano) voice server instead of ElevenLabs, e.g. `http://soprano:8000` |
| `VOICE_PROVIDER` | auto | Force `soprano`, `elevenlabs`, `gemini`, `browser` or `off`. Auto picks Soprano, then ElevenLabs, then Gemini |
| `VOICE_CHAR_BUDGET` | `40000` | Characters of speech per party per day |
| `DATA_DIR` | `./data` | Saved parties and the audio cache |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | – | Also save parties to a free Upstash Redis database, so they survive restarts on hosts that wipe the disk |

The ElevenLabs key needs the **Text to Speech** permission (and **Sound Effects**
for generated ambience). It does not need to list voices.

## Free, self-hosted voice: Soprano

[Soprano](https://github.com/ekwek1/soprano) is a small open-source voice model
(80M parameters, Apache-2.0) that runs on an ordinary CPU, about one to two
seconds per line. It has one voice, speaks English only and ignores emotion
tags, so NPCs sound the same as the narrator. It needs about 1.2 GB of memory,
more than Render's free plan gives.

Run it next to the game and point the game at it:

```bash
cd online/soprano
docker build -t soprano .
docker run -p 8000:8000 soprano
SOPRANO_URL=http://localhost:8000 node ../server.js
```

On Render, create a **Private Service** from this repository with Root Directory
`online/soprano` and Docker runtime on a plan with at least 2 GB of memory, then
set `SOPRANO_URL=http://<service-name>:8000` on the game. Keep it private: the
Soprano server has no password. `/healthz?voice=1` on the game shows whether it
answers.

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

## Keeping campaigns on a free host

Render's free plan wipes the disk on every restart and redeploy. Three things keep
campaigns safe anyway:

1. **Cloud saves (recommended).** Create a free database at
   [upstash.com](https://upstash.com) (Redis, any region near your server), open its
   REST API section, and add `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`
   to the server's environment. Every party is then saved there as you play and
   reloaded when the server starts. `/healthz` shows `"saves": "cloud (Upstash) and
   disk"` when it is on.
2. **Browser copies.** Each player's browser keeps a copy of their party; if the
   server has forgotten it, the first player back restores it automatically.
3. **Save files.** Settings → *Download campaign save*. On the join screen,
   *Resume from a save file* brings the party back on any server or device.

The free plan also sleeps after about 15 idle minutes, and the first visit then takes
about a minute. A free uptime monitor (for example UptimeRobot) that opens `/healthz`
every 10 minutes keeps it awake; one always-on service fits within the free plan's
monthly hours.

## How a session plays

1. **Lobby.** Join an open table from the front page or with a code. Build your
   hero: race, class, background, scores and looks. The host picks the adventure,
   tone, difficulty and language, then begins. Friends can join later too.
2. **The story.** Write what you do (*Do*), speak in character (*Say*), or ask the
   Dungeon Master a question (*Ask*). The first action is answered at once; anything
   the others send while the DM is thinking is answered together in the next reply.
   When the DM calls for a check, the named player rolls the d20. Tap a suggestion
   if you are stuck, take a short or long rest, trade when a merchant is around.
3. **Battle.** When a fight breaks out the turn-based engine takes over: attack, use
   a class ability, cast, drink a potion, defend, or improvise a stunt. You can
   still ask the DM questions. Leaving an enemy's reach provokes a free attack. A
   hero at 0 HP makes death saves until an ally stabilises or heals them. If
   someone disconnects or idles for 45 seconds, anyone can skip their turn.
4. **Tools.** `/roll 2d6+3`, `/recap`, a journal of quests, people and facts, a
   rejoin code for switching devices, host tools (director's note, kick, pause the
   DM, redo its last reply, scene mood, start an encounter), a "steer away" button for content the table would rather skip, and a story export.

## Files

| File | What it is |
| --- | --- |
| `server.js` | HTTP + SSE server, saves, one Dungeon Master call per room at a time, voice endpoints |
| `engine.js` | The rules. One JSON room, changed by `act()` and by `dmApply()`, which validates and clamps what a Dungeon Master proposes |
| `maps.js` | Map generation, pathfinding and fog of war |
| `dm.js` | The adventures, the Dungeon Master prompt and reply schema, and the scripted Dungeon Master |
| `providers.js` | Claude, Gemini and ElevenLabs adapters (plain `fetch`) |
| `data.json` | Items, spells and loot tables, generated by `tools/export_data.py` |
| `public/` | The client: `app.js` (UI), `net.js` (transports), `audio.js` (voices, ambience, effects), `table.js` (the visual tabletop), `figure.js` (character figures) |
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

AI-generated scene art, private whispers to the Dungeon Master, spectators and
accounts.
