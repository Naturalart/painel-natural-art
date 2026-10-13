// Uma função por fonte. Cada uma lê de `desde` até hoje (horário de Brasília) e regrava esses dias.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";
import { addDias, diaBR, dias, env, getJSON, gravar, hojeBR, limpar, r2 } from "./util.ts";

type Fonte = (db: SupabaseClient, desde: string) => Promise<Record<string, unknown>>;
const agora = () => new Date().toISOString();

// ---------------- Shopify (Admin GraphQL) ----------------
const SHOP_API = "2025-07";
const Q_PEDIDOS = `query Pedidos($q: String!, $after: String) { orders(first: 100, after: $after, query: $q, sortKey: CREATED_AT) {
  pageInfo { hasNextPage endCursor }
  nodes { createdAt cancelledAt test displayFinancialStatus
    currentTotalPriceSet { shopMoney { amount } } currentTotalDiscountsSet { shopMoney { amount } } currentShippingPriceSet { shopMoney { amount } }
    shippingAddress { province }
    lineItems(first: 50) { nodes { sku title variantTitle currentQuantity originalUnitPriceSet { shopMoney { amount } } discountedTotalSet { shopMoney { amount } } } } } } }`;
const Q_SQL = `query S($q: String!) { shopifyqlQuery(query: $q) { tableData { columns { name } rows } parseErrors } }`;
// Pedidos que contam como venda. VOIDED (Pix não pago, testes anulados) e REFUNDED ficam de fora.
const PAGOS = new Set(["PAID", "PARTIALLY_PAID", "PARTIALLY_REFUNDED", "AUTHORIZED"]);

// Token da Admin API. App do Dev Dashboard instalado na própria loja: client credentials (vale 24h, guardado em integracoes).
// Se existir SHOPIFY_ADMIN_TOKEN (app antigo do admin), usa ele direto.
let tokenShopify: string | null = null;
async function shopifyToken(db: SupabaseClient, loja: string): Promise<string> {
  const fixo = Deno.env.get("SHOPIFY_ADMIN_TOKEN");
  if (fixo) return fixo;
  if (tokenShopify) return tokenShopify;
  const { data } = await db.from("integracoes").select("dados").eq("nome", "shopify").maybeSingle();
  if (data?.dados?.access_token && (data.dados.expira_em ?? 0) > Date.now() + 600_000) return (tokenShopify = data.dados.access_token);
  const r = await fetch(`https://${loja}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: env("SHOPIFY_CLIENT_ID"), client_secret: env("SHOPIFY_CLIENT_SECRET") }),
  });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.access_token) throw new Error(`Shopify login ${r.status}: ${JSON.stringify(t).slice(0, 200)}. Confira se o app está instalado na loja.`);
  await db.from("integracoes").upsert({ nome: "shopify", dados: { access_token: t.access_token, expira_em: Date.now() + (t.expires_in ?? 86399) * 1000 }, atualizado_em: agora() });
  return (tokenShopify = t.access_token);
}

let dbShopify: SupabaseClient;
async function shopifyGQL(query: string, variables: Record<string, unknown>) {
  const loja = Deno.env.get("SHOPIFY_STORE") ?? "k4rwik-3n.myshopify.com";
  const j = await getJSON(`https://${loja}/admin/api/${SHOP_API}/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": await shopifyToken(dbShopify, loja), "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (j.errors) throw new Error("Shopify: " + JSON.stringify(j.errors).slice(0, 300));
  return j.data;
}

async function shopifyQL(q: string): Promise<Record<string, string>[]> {
  const d = await shopifyGQL(Q_SQL, { q });
  const r = d.shopifyqlQuery;
  if (r?.parseErrors?.length) throw new Error("ShopifyQL: " + JSON.stringify(r.parseErrors).slice(0, 300));
  const cols: string[] = (r?.tableData?.columns ?? []).map((c: { name: string }) => c.name);
  return (r?.tableData?.rows ?? []).map((row: unknown) =>
    Array.isArray(row) ? Object.fromEntries(row.map((v, i) => [cols[i], v])) : row as Record<string, string>
  );
}

const shopify: Fonte = async (db, desde) => {
  dbShopify = db; tokenShopify = null;
  const hoje = hojeBR();
  const vendas = new Map<string, { receita: number; bruto: number; descontos: number; frete_cobrado: number; pedidos: number; pecas: number }>();
  for (const d of dias(desde, hoje)) vendas.set(d, { receita: 0, bruto: 0, descontos: 0, frete_cobrado: 0, pedidos: 0, pecas: 0 });
  const skus = new Map<string, { data: string; sku: string; titulo: string; variante: string; qtd: number; receita: number }>();
  const ufs = new Map<string, number>();
  let after: string | null = null, total = 0, fora = 0;
  do {
    const d = await shopifyGQL(Q_PEDIDOS, { q: `created_at:>='${desde}T00:00:00-03:00'`, after });
    for (const o of d.orders.nodes) {
      total++;
      if (o.test || o.cancelledAt || !PAGOS.has(o.displayFinancialStatus)) { fora++; continue; }
      const dia = diaBR(o.createdAt);
      const v = vendas.get(dia); if (!v) continue;
      v.receita += +o.currentTotalPriceSet.shopMoney.amount;
      v.descontos += +o.currentTotalDiscountsSet.shopMoney.amount;
      v.frete_cobrado += +o.currentShippingPriceSet.shopMoney.amount;
      v.pedidos++;
      for (const li of o.lineItems.nodes) {
        if (!li.currentQuantity) continue;
        v.pecas += li.currentQuantity;
        v.bruto += li.currentQuantity * +li.originalUnitPriceSet.shopMoney.amount;
        const k = [dia, li.sku ?? "", li.title ?? "", li.variantTitle ?? ""].join("|");
        const s = skus.get(k) ?? { data: dia, sku: li.sku ?? "", titulo: li.title ?? "", variante: li.variantTitle ?? "", qtd: 0, receita: 0 };
        s.qtd += li.currentQuantity; s.receita += +li.discountedTotalSet.shopMoney.amount;
        skus.set(k, s);
      }
      const uf = o.shippingAddress?.province ?? "";
      if (uf) ufs.set(dia + "|" + uf, (ufs.get(dia + "|" + uf) ?? 0) + 1);
    }
    after = d.orders.pageInfo.hasNextPage ? d.orders.pageInfo.endCursor : null;
  } while (after);

  await gravar(db, "vendas_dia", [...vendas].map(([data, v]) => ({
    canal: "shopify", data, receita: r2(v.receita), bruto: r2(v.bruto), descontos: r2(v.descontos), frete_cobrado: r2(v.frete_cobrado),
    pedidos: v.pedidos, pecas: v.pecas, atualizado_em: agora(),
  })), "canal,data");
  await limpar(db, "vendas_sku_dia", { canal: "shopify" }, desde);
  await gravar(db, "vendas_sku_dia", [...skus.values()].map((s) => ({ canal: "shopify", ...s, receita: r2(s.receita) })), "canal,data,sku,titulo,variante");
  await limpar(db, "pedidos_uf_dia", { canal: "shopify" }, desde);
  await gravar(db, "pedidos_uf_dia", [...ufs].map(([k, n]) => { const [data, uf] = k.split("|"); return { canal: "shopify", data, uf, pedidos: n }; }), "canal,data,uf");

  // Sessões e origem do tráfego (relatórios da Shopify). Se falhar, as vendas já estão salvas.
  let sessoes = "ok";
  try {
    const s = await shopifyQL(`FROM sessions SHOW sessions, sessions_with_cart_additions TIMESERIES day SINCE ${desde} UNTIL ${hoje}`);
    await gravar(db, "sessoes_dia", s.map((r) => ({ data: String(r.day).slice(0, 10), sessoes: +r.sessions || 0, sessoes_carrinho: +r.sessions_with_cart_additions || 0, atualizado_em: agora() })), "data");
    const o = await shopifyQL(`FROM sessions SHOW sessions, sessions_with_cart_additions GROUP BY referrer_source, referrer_name TIMESERIES day SINCE ${desde} UNTIL ${hoje}`);
    const orig = new Map<string, { data: string; origem: string; sessoes: number; sessoes_carrinho: number }>();
    for (const r of o) {
      if (!+r.sessions) continue;
      const data = String(r.day).slice(0, 10), origem = [r.referrer_source, r.referrer_name].filter(Boolean).join(" · ") || "desconhecido";
      const x = orig.get(data + origem) ?? { data, origem, sessoes: 0, sessoes_carrinho: 0 };
      x.sessoes += +r.sessions || 0; x.sessoes_carrinho += +r.sessions_with_cart_additions || 0; orig.set(data + origem, x);
    }
    await limpar(db, "sessoes_origem_dia", {}, desde);
    await gravar(db, "sessoes_origem_dia", [...orig.values()], "data,origem");
  } catch (e) { sessoes = e instanceof Error ? e.message : String(e); }
  return { pedidosLidos: total, foraDaConta: fora, sessoes };
};

// ---------------- Meta Ads (Graph API, token de usuário do sistema) ----------------
const META_CONTAS: Record<string, string> = { "916962516601176": "shopify", "656401004912172": "catalogo" };
const meta: Fonte = async (db, desde) => {
  const token = env("META_TOKEN"), hoje = hojeBR();
  const linhas: Record<string, unknown>[] = [];
  for (const conta of Object.keys(META_CONTAS)) {
    const tr = encodeURIComponent(JSON.stringify({ since: desde, until: hoje }));
    let url: string | null = `https://graph.facebook.com/v21.0/act_${conta}/insights?level=campaign&time_increment=1&limit=500` +
      `&fields=campaign_id,campaign_name,spend,actions,action_values&time_range=${tr}&access_token=${token}`;
    const totais = new Map<string, number>();
    for (const d of dias(desde, hoje)) totais.set(d, 0);
    while (url) {
      const j: any = await getJSON(url);
      for (const x of j.data ?? []) {
        const compra = (arr: any[] | undefined) => +((arr ?? []).find((a) => a.action_type === "purchase")?.value ?? 0);
        linhas.push({ plataforma: "meta", conta, data: x.date_start, campanha_id: x.campaign_id, campanha: x.campaign_name ?? "",
          valor: +x.spend || 0, compras: compra(x.actions), receita_atribuida: r2(compra(x.action_values)), atualizado_em: agora() });
        totais.set(x.date_start, (totais.get(x.date_start) ?? 0) + (+x.spend || 0));
      }
      url = j.paging?.next ?? null;
    }
    // Linha de total da conta por dia (campanha_id ''), inclusive dias sem gasto.
    for (const [data, valor] of totais) linhas.push({ plataforma: "meta", conta, data, campanha_id: "", campanha: "", valor: r2(valor), atualizado_em: agora() });
  }
  await db.from("verba_dia").delete().eq("plataforma", "meta").gte("data", desde);
  await gravar(db, "verba_dia", linhas, "plataforma,conta,data,campanha_id");
  return { linhas: linhas.length };
};

// ---------------- Nuvemshop (vendas + etiquetas do Nuvem Envio) ----------------
const nuvemshop: Fonte = async (db, desde) => {
  // Token vem da autorização do app (função conectar); o segredo NUVEMSHOP_TOKEN fica como alternativa.
  const { data: integ } = await db.from("integracoes").select("dados").eq("nome", "nuvemshop").maybeSingle();
  const token = integ?.dados?.access_token ?? env("NUVEMSHOP_TOKEN");
  const loja = integ?.dados?.loja || Deno.env.get("NUVEMSHOP_STORE_ID") || "2427817", hoje = hojeBR();
  const pedidos: any[] = [];
  for (let page = 1; page < 100; page++) {
    const r = await fetch(`https://api.tiendanube.com/v1/${loja}/orders?created_at_min=${desde}T00:00:00-03:00&per_page=200&page=${page}`, {
      headers: { Authentication: `bearer ${token}`, "User-Agent": "Painel Natural Art (marketing@naturalart.com.br)" },
    });
    if (r.status === 404) break; // passou da última página
    if (!r.ok) throw new Error(`Nuvemshop ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const d = await r.json();
    if (!d.length) break;
    pedidos.push(...d);
    if (d.length < 200) break;
  }
  const vendas = new Map<string, { receita: number; descontos: number; frete_cobrado: number; pedidos: number; pecas: number; etiquetas: number; etiq_pedidos: number }>();
  for (const d of dias(desde, hoje)) vendas.set(d, { receita: 0, descontos: 0, frete_cobrado: 0, pedidos: 0, pecas: 0, etiquetas: 0, etiq_pedidos: 0 });
  const skus = new Map<string, any>();
  for (const o of pedidos) {
    if (o.payment_status !== "paid" || o.status === "cancelled") continue;
    const dia = diaBR(o.created_at.replace("+0000", "+00:00"));
    const v = vendas.get(dia); if (!v) continue;
    v.receita += +o.total; v.pedidos++; v.descontos += +(o.discount ?? 0); v.frete_cobrado += +(o.shipping_cost_customer ?? 0);
    const eo = +(o.shipping_cost_owner ?? 0); v.etiquetas += eo; if (eo > 0) v.etiq_pedidos++;
    for (const p of o.products ?? []) {
      const q = +p.quantity || 0; v.pecas += q;
      const k = [dia, p.sku ?? "", p.name ?? "", ""].join("|");
      const s = skus.get(k) ?? { canal: "nuvemshop", data: dia, sku: p.sku ?? "", titulo: p.name ?? "", variante: "", qtd: 0, receita: 0 };
      s.qtd += q; s.receita = r2(s.receita + q * +(p.price ?? 0)); skus.set(k, s);
    }
  }
  await gravar(db, "vendas_dia", [...vendas].map(([data, v]) => ({ canal: "nuvemshop", data, receita: r2(v.receita), bruto: 0,
    descontos: r2(v.descontos), frete_cobrado: r2(v.frete_cobrado), pedidos: v.pedidos, pecas: v.pecas, atualizado_em: agora() })), "canal,data");
  await gravar(db, "etiquetas_dia", [...vendas].map(([data, v]) => ({ canal: "nuvemshop", data, valor: r2(v.etiquetas), pedidos: v.etiq_pedidos,
    fonte: "Nuvem Envio", atualizado_em: agora() })), "canal,data");
  await limpar(db, "vendas_sku_dia", { canal: "nuvemshop" }, desde);
  await gravar(db, "vendas_sku_dia", [...skus.values()], "canal,data,sku,titulo,variante");
  return { pedidosLidos: pedidos.length };
};

// ---------------- Yampi (checkout) ----------------
const yampi: Fonte = async (db, desde) => {
  const B = `https://api.dooki.com.br/v2/${Deno.env.get("YAMPI_ALIAS") ?? "natural-art"}`;
  const h = { "User-Token": env("YAMPI_TOKEN"), "User-Secret-Key": env("YAMPI_SECRET"), Accept: "application/json" };
  const D = new Map<string, any>();
  const dia = (d: string) => {
    if (!D.has(d)) D.set(d, { data: d, checkouts: 0, carrinhos_abandonados: 0, valor_abandonado: 0, pedidos_pix: 0, pedidos_cartao: 0, pix_nao_pagos: 0, valor_pix_nao_pago: 0 });
    return D.get(d);
  };
  for (const d of dias(desde, hojeBR())) dia(d);
  async function* paginar(path: string) {
    for (let page = 1; page < 200; page++) {
      const j = await getJSON(`${B}/${path}${path.includes("?") ? "&" : "?"}limit=50&page=${page}`, { headers: h });
      for (const x of j.data ?? []) yield x;
      const pg = j.meta?.pagination;
      if (!pg || pg.current_page >= pg.total_pages) break;
    }
  }
  const dt = (v: any) => String(typeof v === "object" ? v.date : v).slice(0, 10); // Yampi já devolve em horário de Brasília
  for await (const c of paginar("checkout/carts?orderBy=id&sortedBy=desc")) {
    const d = dt(c.created_at); if (d < desde) break;
    const x = dia(d); x.carrinhos_abandonados++; x.checkouts++; x.valor_abandonado += +(c.totalizers?.total ?? 0);
  }
  for await (const o of paginar("orders?orderBy=id&sortedBy=desc")) {
    const d = dt(o.created_at); if (d < desde) break;
    const x = dia(d); x.checkouts++;
    const st = o.status?.data?.alias;
    const pag = new Set((o.transactions?.data ?? []).map((t: any) => t.payment?.data?.alias));
    const pix = pag.has("pix");
    if ((st === "cancelled" || st === "waiting_payment") && pix) { x.pix_nao_pagos++; x.valor_pix_nao_pago += +o.value_total; }
    else if (!["cancelled", "waiting_payment", "refused"].includes(st)) {
      if (pix) x.pedidos_pix++;
      else if ([...pag].some((a) => a && a !== "billet" && a !== "boleto")) x.pedidos_cartao++;
    }
  }
  await gravar(db, "yampi_dia", [...D.values()].map((x) => ({ ...x, valor_abandonado: r2(x.valor_abandonado), valor_pix_nao_pago: r2(x.valor_pix_nao_pago), atualizado_em: agora() })), "data");
  return { dias: D.size };
};

// ---------------- Microsoft Clarity (últimas 24h; o histórico se forma dia a dia) ----------------
const clarity: Fonte = async (db) => {
  const j = await getJSON("https://www.clarity.ms/export-data/api/v1/project-live-insights?numOfDays=1", {
    headers: { Authorization: `Bearer ${env("CLARITY_TOKEN")}` },
  });
  const m = Object.fromEntries((j as any[]).map((i) => [i.metricName, i.information]));
  const sub = (k: string) => Math.round((m[k] ?? []).reduce((a: number, i: any) => a + (+i.subTotal || 0), 0));
  await gravar(db, "clarity_dia", [{
    data: hojeBR(), sessoes: +(m.Traffic?.[0]?.totalSessionCount ?? 0), rage_clicks: sub("RageClickCount"), dead_clicks: sub("DeadClickCount"),
    quickbacks: sub("QuickbackClick"), scroll_medio: r2(+(m.ScrollDepth?.[0]?.averageScrollDepth ?? 0)), atualizado_em: agora(),
  }], "data");
  return {};
};

// ---------------- Bling (custo por SKU + estoque do depósito Geral - Ecommerce) ----------------
async function blingToken(db: SupabaseClient): Promise<string> {
  const { data } = await db.from("integracoes").select("dados").eq("nome", "bling").maybeSingle();
  const salvo = data?.dados as { access_token?: string; refresh_token?: string; expira_em?: number } | undefined;
  if (salvo?.access_token && (salvo.expira_em ?? 0) > Date.now() + 120_000) return salvo.access_token;
  const refresh = salvo?.refresh_token ?? env("BLING_REFRESH_TOKEN");
  const basic = btoa(`${env("BLING_CLIENT_ID")}:${env("BLING_CLIENT_SECRET")}`);
  const r = await fetch("https://www.bling.com.br/Api/v3/oauth/token", {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "1.0" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }),
  });
  if (!r.ok) throw new Error(`Bling login ${r.status}: ${(await r.text()).slice(0, 300)}. Gere um novo refresh token do app no Bling.`);
  const t = await r.json();
  await db.from("integracoes").upsert({ nome: "bling", dados: { access_token: t.access_token, refresh_token: t.refresh_token, expira_em: Date.now() + t.expires_in * 1000 }, atualizado_em: agora() });
  return t.access_token;
}

const bling: Fonte = async (db) => {
  const token = await blingToken(db), dep = +(Deno.env.get("BLING_DEPOSITO_ID") ?? "14887242193");
  const h = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const pausa = () => new Promise((s) => setTimeout(s, 380)); // limite do Bling: 3 chamadas por segundo
  const prods: { id: number; codigo: string; nome: string; precoCusto: number }[] = [];
  for (let pg = 1; pg <= 100; pg++) {
    const j = await getJSON(`https://api.bling.com.br/Api/v3/produtos?pagina=${pg}&limite=100&criterio=2&tipo=V`, { headers: h });
    prods.push(...(j.data ?? []));
    await pausa();
    if ((j.data ?? []).length < 100) break;
  }
  const saldo = new Map<number, number>();
  for (let i = 0; i < prods.length; i += 100) {
    const qs = prods.slice(i, i + 100).map((p) => `idsProdutos[]=${p.id}`).join("&");
    const j = await getJSON(`https://api.bling.com.br/Api/v3/estoques/saldos?${qs}`, { headers: h });
    for (const s of j.data ?? []) {
      const d = (s.depositos ?? []).find((x: any) => x.id === dep);
      if (d) saldo.set(s.produto.id, +d.saldoFisico || 0);
    }
    await pausa();
  }
  const custos = prods.filter((p) => p.codigo && +p.precoCusto > 0).map((p) => ({ sku: p.codigo, custo: +p.precoCusto, atualizado_em: agora() }));
  const est = prods.filter((p) => p.codigo && (saldo.get(p.id) ?? 0) > 0)
    .map((p) => ({ sku: p.codigo, nome: p.nome ?? "", custo: +p.precoCusto || 0, qtd: saldo.get(p.id)!, atualizado_em: agora() }));
  await gravar(db, "custo_sku", custos, "sku");
  const { error } = await db.from("estoque").delete().neq("sku", "");
  if (error) throw new Error("estoque: " + error.message);
  await gravar(db, "estoque", est, "sku");
  await gravar(db, "estoque_hist", est.map((e) => ({ data: hojeBR(), sku: e.sku, qtd: e.qtd })), "data,sku");
  return { produtos: prods.length, comEstoque: est.length };
};

// ---------------- Melhor Envio (etiquetas pagas dos pedidos da Shopify) ----------------
const melhorenvio: Fonte = async (db, desde) => {
  const h = { Authorization: `Bearer ${env("MELHORENVIO_TOKEN")}`, Accept: "application/json", "User-Agent": "Painel Natural Art (marketing@naturalart.com.br)" };
  const porDia = new Map<string, { valor: number; pedidos: number }>();
  for (const d of dias(desde, hojeBR())) porDia.set(d, { valor: 0, pedidos: 0 });
  // Etiquetas pagas: status released (paga), posted, delivered. Canceladas ficam de fora.
  for (const status of ["released", "posted", "delivered"]) {
    for (let page = 1; page < 50; page++) {
      const j = await getJSON(`https://www.melhorenvio.com.br/api/v2/me/orders?status=${status}&page=${page}`, { headers: h });
      const lista = j.data ?? [];
      let antigo = false;
      for (const e of lista) {
        const quando = e.paid_at ?? e.created_at;
        if (!quando) continue;
        const d = diaBR(String(quando).replace(" ", "T") + (String(quando).includes("T") ? "" : "-03:00"));
        if (d < desde) { antigo = true; continue; }
        const x = porDia.get(d); if (!x) continue;
        x.valor += +(e.price ?? 0); x.pedidos++;
      }
      if (antigo || !j.next_page_url || !lista.length) break;
    }
  }
  // Só grava dias com etiqueta: um dia sem etiqueta comprada ainda usa a estimativa por estado no painel.
  await gravar(db, "etiquetas_dia", [...porDia].filter(([, v]) => v.pedidos > 0).map(([data, v]) => ({ canal: "shopify", data, valor: r2(v.valor), pedidos: v.pedidos, fonte: "Melhor Envio", atualizado_em: agora() })), "canal,data");
  return { dias: porDia.size };
};

export const fontes: Record<string, Fonte> = { shopify, meta, nuvemshop, yampi, clarity, bling, melhorenvio };
export { addDias };
