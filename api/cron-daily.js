// api/cron-daily.js
// Vercel Cron Job — executa todo dia às 08h (BRT = UTC-3, então 11h UTC)
// Configurado no vercel.json

export const config = { runtime: 'edge' };

const SUPABASE_URL  = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY  = process.env.VITE_SUPABASE_ANON_KEY;
const BASE_URL      = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';

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
  // Segurança: só Vercel pode chamar este endpoint
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    // Buscar dados do Supabase
    const hoje = new Date().toISOString().slice(0, 10);
    const [projetos, sessoes, usuarios] = await Promise.all([
      supabaseGet('projetos', 'select=id,codigo,cliente,status,responsavel,tem_contrato,data_entrega_prevista'),
      supabaseGet('sessoes_horas', `select=*&data=eq.${hoje}`),
      supabaseGet('usuarios', 'select=id,nome,email&ativo=eq.true'),
    ]);

    // Verificar projetos com prazo crítico (vencendo em até 7 dias ou já atrasados)
    const criticos = projetos.filter(p => {
      if (!p.data_entrega_prevista) return false;
      if (['CONCLUÍDO', 'CANCELADO'].includes(p.status)) return false;
      const dias = Math.ceil((new Date(p.data_entrega_prevista) - new Date()) / 86400000);
      return dias <= 7;
    });

    // Enviar alertas de projetos críticos por responsável
    if (criticos.length > 0) {
      // Agrupar por responsável
      const porResp = {};
      criticos.forEach(p => {
        const resp = p.responsavel || 'sem_responsavel';
        if (!porResp[resp]) porResp[resp] = [];
        porResp[resp].push({
          codigo: p.codigo,
          cliente: p.cliente,
          responsavel: p.responsavel,
          dias: Math.ceil((new Date(p.data_entrega_prevista) - new Date()) / 86400000),
        });
      });

      // Envia um email para cada responsável + gestor
      for (const [responsavel, projResp] of Object.entries(porResp)) {
        const usuario = usuarios.find(u => u.nome === responsavel);
        await fetch(`${BASE_URL}/api/email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tipo: 'projetos_vencendo',
            dados: {
              destinatario: responsavel,
              emailResponsavel: usuario?.email || null,
              projetos: projResp,
            }
          })
        });
      }
    }

    // Enviar resumo diário para o gestor
    await fetch(`${BASE_URL}/api/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tipo: 'resumo_diario',
        dados: { projetos, sessoesDia: sessoes, usuarios }
      })
    });

    return new Response(JSON.stringify({
      ok: true,
      resumoDiario: true,
      alertasCriticos: criticos.length,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (err) {
    console.error('Erro cron-daily:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}
