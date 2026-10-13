// Gera web/config.js no build da Vercel com o endereço e a chave pública do Supabase.
// A chave "anon" é pública por natureza: quem protege os dados são as regras de acesso (RLS) do banco.
import { writeFileSync } from "node:fs";
const url = process.env.SUPABASE_URL, anonKey = process.env.SUPABASE_ANON_KEY;
if (!url || !anonKey) {
  console.error("Defina SUPABASE_URL e SUPABASE_ANON_KEY nas variáveis da Vercel.");
  process.exit(1);
}
writeFileSync(new URL("../web/config.js", import.meta.url), `window.PAINEL_CONFIG=${JSON.stringify({ url, anonKey })};\n`);
console.log("config.js gerado");
