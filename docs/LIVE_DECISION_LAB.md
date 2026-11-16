# Live Chess Decision Lab — implementation and acceptance (16 November 2026)

## Goal
Give mobile spectators a transparent, real-time view of **what the models publicly say about their move**, independent engine candidates/continuations, named opening/phase, and rough move-quality alerts. Preserve the Cloudflare Durable Object backend, saved games and live navigation. Avoid exposing or fabricating hidden reasoning.

## Evidence and choices
- Cloudflare Worker `llm-chess-arena` already hosts autonomous Workers AI turns with `ARENA` Durable Object; client currently reports turn / timer / playing side and only one local Stockfish PV.
- Prompt currently requests `MOVE:` and a short `THINK:` explanation; private internal reasoning is unavailable. Ask models for **CANDIDATES:** as a short *public* list of legal alternatives, plus a short `THINK:` broadcast explanation. Display these as **model-reported**, never as an internal trace.
- Local Stockfish 19 Lite will run MultiPV=3 in a mobile web worker; report ranked candidates, White-perspective score and depth, principal variations. Engine thinking info is **engine output**, not LLM chain-of-thought.
- The [Lichess chess-openings dataset](https://github.com/lichess-org/chess-openings), CC0, provides ECO, name, PGN. Classify longest known SAN prefix; if moves transpose unusually or leave theory, retain last known family and mark the phase separately. Fetch dataset lazily using a fixed, cached same-origin Cloudflare proxy; no arbitrary URL proxying.
- Move-quality loss is approximate **White-normalised centipawn eval before vs after** the actual move; only label moves when both positions were evaluated and the depth is meaningful. Avoid a verdict from a single unfinished search.
- Stockfish 19 remains among the strongest chess engines on CCRL lists, while Leela Chess Zero, Reckless and PlentyChess provide alternative perspectives; none has been demonstrated universally stronger. Browser-only Lc0 GPU acceleration is not included until a verified deployable build and model weights exist.

## Delivery
1. Save this design with explicit acceptance.
2. Add the new mobile decision panel, timer and publicly reported candidates.
3. Add Stockfish MultiPV (three ranked lines + scores) and move-quality comparison with uncertainty label.
4. Add named opening + middlegame/endgame phase using Lichess public data.
5. Keep API/Worker bindings and persistence unchanged; add regression tests.
6. Merge CI-green PR, deploy versioned Worker to Cloudflare, verify actual HTTPS/mobile/browser outcomes and record limitations.

## Completion gates
- [x] All unit, integration, Cloudflare, Docker tests green (GitHub Actions run 43792611195).
- [x] GitHub main contains the code and this record (PRs #8, #9, #10 merged).
- [x] Live /health and browser /api/state respond; active AI/ARENA bindings and same Durable Object namespace were verified after deployment.
- [x] Browser displays named opening (Italian Game: Two Knights Defense, Knight Attack, C57), phase, decision timer and 3 engine lines on a 390 px viewport.
- [x] Complete simulated Durable Object + Workers AI turn verified legal public candidates persisted and illegal candidates removed; older games explicitly show 'Not recorded'. **Real new-turn provider output hasn't been observed live yet.**
- [x] Move-quality display requires cached pre- and post-move evaluations at depth >= 9; live browser showed the estimated result after both analyses.
- [x] Public UI uses public explanations and engine outputs only, no credentials or private model reasoning added to frontend.
- [x] Browser Rendering on a 390 px mobile viewport checked; controls and engine analysis rendered.

## Remaining after this increment
- **Delivered external comparison**: each viewed FEN links to 0x88.app's verified browser-based Lc0, Stockfish, Berserk, Reckless, PlentyChess and other engine comparison. The external tool runs its own engines; this Chess Arena does not claim they run inside its Worker or that any is universally stronger than Stockfish. Additional engines embedded in our own site still require verified browser/cloud compute and licensing.
- Truly autonomous server-side engine multiPV analysis requires additional cloud compute; browser engine is spectator-local.
- The Cloudflare frontend follows GitHub main; backend still needs deliberate source-upload deployment.

## Deployment verification receipt — 16 November 2026

- GitHub source / PRs: https://github.com/Parris-Tech-Services/llm-chess-arena/pulls?q=is%3Apr+is%3Amerged
- CI: https://github.com/Parris-Tech-Services/llm-chess-arena/actions/runs/43792611195
- Live site: https://llm-chess-arena.parris-neathaustralia.workers.dev/?analysis=on
- Cloudflare Worker deployment: `682fb57e07a14dfd89e387dee3537268`. Same original `ARENA` Durable Object namespace `a0536b93df99444c826be12a671c9cbb`; `AI` binding remains attached.
- Health recheck: `ok: true`, `cloudflare-durable-v2`, `cloudflare-ai`, existing completed game retained, phone not needed.
- Live mobile analysis: ECO C57 and three Stockfish lines, depth 19; example reviewed game at ply 6 identified Italian Game: Giuoco Piano and the comparative engine deep link contained the exact FEN of move six.
- Multi-engine: the Compare action opens `https://0x88.app/app/analysis/?fen=<encoded FEN>` in a new tab. Browser-rendered link was checked and targeted the currently reviewed FEN. 0x88 supports Lc0, Berserk, Reckless and more, but those run in that **external** app.
- Candidate reporting: verified with a fully executed local Durable Object alarm using a mocked Workers AI response; no claim yet of actual new production model responses.
- Rough move-quality evals and opening-family labels are aids, not certified accuracy scores or guaranteed classifications across transpositions.
