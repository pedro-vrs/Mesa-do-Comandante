// Servidor de sala: guarda o estado de cada mesa, valida ações e manda a visão certa para cada jogador.
import express from 'express';
import { createServer } from 'node:http';
import { randomInt, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Server, Socket } from 'socket.io';
import { WebSocketServer, WebSocket } from 'ws';
import { customAlphabet } from 'nanoid';
import { addPlayer, newGame, removePlayer, RuleError, step, viewFor, Ctx } from '../shared/game.js';
import type { Action, DeckEntry, GameState, GameView } from '../shared/types.js';

const PORT = Number(process.env.PORT ?? 3000);
const roomCode = customAlphabet('abcdefghjkmnpqrstuvwxyz23456789', 6);
const engineCode = customAlphabet('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 10);

interface Room {
  state: GameState;
  history: { snapshot: string; actor: string }[];  // para desfazer
  seats: Map<string, string>;                       // chave secreta do jogador -> id do jogador
  sockets: Map<string, { playerId?: string }>;
  touched: number;
  // ---- modo XMage ----
  engineKey: string;                                     // segredo que o motor do anfitrião usa para se ligar
  engine: WebSocket | null;
  engineInfo: { status: string; error: string; version?: string };
  decks: Map<string, { name: string; entries: DeckEntry[] }>;
  xm: Map<string, { state?: unknown; prompt?: unknown; extra: unknown[] }>; // último estado/decisão por jogador
  xmLog: { id: number; user: string; text: string; type: string }[];
  xmStarted: boolean;
}

const rooms = new Map<string, Room>();

const ctx: Ctx = {
  rand: () => randomInt(0, 2 ** 32) / 2 ** 32,
  id: () => randomUUID().slice(0, 12),
  now: () => Date.now(),
};

function getRoom(id: string): Room {
  let r = rooms.get(id);
  if (!r) {
    r = {
      state: newGame(id, ''), history: [], seats: new Map(), sockets: new Map(), touched: Date.now(),
      engineKey: engineCode(), engine: null, engineInfo: { status: '', error: '' }, decks: new Map(), xm: new Map(), xmLog: [], xmStarted: false,
    };
    rooms.set(id, r);
  }
  r.touched = Date.now();
  return r;
}

// Mesas paradas por 12 horas são descartadas (plano grátis, memória curta).
setInterval(() => {
  const limit = Date.now() - 12 * 3600_000;
  for (const [id, r] of rooms) if (r.touched < limit && r.sockets.size === 0) rooms.delete(id);
}, 600_000).unref();

const NOT_UNDOABLE = new Set<Action['type']>(['chat', 'setReady', 'loadDeck', 'start', 'restart', 'settings']);

const app = express();
const http = createServer(app);
const io = new Server(http, { maxHttpBufferSize: 4e6, cors: { origin: process.env.DEV ? '*' : undefined } });

function broadcast(roomId: string) {
  const r = rooms.get(roomId);
  if (!r) return;
  const spectators = [...r.sockets.values()].filter(x => !x.playerId).length;
  for (const [sid, info] of r.sockets) {
    const last = r.history.at(-1);
    const view: GameView = {
      ...viewFor(r.state, info.playerId), you: info.playerId,
      canUndo: !!info.playerId && last?.actor === info.playerId, spectators,
      xmage: {
        connected: !!r.engine && r.engine.readyState === WebSocket.OPEN, status: r.engineInfo.status, error: r.engineInfo.error,
        version: r.engineInfo.version, key: info.playerId && info.playerId === r.state.hostId ? r.engineKey : undefined,
      },
    };
    io.to(sid).emit('state', view);
  }
}

io.on('connection', (socket: Socket) => {
  let roomId = '';

  socket.on('join', (msg: { roomId: string; name: string; key?: string; spectate?: boolean }, ack: (r: any) => void) => {
    try {
      roomId = String(msg.roomId || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
      if (!roomId) throw new RuleError('Código de mesa inválido.');
      const r = getRoom(roomId);
      socket.join(roomId);
      let playerId = msg.key ? r.seats.get(msg.key) : undefined;
      let key = msg.key;
      if (!playerId && !msg.spectate) {
        if (r.state.phase === 'lobby' && r.state.players.length < r.state.settings.maxPlayers) {
          key = randomUUID();
          playerId = randomUUID().slice(0, 8);
          addPlayer(r.state, playerId, msg.name);
          r.seats.set(key, playerId);
          r.state.version++;
        }
      } else if (playerId) {
        addPlayer(r.state, playerId, msg.name); // reconecta
      }
      r.sockets.set(socket.id, { playerId });
      ack({ ok: true, key, playerId, roomId });
      broadcast(roomId);
      if (r.state.phase === 'xmage') sendXmCache(r, socket.id, playerId);
    } catch (e) {
      ack({ ok: false, error: e instanceof RuleError ? e.message : 'Não foi possível entrar.' });
    }
  });

  socket.on('action', (a: Action, ack?: (r: any) => void) => {
    const r = rooms.get(roomId);
    const pid = r?.sockets.get(socket.id)?.playerId;
    if (!r || !pid) return ack?.({ ok: false, error: 'Você está assistindo esta mesa.' });
    if (a.type === 'start' && r.state.settings.mode === 'xmage') {
      try { startXmage(r, pid); ack?.({ ok: true }); broadcast(roomId); }
      catch (e) { ack?.({ ok: false, error: e instanceof RuleError ? e.message : 'Não foi possível começar no XMage.' }); }
      return;
    }
    if (a.type === 'restart' && r.state.phase === 'xmage') { r.engine?.send(JSON.stringify({ t: 'stop' })); r.xmStarted = false; r.xm.clear(); }
    if (a.type === 'loadDeck') r.decks.set(pid, { name: a.name, entries: a.entries });
    const before = JSON.stringify(r.state);
    try {
      step(r.state, pid, a, ctx);
      if (!NOT_UNDOABLE.has(a.type)) {
        r.history.push({ snapshot: before, actor: pid });
        if (r.history.length > 40) r.history.shift();
      } else if (a.type !== 'chat') r.history = [];
      r.touched = Date.now();
      ack?.({ ok: true });
      broadcast(roomId);
    } catch (e) {
      // ação recusada: volta ao estado de antes, inteiro (nada fica pela metade)
      r.state = JSON.parse(before);
      if (!(e instanceof RuleError)) console.error(e);
      ack?.({ ok: false, error: e instanceof RuleError ? e.message : 'Erro inesperado na mesa.', overridable: e instanceof RuleError && e.overridable });
    }
  });

  // Desfazer: só a última ação, e só por quem a fez (como o rollback do XMage, mas sob pedido).
  socket.on('undo', (ack?: (r: any) => void) => {
    const r = rooms.get(roomId);
    const pid = r?.sockets.get(socket.id)?.playerId;
    const last = r?.history.at(-1);
    if (!r || !pid || !last || last.actor !== pid) return ack?.({ ok: false, error: 'Nada para desfazer.' });
    r.history.pop();
    const restored: GameState = JSON.parse(last.snapshot);
    for (const p of restored.players) p.connected = r.state.players.find(q => q.id === p.id)?.connected ?? false;
    restored.version = r.state.version + 1;
    const name = restored.players.find(p => p.id === pid)?.name;
    restored.log.push({ id: (r.state.log.at(-1)?.id ?? 0) + 1, t: Date.now(), playerId: pid, text: `${name} desfez a última ação` });
    r.state = restored;
    ack?.({ ok: true });
    broadcast(roomId);
  });

  // Olhar as N cartas do topo: só quem pediu recebe as cartas.
  socket.on('peek', (n: number, ack: (r: any) => void) => {
    const r = rooms.get(roomId);
    const pid = r?.sockets.get(socket.id)?.playerId;
    const p = r?.state.players.find(q => q.id === pid);
    if (!r || !p || r.state.phase !== 'playing') return ack({ ok: false, error: 'Indisponível.' });
    const k = Math.max(1, Math.min(n === -1 ? 999 : n, p.zones.library.length));
    const cards = p.zones.library.slice(0, k).map(iid => r.state.cards[iid]);
    const what = n === -1 ? 'procurou no grimório' : `olhou as ${k} cartas do topo do grimório`;
    r.state.log.push({ id: (r.state.log.at(-1)?.id ?? 0) + 1, t: Date.now(), playerId: pid, text: `${p.name} ${what}` });
    r.state.version++;
    ack({ ok: true, cards });
    broadcast(roomId);
  });

  // ---- modo XMage: respostas do jogador vão para o motor ----
  socket.on('xmresp', (msg: { kind: string; value?: string | number | boolean | null }) => {
    const r = rooms.get(roomId);
    const pid = r?.sockets.get(socket.id)?.playerId;
    if (!r || !pid || !r.engine) return;
    const c = r.xm.get(pid);
    if (c) c.prompt = undefined;
    r.engine.send(JSON.stringify({ t: 'resp', pid, kind: String(msg.kind), value: msg.value === undefined || msg.value === null ? null : String(msg.value) }));
  });
  socket.on('xmchat', (text: string) => {
    const r = rooms.get(roomId);
    const pid = r?.sockets.get(socket.id)?.playerId;
    if (!r || !pid || !r.engine || typeof text !== 'string' || !text.trim()) return;
    r.engine.send(JSON.stringify({ t: 'chat', pid, text: text.trim().slice(0, 300) }));
  });
  socket.on('xmresync', () => {
    const r = rooms.get(roomId);
    const pid = r?.sockets.get(socket.id)?.playerId;
    if (!r) return;
    sendXmCache(r, socket.id, pid);
  });

  socket.on('disconnect', () => {
    const r = rooms.get(roomId);
    if (!r) return;
    const pid = r.sockets.get(socket.id)?.playerId;
    r.sockets.delete(socket.id);
    if (pid && ![...r.sockets.values()].some(x => x.playerId === pid)) {
      const p = r.state.players.find(q => q.id === pid);
      if (p) p.connected = false;
      // No lobby, quem sai some depois de 2 minutos sem voltar.
      if (r.state.phase === 'lobby') setTimeout(() => {
        const still = r.state.players.find(q => q.id === pid);
        if (still && !still.connected && r.state.phase === 'lobby') {
          removePlayer(r.state, pid);
          for (const [k, v] of r.seats) if (v === pid) r.seats.delete(k);
          r.state.version++; broadcast(roomId);
        }
      }, 120_000).unref();
    }
    broadcast(roomId);
  });
});

// ---------- motor do XMage (computador do anfitrião) ----------

function sendXmCache(r: Room, sid: string, pid?: string) {
  io.to(sid).emit('xmlog', r.xmLog.slice(-200));
  const c = pid ? r.xm.get(pid) : undefined;
  if (c?.state) io.to(sid).emit('xm', { kind: 'state', game: c.state });
  for (const e of c?.extra ?? []) io.to(sid).emit('xm', e);
  if (c?.prompt) io.to(sid).emit('xm', { kind: 'prompt', prompt: c.prompt });
}

function startXmage(r: Room, actor: string) {
  const s = r.state;
  if (actor !== s.hostId) throw new RuleError('Só quem criou a mesa começa a partida.');
  if (!r.engine || r.engine.readyState !== WebSocket.OPEN) throw new RuleError('O motor do XMage não está ligado. Abra o Motor da Mesa no seu computador.');
  if (s.players.length < 2) throw new RuleError('O XMage precisa de pelo menos 2 jogadores.');
  const missing = s.players.filter(p => !r.decks.has(p.id)).map(p => p.name);
  if (missing.length) throw new RuleError(`Falta escolher deck: ${missing.join(', ')}.`);
  const players = s.players.map(p => {
    const d = r.decks.get(p.id)!;
    return {
      pid: p.id, name: p.name,
      deck: { name: d.name, entries: d.entries.map(e => ({ name: e.data.name, set: e.data.set ?? '', num: e.data.num ?? '', count: e.count, commander: !!e.commander })) },
    };
  });
  r.xm.clear(); r.xmLog = []; r.xmStarted = false; r.engineInfo.error = '';
  r.engine.send(JSON.stringify({ t: 'start', players, life: s.settings.startingLife }));
  step(s, actor, { type: 'xmageStart' }, ctx);
}

function onEngineMessage(roomId: string, r: Room, raw: string) {
  let m: any;
  try { m = JSON.parse(raw); } catch { return; }
  switch (m.t) {
    case 'hello': r.engineInfo.version = String(m.version ?? ''); broadcast(roomId); break;
    case 'status': r.engineInfo.status = String(m.text ?? ''); broadcast(roomId); break;
    case 'error': {
      r.engineInfo.error = String(m.text ?? 'Erro no motor.');
      // se a partida nem chegou a começar, volta ao lobby para corrigir (deck, cartas...)
      if (r.state.phase === 'xmage' && !r.xmStarted) { r.state.phase = 'lobby'; r.state.version++; }
      broadcast(roomId);
      break;
    }
    case 'to': {
      const pid = String(m.pid);
      const { t: _t, pid: _p, ...body } = m;
      const c = r.xm.get(pid) ?? { extra: [] };
      if (body.kind === 'state') c.state = body.game;
      else if (body.kind === 'prompt') c.prompt = body.prompt;
      else if (body.kind === 'started') { r.xmStarted = true; r.engineInfo.error = ''; }
      else if (body.kind === 'over' || body.kind === 'result') { c.prompt = undefined; c.extra.push(body); }
      r.xm.set(pid, c);
      for (const [sid, info] of r.sockets) if (info.playerId === pid) io.to(sid).emit('xm', body);
      break;
    }
    case 'log': {
      const e = { id: (r.xmLog.at(-1)?.id ?? 0) + 1, user: String(m.user ?? ''), text: String(m.text ?? ''), type: String(m.type ?? '') };
      r.xmLog.push(e);
      if (r.xmLog.length > 400) r.xmLog.splice(0, r.xmLog.length - 400);
      io.to(roomId).emit('xmlog', [e]);
      break;
    }
  }
  r.touched = Date.now();
}

const engineWss = new WebSocketServer({ noServer: true, maxPayload: 8e6 });
http.on('upgrade', (req, sock, head) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/engine') return; // o socket.io cuida do resto
  const roomId = (url.searchParams.get('room') ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const r = rooms.get(roomId);
  engineWss.handleUpgrade(req, sock, head, ws => {
    if (!r || req.headers['x-engine-key'] !== r.engineKey) { ws.close(4401, 'chave invalida'); return; }
    if (r.engine && r.engine.readyState === WebSocket.OPEN) r.engine.close(4409, 'outro motor assumiu');
    r.engine = ws;
    r.engineInfo = { status: 'Motor ligado', error: '', version: undefined };
    ws.send(JSON.stringify({ t: 'welcome', room: roomId }));
    broadcast(roomId);
    ws.on('message', data => onEngineMessage(roomId, r, data.toString()));
    ws.on('close', () => {
      if (r.engine === ws) { r.engine = null; r.engineInfo.status = 'Motor desligado'; broadcast(roomId); }
    });
    ws.on('error', () => { /* o close vem em seguida */ });
  });
});

app.get('/api/new-room', (_req, res) => {
  let id = roomCode();
  while (rooms.has(id)) id = roomCode();
  res.json({ roomId: id });
});
app.get('/api/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
app.use(express.static(dist, { maxAge: '1h', index: false }));
app.get(/^\/(?!api|socket\.io).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));

http.listen(PORT, () => console.log(`Mesa no ar em http://localhost:${PORT}`));
