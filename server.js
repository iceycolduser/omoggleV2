'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const { nanoid } = require('nanoid');

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'omoggle.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,
    handle TEXT NOT NULL,
    elo INTEGER NOT NULL DEFAULT 1000,
    psl REAL,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    draws INTEGER NOT NULL DEFAULT 0,
    mogs INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_players_elo ON players(elo DESC);
  CREATE INDEX IF NOT EXISTS idx_players_mogs ON players(mogs DESC);

  CREATE TABLE IF NOT EXISTS matches (
    id TEXT PRIMARY KEY,
    a_id TEXT NOT NULL,
    b_id TEXT NOT NULL,
    a_psl REAL,
    b_psl REAL,
    winner TEXT,
    a_elo_delta INTEGER,
    b_elo_delta INTEGER,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_matches_ended ON matches(ended_at DESC);
`);

const queries = {
  upsertPlayer: db.prepare(`
    INSERT INTO players (id, handle, elo, created_at, last_seen)
    VALUES (@id, @handle, 1000, @now, @now)
    ON CONFLICT(id) DO UPDATE SET handle = excluded.handle, last_seen = excluded.last_seen
  `),
  getPlayer: db.prepare('SELECT * FROM players WHERE id = ?'),
  updatePsl: db.prepare('UPDATE players SET psl = @psl, last_seen = @now WHERE id = @id'),
  applyResult: db.prepare(`
    UPDATE players
       SET elo = elo + @delta,
           wins = wins + @win,
           losses = losses + @loss,
           draws = draws + @draw,
           mogs = mogs + @mog,
           last_seen = @now
     WHERE id = @id
  `),
  insertMatch: db.prepare(`
    INSERT INTO matches (id, a_id, b_id, started_at)
    VALUES (@id, @a, @b, @now)
  `),
  finishMatch: db.prepare(`
    UPDATE matches
       SET a_psl = @aPsl, b_psl = @bPsl, winner = @winner,
           a_elo_delta = @aDelta, b_elo_delta = @bDelta, ended_at = @now
     WHERE id = @id
  `),
  topElo: db.prepare(`
    SELECT id, handle, elo, psl, wins, losses, draws, mogs
      FROM players
     WHERE wins + losses + draws > 0
     ORDER BY elo DESC, mogs DESC
     LIMIT ?
  `),
  topMogs: db.prepare(`
    SELECT id, handle, elo, psl, mogs
      FROM players
     ORDER BY mogs DESC, elo DESC
     LIMIT ?
  `),
  stats: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM players) AS players,
      (SELECT COUNT(*) FROM matches WHERE ended_at IS NOT NULL) AS matches
  `),
};

const app = express();
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https://cdn.jsdelivr.net'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://cdn.jsdelivr.net'],
      mediaSrc: ["'self'", 'blob:'],
      connectSrc: [
        "'self'", 'wss:', 'ws:',
        'https://cdn.jsdelivr.net',
        'https://justadudewhohacks.github.io',
        'https://model.nsfwjs.com',
        'https://nsfwjs.com',
      ],
      workerSrc: ["'self'", 'blob:'],
      objectSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(compression());
app.use(express.json({ limit: '32kb' }));

const apiLimiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });
app.use('/api/', apiLimiter);

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));

app.get('/api/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.get('/api/stats', (_req, res) => {
  const s = queries.stats.get();
  res.json({ ...s, online: io.engine.clientsCount, queued: queue.length });
});

app.get('/api/leaderboard', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const board = req.query.board === 'mogs' ? queries.topMogs.all(limit) : queries.topElo.all(limit);
  res.json({ board });
});

app.get('/api/me/:id', (req, res) => {
  const p = queries.getPlayer.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not_found' });
  res.json(p);
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: false },
  maxHttpBufferSize: 1e6,
  pingInterval: 25_000,
  pingTimeout: 20_000,
});

// queue entries: { id: socketId, elo, joinedAt }
// pairing: oldest waiter is paired with the closest-elo partner inside a
// band that widens with their wait time. fairer than FIFO and the wait cap
// keeps the queue from stalling on a single outlier rating.
const queue = [];
const sockets = new Map();
const PAIR_BAND_START = 80;      // ±elo at t=0
const PAIR_BAND_GROW  = 60;      // ±elo gained per second of waiting
const PAIR_BAND_MAX   = 1200;    // hard cap (eventually anyone is fine)
let   pairTimer = null;          // periodic sweep to widen bands

function eloDelta(rA, rB, score, k = 32) {
  const expected = 1 / (1 + Math.pow(10, (rB - rA) / 400));
  return Math.round(k * (score - expected));
}

function bandFor(entry, now) {
  const waited = Math.max(0, (now - entry.joinedAt) / 1000);
  return Math.min(PAIR_BAND_MAX, PAIR_BAND_START + waited * PAIR_BAND_GROW);
}

function pairFromQueue() {
  const now = Date.now();
  // drop disconnected sockets
  for (let i = queue.length - 1; i >= 0; i--) {
    if (!sockets.get(queue[i].id)) queue.splice(i, 1);
  }
  // greedy: walk from oldest waiter, find closest-elo partner inside band.
  for (let i = 0; i < queue.length; i++) {
    const a = queue[i];
    const band = bandFor(a, now);
    let bestJ = -1, bestDiff = Infinity;
    for (let j = i + 1; j < queue.length; j++) {
      const b = queue[j];
      const diff = Math.abs(a.elo - b.elo);
      if (diff <= band && diff < bestDiff) {
        bestDiff = diff; bestJ = j;
        if (diff === 0) break;
      }
    }
    if (bestJ !== -1) {
      const b = queue[bestJ];
      // remove higher index first so the other index stays valid
      queue.splice(bestJ, 1);
      queue.splice(i, 1);
      const sa = sockets.get(a.id);
      const sb = sockets.get(b.id);
      if (sa && sb) startMatch(sa, sb);
      i = -1; // restart from start since indices shifted
    }
  }
}

function startPairTimer() {
  if (pairTimer) return;
  pairTimer = setInterval(() => {
    if (queue.length >= 2) pairFromQueue();
    if (queue.length === 0) { clearInterval(pairTimer); pairTimer = null; }
  }, 1000);
}

function startMatch(sa, sb) {
  const matchId = nanoid(12);
  const now = Date.now();
  queries.insertMatch.run({ id: matchId, a: sa.data.playerId, b: sb.data.playerId, now });

  sa.data.matchId = matchId;
  sb.data.matchId = matchId;
  sa.data.opponent = sb.id;
  sb.data.opponent = sa.id;
  sa.join(matchId);
  sb.join(matchId);

  // Caller is sa, callee is sb (so sa creates the offer)
  sa.emit('match:start', {
    matchId,
    role: 'caller',
    opponent: { handle: sb.data.handle, elo: sb.data.elo, psl: sb.data.psl },
  });
  sb.emit('match:start', {
    matchId,
    role: 'callee',
    opponent: { handle: sa.data.handle, elo: sa.data.elo, psl: sa.data.psl },
  });
}

function endMatch(matchId, winnerSocket, loserSocket, draw, payload) {
  if (!matchId) return;
  const aSock = winnerSocket || (draw ? payload?.a : null);
  const bSock = loserSocket || (draw ? payload?.b : null);
  // Resolve participants via room
  const room = io.sockets.adapter.rooms.get(matchId);
  if (!room) return;
  const ids = [...room];
  if (ids.length < 2) {
    // Opponent already left; close out cleanly
    for (const sid of ids) {
      const s = io.sockets.sockets.get(sid);
      if (s) { s.leave(matchId); s.data.matchId = null; s.data.opponent = null; }
    }
    return;
  }
  const [id1, id2] = ids;
  const s1 = io.sockets.sockets.get(id1);
  const s2 = io.sockets.sockets.get(id2);
  if (!s1 || !s2) return;

  const aPsl = payload?.aPsl ?? null;
  const bPsl = payload?.bPsl ?? null;
  const p1 = queries.getPlayer.get(s1.data.playerId);
  const p2 = queries.getPlayer.get(s2.data.playerId);
  if (!p1 || !p2) return;

  let s1Score, s2Score, winnerId;
  if (draw) { s1Score = 0.5; s2Score = 0.5; winnerId = null; }
  else if (winnerSocket && winnerSocket.id === s1.id) { s1Score = 1; s2Score = 0; winnerId = p1.id; }
  else { s1Score = 0; s2Score = 1; winnerId = p2.id; }

  const d1 = eloDelta(p1.elo, p2.elo, s1Score);
  const d2 = eloDelta(p2.elo, p1.elo, s2Score);
  const now = Date.now();

  queries.applyResult.run({
    id: p1.id, delta: d1, now,
    win: s1Score === 1 ? 1 : 0,
    loss: s1Score === 0 ? 1 : 0,
    draw: s1Score === 0.5 ? 1 : 0,
    mog: s1Score === 1 ? 1 : 0,
  });
  queries.applyResult.run({
    id: p2.id, delta: d2, now,
    win: s2Score === 1 ? 1 : 0,
    loss: s2Score === 0 ? 1 : 0,
    draw: s2Score === 0.5 ? 1 : 0,
    mog: s2Score === 1 ? 1 : 0,
  });
  queries.finishMatch.run({
    id: matchId,
    aPsl: s1.data.playerId === p1.id ? aPsl : bPsl,
    bPsl: s1.data.playerId === p1.id ? bPsl : aPsl,
    winner: winnerId,
    aDelta: d1, bDelta: d2, now,
  });

  s1.emit('match:result', {
    youWon: s1Score === 1, draw, opponentPsl: bPsl, yourPsl: aPsl,
    eloDelta: d1, newElo: p1.elo + d1, opponentEloDelta: d2,
  });
  s2.emit('match:result', {
    youWon: s2Score === 1, draw, opponentPsl: aPsl, yourPsl: bPsl,
    eloDelta: d2, newElo: p2.elo + d2, opponentEloDelta: d1,
  });

  s1.data.elo = p1.elo + d1;
  s2.data.elo = p2.elo + d2;
  s1.leave(matchId); s2.leave(matchId);
  s1.data.matchId = null; s2.data.matchId = null;
  s1.data.opponent = null; s2.data.opponent = null;
}

io.on('connection', (socket) => {
  socket.data.playerId = null;
  socket.data.handle = null;
  socket.data.elo = 1000;
  socket.data.psl = null;
  socket.data.matchId = null;
  socket.data.opponent = null;
  sockets.set(socket.id, socket);

  socket.on('player:hello', ({ playerId, handle }, ack) => {
    let id = typeof playerId === 'string' && /^[A-Za-z0-9_-]{8,32}$/.test(playerId) ? playerId : nanoid(16);
    let h = (handle || '').toString().slice(0, 24).replace(/[^A-Za-z0-9_\- ]/g, '').trim();
    if (!h) h = 'anon-' + id.slice(0, 4);
    const now = Date.now();
    queries.upsertPlayer.run({ id, handle: h, now });
    const p = queries.getPlayer.get(id);
    socket.data.playerId = id;
    socket.data.handle = h;
    socket.data.elo = p.elo;
    socket.data.psl = p.psl;
    ack?.({ playerId: id, handle: h, elo: p.elo, psl: p.psl, wins: p.wins, losses: p.losses, mogs: p.mogs });
  });

  socket.on('player:psl', ({ psl }) => {
    const v = Math.max(0, Math.min(10, parseFloat(psl)));
    if (!Number.isFinite(v) || !socket.data.playerId) return;
    socket.data.psl = v;
    queries.updatePsl.run({ id: socket.data.playerId, psl: v, now: Date.now() });
  });

  socket.on('queue:join', () => {
    if (!socket.data.playerId) return;
    if (socket.data.matchId) return;
    if (queue.some(e => e.id === socket.id)) return;
    queue.push({ id: socket.id, elo: socket.data.elo, joinedAt: Date.now() });
    socket.emit('queue:joined', { position: queue.length });
    pairFromQueue();
    startPairTimer();
  });

  socket.on('queue:leave', () => {
    const i = queue.findIndex(e => e.id === socket.id);
    if (i >= 0) queue.splice(i, 1);
    socket.emit('queue:left');
  });

  // WebRTC signaling — relay to opponent only
  socket.on('rtc:signal', (payload) => {
    const oppId = socket.data.opponent;
    if (!oppId) return;
    const opp = io.sockets.sockets.get(oppId);
    if (!opp) return;
    opp.emit('rtc:signal', payload);
  });

  socket.on('match:psl', ({ psl }) => {
    const oppId = socket.data.opponent;
    if (!oppId) return;
    const opp = io.sockets.sockets.get(oppId);
    if (!opp) return;
    socket.data.lastPsl = psl;
    opp.emit('match:opponent_psl', { psl });
  });

  socket.on('match:concede', () => {
    const matchId = socket.data.matchId;
    if (!matchId) return;
    const oppId = socket.data.opponent;
    const opp = oppId ? io.sockets.sockets.get(oppId) : null;
    if (opp) {
      endMatch(matchId, opp, socket, false, {
        aPsl: opp.data.lastPsl ?? null,
        bPsl: socket.data.lastPsl ?? null,
      });
    }
  });

  socket.on('match:finish', ({ aPsl, bPsl }) => {
    const matchId = socket.data.matchId;
    if (!matchId) return;
    const oppId = socket.data.opponent;
    const opp = oppId ? io.sockets.sockets.get(oppId) : null;
    if (!opp) return;
    // Coordinated finish: server compares both reported PSLs.
    // Only act when both clients sent the same match's payload.
    socket.data.finishPayload = { aPsl, bPsl };
    if (opp.data.finishPayload) {
      const myA = aPsl, myB = bPsl;
      const oppA = opp.data.finishPayload.bPsl;
      const oppB = opp.data.finishPayload.aPsl;
      // Average both perspectives for fairness.
      const meanA = (myA + oppA) / 2;
      const meanB = (myB + oppB) / 2;
      let winner = null, draw = false;
      if (Math.abs(meanA - meanB) < 0.05) draw = true;
      else if (meanA > meanB) winner = socket;
      else winner = opp;
      const loser = draw ? null : (winner === socket ? opp : socket);
      endMatch(matchId, winner, loser, draw, { aPsl: meanA, bPsl: meanB });
      socket.data.finishPayload = null;
      opp.data.finishPayload = null;
    }
  });

  socket.on('match:report', ({ reason }) => {
    const oppId = socket.data.opponent;
    const matchId = socket.data.matchId;
    console.warn('[report]', socket.data.playerId, '->', oppId, 'match', matchId, 'reason', String(reason || '').slice(0, 80));
    // Treat as concede for the reporter; opponent does not gain elo from abuse.
    if (matchId) {
      const opp = oppId ? io.sockets.sockets.get(oppId) : null;
      if (opp) {
        // Draw to neutralize; reporter leaves
        endMatch(matchId, null, null, true, { aPsl: null, bPsl: null });
      }
    }
  });

  socket.on('disconnect', () => {
    sockets.delete(socket.id);
    const i = queue.findIndex(e => e.id === socket.id);
    if (i >= 0) queue.splice(i, 1);
    const oppId = socket.data.opponent;
    const matchId = socket.data.matchId;
    if (matchId && oppId) {
      const opp = io.sockets.sockets.get(oppId);
      if (opp) {
        endMatch(matchId, opp, null, false, {
          aPsl: opp.data.lastPsl ?? null,
          bPsl: socket.data.lastPsl ?? null,
        });
        opp.emit('match:opponent_left');
      }
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`omoggle V2 listening on http://${HOST}:${PORT}`);
});

function shutdown() {
  console.log('shutting down...');
  io.close(() => server.close(() => { db.close(); process.exit(0); }));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
