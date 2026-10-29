# Mesa do Comandante

Commander no navegador para jogar com os amigos. Layout e fluxo no estilo do EDHplay, com as regras automáticas
que não dependem de ler o texto da carta, inspiradas no motor do XMage.

## O que a mesa faz sozinha

- Vida, veneno e dano de comandante por comandante; derrota automática em 0 de vida, 10 venenos ou 21 de um mesmo comandante.
- Dano de comandante também desconta da vida.
- Imposto de comandante contado a cada conjuração da zona de comando.
- Comandante indo para cemitério, exílio, mão ou grimório pergunta se volta à zona de comando.
- Desvirar e comprar no início do turno (sem compra no 1º turno em partida de 2).
- Pilha: mágica instantânea ou feitiço resolve para o cemitério; permanente resolve para o campo.
- Contadores +1/+1 e −1/−1 se anulam; tokens somem ao sair do campo; modificadores "até o fim do turno" zeram na limpeza.
- Avisos (sem agir): resistência 0, regra da lenda, aura solta, planeswalker sem lealdade.
- Regras de turno e mana (ligadas por padrão): um terreno por turno, só na fase principal; mágicas que não são
  instantâneas só na sua fase principal com a pilha vazia; conjurar cobra o custo (com imposto e X) e vira os terrenos
  sozinho; virar terreno gera mana na reserva, que esvazia a cada passo; criatura que acabou de entrar não vira por mana.
  Como a mesa não lê o texto de cada carta, toda recusa oferece "Fazer assim mesmo", e isso fica no registro.
- Modo prioridade opcional, como no XMage: quando todos passam, a pilha resolve ou o turno avança.
- Desfazer a própria última ação (Ctrl+Z).
- Informação oculta: mão e grimório dos outros nunca chegam ao seu navegador.

## Rodar no seu computador

```bash
npm install
npm run build
npm start          # http://localhost:3000
```

Para desenvolver com recarga automática: `npm run dev` (abre o Vite em http://localhost:5173).

Testes das regras: `npm test`.

## Publicar grátis no Render

1. Suba esta pasta para um repositório no GitHub.
2. No [Render](https://render.com), escolha **New → Blueprint** e aponte para o repositório. O `render.yaml` já configura tudo.
3. Em poucos minutos a mesa fica em `https://mesa-do-comandante.onrender.com` (ou parecido).

No plano grátis o servidor dorme depois de 15 minutos parado e leva uns 30 segundos para acordar. As mesas ficam
em memória: se o servidor dormir no meio de uma partida, ela se perde.

## Como está organizado

| Pasta | O que tem |
| --- | --- |
| `shared/` | Tipos e o motor da mesa (`game.ts`), com os testes de regra |
| `server/` | Servidor de sala: Express + Socket.IO, estado autoritativo, desfazer, olhar o topo |
| `client/` | React: início, decks, lobby, mesa |

As cartas vêm do Scryfall, buscadas pelo navegador de cada jogador na importação do deck.

## Próximo passo possível

Uma ponte Java com o motor do XMage (`Mage` + `Mage.Sets`, licença MIT) para um modo de regras completas por mesa.
O estado da mesa já é autoritativo no servidor justamente para permitir isso.

Imagens e textos de cartas são da Wizards of the Coast. Projeto de fã, sem fins lucrativos e sem ligação com a Wizards.
