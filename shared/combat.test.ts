import { describe, it, expect } from 'vitest';
import { newGame, addPlayer, step, blankCard, Ctx } from './game.js';
import { printedKeywords, keywordsOf } from './keywords.js';
import type { CardData, GameState } from './types.js';

function ctx(): Ctx { let n = 0, x = 3; return { rand: () => { x = (x * 16807) % 2147483647; return (x - 1) / 2147483646; }, id: () => `k${++n}`, now: () => 0 }; }
const data = (name: string, typeLine: string, oracle = '', power?: string, toughness?: string): CardData =>
  ({ sid: name, name, typeLine, manaCost: '', cmc: 0, oracle, power, toughness, colorIdentity: [] });

/** Mesa de 2 com regras ligadas; A no passo indicado do próprio turno. */
function arena(players = 2) {
  const c = ctx();
  const s = newGame('r', '');
  for (let i = 0; i < players; i++) {
    addPlayer(s, `p${i}`, `P${i}`);
    step(s, `p${i}`, { type: 'loadDeck', name: 'd', entries: [{ data: data('Forest', 'Basic Land — Forest'), count: 40 }] }, c);
  }
  step(s, 'p0', { type: 'start' }, c);
  const A = s.turn.activeId, B = s.players.find(p => p.id !== A)!.id;
  const put = (owner: string, name: string, oracle: string, p: string, t: string, typeLine = 'Creature — Test') => {
    const iid = c.id();
    const card = blankCard(iid, owner, data(name, typeLine, oracle, p, t), 'battlefield');
    card.enteredTurn = -1; // já estava no campo
    s.cards[iid] = card; s.battlefield.push(iid);
    return card;
  };
  const go = (st: any) => step(s, A, { type: 'setStep', step: st }, c);
  const life = (pid: string) => s.players.find(p => p.id === pid)!.life;
  return { s, c, A, B, put, go, life, act: (pid: string, a: any) => step(s, pid, a, c) };
}

/** Atacar com `atk`, bloquear com `blk` (lista), ir até o fim do dano. */
function fight(e: ReturnType<typeof arena>, atk: any[], blocks: [any, any][] = []) {
  e.go('main1');
  for (const a of atk) e.act(e.A, { type: 'attack', iid: a.iid, target: e.B });
  e.act(e.A, { type: 'nextStep' });            // -> bloqueadores
  for (const [b, a] of blocks) e.act(e.B, { type: 'block', iid: b.iid, attacker: a.iid });
  e.act(e.A, { type: 'nextStep' });            // -> dano
}

describe('leitura de palavras-chave', () => {
  it('lê linhas só de palavras-chave e ignora efeitos de outras cartas', () => {
    expect([...printedKeywords('Flying, vigilance\nWhenever this attacks, draw a card.').kws]).toEqual(['flying', 'vigilance']);
    expect([...printedKeywords('Creatures you control have flying.').kws]).toEqual([]);
    expect([...printedKeywords('First strike (This creature deals combat damage before creatures without first strike.)').kws]).toEqual(['first strike']);
    expect(printedKeywords('Ward {2}').ward).toEqual({ mana: '{2}', text: '{2}' });
    expect(printedKeywords('Ward—Pay 3 life.').ward).toEqual({ life: 3, text: 'pagar 3 de vida' });
    expect([...printedKeywords('Deathtouch, lifelink\nHexproof').kws].sort()).toEqual(['deathtouch', 'hexproof', 'lifelink']);
  });
  it('habilidade concedida à mão e removida', () => {
    const e = arena();
    const x = e.put(e.A, 'Bear', '', '2', '2');
    e.act(e.A, { type: 'keyword', iid: x.iid, kw: 'flying', mode: 'eot' });
    expect(keywordsOf(e.s.cards[x.iid]).has('flying')).toBe(true);
    e.act(e.A, { type: 'endTurn' });
    expect(keywordsOf(e.s.cards[x.iid]).has('flying')).toBe(false); // acabou no fim do turno
  });
});

describe('ataque', () => {
  it('criatura sem bloqueio causa dano ao jogador e vira; vigilância não vira', () => {
    const e = arena();
    const bear = e.put(e.A, 'Bear', '', '2', '2');
    const knight = e.put(e.A, 'Knight', 'Vigilance', '3', '3');
    fight(e, [bear, knight]);
    expect(e.life(e.B)).toBe(35);
    expect(e.s.cards[bear.iid].tapped).toBe(true);
    expect(e.s.cards[knight.iid].tapped).toBe(false);
  });
  it('defensor não ataca; enjoo de invocação impede, ímpeto libera', () => {
    const e = arena();
    const wall = e.put(e.A, 'Wall', 'Defender', '0', '4');
    const fresh = e.put(e.A, 'Fresh', '', '2', '2'); fresh.enteredTurn = e.s.turn.number;
    const hasty = e.put(e.A, 'Hasty', 'Haste', '2', '2'); hasty.enteredTurn = e.s.turn.number;
    e.go('main1');
    expect(() => e.act(e.A, { type: 'attack', iid: wall.iid, target: e.B })).toThrow(/defensor/);
    expect(() => e.act(e.A, { type: 'attack', iid: fresh.iid, target: e.B })).toThrow(/ímpeto/);
    e.act(e.A, { type: 'attack', iid: hasty.iid, target: e.B });
    expect(e.s.cards[hasty.iid].attacking).toBe(e.B);
  });
  it('sem atacantes, pula direto para o fim do combate', () => {
    const e = arena();
    e.go('attackers');
    e.act(e.A, { type: 'nextStep' });
    expect(e.s.turn.step).toBe('combat-end');
  });
});

describe('bloqueio', () => {
  it('voar só é bloqueado por voar ou alcance', () => {
    const e = arena();
    const bird = e.put(e.A, 'Bird', 'Flying', '1', '1');
    const bear = e.put(e.B, 'Bear', '', '2', '2');
    const spider = e.put(e.B, 'Spider', 'Reach', '1', '3');
    e.go('main1');
    e.act(e.A, { type: 'attack', iid: bird.iid, target: e.B });
    e.act(e.A, { type: 'nextStep' });
    expect(() => e.act(e.B, { type: 'block', iid: bear.iid, attacker: bird.iid })).toThrow(/voar/);
    e.act(e.B, { type: 'block', iid: spider.iid, attacker: bird.iid });
    e.act(e.A, { type: 'nextStep' });
    expect(e.s.cards[bird.iid]).toBeDefined();
    expect(e.s.cards[bird.iid].zone).toBe('graveyard'); // 1/1 contra 1/3 morre
    expect(e.life(e.B)).toBe(40);
  });
  it('ameaçar exige dois bloqueadores', () => {
    const e = arena();
    const goblin = e.put(e.A, 'Goblin', 'Menace', '2', '2');
    const b1 = e.put(e.B, 'B1', '', '1', '1'), b2 = e.put(e.B, 'B2', '', '1', '1');
    e.go('main1');
    e.act(e.A, { type: 'attack', iid: goblin.iid, target: e.B });
    e.act(e.A, { type: 'nextStep' });
    e.act(e.B, { type: 'block', iid: b1.iid, attacker: goblin.iid });
    expect(() => e.act(e.A, { type: 'nextStep' })).toThrow(/ameaçar/);
    e.act(e.B, { type: 'block', iid: b2.iid, attacker: goblin.iid });
    e.act(e.A, { type: 'nextStep' });
    expect(e.s.turn.step).toBe('damage');
  });
});

describe('dano de combate', () => {
  it('atropelar passa o excesso; com toque mortífero, 1 basta por bloqueador', () => {
    const e = arena();
    const wurm = e.put(e.A, 'Wurm', 'Trample', '6', '6');
    const chump = e.put(e.B, 'Chump', '', '2', '2');
    fight(e, [wurm], [[chump, wurm]]);
    expect(e.life(e.B)).toBe(36);
    expect(e.s.cards[chump.iid].zone).toBe('graveyard');

    const e2 = arena();
    const snake = e2.put(e2.A, 'Snake', 'Deathtouch, trample', '4', '4');
    const big = e2.put(e2.B, 'Big', '', '1', '10');
    fight(e2, [snake], [[big, snake]]);
    expect(e2.life(e2.B)).toBe(37);              // 1 letal no bloqueador, 3 atropelam
    expect(e2.s.cards[big.iid].zone).toBe('graveyard');
  });
  it('sem atropelar, todo o dano fica no bloqueador', () => {
    const e = arena();
    const ogre = e.put(e.A, 'Ogre', '', '5', '5');
    const chump = e.put(e.B, 'Chump', '', '1', '1');
    fight(e, [ogre], [[chump, ogre]]);
    expect(e.life(e.B)).toBe(40);
  });
  it('iniciativa mata antes de levar dano; golpe duplo bate duas vezes', () => {
    const e = arena();
    const fencer = e.put(e.A, 'Fencer', 'First strike', '2', '1');
    const bear = e.put(e.B, 'Bear', '', '2', '2');
    fight(e, [fencer], [[bear, fencer]]);
    expect(e.s.cards[bear.iid].zone).toBe('graveyard');
    expect(e.s.cards[fencer.iid].zone).toBe('battlefield'); // o urso morreu antes de bater

    const e2 = arena();
    const ds = e2.put(e2.A, 'Swiftblade', 'Double strike', '3', '3');
    fight(e2, [ds]);
    expect(e2.life(e2.B)).toBe(34);
  });
  it('vínculo com a vida faz o controlador ganhar vida', () => {
    const e = arena();
    const vamp = e.put(e.A, 'Vampire', 'Lifelink', '3', '3');
    fight(e, [vamp]);
    expect(e.life(e.A)).toBe(43);
    expect(e.life(e.B)).toBe(37);
  });
  it('toque mortífero mata qualquer criatura; indestrutível sobrevive', () => {
    const e = arena();
    const asp = e.put(e.A, 'Asp', 'Deathtouch', '1', '1');
    const titan = e.put(e.B, 'Titan', '', '6', '6');
    fight(e, [asp], [[titan, asp]]);
    expect(e.s.cards[titan.iid].zone).toBe('graveyard');

    const e2 = arena();
    const asp2 = e2.put(e2.A, 'Asp', 'Deathtouch', '1', '1');
    const god = e2.put(e2.B, 'God', 'Indestructible', '6', '6');
    fight(e2, [asp2], [[god, asp2]]);
    expect(e2.s.cards[god.iid].zone).toBe('battlefield');
    expect(e2.s.cards[asp2.iid].zone).toBe('graveyard');
  });
  it('comandante atacando conta dano de comandante sozinho', () => {
    const e = arena();
    const cmd = e.put(e.A, 'Commander', '', '7', '7'); cmd.isCommander = true;
    fight(e, [cmd]);
    const pb = e.s.players.find(p => p.id === e.B)!;
    expect(pb.cmdDamage[cmd.iid]).toBe(7);
    expect(pb.life).toBe(33);
  });
  it('o dano marcado some na limpeza', () => {
    const e = arena();
    const ogre = e.put(e.A, 'Ogre', '', '2', '5');
    const bear = e.put(e.B, 'Bear', '', '2', '2');
    fight(e, [ogre], [[bear, ogre]]);
    expect(e.s.cards[ogre.iid].damage).toBe(2);
    e.act(e.A, { type: 'endTurn' });
    expect(e.s.cards[ogre.iid].damage).toBe(0);
  });
});

describe('destruir', () => {
  it('"destrua" não afeta indestrutível', () => {
    const e = arena();
    const god = e.put(e.B, 'God', 'Indestructible', '5', '5');
    e.act(e.B, { type: 'destroy', iids: [god.iid] });
    expect(e.s.cards[god.iid].zone).toBe('battlefield');
  });
});

describe('alvos', () => {
  function withSpell(e: ReturnType<typeof arena>, oracle = 'Destroy target creature.') {
    const iid = e.c.id();
    const spell = blankCard(iid, e.A, data('Murder', 'Instant', oracle), 'hand');
    e.s.cards[iid] = spell; e.s.players.find(p => p.id === e.A)!.zones.hand.push(iid);
    return spell;
  }
  it('resistência a magia impede oponente de escolher como alvo', () => {
    const e = arena();
    const elf = e.put(e.B, 'Elf', 'Hexproof', '1', '1');
    const spell = withSpell(e);
    e.go('main1');
    expect(() => e.act(e.A, { type: 'move', iids: [spell.iid], to: 'stack', targets: [elf.iid] })).toThrow(/resistência a magia/);
  });
  it('a própria criatura com resistência pode ser alvo do dono', () => {
    const e = arena();
    const elf = e.put(e.A, 'Elf', 'Hexproof', '1', '1');
    const spell = withSpell(e, 'Target creature gets +3/+3 until end of turn.');
    e.go('main1');
    e.act(e.A, { type: 'move', iids: [spell.iid], to: 'stack', targets: [elf.iid] });
    expect(e.s.cards[spell.iid].targets).toEqual([elf.iid]);
  });
  it('salvaguarda: sem pagar, a mágica é anulada; pagando, segue', () => {
    const e = arena();
    const guard = e.put(e.B, 'Guard', 'Ward—Pay 3 life.', '2', '2');
    const spell = withSpell(e);
    e.go('main1');
    e.act(e.A, { type: 'move', iids: [spell.iid], to: 'stack', targets: [guard.iid] });
    const pa = e.s.players.find(p => p.id === e.A)!;
    const pr = pa.prompts.find(p => p.kind === 'ward')!;
    expect(pr).toBeDefined();
    e.act(e.A, { type: 'prompt', promptId: pr.id, accept: false });
    expect(e.s.cards[spell.iid].zone).toBe('graveyard');

    const e2 = arena();
    const guard2 = e2.put(e2.B, 'Guard', 'Ward—Pay 3 life.', '2', '2');
    const spell2 = withSpell(e2);
    e2.go('main1');
    e2.act(e2.A, { type: 'move', iids: [spell2.iid], to: 'stack', targets: [guard2.iid] });
    const pa2 = e2.s.players.find(p => p.id === e2.A)!;
    e2.act(e2.A, { type: 'prompt', promptId: pa2.prompts[0].id, accept: true });
    expect(pa2.life).toBe(37);
    expect(e2.s.stack).toContain(spell2.iid);
  });
  it('salvaguarda de mana sem mana disponível recusa o pagamento', () => {
    const e = arena();
    const guard = e.put(e.B, 'Guard', 'Ward {2}', '2', '2');
    const spell = withSpell(e);
    e.go('main1');
    e.act(e.A, { type: 'move', iids: [spell.iid], to: 'stack', targets: [guard.iid] });
    const pa = e.s.players.find(p => p.id === e.A)!;
    expect(() => e.act(e.A, { type: 'prompt', promptId: pa.prompts[0].id, accept: true })).toThrow(/salvaguarda/);
  });
});

describe('lampejo', () => {
  it('criatura com lampejo entra na pilha fora da fase principal', () => {
    const e = arena();
    const iid = e.c.id();
    const ambusher = blankCard(iid, e.A, data('Ambusher', 'Creature — Cat', 'Flash', '2', '1'), 'hand');
    e.s.cards[iid] = ambusher; e.s.players.find(p => p.id === e.A)!.zones.hand.push(iid);
    const iid2 = e.c.id();
    const slow = blankCard(iid2, e.A, data('Slow', 'Creature — Bear', '', '2', '2'), 'hand');
    e.s.cards[iid2] = slow; e.s.players.find(p => p.id === e.A)!.zones.hand.push(iid2);
    e.go('attackers');
    expect(() => e.act(e.A, { type: 'move', iids: [iid2], to: 'stack' })).toThrow(/fase principal/);
    e.act(e.A, { type: 'move', iids: [iid], to: 'stack' });
    expect(e.s.stack).toContain(iid);
  });
});
