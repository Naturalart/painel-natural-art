// Atualização automática do Painel Natural Art.
// Chamada pela agenda (pg_cron) com ?fontes=shopify,meta,... e opcionalmente &desde=YYYY-MM-DD para recuperar um período.
// Cada fonte roda isolada: se uma falhar, as outras seguem e o erro fica em sync_status.
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";
import { fontes } from "./fontes.ts";
import { hojeBR, addDias } from "./util.ts";

const db: SupabaseClient = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

// Quantos dias para trás cada rodada relê, para pegar pedidos pagos depois, cancelamentos e dias perdidos.
const JANELA_PADRAO = 4;

async function janela(fonte: string, desdeParam: string | null): Promise<string> {
  if (desdeParam) return desdeParam;
  const hoje = hojeBR();
  let desde = addDias(hoje, -(JANELA_PADRAO - 1));
  // Se a última atualização boa foi antes disso, volta até ela: recupera qualquer buraco.
  const { data } = await db.from("sync_status").select("ultima_ok").eq("fonte", fonte).maybeSingle();
  if (data?.ultima_ok) {
    const ult = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date(data.ultima_ok));
    if (ult < desde) desde = addDias(ult, -1);
  }
  const limite = addDias(hoje, -60);
  return desde < limite ? limite : desde;
}

async function avisarFalha(fonte: string, erro: string) {
  const resend = Deno.env.get("RESEND_API_KEY"), para = Deno.env.get("ALERTA_EMAIL");
  if (!resend || !para) return;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resend}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: Deno.env.get("ALERTA_DE") ?? "Painel Natural Art <onboarding@resend.dev>",
      to: [para],
      subject: `Painel: a atualização de ${fonte} falhou`,
      text: `A atualização de ${fonte} falhou às ${new Date().toISOString()}.\n\n${erro}\n\nA próxima rodada tenta de novo e recupera os dias perdidos.`,
    }),
  }).catch(() => {});
}

Deno.serve(async (req) => {
  const auth = req.headers.get("Authorization") ?? "";
  if (auth !== `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`) {
    return new Response("não autorizado", { status: 401 });
  }
  const url = new URL(req.url);
  const pedidas = (url.searchParams.get("fontes") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const desdeParam = url.searchParams.get("desde");
  const resultado: Record<string, unknown> = {};

  for (const nome of pedidas) {
    const fn = fontes[nome];
    if (!fn) { resultado[nome] = "fonte desconhecida"; continue; }
    const agora = new Date().toISOString();
    try {
      const desde = await janela(nome, desdeParam);
      const detalhe = await fn(db, desde);
      await db.from("sync_status").upsert({ fonte: nome, ultima_ok: agora, ultima_tentativa: agora, ultimo_erro: null, detalhe: { desde, ...detalhe } });
      resultado[nome] = { ok: true, desde, ...detalhe };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await db.from("sync_status").upsert({ fonte: nome, ultima_tentativa: agora, ultimo_erro: msg.slice(0, 1000) });
      await avisarFalha(nome, msg);
      resultado[nome] = { ok: false, erro: msg };
    }
  }
  return Response.json(resultado);
});
