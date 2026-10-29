// Decks salvos no navegador.
import type { CardData, DeckEntry } from '../shared/types';

export interface SavedDeck { id: string; name: string; entries: DeckEntry[]; updated: number }

const KEY = 'mesa.decks.v1';

export function loadDecks(): SavedDeck[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]'); } catch { return []; }
}
export function saveDecks(d: SavedDeck[]) {
  try { localStorage.setItem(KEY, JSON.stringify(d)); } catch { /* armazenamento cheio ou bloqueado */ }
}
export function upsertDeck(deck: SavedDeck) {
  const all = loadDecks().filter(d => d.id !== deck.id);
  all.unshift({ ...deck, updated: Date.now() });
  saveDecks(all);
}
export function deleteDeck(id: string) { saveDecks(loadDecks().filter(d => d.id !== id)); }

export function getPref(k: string, fallback = ''): string {
  try { return localStorage.getItem(`mesa.${k}`) ?? fallback; } catch { return fallback; }
}
export function setPref(k: string, v: string) {
  try { localStorage.setItem(`mesa.${k}`, v); } catch { /* ok */ }
}

const c = (name: string, typeLine: string, extra: Partial<CardData> = {}): CardData => ({
  sid: `demo-${name}`, name, typeLine, manaCost: '', cmc: 0, oracle: '', colorIdentity: ['G'], ...extra,
});

/** Deck de teste que funciona sem internet (cartas sem imagem). */
export function demoDeck(): SavedDeck {
  const entries: DeckEntry[] = [
    { data: c('Selvala, Heart of the Wilds', 'Legendary Creature — Elf Scout', { power: '2', toughness: '3', manaCost: '{1}{G}{G}', oracle: 'Whenever another creature enters, its controller may draw a card if its power is greater than each other creature\'s power.\n{G}, {T}: Add X mana in any combination of colors, where X is the greatest power among creatures you control.' }), count: 1, commander: true },
    { data: c('Forest', 'Basic Land — Forest', { colorIdentity: [], oracle: '({T}: Add {G}.)' }), count: 36 },
    { data: c('Llanowar Elves', 'Creature — Elf Druid', { power: '1', toughness: '1', manaCost: '{G}', oracle: '{T}: Add {G}.' }), count: 1 },
    { data: c('Sol Ring', 'Artifact', { colorIdentity: [], manaCost: '{1}', oracle: '{T}: Add {C}{C}.' }), count: 1 },
    { data: c('Craterhoof Behemoth', 'Creature — Beast', { power: '5', toughness: '5', manaCost: '{5}{G}{G}{G}', oracle: 'Haste\nWhen this creature enters, creatures you control gain trample and get +X/+X until end of turn, where X is the number of creatures you control.' }), count: 1 },
    { data: c('Giant Growth', 'Instant', { manaCost: '{G}', oracle: 'Target creature gets +3/+3 until end of turn.' }), count: 1 },
    { data: c('Beast Within', 'Instant', { manaCost: '{2}{G}', oracle: 'Destroy target permanent. Its controller creates a 3/3 green Beast creature token.' }), count: 1 },
    { data: c('Rampant Growth', 'Sorcery', { manaCost: '{1}{G}', oracle: 'Search your library for a basic land card, put that card onto the battlefield tapped, then shuffle.' }), count: 1 },
    { data: c('Elvish Mystic', 'Creature — Elf Druid', { power: '1', toughness: '1', manaCost: '{G}', oracle: '{T}: Add {G}.' }), count: 1 },
    { data: c('Garruk Wildspeaker', 'Legendary Planeswalker — Garruk', { manaCost: '{2}{G}{G}', loyalty: '3', oracle: '+1: Untap two target lands.\n−1: Create a 3/3 green Beast creature token.\n−4: Creatures you control get +3/+3 and gain trample until end of turn.' }), count: 1 },
    { data: c('Rancor', 'Enchantment — Aura', { manaCost: '{G}', oracle: 'Enchant creature\nEnchanted creature gets +2/+0 and has trample.' }), count: 1 },
    { data: c('Grizzly Bears', 'Creature — Bear', { power: '2', toughness: '2', manaCost: '{1}{G}' }), count: 54 },
  ];
  return { id: 'demo', name: 'Teste: Selvala (sem internet)', entries, updated: 0 };
}
