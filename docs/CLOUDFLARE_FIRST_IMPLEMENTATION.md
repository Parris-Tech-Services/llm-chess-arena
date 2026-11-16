# Cloudflare-first Chess Arena — operational implementation and acceptance

## Goal
Provide a durable, publicly accessible, phone-independent Chess Arena at a stable HTTPS URL, with competitive, fast chess, live Back / Forward / Live navigation, saved games, honest provenance of engine versus AI moves, clear running costs, and automatic deployment from source control.

## Findings verified on 16 November 2026
- **Do not delete a Render service.** The Cloudflare account already contains a deployed Worker named `llm-chess-arena` and a separate `llm-chess-square` proxy.
- The existing `llm-chess-arena` Worker has a Workers AI binding (`AI`), a persistent Durable Object binding (`ARENA` / class `ArenaRoom`), and a Worker subdomain enabled.
- The Worker is running `cloudflare-durable-v2`; its /health response confirmed autonomous Durable Object game state with a previously completed 13-ply game and 0 Groq keys. The Worker can use Cloudflare Workers AI without Groq keys.
- Its frontend HTML/CSS/JS is fetched from this GitHub repository by the Worker, so **changes to the existing public assets propagate to Cloudflare without a separate frontend host**.
- Native Node Stockfish from the Docker build cannot execute inside ordinary Cloudflare Workers. Browser-side Stockfish is a separate execution mode, not an autonomous cloud backend.

## Delivery sequence and acceptance
1. **Version control**: snapshot the existing Cloudflare Worker into the repo with a pinned Worker script source, plus documented deployment settings. No API secrets in Git.
2. **Real browser engine**: add local browser UCI Stockfish analysis and optional browser engine playback. Use a small single-threaded engine served from a pinned CDN through the existing Cloudflare Worker. The browser must never silently label these moves as LLM moves.
3. **Better observability**: show game state, per-move latency, exact provider mode, rejected moves and move provenance. Keep existing Back/Forward/Live controls functional.
4. **Cost / reliability**: preserve Durable Object alarms and Workers AI backend; avoid new Render services, Termux or temporary tunnels.
5. **Deployment**: upload tested Worker code via Cloudflare API with existing AI and Durable Object bindings intact; verify the Worker subdomain and real /health, /api/config, frontend and engine assets externally.
6. **Continuous delivery**: retain GitHub Actions tests, document a reproducible deployment path, and where authorised connect automatic Cloudflare builds after checks.

## Truthful scope
- Pure LLM matches run autonomously on the existing Cloudflare Durable Object backend.
- Browser Stockfish provides expert analysis only while a spectator's device runs it. Autonomous server-side Stockfish requires separately hosted compute; do not claim otherwise.
- Browser Stockfish strength depends on the selected engine and evaluation time; do not infer speed or ELO improvements without measured tests.
- Never put Groq tokens into publicly served frontend JavaScript.
- Keep the Docker app and Render Blueprint as backup options.

## Validation / completion record
- [x] Verified existing Worker, bindings, subdomain and live /health.
- [x] Saved the complete deployed Worker script and the versioned updated Worker in GitHub.
- [x] Pushed and merged UI and engine changes with passing Cloudflare, chess, HTTP end-to-end and Docker tests.
- [x] Deployed on 16 Nov 2026 with the exact AI and ARENA Durable Object namespace bindings unchanged.
- [x] Verified live frontend, engine manifest, and engine execution in a real browser (Stockfish depth 17, evaluation +0.24).
- [x] Verified live rendered navigation controls and matching saved game state; automated UI tests validate the stepping and replay DOM contract. Direct button-click playtest can be supplemented with move deep-link checks.
- [x] Confirmed GitHub frontend updates are served directly by the Worker. Automatic backend code upload remains unconfigured (Cloudflare API was used to deploy safely with bindings).

## Live verification receipt
- URL: https://llm-chess-arena.parris-neathaustralia.workers.dev/
- Analysis opt-in: https://llm-chess-arena.parris-neathaustralia.workers.dev/?analysis=on
- Frontend and GitHub source: Parris-Tech-Services/llm-chess-arena/main/public
- Backend: Cloudflare Worker llm-chess-arena, Durable Object class ArenaRoom, binding ARENA, Workers AI binding AI
- Confirmed /health returned cloudflare-durable-v2 with completed 13-ply game; after redeployment the same game persisted.
- Confirmed in real browser: Stockfish 19 Lite successfully evaluated the existing chess position to depth 17, showed +0.24, and gave d7 → d5. Move history displayed 13/13 with an average 13.4 s per model move, demonstrating the current performance baseline, not a speed improvement claim.
- Stockfish.js source/licence: https://github.com/nmrugg/stockfish.js (GPLv3). Pinned package assets from https://unpkg.com/stockfish@19.0.1/bin/ are fetched only when requested, via same-origin Worker proxy.
- No Render services deleted and no temporary tunnels required.
