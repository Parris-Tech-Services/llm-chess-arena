/**
 * Elo ratings computed only from completed games actually played by this arena.
 * Nothing here is seeded or invented: a model with no games has no rating.
 */
const BASE = 1200;
const K = 24;

const expected = (a, b) => 1 / (1 + 10 ** ((b - a) / 400));

function blank(name) {
  return {
    model: name,
    rating: BASE,
    games: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    latencySum: 0,
    latencyCount: 0,
    moves: 0,
    rejections: 0,
    lastPlayed: null,
  };
}

export function computeStandings(results = []) {
  const table = new Map();
  const h2h = new Map();
  const ordered = [...results].sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0));

  const byModel = (name) => {
    if (!table.has(name)) table.set(name, blank(name));
    return table.get(name);
  };

  for (const r of ordered) {
    if (!r?.white || !r?.black || !r.result) continue;
    const w = byModel(r.white);
    const b = byModel(r.black);

    const scoreW = r.result === 'w' ? 1 : r.result === 'draw' ? 0.5 : 0;
    const scoreB = 1 - scoreW;
    const ew = expected(w.rating, b.rating);
    w.rating += K * (scoreW - ew);
    b.rating += K * (scoreB - (1 - ew));

    for (const [side, p, score] of [['w', w, scoreW], ['b', b, scoreB]]) {
      p.games += 1;
      if (score === 1) p.wins += 1;
      else if (score === 0.5) p.draws += 1;
      else p.losses += 1;
      p.lastPlayed = r.endedAt || p.lastPlayed;
      const lat = r.latency?.[side];
      if (typeof lat === 'number') {
        p.latencySum += lat;
        p.latencyCount += 1;
      }
      p.moves += r.moves?.[side] || 0;
      p.rejections += r.rejections?.[side] || 0;
    }

    const key = [r.white, r.black].sort().join('::');
    if (!h2h.has(key)) h2h.set(key, { a: r.white, b: r.black, aWins: 0, bWins: 0, draws: 0 });
    const pair = h2h.get(key);
    if (r.result === 'draw') pair.draws += 1;
    else if (r.result === 'w') (pair.a === r.white ? pair.aWins++ : pair.bWins++);
    else if (pair.a === r.black) pair.aWins++;
    else pair.bWins++;
  }

  const rows = [...table.values()]
    .map((p) => ({
      ...p,
      rating: Math.round(p.rating),
      avgLatencyMs: p.latencyCount ? Math.round(p.latencySum / p.latencyCount) : null,
      legalMoveRate: p.moves ? Number(((p.moves / (p.moves + p.rejections)) * 100).toFixed(1)) : null,
      winRate: p.games ? Number(((p.wins / p.games) * 100).toFixed(1)) : null,
    }))
    .sort((a, b) => b.rating - a.rating);

  return {
    rows,
    headToHead: [...h2h.values()].sort((a, b) => b.aWins + b.bWins - (a.aWins + a.bWins)),
    totalGames: ordered.length,
  };
}
