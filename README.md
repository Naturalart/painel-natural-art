# Painel Natural Art

Painel de vendas, anúncios e lucro real da Natural Art (Shopify, Nuvemshop, TikTok Shop, Meta Ads, Yampi, Clarity, Bling, Melhor Envio).

- `web/` — o site (HTML estático). Publicado na Vercel; login por link no e-mail (Supabase Auth).
- `supabase/migrations/` — tabelas, regras de acesso e a agenda das atualizações.
- `supabase/functions/sync/` — busca os dados nas APIs e grava no banco. Roda sozinha: Shopify e Meta de hora em hora, o resto às 7h, 13h e 19h (Brasília). Cada rodada relê os últimos dias e recupera qualquer dia perdido.

## Segredos (Supabase → Edge Functions → Secrets)

| Segredo | De onde vem |
| --- | --- |
| `SHOPIFY_STORE`, `SHOPIFY_ADMIN_TOKEN` | App personalizado na Shopify (escopos `read_orders`, `read_reports`) |
| `META_TOKEN` | Usuário do sistema no Business Manager, com acesso às duas contas |
| `NUVEMSHOP_STORE_ID`, `NUVEMSHOP_TOKEN` | App da Nuvemshop (loja 2427817) |
| `YAMPI_TOKEN`, `YAMPI_SECRET` | Yampi → Perfil → Credenciais de API |
| `CLARITY_TOKEN` | Clarity → Configurações → Data Export |
| `BLING_CLIENT_ID`, `BLING_CLIENT_SECRET`, `BLING_REFRESH_TOKEN` | App no developer.bling.com.br (o refresh token renova sozinho depois) |
| `MELHORENVIO_TOKEN` | Melhor Envio → Integrações → Tokens |
| `RESEND_API_KEY`, `ALERTA_EMAIL` (opcional) | E-mail de alerta quando uma fonte falha |

Nunca coloque chaves no repositório.

## Vercel

Variáveis `SUPABASE_URL` e `SUPABASE_ANON_KEY`. O build gera `web/config.js`.

## Quem pode ver

Inclua o e-mail na tabela `usuarios_liberados`.
