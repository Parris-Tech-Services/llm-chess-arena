import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Arena } from '../src/game.mjs';
import { KeyPool } from '../src/keys.mjs';
import { createGroqProvider } from '../src/provider.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const keysFile = process.env.KEYS_FILE || path.join(ROOT, 'keys.txt');
if (!fs.existsSync(keysFile)) {
  console.error('no keys.txt — cannot run live smoke test');
  process.exit(1);
}

const pool = KeyPool.fromFile(keysFile);
const provider = createGroqProvider(pool);
const whiteModel = process.env.WHITE_MODEL || 'openai/gpt-oss-120b';
const blackModel = process.env.BLACK_MODEL || 'qwen/qwen3.8-27b';
const refereeModel = process.env.REFEREE_MODEL || 'openai/gpt-oss-20b';
const plies = Number(process.env.PLIES || 6);
const budget = Number(process.env.MOVE_BUDGET_MS || 60_000);

const referee = {
  generate: (opts) => provider.generate({ ...opts, model: refereeModel }),
};

const arena = new Arena({
  provider,
  refereeProvider: referee,
  config: { moveBudgetMs: budget, maxAttempts: 2, maxPlies: plies, plyDelayMs: 0, refereeEveryMove: true },
});

arena.on('event', (e) => {
  if (e.type === 'move') {
    const m = e.move;
    console.log(`${String(m.n).padStart(3)}. ${m.side === 'w' ? 'W' : 'B'} ${m.san.padEnd(6)} ${m.attempts > 1 ? `(${m.attempts} tries) ` : ''}${m.think}`);
  }
  if (e.type === 'referee') console.log(`     referee ${e.entry.moveNumber}: ${e.entry.text}`);
  if (e.type === 'log' && e.level === 'warn') console.log(`     ! ${e.text}`);
});

const started = Date.now();
const done = new Promise((resolve) => {
  arena.on('event', (e) => {
    if (e.type === 'verdict') resolve(e.verdict);
    if (e.type === 'state' && e.state.status === 'finished' && e.state.result === 'aborted') resolve(null);
  });
});

await arena.start({
  white: { name: 'GPT-OSS 120B', model: whiteModel },
  black: { name: 'Qwen3 27B', model: blackModel },
});

const verdict = await done;
const snap = arena.snapshot();
console.log('\n--- result -------------------------------------------------');
console.log(`status:  ${snap.status}`);
console.log(`result:  ${snap.result} (${snap.reason})`);
console.log(`plies:   ${snap.moves.length}`);
console.log(`elapsed: ${((Date.now() - started) / 1000).toFixed(1)}s`);
if (verdict) console.log(`referee: ${verdict.verdict} / ${verdict.conduct} — ${verdict.note}`);
console.log(`rejected attempts: ${snap.rejections.length} (cheating vs formatting logged separately)`);
console.log('\nkey pool:');
for (const k of pool.stats()) {
  console.log(`  ${k.name}  req=${k.requests} err=${k.errors}${k.cooling ? ' cooling' : ''}${k.disabled ? ' DISABLED' : ''}`);
}
console.log(`\nPGN:\n${snap.pgn}`);
process.exit(0);
