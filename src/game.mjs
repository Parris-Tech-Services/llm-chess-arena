import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { Chess } from 'chess.js';
import { requestMove } from './bots.mjs';
import { refereeRemark, refereeExplainRejection, refereeVerdict } from './referee.mjs';

const DEFAULT_CONFIG = {
  moveBudgetMs: 60_000,
  maxAttempts: 3,
  maxPlies: 300,
  noProgressPlies: 80,
  plyDelayMs: 600,
  refereeEnabled: true,
  playerMaxTokens: 800,
  reasoningEffort: 'low',
  maxForcedMoves: 2,
  timeControl: { baseMs: 300_000, incrementMs: 1000 },
};

/**
 * One game. Two models, one referee, one deterministic rules engine.
 * The board is mutated only by chess.js after validation; model text never
 * moves a piece, and private chain-of-thought is never stored or broadcast.
 */
export class Arena extends EventEmitter {
  constructor({ provider, refereeProvider, store, config = {} }) {
    super();
    this.provider = provider;
    this.refereeProvider = refereeProvider;
    this.store = store;
    this.config = { ...DEFAULT_CONFIG, ...config, timeControl: { ...DEFAULT_CONFIG.timeControl, ...(config.timeControl || {}) } };
    this.reset();
  }

  reset() {
    // Generation counter: any loop from a previous game must not touch this one.
    this.gen = (this.gen || 0) + 1;
    this.id = null;
    this.chess = new Chess();
    this.fens = [this.chess.fen()];
    this.moves = [];
    this.status = 'idle';
    this.result = null;
    this.reason = null;
    this.verdict = null;
    this.rejections = [];
    this.refereeLog = [];
    this.players = {
      w: { name: 'White', model: null },
      b: { name: 'Black', model: null },
      referee: { name: 'Referee', model: null },
    };
    this.clocks = { w: this.config.timeControl.baseMs, b: this.config.timeControl.baseMs };
    this.latency = { w: { sum: 0, count: 0 }, b: { sum: 0, count: 0 } };
    this.startedAt = null;
    this.finishedAt = null;
    this.moveStartedAt = null;
    this.noProgress = 0;
    this.forced = { w: 0, b: 0 };
    this.pace = this.config.plyDelayMs;
    this.timed = this.config.timeControl.baseMs > 0;
    this.interrupted = false;
    this.stopped = false;
    this.pauseGate = null;
    this.tickTimer = null;
    this._explainLocks = new Set();
  }

  get publicPlayers() {
    return {
      w: { name: this.players.w.name, model: this.players.w.model },
      b: { name: this.players.b.name, model: this.players.b.model },
      referee: { name: this.players.referee.name, model: this.players.referee.model },
    };
  }

  snapshot() {
    return {
      id: this.id,
      status: this.status,
      fen: this.chess.fen(),
      pgn: this.chess.pgn(),
      turn: this.chess.turn(),
      inCheck: this.chess.inCheck(),
      moves: this.moves,
      players: this.publicPlayers,
      clocks: this.clocks,
      result: this.result,
      reason: this.reason,
      verdict: this.verdict,
      refereeLog: this.refereeLog,
      rejections: this.rejections,
      noProgress: this.noProgress,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      interrupted: this.interrupted,
      latency: this.avgLatency(),
      pace: this.pace,
      timeControl: this.config.timeControl,
      moveStartedAt: this.moveStartedAt,
    };
  }

  avgLatency() {
    const f = (s) => (s.count ? Math.round(s.sum / s.count) : null);
    return { w: f(this.latency.w), b: f(this.latency.b) };
  }

  emitState() { this.emit('event', { type: 'state', state: this.snapshot() }); }

  startTicker() {
    this.stopTicker();
    this.tickTimer = setInterval(() => {
      if (this.status !== 'playing') return;
      const running = this.moveStartedAt ? Date.now() - this.moveStartedAt : 0;
      this.emit('event', {
        type: 'tick',
        clocks: {
          w: this.chess.turn() === 'w' ? Math.max(0, this.clocks.w - running) : this.clocks.w,
          b: this.chess.turn() === 'b' ? Math.max(0, this.clocks.b - running) : this.clocks.b,
        },
        turn: this.chess.turn(),
      });
    }, 1000);
    this.tickTimer.unref?.();
  }

  stopTicker() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  pause() {
    if (this.status !== 'playing') return false;
    this.status = 'paused';
    this.emitState();
    return true;
  }

  resume() {
    if (this.status !== 'paused') return false;
    this.status = 'playing';
    if (this.pauseGate) {
      const release = this.pauseGate;
      this.pauseGate = null;
      release();
    }
    this.emitState();
    return true;
  }

  stop(reason = 'stopped by operator') {
    if (this.status === 'finished' || this.status === 'idle') return;
    this.stopped = true;
    this.status = 'finished';
    this.result = 'aborted';
    this.reason = reason;
    this.finishedAt = Date.now();
    this.stopTicker();
    if (this.pauseGate) {
      const release = this.pauseGate;
      this.pauseGate = null;
      release();
    }
    this.emitState();
    this.persist().catch(() => {});
  }

  async start({ white, black, referee, timeControl, pace } = {}) {
    if (this.status === 'playing' || this.status === 'paused') throw new Error('a game is already in progress');
    this.reset();
    this.id = crypto.randomUUID().slice(0, 8);
    this.players = {
      w: { name: white?.name || white?.model || 'White', model: white?.model },
      b: { name: black?.name || black?.model || 'Black', model: black?.model },
      referee: { name: referee?.name || referee?.model || 'Referee', model: referee?.model || referee?.name || 'openai/gpt-oss-20b' },
    };
    if (timeControl?.baseMs !== undefined) this.config.timeControl = { ...this.config.timeControl, ...timeControl };
    this.timed = this.config.timeControl.baseMs > 0;
    this.clocks = { w: this.config.timeControl.baseMs, b: this.config.timeControl.baseMs };
    if (typeof pace === 'number') this.pace = Math.max(0, Math.min(5000, pace));
    this.status = 'playing';
    this.startedAt = Date.now();
    this.stopped = false;
    this.emit('event', { type: 'log', text: `${this.players.w.name} (White) vs ${this.players.b.name} (Black) · referee ${this.players.referee.name}` });
    this.emitState();
    this.startTicker();
    const gen = this.gen;
    this.loop(gen).catch((err) => this.crash(err));
  }

  async crash(err) {
    if (this.status === 'finished') return;
    this.status = 'finished';
    this.result = 'error';
    this.reason = err.message;
    this.finishedAt = Date.now();
    this.stopTicker();
    this.emit('event', { type: 'log', level: 'warn', text: `arena error: ${err.message}` });
    this.emitState();
    await this.persist().catch(() => {});
  }

  async waitWhilePaused() {
    if (this.status !== 'paused') return;
    await new Promise((resolve) => { this.pauseGate = resolve; });
  }

  async loop(gen = this.gen) {
    while (!this.stopped && gen === this.gen) {
      if (this.status === 'paused') { await this.waitWhilePaused(); continue; }
      if (this.status !== 'playing') return;

      const side = this.chess.turn();
      const player = this.players[side];
      const opponent = this.players[side === 'w' ? 'b' : 'w'];
      const plies = this.chess.history().length;

      if (plies >= this.config.maxPlies) return this.finish('draw', 'move limit reached');
      if (this.timed && this.clocks[side] <= 0) return this.finish(`${side === 'w' ? 'b' : 'w'}-wins`, 'time out');

      this.emit('event', { type: 'turn', side, moveNumber: Math.floor(plies / 2) + 1 });
      this.moveStartedAt = Date.now();

      const res = await requestMove({
        generate: (opts) =>
          this.provider.generate({
            ...opts,
            model: player.model,
            temperature: 0.6,
            maxTokens: this.config.playerMaxTokens,
            reasoningEffort: this.config.reasoningEffort,
            onDelta: (d, full) => this.emit('event', { type: 'stream', kind: 'commentary', side, delta: d, full }),
          }),
        chess: this.chess,
        side,
        name: player.name,
        opponent: opponent.name,
        budgetMs: this.timed ? Math.min(this.config.moveBudgetMs, Math.max(5000, this.clocks[side])) : this.config.moveBudgetMs,
        maxAttempts: this.config.maxAttempts,
        maxTokens: this.config.playerMaxTokens,
        reasoningEffort: this.config.reasoningEffort,
        refereeNote: this.refereeLog.at(-1)?.text,
        onAttempt: (info) => {
          this.rejections.push({ side, moveNumber: Math.floor(plies / 2) + 1, ...info, at: Date.now() });
          this.emit('event', { type: 'rejection', side, reason: info.reason, text: `Rejected ${side === 'w' ? 'White' : 'Black'}: ${info.reason}` });
          this.explainRejection(info, side);
        },
      });

      if (this.stopped || gen !== this.gen) return;
      const elapsed = Date.now() - this.moveStartedAt;

      if (res.forfeit) {
        const canForce = res.forfeitKind === 'unparseable' && this.forced[side] < this.config.maxForcedMoves;
        if (canForce) {
          this.forced[side] += 1;
          const legal = this.chess.moves({ verbose: true });
          const pick = legal[Math.floor(Math.random() * legal.length)];
          this.chess.move(pick);
          res.san = pick.san;
          res.think = '(no reply — arena played a legal move on the player’s behalf)';
          this.emit('event', { type: 'log', level: 'warn', text: `No reply from ${player.name}; arena forced ${pick.san}` });
        } else {
          const winner = side === 'w' ? 'b' : 'w';
          const why = res.forfeitKind === 'illegal' ? 'forfeit: repeated illegal moves' : 'forfeit: no reply within the time limit';
          return this.finish(`${winner}-wins`, why);
        }
      }

      if (this.timed) {
        this.clocks[side] -= elapsed;
        this.clocks[side] += this.config.timeControl.incrementMs;
      }
      this.latency[side].sum += elapsed;
      this.latency[side].count += 1;
      this.moveStartedAt = null;

      const last = this.chess.history({ verbose: true }).at(-1);
      this.noProgress = last.captured || last.piece === 'p' ? 0 : this.noProgress + 1;

      this.moves.push({
        n: this.moves.length + 1,
        san: res.san,
        side,
        from: last.from,
        to: last.to,
        piece: last.piece,
        captured: last.captured || null,
        think: res.think,
        attempts: res.attempts,
        ms: elapsed,
      });
      this.fens.push(this.chess.fen());

      this.emit('event', { type: 'move', move: this.moves.at(-1), state: this.snapshot() });

      if (this.config.refereeEnabled) this.scheduleReferee(res, side, Math.ceil(this.chess.history().length / 2));

      if (this.timed && this.clocks[side] <= 0) return this.finish(`${side === 'w' ? 'b' : 'w'}-wins`, 'time out');

      const outcome = this.checkOutcome();
      if (outcome) return this.finish(outcome.result, outcome.reason);

      await this.persist().catch(() => {});
      if (this.pace > 0) await new Promise((r) => setTimeout(r, this.pace));
      else await new Promise((r) => setImmediate(r));
    }
  }

  checkOutcome() {
    const c = this.chess;
    if (c.isCheckmate()) {
      const winner = c.turn() === 'w' ? 'b' : 'w';
      return { result: `${winner}-wins`, reason: 'checkmate' };
    }
    if (c.isStalemate()) return { result: 'draw', reason: 'stalemate' };
    if (c.isInsufficientMaterial()) return { result: 'draw', reason: 'insufficient material' };
    if (c.isThreefoldRepetition()) return { result: 'draw', reason: 'threefold repetition' };
    if (c.isDrawByFiftyMoves()) return { result: 'draw', reason: 'fifty-move rule' };
    if (this.noProgress >= this.config.noProgressPlies) {
      return { result: 'draw', reason: `no capture or pawn move in ${this.noProgress} plies` };
    }
    return null;
  }

  refereeGenerate(opts) {
    return this.refereeProvider.generate({
      ...opts,
      model: this.players.referee.model,
      onDelta: (d, full) => this.emit('event', { type: 'stream', kind: 'referee', delta: d, full }),
    });
  }

  explainRejection(info, side) {
    if (!this.config.refereeEnabled) return;
    const key = `${side}:${this.moves.length}:${info.attempt}`;
    if (this._explainLocks.has(key)) return;
    this._explainLocks.add(key);
    (async () => {
      try {
        const text = await refereeExplainRejection({
          generate: (o) => this.refereeGenerate({ ...o, maxTokens: 260, temperature: 0.3 }),
          side,
          reason: info.reason,
          fen: this.chess.fen(),
          legalMoves: this.chess.moves(),
        });
        if (text) this.emit('event', { type: 'referee', entry: { moveNumber: Math.floor(this.moves.length / 2) + 1, text, kind: 'ruling' } });
      } catch { /* referee is optional */ }
    })();
  }

  scheduleReferee(res, side, moveNumber) {
    const run = async () => {
      try {
        const text = await refereeRemark({
          generate: (o) => this.refereeGenerate({ ...o, maxTokens: 400, temperature: 0.4 }),
          fen: this.chess.fen(),
          san: res.san,
          side,
          moveNumber,
          think: res.think,
          lastRejections: this.rejections.slice(-1).map((r) => r.reason),
        });
        if (!text) return;
        const entry = { moveNumber, text, kind: 'remark', at: Date.now() };
        this.refereeLog.push(entry);
        this.emit('event', { type: 'referee', entry });
      } catch (err) {
        this.emit('event', { type: 'log', level: 'warn', text: `referee unavailable: ${err.message}` });
      }
    };
    this.refereePending = (this.refereePending || Promise.resolve()).then(run);
  }

  async finish(result, reason) {
    if (this.status === 'finished') return;
    this.status = 'finished';
    this.result = result;
    this.reason = reason;
    this.finishedAt = Date.now();
    this.moveStartedAt = null;
    this.stopTicker();
    this.emit('event', { type: 'log', text: `Game over: ${result} (${reason})` });
    this.emitState();

    if (this.config.refereeEnabled) {
      let verdict = { verdict: 'unknown', conduct: 'unknown', note: 'referee did not respond' };
      try {
        await (this.refereePending || Promise.resolve());
        verdict = await refereeVerdict({
          generate: (o) => this.refereeGenerate({ ...o, maxTokens: 500, temperature: 0.3 }),
          result,
          reason,
          players: this.publicPlayers,
          pgn: this.chess.pgn(),
          rejections: this.rejections,
          refereeLog: this.refereeLog,
        });
      } catch (err) {
        verdict.note = `referee unavailable: ${err.message}`;
      }
      verdict.engineResult = result;
      verdict.mismatch = verdict.verdict === 'dispute';
      this.verdict = verdict;
      this.emit('event', { type: 'verdict', verdict });
    }

    await this.persist().catch(() => {});
    await this.recordResult().catch(() => {});
    this.emitState();
  }

  record() {
    return {
      id: this.id,
      status: this.status,
      pgn: this.chess.pgn(),
      fen: this.chess.fen(),
      moves: this.moves,
      fens: this.fens,
      players: this.publicPlayers,
      clocks: this.clocks,
      timeControl: this.config.timeControl,
      result: this.result,
      reason: this.reason,
      verdict: this.verdict,
      refereeLog: this.refereeLog,
      rejections: this.rejections,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      interrupted: this.interrupted,
      noProgress: this.noProgress,
      pace: this.pace,
    };
  }

  async persist() {
    if (!this.store || !this.id) return;
    await this.store.saveGame(this.record());
  }

  async recordResult() {
    if (!this.store || !this.id) return;
    if (this.result === 'aborted' || this.result === 'error') return;
    await this.store.upsertResult({
      gameId: this.id,
      white: this.players.w.model,
      black: this.players.b.model,
      referee: this.players.referee.model,
      result: this.result === 'w-wins' ? 'w' : this.result === 'b-wins' ? 'b' : 'draw',
      reason: this.reason,
      moves: {
        w: this.moves.filter((m) => m.side === 'w').length,
        b: this.moves.filter((m) => m.side === 'b').length,
      },
      rejections: {
        w: this.rejections.filter((r) => r.side === 'w').length,
        b: this.rejections.filter((r) => r.side === 'b').length,
      },
      latency: this.avgLatency(),
      endedAt: this.finishedAt,
    });
  }

  /** Restore a game that was in progress when the process stopped. */
  adopt(record) {
    this.reset();
    this.id = record.id;
    // Deep copies: a restored game must never mutate the record it came from.
    const clone = (v) => (v === undefined ? undefined : structuredClone(v));
    this.players = clone(record.players);
    this.moves = clone(record.moves) || [];
    this.refereeLog = clone(record.refereeLog) || [];
    this.rejections = clone(record.rejections) || [];
    this.clocks = clone(record.clocks) || { w: 300_000, b: 300_000 };
    this.startedAt = record.startedAt;
    this.pace = record.pace ?? this.config.plyDelayMs;
    if (record.timeControl) this.config.timeControl = record.timeControl;
    this.timed = this.config.timeControl.baseMs > 0;
    this.chess = new Chess();
    try {
      this.chess.loadPgn(record.pgn);
      const replay = new Chess();
      this.fens = [replay.fen()];
      for (const m of this.moves) {
        try { replay.move(m.san); this.fens.push(replay.fen()); } catch { break; }
      }
    } catch { /* keep empty board if the PGN is unusable */ }
    this.fens = this.fens || [this.chess.fen()];
    this.status = 'paused';
    this.interrupted = true;
    this.result = null;
    this.reason = null;
    this.emitState();
    return this;
  }

  resumeInterrupted() {
    if (!this.interrupted) return false;
    this.interrupted = false;
    this.status = 'playing';
    this.emit('event', { type: 'log', text: 'Resuming interrupted game' });
    this.emitState();
    this.startTicker();
    const gen = this.gen;
    this.loop(gen).catch((err) => this.crash(err));
    return true;
  }
}
