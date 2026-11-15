import { Chess } from 'chess.js';

const PIECES = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚', P: '♙', N: '♘', B: '♗', R: '♖', Q: '♕', K: '♔' };

export function asciiBoard(chess) {
  const rows = chess.board();
  const out = ['  +------------------------+'];
  rows.forEach((row, r) => {
    let line = `${8 - r} |`;
    row.forEach((sq) => { line += sq ? ` ${PIECES[sq.color === 'w' ? sq.type.toUpperCase() : sq.type]} ` : ' . '; });
    out.push(line + '|');
  });
  out.push('  +------------------------+');
  out.push('    a  b  c  d  e  f  g  h');
  return out.join('\n');
}

function historyLine(chess, max = 12) {
  const hist = chess.history();
  const tail = hist.slice(-max);
  const start = hist.length - tail.length;
  const parts = [];
  for (let i = 0; i < tail.length; i++) {
    const ply = start + i;
    if (ply % 2 === 0) parts.push(`${ply / 2 + 1}. ${tail[i]}`);
    else parts.push(tail[i]);
  }
  return parts.join(' ');
}

// One-ply safety heuristic, NOT a chess engine. Never overrides legal model moves.
const VALUES = { p: 1, n: 3, b: 3.2, r: 5, q: 9, k: 0 };
export function rankLegalMoves(chess) {
  const fen = chess.fen();
  const opening = chess.history().length < 12;
  return chess.moves({ verbose: true }).map((move) => {
    const probe = new Chess(fen);
    probe.move({ from: move.from, to: move.to, ...(move.promotion ? { promotion: move.promotion } : {}) });
    if (probe.isCheckmate()) return { move, score: 10000 };
    const captures = probe.moves({ verbose: true })
      .filter((m) => m.captured)
      .map((m) => (VALUES[m.captured] || 0) * (m.to === move.to ? 1 : 0.75));
    const exposure = captures.length ? Math.max(...captures) : 0;
    let score = (VALUES[move.captured] || 0) * 7 - exposure * 6;
    if (move.promotion) score += (VALUES[move.promotion] || 0) * 6;
    if (probe.inCheck()) score += 1.2;
    if (move.flags.includes('k') || move.flags.includes('q')) score += 2;
    if (opening && (move.piece === 'n' || move.piece === 'b')) score += 0.5;
    if (['d4', 'e4', 'd5', 'e5'].includes(move.to)) score += 0.8;
    if (opening && move.piece === 'q') score -= 1.5;
    return { move, score };
  }).sort((a, b) => b.score - a.score || a.move.san.localeCompare(b.move.san));
}

export function buildMoveMessages({ chess, side, name, opponent, note, stockfishMoves = [] }) {
  const legal = chess.moves({ verbose: true });
  const legalSan = legal.map((m) => m.san).join(', ');
  const candidates = rankLegalMoves(chess).slice(0, 5).map(({ move }) => move.san).join(', ');

  const system = [
    `You are ${name}, a chess-playing AI. You are playing ${side === 'w' ? 'White' : 'Black'} against ${opponent}.`,
    'Play sound competitive chess, not random or theatrical chess.',
    'Before choosing, check immediate mate threats, forcing checks/captures, hanging pieces, and opponent recaptures.',
    'Prefer safe development, centre control, and king safety; avoid speculative early queen sorties.',
    stockfishMoves.length ? 'Stockfish has searched this position. Choose ONLY one of the STOCKFISH SHORTLIST moves below.' : 'Tactical candidates are a shallow heuristic, not an engine verdict. Any legal move is allowed.',
    '',
    'Reply in exactly two short lines, with MOVE FIRST:',
    'MOVE: <one legal SAN move copied exactly from the list>',
    'THINK: <a public explanation of at most 12 words>',
    'Never invent a move or output analysis before MOVE.',
  ].join('\n');

  const user = [
    `Position (FEN): ${chess.fen()}`,
    `Move number: ${Math.floor(chess.history().length / 2) + 1}`,
    `Side to move: ${side === 'w' ? 'White' : 'Black'}`,
    '',
    asciiBoard(chess),
    '',
    `Move history: ${historyLine(chess) || '(none)'}`,
    '',
    `LEGAL MOVES (SAN): ${legalSan}`,
    ...(stockfishMoves.length ? [`STOCKFISH SHORTLIST (best first): ${stockfishMoves.join(', ')}`] : [`TACTICAL CANDIDATES (approximate): ${candidates}`]),
    '',
    note ? `REFEREE NOTE (non-binding): ${note.slice(0, 100)}` : '',
    'Give MOVE first (spectators watch the board update live), then THINK.',
    'Reply with the two lines only.',
  ].filter(Boolean).join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

export function extractMoveToken(text) {
  const m = text.match(/^\s*MOVE:\s*([^\s,;]+)/im);
  if (m) return m[1].replace(/[.!]+$/, '').trim();
  const bare = text.match(/^\s*([KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?|O-O(?:-O)?)\s*$/m);
  return bare ? bare[1] : null;
}

export function extractThink(text) {
  const m = text.match(/THINK:\s*([\s\S]*)/i);
  return (m ? m[1] : text).replace(/\s+/g, ' ').trim().slice(0, 400);
}

function tryApply(chess, token) {
  if (!token) return null;
  for (const t of [token, token.toLowerCase()]) {
    try {
      const mv = chess.move(t, { strict: false });
      if (mv) return mv;
    } catch { /* next form */ }
  }
  const coord = token.match(/^([a-h][1-8])([a-h][1-8])([qrbn])?$/i);
  if (coord) {
    try {
      const mv = chess.move({ from: coord[1].toLowerCase(), to: coord[2].toLowerCase(), promotion: (coord[3] || 'q').toLowerCase() });
      if (mv) return mv;
    } catch { /* fall through */ }
  }
  return null;
}

/**
 * Ask a bot for a move. Retries on illegal output, feeding the error back.
 * The board is only mutated by a validated move — never by model text.
 */
export async function requestMove({
  generate, chess, side, name, opponent,
  budgetMs = 30_000, maxAttempts = 3, maxTokens = 480, reasoningEffort = 'low',
  onDelta, onAttempt, refereeNote, stockfishMoves = [],
}) {
  const illegal = [];
  let lastText = '';
  let sawIllegalMove = false;
  let attemptsMade = 0;
  // A single deadline covers ALL retries, rather than giving each 30+ seconds.
  const deadline = Date.now() + budgetMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    attemptsMade = attempt;
    const messages = buildMoveMessages({ chess, side, name, opponent, note: refereeNote, stockfishMoves });
    if (attempt > 1) {
      messages.push({ role: 'assistant', content: lastText || 'MOVE: (none)' });
      messages.push({
        role: 'user',
        content:
          `That move was rejected by the referee: "${illegal.at(-1)}". ` +
          `You may ONLY play one of these moves: ${(stockfishMoves.length ? stockfishMoves : chess.moves()).join(', ')}. ` +
          'Reply again with MOVE: and THINK: only.',
      });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('move timeout')), remainingMs);
    let text = '';
    try {
      const res = await generate({
        messages,
        signal: controller.signal,
        maxTokens,
        reasoningEffort,
        onDelta: (d, full) => { text = full; onDelta?.(d, full, attempt); },
      });
      text = res.text || text;
      lastText = text;
    } catch (err) {
      if (err.name === 'AbortError' || controller.signal.aborted) illegal.push('no response before the clock ran out');
      else throw err;
    } finally {
      clearTimeout(timer);
    }

    const token = extractMoveToken(text);
    const applied = tryApply(chess, token);
    if (applied) {
      return { move: applied, san: applied.san, think: extractThink(text), attempts: attempt, illegal, raw: text };
    }
    if (token) sawIllegalMove = true;
    illegal.push(token ? `illegal or unparseable move "${token}"` : 'no MOVE: line in the reply');
    onAttempt?.({ attempt, token, reason: illegal.at(-1) });
  }

  return {
    move: null, think: '', attempts: attemptsMade, illegal, forfeit: true,
    forfeitKind: sawIllegalMove ? 'illegal' : 'unparseable',
  };
}

export function newGame() {
  return new Chess();
}
