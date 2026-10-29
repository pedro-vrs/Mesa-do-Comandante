// Busca de cartas no Scryfall, feita pelo navegador de cada jogador.
import type { CardData, DeckEntry } from '../shared/types';

export interface ParsedLine { count: number; name: string; set?: string; num?: string; commander: boolean }

export function parseDecklist(text: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  let section: 'main' | 'commander' | 'skip' = 'main';
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('#')) continue;
    const header = line.replace(/[:\s]+$/, '').toLowerCase();
    if (/^(commanders?|comandantes?)( \(\d+\))?$/.test(header)) { section = 'commander'; continue; }
    if (/^(sideboard|maybeboard|considering|tokens?)( \(\d+\))?$/.test(header)) { section = 'skip'; continue; }
    if (/^(deck|main|mainboard|baralho|companion)( \(\d+\))?$/.test(header)) { section = 'main'; continue; }
    const m = /^(\d+)\s*x?\s+(.+)$/i.exec(line);
    if (!m) { if (section !== 'skip') out.push({ count: 1, name: line, commander: section === 'commander' }); continue; }
    if (section === 'skip') continue;
    let rest = m[2];
    let commander = section === 'commander';
    if (/\*CMDR\*/i.test(rest) || /\[[^\]]*commander[^\]]*\]/i.test(rest)) commander = true;
    rest = rest.replace(/\[[^\]]*\]/g, '').replace(/\^[^^]*\^/g, '').replace(/\*[A-Z]+\*/gi, '').trim();
    let set: string | undefined, num: string | undefined;
    const sm = /\s+\(([A-Za-z0-9]{2,6})\)(?:\s+([A-Za-z0-9★-]+))?\s*$/.exec(rest);
    if (sm) { set = sm[1].toLowerCase(); num = sm[2]; rest = rest.slice(0, sm.index).trim(); }
    out.push({ count: parseInt(m[1], 10), name: rest, set, num, commander });
  }
  return out;
}

function toCardData(c: any): CardData {
  const f0 = c.card_faces?.[0], f1 = c.card_faces?.[1];
  return {
    sid: c.id,
    name: c.name,
    typeLine: c.type_line ?? f0?.type_line ?? '',
    manaCost: c.mana_cost ?? f0?.mana_cost ?? '',
    cmc: c.cmc ?? 0,
    oracle: c.oracle_text ?? (c.card_faces ?? []).map((f: any) => f.oracle_text).join('\n//\n'),
    power: c.power ?? f0?.power,
    toughness: c.toughness ?? f0?.toughness,
    loyalty: c.loyalty ?? f0?.loyalty,
    colorIdentity: c.color_identity ?? [],
    image: c.image_uris?.normal ?? f0?.image_uris?.normal,
    imageBack: f1?.image_uris?.normal,
    backName: f1?.name,
    legalCommander: c.legalities?.commander,
    set: c.set,
    num: c.collector_number,
  };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function collection(ids: object[]): Promise<{ data: any[]; not_found: any[] }> {
  const res = await fetch('https://api.scryfall.com/cards/collection', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ identifiers: ids }),
  });
  if (!res.ok) throw new Error(`O Scryfall respondeu ${res.status}. Tente de novo em alguns segundos.`);
  return res.json();
}

const norm = (s: string) => s.toLowerCase().split(' // ')[0].trim();

/** Resolve a lista no Scryfall. Devolve as entradas encontradas e os nomes que faltaram. */
export async function resolveDeck(lines: ParsedLine[], onProgress?: (done: number, total: number) => void) {
  const found = new Map<number, CardData>();
  const pending = lines.map((l, i) => ({ l, i }));
  const missing: string[] = [];
  for (let round = 0; round < 2 && pending.length; round++) {
    const batch = pending.splice(0);
    for (let k = 0; k < batch.length; k += 75) {
      const chunk = batch.slice(k, k + 75);
      const ids = chunk.map(({ l }) => round === 0 && l.set && l.num ? { set: l.set, collector_number: l.num } : { name: l.name });
      const r = await collection(ids);
      for (const { l, i } of chunk) {
        const hit = r.data.find(c => (round === 0 && l.set && l.num)
          ? c.set === l.set && String(c.collector_number) === l.num
          : norm(c.name) === norm(l.name) || (c.card_faces ?? []).some((f: any) => norm(f.name) === norm(l.name)));
        if (hit) found.set(i, toCardData(hit));
        else if (round === 0 && l.set) pending.push({ l, i });  // tenta só pelo nome
        else missing.push(l.name);
      }
      onProgress?.(found.size, lines.length);
      await sleep(110); // o Scryfall pede no máximo ~10 requisições por segundo
    }
  }
  const entries: DeckEntry[] = [];
  lines.forEach((l, i) => { const d = found.get(i); if (d) entries.push({ data: d, count: l.count, commander: l.commander }); });
  return { entries, missing };
}

export async function searchTokens(q: string): Promise<CardData[]> {
  const res = await fetch(`https://api.scryfall.com/cards/search?unique=art&q=${encodeURIComponent(`t:token ${q}`)}`);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error('Não deu para buscar tokens no Scryfall agora.');
  const j = await res.json();
  return (j.data ?? []).slice(0, 24).map(toCardData);
}

const BASICS = /^(Plains|Island|Swamp|Mountain|Forest|Wastes|Snow-Covered \w+)$/;

/** Checagem de legalidade de Commander (avisos, não bloqueia). */
export function commanderWarnings(entries: DeckEntry[]): string[] {
  const w: string[] = [];
  const cmds = entries.filter(e => e.commander);
  const total = entries.reduce((n, e) => n + e.count, 0);
  if (cmds.length === 0) w.push('Nenhum comandante marcado. Marque um na lista abaixo.');
  if (cmds.length > 2) w.push(`${cmds.length} comandantes marcados; o normal é 1 (ou 2 com Parceiro).`);
  if (total !== 100) w.push(`O deck tem ${total} cartas; Commander pede 100 contando o comandante.`);
  const identity = new Set(cmds.flatMap(e => e.data.colorIdentity));
  for (const e of entries) {
    const anyNumber = /any number of cards named/i.test(e.data.oracle);
    if (e.count > 1 && !BASICS.test(e.data.name) && !anyNumber) w.push(`${e.data.name}: ${e.count} cópias (Commander é singleton).`);
    if (e.data.legalCommander && !['legal', 'restricted'].includes(e.data.legalCommander)) w.push(`${e.data.name} não é legal em Commander.`);
    if (cmds.length && !e.commander && e.data.colorIdentity.some(c => !identity.has(c)))
      w.push(`${e.data.name} está fora da identidade de cor do comandante.`);
    if (e.commander && !/legendary/i.test(e.data.typeLine) && !/can be your commander/i.test(e.data.oracle))
      w.push(`${e.data.name} não é uma criatura lendária.`);
  }
  return w;
}
