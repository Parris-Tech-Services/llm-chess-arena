// No Cloudflare credentials required: validate live Worker adapter without external calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import worker, { ArenaRoom } from '../cloudflare/worker.mjs';

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('PASS ' + name);
  } catch (e) {
    console.error('FAIL ' + name + ': ' + e.stack);
    failures++;
  }
}
const request = (p) => new Request('https://llm-chess-arena.example.test' + p);

await test('preserves Durable Object class and autonomous controller', async () => {
  assert.equal(typeof ArenaRoom, 'function');
  assert.equal(typeof ArenaRoom.prototype.alarm, 'function');
  assert.equal(typeof worker.fetch, 'function');
});

await test('engine manifest distinguishes browser analysis from server AI', async () => {
  const res = await worker.fetch(request('/engine/manifest'), {}, {});
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.available, true);
  assert.equal(json.runs, 'browser');
  assert.equal(json.influencesLiveModelMoves, false);
  assert.match(json.engine, /Stockfish/);
});

await test('engine endpoint refuses unlisted files (no generic network proxy)', async () => {
  assert.equal((await worker.fetch(request('/engine/../../private.txt'), {}, {})).status, 404);
  assert.equal((await worker.fetch(request('/engine/secret.key'), {}, {})).status, 404);
});

await test('engine static proxy has correct JS and WASM types', async () => {
  const actualFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url.toString());
    return new Response(new Uint8Array([0, 97, 115, 109]), {status: 200});
  };
  try {
    for (const [file, mime] of [
      ['stockfish-19-lite-single.js','application/javascript'],
      ['stockfish-19-lite-single.wasm','application/wasm'],
    ]) {
      const res = await worker.fetch(request('/engine/' + file), {}, {});
      assert.equal(res.status, 200);
      assert.ok(res.headers.get('content-type').startsWith(mime));
      assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      await res.arrayBuffer();
    }
    assert.deepEqual(calls, [
      'https://cdn.jsdelivr.net/npm/stockfish@19.0.1/bin/stockfish-19-lite-single.js',
      'https://cdn.jsdelivr.net/npm/stockfish@19.0.1/bin/stockfish-19-lite-single.wasm',
    ]);
  } finally {
    globalThis.fetch = actualFetch;
  }
});

await test('frontend includes play-by-play navigation and engine opt-in', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const html = await fs.readFile(path.join(root, 'public/index.html'), 'utf8');
  const js = await fs.readFile(path.join(root, 'public/app.js'), 'utf8');
  for (const id of ['moveBackBtn','moveForwardBtn','moveLiveBtn','moveSlider','engineToggle','engineEval','engineBest','engineSpeed']) {
    assert.ok(html.includes('id="' + id + '"'), id);
  }
  assert.match(js, /worker\.postMessage\('go movetime 500'\)/);
  assert.match(js, /function renderPosition/);
  assert.match(js, /function stopStockfish/);
  assert.match(js, /searchParams.get\('analysis'\) === 'on'/);
});

console.log((5 - failures) + '/5 Cloudflare adapter tests passed');
process.exitCode = failures ? 1 : 0;
