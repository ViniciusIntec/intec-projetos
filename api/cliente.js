// api/cliente.js
// Endpoint público — retorna dados do projeto pelo token do cliente
// Chamado pela página /cliente/[token]

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY;

async function supabaseGet(tabela, filtros = '') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${tabela}?${filtros}`, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    }
  });
  if (!res.ok) throw new Error(`Supabase error: ${res.status}`);
  return res.json();
}

export default async function handler(req) {
  const url    = new URL(req.url);
  const token  = url.searchParams.get('token');

  if (!token) {
    return new Response(JSON.stringify({ error: 'Token obrigatório' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    // Buscar projeto pelo token
    const projetos = await supabaseGet('projetos',
      `token_cliente=eq.${encodeURIComponent(token)}&select=*`
    );

    if (!projetos || projetos.length === 0) {
      return new Response(JSON.stringify({ error: 'Link inválido ou expirado' }), {
        status: 404, headers: { 'Content-Type': 'application/json' }
      });
    }

    const projeto = projetos[0];

    // Verificar se link está ativo
    if (!projeto.link_cliente_ativo) {
      return new Response(JSON.stringify({ error: 'Este link foi desativado pelo escritório' }), {
        status: 403, headers: { 'Content-Type': 'application/json' }
      });
    }

    // Buscar atualizações do projeto (manuais + automáticas)
    const atualizacoes = await supabaseGet('atualizacoes_projeto',
      `projeto_id=eq.${projeto.id}&order=created_at.desc&select=*`
    );

    // Retornar apenas dados públicos (sem financeiro, sem dados internos)
    const dadosPublicos = {
      codigo:               projeto.codigo,
      cliente:              projeto.cliente,
      tipo:                 projeto.tipo,
      status:               projeto.status,
      dataContrato:         projeto.data_contrato,
      dataEntregaPrevista:  projeto.data_entrega_prevista,
      dataEntregaReal:      projeto.data_entrega_real,
      obs:                  projeto.obs_cliente || '', // campo separado para obs do cliente
      progresso:            projeto.progresso || 0,
      atualizacoes:         (atualizacoes || []).map(a => ({
        id:          a.id,
        tipo:        a.tipo,        // "manual" | "sessao" | "status"
        titulo:      a.titulo,
        descricao:   a.descricao,
        autor:       a.autor_nome,
        data:        a.created_at,
        visivel:     a.visivel_cliente,
        icone:       a.icone,
      })).filter(a => a.visivel !== false),
    };

    return new Response(JSON.stringify(dadosPublicos), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      }
    });

  } catch (err) {
    console.error('Erro cliente API:', err);
    return new Response(JSON.stringify({ error: 'Erro interno' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}
