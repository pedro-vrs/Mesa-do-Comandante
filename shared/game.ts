// Motor da mesa: aplica ações ao estado. Roda no servidor, que é a fonte da verdade.
// Regras automáticas inspiradas no XMage (GameImpl / GameCommanderImpl):
//  - derrota por vida <= 0, 10 venenos ou 21 de dano de um mesmo comandante (704.5a/c, 903.10a)
//  - imposto de comandante contado a cada conjuração da zona de comando (903.8)
//  - comandante indo para cemitério/exílio pergunta se volta à zona de comando (903.9a)
//  - contadores +1/+1 e -1/-1 se anulam (704.5q)
//  - tokens deixam de existir fora do campo (704.5d)
//  - desvirar e comprar automáticos; sem compra no 1º turno em partida de 2 (103.8a)
//  - modo prioridade: todos passam -> resolve o topo da pilha ou avança o passo (117.4)
//  - regras de turno e mana (opcional): 1 terreno por turno (305.2), velocidade de feitiço (307.1),
//    custo pago com mana e pagamento automático, reserva esvazia a cada passo (500.4),
//    enjoo de invocação para virar criaturas por mana (302.6)

import {
  Action, CardData, CardInst, GameState, PlayerState, PlayerZone, Settings, Step, STEPS,
  STEP_LABEL, ZONE_LABEL, ZoneName,
} from './types.js';
import { COLORS as MANA_COLORS, emptyPool, frontType, hasFlash, hasHaste, manaOptions, Mana, MANA, MANA_NAME, parseCost, planPayment, costToText } from './mana.js';

export const COLORS = ['#e4572e', '#3b82f6', '#22a06b', '#a855f7', '#f59e0b', '#ec4899'];
const PLAYER_ZONES: PlayerZone[] = ['library', 'hand', 'graveyard', 'exile', 'command'];
const PUBLIC_ZONES: ZoneName[] = ['battlefield', 'graveyard', 'exile', 'command', 'stack'];

export class RuleError extends Error {
  /** true = é uma regra da mesa que o jogador pode ignorar ("fazer assim mesmo"). */
  constructor(message: string, public overridable = false) { super(message); }
}

export interface Ctx {
  rand: () => number;   // [0,1)
  id: () => string;
  now: () => number;
}

export function newGame(roomId: string, hostId: string): GameState {
  return {
    roomId, version: 0, phase: 'lobby', hostId, players: [], cards: {}, battlefield: [], stack: [],
    turn: { number: 0, activeId: '', step: 'untap', priorityId: '', passed: [] },
    log: [],
    settings: { startingLife: 40, autoUntap: true, autoDraw: true, priority: false, enforce: true, mode: 'manual', maxPlayers: 6 },
  };
}

export function addPlayer(s: GameState, id: string, name: string): PlayerState {
  const existing = s.players.find(p => p.id === id);
  if (existing) { existing.connected = true; existing.name = name || existing.name; return existing; }
  if (s.phase !== 'lobby') throw new RuleError('A partida já começou.');
  if (s.players.length >= s.settings.maxPlayers) throw new RuleError('A mesa está cheia.');
  const used = new Set(s.players.map(p => p.color));
  const p: PlayerState = {
    id, name: name.trim().slice(0, 24) || `Jogador ${s.players.length + 1}`,
    color: COLORS.find(c => !used.has(c)) ?? COLORS[0],
    life: s.settings.startingLife, poison: 0, counters: {}, cmdDamage: {}, cmdCasts: {},
    lost: false, pool: emptyPool(), landsPlayed: 0, zones: emptyZones(), deckSize: 0, ready: false, connected: true, prompts: [],
  };
  s.players.push(p);
  if (!s.hostId) s.hostId = id;
  return p;
}

export function removePlayer(s: GameState, id: string) {
  if (s.phase !== 'lobby') return;
  const p = s.players.find(q => q.id === id);
  if (!p) return;
  for (const z of PLAYER_ZONES) for (const iid of p.zones[z]) delete s.cards[iid];
  s.players = s.players.filter(q => q.id !== id);
  if (s.hostId === id) s.hostId = s.players[0]?.id ?? '';
}

function emptyZones(): Record<PlayerZone, string[]> {
  return { library: [], hand: [], graveyard: [], exile: [], command: [] };
}

// ---------- utilidades ----------

export function player(s: GameState, id: string): PlayerState {
  const p = s.players.find(q => q.id === id);
  if (!p) throw new RuleError('Jogador não está na mesa.');
  return p;
}

function card(s: GameState, iid: string): CardInst {
  const c = s.cards[iid];
  if (!c) throw new RuleError('Carta não encontrada.');
  return c;
}

export function isType(c: CardInst | CardData, t: string): boolean {
  const line = 'data' in c ? c.data.typeLine : c.typeLine;
  return line.toLowerCase().includes(t.toLowerCase());
}

function num(v?: string): number { const n = parseInt(v ?? '', 10); return Number.isFinite(n) ? n : 0; }

/** P/R efetivos: base + modificador manual + contadores (camada 7, simplificada). */
export function effectivePT(c: CardInst): [number, number] | null {
  if (c.data.power === undefined && c.data.toughness === undefined) return null;
  const plus = c.counters['+1/+1'] ?? 0, minus = c.counters['-1/-1'] ?? 0;
  return [num(c.data.power) + c.ptMod[0] + plus - minus, num(c.data.toughness) + c.ptMod[1] + plus - minus];
}

function shuffle<T>(arr: T[], rand: () => number) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function log(s: GameState, ctx: Ctx, text: string, playerId?: string) {
  const id = (s.log.at(-1)?.id ?? 0) + 1;
  s.log.push({ id, t: ctx.now(), playerId, text });
  if (s.log.length > 300) s.log.splice(0, s.log.length - 300);
}

function zoneArray(s: GameState, c: CardInst): string[] {
  if (c.zone === 'battlefield') return s.battlefield;
  if (c.zone === 'stack') return s.stack;
  return player(s, c.ownerId).zones[c.zone];
}

function cardName(c: CardInst) { return c.faceDown ? 'uma carta virada para baixo' : c.data.name; }

function alive(s: GameState) { return s.players.filter(p => !p.lost); }

function nextAlive(s: GameState, fromId: string): string {
  const live = s.players.filter(p => !p.lost || p.id === fromId);
  const i = live.findIndex(p => p.id === fromId);
  for (let k = 1; k <= live.length; k++) {
    const p = live[(i + k) % live.length];
    if (!p.lost) return p.id;
  }
  return fromId;
}

// ---------- movimento de cartas ----------

interface MoveOpts { position?: 'top' | 'bottom'; x?: number; y?: number; faceDown?: boolean; toPlayer?: string; quiet?: boolean }

function moveCard(s: GameState, ctx: Ctx, actor: string, iid: string, to: ZoneName, o: MoveOpts = {}) {
  const c = card(s, iid);
  const from = c.zone;
  const wasFaceDown = c.faceDown;
  const fromArr = zoneArray(s, c);
  fromArr.splice(fromArr.indexOf(iid), 1);

  // Ao sair do campo: desanexa o que estava preso nela e reseta o estado da permanente.
  if (from === 'battlefield' && to !== 'battlefield') {
    for (const other of s.battlefield) if (s.cards[other]?.attachedTo === iid) s.cards[other].attachedTo = undefined;
    c.attachedTo = undefined; c.tapped = false; c.counters = {}; c.ptMod = [0, 0];
    c.controllerId = c.ownerId; c.transformed = false;
  }

  // 704.5d: token ou habilidade fora do campo/pilha deixa de existir.
  if ((c.token || c.ability) && to !== 'battlefield' && !(to === 'stack' && from === 'stack')) {
    delete s.cards[iid];
    if (!o.quiet && c.token) log(s, ctx, `${c.data.name} (token) deixou de existir`, actor);
    return;
  }

  // Cartas só vão para zonas do dono (cemitério, mão, grimório...).
  c.zone = to;
  c.faceDown = o.faceDown ?? (to === 'battlefield' ? c.faceDown : false);
  if (to === 'battlefield') {
    if (from !== 'battlefield') { c.controllerId = o.toPlayer ?? actor; c.enteredTurn = s.turn.number; }
    if (from === 'hand' && isLand(c) && !c.faceDown) player(s, actor).landsPlayed++;
    if (o.x !== undefined) c.x = clamp01(o.x);
    if (o.y !== undefined) c.y = clamp01(o.y);
    if (from !== 'battlefield') s.battlefield.push(iid);
    else s.battlefield.push(iid); // trazer para frente
  } else if (to === 'stack') {
    c.controllerId = actor;
    s.stack.push(iid);
  } else {
    const arr = player(s, c.ownerId).zones[to];
    if (o.position === 'bottom') arr.push(iid); else arr.unshift(iid);
  }

  const p = player(s, c.ownerId);

  // 903.8: imposto de comandante.
  if (c.isCommander && from === 'command' && (to === 'stack' || to === 'battlefield')) {
    p.cmdCasts[iid] = (p.cmdCasts[iid] ?? 0) + 1;
    const next = p.cmdCasts[iid] * 2;
    log(s, ctx, `${p.name} conjurou ${c.data.name} da zona de comando (próximo imposto: +${next})`, actor);
  } else if (!o.quiet && from !== to) {
    const hiddenMove = (from === 'library' || from === 'hand') && (to === 'library' || to === 'hand');
    const shown = hiddenMove || (wasFaceDown && c.faceDown) || (to === 'battlefield' && c.faceDown)
      ? 'uma carta' : c.data.name;
    const where = to === 'library' ? `${o.position === 'bottom' ? 'o fundo' : 'o topo'} do grimório` : ZONE_LABEL[to];
    const verb = to === 'stack' ? 'conjurou' : 'moveu';
    log(s, ctx, to === 'stack'
      ? `${player(s, actor).name} conjurou ${shown}`
      : `${player(s, actor).name} ${verb} ${shown} de ${ZONE_LABEL[from]} para ${where}`, actor);
  }

  // 903.9a/b: comandante em cemitério ou exílio (ou mão/grimório, regra antiga do XMage) -> pergunta ao dono.
  if (c.isCommander && ['graveyard', 'exile', 'hand', 'library'].includes(to)) {
    p.prompts = p.prompts.filter(q => q.iid !== iid);
    p.prompts.push({ id: ctx.id(), kind: 'commander-zone', iid, from: to });
  }
  if (s.settings.priority && to === 'stack') resetPasses(s, actor);
}

function clamp01(v: number) { return Math.max(0, Math.min(1, v)); }

function draw(s: GameState, ctx: Ctx, pid: string, n: number, quiet = false) {
  const p = player(s, pid);
  let drawn = 0;
  for (let i = 0; i < n; i++) {
    const top = p.zones.library[0];
    if (!top) {
      log(s, ctx, `${p.name} tentou comprar de um grimório vazio`, pid);
      lose(s, ctx, p, 'comprou de um grimório vazio');
      break;
    }
    moveCard(s, ctx, pid, top, 'hand', { quiet: true });
    drawn++;
  }
  if (!quiet && drawn) log(s, ctx, `${p.name} comprou ${drawn} carta${drawn > 1 ? 's' : ''}`, pid);
}

// ---------- vitória e derrota ----------

function lose(s: GameState, ctx: Ctx, p: PlayerState, reason: string) {
  if (p.lost) return;
  p.lost = true; p.lossReason = reason;
  log(s, ctx, `${p.name} perdeu: ${reason}`, p.id);
  checkWinner(s, ctx);
  if (s.phase === 'playing' && s.turn.activeId === p.id) passTurnTo(s, ctx, nextAlive(s, p.id));
  else if (s.turn.priorityId === p.id) s.turn.priorityId = nextAlive(s, p.id);
}

function checkWinner(s: GameState, ctx: Ctx) {
  const live = alive(s);
  if (s.phase === 'playing' && s.players.length > 1 && live.length === 1) {
    s.phase = 'over'; s.winnerId = live[0].id;
    log(s, ctx, `${live[0].name} venceu a partida!`);
  } else if (s.phase === 'playing' && live.length === 0) {
    s.phase = 'over'; log(s, ctx, 'A partida terminou empatada.');
  }
}

/** Ações baseadas em estado que a mesa aplica sozinha (as que não exigem ler texto de carta). */
export function stateBasedActions(s: GameState, ctx: Ctx) {
  if (s.phase !== 'playing') return;
  for (const p of s.players) {
    if (p.lost) continue;
    if (p.life <= 0) lose(s, ctx, p, 'vida chegou a 0');
    else if (p.poison >= 10) lose(s, ctx, p, '10 marcadores de veneno');
    else {
      for (const [cmd, dmg] of Object.entries(p.cmdDamage)) {
        if (dmg >= 21) { lose(s, ctx, p, `21 de dano do comandante ${s.cards[cmd]?.data.name ?? ''}`.trim()); break; }
      }
    }
  }
  // 704.5q: contadores +1/+1 e -1/-1 se anulam.
  for (const iid of s.battlefield) {
    const c = s.cards[iid];
    const a = c.counters['+1/+1'] ?? 0, b = c.counters['-1/-1'] ?? 0;
    if (a && b) {
      const m = Math.min(a, b);
      setCounter(c, '+1/+1', a - m); setCounter(c, '-1/-1', b - m);
    }
  }
}

/** Avisos que a mesa mostra mas deixa o jogador decidir (o texto da carta pode mudar a regra). */
export interface Warning { iid?: string; playerId: string; text: string }
export function warnings(s: GameState): Warning[] {
  const out: Warning[] = [];
  const legends = new Map<string, string[]>();
  for (const iid of s.battlefield) {
    const c = s.cards[iid];
    if (!c || c.faceDown) continue;
    const pt = effectivePT(c);
    if (isType(c, 'creature') && pt && pt[1] <= 0)
      out.push({ iid, playerId: c.controllerId, text: `${c.data.name} tem resistência ${pt[1]} e deveria ir para o cemitério` });
    if (isType(c, 'planeswalker') && (c.counters['loyalty'] ?? num(c.data.loyalty)) <= 0 && 'loyalty' in c.counters)
      out.push({ iid, playerId: c.controllerId, text: `${c.data.name} está sem lealdade` });
    if (isType(c, 'aura') && !c.attachedTo)
      out.push({ iid, playerId: c.controllerId, text: `${c.data.name} é uma aura sem estar anexada a nada` });
    if (isType(c, 'legendary') && !c.token) {
      const key = `${c.controllerId}|${c.data.name}`;
      legends.set(key, [...(legends.get(key) ?? []), iid]);
    }
  }
  for (const [key, ids] of legends) if (ids.length > 1)
    out.push({ iid: ids[1], playerId: key.split('|')[0], text: `Regra da lenda: ${ids.length} cópias de ${s.cards[ids[0]].data.name}` });
  return out;
}

function setCounter(c: CardInst, kind: string, v: number) {
  if (v <= 0) delete c.counters[kind]; else c.counters[kind] = v;
}

// ---------- turno e prioridade ----------

function resetPasses(s: GameState, actor: string) {
  s.turn.passed = [];
  s.turn.priorityId = actor;
}

function enterStep(s: GameState, ctx: Ctx, step: Step) {
  s.turn.step = step;
  for (const p of s.players) p.pool = emptyPool();   // 500.4: a reserva de mana esvazia entre passos
  s.turn.passed = [];
  s.turn.priorityId = s.turn.activeId;
  const active = player(s, s.turn.activeId);
  if (step === 'untap') {
    if (s.settings.autoUntap) {
      for (const iid of s.battlefield) if (s.cards[iid].controllerId === active.id) s.cards[iid].tapped = false;
    }
    enterStep(s, ctx, 'upkeep'); // ninguém recebe prioridade no desvirar (502.4)
    return;
  }
  if (step === 'draw' && s.settings.autoDraw) {
    const firstTurnSkip = s.turn.number === 1 && s.players.length === 2;
    if (!firstTurnSkip) draw(s, ctx, active.id, 1);
  }
  if (step === 'cleanup') {
    // 514: o dano marcado some e efeitos "até o fim do turno" acabam (modificadores manuais de P/R).
    for (const iid of s.battlefield) s.cards[iid].ptMod = [0, 0];
  }
}

function passTurnTo(s: GameState, ctx: Ctx, pid: string) {
  s.turn.number += 1;
  for (const p of s.players) p.landsPlayed = 0;
  s.turn.activeId = pid;
  log(s, ctx, `Turno ${s.turn.number}: ${player(s, pid).name}`);
  enterStep(s, ctx, 'untap');
}

function nextStep(s: GameState, ctx: Ctx) {
  const i = STEPS.indexOf(s.turn.step);
  if (s.turn.step === 'cleanup') passTurnTo(s, ctx, nextAlive(s, s.turn.activeId));
  else enterStep(s, ctx, STEPS[i + 1]);
}

function resolveTop(s: GameState, ctx: Ctx, actor: string) {
  const iid = s.stack.at(-1);
  if (!iid) throw new RuleError('A pilha está vazia.');
  const c = s.cards[iid];
  if (c.ability) {
    s.stack.pop(); delete s.cards[iid];
    log(s, ctx, `Resolveu: ${c.data.name}`, actor);
  } else if (isType(c, 'instant') || isType(c, 'sorcery')) {
    moveCard(s, ctx, c.controllerId, iid, 'graveyard', { quiet: true });
    log(s, ctx, `Resolveu ${c.data.name}`, actor);
  } else {
    const n = s.battlefield.filter(x => s.cards[x].controllerId === c.controllerId).length;
    moveCard(s, ctx, c.controllerId, iid, 'battlefield', { quiet: true, x: 0.06 + (n % 9) * 0.105, y: isType(c, 'land') ? 0.7 : 0.08 });
    log(s, ctx, `${c.data.name} resolveu e entrou no campo`, actor);
  }
  s.turn.passed = [];
  s.turn.priorityId = s.turn.activeId;
}

// ---------- regras de turno e mana ----------

export function isLand(c: CardInst) { return frontType(c.data.typeLine).toLowerCase().includes('land'); }
function isMain(s: GameState) { return s.turn.step === 'main1' || s.turn.step === 'main2'; }

export function commanderIdentity(s: GameState, pid: string): string[] {
  const ids = Object.values(s.cards).filter(c => c.ownerId === pid && c.isCommander).flatMap(c => c.data.colorIdentity);
  return ids.length ? [...new Set(ids)] : [...MANA_COLORS];
}

export function summoningSick(s: GameState, c: CardInst) {
  return isType(c, 'creature') && c.enteredTurn === s.turn.number && !hasHaste(c.data.oracle);
}

/** Fontes de mana que o jogador pode virar agora. */
export function manaSources(s: GameState, pid: string) {
  const identity = commanderIdentity(s, pid);
  return s.battlefield.map(i => s.cards[i])
    .filter(c => c && c.controllerId === pid && !c.tapped && !summoningSick(s, c))
    .map(c => ({ iid: c.iid, options: manaOptions(c, identity) }))
    .filter(x => x.options.length);
}

function checkTiming(s: GameState, actor: string, c: CardInst, to: ZoneName, a: { faceDown?: boolean }) {
  const name = c.data.name;
  if (to === 'battlefield' && c.zone === 'hand' && isLand(c)) {
    if (s.turn.activeId !== actor) throw new RuleError('Só dá para baixar terreno no seu turno.', true);
    if (!isMain(s) || s.stack.length) throw new RuleError('Terreno só na sua fase principal, com a pilha vazia.', true);
    if (player(s, actor).landsPlayed >= 1) throw new RuleError('Você já baixou um terreno neste turno.', true);
    return;
  }
  if (to === 'battlefield' && (c.zone === 'hand' || c.zone === 'command') && !a.faceDown)
    throw new RuleError(`${name} precisa ser conjurada: arraste para a pilha ou dê duplo clique.`, true);
  if (to === 'stack' && !c.ability && c.zone !== 'battlefield' && c.zone !== 'stack') {
    if (isLand(c)) throw new RuleError('Terreno não se conjura: baixe direto no campo.', true);
    const instant = frontType(c.data.typeLine).toLowerCase().includes('instant') || hasFlash(c.data.oracle);
    if (!instant && !(s.turn.activeId === actor && isMain(s) && s.stack.length === 0))
      throw new RuleError(`${name} só pode ser conjurada na sua fase principal, com a pilha vazia.`, true);
  }
}

/** Paga o custo da carta: usa a reserva e vira as fontes que faltarem (pagamento automático). */
function payFor(s: GameState, ctx: Ctx, actor: string, c: CardInst, xValue?: number) {
  const p = player(s, actor);
  const cost = parseCost(c.data.manaCost);
  const tax = c.isCommander && c.zone === 'command' ? (p.cmdCasts[c.iid] ?? 0) * 2 : 0;
  if (cost.x && (xValue === undefined || xValue < 0)) throw new RuleError(`Diga o valor de X para conjurar ${c.data.name}.`);
  const plan = planPayment(cost, xValue ?? 0, tax, p.pool as any, manaSources(s, actor), p.life);
  const text = costToText(cost, xValue ?? 0, tax);
  if ('missing' in plan)
    throw new RuleError(`Mana insuficiente para ${c.data.name} (${text}): falta ${plan.missing}. Vire outras fontes primeiro, ou passe por cima se uma carta deixa mais barato.`, true);
  for (const t of plan.taps) s.cards[t.iid].tapped = true;
  p.pool = plan.pool;
  p.life -= plan.life;
  if (text !== '{0}' || plan.life)
    log(s, ctx, `${p.name} pagou ${text}${plan.taps.length ? ` virando ${plan.taps.map(t => s.cards[t.iid].data.name).join(', ')}` : ''}${plan.life ? ` e ${plan.life} de vida` : ''}`, actor);
}

// ---------- permissões ----------

function assertTurnOwner(s: GameState, actor: string) {
  if (s.turn.activeId !== actor) throw new RuleError('Só o jogador ativo avança o turno.');
}

function assertCanTouch(s: GameState, actor: string, c: CardInst) {
  if (c.zone === 'battlefield' || c.zone === 'stack') {
    if (c.controllerId !== actor) throw new RuleError(`${cardName(c)} é controlada por outro jogador.`);
  } else if (c.ownerId !== actor) {
    throw new RuleError('Essa carta é de outro jogador.');
  }
}

// ---------- redutor ----------

export function apply(s: GameState, actor: string, a: Action, ctx: Ctx): void {
  const me = player(s, actor);
  if (s.phase === 'xmage' && !['chat', 'restart'].includes(a.type))
    throw new RuleError('A partida está acontecendo no motor do XMage.');
  const playing = s.phase === 'playing';
  const lobbyOnly = ['loadDeck', 'setReady', 'start', 'settings', 'xmageStart'];
  if (!playing && !lobbyOnly.includes(a.type) && !['chat', 'restart'].includes(a.type))
    throw new RuleError(s.phase === 'lobby' ? 'A partida ainda não começou.' : 'A partida acabou.');
  if (playing && me.lost && !['chat', 'rejoin'].includes(a.type))
    throw new RuleError('Você está fora desta partida.');

  switch (a.type) {
    case 'loadDeck': {
      if (s.phase !== 'lobby') throw new RuleError('Troque de deck antes de começar.');
      for (const z of PLAYER_ZONES) { for (const iid of me.zones[z]) delete s.cards[iid]; me.zones[z] = []; }
      let total = 0;
      for (const e of a.entries) {
        const count = Math.max(1, Math.min(250, Math.floor(e.count)));
        for (let i = 0; i < count; i++) {
          const iid = ctx.id();
          s.cards[iid] = blankCard(iid, actor, e.data, e.commander ? 'command' : 'library');
          if (e.commander) s.cards[iid].isCommander = true;
          me.zones[e.commander ? 'command' : 'library'].push(iid);
          total++;
        }
      }
      if (total > 400) throw new RuleError('Deck grande demais.');
      me.deckName = a.name.slice(0, 60); me.deckSize = total; me.ready = false;
      log(s, ctx, `${me.name} escolheu o deck ${me.deckName} (${total} cartas)`, actor);
      return;
    }
    case 'setReady': me.ready = a.ready; return;
    case 'settings': {
      if (actor !== s.hostId) throw new RuleError('Só quem criou a mesa muda as opções.');
      const allowed: (keyof Settings)[] = ['startingLife', 'autoUntap', 'autoDraw', 'priority', 'enforce', 'mode'];
      if (a.settings.mode && s.phase !== 'lobby') throw new RuleError('O modo da mesa só muda no lobby.');
      for (const k of allowed) if (a.settings[k] !== undefined) (s.settings as any)[k] = a.settings[k];
      s.settings.startingLife = Math.max(1, Math.min(999, Math.floor(s.settings.startingLife)));
      if (s.phase === 'lobby') for (const p of s.players) p.life = s.settings.startingLife;
      return;
    }
    case 'start': {
      if (actor !== s.hostId) throw new RuleError('Só quem criou a mesa começa a partida.');
      if (s.phase !== 'lobby') throw new RuleError('A partida já começou.');
      const missing = s.players.filter(p => p.deckSize === 0).map(p => p.name);
      if (missing.length) throw new RuleError(`Falta escolher deck: ${missing.join(', ')}.`);
      s.phase = 'playing';
      for (const p of s.players) {
        p.life = s.settings.startingLife; p.poison = 0; p.cmdDamage = {}; p.cmdCasts = {}; p.lost = false;
        shuffle(p.zones.library, ctx.rand);
        draw(s, ctx, p.id, 7, true);
      }
      const first = s.players[Math.floor(ctx.rand() * s.players.length)];
      log(s, ctx, `Partida começou. Sorteio: ${first.name} começa.`);
      s.turn = { number: 0, activeId: first.id, step: 'untap', priorityId: first.id, passed: [] };
      passTurnTo(s, ctx, first.id);
      return;
    }
    case 'restart': {
      if (actor !== s.hostId) throw new RuleError('Só quem criou a mesa reinicia.');
      // Devolve todas as cartas aos donos e volta ao lobby, mantendo os decks.
      for (const iid of Object.keys(s.cards)) {
        const c = s.cards[iid];
        if (c.token || c.ability) { delete s.cards[iid]; continue; }
        Object.assign(c, blankCard(iid, c.ownerId, c.data, c.isCommander ? 'command' : 'library'), { isCommander: c.isCommander });
      }
      s.battlefield = []; s.stack = [];
      for (const p of s.players) {
        p.zones = emptyZones();
        for (const c of Object.values(s.cards)) if (c.ownerId === p.id) p.zones[c.zone as PlayerZone].push(c.iid);
        p.lost = false; p.lossReason = undefined; p.life = s.settings.startingLife; p.poison = 0;
        p.cmdDamage = {}; p.cmdCasts = {}; p.counters = {}; p.prompts = []; p.ready = false;
        p.pool = emptyPool(); p.landsPlayed = 0;
      }
      s.phase = 'lobby'; s.winnerId = undefined;
      log(s, ctx, `${me.name} voltou a mesa para o lobby`, actor);
      return;
    }
    case 'xmageStart': {
      // só o servidor manda esta ação, depois de entregar os decks ao motor
      if (actor !== s.hostId) throw new RuleError('Só quem criou a mesa começa a partida.');
      s.phase = 'xmage';
      log(s, ctx, 'Partida enviada ao motor do XMage.');
      return;
    }
    case 'draw': draw(s, ctx, actor, Math.max(1, Math.min(20, a.n))); return;
    case 'shuffle':
      shuffle(me.zones.library, ctx.rand);
      log(s, ctx, `${me.name} embaralhou o grimório`, actor); return;
    case 'mulligan': {
      // Mulligan de Londres (103.5): embaralha a mão no grimório e compra 7; o jogador põe cartas no fundo depois.
      const n = me.zones.hand.length;
      for (const iid of [...me.zones.hand]) moveCard(s, ctx, actor, iid, 'library', { quiet: true });
      shuffle(me.zones.library, ctx.rand);
      draw(s, ctx, actor, 7, true);
      me.counters['mulligan'] = (me.counters['mulligan'] ?? 0) + 1;
      log(s, ctx, `${me.name} fez mulligan (${me.counters['mulligan']}º) e comprou 7 — devolvia ${n}`, actor);
      return;
    }
    case 'move': {
      if (!a.iids.length) return;
      const toPlayer = a.toPlayer && player(s, a.toPlayer).id;
      if (a.force) log(s, ctx, `${me.name} passou por cima de uma regra da mesa`, actor);
      for (const iid of a.iids) {
        const c = card(s, iid);
        assertCanTouch(s, actor, c);
        if (s.settings.enforce && !a.force) {
          checkTiming(s, actor, c, a.to, a);
          if (a.to === 'stack' && !c.ability && c.zone !== 'battlefield' && c.zone !== 'stack') payFor(s, ctx, actor, c, a.xValue);
        }
        // Zonas privadas e cemitério/exílio sempre são do dono; no campo, o destino escolhido vira controlador.
        moveCard(s, ctx, actor, iid, a.to, { position: a.position, x: a.x, y: a.y, faceDown: a.faceDown, toPlayer });
      }
      return;
    }
    case 'tap': {
      const identity = commanderIdentity(s, actor);
      const made: string[] = [];
      for (const iid of a.iids) {
        const c = card(s, iid);
        if (c.zone !== 'battlefield') continue;
        assertCanTouch(s, actor, c);
        const tapping = (a.value ?? !c.tapped) && !c.tapped;
        if (tapping && s.settings.enforce) {
          const opts = manaOptions(c, identity);
          if (opts.length) {
            if (summoningSick(s, c) && !a.force)
              throw new RuleError(`${c.data.name} entrou neste turno e ainda não pode ser virada (enjoo de invocação).`, true);
            const chosen = opts.length === 1 ? opts[0] : opts.find(o => o.join('') === a.mana);
            if (chosen) { for (const m of chosen) me.pool[m]++; made.push(chosen.map(m => `{${m}}`).join('')); }
          }
        }
        c.tapped = a.value ?? !c.tapped;
      }
      if (a.iids.length === 1) {
        const c = s.cards[a.iids[0]];
        if (c) log(s, ctx, `${me.name} ${c.tapped ? 'virou' : 'desvirou'} ${cardName(c)}${made.length ? ` (+${made[0]})` : ''}`, actor);
      } else if (made.length) log(s, ctx, `${me.name} virou ${a.iids.length} permanentes (+${made.join('')})`, actor);
      return;
    }
    case 'addMana': {
      const m = a.mana.toUpperCase() as Mana;
      if (!MANA.includes(m)) throw new RuleError('Tipo de mana inválido.');
      me.pool[m] = Math.max(0, me.pool[m] + a.delta);
      log(s, ctx, `${me.name} ${a.delta > 0 ? 'adicionou' : 'tirou'} mana ${MANA_NAME[m]} ${a.delta > 0 ? 'à' : 'da'} reserva (${me.pool[m]})`, actor);
      return;
    }
    case 'untapAll':
      for (const iid of s.battlefield) if (s.cards[iid].controllerId === actor) s.cards[iid].tapped = false;
      log(s, ctx, `${me.name} desvirou tudo`, actor); return;
    case 'transform': {
      const c = card(s, a.iid); assertCanTouch(s, actor, c);
      if (!c.data.imageBack) throw new RuleError(`${c.data.name} não tem outra face.`);
      c.transformed = !c.transformed;
      log(s, ctx, `${me.name} transformou ${c.transformed ? c.data.name : c.data.backName}`, actor); return;
    }
    case 'faceDown': {
      const c = card(s, a.iid); assertCanTouch(s, actor, c);
      c.faceDown = a.value ?? !c.faceDown;
      log(s, ctx, `${me.name} ${c.faceDown ? 'virou uma carta para baixo' : `revelou ${c.data.name}`}`, actor); return;
    }
    case 'counter': {
      const c = card(s, a.iid); assertCanTouch(s, actor, c);
      const kind = a.kind.trim().slice(0, 20) || '+1/+1';
      setCounter(c, kind, (c.counters[kind] ?? 0) + a.delta);
      log(s, ctx, `${me.name} ${a.delta > 0 ? 'pôs' : 'tirou'} ${Math.abs(a.delta)} marcador ${kind} ${a.delta > 0 ? 'em' : 'de'} ${cardName(c)}`, actor);
      return;
    }
    case 'pt': {
      const c = card(s, a.iid); assertCanTouch(s, actor, c);
      c.ptMod = [c.ptMod[0] + a.dp, c.ptMod[1] + a.dt];
      const pt = effectivePT(c);
      log(s, ctx, `${cardName(c)} agora é ${pt ? `${pt[0]}/${pt[1]}` : `${c.ptMod[0]}/${c.ptMod[1]}`} até o fim do turno`, actor);
      return;
    }
    case 'attach': {
      const c = card(s, a.iid); assertCanTouch(s, actor, c);
      if (a.to) {
        const t = card(s, a.to);
        if (t.zone !== 'battlefield' || c.zone !== 'battlefield') throw new RuleError('As duas cartas precisam estar no campo.');
        if (t.iid === c.iid) throw new RuleError('Uma carta não se anexa a ela mesma.');
        c.attachedTo = t.iid;
        log(s, ctx, `${me.name} anexou ${cardName(c)} a ${cardName(t)}`, actor);
      } else { c.attachedTo = undefined; log(s, ctx, `${me.name} desanexou ${cardName(c)}`, actor); }
      return;
    }
    case 'control': {
      const c = card(s, a.iid); assertCanTouch(s, actor, c);
      if (c.zone !== 'battlefield') throw new RuleError('Só permanentes trocam de controlador.');
      const to = player(s, a.to);
      c.controllerId = to.id; c.attachedTo = undefined;
      log(s, ctx, `${me.name} deu o controle de ${cardName(c)} para ${to.name}`, actor);
      return;
    }
    case 'token': {
      const count = Math.max(1, Math.min(30, Math.floor(a.count)));
      const data: CardData = {
        sid: a.data.sid ?? `token-${a.data.name}`, name: a.data.name.slice(0, 40), typeLine: a.data.typeLine ?? 'Token Creature',
        manaCost: '', cmc: 0, oracle: a.data.oracle ?? '', power: a.data.power, toughness: a.data.toughness,
        colorIdentity: [], image: a.data.image,
      };
      for (let i = 0; i < count; i++) {
        const iid = ctx.id();
        const c = blankCard(iid, actor, data, 'battlefield');
        c.token = true; c.x = clamp01((a.x ?? 0.4) + i * 0.03); c.y = clamp01((a.y ?? 0.35) + i * 0.03);
        s.cards[iid] = c; s.battlefield.push(iid);
      }
      log(s, ctx, `${me.name} criou ${count} token${count > 1 ? 's' : ''} ${data.name}${data.power !== undefined ? ` ${data.power}/${data.toughness}` : ''}`, actor);
      return;
    }
    case 'clone': {
      const src = card(s, a.iid);
      if (src.zone !== 'battlefield') throw new RuleError('Só dá para copiar uma permanente.');
      const iid = ctx.id();
      const c = blankCard(iid, actor, src.data, 'battlefield');
      c.token = true; c.x = clamp01(src.x + 0.04); c.y = clamp01(src.y + 0.04);
      s.cards[iid] = c; s.battlefield.push(iid);
      log(s, ctx, `${me.name} criou uma cópia token de ${src.data.name}`, actor); return;
    }
    case 'ability': {
      const text = a.text.trim().slice(0, 140);
      if (!text) throw new RuleError('Descreva a habilidade.');
      const src = a.sourceIid ? s.cards[a.sourceIid] : undefined;
      const iid = ctx.id();
      const c = blankCard(iid, actor, {
        sid: 'ability', name: src ? `${src.data.name}: ${text}` : text, typeLine: 'Habilidade', manaCost: '', cmc: 0,
        oracle: text, colorIdentity: [], image: src && !src.faceDown ? (src.transformed ? src.data.imageBack : src.data.image) : undefined,
      }, 'stack');
      c.ability = true; s.cards[iid] = c; s.stack.push(iid);
      log(s, ctx, `${me.name} pôs na pilha: ${c.data.name}`, actor);
      if (s.settings.priority) resetPasses(s, actor);
      return;
    }
    case 'resolve': {
      const top = s.stack.at(-1);
      if (!top) throw new RuleError('A pilha está vazia.');
      if (s.settings.priority && s.cards[top].controllerId !== actor && s.turn.activeId !== actor)
        throw new RuleError('No modo prioridade, a pilha resolve quando todos passam.');
      resolveTop(s, ctx, actor); return;
    }
    case 'life':
      me.life += a.delta;
      log(s, ctx, `${me.name} ${a.delta >= 0 ? 'ganhou' : 'perdeu'} ${Math.abs(a.delta)} de vida (${me.life})`, actor); return;
    case 'playerCounter': {
      const kind = a.kind.trim().slice(0, 20);
      if (kind === 'poison') me.poison = Math.max(0, me.poison + a.delta);
      else me.counters[kind] = Math.max(0, (me.counters[kind] ?? 0) + a.delta);
      const v = kind === 'poison' ? me.poison : me.counters[kind];
      log(s, ctx, `${me.name}: ${kind === 'poison' ? 'veneno' : kind} ${v}`, actor); return;
    }
    case 'cmdDamage': {
      // 903.10a: dano de comandante também é dano normal, então mexe na vida junto.
      const cmd = card(s, a.commanderIid);
      if (!cmd.isCommander) throw new RuleError('Essa carta não é um comandante.');
      const before = me.cmdDamage[cmd.iid] ?? 0;
      const after = Math.max(0, before + a.delta);
      me.cmdDamage[cmd.iid] = after;
      me.life -= after - before;
      log(s, ctx, `${me.name} sofreu ${after - before} de dano de ${cmd.data.name} (${after}/21, vida ${me.life})`, actor);
      return;
    }
    case 'prompt': {
      const pr = me.prompts.find(q => q.id === a.promptId);
      if (!pr) return;
      me.prompts = me.prompts.filter(q => q.id !== a.promptId);
      const c = s.cards[pr.iid];
      if (a.accept && c && c.zone === pr.from) {
        moveCard(s, ctx, actor, c.iid, 'command', { quiet: true });
        me.prompts = me.prompts.filter(q => q.iid !== c.iid);
        log(s, ctx, `${me.name} devolveu ${c.data.name} à zona de comando`, actor);
      }
      return;
    }
    case 'nextStep': assertTurnOwner(s, actor); nextStep(s, ctx); return;
    case 'setStep': {
      assertTurnOwner(s, actor);
      const target = STEPS.indexOf(a.step), cur = STEPS.indexOf(s.turn.step);
      if (target < 0) throw new RuleError('Passo inválido.');
      if (target <= cur) { s.turn.step = a.step; s.turn.passed = []; return; } // voltar: só corrige o marcador
      while (STEPS.indexOf(s.turn.step) < target && s.turn.activeId === actor) nextStep(s, ctx);
      return;
    }
    case 'endTurn': {
      assertTurnOwner(s, actor);
      enterStep(s, ctx, 'cleanup');
      passTurnTo(s, ctx, nextAlive(s, actor));
      return;
    }
    case 'pass': {
      if (!s.settings.priority) throw new RuleError('O modo prioridade está desligado.');
      if (s.turn.priorityId !== actor) throw new RuleError('Você não tem prioridade agora.');
      if (!s.turn.passed.includes(actor)) s.turn.passed.push(actor);
      const everyone = alive(s).every(p => s.turn.passed.includes(p.id));
      if (!everyone) { s.turn.priorityId = nextAlive(s, actor); return; }
      if (s.stack.length) resolveTop(s, ctx, actor);
      else nextStep(s, ctx);
      return;
    }
    case 'concede': lose(s, ctx, me, 'desistiu'); return;
    case 'rejoin': {
      if (!me.lost) return;
      me.lost = false; me.lossReason = undefined;
      log(s, ctx, `${me.name} voltou para a partida`, actor); return;
    }
    case 'chat': {
      const text = a.text.trim().slice(0, 300);
      if (text) { log(s, ctx, `${me.name}: ${text}`, actor); s.log[s.log.length - 1].kind = 'chat'; }
      return;
    }
    case 'reveal': {
      const names = a.iids.map(iid => { const c = card(s, iid); assertCanTouch(s, actor, c); return c.data.name; });
      if (names.length) log(s, ctx, `${me.name} revelou: ${names.join(', ')}`, actor);
      return;
    }
  }
}

export function blankCard(iid: string, owner: string, data: CardData, zone: ZoneName): CardInst {
  return {
    iid, ownerId: owner, controllerId: owner, data, zone, tapped: false, faceDown: false, transformed: false,
    counters: {}, x: 0.1, y: 0.1, ptMod: [0, 0],
  };
}

/** Aplica a ação e roda as ações baseadas em estado, como o XMage faz antes de dar prioridade. */
export function step(s: GameState, actor: string, a: Action, ctx: Ctx) {
  apply(s, actor, a, ctx);
  stateBasedActions(s, ctx);
  s.version++;
}

// ---------- visão por jogador (informação oculta) ----------

export function viewFor(s: GameState, viewer?: string): GameState {
  const cards: GameState['cards'] = {};
  for (const [iid, c] of Object.entries(s.cards)) {
    const visible =
      PUBLIC_ZONES.includes(c.zone) && !(c.faceDown && c.controllerId !== viewer) ||
      (c.zone === 'hand' && c.ownerId === viewer);
    if (visible) cards[iid] = c;
    else if (c.zone === 'battlefield' || c.zone === 'stack') {
      // carta virada para baixo de outro jogador: aparece, mas sem os dados
      cards[iid] = { ...c, data: { sid: 'hidden', name: 'Carta virada para baixo', typeLine: '', manaCost: '', cmc: 0, oracle: '', colorIdentity: [] } };
    }
  }
  return { ...s, cards };
}

export function stepLabel(st: Step) { return STEP_LABEL[st]; }
