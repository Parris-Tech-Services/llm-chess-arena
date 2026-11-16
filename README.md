# LLM Chess Arena

Two AI models play chess live in the browser. A third AI referees. A deterministic
rules engine decides what is actually legal.

**[Live Cloudflare Arena](https://llm-chess-arena.parris-neathaustralia.workers.dev/)** · **[With Stockfish analysis](https://llm-chess-arena.parris-neathaustralia.workers.dev/?analysis=on)** · [Source](https://github.com/Parris-Tech-Services/llm-chess-arena) · Node 18+ · no database · no build step

```
 White model ─┐
              ├─► Arena loop ─► chess.js validates ─► SSE ─► every spectator
 Black model ─┘        │
                       └─► Referee model (commentary, conduct, verdict — never legality)
```

## Why the referee does not judge legality

A third LLM cannot reliably adjudicate chess: it hallucinates rules, misses pins,
and will happily "accept" an illegal move. So the responsibilities are split:

| Question | Owner |
|---|---|
| Is this move legal? Mate, stalemate, repetition, 50-move, insufficient material? | `chess.js` |
| Was that illegal move misconduct or a formatting failure? | Arena policy (code) |
| What does the move mean? Was the conduct acceptable? Who was player of the match? | Referee LLM |

The referee's verdict is stored **beside** the engine result and can never override
it. A `dispute` is shown to spectators together with the engine result that stands.

## Features

- **Live play** — legal moves only, validated server-side; the board is never
  mutated by model text.
- **Broadcast UI** — animated pieces, last-move and check highlights, clocks,
  move list, live commentary feed, light/dark themes, four board palettes,
  optional sound, fullscreen.
- **Mobile first** — single-column layout under 860 px, 44 px touch targets,
  board sized to the viewport so it is visible without scrolling.
- **Controls** — Start, Pause, Resume, Stop, Rematch (colours swapped), New game.
- **Referee** — per-move remarks, explanations of rejected moves, tactical notes,
  final verdict, summary, conduct ruling and player of the match.
- **Standings** — Elo (K=24, base 1200) computed only from completed games, with
  W/D/L, legal-move rate, average response time and head-to-head records.
- **Move history** — Back, Forward, slider and Live below the board, both during matches and saved replays; reviewing older moves never changes the actual game.
- **Replays** — every game persisted, scrubbable at `/g/<id>`, PGN download.
- **Resilience** — key rotation across accounts, rate-limit cooldowns, smaller retry budgets, tactical fallback rather than a random move when no valid reply arrives, forfeit on repeated illegal moves, and interrupted-game recovery.
- **Performance** — shorter prompts, temperature 0.15, concise output, a shared 35-second turn deadline and fewer referee calls. This does not make an LLM as strong as Stockfish; tactical candidate ranking only looks one ply ahead.
- **Privacy** — only each model's public `THINK:` line is stored or broadcast.
  Hidden reasoning channels are discarded at the provider layer.

## Chess strength modes

The match setup now supports three independently labelled modes:

- **Pure LLM** (default): the language models choose legal moves themselves; the shallow fallback heuristic is not Stockfish.
- **Stockfish-assisted LLM**: a local native Stockfish process searches each position for up to ~180 ms. The LLM must choose from its top three candidates. Any move outside those candidates is replaced by Stockfish's best choice; the move record labels this as an engine override. This mode improves practical strength without pretending every engine move was proposed by the model.
- **Stockfish only**: both sides are moved entirely by Stockfish, without per-move model requests. This is the fastest and strongest exhibition mode, but is **not** LLM vs LLM. The referee is not needed for engine-only games.

Stockfish is always optional. When the binary is unavailable, the two Stockfish modes are disabled and rejected on the server; the pure LLM mode still works. Only `chess.js` can commit a legal move.

### Stockfish installation

Stockfish uses the UCI text protocol and is launched as a local subprocess. On Debian/Ubuntu install `stockfish` (usually `/usr/games/stockfish`); alternatively provide the absolute binary path in `STOCKFISH_PATH`. All engine requests are bounded and validated against `chess.js` before a piece moves.

A `render.yaml` Blueprint supplies a **free preview** setup (Docker, health checks, Singapore region) when deployed from Render. Free Render web services sleep after inactivity, and their local game history is lost on restart. A paid instance with a disk, or an external persistent store, is required for durable history. This Blueprint deliberately avoids paid infrastructure by default.

The provided Dockerfile installs Stockfish and the Node dependencies automatically. Engine availability is reported at `/health` and `/api/config`; no engine is silently substituted for the chosen match mode.

### Persistent hosting (without Termux)

The repo now includes a production Dockerfile. Deploy to a container host (Railway/Render/VPS) with `HOST=0.0.0.0`, a persistent volume mounted at `/data`, and `DATA_DIR=/data`. Configure `GROQ_KEYS` securely in the host to use real LLMs; without credentials it intentionally runs **mock mode**. The engine-only mode works without Groq credentials.

Stockfish is GPL-3.0 licensed: see <https://stockfishchess.org> and <https://github.com/official-stockfish/Stockfish>. The standalone binary runs as a separate subprocess, and the package's licence/copyright notices must be retained on redistribution.

## Run

```bash
npm install
npm test        # 11 unit tests, offline
npm run e2e     # 5 HTTP tests against a real server process
npm run smoke   # plays a short live game against Groq
npm start       # http://127.0.0.1:8787
```

Without credentials the server starts in **mock mode** (random legal bots) so the
whole UI and API can be exercised offline.

## Configuration

Environment variables only in production:

| Variable | Purpose |
|---|---|
| `GROQ_KEYS` | Comma or newline separated keys. Preferred over files. |
| `KEYS_FILE` | Path to a local `keys.txt` (dev fallback, gitignored). |
| `DATA_DIR` | Where games and results are stored (default `./data`). |
| `PORT`, `HOST` | Listen address (default `127.0.0.1:8787`). |
| `CLOCK_BASE_MS`, `CLOCK_INCREMENT_MS` | Default time control. |
| `MOVE_BUDGET_MS`, `PLY_DELAY_MS` | Per-move ceiling and spectator pacing. |
| `GIT_SHA` | Reported by `/health`. |

`keys.txt` format:

```
acct-01=gsk_...
acct-02=gsk_...
```

## API

| Endpoint | Purpose |
|---|---|
| `GET /events` | SSE: `state`, `tick`, `turn`, `stream`, `move`, `rejection`, `referee`, `verdict`, `log` |
| `GET /api/state` | Current snapshot |
| `GET /api/config` | Playable models, defaults, limits |
| `POST /api/start` | `{white, black, referee, timeControl, pace}` |
| `POST /api/pause` \| `resume` \| `stop` \| `rematch` \| `new` | Game control |
| `POST /api/resume-interrupted` | Continue a game restored after a restart |
| `GET /api/games` · `/api/games/:id` | History and full replay records |
| `GET /api/standings` | Elo and head-to-head from real results |
| `GET /health` | Liveness, version, game, key health |

`/api/keys` returns aggregate health only — never names or key material.

## Security notes

- Keys live only in the server process. They are never sent to the browser, never
  committed, and never logged.
- Per-IP rate limits on every state-changing endpoint (6 starts/min, 20 actions/min).
- Strict CSP, `nosniff`, `no-referrer`, frame-ancestors self.
- Path traversal is rejected in game IDs; request bodies are size-limited.
- **If a key has ever been pasted into a chat, transcript or log, rotate it.**

## Deployment

The app is a single Node process plus static files. It works on any host that can
run Node with a persistent process (Fly, Railway, Render, a VPS, or a Cloudflare
tunnel to a local process):

```bash
GROQ_KEYS=... DATA_DIR=/var/lib/arena PORT=8080 node src/server.mjs
```

SSE requires buffering to be disabled (`X-Accel-Buffering: no` is already sent).

## Licence

MIT.

## Transport note

SSE is the fast path (token-level commentary). Cloudflare's account-less
`trycloudflare.com` tunnel buffers event streams, so the client watches for
silence and automatically falls back to 1.5 s state polling. Both transports
render the same moves, clocks, commentary and referee log — polling simply
delivers commentary once per move instead of token by token.


## Cloudflare live deployment (verified 16 Nov 2026)

The existing **llm-chess-arena** Worker hosts autonomous matches using Workers AI and a persistent Durable Object, independently of Termux or Render. The live frontend is fetched from `public/` in this repository. A versioned copy of the exact deployed bundled Worker, its non-destructive engine proxy and the migration acceptance record are under `cloudflare/` and `docs/CLOUDFLARE_FIRST_IMPLEMENTATION.md`.

Use **Enable analysis** under the board to run Stockfish 19 Lite locally in your browser, or add `?analysis=on` to the URL. Sharing while reviewing move 6 generates a link with `?ply=6`, so the viewer opens that exact position; analysis remains optional. **Browser Stockfish does not override autonomous LLM decisions.** Native Stockfish-assisted moves remain available only on the Docker/Node backend.

This Worker deployment has retained the existing `ARENA` Durable Object namespace and `AI` binding. GitHub frontend updates are read by the Worker directly, while bundled Worker/backend code requires a separate controlled Cloudflare deployment; automatic backend deployment is not yet configured.
