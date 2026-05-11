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
      const { data, error } = await supabase
        .from('projetos')
        .upsert(row, { onConflict: 'id' })
        .select()
        .single();
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
    async encerrar(id, horaFim, duracaoMin, obs) {
      const { data, error } = await supabase
        .from('sessoes_horas')
        .update({ hora_fim: horaFim, duracao_min: duracaoMin, obs })
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      return toSessaoFront(data);
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
    ano:                  r.ano,
    tipo:                 r.tipo,
    status:               r.status,
    prazo:                r.prazo || 0,
    dataContrato:         r.data_contrato || '',
    dataEntregaPrevista:  r.data_entrega_prevista || '',
    obs:                  r.obs || '',
    temContrato:          r.tem_contrato || false,
    parcelas:             Array.isArray(r.parcelas) ? r.parcelas : [],
    driveUrl:             r.drive_url || '',
    _doDrive:             r.do_drive || false,
  };
}

function toProjetoBack(p) {
  return {
    id:                   p.id || p.codigo,
    codigo:               p.codigo,
    cliente:              p.cliente,
    responsavel:          p.responsavel || '',
    coresponsavel:        p.coresponsavel || '',
    ano:                  p.ano,
    tipo:                 p.tipo,
    status:               p.status,
    prazo:                p.prazo || 0,
    data_contrato:        p.dataContrato || null,
    data_entrega_prevista: p.dataEntregaPrevista || null,
    obs:                  p.obs || '',
    tem_contrato:         p.temContrato || false,
    parcelas:             p.parcelas || [],
    drive_url:            p.driveUrl || '',
    do_drive:             p._doDrive || false,
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
    id:          r.id,
    usuarioId:   r.usuario_id,
    projetoId:   r.projeto_id,
    data:        r.data,
    horaInicio:  r.hora_inicio,
    horaFim:     r.hora_fim,
    duracaoMin:  r.duracao_min,
    inicioTs:    r.inicio_ts,
    obs:         r.obs || '',
  };
}

function toSessaoBack(s) {
  return {
    id:          s.id,
    usuario_id:  s.usuarioId,
    projeto_id:  s.projetoId || null,
    data:        s.data,
    hora_inicio: s.horaInicio,
    hora_fim:    s.horaFim || null,
    duracao_min: s.duracaoMin || null,
    inicio_ts:   s.inicioTs,
    obs:         s.obs || '',
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
