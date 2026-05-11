import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { db, iniciarRealtime } from "./supabase.js";

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID = "26616128245-j4kghm435os4m3vu42tq32ikkjmbvrp6.apps.googleusercontent.com";
const DRIVE_ROOT_ID    = "0AIRz2lul3P76Uk9PVA";
const SCOPES           = "https://www.googleapis.com/auth/drive.readonly";
const CHECK_INTERVAL   = 60 * 60 * 1000; // 1h

// ─── CORES INTEC ───────────────────────────────────────────────────────────────
const C = {
  azulEscuro:"#1a3a6b", azulMedio:"#2563a8", azulClaro:"#3b8fd4",
  ciano:"#56bfe9", cinzaEscuro:"#1e2535", cinzaMedio:"#2d3a50",
  cinzaClaro:"#8492a6", cinzaFundo:"#f0f4f8", cinzaCard:"#e8eef5",
  branco:"#ffffff", verde:"#22c55e", amarelo:"#f59e0b",
  vermelho:"#ef4444", laranja:"#f97316",
};

const STATUS_CONFIG = {
  "Novo/Definir": { cor:C.cinzaClaro, bg:"#f8fafc", icone:"○" },
  "Em andamento": { cor:C.azulClaro,  bg:"#e8f4fd", icone:"▶" },
  "PAUSADO":      { cor:C.amarelo,    bg:"#fffbeb", icone:"⏸" },
  "ATRASADO":     { cor:C.vermelho,   bg:"#fef2f2", icone:"⚠" },
  "CONCLUÍDO":    { cor:C.verde,      bg:"#f0fdf4", icone:"✓" },
  "CANCELADO":    { cor:"#6b7280",    bg:"#f3f4f6", icone:"✕" },
};
// Normaliza variações antigas
const STATUS_ALIAS = { "Concluído":"CONCLUÍDO", "concluído":"CONCLUÍDO", "Cancelado":"CANCELADO" };

const TIPOS = {
  PE:"Proj. Estrutural", PR:"Proj. Reforço", LT:"Laudo Técnico",
  CB:"Compatibilização", EL:"Proj. Elétrico", PH:"Proj. Hidrossanitário",
  PA:"Proj. Ar-condic.", PF:"Proj. Fundação", CT:"Consultoria", RE:"Revisão",
};

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
const horaMin    = h => { if(!h) return 0; const [hh,mm]=h.split(":").map(Number); return hh*60+mm; };

// Calcula horas diárias de trabalho baseado no expediente do usuário
// Suporta 1 ou 2 turnos com modo E (ambos) ou OU (apenas 1 turno por dia)
// Estrutura: { turno1:{inicio,fim}, turno2:{ativo,inicio,fim}, modo:"E"|"OU" }
const calcHorasDia = (expediente) => {
  if (!expediente) return 7;
  // Formato novo com turnos
  if (expediente.turno1) {
    const h1 = expediente.turno1.inicio && expediente.turno1.fim
      ? Math.max(0, (horaMin(expediente.turno1.fim) - horaMin(expediente.turno1.inicio)) / 60) : 0;
    const h2 = expediente.turno2?.ativo && expediente.turno2.inicio && expediente.turno2.fim
      ? Math.max(0, (horaMin(expediente.turno2.fim) - horaMin(expediente.turno2.inicio)) / 60) : 0;
    if (expediente.turno2?.ativo && expediente.modo === "OU") return Math.max(h1, h2);
    return Math.round((h1 + h2) * 10) / 10;
  }
  // Formato legado {inicio, fim} — converte automaticamente
  // Ex: {inicio:"09:00", fim:"18:00"} = considera intervalo de almoço de 2h → 7h
  if (expediente.inicio && expediente.fim) {
    const total = Math.max(0, (horaMin(expediente.fim) - horaMin(expediente.inicio)) / 60);
    // Se total > 6h assume que tem intervalo de 1h de almoço (padrão CLT)
    return total > 6 ? total - 1 : total;
  }
  return 7;
};

// Verifica se uma hora está dentro do expediente do colaborador
// Retorna { eHoraExtra: bool, minutosExtras: number }
const verificarHoraExtra = (horaInicio, horaFim, expediente) => {
  if (!horaInicio || !horaFim || !expediente) return { eHoraExtra: false, minutosExtras: 0 };
  const ini = horaMin(horaInicio);
  const fim = horaMin(horaFim);
  const durTotal = Math.max(0, fim - ini);

  const turnos = [];
  if (expediente.turno1?.inicio && expediente.turno1?.fim) {
    turnos.push({ ini: horaMin(expediente.turno1.inicio), fim: horaMin(expediente.turno1.fim) });
  }
  if (expediente.turno2?.ativo && expediente.turno2?.inicio && expediente.turno2?.fim) {
    turnos.push({ ini: horaMin(expediente.turno2.inicio), fim: horaMin(expediente.turno2.fim) });
  }
  // Formato antigo
  if (turnos.length === 0 && expediente.inicio && expediente.fim) {
    turnos.push({ ini: horaMin(expediente.inicio), fim: horaMin(expediente.fim) });
  }

  // Calcula minutos dentro do expediente
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

// Retorna hora de fim do último turno ativo (para auto-encerramento)
// No modo OU, usa o turno mais tarde do dia como referência
const fimExpediente = (expediente) => {
  if (!expediente) return "18:00";
  const f1 = expediente.turno1?.fim || expediente.fim || "18:00";
  const f2 = expediente.turno2?.ativo ? (expediente.turno2?.fim || "18:00") : "00:00";
  if (expediente.turno2?.ativo) return f2 > f1 ? f2 : f1; // sempre o mais tarde
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
              <Inp label="Senha" type="password" value={senha} onChange={setSenha} placeholder="Digite sua senha" required/>
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
    <Inp label="Observação (opcional)" value={obs} onChange={setObs} placeholder={tipoSessao==="projeto"?"Ex: Modelagem no Eberick...":"Ex: Orçamento para cliente X..."}/>
    <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}>
      <Btn variant="ghost" onClick={onFechar}>Agora não</Btn>
      <Btn onClick={()=>onIniciar(tipoSessao==="projeto"?projSel:null, hi, obs, tipoSessao==="admin"?catSel:null)}
        disabled={tipoSessao==="projeto"?!projSel:!catSel}>▶ Iniciar</Btn>
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
  </>, "⏰ Verificação de Atividade", "Já faz 1 hora — você ainda está trabalhando?", C.amarelo, C.laranja);

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
      <Inp label="Observação do dia (opcional)" value={obs} onChange={setObs} placeholder="Como foi o dia?"/>
      <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}>
        <Btn variant="ghost" onClick={onFechar}>Cancelar</Btn>
        <Btn variant="verde" onClick={()=>onEncerrar(hf,obs)} disabled={!horaValida}>✔ Encerrar e Salvar</Btn>
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

  const horasPrevistas = diasUteis * calendario.HORAS_DIA;
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
              Feriados nacionais + MG + Gov. Valadares • Expediente: 9h–12h e 14h–18h ({calendario.HORAS_DIA}h/dia)
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
            {label:"Horas Previstas", valor:`${horasPrevistas - recessosMes.length * calendario.HORAS_DIA}h`, cor:C.azulClaro, icone:"⏱", sub:`${calendario.HORAS_DIA}h × ${diasUteis - recessosMes.length} dias`},
            {label:"Feriados",    valor:feriadosMes.length,    cor:C.laranja, icone:"🎉", sub:"no mes"},
            {label:"Recessos",    valor:recessosMes.length,    cor:C.amarelo, icone:"🏖", sub:"cadastrados"},
            {label:"Expediente",  valor:"7h/dia",              cor:C.verde,   icone:"🏢", sub:"9–12h e 14–18h"},
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
                        <div style={{fontSize:10,color:C.cinzaClaro}}>de {Math.round(calendario.diasUteisNoMes(ano,mes)*calcHorasDia(d.usuario.expediente))}h ({d.pct}%)</div>
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

function BancoHoras({registros,usuarios,projetos,usuarioAtual,onAbrirEncerramento}){
  const [filtroUser,setFU]=useState(usuarioAtual.perfil==="colaborador"?usuarioAtual.id:"todos");
  const [filtroMes,setFM]=useState("todos");
  const isGestor=["admin","gestor"].includes(usuarioAtual.perfil);

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
        <div style={{padding:"14px 20px",borderBottom:`1px solid ${C.cinzaCard}`}}><h3 style={{color:C.azulEscuro,margin:0,fontSize:14,fontWeight:700}}>📋 Histórico de Sessões</h3></div>
        <div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
            <thead><tr style={{background:C.azulEscuro}}>{["Data","Colaborador","Projeto","Entrada","Saída","Duração","Obs"].map(h=><th key={h} style={{padding:"10px 14px",color:C.ciano,textAlign:"left",fontWeight:700,fontSize:11}}>{h}</th>)}</tr></thead>
            <tbody>
              {filtrados.length===0&&<tr><td colSpan={7} style={{padding:"24px",textAlign:"center",color:C.cinzaClaro}}>Nenhum registro encontrado</td></tr>}
              {[...filtrados].sort((a,b)=>(b.inicioTs||0)-(a.inicioTs||0)).map((r,i)=>{
                const u=usuarios.find(x=>x.id===r.usuarioId);
                const proj=projetos.find(p=>p.id===r.projetoId);
                const aberta=!r.horaFim;
                return(<tr key={r.id} style={{borderBottom:`1px solid ${C.cinzaFundo}`,background:i%2===0?C.branco:"#f8fafc"}}>
                  <td style={{padding:"9px 14px",color:C.cinzaClaro,whiteSpace:"nowrap"}}>{r.data?fmtData(r.data):"—"}</td>
                  <td style={{padding:"9px 14px"}}><div style={{display:"flex",alignItems:"center",gap:8}}><Avatar u={u} size={24}/><span style={{fontWeight:600,fontSize:12}}>{u?.nome||"—"}</span></div></td>
                  <td style={{padding:"9px 14px"}}><div style={{fontSize:11,fontWeight:700,color:C.azulMedio}}>{proj?.codigo||"—"}</div><div style={{fontSize:11,color:C.cinzaClaro}}>{proj?.cliente?.substring(0,28)||""}</div></td>
                  <td style={{padding:"9px 14px",color:C.cinzaClaro}}>{r.horaInicio||"—"}</td>
                  <td style={{padding:"9px 14px",color:C.cinzaClaro}}>{aberta?<span style={{color:C.verde,fontWeight:700}}>Em aberto</span>:r.horaFim}</td>
                  <td style={{padding:"9px 14px",fontWeight:700,color:aberta?C.verde:C.azulEscuro}}>{aberta?"...":fmtDuracao(r.duracaoMin)}</td>
                  <td style={{padding:"9px 14px",color:C.cinzaClaro,fontSize:11}}>{r.obs||"—"}</td>
                  {["admin","gestor"].includes(usuarioAtual.perfil)&&<td style={{padding:"9px 14px"}}>
                    <Btn onClick={e=>{e.stopPropagation();if(window.confirm("Excluir este registro?"))setRegistros(x=>x.filter(x2=>x2.id!==r.id));}} variant="danger" small>🗑</Btn>
                  </td>}
                </tr>);
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ─── CONFIGURAÇÕES ─────────────────────────────────────────────────────────────
function Configuracoes({usuarios,onSalvarUsuarios,usuarioAtual}){
  const [lista,setLista]=useState(usuarios);
  const [editId,setEditId]=useState(null);
  const [showForm,setShowForm]=useState(false);
  const VAZIO={id:"",nome:"",email:"",senha:"",salario:0,perfil:"colaborador",cor:"#2563a8",iniciais:"",ativo:true,expediente:{turno1:{inicio:"09:00",fim:"12:00"},turno2:{ativo:true,inicio:"14:00",fim:"18:00"},modo:"E"},especialidades:[]};
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
            {[{label:"Verificação de atividade",valor:"A cada 1 hora",sub:"Aviso automático durante sessão"},{label:"Expediente",valor:"9h–12h e 14h–18h",sub:"7 horas por dia útil"},{label:"Encerramento automático",valor:"5 min após fim do expediente",sub:"Se sessão ainda estiver aberta"},{label:"Versão",valor:"INTEC v2.0",sub:"Com Supabase + Realtime"}].map(i=>(
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
              {/* Turno 1 */}
              <div style={{gridColumn:"1/-1"}}>
                <label style={{fontSize:12,fontWeight:600,color:C.cinzaEscuro,display:"block",marginBottom:8}}>
                  Turno 1 (obrigatório)
                  <span style={{fontSize:11,color:C.cinzaClaro,fontWeight:400,marginLeft:8}}>
                    {form.expediente?.turno1?.inicio&&form.expediente?.turno1?.fim
                      ? `${Math.max(0,(horaMin(form.expediente.turno1.fim)-horaMin(form.expediente.turno1.inicio))/60).toFixed(1)}h`
                      : ""}
                  </span>
                </label>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                  <Inp label="Entrada" value={form.expediente?.turno1?.inicio||""} onChange={v=>setForm(f=>({...f,expediente:{...f.expediente,turno1:{...f.expediente?.turno1,inicio:v}}}))} type="time"/>
                  <Inp label="Saída" value={form.expediente?.turno1?.fim||""} onChange={v=>setForm(f=>({...f,expediente:{...f.expediente,turno1:{...f.expediente?.turno1,fim:v}}}))} type="time"/>
                </div>
              </div>
              {/* Turno 2 */}
              <div style={{gridColumn:"1/-1"}}>
                <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8,padding:"10px 14px",background:form.expediente?.turno2?.ativo?"#eff6ff":"#f8fafc",borderRadius:8,border:`1px solid ${form.expediente?.turno2?.ativo?C.azulClaro:C.cinzaCard}`}}>
                  <input type="checkbox" checked={!!form.expediente?.turno2?.ativo}
                    onChange={e=>setForm(f=>({...f,expediente:{...f.expediente,turno2:{...f.expediente?.turno2,ativo:e.target.checked}}}))}
                    id="t2ativo" style={{cursor:"pointer",width:15,height:15}}/>
                  <label htmlFor="t2ativo" style={{fontSize:13,fontWeight:600,cursor:"pointer",color:form.expediente?.turno2?.ativo?C.azulMedio:C.cinzaClaro}}>
                    {form.expediente?.turno2?.ativo?"✓ Turno 2 cadastrado":"+ Adicionar Turno 2"}
                  </label>
                  {form.expediente?.turno2?.ativo&&(
                    <span style={{marginLeft:"auto",fontSize:12,fontWeight:700,color:C.azulEscuro}}>
                      Total: {calcHorasDia(form.expediente)}h/dia
                    </span>
                  )}
                </div>

                {form.expediente?.turno2?.ativo&&(<>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
                    <Inp label="Entrada turno 2" value={form.expediente?.turno2?.inicio||""} onChange={v=>setForm(f=>({...f,expediente:{...f.expediente,turno2:{...f.expediente?.turno2,inicio:v}}}))} type="time"/>
                    <Inp label="Saída turno 2" value={form.expediente?.turno2?.fim||""} onChange={v=>setForm(f=>({...f,expediente:{...f.expediente,turno2:{...f.expediente?.turno2,fim:v}}}))} type="time"/>
                  </div>

                  {/* Modo E/OU */}
                  <div style={{padding:"12px 14px",background:"#f0f4f8",borderRadius:10,border:`1px solid ${C.cinzaCard}`}}>
                    <div style={{fontSize:12,fontWeight:700,color:C.cinzaEscuro,marginBottom:10}}>
                      Como este colaborador trabalha?
                    </div>
                    <div style={{display:"flex",gap:10}}>
                      {[
                        { val:"E",  titulo:"Manhã E Tarde",    sub:"Trabalha os 2 turnos todo dia",      icone:"🔁" },
                        { val:"OU", titulo:"Manhã OU Tarde",   sub:"Trabalha só 1 turno por dia (flexível)", icone:"🔀" },
                      ].map(opt=>{
                        const ativo = (form.expediente?.modo||"E") === opt.val;
                        return (
                          <div key={opt.val} onClick={()=>setForm(f=>({...f,expediente:{...f.expediente,modo:opt.val}}))}
                            style={{flex:1,padding:"10px 14px",borderRadius:10,border:`2px solid ${ativo?C.azulMedio:C.cinzaCard}`,background:ativo?C.azulEscuro:"white",cursor:"pointer",transition:"all 0.15s"}}>
                            <div style={{fontSize:18,marginBottom:4}}>{opt.icone}</div>
                            <div style={{fontSize:13,fontWeight:700,color:ativo?C.branco:C.cinzaEscuro}}>{opt.titulo}</div>
                            <div style={{fontSize:11,color:ativo?"rgba(255,255,255,0.7)":C.cinzaClaro,marginTop:2}}>{opt.sub}</div>
                            {ativo&&opt.val==="E"&&<div style={{fontSize:11,color:C.ciano,marginTop:4,fontWeight:700}}>{calcHorasDia(form.expediente)}h/dia contabilizadas</div>}
                            {ativo&&opt.val==="OU"&&<div style={{fontSize:11,color:C.ciano,marginTop:4,fontWeight:700}}>{Math.max(
                              form.expediente?.turno1?.inicio&&form.expediente?.turno1?.fim ? Math.max(0,(horaMin(form.expediente.turno1.fim)-horaMin(form.expediente.turno1.inicio))/60) : 0,
                              form.expediente?.turno2?.inicio&&form.expediente?.turno2?.fim ? Math.max(0,(horaMin(form.expediente.turno2.fim)-horaMin(form.expediente.turno2.inicio))/60) : 0
                            ).toFixed(1)}h/dia contabilizadas</div>}
                          </div>
                        );
                      })}
                    </div>
                    {(form.expediente?.modo||"E")==="OU"&&(
                      <div style={{marginTop:10,padding:"8px 12px",background:"#fffbeb",borderRadius:8,border:"1px solid #fde68a",fontSize:12,color:"#92400e"}}>
                        ℹ️ O sistema aceita registro em qualquer um dos 2 turnos, mas conta apenas 1 turno por dia na meta de produtividade.
                      </div>
                    )}
                  </div>
                </>)}
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
            {label:"Verificação de atividade",valor:"A cada 1 hora",sub:"Aviso automático durante sessão"},
            {label:"Drive raiz",valor:"ENGENHARIA INTEGRADA",sub:`ID: ${DRIVE_ROOT_ID.substring(0,18)}...`},
            {label:"Encerramento automático",valor:"5 min após fim do expediente",sub:"Se sessão ainda estiver aberta"},
            {label:"Armazenamento",valor:"localStorage (navegador)",sub:"Dados salvos localmente"},
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
  const [form,setForm]=useState(projeto||{id:"",codigo:"",cliente:"",responsavel:"",coresponsavel:"",ano:new Date().getFullYear(),tipo:"PE",status:"Novo/Definir",prazo:60,dataContrato:"",dataEntregaPrevista:"",obs:"",temContrato:false,parcelas:[],driveUrl:""});
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
        <div style={{padding:24,display:"flex",flexDirection:"column",gap:20}}>
          <div>
            <h3 style={{color:C.azulEscuro,fontSize:13,fontWeight:700,margin:"0 0 12px",textTransform:"uppercase",letterSpacing:1}}>📁 Identificação</h3>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              <Inp label={`Código *${form._doDrive?" (não editável)":""}`} value={form.codigo} onChange={v=>s("codigo",v)} required readOnly={!!form._doDrive}/>
              <Sel label="Tipo" value={form.tipo} onChange={v=>s("tipo",v)} options={Object.entries(TIPOS).map(([k,v])=>({value:k,label:`${k} – ${v}`}))}/>
              <div style={{gridColumn:"1/-1"}}><Inp label={`Cliente / Projeto *${form._doDrive?" (importado do Drive — não editável)":""}`} value={form.cliente} onChange={v=>s("cliente",v)} required readOnly={!!form._doDrive}/></div>
              <Sel label="Responsável" value={form.responsavel} onChange={v=>s("responsavel",v)}
                options={[{value:"",label:"— Selecione —"},...usuarios.filter(u=>u.ativo).map(u=>({value:u.nome,label:u.nome}))]}/>
              <Sel label="Co-responsável" value={form.coresponsavel} onChange={v=>s("coresponsavel",v)}
                options={[{value:"",label:"— Nenhum —"},...usuarios.filter(u=>u.ativo).map(u=>({value:u.nome,label:u.nome}))]}/>
              {form._doDrive ? <div style={{display:"flex",flexDirection:"column",gap:4}}><label style={{fontSize:12,fontWeight:600,color:C.cinzaEscuro}}>Ano</label><input value={form.ano} readOnly style={{border:`1.5px solid ${C.cinzaCard}`,borderRadius:8,padding:"8px 12px",fontSize:14,background:"#f8fafc",cursor:"not-allowed",color:C.cinzaClaro}}/></div> : <Sel label="Ano" value={form.ano} onChange={v=>s("ano",parseInt(v))} options={[2024,2025,2026,2027].map(y=>({value:y,label:y}))}/>}
              <Sel label="Status" value={form.status} onChange={v=>s("status",v)} options={Object.keys(STATUS_CONFIG).map(k=>({value:k,label:k}))}/>
            </div>
          </div>
          <div>
            <h3 style={{color:C.azulEscuro,fontSize:13,fontWeight:700,margin:"0 0 12px",textTransform:"uppercase",letterSpacing:1}}>📋 Contrato & Prazo</h3>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12,padding:"10px 14px",background:form.temContrato?"#f0fdf4":"#fef9f0",borderRadius:8,border:`1px solid ${form.temContrato?"#86efac":"#fde68a"}`}}>
              <input type="checkbox" checked={form.temContrato} onChange={e=>s("temContrato",e.target.checked)} id="tc" style={{width:16,height:16,cursor:"pointer"}}/>
              <label htmlFor="tc" style={{fontSize:13,fontWeight:600,color:form.temContrato?"#166534":"#92400e",cursor:"pointer"}}>{form.temContrato?"✓ Contrato assinado":"⚠ Sem contrato formalizado"}</label>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12}}>
              <Inp label="Data do Contrato" value={form.dataContrato} onChange={v=>s("dataContrato",v)} type="date"/>
              <Inp label="Prazo (Dias Úteis)" value={form.prazo} onChange={v=>s("prazo",parseInt(v)||0)} type="number"/>
              <Inp label="Entrega Prevista" value={form.dataEntregaPrevista} onChange={v=>s("dataEntregaPrevista",v)} type="date"/>
            </div>
          </div>
          <div>
            <h3 style={{color:C.azulEscuro,fontSize:13,fontWeight:700,margin:"0 0 12px",textTransform:"uppercase",letterSpacing:1}}>💰 Financeiro</h3>
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
          <div>
            <h3 style={{color:C.azulEscuro,fontSize:13,fontWeight:700,margin:"0 0 12px",textTransform:"uppercase",letterSpacing:1}}>🔗 Drive & Obs</h3>
            <div style={{display:"flex",flexDirection:"column",gap:12}}>
              {form._doDrive ? <div style={{display:"flex",flexDirection:"column",gap:4}}><label style={{fontSize:12,fontWeight:600,color:C.cinzaEscuro}}>Link do Drive <span style={{fontSize:10,color:C.cinzaClaro}}>(gerenciado automaticamente)</span></label><div style={{display:"flex",gap:8,alignItems:"center"}}><input value={form.driveUrl} readOnly style={{flex:1,border:`1.5px solid ${C.cinzaCard}`,borderRadius:8,padding:"8px 12px",fontSize:12,background:"#f8fafc",cursor:"not-allowed",color:C.cinzaClaro}}/>{form.driveUrl&&<a href={form.driveUrl} target="_blank" rel="noreferrer" style={{color:C.azulClaro,fontSize:12,whiteSpace:"nowrap"}}>📂 Abrir</a>}</div></div> : <Inp label="Link da pasta no Google Drive" value={form.driveUrl} onChange={v=>s("driveUrl",v)} placeholder="https://drive.google.com/..."/>}
              <div style={{display:"flex",flexDirection:"column",gap:4}}>
                <label style={{fontSize:12,fontWeight:600,color:C.cinzaEscuro}}>Observações</label>
                <textarea value={form.obs} onChange={e=>s("obs",e.target.value)} rows={2} style={{border:`1.5px solid ${C.cinzaCard}`,borderRadius:8,padding:"8px 12px",fontSize:14,fontFamily:"inherit",color:C.cinzaEscuro,outline:"none",resize:"vertical",width:"100%",boxSizing:"border-box"}}/>
              </div>
            </div>
          </div>
          <div style={{display:"flex",gap:10,justifyContent:"space-between",paddingTop:8,borderTop:`1px solid ${C.cinzaCard}`}}>
            {modo==="editar"&&<Btn variant="danger" small onClick={()=>onExcluir(projeto.id)}>🗑 Excluir</Btn>}
            <div style={{display:"flex",gap:10,marginLeft:"auto"}}><Btn variant="ghost" onClick={onClose}>Cancelar</Btn><Btn onClick={()=>onSave(form)}>💾 Salvar</Btn></div>
          </div>
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
        {p.responsavel&&<span>👤 {p.responsavel}{p.coresponsavel&&` / ${p.coresponsavel}`}</span>}
        {p.dataEntregaPrevista&&<span style={{color:dias!==null&&dias<0?C.vermelho:dias!==null&&dias<7?C.laranja:C.cinzaClaro}}>📅 {fmtData(p.dataEntregaPrevista)}{dias!==null&&` (${dias<0?`${Math.abs(dias)}d atrasado`:`${dias}d`})`}</span>}
        {p.driveUrl&&<a href={p.driveUrl} target="_blank" rel="noreferrer" onClick={e=>e.stopPropagation()} style={{color:C.azulClaro,textDecoration:"none"}}>📂</a>}
      </div>
      {total>0&&(<div><div style={{display:"flex",justifyContent:"space-between",fontSize:11,marginBottom:3}}><span style={{color:C.verde}}>✓ {fmt(rec)}</span><span style={{color:C.cinzaClaro}}>{fmt(total)}</span></div><div style={{background:C.cinzaFundo,borderRadius:4,height:4}}><div style={{background:pct===100?C.verde:C.azulClaro,height:4,borderRadius:4,width:`${pct}%`,transition:"width 0.3s"}}/></div></div>)}
      {p.obs&&<p style={{margin:"8px 0 0",fontSize:11,color:C.cinzaClaro,fontStyle:"italic",borderTop:`1px solid ${C.cinzaFundo}`,paddingTop:6}}>💬 {p.obs}</p>}
    </div>
  </div>);
}

function TabelaProjetos({projetos,onAbrirProjeto}){
  const [ordem,setOrdem]=useState({col:"codigo",dir:"asc"});
  const toggle=key=>setOrdem(o=>o.col===key?{col:key,dir:o.dir==="asc"?"desc":"asc"}:{col:key,dir:"asc"});
  const sorted=useMemo(()=>{
    const arr=[...projetos];
    arr.sort((a,b)=>{
      let va,vb;
      switch(ordem.col){
        case "financeiro":{const ta=(a.parcelas||[]).reduce((s,x)=>s+x.valor,0);const tb=(b.parcelas||[]).reduce((s,x)=>s+x.valor,0);return ordem.dir==="asc"?ta-tb:tb-ta;}
        case "status": va=statusN(a.status);vb=statusN(b.status);break;
        case "dataEntregaPrevista": va=a.dataEntregaPrevista||"";vb=b.dataEntregaPrevista||"";break;
        default: va=a[ordem.col]||"";vb=b[ordem.col]||"";
      }
      const c=String(va).localeCompare(String(vb),"pt-BR",{numeric:true,sensitivity:"base"});
      return ordem.dir==="asc"?c:-c;
    });
    return arr;
  },[projetos,ordem.col,ordem.dir]);
  const Th=({col,label})=>{const a=ordem.col===col;return <th onClick={()=>toggle(col)} style={{padding:"11px 14px",color:a?C.branco:C.ciano,textAlign:"left",fontWeight:700,fontSize:11,letterSpacing:0.5,cursor:"pointer",userSelect:"none",whiteSpace:"nowrap",background:a?"rgba(255,255,255,0.12)":"transparent",transition:"background 0.15s"}} onMouseEnter={e=>e.currentTarget.style.background="rgba(255,255,255,0.15)"} onMouseLeave={e=>e.currentTarget.style.background=a?"rgba(255,255,255,0.12)":"transparent"}>{label}<span style={{marginLeft:4,fontSize:10,opacity:a?1:0.4}}>{a?(ordem.dir==="asc"?"↑":"↓"):"⇅"}</span></th>;};
  return(<Card style={{padding:0,overflow:"hidden"}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}><thead><tr style={{background:C.azulEscuro}}><Th col="codigo" label="Código"/><Th col="tipo" label="Tipo"/><Th col="cliente" label="Cliente"/><Th col="responsavel" label="Responsável"/><Th col="status" label="Status"/><Th col="dataEntregaPrevista" label="Entrega"/><Th col="financeiro" label="Financeiro"/></tr></thead><tbody>{sorted.map((p,i)=>{const total=(p.parcelas||[]).reduce((a,x)=>a+x.valor,0);const rec=(p.parcelas||[]).reduce((a,x)=>a+(x.pago?x.valor:0),0);return <tr key={p.id+"_"+i} onClick={()=>onAbrirProjeto(p)} style={{borderBottom:`1px solid ${C.cinzaFundo}`,cursor:"pointer",background:i%2===0?C.branco:"#f8fafc",transition:"background 0.12s"}} onMouseEnter={e=>e.currentTarget.style.background="#e8f4fd"} onMouseLeave={e=>e.currentTarget.style.background=i%2===0?C.branco:"#f8fafc"}><td style={{padding:"10px 14px",fontWeight:600,color:C.azulMedio}}>{p.codigo}</td><td style={{padding:"10px 14px"}}><TipoBadge tipo={p.tipo}/></td><td style={{padding:"10px 14px",maxWidth:240,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.cliente}</td><td style={{padding:"10px 14px",color:C.cinzaClaro}}>{p.responsavel}{p.coresponsavel?` / ${p.coresponsavel}`:""}</td><td style={{padding:"10px 14px"}}><Badge status={p.status}/></td><td style={{padding:"10px 14px",color:C.cinzaClaro,whiteSpace:"nowrap"}}>{fmtData(p.dataEntregaPrevista)}</td><td style={{padding:"10px 14px"}}>{total>0?<span style={{color:rec===total?C.verde:C.amarelo,fontWeight:600}}>{fmt(rec)}/{fmt(total)}</span>:<span style={{color:C.cinzaClaro}}>—</span>}</td></tr>;})}</tbody></table></Card>);
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
      <div style={{marginTop:8,fontSize:12,color:C.cinzaClaro}}>{filtrados.length} projeto(s)</div>
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

function Dashboard({projetos,onAbrirProjeto,drive,onImportar,usuarioAtual}){
  const [abaD,setAbaD] = useState("visao");
  const isColab = usuarioAtual?.perfil==="colaborador";
  const ativos=projetos.filter(p=>!["CONCLUÍDO","CANCELADO"].includes(statusN(p.status)));
  const porStatus={};projetos.forEach(p=>{const s=statusN(p.status);porStatus[s]=(porStatus[s]||0)+1;});
  const recTotal=projetos.reduce((a,p)=>a+(p.parcelas||[]).reduce((b,x)=>b+x.valor,0),0);
  const recRecebida=projetos.reduce((a,p)=>a+(p.parcelas||[]).reduce((b,x)=>b+(x.pago?x.valor:0),0),0);
  const porTipo={};projetos.forEach(p=>{porTipo[p.tipo]=(porTipo[p.tipo]||0)+1;});
  const semC=ativos.filter(p=>!p.temContrato);
  const totalAlertas=ativos.filter(p=>!p.temContrato||statusN(p.status)==="ATRASADO"||(()=>{const d=diasAte(p.dataEntregaPrevista);return d!==null&&d<=14;})()).length;

  return(<div style={{display:"flex",flexDirection:"column",gap:20}}>
    {/* Sub-abas do Dashboard */}
    <div style={{display:"flex",gap:4,borderBottom:`2px solid ${C.cinzaCard}`,paddingBottom:0}}>
      {[{id:"visao",label:"📊 Visão Geral"},{id:"alertas",label:`🔔 Alertas${totalAlertas>0?` (${totalAlertas})`:""}`}].map(t=>(
        <button key={t.id} onClick={()=>setAbaD(t.id)} style={{background:"none",border:"none",padding:"10px 18px",cursor:"pointer",fontSize:13,fontFamily:"inherit",fontWeight:abaD===t.id?700:500,color:abaD===t.id?C.azulMedio:C.cinzaClaro,borderBottom:abaD===t.id?`2px solid ${C.azulMedio}`:"2px solid transparent",marginBottom:-2,transition:"all 0.15s"}}>
          {t.label}
        </button>
      ))}
    </div>

    {abaD==="alertas" && <PainelAlertas projetos={projetos} onAbrirProjeto={onAbrirProjeto}/>}

    {abaD==="visao" && <>
      <PainelDrive drive={drive} projetosExistentes={projetos} onImportar={onImportar}/>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:16}}>
        {[{label:"Ativos",valor:ativos.length,cor:C.azulMedio,i:"📂"},{label:"Concluídos",valor:porStatus["CONCLUÍDO"]||0,cor:C.verde,i:"✅"},{label:"Atrasados",valor:porStatus["ATRASADO"]||0,cor:C.vermelho,i:"⚠️"},{label:"Pausados",valor:porStatus["PAUSADO"]||0,cor:C.amarelo,i:"⏸"}].map(k=>(
          <Card key={k.label} style={{textAlign:"center",borderTop:`3px solid ${k.cor}`}}><div style={{fontSize:26}}>{k.i}</div><div style={{fontSize:34,fontWeight:800,color:k.cor,lineHeight:1}}>{k.valor}</div><div style={{fontSize:12,color:C.cinzaClaro,fontWeight:600,marginTop:4}}>{k.label}</div></Card>
        ))}
        {!isColab&&<Card style={{textAlign:"center",borderTop:`3px solid ${C.verde}`}}><div style={{fontSize:26}}>💰</div><div style={{fontSize:18,fontWeight:800,color:C.verde,lineHeight:1}}>{fmt(recRecebida)}</div><div style={{fontSize:11,color:C.cinzaClaro}}>de {fmt(recTotal)}</div><div style={{fontSize:12,color:C.cinzaClaro,fontWeight:600}}>Receita</div></Card>}
        <Card style={{textAlign:"center",borderTop:`3px solid ${C.laranja}`}}><div style={{fontSize:26}}>📋</div><div style={{fontSize:34,fontWeight:800,color:C.laranja,lineHeight:1}}>{semC.length}</div><div style={{fontSize:12,color:C.cinzaClaro,fontWeight:600,marginTop:4}}>Sem Contrato</div></Card>
      </div>
      <Card><h3 style={{color:C.azulEscuro,margin:"0 0 16px",fontSize:14,fontWeight:700}}>📊 Projetos por Tipo</h3><div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))",gap:10}}>{Object.entries(porTipo).sort((a,b)=>b[1]-a[1]).map(([tipo,qtd])=><div key={tipo} style={{padding:"10px 14px",background:C.cinzaFundo,borderRadius:8,display:"flex",justifyContent:"space-between",alignItems:"center"}}><div><div style={{fontSize:12,fontWeight:800,color:C.azulEscuro}}>{tipo}</div><div style={{fontSize:10,color:C.cinzaClaro}}>{TIPOS[tipo]||tipo}</div></div><span style={{fontSize:22,fontWeight:800,color:C.azulMedio}}>{qtd}</span></div>)}</div></Card>
      <div><h3 style={{color:C.azulEscuro,margin:"0 0 16px",fontSize:14,fontWeight:700}}>🔥 Projetos em Aberto</h3><div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))",gap:14}}>{ativos.slice(0,8).map(p=><CardProjeto key={p.id} p={p} onClick={()=>onAbrirProjeto(p)}/>)}</div></div>
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
export default function App(){
  const calendario = useCalendario();
  const [projetos,  setProjetos]  = useState([]);
  const [usuarios,  setUsuarios]  = useState(USUARIOS_PADRAO);
  const [registros, setRegistros] = useState([]);
  const [carregando,setCarregando]= useState(true);
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
  const timerRef = useRef(null);
  const expRef   = useRef(null);

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

  // Timer verificação de atividade (1h)
  useEffect(()=>{
    if(!user) return;
    timerRef.current=setInterval(()=>{
      const aberta=registros.find(r=>r.usuarioId===user.id&&!r.horaFim);
      if(aberta) setModalH("aviso");
    },CHECK_INTERVAL);
    return()=>clearInterval(timerRef.current);
  },[user,registros]);

  // Verificação fim de expediente (a cada minuto)
  useEffect(()=>{
    if(!user) return;
    expRef.current=setInterval(()=>{
      const agora=new Date().toTimeString().slice(0,5);
      const fim=fimExpediente(user.expediente);
      if(!fim||agora<fim) return;
      const aberta=registros.find(r=>r.usuarioId===user.id&&!r.horaFim);
      if(!aberta) return;
      const [fh,fm]=fim.split(":").map(Number);
      const [ah,am]=agora.split(":").map(Number);
      const diff=(ah*60+am)-(fh*60+fm);
      if(diff>=5) encerrar(fim,"Encerrado automaticamente");
      else if(diff===0) setModalH("encerramento");
    },60000);
    return()=>clearInterval(expRef.current);
  },[user,registros]);

  const sessaoAtiva=registros.find(r=>r.usuarioId===user?.id&&!r.horaFim);

  // ── Sessões ──
  const iniciar = async (projetoId, hi, obs, categoriaAdmin=null) => {
    const nova = {
      id: Date.now().toString(), usuarioId:user.id,
      projetoId: projetoId||null,
      categoriaAdmin: categoriaAdmin||null,
      data: new Date().toISOString().slice(0,10),
      horaInicio:hi, horaFim:null, duracaoMin:null,
      minutosExtras:0, inicioTs:Date.now(), obs,
    };
    setRegistros(x => [...x, nova]);
    setModalH(null);
    try { await db.sessoes.salvar(nova); } catch(e){ console.error("Erro salvar sessao:", e); }
  };

  const encerrar = async (hf, obs) => {
    let sessaoId = null;
    setRegistros(x => x.map(r => {
      if(r.usuarioId===user.id && !r.horaFim){
        const dur = Math.max(0, horaMin(hf) - horaMin(r.horaInicio));
        const u   = usuarios.find(u2=>u2.id===r.usuarioId);
        const {minutosExtras} = verificarHoraExtra(r.horaInicio, hf, u?.expediente);
        sessaoId = r.id;
        return {...r, horaFim:hf, duracaoMin:dur, minutosExtras, obs:obs||r.obs};
      }
      return r;
    }));
    setModalH(null);
    if(sessaoId) {
      const sessao = registros.find(r => r.id === sessaoId);
      if(sessao) {
        const dur = Math.max(0, horaMin(hf) - horaMin(sessao.horaInicio));
        const u   = usuarios.find(u2=>u2.id===sessao.usuarioId);
        const {minutosExtras} = verificarHoraExtra(sessao.horaInicio, hf, u?.expediente);
        try { await db.sessoes.encerrar(sessaoId, hf, dur, obs||sessao.obs, minutosExtras); }
        catch(e){ console.error("Erro encerrar sessao:", e); }
      }
    }
  };

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
    const n = {...f, id:c};
    if(modal.modo==="novo") setProjetos(p=>[...p,n]);
    else setProjetos(p=>p.map(x=>x.id===modal.projeto.id?n:x));
    setModal(null);
    try { await db.projetos.salvar(n); } catch(e){ console.error("Erro salvar projeto:", e); }
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
    // Busca o usuário atualizado da lista (pode ter salário/expediente atualizado)
    const uAtualizado = usuarios.find(x=>x.id===u.id) || u;
    setUser(uAtualizado);
    localStorage.setItem("intec_user_logado", JSON.stringify(uAtualizado));
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
  const abas=[
    {id:"dashboard",    label:"Dashboard",       icone:"📊"},
    {id:"projetos",     label:"Projetos",         icone:"📁"},
    ...(!isColab ? [{id:"financeiro", label:"Financeiro", icone:"💰"}] : []),
    {id:"horas",        label:"Banco de Horas",   icone:"⏱"},
    {id:"produtividade",label:"Produtividade",    icone:"📈"},
    {id:"calendario",   label:"Calendario",       icone:"📅"},
    {id:"config",       label:"Configuracoes",    icone:"⚙"},
  ];

  return(
    <div style={{minHeight:"100vh",background:C.cinzaFundo,fontFamily:"'Segoe UI',system-ui,sans-serif"}}>
      <div style={{background:`linear-gradient(135deg,${C.azulEscuro},${C.azulMedio})`,padding:"0 24px",boxShadow:"0 4px 20px rgba(26,58,107,0.3)",position:"sticky",top:0,zIndex:100}}>
        <div style={{maxWidth:1400,margin:"0 auto",display:"flex",alignItems:"center"}}>
          <div style={{padding:"14px 24px 14px 0",borderRight:`1px solid rgba(255,255,255,0.15)`,marginRight:24}}>
            <svg width="90" height="36" viewBox="0 0 220 80"><circle cx="28" cy="14" r="7" fill="none" stroke="#56bfe9" strokeWidth="3.5"/><path d="M21 28 Q21 52 28 52 Q35 52 35 28" fill="none" stroke="white" strokeWidth="5" strokeLinecap="round"/><path d="M35 28 Q35 14 55 14 L80 52" fill="none" stroke="white" strokeWidth="5" strokeLinecap="round"/><path d="M80 14 L80 52" fill="none" stroke="white" strokeWidth="5" strokeLinecap="round"/><text x="95" y="45" fill="white" fontSize="36" fontWeight="800" fontFamily="'Segoe UI',sans-serif" letterSpacing="2">NTEC</text></svg>
            <div style={{color:C.ciano,fontSize:9,letterSpacing:3,fontWeight:700,marginTop:-4}}>ENGENHARIA INTEGRADA</div>
          </div>
          <nav style={{display:"flex",gap:2,flex:1,overflowX:"auto"}}>
            {abas.map(a=><button key={a.id} onClick={()=>setAba(a.id)} style={{background:aba===a.id?"rgba(255,255,255,0.15)":"transparent",color:aba===a.id?C.branco:"rgba(255,255,255,0.65)",border:"none",padding:"16px 14px",cursor:"pointer",fontSize:13,fontWeight:aba===a.id?700:500,fontFamily:"inherit",display:"flex",alignItems:"center",gap:6,borderBottom:aba===a.id?`2px solid ${C.ciano}`:"2px solid transparent",transition:"all 0.2s",whiteSpace:"nowrap"}}>{a.icone} {a.label}</button>)}
          </nav>
          <div style={{display:"flex",gap:8,alignItems:"center",flexShrink:0}}>
            {sessaoAtiva&&<div style={{background:"rgba(34,197,94,0.2)",border:"1px solid rgba(34,197,94,0.4)",borderRadius:8,padding:"4px 10px",fontSize:11,color:C.verde,fontWeight:700}}>▶ Em sessão</div>}
            {!sessaoAtiva&&<Btn onClick={()=>setModalH("checkin")} variant="ciano" small>▶ Iniciar Sessão</Btn>}
            {sessaoAtiva&&<Btn onClick={()=>setModalH("encerramento")} small style={{background:"rgba(239,68,68,0.15)",color:"#fca5a5",border:"1px solid rgba(239,68,68,0.3)"}}>⏹ Encerrar</Btn>}
            <div style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer",padding:"6px 10px",borderRadius:8,border:"1px solid rgba(255,255,255,0.2)",transition:"all 0.2s"}} onClick={()=>{if(window.confirm("Sair do sistema?"))fazerLogout();}}>
              <Avatar u={user} size={28}/>
              <div style={{color:C.branco}}><div style={{fontSize:12,fontWeight:700}}>{user.nome.split(" ")[0]}</div><div style={{fontSize:10,color:C.ciano}}>{user.perfil==="admin"?"Admin":user.perfil==="gestor"?"Gestor":"Colaborador"}</div></div>
            </div>
          </div>
        </div>
      </div>

      <main style={{maxWidth:1400,margin:"0 auto",padding:"28px 24px"}}>
        {aba==="dashboard" &&<Dashboard projetos={projetos} onAbrirProjeto={abrirP} drive={drive} onImportar={importar} usuarioAtual={user}/>}
        {aba==="projetos"  &&<ListaProjetos projetos={projetos} onAbrirProjeto={abrirP} onNovoProjeto={novoP} usuarios={usuarios}/>}
        {aba==="financeiro"&&<Financeiro projetos={projetos}/>}
        {aba==="horas"          &&<BancoHoras registros={registros} usuarios={usuarios} projetos={projetos} usuarioAtual={user} onAbrirEncerramento={()=>setModalH("encerramento")}/>}
        {aba==="produtividade" &&<Produtividade registros={registros} usuarios={usuarios} projetos={projetos} usuarioAtual={user} calendario={calendario}/>}
        {aba==="calendario"    &&<ModuloCalendario calendario={calendario} usuarioAtual={user} registros={registros} usuarios={usuarios}/>}
        {aba==="config"    &&<Configuracoes usuarios={usuarios} onSalvarUsuarios={salvarUsuarios} usuarioAtual={user}/>}
      </main>

      {modal&&<ModalProjeto projeto={modal.projeto} modo={modal.modo} onClose={()=>setModal(null)} onSave={salvarP} onExcluir={excluirP} usuarios={usuarios}/>}

      {modalH&&<ModalHoras tipo={modalH} projetos={projetos} usuarioAtual={user} sessaoAtiva={sessaoAtiva} onIniciar={iniciar} onEncerrar={encerrar} onMudar={mudar} onFechar={acao=>{ if(acao==="encerrar") encerrar(new Date().toTimeString().slice(0,5),"Encerrado pelo colaborador"); else setModalH(null); }}/>}
    </div>
  );
}
