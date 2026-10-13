import type { SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

const TZ = "America/Sao_Paulo";
const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ });

export const hojeBR = () => fmt.format(new Date());
export const diaBR = (iso: string) => fmt.format(new Date(iso));
export function addDias(d: string, n: number) {
  const x = new Date(d + "T12:00:00Z");
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
export function dias(desde: string, ate: string) {
  const out: string[] = [];
  for (let d = desde; d <= ate; d = addDias(d, 1)) out.push(d);
  return out;
}
export const r2 = (v: number) => Math.round(v * 100) / 100;

export function env(nome: string): string {
  const v = Deno.env.get(nome);
  if (!v) throw new Error(`Falta o segredo ${nome} nas Edge Functions do Supabase.`);
  return v;
}

export async function getJSON(url: string, init: RequestInit = {}, tentativas = 3): Promise<any> {
  let ultimo = "";
  for (let i = 0; i < tentativas; i++) {
    const r = await fetch(url, init);
    if (r.ok) return r.status === 204 ? null : await r.json();
    ultimo = `${r.status} ${(await r.text()).slice(0, 300)}`;
    if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 1500 * (i + 1))); continue; }
    break;
  }
  throw new Error(`${new URL(url).host}: ${ultimo}`);
}

export async function gravar(db: SupabaseClient, tabela: string, linhas: Record<string, unknown>[], conflito: string) {
  for (let i = 0; i < linhas.length; i += 500) {
    const { error } = await db.from(tabela).upsert(linhas.slice(i, i + 500), { onConflict: conflito });
    if (error) throw new Error(`${tabela}: ${error.message}`);
  }
}

// Apaga as linhas de um período antes de regravar (ex. vendas por SKU de um dia que mudou).
export async function limpar(db: SupabaseClient, tabela: string, filtros: Record<string, string>, desde: string) {
  let q = db.from(tabela).delete().gte("data", desde);
  for (const [k, v] of Object.entries(filtros)) q = q.eq(k, v);
  const { error } = await q;
  if (error) throw new Error(`${tabela}: ${error.message}`);
}
