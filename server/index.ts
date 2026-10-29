// Servidor de sala: guarda o estado de cada mesa, valida ações e manda a visão certa para cada jogador.
import express from 'express';
import { createServer } from 'node:http';
import { randomInt, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Server, Socket } from 'socket.io';
import { customAlphabet } from 'nanoid';
import { addPlayer, newGame, removePlayer, RuleError, step, viewFor, Ctx } from '../shared/game.js';
import type { Action, GameState, GameView } from '../shared/types.js';

const PORT = Number(process.env.PORT ?? 3000);
const roomCode = customAlphabet('abcdefghjkmnpqrstuvwxyz23456789', 6);

interface Room {
  state: GameState;
  history: { snapshot: string; actor: string }[];  // para desfazer
  seats: Map<string, string>;                       // chave secreta do jogador -> id do jogador
  sockets: Map<string, { playerId?: string }>;
  touched: number;
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
    r = { state: newGame(id, ''), history: [], seats: new Map(), sockets: new Map(), touched: Date.now() };
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
    } catch (e) {
      ack({ ok: false, error: e instanceof RuleError ? e.message : 'Não foi possível entrar.' });
    }
  });

  socket.on('action', (a: Action, ack?: (r: any) => void) => {
    const r = rooms.get(roomId);
    const pid = r?.sockets.get(socket.id)?.playerId;
    if (!r || !pid) return ack?.({ ok: false, error: 'Você está assistindo esta mesa.' });
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
