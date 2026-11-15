import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Arena } from './game.mjs';
import { StockfishEngine } from './stockfish.mjs';
import { KeyPool } from './keys.mjs';
import { createGroqProvider } from './provider.mjs';
import { listModels } from './groq.mjs';
import { Store } from './storage.mjs';
import { computeStandings } from './rating.mjs';
import { createMockProvider } from '../test/mock-provider.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';

const KEYS_FILE = process.env.KEYS_FILE || path.join(ROOT, 'keys.txt');
const envKeys = (process.env.GROQ_KEYS || '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean);

const store = new Store(DATA);
await store.init();

let keyPool = null;
let mode = 'mock';
try {
  if (envKeys.length) {
    keyPool = new KeyPool(envKeys.map((key, i) => ({ name: `env-${i + 1}`, key })));
    mode = 'groq';
  } else if (fs.existsSync(KEYS_FILE)) {
    keyPool = KeyPool.fromFile(KEYS_FILE);
    mode = 'groq';
  }
} catch (err) {
  console.error('[arena] key pool failed:', err.message);
}
if (mode === 'mock') console.warn('[arena] running in mock mode — no credentials configured');

const mock = createMockProvider();
const provider = keyPool ? createGroqProvider(keyPool) : mock;
const refereeProvider = keyPool ? createGroqProvider(keyPool) : mock;
const engine = new StockfishEngine();
console.log(`[arena] Stockfish ${engine.available ? 'available' : 'unavailable — pure LLM only'}`);

const arena = new Arena({
  provider, refereeProvider, engine, store,
  config: {
    moveBudgetMs: Number(process.env.MOVE_BUDGET_MS || 35_000),
    plyDelayMs: Number(process.env.PLY_DELAY_MS || 700),
    timeControl: {
      baseMs: Number(process.env.CLOCK_BASE_MS || 300_000),
      incrementMs: Number(process.env.CLOCK_INCREMENT_MS || 1000),
    },
  },
});

const interrupted = await store.findInterrupted().catch(() => null);
if (interrupted && interrupted.moves?.length) {
  arena.adopt(interrupted);
  console.log(`[arena] restored interrupted game ${interrupted.id} (${interrupted.moves.length} plies)`);
}

const VERSION = (() => {
  if (process.env.GIT_SHA) return process.env.GIT_SHA;
  try { return execSync('git rev-parse --short HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return 'dev'; }
})();

let catalogue = { models: [], fetchedAt: 0, source: mode };
const MODEL_TTL = 10 * 60_000;

async function getModels(force = false) {
  if (!keyPool) return [{ id: 'mock', active: true }];
  if (!force && Date.now() - catalogue.fetchedAt < MODEL_TTL && catalogue.models.length) return catalogue.models;
  try {
    const key = keyPool.next();
    const models = await listModels(key.key);
    keyPool.report(key, { status: 'ok' });
    catalogue = { models, fetchedAt: Date.now(), source: 'groq' };
  } catch (err) {
    catalogue = { ...catalogue, error: err.message, source: 'error' };
  }
  return catalogue.models;
}

const PLAYABLE = (id) => !/whisper|orpheus|prompt-guard|allam/i.test(id);
await getModels().catch(() => {});

const buckets = new Map();
function rateLimit(ip, { max = 30, windowMs = 60_000 } = {}) {
  const now = Date.now();
  const list = (buckets.get(ip) || []).filter((t) => now - t < windowMs);
  if (list.length >= max) return { ok: false, retryAfter: Math.ceil((windowMs - (now - list[0])) / 1000) };
  list.push(now);
  buckets.set(ip, list);
  if (buckets.size > 5000) buckets.clear();
  return { ok: true };
}

const clientIp = (req) =>
  (req.headers['cf-connecting-ip'] || '').toString().split(',')[0].trim() ||
  (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() ||
  req.socket.remoteAddress || 'unknown';

const clients = new Set();
function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}
arena.on('event', broadcast);

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'SAMEORIGIN',
  'content-security-policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'",
};

function json(res, code, obj) {
  res.writeHead(code, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

async function serveFile(res, file) {
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': path.extname(file) === '.html' ? 'no-store' : 'public, max-age=300',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { ...SECURITY_HEADERS, 'content-type': 'text/plain' });
    res.end('not found');
  }
}

function readBody(req, limit = 16_384) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > limit) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

const VALID_MODEL = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,80}$/;
function pickModel(id, fallback) {
  if (typeof id !== 'string' || !VALID_MODEL.test(id)) return fallback;
  const known = catalogue.models.map((m) => m.id);
  if (known.length && !known.includes(id)) return fallback;
  return id;
}

const server = http.createServer(async (req, res) => {
  const ip = clientIp(req);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  try {
    if (p === '/' || p === '/index.html' || p.startsWith('/g/')) return serveFile(res, path.join(PUBLIC, 'index.html'));
    if (p === '/style.css' || p === '/app.js' || p === '/favicon.svg') return serveFile(res, path.join(PUBLIC, p.slice(1)));

    if (p === '/health') {
      const s = arena.snapshot();
      return json(res, 200, {
        ok: true, version: VERSION, uptimeSec: Math.round(process.uptime()), mode,
        stockfish: { available: engine.available },
        game: { id: s.id, status: s.status, plies: s.moves.length, result: s.result },
        models: catalogue.models.length,
        keys: keyPool ? { total: keyPool.size, available: keyPool.stats().filter((k) => !k.disabled && !k.cooling).length } : null,
      });
    }

    if (p === '/events') {
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 3000\n');
      // Proxies (including Cloudflare tunnels) buffer small responses. A padding
      // comment larger than the usual buffer threshold makes frames flow at once.
      res.write(`: ${' '.repeat(8192)}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'state', state: arena.snapshot() })}\n\n`);
      clients.add(res);
      const beat = setInterval(() => {
        try { res.write(`: keep-alive ${' '.repeat(2048)}\n\n`); } catch { /* closed */ }
      }, 15_000);
      req.on('close', () => { clearInterval(beat); clients.delete(res); });
      return;
    }

    if (p === '/api/state') return json(res, 200, arena.snapshot());

    if (p === '/api/config') {
      const models = await getModels();
      return json(res, 200, {
        mode, version: VERSION,
        stockfish: { available: engine.available, modes: engine.available ? ['pure', 'assisted', 'engine'] : ['pure'] },
        models: models.filter((m) => PLAYABLE(m.id)).map((m) => ({ id: m.id, context: m.context })),
        defaults: {
          white: 'openai/gpt-oss-120b',
          black: 'qwen/qwen3.8-27b',
          referee: 'openai/gpt-oss-20b',
          engineMode: 'pure',
          timeControl: arena.config.timeControl,
          pace: arena.config.plyDelayMs,
        },
        limits: { maxPlies: arena.config.maxPlies, startPerMinute: 6 },
      });
    }

    if (p === '/api/keys') {
      if (!keyPool) return json(res, 200, { mode, total: 0, available: 0, cooling: 0, disabled: 0 });
      const stats = keyPool.stats();
      return json(res, 200, {
        mode,
        total: stats.length,
        available: stats.filter((k) => !k.disabled && !k.cooling).length,
        cooling: stats.filter((k) => k.cooling && !k.disabled).length,
        disabled: stats.filter((k) => k.disabled).length,
      });
    }

    if (p === '/api/games') return json(res, 200, { games: await store.listGames(40) });

    if (p.startsWith('/api/games/')) {
      const game = await store.getGame(p.slice('/api/games/'.length));
      if (!game) return json(res, 404, { error: 'game not found' });
      return json(res, 200, game);
    }

    if (p === '/api/standings') return json(res, 200, computeStandings(store.results));

    if (req.method !== 'POST') return json(res, 404, { error: 'not found' });

    // Separate buckets per action class: starting games is far more expensive
    // than pausing, and must not be starved by other POSTs.
    const kind = p.includes('start') || p.includes('rematch') ? 'start' : 'action';
    const limited = rateLimit(`${ip}:${kind}`, { max: kind === 'start' ? 6 : 20, windowMs: 60_000 });
    if (!limited.ok) {
      res.setHeader('retry-after', String(limited.retryAfter));
      return json(res, 429, { error: 'too many requests', retryAfter: limited.retryAfter });
    }

    if (p === '/api/start' || p === '/api/rematch') {
      if (arena.status === 'playing' || arena.status === 'paused') return json(res, 409, { error: 'a game is already in progress' });
      let body = {};
      if (p === '/api/rematch') {
        const last = arena.players;
        if (!last.w.model || !last.b.model) return json(res, 409, { error: 'no previous game to rematch' });
        body = {
          white: { model: last.b.model, name: last.b.name },
          black: { model: last.w.model, name: last.w.name },
          referee: { model: last.referee.model, name: last.referee.name },
          engineMode: arena.engineMode,
        };
      } else {
        try { body = await readBody(req); } catch (err) { return json(res, err.status || 400, { error: err.message }); }
      }
      const white = { model: pickModel(body.white?.model, 'openai/gpt-oss-120b'), name: body.white?.name };
      const black = { model: pickModel(body.black?.model, 'qwen/qwen3.8-27b'), name: body.black?.name };
      const referee = { model: pickModel(body.referee?.model, 'openai/gpt-oss-20b') };
      const tc = body.timeControl && body.timeControl.baseMs !== undefined
        ? { baseMs: Math.max(0, Math.min(3_600_000, Number(body.timeControl.baseMs) || 0)), incrementMs: Math.max(0, Math.min(30_000, Number(body.timeControl.incrementMs) || 0)) }
        : undefined;
      const pace = body.pace === undefined ? undefined : Number(body.pace);
      try {
        await arena.start({ white, black, referee, timeControl: tc, pace, engineMode: body.engineMode || 'pure' });
      } catch (err) {
        return json(res, 409, { error: err.message });
      }
      return json(res, 202, { id: arena.id, white, black, referee, engineMode: arena.engineMode });
    }

    if (p === '/api/pause') return json(res, 200, { paused: arena.pause() });
    if (p === '/api/resume') return json(res, 200, { resumed: arena.resume() });
    if (p === '/api/stop') { arena.stop(); return json(res, 200, { stopped: true }); }
    if (p === '/api/new') { arena.stop('new game requested'); arena.reset(); arena.emitState(); return json(res, 200, { reset: true }); }
    if (p === '/api/resume-interrupted') return json(res, 200, { resumed: arena.resumeInterrupted() });

    return json(res, 404, { error: 'not found' });
  } catch (err) {
    console.error('[arena] request failed:', err);
    if (!res.headersSent) json(res, 500, { error: 'internal error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[arena] http://${HOST}:${PORT}  mode=${mode}  keys=${keyPool?.size ?? 0}  version=${VERSION}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log(`[arena] ${sig} — saving state`);
    await arena.persist().catch(() => {});
    process.exit(0);
  });
}
