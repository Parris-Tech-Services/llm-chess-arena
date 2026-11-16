'use strict';

/* ------------------------------------------------------------------ helpers */
const $ = (id) => document.getElementById(id);
const GLYPH = {
  p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚',
  P: '♙', N: '♘', B: '♗', R: '♖', Q: '♕', K: '♔',
};
const FILE = 'abcdefgh';
const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const prefs = {
  theme: 'dark',
  board: 'classic',
  sound: true,
  ...JSON.parse(localStorage.getItem('arena.prefs') || '{}'),
};
function savePrefs() {
  localStorage.setItem('arena.prefs', JSON.stringify(prefs));
  document.documentElement.dataset.theme = prefs.theme;
  document.documentElement.dataset.board = prefs.board;
  $('soundBtn').textContent = prefs.sound ? '🔊' : '🔇';
  $('soundBtn').setAttribute('aria-pressed', String(prefs.sound));
}

const S = {
  config: null,
  state: null,
  feed: [],
  feedGameId: null,
  tab: 'commentary',
  liveReferee: '',
  streams: { w: '', b: '' },
  replay: null,
  viewPly: null, // null follows the newest move; a number freezes the board at that ply
  initialPlyApplied: false,
  connected: false,
  finishedHandled: false,
};

/* -------------------------------------------------------------------- sound */
let actx = null;
function blip(kind) {
  if (!prefs.sound) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const t = actx.currentTime;
    const osc = actx.createOscillator();
    const gain = actx.createGain();
    osc.connect(gain).connect(actx.destination);
    const map = { move: [520, 'sine', 0.05], capture: [190, 'triangle', 0.09], check: [760, 'sine', 0.08], bad: [120, 'sawtooth', 0.09], end: [320, 'sine', 0.25] };
    const [freq, type, dur] = map[kind] || map.move;
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(60, freq * 0.7), t + dur);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.16, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  } catch { /* audio is optional */ }
}

/* -------------------------------------------------------------------- board */
function parseFen(fen) {
  const rows = [];
  for (const row of fen.split(' ')[0].split('/')) {
    const out = [];
    for (const ch of row) {
      if (/\d/.test(ch)) out.push(...Array(Number(ch)).fill(null));
      else out.push(ch);
    }
    rows.push(out);
  }
  return rows;
}

function fmtClock(ms) {
  if (ms === null || ms === undefined) return '--:--';
  if (ms <= 0) return '0:00';
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function findKing(rows, turn) {
  const target = turn === 'w' ? 'K' : 'k';
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (rows[r][c] === target) return FILE[c] + (8 - r);
  return null;
}

function renderBoard(state, animate = false) {
  const board = $('board');
  if (!state) return;
  const rows = parseFen(state.fen);
  const last = state.moves && state.moves.length ? state.moves[state.moves.length - 1] : null;
  const checkSq = state.inCheck ? findKing(rows, state.turn) : null;

  board.innerHTML = '';
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = rows[r][c];
      const sq = FILE[c] + (8 - r);
      const el = document.createElement('div');
      el.className = `sq ${(r + c) % 2 === 0 ? 'light' : 'dark'}`;
      el.dataset.sq = sq;
      if (last && (last.from === sq || last.to === sq)) el.classList.add('last');
      if (checkSq === sq) el.classList.add('check');
      if (piece) {
        const span = document.createElement('span');
        span.className = 'pc';
        span.textContent = GLYPH[piece];
        el.appendChild(span);
      }
      if (r === 7) el.insertAdjacentHTML('beforeend', `<span class="coord file">${FILE[c]}</span>`);
      if (c === 0) el.insertAdjacentHTML('beforeend', `<span class="coord rank">${8 - r}</span>`);
      board.appendChild(el);
    }
  }
  board.setAttribute('aria-label', `Chess board, ${state.moves ? state.moves.length : 0} plies played`);
  if (animate && last && !prefersReduced) animateMove(last);
}

function animateMove(move) {
  const board = $('board');
  const from = board.querySelector(`[data-sq="${move.from}"]`);
  const to = board.querySelector(`[data-sq="${move.to}"]`);
  if (!from || !to) return;
  const pieceEl = to.querySelector('.pc');
  if (pieceEl) pieceEl.style.visibility = 'hidden';

  const flyer = document.createElement('div');
  flyer.className = 'sq flyer';
  flyer.style.cssText = `left:${from.offsetLeft}px;top:${from.offsetTop}px;width:${from.offsetWidth}px;height:${from.offsetHeight}px;font-size:${getComputedStyle(from).fontSize}`;
  const glyph = pieceEl ? pieceEl.textContent : '';
  flyer.textContent = glyph || '';
  flyer.style.color = getComputedStyle(to).color;
  board.appendChild(flyer);

  requestAnimationFrame(() => {
    flyer.style.transform = `translate(${to.offsetLeft - from.offsetLeft}px, ${to.offsetTop - from.offsetTop}px)`;
  });
  const done = () => {
    flyer.remove();
    if (pieceEl) pieceEl.style.visibility = '';
  };
  flyer.addEventListener('transitionend', done, { once: true });
  setTimeout(done, 400);
}

/* ------------------------------------------------------------------- render */
function statusInfo(state) {
  if (!state || state.status === 'idle') return { cls: '', text: 'idle' };
  if (state.status === 'playing') return { cls: 'live', text: 'live' };
  if (state.status === 'paused') return { cls: 'paused', text: state.interrupted ? 'interrupted' : 'paused' };
  if (state.status === 'finished') return { cls: 'done', text: state.result === 'aborted' ? 'stopped' : 'finished' };
  return { cls: '', text: state.status };
}

function moveHistory(state) {
  const fens = state?.fens || S.replay?.fens || [];
  const total = state?.moves?.length || 0;
  return { fens, total, available: fens.length >= total + 1 };
}

function viewedPly(state) {
  const { total } = moveHistory(state);
  return S.viewPly === null ? total : Math.max(0, Math.min(total, S.viewPly));
}

// Navigation only changes the spectator's displayed position, never the live game.
function navigateTo(ply) {
  const { total, available } = moveHistory(S.state);
  if (!available) return;
  S.viewPly = ply >= total ? null : Math.max(0, ply);
  renderPosition(false);
  renderMoves(S.state);
}

function renderPosition(animate = false) {
  if (!S.state) return;
  if (!S.initialPlyApplied) {
    S.initialPlyApplied = true;
    const requested = new URL(location.href).searchParams.get('ply');
    if (requested !== null && /^\d+$/.test(requested)) {
      const target = Math.min(moveHistory(S.state).total, Number(requested));
      S.viewPly = target === moveHistory(S.state).total ? null : target;
    }
  }
  const { fens, total, available } = moveHistory(S.state);
  const index = viewedPly(S.state);
  const moves = S.state.moves || [];
  if (available) {
    const shown = moves.slice(0, index);
    const atEnd = index === total;
    const lastSan = shown.at(-1)?.san || '';
    renderBoard({
      ...S.state,
      fen: fens[index],
      moves: shown,
      turn: index % 2 === 0 ? 'w' : 'b',
      inCheck: atEnd ? S.state.inCheck || /[+#]$/.test(lastSan) : /[+#]$/.test(lastSan),
    }, animate && atEnd);
  } else {
    renderBoard(S.state, animate);
  }
  $('moveSlider').max = String(total);
  $('moveSlider').value = String(index);
  $('moveSlider').disabled = !available || total === 0;
  $('moveBackBtn').disabled = !available || index === 0;
  $('moveForwardBtn').disabled = !available || index >= total;
  $('moveLiveBtn').disabled = !available || S.viewPly === null;
  const last = moves[index - 1];
  const moveLabel = last ? `${Math.floor((index - 1) / 2) + 1}${last.side === 'w' ? '.' : '…'} ${last.san}` : 'Starting position';
  $('movePosition').textContent = `${index} / ${total} · ${moveLabel}${index < total ? (S.state.status === 'playing' ? ' · LIVE CONTINUES' : ' · REPLAYING') : ' · Latest'}`;
  $('movePosition').classList.toggle('behind', index < total);
  renderDecision();
  updateEnginePanel();
}

function renderStatus(state) {
  const info = statusInfo(state);
  const pill = $('statusPill');
  pill.className = `pill ${info.cls}`;
  pill.textContent = info.text;
}

function renderPlayers(state) {
  const p = state.players || {};
  $('nameW').textContent = p.w?.name || 'White';
  $('nameB').textContent = p.b?.name || 'Black';
  $('avatarW').textContent = initials(p.w?.name || 'White');
  $('avatarB').textContent = initials(p.b?.name || 'Black');
  const modelLabel = (p) => state.engineMode === 'engine' ? 'Stockfish · engine only'
    : state.engineMode === 'assisted' ? (p?.model || 'LLM') + ' + Stockfish'
    : (p?.model || 'not set');
  $('modelW').textContent = modelLabel(p.w);
  $('modelB').textContent = modelLabel(p.b);
  $('playerW').classList.toggle('active', state.status === 'playing' && state.turn === 'w');
  $('playerB').classList.toggle('active', state.status === 'playing' && state.turn === 'b');
  $('clockW').textContent = state.timeControl?.baseMs ? fmtClock(state.clocks?.w) : '∞';
  $('clockB').textContent = state.timeControl?.baseMs ? fmtClock(state.clocks?.b) : '∞';
  $('clockW').classList.toggle('low', !!state.timeControl?.baseMs && state.clocks?.w < 20000);
  $('clockB').classList.toggle('low', !!state.timeControl?.baseMs && state.clocks?.b < 20000);
}

function initials(name) {
  return String(name).replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || 'AI';
}

function renderFeed() {
  const feed = $('feed');
  const empty = $('commentaryEmpty');
  if (!S.feed.length) {
    empty.hidden = false;
    feed.innerHTML = '';
    return;
  }
  empty.hidden = true;
  const nearBottom = true;
  feed.innerHTML = S.feed.slice(-120).map((row) => {
    const tagCls = row.tagClass || '';
    return `<div class="row">
      <div class="tag ${tagCls}">${row.tag}</div>
      <div>
        <div class="txt ${row.dim ? 'dim' : ''}">${esc(row.text)}</div>
        ${row.meta ? `<div class="meta">${esc(row.meta)}</div>` : ''}
      </div>
    </div>`;
  }).join('');
  if (nearBottom) document.getElementById('tabCommentary').scrollTop = 1e6;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function rebuildFeed(state) {
  S.feed = [];
  const moves = state.moves || [];
  const refs = state.refereeLog || [];
  const rej = state.rejections || [];
  const items = [];
  moves.forEach((m, i) => items.push({ at: i * 2, kind: 'move', m }));
  refs.forEach((r) => items.push({ at: (r.moveNumber || 1) * 2 - 1, kind: 'ref', r }));
  rej.forEach((r) => items.push({ at: (r.moveNumber || 1) * 2 - 0.5, kind: 'rej', r }));
  items.sort((a, b) => a.at - b.at);
  for (const it of items) {
    if (it.kind === 'move') {
      S.feed.push({
        tag: it.m.side === 'w' ? 'W' : 'B',
        tagClass: it.m.side,
        text: it.m.think || it.m.san,
        meta: `${Math.floor((it.m.n - 1) / 2) + 1}${it.m.side === 'w' ? '.' : '…'} ${it.m.san}${it.m.ms ? ` · ${(it.m.ms / 1000).toFixed(1)}s` : ''}`,
      });
    } else if (it.kind === 'ref') {
      S.feed.push({ tag: 'REF', tagClass: 'ref', text: it.r.text, meta: it.r.kind === 'ruling' ? 'ruling' : `move ${it.r.moveNumber}` });
    } else {
      S.feed.push({ tag: '!', tagClass: 'bad', text: it.r.reason, meta: `${it.r.side === 'w' ? 'White' : 'Black'} attempt rejected` });
    }
  }
  renderFeed();
}

function pushFeed(row) {
  S.feed.push(row);
  renderFeed();
}

function renderMoves(state) {
  const box = $('movelist');
  const moves = state?.moves || [];
  if (!moves.length) {
    box.innerHTML = '<div class="empty">No moves yet.</div>';
    return;
  }
  const selected = viewedPly(state);
  box.innerHTML = moves.map((m, i) => `<div class="mv${i + 1 === selected ? ' viewed' : ''}" data-ply="${i + 1}">
      <span class="no">${m.side === 'w' ? Math.floor(i / 2) + 1 + '.' : ''}</span>
      <span class="san">${esc(m.san)}</span>
      <span class="why" title="${esc((m.source || 'llm') + ': ' + (m.think || ''))}">${esc(m.source && m.source !== 'llm' ? '[' + m.source.replaceAll('-', ' ') + '] ' : '')}${esc(m.think || '')}</span>
    </div>`).join('');
}

function updateControls(state) {
  const playing = state.status === 'playing';
  const paused = state.status === 'paused';
  const idle = state.status === 'idle';
  const over = state.status === 'finished';
  const busy = playing || paused;
  $('startBtn').disabled = busy;
  $('startBtn').hidden = busy;
  $('pauseBtn').disabled = !playing;
  $('pauseBtn').hidden = !playing;
  $('resumeBtn').disabled = !paused;
  $('resumeBtn').hidden = !paused;
  $('stopBtn').disabled = !busy;
  $('stopBtn').hidden = !busy;
  $('rematchBtn').disabled = !over || !state.players.w.model;
  $('newBtn').disabled = idle;
  document.querySelectorAll('#setupCard select').forEach((s) => { s.disabled = busy; });
}

function renderVerdict(state) {
  const card = $('resultCard');
  const finished = state.status === 'finished' && state.result && state.result !== 'aborted';
  if (!finished) { card.hidden = true; return; }
  card.hidden = false;
  const label = state.result === 'draw' ? 'Draw'
    : state.result === 'w-wins' ? `${state.players.w.name} wins`
    : state.result === 'b-wins' ? `${state.players.b.name} wins`
    : state.result;
  $('resultBig').textContent = label;
  $('resultReason').textContent = state.reason || '';
  const v = state.verdict;
  const parts = [];
  if (v?.summary) parts.push(`<div>${esc(v.summary)}</div>`);
  if (v?.note) parts.push(`<div>${esc(v.note)}</div>`);
  if (v?.playerOfMatch) parts.push(`<div class="potm">★ Player of the match: ${esc(v.playerOfMatch)}</div>`);
  if (v?.mismatch) parts.push('<div style="color:var(--warn)">Referee disagreed with the rules engine — the engine result stands.</div>');
  if (v?.conduct && v.conduct !== 'clean') parts.push(`<div>Conduct: ${esc(v.conduct)}</div>`);
  $('resultVerdict').innerHTML = parts.join('') || '<div class="empty">Referee is preparing the summary…</div>';

  const pgn = state.pgn || '';
  const blob = new Blob([pgn], { type: 'application/x-chess-pgn' });
  const url = URL.createObjectURL(blob);
  const link = $('pgnLink');
  if (link.dataset.url) URL.revokeObjectURL(link.dataset.url);
  link.href = url;
  link.dataset.url = url;
  link.download = `llm-chess-${state.id || 'game'}.pgn`;
}

function renderAll(animate = false) {
  const state = S.state;
  if (!state) return;
  renderStatus(state);
  renderPlayers(state);
  renderPosition(animate);
  renderMoves(state);
  updateControls(state);
  renderVerdict(state);
  renderDecision();
}

/* --------------------------------------------------------------------- tabs */
function setTab(tab) {
  S.tab = tab;
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === tab)));
  for (const name of ['commentary', 'moves', 'standings', 'games']) {
    $(`tab${name[0].toUpperCase()}${name.slice(1)}`).hidden = name !== tab;
  }
  if (tab === 'standings') loadStandings();
  if (tab === 'games') loadGames();
}

/* --------------------------------------------------------------------- data */
async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();
}

async function loadConfig() {
  try {
    S.config = await fetchJson('/api/config');
    const models = S.config.models || [];
    const fill = (sel, value) => {
      sel.innerHTML = models.map((m) => `<option value="${esc(m.id)}">${esc(m.id)}</option>`).join('')
        || '<option value="mock">mock</option>';
      if (value && models.some((m) => m.id === value)) sel.value = value;
    };
    fill($('whiteModel'), S.config.defaults.white);
    fill($('blackModel'), S.config.defaults.black);
    fill($('refereeModel'), S.config.defaults.referee);
    const available = !!S.config.stockfish?.available;
    for (const option of $('engineMode').options) option.disabled = option.value !== 'pure' && !available;
    $('engineMode').value = 'pure';
    if (!available) $('engineHelp').textContent = 'Cloud matches use independent LLMs. Optional Stockfish analysis and candidate lines are available beneath the board.';
    refreshKeys();
  } catch (err) {
    showBanner(`Could not load model catalogue: ${err.message}`);
    $('keyText').textContent = 'provider unavailable';
    $('keyLed').className = 'led bad';
  }
}

async function refreshKeys() {
  try {
    const k = await fetchJson('/api/keys');
    const led = $('keyLed');
    if (k.mode === 'cloudflare-ai') {
      led.className = 'led';
      $('keyText').textContent = 'Cloudflare AI · hosted live models';
      return;
    }
    if (k.mode === 'mock') {
      led.className = 'led mock';
      $('keyText').textContent = 'mock mode — random legal bots';
      return;
    }
    led.className = k.available > 0 ? 'led' : 'led bad';
    $('keyText').textContent = `${k.available}/${k.total} keys ready${k.cooling ? ` · ${k.cooling} cooling` : ''}${k.disabled ? ` · ${k.disabled} disabled` : ''}`;
  } catch { /* non-fatal */ }
}

async function loadStandings() {
  const box = $('standings');
  try {
    const s = await fetchJson('/api/standings');
    if (!s.rows.length) {
      box.innerHTML = '<div class="empty">No completed games yet. Ratings are calculated only from real results.</div>';
      return;
    }
    box.innerHTML = `<table class="tbl">
      <thead><tr><th>#</th><th>Model</th><th>Elo</th><th>G</th><th>W</th><th>D</th><th>L</th><th>Legal</th><th>ms</th></tr></thead>
      <tbody>${s.rows.map((r, i) => `<tr>
        <td>${i + 1}</td>
        <td class="model" title="${esc(r.model)}">${esc(r.model)}</td>
        <td>${r.rating}</td>
        <td>${r.games}</td>
        <td>${r.wins}</td>
        <td>${r.draws}</td>
        <td>${r.losses}</td>
        <td>${r.legalMoveRate === null ? '—' : r.legalMoveRate + '%'}</td>
        <td>${r.avgLatencyMs ?? '—'}</td>
      </tr>`).join('')}</tbody></table>
      <p class="hint" style="margin-top:10px">${s.totalGames} completed game${s.totalGames === 1 ? '' : 's'} · Elo K=24, start 1200.</p>`;
  } catch (err) {
    box.innerHTML = `<div class="empty">Could not load standings: ${esc(err.message)}</div>`;
  }
}

async function loadGames() {
  const box = $('games');
  try {
    const { games } = await fetchJson('/api/games');
    if (!games.length) {
      box.innerHTML = '<div class="empty">No completed games yet.</div>';
      return;
    }
    box.innerHTML = `<table class="tbl"><thead><tr><th>Match</th><th>Result</th><th></th></tr></thead><tbody>
      ${games.map((g) => `<tr>
        <td class="model">${esc(short(g.players.w.model))}<br><span style="color:var(--faint)">vs</span> ${esc(short(g.players.b.model))}</td>
        <td>${esc(g.result || g.status)}<br><span style="color:var(--faint);font-size:11px">${g.plies} plies</span></td>
        <td><a href="/g/${esc(g.id)}">watch</a></td>
      </tr>`).join('')}</tbody></table>`;
  } catch (err) {
    box.innerHTML = `<div class="empty">Could not load games: ${esc(err.message)}</div>`;
  }
}

const short = (m) => String(m || '').split('/').pop();

function showBanner(text) {
  const b = $('banner');
  b.textContent = text;
  b.classList.toggle('show', Boolean(text));
}

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ---------------------------------------------------------------------- SSE */
let es = null;
let pollTimer = null;
let lastEventAt = 0;
let watchdog = null;

/**
 * SSE is the fast path, but some proxies buffer event streams completely.
 * If nothing arrives quickly, fall back to state polling so the arena still
 * works everywhere (moves, clocks, commentary and referee arrive per poll).
 */
function startPolling() {
  if (pollTimer) return;
  if (es) { es.close(); es = null; }
  S.connected = true;
  S.polling = true;
  showBanner('');
  const tick = async () => {
    try {
      const state = await fetchJson('/api/state');
      handleEvent({ type: 'state', state });
    } catch {
      showBanner('Connection lost — retrying…');
    }
  };
  tick();
  pollTimer = setInterval(tick, 1500);
}

function connect() {
  if (es) es.close();
  lastEventAt = Date.now();
  es = new EventSource('/events');
  es.onopen = () => {
    S.connected = true;
    if (!S.polling) showBanner('');
  };
  es.onerror = () => {
    S.connected = false;
    if (!S.polling) showBanner('Connection lost — reconnecting…');
    // Repeated failures: switch transport rather than spin.
    if (Date.now() - lastEventAt > 8000) startPolling();
  };
  es.onmessage = (msg) => {
    lastEventAt = Date.now();
    if (S.polling) return;
    let e;
    try { e = JSON.parse(msg.data); } catch { return; }
    handleEvent(e);
  };
  clearTimeout(watchdog);
  watchdog = setTimeout(() => {
    if (Date.now() - lastEventAt > 4500 && !S.polling) startPolling();
  }, 5000);
}

function handleEvent(e) {
  if (e.type === 'state') {
    const prev = S.state;
    S.state = e.state;
    const isNewGame = !prev || prev.id !== e.state.id;
    // Polling transports deliver moves inside the snapshot rather than as
    // 'move' events, so keep the feed and sound in sync from state alone.
    if (!isNewGame && prev && e.state.moves.length !== prev.moves.length) {
      const grew = e.state.moves.length > prev.moves.length;
      if (grew) {
        const m = e.state.moves[e.state.moves.length - 1];
        blip(m.captured ? 'capture' : m.san.includes('+') || m.san.includes('#') ? 'check' : 'move');
      }
      rebuildFeed(e.state);
      renderMoves(e.state);
      if (e.state.status === 'playing') {
        const modelEl = e.state.turn === 'w' ? $('modelW') : $('modelB');
        if (modelEl) modelEl.textContent = e.state.players[e.state.turn]?.model || '';
      }
    }
    if (isNewGame) {
      S.viewPly = null;
      S.feed = [];
      S.finishedHandled = false;
      rebuildFeed(e.state);
      $('resultCard').hidden = true;
    }
    renderAll(Boolean(prev && prev.moves.length < e.state.moves.length));
    if (e.state.status === 'finished' && !S.finishedHandled) {
      S.finishedHandled = true;
      blip('end');
      if (e.state.result !== 'aborted') {
        loadStandings();
        loadGames();
      }
    }
    return;
  }
  if (e.type === 'tick') {
    $('clockW').textContent = S.state?.timeControl?.baseMs ? fmtClock(e.clocks.w) : '∞';
    $('clockB').textContent = S.state?.timeControl?.baseMs ? fmtClock(e.clocks.b) : '∞';
    return;
  }
  if (e.type === 'turn') {
    const el = e.side === 'w' ? $('playerW') : $('playerB');
    document.querySelectorAll('.player').forEach((p) => p.classList.remove('active'));
    el.classList.add('active');
    const modelEl = e.side === 'w' ? $('modelW') : $('modelB');
    modelEl.textContent = 'thinking…';
    modelEl.style.color = 'var(--accent)';
    return;
  }
  if (e.type === 'stream') {
    if (e.kind === 'commentary') {
      const modelEl = e.side === 'w' ? $('modelW') : $('modelB');
      modelEl.textContent = (e.full || '').replace(/\s+/g, ' ').slice(-90);
    } else if (e.kind === 'referee') {
      S.liveReferee = e.full || '';
      let row = document.getElementById('liveRefRow');
      if (!row) {
        row = document.createElement('div');
        row.id = 'liveRefRow';
        row.className = 'row';
        row.innerHTML = '<div class="tag ref">REF</div><div><div class="txt dim" id="liveRefText"></div></div>';
        $('feed').prepend(row);
        $('commentaryEmpty').hidden = true;
      }
      $('liveRefText').textContent = S.liveReferee;
    }
    return;
  }
  if (e.type === 'move') {
    S.state = e.state;
    const p = e.move.side === 'w' ? $('modelW') : $('modelB');
    p.textContent = S.state.players[e.move.side]?.model || '';
    p.style.color = '';
    renderAll(true);
    if (e.move.captured) blip('capture');
    else if (e.move.san.includes('+') || e.move.san.includes('#')) blip('check');
    else blip('move');
    pushFeed({
      tag: e.move.side === 'w' ? 'W' : 'B',
      tagClass: e.move.side,
      text: e.move.think || e.move.san,
      meta: `${Math.floor((e.move.n - 1) / 2) + 1}${e.move.side === 'w' ? '.' : '…'} ${e.move.san}${e.move.ms ? ` · ${(e.move.ms / 1000).toFixed(1)}s` : ''}${e.move.source && e.move.source !== 'llm' ? ` · ${e.move.source}` : ''}`,
    });
    return;
  }
  if (e.type === 'rejection') {
    blip('bad');
    pushFeed({ tag: '!', tagClass: 'bad', text: e.reason, meta: `${e.side === 'w' ? 'White' : 'Black'} attempt rejected` });
    showBanner(`Rejected move: ${e.reason}`);
    setTimeout(() => showBanner(''), 4000);
    return;
  }
  if (e.type === 'referee') {
    const row = document.getElementById('liveRefRow');
    if (row) row.remove();
    pushFeed({ tag: 'REF', tagClass: 'ref', text: e.entry.text, meta: e.entry.kind === 'ruling' ? 'ruling' : `move ${e.entry.moveNumber}` });
    return;
  }
  if (e.type === 'verdict') {
    if (S.state) { S.state.verdict = e.verdict; renderVerdict(S.state); }
    return;
  }
  if (e.type === 'log') {
    pushFeed({ tag: '·', tagClass: '', text: e.text, dim: true });
    return;
  }
}

/* ------------------------------------------------------------------ actions */
async function post(url, body) {
  try {
    const res = await fetchJson(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res;
  } catch (err) {
    toast(err.message);
    return null;
  }
}

function currentSetup() {
  const [base, inc] = $('clockSel').value.split(',').map(Number);
  return {
    white: { model: $('whiteModel').value, name: short($('whiteModel').value) },
    black: { model: $('blackModel').value, name: short($('blackModel').value) },
    referee: { model: $('refereeModel').value, name: short($('refereeModel').value) },
    timeControl: { baseMs: base, incrementMs: inc },
    pace: Number($('paceSel').value),
    engineMode: $('engineMode').value,
  };
}

$('startBtn').onclick = async () => {
  $('resultCard').hidden = true;
  showBanner('');
  const r = await post('/api/start', currentSetup());
  if (r) toast(`Match started · ${r.engineMode === 'engine' ? 'Stockfish only' : `${short(r.white.model)} vs ${short(r.black.model)}`} · ${r.engineMode}`);
};
$('pauseBtn').onclick = () => post('/api/pause');
$('resumeBtn').onclick = async () => {
  const r = await post('/api/resume');
  if (r && !r.resumed) await post('/api/resume-interrupted');
};
$('stopBtn').onclick = () => post('/api/stop');
$('rematchBtn').onclick = async () => {
  const r = await post('/api/rematch');
  if (r) toast('Rematch — colours swapped');
};
$('newBtn').onclick = async () => {
  await post('/api/new');
  S.feed = [];
  rebuildFeed({ moves: [], refereeLog: [], rejections: [] });
  $('resultCard').hidden = true;
  toast('Ready for a new match');
};

$('themeBtn').onclick = () => {
  prefs.theme = prefs.theme === 'dark' ? 'light' : 'dark';
  savePrefs();
};
$('soundBtn').onclick = () => {
  prefs.sound = !prefs.sound;
  savePrefs();
  if (prefs.sound) blip('move');
};
$('fullBtn').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => toast('Fullscreen not available'));
};
$('shareBtn').onclick = async () => {
  const id = S.state?.id;
  const shared = new URL(id ? `/g/${id}` : location.pathname, location.origin);
  if (S.viewPly !== null) shared.searchParams.set('ply', String(viewedPly(S.state)));
  if (ENGINE.enabled) shared.searchParams.set('analysis', 'on');
  const url = shared.toString();
  try {
    await navigator.clipboard.writeText(url);
    toast('Share link copied');
  } catch {
    toast(url);
  }
};
$('moveBackBtn').onclick = () => navigateTo(viewedPly(S.state) - 1);
$('moveForwardBtn').onclick = () => navigateTo(viewedPly(S.state) + 1);
$('moveLiveBtn').onclick = () => navigateTo(moveHistory(S.state).total);
$('moveSlider').oninput = () => navigateTo(Number($('moveSlider').value));
$('movelist').onclick = (e) => {
  const row = e.target.closest('[data-ply]');
  if (row) navigateTo(Number(row.dataset.ply));
};
$('boardSel').onchange = () => { prefs.board = $('boardSel').value; savePrefs(); };
document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => setTab(t.dataset.tab); });

/* -------------------------------------------------------------------- replay */
async function initReplay(id) {
  $('setupCard').hidden = true;
  $('controls').innerHTML = '';
  try {
    const game = await fetchJson(`/api/games/${id}`);
    S.replay = game;
    S.viewPly = null;
    S.state = {
      status: 'finished',
      engineMode: game.engineMode || 'pure',
      fen: game.fen,
      pgn: game.pgn,
      moves: game.moves,
      fens: game.fens,
      players: game.players,
      result: game.result,
      reason: game.reason,
      verdict: game.verdict,
      refereeLog: game.refereeLog,
      rejections: game.rejections,
      clocks: game.clocks,
      timeControl: game.timeControl,
      turn: 'w',
      inCheck: false,
      id: game.id,
    };
    rebuildFeed(S.state);
    renderStatus(S.state);
    renderPlayers(S.state);
    renderMoves(S.state);
    renderVerdict(S.state);
    renderPosition(false);
    $('statusPill').className = 'pill done';
    $('statusPill').textContent = 'replay';
  } catch (err) {
    $('board').innerHTML = `<div class="empty" style="grid-column:1/9;align-self:center">Could not load game ${esc(id)}: ${esc(err.message)}</div>`;
  }
}



/* ------------------------------------------------------ Live decision desk */
// The live model's internal chain-of-thought is unavailable. 'considered' is
// only what it deliberately reports in its public answer after a decision.
const OPENINGS = {
  entries: null, loading: false, error: null, lastKey: null, lastLabel: null,
};
function canonicalSan(value) {
  return String(value || '').replace(/[+#?!]/g, '');
}
async function loadOpeningNames() {
  if (OPENINGS.loading || OPENINGS.entries) return;
  OPENINGS.loading = true;
  try {
    const letters = ['a','b','c','d','e'];
    const res = await Promise.all(letters.map((s) => fetch('/data/openings/' + s + '.tsv')));
    if (res.some((r) => !r.ok)) throw Error('Opening reference temporarily unavailable');
    const files = await Promise.all(res.map((r) => r.text()));
    const entries = [];
    for (const file of files) {
      const rows = file.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
      const header = rows.shift().split('\t');
      const eco = header.indexOf('eco'), name = header.indexOf('name'), pgn = header.indexOf('pgn');
      if (eco < 0 || name < 0 || pgn < 0) throw Error('Unexpected opening database format');
      for (const row of rows) {
        const cols = row.split('\t');
        const moves = (cols[pgn] || '').replace(/\d+\.(?:\.\.)?/g, ' ')
          .trim().split(/\s+/).filter(Boolean).map(canonicalSan);
        if (moves.length && cols[name]) entries.push({eco:cols[eco],name:cols[name],moves});
      }
    }
    OPENINGS.entries = entries;
    OPENINGS.lastKey = null;
    renderDecision();
  } catch (error) {
    OPENINGS.error = error.message;
    $('openingInfo').textContent = error.message + ' · Position names remain optional.';
  } finally {
    OPENINGS.loading = false;
  }
}
function estimatePhase(fen, ply) {
  if (ply < 20) return 'Opening';
  const pieces = String(fen || '').split(' ')[0].replace(/[0-9/]/g, '');
  const minorMajor = (pieces.match(/[qrbnQRBN]/g) || []).length;
  if (minorMajor <= 5 && ply >= 34) return 'Endgame (likely)';
  return 'Middlegame (likely)';
}
function openingAt(state, ply) {
  const selected = (state.moves || []).slice(0, ply).map((m) => canonicalSan(m.san));
  const cacheKey = (state.id || 'new') + ':' + selected.join(' ');
  if (cacheKey === OPENINGS.lastKey) return OPENINGS.lastLabel;
  let match = null;
  for (const item of OPENINGS.entries || []) {
    if (item.moves.length > selected.length || match && item.moves.length < match.moves.length) continue;
    if (item.moves.every((m,i) => selected[i] === m)) match = item;
  }
  OPENINGS.lastKey = cacheKey;
  OPENINGS.lastLabel = match;
  return match;
}
function renderDecision() {
  const state = S.state;
  if (!state) return;
  const active = state.status === 'playing';
  const side = state.turn || 'w';
  const player = state.players?.[side];
  const elapsed = active && Number.isFinite(state.moveStartedAt) && state.moveStartedAt > 0
    ? Math.max(0, (Date.now() - state.moveStartedAt) / 1000) : 0;
  const historical = viewedPly(state) < (state.moves || []).length;
  $('decisionStatus').textContent = active ? '● LIVE' : state.status === 'finished' ? '● FINISHED' : '● ' + String(state.status).toUpperCase();
  $('decisionModel').textContent = active
    ? (player?.name || (side === 'w' ? 'White' : 'Black')) + ' · deciding as ' + (side === 'w' ? 'White' : 'Black')
    : 'No active model decision';
  $('decisionTimer').textContent = active ? elapsed.toFixed(1) + 's' : '—';
  $('decisionNote').textContent = active
    ? 'Waiting for a public MOVE / CANDIDATES / THINK response. Private model reasoning cannot be viewed.'
    : 'Public explanations are recorded with each move. This is not private model reasoning.';
  const ply = viewedPly(state);
  const fens = moveHistory(state).fens;
  const fen = fens[ply] || state.fen;
  $('gamePhase').textContent = estimatePhase(fen, ply);
  const opening = OPENINGS.entries ? openingAt(state,ply) : null;
  $('openingName').textContent = opening
    ? opening.name : OPENINGS.error ? 'Opening name unavailable'
    : OPENINGS.entries ? (ply ? 'Unclassified continuation' : 'Starting position') : 'Loading opening names…';
  $('openingInfo').textContent = opening
    ? opening.eco + ' · Lichess opening database (last known sequence)'
    : OPENINGS.error ? OPENINGS.error
    : 'ECO based on a named move sequence; unusual transpositions may differ.';
  const last = state.moves?.[ply - 1];
  if (!last) {
    $('modelCandidates').textContent = 'No model move selected yet.';
    $('modelExplain').textContent = 'Independent engine alternatives appear below once analysis is enabled.';
  } else if (last.considered?.length) {
    $('modelCandidates').textContent = last.considered.join(' · ');
    $('modelExplain').textContent =
      (historical ? 'Move ' + ply + ': ' : 'Latest move: ') +
      (last.side === 'w' ? 'White' : 'Black') + ' played ' + last.san +
      '. Public explanation: ' + (last.think || 'Not supplied.');
  } else {
    $('modelCandidates').textContent = 'Not recorded for move ' + ply + '.';
    $('modelExplain').textContent =
      'Played ' + last.san + '. ' + (last.think || 'No public explanation was supplied.') +
      ' · Only new matches can contain model-reported alternatives.';
  }
}
setInterval(renderDecision, 500);
loadOpeningNames();

/* ----------------------------------------------------------- Chess analysis */
// A separate UCI Web Worker evaluates a position; its engine output is not
// an LLM's private thoughts. MultiPV 3 offers three independent candidate lines.
const ENGINE = {
  enabled:false, ready:false, searching:false, worker:null, currentFen:null,
  targetFen:null, queue:[], turn:'w', depth:0, timer:null,
  lines:new Map(), evaluations:new Map(),
};
function currentViewFen() {
  if (!S.state) return null;
  const {fens,available} = moveHistory(S.state);
  return available ? fens[viewedPly(S.state)] : S.state.fen;
}
function engineLineText(uci) {
  return (uci || '').trim().split(/\s+/).slice(0, 5).map((m) =>
    /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(m) ? m.slice(0,2) + '→' + m.slice(2) : ''
  ).filter(Boolean).join(' ');
}
function displayEngineScore(obj) {
  if (!obj) return '—';
  if (obj.mate !== null) return (obj.mate >= 0 ? 'M+' : 'M') + Math.abs(obj.mate);
  const n = (obj.cp || 0) / 100;
  return (n > 0 ? '+' : '') + n.toFixed(2);
}
function renderEngineCandidates() {
  const rows = Array.from(ENGINE.lines.values()).sort((a,b)=>a.rank-b.rank).filter((r)=>r.pv);
  if (!ENGINE.enabled || !rows.length) { $('engineCandidates').hidden = true; return; }
  $('engineCandidates').hidden = false;
  $('engineCandidates').innerHTML = rows.map((r) =>
    '<div class="engine-line"><span class="engine-rank">#' + r.rank + '</span>' +
    '<span class="pv">' + esc(engineLineText(r.pv)) +
    ' <span class="engine-depth">depth ' + r.depth + '</span></span>' +
    '<strong class="engine-score">' + esc(displayEngineScore(r)) + '</strong></div>'
  ).join('');
  const first = rows[0];
  if (first) {
    $('engineEval').textContent = displayEngineScore(first);
    $('engineBest').textContent = 'Best: ' + engineLineText(first.pv).split(' ')[0];
    $('engineDepth').textContent = 'Depth ' + first.depth + ' · White perspective · ' + rows.length + ' lines';
  }
}
function renderMoveQuality() {
  const box = $('moveQuality');
  box.hidden = true;
  box.className = 'move-quality hint';
  if (!ENGINE.enabled || !S.state) return;
  const index = viewedPly(S.state);
  const fens = moveHistory(S.state).fens;
  if (!index || !fens[index-1] || !fens[index]) return;
  const before = ENGINE.evaluations.get(fens[index-1]);
  const after = ENGINE.evaluations.get(fens[index]);
  if (!before || !after || before.depth < 9 || after.depth < 9
    || before.mate !== null || after.mate !== null) return;
  const side = S.state.moves[index - 1]?.side === 'w' ? 1 : -1;
  const loss = Math.max(0, Math.round((before.cp - after.cp) * side));
  const label = loss >= 250 ? 'Possible blunder' : loss >= 120 ? 'Possible mistake' :
    loss >= 60 ? 'Possible inaccuracy' : 'Reasonable move';
  box.classList.toggle('warning', loss >= 60 && loss < 250);
  box.classList.toggle('blunder', loss >= 250);
  box.textContent = label + ': ' + S.state.moves[index - 1].san +
    ' · ~' + (loss / 100).toFixed(2) + ' pawns vs engine baseline' +
    (before.pv ? ' · previous top line ' + engineLineText(before.pv).split(' ')[0] : '') +
    '. Approximate Stockfish Lite comparison; not a certified accuracy score.';
  box.hidden = false;
}
function updateEnginePanel() {
  const compare = $('compareEngines');
  const selectedFen = currentViewFen();
  if (compare && selectedFen) compare.href = 'https://0x88.app/app/analysis/?fen=' + encodeURIComponent(selectedFen);
  if (S.state) {
    const timed = S.state.moves.filter((m) => Number.isFinite(m.ms));
    if (timed.length) {
      const avg = timed.reduce((sum, m)=>sum+m.ms,0)/timed.length;
      const last = timed.at(-1);
      $('engineSpeed').textContent = 'Avg move: ' + (avg/1000).toFixed(1) +
        's · Last: ' + (last.ms/1000).toFixed(1) + 's';
    }
  }
  if (!ENGINE.enabled || !ENGINE.ready || !S.state) return;
  const fen = currentViewFen();
  if (!fen || ENGINE.targetFen === fen) {renderMoveQuality();return;}
  ENGINE.targetFen = fen;
  const index = viewedPly(S.state), fens = moveHistory(S.state).fens;
  const previous = index > 0 ? fens[index-1] : null;
  ENGINE.queue = [];
  if (previous && !ENGINE.evaluations.has(previous)) ENGINE.queue.push(previous);
  ENGINE.queue.push(fen);
  if (ENGINE.searching) ENGINE.worker.postMessage('stop');
  else engineAnalyzeNext();
}
function engineAnalyzeNext() {
  if (!ENGINE.enabled || !ENGINE.ready || ENGINE.searching || !ENGINE.queue.length) return;
  ENGINE.currentFen = ENGINE.queue.shift();
  ENGINE.turn = ENGINE.currentFen.split(' ')[1] || 'w';
  ENGINE.searching = true; ENGINE.depth = 0; ENGINE.lines = new Map();
  $('engineEval').textContent = '…';
  $('engineBest').textContent = ENGINE.currentFen === ENGINE.targetFen
    ? 'Comparing three moves…' : 'Checking previous move…';
  $('engineDepth').textContent = 'Stockfish · analysing position';
  $('engineCandidates').hidden = true;
  ENGINE.worker.postMessage('position fen ' + ENGINE.currentFen);
  ENGINE.worker.postMessage('go movetime 1100');
}
function onEngineLine(line) {
  if (line === 'uciok') {
    ENGINE.worker.postMessage('setoption name MultiPV value 3');
    ENGINE.worker.postMessage('isready');
    return;
  }
  if (line === 'readyok') {
    ENGINE.ready = true;
    clearTimeout(ENGINE.timer);
    $('engineMessage').textContent = 'Three ranked lines from local Stockfish; models’ public candidates appear above after their move.';
    $('engineDetails').hidden = false;
    ENGINE.targetFen = null;
    updateEnginePanel();
    return;
  }
  if (line.startsWith('info ') && ENGINE.searching) {
    const depth = Number(/\bdepth (\d+)/.exec(line)?.[1] || 0);
    const rank = Number(/\bmultipv (\d+)/.exec(line)?.[1] || 1);
    const score = /\bscore (cp|mate) (-?\d+)/.exec(line);
    const pv = /\bpv ([a-h][1-8][a-h][1-8][qrbn]?(?:\s+[a-h][1-8][a-h][1-8][qrbn]?)*)/.exec(line);
    if (!score || !pv || rank > 3 || depth < 1) return;
    const old = ENGINE.lines.get(rank);
    if (old && depth < old.depth) return;
    const raw = Number(score[2]) * (ENGINE.turn === 'b' ? -1 : 1);
    ENGINE.lines.set(rank,{
      rank,depth,pv:pv[1],
      cp:score[1] === 'cp' ? raw : null,
      mate:score[1] === 'mate' ? raw : null,
    });
    if (ENGINE.currentFen === ENGINE.targetFen) renderEngineCandidates();
  }
  if (line.startsWith('bestmove ')) {
    ENGINE.searching = false;
    const first = ENGINE.lines.get(1);
    if (first && first.depth >= 7) {
      ENGINE.evaluations.set(ENGINE.currentFen,first);
      if (ENGINE.evaluations.size > 150) ENGINE.evaluations.delete(ENGINE.evaluations.keys().next().value);
    }
    if (ENGINE.queue.length) {
      engineAnalyzeNext();
    } else {
      if (ENGINE.currentFen === ENGINE.targetFen) renderEngineCandidates();
      renderMoveQuality();
    }
  }
}
function stopStockfish() {
  ENGINE.enabled=false;ENGINE.ready=false;ENGINE.searching=false;
  ENGINE.currentFen=null;ENGINE.targetFen=null;ENGINE.queue=[];ENGINE.lines=new Map();
  clearTimeout(ENGINE.timer); ENGINE.worker?.terminate(); ENGINE.worker=null;
  $('engineToggle').textContent='Enable analysis';
  $('engineToggle').setAttribute('aria-pressed','false');
  $('engineDetails').hidden=true;$('engineCandidates').hidden=true;$('moveQuality').hidden=true;
  $('engineMessage').textContent='Analysis off. Enable it to compare three candidate moves and review mistakes.';
}
async function toggleStockfish() {
  if (ENGINE.enabled) {stopStockfish();return;}
  ENGINE.enabled=true;
  $('engineToggle').textContent='Disable analysis';
  $('engineToggle').setAttribute('aria-pressed','true');
  $('engineMessage').textContent='Loading local Stockfish Lite…';
  try {
    const check=await fetch('/engine/manifest',{cache:'no-store'});
    if (!check.ok || !(await check.json()).available) throw Error('The engine is unavailable here');
    if (!ENGINE.enabled) return;
    ENGINE.worker=new Worker('/engine/stockfish-19-lite-single.js');
    ENGINE.worker.onmessage=(event)=>{
      for (const part of String(event.data||'').split(/\r?\n/)) if (part) onEngineLine(part.trim());
    };
    ENGINE.worker.onerror=(event)=>{
      const message=event.message||'Engine failed to load';
      stopStockfish();$('engineMessage').textContent='Stockfish error: '+message;
    };
    ENGINE.timer=setTimeout(()=>{
      if (ENGINE.enabled && !ENGINE.ready) {
        stopStockfish();$('engineMessage').textContent='Stockfish did not start. Retry analysis.';
      }
    },20000);
    ENGINE.worker.postMessage('uci');
  } catch(e) {
    stopStockfish();$('engineMessage').textContent='Stockfish unavailable: '+e.message;
  }
}
$('engineToggle').onclick=toggleStockfish;
window.addEventListener('pagehide',()=>ENGINE.worker?.terminate());

/* ---------------------------------------------------------------------- boot */
savePrefs();
$('boardSel').value = prefs.board;
if (location.pathname.startsWith('/g/')) {
  initReplay(location.pathname.slice(3).replace(/\/$/, ''));
} else {
  loadConfig();
  connect();
  setInterval(refreshKeys, 20000);
}
// Explicit analysis=on is a shareable, testable opt-in; normal visits remain lightweight.
if (new URL(location.href).searchParams.get('analysis') === 'on') toggleStockfish();
window.addEventListener('beforeunload', () => {
  if (es) es.close();
  if (pollTimer) clearInterval(pollTimer);
});
