import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';
import { Arena } from '../src/game.mjs';
import { rankLegalMoves, buildMoveMessages, requestMove } from '../src/bots.mjs';
import { KeyPool } from '../src/keys.mjs';
import { createGroqProvider } from '../src/provider.mjs';
import { Store } from '../src/storage.mjs';
import { computeStandings } from '../src/rating.mjs';
import { createMockProvider } from './mock-provider.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout = 15_000, label = 'condition') {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return true;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function outcome(arena) {
  return new Promise((resolve) => {
    const check = (e) => {
      if (e.type === 'verdict') { arena.off('event', check); resolve(e.verdict); }
      if (e.type === 'state' && e.state.status === 'finished') { arena.off('event', check); resolve(null); }
    };
    arena.on('event', check);
  });
}

/* ------------------------------------------------------------------ tests */

test('full game: every move legal, PGN replays exactly', async () => {
  const provider = createMockProvider();
  const arena = new Arena({ provider, refereeProvider: provider, config: { plyDelayMs: 0, maxPlies: 40, moveBudgetMs: 5000, timeControl: { baseMs: 0, incrementMs: 0 } } });
  const done = outcome(arena);
  await arena.start({ white: { name: 'Mock A', model: 'mock' }, black: { name: 'Mock B', model: 'mock' } });
  await done;
  const snap = arena.snapshot();
  assert.equal(snap.status, 'finished');
  assert.ok(snap.moves.length > 0);
  const replay = new Chess();
  replay.loadPgn(snap.pgn);
  assert.equal(replay.history().length, snap.moves.length, 'PGN has every move');
  assert.equal(arena.fens.length, snap.moves.length + 1, 'FEN history matches plies');
  assert.deepEqual(snap.fens, arena.fens, 'snapshot includes the live move history');
});

test('illegal moves: three strikes then forfeit', async () => {
  const alwaysIllegal = {
    async generate({ onDelta }) {
      const text = 'MOVE: Zz9\nTHINK: I do what I want.';
      onDelta?.(text, text);
      return { text, tokens: 10 };
    },
  };
  const arena = new Arena({ provider: alwaysIllegal, refereeProvider: alwaysIllegal, config: { plyDelayMs: 0, maxAttempts: 3, timeControl: { baseMs: 0, incrementMs: 0 } } });
  const done = outcome(arena);
  await arena.start({ white: { name: 'Cheater', model: 'bad' }, black: { name: 'Honest', model: 'ok' } });
  await done;
  const snap = arena.snapshot();
  assert.equal(snap.result, 'b-wins');
  assert.match(snap.reason, /illegal/);
  assert.equal(snap.rejections.length, 3);
});

test('formatting failure: arena forces a legal move, then continues', async () => {
  let n = 0;
  const flaky = {
    async generate({ onDelta }) {
      n += 1;
      const text = n === 1 ? 'MOVE: Zz9\nTHINK: oops.' : 'MOVE: e4\nTHINK: fine.';
      onDelta?.(text, text);
      return { text, tokens: 10 };
    },
  };
  const arena = new Arena({ provider: flaky, refereeProvider: flaky, config: { plyDelayMs: 0, maxAttempts: 3, maxPlies: 2, timeControl: { baseMs: 0, incrementMs: 0 } } });
  const done = outcome(arena);
  await arena.start({ white: { name: 'Flaky', model: 'x' }, black: { name: 'Other', model: 'y' } });
  await done;
  const snap = arena.snapshot();
  assert.equal(snap.moves[0].san, 'e4');
  assert.equal(snap.moves[0].attempts, 2);
});

test('pause freezes play, resume continues', async () => {
  const provider = createMockProvider();
  const arena = new Arena({ provider, refereeProvider: provider, config: { plyDelayMs: 0, maxPlies: 60, timeControl: { baseMs: 0, incrementMs: 0 } } });
  await arena.start({ white: { name: 'A', model: 'a' }, black: { name: 'B', model: 'b' } });
  await waitFor(() => arena.moves.length >= 2, 10_000, 'two plies');
  arena.pause();
  await sleep(250);
  const frozen = arena.moves.length;
  await sleep(500);
  assert.equal(arena.moves.length, frozen, 'no moves while paused');
  assert.equal(arena.snapshot().status, 'paused');
  arena.resume();
  await waitFor(() => arena.moves.length > frozen, 10_000, 'play to resume');
  arena.stop();
});

test('untimed game is not instantly lost on time', async () => {
  const provider = createMockProvider();
  const arena = new Arena({ provider, refereeProvider: provider, config: { plyDelayMs: 0, maxPlies: 4, timeControl: { baseMs: 0, incrementMs: 0 } } });
  const done = outcome(arena);
  await arena.start({ white: { name: 'A', model: 'a' }, black: { name: 'B', model: 'b' } });
  await done;
  const snap = arena.snapshot();
  assert.notEqual(snap.result, 'b-wins');
  assert.ok(snap.moves.length >= 4);
});

test('clock: a side that runs out loses on time', async () => {
  const slow = {
    async generate({ onDelta }) {
      await new Promise((r) => setTimeout(r, 120));
      const text = 'MOVE: e4\nTHINK: slow.';
      onDelta?.(text, text);
      return { text, tokens: 5 };
    },
  };
  // 100ms bank per side, 120ms per move => White flags on move one.
  const arena = new Arena({ provider: slow, refereeProvider: slow, config: { plyDelayMs: 0, maxPlies: 10, moveBudgetMs: 5000, timeControl: { baseMs: 100, incrementMs: 0 } } });
  const done = outcome(arena);
  await arena.start({ white: { name: 'Slow', model: 's' }, black: { name: 'Other', model: 'o' } });
  await done;
  const snap = arena.snapshot();
  assert.equal(snap.result, 'b-wins');
  assert.match(snap.reason, /time out/);
});

test('standings: Elo moves in the right direction from real results', () => {
  const results = [
    { gameId: 'g1', white: 'A', black: 'B', result: 'w', endedAt: 1, moves: { w: 10, b: 10 }, rejections: { w: 0, b: 1 }, latency: { w: 900, b: 800 } },
    { gameId: 'g2', white: 'B', black: 'A', result: 'b', endedAt: 2, moves: { w: 9, b: 9 }, rejections: { w: 0, b: 0 }, latency: { w: 800, b: 700 } },
    { gameId: 'g3', white: 'A', black: 'B', result: 'draw', endedAt: 3, moves: { w: 30, b: 30 }, rejections: { w: 2, b: 0 }, latency: { w: 1000, b: 1100 } },
  ];
  const s = computeStandings(results);
  const a = s.rows.find((r) => r.model === 'A');
  const b = s.rows.find((r) => r.model === 'B');
  assert.equal(s.totalGames, 3);
  assert.ok(a.rating > 1200, 'winner above base');
  assert.ok(b.rating < 1200, 'loser below base');
  assert.equal(a.games, 3);
  assert.equal(a.wins, 2);
  assert.equal(a.draws, 1);
  assert.equal(b.losses, 2);
  assert.ok(a.legalMoveRate < 100, 'rejections reduce legal move rate');
  assert.equal(a.avgLatencyMs, 867);
});

test('storage: save, list, load, results and interrupted recovery', async () => {
  const dir = await fs.mkdtemp(path.join(ROOT, '.test-store-'));
  try {
    const store = new Store(dir);
    await store.init();
    const record = {
      id: 'abcd1234', status: 'playing', result: null, reason: null,
      players: { w: { name: 'W', model: 'm1' }, b: { name: 'B', model: 'm2' } },
      moves: [{ n: 1, san: 'e4', side: 'w', from: 'e2', to: 'e4' }],
      pgn: '1. e4 *', fen: 'x', clocks: { w: 1000, b: 1000 },
    };
    await store.saveGame(record);
    assert.equal((await store.getGame('abcd1234')).id, 'abcd1234');
    assert.equal((await store.listGames()).length, 1);
    const found = await store.findInterrupted();
    assert.equal(found.id, 'abcd1234');
    await store.upsertResult({ gameId: 'abcd1234', white: 'm1', black: 'm2', result: 'w', endedAt: 1 });
    await store.upsertResult({ gameId: 'abcd1234', white: 'm1', black: 'm2', result: 'w', endedAt: 1 });
    assert.equal(store.results.length, 1, 'upsert is idempotent');
    assert.equal(await store.getGame('../etc/passwd'), null, 'path traversal rejected');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('interrupted game is restored paused and resumable', async () => {
  const provider = createMockProvider();
  const arena = new Arena({ provider, refereeProvider: provider, config: { plyDelayMs: 0, timeControl: { baseMs: 0, incrementMs: 0 } } });
  const provider2 = createMockProvider();
  const source = new Arena({ provider: provider2, refereeProvider: provider2, config: { plyDelayMs: 0, maxPlies: 40, timeControl: { baseMs: 0, incrementMs: 0 } } });
  await source.start({ white: { name: 'A', model: 'a' }, black: { name: 'B', model: 'b' } });
  await waitFor(() => source.moves.length >= 4, 10_000, 'plies');
  source.stop();
  const rec = { ...source.record(), status: 'playing' };
  arena.adopt(rec);
  const snap = arena.snapshot();
  assert.equal(snap.status, 'paused');
  assert.equal(snap.interrupted, true);
  assert.equal(snap.moves.length, rec.moves.length);
  assert.equal(snap.fen, rec.fen, 'board restored to the saved position');
  assert.equal(arena.resumeInterrupted(), true);
  await waitFor(() => arena.moves.length > rec.moves.length, 10_000, 'game to continue');
  arena.stop();
});

test('key pool rotates away from rate-limited keys', async () => {
  const pool = new KeyPool([{ name: 'a', key: 'k1' }, { name: 'b', key: 'k2' }, { name: 'c', key: 'k3' }]);
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const key = init.headers.authorization.replace('Bearer ', '');
    seen.push(key);
    if (key === 'k1') return new Response('{"error":"rate"}', { status: 429, headers: { 'retry-after': '30' } });
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    return new Response(body, { status: 200 });
  };
  try {
    const provider = createGroqProvider(pool);
    const res = await provider.generate({ model: 'm', messages: [{ role: 'user', content: 'hi' }], signal: new AbortController().signal });
    assert.equal(res.text, 'hello');
    assert.ok(seen.includes('k1'));
    assert.ok(seen.filter((k) => k !== 'k1').length >= 1);
    assert.equal(pool.stats().find((s) => s.name === 'a').cooling, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('oversized max_tokens is shrunk and retried, not fatal', async () => {
  const pool = new KeyPool([{ name: 'a', key: 'k1' }, { name: 'b', key: 'k2' }]);
  const budgets = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    budgets.push(body.max_tokens);
    if (body.max_tokens > 500) {
      return new Response(
        JSON.stringify({ error: { message: 'Request too large for model on output tokens per minute (OTPM): Limit 1000, Requested ' + body.max_tokens } }),
        { status: 429 },
      );
    }
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    return new Response(stream, { status: 200 });
  };
  try {
    const provider = createGroqProvider(pool);
    const res = await provider.generate({ model: 'm', messages: [], maxTokens: 1024, signal: new AbortController().signal });
    assert.equal(res.text, 'ok');
    assert.deepEqual(budgets, [1024, 512, 256], 'halves until the provider accepts');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('tactical shortlist prefers a forced mate-in-one', () => {
  const chess = new Chess('r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 4 4');
  const ranked = rankLegalMoves(chess);
  assert.equal(ranked[0].move.san, 'Qxf7#');
  assert.equal(ranked.length, chess.moves().length);
  assert.match(buildMoveMessages({ chess, side: 'w', name: 'W', opponent: 'B' })[1].content, /TACTICAL CANDIDATES/);
});

test('per-turn timeout is shared across retries', async () => {
  const slow = async ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  });
  const started = Date.now();
  const res = await requestMove({ generate: slow, chess: new Chess(), side: 'w', name: 'W', opponent: 'B', budgetMs: 80, maxAttempts: 3 });
  assert.ok(Date.now() - started < 250, 'only one total timeout instead of three');
  assert.equal(res.forfeit, true);
});

/* -------------------------------------------------------------------- runner */
let failed = 0;
for (const { name, fn } of tests) {
  process.stdout.write(`• ${name}\n`);
  try {
    await fn();
    process.stdout.write('  pass\n');
  } catch (err) {
    failed += 1;
    process.stdout.write(`  FAIL: ${err.message}\n`);
  }
}
process.stdout.write(`\n${tests.length - failed}/${tests.length} passed\n`);
process.exit(failed ? 1 : 0);
