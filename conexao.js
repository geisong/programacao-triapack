/* ---------- conexão: Supabase (login + dados compartilhados) ---------- */
function makeDb(sb){
  const subs = new Map(); const timers = {};
  const CP = window.APP_TESTE ? "teste_" : ""; /* app de teste grava em coleções separadas */
  async function fetchCol(col){ let all=[], from=0; for(;;){ const {data,error} = await sb.from("docs").select("id,data").eq("col",CP+col).range(from,from+999); if (error) throw error; all = all.concat(data); if (data.length<1000) break; from += 1000; } return all; }
  const snap = rows => ({docs: rows.map(r=>({id:r.id, exists:true, data:()=>r.data})), metadata:{fromCache:false, hasPendingWrites:false}, size:rows.length, empty:!rows.length});
  const fail = e => ({code: (e && e.code) || "unavailable", message: (e && e.message) || String(e)});
  const docRef = (col,id) => ({ id, path:col+"/"+id,
    async get(){ const {data,error} = await sb.from("docs").select("data").eq("col",CP+col).eq("id",id).maybeSingle(); if (error) throw fail(error); return {id, exists:!!data, data:()=>data ? data.data : undefined}; },
    async set(d){ const {error} = await sb.from("docs").upsert({col:CP+col, id, data:d, updated_at:new Date().toISOString()}); if (error) throw fail(error); },
    async delete(){ const {error} = await sb.from("docs").delete().eq("col",CP+col).eq("id",id); if (error) throw fail(error); },
    onSnapshot(next, err){ return colRef(col).onSnapshot(s=>{ const d = s.docs.find(x=>x.id===id); next(d ? {id, exists:true, data:d.data} : {id, exists:false, data:()=>undefined}); }, err); } });
  const colRef = col => ({ path:col, doc:id=>docRef(col,id), async get(){ return snap(await fetchCol(col)); },
    async setMany(entries){ for (let i=0;i<entries.length;i+=200){ const chunk = entries.slice(i,i+200).map(([id,d])=>({col:CP+col, id, data:d, updated_at:new Date().toISOString()})); const {error} = await sb.from("docs").upsert(chunk); if (error) throw fail(error); } },
    async deleteMany(ids){ for (let i=0;i<ids.length;i+=200){ const {error} = await sb.from("docs").delete().eq("col",CP+col).in("id", ids.slice(i,i+200)); if (error) throw fail(error); } },
    onSnapshot(next, err){ let alive = true; const run = async () => { try { const rows = await fetchCol(col); if (alive) next(snap(rows)); } catch(e){ if (alive && err) err(fail(e)); } };
      run(); const set = subs.get(col) || new Set(); set.add(run); subs.set(col, set); return () => { alive = false; set.delete(run); }; } });
  sb.channel("docs-mudancas").on("postgres_changes", {event:"*", schema:"public", table:"docs"}, p => {
    let col = (p.new && p.new.col) || (p.old && p.old.col); if (col){ if (CP){ if (!col.startsWith(CP)) return; col = col.slice(CP.length); } else if (col.startsWith("teste_")) return; } const cols = col ? [col] : [...subs.keys()];
    cols.forEach(c => { clearTimeout(timers[c]); timers[c] = setTimeout(()=>{ (subs.get(c)||[]).forEach(fn=>fn()); }, 400); });
  }).subscribe();
  return { collection: colRef, doc: path => { const [c,i] = path.split("/"); return docRef(c,i); }, refresh: () => subs.forEach(set => set.forEach(fn => fn())),
    async oficial(col){ let all=[], from=0; for(;;){ const {data,error} = await sb.from("docs").select("id,data").eq("col",col).range(from,from+999); if (error) throw fail(error); all = all.concat(data); if (data.length<1000) break; from += 1000; } return all; } };
}
let sb = null, perfil = null;
/* Administrador: só ele vê Usuários. Antes do SQL do admin (coluna inexistente), vale o programador. */
const ehAdmin = () => !!perfil && ("admin" in perfil ? perfil.admin===true : perfil.papel==="programador");
/* Atualização automática: versão nova do site e dados do banco ao abrir/voltar para o app */
let ultimaChecagem = 0;
async function verificarVersao(manual, aviso){
  const agora = Date.now(); if (!manual && agora - ultimaChecagem < 15000) return; ultimaChecagem = agora;
  try {
    const r = await fetch("version.json?t=" + agora, {cache:"no-store"}); const j = await r.json();
    if (j && j.v && j.v !== window.APP_VERSAO){
      let n = 0; try { n = Number(sessionStorage.getItem("recarga_"+j.v)||0); sessionStorage.setItem("recarga_"+j.v, n+1); } catch(_){}
      if (n < 2){ location.replace(location.pathname + "?v=" + encodeURIComponent(j.v) + location.hash); return; }
    }
  } catch(_){}
  if (db && db.refresh) db.refresh();
  if (aviso && typeof toast==="function") toast("Dados atualizados.");
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState==="visible") verificarVersao(false); });
window.addEventListener("pageshow", e => { if (e.persisted) verificarVersao(true); });
window.addEventListener("online", () => verificarVersao(true));
/* Sair: encerra a sessão neste aparelho mesmo se a internet falhar ou o Supabase demorar */
let saindo = false;
async function sairApp(e){
  if (e) e.preventDefault();
  if (saindo) return; saindo = true;
  const b = document.getElementById("sair") || document.getElementById("aSair"); if (b) b.textContent = "Saindo...";
  try { await Promise.race([ sb.auth.signOut({scope:"local"}), new Promise(r=>setTimeout(r,2500)) ]); } catch(_){}
  try { Object.keys(localStorage).filter(k=>k.startsWith("sb-")).forEach(k=>localStorage.removeItem(k)); } catch(_){}
  try { sessionStorage.clear(); } catch(_){}
  location.replace(location.pathname + location.search);
}
const authEl = () => document.getElementById("auth");
function telaLogin(modo, msg){
  const el = authEl(); el.hidden = false; document.querySelector(".stage").hidden = true; document.getElementById("nav").hidden = true;
  el.innerHTML = `<div class="authbox">
    <img src="${document.querySelector(".brand img").src}" alt="Triapack" class="authlogo">
    <h1>${modo==="cadastro"?"Criar acesso":"Chão de fábrica"}</h1>
    <p class="sub">${modo==="cadastro"?"Depois de criar, o programador libera o seu acesso.":"Entre com seu e-mail e senha."}</p>
    <form id="fAuth" class="authform">
      ${modo==="cadastro"?`<label class="f">Nome<input id="aNome" autocomplete="name" required></label>`:""}
      <label class="f">E-mail<input id="aEmail" type="email" autocomplete="email" required></label>
      <label class="f">Senha<input id="aSenha" type="password" autocomplete="${modo==="cadastro"?"new-password":"current-password"}" minlength="6" required></label>
      <div class="notice ${msg&&msg.err?"err":""}" id="aMsg" ${msg?"":"hidden"}>${msg?esc(msg.t):""}</div>
      <button class="primary" type="submit">${modo==="cadastro"?"Criar acesso":"Entrar"}</button>
    </form>
    <button class="linkbtn" id="aTroca">${modo==="cadastro"?"Já tenho acesso · Entrar":"Primeiro acesso? Criar cadastro"}</button>
  </div>`;
  document.getElementById("aTroca").onclick = () => telaLogin(modo==="cadastro"?"login":"cadastro");
  document.getElementById("fAuth").onsubmit = async e => { e.preventDefault();
    const email = document.getElementById("aEmail").value.trim(), senha = document.getElementById("aSenha").value; const m = document.getElementById("aMsg");
    const btn = e.submitter || e.target.querySelector("button"); btn.disabled = true;
    try {
      if (modo==="cadastro"){ const nome = document.getElementById("aNome").value.trim();
        const {data, error} = await sb.auth.signUp({email, password:senha, options:{data:{nome}}}); if (error) throw error;
        if (!data.session){ telaLogin("login", {t:"Cadastro criado. Confirme pelo link enviado ao seu e-mail e depois entre."}); return; } }
      else { const {error} = await sb.auth.signInWithPassword({email, password:senha}); if (error) throw error; }
    } catch(err){ m.className="notice err"; m.hidden=false; const em = String(err && err.message || err); m.textContent = /Invalid login/i.test(em) ? "E-mail ou senha incorretos." : /registered/i.test(em) ? "Este e-mail já tem cadastro. Use Entrar." : /rate limit|too many/i.test(em) ? "Muitos cadastros em pouco tempo (limite de e-mails do servidor). Peça ao administrador para desligar a confirmação por e-mail no Supabase, ou tente de novo em 1 hora." : /not confirmed/i.test(em) ? "E-mail ainda não confirmado. Abra o link enviado ao seu e-mail, ou peça ao administrador para desligar a confirmação por e-mail." : /password/i.test(em) && /6|least|weak/i.test(em) ? "A senha precisa ter pelo menos 6 caracteres." : "Não foi possível: "+em; btn.disabled=false; }
  };
  const f = document.getElementById(modo==="cadastro"?"aNome":"aEmail"); if (f) f.focus();
}
function telaPendente(){
  const el = authEl(); el.hidden = false; document.querySelector(".stage").hidden = true; document.getElementById("nav").hidden = true;
  el.innerHTML = `<div class="authbox"><img src="${document.querySelector(".brand img").src}" alt="Triapack" class="authlogo"><h1>Acesso aguardando liberação</h1><p class="sub">Olá, ${esc(perfil.nome||perfil.email)}. Seu cadastro foi criado. Peça ao administrador (Geison) para liberar seu acesso em <b>Usuários</b>.</p>${perfil.diag?`<p class="sub" style="font-size:12px;opacity:.7">Detalhe técnico: ${esc(perfil.diag)}</p>`:""}<button id="aSair">Sair</button></div>`;
  document.getElementById("aSair").onclick = sairApp;
}
let iniciado = false;
async function entrar(session){
  const {data, error} = await sb.from("perfis").select("*").eq("user_id", session.user.id).maybeSingle();
  perfil = data || {nome:session.user.email, email:session.user.email, papel:"pendente", diag: error ? ("Erro ao ler o perfil: "+error.message+(error.code?" ("+error.code+")":"")) : "Perfil não encontrado no banco."};
  if (perfil.papel==="pendente"){ telaPendente(); return; }
  authEl().hidden = true; document.querySelector(".stage").hidden = false; document.getElementById("nav").hidden = false;
  canEdit = perfil.papel==="programador"; canWrite = true;
  document.getElementById("who").innerHTML = `${esc(perfil.nome||perfil.email)} <span class="pill ${canEdit?"acc":""}">${canEdit?"Programador":"Produção"}</span> <button class="linkbtn" id="recarr" title="Atualizar dados" aria-label="Atualizar dados" style="color:var(--hdr-muted);padding:10px 8px;margin:-10px 0;touch-action:manipulation;font-size:16px">↻</button> <button class="linkbtn" id="sair" style="color:var(--hdr-muted);padding:10px 12px;margin:-10px 0;touch-action:manipulation">Sair</button>`;
  document.getElementById("sair").onclick = sairApp;
  document.getElementById("recarr").onclick = () => verificarVersao(true, true);
  document.getElementById("navUsuarios").hidden = !ehAdmin();
  verificarVersao(true);
  if (iniciado) { render(); return; } iniciado = true;
  db = makeDb(sb); dbState = "ok"; render();
  if (window.APP_TESTE && canEdit) (async()=>{ try { /* teste: começa com as máquinas e o calendário do app oficial (só leitura do oficial) */
    for (const col of ["maquinas","calendario"]){ const cur = await db.collection(col).get(); if (!cur.empty) continue;
      const rows = await db.oficial(col); if (rows.length) await db.collection(col).setMany(rows.map(r=>[r.id, r.data])); }
    db.refresh(); } catch(e){ toast("Não foi possível copiar máquinas/calendário do app oficial: "+(e.message||e), true); } })();
  const slow = setTimeout(()=>{ if (!(S.loaded.m&&S.loaded.c&&S.loaded.p)){ dbState="slow"; render(); } }, 10000);
  const done = () => { if (S.loaded.m&&S.loaded.c&&S.loaded.p){ clearTimeout(slow); if (dbState==="slow") dbState="ok"; } schedule(); };
  const err = e => { clearTimeout(slow); dbState="off"; render(); };
  db.collection("maquinas").onSnapshot(s=>{ const o={}; s.docs.forEach(x=>{ const v=x.data(); o[v.cod]=v; }); S.maquinas=o; S.loaded.m=true; done(); }, err);
  db.collection("calendario").onSnapshot(s=>{ S.calendario=s.docs.map(x=>x.data()); S.loaded.c=true; done(); }, err);
  db.collection("pedidos").onSnapshot(s=>{ S.pedidos=s.docs.map(x=>({...x.data(), id:x.id})); S.loaded.p=true; done(); }, err);
  db.collection("ordem").onSnapshot(s=>{ const o={}, t={}, im={}, pa={}; s.docs.forEach(x=>{ const v=x.data(); if (v && v.maquina){ o[v.maquina]=v.ids||[]; t[v.maquina]=v.travas||{}; if (v.inicio) im[v.maquina]=v.inicio; if ((v.paradas||[]).length) pa[v.maquina]=v.paradas; } }); S.ordem=o; S.travas=t; S.inicioMaq=im; S.paradas=pa; schedule(); }, ()=>{});
  db.collection("apontamentos").onSnapshot(s=>{ const o={}, h={}; s.docs.forEach(x=>{ if (x.id.startsWith("hist__")) h[x.id]=x.data(); else o[x.id]=x.data(); }); S.apont=o; S.hist=h; schedule(); }, ()=>{});
  db.doc("config/importacao").onSnapshot(s=>{ S.imp = s.exists ? s.data() : null; schedule(); }, ()=>{});
}
/* ---------- usuários (somente programador) ---------- */
let usuarios = null;
async function carregarUsuarios(){ const {data, error} = await sb.from("perfis").select("*").order("criado_em"); usuarios = error ? [] : data; render(); }
function viewUsuarios(){
  if (!ehAdmin()) return `<div class="panel empty">Somente o administrador acessa esta tela.</div>`;
  if (!usuarios){ carregarUsuarios(); return `<div class="head"><div><h1>Usuários</h1></div></div><div class="panel empty">Carregando…</div>`; }
  const pend = usuarios.filter(u=>u.papel==="pendente").length;
  return `<div class="head"><div><h1>Usuários</h1><p class="sub">Quem se cadastra entra como pendente. Libere como Produção (consulta e marca produzido) ou Programador (atualiza, arrasta e trava).</p></div><button data-act="recarregarUsuarios">Recarregar</button></div>
  ${pend?`<div class="notice warn">${pend} cadastro(s) aguardando liberação.</div>`:""}
  <div class="panel" style="padding:0"><div class="scroll"><table><thead><tr><th>Nome</th><th>E-mail</th><th>Acesso</th><th>Desde</th></tr></thead><tbody>
  ${usuarios.map(u=>`<tr><td><b>${esc(u.nome||"—")}</b></td><td>${esc(u.email||"")}</td><td><select data-papel="${esc(u.user_id)}" ${perfil&&u.user_id===perfil.user_id?"disabled":""}>${[["pendente","Pendente (sem acesso)"],["consulta","Produção"],["programador","Programador"]].map(([v,l])=>`<option value="${v}" ${u.papel===v?"selected":""}>${l}</option>`).join("")}</select></td><td class="mono">${u.criado_em?new Date(u.criado_em).toLocaleDateString("pt-BR"):"—"}</td></tr>`).join("")}
  </tbody></table></div></div>`;
}
app.addEventListener("change", async e => { const t = e.target; if (!t.dataset.papel) return; t.disabled = true;
  const {error} = await sb.from("perfis").update({papel:t.value}).eq("user_id", t.dataset.papel); if (error) toast("Não foi possível alterar: "+error.message, true); else toast("Acesso atualizado."); await carregarUsuarios(); });
app.addEventListener("click", e => { const b = e.target.closest("button"); if (b && b.dataset.act==="recarregarUsuarios"){ usuarios=null; render(); } });
ROUTES.usuarios = viewUsuarios;

(async () => {
  const cfg = window.TRIAPACK_CONFIG || {};
  if (!cfg.url || !cfg.anon || !window.supabase){ app.innerHTML = `<div class="panel empty"><h2>Configuração pendente</h2><p class="sub">Falta informar o endereço e a chave do Supabase em config.js.</p></div>`; return; }
  sb = window.supabase.createClient(cfg.url, cfg.anon, {auth:{persistSession:true, autoRefreshToken:true}});
  const {data} = await sb.auth.getSession();
  if (data.session) await entrar(data.session); else telaLogin("login");

  sb.auth.onAuthStateChange((ev, session) => { if (ev==="SIGNED_IN" && session) entrar(session); if (ev==="SIGNED_OUT" && !saindo){ location.replace(location.pathname + location.search); } });
})();
})();
</script>
