# Chromora — servidor

Servidor único em Node.js 22+ (sem dependências). Faz: contas e login, save na nuvem, ranking (semanal, temporada, nível), prêmios (semanal e diário) e a carteira global de ChromoraCoin (supply de 21 milhões, reserva do Banco e planos de 30 dias comprados em CC). Também serve o jogo (`public/index.html`).

## Rodar
```
npm start            # http://localhost:3000
```
Variáveis de ambiente:
- `PORT` (padrão 3000)
- `DB_FILE` caminho do banco SQLite (padrão `./chromora.db`). **Faça backup deste arquivo todo dia** e guarde-o em disco persistente.
- `CORS_ORIGIN` (opcional) domínio do jogo, se ele for servido de outro lugar.

## Colocar no ar
Qualquer host que rode Node 22 com **disco persistente** serve (Render, Railway, Fly.io, VPS). Use HTTPS. Comando de start: `npm start`. Sem disco persistente o banco some a cada deploy.

## ChromoraCoin e planos
O CC vive no servidor (tabelas `wallets` e `ccg`). Mineração é enviada pelo jogo em `/api/cc/claim`, com teto de 6.000 CC/hora e 40.000 CC/dia por conta. O CC gasto volta à reserva do Banco. Planos (300 e 800 CC, 30 dias) são comprados em `/api/plan/buy`. Não há cobrança em dinheiro. Limite conhecido: o servidor não vê a mineração acontecer, só limita a taxa. Faça backup diário do arquivo `.db` e use disco persistente.

## Regras do servidor
- Semana: segunda 00:00 (Brasília). Prêmio semanal só da semana fechada; prêmio diário para top 100 (semanal ou nível). Cada prêmio só pode ser pego uma vez por conta.
- Conflito de save: vence o de maior progresso (fase, nível, CC minerado); se os dois mudaram, o jogo pergunta ao jogador.
- Antifraude básico: saltos de nível/fase/pontos impossíveis em pouco tempo tiram o jogador do ranking (o save é guardado).

## Limite importante
A lógica do jogo roda no aparelho. O servidor limita saltos absurdos, mas não impede 100% de trapaça (por exemplo editar o save local). Para um jogo competitivo de verdade, o próximo passo é mover cálculos de ouro, CC e pontos para o servidor.
