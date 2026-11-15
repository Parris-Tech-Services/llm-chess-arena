/**
 * End-to-end HTTP test: boots the real server in mock mode on a throwaway port
 * and exercises the public surface the way a browser would.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = await fs.mkdtemp(path.join(os.tmpdir(), 'arena-e2e-'));

const server = spawn(process.execPath, ['src/server.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), KEYS_FILE: '/nonexistent-keys', DATA_DIR: DATA, PLY_DELAY_MS: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout = 20_000, label = 'condition') {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (await fn()) return; } catch { /* retry */ }
    await sleep(80);
  }
  throw new Error(`timeout: ${label}\n${serverLog}`);
}
const get = async (p) => {
  const r = await fetch(BASE + p);
  return { status: r.status, text: await r.text(), headers: r.headers };
};
const post = async (p, body) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

const tests = [];
const test = (n, f) => tests.push({ n, f });

test('static assets and security headers', async () => {
  const page = await get('/');
  assert.equal(page.status, 200);
  assert.match(page.text, /<title>LLM Chess Arena/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.match(page.headers.get('content-security-policy') || '', /script-src 'self'/);
  for (const asset of ['/style.css', '/app.js', '/favicon.svg']) {
    assert.equal((await get(asset)).status, 200, asset);
  }
  assert.equal((await get('/../keys.txt')).status, 404);
});

test('health and config never leak secrets', async () => {
  const health = await get('/health');
  assert.equal(health.status, 200);
  const h = JSON.parse(health.text);
  assert.equal(h.ok, true);
  assert.ok(!/gsk_/.test(health.text), 'no key material in health');

  const cfg = JSON.parse((await get('/api/config')).text);
  assert.ok(Array.isArray(cfg.models));
  assert.equal(cfg.mode, 'mock');

  const keys = await get('/api/keys');
  assert.ok(!/gsk_/.test(keys.text), 'no key material in /api/keys');
});

test('a game runs, streams, pauses, resumes and stops', async () => {
  const start = await post('/api/start', {
    white: { model: 'mock', name: 'Mock A' },
    black: { model: 'mock', name: 'Mock B' },
    referee: { model: 'mock' },
    timeControl: { baseMs: 0, incrementMs: 0 },
    pace: 0,
  });
  assert.ok([202, 200].includes(start.status), `start ${start.status}`);

  // A second start while playing must be rejected.
  const conflict = await post('/api/start', { white: { model: 'mock' }, black: { model: 'mock' } });
  assert.equal(conflict.status, 409);

  // SSE delivers at least one event to a fresh spectator.
  const ac = new AbortController();
  const sse = await fetch(`${BASE}/events`, { signal: ac.signal });
  const reader = sse.body.getReader();
  const decoder = new TextDecoder();
  let streamed = '';
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && !/data: \{/.test(streamed)) {
    const r = await Promise.race([reader.read(), sleep(1000).then(() => ({ done: true }))]);
    if (r.done) break;
    streamed += decoder.decode(r.value, { stream: true });
  }
  ac.abort();
  assert.match(streamed, /data: \{/, 'SSE frame received');

  await waitFor(async () => JSON.parse((await get('/api/state')).text).moves.length >= 2, 20_000, 'two plies');

  const paused = await post('/api/pause');
  assert.equal(paused.json.paused, true);
  await sleep(400);
  const pausedState = JSON.parse((await get('/api/state')).text);
  assert.equal(pausedState.status, 'paused');
  const frozen = pausedState.moves.length;
  await sleep(500);
  assert.equal(JSON.parse((await get('/api/state')).text).moves.length, frozen, 'no progress while paused');

  assert.equal((await post('/api/resume')).json.resumed, true);
  await waitFor(async () => JSON.parse((await get('/api/state')).text).moves.length > frozen, 15_000, 'resume');
  assert.equal((await post('/api/stop')).status, 200);
});

test('completed games, standings, replay and PGN', async () => {
  const started = await post('/api/start', {
    white: { name: 'Mock A' },
    black: { name: 'Mock B' },
    referee: { model: 'mock' },
    timeControl: { baseMs: 0, incrementMs: 0 },
    pace: 0,
  });
  assert.ok([200, 202].includes(started.status), `restart accepted, got ${started.status} ${JSON.stringify(started.json)}`);
  try {
    await waitFor(async () => {
      const s = JSON.parse((await get('/api/state')).text);
      return s.status === 'finished' && s.result !== 'aborted';
    }, 90_000, 'finished game');
  } catch (err) {
    const s = JSON.parse((await get('/api/state')).text);
    throw new Error(`${err.message} | status=${s.status} result=${s.result} plies=${s.moves.length} rejections=${s.rejections.length}`);
  }

  const state = JSON.parse((await get('/api/state')).text);
  assert.ok(state.moves.length > 5, 'game has moves');

  const games = JSON.parse((await get('/api/games')).text).games;
  assert.ok(games.length >= 1);
  const id = games[0].id;

  const replayPage = await get(`/g/${id}`);
  assert.equal(replayPage.status, 200, 'share URL serves the app');

  const game = JSON.parse((await get(`/api/games/${id}`)).text);
  assert.ok(game.pgn.includes('1.'), 'PGN present');
  assert.equal(game.fens.length, game.moves.length + 1, 'FEN per ply for scrubbing');
  assert.ok(!('raw' in (game.moves[0] || {})), 'no raw model output persisted');
  assert.equal((await get('/api/games/deadbeef')).status, 404);

  const standings = JSON.parse((await get('/api/standings')).text);
  assert.equal(standings.totalGames, 1);
  assert.ok(standings.rows.length >= 1);
  // Elo is conserved across a game (a draw leaves both at base).
  const total = standings.rows.reduce((n, r) => n + r.rating, 0);
  assert.ok(Math.abs(total - 1200 * standings.rows.length) < 2, `ratings conserve: ${total}`);
});

test('input validation and rate limits', async () => {
  const bad = await post('/api/start', { white: { model: 'not-a-real-model!!' }, black: { model: 'x' } });
  assert.ok([202, 409].includes(bad.status));
  assert.equal((await post('/api/nonsense')).status, 404);
  // Burst past the per-IP POST budget and expect a 429.
  let saw429 = false;
  for (let i = 0; i < 30; i++) {
    const r = await post('/api/pause');
    if (r.status === 429) { saw429 = true; break; }
  }
  assert.ok(saw429, 'rate limiter engages');
});

let failed = 0;
try {
  await waitFor(async () => (await get('/health')).status === 200, 20_000, 'server boot');
  for (const { n, f } of tests) {
    process.stdout.write(`• ${n}\n`);
    try { await f(); process.stdout.write('  pass\n'); }
    catch (err) { failed += 1; process.stdout.write(`  FAIL: ${err.message}\n`); }
  }
} finally {
  server.kill('SIGKILL');
  await fs.rm(DATA, { recursive: true, force: true });
}
process.stdout.write(`\n${tests.length - failed}/${tests.length} passed\n`);
process.exit(failed ? 1 : 0);
