package mesa.motor;

import mage.view.CardView;
import mage.view.CardsView;
import mage.view.CombatGroupView;
import mage.view.CommandObjectView;
import mage.view.CounterView;
import mage.view.ExileView;
import mage.view.GameView;
import mage.view.LookedAtView;
import mage.view.ManaPoolView;
import mage.view.PermanentView;
import mage.view.PlayerView;
import mage.view.RevealedView;
import mage.view.SimpleCardView;
import mage.view.SimpleCardsView;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Traduz o GameView do XMage para o JSON que o site desenha.
 * Cada jogador recebe a sua visão (a própria mão; das outras, só a quantidade).
 */
final class ViewMapper {
    private ViewMapper() {}

    static Map<String, Object> game(GameView g, UUID me) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("turn", g.getTurn());
        out.put("phase", g.getPhase() == null ? null : g.getPhase().name());
        out.put("step", g.getStep() == null ? null : g.getStep().name());
        out.put("activePlayerId", str(g.getActivePlayerId()));
        out.put("activeName", g.getActivePlayerName());
        out.put("priorityName", g.getPriorityPlayerName());
        out.put("special", g.getSpecial());
        out.put("me", str(me));

        List<Object> players = new ArrayList<>();
        for (PlayerView p : g.getPlayers()) players.add(player(p, me));
        out.put("players", players);

        out.put("hand", cards(g.getMyHand()));
        out.put("stack", cards(g.getStack()));

        List<Object> exiles = new ArrayList<>();
        if (g.getExile() != null) for (ExileView e : g.getExile()) exiles.add(zone(e.getName(), e));
        out.put("exileZones", exiles);

        List<Object> revealed = new ArrayList<>();
        if (g.getRevealed() != null) for (RevealedView r : g.getRevealed()) revealed.add(zone(r.getName(), r.getCards()));
        out.put("revealed", revealed);

        List<Object> lookedAt = new ArrayList<>();
        if (g.getLookedAt() != null) for (LookedAtView l : g.getLookedAt()) {
            Map<String, Object> z = new LinkedHashMap<>();
            z.put("name", l.getName());
            List<Object> cs = new ArrayList<>();
            if (l.getCards() != null) for (SimpleCardView sc : l.getCards().values()) {
                Map<String, Object> cm = new LinkedHashMap<>();
                cm.put("id", str(sc.getId()));
                cm.put("set", sc.getExpansionSetCode());
                cm.put("num", sc.getCardNumber());
                cs.add(cm);
            }
            z.put("cards", cs);
            lookedAt.add(z);
        }
        out.put("lookedAt", lookedAt);

        List<Object> combat = new ArrayList<>();
        if (g.getCombat() != null) for (CombatGroupView c : g.getCombat()) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("defender", c.getDefenderName());
            m.put("defenderId", str(c.getDefenderId()));
            m.put("attackers", ids(c.getAttackers()));
            m.put("blockers", ids(c.getBlockers()));
            m.put("blocked", c.isBlocked());
            combat.add(m);
        }
        out.put("combat", combat);

        List<String> playable = new ArrayList<>();
        if (g.getCanPlayObjects() != null && g.getCanPlayObjects().getObjects() != null)
            for (UUID id : g.getCanPlayObjects().getObjects().keySet()) playable.add(id.toString());
        out.put("canPlay", playable);
        return out;
    }

    static Map<String, Object> player(PlayerView p, UUID me) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", str(p.getPlayerId()));
        m.put("name", p.getName());
        m.put("isMe", p.getPlayerId().equals(me));
        m.put("life", p.getLife());
        m.put("library", p.getLibraryCount());
        m.put("hand", p.getHandCount());
        m.put("active", p.isActive());
        m.put("hasPriority", p.hasPriority());
        m.put("left", p.hasLeft());
        m.put("monarch", p.isMonarch());
        m.put("initiative", p.isInitiative());
        m.put("designations", p.getDesignationNames());
        m.put("counters", counters(p.getCounters()));
        m.put("pool", pool(p.getManaPool()));
        m.put("graveyard", cards(p.getGraveyard()));
        m.put("exile", cards(p.getExile()));
        List<Object> perms = new ArrayList<>();
        if (p.getBattlefield() != null) for (PermanentView pv : p.getBattlefield().values()) perms.add(permanent(pv));
        m.put("battlefield", perms);
        List<Object> command = new ArrayList<>();
        if (p.getCommandObjectList() != null) for (CommandObjectView c : p.getCommandObjectList()) {
            Map<String, Object> cm = new LinkedHashMap<>();
            cm.put("id", str(c.getId()));
            cm.put("name", c.getName());
            cm.put("set", c.getExpansionSetCode());
            cm.put("rules", c.getRules());
            if (c instanceof CardView) {
                CardView cv = (CardView) c;
                cm.put("num", cv.getCardNumber());
                cm.put("cost", cv.getManaCostStr());
                cm.put("type", cv.getTypeText());
            }
            command.add(cm);
        }
        m.put("command", command);
        return m;
    }

    static Map<String, Object> permanent(PermanentView p) {
        Map<String, Object> m = card(p);
        m.put("tapped", p.isTapped());
        m.put("damage", p.getDamage());
        m.put("sick", p.hasSummoningSickness());
        m.put("attachedTo", str(p.getAttachedTo()));
        m.put("controller", p.getNameController());
        m.put("owner", p.getNameOwner());
        m.put("copy", p.isCopy());
        m.put("phasedOut", !p.isPhasedIn());
        return m;
    }

    static Map<String, Object> card(CardView c) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", str(c.getId()));
        m.put("name", c.getDisplayName());
        m.put("set", c.getExpansionSetCode());
        m.put("num", c.getCardNumber());
        m.put("cost", c.getManaCostStr());
        m.put("type", c.getTypeText());
        m.put("rules", c.getRules());
        m.put("power", c.getPower());
        m.put("toughness", c.getToughness());
        m.put("loyalty", c.getLoyalty());
        m.put("defense", c.getDefense());
        m.put("counters", counters(c.getCounters()));
        m.put("faceDown", c.isFaceDown());
        m.put("token", c.isToken());
        m.put("ability", c.isAbility());
        m.put("transformed", c.isTransformed());
        m.put("land", c.isLand());
        m.put("creature", c.isCreature());
        List<String> targets = new ArrayList<>();
        if (c.getTargets() != null) for (UUID t : c.getTargets()) targets.add(t.toString());
        m.put("targets", targets);
        CardView back = c.getSecondCardFace();
        if (back != null) {
            Map<String, Object> b = new LinkedHashMap<>();
            b.put("name", back.getDisplayName());
            b.put("set", back.getExpansionSetCode());
            b.put("num", back.getCardNumber());
            b.put("type", back.getTypeText());
            b.put("rules", back.getRules());
            m.put("back", b);
        }
        if (c.isAbility() && c.getAbility() == null) m.put("source", c.getName());
        return m;
    }

    static List<Object> cards(Map<UUID, ? extends CardView> cards) {
        List<Object> out = new ArrayList<>();
        if (cards != null) for (CardView c : cards.values()) out.add(c instanceof PermanentView ? permanent((PermanentView) c) : card(c));
        return out;
    }

    static List<String> ids(CardsView cards) {
        List<String> out = new ArrayList<>();
        if (cards != null) for (UUID id : cards.keySet()) out.add(id.toString());
        return out;
    }

    static Map<String, Object> zone(String name, CardsView cards) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("name", name);
        m.put("cards", cards(cards));
        return m;
    }

    static Map<String, Integer> counters(Collection<CounterView> list) {
        Map<String, Integer> m = new LinkedHashMap<>();
        if (list != null) for (CounterView c : list) m.put(c.getName(), c.getCount());
        return m;
    }

    static Map<String, Integer> pool(ManaPoolView p) {
        Map<String, Integer> m = new LinkedHashMap<>();
        if (p == null) return m;
        m.put("W", p.getWhite());
        m.put("U", p.getBlue());
        m.put("B", p.getBlack());
        m.put("R", p.getRed());
        m.put("G", p.getGreen());
        m.put("C", p.getColorless());
        return m;
    }

    static int size(SimpleCardsView v) { return v == null ? 0 : v.size(); }

    static String str(UUID id) { return id == null ? null : id.toString(); }
}
