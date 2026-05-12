// src/supabase.js
// Substitua os valores abaixo pelos do seu projeto Supabase:
// Supabase → Settings → API → Project URL e anon public key

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL  = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);

// ─── PROJETOS ──────────────────────────────────────────────────────────────────
export const db = {

  projetos: {
    async listar() {
      const { data, error } = await supabase
        .from('projetos')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data.map(toProjetoFront);
    },
    async salvar(projeto) {
      const row = toProjetoBack(projeto);
      const id  = row.id;

      // Tentar update primeiro (projeto existente), depois insert se não existir
      let data, error;

      // Verificar se já existe
      const { data: existe } = await supabase
        .from('projetos').select('id').eq('id', id).single();

      if (existe) {
        // UPDATE — preserva campos que não estamos editando
        const resultado = await supabase
          .from('projetos')
          .update(row)
          .eq('id', id)
          .select()
          .single();
        data  = resultado.data;
        error = resultado.error;
      } else {
        // INSERT — projeto novo
        const resultado = await supabase
          .from('projetos')
          .insert(row)
          .select()
          .single();
        data  = resultado.data;
        error = resultado.error;
      }

      if (error) throw error;
      return toProjetoFront(data);
    },
    async excluir(id) {
      const { error } = await supabase.from('projetos').delete().eq('id', id);
      if (error) throw error;
    },
  },

  usuarios: {
    async listar() {
      const { data, error } = await supabase
        .from('usuarios')
        .select('*')
        .order('nome');
      if (error) throw error;
      return data.map(toUsuarioFront);
    },
    async salvar(usuario) {
      const row = toUsuarioBack(usuario);
      const { data, error } = await supabase
        .from('usuarios')
        .upsert(row, { onConflict: 'id' })
        .select()
        .single();
      if (error) throw error;
      return toUsuarioFront(data);
    },
  },

  sessoes: {
    async listar() {
      const { data, error } = await supabase
        .from('sessoes_horas')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data.map(toSessaoFront);
    },
    async salvar(sessao) {
      const row = toSessaoBack(sessao);
      const { data, error } = await supabase
        .from('sessoes_horas')
        .upsert(row, { onConflict: 'id' })
        .select()
        .single();
      if (error) throw error;
      return toSessaoFront(data);
    },
    async encerrar(id, horaFim, duracaoMin, obs, minutosExtras=0) {
      const { data, error } = await supabase
        .from('sessoes_horas')
        .update({ hora_fim: horaFim, duracao_min: duracaoMin, obs, minutos_extras: minutosExtras })
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      return toSessaoFront(data);
    },
    async excluir(id) {
      const { error } = await supabase
        .from('sessoes_horas')
        .delete()
        .eq('id', id);
      if (error) throw error;
    },
    async atualizarObs(id, obs) {
      const { error } = await supabase
        .from('sessoes_horas')
        .update({ obs })
        .eq('id', id);
      if (error) throw error;
    },
    async toggleVisivel(id, visivel) {
      const { error } = await supabase
        .from('sessoes_horas')
        .update({ visivel_cliente: visivel })
        .eq('id', id);
      if (error) throw error;
    },
  },

  recessos: {
    async listar() {
      const { data, error } = await supabase
        .from('recessos')
        .select('*')
        .order('data');
      if (error) throw error;
      return data.map(r => ({ data: r.data, motivo: r.motivo }));
    },
    async salvar(data, motivo) {
      const { error } = await supabase
        .from('recessos')
        .upsert({ data, motivo }, { onConflict: 'data' });
      if (error) throw error;
    },
    async excluir(data) {
      const { error } = await supabase.from('recessos').delete().eq('data', data);
      if (error) throw error;
    },
  },

  feriadosEdicoes: {
    async listar() {
      const { data, error } = await supabase.from('feriados_edicoes').select('*');
      if (error) throw error;
      const mapa = {};
      data.forEach(f => { mapa[f.data_iso] = f.nome; }); // nome null = excluído
      return mapa;
    },
    async salvar(dataIso, nome) { // nome = null para excluir
      const { error } = await supabase
        .from('feriados_edicoes')
        .upsert({ data_iso: dataIso, nome }, { onConflict: 'data_iso' });
      if (error) throw error;
    },
    async excluir(dataIso) {
      const { error } = await supabase
        .from('feriados_edicoes')
        .delete()
        .eq('data_iso', dataIso);
      if (error) throw error;
    },
  },
};

// ─── CONVERSORES (snake_case ↔ camelCase) ──────────────────────────────────────
function toProjetoFront(r) {
  return {
    id:                   r.id,
    codigo:               r.codigo,
    cliente:              r.cliente,
    responsavel:          r.responsavel || '',
    coresponsavel:        r.coresponsavel || '',
    coresponsavel2:       r.coresponsavel2 || '',
    coresponsavel3:       r.coresponsavel3 || '',
    ano:                  r.ano,
    tipo:                 r.tipo,
    status:               r.status,
    prazo:                r.prazo || 0,
    dataContrato:         r.data_contrato || '',
    dataEntregaPrevista:  r.data_entrega_prevista || '',
    dataEntregaReal:      r.data_entrega_real || '',
    obs:                  r.obs || '',
    temContrato:          r.tem_contrato || false,
    parcelas:             Array.isArray(r.parcelas) ? r.parcelas : [],
    pausas:               Array.isArray(r.pausas)      ? r.pausas      : [],
    disciplinas:          Array.isArray(r.disciplinas) ? r.disciplinas : [],
    driveUrl:             r.drive_url || '',
    driveEntregaveis:     r.drive_entregaveis || '',
    statusAuto:           r.status_auto ?? true,
    _doDrive:             r.do_drive || false,
    // Portal do cliente
    token_cliente:        r.token_cliente || '',
    link_cliente_ativo:   r.link_cliente_ativo || false,
    linkClienteAtivo:     r.link_cliente_ativo || false,
    progresso:            r.progresso || 0,
    obs_cliente:          r.obs_cliente || '',
  };
}

function toProjetoBack(p) {
  return {
    id:                    p.id || p.codigo,
    codigo:                p.codigo,
    cliente:               p.cliente,
    responsavel:           p.responsavel || '',
    coresponsavel:         p.coresponsavel || '',
    coresponsavel2:        p.coresponsavel2 || '',
    coresponsavel3:        p.coresponsavel3 || '',
    ano:                   p.ano,
    tipo:                  p.tipo,
    status:                p.status,
    prazo:                 p.prazo || 0,
    data_contrato:         p.dataContrato || null,
    data_entrega_prevista: p.dataEntregaPrevista || null,
    data_entrega_real:     p.dataEntregaReal || null,
    obs:                   p.obs || '',
    tem_contrato:          p.temContrato || false,
    parcelas:              p.parcelas || [],
    pausas:               p.pausas      || [],
    disciplinas:          p.disciplinas || [],
    drive_url:             p.driveUrl || '',
    drive_entregaveis:    p.driveEntregaveis || '',
    status_auto:          p.statusAuto ?? true,
    do_drive:              p._doDrive || false,
    // Portal do cliente — preservar token e salvar progresso/obs
    ...(p.token_cliente        ? { token_cliente:      p.token_cliente }      : {}),
    link_cliente_ativo: p.linkClienteAtivo ?? p.link_cliente_ativo ?? false,
    progresso:             p.progresso ?? 0,
    obs_cliente:           p.obsCliente  ?? p.obs_cliente ?? '',
  };
}

function toUsuarioFront(r) {
  return {
    id:             r.id,
    nome:           r.nome,
    email:          r.email,
    senha:          r.senha,
    perfil:         r.perfil,
    cor:            r.cor || '#2563a8',
    iniciais:       r.iniciais || r.nome?.slice(0,2).toUpperCase(),
    ativo:          r.ativo !== false,
    salario:        r.salario || 0,
    especialidades: r.especialidades || [],
    expediente:     r.expediente || { inicio:'09:00', fim:'18:00' },
  };
}

function toUsuarioBack(u) {
  return {
    id:             u.id,
    nome:           u.nome,
    email:          u.email,
    senha:          u.senha,
    perfil:         u.perfil,
    cor:            u.cor,
    iniciais:       u.iniciais,
    ativo:          u.ativo,
    salario:        u.salario || 0,
    especialidades: u.especialidades || [],
    expediente:     u.expediente || { inicio:'09:00', fim:'18:00' },
  };
}

function toSessaoFront(r) {
  return {
    id:             r.id,
    usuarioId:      r.usuario_id,
    projetoId:      r.projeto_id,
    categoriaAdmin: r.categoria_admin || null,
    data:           r.data,
    horaInicio:     r.hora_inicio,
    horaFim:        r.hora_fim,
    duracaoMin:     r.duracao_min,
    minutosExtras:  r.minutos_extras || 0,
    inicioTs:       r.inicio_ts,
    obs:            r.obs || '',
  };
}

function toSessaoBack(s) {
  return {
    id:               s.id,
    usuario_id:       s.usuarioId,
    projeto_id:       s.projetoId || null,
    categoria_admin:  s.categoriaAdmin || null,
    data:             s.data,
    hora_inicio:      s.horaInicio,
    hora_fim:         s.horaFim || null,
    duracao_min:      s.duracaoMin || null,
    minutos_extras:   s.minutosExtras || 0,
    inicio_ts:        s.inicioTs,
    obs:              s.obs || '',
  };
}

// ─── REALTIME ──────────────────────────────────────────────────────────────────
// Escuta mudanças em tempo real nas tabelas e chama os callbacks
export function iniciarRealtime({ onProjetosChange, onSessoesChange }) {
  const canal = supabase
    .channel('intec-realtime')
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'projetos' },
      (payload) => { if(onProjetosChange) onProjetosChange(payload); }
    )
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'sessoes_horas' },
      (payload) => { if(onSessoesChange) onSessoesChange(payload); }
    )
    .subscribe();

  return () => supabase.removeChannel(canal); // retorna função de cleanup
}

// ─── EMAIL VIA RESEND (chama a API da Vercel) ─────────────────────────────────
export async function enviarEmail(tipo, dados) {
  try {
    const res = await fetch('/api/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tipo, dados }),
    });
    const result = await res.json();
    if (!res.ok) console.error('Erro email:', result);
    return result;
  } catch (err) {
    console.error('Erro ao enviar email:', err);
  }
}

// ─── PORTAL DO CLIENTE ────────────────────────────────────────────────────────
export const portal = {

  // Gerar token único para o projeto
  async gerarToken(projetoId) {
    const token = Array.from(crypto.getRandomValues(new Uint8Array(20)))
      .map(b => b.toString(16).padStart(2,'0')).join('');
    const { data, error } = await supabase
      .from('projetos')
      .update({ token_cliente: token, link_cliente_ativo: true })
      .eq('id', projetoId)
      .select('token_cliente')
      .single();
    if (error) throw error;
    return data.token_cliente;
  },

  // Ativar/desativar link
  async setLinkAtivo(projetoId, ativo) {
    const { error } = await supabase
      .from('projetos')
      .update({ link_cliente_ativo: ativo })
      .eq('id', projetoId);
    if (error) throw error;
  },

  // Buscar atualizações do projeto
  async listarAtualizacoes(projetoId) {
    const { data, error } = await supabase
      .from('atualizacoes_projeto')
      .select('*')
      .eq('projeto_id', projetoId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  },

  // Adicionar atualização manual
  async adicionarAtualizacao(projetoId, { tipo, titulo, descricao, autorId, autorNome, icone, visivelCliente=true }) {
    const { data, error } = await supabase
      .from('atualizacoes_projeto')
      .insert({
        projeto_id: projetoId, tipo: tipo||'manual',
        titulo, descricao: descricao||'',
        autor_id: autorId||null, autor_nome: autorNome||'',
        icone: icone||'📝', visivel_cliente: visivelCliente,
      })
      .select().single();
    if (error) throw error;
    return data;
  },

  // Excluir atualização
  async excluirAtualizacao(id) {
    const { error } = await supabase
      .from('atualizacoes_projeto')
      .delete().eq('id', id);
    if (error) throw error;
  },

  // Atualizar progresso e obs do cliente
  async atualizarProgresso(projetoId, progresso, obsCliente) {
    const { error } = await supabase
      .from('projetos')
      .update({ progresso, obs_cliente: obsCliente })
      .eq('id', projetoId);
    if (error) throw error;
  },
};
