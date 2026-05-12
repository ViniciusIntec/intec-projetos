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

    // Buscar atualizações manuais do projeto
    const atualizacoes = await supabaseGet('atualizacoes_projeto',
      `projeto_id=eq.${projeto.id}&order=created_at.desc&select=*`
    );

    // Buscar sessões do banco de horas deste projeto (apenas encerradas)
    const sessoes = await supabaseGet('sessoes_horas',
      `projeto_id=eq.${projeto.id}&hora_fim=not.is.null&order=created_at.desc&select=*,usuarios(nome)`
    );

    // Retornar apenas dados públicos (sem financeiro, sem dados internos)
    const dadosPublicos = {
      // Identificação
      codigo:               projeto.codigo,
      cliente:              projeto.cliente,
      tipo:                 projeto.tipo,
      status:               projeto.status,
      // Responsáveis
      responsavel:          projeto.responsavel || '',
      coresponsavel:        projeto.coresponsavel || '',
      coresponsavel2:       projeto.coresponsavel2 || '',
      coresponsavel3:       projeto.coresponsavel3 || '',
      // Contrato e prazo
      dataContrato:         projeto.data_contrato || null,
      prazo:                projeto.prazo || 0,
      dataEntregaPrevista:  projeto.data_entrega_prevista || null,
      dataEntregaReal:      projeto.data_entrega_real || null,
      // Portal
      progresso:            projeto.progresso || 0,
      obs:                  projeto.obs_cliente || '',
      // Atualizações visíveis ao cliente
      atualizacoes: (() => {
        // Atualizações manuais visíveis ao cliente
        const manuais = (atualizacoes || [])
          .filter(a => a.visivel_cliente !== false)
          .map(a => ({
            id:        a.id,
            tipo:      a.tipo || 'manual',
            titulo:    a.titulo,
            descricao: a.descricao || '',
            autor:     a.autor_nome || '',
            data:      a.created_at,
            icone:     a.icone || '📝',
            origem:    'manual',
          }));

        // Sessões do banco de horas como linha do tempo
        const sessoesTimeline = (sessoes || []).filter(s => s.visivel_cliente !== false).map(s => {
          const nomeColaborador = s.usuarios?.nome || 'Equipe INTEC';
          const hIni  = s.hora_inicio || '';
          const hFim  = s.hora_fim    || '';
          const durMin= s.duracao_min || 0;
          const horas = Math.floor(durMin/60);
          const mins  = durMin % 60;
          const durStr= durMin > 0 ? (horas>0 ? `${horas}h ${mins}min` : `${mins}min`) : '';
          const obsStr= s.obs ? ` — ${s.obs}` : '';
          return {
            id:        s.id,
            tipo:      'sessao',
            titulo:    `Trabalho realizado por ${nomeColaborador}`,
            descricao: `${s.data ? new Date(s.data+'T12:00:00').toLocaleDateString('pt-BR') : ''} ${durStr?'('+durStr+')':''} ${obsStr}`.trim(),
            autor:     nomeColaborador,
            data:      s.created_at,
            icone:     '⚙️',
            origem:    'sessao',
          };
        });

        // Unir e ordenar por data decrescente
        return [...manuais, ...sessoesTimeline]
          .sort((a,b) => new Date(b.data) - new Date(a.data));
      })(),
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
