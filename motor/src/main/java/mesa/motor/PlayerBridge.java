package mesa.motor;

import mage.cards.decks.DeckCardLists;
import mage.choices.Choice;
import mage.constants.ManaType;
import mage.constants.PlayerAction;
import mage.game.match.MatchOptions;
import mage.interfaces.MageClient;
import mage.interfaces.callback.ClientCallback;
import mage.players.PlayerType;
import mage.remote.Connection;
import mage.remote.Session;
import mage.remote.SessionImpl;
import mage.util.MultiAmountMessage;
import mage.utils.MageVersion;
import mage.view.AbilityPickerView;
import mage.view.ChatMessage;
import mage.view.GameClientMessage;
import mage.view.GameEndView;
import mage.view.GameView;
import mage.view.TableClientMessage;
import mage.view.TableView;

import java.io.Serializable;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * Um jogador do site dentro do XMage: uma sessão de cliente, igual à do programa oficial,
 * mas que em vez de desenhar a tela repassa tudo ao navegador daquele jogador.
 */
final class PlayerBridge implements MageClient {
    private static final MageVersion VERSION = new MageVersion(MageClient.class);

    final String pid;          // id do jogador no site
    final String displayName;  // nome que aparece na mesa
    final String userName;     // nome no XMage (3 a 14 caracteres)
    private final Main.Config cfg;
    private final Engine engine;
    private final boolean logger; // só um jogador repassa o registro do jogo, para não duplicar

    private Session session;
    private UUID roomId;
    private volatile UUID gameId;
    private volatile UUID playerId;
    private volatile Map<String, Object> lastState;
    private volatile Map<String, Object> lastPrompt;

    PlayerBridge(Main.Config cfg, Engine engine, String pid, String displayName, int seat, boolean logger) {
        this.cfg = cfg;
        this.engine = engine;
        this.pid = pid;
        this.displayName = displayName;
        this.logger = logger;
        String clean = displayName.replaceAll("[^A-Za-z0-9]", "");
        if (clean.length() > 10) clean = clean.substring(0, 10);
        this.userName = (clean.length() < 1 ? "Jogador" : clean) + "_" + seat + Integer.toString((int) (Math.random() * 36), 36);
    }

    // ---------- conexão e mesa ----------

    void connect() {
        Connection con = new Connection();
        con.setUsername(userName);
        con.setHost(cfg.xmageHost);
        con.setPort(cfg.xmagePort);
        con.setProxyType(Connection.ProxyType.NONE);
        session = new SessionImpl(this);
        if (!session.connectStart(con)) throw new IllegalStateException("Não consegui conectar " + displayName + " ao XMage: " + session.getLastError());
        roomId = session.getMainRoomId();
    }

    UUID createTable(int players, int startingLife, String deckType) {
        MatchOptions o = new MatchOptions("Mesa do Comandante", "Commander Free For All", true);
        for (int i = 0; i < players; i++) o.getPlayerTypes().add(PlayerType.HUMAN);
        o.setDeckType(deckType);
        o.setLimited(false);
        o.setWinsNeeded(1);
        o.setAttackOption(mage.constants.MultiplayerAttackOption.MULTIPLE);
        o.setRange(mage.constants.RangeOfInfluence.ALL);
        o.setMatchTimeLimit(mage.constants.MatchTimeLimit.NONE);
        o.setSpectatorsAllowed(false);
        o.setRollbackTurnsAllowed(true);
        o.setFreeMulligans(1);
        if (startingLife != 40) {
            o.setCustomStartLifeEnabled(true);
            o.setCustomStartLife(startingLife);
        }
        TableView table = session.createTable(roomId, o);
        if (table == null) throw new IllegalStateException("O XMage não criou a mesa: " + session.getLastError());
        return table.getTableId();
    }

    void joinTable(UUID tableId, DeckCardLists deck) {
        if (!session.joinTable(roomId, tableId, userName, PlayerType.HUMAN, 1, deck, ""))
            throw new IllegalStateException("O XMage recusou o deck de " + displayName + ": " + session.getLastError());
    }

    void startMatch(UUID tableId) {
        if (!session.startMatch(roomId, tableId)) throw new IllegalStateException("O XMage não começou a partida: " + session.getLastError());
    }

    void disconnect() {
        try {
            if (session != null && session.isConnected()) session.connectStop(false, false);
        } catch (Exception ignored) { }
    }

    // ---------- respostas vindas do navegador ----------

    void respond(String kind, String value) {
        UUID g = gameId;
        if (g == null) return;
        lastPrompt = null;
        switch (kind) {
            case "uuid": session.sendPlayerUUID(g, value == null || value.isEmpty() ? null : UUID.fromString(value)); break;
            case "bool": session.sendPlayerBoolean(g, Boolean.parseBoolean(value)); break;
            case "int": session.sendPlayerInteger(g, Integer.parseInt(value)); break;
            case "string": session.sendPlayerString(g, value); break;
            case "mana": session.sendPlayerManaType(g, playerId, ManaType.valueOf(value)); break;
            case "action": session.sendPlayerAction(PlayerAction.valueOf(value), g, null); break;
            default: Log.warn("Resposta desconhecida do site: " + kind);
        }
    }

    void chat(String text) {
        UUID g = gameId;
        if (g == null) return;
        Optional<UUID> chat = session.getGameChatId(g);
        chat.ifPresent(id -> session.sendChatMessage(id, text));
    }

    /** O navegador reconectou: manda de novo o último estado e a decisão pendente. */
    void resend() {
        if (lastState != null) engine.toPlayer(pid, "state", Map.of("game", lastState));
        if (lastPrompt != null) engine.toPlayer(pid, "prompt", Map.of("prompt", lastPrompt));
    }

    // ---------- callbacks do XMage ----------

    @Override
    public void onCallback(ClientCallback callback) {
        try {
            callback.decompressData();
            handle(callback);
        } catch (Throwable e) {
            Log.error("Falha ao tratar " + callback.getMethod() + " de " + displayName, e);
        }
    }

    private void handle(ClientCallback cb) {
        Object data = cb.getData();
        switch (cb.getMethod()) {
            case START_GAME: {
                TableClientMessage m = (TableClientMessage) data;
                gameId = m.getGameId();
                playerId = m.getPlayerId();
                session.joinGame(gameId);
                if (logger) session.getGameChatId(gameId).ifPresent(session::joinChat);
                engine.toPlayer(pid, "started", Map.of("playerId", playerId.toString()));
                break;
            }
            case GAME_INIT:
            case GAME_UPDATE:
                state((GameView) data);
                break;
            case GAME_UPDATE_AND_INFORM: {
                GameClientMessage m = (GameClientMessage) data;
                state(m.getGameView());
                break;
            }
            case GAME_INFORM_PERSONAL: {
                GameClientMessage m = (GameClientMessage) data;
                state(m.getGameView());
                engine.toPlayer(pid, "info", Map.of("text", Text.plain(m.getMessage())));
                break;
            }
            case GAME_ASK: {
                GameClientMessage m = (GameClientMessage) data;
                prompt(m.getGameView(), base("ask", m.getMessage(), m.getOptions(), "Sim", "Não"));
                break;
            }
            case GAME_SELECT: {
                GameClientMessage m = (GameClientMessage) data;
                Map<String, Object> p = base("select", m.getMessage(), m.getOptions(), "", "Pronto");
                putIds(p, "attackers", m.getOptions(), "possibleAttackers");
                putIds(p, "blockers", m.getOptions(), "possibleBlockers");
                prompt(m.getGameView(), p);
                break;
            }
            case GAME_TARGET: {
                GameClientMessage m = (GameClientMessage) data;
                boolean required = m.isFlag();
                Map<String, Object> p = base("target", m.getMessage(), m.getOptions(), "", required ? "" : "Cancelar");
                p.put("required", required);
                List<String> targets = new ArrayList<>();
                if (m.getTargets() != null) for (UUID t : m.getTargets()) targets.add(t.toString());
                p.put("targets", targets);
                p.put("cards", ViewMapper.cards(m.getCardsView1()));
                Object chosen = m.getOptions() == null ? null : m.getOptions().get("chosenTargets");
                if (chosen instanceof java.util.Collection) {
                    List<String> c = new ArrayList<>();
                    for (Object o : (java.util.Collection<?>) chosen) c.add(String.valueOf(o));
                    p.put("chosen", c);
                }
                prompt(m.getGameView(), p);
                break;
            }
            case GAME_PLAY_MANA: {
                GameClientMessage m = (GameClientMessage) data;
                prompt(m.getGameView(), base("mana", m.getMessage(), m.getOptions(), "", "Cancelar"));
                break;
            }
            case GAME_PLAY_XMANA: {
                GameClientMessage m = (GameClientMessage) data;
                prompt(m.getGameView(), base("xmana", m.getMessage(), m.getOptions(), "Pronto", "Cancelar"));
                break;
            }
            case GAME_GET_AMOUNT: {
                GameClientMessage m = (GameClientMessage) data;
                Map<String, Object> p = base("amount", m.getMessage(), m.getOptions(), "", "");
                p.put("min", m.getMin());
                p.put("max", m.getMax());
                prompt(m.getGameView(), p);
                break;
            }
            case GAME_GET_MULTI_AMOUNT: {
                GameClientMessage m = (GameClientMessage) data;
                Map<String, Object> p = base("multiAmount", m.getMessage(), m.getOptions(), "", "");
                List<Object> parts = new ArrayList<>();
                if (m.getMessages() != null) for (MultiAmountMessage x : m.getMessages()) {
                    Map<String, Object> e = new LinkedHashMap<>();
                    e.put("text", Text.plain(x.message));
                    e.put("min", x.min);
                    e.put("max", x.max);
                    e.put("default", x.defaultValue);
                    parts.add(e);
                }
                p.put("parts", parts);
                p.put("min", m.getMin());
                p.put("max", m.getMax());
                prompt(m.getGameView(), p);
                break;
            }
            case GAME_CHOOSE_PILE: {
                GameClientMessage m = (GameClientMessage) data;
                Map<String, Object> p = base("pile", m.getMessage(), m.getOptions(), "", "");
                p.put("pile1", ViewMapper.cards(m.getCardsView1()));
                p.put("pile2", ViewMapper.cards(m.getCardsView2()));
                prompt(m.getGameView(), p);
                break;
            }
            case GAME_CHOOSE_CHOICE: {
                GameClientMessage m = (GameClientMessage) data;
                Choice ch = m.getChoice();
                Map<String, Object> p = base("choice", ch == null ? m.getMessage() : ch.getMessage(), m.getOptions(), "", ch != null && ch.isRequired() ? "" : "Cancelar");
                List<Object> list = new ArrayList<>();
                if (ch != null) {
                    if (ch.isKeyChoice()) for (Map.Entry<String, String> e : ch.getKeyChoices().entrySet()) list.add(Map.of("key", e.getKey(), "label", Text.plain(e.getValue())));
                    else for (String s : ch.getChoices()) list.add(Map.of("key", s, "label", Text.plain(s)));
                    if (ch.getSubMessage() != null) p.put("sub", Text.plain(ch.getSubMessage()));
                }
                p.put("choices", list);
                prompt(m.getGameView(), p);
                break;
            }
            case GAME_CHOOSE_ABILITY: {
                AbilityPickerView a = (AbilityPickerView) data;
                Map<String, Object> p = base("ability", a.getMessage(), null, "", "Cancelar");
                List<Object> list = new ArrayList<>();
                if (a.getChoices() != null) for (Map.Entry<UUID, String> e : a.getChoices().entrySet())
                    list.add(Map.of("key", e.getKey().toString(), "label", Text.plain(e.getValue())));
                p.put("choices", list);
                prompt(a.getGameView(), p);
                break;
            }
            case GAME_OVER: {
                GameClientMessage m = (GameClientMessage) data;
                if (m.getGameView() != null) state(m.getGameView());
                lastPrompt = null;
                engine.toPlayer(pid, "over", Map.of("text", Text.plain(m.getMessage())));
                break;
            }
            case END_GAME_INFO: {
                GameEndView e = (GameEndView) data;
                engine.toPlayer(pid, "result", Map.of("won", e.hasWon()));
                break;
            }
            case GAME_ERROR:
                engine.toPlayer(pid, "info", Map.of("text", "O XMage avisou um erro: " + Text.plain(String.valueOf(data))));
                break;
            case CHATMESSAGE: {
                if (!logger) break;
                ChatMessage m = (ChatMessage) data;
                engine.log(m.getUsername(), Text.plain(m.getMessage()), m.getMessageType() == null ? "" : m.getMessageType().name());
                break;
            }
            case SHOW_USERMESSAGE: {
                @SuppressWarnings("unchecked") List<String> parts = (List<String>) data;
                engine.toPlayer(pid, "info", Map.of("text", Text.plain(String.join(": ", parts))));
                break;
            }
            default:
                break; // mesas, torneios, draft e replay não são usados aqui
        }
    }

    private Map<String, Object> base(String type, String message, Map<String, Serializable> options, String left, String right) {
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("type", type);
        p.put("message", Text.plain(message));
        String l = left, r = right;
        if (options != null) {
            if (options.get("UI.left.btn.text") instanceof String) l = (String) options.get("UI.left.btn.text");
            if (options.get("UI.right.btn.text") instanceof String) r = (String) options.get("UI.right.btn.text");
            if (options.get("specialButton") instanceof String) p.put("special", Text.plain((String) options.get("specialButton")));
            if (options.get("secondMessage") instanceof String) p.put("sub", Text.plain((String) options.get("secondMessage")));
            if (options.get("hintText") instanceof String) p.put("hint", Text.plain((String) options.get("hintText")));
        }
        p.put("left", Text.button(l));
        p.put("right", Text.button(r));
        return p;
    }

    private static void putIds(Map<String, Object> p, String key, Map<String, Serializable> options, String option) {
        if (options == null || !(options.get(option) instanceof java.util.Collection)) return;
        List<String> ids = new ArrayList<>();
        for (Object o : (java.util.Collection<?>) options.get(option)) ids.add(String.valueOf(o));
        p.put(key, ids);
    }

    private void state(GameView g) {
        if (g == null) return;
        Map<String, Object> s = ViewMapper.game(g, playerId);
        lastState = s;
        engine.toPlayer(pid, "state", Map.of("game", s));
    }

    private void prompt(GameView g, Map<String, Object> p) {
        if (g != null) {
            if (g.getSpecial() && !p.containsKey("special")) p.put("special", "Especial");
            state(g);
        }
        lastPrompt = p;
        engine.toPlayer(pid, "prompt", Map.of("prompt", p));
    }

    // ---------- MageClient ----------

    @Override public MageVersion getVersion() { return VERSION; }
    @Override public void connected(String message) { Log.info(displayName + " conectado ao XMage."); }
    @Override public void disconnected(boolean askToReconnect, boolean keepMySessionActive) { Log.info(displayName + " desconectado do XMage."); }
    @Override public void showMessage(String message) { Log.info("XMage para " + displayName + ": " + Text.plain(message)); }
    @Override public void showError(String message) { Log.warn("XMage para " + displayName + ": " + Text.plain(message)); engine.toPlayer(pid, "info", Map.of("text", Text.plain(message))); }
    @Override public void onNewConnection() { }
}
