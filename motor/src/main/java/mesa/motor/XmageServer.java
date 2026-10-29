package mesa.motor;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;

/** Sobe o servidor oficial do XMage como um processo filho, do jeito que o startServer.sh faz. */
final class XmageServer {
    private final Main.Config cfg;
    private Process process;

    XmageServer(Main.Config cfg) { this.cfg = cfg; }

    void ensureRunning() throws IOException, InterruptedException {
        if (portOpen()) {
            Log.info("Servidor do XMage já está rodando na porta " + cfg.xmagePort + ".");
            return;
        }
        Path jar = findServerJar();
        String java = Path.of(System.getProperty("java.home"), "bin", isWindows() ? "java.exe" : "java").toString();
        List<String> cmd = new ArrayList<>(List.of(
                java, "-Xmx" + cfg.serverMemory,
                "--add-opens=java.base/java.io=ALL-UNNAMED",
                "--add-opens=java.base/java.lang=ALL-UNNAMED",
                "--add-opens=java.base/java.util=ALL-UNNAMED",
                "-jar", cfg.serverDir.relativize(jar).toString()));
        Log.info("Iniciando o servidor do XMage (na primeira vez ele monta o banco de cartas e pode levar alguns minutos)...");
        process = new ProcessBuilder(cmd)
                .directory(cfg.serverDir.toFile())
                .redirectErrorStream(true)
                .redirectOutput(cfg.serverDir.resolve("xmage-server.log").toFile())
                .start();
        long deadline = System.currentTimeMillis() + 15 * 60_000L;
        int dots = 0;
        while (!portOpen()) {
            if (!process.isAlive())
                throw new IOException("O servidor do XMage fechou ao iniciar. Veja o arquivo xmage-server.log nesta pasta.");
            if (System.currentTimeMillis() > deadline)
                throw new IOException("O servidor do XMage demorou demais para iniciar.");
            Thread.sleep(2000);
            if (++dots % 15 == 0) Log.info("...ainda preparando o servidor do XMage");
        }
        Thread.sleep(1500); // dá tempo de terminar de registrar os tipos de jogo
        Log.info("Servidor do XMage pronto.");
    }

    void stop() {
        if (process != null && process.isAlive()) {
            Log.info("Desligando o servidor do XMage.");
            process.destroy();
        }
    }

    private boolean portOpen() {
        try (Socket s = new Socket()) {
            s.connect(new InetSocketAddress(cfg.xmageHost, cfg.xmagePort), 800);
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    private Path findServerJar() throws IOException {
        Path lib = cfg.serverDir.resolve("lib");
        try (Stream<Path> files = Files.list(lib)) {
            return files.filter(p -> p.getFileName().toString().matches("mage-server-.*\\.jar"))
                    .findFirst()
                    .orElseThrow(() -> new IOException("Não achei lib/mage-server-*.jar em " + cfg.serverDir));
        }
    }

    private static boolean isWindows() { return System.getProperty("os.name", "").toLowerCase().contains("win"); }
}
