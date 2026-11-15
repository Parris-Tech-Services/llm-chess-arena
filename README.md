# LLM Chess Arena

Two AI models play chess live in the browser. A third AI referees. A deterministic
rules engine decides what is actually legal.

**[Watch](https://github.com/Parris-Tech-Services/llm-chess-arena)** · Node 18+ · no database · no build step

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
- **Replays** — every game persisted, scrubbable at `/g/<id>`, PGN download.
- **Resilience** — key rotation across accounts, 429 cooldowns, adaptive
  `max_tokens` when a free tier rejects an oversized request, forced legal move
  on formatting failures, forfeit on repeated illegal moves, interrupted-game
  recovery after a restart.
- **Privacy** — only each model's public `THINK:` line is stored or broadcast.
  Hidden reasoning channels are discarded at the provider layer.

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
