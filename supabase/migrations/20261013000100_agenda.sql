-- Agenda das atualizações automáticas.
-- A URL do projeto e um segredo aleatório ficam no Vault; o mesmo segredo fica em integracoes ('agenda'),
-- que a função de sincronização confere. Nada disso sai do banco.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Rodar uma vez por projeto (fora do repositório, com a URL certa):
--   select public.preparar_agenda('https://<ref>.supabase.co');
create or replace function public.preparar_agenda(projeto_url text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare s text := encode(gen_random_bytes(32), 'hex');
begin
  delete from vault.secrets where name in ('projeto_url', 'sync_segredo');
  perform vault.create_secret(projeto_url, 'projeto_url');
  perform vault.create_secret(s, 'sync_segredo');
  insert into public.integracoes (nome, dados) values ('agenda', jsonb_build_object('segredo', s))
  on conflict (nome) do update set dados = excluded.dados, atualizado_em = now();
end $$;
revoke all on function public.preparar_agenda(text) from public, anon, authenticated;

create or replace function public.disparar_sync(fontes text, desde text default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  url text := (select decrypted_secret from vault.decrypted_secrets where name = 'projeto_url');
  segredo text := (select decrypted_secret from vault.decrypted_secrets where name = 'sync_segredo');
begin
  perform net.http_post(
    url := url || '/functions/v1/sync?fontes=' || fontes || coalesce('&desde=' || desde, ''),
    headers := jsonb_build_object('x-sync-segredo', segredo, 'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
end $$;
revoke all on function public.disparar_sync(text, text) from public, anon, authenticated;

-- Horários em UTC (Brasília = UTC-3).
-- Shopify e Meta: de hora em hora, das 7h às 23h de Brasília.
select cron.schedule('sync-horario', '5 10-23,0-2 * * *', $$ select public.disparar_sync('shopify,meta') $$);
-- Demais fontes: 7h, 13h e 19h de Brasília.
select cron.schedule('sync-3x', '15 10,16,22 * * *', $$ select public.disparar_sync('nuvemshop,yampi,clarity,bling,melhorenvio') $$);
