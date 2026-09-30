# DESAFIO 24 — v1.2.0

Versão preparada para piloto público.

## O que mudou
- Pontuação em PostgreSQL quando `DATABASE_URL` está configurada.
- Endpoint `/api/health` para verificar o serviço.
- `/api/admin/questions` protegido por `X-Admin-Token`.
- Validação de nome e pontuação.
- Limite básico de requisições no processo.
- Configuração `render.yaml` para facilitar o deploy.
- Em produção, o servidor encerra se `DATABASE_URL` ou `ADMIN_TOKEN` não estiverem configurados.

## Deploy no Render
1. Crie um repositório Git e envie estes arquivos.
2. No Render, crie um Web Service a partir do repositório.
3. Build: `npm install`.
4. Start: `npm start`.
5. Defina `NODE_ENV=production`.
6. Defina `DATABASE_URL` com a URL de um PostgreSQL.
7. Defina um `ADMIN_TOKEN` secreto forte.
8. Após publicar, teste `/api/health`.

### Banco
Para o piloto, pode-se usar PostgreSQL gerenciado. Não dependa dos arquivos JSON para pontuação em produção.

### Atenção ao plano gratuito
Planos gratuitos são adequados para teste/piloto, mas têm limitações e não devem ser tratados como infraestrutura definitiva de produção. No Render, por exemplo, o Postgres gratuito expira após 30 dias.

## Teste local
Sem `DATABASE_URL`, o modo local usa `data/scores.json` para facilitar testes. Para simular produção, configure `NODE_ENV=production`, `DATABASE_URL` e `ADMIN_TOKEN`.
