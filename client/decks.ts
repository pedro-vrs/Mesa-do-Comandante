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
    { data: c('Serra Angel', 'Creature — Angel', { power: '4', toughness: '4', manaCost: '{3}{W}{W}', oracle: 'Flying, vigilance' }), count: 1 },
    { data: c('Giant Spider', 'Creature — Spider', { power: '2', toughness: '4', manaCost: '{3}{G}', oracle: 'Reach' }), count: 1 },
    { data: c('Vampire Nighthawk', 'Creature — Vampire Shaman', { power: '2', toughness: '3', manaCost: '{1}{B}{B}', oracle: 'Flying\nDeathtouch\nLifelink' }), count: 1 },
    { data: c('Colossal Dreadmaw', 'Creature — Dinosaur', { power: '6', toughness: '6', manaCost: '{4}{G}{G}', oracle: 'Trample' }), count: 1 },
    { data: c('Boros Swiftblade', 'Creature — Human Soldier', { power: '1', toughness: '2', manaCost: '{R}{W}', oracle: 'Double strike' }), count: 1 },
    { data: c('Youthful Knight', 'Creature — Human Knight', { power: '2', toughness: '1', manaCost: '{1}{W}', oracle: 'First strike' }), count: 1 },
    { data: c('Darksteel Myr', 'Artifact Creature — Myr', { power: '0', toughness: '1', manaCost: '{3}', oracle: 'Indestructible' }), count: 1 },
    { data: c('Gladecover Scout', 'Creature — Elf Scout', { power: '1', toughness: '1', manaCost: '{G}', oracle: 'Hexproof' }), count: 1 },
    { data: c('Wall of Wood', 'Creature — Wall', { power: '0', toughness: '3', manaCost: '{G}', oracle: 'Defender' }), count: 1 },
    { data: c('Raging Goblin', 'Creature — Goblin Berserker', { power: '1', toughness: '1', manaCost: '{R}', oracle: 'Haste' }), count: 1 },
    { data: c('Ambush Viper', 'Creature — Snake', { power: '2', toughness: '1', manaCost: '{1}{G}', oracle: 'Flash\nDeathtouch' }), count: 1 },
    { data: c('Boggart Brute', 'Creature — Goblin Warrior', { power: '3', toughness: '2', manaCost: '{2}{R}', oracle: 'Menace' }), count: 1 },
    { data: c('Guardião de Teste', 'Creature — Spirit', { power: '2', toughness: '2', manaCost: '{1}{U}', oracle: 'Ward {2}' }), count: 1 },
    { data: c('Murder', 'Instant', { manaCost: '{1}{B}{B}', oracle: 'Destroy target creature.' }), count: 1 },
    { data: c('Grizzly Bears', 'Creature — Bear', { power: '2', toughness: '2', manaCost: '{1}{G}' }), count: 40 },
  ];
  return { id: 'demo', name: 'Teste: habilidades (sem internet)', entries, updated: 0 };
}
