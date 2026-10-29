// Mana: ler custos, descobrir o que cada permanente gera e planejar o pagamento automático.
// Inspirado no pagamento automático do XMage (ManaUtil / PlayerImpl.playManaAbilities), em versão simplificada:
// o planejador usa só habilidades de mana "{T}: Adicione ...", que é o caso de quase todo terreno e pedra de mana.

import type { CardInst } from './types.js';

export const COLORS = ['W', 'U', 'B', 'R', 'G'] as const;
export const MANA = ['W', 'U', 'B', 'R', 'G', 'C'] as const;
export type Mana = typeof MANA[number];
export type Pool = Record<Mana, number>;

export const MANA_NAME: Record<Mana, string> = { W: 'branca', U: 'azul', B: 'preta', R: 'vermelha', G: 'verde', C: 'incolor' };

export const emptyPool = (): Pool => ({ W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 });
export const poolTotal = (p: Pool) => MANA.reduce((n, m) => n + (p[m] ?? 0), 0);

export interface Cost {
  generic: number;
  colored: Mana[];           // {W}, {C}...
  hybrid: string[][];        // {W/U} -> ['W','U'];  {2/W} -> ['W','2']
  phyrexian: Mana[];         // {G/P}
  x: number;                 // quantos {X}
}

export function parseCost(manaCost: string): Cost {
  const cost: Cost = { generic: 0, colored: [], hybrid: [], phyrexian: [], x: 0 };
  // custo de carta dupla "{1}{U} // {2}{R}": vale a face da frente
  const front = manaCost.split(' // ')[0];
  for (const m of front.matchAll(/\{([^}]+)\}/g)) {
    const s = m[1].toUpperCase();
    if (/^\d+$/.test(s)) cost.generic += Number(s);
    else if (s === 'X') cost.x++;
    else if (s === 'S') cost.generic++;                           // neve: trata como genérico
    else if ((MANA as readonly string[]).includes(s)) cost.colored.push(s as Mana);
    else if (/^[WUBRG]\/P$/.test(s)) cost.phyrexian.push(s[0] as Mana);
    else if (/^[WUBRGC2]\/[WUBRG]$/.test(s)) cost.hybrid.push(s.split('/'));
    else if (/^[WUBRG]\/[WUBRG]\/P$/.test(s)) cost.hybrid.push(s.split('/').slice(0, 2));
  }
  return cost;
}

export function costToText(c: Cost, xValue = 0, extra = 0): string {
  const g = c.generic + c.x * xValue + extra;
  return [g ? `{${g}}` : '', ...c.colored.map(m => `{${m}}`), ...c.hybrid.map(h => `{${h.join('/')}}`), ...c.phyrexian.map(m => `{${m}/P}`)].join('') || '{0}';
}

/** Opções de mana que a permanente gera ao ser virada. Cada opção é a lista de manas adicionadas. */
export function manaOptions(c: CardInst, commanderIdentity: string[] = [...COLORS]): Mana[][] {
  if (c.faceDown) return [];
  const text = c.data.oracle;
  const opts: Mana[][] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^\(|\)$/g, '');
    const i = line.indexOf(':');
    if (i < 0) continue;
    const cost = line.slice(0, i), effect = line.slice(i + 1).trim();
    if (!cost.includes('{T}') || /\{(?!T\})[^}]+\}/.test(cost)) continue;   // só "{T}" sem outra mana no custo
    const add = /\badd\b([^.]*)/i.exec(effect);
    if (!add) continue;
    const what = add[1];
    if (/one mana of any color in your commander/i.test(what)) {
      for (const m of commanderIdentity) opts.push([m as Mana]);
      continue;
    }
    if (/one mana of any color/i.test(what)) { for (const m of COLORS) opts.push([m]); continue; }
    if (/one mana of any type/i.test(what)) { for (const m of MANA) opts.push([m]); continue; }
    const groups = [...what.matchAll(/(?:\{[WUBRGC]\})+/g)].map(g => [...g[0].matchAll(/\{([WUBRGC])\}/g)].map(x => x[1] as Mana));
    if (!groups.length) continue;
    if (/\bor\b/.test(what)) opts.push(...groups); else opts.push(groups.flat());
  }
  if (!opts.length) {
    const t = c.data.typeLine;
    const basics: [RegExp, Mana][] = [[/Plains/, 'W'], [/Island/, 'U'], [/Swamp/, 'B'], [/Mountain/, 'R'], [/Forest/, 'G'], [/Wastes/, 'C']];
    for (const [re, m] of basics) if (re.test(t)) opts.push([m]);
  }
  const seen = new Set<string>();
  return opts.filter(o => { const k = o.join(''); if (seen.has(k)) return false; seen.add(k); return true; });
}

export interface Source { iid: string; options: Mana[][] }
export interface PayPlan { taps: { iid: string; produced: Mana[] }[]; pool: Pool; life: number }
export interface PayFail { missing: string }

/**
 * Planeja o pagamento: primeiro a reserva de mana, depois vira fontes (as de menos opções primeiro).
 * Ordem: símbolos coloridos -> híbridos -> phyrexianos -> genérico.
 */
export function planPayment(cost: Cost, xValue: number, extraGeneric: number, poolIn: Pool, sourcesIn: Source[], life: number): PayPlan | PayFail {
  const pool = { ...poolIn };
  const sources = [...sourcesIn].sort((a, b) => a.options.length - b.options.length || a.options[0].length - b.options[0].length);
  const used = new Set<string>();
  const taps: PayPlan['taps'] = [];
  let lifePaid = 0;
  let generic = cost.generic + cost.x * xValue + extraGeneric;

  // quanto ainda falta de cada cor (para não gastar à toa uma cor que vai ser pedida depois)
  const demand = (m: Mana) => cost.colored.filter(x => x === m).length;

  const tapFor = (accept: Mana[]): boolean => {
    for (const s of sources) {
      if (used.has(s.iid)) continue;
      const opt = s.options.find(o => o.some(m => accept.includes(m)));
      if (!opt) continue;
      used.add(s.iid); taps.push({ iid: s.iid, produced: opt });
      for (const m of opt) pool[m]++;
      return true;
    }
    return false;
  };
  const take = (accept: Mana[]): boolean => {
    const have = accept.filter(m => pool[m] > 0).sort((a, b) => demand(a) - demand(b));
    if (have.length) { pool[have[0]]--; return true; }
    if (tapFor(accept)) return take(accept);
    return false;
  };

  const missing: string[] = [];
  for (const m of [...cost.colored].sort()) if (!take([m])) missing.push(`{${m}}`);
  for (const h of cost.hybrid) {
    const colors = h.filter(x => x !== '2') as Mana[];
    if (!take(colors)) {
      if (h.includes('2')) generic += 2; else missing.push(`{${h.join('/')}}`);
    }
  }
  for (const m of cost.phyrexian) {
    if (!take([m])) { if (life - lifePaid > 2) lifePaid += 2; else missing.push(`{${m}/P}`); }
  }
  // genérico: incolor primeiro, depois as cores mais sobrando
  while (generic > 0) {
    const order = [...MANA].filter(m => pool[m] > 0).sort((a, b) => (a === 'C' ? -1 : b === 'C' ? 1 : pool[b] - pool[a]));
    if (order.length) { pool[order[0]]--; generic--; continue; }
    // vira a fonte que gera mais mana de uma vez (Sol Ring antes de terreno)
    const next = sources.filter(s => !used.has(s.iid)).sort((a, b) => Math.max(...b.options.map(o => o.length)) - Math.max(...a.options.map(o => o.length)))[0];
    if (!next) break;
    const opt = [...next.options].sort((a, b) => b.length - a.length || (a[0] === 'C' ? -1 : 1))[0];
    used.add(next.iid); taps.push({ iid: next.iid, produced: opt });
    for (const m of opt) pool[m]++;
  }
  if (generic > 0) missing.unshift(`{${generic}}`);
  if (missing.length) return { missing: missing.join('') };
  return { taps, pool, life: lifePaid };
}

/** Tipo da face da frente (cartas duplas e MDFC trazem "Instant // Land"). */
export function frontType(typeLine: string) { return typeLine.split(' // ')[0]; }

export function hasFlash(oracle: string) { return /(^|\n)Flash\b/.test(oracle) || /\bFlash\b(?=[,\n]|$)/.test(oracle.split('\n')[0] ?? ''); }
export function hasHaste(oracle: string) { return /(^|\n|, )Haste\b/i.test(oracle); }
