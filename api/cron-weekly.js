// api/cron-weekly.js
// Vercel Cron Job — executa toda segunda-feira às 08h (BRT = 11h UTC)
// Configurado no vercel.json

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const BASE_URL     = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';

async function supabaseGet(tabela, filtros = '') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${tabela}?${filtros}`, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    }
  });
  return res.json();
}

export default async function handler(req) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    // Buscar dados da última semana
    const hoje = new Date();
    const inicioSemana = new Date(hoje);
    inicioSemana.setDate(hoje.getDate() - 7);
    const isoInicio = inicioSemana.toISOString().slice(0, 10);

    const [projetos, sessoes, usuarios] = await Promise.all([
      supabaseGet('projetos', 'select=id,codigo,cliente,status,responsavel'),
      supabaseGet('sessoes_horas', `select=*&data=gte.${isoInicio}`),
      supabaseGet('usuarios', 'select=id,nome,email&ativo=eq.true'),
    ]);

    await fetch(`${BASE_URL}/api/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tipo: 'resumo_semanal',
        dados: { projetos, sessoes, usuarios }
      })
    });

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error('Erro cron-weekly:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}
