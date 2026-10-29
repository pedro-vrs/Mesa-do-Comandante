package mesa.motor;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Coordena a partida: recebe ordens do site, cria os jogadores no XMage e devolve o que acontece.
 *
 * Do site para o motor:
 *   {t:"start", players:[{pid,name,deck:{name,entries:[{name,set,num,count,commander}]}}], life, deckType}
 *   {t:"resp", pid, kind:"uuid|bool|int|string|mana|action", value}
 *   {t:"chat", pid, text}   {t:"resync", pid}   {t:"stop"}
 * Do motor para o site:
 *   {t:"hello", version}   {t:"status", text}   {t:"error", text}
 *   {t:"to", pid, kind:"state|prompt|info|over|result|started", ...}
 *   {t:"log", user, text, type}
 */
final class Engine {
    private final Main.Config cfg;
    private SiteLink link;
    private final Map<String, PlayerBridge> bridges = new LinkedHashMap<>();
    private final ExecutorService worker = Executors.newSingleThreadExecutor(r -> new Thread(r, "partida"));

    Engine(Main.Config cfg) { this.cfg = cfg; }

    void setLink(SiteLink link) { this.link = link; }

    void onMessage(JsonObject m) {
        String t = m.has("t") ? m.get("t").getAsString() : "";
        switch (t) {
            case "welcome":
                link.send(Map.of("t", "hello", "version", Main.Config.VERSION));
                if (!bridges.isEmpty()) for (PlayerBridge b : snapshot()) b.resend();
                break;
            case "start":
                worker.submit(() -> start(m));
                break;
            case "stop":
                worker.submit(this::stop);
                break;
            case "resp": {
                PlayerBridge b = bridge(m);
                if (b != null) {
                    JsonElement v = m.get("value");
                    b.respond(m.get("kind").getAsString(), v == null || v.isJsonNull() ? null : v.getAsString());
                }
                break;
            }
            case "chat": {
                PlayerBridge b = bridge(m);
                if (b != null) b.chat(m.get("text").getAsString());
                break;
            }
            case "resync": {
                PlayerBridge b = bridge(m);
                if (b != null) b.resend();
                break;
            }
            default:
                break;
        }
    }

    private PlayerBridge bridge(JsonObject m) {
        if (!m.has("pid")) return null;
        synchronized (bridges) { return bridges.get(m.get("pid").getAsString()); }
    }

    private List<PlayerBridge> snapshot() {
        synchronized (bridges) { return new ArrayList<>(bridges.values()); }
    }

    private void start(JsonObject m) {
        stop();
        try {
            List<JsonObject> players = new ArrayList<>();
            for (JsonElement e : m.getAsJsonArray("players")) players.add(e.getAsJsonObject());
            if (players.size() < 2) throw new IllegalStateException("O XMage precisa de pelo menos 2 jogadores.");
            int life = m.has("life") ? m.get("life").getAsInt() : 40;
            String deckType = m.has("deckType") ? m.get("deckType").getAsString() : "Variant Magic - Freeform Commander";
            status("Preparando a partida no XMage...");

            // 1. decks: traduz os nomes para as cartas do XMage antes de mexer em qualquer mesa
            Map<String, Decks.Result> decks = new LinkedHashMap<>();
            List<String> problems = new ArrayList<>();
            for (JsonObject p : players) {
                Decks.Result d = Decks.build(p.getAsJsonObject("deck"));
                if (!d.missing.isEmpty()) problems.add(p.get("name").getAsString() + ": " + String.join(", ", d.missing));
                decks.put(p.get("pid").getAsString(), d);
            }
            if (!problems.isEmpty())
                throw new IllegalStateException("O XMage não conhece estas cartas (ou ainda não as implementou) — " + String.join(" | ", problems));

            // 2. uma sessão por jogador
            int seat = 0;
            for (JsonObject p : players) {
                String pid = p.get("pid").getAsString();
                PlayerBridge b = new PlayerBridge(cfg, this, pid, p.get("name").getAsString(), ++seat, seat == 1);
                b.connect();
                synchronized (bridges) { bridges.put(pid, b); }
            }

            // 3. mesa de Commander, todos sentam, o primeiro começa
            List<PlayerBridge> list = snapshot();
            PlayerBridge host = list.get(0);
            UUID table = host.createTable(list.size(), life, deckType);
            for (PlayerBridge b : list) b.joinTable(table, decks.get(b.pid).deck);
            host.startMatch(table);
            status("Partida começou no XMage.");
            Log.info("Partida começou com " + list.size() + " jogadores.");
        } catch (Exception e) {
            Log.error("Não deu para começar a partida", e);
            link.send(Map.of("t", "error", "text", e.getMessage() == null ? e.toString() : e.getMessage()));
            stop();
        }
    }

    private void stop() {
        List<PlayerBridge> list = snapshot();
        if (list.isEmpty()) return;
        for (PlayerBridge b : list) b.disconnect();
        synchronized (bridges) { bridges.clear(); }
        Log.info("Partida encerrada no motor.");
    }

    void shutdown() { stop(); }

    // ---------- saída para o site ----------

    void toPlayer(String pid, String kind, Map<String, Object> body) {
        Map<String, Object> msg = new LinkedHashMap<>(body);
        msg.put("t", "to");
        msg.put("pid", pid);
        msg.put("kind", kind);
        link.send(msg);
    }

    void log(String user, String text, String type) {
        if (text == null || text.isEmpty()) return;
        Map<String, Object> msg = new LinkedHashMap<>();
        msg.put("t", "log");
        msg.put("user", user == null ? "" : user);
        msg.put("text", text);
        msg.put("type", type);
        link.send(msg);
    }

    private void status(String text) { link.send(Map.of("t", "status", "text", text)); }
}
