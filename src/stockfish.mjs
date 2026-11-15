// Minimal UCI adapter for a locally installed, native Stockfish engine.
// No user input is ever interpolated into a shell command.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { Chess } from 'chess.js';

export function locateStockfish() {
  const options = [
    process.env.STOCKFISH_PATH,
    '/usr/games/stockfish',
    '/usr/bin/stockfish',
    '/opt/homebrew/bin/stockfish',
    '/usr/local/bin/stockfish',
    'stockfish',
  ].filter(Boolean);
  for (const binary of options) {
    if (binary.includes('/') && !existsSync(binary)) continue;
    try {
      const result = spawnSync(binary, [], {
        input: 'uci\nquit\n', timeout: 2000, encoding: 'utf8',
        windowsHide: true, maxBuffer: 256 * 1024,
      });
      if (!result.error && /\buciok\b/.test(result.stdout || '')) return binary;
    } catch { /* try next location */ }
  }
  return null;
}

export function uciToSan(chess, token) {
  const m = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(token || '');
  if (!m) return null;
  return chess.moves({ verbose: true }).find((move) =>
    move.from === m[1] && move.to === m[2] && (move.promotion || '') === (m[3] || '')
  )?.san || null;
}

export class StockfishEngine {
  constructor(binary = locateStockfish()) { this.binary = binary; }
  get available() { return !!this.binary; }

  async analyze(fen, { multiPv = 3, moveTimeMs = 160 } = {}) {
    if (!this.available) throw new Error('Stockfish is not installed on this server');
    const chess = new Chess(fen); // fail fast on an invalid FEN
    if (chess.isGameOver()) return { best: null, moves: [] };
    const multipv = Math.max(1, Math.min(3, Math.floor(multiPv)));
    const movetime = Math.max(60, Math.min(2000, Math.floor(moveTimeMs)));

    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      const variants = new Map();
      let buffer = '';
      let settled = false;
      let timer;
      const finish = (error, data) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeAllListeners('error');
        child.removeAllListeners('exit');
        child.stdout?.removeAllListeners('data');
        try { child.stdin.end(); } catch { /* already closed */ }
        if (!child.killed) child.kill();
        if (error) reject(error);
        else resolve(data);
      };
      const send = (command) => { if (!settled && child.stdin.writable) child.stdin.write(command + '\n'); };
      child.on('error', (err) => finish(err));
      child.on('exit', (code) => {
        if (!settled) finish(new Error(`Stockfish exited before its best move (code ${code})`));
      });
      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let index;
        while ((index = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line === 'uciok') {
            send('setoption name MultiPV value ' + multipv);
            send('isready');
          } else if (line === 'readyok') {
            send('position fen ' + fen);
            send('go movetime ' + movetime);
          } else if (line.startsWith('info ') && /\spv\s/.test(line)) {
            const rank = Number(/\bmultipv (\d+)/.exec(line)?.[1] || 1);
            const uci = /\bpv ([a-h][1-8][a-h][1-8][qrbn]?)/.exec(line)?.[1];
            if (!uci || rank > multipv) continue;
            const san = uciToSan(chess, uci);
            if (!san) continue;
            const depth = Number(/\bdepth (\d+)/.exec(line)?.[1] || 0);
            const prev = variants.get(rank);
            if (!prev || depth >= prev.depth) variants.set(rank, {
              rank, uci, san, depth,
              centipawns: Number(/\bscore cp (-?\d+)/.exec(line)?.[1] || 0),
              mate: /\bscore mate (-?\d+)/.exec(line)?.[1] ? Number(/\bscore mate (-?\d+)/.exec(line)[1]) : null,
            });
          } else if (line.startsWith('bestmove ')) {
            const bestUci = /^bestmove ([a-h][1-8][a-h][1-8][qrbn]?)/.exec(line)?.[1];
            const bestSan = uciToSan(chess, bestUci);
            if (!bestSan) return finish(new Error('Stockfish did not provide a legal best move'));
            const alternatives = [...variants.values()].sort((a,b) => a.rank - b.rank)
              .filter((v) => v.san !== bestSan);
            finish(null, {
              best: bestSan,
              moves: [{ san: bestSan, uci: bestUci, rank: 1 }, ...alternatives].slice(0, multipv),
              binary: this.binary,
            });
          }
        }
      });
      timer = setTimeout(() => finish(new Error('Stockfish analysis timed out')), movetime + 4000);
      send('uci');
    });
  }
}
