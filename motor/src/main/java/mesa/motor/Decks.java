package mesa.motor;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import mage.cards.decks.DeckCardInfo;
import mage.cards.decks.DeckCardLists;
import mage.cards.repository.CardInfo;
import mage.cards.repository.CardRepository;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Converte o deck que veio do site (nomes do Scryfall, com coleção e número quando houver)
 * para o formato do XMage. No Commander do XMage, o comandante vai no sideboard.
 */
final class Decks {
    private Decks() {}

    static final class Result {
        final DeckCardLists deck = new DeckCardLists();
        final List<String> missing = new ArrayList<>();
    }

    static Result build(JsonObject json) {
        Result r = new Result();
        r.deck.setName(str(json, "name", "Deck"));
        JsonArray entries = json.has("entries") ? json.getAsJsonArray("entries") : new JsonArray();
        for (JsonElement el : entries) {
            JsonObject e = el.getAsJsonObject();
            String name = str(e, "name", "");
            String set = str(e, "set", "");
            String num = str(e, "num", "");
            int count = e.has("count") ? Math.max(1, e.get("count").getAsInt()) : 1;
            boolean commander = e.has("commander") && e.get("commander").getAsBoolean();
            CardInfo info = find(name, set, num);
            if (info == null) {
                r.missing.add(name);
                continue;
            }
            DeckCardInfo dci = new DeckCardInfo(info.getName(), info.getCardNumber(), info.getSetCode(), count);
            if (commander) r.deck.getSideboard().add(dci);
            else r.deck.getCards().add(dci);
        }
        return r;
    }

    /** Procura a carta no banco do XMage: primeiro a mesma impressão, depois pelo nome. */
    static CardInfo find(String name, String set, String num) {
        CardRepository repo = CardRepository.instance;
        String setCode = set.toUpperCase(Locale.ROOT);
        if (!setCode.isEmpty() && !num.isEmpty()) {
            CardInfo exact = repo.findCard(setCode, num);
            if (exact != null && sameName(exact.getName(), name)) return exact;
        }
        for (String candidate : candidates(name)) {
            CardInfo c = repo.findPreferredCoreExpansionCard(candidate, setCode);
            if (c != null) return c;
            List<CardInfo> any = repo.findCards(candidate);
            if (!any.isEmpty()) return any.get(0);
        }
        return null;
    }

    /** "Fire // Ice" e cartas de duas faces: o XMage às vezes guarda só a face da frente. */
    private static List<String> candidates(String name) {
        List<String> out = new ArrayList<>();
        out.add(name);
        if (name.contains(" // ")) out.add(name.substring(0, name.indexOf(" // ")));
        return out;
    }

    private static boolean sameName(String a, String b) {
        String x = a.toLowerCase(Locale.ROOT), y = b.toLowerCase(Locale.ROOT);
        return x.equals(y) || y.startsWith(x + " //") || x.startsWith(y + " //");
    }

    private static String str(JsonObject o, String k, String def) {
        return o.has(k) && !o.get(k).isJsonNull() ? o.get(k).getAsString() : def;
    }
}
