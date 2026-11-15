/**
 * Offline provider used by tests and by `npm run mock`.
 * Plays random legal moves and streams text in chunks like the real thing.
 */
const CHATTER = [
  'The centre is mine.',
  'I have seen this in a dream.',
  'A quiet move, then the storm.',
  'Your king looks cold over there.',
  'I am not trapped, I am coiled.',
  'Structure before fireworks.',
  'Every piece has a job.',
  'This is theory where I come from.',
];

export function createMockProvider(opts = {}) {
  const { illegalFor = null, illegalAtMove = 3 } = opts;
  const moved = new Map();

  return {
    async generate({ messages, signal, onDelta }) {
      if (signal?.aborted) throw new Error('aborted');
      const prompt = messages.map((m) => m.content).join('\n');
      const legal = /LEGAL MOVES \(SAN\): (.*)/.exec(prompt)?.[1]?.split(/,\s*/) ?? [];
      if (!legal.length) throw new Error('mock: no legal moves in prompt');
      const side = /Side to move: (White|Black)/.exec(prompt)?.[1];
      const moveNumber = Number(/Move number: (\d+)/.exec(prompt)?.[1] || 1);
      const count = (moved.get(side) || 0) + 1;
      moved.set(side, count);

      let move;
      if (illegalFor === side && moveNumber === illegalAtMove && count === 1) move = 'Zz9';
      else move = legal[Math.floor(Math.random() * legal.length)];

      const text = `MOVE: ${move}\nTHINK: ${CHATTER[Math.floor(Math.random() * CHATTER.length)]}`;
      let acc = '';
      for (const chunk of text.match(/[\s\S]{1,12}/g)) {
        if (signal?.aborted) throw new Error('aborted');
        acc += chunk;
        onDelta?.(chunk, acc);
        await new Promise((r) => setTimeout(r, 4));
      }
      return { text, tokens: text.length, finishReason: 'stop' };
    },
  };
}

export function createScriptedProvider(moves) {
  let i = 0;
  return {
    async generate({ onDelta }) {
      const move = moves[i++ % moves.length];
      const text = `MOVE: ${move}\nTHINK: scripted.`;
      onDelta?.(text, text);
      return { text, tokens: 8, finishReason: 'stop' };
    },
  };
}
