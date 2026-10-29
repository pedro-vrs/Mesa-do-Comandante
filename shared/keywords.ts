// Palavras-chave: lidas do texto de qualquer carta, sem programar carta por carta.
// Uma linha só conta como linha de palavras-chave se TODAS as partes dela forem palavras-chave
// ("Flying, vigilance" sim; "Creatures you control have flying" não, isso é efeito de outra carta).

import type { CardInst } from './types.js';

export const KEYWORDS = [
  'flying', 'trample', 'first strike', 'double strike', 'haste', 'vigilance', 'reach',
  'lifelink', 'deathtouch', 'indestructible', 'hexproof', 'ward', 'flash', 'menace', 'defender',
] as const;
export type Keyword = typeof KEYWORDS[number];

export const KW_LABEL: Record<Keyword, string> = {
  flying: 'Voar', trample: 'Atropelar', 'first strike': 'Iniciativa', 'double strike': 'Golpe duplo',
  haste: 'Ímpeto', vigilance: 'Vigilância', reach: 'Alcance', lifelink: 'Vínculo com a vida',
  deathtouch: 'Toque mortífero', indestructible: 'Indestrutível', hexproof: 'Resistência a magia',
  ward: 'Salvaguarda', flash: 'Lampejo', menace: 'Ameaçar', defender: 'Defensor',
};

/** Selo curto para mostrar na carta. */
export const KW_SHORT: Record<Keyword, string> = {
  flying: 'Voa', trample: 'Atr', 'first strike': 'Ini', 'double strike': 'GD', haste: 'Ímp',
  vigilance: 'Vig', reach: 'Alc', lifelink: 'Vín', deathtouch: 'TM', indestructible: 'Ind',
  hexproof: 'RM', ward: 'Salv', flash: 'Lamp', menace: 'Ame', defender: 'Def',
};

export const KW_HELP: Record<Keyword, string> = {
  flying: 'Só pode ser bloqueada por criaturas com voar ou alcance.',
  trample: 'Dano além do letal nos bloqueadores vai para o jogador defensor.',
  'first strike': 'Causa dano de combate antes das criaturas sem iniciativa.',
  'double strike': 'Causa dano de combate duas vezes: na iniciativa e no dano normal.',
  haste: 'Pode atacar e virar no turno em que entra.',
  vigilance: 'Atacar não vira esta criatura.',
  reach: 'Pode bloquear criaturas com voar.',
  lifelink: 'O dano que causa também faz o controlador ganhar essa vida.',
  deathtouch: 'Qualquer dano que causa a uma criatura é letal.',
  indestructible: 'Não é destruída por "destrua" nem por dano letal.',
  hexproof: 'Oponentes não podem escolher como alvo.',
  ward: 'Quando um oponente a escolhe como alvo, a mágica é anulada a menos que ele pague o custo.',
  flash: 'Pode ser conjurada a qualquer momento em que se pode conjurar uma instantânea.',
  menace: 'Só pode ser bloqueada por duas ou mais criaturas.',
  defender: 'Não pode atacar.',
};

export interface WardCost { mana?: string; life?: number; text: string }

/** Lê as palavras-chave impressas no texto de regras. */
export function printedKeywords(oracle: string, face = 0): { kws: Set<Keyword>; ward?: WardCost } {
  const kws = new Set<Keyword>();
  let ward: WardCost | undefined;
  // carta de duas faces: vale a face virada para cima
  const faces = oracle.split('\n//\n');
  const front = faces[Math.min(face, faces.length - 1)];
  for (const raw of front.split('\n')) {
    const line = raw.replace(/\([^)]*\)/g, '').trim();   // tira o texto explicativo
    if (!line) continue;
    const parts = line.split(/,\s*|;\s*/).map(p => p.trim()).filter(Boolean);
    const found: Keyword[] = [];
    let wardHere: WardCost | undefined;
    let ok = parts.length > 0;
    for (const part of parts) {
      const low = part.toLowerCase().replace(/\.$/, '');
      const w = /^ward(?:\s*(\{[^}]+\}(?:\{[^}]+\})*)|\s*[—-]\s*(.+))$/i.exec(part.replace(/\.$/, ''));
      if (w) {
        found.push('ward');
        if (w[1]) wardHere = { mana: w[1], text: w[1] };
        else {
          const life = /pay (\d+) life/i.exec(w[2]);
          wardHere = life ? { life: Number(life[1]), text: `pagar ${life[1]} de vida` } : { text: w[2] };
        }
        continue;
      }
      if ((KEYWORDS as readonly string[]).includes(low)) found.push(low as Keyword);
      else { ok = false; break; }
    }
    if (ok) { for (const k of found) kws.add(k); if (wardHere) ward = wardHere; }
  }
  return { kws, ward };
}

/** Palavras-chave que a permanente tem agora: impressas + concedidas (marcadores ou à mão) − removidas. */
export function keywordsOf(c: CardInst): Set<Keyword> {
  if (c.faceDown) return new Set();
  const out = printedKeywords(c.data.oracle, c.transformed ? 1 : 0).kws;
  // marcadores de palavra-chave ("flying counter")
  for (const k of Object.keys(c.counters)) if ((KEYWORDS as readonly string[]).includes(k)) out.add(k as Keyword);
  for (const [k, mode] of Object.entries(c.kw ?? {})) {
    if (mode === 'off') out.delete(k as Keyword);
    else out.add(k as Keyword);
  }
  return out;
}

export function has(c: CardInst, k: Keyword) { return keywordsOf(c).has(k); }

export function wardOf(c: CardInst): WardCost | undefined {
  if (!has(c, 'ward')) return undefined;
  return printedKeywords(c.data.oracle, c.transformed ? 1 : 0).ward ?? { text: 'custo da carta' };
}
