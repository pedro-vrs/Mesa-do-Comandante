// Tipos compartilhados entre servidor e navegador.

export type HiddenZone = 'library' | 'hand';
export type PlayerZone = 'library' | 'hand' | 'graveyard' | 'exile' | 'command';
export type ZoneName = PlayerZone | 'battlefield' | 'stack';

export const ZONE_LABEL: Record<ZoneName, string> = {
  library: 'grimório',
  hand: 'mão',
  graveyard: 'cemitério',
  exile: 'exílio',
  command: 'zona de comando',
  battlefield: 'campo de batalha',
  stack: 'pilha',
};

/** Dados estáticos da carta, vindos do Scryfall. */
export interface CardData {
  sid: string;            // id do Scryfall (ou id local para tokens)
  name: string;
  typeLine: string;
  manaCost: string;
  cmc: number;
  oracle: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
  colorIdentity: string[];
  image?: string;
  imageBack?: string;
  backName?: string;
  legalCommander?: string; // 'legal' | 'not_legal' | 'banned' ...
}

export interface CardInst {
  iid: string;
  ownerId: string;
  controllerId: string;
  data: CardData;
  zone: ZoneName;
  tapped: boolean;
  faceDown: boolean;
  transformed: boolean;
  counters: Record<string, number>;
  attachedTo?: string;
  token?: boolean;
  ability?: boolean;      // item de pilha que é uma habilidade, não uma carta
  isCommander?: boolean;
  enteredTurn?: number;   // turno em que entrou no campo (enjoo de invocação)
  x: number;              // posição no campo (0..1)
  y: number;
  ptMod: [number, number];
}

export interface PlayerState {
  id: string;
  name: string;
  color: string;
  life: number;
  poison: number;
  counters: Record<string, number>;     // energia, experiência...
  cmdDamage: Record<string, number>;    // iid do comandante -> dano sofrido
  cmdCasts: Record<string, number>;     // iid do comandante -> vezes conjurado da zona de comando
  lost: boolean;
  lossReason?: string;
  pool: Record<'W' | 'U' | 'B' | 'R' | 'G' | 'C', number>;  // reserva de mana
  landsPlayed: number;                  // terrenos baixados neste turno
  zones: Record<PlayerZone, string[]>;  // iids, índice 0 = topo
  deckName?: string;
  deckSize: number;
  ready: boolean;
  connected: boolean;
  prompts: Prompt[];
}

export type Prompt = { id: string; kind: 'commander-zone'; iid: string; from: ZoneName };

export const STEPS = [
  'untap', 'upkeep', 'draw', 'main1',
  'combat-begin', 'attackers', 'blockers', 'damage', 'combat-end',
  'main2', 'end', 'cleanup',
] as const;
export type Step = typeof STEPS[number];

export const STEP_LABEL: Record<Step, string> = {
  untap: 'Desvirar', upkeep: 'Manutenção', draw: 'Compra', main1: 'Principal 1',
  'combat-begin': 'Combate', attackers: 'Atacantes', blockers: 'Bloqueadores',
  damage: 'Dano', 'combat-end': 'Fim combate', main2: 'Principal 2',
  end: 'Final', cleanup: 'Limpeza',
};

export interface LogEntry { id: number; t: number; playerId?: string; text: string; kind?: 'chat' | 'game' }

export interface Settings {
  startingLife: number;
  autoUntap: boolean;     // desvira as permanentes do jogador ativo no passo de desvirar
  autoDraw: boolean;      // compra automática no passo de compra
  priority: boolean;      // modo XMage: passar prioridade resolve a pilha e avança os passos
  enforce: boolean;       // regras de turno e mana: 1 terreno por turno, tempo de mágica, custo pago
  maxPlayers: number;
}

export interface GameState {
  roomId: string;
  version: number;
  phase: 'lobby' | 'playing' | 'over';
  hostId: string;
  players: PlayerState[];
  cards: Record<string, CardInst>;
  battlefield: string[];
  stack: string[];        // último = topo
  turn: { number: number; activeId: string; step: Step; priorityId: string; passed: string[] };
  log: LogEntry[];
  settings: Settings;
  winnerId?: string;
}

/** Versão que um jogador recebe: cartas ocultas ficam de fora de `cards`. */
export type GameView = GameState & { you?: string; canUndo: boolean; spectators: number };

export interface DeckEntry { data: CardData; count: number; commander?: boolean }

export type Action =
  | { type: 'loadDeck'; name: string; entries: DeckEntry[] }
  | { type: 'setReady'; ready: boolean }
  | { type: 'settings'; settings: Partial<Settings> }
  | { type: 'start' }
  | { type: 'draw'; n: number }
  | { type: 'shuffle' }
  | { type: 'mulligan' }
  | { type: 'move'; iids: string[]; to: ZoneName; toPlayer?: string; position?: 'top' | 'bottom'; x?: number; y?: number; faceDown?: boolean; xValue?: number; force?: boolean }
  | { type: 'tap'; iids: string[]; value?: boolean; mana?: string; force?: boolean }
  | { type: 'addMana'; mana: string; delta: number }
  | { type: 'untapAll' }
  | { type: 'transform'; iid: string }
  | { type: 'faceDown'; iid: string; value?: boolean }
  | { type: 'counter'; iid: string; kind: string; delta: number }
  | { type: 'pt'; iid: string; dp: number; dt: number }
  | { type: 'attach'; iid: string; to: string | null }
  | { type: 'control'; iid: string; to: string }
  | { type: 'token'; data: Partial<CardData> & { name: string }; count: number; x?: number; y?: number }
  | { type: 'clone'; iid: string }
  | { type: 'ability'; text: string; sourceIid?: string }
  | { type: 'resolve' }
  | { type: 'life'; delta: number }
  | { type: 'playerCounter'; kind: string; delta: number }
  | { type: 'cmdDamage'; commanderIid: string; delta: number }
  | { type: 'prompt'; promptId: string; accept: boolean }
  | { type: 'nextStep' }
  | { type: 'setStep'; step: Step }
  | { type: 'endTurn' }
  | { type: 'pass' }
  | { type: 'concede' }
  | { type: 'rejoin' }
  | { type: 'chat'; text: string }
  | { type: 'reveal'; iids: string[] }
  | { type: 'restart' };
