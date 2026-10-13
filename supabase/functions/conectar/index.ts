// Recebe o retorno da autorização de apps (Nuvemshop e Bling) e guarda o token em integracoes.
// O segredo do app fica só nos Secrets do Supabase; ninguém precisa copiar token nenhum.
//   Nuvemshop: URL de redirecionamento do app = https://<ref>.supabase.co/functions/v1/conectar
//   Bling:     URL de redirecionamento do app = https://<ref>.supabase.co/functions/v1/conectar?app=bling
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

function pagina(titulo: string, texto: string, status = 200) {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${titulo}</title><body style="font-family:system-ui;max-width:520px;margin:15vh auto;padding:0 16px;line-height:1.5">
<h1 style="font-size:22px">${titulo}</h1><p>${texto}</p></body>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

async function nuvemshop(code: string) {
  const r = await fetch("https://www.tiendanube.com/apps/authorize/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: Deno.env.get("NUVEMSHOP_CLIENT_ID") ?? "45888",
      client_secret: Deno.env.get("NUVEMSHOP_CLIENT_SECRET"),
      grant_type: "authorization_code",
      code,
    }),
  });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.access_token) throw new Error(`Nuvemshop respondeu ${r.status}: ${t.error_description ?? t.error ?? "sem token"}`);
  await db.from("integracoes").upsert({ nome: "nuvemshop", dados: { access_token: t.access_token, loja: String(t.user_id ?? "") }, atualizado_em: new Date().toISOString() });
}

async function bling(code: string) {
  const basic = btoa(`${Deno.env.get("BLING_CLIENT_ID")}:${Deno.env.get("BLING_CLIENT_SECRET")}`);
  const r = await fetch("https://www.bling.com.br/Api/v3/oauth/token", {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "1.0" },
    body: new URLSearchParams({ grant_type: "authorization_code", code }),
  });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.access_token) throw new Error(`Bling respondeu ${r.status}: ${t.error?.description ?? "sem token"}`);
  await db.from("integracoes").upsert({ nome: "bling", dados: { access_token: t.access_token, refresh_token: t.refresh_token, expira_em: Date.now() + t.expires_in * 1000 }, atualizado_em: new Date().toISOString() });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const app = url.searchParams.get("app") ?? "nuvemshop";
  const code = url.searchParams.get("code");
  if (!code) return pagina("Falta a autorização", "Abra esta página pelo botão de autorizar do app.", 400);
  try {
    if (app === "bling") await bling(code); else await nuvemshop(code);
    const nome = app === "bling" ? "Bling" : "Nuvemshop";
    return pagina(`${nome} conectado`, `Pronto. O painel já pode ler a ${nome}. Pode fechar esta página e avisar no chat.`);
  } catch (e) {
    return pagina("Não deu certo", String(e instanceof Error ? e.message : e).replace(/[<>]/g, ""), 500);
  }
});
