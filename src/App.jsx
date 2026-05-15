import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { db, iniciarRealtime, enviarEmail, portal, chat } from "./supabase.js";

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID = "26616128245-j4kghm435os4m3vu42tq32ikkjmbvrp6.apps.googleusercontent.com";
const DRIVE_ROOT_ID    = "0AIRz2lul3P76Uk9PVA";
const SCOPES           = "https://www.googleapis.com/auth/drive.readonly";
const CHECK_INTERVAL   = 60 * 60 * 1000; // 1 hora

// Solicitar permissão de notificação ao carregar
function pedirPermissaoNotificacao() {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
  // Desbloquear AudioContext no primeiro clique (política dos browsers modernos)
  const desbloquearAudio = () => {
    if (_audioCtx && _audioCtx.state === 'suspended') {
      _audioCtx.resume().catch(()=>{});
    }
    document.removeEventListener('click', desbloquearAudio);
  };
  document.addEventListener('click', desbloquearAudio);
}

// Disparar notificação nativa do sistema operacional
function notificarSistema(titulo, corpo, tag="intec-geral", duracaoMs=10000) {
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  try {
    const n = new Notification(titulo, {
      body:     corpo,
      icon:     "https://intec-projetos.vercel.app/icons.svg",
      tag:      tag,
      renotify: true,
      silent:   false,
    });
    n.onclick = () => { window.focus(); n.close(); };
    setTimeout(() => n.close(), duracaoMs);
  } catch(e) { console.warn("Notificação:", e); }
}

// Som de notificação do chat
let _audioCtx = null;
function tocarSomChat() {
  try {
    // Reusar contexto existente ou criar novo
    if (!_audioCtx || _audioCtx.state === 'closed') {
      _audioCtx = new (window.AudioContext||window.webkitAudioContext)();
    }
    const ctx = _audioCtx;
    // Retomar se suspenso (política do browser)
    const play = () => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(660, ctx.currentTime);
      osc.frequency.setValueAtTime(880, ctx.currentTime+0.1);
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.25, ctx.currentTime+0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime+0.4);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime+0.4);
    };
    if (ctx.state === 'suspended') {
      ctx.resume().then(play).catch(()=>{});
    } else {
      play();
    }
  } catch(e){ console.warn('Som chat:', e); }
}

// Piscar título da aba quando chegar mensagem
let _titleFlash = null;
let _tituloOriginal = document.title;
function piscarTitulo(msg) {
  if (_titleFlash) return; // já piscando
  let show = true;
  _titleFlash = setInterval(() => {
    document.title = show ? `💬 ${msg}` : _tituloOriginal;
    show = !show;
  }, 1000);
  // Para de piscar quando o usuário volta para a aba
  const parar = () => {
    clearInterval(_titleFlash); _titleFlash = null;
    document.title = _tituloOriginal;
    window.removeEventListener('focus', parar);
  };
  window.addEventListener('focus', parar);
  setTimeout(parar, 30000); // para sozinho após 30s
}

// Controle de notificações já enviadas (evitar repetir na mesma sessão)
const _notifsEnviadas = new Set();
function notificarUmaVez(chave, titulo, corpo, tag) {
  if (_notifsEnviadas.has(chave)) return;
  _notifsEnviadas.add(chave);
  notificarSistema(titulo, corpo, tag, 12000);
}

// ─── CORES INTEC ───────────────────────────────────────────────────────────────
const C = {
  azulEscuro:"#1a3a6b", azulMedio:"#2563a8", azulClaro:"#3b8fd4",
  ciano:"#56bfe9", cinzaEscuro:"#1e2535", cinzaMedio:"#2d3a50",
  cinzaClaro:"#8492a6", cinzaFundo:"#f0f4f8", cinzaCard:"#e8eef5",
  branco:"#ffffff", verde:"#22c55e", amarelo:"#f59e0b",
  vermelho:"#ef4444", laranja:"#f97316",
};

const STATUS_CONFIG = {
  "Novo/Definir":   { cor:C.cinzaClaro, bg:"#f8fafc", icone:"○" },
  "Em andamento":   { cor:C.azulClaro,  bg:"#e8f4fd", icone:"▶" },
  "PAUSADO":        { cor:C.amarelo,    bg:"#fffbeb", icone:"⏸" },
  "PAUSADO PARCIAL":{ cor:"#d97706",    bg:"#fef3c7", icone:"⏸" },
  "ATRASADO":       { cor:C.vermelho,   bg:"#fef2f2", icone:"⚠" },
  "CONCLUÍDO":      { cor:C.verde,      bg:"#f0fdf4", icone:"✓" },
  "CANCELADO":      { cor:"#6b7280",    bg:"#f3f4f6", icone:"✕" },
};
// Normaliza variações antigas
const STATUS_ALIAS = { "Concluído":"CONCLUÍDO", "concluído":"CONCLUÍDO", "Cancelado":"CANCELADO" };

const TIPOS = {
  PE:"Proj. Estrutural",   PR:"Proj. Reforço",        LT:"Laudo Técnico",
  CB:"Compatibilização",   EL:"Proj. Elétrico",        PH:"Proj. Hidrossanitário",
  PA:"Proj. Arquitetônico", PF:"Proj. Fundação",       CT:"Consultoria", RE:"Revisão",
};

// Disciplinas do sistema — mesmos tipos de TIPOS
const DISCIPLINAS_CB = [
  { id:"PE", label:"Proj. Estrutural",      icone:"🏗",  cor:"#2563a8" },
  { id:"PR", label:"Proj. Reforço",         icone:"🔩",  cor:"#0891b2" },
  { id:"LT", label:"Laudo Técnico",         icone:"📋",  cor:"#059669" },
  { id:"EL", label:"Proj. Elétrico",        icone:"⚡",  cor:"#f59e0b" },
  { id:"PH", label:"Proj. Hidrossanitário", icone:"💧",  cor:"#06b6d4" },
  { id:"PA", label:"Proj. Arquitetônico",   icone:"📐",  cor:"#ec4899" },
  { id:"PF", label:"Proj. Fundação",        icone:"⚓",  cor:"#8b5cf6" },
  { id:"CT", label:"Consultoria",           icone:"💼",  cor:"#6366f1" },
  { id:"CB", label:"Compatibilização",      icone:"🔗",  cor:"#9333ea" },
];

const USUARIOS_PADRAO = [
  { id:"vinicius", nome:"Vinicius", email:"intecestruturas4@gmail.com", senha:"1234",
    perfil:"colaborador", cor:"#2563a8", iniciais:"VI", ativo:true,
    expediente:{ turno1:{inicio:"09:00",fim:"12:00"}, turno2:{ativo:true,inicio:"14:00",fim:"18:00"}, modo:"E" },
    salario:0, especialidades:["PE","PR","LT","PF"] },
  { id:"leonardo", nome:"Leonardo", email:"intecestruturas2@gmail.com", senha:"1234",
    perfil:"colaborador", cor:"#0891b2", iniciais:"LE", ativo:true,
    expediente:{ turno1:{inicio:"09:00",fim:"12:00"}, turno2:{ativo:true,inicio:"14:00",fim:"18:00"}, modo:"E" },
    especialidades:["PE","PR","LT","PF"] },
  { id:"claudio", nome:"Claudio", email:"intecestruturas3@gmail.com", senha:"1234",
    perfil:"colaborador", cor:"#059669", iniciais:"CL", ativo:true,
    expediente:{ turno1:{inicio:"09:00",fim:"12:00"}, turno2:{ativo:true,inicio:"14:00",fim:"18:00"}, modo:"E" },
    especialidades:["PE","PR","LT","PF"] },
  { id:"heriston", nome:"Heriston", email:"direcao@engenhariaintec.com.br", senha:"1234",
    perfil:"gestor", cor:"#7c3aed", iniciais:"HE", ativo:true,
    expediente:{ turno1:{inicio:"09:00",fim:"12:00"}, turno2:{ativo:true,inicio:"14:00",fim:"18:00"}, modo:"E" },
    especialidades:["PE","PR","LT","PF","CT"] },
  { id:"gustavo", nome:"Gustavo", email:"intecestruturas5@gmail.com", senha:"1234",
    perfil:"colaborador", cor:"#f59e0b", iniciais:"GU", ativo:true,
    expediente:{ turno1:{inicio:"09:00",fim:"12:00"}, turno2:{ativo:true,inicio:"14:00",fim:"18:00"}, modo:"E" },
    especialidades:["PE","PR","LT","PF"] },
  { id:"jonathan", nome:"Jonathan", email:"intecobras2@gmail.com", senha:"1234",
    perfil:"colaborador", cor:"#dc2626", iniciais:"JO", ativo:true,
    expediente:{ turno1:{inicio:"09:00",fim:"12:00"}, turno2:{ativo:true,inicio:"14:00",fim:"18:00"}, modo:"E" },
    especialidades:["EL","PH"] },
  { id:"pablo", nome:"Pablo", email:"inteccompplementares1@gmail.com", senha:"1234",
    perfil:"colaborador", cor:"#db2777", iniciais:"PA", ativo:true,
    expediente:{ turno1:{inicio:"09:00",fim:"12:00"}, turno2:{ativo:true,inicio:"14:00",fim:"18:00"}, modo:"E" },
    especialidades:["EL","PH"] },
];

// ─── UTILS ─────────────────────────────────────────────────────────────────────
const fmt        = v => new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"}).format(v||0);
const fmtData    = d => { if(!d) return "—"; const [y,m,dd]=d.split("-"); return `${dd}/${m}/${y}`; };
const fmtDuracao = mins => { if(!mins||mins<0) return "0h 0min"; return `${Math.floor(mins/60)}h ${mins%60}min`; };
const diasAte    = data => { if(!data) return null; return Math.ceil((new Date(data)-new Date())/86400000); };
const statusN    = s => { if(!s) return "Novo/Definir"; if(s==="Concluído"||s==="CONCLUÍDO") return "CONCLUÍDO"; return s; };

const calcStatusAuto = (p) => {
  if (!p) return 'Novo/Definir';
  const atual = statusN(p.status);
  if (atual==="CONCLUÍDO" || atual==="CANCELADO") return atual;
  if (atual==="PAUSADO") return "PAUSADO";
  if ((p.progresso||0) >= 100) return "CONCLUÍDO";
  // CB: verificar pausas parciais nas disciplinas dos membros
  if (p.tipo==="CB") {
    const membros = (p.disciplinas||[]).filter(d=>d.usuarioNome);
    if (membros.length > 0) {
      // Todas as disciplinas de todos os membros pausadas = PAUSADO geral
      const todasDiscs = membros.flatMap(m=>(m.disciplinas||[]).map(dId=>({dId,pausada:(m.discPausadas||{})[dId]})));
      if (todasDiscs.length > 0 && todasDiscs.every(d=>d.pausada)) return "PAUSADO";
      // Pelo menos uma disciplina pausada = PAUSADO PARCIAL
      if (todasDiscs.some(d=>d.pausada)) return "PAUSADO PARCIAL";
    }
  }
  if (p.dataEntregaPrevista) {
    const dias = Math.ceil((new Date(p.dataEntregaPrevista) - new Date()) / 86400000);
    if (dias < 0) return "ATRASADO";
  }
  if (p.responsavel || p.temContrato || p.prazo || p.dataContrato) return "Em andamento";
  return "Novo/Definir";
};
const horaMin    = h => { if(!h) return 0; const [hh,mm]=h.split(":").map(Number); return hh*60+mm; };

// Calcula horas diárias de trabalho baseado no expediente do usuário
// Suporta 1 ou 2 turnos com modo E (ambos) ou OU (apenas 1 turno por dia)
// Estrutura: { turno1:{inicio,fim}, turno2:{ativo,inicio,fim}, modo:"E"|"OU" }
// Dias da semana
const DIAS_SEMANA = ["domingo","segunda","terca","quarta","quinta","sexta","sabado"];
const DIAS_LABEL  = ["Dom","Seg","Ter","Qua","Qui","Sex","Sáb"];

// Formato novo de expediente por dia da semana:
// { segunda: { ativo:true, turno1:{inicio,fim}, turno2:{ativo,inicio,fim} }, ... }

// Calcula horas de um dia específico do expediente
const calcHorasDiaSemana = (diaExp) => {
  if (!diaExp || !diaExp.ativo) return 0;
  const h1 = diaExp.turno1?.inicio && diaExp.turno1?.fim
    ? Math.max(0, (horaMin(diaExp.turno1.fim) - horaMin(diaExp.turno1.inicio)) / 60) : 0;
  const h2 = diaExp.turno2?.ativo && diaExp.turno2?.inicio && diaExp.turno2?.fim
    ? Math.max(0, (horaMin(diaExp.turno2.fim) - horaMin(diaExp.turno2.inicio)) / 60) : 0;
  // Modo OU: conta só o maior turno (estagiário que vem manhã OU tarde)
  if (diaExp.turno2?.ativo && diaExp.modo === "OU") return Math.round(Math.max(h1, h2) * 10) / 10;
  return Math.round((h1 + h2) * 10) / 10;
};

// Média de horas por dia útil (seg-sex com ativo=true)
const calcHorasDia = (expediente) => {
  if (!expediente) return 7;
  // Formato novo por dia da semana
  if (expediente.segunda !== undefined) {
    const diasUteis = ["segunda","terca","quarta","quinta","sexta"];
    const total = diasUteis.reduce((a, d) => a + calcHorasDiaSemana(expediente[d]), 0);
    const ativos = diasUteis.filter(d => expediente[d]?.ativo).length;
    return ativos > 0 ? Math.round((total / ativos) * 10) / 10 : 0;
  }
  // Formato turno1/turno2 (legado)
  if (expediente.turno1) {
    const h1 = expediente.turno1.inicio && expediente.turno1.fim
      ? Math.max(0, (horaMin(expediente.turno1.fim) - horaMin(expediente.turno1.inicio)) / 60) : 0;
    const h2 = expediente.turno2?.ativo && expediente.turno2.inicio && expediente.turno2.fim
      ? Math.max(0, (horaMin(expediente.turno2.fim) - horaMin(expediente.turno2.inicio)) / 60) : 0;
    if (expediente.turno2?.ativo && expediente.modo === "OU") return Math.max(h1, h2);
    return Math.round((h1 + h2) * 10) / 10;
  }
  // Formato legado simples
  if (expediente.inicio && expediente.fim) {
    const total = Math.max(0, (horaMin(expediente.fim) - horaMin(expediente.inicio)) / 60);
    return total > 6 ? total - 1 : total;
  }
  return 7;
};

// Horas previstas para um dia específico (data ISO)
const calcHorasDiaData = (expediente, dataISO) => {
  if (!expediente || !dataISO) return calcHorasDia(expediente);
  if (expediente.segunda !== undefined) {
    const dow = new Date(dataISO + "T12:00:00").getDay(); // 0=dom,1=seg...
    const nomeDia = DIAS_SEMANA[dow];
    return calcHorasDiaSemana(expediente[nomeDia]);
  }
  return calcHorasDia(expediente);
};

// Total horas semanais
const calcHorasSemanais = (expediente) => {
  if (!expediente) return 35;
  if (expediente.segunda !== undefined) {
    return ["segunda","terca","quarta","quinta","sexta","sabado"]
      .reduce((a, d) => a + calcHorasDiaSemana(expediente[d]), 0);
  }
  return calcHorasDia(expediente) * 5;
};

// Expediente padrão por dia da semana (7h/dia seg-sex)
const expedientePadrao = () => ({
  segunda: { ativo:true,  turno1:{inicio:"09:00",fim:"12:00"}, turno2:{ativo:true, inicio:"14:00",fim:"18:00"} },
  terca:   { ativo:true,  turno1:{inicio:"09:00",fim:"12:00"}, turno2:{ativo:true, inicio:"14:00",fim:"18:00"} },
  quarta:  { ativo:true,  turno1:{inicio:"09:00",fim:"12:00"}, turno2:{ativo:true, inicio:"14:00",fim:"18:00"} },
  quinta:  { ativo:true,  turno1:{inicio:"09:00",fim:"12:00"}, turno2:{ativo:true, inicio:"14:00",fim:"18:00"} },
  sexta:   { ativo:true,  turno1:{inicio:"09:00",fim:"12:00"}, turno2:{ativo:true, inicio:"14:00",fim:"18:00"} },
  sabado:  { ativo:false, turno1:{inicio:"09:00",fim:"12:00"}, turno2:{ativo:false,inicio:"14:00",fim:"18:00"} },
  domingo: { ativo:false, turno1:{inicio:"09:00",fim:"12:00"}, turno2:{ativo:false,inicio:"14:00",fim:"18:00"} },
});

// Verifica se uma hora está dentro do expediente do colaborador
// Retorna { eHoraExtra: bool, minutosExtras: number }
const verificarHoraExtra = (horaInicio, horaFim, expediente, dataISO) => {
  if (!horaInicio || !horaFim || !expediente) return { eHoraExtra: false, minutosExtras: 0 };
  const ini      = horaMin(horaInicio);
  const fim      = horaMin(horaFim);
  const durTotal = Math.max(0, fim - ini);

  // Pega turnos do dia correto
  let turnos = [];
  if (expediente.segunda !== undefined) {
    const dow    = dataISO ? new Date(dataISO+"T12:00:00").getDay() : new Date().getDay();
    const nomeDia = DIAS_SEMANA[dow];
    const diaExp  = expediente[nomeDia];
    if (diaExp?.ativo) {
      if (diaExp.turno1?.inicio && diaExp.turno1?.fim)
        turnos.push({ ini: horaMin(diaExp.turno1.inicio), fim: horaMin(diaExp.turno1.fim) });
      if (diaExp.turno2?.ativo && diaExp.turno2?.inicio && diaExp.turno2?.fim)
        turnos.push({ ini: horaMin(diaExp.turno2.inicio), fim: horaMin(diaExp.turno2.fim) });
    }
  } else {
    if (expediente.turno1?.inicio && expediente.turno1?.fim)
      turnos.push({ ini: horaMin(expediente.turno1.inicio), fim: horaMin(expediente.turno1.fim) });
    if (expediente.turno2?.ativo && expediente.turno2?.inicio && expediente.turno2?.fim)
      turnos.push({ ini: horaMin(expediente.turno2.inicio), fim: horaMin(expediente.turno2.fim) });
    if (turnos.length === 0 && expediente.inicio && expediente.fim)
      turnos.push({ ini: horaMin(expediente.inicio), fim: horaMin(expediente.fim) });
  }

  // Se não há expediente no dia (ex: sábado) tudo é hora extra
  if (turnos.length === 0) return { eHoraExtra: true, minutosExtras: durTotal };

  let minDentro = 0;
  for (const t of turnos) {
    const sobreposIni = Math.max(ini, t.ini);
    const sobreposFim = Math.min(fim, t.fim);
    if (sobreposFim > sobreposIni) minDentro += sobreposFim - sobreposIni;
  }
  const minutosExtras = Math.max(0, durTotal - minDentro);
  return { eHoraExtra: minutosExtras > 0, minutosExtras };
};

// Label resumido do expediente
const labelModoExpediente = (expediente) => {
  if (!expediente?.turno2?.ativo) return "";
  return expediente.modo === "OU" ? "Manhã OU Tarde (1 turno/dia)" : "Manhã E Tarde (2 turnos/dia)";
};

// Retorna hora de fim do expediente do dia atual
const fimExpediente = (expediente) => {
  if (!expediente) return "18:00";
  // Formato novo por dia da semana
  if (expediente.segunda !== undefined) {
    const dow = new Date().getDay();
    const nomeDia = DIAS_SEMANA[dow];
    const diaExp = expediente[nomeDia];
    if (!diaExp?.ativo) return "18:00";
    const f1 = diaExp.turno1?.fim || "18:00";
    const f2 = diaExp.turno2?.ativo ? (diaExp.turno2?.fim || "18:00") : "00:00";
    return diaExp.turno2?.ativo && f2 > f1 ? f2 : f1;
  }
  // Legado
  const f1 = expediente.turno1?.fim || expediente.fim || "18:00";
  const f2 = expediente.turno2?.ativo ? (expediente.turno2?.fim || "18:00") : "00:00";
  if (expediente.turno2?.ativo) return f2 > f1 ? f2 : f1;
  return f1;
};

// Formata expediente para exibição
const labelExpediente = (expediente) => {
  if (!expediente) return "—";
  if (expediente.turno1) {
    const t1 = `${expediente.turno1.inicio}–${expediente.turno1.fim}`;
    if (expediente.turno2?.ativo) {
      const sep = expediente.modo === "OU" ? " OU " : " E ";
      return `${t1}${sep}${expediente.turno2.inicio}–${expediente.turno2.fim}`;
    }
    return t1;
  }
  return `${expediente.inicio||"?"}–${expediente.fim||"?"}`;
};
const salvar     = (k,v) => { try { localStorage.setItem(k,JSON.stringify(v)); } catch{} };
const carregar   = (k,d) => { try { const s=localStorage.getItem(k); return s?JSON.parse(s):d; } catch { return d; } };

function parsePastaDrive(nome, driveUrl="") {
  const m = nome.match(/^(\d{2})\.([A-Z]{2})\.(\d{4})\s*[-–]\s*(.+)$/);
  if (!m) return null;
  const [,num,tipo,mmaa,resto] = m;
  const ano2 = mmaa.slice(2,4);
  const ano  = parseInt(ano2)>50 ? 1900+parseInt(ano2) : 2000+parseInt(ano2);
  const codigo = `${num}.${tipo}.${mmaa}`;
  return { id:codigo, codigo, cliente:resto.trim(), tipo, ano, status:"Novo/Definir",
    prazo:0, dataContrato:"", dataEntregaPrevista:"", obs:"Importado do Drive",
    temContrato:false, parcelas:[], responsavel:"", coresponsavel:"", driveUrl, _doDrive:true };
}

// ─── GOOGLE DRIVE HOOK ─────────────────────────────────────────────────────────
function useGoogleDrive() {
  const [gapiReady,setGapiReady]   = useState(false);
  const [gisReady,setGisReady]     = useState(false);
  const [logado,setLogado]         = useState(false);
  const [carregando,setCarregando] = useState(false);
  const [erro,setErro]             = useState(null);
  const [tokenClient,setTC]        = useState(null);

  useEffect(()=>{
    const loadGapi=()=>new Promise(res=>{
      if(window.gapi){res();return;}
      const s=document.createElement("script");s.src="https://apis.google.com/js/api.js";
      s.onload=()=>window.gapi.load("client",async()=>{
        await window.gapi.client.init({discoveryDocs:["https://www.googleapis.com/discovery/v1/apis/drive/v3/rest"]});
        setGapiReady(true);res();
      });document.head.appendChild(s);
    });
    const loadGis=()=>new Promise(res=>{
      if(window.google?.accounts){res();return;}
      const s=document.createElement("script");s.src="https://accounts.google.com/gsi/client";
      s.onload=()=>{setGisReady(true);res();};document.head.appendChild(s);
    });
    Promise.all([loadGapi(),loadGis()]).then(()=>{
      const tc=window.google.accounts.oauth2.initTokenClient({
        client_id:GOOGLE_CLIENT_ID,scope:SCOPES,
        callback:(r)=>{ if(r.error){setErro("Erro: "+r.error);return;} setLogado(true); },
      });
      setTC(tc);setGapiReady(true);setGisReady(true);
    });
  },[]);

  const login  = useCallback(()=>{ if(tokenClient) tokenClient.requestAccessToken({prompt:"consent"}); },[tokenClient]);
  const logout = useCallback(()=>{ const t=window.gapi?.client?.getToken(); if(t) window.google.accounts.oauth2.revoke(t.access_token); window.gapi?.client?.setToken(null); setLogado(false); },[]);

  const buscarProjetos = useCallback(async()=>{
    if(!logado) return [];
    setCarregando(true);setErro(null);
    try {
      const out=[];
      const rAnos=await window.gapi.client.drive.files.list({corpora:"drive",driveId:DRIVE_ROOT_ID,includeItemsFromAllDrives:true,supportsAllDrives:true,q:`'${DRIVE_ROOT_ID}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,fields:"files(id,name)",pageSize:20});
      for(const a of (rAnos.result.files||[])){
        const rP=await window.gapi.client.drive.files.list({corpora:"drive",driveId:DRIVE_ROOT_ID,includeItemsFromAllDrives:true,supportsAllDrives:true,q:`'${a.id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,fields:"files(id,name,webViewLink)",pageSize:200});
        for(const p of (rP.result.files||[])){ const x=parsePastaDrive(p.name,p.webViewLink||""); if(x) out.push(x); }
      }
      return out;
    } catch(e){ setErro("Erro: "+(e.result?.error?.message||e.message)); return []; }
    finally{ setCarregando(false); }
  },[logado]);

  return {gapiReady,gisReady,logado,carregando,erro,login,logout,buscarProjetos};
}

// ─── COMPONENTES BASE ──────────────────────────────────────────────────────────
const Badge=({status})=>{const s=statusN(status);const cfg=STATUS_CONFIG[s]||STATUS_CONFIG["Novo/Definir"];return <span style={{background:cfg.bg,color:cfg.cor,border:`1px solid ${cfg.cor}30`,padding:"2px 10px",borderRadius:20,fontSize:11,fontWeight:700,whiteSpace:"nowrap",display:"inline-flex",alignItems:"center",gap:4}}>{cfg.icone} {s}</span>;};
const TipoBadge=({tipo})=><span style={{background:C.azulEscuro,color:C.ciano,padding:"2px 8px",borderRadius:4,fontSize:10,fontWeight:800,letterSpacing:1}}>{tipo}</span>;
const Card=({children,style={}})=><div style={{background:C.branco,borderRadius:12,padding:20,boxShadow:"0 2px 12px rgba(26,58,107,0.08)",border:`1px solid ${C.cinzaCard}`,...style}}>{children}</div>;
const Btn=({children,onClick,variant="primary",small,style={},disabled})=>{
  const v={primary:{background:C.azulMedio,color:C.branco,border:"none"},secondary:{background:"transparent",color:C.azulMedio,border:`1.5px solid ${C.azulMedio}`},danger:{background:C.vermelho,color:C.branco,border:"none"},ghost:{background:"transparent",color:C.cinzaClaro,border:`1px solid ${C.cinzaCard}`},ciano:{background:C.ciano,color:C.azulEscuro,border:"none"},verde:{background:C.verde,color:C.branco,border:"none"}};
  return <button onClick={onClick} disabled={disabled} style={{...v[variant],borderRadius:8,padding:small?"5px 12px":"9px 20px",fontSize:small?12:14,fontWeight:600,cursor:disabled?"not-allowed":"pointer",opacity:disabled?0.5:1,transition:"all 0.15s",fontFamily:"inherit",display:"inline-flex",alignItems:"center",gap:6,...style}}>{children}</button>;
};
const Inp=({label,value,onChange,type="text",placeholder,required,readOnly,style={}})=>(
  <div style={{display:"flex",flexDirection:"column",gap:4}}>
    {label&&<label style={{fontSize:12,fontWeight:600,color:C.cinzaEscuro}}>{label}{required&&<span style={{color:C.vermelho}}> *</span>}</label>}
    <input type={type} value={value}
      onChange={e=>{ if(!readOnly && onChange) onChange(e.target.value); }}
      placeholder={placeholder}
      readOnly={readOnly}
      style={{border:`1.5px solid ${readOnly?C.cinzaCard:C.cinzaCard}`,borderRadius:8,padding:"8px 12px",fontSize:14,fontFamily:"inherit",color:readOnly?C.cinzaClaro:C.cinzaEscuro,outline:"none",background:readOnly?"#f8fafc":C.branco,width:"100%",boxSizing:"border-box",cursor:readOnly?"not-allowed":"text",...style}}/>
  </div>
);
const Sel=({label,value,onChange,options,required})=>(
  <div style={{display:"flex",flexDirection:"column",gap:4}}>
    {label&&<label style={{fontSize:12,fontWeight:600,color:C.cinzaEscuro}}>{label}{required&&<span style={{color:C.vermelho}}> *</span>}</label>}
    <select value={value} onChange={e=>onChange(e.target.value)} style={{border:`1.5px solid ${C.cinzaCard}`,borderRadius:8,padding:"8px 12px",fontSize:14,fontFamily:"inherit",color:C.cinzaEscuro,outline:"none",background:C.branco,width:"100%",boxSizing:"border-box"}}>
      {options.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  </div>
);
const Avatar=({u,size=36})=><div style={{width:size,height:size,borderRadius:"50%",background:u?.cor||C.azulMedio,display:"flex",alignItems:"center",justifyContent:"center",color:C.branco,fontWeight:800,fontSize:size*0.35,flexShrink:0}}>{u?.iniciais||"?"}</div>;

// ─── TELA DE LOGIN ─────────────────────────────────────────────────────────────
function TelaLogin({usuarios,onLogin}){
  const [etapa,setEtapa]=useState("sel");
  const [userSel,setUserSel]=useState(null);
  const [senha,setSenha]=useState("");
  const [erro,setErro]=useState("");

  return(
    <div style={{minHeight:"100vh",background:`linear-gradient(135deg,${C.azulEscuro},${C.azulMedio} 60%,${C.azulClaro})`,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
      <div style={{background:C.branco,borderRadius:20,padding:40,width:"100%",maxWidth:440,boxShadow:"0 24px 64px rgba(0,0,0,0.25)"}}>
        <div style={{textAlign:"center",marginBottom:32}}>
          <svg width="120" height="48" viewBox="0 0 220 80" style={{margin:"0 auto"}}>
            <circle cx="28" cy="14" r="7" fill="none" stroke={C.ciano} strokeWidth="3.5"/>
            <path d="M21 28 Q21 52 28 52 Q35 52 35 28" fill="none" stroke={C.azulEscuro} strokeWidth="5" strokeLinecap="round"/>
            <path d="M35 28 Q35 14 55 14 L80 52" fill="none" stroke={C.azulEscuro} strokeWidth="5" strokeLinecap="round"/>
            <path d="M80 14 L80 52" fill="none" stroke={C.azulEscuro} strokeWidth="5" strokeLinecap="round"/>
            <text x="95" y="45" fill={C.azulEscuro} fontSize="36" fontWeight="800" fontFamily="'Segoe UI',sans-serif" letterSpacing="2">NTEC</text>
          </svg>
          <p style={{color:C.cinzaClaro,fontSize:11,letterSpacing:3,fontWeight:700,marginTop:4}}>ENGENHARIA INTEGRADA</p>
        </div>

        {etapa==="sel"?(
          <>
            <h2 style={{color:C.cinzaEscuro,fontSize:18,fontWeight:700,margin:"0 0 6px",textAlign:"center"}}>Quem está acessando?</h2>
            <p style={{color:C.cinzaClaro,fontSize:13,margin:"0 0 24px",textAlign:"center"}}>Selecione seu perfil para continuar</p>
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              {usuarios.filter(u=>u.ativo).map(u=>(
                <div key={u.id} onClick={()=>{setUserSel(u);setEtapa("senha");setErro("");setSenha("");}}
                  style={{display:"flex",alignItems:"center",gap:14,padding:"14px 16px",borderRadius:12,border:`2px solid ${C.cinzaCard}`,cursor:"pointer",transition:"all 0.2s"}}
                  onMouseEnter={e=>{e.currentTarget.style.borderColor=C.azulMedio;e.currentTarget.style.background="#f0f6ff";}}
                  onMouseLeave={e=>{e.currentTarget.style.borderColor=C.cinzaCard;e.currentTarget.style.background=C.branco;}}>
                  <Avatar u={u} size={44}/>
                  <div style={{flex:1}}>
                    <div style={{fontWeight:700,color:C.cinzaEscuro,fontSize:15}}>{u.nome}</div>
                    <div style={{fontSize:11,color:C.cinzaClaro,marginTop:2,display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                      <span>{u.perfil==="admin"?"👑 Admin":u.perfil==="gestor"?"🔑 Gestor":"👤 Colaborador"}</span>
                      {(u.especialidades||[]).map(e=><span key={e} style={{background:C.azulEscuro,color:C.ciano,padding:"1px 5px",borderRadius:3,fontSize:9,fontWeight:800}}>{e}</span>)}
                    </div>
                  </div>
                  <span style={{color:C.cinzaClaro,fontSize:22}}>›</span>
                </div>
              ))}
            </div>
          </>
        ):(
          <>
            <button onClick={()=>{setEtapa("sel");setSenha("");setErro("");}} style={{background:"none",border:"none",color:C.azulMedio,cursor:"pointer",fontSize:13,fontWeight:600,marginBottom:20,display:"flex",alignItems:"center",gap:4}}>← Voltar</button>
            <div style={{display:"flex",alignItems:"center",gap:14,padding:"14px 16px",borderRadius:12,background:C.cinzaFundo,marginBottom:24}}>
              <Avatar u={userSel} size={48}/>
              <div>
                <div style={{fontWeight:700,color:C.cinzaEscuro,fontSize:16}}>{userSel?.nome}</div>
                <div style={{fontSize:12,color:C.cinzaClaro}}>{userSel?.email}</div>
              </div>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:16}}>
              <div style={{display:"flex",flexDirection:"column",gap:4}}>
                <label style={{fontSize:12,fontWeight:600,color:C.cinzaEscuro}}>Senha <span style={{color:C.vermelho}}>*</span></label>
                <input type="password" value={senha} onChange={e=>setSenha(e.target.value)}
                  placeholder="Digite sua senha"
                  autoFocus
                  onKeyDown={e=>{ if(e.key==="Enter"){ if(userSel.senha===senha) onLogin(userSel); else{setErro("Senha incorreta.");setSenha("");} } }}
                  style={{border:`1.5px solid ${C.cinzaCard}`,borderRadius:8,padding:"10px 12px",fontSize:14,fontFamily:"inherit",color:C.cinzaEscuro,outline:"none",background:C.branco,width:"100%",boxSizing:"border-box"}}/>
              </div>
              {erro&&<div style={{padding:"8px 12px",background:"#fef2f2",borderRadius:8,fontSize:13,color:C.vermelho,border:"1px solid #fecaca"}}>⚠ {erro}</div>}
              <Btn onClick={()=>{ if(userSel.senha===senha) onLogin(userSel); else {setErro("Senha incorreta.");setSenha("");} }} style={{width:"100%",justifyContent:"center"}}>Entrar no Sistema</Btn>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── MODAL CHECK-IN / AVISO ────────────────────────────────────────────────────
// Categorias de sessão administrativa
const CATS_ADMIN = [
  { id:"orcamento",    label:"Orçamento",           icone:"💰" },
  { id:"reuniao",      label:"Reunião",              icone:"🤝" },
  { id:"atendimento",  label:"Atendimento ao Cliente",icone:"📞" },
  { id:"financeiro",   label:"Financeiro/Adm",      icone:"📊" },
  { id:"capacitacao",  label:"Capacitação/Estudo",   icone:"📚" },
  { id:"visita",       label:"Visita Técnica",       icone:"🔍" },
  { id:"outros",       label:"Outros",               icone:"📝" },
];

function ModalHoras({tipo,projetos,usuarioAtual,sessaoAtiva,onIniciar,onEncerrar,onMudar,onFechar}){
  const [tipoSessao, setTipoSessao] = useState("projeto"); // "projeto" | "admin"
  const [projSel,   setProjSel]     = useState(sessaoAtiva?.projetoId||"");
  const [catSel,    setCatSel]      = useState("");
  const [hi,        setHi]          = useState(new Date().toTimeString().slice(0,5));
  const [hf,        setHf]          = useState(new Date().toTimeString().slice(0,5));
  const [obs,       setObs]         = useState("");
  const [filtroAno, setFAno]        = useState("todos");

  const ativos = projetos.filter(p=>!["CONCLUÍDO","CANCELADO"].includes(statusN(p.status)));
  const anos   = useMemo(()=>[...new Set(ativos.map(p=>p.ano))].filter(Boolean).sort((a,b)=>b-a),[ativos]);
  const ativosFiltrados = useMemo(()=>{
    const lista = filtroAno==="todos" ? ativos : ativos.filter(p=>Number(p.ano)===Number(filtroAno));
    return [...lista].sort((a,b)=>{
      const na=parseInt((a.codigo||"").split(".")[0])||0;
      const nb=parseInt((b.codigo||"").split(".")[0])||0;
      return na!==nb ? na-nb : (a.codigo||"").localeCompare(b.codigo||"","pt-BR");
    });
  },[ativos,filtroAno]);

  const opts=[{value:"",label:"Selecione o projeto..."},...ativosFiltrados.map(p=>({value:p.id,label:`${p.codigo} — ${p.cliente.substring(0,50)}`}))];

  // Botões de tipo de sessão
  const BotoesTipo = () => (
    <div style={{display:"flex",gap:8,marginBottom:4}}>
      {[
        {id:"projeto", label:"📁 Projetos",      sub:"Vincula a um projeto"},
        {id:"admin",   label:"⚙ Administrativa", sub:"Orçamentos, reuniões..."},
      ].map(t=>(
        <div key={t.id} onClick={()=>{setTipoSessao(t.id);setProjSel("");setCatSel("");}}
          style={{flex:1,padding:"10px 12px",borderRadius:10,border:`2px solid ${tipoSessao===t.id?C.azulMedio:C.cinzaCard}`,background:tipoSessao===t.id?C.azulEscuro:"white",cursor:"pointer",transition:"all 0.15s",textAlign:"center"}}>
          <div style={{fontSize:14,fontWeight:700,color:tipoSessao===t.id?C.branco:C.cinzaEscuro}}>{t.label}</div>
          <div style={{fontSize:11,color:tipoSessao===t.id?"rgba(255,255,255,0.7)":C.cinzaClaro,marginTop:2}}>{t.sub}</div>
        </div>
      ))}
    </div>
  );

  const wrap=(children,titulo,sub,gradFrom,gradTo)=>(
    <div style={{position:"fixed",inset:0,background:"rgba(15,25,50,0.8)",zIndex:2000,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
      <div style={{background:C.branco,borderRadius:20,width:"100%",maxWidth:500,maxHeight:"90vh",overflowY:"auto",boxShadow:"0 24px 64px rgba(0,0,0,0.3)"}}>
        <div style={{background:`linear-gradient(135deg,${gradFrom},${gradTo})`,padding:"20px 24px",borderRadius:"20px 20px 0 0"}}>
          <h2 style={{color:C.branco,margin:0,fontSize:18}}>{titulo}</h2>
          <p style={{color:"rgba(255,255,255,0.85)",margin:"4px 0 0",fontSize:13}}>{sub}</p>
        </div>
        <div style={{padding:24,display:"flex",flexDirection:"column",gap:14}}>{children}</div>
      </div>
    </div>
  );

  if(tipo==="checkin") return wrap(<>
    <BotoesTipo/>

    {tipoSessao==="projeto" ? (<>
      <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
        <label style={{fontSize:12,fontWeight:600,color:C.cinzaEscuro,whiteSpace:"nowrap"}}>Ano:</label>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {["todos",...anos].map(a=>(
            <button key={a} onClick={()=>{setFAno(a);setProjSel("");}}
              style={{padding:"3px 10px",borderRadius:20,border:`1.5px solid ${filtroAno==a?C.azulMedio:C.cinzaCard}`,background:filtroAno==a?C.azulMedio:"transparent",color:filtroAno==a?C.branco:C.cinzaClaro,fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit",transition:"all 0.15s"}}>
              {a==="todos"?"Todos":a}
            </button>
          ))}
        </div>
      </div>
      <Sel label={`Projeto * (${ativosFiltrados.length} disponíveis)`} value={projSel} onChange={setProjSel} options={opts}/>
    </>) : (<>
      <div>
        <label style={{fontSize:12,fontWeight:600,color:C.cinzaEscuro,display:"block",marginBottom:8}}>Categoria *</label>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
          {CATS_ADMIN.map(c=>(
            <div key={c.id} onClick={()=>setCatSel(c.id)}
              style={{padding:"10px 12px",borderRadius:8,border:`2px solid ${catSel===c.id?C.azulMedio:C.cinzaCard}`,background:catSel===c.id?"#eff6ff":"white",cursor:"pointer",display:"flex",alignItems:"center",gap:8,transition:"all 0.15s"}}>
              <span style={{fontSize:18}}>{c.icone}</span>
              <span style={{fontSize:12,fontWeight:600,color:catSel===c.id?C.azulMedio:C.cinzaEscuro}}>{c.label}</span>
            </div>
          ))}
        </div>
      </div>
    </>)}

    <Inp label="Hora de início" type="time" value={hi} onChange={setHi}/>
    <Inp label="O que você vai fazer? *" value={obs} onChange={setObs}
      placeholder={tipoSessao==="projeto"?"Ex: Modelagem estrutural no Eberick...":"Ex: Orçamento para cliente X..."} required/>
    {!obs.trim()&&<span style={{fontSize:11,color:C.vermelho,fontSize:11}}>⚠ Descrição obrigatória</span>}
    <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}>
      <Btn variant="ghost" onClick={onFechar}>Agora não</Btn>
      <Btn onClick={()=>onIniciar(tipoSessao==="projeto"?projSel:null, hi, obs, tipoSessao==="admin"?catSel:null)}
        disabled={tipoSessao==="projeto"?(!projSel||!obs.trim()):(!catSel||!obs.trim())}>▶ Iniciar</Btn>
    </div>
  </>, "⏱ Iniciar Sessão de Trabalho", `Olá, ${usuarioAtual.nome}! O que você vai fazer?`, C.azulEscuro, C.azulMedio);

  if(tipo==="aviso") return wrap(<>
    {sessaoAtiva&&<div style={{padding:"12px 16px",background:C.cinzaFundo,borderRadius:10,fontSize:13}}>
      <div style={{fontWeight:700,color:C.cinzaEscuro}}>
        {sessaoAtiva.categoriaAdmin
          ? `⚙ ${CATS_ADMIN.find(c=>c.id===sessaoAtiva.categoriaAdmin)?.label||"Administrativa"}`
          : "📁 Projeto:"}
      </div>
      <div style={{color:C.azulMedio,marginTop:4}}>
        {sessaoAtiva.categoriaAdmin
          ? (sessaoAtiva.obs||"—")
          : projetos.find(p=>p.id===sessaoAtiva.projetoId)?.cliente||"—"}
      </div>
      <div style={{color:C.cinzaClaro,fontSize:11,marginTop:2}}>Iniciado às {sessaoAtiva.horaInicio}</div>
    </div>}
    <Btn onClick={()=>onFechar("continuar")} style={{justifyContent:"center"}}>✅ Sim, ainda estou trabalhando</Btn>
    <div style={{fontSize:12,fontWeight:600,color:C.cinzaEscuro}}>Mudei para outro projeto:</div>
    <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
      <label style={{fontSize:11,color:C.cinzaClaro}}>Ano:</label>
      {["todos",...anos].map(a=>(
        <button key={a} onClick={()=>{setFAno(a);setProjSel("");}}
          style={{padding:"3px 8px",borderRadius:20,border:`1.5px solid ${filtroAno==a?C.azulMedio:C.cinzaCard}`,background:filtroAno==a?C.azulMedio:"transparent",color:filtroAno==a?C.branco:C.cinzaClaro,fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>
          {a==="todos"?"Todos":a}
        </button>
      ))}
    </div>
    <Sel label="" value={projSel} onChange={setProjSel} options={opts}/>
    {projSel&&projSel!==sessaoAtiva?.projetoId&&<Btn variant="secondary" onClick={()=>onMudar(projSel)} style={{justifyContent:"center"}}>🔄 Mudar para este projeto</Btn>}
    <Btn variant="danger" onClick={()=>onFechar("encerrar")} style={{justifyContent:"center"}}>⏹ Parei de trabalhar</Btn>
  </>, "⏰ Verificação de Atividade", "Já faz 30 minutos — você ainda está trabalhando?", C.amarelo, C.laranja);

  if(tipo==="encerramento") {
    const horaMaxima = new Date().toTimeString().slice(0,5);
    const horaValida = hf <= horaMaxima;
    return wrap(<>
      <div style={{display:"flex",flexDirection:"column",gap:4}}>
        <label style={{fontSize:12,fontWeight:600,color:C.cinzaEscuro}}>Hora de saída <span style={{color:C.cinzaClaro,fontWeight:400}}>(máx: {horaMaxima})</span></label>
        <input type="time" value={hf} max={horaMaxima}
          onChange={e=>{ if(e.target.value<=horaMaxima) setHf(e.target.value); else setHf(horaMaxima); }}
          style={{border:`1.5px solid ${horaValida?C.cinzaCard:C.vermelho}`,borderRadius:8,padding:"8px 12px",fontSize:14,fontFamily:"inherit",color:C.cinzaEscuro,outline:"none",background:C.branco,width:"100%",boxSizing:"border-box"}}/>
        {!horaValida&&<span style={{fontSize:11,color:C.vermelho}}>⚠ Hora não pode ser maior que {horaMaxima}</span>}
      </div>
      {/* Mostra o que foi dito ao iniciar (somente leitura) */}
    {sessaoAtiva?.obsInicio&&(
      <div style={{padding:"8px 12px",background:C.cinzaFundo,borderRadius:8,border:`1px solid ${C.cinzaCard}`}}>
        <div style={{fontSize:10,fontWeight:700,color:C.cinzaClaro,marginBottom:2}}>O QUE ESTAVA FAZENDO</div>
        <div style={{fontSize:13,color:C.cinzaEscuro}}>{sessaoAtiva.obsInicio}</div>
      </div>
    )}
    <Inp label="Feedback / Como foi? (opcional)" value={obs} onChange={setObs}
      placeholder="Ex: Modelagem concluída, falta lançar fundações..."/>
      <div style={{display:"flex",gap:8,justifyContent:"space-between",flexWrap:"wrap"}}>
        <Btn variant="secondary" small onClick={()=>onFechar("continuar_extra")}
          title="Encerra a sessão atual e inicia nova como hora extra">
          ⏰ Continuar em hora extra
        </Btn>
        <div style={{display:"flex",gap:8}}>
          <Btn variant="ghost" onClick={onFechar}>Cancelar</Btn>
          <Btn variant="verde" onClick={()=>onEncerrar(hf,obs)} disabled={!horaValida}>✔ Encerrar</Btn>
        </div>
      </div>
    </>, "🏁 Encerrar Expediente", "Registre o horário de saída para finalizar o dia", C.azulEscuro, C.azulMedio);
  }
  return null;
}

// ─── BANCO DE HORAS ────────────────────────────────────────────────────────────

// ─── GERADOR DE PDF (jsPDF via CDN) ──────────────────────────────────────────
function carregarJsPDF() {
  return new Promise((resolve) => {
    if (window.jspdf) { resolve(window.jspdf.jsPDF); return; }
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
    s.onload = () => resolve(window.jspdf.jsPDF);
    document.head.appendChild(s);
  });
}

function carregarAutoTable() {
  return new Promise((resolve) => {
    if (window.jspdf?.jsPDF?.API?.autoTable) { resolve(); return; }
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js';
    s.onload = () => resolve();
    document.head.appendChild(s);
  });
}

async function gerarRelatorioPDF({ usuario, registrosFiltrados, projetos, mes, salario }) {
  const JsPDF = await carregarJsPDF();
  await carregarAutoTable();

  const doc = new JsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const W = 210; const M = 15;
  const fmtD = d => { if(!d) return '—'; const [y,m,dd] = d.split('-'); return `${dd}/${m}/${y}`; };
  const fmtDur = mins => { if(!mins) return '0h 0min'; return `${Math.floor(mins/60)}h ${mins%60}min`; };
  const fmtR = v => new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(v||0);
  const nomeMes = (ym) => {
    if (!ym) return '';
    const [y, m] = ym.split('-');
    const nomes = ['','Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    return `${nomes[parseInt(m)]} ${y}`;
  };

  // ── Cabeçalho ──
  doc.setFillColor(26, 58, 107);
  doc.rect(0, 0, W, 40, 'F');
  doc.setFillColor(43, 99, 168);
  doc.rect(0, 30, W, 10, 'F');

  // Logo texto
  doc.setTextColor(86, 191, 233);
  doc.setFontSize(22);
  doc.setFont('helvetica', 'bold');
  doc.text('iNTEC', M, 20);
  doc.setFontSize(7);
  doc.setFont('helvetica', 'normal');
  doc.text('ENGENHARIA INTEGRADA', M, 26);

  // Título
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.text('RELATORIO DE PRODUTIVIDADE', W/2, 36, { align: 'center' });

  // Info colaborador
  doc.setFillColor(240, 244, 248);
  doc.rect(M, 45, W - M*2, 28, 'F');
  doc.setDrawColor(200, 210, 225);
  doc.rect(M, 45, W - M*2, 28, 'S');

  doc.setTextColor(30, 37, 53);
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text(usuario.nome, M+6, 55);

  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(132, 146, 166);
  doc.text(usuario.email || '', M+6, 61);
  doc.text(`Perfil: ${usuario.perfil === 'admin' ? 'Admin' : usuario.perfil === 'gestor' ? 'Gestor' : 'Colaborador'}`, M+6, 67);

  // Período
  doc.setTextColor(37, 99, 168);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.text(`Periodo: ${nomeMes(mes) || 'Todos os meses'}`, W - M, 55, { align: 'right' });
  doc.text(`Gerado em: ${new Date().toLocaleDateString('pt-BR')}`, W - M, 62, { align: 'right' });

  // ── Totais ──
  const totalMin = registrosFiltrados.reduce((a,r) => a + (r.duracaoMin||0), 0);
  const totalH = Math.floor(totalMin/60);
  const totalM = totalMin%60;
  const totalSessoes = registrosFiltrados.length;
  const projsUnicos = new Set(registrosFiltrados.map(r=>r.projetoId).filter(Boolean)).size;
  const custoHora = salario > 0 ? salario / (totalH || 1) : 0;
  const diasUteis = 22;
  const horesPrevistas = diasUteis * 8 * 60;
  const eficiencia = horesPrevistas > 0 ? Math.min(100, Math.round((totalMin / horesPrevistas) * 100)) : 0;

  const cards = [
    { label: 'Horas Trabalhadas', valor: `${totalH}h ${totalM}min`, cor: [37,99,168] },
    { label: 'Sessoes Registradas', valor: String(totalSessoes), cor: [34,197,94] },
    { label: 'Projetos Atendidos', valor: String(projsUnicos), cor: [86,191,233] },
    { label: 'Eficiencia do Mes', valor: `${eficiencia}%`, cor: salario>0?[245,158,11]:[132,146,166] },
  ];

  const cardW = (W - M*2 - 9) / 4;
  let cx = M;
  doc.setFontSize(9);
  cards.forEach(card => {
    doc.setFillColor(...card.cor);
    doc.rect(cx, 78, cardW, 22, 'F');
    doc.setTextColor(255,255,255);
    doc.setFont('helvetica','bold');
    doc.setFontSize(14);
    doc.text(card.valor, cx + cardW/2, 90, { align: 'center' });
    doc.setFontSize(7);
    doc.setFont('helvetica','normal');
    doc.text(card.label, cx + cardW/2, 96, { align: 'center' });
    cx += cardW + 3;
  });

  // Custo (se tiver salário)
  let yPos = 108;
  if (salario > 0) {
    doc.setFillColor(255, 251, 235);
    doc.setDrawColor(253, 230, 138);
    doc.rect(M, yPos, W - M*2, 14, 'FD');
    doc.setTextColor(146, 64, 14);
    doc.setFont('helvetica','bold');
    doc.setFontSize(10);
    doc.text(`Salario Mensal: ${fmtR(salario)}`, M+6, yPos+6);
    doc.text(`Custo por Hora Trabalhada: ${fmtR(custoHora)}`, M+6, yPos+11);
    doc.setTextColor(30,37,53);
    yPos += 18;
  }

  // ── Tabela por projeto ──
  const porProjeto = {};
  registrosFiltrados.forEach(r => {
    if (!r.projetoId) return;
    if (!porProjeto[r.projetoId]) porProjeto[r.projetoId] = { totalMin:0, sessoes:0 };
    porProjeto[r.projetoId].totalMin += r.duracaoMin||0;
    porProjeto[r.projetoId].sessoes++;
  });

  const linhasProjeto = Object.entries(porProjeto)
    .sort((a,b) => b[1].totalMin - a[1].totalMin)
    .map(([pid, d]) => {
      const proj = projetos.find(p => p.id === pid);
      const custoProj = salario > 0 && totalMin > 0 ? (d.totalMin / totalMin) * salario : 0;
      const pct = totalMin > 0 ? ((d.totalMin/totalMin)*100).toFixed(1) : '0.0';
      return [
        proj?.codigo || pid,
        (proj?.cliente || '—').substring(0, 38),
        fmtDur(d.totalMin),
        `${pct}%`,
        d.sessoes,
        salario > 0 ? fmtR(custoProj) : '—',
      ];
    });

  doc.setFont('helvetica','bold');
  doc.setFontSize(10);
  doc.setTextColor(26,58,107);
  doc.text('Horas por Projeto', M, yPos);
  yPos += 4;

  doc.autoTable({
    startY: yPos,
    head: [['Codigo','Projeto','Horas','% do Total','Sessoes', salario>0?'Custo Proporcional':'']],
    body: linhasProjeto,
    theme: 'grid',
    headStyles: { fillColor:[26,58,107], textColor:255, fontStyle:'bold', fontSize:8 },
    bodyStyles: { fontSize:8, textColor:[30,37,53] },
    alternateRowStyles: { fillColor:[240,244,248] },
    columnStyles: {
      0: { cellWidth:22, fontStyle:'bold', textColor:[37,99,168] },
      1: { cellWidth:60 },
      2: { cellWidth:22, halign:'center' },
      3: { cellWidth:20, halign:'center' },
      4: { cellWidth:16, halign:'center' },
      5: { cellWidth:30, halign:'right' },
    },
    margin: { left: M, right: M },
  });

  // ── Histórico de sessões ──
  const yAposTabela = doc.lastAutoTable.finalY + 8;
  doc.setFont('helvetica','bold');
  doc.setFontSize(10);
  doc.setTextColor(26,58,107);
  doc.text('Historico de Sessoes', M, yAposTabela);

  const linhasSessoes = [...registrosFiltrados]
    .sort((a,b) => (b.inicioTs||0)-(a.inicioTs||0))
    .map(r => {
      const proj = projetos.find(p => p.id === r.projetoId);
      return [
        r.data ? fmtD(r.data) : '—',
        proj?.codigo || '—',
        (proj?.cliente||'—').substring(0,30),
        r.horaInicio || '—',
        r.horaFim || 'Aberta',
        fmtDur(r.duracaoMin),
        (r.obs||'').substring(0,25),
      ];
    });

  doc.autoTable({
    startY: yAposTabela + 4,
    head: [['Data','Codigo','Projeto','Entrada','Saida','Duracao','Obs']],
    body: linhasSessoes.length > 0 ? linhasSessoes : [['Nenhum registro','','','','','','']],
    theme: 'striped',
    headStyles: { fillColor:[43,99,168], textColor:255, fontStyle:'bold', fontSize:7.5 },
    bodyStyles: { fontSize:7.5, textColor:[30,37,53] },
    alternateRowStyles: { fillColor:[248,250,252] },
    columnStyles: {
      0: { cellWidth:20 },
      1: { cellWidth:20, fontStyle:'bold', textColor:[37,99,168] },
      2: { cellWidth:48 },
      3: { cellWidth:16, halign:'center' },
      4: { cellWidth:16, halign:'center' },
      5: { cellWidth:22, halign:'center', fontStyle:'bold' },
      6: { cellWidth:35 },
    },
    margin: { left: M, right: M },
  });

  // ── Rodapé ──
  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFillColor(26,58,107);
    doc.rect(0, 287, W, 10, 'F');
    doc.setTextColor(86,191,233);
    doc.setFontSize(7);
    doc.setFont('helvetica','normal');
    doc.text('INTEC Engenharia Integrada — Sistema de Controle de Projetos', M, 293);
    doc.text(`Pagina ${i} de ${pageCount}`, W - M, 293, { align:'right' });
  }

  const nomeArq = `relatorio_${usuario.nome.toLowerCase().replace(/\s+/g,'_')}_${mes||'geral'}.pdf`;
  doc.save(nomeArq);
}

// ─── PRODUTIVIDADE ────────────────────────────────────────────────────────────

// ─── ABA HORAS & PRODUTIVIDADE ────────────────────────────────────────────────
function AbaHoras({ registros, setRegistros, usuarios, projetos, usuarioAtual, calendario, onAbrirEncerramento }) {
  const [subAba, setSubAba] = useState("horas");
  return (
    <div>
      <div style={{display:"flex",gap:0,marginBottom:24,borderBottom:`2px solid ${C.cinzaCard}`}}>
        {[{id:"horas",label:"⏱ Banco de Horas"},{id:"produtividade",label:"📈 Produtividade"}].map(t=>(
          <button key={t.id} onClick={()=>setSubAba(t.id)}
            style={{background:"none",border:"none",padding:"12px 20px",cursor:"pointer",fontSize:14,
              fontFamily:"inherit",fontWeight:subAba===t.id?700:500,
              color:subAba===t.id?C.azulMedio:C.cinzaClaro,
              borderBottom:subAba===t.id?`2px solid ${C.azulMedio}`:"2px solid transparent",
              marginBottom:-2,transition:"all 0.15s"}}>
            {t.label}
          </button>
        ))}
      </div>
      {subAba==="horas"        &&<BancoHoras registros={registros} setRegistros={setRegistros} usuarios={usuarios} projetos={projetos} usuarioAtual={usuarioAtual} onAbrirEncerramento={onAbrirEncerramento}/>}
      {subAba==="produtividade"&&<Produtividade registros={registros} usuarios={usuarios} projetos={projetos} usuarioAtual={usuarioAtual} calendario={calendario}/>}
    </div>
  );
}

// ─── ABA AGENDA & ESCALAS ─────────────────────────────────────────────────────
function AbaAgenda({ calendario, usuarioAtual, registros, usuarios }) {
  const [subAba, setSubAba] = useState("calendario");
  return (
    <div>
      <div style={{display:"flex",gap:0,marginBottom:24,borderBottom:`2px solid ${C.cinzaCard}`}}>
        {[{id:"calendario",label:"📅 Calendário"},{id:"escalas",label:"📋 Escalas"}].map(t=>(
          <button key={t.id} onClick={()=>setSubAba(t.id)}
            style={{background:"none",border:"none",padding:"12px 20px",cursor:"pointer",fontSize:14,
              fontFamily:"inherit",fontWeight:subAba===t.id?700:500,
              color:subAba===t.id?C.azulMedio:C.cinzaClaro,
              borderBottom:subAba===t.id?`2px solid ${C.azulMedio}`:"2px solid transparent",
              marginBottom:-2,transition:"all 0.15s"}}>
            {t.label}
          </button>
        ))}
      </div>
      {subAba==="calendario"&&<ModuloCalendario calendario={calendario} usuarioAtual={usuarioAtual} registros={registros} usuarios={usuarios}/>}
      {subAba==="escalas"   &&<Escalas usuarioAtual={usuarioAtual} usuarios={usuarios}/>}
    </div>
  );
}

function Produtividade({ registros, usuarios, projetos, usuarioAtual, calendario }) {
  const [filtroUser, setFU] = useState(
    usuarioAtual.perfil === 'colaborador' ? usuarioAtual.id : 'todos'
  );
  const [filtroMes, setFM] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
  });
  const [gerando, setGerando] = useState(false);
  const isGestor = ['admin','gestor'].includes(usuarioAtual.perfil);

  const fmt$ = v => new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(v||0);

  const meses = useMemo(() => {
    const s = new Set();
    registros.forEach(r => { if(r.data) s.add(r.data.slice(0,7)); });
    return [...s].sort((a,b) => b.localeCompare(a));
  }, [registros]);

  const nomesMeses = {
    '01':'Janeiro','02':'Fevereiro','03':'Marco','04':'Abril','05':'Maio','06':'Junho',
    '07':'Julho','08':'Agosto','09':'Setembro','10':'Outubro','11':'Novembro','12':'Dezembro'
  };
  const labelMes = (ym) => {
    if (!ym || ym === 'todos') return 'Todos';
    const [y,m] = ym.split('-');
    return `${nomesMeses[m]||m} ${y}`;
  };

  // Horas previstas usando calendario real ou fallback seguro
  const getHoresPrev = useCallback((ym, usuario) => {
    try {
      const hdDia = usuario?.expediente ? calcHorasDia(usuario.expediente) : 7;
      if (!ym || ym === 'todos') return Math.round(22 * hdDia);
      const [ano, mes] = ym.split('-').map(Number);
      if (calendario && typeof calendario.horasPrevistasMes === 'function') {
        const h = calendario.horasPrevistasMes(ano, mes, hdDia);
        return h > 0 ? h : Math.round(22 * hdDia);
      }
    } catch(e) {}
    return 154;
  }, [calendario]);

  const usuariosParaExibir = useMemo(() => {
    if (!isGestor) return usuarios.filter(u => u.id === usuarioAtual.id);
    if (filtroUser !== 'todos') return usuarios.filter(u => u.id === filtroUser);
    return usuarios.filter(u => u.ativo);
  }, [usuarios, filtroUser, usuarioAtual, isGestor]);

  const dadosUsuario = useMemo(() => {
    return usuariosParaExibir.map(u => {
      const regs = registros.filter(r => {
        if (r.usuarioId !== u.id) return false;
        if (filtroMes !== 'todos' && !r.data?.startsWith(filtroMes)) return false;
        return true;
      });
      const totalMin    = regs.reduce((a,r) => a + (r.duracaoMin||0), 0);
      const totalH      = Math.floor(totalMin/60);
      const totalM      = totalMin%60;
      const projsUnicos = new Set(regs.map(r=>r.projetoId).filter(Boolean));
      // hPrevH calculado individualmente por colaborador com base no expediente dele
      const hPrevH      = getHoresPrev(filtroMes, u);
      const hPrevMin    = hPrevH * 60;
      const eficiencia  = hPrevMin > 0 ? Math.min(100, Math.round((totalMin/hPrevMin)*100)) : 0;
      const salario     = u.salario || 0;
      const custoHora   = totalMin > 0 && salario > 0 ? salario / (totalMin/60) : 0;
      const porProjeto  = {};
      regs.forEach(r => {
        if (!r.projetoId) return;
        if (!porProjeto[r.projetoId]) porProjeto[r.projetoId] = { totalMin:0, sessoes:0 };
        porProjeto[r.projetoId].totalMin += r.duracaoMin||0;
        porProjeto[r.projetoId].sessoes++;
      });
      return { usuario:u, regs, totalMin, totalH, totalM, projsUnicos,
               eficiencia, salario, custoHora, porProjeto, hPrevH };
    });
  }, [usuariosParaExibir, registros, filtroMes, getHoresPrev]);

  const gerarPDF = async (dado) => {
    setGerando(true);
    try {
      await gerarRelatorioPDF({
        usuario: dado.usuario,
        registrosFiltrados: dado.regs,
        projetos,
        mes: filtroMes !== 'todos' ? filtroMes : null,
        salario: dado.salario,
      });
    } finally { setGerando(false); }
  };

  return (
    <div style={{display:'flex',flexDirection:'column',gap:20}}>
      {/* Filtros */}
      <Card style={{padding:16}}>
        <div style={{display:'flex',gap:10,flexWrap:'wrap',alignItems:'center'}}>
          <div style={{flex:1}}>
            <h2 style={{color:C.azulEscuro,margin:0,fontSize:16,fontWeight:700}}>📈 Produtividade & Custos</h2>
            <p style={{color:C.cinzaClaro,fontSize:12,margin:'4px 0 0'}}>Controle de horas, eficiencia e custo de mao de obra</p>
          </div>
          {isGestor && (
            <select value={filtroUser} onChange={e=>setFU(e.target.value)}
              style={{border:`1.5px solid ${C.cinzaCard}`,borderRadius:8,padding:'8px 12px',fontSize:13,fontFamily:'inherit',cursor:'pointer'}}>
              <option value="todos">👥 Todos os colaboradores</option>
              {usuarios.filter(u=>u.ativo).map(u=><option key={u.id} value={u.id}>{u.nome}</option>)}
            </select>
          )}
          <select value={filtroMes} onChange={e=>setFM(e.target.value)}
            style={{border:`1.5px solid ${C.cinzaCard}`,borderRadius:8,padding:'8px 12px',fontSize:13,fontFamily:'inherit',cursor:'pointer'}}>
            <option value="todos">📅 Todos os meses</option>
            {meses.map(m=><option key={m} value={m}>{labelMes(m)}</option>)}
          </select>
        </div>
      </Card>

      {dadosUsuario.length === 0 && (
        <Card><p style={{textAlign:'center',color:C.cinzaClaro,padding:20}}>Nenhum dado encontrado.</p></Card>
      )}

      {dadosUsuario.map(d => {
        const hPrevH = d.hPrevH;
        return (
          <div key={d.usuario.id} style={{display:'flex',flexDirection:'column',gap:16}}>
            {/* Header colaborador */}
            <Card style={{background:`linear-gradient(135deg,${C.azulEscuro},${C.azulMedio})`,border:'none',padding:20}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:12}}>
                <div style={{display:'flex',alignItems:'center',gap:14}}>
                  <Avatar u={d.usuario} size={52}/>
                  <div>
                    <h3 style={{color:C.branco,margin:0,fontSize:18,fontWeight:800}}>{d.usuario.nome}</h3>
                    <p style={{color:C.ciano,margin:'3px 0 0',fontSize:12}}>{d.usuario.email}</p>
                    <p style={{color:'rgba(255,255,255,0.6)',margin:'2px 0 0',fontSize:11}}>
                      {d.usuario.perfil==='admin'?'👑 Admin':d.usuario.perfil==='gestor'?'🔑 Gestor':'👤 Colaborador'} • {labelMes(filtroMes)}
                    </p>
                  </div>
                </div>
                <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
                  {d.salario > 0 && (
                    <div style={{background:'rgba(255,255,255,0.1)',border:'1px solid rgba(255,255,255,0.2)',borderRadius:10,padding:'8px 14px',textAlign:'center'}}>
                      <div style={{color:C.ciano,fontSize:10,fontWeight:700}}>CUSTO/HORA</div>
                      <div style={{color:C.branco,fontSize:16,fontWeight:800}}>{fmt$(d.custoHora)}</div>
                    </div>
                  )}
                  <Btn onClick={()=>gerarPDF(d)} disabled={gerando}
                    style={{background:'rgba(86,191,233,0.2)',color:C.ciano,border:'1px solid rgba(86,191,233,0.4)'}}>
                    {gerando?'⏳ Gerando...':'📄 Exportar PDF'}
                  </Btn>
                </div>
              </div>
            </Card>

            {/* KPIs */}
            <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(150px,1fr))',gap:12}}>
              {[
                {label:'Horas Trabalhadas', valor:`${d.totalH}h ${d.totalM}min`, cor:C.azulMedio, icone:'⏱'},
                {label:'Sessoes', valor:String(d.regs.length), cor:C.azulClaro, icone:'🖥'},
                {label:'Projetos', valor:String(d.projsUnicos.size), cor:C.ciano, icone:'📂'},
                {label:'Eficiencia', valor:`${d.eficiencia}%`,
                  cor:d.eficiencia>=80?C.verde:d.eficiencia>=50?C.amarelo:C.vermelho, icone:'📊'},
                ...(d.salario>0 ? [{label:'Salario Mensal', valor:fmt$(d.salario), cor:C.verde, icone:'💵'}] : []),
              ].map(k=>(
                <Card key={k.label} style={{textAlign:'center',borderTop:`3px solid ${k.cor}`,padding:14}}>
                  <div style={{fontSize:22}}>{k.icone}</div>
                  <div style={{fontSize:k.label==='Salario Mensal'?13:20,fontWeight:800,color:k.cor,lineHeight:1.2,marginTop:4}}>{k.valor}</div>
                  <div style={{fontSize:11,color:C.cinzaClaro,marginTop:4,fontWeight:600}}>{k.label}</div>
                </Card>
              ))}
            </div>

            {/* Barra eficiência */}
            <Card style={{padding:16}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
                <span style={{fontSize:13,fontWeight:700,color:C.cinzaEscuro}}>
                  Eficiencia do mes (meta: {hPrevH}h / {Math.round(hPrevH/7)} dias uteis)
                </span>
                <span style={{fontSize:14,fontWeight:800,
                  color:d.eficiencia>=80?C.verde:d.eficiencia>=50?C.amarelo:C.vermelho}}>
                  {d.eficiencia}%
                </span>
              </div>
              <div style={{background:C.cinzaFundo,borderRadius:8,height:12}}>
                <div style={{background:d.eficiencia>=80?C.verde:d.eficiencia>=50?C.amarelo:C.vermelho,
                  height:12,borderRadius:8,width:`${d.eficiencia}%`,transition:'width 0.5s'}}/>
              </div>
              <div style={{display:'flex',justifyContent:'space-between',fontSize:11,color:C.cinzaClaro,marginTop:6}}>
                <span>0h</span>
                <span style={{color:C.amarelo}}>{Math.round(hPrevH*0.5)}h (50%)</span>
                <span style={{color:C.verde}}>{Math.round(hPrevH*0.8)}h (80%)</span>
                <span>{hPrevH}h (100%)</span>
              </div>
            </Card>

            {/* Horas por projeto */}
            {Object.keys(d.porProjeto).length > 0 && (
              <Card>
                <h3 style={{color:C.azulEscuro,margin:'0 0 16px',fontSize:14,fontWeight:700}}>⏱ Distribuicao de Horas por Projeto</h3>
                <div style={{display:'flex',flexDirection:'column',gap:10}}>
                  {Object.entries(d.porProjeto).sort((a,b)=>b[1].totalMin-a[1].totalMin).map(([pid,pd])=>{
                    const proj = projetos.find(p=>p.id===pid);
                    const pct  = d.totalMin>0 ? (pd.totalMin/d.totalMin)*100 : 0;
                    const custoProj = d.salario>0 && d.totalMin>0 ? (pd.totalMin/d.totalMin)*d.salario : 0;
                    return (
                      <div key={pid} style={{padding:'10px 14px',background:C.cinzaFundo,borderRadius:10}}>
                        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6,flexWrap:'wrap',gap:8}}>
                          <div>
                            <span style={{fontSize:12,fontWeight:800,color:C.azulMedio}}>{proj?.codigo||pid}</span>
                            <span style={{fontSize:11,color:C.cinzaClaro,marginLeft:8}}>{proj?.cliente?.substring(0,45)||'—'}</span>
                          </div>
                          <div style={{display:'flex',gap:12,alignItems:'center'}}>
                            {d.salario>0 && <span style={{fontSize:11,fontWeight:700,color:C.amarelo}}>{fmt$(custoProj)}</span>}
                            <span style={{fontSize:12,fontWeight:700,color:C.azulEscuro}}>{Math.floor(pd.totalMin/60)}h {pd.totalMin%60}min</span>
                            <span style={{fontSize:11,color:C.cinzaClaro}}>{pd.sessoes} sessao(oes)</span>
                            <span style={{fontSize:11,fontWeight:700,
                              color:pct>30?C.vermelho:pct>15?C.amarelo:C.verde}}>{pct.toFixed(1)}%</span>
                          </div>
                        </div>
                        <div style={{background:C.cinzaCard,borderRadius:6,height:8}}>
                          <div style={{background:C.azulClaro,height:8,borderRadius:6,width:`${pct}%`,transition:'width 0.4s'}}/>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>
            )}

            {d.regs.length === 0 && (
              <Card><p style={{textAlign:'center',color:C.cinzaClaro,padding:16}}>Nenhuma sessao registrada neste periodo.</p></Card>
            )}
          </div>
        );
      })}
    </div>
  );
}


// ─── FERIADOS GOV. VALADARES (municipais fixos) ───────────────────────────────
const FERIADOS_GV_MUNICIPAIS = {
  "01-01": "Ano Novo",
  "04-08": "Aniversario de Gov. Valadares",
  "11-02": "Criacao do Municipio de Gov. Valadares",
};

const FERIADOS_MG_ESTADUAIS = {
  "04-21": "Tiradentes (Estadual MG)",
  "07-09": "Revolução Constitucionalista MG",
};

// ─── HOOK DE CALENDÁRIO ───────────────────────────────────────────────────────
function useCalendario() {
  const [feriados,    setFeriados]    = useState({});   // "YYYY-MM-DD" -> nome
  const [carregando,  setCarregando]  = useState(false);
  const [erro,        setErro]        = useState(null);
  const [anoAtual,    setAnoAtual]    = useState(new Date().getFullYear());

  // HORAS_DIA padrão do escritório (usado no calendário geral)
  // Cada colaborador tem suas próprias horas calculadas via calcHorasDia(expediente)
  const HORAS_DIA = 7; // padrão referência (9-12 + 14-18)

  const buscarFeriados = async (ano) => {
    setCarregando(true);
    setErro(null);
    try {
      const res = await fetch(`https://brasilapi.com.br/api/feriados/v1/${ano}`);
      if (!res.ok) throw new Error("Erro na BrasilAPI");
      const lista = await res.json();

      const mapa = {};

      // Nacionais da BrasilAPI
      lista.forEach(f => {
        mapa[f.date] = f.name;
      });

      // Estaduais MG (BrasilAPI não retorna todos)
      Object.entries(FERIADOS_MG_ESTADUAIS).forEach(([mmdd, nome]) => {
        mapa[`${ano}-${mmdd}`] = nome;
      });

      // Municipais Gov. Valadares
      Object.entries(FERIADOS_GV_MUNICIPAIS).forEach(([mmdd, nome]) => {
        mapa[`${ano}-${mmdd}`] = nome;
      });

      setFeriados(prev => ({ ...prev, ...mapa }));
      setAnoAtual(ano);
    } catch(e) {
      setErro("Nao foi possivel buscar feriados: " + e.message);
      // Fallback: feriados nacionais fixos
      const fallback = {};
      const fixos = {
        "01-01":"Confraternizacao Universal","04-21":"Tiradentes","05-01":"Dia do Trabalho",
        "09-07":"Independencia do Brasil","10-12":"Nossa Sra. Aparecida","11-02":"Finados",
        "11-15":"Proclamacao da Republica","12-25":"Natal",
        "04-08":"Aniversario de Gov. Valadares","11-02":"Criacao Municipio GV",
      };
      Object.entries(fixos).forEach(([mmdd,nome]) => { fallback[`${ano}-${mmdd}`] = nome; });
      setFeriados(prev => ({ ...prev, ...fallback }));
    } finally {
      setCarregando(false);
    }
  };

  const ehFeriado = (dataISO) => !!feriados[dataISO];
  const nomeFeriado = (dataISO) => feriados[dataISO] || null;

  const ehDiaUtil = (dataISO) => {
    const d = new Date(dataISO + "T12:00:00");
    const dow = d.getDay(); // 0=Dom, 6=Sab
    if (dow === 0 || dow === 6) return false;
    if (ehFeriado(dataISO)) return false;
    return true;
  };

  const diasUteisNoMes = (ano, mes) => {
    // mes: 1-12
    const diasNoMes = new Date(ano, mes, 0).getDate();
    let count = 0;
    for (let d = 1; d <= diasNoMes; d++) {
      const iso = `${ano}-${String(mes).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
      if (ehDiaUtil(iso)) count++;
    }
    return count;
  };

  const horasPrevistasMes = (ano, mes, horasDia=HORAS_DIA) => diasUteisNoMes(ano, mes) * horasDia;

  // Lista feriados de um mes
  const feriadosDoMes = (ano, mes) => {
    const diasNoMes = new Date(ano, mes, 0).getDate();
    const lista = [];
    for (let d = 1; d <= diasNoMes; d++) {
      const iso = `${ano}-${String(mes).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
      if (feriados[iso]) lista.push({ data: iso, nome: feriados[iso] });
    }
    return lista;
  };

  return {
    feriados, carregando, erro, anoAtual,
    buscarFeriados, ehFeriado, nomeFeriado,
    ehDiaUtil, diasUteisNoMes, horasPrevistasMes, feriadosDoMes,
    HORAS_DIA,
  };
}

// ─── MÓDULO CALENDÁRIO / DIAS ÚTEIS ──────────────────────────────────────────
function ModuloCalendario({ calendario, usuarioAtual, registros, usuarios }) {
  const [ano,  setAno]  = useState(new Date().getFullYear());
  const [mes,  setMes]  = useState(new Date().getMonth() + 1);
  const [aba,  setAba]  = useState("calendario"); // calendario | feriados | recessos
  const [novoRecesso, setNR]   = useState({ data:"", motivo:"" });
  const [recessos, setRecessos] = useState(() => carregar("intec_recessos", []));
  // Edições manuais de feriados: { [iso]: nome } para adicionar/editar, { [iso]: null } para excluir
  const [edicoesFeriados, setEF] = useState(() => carregar("intec_feriados_edicoes", {}));
  const [novoFeriado, setNF]    = useState({ data:"", nome:"" });
  const [editando, setEditando] = useState(null); // iso sendo editado
  const [editNome, setEditNome] = useState("");
  const isGestor = ["admin","gestor"].includes(usuarioAtual.perfil);

  useEffect(() => { salvar("intec_recessos", recessos); }, [recessos]);
  useEffect(() => { salvar("intec_feriados_edicoes", edicoesFeriados); }, [edicoesFeriados]);

  useEffect(() => {
    if (Object.keys(calendario.feriados).length === 0 || calendario.anoAtual !== ano) {
      calendario.buscarFeriados(ano);
    }
  }, [ano]);

  const nomesMeses = ["","Janeiro","Fevereiro","Marco","Abril","Maio","Junho",
    "Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
  const anos = [2024, 2025, 2026, 2027];

  // Feriados efetivos = API + edições manuais (null = excluído)
  const feriadosEfetivos = useMemo(() => {
    const base = { ...calendario.feriados };
    Object.entries(edicoesFeriados).forEach(([iso, nome]) => {
      if (nome === null) delete base[iso];
      else base[iso] = nome;
    });
    return base;
  }, [calendario.feriados, edicoesFeriados]);

  // Funções usando feriados efetivos
  const ehFeriadoEfetivo   = (iso) => !!feriadosEfetivos[iso];
  const nomeFeriadoEfetivo = (iso) => feriadosEfetivos[iso] || null;
  const ehDiaUtilEfetivo   = (iso) => {
    const d = new Date(iso + "T12:00:00");
    const dow = d.getDay();
    if (dow === 0 || dow === 6) return false;
    if (ehFeriadoEfetivo(iso)) return false;
    return true;
  };
  const diasUteis = useMemo(() => {
    const diasNoMes = new Date(ano, mes, 0).getDate();
    let count = 0;
    for (let d = 1; d <= diasNoMes; d++) {
      const iso = `${ano}-${String(mes).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
      if (ehDiaUtilEfetivo(iso)) count++;
    }
    return count;
  }, [ano, mes, feriadosEfetivos]);

  // Horas previstas do usuário logado (não fixo)
  const hdDiaUsuario    = calcHorasDia(usuarioAtual?.expediente);
  const horasPrevistas  = diasUteis * hdDiaUsuario;
  const diasNoMes      = new Date(ano, mes, 0).getDate();
  const primeiroDia    = new Date(ano, mes - 1, 1).getDay();

  const recessosMes  = recessos.filter(r => r.data.startsWith(`${ano}-${String(mes).padStart(2,"0")}`));
  const ehRecesso    = (iso) => recessos.some(r => r.data === iso);
  const nomeRecesso  = (iso) => recessos.find(r => r.data === iso)?.motivo || null;

  const adicionarRecesso = () => {
    if (!novoRecesso.data || !novoRecesso.motivo) return;
    setRecessos(r => [...r.filter(x => x.data !== novoRecesso.data), { ...novoRecesso }]);
    setNR({ data:"", motivo:"" });
  };
  const removerRecesso = (data) => setRecessos(r => r.filter(x => x.data !== data));

  // Gerenciar feriados
  const adicionarFeriado = () => {
    if (!novoFeriado.data || !novoFeriado.nome) return;
    setEF(e => ({ ...e, [novoFeriado.data]: novoFeriado.nome }));
    setNF({ data:"", nome:"" });
  };
  const excluirFeriado = (iso) => {
    // Se é da API, marca como null (excluído). Se é manual, remove das edições
    setEF(e => {
      const novo = { ...e };
      if (calendario.feriados[iso]) novo[iso] = null; // excluir da API
      else delete novo[iso]; // remover manual
      return novo;
    });
  };
  const iniciarEdicao = (iso) => { setEditando(iso); setEditNome(feriadosEfetivos[iso] || ""); };
  const salvarEdicao  = () => {
    if (editando && editNome.trim()) setEF(e => ({ ...e, [editando]: editNome.trim() }));
    setEditando(null); setEditNome("");
  };
  const restaurarFeriado = (iso) => {
    setEF(e => { const n = { ...e }; delete n[iso]; return n; });
  };

  // Todos os feriados do ano para a tela de gerenciamento
  const todosAno = useMemo(() => {
    const todos = {};
    // Da API
    Object.entries(calendario.feriados).forEach(([iso, nome]) => {
      if (iso.startsWith(String(ano))) todos[iso] = { nome, origem:"api", excluido: edicoesFeriados[iso] === null };
    });
    // Manuais adicionados
    Object.entries(edicoesFeriados).forEach(([iso, nome]) => {
      if (!iso.startsWith(String(ano))) return;
      if (nome === null) return; // já marcado como excluído acima
      if (!calendario.feriados[iso]) todos[iso] = { nome, origem:"manual", excluido:false };
      else todos[iso] = { ...todos[iso], nome, editado:true }; // editado da API
    });
    return Object.entries(todos).sort((a,b) => a[0].localeCompare(b[0]));
  }, [calendario.feriados, edicoesFeriados, ano]);

  const feriadosMes = useMemo(() =>
    Object.entries(feriadosEfetivos)
      .filter(([iso]) => iso.startsWith(`${ano}-${String(mes).padStart(2,"0")}`))
      .sort((a,b)=>a[0].localeCompare(b[0]))
      .map(([iso,nome])=>({data:iso,nome}))
  , [feriadosEfetivos, ano, mes]);

  const resumoHoras = useMemo(() => {
    return usuarios.filter(u => u.ativo).map(u => {
      const regs = registros.filter(r =>
        r.usuarioId === u.id &&
        r.data?.startsWith(`${ano}-${String(mes).padStart(2,"0")}`) &&
        r.duracaoMin
      );
      const totalMin    = regs.reduce((a,r) => a + r.duracaoMin, 0);
      const totalH      = Math.floor(totalMin / 60);
      const totalM      = totalMin % 60;
      const hdDia       = calcHorasDia(u.expediente);
      const hPrevUsuario= calendario.diasUteisNoMes(ano, mes) * hdDia * 60;
      const pct         = hPrevUsuario > 0 ? Math.min(100, Math.round((totalMin / hPrevUsuario) * 100)) : 0;
      return { usuario:u, totalMin, totalH, totalM, pct, hdDia };
    });
  }, [usuarios, registros, ano, mes]);

  const semanas = ["Dom","Seg","Ter","Qua","Qui","Sex","Sab"];
  const hoje_iso = new Date().toISOString().slice(0,10);

  const badgeOrigem = (origem, editado, excluido) => {
    if (excluido) return <span style={{fontSize:9,background:"#fef2f2",color:C.vermelho,padding:"1px 6px",borderRadius:3,fontWeight:700,border:"1px solid #fecaca"}}>EXCLUÍDO</span>;
    if (editado)  return <span style={{fontSize:9,background:"#fffbeb",color:"#92400e",padding:"1px 6px",borderRadius:3,fontWeight:700,border:"1px solid #fde68a"}}>EDITADO</span>;
    if (origem==="manual") return <span style={{fontSize:9,background:"#f0fdf4",color:"#166534",padding:"1px 6px",borderRadius:3,fontWeight:700,border:"1px solid #86efac"}}>MANUAL</span>;
    return <span style={{fontSize:9,background:"#eff6ff",color:"#1d4ed8",padding:"1px 6px",borderRadius:3,fontWeight:700,border:"1px solid #bfdbfe"}}>API</span>;
  };

  return (
    <div style={{display:"flex",flexDirection:"column",gap:20}}>
      {/* Controles topo */}
      <Card style={{padding:16}}>
        <div style={{display:"flex",gap:12,alignItems:"center",flexWrap:"wrap"}}>
          <div style={{flex:1}}>
            <h2 style={{color:C.azulEscuro,margin:0,fontSize:16,fontWeight:700}}>📅 Calendario de Dias Uteis</h2>
            <p style={{color:C.cinzaClaro,fontSize:12,margin:"4px 0 0"}}>
              Feriados nacionais + MG + Gov. Valadares • Expediente: {labelExpediente(usuarioAtual?.expediente)} ({hdDiaUsuario}h/dia)
            </p>
          </div>
          <select value={mes} onChange={e=>setMes(Number(e.target.value))} style={{border:`1.5px solid ${C.cinzaCard}`,borderRadius:8,padding:"8px 12px",fontSize:13,fontFamily:"inherit",cursor:"pointer"}}>
            {nomesMeses.slice(1).map((n,i)=><option key={i+1} value={i+1}>{n}</option>)}
          </select>
          <select value={ano} onChange={e=>setAno(Number(e.target.value))} style={{border:`1.5px solid ${C.cinzaCard}`,borderRadius:8,padding:"8px 12px",fontSize:13,fontFamily:"inherit",cursor:"pointer"}}>
            {anos.map(a=><option key={a} value={a}>{a}</option>)}
          </select>
          <Btn onClick={()=>calendario.buscarFeriados(ano)} variant="secondary" small disabled={calendario.carregando}>
            {calendario.carregando ? "⏳ Buscando..." : "🔄 Atualizar API"}
          </Btn>
        </div>
        {calendario.erro && <div style={{marginTop:10,padding:"8px 12px",background:"#fef2f2",border:"1px solid #fecaca",borderRadius:8,fontSize:12,color:C.vermelho}}>⚠ {calendario.erro}</div>}

        {/* Sub-abas */}
        <div style={{display:"flex",gap:4,marginTop:14,borderBottom:`2px solid ${C.cinzaCard}`,paddingBottom:0}}>
          {[
            {id:"calendario", label:"📆 Visualizar"},
            {id:"feriados",   label:"🎉 Gerenciar Feriados"},
            {id:"recessos",   label:"🏖 Recessos & Pontes"},
          ].map(t=>(
            <button key={t.id} onClick={()=>setAba(t.id)} style={{
              background:"none",border:"none",padding:"8px 16px",cursor:"pointer",fontSize:13,
              fontFamily:"inherit",fontWeight:aba===t.id?700:500,
              color:aba===t.id?C.azulMedio:C.cinzaClaro,
              borderBottom:aba===t.id?`2px solid ${C.azulMedio}`:"2px solid transparent",
              marginBottom:-2,transition:"all 0.15s"}}>
              {t.label}
            </button>
          ))}
        </div>
      </Card>

      {/* ── ABA: CALENDÁRIO VISUAL ── */}
      {aba === "calendario" && (<>
        {/* KPIs */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:14}}>
          {[
            {label:"Dias Uteis",   valor:diasUteis - recessosMes.length, cor:C.azulMedio, icone:"📆", sub:`de ${diasNoMes} dias`},
            {label:"Horas Previstas", valor:`${horasPrevistas - recessosMes.length * hdDiaUsuario}h`, cor:C.azulClaro, icone:"⏱", sub:`${hdDiaUsuario}h × ${diasUteis - recessosMes.length} dias`},
            {label:"Feriados",    valor:feriadosMes.length,    cor:C.laranja, icone:"🎉", sub:"no mes"},
            {label:"Recessos",    valor:recessosMes.length,    cor:C.amarelo, icone:"🏖", sub:"cadastrados"},
            {label:"Expediente",  valor:`${hdDiaUsuario}h/dia`, cor:C.verde,  icone:"🏢", sub:labelExpediente(usuarioAtual?.expediente)},
          ].map(k=>(
            <Card key={k.label} style={{textAlign:"center",borderTop:`3px solid ${k.cor}`,padding:14}}>
              <div style={{fontSize:22}}>{k.icone}</div>
              <div style={{fontSize:22,fontWeight:800,color:k.cor,lineHeight:1.1,marginTop:4}}>{k.valor}</div>
              <div style={{fontSize:11,color:C.cinzaClaro,marginTop:4,fontWeight:600}}>{k.label}</div>
              <div style={{fontSize:10,color:C.cinzaClaro}}>{k.sub}</div>
            </Card>
          ))}
        </div>

        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20}}>
          {/* Calendário */}
          <Card>
            <h3 style={{color:C.azulEscuro,margin:"0 0 14px",fontSize:14,fontWeight:700}}>{nomesMeses[mes]} {ano}</h3>
            <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:3}}>
              {semanas.map(s=>(
                <div key={s} style={{textAlign:"center",fontSize:10,fontWeight:700,color:C.cinzaClaro,padding:"4px 0",background:C.cinzaFundo,borderRadius:4}}>{s}</div>
              ))}
              {Array(primeiroDia).fill(null).map((_,i)=><div key={"e"+i}/>)}
              {Array.from({length:diasNoMes},(_,i)=>i+1).map(d => {
                const iso = `${ano}-${String(mes).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
                const feriado = ehFeriadoEfetivo(iso);
                const recesso = ehRecesso(iso);
                const dow = new Date(iso+"T12:00:00").getDay();
                const fds = dow===0||dow===6;
                let bg=C.branco, color=C.cinzaEscuro, borda=C.cinzaCard;
                if (fds)     { bg="#f8fafc"; color=C.cinzaClaro; }
                if (recesso) { bg="#fffbeb"; color="#92400e"; borda="#fde68a"; }
                if (feriado) { bg="#fff0e6"; color=C.laranja;  borda="#fed7aa"; }
                if (iso===hoje_iso) borda=C.azulMedio;
                return (
                  <div key={iso} title={nomeFeriadoEfetivo(iso)||nomeRecesso(iso)||""}
                    style={{textAlign:"center",padding:"5px 2px",borderRadius:6,fontSize:12,
                      fontWeight:ehDiaUtilEfetivo(iso)&&!recesso?700:400,
                      background:bg,color,border:`1px solid ${borda}`,position:"relative",
                      cursor:feriado||recesso?"help":"default"}}>
                    {d}
                    {(feriado||recesso)&&<div style={{position:"absolute",bottom:1,left:"50%",transform:"translateX(-50%)",width:4,height:4,borderRadius:"50%",background:recesso?C.amarelo:C.laranja}}/>}
                  </div>
                );
              })}
            </div>
            <div style={{display:"flex",gap:12,marginTop:12,flexWrap:"wrap"}}>
              {[{cor:"#f8fafc",borda:C.cinzaCard,label:"Fim de semana"},{cor:"#fff0e6",borda:"#fed7aa",label:"Feriado"},{cor:"#fffbeb",borda:"#fde68a",label:"Recesso"},{cor:C.branco,borda:C.azulMedio,label:"Hoje"}].map(l=>(
                <div key={l.label} style={{display:"flex",alignItems:"center",gap:5,fontSize:10,color:C.cinzaClaro}}>
                  <div style={{width:12,height:12,borderRadius:3,background:l.cor,border:`1px solid ${l.borda}`}}/>
                  {l.label}
                </div>
              ))}
            </div>
          </Card>

          {/* Feriados do mês + horas colaboradores */}
          <div style={{display:"flex",flexDirection:"column",gap:14}}>
            <Card style={{padding:16}}>
              <h3 style={{color:C.azulEscuro,margin:"0 0 12px",fontSize:13,fontWeight:700}}>🎉 Feriados em {nomesMeses[mes]}</h3>
              {feriadosMes.length===0
                ?<p style={{color:C.cinzaClaro,fontSize:12,margin:0}}>Nenhum feriado neste mes.</p>
                :<div style={{display:"flex",flexDirection:"column",gap:5}}>
                  {feriadosMes.map(f=>(
                    <div key={f.data} style={{display:"flex",justifyContent:"space-between",padding:"7px 10px",background:"#fff7ed",borderRadius:8,border:"1px solid #fed7aa",fontSize:12}}>
                      <span style={{fontWeight:700,color:C.laranja}}>{f.data.slice(8)}/{f.data.slice(5,7)}</span>
                      <span style={{color:C.cinzaEscuro,flex:1,marginLeft:10}}>{f.nome}</span>
                      {isGestor&&<button onClick={()=>{setAba("feriados");}} style={{background:"none",border:"none",color:C.azulClaro,cursor:"pointer",fontSize:11,padding:"0 4px"}}>editar</button>}
                    </div>
                  ))}
                </div>}
            </Card>

            <Card>
              <h3 style={{color:C.azulEscuro,margin:"0 0 12px",fontSize:13,fontWeight:700}}>👥 Horas — {nomesMeses[mes]}</h3>
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                {resumoHoras.map(d=>(
                  <div key={d.usuario.id} style={{padding:"10px 12px",background:C.cinzaFundo,borderRadius:8}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                      <div style={{display:"flex",alignItems:"center",gap:8}}>
                        <Avatar u={d.usuario} size={28}/>
                        <span style={{fontWeight:700,color:C.cinzaEscuro,fontSize:12}}>{d.usuario.nome}</span>
                      </div>
                      <div style={{textAlign:"right"}}>
                        <div style={{fontSize:13,fontWeight:800,color:d.pct>=80?C.verde:d.pct>=50?C.amarelo:C.vermelho}}>{d.totalH}h {d.totalM}min</div>
                        <div style={{fontSize:10,color:C.cinzaClaro}}>de {Math.round(calendario.diasUteisNoMes(ano,mes)*calcHorasDia(d.usuario.expediente))}h • {calcHorasDia(d.usuario.expediente)}h/dia ({d.pct}%)</div>
                      </div>
                    </div>
                    <div style={{background:C.cinzaCard,borderRadius:4,height:6}}>
                      <div style={{background:d.pct>=80?C.verde:d.pct>=50?C.amarelo:C.vermelho,height:6,borderRadius:4,width:`${d.pct}%`,transition:"width 0.4s"}}/>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </div>
      </>)}

      {/* ── ABA: GERENCIAR FERIADOS ── */}
      {aba === "feriados" && (
        <Card>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:10}}>
            <div>
              <h3 style={{color:C.azulEscuro,margin:0,fontSize:15,fontWeight:700}}>🎉 Gerenciar Feriados — {ano}</h3>
              <p style={{color:C.cinzaClaro,fontSize:12,margin:"4px 0 0"}}>
                Edite ou exclua feriados carregados da API. Adicione feriados locais manualmente.
              </p>
            </div>
            <div style={{display:"flex",gap:8}}>
              <Btn variant="ghost" small onClick={()=>{ if(window.confirm("Restaurar todos os feriados excluídos/editados deste ano?")){ setEF(e=>{ const n={...e}; Object.keys(n).filter(k=>k.startsWith(String(ano))).forEach(k=>delete n[k]); return n; }); } }}>
                ↩ Restaurar tudo do {ano}
              </Btn>
            </div>
          </div>

          {/* Adicionar feriado manual */}
          {isGestor && (
            <div style={{display:"flex",gap:8,marginBottom:16,padding:"12px 14px",background:C.cinzaFundo,borderRadius:10,flexWrap:"wrap",alignItems:"flex-end"}}>
              <div style={{display:"flex",flexDirection:"column",gap:4}}>
                <label style={{fontSize:11,fontWeight:600,color:C.cinzaEscuro}}>Data</label>
                <input type="date" value={novoFeriado.data} onChange={e=>setNF(n=>({...n,data:e.target.value}))}
                  style={{border:`1.5px solid ${C.cinzaCard}`,borderRadius:8,padding:"7px 10px",fontSize:13,fontFamily:"inherit"}}/>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:4,flex:1,minWidth:180}}>
                <label style={{fontSize:11,fontWeight:600,color:C.cinzaEscuro}}>Nome do feriado</label>
                <input placeholder="Ex: Aniversário de Gov. Valadares" value={novoFeriado.nome} onChange={e=>setNF(n=>({...n,nome:e.target.value}))}
                  style={{border:`1.5px solid ${C.cinzaCard}`,borderRadius:8,padding:"7px 10px",fontSize:13,fontFamily:"inherit",width:"100%",boxSizing:"border-box"}}/>
              </div>
              <Btn onClick={adicionarFeriado} variant="verde" small>+ Adicionar Feriado</Btn>
            </div>
          )}

          {/* Lista completa do ano */}
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            {todosAno.length === 0 && <p style={{color:C.cinzaClaro,fontSize:13,textAlign:"center",padding:20}}>Nenhum feriado carregado. Clique em "Atualizar API".</p>}
            {todosAno.map(([iso, info]) => (
              <div key={iso} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",
                background:info.excluido?"#fef2f2":info.editado?"#fffbeb":info.origem==="manual"?"#f0fdf4":C.cinzaFundo,
                borderRadius:10,border:`1px solid ${info.excluido?"#fecaca":info.editado?"#fde68a":info.origem==="manual"?"#86efac":C.cinzaCard}`,
                opacity:info.excluido?0.6:1}}>

                {/* Data */}
                <div style={{minWidth:55,fontWeight:700,color:C.azulMedio,fontSize:12}}>
                  {iso.slice(8)}/{iso.slice(5,7)}
                </div>

                {/* Nome — modo edição ou leitura */}
                {editando === iso ? (
                  <input value={editNome} onChange={e=>setEditNome(e.target.value)}
                    onKeyDown={e=>{ if(e.key==="Enter") salvarEdicao(); if(e.key==="Escape"){setEditando(null);} }}
                    autoFocus
                    style={{flex:1,border:`1.5px solid ${C.azulClaro}`,borderRadius:6,padding:"4px 8px",fontSize:13,fontFamily:"inherit"}}/>
                ) : (
                  <span style={{flex:1,fontSize:13,color:info.excluido?C.cinzaClaro:C.cinzaEscuro,textDecoration:info.excluido?"line-through":"none"}}>
                    {info.nome}
                  </span>
                )}

                {badgeOrigem(info.origem, info.editado, info.excluido)}

                {/* Ações */}
                {isGestor && !info.excluido && (
                  <>
                    {editando === iso ? (
                      <>
                        <Btn onClick={salvarEdicao} variant="verde" small>✓ Salvar</Btn>
                        <Btn onClick={()=>setEditando(null)} variant="ghost" small>Cancelar</Btn>
                      </>
                    ) : (
                      <>
                        <Btn onClick={()=>iniciarEdicao(iso)} variant="ghost" small>✏ Editar</Btn>
                        <Btn onClick={()=>excluirFeriado(iso)} variant="danger" small>🗑 Excluir</Btn>
                      </>
                    )}
                  </>
                )}
                {isGestor && info.excluido && (
                  <Btn onClick={()=>restaurarFeriado(iso)} variant="secondary" small>↩ Restaurar</Btn>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ── ABA: RECESSOS ── */}
      {aba === "recessos" && (
        <Card>
          <h3 style={{color:C.azulEscuro,margin:"0 0 16px",fontSize:15,fontWeight:700}}>🏖 Recessos, Pontes & Dias Nao Trabalhados</h3>
          {isGestor && (
            <div style={{display:"flex",gap:8,marginBottom:16,padding:"12px 14px",background:C.cinzaFundo,borderRadius:10,flexWrap:"wrap",alignItems:"flex-end"}}>
              <div style={{display:"flex",flexDirection:"column",gap:4}}>
                <label style={{fontSize:11,fontWeight:600,color:C.cinzaEscuro}}>Data</label>
                <input type="date" value={novoRecesso.data} onChange={e=>setNR(n=>({...n,data:e.target.value}))}
                  style={{border:`1.5px solid ${C.cinzaCard}`,borderRadius:8,padding:"7px 10px",fontSize:13,fontFamily:"inherit"}}/>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:4,flex:1,minWidth:180}}>
                <label style={{fontSize:11,fontWeight:600,color:C.cinzaEscuro}}>Motivo</label>
                <input placeholder="Ex: Recesso de Natal, Ponte..." value={novoRecesso.motivo} onChange={e=>setNR(n=>({...n,motivo:e.target.value}))}
                  style={{border:`1.5px solid ${C.cinzaCard}`,borderRadius:8,padding:"7px 10px",fontSize:13,fontFamily:"inherit",width:"100%",boxSizing:"border-box"}}/>
              </div>
              <Btn onClick={adicionarRecesso} small>+ Adicionar</Btn>
            </div>
          )}
          {recessos.length === 0
            ? <p style={{color:C.cinzaClaro,fontSize:13,textAlign:"center",padding:20}}>Nenhum recesso cadastrado.</p>
            : <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {[...recessos].sort((a,b)=>a.data.localeCompare(b.data)).map(r=>(
                <div key={r.data} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 14px",background:"#fffbeb",borderRadius:10,border:"1px solid #fde68a"}}>
                  <span style={{fontWeight:700,color:"#92400e",minWidth:80,fontSize:12}}>{r.data.slice(8)}/{r.data.slice(5,7)}/{r.data.slice(0,4)}</span>
                  <span style={{flex:1,fontSize:13,color:C.cinzaEscuro}}>{r.motivo}</span>
                  {isGestor && <Btn onClick={()=>removerRecesso(r.data)} variant="danger" small>🗑 Remover</Btn>}
                </div>
              ))}
            </div>}
        </Card>
      )}
    </div>
  );
}

function BancoHoras({registros,setRegistros,usuarios,projetos,usuarioAtual,onAbrirEncerramento}){
  const [filtroUser,setFU]=useState(usuarioAtual.perfil==="colaborador"?usuarioAtual.id:"todos");
  const [filtroMes,setFM]=useState("todos");
  const [abaH,     setAbaH]=useState("historico"); // historico | extras
  const [editandoObs,setEditandoObs]=useState(null);
  const [novaObs,setNovaObs]=useState("");
  const isGestor=["admin","gestor"].includes(usuarioAtual.perfil);

  const podeEditar = (r) => isGestor || r.usuarioId===usuarioAtual.id;

  const excluirSessao = async (id) => {
    if(!window.confirm("Excluir este registro?")) return;
    setRegistros(x=>x.filter(x2=>x2.id!==id));
    try { await db.sessoes.excluir(id); } catch(e){ console.error("Erro excluir sessao:",e); }
  };

  const salvarObs = async (id) => {
    setRegistros(x=>x.map(r=>r.id===id?{...r,obs:novaObs}:r));
    setEditandoObs(null);
    try {
      await db.sessoes.atualizarObs(id, novaObs);
    } catch(e){ console.error("Erro salvar obs:",e); }
  };

  const meses=useMemo(()=>{const s=new Set();registros.forEach(r=>{if(r.data)s.add(r.data.slice(0,7));});return [...s].sort((a,b)=>b.localeCompare(a));},[registros]);

  const filtrados=useMemo(()=>registros.filter(r=>{
    if(!isGestor&&r.usuarioId!==usuarioAtual.id) return false;
    if(filtroUser!=="todos"&&r.usuarioId!==filtroUser) return false;
    if(filtroMes!=="todos"&&!r.data?.startsWith(filtroMes)) return false;
    return true;
  }),[registros,filtroUser,filtroMes,usuarioAtual,isGestor]);

  const resumoUser=useMemo(()=>{const m={};filtrados.forEach(r=>{if(!m[r.usuarioId])m[r.usuarioId]={totalMin:0,sessoes:0,projs:new Set(),totalExtras:0};m[r.usuarioId].totalMin+=r.duracaoMin||0;m[r.usuarioId].sessoes++;m[r.usuarioId].totalExtras+=r.minutosExtras||0;if(r.projetoId)m[r.usuarioId].projs.add(r.projetoId);});return m;},[filtrados]);

  const resumoProj=useMemo(()=>{const m={};filtrados.forEach(r=>{if(!r.projetoId)return;if(!m[r.projetoId])m[r.projetoId]={totalMin:0,sessoes:0};m[r.projetoId].totalMin+=r.duracaoMin||0;m[r.projetoId].sessoes++;});return m;},[filtrados]);

  const sessaoAberta=registros.find(r=>r.usuarioId===usuarioAtual.id&&!r.horaFim);
  const totalExtras = filtrados.filter(r=>r.usuarioId===usuarioAtual.id||(["admin","gestor"].includes(usuarioAtual.perfil)&&filtroUser==="todos")).reduce((a,r)=>a+(r.minutosExtras||0),0);

  return(
    <div style={{display:"flex",flexDirection:"column",gap:20}}>
      {/* Resumo de horas extras na aba extras */}
      {abaH==="extras"&&(()=>{
        const regExtras = filtrados.filter(r=>(r.minutosExtras||0)>0 && (isGestor||r.usuarioId===usuarioAtual.id));
        const totalExtraMin = regExtras.reduce((a,r)=>a+(r.minutosExtras||0),0);
        const porUser = {};
        regExtras.forEach(r=>{
          if(!porUser[r.usuarioId]) porUser[r.usuarioId]={min:0,n:0};
          porUser[r.usuarioId].min+=r.minutosExtras||0;
          porUser[r.usuarioId].n++;
        });
        return(
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:12,marginBottom:16}}>
            <Card style={{textAlign:"center",borderTop:`3px solid ${C.laranja}`,padding:14}}>
              <div style={{fontSize:22}}>⏰</div>
              <div style={{fontSize:22,fontWeight:800,color:C.laranja}}>{fmtDuracao(totalExtraMin)}</div>
              <div style={{fontSize:11,color:C.cinzaClaro,marginTop:4}}>Total de horas extras</div>
            </Card>
            {isGestor&&Object.entries(porUser).map(([uid,d])=>{
              const u=usuarios.find(x=>x.id===uid);
              return <Card key={uid} style={{borderTop:`3px solid ${C.amarelo}`,padding:14}}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}><Avatar u={u} size={28}/><span style={{fontSize:13,fontWeight:700}}>{u?.nome||uid}</span></div>
                <div style={{fontSize:18,fontWeight:800,color:C.amarelo}}>{fmtDuracao(d.min)}</div>
                <div style={{fontSize:11,color:C.cinzaClaro}}>{d.n} sessão(ões)</div>
              </Card>;
            })}
          </div>
        );
      })()}
      {sessaoAberta&&(
        <Card style={{borderLeft:`4px solid ${C.verde}`,background:"#f0fdf4"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10}}>
            <div>
              <div style={{fontSize:13,fontWeight:700,color:"#166534"}}>▶ Sessão em andamento</div>
              <div style={{fontSize:12,color:"#166534",marginTop:2}}>Projeto: <strong>{projetos.find(p=>p.id===sessaoAberta.projetoId)?.codigo||"?"}</strong> — Início: {sessaoAberta.horaInicio}</div>
            </div>
            <Btn onClick={onAbrirEncerramento} variant="verde" small>🏁 Encerrar expediente</Btn>
          </div>
        </Card>
      )}

      <Card style={{padding:16}}>
        <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"center"}}>
          {isGestor&&<select value={filtroUser} onChange={e=>setFU(e.target.value)} style={{border:`1.5px solid ${C.cinzaCard}`,borderRadius:8,padding:"8px 12px",fontSize:13,fontFamily:"inherit",cursor:"pointer"}}>
            <option value="todos">👤 Todos</option>
            {usuarios.filter(u=>u.ativo).map(u=><option key={u.id} value={u.id}>{u.nome}</option>)}
          </select>}
          <select value={filtroMes} onChange={e=>setFM(e.target.value)} style={{border:`1.5px solid ${C.cinzaCard}`,borderRadius:8,padding:"8px 12px",fontSize:13,fontFamily:"inherit",cursor:"pointer"}}>
            <option value="todos">📅 Todos os meses</option>
            {meses.map(m=><option key={m} value={m}>{m}</option>)}
          </select>
          <span style={{fontSize:12,color:C.cinzaClaro,marginLeft:"auto"}}>{filtrados.length} registro(s)</span>
        </div>
      </Card>

      {isGestor&&filtroUser==="todos"&&Object.keys(resumoUser).length>0&&(
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:14}}>
          {Object.entries(resumoUser).map(([uid,d])=>{
            const u=usuarios.find(x=>x.id===uid); if(!u) return null;
            return(<Card key={uid} style={{borderTop:`3px solid ${u.cor||C.azulMedio}`}}>
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}><Avatar u={u} size={36}/><div style={{fontWeight:700,color:C.cinzaEscuro,fontSize:13}}>{u.nome}</div></div>
              <div style={{fontSize:24,fontWeight:800,color:u.cor||C.azulMedio}}>{fmtDuracao(d.totalMin)}</div>
              <div style={{fontSize:11,color:C.cinzaClaro,marginTop:4}}>{d.sessoes} sessão(ões) • {d.projs.size} projeto(s)</div>
              {d.totalExtras>0&&<div style={{fontSize:11,color:C.laranja,fontWeight:700,marginTop:2}}>⏰ +{fmtDuracao(d.totalExtras)} extras</div>}
            </Card>);
          })}
        </div>
      )}

      {Object.keys(resumoProj).length>0&&(
        <Card>
          <h3 style={{color:C.azulEscuro,margin:"0 0 16px",fontSize:14,fontWeight:700}}>⏱ Horas por Projeto</h3>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {Object.entries(resumoProj).sort((a,b)=>b[1].totalMin-a[1].totalMin).map(([pid,d])=>{
              const proj=projetos.find(p=>p.id===pid);
              const maxMin=Math.max(...Object.values(resumoProj).map(x=>x.totalMin));
              return(<div key={pid} style={{padding:"10px 14px",background:C.cinzaFundo,borderRadius:8}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                  <div><span style={{fontSize:12,fontWeight:700,color:C.azulMedio}}>{proj?.codigo||pid}</span><span style={{fontSize:11,color:C.cinzaClaro,marginLeft:8}}>{proj?.cliente?.substring(0,40)||"—"}</span></div>
                  <span style={{fontSize:13,fontWeight:700,color:C.azulEscuro}}>{fmtDuracao(d.totalMin)}</span>
                </div>
                <div style={{background:C.cinzaCard,borderRadius:4,height:6}}><div style={{background:C.azulClaro,height:6,borderRadius:4,width:`${maxMin>0?(d.totalMin/maxMin)*100:0}%`,transition:"width 0.3s"}}/></div>
              </div>);
            })}
          </div>
        </Card>
      )}

      <Card style={{padding:0,overflow:"hidden"}}>
        {/* Sub-abas Histórico / Horas Extras */}
        <div style={{padding:"0 20px",borderBottom:`1px solid ${C.cinzaCard}`,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div style={{display:"flex",gap:0}}>
            {[{id:"historico",label:"📋 Histórico"},{id:"extras",label:"⏰ Horas Extras"}].map(t=>(
              <button key={t.id} onClick={()=>setAbaH(t.id)}
                style={{background:"none",border:"none",padding:"14px 18px",cursor:"pointer",fontSize:13,
                  fontFamily:"inherit",fontWeight:abaH===t.id?700:500,
                  color:abaH===t.id?C.azulMedio:C.cinzaClaro,
                  borderBottom:abaH===t.id?`2px solid ${C.azulMedio}`:"2px solid transparent",
                  marginBottom:-1,transition:"all 0.15s"}}>
                {t.label}
              </button>
            ))}
          </div>
          <span style={{fontSize:11,color:C.cinzaClaro}}>{filtrados.filter(r=>abaH==="extras"?(r.minutosExtras||0)>0:true).length} registro(s)</span>
        </div>
        <div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
            <thead>
              <tr style={{background:C.azulEscuro}}>
                {(abaH==="extras"
                  ? ["Data","Colaborador","Projeto/Atividade","Entrada","Saída","Total","H.Extra","O que fez",""]
                  : ["Data","Tipo","Colaborador","Projeto/Atividade","Entrada","Saída","Duração","H.Extra","O que fez","Feedback",""]
                ).map(h=><th key={h} style={{padding:"10px 14px",color:C.ciano,textAlign:"left",fontWeight:700,fontSize:11,whiteSpace:"nowrap"}}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {(()=>{
                const lista = abaH==="extras"
                  ? [...filtrados].filter(r=>(r.minutosExtras||0)>0).sort((a,b)=>(b.inicioTs||0)-(a.inicioTs||0))
                  : [...filtrados].sort((a,b)=>(b.inicioTs||0)-(a.inicioTs||0));
                if(lista.length===0) return <tr><td colSpan={11} style={{padding:"24px",textAlign:"center",color:C.cinzaClaro}}>
                  {abaH==="extras"?"Nenhuma hora extra registrada no período 🎉":"Nenhum registro encontrado"}
                </td></tr>;
                return lista.map((r,i)=>{
                  const u=usuarios.find(x=>x.id===r.usuarioId);
                  const proj=projetos.find(p=>p.id===r.projetoId);
                  const aberta=!r.horaFim;
                  return(
                    <tr key={r.id} style={{borderBottom:`1px solid ${C.cinzaFundo}`,background:i%2===0?C.branco:"#f8fafc"}}>
                      <td style={{padding:"9px 14px",color:C.cinzaClaro,whiteSpace:"nowrap"}}>{r.data?fmtData(r.data):"—"}</td>
                      {abaH==="historico"&&(
                        <td style={{padding:"9px 14px"}}>
                          {r.categoriaAdmin
                            ? <span style={{fontSize:10,background:"#f0fdf4",color:"#166534",padding:"2px 7px",borderRadius:4,fontWeight:700}}>⚙ Adm</span>
                            : <span style={{fontSize:10,background:"#eff6ff",color:C.azulMedio,padding:"2px 7px",borderRadius:4,fontWeight:700}}>📁 Proj</span>}
                        </td>
                      )}
                      <td style={{padding:"9px 14px"}}>
                        <div style={{display:"flex",alignItems:"center",gap:8}}>
                          <Avatar u={u} size={24}/>
                          <span style={{fontWeight:600,fontSize:12}}>{u?.nome||"—"}</span>
                        </div>
                      </td>
                      <td style={{padding:"9px 14px"}}>
                        {r.categoriaAdmin
                          ? <div style={{fontSize:11,fontWeight:700,color:"#166534"}}>{CATS_ADMIN.find(c=>c.id===r.categoriaAdmin)?.label||"Adm"}</div>
                          : <><div style={{fontSize:11,fontWeight:700,color:C.azulMedio}}>{proj?.codigo||"—"}</div>
                             <div style={{fontSize:11,color:C.cinzaClaro}}>{proj?.cliente?.substring(0,28)||""}</div></>}
                      </td>
                      <td style={{padding:"9px 14px",color:C.cinzaClaro}}>{r.horaInicio||"—"}</td>
                      <td style={{padding:"9px 14px",color:C.cinzaClaro}}>
                        {aberta?<span style={{color:C.verde,fontWeight:700}}>Em aberto</span>:r.horaFim}
                      </td>
                      <td style={{padding:"9px 14px",fontWeight:700,color:aberta?C.verde:C.azulEscuro}}>
                        {aberta?"...":fmtDuracao(r.duracaoMin)}
                      </td>
                      {/* H. Extra */}
                      <td style={{padding:"9px 14px"}}>
                        {(r.minutosExtras||0)>0
                          ? <span style={{fontSize:11,fontWeight:700,color:C.laranja,background:"#fff7ed",padding:"2px 8px",borderRadius:4,border:"1px solid #fed7aa",whiteSpace:"nowrap"}}>+{fmtDuracao(r.minutosExtras)}</span>
                          : <span style={{color:C.cinzaClaro,fontSize:11}}>—</span>}
                      </td>
                      {/* O que fez */}
                      <td style={{padding:"9px 14px",maxWidth:160}}>
                        <div style={{fontSize:11,color:C.cinzaEscuro,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:150}}
                          title={r.obsInicio||r.obs||"—"}>
                          {r.obsInicio||r.obs||<span style={{color:C.cinzaClaro}}>—</span>}
                        </div>
                      </td>
                      {/* Feedback — só na aba histórico */}
                      {abaH==="historico"&&(
                        <td style={{padding:"9px 14px",maxWidth:160}}>
                          {editandoObs===r.id ? (
                            <div style={{display:"flex",gap:6,alignItems:"center"}}>
                              <input value={novaObs} onChange={e=>setNovaObs(e.target.value)}
                                onKeyDown={e=>{if(e.key==="Enter")salvarObs(r.id);if(e.key==="Escape")setEditandoObs(null);}}
                                autoFocus placeholder="Feedback..."
                                style={{flex:1,border:`1.5px solid ${C.azulClaro}`,borderRadius:6,padding:"3px 7px",fontSize:12,fontFamily:"inherit"}}/>
                              <button onClick={()=>salvarObs(r.id)} style={{background:C.verde,color:"#fff",border:"none",borderRadius:5,padding:"3px 8px",cursor:"pointer",fontSize:11,fontWeight:700}}>✓</button>
                              <button onClick={()=>setEditandoObs(null)} style={{background:"none",border:"none",color:C.cinzaClaro,cursor:"pointer",fontSize:14}}>✕</button>
                            </div>
                          ):(
                            <div style={{display:"flex",alignItems:"center",gap:4,cursor:podeEditar(r)?"pointer":"default"}}
                              onClick={()=>{ if(podeEditar(r)){setEditandoObs(r.id);setNovaObs(r.obsFim||"");} }}>
                              <span style={{color:r.obsFim?C.cinzaEscuro:C.cinzaClaro,fontSize:11,flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:130}}
                                title={r.obsFim||""}>
                                {r.obsFim||<span style={{fontStyle:"italic",color:C.cinzaClaro,fontSize:10}}>+ feedback</span>}
                              </span>
                              {podeEditar(r)&&<span style={{color:C.azulClaro,fontSize:10,opacity:0.5}}>✏</span>}
                            </div>
                          )}
                        </td>
                      )}
                      {/* Excluir */}
                      {podeEditar(r)&&<td style={{padding:"9px 14px",width:36}}>
                        <Btn onClick={e=>{e.stopPropagation();excluirSessao(r.id);}} variant="danger" small>🗑</Btn>
                      </td>}
                    </tr>
                  );
                });
              })()}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ─── CONFIGURAÇÕES ─────────────────────────────────────────────────────────────

// ─── ESCALAS ───────────────────────────────────────────────────────────────────
function Escalas({ usuarioAtual, usuarios }) {
  const isGestor = ["admin","gestor"].includes(usuarioAtual.perfil);
  const chave_revisao = "intec_escala_revisao";
  const chave_lixo    = "intec_escala_lixo";

  // Próxima sexta-feira a partir de uma data
  // Retorna a sexta-feira da semana atual (seg-sex → sexta desta semana, sab-dom → sexta da próxima)
  const sextaFeiraAtual = () => {
    const d = new Date();
    const dow = d.getDay(); // 0=dom,1=seg...5=sex,6=sab
    let diff;
    if (dow === 5) diff = 0;       // hoje é sexta
    else if (dow === 6) diff = 6;  // sábado → próxima sexta
    else if (dow === 0) diff = 5;  // domingo → próxima sexta
    else diff = 5 - dow;           // seg(1)→4, ter(2)→3, qua(3)→2, qui(4)→1
    d.setDate(d.getDate() + diff);
    return d.toISOString().slice(0,10);
  };

  // Dado dataInicio (que deve ser uma sexta-feira), gera N semanas
  // O índice de cada semana é calculado pela distância em semanas a partir do dataInicio
  const gerarSemanas = (membros, dataInicio, n=16) => {
    if (!membros || membros.length === 0 || !dataInicio) return [];
    const ini = new Date(dataInicio+"T12:00:00");
    // Alinhar ini para sexta-feira caso não seja
    const dowIni = ini.getDay();
    if (dowIni !== 5) {
      const ajuste = dowIni < 5 ? (5-dowIni) : (5+(7-dowIni));
      ini.setDate(ini.getDate() + ajuste);
    }
    // Sexta atual
    const sextaHoje = sextaFeiraAtual();
    const sextaHojeD = new Date(sextaHoje+"T12:00:00");
    // Quantas semanas da ini até a sexta atual
    const diffSem = Math.round((sextaHojeD - ini) / (7*24*60*60*1000));
    // Gerar de 4 semanas atrás até n semanas à frente
    const semanas = [];
    for (let i = -4; i < n; i++) {
      const d = new Date(ini);
      d.setDate(ini.getDate() + ((diffSem + i) * 7));
      const idx = ((diffSem + i) % membros.length + membros.length) % membros.length;
      semanas.push({
        data:   d.toISOString().slice(0,10),
        membro: membros[idx],
        offset: i,
      });
    }
    return semanas;
  };

  // Estado das escalas salvo no localStorage
  const [revisao, setRevisao] = useState(() => {
    try {
      const s = localStorage.getItem(chave_revisao);
      if (s) return JSON.parse(s);
    } catch {}
    return {
      membros: ["Claudio","Vinicius","Leonardo","Heriston"],
      dataInicio: "2026-05-01",
    };
  });

  const [lixo, setLixo] = useState(() => {
    try {
      const s = localStorage.getItem(chave_lixo);
      if (s) return JSON.parse(s);
    } catch {}
    return {
      membros: ["Jonathan","Vinicius","Gustavo","Matheus","Leonardo","Marina","Pablo","Kelen"],
      dataInicio: "2026-05-15",
    };
  });

  const [abaE, setAbaE] = useState("revisao");
  const [editando, setEditando] = useState(false);
  const [novoMembro, setNovoMembro] = useState("");

  // Persistir no localStorage
  useEffect(()=>{ localStorage.setItem(chave_revisao, JSON.stringify(revisao)); }, [revisao]);
  useEffect(()=>{ localStorage.setItem(chave_lixo, JSON.stringify(lixo)); }, [lixo]);

  const escala = abaE==="revisao" ? revisao : lixo;
  const setEscala = abaE==="revisao" ? setRevisao : setLixo;
  const titulo = abaE==="revisao" ? "Revisão de Projetos" : "Coleta de Lixo";
  const icone  = abaE==="revisao" ? "🔍" : "🗑";

  const semanas = gerarSemanas(escala.membros, escala.dataInicio);
  const hoje = new Date().toISOString().slice(0,10);
  const sextaAtual = sextaFeiraAtual();
  // Semana atual = exatamente a sexta desta semana
  const semanaAtual = semanas.find(s => s.data === sextaAtual)
    || semanas.find(s => s.data > hoje)
    || semanas[semanas.length-1];

  const moverMembro = (idx, dir) => {
    const lista = [...escala.membros];
    const novo = idx + dir;
    if (novo < 0 || novo >= lista.length) return;
    [lista[idx], lista[novo]] = [lista[novo], lista[idx]];
    setEscala(e=>({...e, membros:lista}));
  };

  const removerMembro = (idx) => {
    setEscala(e=>({...e, membros: e.membros.filter((_,i)=>i!==idx)}));
  };

  const adicionarMembro = () => {
    if (!novoMembro.trim()) return;
    setEscala(e=>({...e, membros:[...e.membros, novoMembro.trim()]}));
    setNovoMembro("");
  };

  const nomesDia = ["Dom","Seg","Ter","Qua","Qui","Sex","Sáb"];

  return (
    <div style={{display:"flex",flexDirection:"column",gap:20}}>
      <Card style={{padding:16}}>
        <div style={{display:"flex",gap:12,alignItems:"center",flexWrap:"wrap"}}>
          <div style={{flex:1}}>
            <h2 style={{color:C.azulEscuro,margin:0,fontSize:16,fontWeight:700}}>📋 Escalas Semanais</h2>
            <p style={{color:C.cinzaClaro,fontSize:12,margin:"4px 0 0"}}>Rotatividade semanal de responsabilidades da equipe</p>
          </div>
          {isGestor&&<Btn onClick={()=>setEditando(!editando)} variant={editando?"verde":"secondary"} small>
            {editando?"✓ Concluir edição":"✏ Editar escalas"}
          </Btn>}
        </div>
        <div style={{display:"flex",gap:4,marginTop:14,borderBottom:`2px solid ${C.cinzaCard}`,paddingBottom:0}}>
          {[{id:"revisao",label:"🔍 Revisão de Projetos"},{id:"lixo",label:"🗑 Coleta de Lixo"}].map(t=>(
            <button key={t.id} onClick={()=>setAbaE(t.id)} style={{background:"none",border:"none",padding:"8px 16px",cursor:"pointer",fontSize:13,fontFamily:"inherit",fontWeight:abaE===t.id?700:500,color:abaE===t.id?C.azulMedio:C.cinzaClaro,borderBottom:abaE===t.id?`2px solid ${C.azulMedio}`:"2px solid transparent",marginBottom:-2,transition:"all 0.15s"}}>
              {t.label}
            </button>
          ))}
        </div>
      </Card>

      {/* Card da semana atual */}
      {semanaAtual&&(
        <Card style={{background:`linear-gradient(135deg,${C.azulEscuro},${C.azulMedio})`,border:"none",padding:24}}>
          <div style={{color:C.ciano,fontSize:11,fontWeight:700,letterSpacing:1,marginBottom:8}}>SEMANA ATUAL — {icone} {titulo.toUpperCase()}</div>
          <div style={{display:"flex",alignItems:"center",gap:16,flexWrap:"wrap"}}>
            <div style={{width:60,height:60,borderRadius:"50%",background:"rgba(255,255,255,0.15)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:28,fontWeight:900,color:C.branco,border:"3px solid rgba(255,255,255,0.3)"}}>
              {semanaAtual.membro.slice(0,2).toUpperCase()}
            </div>
            <div>
              <div style={{fontSize:26,fontWeight:900,color:C.branco}}>{semanaAtual.membro}</div>
              <div style={{fontSize:13,color:"rgba(255,255,255,0.7)",marginTop:2}}>
                Semana de {fmtData(semanaAtual.data)} (Sexta-feira)
              </div>
            </div>
            {escala.membros.length>1&&(()=>{
              const prox = semanas.find(s=>s.data>semanaAtual.data);
              return prox ? (
                <div style={{marginLeft:"auto",textAlign:"right"}}>
                  <div style={{fontSize:11,color:"rgba(255,255,255,0.6)"}}>Próxima semana</div>
                  <div style={{fontSize:16,fontWeight:700,color:C.ciano}}>{prox.membro}</div>
                  <div style={{fontSize:11,color:"rgba(255,255,255,0.5)"}}>{fmtData(prox.data)}</div>
                </div>
              ) : null;
            })()}
          </div>
        </Card>
      )}

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20}}>
        {/* Calendário das próximas semanas */}
        <Card>
          <h3 style={{color:C.azulEscuro,margin:"0 0 14px",fontSize:14,fontWeight:700}}>📅 Próximas Semanas</h3>
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            {semanas.map((s,i)=>{
              const passada  = s.data < hoje;
              const atual    = s.data === semanaAtual?.data;
              const idx      = i % escala.membros.length;
              const cor      = `hsl(${(idx*47)%360},60%,45%)`;
              return(
                <div key={s.data} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 12px",borderRadius:8,
                  background:atual?"#eff6ff":passada?"#f8fafc":"white",
                  border:`1px solid ${atual?C.azulMedio:C.cinzaCard}`,opacity:passada?0.5:1}}>
                  <div style={{minWidth:80,fontSize:12,fontWeight:atual?700:400,color:atual?C.azulMedio:C.cinzaClaro}}>
                    {fmtData(s.data)}
                    {atual&&<span style={{marginLeft:6,fontSize:10,background:C.azulMedio,color:"#fff",padding:"1px 5px",borderRadius:3,fontWeight:700}}>ESTA SEMANA</span>}
                    {passada&&!atual&&<span style={{marginLeft:6,fontSize:9,color:C.cinzaClaro}}>✓ passou</span>}
                  </div>
                  <div style={{width:28,height:28,borderRadius:"50%",background:cor,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:800,color:"#fff",flexShrink:0}}>
                    {s.membro.slice(0,2).toUpperCase()}
                  </div>
                  <span style={{fontSize:13,fontWeight:atual?700:400,color:atual?C.azulEscuro:C.cinzaEscuro}}>{s.membro}</span>
                </div>
              );
            })}
          </div>
        </Card>

        {/* Lista de membros + edição */}
        <div style={{display:"flex",flexDirection:"column",gap:14}}>
          <Card>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <h3 style={{color:C.azulEscuro,margin:0,fontSize:14,fontWeight:700}}>👥 Ordem da Escala</h3>
              <span style={{fontSize:11,color:C.cinzaClaro}}>{escala.membros.length} membro(s)</span>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {escala.membros.map((m,i)=>(
                <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",background:C.cinzaFundo,borderRadius:8}}>
                  <span style={{fontSize:11,fontWeight:700,color:C.cinzaClaro,minWidth:20}}>#{i+1}</span>
                  <span style={{flex:1,fontSize:13,fontWeight:600,color:C.cinzaEscuro}}>{m}</span>
                  {editando&&isGestor&&(
                    <div style={{display:"flex",gap:4}}>
                      <button onClick={()=>moverMembro(i,-1)} disabled={i===0}
                        style={{background:"none",border:"none",cursor:i===0?"not-allowed":"pointer",color:i===0?C.cinzaClaro:C.azulMedio,fontSize:14,padding:"0 4px"}}>↑</button>
                      <button onClick={()=>moverMembro(i,1)} disabled={i===escala.membros.length-1}
                        style={{background:"none",border:"none",cursor:i===escala.membros.length-1?"not-allowed":"pointer",color:i===escala.membros.length-1?C.cinzaClaro:C.azulMedio,fontSize:14,padding:"0 4px"}}>↓</button>
                      <button onClick={()=>removerMembro(i)}
                        style={{background:"none",border:"none",color:C.vermelho,cursor:"pointer",fontSize:14,padding:"0 4px"}}>🗑</button>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Adicionar membro */}
            {editando&&isGestor&&(
              <div style={{marginTop:10,display:"flex",gap:8}}>
                <input value={novoMembro} onChange={e=>setNovoMembro(e.target.value)}
                  onKeyDown={e=>{ if(e.key==="Enter") adicionarMembro(); }}
                  placeholder="Nome do membro..."
                  list="lista-usuarios-escala"
                  style={{flex:1,border:`1.5px solid ${C.cinzaCard}`,borderRadius:8,padding:"7px 10px",fontSize:13,fontFamily:"inherit"}}/>
                <datalist id="lista-usuarios-escala">
                  {usuarios.filter(u=>u.ativo).map(u=><option key={u.id} value={u.nome}/>)}
                </datalist>
                <Btn onClick={adicionarMembro} small disabled={!novoMembro.trim()}>+ Add</Btn>
              </div>
            )}
          </Card>

          {/* Data de início */}
          {editando&&isGestor&&(
            <Card>
              <h3 style={{color:C.azulEscuro,margin:"0 0 12px",fontSize:13,fontWeight:700}}>📅 Data de início da escala</h3>
              <Inp label="Primeira sexta-feira da escala" type="date" value={escala.dataInicio}
                onChange={v=>setEscala(e=>({...e,dataInicio:v}))}/>
              <p style={{fontSize:11,color:C.cinzaClaro,marginTop:6}}>
                A escala rotaciona a cada 7 dias a partir desta data.
              </p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function Configuracoes({usuarios,onSalvarUsuarios,usuarioAtual}){
  const [lista,setLista]=useState(usuarios);
  const [editId,setEditId]=useState(null);
  const [showForm,setShowForm]=useState(false);
  const VAZIO={id:"",nome:"",email:"",senha:"",salario:0,perfil:"colaborador",cor:"#2563a8",iniciais:"",ativo:true,expediente:expedientePadrao(),especialidades:[]};
  const [form,setForm]=useState(VAZIO);
  const sf=(k,v)=>setForm(f=>({...f,[k]:v}));
  const se=(k,v)=>setForm(f=>({...f,expediente:{...f.expediente,[k]:v}}));

  useEffect(()=>{ onSalvarUsuarios(lista); },[lista]);

  const salvarForm=()=>{
    if(!form.nome||!form.email||!form.senha) return;
    const id=form.id||form.nome.toLowerCase().replace(/\s+/g,".").normalize("NFD").replace(/[\u0300-\u036f]/g,"");
    const iniciais=form.iniciais||form.nome.split(" ").map(p=>p[0]).join("").substring(0,2).toUpperCase();
    const u={...form,id,iniciais};
    const nova=editId?lista.map(x=>x.id===editId?u:x):[...lista,u];
    setLista(nova);setShowForm(false);setEditId(null);setForm(VAZIO);
  };

  // Colaborador vê versão limitada
  if(usuarioAtual.perfil==="colaborador"){
    const eu = usuarios.find(u=>u.id===usuarioAtual.id)||usuarioAtual;
    return (
      <div style={{display:"flex",flexDirection:"column",gap:20}}>
        <Card>
          <h2 style={{color:C.azulEscuro,margin:"0 0 16px",fontSize:16,fontWeight:700}}>👤 Meu Perfil</h2>
          <div style={{display:"flex",alignItems:"center",gap:16,padding:"14px 16px",background:C.cinzaFundo,borderRadius:10,marginBottom:16}}>
            <Avatar u={eu} size={52}/>
            <div>
              <div style={{fontWeight:800,color:C.cinzaEscuro,fontSize:16}}>{eu.nome}</div>
              <div style={{fontSize:12,color:C.cinzaClaro}}>{eu.email}</div>
              <div style={{fontSize:11,color:C.cinzaClaro,marginTop:2}}>👤 Colaborador</div>
            </div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
            <div style={{padding:"12px 16px",background:C.cinzaFundo,borderRadius:10}}>
              <div style={{fontSize:11,fontWeight:700,color:C.cinzaEscuro,marginBottom:4}}>Turno 1 — Manhã</div>
              <div style={{fontSize:18,fontWeight:800,color:C.azulMedio}}>
                {eu.expediente?.turno1?.inicio||eu.expediente?.inicio||"09:00"} – {eu.expediente?.turno1?.fim||eu.expediente?.fim||"12:00"}
              </div>
            </div>
            {eu.expediente?.turno2?.ativo
              ? <div style={{padding:"12px 16px",background:C.cinzaFundo,borderRadius:10}}>
                  <div style={{fontSize:11,fontWeight:700,color:C.cinzaEscuro,marginBottom:4}}>Turno 2 — Tarde</div>
                  <div style={{fontSize:18,fontWeight:800,color:C.azulMedio}}>{eu.expediente.turno2.inicio} – {eu.expediente.turno2.fim}</div>
                  <div style={{fontSize:11,color:C.cinzaClaro,marginTop:3}}>
                    {eu.expediente.modo==="OU"?"🔀 Trabalha 1 turno/dia (flexível)":"🔁 Trabalha os 2 turnos"}
                  </div>
                </div>
              : <div style={{padding:"12px 16px",background:C.cinzaFundo,borderRadius:10}}>
                  <div style={{fontSize:11,fontWeight:700,color:C.cinzaEscuro,marginBottom:4}}>Turno 2</div>
                  <div style={{fontSize:14,color:C.cinzaClaro}}>Somente 1 turno</div>
                </div>
            }
            <div style={{padding:"12px 16px",background:C.azulEscuro,borderRadius:10}}>
              <div style={{fontSize:11,fontWeight:700,color:C.ciano,marginBottom:4}}>Meta Diária</div>
              <div style={{fontSize:22,fontWeight:800,color:C.branco}}>{calcHorasDia(eu.expediente)}h</div>
              <div style={{fontSize:10,color:"rgba(255,255,255,0.6)"}}>{labelModoExpediente(eu.expediente)||"por dia"}</div>
            </div>
            <div style={{padding:"12px 16px",background:C.cinzaFundo,borderRadius:10,gridColumn:"1/-1"}}>
              <div style={{fontSize:11,fontWeight:700,color:C.cinzaEscuro,marginBottom:4}}>Especialidades</div>
              <div style={{display:"flex",gap:6,flexWrap:"wrap",marginTop:4}}>
                {(eu.especialidades||[]).map(e=><span key={e} style={{background:C.azulEscuro,color:C.ciano,padding:"2px 8px",borderRadius:4,fontSize:11,fontWeight:800}}>{e}</span>)}
              </div>
            </div>
          </div>
        </Card>
        <Card>
          <h2 style={{color:C.azulEscuro,margin:"0 0 16px",fontSize:16,fontWeight:700}}>⚙ Informações do Sistema</h2>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
            {[
              {label:"Verificação de atividade", valor:"A cada 30 minutos",    sub:"Aviso automático de inatividade"},
              {label:"Expediente",               valor:labelExpediente(eu.expediente), sub:`${calcHorasDia(eu.expediente)}h por dia útil`},
              {label:"Encerramento automático",  valor:"5 min após expediente", sub:"Se sessão ainda estiver aberta"},
              {label:"Versão",                   valor:"INTEC v2.0",            sub:"Com Supabase + Realtime"},
            ].map(i=>(
              <div key={i.label} style={{padding:"12px 16px",background:C.cinzaFundo,borderRadius:10}}>
                <div style={{fontSize:11,fontWeight:700,color:C.cinzaEscuro,marginBottom:2}}>{i.label}</div>
                <div style={{fontSize:13,fontWeight:700,color:C.azulMedio}}>{i.valor}</div>
                <div style={{fontSize:11,color:C.cinzaClaro,marginTop:2}}>{i.sub}</div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    );
  }

  const cores=["#2563a8","#7c3aed","#0891b2","#059669","#d97706","#dc2626","#db2777","#4f46e5","#0f766e","#9333ea"];

  return(
    <div style={{display:"flex",flexDirection:"column",gap:20}}>
      <Card>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
          <div>
            <h2 style={{color:C.azulEscuro,margin:0,fontSize:16,fontWeight:700}}>👥 Colaboradores</h2>
            <p style={{color:C.cinzaClaro,fontSize:12,margin:"4px 0 0"}}>{lista.filter(u=>u.ativo).length} ativo(s)</p>
          </div>
          <Btn onClick={()=>{setForm(VAZIO);setEditId(null);setShowForm(true);}}>+ Novo Colaborador</Btn>
        </div>

        {showForm&&(
          <div style={{background:C.cinzaFundo,borderRadius:12,padding:20,marginBottom:20,border:`2px solid ${C.azulClaro}`}}>
            <h3 style={{color:C.azulEscuro,margin:"0 0 16px",fontSize:14}}>{editId?"✏ Editar":"➕ Novo"} Colaborador</h3>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              <Inp label="Nome completo *" value={form.nome} onChange={v=>sf("nome",v)}/>
              <Inp label="Email" value={form.email} onChange={v=>sf("email",v)} type="email"/>
              <Inp label="Senha *" value={form.senha} onChange={v=>sf("senha",v)} type="password"/>
              <Inp label="Salario Mensal (R$)" value={form.salario||""} onChange={v=>sf("salario",parseFloat(v)||0)} type="number" placeholder="Ex: 3500"/>
              <Sel label="Perfil" value={form.perfil} onChange={v=>sf("perfil",v)} options={[{value:"colaborador",label:"👤 Colaborador"},{value:"gestor",label:"🔑 Gestor"},{value:"admin",label:"👑 Admin"}]}/>
              {/* Expediente por dia da semana */}
              <div style={{gridColumn:"1/-1"}}>
                <label style={{fontSize:12,fontWeight:600,color:C.cinzaEscuro,display:"block",marginBottom:4}}>
                  Horário por Dia da Semana
                  <span style={{fontSize:11,color:C.cinzaClaro,fontWeight:400,marginLeft:8}}>
                    Total: {calcHorasSemanais(form.expediente)}h/semana • {calcHorasDia(form.expediente)}h/dia (média)
                  </span>
                </label>
                <div style={{display:"flex",flexDirection:"column",gap:8}}>
                  {["segunda","terca","quarta","quinta","sexta","sabado","domingo"].map((dia,idx)=>{
                    const exp    = form.expediente?.[dia] || {ativo:false,turno1:{inicio:"09:00",fim:"12:00"},turno2:{ativo:false,inicio:"14:00",fim:"18:00"},modo:"E"};
                    const modo   = exp.modo || "E";
                    const setDia = (campo,val) => setForm(f=>({...f,expediente:{...f.expediente,[dia]:{...exp,[campo]:val}}}));
                    const setT1  = (campo,val) => setForm(f=>({...f,expediente:{...f.expediente,[dia]:{...exp,turno1:{...exp.turno1,[campo]:val}}}}));
                    const setT2  = (campo,val) => setForm(f=>({...f,expediente:{...f.expediente,[dia]:{...exp,turno2:{...exp.turno2,[campo]:val}}}}));
                    const setModo= (val)       => setForm(f=>({...f,expediente:{...f.expediente,[dia]:{...exp,modo:val}}}));
                    const hDia   = calcHorasDiaSemana(exp);
                    const h1 = exp.turno1?.inicio&&exp.turno1?.fim ? Math.max(0,(horaMin(exp.turno1.fim)-horaMin(exp.turno1.inicio))/60) : 0;
                    const h2 = exp.turno2?.ativo&&exp.turno2?.inicio&&exp.turno2?.fim ? Math.max(0,(horaMin(exp.turno2.fim)-horaMin(exp.turno2.inicio))/60) : 0;
                    return (
                      <div key={dia} style={{border:`1.5px solid ${exp.ativo?C.azulClaro:C.cinzaCard}`,borderRadius:10,padding:"10px 14px",background:exp.ativo?"#f0f9ff":"#f8fafc",transition:"all 0.15s"}}>
                        {/* Cabeçalho do dia */}
                        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:exp.ativo?10:0}}>
                          <input type="checkbox" checked={!!exp.ativo} onChange={e=>setDia("ativo",e.target.checked)} style={{width:15,height:15,cursor:"pointer"}}/>
                          <span style={{fontSize:13,fontWeight:700,color:exp.ativo?C.azulMedio:C.cinzaClaro,minWidth:70}}>{DIAS_LABEL[idx]}</span>
                          {exp.ativo&&<span style={{fontSize:12,color:C.verde,fontWeight:700}}>{hDia}h/dia</span>}
                          {exp.ativo&&exp.turno2?.ativo&&(
                            <span style={{marginLeft:"auto",fontSize:10,background:modo==="OU"?"#fff7ed":"#eff6ff",color:modo==="OU"?"#c2410c":C.azulMedio,padding:"2px 8px",borderRadius:4,fontWeight:700,border:`1px solid ${modo==="OU"?"#fed7aa":"#bfdbfe"}`}}>
                              {modo==="OU"?"🔀 OU":"🔁 E"}
                            </span>
                          )}
                          {!exp.ativo&&<span style={{fontSize:11,color:C.cinzaClaro}}>Não trabalha</span>}
                        </div>

                        {exp.ativo&&(
                          <div style={{display:"flex",flexDirection:"column",gap:8}}>
                            {/* Turno 1 — manhã */}
                            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                              <Inp label="Manhã — entrada" value={exp.turno1?.inicio||""} onChange={v=>setT1("inicio",v)} type="time"/>
                              <Inp label="Manhã — saída"   value={exp.turno1?.fim||""}   onChange={v=>setT1("fim",v)}   type="time"/>
                            </div>

                            {/* Turno 2 — tarde */}
                            <div style={{background:"#f8fafc",borderRadius:8,padding:"8px 10px",border:`1px solid ${exp.turno2?.ativo?C.azulClaro:C.cinzaCard}`}}>
                              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:exp.turno2?.ativo?8:0}}>
                                <input type="checkbox" checked={!!exp.turno2?.ativo} onChange={e=>setT2("ativo",e.target.checked)} style={{cursor:"pointer"}}/>
                                <label style={{fontSize:12,fontWeight:600,color:exp.turno2?.ativo?C.azulMedio:C.cinzaClaro,cursor:"pointer"}}>
                                  {exp.turno2?.ativo?"✓ Tarde ativo":"+ Adicionar turno tarde"}
                                </label>
                                {exp.turno2?.ativo&&h2>0&&<span style={{fontSize:11,color:C.cinzaClaro}}>{h2.toFixed(1)}h</span>}
                              </div>

                              {exp.turno2?.ativo&&(<>
                                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
                                  <Inp label="Tarde — entrada" value={exp.turno2?.inicio||""} onChange={v=>setT2("inicio",v)} type="time"/>
                                  <Inp label="Tarde — saída"   value={exp.turno2?.fim||""}   onChange={v=>setT2("fim",v)}   type="time"/>
                                </div>

                                {/* Seletor E / OU */}
                                <div style={{display:"flex",gap:6}}>
                                  {[
                                    {val:"E",  label:"🔁 Manhã E Tarde",  sub:`${(h1+h2).toFixed(1)}h/dia contabilizadas`},
                                    {val:"OU", label:"🔀 Manhã OU Tarde", sub:`${Math.max(h1,h2).toFixed(1)}h/dia (flexível)`},
                                  ].map(opt=>(
                                    <div key={opt.val} onClick={()=>setModo(opt.val)}
                                      style={{flex:1,padding:"7px 10px",borderRadius:8,border:`2px solid ${modo===opt.val?C.azulMedio:C.cinzaCard}`,background:modo===opt.val?C.azulEscuro:"white",cursor:"pointer",transition:"all 0.15s",textAlign:"center"}}>
                                      <div style={{fontSize:12,fontWeight:700,color:modo===opt.val?C.branco:C.cinzaEscuro}}>{opt.label}</div>
                                      <div style={{fontSize:10,color:modo===opt.val?C.ciano:C.cinzaClaro,marginTop:2}}>{opt.sub}</div>
                                    </div>
                                  ))}
                                </div>
                                {modo==="OU"&&(
                                  <div style={{marginTop:6,padding:"5px 8px",background:"#fffbeb",borderRadius:6,fontSize:11,color:"#92400e"}}>
                                    ℹ️ Conta apenas 1 turno por dia na meta — aceita registro em qualquer um
                                  </div>
                                )}
                              </>)}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div style={{gridColumn:"1/-1"}}>
                <label style={{fontSize:12,fontWeight:600,color:C.cinzaEscuro,display:"block",marginBottom:6}}>Cor do avatar</label>
                <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                  {cores.map(cor=><div key={cor} onClick={()=>sf("cor",cor)} style={{width:28,height:28,borderRadius:"50%",background:cor,cursor:"pointer",border:form.cor===cor?`3px solid ${C.cinzaEscuro}`:"3px solid transparent",transition:"all 0.15s"}}/>)}
                </div>
              </div>
              <div style={{gridColumn:"1/-1"}}>
                <label style={{fontSize:12,fontWeight:600,color:C.cinzaEscuro,display:"block",marginBottom:8}}>Especialidades (projetos que atua)</label>
                <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                  {Object.entries(TIPOS).map(([k,v])=>{
                    const ativo=(form.especialidades||[]).includes(k);
                    return <div key={k} onClick={()=>{const atual=form.especialidades||[];sf("especialidades",ativo?atual.filter(x=>x!==k):[...atual,k]);}} style={{padding:"4px 10px",borderRadius:6,border:`1.5px solid ${ativo?C.azulMedio:C.cinzaCard}`,background:ativo?C.azulEscuro:"transparent",color:ativo?C.ciano:C.cinzaClaro,fontSize:11,fontWeight:700,cursor:"pointer",transition:"all 0.15s"}}>{k}</div>;
                  })}
                </div>
              </div>
            </div>
            <div style={{display:"flex",gap:10,marginTop:16,justifyContent:"flex-end"}}>
              <Btn variant="ghost" onClick={()=>{setShowForm(false);setEditId(null);}}>Cancelar</Btn>
              <Btn onClick={salvarForm}>💾 Salvar</Btn>
            </div>
          </div>
        )}

        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {lista.map(u=>(
            <div key={u.id} style={{display:"flex",alignItems:"center",gap:14,padding:"12px 16px",borderRadius:10,border:`1.5px solid ${C.cinzaCard}`,opacity:u.ativo?1:0.55}}>
              <Avatar u={u} size={42}/>
              <div style={{flex:1}}>
                <div style={{fontWeight:700,color:C.cinzaEscuro}}>{u.nome}</div>
                <div style={{fontSize:11,color:C.cinzaClaro,marginTop:2}}>
                    {u.email} • {u.perfil==="admin"?"👑 Admin":u.perfil==="gestor"?"🔑 Gestor":"👤 Colaborador"} •{" "}
                    ⏰ {labelExpediente(u.expediente)} ({calcHorasDia(u.expediente)}h/dia)
                    {u.expediente?.turno2?.ativo&&<span style={{marginLeft:6,fontSize:10,background:u.expediente.modo==="OU"?"#fff7ed":"#eff6ff",color:u.expediente.modo==="OU"?"#c2410c":C.azulMedio,padding:"1px 6px",borderRadius:4,fontWeight:700}}>{u.expediente.modo==="OU"?"🔀 OU":"🔁 E"}</span>}
                  </div>
                  {(u.especialidades||[]).length>0&&<div style={{display:"flex",gap:4,marginTop:4,flexWrap:"wrap"}}>{(u.especialidades||[]).map(e=><span key={e} style={{background:C.azulEscuro,color:C.ciano,padding:"1px 6px",borderRadius:3,fontSize:9,fontWeight:800}}>{e}</span>)}</div>}
              </div>
              <div style={{display:"flex",gap:8}}>
                <Btn onClick={()=>{setForm({...u});setEditId(u.id);setShowForm(true);}} variant="ghost" small>✏</Btn>
                {u.id!==usuarioAtual.id&&<Btn onClick={()=>setLista(l=>l.map(x=>x.id===u.id?{...x,ativo:!x.ativo}:x))} variant={u.ativo?"danger":"verde"} small>{u.ativo?"Desativar":"Ativar"}</Btn>}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <h2 style={{color:C.azulEscuro,margin:"0 0 16px",fontSize:16,fontWeight:700}}>⚙ Informações do Sistema</h2>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
          {[
            {label:"Verificação de atividade", valor:"A cada 30 minutos",        sub:"Aviso automático de inatividade"},
            {label:"Drive raiz",               valor:"ENGENHARIA INTEGRADA",     sub:`ID: ${DRIVE_ROOT_ID.substring(0,18)}...`},
            {label:"Encerramento automático",  valor:"5 min após fim do expediente", sub:"Se sessão ainda estiver aberta"},
            {label:"Banco de dados",           valor:"Supabase (PostgreSQL)",    sub:"Dados sincronizados em tempo real"},
          ].map(i=>(
            <div key={i.label} style={{padding:"14px 16px",background:C.cinzaFundo,borderRadius:10}}>
              <div style={{fontSize:11,fontWeight:700,color:C.cinzaEscuro,marginBottom:2}}>{i.label}</div>
              <div style={{fontSize:14,fontWeight:700,color:C.azulMedio}}>{i.valor}</div>
              <div style={{fontSize:11,color:C.cinzaClaro,marginTop:2}}>{i.sub}</div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

// ─── PAINEL DRIVE ──────────────────────────────────────────────────────────────
function PainelDrive({drive,projetosExistentes,onImportar}){
  const [pastasNovo,setPN]=useState([]);
  const [sel,setSel]=useState({});
  const [sync,setSync]=useState(false);
  const [jaExistem,setJE]=useState(0);

  const sincronizar=async()=>{
    const todos=await drive.buscarProjetos();
    const ids=new Set(projetosExistentes.map(p=>p.id));
    const cods=new Set(projetosExistentes.map(p=>p.codigo?.trim().toUpperCase()));
    const novos=todos.filter(p=>!ids.has(p.id)&&!cods.has(p.codigo?.trim().toUpperCase()));
    const existem=todos.filter(p=>ids.has(p.id)||cods.has(p.codigo?.trim().toUpperCase()));
    setPN(novos);setJE(existem.length);setSync(true);
    const s={};novos.forEach(p=>s[p.id]=true);setSel(s);
  };

  const qtd=Object.values(sel).filter(Boolean).length;

  return(
    <Card style={{borderLeft:`4px solid ${C.ciano}`}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:10}}>
        <div>
          <h3 style={{color:C.azulEscuro,margin:0,fontSize:15,fontWeight:700}}>☁ Integração Google Drive</h3>
          <p style={{color:C.cinzaClaro,fontSize:12,margin:"4px 0 0"}}>{drive.logado?"✅ Conectado — ENGENHARIA INTEGRADA":"Conecte para importar projetos do Drive"}</p>
        </div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          {!drive.logado
            ?<Btn onClick={drive.login} variant="ciano" disabled={!drive.gapiReady||!drive.gisReady}>{(!drive.gapiReady||!drive.gisReady)?"⏳ Carregando...":"🔐 Conectar ao Drive"}</Btn>
            :<><Btn onClick={sincronizar} variant="ciano" disabled={drive.carregando}>{drive.carregando?"⏳ Sincronizando...":"🔄 Sincronizar Pastas"}</Btn><Btn onClick={drive.logout} variant="ghost" small>Desconectar</Btn></>}
        </div>
      </div>
      {drive.erro&&<div style={{padding:"10px 14px",background:"#fef2f2",border:"1px solid #fecaca",borderRadius:8,fontSize:13,color:C.vermelho,marginBottom:12}}>⚠ {drive.erro}</div>}
      {sync&&!drive.carregando&&(
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {jaExistem>0&&<div style={{padding:"10px 14px",background:"#eff6ff",border:"1px solid #bfdbfe",borderRadius:8,fontSize:13,color:"#1d4ed8"}}>ℹ️ <strong>{jaExistem}</strong> pasta(s) já cadastrada(s) foram ignoradas.</div>}
          {pastasNovo.length===0&&<div style={{padding:"10px 14px",background:"#f0fdf4",border:"1px solid #86efac",borderRadius:8,fontSize:13,color:"#166534"}}>✅ Tudo sincronizado! Nenhuma pasta nova.</div>}
        </div>
      )}
      {pastasNovo.length>0&&(
        <div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
            <span style={{fontSize:13,fontWeight:600,color:C.cinzaEscuro}}>{pastasNovo.length} pasta(s) nova(s):</span>
            <Btn onClick={()=>{onImportar(pastasNovo.filter(p=>sel[p.id]));setPN([]);setSync(false);}} variant="verde" small disabled={qtd===0}>⬇ Importar {qtd}</Btn>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:6,maxHeight:280,overflowY:"auto"}}>
            {pastasNovo.map(p=>(
              <div key={p.id} onClick={()=>setSel(s=>({...s,[p.id]:!s[p.id]}))} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 12px",background:sel[p.id]?"#f0f9ff":"#f8fafc",borderRadius:8,border:`1px solid ${sel[p.id]?C.azulClaro:C.cinzaCard}`,cursor:"pointer"}}>
                <input type="checkbox" checked={!!sel[p.id]} onChange={()=>setSel(s=>({...s,[p.id]:!s[p.id]}))} onClick={e=>e.stopPropagation()} style={{width:15,height:15}}/>
                <TipoBadge tipo={p.tipo}/><span style={{fontSize:12,fontWeight:600,color:C.azulMedio,minWidth:100}}>{p.codigo}</span>
                <span style={{fontSize:12,color:C.cinzaEscuro,flex:1}}>{p.cliente}</span>
                <span style={{fontSize:11,color:C.cinzaClaro}}>{p.ano}</span>
                {p.driveUrl&&<a href={p.driveUrl} target="_blank" rel="noreferrer" onClick={e=>e.stopPropagation()} style={{fontSize:11,color:C.azulClaro,textDecoration:"none"}}>📂</a>}
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

// ─── MODAL PROJETO ─────────────────────────────────────────────────────────────
function ModalProjeto({projeto,onClose,onSave,onExcluir,modo,usuarios=[]}){
  const [form,setForm]=useState(()=>{
    const base = {
      id:"", codigo:"", cliente:"", responsavel:"", coresponsavel:"",
      coresponsavel2:"", coresponsavel3:"",
      ano:new Date().getFullYear(), tipo:"PE", status:"Novo/Definir",
      prazo:0, dataContrato:"", dataEntregaPrevista:"", dataEntregaReal:"",
      obs:"", temContrato:false, parcelas:[], driveUrl:"", driveEntregaveis:"", statusAuto:true, pausas:[], disciplinas:[], revisaoMandado:false, revisaoFeita:false, revisaoCorrigida:false, revisaoResponsavel:"",
    };
    if(!projeto) return base;
    // Spread do projeto e garantir campos do portal
    return {
      ...base,
      ...projeto,
      // Portal — garantir que vieram do banco
      token_cliente:      projeto.token_cliente      || "",
      link_cliente_ativo: projeto.link_cliente_ativo || false,
      linkClienteAtivo:   projeto.link_cliente_ativo || false,
      progresso:          projeto.progresso          ?? 0,
      obs_cliente:        projeto.obs_cliente        || "",
      obsCliente:         projeto.obs_cliente        || "",
    };
  });
  const [abaModal, setAbaModal] = useState("info"); // info | financeiro | portal
  const [atualizacoes, setAtualizacoes] = useState([]);
  const [carregandoAtu, setCarregandoAtu] = useState(false);
  const [novaAtu, setNovaAtu] = useState({ titulo:"", descricao:"", icone:"📝", tipo:"manual", visivelCliente:true });
  const [gerandoLink, setGerandoLink] = useState(false);
  const [copiado, setCopiado] = useState(false);

  // Carregar atualizações ao abrir projeto existente
  useEffect(() => {
    if (modo !== "editar" || !projeto?.id) return;
    setCarregandoAtu(true);
    Promise.all([
      portal.listarAtualizacoes(projeto.id),
      db.sessoes.listar().then(s => s.filter(x => x.projetoId===projeto.id && x.horaFim)),
    ]).then(([manuais, sessoesProjeto]) => {
      // Converter sessões para formato de atualização
      const sessaoItems = sessoesProjeto.map(s => {
        const u = usuarios?.find(x=>x.id===s.usuarioId);
        const nome = u?.nome || 'Equipe INTEC';
        const durMin = s.duracaoMin||0;
        const h=Math.floor(durMin/60), m=durMin%60;
        const durStr = durMin>0 ? (h>0?`${h}h ${m}min`:`${m}min`) : '';
        return {
          id:              s.id,
          tipo:            'sessao',
          titulo:          `Trabalho realizado por ${nome}`,
          descricao:       `${s.data?new Date(s.data+'T12:00:00').toLocaleDateString('pt-BR'):''} ${durStr?'('+durStr+')':''} ${s.obs?'— '+s.obs:''}`.trim(),
          autor_nome:      nome,
          icone:           '⚙️',
          visivel_cliente: s.visivel_cliente !== false,
          created_at:      s.inicioTs ? new Date(s.inicioTs).toISOString() : (s.data+'T'+(s.horaInicio||'00:00')+':00'),
          origem:          'sessao',
          sessaoId:        s.id,
        };
      });
      // Unir e ordenar por data
      const todos = [...manuais.map(x=>({...x,origem:'manual'})), ...sessaoItems]
        .sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
      setAtualizacoes(todos);
    }).catch(()=>{})
    .finally(()=>setCarregandoAtu(false));
  }, [projeto?.id]);

  const gerarLink = async () => {
    if (!form.id) return;
    setGerandoLink(true);
    try {
      const token = await portal.gerarToken(form.id);
      setForm(f=>({...f, tokenCliente:token, linkClienteAtivo:true}));
    } catch(e){ console.error(e); }
    finally{ setGerandoLink(false); }
  };

  const toggleLink = async (ativo) => {
    if (!form.id) return;
    await portal.setLinkAtivo(form.id, ativo);
    setForm(f=>({...f, linkClienteAtivo:ativo}));
  };

  const adicionarAtu = async () => {
    if (!novaAtu.titulo || !form.id) return;
    const atu = await portal.adicionarAtualizacao(form.id, {
      ...novaAtu, autorId: null, autorNome: "Equipe INTEC"
    });
    setAtualizacoes(a=>[atu,...a]);
    setNovaAtu({ titulo:"", descricao:"", icone:"📝", tipo:"manual", visivelCliente:true });
  };

  const excluirAtu = async (id) => {
    if (!window.confirm("Excluir esta atualização?")) return;
    await portal.excluirAtualizacao(id);
    setAtualizacoes(a=>a.filter(x=>x.id!==id));
  };

  const copiarLink = () => {
    const url = `${window.location.origin}/cliente/${form.tokenCliente||form.token_cliente}`;
    navigator.clipboard.writeText(url);
    setCopiado(true); setTimeout(()=>setCopiado(false),2000);
  };

  const ICONES_ATU = ["📝","✅","⚠️","🔄","📐","🏗️","🔍","📦","⏸️","▶️","📞","💬","🎯","⚡"];

  // Calcula data de entrega prevista automaticamente ao mudar contrato ou prazo
  // Calcula total de dias úteis em pausas
  const calcDiasPausados = (pausas) => {
    if (!pausas || pausas.length === 0) return 0;
    let total = 0;
    pausas.forEach(p => {
      if (!p.inicio) return;
      const fim   = p.fim ? new Date(p.fim + "T12:00:00") : new Date();
      const ini   = new Date(p.inicio + "T12:00:00");
      let d = new Date(ini);
      while (d <= fim) {
        const dow = d.getDay();
        if (dow !== 0 && dow !== 6) total++;
        d.setDate(d.getDate() + 1);
      }
    });
    return total;
  };

  const calcularEntregaPrevista = (dataContrato, prazo, pausas) => {
    if (!dataContrato || !prazo || prazo <= 0) return "";
    const diasPausados = calcDiasPausados(pausas || form.pausas || []);
    const prazoTotal   = prazo + diasPausados;
    const d = new Date(dataContrato + "T12:00:00");
    let diasUteis = 0;
    while (diasUteis < prazoTotal) {
      d.setDate(d.getDate() + 1);
      const dow = d.getDay();
      if (dow !== 0 && dow !== 6) diasUteis++;
    }
    return d.toISOString().slice(0,10);
  };

  const setContrato = (v) => {
    const nova = calcularEntregaPrevista(v, form.prazo, form.pausas);
    setForm(f=>({...f, dataContrato:v, dataEntregaPrevista: nova || f.dataEntregaPrevista}));
  };
  const setPrazo = (v) => {
    const p = parseInt(v)||0;
    const nova = calcularEntregaPrevista(form.dataContrato, p, form.pausas);
    setForm(f=>({...f, prazo:p, dataEntregaPrevista: nova || f.dataEntregaPrevista}));
  };

  // Adiciona uma pausa e recalcula a entrega
  const adicionarPausa = (pausa) => {
    const novasPausas = [...(form.pausas||[]), pausa];
    const nova = calcularEntregaPrevista(form.dataContrato, form.prazo, novasPausas);
    setForm(f=>({...f, pausas:novasPausas, dataEntregaPrevista: nova || f.dataEntregaPrevista}));
  };

  const removerPausa = (idx) => {
    const novasPausas = (form.pausas||[]).filter((_,i)=>i!==idx);
    const nova = calcularEntregaPrevista(form.dataContrato, form.prazo, novasPausas);
    setForm(f=>({...f, pausas:novasPausas, dataEntregaPrevista: nova || f.dataEntregaPrevista}));
  };

  const [retornandoIdx, setRetornandoIdx] = useState(null);
  const [dataRetorno, setDataRetorno]       = useState("");

  const confirmarRetorno = (idx) => {
    const data = dataRetorno || new Date().toISOString().slice(0,10);
    const novasPausas = (form.pausas||[]).map((p,i)=> i===idx ? {...p, fim:data} : p);
    const nova = calcularEntregaPrevista(form.dataContrato, form.prazo, novasPausas);
    setForm(f=>({...f, pausas:novasPausas, dataEntregaPrevista: nova || f.dataEntregaPrevista,
      status: f.statusAuto ? "Em andamento" : f.status}));
    setRetornandoIdx(null);
    setDataRetorno("");
  };

  const [novaPausa, setNovaPausa] = useState({inicio:"", motivo:""});
  const [np,setNp]=useState({desc:"",valor:"",pago:false});
  const s=(k,v)=>setForm(f=>({...f,[k]:v}));
  const addP=()=>{if(!np.desc||!np.valor)return;s("parcelas",[...(form.parcelas||[]),{...np,valor:parseFloat(np.valor)}]);setNp({desc:"",valor:"",pago:false});};
  const togP=i=>{const p=[...form.parcelas];p[i]={...p[i],pago:!p[i].pago};s("parcelas",p);};
  const delP=i=>s("parcelas",form.parcelas.filter((_,x)=>x!==i));
  const rec=(form.parcelas||[]).reduce((a,p)=>a+(p.pago?p.valor:0),0);
  const pend=(form.parcelas||[]).reduce((a,p)=>a+(!p.pago?p.valor:0),0);
  return(
    <div style={{position:"fixed",inset:0,background:"rgba(15,25,50,0.7)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
      <div style={{background:C.branco,borderRadius:16,width:"100%",maxWidth:700,maxHeight:"90vh",overflow:"auto",boxShadow:"0 20px 60px rgba(0,0,0,0.3)"}} onClick={e=>e.stopPropagation()}>
        <div style={{background:`linear-gradient(135deg,${C.azulEscuro},${C.azulMedio})`,padding:"20px 24px",borderRadius:"16px 16px 0 0",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div><div style={{color:C.ciano,fontSize:11,fontWeight:700,letterSpacing:1,marginBottom:4}}>INTEC ENGENHARIA INTEGRADA</div><h2 style={{color:C.branco,margin:0,fontSize:18}}>{modo==="novo"?"Novo Projeto":"Editar Projeto"}</h2></div>
          <button onClick={onClose} style={{background:"rgba(255,255,255,0.15)",border:"none",color:C.branco,borderRadius:8,width:32,height:32,cursor:"pointer",fontSize:18,display:"flex",alignItems:"center",justifyContent:"center"}}>×</button>
        </div>
        {/* Sub-abas do modal */}
        <div style={{display:"flex",gap:0,borderBottom:`2px solid ${C.cinzaCard}`}}>
          {[{id:"info",label:"📋 Projeto"},{id:"execucao",label:"🔍 Revisões"},{id:"financeiro",label:"💰 Financeiro"},{id:"portal",label:"🔗 Portal Cliente"}].map(t=>(
            <button key={t.id} onClick={()=>setAbaModal(t.id)} style={{background:"none",border:"none",padding:"12px 18px",cursor:"pointer",fontSize:13,fontFamily:"inherit",fontWeight:abaModal===t.id?700:500,color:abaModal===t.id?C.azulMedio:C.cinzaClaro,borderBottom:abaModal===t.id?`2px solid ${C.azulMedio}`:"2px solid transparent",marginBottom:-2,transition:"all 0.15s"}}>
              {t.label}
            </button>
          ))}
        </div>

        <div style={{padding:24,display:"flex",flexDirection:"column",gap:20}}>
        {/* ─── ABA INFO ─── */}
        {abaModal==="info" && <>
          <div>
            <h3 style={{color:C.azulEscuro,fontSize:13,fontWeight:700,margin:"0 0 12px",textTransform:"uppercase",letterSpacing:1}}>📁 Identificação</h3>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              <Inp label={`Código *${form._doDrive?" (não editável)":""}`} value={form.codigo} onChange={v=>s("codigo",v)} required readOnly={!!form._doDrive}/>
              <Sel label="Tipo" value={form.tipo} onChange={v=>s("tipo",v)} options={Object.entries(TIPOS).map(([k,v])=>({value:k,label:`${k} – ${v}`}))}/>
              <div style={{gridColumn:"1/-1"}}><Inp label={`Cliente / Projeto *${form._doDrive?" (importado do Drive — não editável)":""}`} value={form.cliente} onChange={v=>s("cliente",v)} required readOnly={!!form._doDrive}/></div>
              {form._doDrive ? <div style={{display:"flex",flexDirection:"column",gap:4}}><label style={{fontSize:12,fontWeight:600,color:C.cinzaEscuro}}>Ano</label><input value={form.ano} readOnly style={{border:`1.5px solid ${C.cinzaCard}`,borderRadius:8,padding:"8px 12px",fontSize:14,background:"#f8fafc",cursor:"not-allowed",color:C.cinzaClaro}}/></div> : <Sel label="Ano" value={form.ano} onChange={v=>s("ano",parseInt(v))} options={[2024,2025,2026,2027].map(y=>({value:y,label:y}))}/>}
              <div style={{display:"flex",flexDirection:"column",gap:4}}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                  <label style={{fontSize:12,fontWeight:600,color:C.cinzaEscuro}}>Status</label>
                  <div style={{display:"flex",alignItems:"center",gap:5,marginLeft:"auto"}}>
                    <input type="checkbox" id="statusAuto" checked={!!form.statusAuto} onChange={e=>{ const v=e.target.checked; s("statusAuto",v); if(v) s("status",calcStatusAuto(form)); }} style={{cursor:"pointer"}}/>
                    <label htmlFor="statusAuto" style={{fontSize:11,color:form.statusAuto?C.verde:C.cinzaClaro,cursor:"pointer",fontWeight:600}}>
                      {form.statusAuto?"⚡ Automático":"✋ Manual"}
                    </label>
                  </div>
                </div>
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  <select value={form.status} onChange={v=>{ s("status",v.target.value); s("statusAuto",false); }}
                    disabled={!!form.statusAuto}
                    style={{flex:1,border:`1.5px solid ${form.statusAuto?C.cinzaCard:C.cinzaCard}`,borderRadius:8,padding:"8px 12px",fontSize:13,fontFamily:"inherit",cursor:form.statusAuto?"not-allowed":"pointer",background:form.statusAuto?"#f8fafc":C.branco,color:C.cinzaEscuro}}>
                    {Object.keys(STATUS_CONFIG).map(k=><option key={k} value={k}>{k}</option>)}
                  </select>
                  {form.statusAuto&&<span style={{fontSize:11,color:C.verde,whiteSpace:"nowrap",fontWeight:600}}>
                    → {calcStatusAuto(form)}
                  </span>}
                </div>
                {form.statusAuto&&<span style={{fontSize:10,color:C.cinzaClaro}}>Calculado com base em prazo, responsável e progresso</span>}
              </div>
            </div>
          </div>
          <div>
            <h3 style={{color:C.azulEscuro,fontSize:13,fontWeight:700,margin:"0 0 12px",textTransform:"uppercase",letterSpacing:1}}>📋 Contrato & Prazo</h3>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12,padding:"10px 14px",background:form.temContrato?"#f0fdf4":"#fef9f0",borderRadius:8,border:`1px solid ${form.temContrato?"#86efac":"#fde68a"}`}}>
              <input type="checkbox" checked={form.temContrato} onChange={e=>s("temContrato",e.target.checked)} id="tc" style={{width:16,height:16,cursor:"pointer"}}/>
              <label htmlFor="tc" style={{fontSize:13,fontWeight:600,color:form.temContrato?"#166534":"#92400e",cursor:"pointer"}}>{form.temContrato?"✓ Contrato assinado":"⚠ Sem contrato formalizado"}</label>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12}}>
              <Inp label="Data do Contrato" value={form.dataContrato} onChange={setContrato} type="date"/>
              <Inp label="Prazo (Dias Úteis)" value={form.prazo||""} onChange={setPrazo} type="number" placeholder="Ex: 60"/>
              <div style={{display:"flex",flexDirection:"column",gap:4}}>
                <label style={{fontSize:12,fontWeight:600,color:C.cinzaEscuro}}>
                  Entrega Prevista
                  {form.dataContrato&&form.prazo>0&&<span style={{fontSize:10,color:C.verde,marginLeft:6}}>✓ calculada automaticamente</span>}
                </label>
                <input type="date" value={form.dataEntregaPrevista} onChange={e=>s("dataEntregaPrevista",e.target.value)}
                  style={{border:`1.5px solid ${form.dataContrato&&form.prazo>0?C.verde:C.cinzaCard}`,borderRadius:8,padding:"8px 12px",fontSize:14,fontFamily:"inherit",color:C.cinzaEscuro,outline:"none",background:form.dataContrato&&form.prazo>0?"#f0fdf4":C.branco,width:"100%",boxSizing:"border-box"}}/>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:4}}>
                <label style={{fontSize:12,fontWeight:600,color:C.cinzaEscuro}}>
                  Entrega Real
                  {form.dataEntregaReal&&form.dataEntregaPrevista&&(
                    <span style={{fontSize:10,marginLeft:6,color:form.dataEntregaReal<=form.dataEntregaPrevista?C.verde:C.vermelho,fontWeight:700}}>
                      {form.dataEntregaReal<=form.dataEntregaPrevista?"✓ No prazo":"⚠ Atrasado"}
                    </span>
                  )}
                </label>
                <input type="date" value={form.dataEntregaReal||""} onChange={e=>s("dataEntregaReal",e.target.value)}
                  style={{border:`1.5px solid ${form.dataEntregaReal?(form.dataEntregaReal<=form.dataEntregaPrevista?C.verde:C.vermelho):C.cinzaCard}`,borderRadius:8,padding:"8px 12px",fontSize:14,fontFamily:"inherit",color:C.cinzaEscuro,outline:"none",background:C.branco,width:"100%",boxSizing:"border-box"}}/>
              </div>
            </div>
          </div>

          {/* ── EQUIPE DO PROJETO ── */}
          <div>
            <h3 style={{color:C.azulEscuro,fontSize:13,fontWeight:700,margin:"0 0 12px",textTransform:"uppercase",letterSpacing:1}}>
              👥 Equipe & Responsabilidades
            </h3>

            {/* Equipe: selecionar pessoa → atribuir disciplinas (funciona para todos os tipos) */}
            {(()=>{
              // Helper: derivar responsavel/coresponsavel dos membros da equipe
              const sincronizarResps = (membros) => {
                const nomes = [...new Set(membros.map(m=>m.usuarioNome).filter(Boolean))];
                s("responsavel",    nomes[0]||"");
                s("coresponsavel",  nomes[1]||"");
                s("coresponsavel2", nomes[2]||"");
                s("coresponsavel3", nomes[3]||"");
              };
              // Usar form.disciplinas como lista de membros: [{usuarioNome, disciplinas:[], obs:""}]
              // Detectar formato: novo tem "usuarioNome", antigo tem "id"+"responsavel" (uma entrada por disciplina)
              let membros;
              const disc = form.disciplinas||[];
              if(disc.length > 0 && disc[0].usuarioNome !== undefined) {
                // Formato novo — usar direto
                membros = disc.filter(m=>m.usuarioNome);
              } else {
                // Formato antigo — agrupar por responsavel
                const mapa = {};
                disc.forEach(d => {
                  const nome = d.responsavel||"";
                  if(!nome) return;
                  if(!mapa[nome]) mapa[nome] = {usuarioNome:nome, disciplinas:[], obs:d.obs||"", discPausadas:{}};
                  if(d.id) mapa[nome].disciplinas.push(d.id);
                  if(d.id && d.pausada) mapa[nome].discPausadas[d.id] = true;
                });
                membros = Object.values(mapa);
              }

              const usuariosDisponiveis = usuarios.filter(u=>u.ativo);
              const adicionarMembro = (u) => {
                if(membros.find(m=>m.usuarioNome===u.nome)) return;
                const novos = [...membros, {usuarioNome:u.nome, disciplinas:[], obs:""}];
                s("disciplinas", novos);
                sincronizarResps(novos);
              };
              const removerMembro = (nome) => {
                const novos = membros.filter(m=>m.usuarioNome!==nome);
                s("disciplinas", novos);
                sincronizarResps(novos);
              };
              const toggleDisc = (mIdx, discId) => {
                const novos = membros.map((m,i)=>i!==mIdx?m:{
                  ...m,
                  disciplinas: m.disciplinas.includes(discId)
                    ? m.disciplinas.filter(d=>d!==discId)
                    : [...m.disciplinas, discId]
                });
                s("disciplinas", novos);
              };
              const setObs = (mIdx, obs) => {
                s("disciplinas", membros.map((m,i)=>i!==mIdx?m:{...m,obs}));
              };
              // Pausar/retomar uma disciplina específica de um membro
              const togglePausaDisc = (mIdx, discId) => {
                const novos = membros.map((m,i)=>{
                  if(i!==mIdx) return m;
                  const dp = {...(m.discPausadas||{})};
                  if(dp[discId]) delete dp[discId]; else dp[discId] = true;
                  return {...m, discPausadas:dp};
                });
                s("disciplinas", novos);
                // Recalcular status automaticamente
                if(form.statusAuto){
                  // Contar disciplinas pausadas de todos os membros
                  const todasDiscs = novos.flatMap(m=>(m.disciplinas||[]).map(dId=>({dId,pausada:(m.discPausadas||{})[dId]})));
                  if(todasDiscs.length>0 && todasDiscs.every(d=>d.pausada)) s("status","PAUSADO");
                  else if(todasDiscs.some(d=>d.pausada)) s("status","PAUSADO PARCIAL");
                  else s("status","Em andamento");
                }
              };

              return (
                <div style={{display:"flex",flexDirection:"column",gap:12}}>
                  {/* Botões para adicionar membro */}
                  <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
                    {usuariosDisponiveis.map(u=>{
                      const jaEsta = membros.find(m=>m.usuarioNome===u.nome);
                      return(
                        <button key={u.id} onClick={()=>jaEsta?null:adicionarMembro(u)}
                          disabled={!!jaEsta}
                          style={{display:"flex",alignItems:"center",gap:6,padding:"6px 14px",borderRadius:20,
                            border:`2px solid ${jaEsta?u.cor||C.azulMedio:C.cinzaCard}`,
                            background:jaEsta?(u.cor||C.azulMedio)+"18":"white",
                            color:jaEsta?u.cor||C.azulMedio:C.cinzaClaro,
                            cursor:jaEsta?"default":"pointer",fontSize:12,fontWeight:jaEsta?700:400,
                            fontFamily:"inherit",transition:"all 0.15s",opacity:jaEsta?1:0.8}}>
                          <span style={{width:22,height:22,borderRadius:"50%",background:u.cor||C.azulMedio,
                            display:"flex",alignItems:"center",justifyContent:"center",
                            color:"white",fontSize:9,fontWeight:800,flexShrink:0}}>
                            {u.nome.slice(0,2).toUpperCase()}
                          </span>
                          {u.nome}
                          {jaEsta&&<span style={{fontSize:10}}>✓</span>}
                        </button>
                      );
                    })}
                  </div>
                  {membros.length===0&&<span style={{fontSize:11,color:C.cinzaClaro,fontStyle:"italic"}}>
                    Nenhum colaborador adicionado ao projeto ainda
                  </span>}

                  {/* Cards por membro */}
                  {membros.map((m,mIdx)=>{
                    const u = usuariosDisponiveis.find(x=>x.nome===m.usuarioNome)||{cor:C.azulMedio,nome:m.usuarioNome};
                    return(
                      <div key={m.usuarioNome} style={{border:`2px solid ${u.cor||C.azulMedio}22`,borderRadius:12,
                        background:`${u.cor||C.azulMedio}05`,overflow:"hidden"}}>
                        {/* Header do membro */}
                        <div style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",
                          borderBottom:`1px solid ${u.cor||C.azulMedio}22`,background:`${u.cor||C.azulMedio}10`}}>
                          <div style={{width:32,height:32,borderRadius:"50%",background:u.cor||C.azulMedio,
                            display:"flex",alignItems:"center",justifyContent:"center",
                            color:"white",fontSize:11,fontWeight:800,flexShrink:0}}>
                            {m.usuarioNome.slice(0,2).toUpperCase()}
                          </div>
                          <span style={{fontSize:13,fontWeight:700,color:u.cor||C.azulMedio,flex:1}}>{m.usuarioNome}</span>
                          <button onClick={()=>removerMembro(m.usuarioNome)}
                            style={{background:"none",border:"none",color:C.cinzaClaro,cursor:"pointer",
                              fontSize:16,padding:"0 4px",lineHeight:1}}>✕</button>
                        </div>
                        {/* Disciplinas */}
                        <div style={{padding:"10px 14px",display:"flex",flexDirection:"column",gap:8}}>
                          <div style={{fontSize:11,color:C.cinzaClaro,fontWeight:600}}>Disciplinas atribuídas:</div>
                          <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                            {DISCIPLINAS_CB.map(d=>{
                              const ativo = (m.disciplinas||[]).includes(d.id);
                              const pausada = ativo && (m.discPausadas||{})[d.id];
                              if(!ativo) return(
                                <button key={d.id} onClick={()=>toggleDisc(mIdx,d.id)}
                                  style={{display:"flex",alignItems:"center",gap:4,padding:"4px 10px",
                                    borderRadius:14,border:`1.5px solid ${C.cinzaCard}`,
                                    background:"white",color:C.cinzaClaro,
                                    cursor:"pointer",fontSize:11,
                                    fontFamily:"inherit",transition:"all 0.12s"}}>
                                  {d.icone} {d.id}
                                </button>
                              );
                              return(
                                <div key={d.id} style={{display:"flex",alignItems:"center",gap:0,
                                  borderRadius:14,border:`1.5px solid ${pausada?"#d97706":d.cor}`,
                                  background:pausada?"#fef3c7":d.cor,overflow:"hidden"}}>
                                  {/* Clica na disciplina = remove */}
                                  <button onClick={()=>toggleDisc(mIdx,d.id)}
                                    title="Remover disciplina"
                                    style={{display:"flex",alignItems:"center",gap:4,padding:"4px 10px",
                                      background:"transparent",border:"none",
                                      color:pausada?"#92400e":"white",
                                      cursor:"pointer",fontSize:11,fontWeight:700,fontFamily:"inherit"}}>
                                    {d.icone} {d.id} ✓
                                  </button>
                                  {/* Botão de pausa parcial */}
                                  <button onClick={()=>togglePausaDisc(mIdx,d.id)}
                                    title={pausada?"Retomar disciplina":"Pausar esta disciplina"}
                                    style={{padding:"4px 7px",background:pausada?"#d97706":"rgba(0,0,0,0.2)",
                                      border:"none",borderLeft:`1px solid rgba(255,255,255,0.3)`,
                                      color:"white",cursor:"pointer",fontSize:11,lineHeight:1,
                                      display:"flex",alignItems:"center"}}>
                                    {pausada?"▶":"⏸"}
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                          {/* Aviso de pausas parciais */}
                          {Object.keys(m.discPausadas||{}).filter(k=>(m.disciplinas||[]).includes(k)).length>0&&(
                            <div style={{fontSize:11,color:"#92400e",background:"#fef3c7",
                              padding:"4px 10px",borderRadius:6,border:"1px solid #fde68a"}}>
                              ⏸ {Object.keys(m.discPausadas||{}).filter(k=>(m.disciplinas||[]).includes(k)).map(k=>{
                                const d=DISCIPLINAS_CB.find(x=>x.id===k);
                                return d?`${d.icone} ${d.id}`:k;
                              }).join(", ")} pausada(s)
                            </div>
                          )}
                          <input value={m.obs||""} onChange={e=>setObs(mIdx,e.target.value)}
                            placeholder="Observações sobre a participação..."
                            style={{border:`1px solid ${C.cinzaCard}`,borderRadius:7,padding:"5px 10px",
                              fontSize:11,fontFamily:"inherit",color:C.cinzaEscuro,background:"#fafafa",
                              width:"100%",boxSizing:"border-box"}}/>
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
            {/* Separador antes do bloco não-CB antigo — agora tudo usa o bloco acima */}
          </div>


          {/* ── PAUSAS DO PROJETO ── */}
          {/* Pausas do projeto */}
          <div>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
              <h3 style={{color:C.azulEscuro,fontSize:13,fontWeight:700,margin:0,textTransform:"uppercase",letterSpacing:1}}>⏸ Pausas do Projeto</h3>
              {(form.pausas||[]).length>0&&<span style={{fontSize:11,color:C.laranja,fontWeight:700}}>+{calcDiasPausados(form.pausas)} dias úteis adicionados ao prazo</span>}
            </div>
            {(form.pausas||[]).length>0&&(
              <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:12}}>
                {(form.pausas||[]).map((p,i)=>{const ativa=!p.fim; const diasP=calcDiasPausados([p]);
                  return(<div key={i} style={{display:"flex",gap:10,alignItems:"center",padding:"10px 14px",background:ativa?"#fff7ed":"#f0fdf4",borderRadius:10,border:`1px solid ${ativa?"#fde68a":"#86efac"}`}}>
                    <div style={{fontSize:18}}>{ativa?"⏸":"▶"}</div>
                    <div style={{flex:1}}>
                      <div style={{fontSize:13,fontWeight:700,color:ativa?"#92400e":"#166534"}}>{ativa?"Em pausa desde":"Pausa encerrada"} — {p.motivo||"sem motivo"}</div>
                      <div style={{fontSize:11,color:"#6b7280",marginTop:2}}>{fmtData(p.inicio)} {p.fim?`→ ${fmtData(p.fim)}`:"→ hoje"} · {diasP} dia(s) útil(eis)</div>
                    </div>
                    {ativa&&(retornandoIdx===i?(
                      <div style={{display:"flex",gap:6,alignItems:"center",flexShrink:0}}>
                        <input type="date" value={dataRetorno} onChange={e=>setDataRetorno(e.target.value)} min={form.pausas[i]?.inicio} max={new Date().toISOString().slice(0,10)} style={{border:`1.5px solid ${C.verde}`,borderRadius:6,padding:"4px 8px",fontSize:12,fontFamily:"inherit"}}/>
                        <Btn onClick={()=>confirmarRetorno(i)} variant="verde" small disabled={!dataRetorno}>✓ Ok</Btn>
                        <Btn onClick={()=>{setRetornandoIdx(null);setDataRetorno("");}} variant="ghost" small>✕</Btn>
                      </div>
                    ):(
                      <Btn onClick={()=>{setRetornandoIdx(i);setDataRetorno(new Date().toISOString().slice(0,10));}} variant="verde" small>▶ Retornar</Btn>
                    ))}
                    <button onClick={()=>removerPausa(i)} style={{background:"none",border:"none",color:C.vermelho,cursor:"pointer",fontSize:14,padding:"0 4px"}}>🗑</button>
                  </div>);
                })}
              </div>
            )}
            {!(form.pausas||[]).some(p=>!p.fim)?(
              <div style={{background:C.cinzaFundo,borderRadius:10,padding:12,display:"flex",gap:8,alignItems:"flex-end",flexWrap:"wrap"}}>
                <div style={{display:"flex",flexDirection:"column",gap:4}}>
                  <label style={{fontSize:11,fontWeight:600,color:C.cinzaEscuro}}>Data de início</label>
                  <input type="date" value={novaPausa.inicio} onChange={e=>setNovaPausa(n=>({...n,inicio:e.target.value}))} style={{border:`1.5px solid ${C.cinzaCard}`,borderRadius:8,padding:"7px 10px",fontSize:13,fontFamily:"inherit"}}/>
                </div>
                <div style={{display:"flex",flexDirection:"column",gap:4,flex:1,minWidth:160}}>
                  <label style={{fontSize:11,fontWeight:600,color:C.cinzaEscuro}}>Motivo da pausa</label>
                  <input value={novaPausa.motivo} onChange={e=>setNovaPausa(n=>({...n,motivo:e.target.value}))} placeholder="Ex: Aguardando aprovação do cliente..." style={{border:`1.5px solid ${C.cinzaCard}`,borderRadius:8,padding:"7px 10px",fontSize:13,fontFamily:"inherit",width:"100%",boxSizing:"border-box"}}/>
                </div>
                <Btn onClick={()=>{if(!novaPausa.inicio||!novaPausa.motivo)return; adicionarPausa({inicio:novaPausa.inicio,motivo:novaPausa.motivo,fim:null}); setNovaPausa({inicio:"",motivo:""}); if(form.statusAuto)s("status","PAUSADO");}} small disabled={!novaPausa.inicio||!novaPausa.motivo}>⏸ Pausar</Btn>
              </div>
            ):(
              <div style={{padding:"8px 12px",background:"#fff7ed",borderRadius:8,fontSize:12,color:"#92400e",border:"1px solid #fde68a"}}>⏸ Projeto em pausa. Clique em "▶ Retornar" para registrar o retorno.</div>
            )}
          </div>

          {/* Drive & Obs */}
          <div>
            <h3 style={{color:C.azulEscuro,fontSize:13,fontWeight:700,margin:"0 0 12px",textTransform:"uppercase",letterSpacing:1}}>🔗 Drive & Observações</h3>
            <div style={{display:"flex",flexDirection:"column",gap:12}}>
              {form._doDrive ? <div style={{display:"flex",flexDirection:"column",gap:4}}><label style={{fontSize:12,fontWeight:600,color:C.cinzaEscuro}}>Link do Drive <span style={{fontSize:10,color:C.cinzaClaro}}>(gerenciado automaticamente)</span></label><div style={{display:"flex",gap:8,alignItems:"center"}}><input value={form.driveUrl} readOnly style={{flex:1,border:`1.5px solid ${C.cinzaCard}`,borderRadius:8,padding:"8px 12px",fontSize:12,background:"#f8fafc",cursor:"not-allowed",color:C.cinzaClaro}}/>{form.driveUrl&&<a href={form.driveUrl} target="_blank" rel="noreferrer" style={{color:C.azulClaro,fontSize:12,whiteSpace:"nowrap"}}>📂 Abrir</a>}</div></div> : <Inp label="Link da pasta no Google Drive" value={form.driveUrl} onChange={v=>s("driveUrl",v)} placeholder="https://drive.google.com/..."/>}
              <div style={{display:"flex",gap:8,alignItems:"center"}}>
                <input value={form.driveEntregaveis||""} onChange={e=>s("driveEntregaveis",e.target.value)}
                  placeholder="📦 Link Entregáveis (cliente vê ao 100%)..."
                  style={{flex:1,border:`1.5px solid ${form.driveEntregaveis?C.verde:C.cinzaCard}`,borderRadius:8,padding:"8px 12px",fontSize:12,fontFamily:"inherit",color:C.cinzaEscuro}}/>
                {form.driveEntregaveis&&<a href={form.driveEntregaveis} target="_blank" rel="noreferrer" style={{color:C.verde,fontSize:12,whiteSpace:"nowrap",fontWeight:700}}>📂 Testar</a>}
              </div>
              <textarea value={form.obs} onChange={e=>s("obs",e.target.value)} rows={2} placeholder="Observações..."
                style={{border:`1.5px solid ${C.cinzaCard}`,borderRadius:8,padding:"8px 12px",fontSize:13,fontFamily:"inherit",color:C.cinzaEscuro,outline:"none",resize:"vertical",width:"100%",boxSizing:"border-box"}}/>
            </div>
          </div>
          <div style={{display:"flex",gap:10,justifyContent:"space-between",paddingTop:8,borderTop:`1px solid ${C.cinzaCard}`}}>
            {modo==="editar"&&<Btn variant="danger" small onClick={()=>onExcluir(projeto.id)}>🗑 Excluir</Btn>}
            <div style={{display:"flex",gap:10,marginLeft:"auto"}}><Btn variant="ghost" onClick={onClose}>Cancelar</Btn><Btn onClick={()=>{
              // Converter disciplinas para formato novo se ainda estiver no antigo
              let disciplinasFinais = form.disciplinas||[];
              if(disciplinasFinais.length > 0 && disciplinasFinais[0].usuarioNome === undefined) {
                // Formato antigo — agrupar por responsavel
                const mapa = {};
                disciplinasFinais.forEach(d => {
                  const nome = d.responsavel||"";
                  if(!nome) return;
                  if(!mapa[nome]) mapa[nome] = {usuarioNome:nome, disciplinas:[], obs:d.obs||"", discPausadas:{}};
                  if(d.id) mapa[nome].disciplinas.push(d.id);
                  if(d.id && d.pausada) mapa[nome].discPausadas[d.id] = true;
                });
                disciplinasFinais = Object.values(mapa);
              }
              // Sincronizar responsavel/coresponsavel a partir dos membros
              const nomes = [...new Set(disciplinasFinais.map(m=>m.usuarioNome).filter(Boolean))];
              const formFinal = {
                ...form,
                disciplinas:    disciplinasFinais,
                responsavel:    nomes[0]||"",
                coresponsavel:  nomes[1]||"",
                coresponsavel2: nomes[2]||"",
                coresponsavel3: nomes[3]||"",
              };
              onSave(formFinal);
            }}>💾 Salvar</Btn></div>
          </div>
        </>}

        {/* ─── ABA EXECUÇÃO: PAUSAS + REVISÃO ─── */}
        {abaModal==="execucao" && <>

          {/* Revisão do projeto */}
          <div>
            <h3 style={{color:C.azulEscuro,fontSize:13,fontWeight:700,margin:"0 0 12px",textTransform:"uppercase",letterSpacing:1}}>🔍 Revisão do Projeto</h3>
            <div style={{background:C.cinzaFundo,borderRadius:10,padding:14,marginBottom:12}}>
              <div style={{fontSize:12,color:C.cinzaClaro,marginBottom:8}}>Responsável pela revisão desta semana (da escala):</div>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                {(()=>{
                  try {
                    const dadosR = JSON.parse(localStorage.getItem("intec_escala_revisao")||"{}");
                    if(dadosR.membros && dadosR.dataInicio){
                      const ini = new Date(dadosR.dataInicio+"T12:00:00");
                      const diffSem = Math.round((new Date()-ini)/(7*24*60*60*1000));
                      const idx = ((diffSem%dadosR.membros.length)+dadosR.membros.length)%dadosR.membros.length;
                      const resp = dadosR.membros[idx];
                      return <div style={{display:"flex",alignItems:"center",gap:8}}>
                        <div style={{width:32,height:32,borderRadius:"50%",background:C.azulMedio,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontWeight:800,fontSize:11}}>{resp.slice(0,2).toUpperCase()}</div>
                        <span style={{fontSize:14,fontWeight:700,color:C.azulEscuro}}>{resp}</span>
                      </div>;
                    }
                  } catch(e){}
                  return <span style={{fontSize:12,color:C.cinzaClaro}}>Configure a escala de revisão na aba Agenda</span>;
                })()}
              </div>
            </div>
            {/* Checklist de revisão */}
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              {[
                {campo:"revisaoMandado",   label:"📤 Mandado para revisão",           cor:"#2563a8"},
                {campo:"revisaoFeita",     label:"✅ Revisão realizada pelo revisor",  cor:"#22c55e"},
                {campo:"revisaoCorrigida", label:"🔧 Correções feitas pelo responsável", cor:"#f59e0b"},
              ].map(item=>(
                <label key={item.campo} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 14px",borderRadius:8,
                  background:form[item.campo]?item.cor+"10":C.cinzaFundo,
                  border:`1.5px solid ${form[item.campo]?item.cor:C.cinzaCard}`,cursor:"pointer",transition:"all 0.15s"}}>
                  <input type="checkbox" checked={!!form[item.campo]} onChange={e=>s(item.campo,e.target.checked)}
                    style={{width:18,height:18,cursor:"pointer",accentColor:item.cor}}/>
                  <span style={{fontSize:13,fontWeight:form[item.campo]?700:400,color:form[item.campo]?item.cor:C.cinzaEscuro}}>{item.label}</span>
                  {form[item.campo]&&<span style={{marginLeft:"auto",fontSize:18}}>✓</span>}
                </label>
              ))}
            </div>
          </div>

          <div style={{display:"flex",gap:10,justifyContent:"flex-end",paddingTop:8,borderTop:`1px solid ${C.cinzaCard}`}}>
            <Btn variant="ghost" onClick={onClose}>Cancelar</Btn><Btn onClick={()=>onSave(form)}>💾 Salvar</Btn>
          </div>
        </>}

        {/* ─── ABA FINANCEIRO ─── */}
        {abaModal==="financeiro" && <>
          <div>
            <h3 style={{color:C.azulEscuro,fontSize:13,fontWeight:700,margin:"0 0 12px",textTransform:"uppercase",letterSpacing:1}}>💰 Financeiro — Parcelas</h3>
            {(form.parcelas||[]).length>0&&(
              <div style={{marginBottom:12,display:"flex",flexDirection:"column",gap:6}}>
                {form.parcelas.map((p,i)=>(
                  <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 12px",background:p.pago?"#f0fdf4":"#fefce8",borderRadius:8,border:`1px solid ${p.pago?"#86efac":"#fde68a"}`}}>
                    <input type="checkbox" checked={p.pago} onChange={()=>togP(i)} style={{width:14,height:14,cursor:"pointer"}}/>
                    <span style={{flex:1,fontSize:13}}>{p.desc}</span>
                    <span style={{fontWeight:700,color:p.pago?C.verde:C.amarelo}}>{fmt(p.valor)}</span>
                    <button onClick={()=>delP(i)} style={{background:"none",border:"none",color:C.vermelho,cursor:"pointer",fontSize:16,padding:"0 4px"}}>×</button>
                  </div>
                ))}
                <div style={{display:"flex",gap:16,padding:"8px 12px",background:C.cinzaFundo,borderRadius:8,fontSize:12}}>
                  <span>✓ <strong style={{color:C.verde}}>{fmt(rec)}</strong></span>
                  <span>⏳ <strong style={{color:C.amarelo}}>{fmt(pend)}</strong></span>
                  <span>Total: <strong>{fmt(rec+pend)}</strong></span>
                </div>
              </div>
            )}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr auto auto",gap:8,alignItems:"end"}}>
              <Inp label="Descrição" value={np.desc} onChange={v=>setNp(n=>({...n,desc:v}))} placeholder="Entrada..."/>
              <Inp label="Valor (R$)" value={np.valor} onChange={v=>setNp(n=>({...n,valor:v}))} type="number" placeholder="0,00"/>
              <div style={{display:"flex",alignItems:"center",gap:6,paddingBottom:2}}>
                <input type="checkbox" checked={np.pago} onChange={e=>setNp(n=>({...n,pago:e.target.checked}))} id="pg" style={{cursor:"pointer"}}/>
                <label htmlFor="pg" style={{fontSize:12,cursor:"pointer",whiteSpace:"nowrap"}}>Já pago</label>
              </div>
              <Btn onClick={addP} small>+ Add</Btn>
            </div>
          </div>
          <div style={{display:"flex",gap:10,justifyContent:"flex-end",paddingTop:8,borderTop:`1px solid ${C.cinzaCard}`}}>
            <Btn variant="ghost" onClick={onClose}>Cancelar</Btn><Btn onClick={()=>onSave(form)}>💾 Salvar</Btn>
          </div>
        </>}

        {/* ─── ABA PORTAL CLIENTE ─── */}
        {abaModal==="portal" && <>
          <div>
            <h3 style={{color:C.azulEscuro,fontSize:13,fontWeight:700,margin:"0 0 4px",textTransform:"uppercase",letterSpacing:1}}>🔗 Portal do Cliente</h3>
            <p style={{color:C.cinzaClaro,fontSize:12,margin:"0 0 16px"}}>Gere um link exclusivo para o cliente acompanhar o projeto em tempo real, sem precisar de login.</p>

            {/* Gerar/copiar link */}
            {!form.tokenCliente && !form.token_cliente ? (
              <div style={{padding:"20px",background:C.cinzaFundo,borderRadius:12,textAlign:"center"}}>
                <div style={{fontSize:32,marginBottom:8}}>🔒</div>
                <div style={{fontSize:14,fontWeight:600,color:C.cinzaEscuro,marginBottom:4}}>Link não gerado</div>
                <div style={{fontSize:12,color:C.cinzaClaro,marginBottom:16}}>Clique para gerar um link exclusivo para este projeto</div>
                <Btn onClick={gerarLink} disabled={gerandoLink||modo==="novo"}>
                  {gerandoLink?"⏳ Gerando...":"🔑 Gerar Link do Cliente"}
                </Btn>
                {modo==="novo"&&<div style={{fontSize:11,color:C.cinzaClaro,marginTop:8}}>Salve o projeto primeiro para gerar o link</div>}
              </div>
            ):(
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                {/* Status do link */}
                <div style={{display:"flex",alignItems:"center",gap:12,padding:"12px 16px",background:(form.linkClienteAtivo||form.link_cliente_ativo)?"#f0fdf4":"#fef2f2",borderRadius:10,border:`1px solid ${(form.linkClienteAtivo||form.link_cliente_ativo)?"#86efac":"#fecaca"}`}}>
                  <div style={{width:10,height:10,borderRadius:"50%",background:(form.linkClienteAtivo||form.link_cliente_ativo)?C.verde:C.vermelho}}/>
                  <span style={{fontSize:13,fontWeight:700,color:(form.linkClienteAtivo||form.link_cliente_ativo)?"#166534":"#991b1b"}}>
                    {(form.linkClienteAtivo||form.link_cliente_ativo)?"Link ativo — cliente pode acessar":"Link desativado — cliente não consegue acessar"}
                  </span>
                  <Btn onClick={()=>toggleLink(!(form.linkClienteAtivo||form.link_cliente_ativo))} small variant={(form.linkClienteAtivo||form.link_cliente_ativo)?"danger":"verde"} style={{marginLeft:"auto"}}>
                    {(form.linkClienteAtivo||form.link_cliente_ativo)?"Desativar":"Ativar"}
                  </Btn>
                </div>
                {/* URL */}
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  <input readOnly value={`${window.location.origin}/cliente/${form.tokenCliente||form.token_cliente}`}
                    style={{flex:1,border:`1.5px solid ${C.cinzaCard}`,borderRadius:8,padding:"8px 12px",fontSize:12,fontFamily:"monospace",color:C.azulMedio,background:"#f8fafc"}}/>
                  <Btn onClick={copiarLink} variant={copiado?"verde":"secondary"} small>
                    {copiado?"✓ Copiado!":"📋 Copiar"}
                  </Btn>
                  <a href={`${window.location.origin}/cliente/${form.tokenCliente||form.token_cliente}`} target="_blank" rel="noreferrer">
                    <Btn variant="ghost" small>↗ Abrir</Btn>
                  </a>
                </div>
              </div>
            )}

            {/* Progresso e obs do cliente */}
            <div style={{marginTop:20,display:"flex",flexDirection:"column",gap:12}}>
              <h3 style={{color:C.azulEscuro,fontSize:13,fontWeight:700,margin:0,textTransform:"uppercase",letterSpacing:1}}>📊 Progresso & Mensagem ao Cliente</h3>
              <div>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                  <label style={{fontSize:12,fontWeight:600,color:C.cinzaEscuro}}>Progresso do projeto</label>
                  <span style={{fontSize:13,fontWeight:800,color:C.azulMedio}}>{form.progresso||0}%</span>
                </div>
                <input type="range" min="0" max="100" step="5" value={form.progresso||0} onChange={e=>s("progresso",parseInt(e.target.value))}
                  style={{width:"100%",accentColor:C.azulMedio}}/>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:C.cinzaClaro,marginTop:2}}>
                  <span>0%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span>
                </div>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:4}}>
                <label style={{fontSize:12,fontWeight:600,color:C.cinzaEscuro}}>Mensagem visível ao cliente</label>
                <textarea value={form.obsCliente||form.obs_cliente||""} onChange={e=>s("obsCliente",e.target.value)} rows={2}
                  placeholder="Ex: Aguardando aprovação das plantas pelo cliente..." 
                  style={{border:`1.5px solid ${C.cinzaCard}`,borderRadius:8,padding:"8px 12px",fontSize:13,fontFamily:"inherit",color:C.cinzaEscuro,outline:"none",resize:"vertical",width:"100%",boxSizing:"border-box"}}/>
              </div>
            </div>

            {/* Atualizações */}
            <div style={{marginTop:20}}>
              <h3 style={{color:C.azulEscuro,fontSize:13,fontWeight:700,margin:"0 0 12px",textTransform:"uppercase",letterSpacing:1}}>🕐 Linha do Tempo</h3>
              {/* Nova atualização */}
              <div style={{background:C.cinzaFundo,borderRadius:10,padding:14,marginBottom:14}}>
                <div style={{display:"grid",gridTemplateColumns:"auto 1fr",gap:8,marginBottom:8}}>
                  <select value={novaAtu.icone} onChange={e=>setNovaAtu(n=>({...n,icone:e.target.value}))}
                    style={{border:`1.5px solid ${C.cinzaCard}`,borderRadius:8,padding:"6px 8px",fontSize:18,cursor:"pointer",background:"white"}}>
                    {ICONES_ATU.map(ic=><option key={ic} value={ic}>{ic}</option>)}
                  </select>
                  <Inp label="" value={novaAtu.titulo} onChange={v=>setNovaAtu(n=>({...n,titulo:v}))} placeholder="Título da atualização (ex: Modelagem estrutural iniciada)"/>
                </div>
                <textarea value={novaAtu.descricao} onChange={e=>setNovaAtu(n=>({...n,descricao:e.target.value}))} rows={2}
                  placeholder="Descrição detalhada (opcional)..."
                  style={{border:`1.5px solid ${C.cinzaCard}`,borderRadius:8,padding:"8px 12px",fontSize:13,fontFamily:"inherit",color:C.cinzaEscuro,outline:"none",resize:"vertical",width:"100%",boxSizing:"border-box",marginBottom:8}}/>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div style={{display:"flex",alignItems:"center",gap:6}}>
                    <input type="checkbox" checked={novaAtu.visivelCliente} onChange={e=>setNovaAtu(n=>({...n,visivelCliente:e.target.checked}))} id="vc" style={{cursor:"pointer"}}/>
                    <label htmlFor="vc" style={{fontSize:12,cursor:"pointer",color:C.cinzaClaro}}>Visível ao cliente</label>
                  </div>
                  <Btn onClick={adicionarAtu} small disabled={!novaAtu.titulo}>+ Adicionar</Btn>
                </div>
              </div>

              {/* Lista de atualizações */}
              {carregandoAtu && <div style={{textAlign:"center",color:C.cinzaClaro,padding:16}}>⏳ Carregando...</div>}
              {!carregandoAtu && atualizacoes.length===0 && <div style={{textAlign:"center",color:C.cinzaClaro,padding:16,fontSize:12}}>Nenhuma atualização ainda. Adicione a primeira acima!</div>}
              <div style={{display:"flex",flexDirection:"column",gap:8,maxHeight:360,overflowY:"auto"}}>
                {atualizacoes.map(a=>{
                  const isSessao = a.origem==="sessao" || a.tipo==="sessao";
                  return (
                  <div key={a.id} style={{display:"flex",gap:10,padding:"10px 12px",
                    background:isSessao?"#f0fdf4":a.visivel_cliente?"#f0f9ff":"#f8fafc",
                    borderRadius:8,border:`1px solid ${isSessao?"#86efac":a.visivel_cliente?C.azulClaro:C.cinzaCard}`,
                    opacity:(!isSessao&&!a.visivel_cliente)?0.6:1}}>
                    <span style={{fontSize:20,flexShrink:0}}>{a.icone||"📝"}</span>
                    <div style={{flex:1}}>
                      <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                        <span style={{fontSize:13,fontWeight:700,color:C.cinzaEscuro}}>{a.titulo}</span>
                        {isSessao
                          ? <span style={{fontSize:10,background:"#f0fdf4",color:"#166534",padding:"1px 7px",borderRadius:10,fontWeight:700,border:"1px solid #86efac"}}>⚙ Execução</span>
                          : <span style={{fontSize:10,background:"#eff6ff",color:C.azulMedio,padding:"1px 7px",borderRadius:10,fontWeight:700,border:`1px solid #bfdbfe`}}>📝 Manual</span>}
                      </div>
                      {a.descricao&&<div style={{fontSize:12,color:C.cinzaClaro,marginTop:2}}>{a.descricao}</div>}
                      <div style={{fontSize:11,color:C.cinzaClaro,marginTop:4}}>
                        {a.autor_nome&&<span>👤 {a.autor_nome} · </span>}
                        {new Date(a.created_at).toLocaleDateString("pt-BR")}
                        {!isSessao&&!a.visivel_cliente&&<span style={{marginLeft:8,color:C.amarelo}}>👁 Oculto ao cliente</span>}
                        {isSessao&&<span style={{marginLeft:6,color:"#8492a6"}}>(gerado automaticamente)</span>}
                      </div>
                    </div>
                    <div style={{display:"flex",flexDirection:"column",gap:4,alignItems:"center",flexShrink:0}}>
                      {isSessao&&(
                        <button title={a.visivel_cliente?"Clique para ocultar do cliente":"Clique para mostrar ao cliente"}
                          onClick={async()=>{
                            try{
                              await db.sessoes.toggleVisivel(a.sessaoId, !a.visivel_cliente);
                              setAtualizacoes(x=>x.map(item=>item.sessaoId===a.sessaoId?{...item,visivel_cliente:!a.visivel_cliente}:item));
                            }catch(e){console.error(e);}
                          }}
                          style={{background:"none",border:"none",cursor:"pointer",fontSize:14,padding:"0 4px",color:a.visivel_cliente?C.verde:C.cinzaClaro}}
                          title={a.visivel_cliente?"Visível ao cliente — clique para ocultar":"Oculto do cliente — clique para mostrar"}>
                          {a.visivel_cliente?"👁":"🙈"}
                        </button>
                      )}
                      {!isSessao&&<button onClick={()=>excluirAtu(a.id)} style={{background:"none",border:"none",color:C.vermelho,cursor:"pointer",fontSize:14,padding:"0 4px"}}>🗑</button>}
                    </div>
                  </div>
                  );
                })}
              </div>
            </div>
          </div>
          <div style={{display:"flex",gap:10,justifyContent:"flex-end",paddingTop:8,borderTop:`1px solid ${C.cinzaCard}`}}>
            <Btn variant="ghost" onClick={onClose}>Fechar</Btn><Btn onClick={()=>onSave(form)}>💾 Salvar Projeto</Btn>
          </div>
        </>}
        </div>
      </div>
    </div>
  );
}

// ─── CARD / TABELA / LISTA PROJETOS ───────────────────────────────────────────
function CardProjeto({p,onClick}){
  const dias=diasAte(p.dataEntregaPrevista);const total=(p.parcelas||[]).reduce((a,x)=>a+x.valor,0);const rec=(p.parcelas||[]).reduce((a,x)=>a+(x.pago?x.valor:0),0);const pct=total>0?(rec/total)*100:0;const s=statusN(p.status);const cfg=STATUS_CONFIG[s]||STATUS_CONFIG["Novo/Definir"];
  return(<div onClick={onClick} style={{background:C.branco,borderRadius:12,padding:16,cursor:"pointer",border:`1.5px solid ${C.cinzaCard}`,transition:"all 0.2s",boxShadow:"0 2px 8px rgba(26,58,107,0.06)",position:"relative",overflow:"hidden"}} onMouseEnter={e=>{e.currentTarget.style.borderColor=C.azulClaro;e.currentTarget.style.transform="translateY(-2px)";e.currentTarget.style.boxShadow=`0 8px 24px rgba(26,58,107,0.15)`;}} onMouseLeave={e=>{e.currentTarget.style.borderColor=C.cinzaCard;e.currentTarget.style.transform="translateY(0)";e.currentTarget.style.boxShadow="0 2px 8px rgba(26,58,107,0.06)";}}>
    <div style={{position:"absolute",left:0,top:0,bottom:0,width:4,background:cfg.cor,borderRadius:"12px 0 0 12px"}}/>
    <div style={{paddingLeft:10}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8,gap:8}}>
        <div style={{flex:1}}>
          <div style={{display:"flex",gap:6,alignItems:"center",marginBottom:4,flexWrap:"wrap"}}><TipoBadge tipo={p.tipo}/><span style={{fontSize:11,color:C.cinzaClaro,fontWeight:600}}>{p.codigo}</span>{!p.temContrato&&<span style={{fontSize:10,background:"#fef3c7",color:"#92400e",padding:"1px 6px",borderRadius:4,fontWeight:700}}>SEM CONTRATO</span>}{p._doDrive&&<span style={{fontSize:10,background:"#e0f2fe",color:"#0369a1",padding:"1px 6px",borderRadius:4,fontWeight:700}}>DRIVE</span>}</div>
          <p style={{margin:0,fontSize:13,fontWeight:700,color:C.cinzaEscuro,lineHeight:1.3}}>{p.cliente}</p>
        </div>
        <Badge status={p.status}/>
      </div>
      <div style={{display:"flex",gap:12,fontSize:11,color:C.cinzaClaro,marginBottom:10,flexWrap:"wrap"}}>
        {(()=>{
                const eq=[p.responsavel,p.coresponsavel,p.coresponsavel2,p.coresponsavel3].filter(Boolean);
                return eq.length>0?<span>👤 {eq.join(" / ")}</span>:null;
              })()}
        {p.dataEntregaPrevista&&<span style={{color:dias!==null&&dias<0?C.vermelho:dias!==null&&dias<7?C.laranja:C.cinzaClaro}}>📅 {fmtData(p.dataEntregaPrevista)}{dias!==null&&` (${dias<0?`${Math.abs(dias)}d atrasado`:`${dias}d`})`}</span>}
        {p.driveUrl&&<a href={p.driveUrl} target="_blank" rel="noreferrer" onClick={e=>e.stopPropagation()} style={{color:C.azulClaro,textDecoration:"none"}}>📂</a>}
      </div>
      {total>0&&(<div><div style={{display:"flex",justifyContent:"space-between",fontSize:11,marginBottom:3}}><span style={{color:C.verde}}>✓ {fmt(rec)}</span><span style={{color:C.cinzaClaro}}>{fmt(total)}</span></div><div style={{background:C.cinzaFundo,borderRadius:4,height:4}}><div style={{background:pct===100?C.verde:C.azulClaro,height:4,borderRadius:4,width:`${pct}%`,transition:"width 0.3s"}}/></div></div>)}
      {p.obs&&<p style={{margin:"8px 0 0",fontSize:11,color:C.cinzaClaro,fontStyle:"italic",borderTop:`1px solid ${C.cinzaFundo}`,paddingTop:6}}>💬 {p.obs}</p>}
    </div>
  </div>);
}

function TabelaProjetos({projetos,onAbrirProjeto}){
  const [ordem, setOrdem] = useState({col:"codigo",dir:"asc"});
  const toggle = key => setOrdem(o=>o.col===key?{col:key,dir:o.dir==="asc"?"desc":"asc"}:{col:key,dir:"asc"});

  const sorted = useMemo(()=>{
    const arr=[...projetos];
    arr.sort((a,b)=>{
      let va,vb;
      switch(ordem.col){
        case "financeiro":{const ta=(a.parcelas||[]).reduce((s,x)=>s+x.valor,0);const tb=(b.parcelas||[]).reduce((s,x)=>s+x.valor,0);return ordem.dir==="asc"?ta-tb:tb-ta;}
        case "status": va=statusN(a.status);vb=statusN(b.status);break;
        case "dataEntregaPrevista": va=a.dataEntregaPrevista||"";vb=b.dataEntregaPrevista||"";break;
        default: va=a[ordem.col]||"";vb=b[ordem.col]||"";
      }
      return (ordem.dir==="asc"?1:-1)*String(va).localeCompare(String(vb),"pt-BR",{numeric:true,sensitivity:"base"});
    });
    return arr;
  },[projetos,ordem]);

  // Fechar dropdown ao clicar fora — removido (sem filtros de coluna)

  const Th = ({col, label}) => {
    const ativo = ordem.col===col;
    return (
      <th style={{padding:"11px 14px",color:C.ciano,textAlign:"left",fontWeight:700,fontSize:11,
        letterSpacing:0.5,background:ativo?"rgba(255,255,255,0.12)":"transparent",
        userSelect:"none",whiteSpace:"nowrap"}}>
        <span onClick={()=>toggle(col)} style={{cursor:"pointer",display:"flex",alignItems:"center",gap:3}}>
          {label}
          <span style={{fontSize:9,opacity:ativo?1:0.4,marginLeft:2}}>{ativo?(ordem.dir==="asc"?"▲":"▼"):"⇅"}</span>
        </span>
      </th>
    );
  };

  return(
    <div>
      <Card style={{padding:0,overflow:"hidden"}}>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
          <thead>
            <tr style={{background:C.azulEscuro}}>
              <Th col="codigo"               label="Código"/>
              <Th col="tipo"                 label="Tipo"/>
              <Th col="cliente"              label="Cliente"/>
              <Th col="responsavel"          label="Responsável"/>
              <Th col="status"               label="Status"/>
              <Th col="dataEntregaPrevista"  label="Entrega"/>
              <Th col="financeiro"           label="Financeiro"/>
            </tr>
          </thead>
          <tbody>
            {sorted.length===0&&<tr><td colSpan={7} style={{padding:"24px",textAlign:"center",color:C.cinzaClaro,fontSize:13}}>Nenhum projeto corresponde aos filtros.</td></tr>}
            {sorted.map((p,i)=>{
              const total=(p.parcelas||[]).reduce((a,x)=>a+x.valor,0);
              const rec  =(p.parcelas||[]).reduce((a,x)=>a+(x.pago?x.valor:0),0);
              return(
                <tr key={p.id+"_"+i} onClick={()=>onAbrirProjeto(p)}
                  style={{borderBottom:`1px solid ${C.cinzaFundo}`,cursor:"pointer",background:i%2===0?C.branco:"#f8fafc",transition:"background 0.12s"}}
                  onMouseEnter={e=>e.currentTarget.style.background="#e8f4fd"}
                  onMouseLeave={e=>e.currentTarget.style.background=i%2===0?C.branco:"#f8fafc"}>
                  <td style={{padding:"10px 14px",fontWeight:600,color:C.azulMedio}}>{p.codigo}</td>
                  <td style={{padding:"10px 14px"}}><TipoBadge tipo={p.tipo}/></td>
                  <td style={{padding:"10px 14px",maxWidth:240,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.cliente}</td>
                  <td style={{padding:"10px 14px",color:C.cinzaClaro}}>{[p.responsavel,p.coresponsavel,p.coresponsavel2,p.coresponsavel3].filter(Boolean).join(" / ")||"—"}</td>
                  <td style={{padding:"10px 14px"}}><Badge status={p.status}/></td>
                  <td style={{padding:"10px 14px",color:C.cinzaClaro,whiteSpace:"nowrap"}}>{fmtData(p.dataEntregaPrevista)}</td>
                  <td style={{padding:"10px 14px"}}>{total>0?<span style={{color:rec===total?C.verde:C.amarelo,fontWeight:600}}>{fmt(rec)}/{fmt(total)}</span>:<span style={{color:C.cinzaClaro}}>—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function ListaProjetos({projetos,onAbrirProjeto,onNovoProjeto,usuarios=[]}){
  const [busca,setBusca]=useState("");const [fStatus,setFS]=useState("todos");const [fTipo,setFT]=useState("todos");const [fAno,setFA]=useState("todos");const [fResp,setFR]=useState("todos");const [view,setView]=useState("grid");
  const anos=[...new Set(projetos.map(p=>p.ano))].sort((a,b)=>b-a);
  const resps=useMemo(()=>usuarios.filter(u=>u.ativo).map(u=>u.nome).sort(),[usuarios]);
  const filtrados=useMemo(()=>{const v=new Set();const u=projetos.filter(p=>{const c=p.id?.trim();if(!c||v.has(c))return false;v.add(c);return true;});return u.filter(p=>{const s=statusN(p.status);if(fStatus!=="todos"&&s!==fStatus)return false;if(fTipo!=="todos"&&p.tipo!==fTipo)return false;if(fAno!=="todos"&&Number(p.ano)!==Number(fAno))return false;if(fResp!=="todos"&&p.responsavel!==fResp&&p.coresponsavel!==fResp)return false;if(busca){const b=busca.toLowerCase();return(p.cliente||"").toLowerCase().includes(b)||(p.codigo||"").toLowerCase().includes(b)||(p.responsavel||"").toLowerCase().includes(b);}return true;});},[projetos,busca,fStatus,fTipo,fAno,fResp]);
  return(<div style={{display:"flex",flexDirection:"column",gap:16}}>
    <Card style={{padding:16}}>
      <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"center"}}>
        <input value={busca} onChange={e=>setBusca(e.target.value)} placeholder="🔍 Buscar..." style={{flex:1,minWidth:200,border:`1.5px solid ${C.cinzaCard}`,borderRadius:8,padding:"8px 14px",fontSize:14,fontFamily:"inherit",outline:"none"}}/>
        <select value={fResp} onChange={e=>setFR(e.target.value)} style={{border:`1.5px solid ${C.cinzaCard}`,borderRadius:8,padding:"8px 12px",fontSize:13,fontFamily:"inherit",cursor:"pointer"}}>
            <option value="todos">👤 Todos os colaboradores</option>
            {usuarios.filter(u=>u.ativo).map(u=><option key={u.id} value={u.nome}>{u.nome} ({u.perfil==="gestor"?"🔑 Gestor":u.perfil==="admin"?"👑 Admin":"👤"})</option>)}
          </select>
        <select value={fStatus} onChange={e=>setFS(e.target.value)} style={{border:`1.5px solid ${C.cinzaCard}`,borderRadius:8,padding:"8px 12px",fontSize:13,fontFamily:"inherit",cursor:"pointer"}}><option value="todos">Todos os status</option>{Object.keys(STATUS_CONFIG).map(s=><option key={s} value={s}>{s}</option>)}</select>
        <select value={fTipo} onChange={e=>setFT(e.target.value)} style={{border:`1.5px solid ${C.cinzaCard}`,borderRadius:8,padding:"8px 12px",fontSize:13,fontFamily:"inherit",cursor:"pointer"}}><option value="todos">Todos os tipos</option>{Object.entries(TIPOS).map(([k,v])=><option key={k} value={k}>{k} – {v}</option>)}</select>
        <select value={fAno} onChange={e=>setFA(e.target.value)} style={{border:`1.5px solid ${C.cinzaCard}`,borderRadius:8,padding:"8px 12px",fontSize:13,fontFamily:"inherit",cursor:"pointer"}}><option value="todos">Todos os anos</option>{anos.map(a=><option key={a} value={a}>{a}</option>)}</select>
        <div style={{display:"flex",gap:4}}>{["grid","list"].map(v=><button key={v} onClick={()=>setView(v)} style={{background:view===v?C.azulMedio:"transparent",color:view===v?C.branco:C.cinzaClaro,border:`1.5px solid ${view===v?C.azulMedio:C.cinzaCard}`,borderRadius:6,padding:"6px 10px",cursor:"pointer",fontSize:16}}>{v==="grid"?"⊞":"☰"}</button>)}</div>
        <Btn onClick={onNovoProjeto}>+ Novo</Btn>
      </div>
      {/* Chips de filtros ativos + contador */}
      <div style={{marginTop:8,display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
        <span style={{fontSize:12,color:C.cinzaClaro}}>{filtrados.length} projeto(s)</span>
        {fResp!=="todos"&&<span style={{display:"flex",alignItems:"center",gap:4,fontSize:11,background:"#e8f4fd",color:C.azulMedio,border:`1px solid ${C.azulMedio}40`,borderRadius:20,padding:"2px 10px",fontWeight:600}}>
          👤 {fResp}<button onClick={()=>setFR("todos")} style={{background:"none",border:"none",cursor:"pointer",color:C.azulMedio,fontSize:13,padding:"0 0 0 4px",lineHeight:1}}>×</button>
        </span>}
        {fStatus!=="todos"&&<span style={{display:"flex",alignItems:"center",gap:4,fontSize:11,background:(STATUS_CONFIG[fStatus]||{}).bg||"#f1f5f9",color:(STATUS_CONFIG[fStatus]||{}).cor||C.cinzaClaro,border:`1px solid ${(STATUS_CONFIG[fStatus]||{}).cor||C.cinzaCard}40`,borderRadius:20,padding:"2px 10px",fontWeight:600}}>
          {(STATUS_CONFIG[fStatus]||{}).icone} {fStatus}<button onClick={()=>setFS("todos")} style={{background:"none",border:"none",cursor:"pointer",color:"inherit",fontSize:13,padding:"0 0 0 4px",lineHeight:1}}>×</button>
        </span>}
        {fTipo!=="todos"&&<span style={{display:"flex",alignItems:"center",gap:4,fontSize:11,background:"#f1f5f9",color:C.azulEscuro,border:`1px solid ${C.cinzaCard}`,borderRadius:20,padding:"2px 10px",fontWeight:600}}>
          {fTipo} – {TIPOS[fTipo]}<button onClick={()=>setFT("todos")} style={{background:"none",border:"none",cursor:"pointer",color:C.cinzaClaro,fontSize:13,padding:"0 0 0 4px",lineHeight:1}}>×</button>
        </span>}
        {fAno!=="todos"&&<span style={{display:"flex",alignItems:"center",gap:4,fontSize:11,background:"#f1f5f9",color:C.azulEscuro,border:`1px solid ${C.cinzaCard}`,borderRadius:20,padding:"2px 10px",fontWeight:600}}>
          📅 {fAno}<button onClick={()=>setFA("todos")} style={{background:"none",border:"none",cursor:"pointer",color:C.cinzaClaro,fontSize:13,padding:"0 0 0 4px",lineHeight:1}}>×</button>
        </span>}
        {busca&&<span style={{display:"flex",alignItems:"center",gap:4,fontSize:11,background:"#f1f5f9",color:C.azulEscuro,border:`1px solid ${C.cinzaCard}`,borderRadius:20,padding:"2px 10px",fontWeight:600}}>
          🔍 "{busca}"<button onClick={()=>setBusca("")} style={{background:"none",border:"none",cursor:"pointer",color:C.cinzaClaro,fontSize:13,padding:"0 0 0 4px",lineHeight:1}}>×</button>
        </span>}
        {(fResp!=="todos"||fStatus!=="todos"||fTipo!=="todos"||fAno!=="todos"||busca)&&(
          <button onClick={()=>{setFR("todos");setFS("todos");setFT("todos");setFA("todos");setBusca("");}}
            style={{fontSize:11,background:"none",border:`1px solid ${C.cinzaCard}`,borderRadius:20,padding:"2px 10px",cursor:"pointer",color:C.cinzaClaro,fontFamily:"inherit"}}>
            Limpar tudo
          </button>
        )}
      </div>
    </Card>
    {view==="grid"?<div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))",gap:14}}>{filtrados.map(p=><CardProjeto key={p.id} p={p} onClick={()=>onAbrirProjeto(p)}/>)}</div>:<TabelaProjetos projetos={filtrados} onAbrirProjeto={onAbrirProjeto}/>}
  </div>);
}

// ─── DASHBOARD ─────────────────────────────────────────────────────────────────
function PainelAlertas({projetos, onAbrirProjeto}) {
  const ativos = projetos.filter(p => !["CONCLUÍDO","CANCELADO"].includes(statusN(p.status)));
  const semContrato  = ativos.filter(p => !p.temContrato);
  const semArt       = ativos.filter(p => !(p.obs||"").toLowerCase().includes("art") && !p.temContrato);
  const atrasados    = ativos.filter(p => statusN(p.status) === "ATRASADO");
  const vencendo     = ativos.filter(p => { const d=diasAte(p.dataEntregaPrevista); return d!==null&&d>=0&&d<=14; });
  const vencidos     = ativos.filter(p => { const d=diasAte(p.dataEntregaPrevista); return d!==null&&d<0&&statusN(p.status)!=="ATRASADO"; });

  const total = semContrato.length + atrasados.length + vencendo.length + vencidos.length;
  const [filtro, setFiltro] = useState("todos");

  const grupos = [
    { id:"semContrato", label:"Sem Contrato",       cor:"#92400e", bg:"#fffbeb", borda:"#fde68a", icone:"📋", lista:semContrato },
    { id:"atrasados",   label:"Atrasados",           cor:C.vermelho, bg:"#fff5f5", borda:"#fecaca", icone:"⚠️", lista:atrasados },
    { id:"vencendo",    label:"Prazo Vencendo (14d)", cor:C.laranja, bg:"#fff7ed", borda:"#fed7aa", icone:"⏰", lista:vencendo },
    { id:"vencidos",    label:"Prazo Vencido",        cor:"#9333ea", bg:"#faf5ff", borda:"#e9d5ff", icone:"📅", lista:vencidos },
  ];

  const listaFiltrada = filtro==="todos"
    ? grupos.flatMap(g=>g.lista.map(p=>({...p,_alertaTipo:g.id,_alertaCor:g.cor,_alertaBg:g.bg,_alertaBorda:g.borda,_alertaLabel:g.label})))
    : (grupos.find(g=>g.id===filtro)?.lista||[]).map(p=>({...p,_alertaTipo:filtro,_alertaCor:grupos.find(g=>g.id===filtro)?.cor,_alertaBg:grupos.find(g=>g.id===filtro)?.bg,_alertaBorda:grupos.find(g=>g.id===filtro)?.borda,_alertaLabel:grupos.find(g=>g.id===filtro)?.label}));

  // Deduplicar por id
  const vistos=new Set();
  const listaDedup=listaFiltrada.filter(p=>{ if(vistos.has(p.id)) return false; vistos.add(p.id); return true; });

  return (
    <div style={{display:"flex",flexDirection:"column",gap:16}}>
      {/* Resumo */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:12}}>
        {[{id:"todos",label:"Total de Alertas",valor:total,cor:C.vermelho,i:"🔔"},
          ...grupos.map(g=>({id:g.id,label:g.label,valor:g.lista.length,cor:g.cor,i:g.icone}))
        ].map(k=>(
          <div key={k.id} onClick={()=>setFiltro(k.id)}
            style={{padding:"12px 14px",borderRadius:10,background:filtro===k.id?k.cor:"white",border:`2px solid ${filtro===k.id?k.cor:C.cinzaCard}`,cursor:"pointer",textAlign:"center",transition:"all 0.2s",boxShadow:filtro===k.id?"0 4px 12px rgba(0,0,0,0.15)":"none"}}>
            <div style={{fontSize:20}}>{k.i}</div>
            <div style={{fontSize:22,fontWeight:800,color:filtro===k.id?"white":k.cor,lineHeight:1}}>{k.valor}</div>
            <div style={{fontSize:10,color:filtro===k.id?"rgba(255,255,255,0.85)":C.cinzaClaro,fontWeight:600,marginTop:3}}>{k.label}</div>
          </div>
        ))}
      </div>

      {/* Lista */}
      <Card>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
          <h3 style={{color:C.azulEscuro,margin:0,fontSize:14,fontWeight:700}}>
            {filtro==="todos"?"Todos os Alertas":grupos.find(g=>g.id===filtro)?.label} ({listaDedup.length})
          </h3>
        </div>
        {listaDedup.length===0
          ? <p style={{textAlign:"center",color:C.verde,padding:20,fontWeight:600}}>✅ Nenhum alerta nesta categoria!</p>
          : <div style={{display:"flex",flexDirection:"column",gap:6}}>
            {listaDedup.map(p=>{
              const d = diasAte(p.dataEntregaPrevista);
              return (
                <div key={p.id+p._alertaTipo} onClick={()=>onAbrirProjeto(p)}
                  style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 14px",
                    background:p._alertaBg,borderRadius:8,cursor:"pointer",border:`1px solid ${p._alertaBorda}`,
                    transition:"all 0.15s"}}
                  onMouseEnter={e=>e.currentTarget.style.opacity="0.85"}
                  onMouseLeave={e=>e.currentTarget.style.opacity="1"}>
                  <div style={{flex:1}}>
                    <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                      <span style={{fontSize:12,fontWeight:800,color:C.azulMedio}}>{p.codigo}</span>
                      <span style={{fontSize:11,background:p._alertaCor,color:"white",padding:"1px 7px",borderRadius:10,fontWeight:700}}>{p._alertaLabel}</span>
                    </div>
                    <div style={{fontSize:12,color:C.cinzaEscuro,marginTop:3}}>{p.cliente.substring(0,55)}</div>
                    {p.responsavel&&<div style={{fontSize:11,color:C.cinzaClaro,marginTop:2}}>👤 {p.responsavel}</div>}
                  </div>
                  <div style={{textAlign:"right",flexShrink:0,marginLeft:12}}>
                    {d!==null&&<div style={{fontSize:12,fontWeight:700,color:d<0?C.vermelho:d<=7?C.laranja:C.amarelo}}>
                      {d<0?`${Math.abs(d)}d atrasado`:d===0?"Vence hoje":`${d}d restantes`}
                    </div>}
                    <div style={{fontSize:10,color:C.cinzaClaro}}>{p.dataEntregaPrevista?`Entrega: ${p.dataEntregaPrevista.split("-").reverse().join("/")}`:""}</div>
                  </div>
                </div>
              );
            })}
          </div>}
      </Card>
    </div>
  );
}


// ─── PAINEL DE ENTREGAS ────────────────────────────────────────────────────────
function PainelEntregas({ projetos, onAbrirProjeto }) {
  const [filtroStatus, setFiltroStatus] = useState("todos");
  const hoje = new Date();
  const anoAtual = hoje.getFullYear();
  const mesAtual = hoje.getMonth(); // 0-indexed

  // Gerar lista de meses disponíveis (últimos 12 + próximos 3)
  const meses = [];
  for(let i = -11; i <= 3; i++){
    const d = new Date(anoAtual, mesAtual + i, 1);
    meses.push({ value: `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`, label: d.toLocaleDateString('pt-BR',{month:'long',year:'numeric'}) });
  }
  const mesAtualStr = `${anoAtual}-${String(mesAtual+1).padStart(2,'0')}`;
  const [filtroMes, setFiltroMes] = useState(mesAtualStr);

  // Filtrar projetos pelo mês selecionado (por dataEntregaPrevista ou dataEntregaReal)
  const projetosMes = projetos.filter(p => {
    const ref = p.dataEntregaReal || p.dataEntregaPrevista;
    if(!ref) return false;
    return ref.slice(0,7) === filtroMes;
  });

  // Agrupar por status
  const porStatus = {
    concluidos:  projetosMes.filter(p => ["CONCLUÍDO","Concluído"].includes(statusN(p.status))),
    atrasados:   projetosMes.filter(p => statusN(p.status)==="ATRASADO"),
    pausados:    projetosMes.filter(p => statusN(p.status)==="PAUSADO"),
    andamento:   projetosMes.filter(p => statusN(p.status)==="Em andamento"),
    novos:       projetosMes.filter(p => statusN(p.status)==="Novo/Definir"),
    cancelados:  projetosMes.filter(p => statusN(p.status)==="CANCELADO"),
  };

  const comEntregaReal = projetosMes.filter(p => p.dataEntregaReal);
  const noPrazo  = comEntregaReal.filter(p => p.dataEntregaReal <= p.dataEntregaPrevista);
  const taxa = comEntregaReal.length > 0 ? Math.round((noPrazo.length / comEntregaReal.length) * 100) : null;

  const resumos = [
    { id:"todos",      label:"Todos",         valor:projetosMes.length,           cor:C.azulMedio },
    { id:"concluidos", label:"✓ Concluídos",  valor:porStatus.concluidos.length,  cor:C.verde },
    { id:"andamento",  label:"▶ Em Andamento",valor:porStatus.andamento.length,   cor:C.azulMedio },
    { id:"atrasados",  label:"⚠ Atrasados",   valor:porStatus.atrasados.length,   cor:C.vermelho },
    { id:"pausados",   label:"⏸ Pausados",    valor:porStatus.pausados.length,    cor:C.amarelo },
    { id:"novos",      label:"○ Novo/Definir", valor:porStatus.novos.length,      cor:C.cinzaClaro },
    { id:"cancelados", label:"✕ Cancelados",  valor:porStatus.cancelados.length,  cor:"#9333ea" },
  ];

  const listaFiltrada = filtroStatus==="todos" ? projetosMes : (porStatus[filtroStatus]||[]);

  const diasAtraso = (p) => {
    if (!p.dataEntregaReal || !p.dataEntregaPrevista) return 0;
    return Math.ceil((new Date(p.dataEntregaReal) - new Date(p.dataEntregaPrevista)) / 86400000);
  };

  return (
    <div style={{display:"flex",flexDirection:"column",gap:16}}>
      {/* Seletor de mês */}
      <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
        <label style={{fontSize:12,fontWeight:700,color:C.cinzaEscuro}}>📅 Período:</label>
        <select value={filtroMes} onChange={e=>setFiltroMes(e.target.value)}
          style={{border:`1.5px solid ${C.cinzaCard}`,borderRadius:8,padding:"6px 12px",fontSize:13,fontFamily:"inherit",color:C.cinzaEscuro,cursor:"pointer",background:"white"}}>
          {meses.map(m=><option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
        {taxa!==null&&<span style={{fontSize:12,fontWeight:700,color:taxa>=80?C.verde:taxa>=50?C.amarelo:C.vermelho,marginLeft:"auto"}}>
          Taxa no prazo: {taxa}%
        </span>}
      </div>

      {/* KPIs por status */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))",gap:10}}>
        {resumos.map(f=>(
          <div key={f.id} onClick={()=>setFiltroStatus(f.id)}
            style={{padding:"12px 14px",borderRadius:10,background:filtroStatus===f.id?f.cor:"white",
              border:`2px solid ${filtroStatus===f.id?f.cor:C.cinzaCard}`,cursor:"pointer",textAlign:"center",
              transition:"all 0.2s",boxShadow:filtroStatus===f.id?"0 4px 12px rgba(0,0,0,0.15)":"none"}}>
            <div style={{fontSize:26,fontWeight:900,color:filtroStatus===f.id?"white":f.cor,lineHeight:1}}>{f.valor}</div>
            <div style={{fontSize:10,color:filtroStatus===f.id?"rgba(255,255,255,0.85)":C.cinzaClaro,fontWeight:600,marginTop:4}}>{f.label}</div>
          </div>
        ))}
      </div>

      {/* Tabela */}
      <Card style={{padding:0,overflow:"hidden"}}>
        <div style={{padding:"14px 20px",borderBottom:`1px solid ${C.cinzaCard}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <h3 style={{color:C.azulEscuro,margin:0,fontSize:14,fontWeight:700}}>
            📦 Projetos do período ({listaFiltrada.length})
          </h3>
        </div>
        <div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
            <thead>
              <tr style={{background:C.azulEscuro}}>
                {["Código","Projeto","Responsável","Entrega Prevista","Entrega Real","Resultado","Dias"].map(h=>(
                  <th key={h} style={{padding:"10px 14px",color:C.ciano,textAlign:"left",fontWeight:700,fontSize:11,whiteSpace:"nowrap"}}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {listaFiltrada.length === 0 && (
                <tr><td colSpan={7} style={{padding:"24px",textAlign:"center",color:C.cinzaClaro}}>Nenhum projeto nesta categoria.</td></tr>
              )}
              {listaFiltrada.sort((a,b)=>(a.dataEntregaPrevista||"").localeCompare(b.dataEntregaPrevista||"")).map((p,i)=>{
                const atr  = diasAtraso(p);
                const dias = p.dataEntregaPrevista ? Math.ceil((new Date(p.dataEntregaPrevista)-new Date())/86400000) : null;
                let resultado, resCor, resBg;
                if (p.dataEntregaReal) {
                  if (atr <= 0)       { resultado="✓ No Prazo";    resCor=C.verde;    resBg="#f0fdf4"; }
                  else                { resultado=`⚠ ${atr}d atraso`; resCor=C.vermelho; resBg="#fff5f5"; }
                } else if (dias!==null && dias < 0) {
                  resultado="🔴 Vencido"; resCor="#9333ea"; resBg="#faf5ff";
                } else {
                  resultado="⏳ Aguardando"; resCor=C.amarelo; resBg="#fffbeb";
                }
                return (
                  <tr key={p.id} onClick={()=>onAbrirProjeto(p)}
                    style={{borderBottom:`1px solid ${C.cinzaFundo}`,cursor:"pointer",background:i%2===0?C.branco:"#f8fafc"}}
                    onMouseEnter={e=>e.currentTarget.style.background="#e8f4fd"}
                    onMouseLeave={e=>e.currentTarget.style.background=i%2===0?C.branco:"#f8fafc"}>
                    <td style={{padding:"9px 14px",fontWeight:700,color:C.azulMedio}}>{p.codigo}</td>
                    <td style={{padding:"9px 14px",maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.cliente}</td>
                    <td style={{padding:"9px 14px",color:C.cinzaClaro}}>{[p.responsavel,p.coresponsavel,p.coresponsavel2,p.coresponsavel3].filter(Boolean).join(", ")||"—"}</td>
                    <td style={{padding:"9px 14px",color:C.cinzaClaro,whiteSpace:"nowrap"}}>{fmtData(p.dataEntregaPrevista)}</td>
                    <td style={{padding:"9px 14px",color:p.dataEntregaReal?C.cinzaEscuro:C.cinzaClaro,whiteSpace:"nowrap"}}>{p.dataEntregaReal?fmtData(p.dataEntregaReal):"—"}</td>
                    <td style={{padding:"9px 14px"}}>
                      <span style={{background:resBg,color:resCor,padding:"2px 10px",borderRadius:20,fontSize:11,fontWeight:700,whiteSpace:"nowrap"}}>{resultado}</span>
                    </td>
                    <td style={{padding:"9px 14px",fontSize:11,fontWeight:700,color:atr>0?C.vermelho:dias!==null&&dias<=3?C.laranja:C.cinzaClaro}}>
                      {p.dataEntregaReal ? (atr>0?`+${atr}d`:atr===0?"Exato":`${Math.abs(atr)}d antes`) : (dias!==null?(dias<0?`${Math.abs(dias)}d vencido`:`${dias}d restantes`):"—")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function Dashboard({projetos,onAbrirProjeto,drive,onImportar,usuarioAtual}){
  const [abaD,setAbaD] = useState("visao");
  const isColab = usuarioAtual?.perfil==="colaborador";
  // Para colaboradores: filtrar apenas projetos onde é responsável
  const ehMeuProj = p => !isColab || p.responsavel===usuarioAtual?.nome
    || p.coresponsavel===usuarioAtual?.nome
    || p.coresponsavel2===usuarioAtual?.nome
    || p.coresponsavel3===usuarioAtual?.nome;
  const projetosVisiveis = projetos.filter(ehMeuProj);

  const ativos=projetosVisiveis.filter(p=>!["CONCLUÍDO","CANCELADO"].includes(statusN(p.status)));
  const porStatus={};projetosVisiveis.forEach(p=>{const s=statusN(p.status);porStatus[s]=(porStatus[s]||0)+1;});
  const recTotal=projetosVisiveis.reduce((a,p)=>a+(p.parcelas||[]).reduce((b,x)=>b+x.valor,0),0);
  const recRecebida=projetosVisiveis.reduce((a,p)=>a+(p.parcelas||[]).reduce((b,x)=>b+(x.pago?x.valor:0),0),0);
  const porTipo={};projetosVisiveis.forEach(p=>{porTipo[p.tipo]=(porTipo[p.tipo]||0)+1;});
  const semC=ativos.filter(p=>!p.temContrato);
  const totalAlertas=ativos.filter(p=>!p.temContrato||statusN(p.status)==="ATRASADO"||(()=>{const d=diasAte(p.dataEntregaPrevista);return d!==null&&d<=14;})()).length;

  return(<div style={{display:"flex",flexDirection:"column",gap:20}}>
    {/* Sub-abas do Dashboard */}
    {isColab&&(
      <div style={{padding:"12px 16px",background:"#eff6ff",borderRadius:10,border:`1px solid ${C.azulClaro}`,marginBottom:-4}}>
        <span style={{fontSize:13,color:C.azulMedio,fontWeight:600}}>
          👤 Exibindo projetos atribuídos a <strong>{usuarioAtual?.nome}</strong>
        </span>
      </div>
    )}
    <div style={{display:"flex",gap:4,borderBottom:`2px solid ${C.cinzaCard}`,paddingBottom:0}}>
      {[
        {id:"visao",   label:"📊 Visão Geral"},
        {id:"alertas", label:`🔔 Alertas${totalAlertas>0?` (${totalAlertas})`:""}`},
        {id:"entregas",label:"📦 Entregas"},
      ].map(t=>(
        <button key={t.id} onClick={()=>setAbaD(t.id)} style={{background:"none",border:"none",padding:"10px 18px",cursor:"pointer",fontSize:13,fontFamily:"inherit",fontWeight:abaD===t.id?700:500,color:abaD===t.id?C.azulMedio:C.cinzaClaro,borderBottom:abaD===t.id?`2px solid ${C.azulMedio}`:"2px solid transparent",marginBottom:-2,transition:"all 0.15s"}}>
          {t.label}
        </button>
      ))}
    </div>

    {abaD==="alertas"   && <PainelAlertas projetos={projetosVisiveis} onAbrirProjeto={onAbrirProjeto}/>}
    {abaD==="entregas"  && <PainelEntregas projetos={projetosVisiveis} onAbrirProjeto={onAbrirProjeto}/>}

    {abaD==="visao" && <>
      {!isColab && <PainelDrive drive={drive} projetosExistentes={projetos} onImportar={onImportar}/>}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:16}}>
        {[{label:"Ativos",valor:ativos.length,cor:C.azulMedio,i:"📂"},{label:"Concluídos",valor:porStatus["CONCLUÍDO"]||0,cor:C.verde,i:"✅"},{label:"Atrasados",valor:porStatus["ATRASADO"]||0,cor:C.vermelho,i:"⚠️"},{label:"Pausados",valor:porStatus["PAUSADO"]||0,cor:C.amarelo,i:"⏸"}].map(k=>(
          <Card key={k.label} style={{textAlign:"center",borderTop:`3px solid ${k.cor}`}}><div style={{fontSize:26}}>{k.i}</div><div style={{fontSize:34,fontWeight:800,color:k.cor,lineHeight:1}}>{k.valor}</div><div style={{fontSize:12,color:C.cinzaClaro,fontWeight:600,marginTop:4}}>{k.label}</div></Card>
        ))}
        {!isColab&&<Card style={{textAlign:"center",borderTop:`3px solid ${C.verde}`}}><div style={{fontSize:26}}>💰</div><div style={{fontSize:18,fontWeight:800,color:C.verde,lineHeight:1}}>{fmt(recRecebida)}</div><div style={{fontSize:11,color:C.cinzaClaro}}>de {fmt(recTotal)}</div><div style={{fontSize:12,color:C.cinzaClaro,fontWeight:600}}>Receita</div></Card>}
        <Card style={{textAlign:"center",borderTop:`3px solid ${C.laranja}`}}><div style={{fontSize:26}}>📋</div><div style={{fontSize:34,fontWeight:800,color:C.laranja,lineHeight:1}}>{semC.length}</div><div style={{fontSize:12,color:C.cinzaClaro,fontWeight:600,marginTop:4}}>Sem Contrato</div></Card>
      </div>
      <Card><h3 style={{color:C.azulEscuro,margin:"0 0 16px",fontSize:14,fontWeight:700}}>📊 Projetos por Tipo</h3><div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))",gap:10}}>{Object.entries(porTipo).sort((a,b)=>b[1]-a[1]).map(([tipo,qtd])=><div key={tipo} style={{padding:"10px 14px",background:C.cinzaFundo,borderRadius:8,display:"flex",justifyContent:"space-between",alignItems:"center"}}><div><div style={{fontSize:12,fontWeight:800,color:C.azulEscuro}}>{tipo}</div><div style={{fontSize:10,color:C.cinzaClaro}}>{TIPOS[tipo]||tipo}</div></div><span style={{fontSize:22,fontWeight:800,color:C.azulMedio}}>{qtd}</span></div>)}</div></Card>
      {(()=>{
        // Colaborador vê só os seus; gestor/admin vê todos
        const ehMeu = p => p.responsavel===usuarioAtual?.nome || p.coresponsavel===usuarioAtual?.nome
          || p.coresponsavel2===usuarioAtual?.nome || p.coresponsavel3===usuarioAtual?.nome;
        const minhaLista = isColab ? ativos.filter(ehMeu) : ativos;
        if (minhaLista.length === 0) return (
          <div style={{padding:"24px",background:C.cinzaFundo,borderRadius:12,textAlign:"center",color:C.cinzaClaro}}>
            <div style={{fontSize:32,marginBottom:8}}>✅</div>
            <div style={{fontWeight:700,fontSize:14}}>Nenhum projeto em aberto atribuído a você</div>
          </div>
        );
        return (
          <div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
              <h3 style={{color:C.azulEscuro,margin:0,fontSize:14,fontWeight:700}}>
                🔥 {isColab?"Meus Projetos em Aberto":"Projetos em Aberto"}
              </h3>
              <span style={{fontSize:11,color:C.cinzaClaro}}>{minhaLista.length} projeto(s)</span>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))",gap:14}}>
              {minhaLista.map(p=><CardProjeto key={p.id} p={p} onClick={()=>onAbrirProjeto(p)}/>)}
            </div>
          </div>
        );
      })()}
    </>}
  </div>);
}

// ─── FINANCEIRO ────────────────────────────────────────────────────────────────
function Financeiro({projetos}){
  const com=projetos.filter(p=>(p.parcelas||[]).length>0);
  const tot=com.reduce((a,p)=>a+p.parcelas.reduce((b,x)=>b+x.valor,0),0);
  const rec=com.reduce((a,p)=>a+p.parcelas.reduce((b,x)=>b+(x.pago?x.valor:0),0),0);
  return(<div style={{display:"flex",flexDirection:"column",gap:20}}>
    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:16}}>
      <Card style={{borderTop:`3px solid ${C.azulMedio}`,textAlign:"center"}}><div style={{fontSize:11,color:C.cinzaClaro,fontWeight:700,marginBottom:4}}>TOTAL CONTRATADO</div><div style={{fontSize:26,fontWeight:800,color:C.azulMedio}}>{fmt(tot)}</div></Card>
      <Card style={{borderTop:`3px solid ${C.verde}`,textAlign:"center"}}><div style={{fontSize:11,color:C.cinzaClaro,fontWeight:700,marginBottom:4}}>RECEBIDO</div><div style={{fontSize:26,fontWeight:800,color:C.verde}}>{fmt(rec)}</div><div style={{fontSize:11,color:C.cinzaClaro}}>{tot>0?((rec/tot)*100).toFixed(0):0}%</div></Card>
      <Card style={{borderTop:`3px solid ${C.amarelo}`,textAlign:"center"}}><div style={{fontSize:11,color:C.cinzaClaro,fontWeight:700,marginBottom:4}}>A RECEBER</div><div style={{fontSize:26,fontWeight:800,color:C.amarelo}}>{fmt(tot-rec)}</div></Card>
    </div>
    <Card style={{padding:0,overflow:"hidden"}}>
      <div style={{padding:"14px 20px",borderBottom:`1px solid ${C.cinzaCard}`}}><h3 style={{color:C.azulEscuro,margin:0,fontSize:14,fontWeight:700}}>💰 Extrato por Projeto</h3></div>
      <div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}><thead><tr style={{background:C.cinzaFundo}}>{["Projeto","Status","Total","Recebido","Pendente","Progresso"].map(h=><th key={h} style={{padding:"8px 12px",color:C.cinzaEscuro,textAlign:"left",fontWeight:700,fontSize:11,borderBottom:`2px solid ${C.cinzaCard}`}}>{h}</th>)}</tr></thead><tbody>{com.map((p,i)=>{const t=p.parcelas.reduce((a,x)=>a+x.valor,0);const r=p.parcelas.reduce((a,x)=>a+(x.pago?x.valor:0),0);return <tr key={p.id} style={{borderBottom:`1px solid ${C.cinzaFundo}`,background:i%2===0?C.branco:"#fafbfc"}}><td style={{padding:"9px 12px"}}><div style={{fontWeight:600,color:C.azulMedio,fontSize:12}}>{p.codigo}</div><div style={{fontSize:11,color:C.cinzaClaro}}>{p.cliente.substring(0,35)}...</div></td><td style={{padding:"9px 12px"}}><Badge status={p.status}/></td><td style={{padding:"9px 12px",fontWeight:700}}>{fmt(t)}</td><td style={{padding:"9px 12px",color:C.verde,fontWeight:600}}>{fmt(r)}</td><td style={{padding:"9px 12px",color:(t-r)>0?C.amarelo:C.cinzaClaro,fontWeight:(t-r)>0?700:400}}>{fmt(t-r)}</td><td style={{padding:"9px 12px"}}><div style={{background:C.cinzaFundo,borderRadius:4,height:6,width:80}}><div style={{background:r===t?C.verde:C.azulClaro,height:6,borderRadius:4,width:`${t>0?(r/t)*100:0}%`}}/></div></td></tr>;})} </tbody></table></div>
    </Card>
  </div>);
}

// ─── APP ───────────────────────────────────────────────────────────────────────

// ══════════════════════════════════════════════════════════════════════════════
// CHAT INTEC
// ══════════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════════════
// CHAT INTEC — reescrito com realtime correto
// ══════════════════════════════════════════════════════════════════════════════
// ─── CHAT UI (estado vive no App) ────────────────────────────────────────────
function Chat({
  usuario, usuarios,
  // estado gerenciado pelo App:
  canais, canalAtivo, onSelecionarCanal,
  mensagens, naoLidos,
  onEnviar, onIniciarDM, onCriarCanal, onDeletarDM,
  onFechar, flutuante,
}) {
  const [texto,        setTexto]     = useState("");
  const [carregando,   setCarreg]    = useState(false);
  const [mostrarEmoji, setEmoji]     = useState(false);
  const [mostrarDM,    setMostrarDM] = useState(false);
  const [criandoCanal, setCriando]   = useState(false);
  const [novoCanal,    setNovoCanal] = useState({nome:"",descricao:"",icone:"💬"});
  const [confirmDelDM, setConfirmDelDM] = useState(null);
  const [sugestoes,    setSugestoes]    = useState([]);
  const [sugestaoIdx,  setSugestaoIdx]  = useState(0);
  const isGestor = ["admin","gestor"].includes(usuario?.perfil);
  const mensagensRef = useRef(null);
  const inputRef     = useRef(null);
  const prevCanalId  = useRef(null);

  const EMOJIS = ["😀","😂","👍","👎","❤️","🔥","✅","⚠️","📋","📁","💰","🏗","🎉","👀","🤔","💡"];

  // ── Scroll automático quando mensagens mudam ─────────────────────────────
  useEffect(()=>{
    if(mensagensRef.current)
      mensagensRef.current.scrollTop = mensagensRef.current.scrollHeight;
  },[mensagens]);

  // ── Focar input ao trocar de canal ───────────────────────────────────────
  useEffect(()=>{
    if(!canalAtivo) return;
    if(prevCanalId.current !== canalAtivo?.id){
      prevCanalId.current = canalAtivo?.id;
      setTimeout(()=>inputRef.current?.focus(), 100);
    }
  },[canalAtivo?.id]);

  // ── Enviar mensagem ──────────────────────────────────────────────────────
  const selecionarMencao = (u) => {
    const cursor = inputRef.current?.selectionStart || texto.length;
    const atPos  = texto.lastIndexOf("@", cursor-1);
    const antes  = texto.slice(0, atPos);
    const depois = texto.slice(cursor);
    const novoTexto = `${antes}@${u.nome} ${depois}`;
    setTexto(novoTexto);
    setSugestoes([]);
    setTimeout(()=>{
      const pos = (antes+"@"+u.nome+" ").length;
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(pos, pos);
    }, 0);
  };

  const enviar = () => {
    if(!texto.trim()||!canalAtivo||!usuario) return;
    const mencoes = usuarios.filter(u=>texto.includes(`@${u.nome}`)).map(u=>u.id);
    onEnviar(canalAtivo.id, texto.trim(), mencoes);
    setTexto("");
    inputRef.current?.focus();
  };

  const iniciarDM = async(outro) => {
    await onIniciarDM(outro);
    setMostrarDM(false);
  };

  const deletarDM = async(canalId) => {
    await onDeletarDM(canalId);
    setConfirmDelDM(null);
  };

  const criarCanalNovo = async() => {
    if(!novoCanal.nome.trim()) return;
    await onCriarCanal(novoCanal);
    setCriando(false);
    setNovoCanal({nome:"",descricao:"",icone:"💬"});
  };

  // ── Helpers ──────────────────────────────────────────────────────────────
  const fmtHora = iso=>new Date(iso).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"});
  const fmtDia  = iso=>{
    const d=new Date(iso),h=new Date();
    if(d.toDateString()===h.toDateString()) return "Hoje";
    const on=new Date(h); on.setDate(h.getDate()-1);
    if(d.toDateString()===on.toDateString()) return "Ontem";
    return d.toLocaleDateString("pt-BR",{day:"2-digit",month:"short"});
  };
  const renderTexto = txt=>{
    return txt.split(/(@\w+(?:\s\w+)?)/g).map((p,i)=>{
      if(p.startsWith("@")){
        const u=usuarios.find(x=>`@${x.nome}`===p||p===`@${x.nome}`);
        if(u) return <span key={i} style={{background:"#dbeafe",color:"#1d4ed8",borderRadius:4,padding:"0 4px",fontWeight:700,fontSize:12}}>{p}</span>;
      }
      return <span key={i}>{p}</span>;
    });
  };
  return(
    <div style={{display:"flex",height:480,background:C.branco,borderRadius:14,overflow:"hidden",border:`1px solid ${C.cinzaCard}`,boxShadow:"0 8px 32px rgba(0,0,0,0.2)",position:"relative"}}>

      {/* ── SIDEBAR ── */}
      <div style={{width:220,background:C.azulEscuro,display:"flex",flexDirection:"column",flexShrink:0}}>
        <div style={{padding:"14px 12px 10px",borderBottom:"1px solid rgba(255,255,255,0.1)"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
            <span style={{color:C.branco,fontWeight:800,fontSize:14}}>💬 Chat INTEC</span>
            <button onClick={onFechar} style={{background:"none",border:"none",color:"rgba(255,255,255,0.5)",cursor:"pointer",fontSize:16,padding:0}}>✕</button>
          </div>
          <div style={{color:C.ciano,fontSize:10,marginTop:3}}>● {usuario?.nome}</div>
        </div>

        <div style={{flex:1,overflowY:"auto",padding:"6px 0"}}>
          {/* Canais públicos */}
          <div style={{padding:"6px 12px 2px",fontSize:9,fontWeight:700,color:"rgba(255,255,255,0.35)",letterSpacing:1}}>CANAIS</div>
          {canais.filter(c=>c.tipo==="canal").map(c=>{
            const nl=naoLidos[c.id]||0;
            const ativo=canalAtivo?.id===c.id;
            return(
              <div key={c.id} onClick={()=>onSelecionarCanal(c)}
                style={{padding:"7px 12px",cursor:"pointer",borderRadius:6,margin:"1px 6px",
                  background:ativo?"rgba(255,255,255,0.15)":"transparent",
                  display:"flex",alignItems:"center",gap:8}}
                onMouseEnter={e=>{if(!ativo)e.currentTarget.style.background="rgba(255,255,255,0.07)";}}
                onMouseLeave={e=>{if(!ativo)e.currentTarget.style.background="transparent";}}>
                <span style={{fontSize:14}}>{c.icone}</span>
                <span style={{color:ativo?C.branco:"rgba(255,255,255,0.7)",fontSize:13,fontWeight:ativo||nl>0?700:400,flex:1}}># {c.nome}</span>
                {nl>0&&<span style={{background:C.vermelho,color:"#fff",borderRadius:10,fontSize:10,fontWeight:800,padding:"1px 5px",minWidth:18,textAlign:"center"}}>{nl>99?"99+":nl}</span>}
                {isGestor&&<button onClick={e=>{e.stopPropagation();if(window.confirm(`Excluir canal #${c.nome}?`))onDeletarDM(c.id);}}
                  style={{background:"none",border:"none",color:"rgba(255,255,255,0.3)",cursor:"pointer",fontSize:12,padding:0,opacity:0,transition:"opacity 0.1s"}}
                  onMouseEnter={e=>e.currentTarget.style.opacity=1} onMouseLeave={e=>e.currentTarget.style.opacity=0}>🗑</button>}
              </div>
            );
          })}

          {/* DMs */}
          <div style={{padding:"10px 12px 2px",fontSize:9,fontWeight:700,color:"rgba(255,255,255,0.35)",letterSpacing:1,marginTop:6}}>MENSAGENS DIRETAS</div>
          {canais.filter(c=>c.tipo==="direto").map(c=>{
            const nomeOutro=(c.nome||"").split("↔").find(n=>n.trim()!==usuario?.nome)?.trim()||c.nome||"";
            const outroU=usuarios.find(u=>u.nome===nomeOutro);
            const nl=naoLidos[c.id]||0;
            const ativo=canalAtivo?.id===c.id;
            return(
              <div key={c.id} style={{padding:"6px 12px",display:"flex",alignItems:"center",gap:8,
                background:ativo?"rgba(255,255,255,0.15)":"transparent",
                borderRadius:6,margin:"1px 6px",cursor:"pointer",position:"relative"}}
                onClick={()=>onSelecionarCanal(c)}
                onMouseEnter={e=>{if(!ativo)e.currentTarget.style.background="rgba(255,255,255,0.07)";}}
                onMouseLeave={e=>{if(!ativo)e.currentTarget.style.background=ativo?"rgba(255,255,255,0.15)":"transparent";}}>
                <div style={{width:26,height:26,borderRadius:"50%",background:outroU?.cor||"#8492a6",display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:800,color:"#fff",flexShrink:0}}>
                  {nomeOutro.slice(0,2).toUpperCase()}
                </div>
                <span style={{fontSize:12,color:ativo?C.branco:"rgba(255,255,255,0.7)",fontWeight:ativo||nl>0?700:400,flex:1}}>{nomeOutro}</span>
                {nl>0&&<span style={{background:C.vermelho,color:"#fff",borderRadius:10,fontSize:10,fontWeight:800,padding:"1px 5px",minWidth:18,textAlign:"center"}}>{nl}</span>}
                <button onClick={e=>{e.stopPropagation();setConfirmDelDM(c.id);}}
                  style={{background:"rgba(255,255,255,0.08)",border:"none",color:"rgba(255,255,255,0.5)",cursor:"pointer",fontSize:12,padding:"2px 5px",borderRadius:4,flexShrink:0}}
                  title="Apagar conversa">🗑</button>
              </div>
            );
          })}

          <div style={{padding:"8px 12px",marginTop:4,display:"flex",flexDirection:"column",gap:4}}>
            <button onClick={()=>setMostrarDM(true)} style={{width:"100%",background:"rgba(255,255,255,0.08)",border:"1px dashed rgba(255,255,255,0.2)",borderRadius:6,padding:"5px",color:"rgba(255,255,255,0.5)",cursor:"pointer",fontSize:11,fontFamily:"inherit"}}>+ Nova conversa</button>
            {isGestor&&<button onClick={()=>setCriando(true)} style={{width:"100%",background:"rgba(255,255,255,0.08)",border:"1px dashed rgba(255,255,255,0.2)",borderRadius:6,padding:"5px",color:"rgba(255,255,255,0.5)",cursor:"pointer",fontSize:11,fontFamily:"inherit"}}>+ Novo canal</button>}
          </div>
        </div>
      </div>

      {/* ── ÁREA PRINCIPAL ── */}
      <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
        {canalAtivo&&(
          <div style={{padding:"10px 16px",borderBottom:`1px solid ${C.cinzaCard}`,display:"flex",alignItems:"center",gap:10,background:"#fafafa",flexShrink:0}}>
            <span style={{fontSize:18}}>{canalAtivo.icone}</span>
            <div style={{flex:1}}>
              <div style={{fontWeight:700,fontSize:14,color:C.cinzaEscuro}}>
                {canalAtivo.tipo==="canal"?"# ":""}{
                  canalAtivo.tipo==="direto"
                    ? (canalAtivo.nome||"").split("↔").find(n=>n.trim()!==usuario?.nome)?.trim()||canalAtivo.nome||""
                    : canalAtivo.nome
                }
              </div>
              {canalAtivo.descricao&&<div style={{fontSize:11,color:C.cinzaClaro}}>{canalAtivo.descricao}</div>}
            </div>
            <span style={{fontSize:11,color:C.cinzaClaro}}>{mensagens.length} msg(s)</span>
          </div>
        )}

        {/* Mensagens */}
        <div ref={mensagensRef} style={{flex:1,overflowY:"auto",padding:"10px 14px",display:"flex",flexDirection:"column",gap:1}}>
          {carregando&&<div style={{textAlign:"center",color:C.cinzaClaro,padding:20}}>⏳ Carregando...</div>}
          {!carregando&&mensagens.length===0&&(
            <div style={{textAlign:"center",color:C.cinzaClaro,padding:40}}>
              <div style={{fontSize:32,marginBottom:8}}>👋</div>
              <div style={{fontWeight:600}}>Início de {canalAtivo?.tipo==="direto"?"conversa":"# "+canalAtivo?.nome}</div>
            </div>
          )}
          {mensagens.map((msg,i)=>{
            const ant=mensagens[i-1];
            const mesmoDia=ant&&fmtDia(ant.created_at)===fmtDia(msg.created_at);
            const mesmoAut=ant&&ant.autor_id===msg.autor_id&&mesmoDia&&(new Date(msg.created_at)-new Date(ant.created_at))<5*60*1000;
            const ehMeu=msg.autor_id===usuario?.id;
            const mencionaMe=(msg.mencoes||[]).includes(usuario?.id);
            const isTemp=msg.id?.startsWith("temp-");
            return(
              <div key={msg.id}>
                {!mesmoDia&&<div style={{textAlign:"center",margin:"10px 0 6px"}}><span style={{background:C.cinzaCard,color:C.cinzaClaro,fontSize:10,padding:"2px 10px",borderRadius:10,fontWeight:600}}>{fmtDia(msg.created_at)}</span></div>}
                <div style={{display:"flex",gap:8,padding:"2px 4px",borderRadius:6,
                  background:mencionaMe?"#fef9c3":"transparent",opacity:isTemp?0.6:1}}>
                  {!mesmoAut?(
                    <div style={{width:32,height:32,borderRadius:"50%",background:msg.autor_cor||C.azulMedio,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:800,color:"#fff",flexShrink:0,marginTop:2}}>
                      {msg.autor_nome.slice(0,2).toUpperCase()}
                    </div>
                  ):<div style={{width:32,flexShrink:0}}/>}
                  <div style={{flex:1}}>
                    {!mesmoAut&&(
                      <div style={{display:"flex",alignItems:"baseline",gap:8,marginBottom:1}}>
                        <span style={{fontWeight:700,fontSize:13,color:msg.autor_cor||C.azulMedio}}>{msg.autor_nome}</span>
                        <span style={{fontSize:10,color:C.cinzaClaro}}>{fmtHora(msg.created_at)}</span>
                      </div>
                    )}
                    <div style={{fontSize:13,color:C.cinzaEscuro,lineHeight:1.5,wordBreak:"break-word"}}>
                      {renderTexto(msg.conteudo)}
                      {isTemp&&<span style={{fontSize:10,color:C.cinzaClaro,marginLeft:4}}>⏳</span>}
                    </div>
                  </div>
                  {(ehMeu||isGestor)&&!isTemp&&(
                    <button onClick={()=>{
                      if(window.confirm(ehMeu?"Apagar sua mensagem?":"Apagar mensagem de "+msg.autor_nome+"?"))
                        chat.excluirMensagem(msg.id).then(()=>setMensagens(p=>p.filter(m=>m.id!==msg.id)));
                    }}
                      style={{background:"none",border:"none",color:C.cinzaClaro,cursor:"pointer",fontSize:12,
                        padding:"0 2px",opacity:0,transition:"opacity 0.1s",alignSelf:"flex-start",marginTop:2}}
                      title={ehMeu?"Apagar minha mensagem":"Apagar mensagem (gestor)"}
                      onMouseEnter={e=>e.currentTarget.style.opacity=1}
                      onMouseLeave={e=>e.currentTarget.style.opacity=0}>🗑</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Input */}
        {canalAtivo&&(
          <div style={{padding:"8px 10px",borderTop:`1px solid ${C.cinzaCard}`,flexShrink:0,position:"relative"}}>
            {mostrarEmoji&&(
              <div style={{position:"absolute",bottom:"100%",left:10,background:C.branco,border:`1px solid ${C.cinzaCard}`,borderRadius:10,padding:8,boxShadow:"0 4px 16px rgba(0,0,0,0.12)",display:"flex",flexWrap:"wrap",gap:4,width:240,zIndex:10}}>
                {EMOJIS.map(e=>(
                  <button key={e} onClick={()=>{setTexto(t=>t+e);setEmoji(false);inputRef.current?.focus();}}
                    style={{background:"none",border:"none",fontSize:20,cursor:"pointer",padding:4,borderRadius:4}}
                    onMouseEnter={e2=>e2.currentTarget.style.background=C.cinzaFundo}
                    onMouseLeave={e2=>e2.currentTarget.style.background="none"}>{e}</button>
                ))}
              </div>
            )}
            <div style={{display:"flex",gap:6,alignItems:"flex-end",background:C.cinzaFundo,borderRadius:10,padding:"5px 8px",border:`1px solid ${C.cinzaCard}`}}>
              <button onClick={()=>setEmoji(e=>!e)} style={{background:"none",border:"none",fontSize:18,cursor:"pointer",color:C.cinzaClaro,padding:"0 2px",flexShrink:0}}>😊</button>
              {/* Autocomplete de menções */}
              {sugestoes.length>0&&(
                <div style={{position:"absolute",bottom:"100%",left:40,background:C.branco,border:`1px solid ${C.cinzaCard}`,borderRadius:8,boxShadow:"0 4px 16px rgba(0,0,0,0.12)",minWidth:160,overflow:"hidden",zIndex:20}}>
                  {sugestoes.map((u,i)=>(
                    <div key={u.id} onClick={()=>selecionarMencao(u)}
                      style={{padding:"7px 12px",cursor:"pointer",display:"flex",alignItems:"center",gap:8,
                        background:i===sugestaoIdx?C.azulMedio:"white",
                        color:i===sugestaoIdx?C.branco:C.cinzaEscuro}}>
                      <div style={{width:22,height:22,borderRadius:"50%",background:u.cor||C.azulMedio,display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,fontWeight:800,color:"#fff",flexShrink:0}}>
                        {u.nome.slice(0,2).toUpperCase()}
                      </div>
                      <span style={{fontSize:12,fontWeight:600}}>@{u.nome}</span>
                    </div>
                  ))}
                </div>
              )}
              <textarea ref={inputRef} value={texto}
                onChange={e=>{
                  const val = e.target.value;
                  setTexto(val);
                  // Detectar @ para autocomplete
                  const cursor = e.target.selectionStart;
                  const atPos  = val.lastIndexOf("@", cursor-1);
                  if(atPos>=0 && (atPos===0||val[atPos-1]===" "||val[atPos-1]==="\n")){
                    const query = val.slice(atPos+1, cursor).toLowerCase();
                    const matches = usuarios.filter(u=>u.ativo&&u.id!==usuario?.id&&u.nome.toLowerCase().startsWith(query));
                    setSugestoes(matches.slice(0,5));
                    setSugestaoIdx(0);
                  } else {
                    setSugestoes([]);
                  }
                }}
                onKeyDown={e=>{
                  if(sugestoes.length>0){
                    if(e.key==="ArrowDown"){e.preventDefault();setSugestaoIdx(i=>Math.min(i+1,sugestoes.length-1));return;}
                    if(e.key==="ArrowUp")  {e.preventDefault();setSugestaoIdx(i=>Math.max(i-1,0));return;}
                    if(e.key==="Enter"||e.key==="Tab"){e.preventDefault();selecionarMencao(sugestoes[sugestaoIdx]);return;}
                    if(e.key==="Escape")   {setSugestoes([]);return;}
                  }
                  if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();enviar();}
                }}
                placeholder={`Mensagem${canalAtivo.tipo==="canal"?" em #"+canalAtivo.nome:""}... (Enter p/ enviar)`}
                rows={1}
                style={{flex:1,background:"none",border:"none",outline:"none",resize:"none",fontSize:13,fontFamily:"inherit",color:C.cinzaEscuro,maxHeight:80,lineHeight:1.5,padding:"2px 0"}}
                onInput={e=>{e.target.style.height="auto";e.target.style.height=Math.min(e.target.scrollHeight,80)+"px";}}/>
              <button onClick={enviar} disabled={!texto.trim()}
                style={{background:texto.trim()?C.azulMedio:"#e2e8f0",color:texto.trim()?C.branco:"#94a3b8",border:"none",borderRadius:7,padding:"5px 12px",cursor:texto.trim()?"pointer":"default",fontSize:13,fontWeight:700,fontFamily:"inherit",flexShrink:0}}>
                ➤
              </button>
            </div>
            <div style={{fontSize:10,color:C.cinzaClaro,marginTop:3,paddingLeft:4}}>Use @Nome para mencionar · Shift+Enter para nova linha</div>
          </div>
        )}
      </div>

      {/* Modal nova DM */}
      {mostrarDM&&(
        <div style={{position:"absolute",inset:0,background:"rgba(0,0,0,0.5)",zIndex:100,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={()=>setMostrarDM(false)}>
          <div onClick={e=>e.stopPropagation()} style={{background:C.branco,borderRadius:12,padding:20,width:260,maxHeight:380,overflowY:"auto",boxShadow:"0 8px 32px rgba(0,0,0,0.2)"}}>
            <h3 style={{color:C.azulEscuro,margin:"0 0 12px",fontSize:14}}>💬 Nova conversa</h3>
            {usuarios.filter(u=>u.ativo&&u.id!==usuario?.id).map(u=>(
              <div key={u.id} onClick={()=>iniciarDM(u)}
                style={{display:"flex",alignItems:"center",gap:10,padding:"8px 10px",borderRadius:8,cursor:"pointer",marginBottom:4}}
                onMouseEnter={e=>e.currentTarget.style.background=C.cinzaFundo}
                onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                <div style={{width:32,height:32,borderRadius:"50%",background:u.cor||C.azulMedio,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:800,color:"#fff"}}>{u.nome.slice(0,2).toUpperCase()}</div>
                <div><div style={{fontSize:13,fontWeight:600,color:C.cinzaEscuro}}>{u.nome}</div><div style={{fontSize:11,color:C.cinzaClaro}}>{u.perfil}</div></div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Modal novo canal */}
      {criandoCanal&&(
        <div style={{position:"absolute",inset:0,background:"rgba(0,0,0,0.5)",zIndex:100,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={()=>setCriando(false)}>
          <div onClick={e=>e.stopPropagation()} style={{background:C.branco,borderRadius:12,padding:24,width:300,boxShadow:"0 8px 32px rgba(0,0,0,0.2)"}}>
            <h3 style={{color:C.azulEscuro,margin:"0 0 14px",fontSize:14}}>➕ Criar canal</h3>
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              <div style={{display:"flex",gap:8}}>
                <input value={novoCanal.icone} onChange={e=>setNovoCanal(n=>({...n,icone:e.target.value}))} style={{width:44,border:`1.5px solid ${C.cinzaCard}`,borderRadius:8,padding:"8px",fontSize:18,textAlign:"center",fontFamily:"inherit"}}/>
                <input value={novoCanal.nome} onChange={e=>setNovoCanal(n=>({...n,nome:e.target.value}))} placeholder="Nome do canal"
                  onKeyDown={e=>e.key==="Enter"&&criarCanalNovo()}
                  style={{flex:1,border:`1.5px solid ${C.cinzaCard}`,borderRadius:8,padding:"8px 12px",fontSize:13,fontFamily:"inherit"}}/>
              </div>
              <input value={novoCanal.descricao} onChange={e=>setNovoCanal(n=>({...n,descricao:e.target.value}))} placeholder="Descrição (opcional)" style={{border:`1.5px solid ${C.cinzaCard}`,borderRadius:8,padding:"8px 12px",fontSize:13,fontFamily:"inherit"}}/>
              <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
                <Btn variant="ghost" small onClick={()=>setCriando(false)}>Cancelar</Btn>
                <Btn small onClick={criarCanalNovo} disabled={!novoCanal.nome.trim()}>Criar</Btn>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Confirmar apagar DM */}
      {confirmDelDM&&(
        <div style={{position:"absolute",inset:0,background:"rgba(0,0,0,0.5)",zIndex:100,display:"flex",alignItems:"center",justifyContent:"center"}}>
          <div style={{background:C.branco,borderRadius:12,padding:24,width:280,boxShadow:"0 8px 32px rgba(0,0,0,0.2)",textAlign:"center"}}>
            <div style={{fontSize:32,marginBottom:8}}>🗑</div>
            <div style={{fontWeight:700,fontSize:14,color:C.cinzaEscuro,marginBottom:6}}>Apagar conversa?</div>
            <div style={{fontSize:12,color:C.cinzaClaro,marginBottom:16}}>Todas as mensagens serão apagadas para você. Esta ação não pode ser desfeita.</div>
            <div style={{display:"flex",gap:8,justifyContent:"center"}}>
              <Btn variant="ghost" small onClick={()=>setConfirmDelDM(null)}>Cancelar</Btn>
              <Btn variant="danger" small onClick={()=>deletarDM(confirmDelDM)}>🗑 Apagar</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


function ChatFlutuante({ usuario, usuarios, aberto, onToggle, pulsando, temMencao, naoLidos,
  canais, canalAtivo, mensagens,
  onSelecionarCanal, onEnviar, onIniciarDM, onCriarCanal, onDeletarDM,
}) {
  const totalNaoLidos = Object.values(naoLidos).reduce((a,b)=>a+b,0);
  const badge = aberto ? 0 : totalNaoLidos;
  const isGestor = ["admin","gestor"].includes(usuario?.perfil);

  return (
    <div style={{position:"fixed",bottom:24,right:24,zIndex:1500}}>
      {aberto&&(
        <div style={{position:"absolute",bottom:68,right:0,width:720,maxWidth:"96vw"}}>
          <Chat
            usuario={usuario} usuarios={usuarios}
            canais={canais} canalAtivo={canalAtivo} mensagens={mensagens} naoLidos={naoLidos}
            onSelecionarCanal={onSelecionarCanal}
            onEnviar={onEnviar}
            onIniciarDM={onIniciarDM}
            onCriarCanal={onCriarCanal}
            onDeletarDM={onDeletarDM}
            onFechar={onToggle}
          />
        </div>
      )}
      <button onClick={onToggle}
        style={{width:54,height:54,borderRadius:"50%",
          background:aberto?C.azulEscuro:`linear-gradient(135deg,${C.azulMedio},${C.ciano})`,
          border:"none",cursor:"pointer",
          boxShadow:pulsando?"0 0 0 8px rgba(37,99,168,0.3)":"0 4px 16px rgba(26,58,107,0.4)",
          display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,
          transition:"all 0.3s",color:C.branco,position:"relative",
          animation:pulsando?"chatPulse 0.5s ease-in-out":"none"}}>
        {aberto?"✕":"💬"}
        {badge>0&&(
          <div style={{position:"absolute",top:-6,right:-6,
            background:temMencao?"#f97316":C.vermelho,
            color:C.branco,borderRadius:"50%",minWidth:22,height:22,
            display:"flex",alignItems:"center",justifyContent:"center",
            fontSize:11,fontWeight:800,padding:"0 5px",
            boxShadow:temMencao?"0 2px 8px rgba(249,115,22,0.7)":"0 2px 8px rgba(239,68,68,0.6)",
            border:"2px solid white",
            animation:"badgePop 0.4s cubic-bezier(0.175,0.885,0.32,1.275)"}}>
            {temMencao?"@":badge>99?"99+":badge}
          </div>
        )}
      </button>
      <style>{`
        @keyframes chatPulse { 0%,100%{transform:scale(1)} 50%{transform:scale(1.12)} }
        @keyframes badgePop  { 0%{transform:scale(0)} 70%{transform:scale(1.2)} 100%{transform:scale(1)} }
      `}</style>
    </div>
  );
}

export default function App(){
  const calendario = useCalendario();
  const [projetos,  setProjetos]  = useState([]);
  const [usuarios,  setUsuarios]  = useState(USUARIOS_PADRAO);
  const [registros, setRegistros] = useState([]);
  const [carregando,setCarregando]= useState(true);

  // ── PWA + Menu: hooks sempre no topo, antes de qualquer return condicional ─
  const [pwaPrompt,   setPwaPrompt]   = useState(null);
  const [pwaInstalado,setPwaInstalado]= useState(false);
  const [menuAberto,  setMenuAberto]  = useState(false);
  useEffect(()=>{
    const handler = (e) => { e.preventDefault(); setPwaPrompt(e); };
    window.addEventListener('beforeinstallprompt', handler);
    window.addEventListener('appinstalled', ()=>{ setPwaInstalado(true); setPwaPrompt(null); });
    return ()=> window.removeEventListener('beforeinstallprompt', handler);
  },[]);
  const instalarPWA = async () => {
    if (!pwaPrompt) return;
    pwaPrompt.prompt();
    const { outcome } = await pwaPrompt.userChoice;
    if (outcome === 'accepted') { setPwaInstalado(true); setPwaPrompt(null); }
  };
  const [user, setUser] = useState(()=>{
    try {
      const s = localStorage.getItem("intec_user_logado");
      return s ? JSON.parse(s) : null;
    } catch { return null; }
  });
  const [aba,       setAba]       = useState("dashboard");
  const [modal,     setModal]     = useState(null);
  const [modalH,    setModalH]    = useState(null);
  const drive    = useGoogleDrive();
  const timerRef      = useRef(null);
  const expRef        = useRef(null);
  const notifRef      = useRef(null);
  const registrosRef  = useRef([]);
  const encerrarRef   = useRef(null);
  const projetosRef   = useRef([]);
  const userRef       = useRef(null);
  const chatSubsRef     = useRef({});   // assinaturas de mensagens por canal {canalId: sub}
  const chatMembrosSub      = useRef(null); // assinatura de novos DMs
  const chatCanaisPublicosSub = useRef(null); // assinatura de novos canais públicos
  const canalAtivoRef   = useRef(null); // ref para evitar stale closure
  const [chatCanais,       setChatCanais]     = useState([]);
  const [chatCanalAtivo,   setChatCanalAtivo] = useState(null);
  const [chatMensagens,    setChatMensagens]  = useState([]);
  const [chatNaoLidos,     setChatNaoLidos]   = useState({});  // {canalId: count}
  const [chatMencao,       setChatMencao]     = useState(false);
  const [chatAberto,       setChatAberto]     = useState(false);
  const [chatPulsando,     setChatPulsando]   = useState(false);
  const chatAbertoRef = useRef(false);
  useEffect(()=>{ chatAbertoRef.current = chatAberto; },[chatAberto]);

  // ── Helper: selecionar canal — carrega mensagens + zera badge ───────────
  const chatSelecionarCanal = useCallback(async (canal) => {
    setChatCanalAtivo(canal);
    canalAtivoRef.current = canal;
    setChatMensagens([]);
    try {
      const msgs = await chat.listarMensagens(canal.id, 100);
      setChatMensagens(msgs);
    } catch(e){ console.error(e); }
    // Zerar badge deste canal
    setChatNaoLidos(prev=>{
      const novo = {...prev};
      delete novo[canal.id];
      const total = Object.values(novo).reduce((a,b)=>a+b,0);
      if(total===0) setChatMencao(false);
      return novo;
    });
    if(user) chat.marcarLido(canal.id, user.id).catch(()=>{});
  }, [user?.id]);

  // ── Helper: assinar canal (reutilizável para novos DMs) ─────────────────
  const chatCanaisAutorizados = useRef(new Set()); // IDs que o usuário pode ver

  const assinarCanalGlobal = useCallback((c) => {
    if(chatSubsRef.current[c.id]) return;
    // SEGURANÇA: DMs só podem ser assinadas se o usuário for membro autorizado.
    // Canais públicos (tipo='canal') todos podem assinar.
    // DMs só chegam aqui via assinarMembros ou chatIniciarDM — ambos já verificados.
    // Se for DM e não estiver no set de autorizados, ignorar.
    if(c.tipo === 'direto' && !chatCanaisAutorizados.current.has(c.id)) return;
    const sub = chat.assinarCanal(c.id, (msg) => {
      const canalAberto = canalAtivoRef.current?.id === c.id && chatAbertoRef.current;
      if(canalAberto) {
        // Está visualizando — adiciona na lista sem badge
        setChatMensagens(prev=>{
          if(prev.find(m=>m.id===msg.id)) return prev;
          return [...prev, msg];
        });
        if(user) chat.marcarLido(c.id, user.id).catch(()=>{});
      } else {
        // Canal não ativo ou chat fechado — incrementa badge
        if(msg.autor_id !== userRef.current?.id) {
          setChatNaoLidos(prev=>({...prev,[c.id]:(prev[c.id]||0)+1}));
        }
      }
      if(msg.autor_id === userRef.current?.id) return;
      tocarSomChat();
      const eMencao = (msg.mencoes||[]).includes(userRef.current?.id);
      if(eMencao){ setChatMencao(true); setTimeout(tocarSomChat, 200); }
      piscarTitulo(eMencao?`🔔 ${msg.autor_nome} mencionou você!`:`💬 ${msg.autor_nome}: ${msg.conteudo.slice(0,30)}`);
      const cNome = c.tipo==="direto"?(c.nome||"").split("↔").find(n=>n.trim()!==userRef.current?.nome)?.trim()||"Mensagem":"# "+c.nome;
      notificarSistema(
        eMencao?`🔔 ${msg.autor_nome} mencionou você em ${cNome}!`:`💬 ${msg.autor_nome} — ${cNome}`,
        msg.conteudo.slice(0,80), "intec-chat-"+c.id, eMencao?12000:8000
      );
      if(!chatAbertoRef.current){
        setChatPulsando(true);
        setTimeout(()=>setChatPulsando(false), 800);
      }
    });
    chatSubsRef.current[c.id] = sub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Helper: enviar mensagem (optimistic) ─────────────────────────────────
  const chatEnviar = useCallback(async (canalId, texto, mencoes) => {
    const tempId = "temp-"+Date.now();
    const tempMsg = {
      id:tempId, canal_id:canalId,
      autor_id:userRef.current?.id, autor_nome:userRef.current?.nome,
      autor_cor:userRef.current?.cor||C.azulMedio,
      conteudo:texto, mencoes, created_at:new Date().toISOString(),
    };
    setChatMensagens(prev=>[...prev,tempMsg]);
    try {
      const salva = await chat.enviarMensagem(canalId, userRef.current.id, userRef.current.nome, userRef.current.cor||C.azulMedio, texto, mencoes);
      setChatMensagens(prev=>prev.map(m=>m.id===tempId?salva:m));
    } catch(e){
      setChatMensagens(prev=>prev.filter(m=>m.id!==tempId));
    }
  }, []);

  // ── Helper: iniciar DM ────────────────────────────────────────────────────
  const chatIniciarDM = useCallback(async (outro) => {
    const canal = await chat.obterOuCriarDM(user.id, outro.id, user.nome, outro.nome);
    chatCanaisAutorizados.current.add(canal.id);
    setChatCanais(prev=>prev.find(c=>c.id===canal.id)?prev:[...prev,canal]);
    assinarCanalGlobal(canal);
    chatSelecionarCanal(canal);
    // Notificar o outro usuário via Broadcast (direto, sem passar por postgres_changes)
    chat.notificarNovoDM(outro.id, canal).catch(()=>{});
  }, [user?.id, assinarCanalGlobal, chatSelecionarCanal]);

  // ── Helper: criar canal ───────────────────────────────────────────────────
  const chatCriarCanal = useCallback(async ({nome,descricao,icone}) => {
    const c = await chat.criarCanal(nome,descricao,icone,"canal",user?.id);
    setChatCanais(prev=>[...prev,c]);
    assinarCanalGlobal(c);
    chatSelecionarCanal(c);
  }, [user?.id, assinarCanalGlobal, chatSelecionarCanal]);

  // ── Helper: deletar canal/DM ──────────────────────────────────────────────
  const chatDeletar = useCallback(async (canalId) => {
    await chat.excluirCanal(canalId).catch(()=>{});
    if(chatSubsRef.current[canalId]){ chat.desassinarCanal(chatSubsRef.current[canalId]); delete chatSubsRef.current[canalId]; }
    setChatCanais(prev=>{
      const nova = prev.filter(c=>c.id!==canalId);
      if(canalAtivoRef.current?.id===canalId){
        const prox = nova.find(c=>c.tipo==="canal")||null;
        setChatCanalAtivo(prox); canalAtivoRef.current=prox;
        if(prox) chatSelecionarCanal(prox);
      }
      return nova;
    });
    setChatNaoLidos(prev=>{ const n={...prev}; delete n[canalId]; return n; });
  }, [chatSelecionarCanal]);

  // Manter refs sempre atualizados (evita stale closure nos timers)
  useEffect(() => {
    registrosRef.current = registros;
  }, [registros]);
  useEffect(() => { projetosRef.current  = projetos;   }, [projetos]);
  useEffect(() => { userRef.current = user; }, [user]);

  // ── Chat global: carrega canais + assinaturas sempre ativas ─────────────
  useEffect(()=>{
    if(!user) return;
    let cancelado = false;
    chatCanaisAutorizados.current = new Set(); // limpar ao trocar usuário
    const init = async () => {
      try {
        const lista = await chat.listarCanais(user.id);
        if(cancelado) return;
        // Registrar todos os canais que o usuário pode ver
        lista.forEach(c => chatCanaisAutorizados.current.add(c.id));
        setChatCanais(lista);
        lista.forEach(c => assinarCanalGlobal(c));
        const primeiro = lista.find(c=>c.tipo==="canal");
        if(primeiro && !canalAtivoRef.current) {
          chatSelecionarCanal(primeiro);
        }
      } catch(e){ console.warn("Chat init:", e); }
    };
    init();

    // Escuta quando o usuário é adicionado a um novo DM
    const subMembros = chat.assinarMembros(user.id, (novoCanal) => {
      if(cancelado) return;
      // Autorizar antes de assinar
      chatCanaisAutorizados.current.add(novoCanal.id);
      setChatCanais(prev=>prev.find(c=>c.id===novoCanal.id)?prev:[...prev,novoCanal]);
      assinarCanalGlobal(novoCanal);
      setChatNaoLidos(prev=>({...prev,[novoCanal.id]:1}));
      setChatPulsando(true); setTimeout(()=>setChatPulsando(false),800);
      const quem = (novoCanal.nome||"").split("↔").find(n=>n.trim()!==user.nome)?.trim()||"alguém";
      notificarSistema(`💬 ${quem} iniciou uma conversa com você`,"Clique no Chat para responder","intec-dm-novo",10000);
    });
    chatMembrosSub.current = subMembros;

    // Escuta criação de canais públicos por qualquer usuário
    const subCanaisPublicos = chat.assinarCanaisPublicos(
      (novoCanal) => {
        if(cancelado) return;
        // IMPORTANTE: ignorar DMs — elas chegam via assinarMembros filtrado por usuário
        // Se processar aqui, todos veriam DMs privadas de outros usuários
        if(novoCanal.tipo !== 'canal') return;
        setChatCanais(prev=>{
          if(prev.find(c=>c.id===novoCanal.id)) return prev;
          return [...prev, novoCanal];
        });
        assinarCanalGlobal(novoCanal);
      },
      (canalId) => {
        if(cancelado) return;
        // Remover da lista para todos
        setChatCanais(prev=>{
          const nova = prev.filter(c=>c.id!==canalId);
          // Se estava visualizando esse canal, mudar para o primeiro disponível
          if(canalAtivoRef.current?.id===canalId){
            const prox = nova.find(c=>c.tipo==="canal")||null;
            setChatCanalAtivo(prox);
            canalAtivoRef.current = prox;
            setChatMensagens([]);
            if(prox) chatSelecionarCanal(prox);
          }
          return nova;
        });
        // Limpar assinatura de mensagens do canal deletado
        if(chatSubsRef.current[canalId]){
          chat.desassinarCanal(chatSubsRef.current[canalId]);
          delete chatSubsRef.current[canalId];
        }
        setChatNaoLidos(prev=>{ const n={...prev}; delete n[canalId]; return n; });
      }
    );
    chatCanaisPublicosSub.current = subCanaisPublicos;

    return ()=>{
      cancelado = true;
      Object.values(chatSubsRef.current).forEach(s=>{ try{ chat.desassinarCanal(s); }catch(e){} });
      chatSubsRef.current = {};
      if(chatMembrosSub.current){ try{ chat.desassinarCanal(chatMembrosSub.current); }catch(e){} chatMembrosSub.current=null; }
      if(chatCanaisPublicosSub.current){ try{ chat.desassinarCanal(chatCanaisPublicosSub.current); }catch(e){} chatCanaisPublicosSub.current=null; }
    };
  },[user?.id, assinarCanalGlobal, chatSelecionarCanal]);

  // ── Carregar dados do Supabase ao iniciar ──
  useEffect(() => {
    async function carregarTudo() {
      try {
        const [p, u, s] = await Promise.all([
          db.projetos.listar(),
          db.usuarios.listar(),
          db.sessoes.listar(),
        ]);
        const vistos = new Set();
        setProjetos(p.filter(x => { if(vistos.has(x.id)) return false; vistos.add(x.id); return true; }));
        const listaUsuarios = u.length > 0 ? u : USUARIOS_PADRAO;
        setUsuarios(listaUsuarios);
        // Atualiza dados do usuário logado se já estiver logado
        setUser(current => {
          if(!current) return current;
          const atualizado = listaUsuarios.find(x=>x.id===current.id);
          if(atualizado) {
            localStorage.setItem("intec_user_logado", JSON.stringify(atualizado));
            return atualizado;
          }
          return current;
        });
        setRegistros(s);
      } catch(e) {
        console.error("Erro ao carregar Supabase:", e);
        // Fallback para localStorage se Supabase falhar
        const lp = localStorage.getItem("intec_projetos");
        const lu = localStorage.getItem("intec_usuarios");
        const ls = localStorage.getItem("intec_horas");
        if(lp) { try { setProjetos(JSON.parse(lp)); } catch{} }
        if(lu) { try { setUsuarios(JSON.parse(lu)); } catch{} }
        if(ls) { try { setRegistros(JSON.parse(ls)); } catch{} }
      } finally {
        setCarregando(false);
      }
    }
    carregarTudo();
  }, []);

  // ── Realtime: atualiza dados automaticamente quando outro usuário faz mudanças ──
  useEffect(() => {
    const cleanup = iniciarRealtime({
      onProjetosChange: async (payload) => {
        // Recarrega lista completa de projetos
        try {
          const p = await db.projetos.listar();
          const vistos = new Set();
          setProjetos(p.filter(x => { if(vistos.has(x.id)) return false; vistos.add(x.id); return true; }));
        } catch(e) { console.error("Realtime projetos:", e); }
      },
      onSessoesChange: async (payload) => {
        // Atualiza só a sessão modificada para não recarregar tudo
        try {
          if(payload.eventType === "DELETE") {
            setRegistros(r => r.filter(x => x.id !== payload.old?.id));
          } else {
            const s = await db.sessoes.listar();
            setRegistros(s);
          }
        } catch(e) { console.error("Realtime sessoes:", e); }
      },
    });
    return cleanup; // cleanup ao desmontar
  }, []);

  // ── Timer central de notificações (30min) ──────────────────────────────────
  useEffect(()=>{
    if(!user) return;

    const verificarTudo = () => {
      const u        = userRef.current;
      const regs     = registrosRef.current;
      const projs    = projetosRef.current;
      if (!u) return;

      const agora    = new Date();
      const hojeISO  = agora.toISOString().slice(0,10);
      const dow      = agora.getDay(); // 0=dom,5=sex,6=sab
      const horaAtual= agora.toTimeString().slice(0,5);

      // ── 1. VERIFICAÇÃO DE SESSÃO ATIVA ──────────────────────────────────
      const sessaoAberta = regs.find(r=>r.usuarioId===u.id&&!r.horaFim);
      if (sessaoAberta) {
        // Verificar se o usuário já respondeu este aviso na última hora
        // Persiste no localStorage para sobreviver a recarregamentos de página
        const chaveAviso = `intec_aviso_respondido_${u.id}`;
        const ultimoResposto = parseInt(localStorage.getItem(chaveAviso)||"0");
        const umHoraAtras = Date.now() - CHECK_INTERVAL;
        if (ultimoResposto > umHoraAtras) return; // já respondeu, aguardar 1h

        setModalH(prev => {
          if (prev) return prev; // já tem modal aberto, mantém
          notificarSistema(
            "⏰ INTEC — Verificação de Atividade",
            `Olá, ${u.nome}! Você ainda está trabalhando no projeto?`,
            "intec-atividade", 15000
          );
          return "aviso";
        });
      }

      // ── 2. LEMBRETE DE SESSÃO NÃO INICIADA (em horário comercial) ───────
      if (!sessaoAberta) {
        const [hh, mm] = horaAtual.split(":").map(Number);
        const dentroDoExpediente = (() => {
          if (!u.expediente) return hh >= 9 && hh < 18;
          if (u.expediente.segunda) {
            const dias = ["domingo","segunda","terca","quarta","quinta","sexta","sabado"];
            const diaExp = u.expediente[dias[dow]];
            if (!diaExp?.ativo) return false;
            const ini = diaExp.turno1?.inicio ? parseInt(diaExp.turno1.inicio) : 9;
            const fim = diaExp.turno2?.ativo ? parseInt(diaExp.turno2.fim||"18") : parseInt(diaExp.turno1?.fim||"18");
            return hh >= ini && hh < fim;
          }
          return hh >= 9 && hh < 18;
        })();
        if (dentroDoExpediente && dow >= 1 && dow <= 5) {
          notificarSistema(
            "📋 INTEC — Sessão não iniciada",
            `${u.nome}, você está no horário de trabalho mas sem sessão ativa. Não esqueça de registrar!`,
            "intec-sem-sessao", 12000
          );
        }
      }

      // ── 3. LEMBRETE DO LIXO — toda sexta ────────────────────────────────
      if (dow === 5) {
        try {
          const dadosLixo = JSON.parse(localStorage.getItem("intec_escala_lixo")||"{}");
          if (dadosLixo.membros && dadosLixo.dataInicio) {
            const ini = new Date(dadosLixo.dataInicio+"T12:00:00");
            const diffSem = Math.round((agora - ini) / (7*24*60*60*1000));
            const idx = ((diffSem % dadosLixo.membros.length) + dadosLixo.membros.length) % dadosLixo.membros.length;
            const responsavel = dadosLixo.membros[idx];
            const chave = `lixo-${hojeISO}`;
            notificarUmaVez(
              chave,
              "🗑 INTEC — Coleta de Lixo",
              `Esta semana é a vez de ${responsavel} tirar o lixo!`,
              "intec-lixo"
            );
          }
        } catch(e) {}
      }

      // ── 4. PROJETOS VENCENDO ESTA SEMANA ────────────────────────────────
      if (projs && projs.length > 0) {
        const criticos = projs.filter(p => {
          if (!p.dataEntregaPrevista) return false;
          if (["CONCLUÍDO","CANCELADO"].includes(p.status)) return false;
          // Só os projetos que o usuário é responsável
          const ehResp = p.responsavel===u.nome || p.coresponsavel===u.nome ||
                         p.coresponsavel2===u.nome || p.coresponsavel3===u.nome;
          if (!ehResp && u.perfil==="colaborador") return false;
          const dias = Math.ceil((new Date(p.dataEntregaPrevista) - agora) / 86400000);
          return dias >= 0 && dias <= 7;
        });
        if (criticos.length > 0) {
          const chave = `prazo-${hojeISO}-${criticos.map(p=>p.id).join(",")}`;
          const nomes = criticos.map(p=>p.codigo).join(", ");
          notificarUmaVez(
            chave,
            `⚠️ INTEC — ${criticos.length} projeto(s) vencendo esta semana`,
            `Prazo próximo: ${nomes}. Acesse o sistema para verificar.`,
            "intec-prazo"
          );
        }
      }

      // ── 5. REVISÃO DE PROJETOS — toda sexta ─────────────────────────────
      if (dow === 5) {
        try {
          const dadosRevisao = JSON.parse(localStorage.getItem("intec_escala_revisao")||"{}");
          if (dadosRevisao.membros && dadosRevisao.dataInicio) {
            const ini = new Date(dadosRevisao.dataInicio+"T12:00:00");
            const diffSem = Math.round((agora - ini) / (7*24*60*60*1000));
            const idx = ((diffSem % dadosRevisao.membros.length) + dadosRevisao.membros.length) % dadosRevisao.membros.length;
            const responsavel = dadosRevisao.membros[idx];
            const chave = `revisao-${hojeISO}`;
            notificarUmaVez(
              chave,
              "🔍 INTEC — Revisão de Projetos",
              `Esta semana a revisão de projetos é responsabilidade de ${responsavel}.`,
              "intec-revisao"
            );
            // Notificar o próprio responsável especialmente
            if (responsavel === u.nome) {
              notificarUmaVez(
                `revisao-voce-${hojeISO}`,
                "🔍 INTEC — É a sua vez de revisar!",
                `${u.nome}, hoje é sexta e esta semana a revisão de projetos é sua. Não esqueça!`,
                "intec-revisao-voce"
              );
            }
          }
        } catch(e) {}
      }
    };

    // Roda APENAS a cada 1 hora — não dispara ao logar/recarregar
    timerRef.current = setInterval(verificarTudo, CHECK_INTERVAL);
    return()=>{ clearInterval(timerRef.current); };
  },[user]); // NÃO depende de estado — usa refs

  // Verificação fim de expediente (a cada 30s para maior precisão)
  // Usa refs para sempre ter registros e encerrar atualizados — evita stale closure
  useEffect(()=>{
    if(!user) return;
    expRef.current = setInterval(()=>{
      const agora = new Date().toTimeString().slice(0,5);
      const fim   = fimExpediente(user.expediente);
      if(!fim || agora < fim) return;

      // Usa ref para pegar registros atuais (não o valor capturado no closure)
      const regsAtuais = registrosRef.current;
      const aberta = regsAtuais.find(r => r.usuarioId===user.id && !r.horaFim);
      if(!aberta) return;

      const [fh,fm] = fim.split(":").map(Number);
      const [ah,am] = agora.split(":").map(Number);
      const diff = (ah*60+am) - (fh*60+fm);

      if(diff === 0){
        // Exatamente na hora — mostra modal para o usuário encerrar
        setModalH("encerramento");
      } else if(diff >= 5){
        // 5+ minutos após o expediente sem resposta — encerra automaticamente
        if(encerrarRef.current) {
          // Bug 3/4: pegar sessão ANTES de encerrar para o email
          const uAtual = registrosRef.current.find(r => r.usuarioId === user.id && !r.horaFim);
          encerrarRef.current(fim, "Encerrado automaticamente pelo sistema");
          notificarSistema(
            "⏹ INTEC — Sessão Encerrada",
            `Sua sessão foi encerrada automaticamente às ${fim}. Expediente finalizado!`,
          );
          if(uAtual) {
            const proj = uAtual.projetoId
              ? `Projeto ${uAtual.projetoId}`
              : (uAtual.categoriaAdmin || "Atividade administrativa");
            enviarEmail("encerramento_auto", {
              colaborador: user.nome,
              email: user.email,
              projetoOuAtividade: proj,
              horaInicio: uAtual.horaInicio,
              horaFim: fim,
            }).catch(()=>{});
          }
        }
      }
    }, 30000); // verifica a cada 30 segundos
    return()=>clearInterval(expRef.current);
  },[user]); // NÃO depende de registros — usa ref

  const sessaoAtiva=registros.find(r=>r.usuarioId===user?.id&&!r.horaFim);

  // ── Sessões ──
  // ── INICIAR SESSÃO ─────────────────────────────────────────────────────────
  // Bug fix: bloqueia início se já existe sessão aberta do mesmo usuário
  const iniciar = async (projetoId, hi, obsInicio, categoriaAdmin=null) => {
    // Bug 2: verificar se já existe sessão aberta — não permitir duplicata
    const jaAberta = registrosRef.current.find(r => r.usuarioId===user.id && !r.horaFim);
    if (jaAberta) {
      console.warn("Já existe sessão aberta, ignorando iniciar()");
      setModalH(null);
      return;
    }
    const dataHoje = new Date().toISOString().slice(0,10);
    const uExp = usuarios.find(u2=>u2.id===user.id)?.expediente;
    const nova = {
      id: Date.now().toString(),
      usuarioId:      user.id,
      projetoId:      projetoId||null,
      categoriaAdmin: categoriaAdmin||null,
      data:           dataHoje,
      horaInicio:     hi,
      horaFim:        null,
      duracaoMin:     null,
      minutosExtras:  0,
      inicioTs:       Date.now(),
      obsInicio:      obsInicio||"",
      obsFim:         "",
      obs:            obsInicio||"",
    };
    // Atualizar estado e ref imediatamente — evita race condition
    setRegistros(prev => { const novo = [...prev, nova]; registrosRef.current = novo; return novo; });
    setModalH(null);
    try {
      await db.sessoes.salvar(nova);
    } catch(e) { console.error("Erro salvar sessao:", e); }
  };

  // ── ENCERRAR SESSÃO ─────────────────────────────────────────────────────────
  // Bug fix: usa ID fixo da sessão, não busca por !horaFim no momento do setState
  const encerrar = async (hf, obsFim) => {
    // Pegar a sessão aberta ANTES de qualquer setState
    const sessaoAberta = registrosRef.current.find(r => r.usuarioId===user.id && !r.horaFim);
    if (!sessaoAberta) {
      console.warn("Nenhuma sessão aberta para encerrar");
      setModalH(null);
      return;
    }

    const sessaoId  = sessaoAberta.id;
    const horaInicio= sessaoAberta.horaInicio;
    const dataS     = sessaoAberta.data;
    const uExp      = usuarios.find(u2=>u2.id===user.id)?.expediente;
    const dur       = Math.max(0, horaMin(hf) - horaMin(horaInicio));
    const {minutosExtras} = verificarHoraExtra(horaInicio, hf, uExp, dataS);
    const sessaoFechada = {
      ...sessaoAberta,
      horaFim:       hf,
      duracaoMin:    dur,
      minutosExtras,
      obsFim:        obsFim||"",
      obs:           sessaoAberta.obsInicio||sessaoAberta.obs||"",
    };

    // Bug 1 e 3: atualizar estado e ref atomicamente pelo ID — nunca pelo !horaFim
    setRegistros(prev => {
      const novo = prev.map(r => r.id===sessaoId ? sessaoFechada : r);
      registrosRef.current = novo; // manter ref sincronizada
      return novo;
    });
    setModalH(null);

    // Persistir no banco
    try {
      await db.sessoes.encerrarCompleto(
        sessaoId, hf, dur,
        sessaoAberta.obsInicio||sessaoAberta.obs||"",
        obsFim||"", minutosExtras
      );
    } catch(e) { console.error("Erro encerrar sessao:", e); }
  };

  // Atualizar ref da função encerrar para o timer sempre usar a versão mais recente
  encerrarRef.current = encerrar;

  // Verificação de projetos críticos (roda 1x ao logar e a cada 6h)
  useEffect(() => {
    if (!user || !["admin","gestor"].includes(user.perfil)) return;
    const verificarCriticos = () => {
      const criticos = projetos.filter(p => {
        if (!p.dataEntregaPrevista) return false;
        if (["CONCLUÍDO","CANCELADO"].includes(statusN(p.status))) return false;
        const dias = Math.ceil((new Date(p.dataEntregaPrevista) - new Date()) / 86400000);
        return dias <= 7 && dias >= -30;
      });
      if (criticos.length > 0) {
        // Agrupa por responsável e envia email
        const porResp = {};
        criticos.forEach(p => {
          const resp = p.responsavel || "—";
          if (!porResp[resp]) porResp[resp] = [];
          porResp[resp].push({
            codigo: p.codigo,
            cliente: p.cliente,
            responsavel: p.responsavel,
            dias: Math.ceil((new Date(p.dataEntregaPrevista) - new Date()) / 86400000),
          });
        });
        Object.entries(porResp).forEach(([responsavel, projResp]) => {
          const uResp = usuarios.find(u => u.nome === responsavel);
          enviarEmail("projetos_vencendo", {
            destinatario: responsavel,
            emailResponsavel: uResp?.email || null,
            projetos: projResp,
          }).catch(()=>{});
        });
      }
    };
    // Roda 1x ao logar (com delay de 5s para não sobrecarregar)
    const t1 = setTimeout(verificarCriticos, 5000);
    // Roda a cada 6h
    const t2 = setInterval(verificarCriticos, 6 * 60 * 60 * 1000);
    return () => { clearTimeout(t1); clearInterval(t2); };
  }, [user?.id, projetos.length]);

  const mudar=(pid)=>{
    const h=new Date().toTimeString().slice(0,5);
    encerrar(h,"Mudou de projeto");
    setTimeout(()=>iniciar(pid,h,""),200);
  };

  // ── Projetos ──
  const abrirP = p => setModal({projeto:p, modo:"editar"});
  const novoP  = () => setModal({projeto:null, modo:"novo"});

  const salvarP = async (f) => {
    const c = f.codigo?.trim(); if(!c) return;
    const n = {
      ...f,
      id: c,
      // Recalcular status automático se ativo
      status:             f.statusAuto ? calcStatusAuto(f) : f.status,
      // Sincronizar campos do portal explicitamente
      progresso:          f.progresso          ?? 0,
      obs_cliente:        f.obsCliente         ?? f.obs_cliente ?? "",
      obsCliente:         f.obsCliente         ?? f.obs_cliente ?? "",
      linkClienteAtivo:   f.linkClienteAtivo   ?? f.link_cliente_ativo ?? false,
      link_cliente_ativo: f.linkClienteAtivo   ?? f.link_cliente_ativo ?? false,
      token_cliente:      f.tokenCliente       || f.token_cliente || "",
    };
    if(modal.modo==="novo") setProjetos(p=>[...p,n]);
    else setProjetos(p=>p.map(x=>x.id===modal.projeto.id?n:x));
    setModal(null);
    try {
      await db.projetos.salvar(n);
    } catch(e){ console.error("Erro salvar projeto:", e); }
  };

  const excluirP = async (id) => {
    if(!window.confirm("Excluir?")) return;
    setProjetos(p=>p.filter(x=>x.id!==id));
    setModal(null);
    try { await db.projetos.excluir(id); } catch(e){ console.error("Erro excluir projeto:", e); }
  };

  const importar = async (ns) => {
    const ids = new Set(projetos.map(x=>x.id));
    const cs  = new Set(projetos.map(x=>x.codigo?.trim().toUpperCase()));
    const novos = ns.filter(x=>!ids.has(x.id)&&!cs.has(x.codigo?.trim().toUpperCase()));
    setProjetos(p=>[...p,...novos]);
    for(const n of novos) {
      try { await db.projetos.salvar(n); } catch(e){ console.error("Erro importar:", e); }
    }
  };

  // ── Usuários ──
  const salvarUsuarios = async (lista) => {
    setUsuarios(lista);
    for(const u of lista) {
      try { await db.usuarios.salvar(u); } catch(e){ console.error("Erro salvar usuario:", e); }
    }
  };

  // Tela de carregamento
  if(carregando) return (
    <div style={{minHeight:"100vh",background:`linear-gradient(135deg,${C.azulEscuro},${C.azulMedio})`,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:16}}>
      <svg width="120" height="48" viewBox="0 0 220 80">
        <circle cx="28" cy="14" r="7" fill="none" stroke="#56bfe9" strokeWidth="3.5"/>
        <path d="M21 28 Q21 52 28 52 Q35 52 35 28" fill="none" stroke="white" strokeWidth="5" strokeLinecap="round"/>
        <path d="M35 28 Q35 14 55 14 L80 52" fill="none" stroke="white" strokeWidth="5" strokeLinecap="round"/>
        <path d="M80 14 L80 52" fill="none" stroke="white" strokeWidth="5" strokeLinecap="round"/>
        <text x="95" y="45" fill="white" fontSize="36" fontWeight="800" fontFamily="'Segoe UI',sans-serif" letterSpacing="2">NTEC</text>
      </svg>
      <div style={{color:"rgba(255,255,255,0.7)",fontSize:14}}>Carregando dados...</div>
    </div>
  );

  const fazerLogin = (u) => {
    const uAtualizado = usuarios.find(x=>x.id===u.id) || u;
    setUser(uAtualizado);
    localStorage.setItem("intec_user_logado", JSON.stringify(uAtualizado));
    // Pedir permissão de notificação ao logar
    pedirPermissaoNotificacao();
    setTimeout(()=>setModalH("checkin"),600);
  };
  const fazerLogout = () => {
    localStorage.removeItem("intec_user_logado");
    setUser(null);
  };

  if(!user) return <TelaLogin usuarios={usuarios} onLogin={fazerLogin}/>;

  const isAdmin    = user.perfil === "admin";
  const isGestorOuAdmin = ["admin","gestor"].includes(user.perfil);
  const isColab    = user.perfil === "colaborador";

  // Abas principais (topbar) — só as mais usadas
  const abasPrincipais=[
    {id:"dashboard",    label:"Dashboard",   icone:"📊"},
    {id:"projetos",     label:"Projetos",    icone:"📁"},
    ...(!isColab ? [{id:"financeiro", label:"Financeiro", icone:"💰"}] : []),
    {id:"horas",        label:"Horas",       icone:"⏱"},
    {id:"agenda",       label:"Agenda",      icone:"📅"},
  ];

  // Abas no menu lateral
  const abasMenu=[
    {id:"dashboard",    label:"Dashboard",        icone:"📊", grupo:"principal"},
    {id:"projetos",     label:"Projetos",          icone:"📁", grupo:"principal"},
    ...(!isColab ? [{id:"financeiro", label:"Financeiro", icone:"💰", grupo:"principal"}] : []),
    {id:"horas",        label:"Horas & Produtividade", icone:"⏱", grupo:"horas"},
    {id:"agenda",       label:"Agenda & Escalas",  icone:"📅", grupo:"agenda"},
    {id:"config",       label:"Configurações",     icone:"⚙",  grupo:"config"},
  ];

  const abas = abasPrincipais; // compat

  return(
    <div style={{minHeight:"100vh",background:C.cinzaFundo,fontFamily:"'Segoe UI',system-ui,sans-serif"}}>
      {/* ── NAVBAR ── */}
      <div style={{background:`linear-gradient(135deg,${C.azulEscuro},${C.azulMedio})`,padding:"0 20px",boxShadow:"0 4px 20px rgba(26,58,107,0.3)",position:"sticky",top:0,zIndex:200}}>
        <div style={{maxWidth:1400,margin:"0 auto",display:"flex",alignItems:"center",gap:8}}>

          {/* Hamburguer + Logo */}
          <button onClick={()=>setMenuAberto(m=>!m)} title="Menu completo"
            style={{background:"none",border:"none",cursor:"pointer",padding:"8px",borderRadius:8,display:"flex",flexDirection:"column",gap:4,flexShrink:0,opacity:0.8}}
            onMouseEnter={e=>e.currentTarget.style.background="rgba(255,255,255,0.1)"}
            onMouseLeave={e=>e.currentTarget.style.background="none"}>
            <div style={{width:20,height:2,background:C.branco,borderRadius:2,transition:"all 0.2s",transform:menuAberto?"rotate(45deg) translate(4px,4px)":"none"}}/>
            <div style={{width:20,height:2,background:C.branco,borderRadius:2,transition:"all 0.2s",opacity:menuAberto?0:1}}/>
            <div style={{width:20,height:2,background:C.branco,borderRadius:2,transition:"all 0.2s",transform:menuAberto?"rotate(-45deg) translate(4px,-4px)":"none"}}/>
          </button>

          <div style={{padding:"12px 16px 12px 4px",borderRight:`1px solid rgba(255,255,255,0.15)`,marginRight:8,flexShrink:0}}>
            <svg width="80" height="32" viewBox="0 0 220 80"><circle cx="28" cy="14" r="7" fill="none" stroke="#56bfe9" strokeWidth="3.5"/><path d="M21 28 Q21 52 28 52 Q35 52 35 28" fill="none" stroke="white" strokeWidth="5" strokeLinecap="round"/><path d="M35 28 Q35 14 55 14 L80 52" fill="none" stroke="white" strokeWidth="5" strokeLinecap="round"/><path d="M80 14 L80 52" fill="none" stroke="white" strokeWidth="5" strokeLinecap="round"/><text x="95" y="45" fill="white" fontSize="36" fontWeight="800" fontFamily="'Segoe UI',sans-serif" letterSpacing="2">NTEC</text></svg>
            <div style={{color:C.ciano,fontSize:8,letterSpacing:3,fontWeight:700,marginTop:-4}}>ENGENHARIA INTEGRADA</div>
          </div>

          {/* Abas principais */}
          <nav style={{display:"flex",gap:0,flex:1,overflowX:"auto",scrollbarWidth:"none"}}>
            {abasPrincipais.map(a=>{
              const ativo = aba===a.id || (a.id==="horas"&&aba==="produtividade") || (a.id==="agenda"&&aba==="escalas");
              return <button key={a.id} onClick={()=>setAba(a.id)}
                style={{background:ativo?"rgba(255,255,255,0.15)":"transparent",
                  color:ativo?C.branco:"rgba(255,255,255,0.65)",
                  border:"none",padding:"16px 14px",cursor:"pointer",fontSize:13,
                  fontWeight:ativo?700:500,fontFamily:"inherit",
                  display:"flex",alignItems:"center",gap:6,whiteSpace:"nowrap",
                  borderBottom:ativo?`2px solid ${C.ciano}`:"2px solid transparent",
                  transition:"all 0.2s"}}>
                {a.icone} {a.label}
              </button>;
            })}
          </nav>

          {/* Botões direita */}
          <div style={{display:"flex",gap:6,alignItems:"center",flexShrink:0}}>
            {pwaPrompt&&!pwaInstalado&&(
              <button onClick={instalarPWA} title="Instalar INTEC como aplicativo"
                style={{background:"rgba(86,191,233,0.15)",color:C.ciano,border:"1px solid rgba(86,191,233,0.3)",borderRadius:8,padding:"5px 10px",cursor:"pointer",fontSize:11,fontWeight:700,fontFamily:"inherit"}}>
                📲
              </button>
            )}
            {sessaoAtiva&&<div style={{background:"rgba(34,197,94,0.2)",border:"1px solid rgba(34,197,94,0.4)",borderRadius:8,padding:"4px 8px",fontSize:11,color:C.verde,fontWeight:700,whiteSpace:"nowrap"}}>▶ Sessão</div>}
            {!sessaoAtiva&&<Btn onClick={()=>setModalH("checkin")} variant="ciano" small>▶ Iniciar</Btn>}
            {sessaoAtiva&&<Btn onClick={()=>setModalH("encerramento")} small style={{background:"rgba(239,68,68,0.15)",color:"#fca5a5",border:"1px solid rgba(239,68,68,0.3)"}}>⏹</Btn>}
            <div style={{display:"flex",alignItems:"center",gap:6,cursor:"pointer",padding:"5px 8px",borderRadius:8,border:"1px solid rgba(255,255,255,0.2)"}}
              onClick={()=>{if(window.confirm("Sair do sistema?"))fazerLogout();}}>
              <Avatar u={user} size={26}/>
              <div style={{color:C.branco}}>
                <div style={{fontSize:12,fontWeight:700}}>{user.nome.split(" ")[0]}</div>
                <div style={{fontSize:9,color:C.ciano}}>{user.perfil==="gestor"?"Gestor":"Colab."}</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── MENU LATERAL ── */}
      {menuAberto&&(
        <div style={{position:"fixed",inset:0,zIndex:150}} onClick={()=>setMenuAberto(false)}>
          <div onClick={e=>e.stopPropagation()}
            style={{position:"fixed",top:0,left:0,bottom:0,width:260,
              background:`linear-gradient(180deg,${C.azulEscuro} 0%,#0d2247 100%)`,
              boxShadow:"4px 0 24px rgba(0,0,0,0.4)",zIndex:151,
              display:"flex",flexDirection:"column",paddingTop:64}}>
            {/* Header do menu */}
            <div style={{padding:"0 20px 16px",borderBottom:"1px solid rgba(255,255,255,0.1)"}}>
              <div style={{color:C.ciano,fontSize:10,fontWeight:700,letterSpacing:2}}>NAVEGAÇÃO</div>
            </div>
            {/* Grupos */}
            {[
              {grupo:"principal", label:"Principal",        icone:"🏠"},
              {grupo:"horas",     label:"Horas & Produtividade", icone:"⏱"},
              {grupo:"agenda",    label:"Agenda & Escalas", icone:"📅"},
              {grupo:"config",    label:"Sistema",          icone:"⚙"},
            ].map(g=>(
              <div key={g.grupo} style={{marginBottom:4}}>
                <div style={{padding:"10px 20px 6px",fontSize:10,fontWeight:700,color:"rgba(255,255,255,0.35)",letterSpacing:1}}>
                  {g.icone} {g.label.toUpperCase()}
                </div>
                {abasMenu.filter(a=>a.grupo===g.grupo).map(a=>{
                  const ativo = aba===a.id;
                  return(
                    <button key={a.id} onClick={()=>{setAba(a.id);setMenuAberto(false);}}
                      style={{width:"100%",background:ativo?"rgba(86,191,233,0.15)":"transparent",
                        border:"none",borderLeft:ativo?`3px solid ${C.ciano}`:"3px solid transparent",
                        padding:"10px 20px",cursor:"pointer",
                        display:"flex",alignItems:"center",gap:12,
                        color:ativo?C.branco:"rgba(255,255,255,0.65)",
                        fontSize:13,fontWeight:ativo?700:400,fontFamily:"inherit",
                        transition:"all 0.15s",textAlign:"left"}}>
                      <span style={{fontSize:18,minWidth:24}}>{a.icone}</span>
                      <span>{a.label}</span>
                      {ativo&&<span style={{marginLeft:"auto",fontSize:10,color:C.ciano}}>●</span>}
                    </button>
                  );
                })}
              </div>
            ))}
            {/* Info do usuário */}
            <div style={{marginTop:"auto",padding:"16px 20px",borderTop:"1px solid rgba(255,255,255,0.1)"}}>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <Avatar u={user} size={36}/>
                <div>
                  <div style={{color:C.branco,fontWeight:700,fontSize:13}}>{user.nome}</div>
                  <div style={{color:C.ciano,fontSize:11}}>{user.email}</div>
                </div>
              </div>
              <button onClick={()=>{if(window.confirm("Sair?"))fazerLogout();}} style={{marginTop:12,width:"100%",background:"rgba(239,68,68,0.15)",border:"1px solid rgba(239,68,68,0.3)",borderRadius:8,padding:"8px",color:"#fca5a5",cursor:"pointer",fontSize:12,fontFamily:"inherit",fontWeight:600}}>
                🚪 Sair do sistema
              </button>
            </div>
          </div>
        </div>
      )}

      <main style={{maxWidth:1400,margin:"0 auto",padding:"28px 24px"}}> 
        {aba==="dashboard" &&<Dashboard projetos={projetos} onAbrirProjeto={abrirP} drive={drive} onImportar={importar} usuarioAtual={user}/>}
        {aba==="projetos"  &&<ListaProjetos projetos={projetos} onAbrirProjeto={abrirP} onNovoProjeto={novoP} usuarios={usuarios}/>}
        {aba==="financeiro"&&<Financeiro projetos={projetos}/>}
        {aba==="horas"     &&<AbaHoras registros={registros} setRegistros={setRegistros} usuarios={usuarios} projetos={projetos} usuarioAtual={user} calendario={calendario} onAbrirEncerramento={()=>setModalH("encerramento")}/>}
        {aba==="agenda"    &&<AbaAgenda calendario={calendario} usuarioAtual={user} registros={registros} usuarios={usuarios}/>}
        {aba==="config"    &&<Configuracoes usuarios={usuarios} onSalvarUsuarios={salvarUsuarios} usuarioAtual={user}/>}
      </main>

      {modal&&<ModalProjeto projeto={modal.projeto} modo={modal.modo} onClose={()=>setModal(null)} onSave={salvarP} onExcluir={excluirP} usuarios={usuarios}/>}

      {modalH&&<ModalHoras tipo={modalH} projetos={projetos} usuarioAtual={user} sessaoAtiva={sessaoAtiva} onIniciar={iniciar} onEncerrar={encerrar} onMudar={mudar} onFechar={acao=>{
  if(acao==="encerrar") {
    encerrar(new Date().toTimeString().slice(0,5),"Encerrado pelo colaborador");
  } else if(acao==="continuar_extra") {
    const agora = new Date().toTimeString().slice(0,5);
    const sessaoAtual = registrosRef.current.find(r=>r.usuarioId===user.id&&!r.horaFim);
    if(sessaoAtual){
      encerrar(agora, "Encerrado no fim do expediente — continuou em hora extra");
      setTimeout(()=>{ iniciar(sessaoAtual.projetoId, agora, sessaoAtual.obsInicio||"", sessaoAtual.categoriaAdmin); }, 500);
    }
    setModalH(null);
  } else {
    localStorage.setItem(`intec_aviso_respondido_${user.id}`, Date.now().toString());
    setModalH(null);
  }
}}/>}

      <ChatFlutuante
        usuario={user} usuarios={usuarios}
        aberto={chatAberto} onToggle={()=>setChatAberto(a=>!a)}
        pulsando={chatPulsando} temMencao={chatMencao} naoLidos={chatNaoLidos}
        canais={chatCanais} canalAtivo={chatCanalAtivo} mensagens={chatMensagens}
        onSelecionarCanal={chatSelecionarCanal}
        onEnviar={chatEnviar}
        onIniciarDM={chatIniciarDM}
        onCriarCanal={chatCriarCanal}
        onDeletarDM={chatDeletar}
      />
    </div>
  );
}
