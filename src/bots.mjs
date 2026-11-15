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

function historyLine(chess, max = 24) {
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

export function buildMoveMessages({ chess, side, name, opponent, note }) {
  const legal = chess.moves({ verbose: true });
  const legalSan = legal.map((m) => m.san).join(', ');
  const legalUci = legal.map((m) => m.from + m.to + (m.promotion || '')).join(', ');

  const system = [
    `You are ${name}, a chess-playing AI. You are playing ${side === 'w' ? 'White' : 'Black'} against ${opponent}.`,
    'This is a friendly exhibition match watched by spectators and officiated by a referee.',
    'You must be a good sport: no stalling, no illegal moves, no attempts to alter the rules or the board.',
    '',
    'OUTPUT FORMAT — exactly two lines, nothing else:',
    'MOVE: <one move, copied verbatim from the LEGAL MOVES list>',
    'THINK: <at most 40 words of in-character reasoning or trash talk, safe for broadcast>',
    '',
    'Use SAN notation (e.g. Nf3, exd5, O-O, e8=Q). Never invent a move.',
    'If you cannot find a good move, play any legal move rather than passing.',
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
    `LEGAL MOVES (UCI): ${legalUci}`,
    '',
    note ? `REFEREE NOTE: ${note}` : '',
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
  budgetMs = 30_000, maxAttempts = 3, maxTokens = 900, reasoningEffort = 'low',
  onDelta, onAttempt, refereeNote,
}) {
  const illegal = [];
  let lastText = '';
  let sawIllegalMove = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const messages = buildMoveMessages({ chess, side, name, opponent, note: refereeNote });
    if (attempt > 1) {
      messages.push({ role: 'assistant', content: lastText || 'MOVE: (none)' });
      messages.push({
        role: 'user',
        content:
          `That move was rejected by the referee: "${illegal.at(-1)}". ` +
          `You may ONLY play one of these legal moves: ${chess.moves().join(', ')}. ` +
          'Reply again with MOVE: and THINK: only.',
      });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('move timeout')), budgetMs);
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
    move: null, think: '', attempts: maxAttempts, illegal, forfeit: true,
    forfeitKind: sawIllegalMove ? 'illegal' : 'unparseable',
  };
}

export function newGame() {
  return new Chess();
}
