import { describe, it, expect } from 'vitest';
import { newGame, addPlayer, step, viewFor, warnings, effectivePT, Ctx } from './game.js';
import type { CardData, DeckEntry, GameState } from './types.js';

function ctx(seed = 1): Ctx {
  let x = seed, n = 0;
  return {
    rand: () => { x = (x * 16807) % 2147483647; return (x - 1) / 2147483646; },
    id: () => `c${++n}`,
    now: () => 0,
  };
}

const card = (name: string, typeLine: string, extra: Partial<CardData> = {}): CardData => ({
  sid: name, name, typeLine, manaCost: '', cmc: 0, oracle: '', colorIdentity: [], ...extra,
});

function deck(commander: string): DeckEntry[] {
  return [
    { data: card(commander, 'Legendary Creature — Elf', { power: '3', toughness: '3' }), count: 1, commander: true },
    { data: card('Forest', 'Basic Land — Forest'), count: 60 },
    { data: card('Llanowar Elves', 'Creature — Elf Druid', { power: '1', toughness: '1' }), count: 1 },
    { data: card('Giant Growth', 'Instant'), count: 1 },
    { data: card('Glorious Anthem', 'Enchantment'), count: 37 },
  ];
}

function table(players = 2, c = ctx(), enforce = false): { s: GameState; c: Ctx } {
  const s = newGame('r', '');
  s.settings.enforce = enforce;
  for (let i = 0; i < players; i++) {
    addPlayer(s, `p${i}`, `P${i}`);
    step(s, `p${i}`, { type: 'loadDeck', name: 'd', entries: deck(`Cmd${i}`) }, c);
  }
  step(s, 'p0', { type: 'start' }, c);
  return { s, c };
}

const find = (s: GameState, pid: string, name: string, zone?: string) =>
  Object.values(s.cards).find(x => x.ownerId === pid && x.data.name === name && (!zone || x.zone === zone))!;

describe('início da partida', () => {
  it('embaralha, compra 7 e põe o comandante na zona de comando', () => {
    const { s } = table();
    for (const p of s.players) {
      expect(p.zones.hand).toHaveLength(7);
      expect(p.zones.library).toHaveLength(92);
      expect(p.zones.command).toHaveLength(1);
      expect(p.life).toBe(40);
    }
    expect(s.turn.number).toBe(1);
    expect(s.turn.step).toBe('upkeep'); // desvirar não dá prioridade
  });

  it('em partida de 2, quem começa não compra no 1º turno (103.8a)', () => {
    const { s, c } = table(2);
    const a = s.turn.activeId;
    step(s, a, { type: 'nextStep' }, c); // -> compra
    expect(s.turn.step).toBe('draw');
    expect(s.players.find(p => p.id === a)!.zones.hand).toHaveLength(7);
  });

  it('em multiplayer, o primeiro jogador compra', () => {
    const { s, c } = table(3);
    const a = s.turn.activeId;
    step(s, a, { type: 'nextStep' }, c);
    expect(s.players.find(p => p.id === a)!.zones.hand).toHaveLength(8);
  });
});

describe('comandante', () => {
  it('conta o imposto a cada conjuração da zona de comando', () => {
    const { s, c } = table();
    const cmd = find(s, 'p0', 'Cmd0');
    step(s, 'p0', { type: 'move', iids: [cmd.iid], to: 'stack' }, c);
    expect(s.players[0].cmdCasts[cmd.iid]).toBe(1);
    step(s, 'p0', { type: 'resolve' }, c);
    expect(s.cards[cmd.iid].zone).toBe('battlefield');
    step(s, 'p0', { type: 'move', iids: [cmd.iid], to: 'graveyard' }, c);
    // vai ao cemitério e pergunta se volta
    const pr = s.players[0].prompts[0];
    expect(pr.kind).toBe('commander-zone');
    step(s, 'p0', { type: 'prompt', promptId: pr.id, accept: true }, c);
    expect(s.cards[cmd.iid].zone).toBe('command');
    step(s, 'p0', { type: 'move', iids: [cmd.iid], to: 'battlefield' }, c);
    expect(s.players[0].cmdCasts[cmd.iid]).toBe(2);
  });

  it('21 de dano do mesmo comandante derrota, e o dano também tira vida', () => {
    const { s, c } = table();
    const cmd = find(s, 'p0', 'Cmd0');
    step(s, 'p1', { type: 'cmdDamage', commanderIid: cmd.iid, delta: 20 }, c);
    expect(s.players[1].life).toBe(20);
    expect(s.players[1].lost).toBe(false);
    step(s, 'p1', { type: 'cmdDamage', commanderIid: cmd.iid, delta: 1 }, c);
    expect(s.players[1].lost).toBe(true);
    expect(s.phase).toBe('over');
    expect(s.winnerId).toBe('p0');
  });
});

describe('ações baseadas em estado', () => {
  it('vida 0 e 10 venenos derrotam', () => {
    const { s, c } = table(3);
    step(s, 'p1', { type: 'life', delta: -40 }, c);
    expect(s.players[1].lost).toBe(true);
    step(s, 'p2', { type: 'playerCounter', kind: 'poison', delta: 10 }, c);
    expect(s.players[2].lost).toBe(true);
    expect(s.winnerId).toBe('p0');
  });

  it('+1/+1 e -1/-1 se anulam (704.5q)', () => {
    const { s, c } = table();
    const elf = Object.values(s.cards).find(x => x.ownerId === 'p0' && x.zone === 'library')!;
    step(s, 'p0', { type: 'move', iids: [elf.iid], to: 'battlefield' }, c);
    step(s, 'p0', { type: 'counter', iid: elf.iid, kind: '+1/+1', delta: 3 }, c);
    step(s, 'p0', { type: 'counter', iid: elf.iid, kind: '-1/-1', delta: 2 }, c);
    expect(s.cards[elf.iid].counters).toEqual({ '+1/+1': 1 });
  });

  it('avisa resistência 0 e regra da lenda sem agir sozinho', () => {
    const { s, c } = table();
    const elf = find(s, 'p0', 'Llanowar Elves');
    s.players[0].zones.library = s.players[0].zones.library.filter(x => x !== elf.iid);
    s.cards[elf.iid].zone = 'hand'; s.players[0].zones.hand.push(elf.iid);
    step(s, 'p0', { type: 'move', iids: [elf.iid], to: 'battlefield' }, c);
    step(s, 'p0', { type: 'counter', iid: elf.iid, kind: '-1/-1', delta: 1 }, c);
    expect(effectivePT(s.cards[elf.iid])).toEqual([0, 0]);
    expect(warnings(s).some(w => w.iid === elf.iid)).toBe(true);
    expect(s.cards[elf.iid].zone).toBe('battlefield');
  });

  it('token some ao sair do campo', () => {
    const { s, c } = table();
    step(s, 'p0', { type: 'token', data: { name: 'Saproling', power: '1', toughness: '1' }, count: 2 }, c);
    const t = s.battlefield.map(i => s.cards[i]).find(x => x.token)!;
    step(s, 'p0', { type: 'move', iids: [t.iid], to: 'graveyard' }, c);
    expect(s.cards[t.iid]).toBeUndefined();
  });
});

describe('pilha', () => {
  it('mágica instantânea vai para o cemitério ao resolver; permanente vai para o campo', () => {
    const { s, c } = table();
    const gg = find(s, 'p0', 'Giant Growth');
    const elf = find(s, 'p0', 'Llanowar Elves');
    for (const x of [gg, elf]) { s.players[0].zones.library = s.players[0].zones.library.filter(i => i !== x.iid); x.zone = 'hand'; s.players[0].zones.hand.push(x.iid); }
    step(s, 'p0', { type: 'move', iids: [elf.iid], to: 'stack' }, c);
    step(s, 'p0', { type: 'move', iids: [gg.iid], to: 'stack' }, c);
    step(s, 'p0', { type: 'resolve' }, c);
    expect(s.cards[gg.iid].zone).toBe('graveyard');
    step(s, 'p0', { type: 'resolve' }, c);
    expect(s.cards[elf.iid].zone).toBe('battlefield');
  });

  it('modo prioridade: todos passam -> resolve, depois avança o passo', () => {
    const { s, c } = table(2);
    step(s, 'p0', { type: 'settings', settings: { priority: true } }, c);
    const a = s.turn.activeId, b = a === 'p0' ? 'p1' : 'p0';
    step(s, a, { type: 'ability', text: 'Compre uma carta' }, c);
    expect(s.stack).toHaveLength(1);
    step(s, a, { type: 'pass' }, c);
    expect(s.turn.priorityId).toBe(b);
    step(s, b, { type: 'pass' }, c);
    expect(s.stack).toHaveLength(0);
    const before = s.turn.step;
    step(s, a, { type: 'pass' }, c);
    step(s, b, { type: 'pass' }, c);
    expect(s.turn.step).not.toBe(before);
  });
});

describe('turno', () => {
  it('desvira as permanentes do novo jogador ativo', () => {
    const { s, c } = table(2);
    const a = s.turn.activeId, b = a === 'p0' ? 'p1' : 'p0';
    const land = Object.values(s.cards).find(x => x.ownerId === b && x.zone === 'hand')!;
    step(s, b, { type: 'move', iids: [land.iid], to: 'battlefield' }, c);
    step(s, b, { type: 'tap', iids: [land.iid] }, c);
    step(s, a, { type: 'endTurn' }, c);
    expect(s.turn.activeId).toBe(b);
    expect(s.cards[land.iid].tapped).toBe(false);
    expect(s.turn.number).toBe(2);
  });

  it('só o jogador ativo avança o passo', () => {
    const { s, c } = table(2);
    const b = s.turn.activeId === 'p0' ? 'p1' : 'p0';
    expect(() => step(s, b, { type: 'nextStep' }, c)).toThrow();
  });
});

describe('informação oculta', () => {
  it('mão e grimório dos outros não chegam ao navegador', () => {
    const { s } = table();
    const v = viewFor(s, 'p0');
    for (const iid of s.players[1].zones.hand) expect(v.cards[iid]).toBeUndefined();
    for (const iid of s.players[0].zones.library) expect(v.cards[iid]).toBeUndefined();
    for (const iid of s.players[0].zones.hand) expect(v.cards[iid]).toBeDefined();
  });

  it('não deixa mexer em carta de outro jogador', () => {
    const { s, c } = table();
    const theirs = s.players[1].zones.hand[0];
    expect(() => step(s, 'p0', { type: 'move', iids: [theirs], to: 'graveyard' }, c)).toThrow();
  });
});

// ---------- regras de turno e mana ----------
import { parseCost, manaOptions, planPayment, emptyPool } from './mana.js';
import { blankCard } from './game.js';

describe('mana: leitura de custos e fontes', () => {
  it('lê custos com genérico, cores, híbrido, phyrexiano e X', () => {
    expect(parseCost('{2}{G}{G}')).toMatchObject({ generic: 2, colored: ['G', 'G'], x: 0 });
    expect(parseCost('{X}{R}')).toMatchObject({ generic: 0, colored: ['R'], x: 1 });
    expect(parseCost('{W/U}{2/B}{G/P}')).toMatchObject({ hybrid: [['W', 'U'], ['2', 'B']], phyrexian: ['G'] });
    expect(parseCost('{1}{U} // {3}{R}')).toMatchObject({ generic: 1, colored: ['U'] });
  });

  it('descobre o que cada terreno ou artefato gera', () => {
    const mk = (typeLine: string, oracle: string) => blankCard('x', 'p', card('X', typeLine, { oracle }), 'battlefield');
    expect(manaOptions(mk('Basic Land — Forest', '({T}: Add {G}.)'))).toEqual([['G']]);
    expect(manaOptions(mk('Artifact', '{T}: Add {C}{C}.'))).toEqual([['C', 'C']]);
    expect(manaOptions(mk('Land — Forest Island', '({T}: Add {G} or {U}.)'))).toEqual([['G'], ['U']]);
    expect(manaOptions(mk('Land', '{T}: Add {C}.\n{T}: Add one mana of any color in your commander\'s color identity.'), ['G', 'W'])).toEqual([['C'], ['G'], ['W']]);
    expect(manaOptions(mk('Artifact', '{1}, {T}: Add {C}{C}.'))).toEqual([]); // custo com mana não conta
    expect(manaOptions(mk('Basic Land — Swamp', ''))).toEqual([['B']]);    // sem texto: pelo tipo
  });

  it('planeja o pagamento sem desperdiçar a cor que ainda vai ser pedida', () => {
    const plan = planPayment(parseCost('{1}{G}'), 0, 0, emptyPool(), [
      { iid: 'dual', options: [['G'], ['U']] }, { iid: 'forest', options: [['G']] }, { iid: 'ring', options: [['C', 'C']] },
    ], 40);
    expect('taps' in plan && plan.taps.map(t => t.iid).sort()).toEqual(['forest', 'ring']);
    const fail = planPayment(parseCost('{U}{U}'), 0, 0, emptyPool(), [{ iid: 'f', options: [['G']] }], 40);
    expect(fail).toEqual({ missing: '{U}{U}' });
  });
});

describe('regras de turno e mana', () => {
  /** Mesa com regras ligadas, já na fase principal 1 do jogador ativo. */
  function ruled() {
    const { s, c } = table(2, ctx(7), true);
    const a = s.turn.activeId, b = a === 'p0' ? 'p1' : 'p0';
    step(s, a, { type: 'setStep', step: 'main1' }, c);
    // põe na mão do ativo: 3 florestas, um elfo, um Giant Growth
    const give = (name: string) => {
      const x = Object.values(s.cards).find(k => k.ownerId === a && k.data.name === name && k.zone === 'library')!;
      const pl = s.players.find(p => p.id === a)!;
      pl.zones.library = pl.zones.library.filter(i => i !== x.iid); x.zone = 'hand'; pl.zones.hand.push(x.iid);
      return x;
    };
    return { s, c, a, b, give };
  }

  it('só um terreno por turno, e só na fase principal do próprio turno', () => {
    const { s, c, a, b, give } = ruled();
    const f1 = give('Forest'), f2 = give('Forest');
    step(s, a, { type: 'move', iids: [f1.iid], to: 'battlefield' }, c);
    expect(() => step(s, a, { type: 'move', iids: [f2.iid], to: 'battlefield' }, c)).toThrow(/já baixou um terreno/);
    // com "fazer assim mesmo" passa, e fica registrado
    step(s, a, { type: 'move', iids: [f2.iid], to: 'battlefield', force: true }, c);
    expect(s.log.some(l => l.text.includes('passou por cima'))).toBe(true);
    const bl = s.players.find(p => p.id === b)!.zones.hand.map(i => s.cards[i]).find(k => k.data.name === 'Forest');
    if (bl) expect(() => step(s, b, { type: 'move', iids: [bl.iid], to: 'battlefield' }, c)).toThrow(/seu turno/);
  });

  it('conjurar cobra o custo virando os terrenos sozinho', () => {
    const { s, c, a, give } = ruled();
    const forest = give('Forest'), elf = give('Llanowar Elves');
    step(s, a, { type: 'move', iids: [forest.iid], to: 'battlefield' }, c);
    s.cards[elf.iid].data = { ...s.cards[elf.iid].data, manaCost: '{G}' };
    step(s, a, { type: 'move', iids: [elf.iid], to: 'stack' }, c);
    expect(s.cards[forest.iid].tapped).toBe(true);
    expect(s.stack).toContain(elf.iid);
  });

  it('recusa sem mana, e a recusa pode ser ignorada', () => {
    const { s, c, a, give } = ruled();
    const elf = give('Llanowar Elves');
    s.cards[elf.iid].data = { ...s.cards[elf.iid].data, manaCost: '{G}' };
    expect(() => step(s, a, { type: 'move', iids: [elf.iid], to: 'stack' }, c)).toThrow(/Mana insuficiente/);
    step(s, a, { type: 'move', iids: [elf.iid], to: 'stack', force: true }, c);
    expect(s.stack).toContain(elf.iid);
  });

  it('feitiço fora da fase principal é recusado; instantânea passa', () => {
    const { s, c, a, b, give } = ruled();
    const gg = give('Giant Growth');
    const anthem = give('Glorious Anthem');
    step(s, a, { type: 'setStep', step: 'attackers' }, c);
    expect(() => step(s, a, { type: 'move', iids: [anthem.iid], to: 'stack' }, c)).toThrow(/fase principal/);
    step(s, a, { type: 'move', iids: [gg.iid], to: 'stack' }, c); // custo vazio no teste: passa
    expect(s.stack).toContain(gg.iid);
  });

  it('imposto do comandante entra no custo', () => {
    const { s, c, a } = ruled();
    const cmd = Object.values(s.cards).find(k => k.ownerId === a && k.isCommander)!;
    cmd.data = { ...cmd.data, manaCost: '{G}' };
    s.players.find(p => p.id === a)!.pool.G = 1;
    step(s, a, { type: 'move', iids: [cmd.iid], to: 'stack' }, c);
    step(s, a, { type: 'resolve' }, c);
    step(s, a, { type: 'move', iids: [cmd.iid], to: 'command' }, c);
    s.players.find(p => p.id === a)!.pool.G = 1;
    // agora custa {G} + 2 de imposto: só 1 mana na reserva
    expect(() => step(s, a, { type: 'move', iids: [cmd.iid], to: 'stack' }, c)).toThrow(/falta \{2\}/);
  });

  it('virar terreno gera mana na reserva, e a reserva esvazia ao mudar de passo', () => {
    const { s, c, a, give } = ruled();
    const f = give('Forest');
    step(s, a, { type: 'move', iids: [f.iid], to: 'battlefield' }, c);
    step(s, a, { type: 'tap', iids: [f.iid] }, c);
    expect(s.players.find(p => p.id === a)!.pool.G).toBe(1);
    step(s, a, { type: 'nextStep' }, c);
    expect(s.players.find(p => p.id === a)!.pool.G).toBe(0);
  });

  it('criatura que acabou de entrar não vira para gerar mana', () => {
    const { s, c, a, give } = ruled();
    const elf = give('Llanowar Elves');
    s.cards[elf.iid].data = { ...s.cards[elf.iid].data, oracle: '{T}: Add {G}.' };
    step(s, a, { type: 'move', iids: [elf.iid], to: 'stack', force: true }, c);
    step(s, a, { type: 'resolve' }, c);
    expect(() => step(s, a, { type: 'tap', iids: [elf.iid] }, c)).toThrow(/enjoo/);
  });
});
