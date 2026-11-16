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
- [ ] All unit, integration, Cloudflare, Docker tests green.
- [ ] GitHub main contains the code and this record.
- [ ] Live /health and /api/state still preserve game state; binding IDs unchanged.
- [ ] Browser displays named opening, current phase, a clock and three engine lines when analysis is on.
- [ ] Model-reported candidates appear for newly played turns; old recorded games must not invent candidates.
- [ ] Move-quality labels never appear without both engine evaluations.
- [ ] No external credentials or hidden reasoning stored in client.
- [ ] Mobile UI 390 px checked.

## Remaining after this increment
- Lc0/other UCI engines: require verified browser/cloud compute and licensing; plan separate opt-in engine comparison, not an unsupported 'stronger than Stockfish' claim.
- Truly autonomous server-side engine multiPV analysis requires additional cloud compute; browser engine is spectator-local.
- The Cloudflare frontend follows GitHub main; backend still needs deliberate source-upload deployment.
