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
      'https://unpkg.com/stockfish@19.0.1/bin/stockfish-19-lite-single.js',
      'https://unpkg.com/stockfish@19.0.1/bin/stockfish-19-lite-single.wasm',
    ]);
  } finally {
    globalThis.fetch = actualFetch;
  }
});

await test('opening-data proxy is fixed-path, safe, and returns ECO TSV', async () => {
  const actualFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (uri) => {
    calls.push(String(uri));
    return new Response('eco\tname\tpgn\nC50\tItalian Game\t1. e4 e5 2. Nf3 Nc6 3. Bc4\n', {status:200});
  };
  try {
    const res = await worker.fetch(request('/data/openings/c.tsv'), {}, {});
    assert.equal(res.status,200);
    assert.match(res.headers.get('content-type'), /tab-separated-values/);
    assert.match(await res.text(), /Italian Game/);
    assert.equal((await worker.fetch(request('/data/openings/z.tsv'), {}, {})).status,404);
    assert.deepEqual(calls, ['https://raw.githubusercontent.com/lichess-org/chess-openings/master/c.tsv']);
  } finally { globalThis.fetch = actualFetch; }
});

await test('Cloudflare AI prompt requests public candidates, not private reasoning', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const script = await fs.readFile(path.join(root,'cloudflare/worker.mjs'),'utf8');
  assert.match(script,/CANDIDATES: <up to 3 plausible legal SAN moves/);
  assert.match(script,/considered:choices/);
  assert.match(script,/private reasoning/);
  assert.match(script,/legalChoices=s\.moves\(\)/);
});

await test('frontend includes play-by-play navigation and engine opt-in', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const html = await fs.readFile(path.join(root, 'public/index.html'), 'utf8');
  const js = await fs.readFile(path.join(root, 'public/app.js'), 'utf8');
  const css = await fs.readFile(path.join(root, 'public/style.css'), 'utf8');
  for (const id of ['moveBackBtn','moveForwardBtn','moveLiveBtn','moveSlider','engineToggle','engineEval','engineBest','engineSpeed','engineCandidates','moveQuality','decisionStatus','decisionTimer','openingName','gamePhase','modelCandidates']) {
    assert.ok(html.includes('id="' + id + '"'), id);
  }
  assert.match(js, /worker\.postMessage\('go movetime 1100'\)/);
  assert.match(js, /MultiPV value 3/);
  assert.match(js, /Possible blunder/);
  assert.match(js, /function openingAt/);
  assert.match(js, /function renderDecision/);
  assert.match(js, /function renderPosition/);
  assert.match(js, /function stopStockfish/);
  assert.match(js, /searchParams.get\('analysis'\) === 'on'/);
  assert.match(js, /searchParams.get\('ply'\)/);
  assert.match(js, /shared.searchParams.set\('ply'/);
  assert.match(js, /REPLAYING/);
  assert.match(css, /\.engine-details\[hidden\]/);
});

console.log((7 - failures) + '/7 Cloudflare adapter tests passed');
process.exitCode = failures ? 1 : 0;
