-- Painel Natural Art: banco de dados
-- Datas sempre no fuso America/Sao_Paulo. Valores em R$.

-- ---------- quem pode ver o painel ----------
create table public.usuarios_liberados (
  email text primary key,
  criado_em timestamptz not null default now()
);

create or replace function public.liberado() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.usuarios_liberados
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- ---------- vendas ----------
-- canal: shopify | nuvemshop | tiktok_shop
create table public.vendas_dia (
  canal text not null,
  data date not null,
  receita numeric not null default 0,      -- total pago pelo cliente (com frete), já sem cancelados e reembolsos
  bruto numeric not null default 0,        -- produtos antes do desconto
  descontos numeric not null default 0,
  frete_cobrado numeric not null default 0,
  pedidos int not null default 0,
  pecas int not null default 0,
  atualizado_em timestamptz not null default now(),
  primary key (canal, data)
);

create table public.vendas_sku_dia (
  canal text not null,
  data date not null,
  sku text not null default '',
  titulo text not null default '',
  variante text not null default '',
  qtd int not null default 0,
  receita numeric not null default 0,
  primary key (canal, data, sku, titulo, variante)
);

create table public.pedidos_uf_dia (
  canal text not null,
  data date not null,
  uf text not null,                         -- nome do estado, ex. 'São Paulo'
  pedidos int not null default 0,
  primary key (canal, data, uf)
);

-- ---------- tráfego da loja (Shopify) ----------
create table public.sessoes_dia (
  data date primary key,
  sessoes int not null default 0,
  sessoes_carrinho int not null default 0,
  atualizado_em timestamptz not null default now()
);

create table public.sessoes_origem_dia (
  data date not null,
  origem text not null,
  sessoes int not null default 0,
  sessoes_carrinho int not null default 0,
  primary key (data, origem)
);

-- ---------- anúncios ----------
-- plataforma: meta | google | tiktok ; conta: id da conta ; campanha_id '' = total da conta
create table public.verba_dia (
  plataforma text not null,
  conta text not null,
  data date not null,
  campanha_id text not null default '',
  campanha text not null default '',
  valor numeric not null default 0,         -- sem imposto
  compras numeric not null default 0,
  receita_atribuida numeric not null default 0,
  atualizado_em timestamptz not null default now(),
  primary key (plataforma, conta, data, campanha_id)
);

-- ---------- etiquetas pagas ----------
-- canal: shopify (Melhor Envio) | nuvemshop (Nuvem Envio)
create table public.etiquetas_dia (
  canal text not null,
  data date not null,
  valor numeric not null default 0,
  pedidos int not null default 0,
  fonte text not null default '',
  atualizado_em timestamptz not null default now(),
  primary key (canal, data)
);

-- ---------- estoque e custo (Bling, depósito Geral - Ecommerce) ----------
create table public.estoque (
  sku text primary key,
  nome text not null default '',
  custo numeric not null default 0,
  qtd int not null default 0,
  atualizado_em timestamptz not null default now()
);

create table public.estoque_hist (
  data date not null,
  sku text not null,
  qtd int not null default 0,
  primary key (data, sku)
);

create table public.custo_sku (
  sku text primary key,
  custo numeric not null,
  atualizado_em timestamptz not null default now()
);

-- ---------- checkout (Yampi) e comportamento (Clarity) ----------
create table public.yampi_dia (
  data date primary key,
  checkouts int not null default 0,
  carrinhos_abandonados int not null default 0,
  valor_abandonado numeric not null default 0,
  pedidos_pix int not null default 0,
  pedidos_cartao int not null default 0,
  pix_nao_pagos int not null default 0,
  valor_pix_nao_pago numeric not null default 0,
  atualizado_em timestamptz not null default now()
);

create table public.clarity_dia (
  data date primary key,
  sessoes int not null default 0,
  rage_clicks int not null default 0,
  dead_clicks int not null default 0,
  quickbacks int not null default 0,
  scroll_medio numeric not null default 0,
  atualizado_em timestamptz not null default now()
);

-- ---------- lançamentos manuais e custos ----------
create table public.lancamentos (
  id uuid primary key default gen_random_uuid(),
  data date not null,
  tipo text not null,      -- tiktok_ads | tiktok_shop | meta_ads | meta_ads_catalogo | etiquetas_shopify | etiquetas_nuvem | amostras | custo_fixo | nuvemshop
  valor numeric,
  receita numeric,
  pedidos int,
  pecas int,
  nota text not null default '',
  criado_em timestamptz not null default now(),
  criado_por text default (auth.jwt() ->> 'email')
);
create index on public.lancamentos (data);

create table public.config (
  chave text primary key,
  valor jsonb not null,
  atualizado_em timestamptz not null default now()
);

-- ---------- saúde das atualizações ----------
create table public.sync_status (
  fonte text primary key,
  ultima_ok timestamptz,
  ultima_tentativa timestamptz,
  ultimo_erro text,
  detalhe jsonb
);

-- tokens que mudam sozinhos (ex. refresh token do Bling). Só a função de sincronização lê.
create table public.integracoes (
  nome text primary key,
  dados jsonb not null,
  atualizado_em timestamptz not null default now()
);

-- ---------- segurança ----------
do $$
declare t text;
begin
  foreach t in array array['vendas_dia','vendas_sku_dia','pedidos_uf_dia','sessoes_dia','sessoes_origem_dia','verba_dia',
    'etiquetas_dia','estoque','estoque_hist','custo_sku','yampi_dia','clarity_dia','lancamentos','config','sync_status']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "liberados leem" on public.%I for select to authenticated using (public.liberado())', t);
  end loop;
end $$;

alter table public.usuarios_liberados enable row level security;
alter table public.integracoes enable row level security;  -- sem política: só a service role

create policy "liberados lançam" on public.lancamentos for insert to authenticated with check (public.liberado());
create policy "liberados apagam" on public.lancamentos for delete to authenticated using (public.liberado());
create policy "liberados mudam custos" on public.config for insert to authenticated with check (public.liberado());
create policy "liberados atualizam custos" on public.config for update to authenticated using (public.liberado()) with check (public.liberado());

-- ---------- custos iniciais (iguais ao painel atual) ----------
insert into public.config (chave, valor) values ('custos', '{
  "custoPeca": 42, "cartaoPct": 8.39, "pixPct": 0.99, "pixShare": 0, "impostoPct": 11, "comissaoPct": 10,
  "fretePedido": 20, "metaTaxPct": 12.15, "ttsTaxaPct": 12, "ttsPorItem": 6, "ttsAfiliadoPct": 15, "ttsFretePedido": 0
}'::jsonb);

insert into public.usuarios_liberados (email) values ('marketing@naturalart.com.br');
