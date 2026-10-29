package mesa.motor;

import java.time.LocalTime;
import java.time.format.DateTimeFormatter;

/** Registro simples no console, em português, para quem está com o motor aberto. */
final class Log {
    private static final DateTimeFormatter T = DateTimeFormatter.ofPattern("HH:mm:ss");

    private Log() {}

    static void info(String m) { System.out.println("[" + LocalTime.now().format(T) + "] " + m); }

    static void warn(String m) { System.out.println("[" + LocalTime.now().format(T) + "] AVISO: " + m); }

    static void error(String m, Throwable e) {
        System.out.println("[" + LocalTime.now().format(T) + "] ERRO: " + m + (e == null ? "" : " — " + e));
        if (e != null && System.getenv("MOTOR_DEBUG") != null) e.printStackTrace(System.out);
    }
}
