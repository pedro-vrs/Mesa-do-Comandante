package mesa.motor;

import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Motor da Mesa.
 *
 * Roda no computador de quem abre a partida, dentro da pasta do servidor do XMage:
 *   java --add-opens=java.base/java.io=ALL-UNNAMED -cp "motor-da-mesa.jar:lib/*" mesa.motor.Main --room abc123 --key SEGREDO
 *
 * 1. Sobe o servidor do XMage nesta máquina (se ainda não estiver rodando).
 * 2. Conecta ao site e se apresenta como o juiz daquela mesa.
 * 3. Para cada jogador do site, abre uma sessão no XMage e repassa estado e decisões.
 */
public final class Main {

    public static void main(String[] args) throws Exception {
        Config cfg = Config.parse(args);
        if (cfg.room == null || cfg.key == null) {
            System.out.println("Uso: motor --room CODIGO --key CHAVE [--site https://mesa-do-comandante.onrender.com]");
            System.out.println("O código e a chave aparecem no site, na mesa em modo XMage, para quem a criou.");
            System.exit(2);
        }
        Log.info("Motor da Mesa " + Config.VERSION + " — mesa " + cfg.room + " em " + cfg.site);

        XmageServer server = new XmageServer(cfg);
        if (!cfg.noServer) server.ensureRunning();

        Engine engine = new Engine(cfg);
        SiteLink link = new SiteLink(cfg, engine);
        engine.setLink(link);
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            engine.shutdown();
            server.stop();
        }, "desligar"));
        link.runForever();
    }

    /** Opções da linha de comando. */
    public static final class Config {
        static final String VERSION = "0.1.0";
        String site = "https://mesa-do-comandante.onrender.com";
        String room;
        String key;
        String xmageHost = "localhost";
        int xmagePort = 17171;
        boolean noServer = false;          // usar um servidor XMage que já está rodando
        Path serverDir = Path.of(".").toAbsolutePath().normalize();
        String serverMemory = "1024m";

        static Config parse(String[] args) {
            Config c = new Config();
            for (int i = 0; i < args.length; i++) {
                String a = args[i];
                String v = i + 1 < args.length ? args[i + 1] : null;
                switch (a) {
                    case "--site": c.site = v; i++; break;
                    case "--room": c.room = v == null ? null : v.toLowerCase().replaceAll("[^a-z0-9]", ""); i++; break;
                    case "--key": c.key = v; i++; break;
                    case "--port": c.xmagePort = Integer.parseInt(v); i++; break;
                    case "--host": c.xmageHost = v; i++; break;
                    case "--server-dir": c.serverDir = Path.of(v).toAbsolutePath().normalize(); i++; break;
                    case "--memory": c.serverMemory = v; i++; break;
                    case "--no-server": c.noServer = true; break;
                    default: break;
                }
            }
            if (c.site.endsWith("/")) c.site = c.site.substring(0, c.site.length() - 1);
            if (!Files.isDirectory(c.serverDir.resolve("lib")) && !c.noServer) {
                Log.warn("Não achei a pasta lib/ do XMage em " + c.serverDir + ". Rode o motor de dentro da pasta do servidor.");
            }
            return c;
        }

        /** Endereço do site trocado para WebSocket: https -> wss. */
        String engineUrl() {
            String base = site.replaceFirst("^http", "ws");
            return base + "/engine?room=" + room;
        }
    }
}
