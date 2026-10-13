-- Agenda das atualizações automáticas.
-- Precisa de dois segredos no Vault (criados fora do repositório):
--   select vault.create_secret('https://<ref>.supabase.co', 'projeto_url');
--   select vault.create_secret('<service role key>', 'service_key');
create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.disparar_sync(fontes text) returns void
language plpgsql security definer set search_path = public as $$
declare
  url text := (select decrypted_secret from vault.decrypted_secrets where name = 'projeto_url');
  chave text := (select decrypted_secret from vault.decrypted_secrets where name = 'service_key');
begin
  perform net.http_post(
    url := url || '/functions/v1/sync?fontes=' || fontes,
    headers := jsonb_build_object('Authorization', 'Bearer ' || chave, 'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
end $$;

revoke all on function public.disparar_sync(text) from public, anon, authenticated;

-- Horários em UTC (Brasília = UTC-3).
-- Shopify e Meta: de hora em hora, das 7h às 23h de Brasília.
select cron.schedule('sync-horario', '5 10-23,0-2 * * *', $$ select public.disparar_sync('shopify,meta') $$);
-- Demais fontes: 7h, 13h e 19h de Brasília.
select cron.schedule('sync-3x', '15 10,16,22 * * *', $$ select public.disparar_sync('nuvemshop,yampi,clarity,bling,melhorenvio') $$);
