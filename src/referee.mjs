/**
 * The referee bot.
 *
 * The referee never decides legality: chess.js does. It explains, comments,
 * judges conduct, and awards honours. Its verdict is stored next to the engine
 * result and can never override it.
 */
const REFEREE_SYSTEM = `You are the Match Referee of an AI chess exhibition, broadcast to spectators.
You are fair, dry, witty and extremely brief.
The tournament software is the authoritative rules engine: it validates every move and
detects checkmate, stalemate, repetition, insufficient material and the fifty-move rule.
You never invent rules and never declare a game state the software has not declared.
Your job is conduct, tactics and commentary.
Style rules: plain text, no markdown, no emoji, no quotation marks around your whole reply.
Never say "move accepted", "legal move", "valid" or "noted" — legality is the software's job.
If you believe a move was illegal, say PROTEST and the software will re-check it.`;

export async function refereeRemark({ generate, fen, san, side, moveNumber, think, lastRejections }) {
  const messages = [
    { role: 'system', content: REFEREE_SYSTEM },
    {
      role: 'user',
      content: [
        `Move ${moveNumber}, ${side === 'w' ? 'White' : 'Black'} played ${san}.`,
        `Position now: ${fen}`,
        think ? `The player's public claim: "${think}"` : '',
        lastRejections?.length ? `Just before this: ${lastRejections[0]}.` : '',
        'One sentence: what the move does, or a conduct note. Under 22 words. No preamble.',
      ].filter(Boolean).join('\n'),
    },
  ];
  const res = await generate({ messages, maxTokens: 400, temperature: 0.4 });
  return res.text.trim().replace(/^["']|["']$/g, '').slice(0, 240);
}

export async function refereeExplainRejection({ generate, side, reason, fen, legalMoves }) {
  const messages = [
    { role: 'system', content: REFEREE_SYSTEM },
    {
      role: 'user',
      content: [
        `${side === 'w' ? 'White' : 'Black'} attempted a move the software rejected: ${reason}.`,
        `Position: ${fen}`,
        `Legal moves available: ${legalMoves.slice(0, 40).join(', ')}`,
        'In one short sentence, explain to spectators what was wrong with the attempt. Under 24 words.',
      ].join('\n'),
    },
  ];
  const res = await generate({ messages, maxTokens: 260, temperature: 0.3 });
  return res.text.trim().replace(/^["']|["']$/g, '').slice(0, 240);
}

export async function refereeVerdict({ generate, result, reason, players, pgn, rejections, refereeLog }) {
  const names = [players.w.name, players.b.name];
  const messages = [
    { role: 'system', content: REFEREE_SYSTEM },
    {
      role: 'user',
      content: [
        `The game has ended. Software result: ${result} (${reason}).`,
        `White: ${players.w.name}. Black: ${players.b.name}.`,
        rejections?.length
          ? `Rejected attempts: ${rejections.map((r) => `${r.side}:${r.reason}`).join('; ')}`
          : 'No rejected attempts.',
        refereeLog?.length ? `Your earlier remarks: ${refereeLog.slice(-6).map((r) => r.text).join(' | ')}` : '',
        `Moves: ${pgn.slice(0, 1000)}`,
        '',
        'Return strictly this JSON, nothing else:',
        '{"verdict":"agree"|"dispute","conduct":"clean"|"warning"|"misconduct",' +
          '"note":"max 25 words on the result",' +
          '"summary":"max 60 words, broadcast style, what decided the game",' +
          `"playerOfMatch":"${names[0]}" or "${names[1]}" or "none"}`,
      ].filter(Boolean).join('\n'),
    },
  ];

  let text = '';
  try {
    const res = await generate({ messages, maxTokens: 500, temperature: 0.3 });
    text = res.text;
  } catch (err) {
    return { verdict: 'unknown', conduct: 'unknown', note: `referee unavailable: ${err.message}`, summary: '', playerOfMatch: null };
  }
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { verdict: 'unknown', conduct: 'unknown', note: text.trim().slice(0, 160), summary: '', playerOfMatch: null };
  try {
    const j = JSON.parse(m[0]);
    return {
      verdict: j.verdict === 'dispute' ? 'dispute' : 'agree',
      conduct: ['clean', 'warning', 'misconduct'].includes(j.conduct) ? j.conduct : 'clean',
      note: String(j.note || '').slice(0, 200),
      summary: String(j.summary || '').slice(0, 500),
      playerOfMatch: names.includes(j.playerOfMatch) ? j.playerOfMatch : null,
    };
  } catch {
    return { verdict: 'unknown', conduct: 'unknown', note: text.trim().slice(0, 160), summary: '', playerOfMatch: null };
  }
}
