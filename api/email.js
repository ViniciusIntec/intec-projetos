// api/email.js
// Vercel Edge Function — envia emails via Resend
// Chamada pelo App.jsx nos eventos: encerramento automático, projetos vencendo

export const config = { runtime: 'edge' };

const RESEND_API = 'https://api.resend.com/emails';
const FROM       = 'INTEC Engenharia <noreply@engenhariaintec.com.br>';
const GESTOR     = 'direcao@engenhariaintec.com.br';

// Paleta INTEC
const AZUL    = '#1a3a6b';
const AZUL2   = '#2563a8';
const CIANO   = '#56bfe9';
const VERDE   = '#22c55e';
const AMARELO = '#f59e0b';
const VERMELHO= '#ef4444';
const CINZA   = '#8492a6';

function baseLayout(conteudo, titulo) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;padding:0;background:#f0f4f8;font-family:'Segoe UI',Arial,sans-serif}
  .wrap{max-width:600px;margin:0 auto;padding:24px 16px}
  .card{background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(26,58,107,.1)}
  .header{background:linear-gradient(135deg,${AZUL},${AZUL2});padding:28px 32px}
  .header h1{color:#fff;margin:0;font-size:22px;font-weight:800}
  .header p{color:${CIANO};margin:6px 0 0;font-size:13px}
  .body{padding:28px 32px}
  .badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700}
  .row{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #f0f4f8}
  .row:last-child{border-bottom:none}
  .footer{text-align:center;padding:16px;font-size:11px;color:${CINZA}}
  table{width:100%;border-collapse:collapse}
  th{background:${AZUL};color:${CIANO};padding:8px 12px;text-align:left;font-size:11px;font-weight:700}
  td{padding:8px 12px;font-size:12px;border-bottom:1px solid #f0f4f8}
  tr:nth-child(even) td{background:#f8fafc}
</style>
</head>
<body>
<div class="wrap">
  <div style="text-align:center;padding:16px 0">
    <span style="font-size:22px;font-weight:900;color:${AZUL}">iNTEC</span>
    <span style="font-size:10px;color:${CINZA};display:block;letter-spacing:3px">ENGENHARIA INTEGRADA</span>
  </div>
  <div class="card">
    <div class="header">
      <h1>${titulo}</h1>
      <p>Sistema de Controle de Projetos · ${new Date().toLocaleDateString('pt-BR',{weekday:'long',day:'2-digit',month:'long',year:'numeric'})}</p>
    </div>
    <div class="body">${conteudo}</div>
  </div>
  <div class="footer">Este é um email automático do sistema INTEC. Não responda este email.</div>
</div>
</body></html>`;
}

// ─── Templates de email ───────────────────────────────────────────────────────

function tmplEncerramentoAuto({ colaborador, projetoOuAtividade, horaInicio, horaFim }) {
  const corpo = `
    <p style="color:#374151;font-size:14px">Olá, <strong>${colaborador}</strong>!</p>
    <p style="color:#6b7280;font-size:13px">Sua sessão de trabalho foi encerrada automaticamente pelo sistema pois o horário de expediente foi atingido.</p>
    <div style="background:#f0f4f8;border-radius:10px;padding:16px;margin:16px 0">
      <div class="row"><span style="color:#6b7280;font-size:13px">Atividade</span><strong style="font-size:13px">${projetoOuAtividade}</strong></div>
      <div class="row"><span style="color:#6b7280;font-size:13px">Entrada</span><strong>${horaInicio}</strong></div>
      <div class="row"><span style="color:#6b7280;font-size:13px">Saída (automática)</span><strong style="color:${AMARELO}">${horaFim}</strong></div>
    </div>
    <p style="color:#6b7280;font-size:12px">Caso o horário esteja incorreto, acesse o <a href="https://intec-projetos.vercel.app" style="color:${AZUL2}">sistema INTEC</a> para corrigir no Banco de Horas.</p>`;
  return baseLayout(corpo, '⏹ Sessão Encerrada Automaticamente');
}

function tmplProjetosVencendo({ destinatario, projetos }) {
  const rows = projetos.map(p => {
    const cor = p.dias < 0 ? VERMELHO : p.dias <= 3 ? VERMELHO : p.dias <= 7 ? AMARELO : AMARELO;
    const label = p.dias < 0 ? `${Math.abs(p.dias)}d atrasado` : p.dias === 0 ? 'Vence HOJE' : `${p.dias}d restantes`;
    return `<tr>
      <td><strong style="color:${AZUL2}">${p.codigo}</strong></td>
      <td>${p.cliente.substring(0,35)}</td>
      <td>${p.responsavel||'—'}</td>
      <td><span style="color:${cor};font-weight:700">${label}</span></td>
    </tr>`;
  }).join('');

  const corpo = `
    <p style="color:#374151;font-size:14px">Olá, <strong>${destinatario}</strong>!</p>
    <p style="color:#6b7280;font-size:13px">Os seguintes projetos estão com prazo vencendo ou já atrasados:</p>
    <table style="margin:16px 0">
      <thead><tr><th>Código</th><th>Projeto</th><th>Responsável</th><th>Prazo</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="text-align:center;margin-top:20px">
      <a href="https://intec-projetos.vercel.app" style="background:${AZUL2};color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px">Abrir Sistema INTEC</a>
    </p>`;
  return baseLayout(corpo, `⚠️ ${projetos.length} Projeto(s) com Prazo Crítico`);
}

function tmplResumoDiario({ projetos, sessoesDia, usuarios }) {
  const ativos    = projetos.filter(p => !['CONCLUÍDO','CANCELADO'].includes(p.status));
  const atrasados = projetos.filter(p => p.status === 'ATRASADO');
  const vencHoje  = projetos.filter(p => {
    if (!p.data_entrega_prevista) return false;
    const dias = Math.ceil((new Date(p.data_entrega_prevista) - new Date()) / 86400000);
    return dias >= 0 && dias <= 3;
  });
  const semContrato = ativos.filter(p => !p.tem_contrato);

  // Sessões de hoje por colaborador
  const hoje = new Date().toISOString().slice(0,10);
  const sessHoje = sessoesDia.filter(s => s.data === hoje);
  const porUser = {};
  sessHoje.forEach(s => {
    if (!porUser[s.usuario_id]) porUser[s.usuario_id] = { min:0, sessoes:0 };
    porUser[s.usuario_id].min += s.duracao_min || 0;
    porUser[s.usuario_id].sessoes++;
  });

  const userRows = usuarios.map(u => {
    const d = porUser[u.id] || { min:0, sessoes:0 };
    const h = Math.floor(d.min/60); const m = d.min%60;
    return `<tr><td>${u.nome}</td><td>${d.sessoes} sessão(ões)</td><td style="color:${d.min>0?VERDE:CINZA};font-weight:700">${d.min>0?`${h}h ${m}min`:'—'}</td></tr>`;
  }).join('');

  const corpo = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px">
      ${[
        {label:'Projetos Ativos',  val:ativos.length,      cor:AZUL2},
        {label:'Atrasados',        val:atrasados.length,   cor:VERMELHO},
        {label:'Vencem em 3 dias', val:vencHoje.length,    cor:AMARELO},
        {label:'Sem Contrato',     val:semContrato.length, cor:AMARELO},
      ].map(k=>`<div style="background:#f0f4f8;border-radius:8px;padding:14px;text-align:center">
        <div style="font-size:28px;font-weight:900;color:${k.cor}">${k.val}</div>
        <div style="font-size:11px;color:${CINZA};margin-top:4px">${k.label}</div>
      </div>`).join('')}
    </div>
    <h3 style="color:${AZUL};font-size:14px;margin:20px 0 10px">📊 Horas Trabalhadas Hoje</h3>
    <table><thead><tr><th>Colaborador</th><th>Sessões</th><th>Total</th></tr></thead>
    <tbody>${userRows}</tbody></table>
    ${atrasados.length > 0 ? `
    <h3 style="color:${VERMELHO};font-size:14px;margin:20px 0 10px">⚠️ Projetos Atrasados (${atrasados.length})</h3>
    <table><thead><tr><th>Código</th><th>Projeto</th><th>Responsável</th></tr></thead>
    <tbody>${atrasados.slice(0,10).map(p=>`<tr><td><strong style="color:${AZUL2}">${p.codigo}</strong></td><td>${(p.cliente||'').substring(0,35)}</td><td>${p.responsavel||'—'}</td></tr>`).join('')}</tbody></table>
    ` : '<p style="color:'+VERDE+';font-weight:700;text-align:center">✅ Nenhum projeto atrasado!</p>'}
    <p style="text-align:center;margin-top:20px">
      <a href="https://intec-projetos.vercel.app" style="background:${AZUL2};color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px">Abrir Sistema INTEC</a>
    </p>`;
  return baseLayout(corpo, '📊 Resumo Diário — INTEC');
}

function tmplResumoSemanal({ projetos, sessoes, usuarios }) {
  const hoje = new Date();
  const inicioSemana = new Date(hoje); inicioSemana.setDate(hoje.getDate() - 7);
  const isoInicio = inicioSemana.toISOString().slice(0,10);

  const sessSemana = sessoes.filter(s => s.data >= isoInicio);
  const totalMin   = sessSemana.reduce((a,s) => a + (s.duracao_min||0), 0);
  const totalH     = Math.floor(totalMin/60);
  const totalM     = totalMin%60;

  const porUser = {};
  sessSemana.forEach(s => {
    if (!porUser[s.usuario_id]) porUser[s.usuario_id] = { min:0, sessoes:0, projetos:new Set() };
    porUser[s.usuario_id].min += s.duracao_min || 0;
    porUser[s.usuario_id].sessoes++;
    if (s.projeto_id) porUser[s.usuario_id].projetos.add(s.projeto_id);
  });

  const concluidos = projetos.filter(p => p.status === 'CONCLUÍDO').length;
  const atrasados  = projetos.filter(p => p.status === 'ATRASADO').length;

  const userRows = usuarios.map(u => {
    const d = porUser[u.id] || { min:0, sessoes:0, projetos:new Set() };
    const h = Math.floor(d.min/60); const m = d.min%60;
    return `<tr><td>${u.nome}</td><td>${d.sessoes}</td><td>${d.projetos.size}</td><td style="color:${d.min>0?VERDE:CINZA};font-weight:700">${d.min>0?`${h}h ${m}min`:'—'}</td></tr>`;
  }).join('');

  const corpo = `
    <div style="background:#f0f4f8;border-radius:10px;padding:16px;margin-bottom:20px;text-align:center">
      <div style="font-size:11px;color:${CINZA};margin-bottom:4px">TOTAL DE HORAS NA SEMANA</div>
      <div style="font-size:36px;font-weight:900;color:${AZUL2}">${totalH}h ${totalM}min</div>
      <div style="font-size:12px;color:${CINZA};margin-top:4px">${sessSemana.length} sessões registradas</div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px">
      ${[
        {label:'Concluídos na semana', val:concluidos, cor:VERDE},
        {label:'Atrasados',           val:atrasados,  cor:VERMELHO},
      ].map(k=>`<div style="background:#f0f4f8;border-radius:8px;padding:14px;text-align:center">
        <div style="font-size:28px;font-weight:900;color:${k.cor}">${k.val}</div>
        <div style="font-size:11px;color:${CINZA};margin-top:4px">${k.label}</div>
      </div>`).join('')}
    </div>
    <h3 style="color:${AZUL};font-size:14px;margin:20px 0 10px">👥 Desempenho da Equipe</h3>
    <table><thead><tr><th>Colaborador</th><th>Sessões</th><th>Projetos</th><th>Total</th></tr></thead>
    <tbody>${userRows}</tbody></table>
    <p style="text-align:center;margin-top:20px">
      <a href="https://intec-projetos.vercel.app" style="background:${AZUL2};color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px">Abrir Sistema INTEC</a>
    </p>`;
  return baseLayout(corpo, '📅 Resumo Semanal — INTEC');
}

// ─── Handler principal ────────────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) {
    return new Response(JSON.stringify({ error: 'RESEND_API_KEY não configurada' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  let body;
  try { body = await req.json(); }
  catch { return new Response('Body inválido', { status: 400 }); }

  const { tipo, dados } = body;
  let para, assunto, html;

  try {
    switch (tipo) {
      case 'encerramento_auto':
        para    = [dados.email, GESTOR].filter(Boolean);
        assunto = `⏹ Sessão encerrada automaticamente — ${dados.colaborador}`;
        html    = tmplEncerramentoAuto(dados);
        break;

      case 'projetos_vencendo':
        para    = [GESTOR, dados.emailResponsavel].filter((e,i,a) => e && a.indexOf(e)===i);
        assunto = `⚠️ ${dados.projetos.length} projeto(s) com prazo crítico — INTEC`;
        html    = tmplProjetosVencendo(dados);
        break;

      case 'resumo_diario':
        para    = [GESTOR];
        assunto = `📊 Resumo Diário INTEC — ${new Date().toLocaleDateString('pt-BR')}`;
        html    = tmplResumoDiario(dados);
        break;

      case 'resumo_semanal':
        para    = [GESTOR];
        assunto = `📅 Resumo Semanal INTEC — semana de ${new Date().toLocaleDateString('pt-BR')}`;
        html    = tmplResumoSemanal(dados);
        break;

      default:
        return new Response(JSON.stringify({ error: 'Tipo desconhecido: ' + tipo }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        });
    }

    const res = await fetch(RESEND_API, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: para, subject: assunto, html }),
    });

    const resultado = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(resultado));

    return new Response(JSON.stringify({ ok: true, id: resultado.id }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error('Erro email:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}
