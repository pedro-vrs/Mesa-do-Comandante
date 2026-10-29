package mesa.motor;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.nio.ByteBuffer;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * Conexão do motor com o site (WebSocket em /engine).
 * Mensagens em JSON, uma por quadro: { "t": "tipo", ... }.
 * Reconecta sozinho se a internet cair ou o site dormir.
 */
final class SiteLink implements WebSocket.Listener {
    private final Main.Config cfg;
    private final Engine engine;
    private final Gson gson = new Gson();
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(60)).build();
    private final ExecutorService inbox = Executors.newSingleThreadExecutor(r -> new Thread(r, "site-entrada"));
    private final StringBuilder partial = new StringBuilder();
    private volatile WebSocket ws;
    private volatile CountDownLatch closed;

    SiteLink(Main.Config cfg, Engine engine) {
        this.cfg = cfg;
        this.engine = engine;
    }

    void runForever() throws InterruptedException {
        int backoff = 2;
        while (true) {
            closed = new CountDownLatch(1);
            try {
                Log.info("Conectando ao site...");
                ws = http.newWebSocketBuilder()
                        .header("x-engine-key", cfg.key)
                        .header("x-engine-version", Main.Config.VERSION)
                        .connectTimeout(Duration.ofSeconds(60))
                        .buildAsync(URI.create(cfg.engineUrl()), this)
                        .get(90, TimeUnit.SECONDS);
                backoff = 2;
                Log.info("Conectado ao site. Pode voltar para o navegador e começar a partida.");
                // mantém a conexão viva atrás de proxies que derrubam conexões paradas
                while (!closed.await(25, TimeUnit.SECONDS)) {
                    WebSocket w = ws;
                    if (w != null) w.sendPing(ByteBuffer.allocate(0));
                }
            } catch (Exception e) {
                Log.warn("Sem conexão com o site (" + e.getClass().getSimpleName() + "). Tentando de novo em " + backoff + "s.");
            }
            ws = null;
            Thread.sleep(backoff * 1000L);
            backoff = Math.min(backoff * 2, 30);
        }
    }

    /** Envia uma mensagem ao site. Seguro para chamar de qualquer thread. */
    synchronized void send(Map<String, Object> msg) {
        WebSocket w = ws;
        if (w == null) return;
        try {
            w.sendText(gson.toJson(msg), true).get(30, TimeUnit.SECONDS);
        } catch (Exception e) {
            Log.warn("Falha ao enviar ao site: " + e.getMessage());
        }
    }

    @Override
    public void onOpen(WebSocket webSocket) {
        webSocket.request(1);
    }

    @Override
    public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
        partial.append(data);
        if (last) {
            String text = partial.toString();
            partial.setLength(0);
            inbox.submit(() -> {
                try {
                    JsonObject msg = JsonParser.parseString(text).getAsJsonObject();
                    engine.onMessage(msg);
                } catch (Exception e) {
                    Log.error("Mensagem do site com problema", e);
                }
            });
        }
        webSocket.request(1);
        return CompletableFuture.completedFuture(null);
    }

    @Override
    public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
        if (statusCode == 4401) Log.warn("O site recusou a chave do motor. Confira o código e a chave na mesa.");
        else if (statusCode == 4409) Log.warn("Já existe outro motor ligado nesta mesa.");
        else Log.warn("O site fechou a conexão (" + statusCode + (reason.isEmpty() ? "" : ": " + reason) + ").");
        if (closed != null) closed.countDown();
        return null;
    }

    @Override
    public void onError(WebSocket webSocket, Throwable error) {
        Log.warn("Erro na conexão com o site: " + error.getMessage());
        if (closed != null) closed.countDown();
    }
}
