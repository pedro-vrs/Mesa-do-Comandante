package mesa.motor;

import java.util.Map;

/** O XMage manda textos com HTML e em inglês; aqui viram texto puro e os botões ganham nome em português. */
final class Text {
    private Text() {}

    private static final Map<String, String> BUTTONS = Map.ofEntries(
            Map.entry("Yes", "Sim"), Map.entry("No", "Não"), Map.entry("OK", "OK"), Map.entry("Ok", "OK"),
            Map.entry("Cancel", "Cancelar"), Map.entry("Done", "Pronto"), Map.entry("Pass", "Passar"),
            Map.entry("Special", "Especial"), Map.entry("Mulligan", "Mulligan"), Map.entry("Keep", "Manter"),
            Map.entry("Heads", "Cara"), Map.entry("Tails", "Coroa"), Map.entry("Even", "Par"), Map.entry("Odd", "Ímpar"),
            Map.entry("Left", "Esquerda"), Map.entry("Right", "Direita"), Map.entry("Attack", "Atacar"), Map.entry("Skip", "Pular"));

    static String button(String s) {
        if (s == null) return "";
        String t = plain(s);
        return BUTTONS.getOrDefault(t, t);
    }

    static String plain(String html) {
        if (html == null) return "";
        String s = html
                .replaceAll("(?i)<br\\s*/?>", "\n")
                .replaceAll("(?i)<img[^>]*alt=\"?([^\" >]+)\"?[^>]*>", "{$1}")   // símbolos de mana viram {G}
                .replaceAll("<[^>]+>", "")
                .replace("&nbsp;", " ").replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&").replace("&quot;", "\"").replace("&#39;", "'");
        return s.replaceAll("[ \\t]+", " ").trim();
    }
}
