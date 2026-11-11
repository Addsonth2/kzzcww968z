/* Radar de Edificações · camada real.
   As telas vêm do esboço aprovado; aqui ficam o login, a leitura do banco e as ações que gravam.
   Funções com o mesmo nome das do esboço substituem as de lá. */
"use strict";
const sb = supabase.createClient(RADAR_CFG.url, RADAR_CFG.chave, { auth: { persistSession: true, autoRefreshToken: true } });
const BASE = { edif: new Map(), regs: [] };
const T = { posses: new Map(), neg: new Map(), visitas: [], vendas: new Map(), prot: [], protDoc: new Map(), protEdif: [], ped: [], notif: [], perfis: [], uso: [], regras: {}, emails: new Map() };
const CHAVE_REGRA = { reserva: 'reserva_dias', reservaSem: 'reserva_sem_prova_dias', prova: 'prova_m', alertaMin: 'alerta_min', alertaDias: 'alerta_dias', raio: 'raio_obra_m' };
const COLS_EDIF = 'id,re,origem,nome,rua,num,bairro,cidade,lat,lng,precisao,area,res_cliente,ponto_por,ponto_em';
const PALETA = ['#FF5CCB', '#27E1F5', '#FF8A1F', '#B6F32A', '#B79CFF', '#FFD23F', '#5CFFB0', '#FF6B6B'];

/* ---------- leitura ---------- */
async function um(q) { const { data, error } = await q; if (error) throw error; return data; }
async function tudo(fq) { const out = []; for (let i = 0; ; i += 1000) { const d = await um(fq().range(i, i + 999)); out.push(...d); if (d.length < 1000) break; } return out; }

async function carregarBase() {
  const [es, rs] = await Promise.all([
    tudo(() => sb.from('edificacoes').select(COLS_EDIF).eq('origem', 'cbmsc').order('id')),
    tudo(() => sb.from('registros').select('codigo,tipo,edificacao_id,detectado_em,exigencias,prazo,emissao,texto_af,situacao,deferido,indeferido,data_protocolo,anexos').order('codigo'))]);
  BASE.edif = new Map(es.map(e => [e.id, e])); BASE.regs = rs;
}

async function carregarTrabalho() {
  const adm = souAdm(), desde = new Date(Date.now() - 15 * D).toISOString().slice(0, 10);
  const qs = [
    tudo(() => sb.from('posses').select('*').order('edificacao_id')),
    tudo(() => sb.from('negociacoes').select('*').order('edificacao_id')),
    tudo(() => sb.from('visitas').select('edificacao_id,usuario,em,comprovada,distancia_m').order('em')),
    um(sb.from('perfis').select('*').order('criado_em')),
    um(sb.from('regras').select('chave,valor')),
    tudo(() => sb.from('protegidos').select('*').order('id')),
    tudo(() => sb.from('protegidos_edif').select('*').order('protegido_id')),
    tudo(() => sb.from('pedidos').select('*').order('criado_em')),
    um(sb.from('notificacoes').select('*').order('criado_em', { ascending: false }).limit(100)),
    tudo(() => sb.from('edificacoes').select(COLS_EDIF).eq('origem', 'campo').order('id'))];
  if (adm) qs.push(
    tudo(() => sb.from('protegidos_doc').select('*').order('protegido_id')),
    tudo(() => sb.from('vendas').select('*').order('id')),
    um(sb.from('acessos_dia').select('*').gte('dia', desde)),
    um(sb.rpc('emails_equipe')));
  const r = await Promise.all(qs);
  T.posses = new Map(r[0].map(x => [x.edificacao_id, x]));
  T.neg = new Map(r[1].map(x => [x.edificacao_id, x]));
  T.visitas = r[2]; T.perfis = r[3];
  T.regras = Object.fromEntries(r[4].map(x => [x.chave, x.valor]));
  T.prot = r[5]; T.protEdif = r[6]; T.ped = r[7]; T.notif = r[8];
  r[9].forEach(e => BASE.edif.set(e.id, e));
  for (const [id, e] of BASE.edif) if (e.origem === 'campo' && !r[9].some(x => x.id === id)) BASE.edif.delete(id);
  T.protDoc = new Map(); T.vendas = new Map(); T.uso = []; T.emails = new Map();
  if (adm) {
    r[10].forEach(x => T.protDoc.set(x.protegido_id, x));
    r[11].forEach(x => { if (x.edificacao_id) T.vendas.set(x.edificacao_id, x.servicos || []); });
    T.uso = r[12]; (r[13] || []).forEach(x => T.emails.set(x.id, x.email));
  }
  montar();
}

function posAprox(cid, id) { const c = CIDADES[cid] || CIDADES.Brusque, r = rngDe(id * 7919 + 13); let dl = (r() - .5) * .05, dg = (r() - .5) * .06; if (c[2]) dg = -Math.abs(dg) - .006; return { lat: c[0] + dl, lng: c[1] + dg }; }

function montar() {
  const g = k => T.regras[k], hoje0 = new Date(); hoje0.setHours(0, 0, 0, 0);
  st.cfg = { reserva: +g('reserva_dias') || 45, reservaSem: +g('reserva_sem_prova_dias') || 15, raio: +g('raio_obra_m') || 150, prova: +g('prova_m') || 200, alertaMin: +g('alerta_min') || 3, alertaDias: +g('alerta_dias') || 7 };
  VENDAS.splice(0, VENDAS.length, ...(Array.isArray(g('servicos')) ? g('servicos') : []));
  st.coleta = g('ultima_coleta') ? Date.parse(g('ultima_coleta')) : 0;
  // uso diário
  uso = {};
  T.uso.forEach(a => { const ent = Date.parse(a.primeiro_em), ult = Date.parse(a.ultimo_em); (uso[a.dia] = uso[a.dia] || {})[a.usuario] = { ent, ult, ip: a.ip || '—', ap: a.aparelho || '—', min: Math.max(0, Math.round((ult - ent) / MIN)), logins: a.aberturas, abertos: a.abertos, pegos: a.pegos, marcados: a.marcados, visitas: a.visitas, comprovadas: a.comprovadas }; });
  const hj = chaveDia(Date.now());
  contas = T.perfis.map((p, i) => {
    const dias = Object.keys(uso).filter(k => uso[k][p.id]).sort(), u = dias.length ? uso[dias[dias.length - 1]][p.id] : null, h = (uso[hj] || {})[p.id];
    return { id: p.id, nome: p.nome, l: p.letra || '?', cor: p.cor && p.cor !== '#8A8F98' ? p.cor : PALETA[i % PALETA.length], papel: p.papel, bloq: p.bloqueado, email: T.emails.get(p.id) || '',
      sess: !!(h && Date.now() - h.ult < 10 * MIN), ip: u ? u.ip : '—', ap: u ? u.ap : '—', ent: h ? h.ent : 0, ult: h ? h.ult : 0, ultLogin: u ? u.ent : 0 };
  });
  if (st.eu) { const c = conta(st.eu.id); if (c) Object.assign(st.eu, { nome: c.nome, l: c.l, cor: c.cor, papel: c.papel }); }
  // visitas por edificação
  const visE = new Map();
  T.visitas.forEach(v => { const a = visE.get(v.edificacao_id) || []; a.push({ t: Date.parse(v.em), prova: v.comprovada, m: v.distancia_m, quem: v.usuario }); visE.set(v.edificacao_id, a); });
  // leads: um por registro do CBMSC; a edificação (RE) é a unidade
  leads = []; porRE = {};
  for (const r of BASE.regs) {
    const e = BASE.edif.get(r.edificacao_id); if (!e) continue;
    const pos = e.lat != null ? { lat: e.lat, lng: e.lng } : posAprox(e.cidade, e.id), ps = T.posses.get(e.id), ng = T.neg.get(e.id);
    const l = { tipo: r.tipo, id: r.codigo, edif: e.id, re: e.re, nome: e.nome, rua: e.rua, num: e.num, bairro: e.bairro, cidade: e.cidade, lat: pos.lat, lng: pos.lng,
      aprox: !['numero', 'manual'].includes(e.precisao), semPonto: e.lat == null, pontoPor: e.ponto_por, pontoEm: e.ponto_em, prec: e.precisao || 'cidade', area: e.area != null ? +e.area : null, det: Date.parse(r.detectado_em) || Date.now() - 90 * D,
      dono: ps ? ps.dono : null, liberado: ps ? ps.liberado : false, status: ng ? ng.status : 'novo', obs: ng ? ng.obs : '', visitas: visE.get(e.id) || [], vendido: T.vendas.get(e.id) || [] };
    if (r.tipo === 'PRO') { l.sit = r.deferido ? [r.situacao || 'Deferido', 'def'] : r.indeferido ? [r.situacao || 'Indeferido', 'ind'] : [r.situacao || 'Sem detalhe', 'ana']; l.anexos = r.anexos; l.data = r.data_protocolo ? Date.parse(r.data_protocolo + 'T12:00:00') : null; }
    else { l.exig = r.exigencias || []; l.prazo = r.prazo ? Math.round((Date.parse(r.prazo + 'T00:00:00') - hoje0) / D) : null; if (r.tipo === 'AF' && r.texto_af) { l.pend = [r.texto_af]; l.pendReal = true; l.emissao = r.emissao ? Date.parse(r.emissao + 'T12:00:00') : null; } }
    leads.push(l); if (l.re) (porRE[l.re] = porRE[l.re] || []).push(l);
  }
  // clientes de campo (cadastrados pelos vendedores e aprovados)
  obras = [];
  for (const e of BASE.edif.values()) {
    if (e.origem !== 'campo') continue; const ps = T.posses.get(e.id); if (!ps) continue;
    const ng = T.neg.get(e.id) || {}, vs = visE.get(e.id) || [], u = vs[vs.length - 1], rev = ng.revisado_em ? Date.parse(ng.revisado_em) : 0, pr = T.prot.find(p => p.edificacao_id === e.id), dc = pr && T.protDoc.get(pr.id);
    obras.push({ tipo: 'CAMPO', id: 'E' + e.id, edif: e.id, nome: e.nome, rua: e.rua, num: e.num, cidade: e.cidade, lat: e.lat, lng: e.lng, area: e.area != null ? +e.area : null, re: e.res_cliente || '',
      dono: ps.dono, status: ng.status || 'contatado', obs: ng.obs || '', retorno: ng.retorno_previsto || '', desde: Date.parse(ps.desde), ultVisita: Math.max(u ? u.t : Date.parse(ps.desde), rev),
      visitas: vs, vendido: T.vendas.get(e.id) || [], doc: dc ? dc.documento : '', fidelizado: true });
  }
  // clientes protegidos
  protegidos.splice(0, protegidos.length);
  T.prot.filter(p => p.aprovado).forEach(p => { const d = T.protDoc.get(p.id) || {}; protegidos.push({ id: 'CP' + p.id, dbid: p.id, nome: p.nome, termos: d.termos || [], doc: d.documento || '', res: d.res || [], dono: p.dono, fid: p.edificacao_id ? 'E' + p.edificacao_id : null }); });
  aplicarProtegidos();
  // pedidos
  const alvoDe = id => leads.find(l => l.edif === id) || obras.find(o => o.edif === id) || null;
  pedidos = T.ped.map(p => {
    const d = p.dados || {}, b = { id: 'P' + p.id, dbid: p.id, quem: p.de, quando: Date.parse(p.criado_em), st: p.situacao === 'aberto' ? 'aberto' : 'fechado',
      desc: p.situacao === 'aberto' ? '' : (p.situacao === 'aceito' ? 'aceito' : 'recusado') + (p.resposta ? ': ' + p.resposta : ''), prova: d.prova_m != null ? { m: d.prova_m } : null }, a = p.edificacao_id ? alvoDe(p.edificacao_id) : null;
    if (p.tipo === 'cliente') return Object.assign(b, { tipo: 'cad', nova: Object.assign({}, d, { area: d.area ? +d.area : null, retorno: (d.retorno || '').slice(0, 7) }) });
    if (p.tipo === 'liberacao') { const pe = T.protEdif.find(x => x.edificacao_id === p.edificacao_id), pr = pe && protegidos.find(x => x.dbid === pe.protegido_id); return Object.assign(b, { tipo: 'prot', prot: pr ? pr.id : null, lead: a ? a.id : null }); }
    return Object.assign(b, { tipo: 'lead', lead: a ? a.id : null, alvo: null });
  }).filter(p => p.tipo === 'cad' || p.lead);
  pedidos.forEach(p => { if (p.tipo === 'lead') { const cf = checar(achar(p.lead), p.quem); p.alvo = cf[0] ? cf[0].o.id : null; } });
  // avisos
  const TIT = { pedido: 'Pedido', venda: 'Venda fechada', liberado: 'Lead liberado', direcionado: 'Novo lead direcionado para você', removido: 'Lead removido da sua carteira', cliente: 'Cliente', mensagem: 'Mensagem do administrador' };
  st.notifs = T.notif.map(n => { const a = n.edificacao_id ? alvoDe(n.edificacao_id) : null; return { id: 'N' + n.id, dbid: n.id, para: n.para, titulo: TIT[n.tipo] || 'Aviso', txt: n.texto, alvo: a ? a.id : null, t: Date.parse(n.criado_em), lida: new Set(n.lida ? [n.para] : []) }; });
  if (souAdm() && !conta(st.quemCart)) st.quemCart = (vendedores()[0] || st.eu).id;
}

function aplicarProtegidos() {
  st.hits = []; leads.forEach(l => { l.prot = null; });
  T.protEdif.forEach(pe => { const p = protegidos.find(x => x.dbid === pe.protegido_id); if (!p) return; const ls = leads.filter(l => l.edif === pe.edificacao_id); if (!ls.length) return; ls.forEach(l => l.prot = p.id); st.hits.push({ prot: p.id, id: ls[0].id }); });
}

/* ---------- ações ---------- */
let ocupado = false;
async function rodar(fn, ok) {
  if (ocupado) return null; ocupado = true;
  try { const { data, error } = await fn(); if (error) throw error; await carregarTrabalho(); pintar(); if (ok) toast(typeof ok === 'function' ? ok(data) : ok); return data || true; }
  catch (e) { toast((e && e.message) || 'Não deu certo. Tente de novo.'); return null; }
  finally { ocupado = false; }
}
async function recarregar() {
  if (!st.eu || ocupado) return;
  const a = document.activeElement; if (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName) && !a.closest('#login')) { clearTimeout(recarregar.t); recarregar.t = setTimeout(recarregar, 4000); return; }
  try { await carregarTrabalho(); pintar(); } catch (e) { console.warn(e); }
}
const agendar = () => { clearTimeout(agendar.t); agendar.t = setTimeout(recarregar, 900); };
function lerGPS() {
  return new Promise((ok, nao) => {
    if (!navigator.geolocation) return nao(new Error('Este aparelho não liberou o GPS para o navegador.'));
    navigator.geolocation.getCurrentPosition(p => ok({ lat: p.coords.latitude, lng: p.coords.longitude }),
      e => nao(new Error(e.code === 1 ? 'A permissão de localização foi negada. Libere nos ajustes do navegador.' : 'Não consegui ler o GPS. Tente de novo ao ar livre.')),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  });
}
const fmtDist = m => m >= 1000 ? (m / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' km' : m + ' m';

function contar(c) { if (c === 'abertos' && st.eu) sb.rpc('contar', { p_campo: 'abertos' }).then(() => {}, () => {}); }

function pegar(id) {
  const l = achar(id); if (l.dono) return toast('Este lead já tem dono.');
  if (souAdm()) return modalAtribuir(id);
  const cf = checar(l, st.eu.id);
  if (cf.length) return abrirModal(`<h3>Obra de ${esc(conta(cf[0].o.dono).nome)} aqui perto</h3><p style="margin:0">${esc(cf[0].o.nome)}, ${cf[0].mot.join(', ')}. O administrador decide quem fica. Pedir com visita comprovada dá mais força ao pedido.</p>
    <div class="fim"><button class="btn" onclick="fecharModal()">Cancelar</button><button class="btn" id="m-prova" onclick="modalVisita('${id}',true)">Estou na obra: comprovar</button><button class="btn" id="m-pedir" style="background:#fff;color:#111" onclick="pedirLead('${id}')">Pedir ao administrador</button></div>`);
  rodar(() => sb.rpc('pegar_lead', { p_edif: l.edif }), grupo(l).length > 1 ? 'Edificação é sua: ' + resumoG(l) + '.' : 'Lead é seu.');
}
function pedirLead(id) { const l = achar(id); fecharModal(); rodar(() => sb.rpc('pedir', { p_tipo: 'conflito', p_edif: l.edif, p_texto: 'Lead perto de obra de outro vendedor: ' + l.nome }), 'Pedido enviado ao administrador.'); }
function atribuir(id) { const l = achar(id), nv = $('#m-v').value; fecharModal(); rodar(() => sb.rpc('direcionar_lead', { p_edif: l.edif, p_para: nv }), 'Atribuído a ' + conta(nv).nome + '.'); }
function soltar(id) {
  const l = achar(id); if (l.dono !== st.eu.id && !souAdm()) return toast('Só o dono ou o administrador pode soltar.');
  rodar(() => souAdm() && l.dono !== st.eu.id ? sb.rpc('direcionar_lead', { p_edif: l.edif, p_para: null }) : sb.rpc('soltar_lead', { p_edif: l.edif }), 'Voltou para a fila.');
}
function marcar(id, s) { const x = achar(id); if (x.dono !== st.eu.id && !souAdm()) return; rodar(() => sb.rpc('marcar_status', { p_edif: x.edif, p_status: s })); }
function salvarObs(id) { const v = $('#m-obs').value.trim(), x = achar(id); fecharModal(); rodar(() => sb.from('negociacoes').update({ obs: v }).eq('edificacao_id', x.edif), 'Observação salva.'); }
function abrirESci(id) {
  try { navigator.clipboard && navigator.clipboard.writeText(id).catch(() => {}); } catch (e) {}
  contar('abertos'); window.open('https://esci.cbm.sc.gov.br', '_blank', 'noopener');
  toast('Código ' + id + ' copiado. Cole na Consulta Geral do e-SCI.');
}
function modalVisita(id, pegando) {
  const x = achar(id);
  abrirModal(`<h3>${pegando ? 'Pegar com visita comprovada' : 'Registrar visita'}</h3><p class="apagado pq" style="margin:0">${esc(x.nome)}</p>
  <p style="margin:0" id="v-aviso">Vamos usar o GPS do celular para confirmar a visita.<button class="info" id="v-i" aria-label="Mais informações" onclick="$('#v-info').hidden=!$('#v-info').hidden">i</button></p><div class="bloco pq" id="v-info" hidden>A posição é lida uma única vez, neste toque, para comparar com o endereço da obra. O local não fica guardado e ninguém acompanha onde você está. Ficam registrados só a data, a hora e a distância até a obra.</div>
  ${x.semPonto ? '<div class="bloco pq">Esta edificação ainda não tem ponto exato no mapa, então a visita não tem como ser comprovada pelo GPS.</div>' : ''}
  <div id="v-res"></div><div class="pilha"><button class="btn forte" id="v-perto" onclick="confirmarVisita('${id}',true,${!!pegando})">ESTOU NA OBRA</button>
  ${pegando ? '' : `<button class="btn" id="v-sem" onclick="confirmarVisita('${id}',false,false)">Registrar sem GPS</button>`}</div>
  <div class="fim"><button class="btn" onclick="fecharModal()">Cancelar</button></div>`);
}
async function confirmarVisita(id, gps, pegando) {
  const x = achar(id), res = $('#v-res'), b = $('#v-perto'), erro = t => { if (res) res.innerHTML = `<div class="erro" id="v-erro">${esc(t)}</div>`; if (b) { b.disabled = false; b.textContent = 'ESTOU NA OBRA'; } };
  let P = { p_lat: null, p_lng: null };
  if (gps) { if (b) { b.disabled = true; b.textContent = 'Lendo o GPS...'; } try { const p = await lerGPS(); P = { p_lat: p.lat, p_lng: p.lng }; } catch (e) { return erro(e.message); } }
  if (pegando) {
    if (checar(x, st.eu.id).length) { const d = await rodar(() => sb.rpc('pedir', Object.assign({ p_tipo: 'conflito', p_edif: x.edif, p_texto: 'Pediu estando na obra: ' + x.nome }, P))); if (d) { fecharModal(); toast(d.prova_m != null ? 'Pedido enviado com visita comprovada.' : 'Pedido enviado. A visita não foi comprovada.'); } return; }
    const r = await sb.rpc('pegar_lead', { p_edif: x.edif }); if (r.error) return erro(r.error.message);
  }
  const { data, error } = await sb.rpc('registrar_visita', Object.assign({ p_edif: x.edif }, P));
  if (error) return erro(error.message);
  await carregarTrabalho(); pintar();
  if (!data.gravada) return erro(data.distancia_m != null ? `Você está a ${fmtDist(data.distancia_m)} da obra, e o limite é de ${st.cfg.prova} m. A visita não foi registrada.` : 'Esta obra não tem ponto exato no mapa. Registre sem GPS.');
  fecharModal(); toast(data.comprovada ? 'Visita comprovada a ' + data.distancia_m + ' m.' : 'Visita registrada sem comprovação.');
}
function alternarVenda(id, k) { if (!souAdm()) return; const x = achar(id), nv = x.vendido.includes(k) ? x.vendido.filter(y => y !== k) : [...x.vendido, k]; rodar(() => sb.rpc('classificar_venda', { p_edif: x.edif, p_servicos: nv })); }
function soltarObra(id) { const o = achar(id); if (o.dono !== st.eu.id && !souAdm()) return; st.aberto = null; rodar(() => souAdm() && o.dono !== st.eu.id ? sb.rpc('direcionar_lead', { p_edif: o.edif, p_para: null }) : sb.rpc('soltar_lead', { p_edif: o.edif }), 'Cliente liberado.'); }
function manterCliente(id) { const o = achar(id); rodar(() => sb.rpc('manter_cliente', { p_edif: o.edif }), 'Cliente mantido com ' + conta(o.dono).nome + '.'); }
function liberarCliente(id) { const o = achar(id); rodar(() => sb.rpc('direcionar_lead', { p_edif: o.edif, p_para: null }), 'Cliente liberado.'); }
function pedirProt(pid, lid) {
  let alvo = lid ? achar(lid) : null; if (!alvo) { const p = achaProt(pid); alvo = p && p.fid ? achar(p.fid) : null; }
  if (!alvo) return toast('Peça pelo cadastro do cliente, em Território.');
  rodar(() => sb.rpc('pedir', { p_tipo: 'liberacao', p_edif: alvo.edif, p_texto: 'Autorização para cliente protegido: ' + alvo.nome }), 'Pedido enviado ao administrador.');
}
function salvarProt() {
  const e = $('#m-erro'), f = t => { e.textContent = t; e.hidden = false; }, n = $('#p-nome').value.trim(), te = $('#p-termos').value.split(',').map(x => x.trim()).filter(Boolean), dg = $('#p-doc').value.replace(/\D/g, '');
  if (n.length < 3) return f('Informe o nome do cliente.'); if (te.some(t => norm(t).length < 3)) return f('Cada termo precisa ter pelo menos 3 letras.'); if (!te.length && !dg) return f('Informe um termo de busca ou um documento.'); if (dg && dg.length !== 11 && dg.length !== 14) return f('CNPJ tem 14 dígitos e CPF tem 11.');
  const dono = $('#p-dono').value; fecharModal(); st.vista = 'comando'; st.cmd = 'protegidos'; st.aberto = null;
  rodar(() => sb.rpc('salvar_protegido', { p_id: null, p_nome: n, p_dono: dono, p_termos: te, p_documento: dg, p_res: [] }), n + ' protegido.');
}
function removerProt(id) { const p = achaProt(id); rodar(() => sb.rpc('remover_protegido', { p_id: p.dbid }), 'Proteção removida. O dono atual continua.'); }
function iniciarMarcacao() { const c = NC[0], [la, lo] = CIDADES[c]; st.aberto = null; st.marcando = { nome: '', doc: '', rua: '', num: '', cidade: c, area: '', re: '', retorno: '', status: 'contatado', obs: '', lat: la, lng: lo, manual: false, dono: (vendedores().filter(v => !v.bloq)[0] || st.eu).id }; pintarGaveta(); desenharPino(); if (mapa) mapa.flyTo([la, lo], 13, { duration: .6 }); }
async function comprovarMarcacao() {
  const m = st.marcando, b = $('#o-prova'); if (!m) return; if (b) { b.disabled = true; b.textContent = 'Lendo o GPS...'; }
  try { const p = await lerGPS(), d = Math.round(metros(p, m)); if (d > st.cfg.prova) { m.prova = null; m.gps = null; toast(`Você está a ${fmtDist(d)} do pino. Arraste o pino até a obra ou chegue mais perto.`); } else { m.gps = p; m.prova = { m: d }; } }
  catch (e) { toast(e.message); }
  pintarGaveta();
}
function salvarObra() {
  const m = st.marcando, e = $('#o-erro'), nome = m.nome.trim(), dg = m.doc.replace(/\D/g, ''), f = t => { e.textContent = t; e.hidden = false; };
  if (nome.length < 3 || !m.rua.trim()) return f('Informe o nome e a rua da obra.'); if (dg && dg.length !== 11 && dg.length !== 14) return f('CNPJ tem 14 dígitos e CPF tem 11.');
  const d = { nome, doc: dg, rua: m.rua.trim(), num: m.num.trim(), cidade: m.cidade, lat: m.lat, lng: m.lng, area: +m.area || null, re: m.re.trim(), retorno: m.retorno ? m.retorno + '-01' : '', status: m.status, obs: m.obs.trim(), dono: souAdm() ? m.dono : '' };
  const P = m.prova && m.gps ? { p_lat: m.gps.lat, p_lng: m.gps.lng } : { p_lat: null, p_lng: null };
  st.marcando = null; desenharPino();
  rodar(() => sb.rpc('cadastrar_cliente', Object.assign({ d }, P)), r => { if (r && r.criado) { st.aberto = 'E' + r.id; return 'Cliente fidelizado para ' + conta(d.dono || st.eu.id).nome + '.'; } return 'Cadastro enviado para aprovação.'; });
}
async function pertoDeMim() {
  try { const p = await lerGPS(); st.perto = p; st.terrFiltro = 'todas'; pintar(); if (mapa) mapa.flyTo([p.lat, p.lng], 14, { duration: .8 }); toast('Posição lida só agora, para esta busca. Não fica guardada.'); }
  catch (e) { toast(e.message); }
}
async function aceitarOp(cid) {
  const o = oportunidades().find(x => x.cidade === cid); if (!o || souAdm()) return;
  const n = Math.min(st.opN[cid] || o.itens.length, o.itens.length), its = o.itens.slice(0, n); let ok = 0;
  for (const l of its) { const r = await sb.rpc('pegar_lead', { p_edif: l.edif }); if (!r.error) { ok++; if (!st.rota.includes(l.id)) st.rota.push(l.id); } }
  st.viagens.unshift({ quem: st.eu.id, cidade: cid, n: ok, t: Date.now() }); st.opFechada.add(cid); st.vista = 'radar'; fecharModal();
  await carregarTrabalho(); pintar();
  if (mapa && its.length) mapa.fitBounds(its.map(l => [l.lat, l.lng]), { padding: [90, 90], maxZoom: 15 });
  if (ok) modalRota(); toast(ok + ' AF de ' + cid + ' agora são seus.' + (ok < its.length ? ' ' + (its.length - ok) + ' já tinham dono.' : ''));
}
function enviarMsg() {
  const t = $('#msg-txt').value.trim(); if (!t) { const e = $('#m-erro'); e.textContent = 'Escreva a mensagem.'; e.hidden = false; return; }
  const p = $('#msg-para').value; fecharModal(); rodar(() => sb.rpc('mensagem', { p_para: p === 'todos' ? null : p, p_texto: t }), 'Mensagem enviada.');
}
async function decidir(id, ac) {
  const p = pedidos.find(x => x.id === id); if (!p) return;
  const aceita = ['passa', 'aprova', 'autoriza'].includes(ac); let resp = '', ret = null;
  if (p.tipo === 'cad') { const r = $('#cad-ret-' + p.id), mo = $('#cad-mot-' + p.id); if (r && r.value) ret = r.value + '-01'; if (!aceita && mo) resp = mo.value.trim(); }
  rodar(() => sb.rpc('decidir_pedido', { p_id: p.dbid, p_aceita: aceita, p_resposta: resp, p_retorno: ret }), aceita ? 'Pedido aceito.' : 'Pedido recusado.');
}
function regra(k, v, a, b) { const n = Math.min(b, Math.max(a, Math.round(+v) || a)); rodar(() => sb.from('regras').update({ valor: n, atualizado_em: new Date().toISOString() }).eq('chave', CHAVE_REGRA[k]), 'Regra atualizada.'); }
function salvarServicos(l) { rodar(() => sb.from('regras').update({ valor: l, atualizado_em: new Date().toISOString() }).eq('chave', 'servicos'), 'Tipos de venda atualizados.'); }
function addVenda() { const v = $('#r-nova').value.trim(); if (v.length < 2) return toast('Digite o nome do tipo.'); if (VENDAS.some(x => norm(x) === norm(v))) return toast('Esse tipo já existe.'); const l = [...VENDAS]; l.splice(Math.max(0, l.length - 1), 0, v); salvarServicos(l); }
function rmVenda(k) { salvarServicos(VENDAS.filter(x => x !== k)); }
function alternarBloq(id) { const c = conta(id); if (!c || c.id === st.eu.id) return; rodar(() => sb.from('perfis').update({ bloqueado: !c.bloq }).eq('id', id), c.nome + (c.bloq ? ' desbloqueado(a).' : ' bloqueado(a). Ele perde o acesso aos dados na hora.')); }
function modalPerfil(id) {
  const c = conta(id);
  abrirModal(`<h3>Editar</h3><p class="apagado pq" style="margin:0">${esc(c.email)}</p><div class="erro" id="m-erro" hidden></div>
  <label class="c">Nome<input class="inp" id="m-nome" value="${esc(c.nome === 'Novo usuário' ? '' : c.nome)}" autocomplete="off"></label>
  <div class="linha" style="flex-wrap:nowrap"><label class="c" style="flex:1">Letra no mapa<input class="inp" id="m-letra" maxlength="2" value="${esc(c.l === '?' ? '' : c.l)}"></label><label class="c" style="flex:1">Cor<input class="inp" id="m-cor" type="color" value="${esc(/^#[0-9a-f]{6}$/i.test(c.cor) ? c.cor : '#FF5CCB')}" style="height:44px;padding:4px"></label></div>
  <div class="fim"><button class="btn" onclick="fecharModal()">Cancelar</button><button class="btn" id="m-ok" style="background:#fff;color:#111" onclick="salvarPerfil('${id}')">Salvar</button></div>`);
}
function salvarPerfil(id) {
  const n = $('#m-nome').value.trim(), l = ($('#m-letra').value.trim() || n[0] || '?').toUpperCase(), cor = $('#m-cor').value, e = $('#m-erro');
  if (n.length < 2) { e.textContent = 'Informe o nome.'; e.hidden = false; return; }
  fecharModal(); rodar(() => sb.from('perfis').update({ nome: n, letra: l, cor }).eq('id', id), 'Salvo.');
}
function modalNova() {
  abrirModal(`<h3>Nova conta de vendedor</h3><ol class="pq" style="margin:0;padding-left:18px;display:grid;gap:6px">
  <li>No Supabase do Radar, abra <b>Authentication → Users → Add user → Create new user</b>.</li>
  <li>Use o e-mail do vendedor e uma senha inicial, e marque <b>Auto Confirm User</b>.</li>
  <li>Volte aqui e toque em <b>Atualizar</b>. A conta aparece em Equipe como “Novo usuário”; toque em <b>Editar</b> para dar nome, letra e cor.</li></ol>
  <p class="pq apagado" style="margin:0">Toda conta nova entra como vendedor. Só existe um administrador.</p>
  <div class="fim"><button class="btn" onclick="fecharModal()">Fechar</button><button class="btn" style="background:#fff;color:#111" onclick="fecharModal();recarregar()">Atualizar</button></div>`);
}
function cmdEquipe() {
  const ks = dias14().map(d => chaveDia(+d)), hoje = chaveDia(Date.now());
  $('#cmd').innerHTML = `<div class="linha" style="margin-bottom:12px"><span class="apagado pq">${contas.filter(x => x.sess).length} online agora</span><span class="esp"></span><button class="btn pq" id="b-msg" onclick="modalMsg()">Enviar mensagem</button><button class="btn pq" id="b-nova" style="background:#fff;color:#111" onclick="modalNova()">Nova conta</button></div>
  <div class="crachas" id="crachas">${contas.map(u => {
    const ad = u.papel === 'admin', f = funil(u.id), ho = (uso[hoje] || {})[u.id], eu = u.id === st.eu.id;
    const barras = ks.map(k => { const m = ((uso[k] || {})[u.id] || {}).min || 0; return `<i class="${m ? '' : 'zero'}" style="height:${m ? Math.max(8, Math.min(100, Math.round(m / 120 * 100))) : 2}%;background:${m ? corReal(u) : ''}" title="${k}: ${m ? m + ' min' : 'não entrou'}"></i>`; }).join('');
    return `<article class="cracha ${u.bloq ? 'bloq' : ''}" data-conta="${u.id}"><div class="top"><span class="fot" style="background:${u.cor}">${esc(u.l)}</span><div style="min-width:0;flex:1"><h3>${esc(u.nome)}${ad ? ' · admin' : ''}</h3><div class="pq apagado" style="overflow-wrap:anywhere">${esc(u.email)}</div></div><span class="etq"><i class="dot ${u.sess ? '' : 'alerta'}" style="${u.bloq ? 'background:var(--mul)' : ''}"></i>${u.bloq ? 'Bloqueada' : u.sess ? 'Online' : 'Offline'}</span></div>
    <div class="cont"><div class="pq"><span class="mono">${esc(u.ip)}</span> · ${esc(u.ap)}<br><span class="apagado">Última entrada ${haQuanto(u.ultLogin)}${u.sess && u.ult ? ' · ativo ' + haQuanto(u.ult) : ''}</span></div>
    ${ad ? '' : `<div class="trio"><div><b>${ho ? ho.min : 0}</b><span>min hoje</span></div><div><b>${f.leads}</b><span>leads</span></div><div><b>${f.campo}</b><span>campo</span></div><div><b>${f.fech}</b><span>fechados</span></div></div>
    <div class="pq" data-prova><b>${f.prov}</b> visitas comprovadas · ${f.semProv} sem comprovação</div>
    <div><div class="barras" aria-label="Minutos de uso por dia, últimos 14 dias">${barras}</div><div class="linha pq apagado" style="margin-top:2px"><span>14 dias atrás</span><span class="esp"></span><span>hoje · até 120 min</span></div></div>`}
    <div class="linha"><button class="btn pq" onclick="modalPerfil('${u.id}')">Editar</button>${eu ? '' : `<button class="btn pq" data-acao="bloq" onclick="alternarBloq('${u.id}')">${u.bloq ? 'Desbloquear' : 'Bloquear'}</button>`}</div></div></article>`;
  }).join('')}</div>`;
}
function cmdColeta() {
  const n = t => leads.filter(l => l.tipo === t).length;
  $('#cmd').innerHTML = `<p class="pq apagado" style="margin:0 0 12px">Última carga: ${st.coleta ? fmtData(st.coleta) + ' às ' + fmtHora(st.coleta) : 'nenhuma'}. O coletor automático entra na próxima etapa; até lá os dados são os do backup de 23/10/2026.</p>
  <div class="tab-wrap"><table id="t-fontes"><tr><th>Fonte</th><th>Origem</th><th class="n">Registros</th></tr>
  <tr><td><b>Multas</b></td><td>Consulta pública</td><td class="n">${n('MUL')}</td></tr><tr><td><b>AF</b></td><td>Consulta pública</td><td class="n">${n('AF')}</td></tr><tr><td><b>Protocolos</b></td><td>Consulta pública</td><td class="n">${n('PRO')}</td></tr>
  <tr><td><b>Exigências, prazo e área</b></td><td>e-SCI, só dados da edificação</td><td class="n">${leads.filter(l => l.exig && l.exig.length).length}</td></tr><tr><td><b>Texto do bombeiro no AF</b></td><td>PDF do AF, sem nomes</td><td class="n">${leads.filter(l => l.pendReal).length}</td></tr>
  <tr><td><b>Edificações com ponto no mapa</b></td><td>Endereço</td><td class="n">${new Set(leads.filter(l => !l.semPonto).map(l => l.edif)).size} de ${new Set(leads.map(l => l.edif)).size}</td></tr></table></div>
  <p class="pq apagado" style="margin-top:10px">Nome, CPF/CNPJ, celular, e-mail e endereço de responsáveis e nome de agentes públicos não são gravados.</p>`;
}
function blocoFid(o) {
  const f = o.status === 'fechado', rv = precisaRevisar(o);
  return `<div class="bloco" id="b-fid"><div class="t">${f ? 'Cliente fechado' : 'Cliente fidelizado'}</div>${o.retorno ? `<div style="font:800 21px var(--display)">Retorno em ${fmtRet(o)}</div>` : ''}<div class="pq apagado">Última visita ${haQuanto(o.ultVisita)} · desde ${fmtData(o.desde)}${o.area ? ' · ' + area(o.area) : ''}${o.re ? ' · RE ' + esc(o.re) : ''}</div>${o.doc ? `<div class="pq apagado">Documento: <span class="mono">${esc(o.doc)}</span></div>` : ''}${rv ? '<div class="pq" style="color:var(--af);margin-top:4px">Na lista de revisão do administrador.</div>' : ''}</div>`;
}
function modalAvisos() {
  modalAvisosBase();
  const ids = st.notifs.filter(n => n.para === st.eu.id).map(n => n.dbid).filter(id => { const t = T.notif.find(x => x.id === id); return t && !t.lida; });
  if (ids.length) sb.from('notificacoes').update({ lida: true }).in('id', ids).then(() => { T.notif.forEach(x => { if (ids.includes(x.id)) x.lida = true; }); pintarTopo(); }, () => {});
}

/* ---------- ponto da edificação ---------- */
function dossieLead(l) { const h = dossieLeadBase(l), i = h.lastIndexOf('</div>'); return h.slice(0, i) + blocoPonto(l) + h.slice(i); }
function blocoPonto(l) {
  const exato = l.prec === 'numero' || l.prec === 'manual', adm = souAdm();
  if (exato && !adm) return '';
  const quem = l.prec === 'manual' && l.pontoPor && conta(l.pontoPor) ? ' por ' + esc(conta(l.pontoPor).nome) + (l.pontoEm ? ' em ' + fmtData(Date.parse(l.pontoEm)) : '') : '';
  const txt = l.semPonto ? 'Esta edificação ainda não tem ponto no mapa: aparece perto do centro da cidade.' : l.prec === 'rua' ? 'O ponto está só na rua, não no número.' : l.prec === 'manual' ? 'Ponto marcado à mão' + quem + '.' : 'Ponto pelo número do endereço.';
  return `<div class="bloco pq" id="b-ponto"><div class="t">Ponto no mapa</div><div>${txt}${exato ? '' : ' Marque o ponto certo: vale para todos e permite comprovar visitas.'}</div>
  <div class="linha" style="margin-top:8px"><button class="btn pq" id="b-ponto-gps" onclick="marcarPontoGPS('${l.id}')">Estou na obra: marcar aqui</button><button class="btn pq" id="b-ponto-mapa" onclick="ajustarPonto('${l.id}')">Marcar no mapa</button></div></div>`;
}
let pinoAjuste = null;
async function salvarPonto(id, lat, lng) {
  const l = achar(id); if (!l) return;
  const { error } = await sb.rpc('marcar_ponto', { p_edif: l.edif, p_lat: lat, p_lng: lng });
  if (error) return toast(error.message);
  const { data } = await sb.from('edificacoes').select(COLS_EDIF).eq('id', l.edif).maybeSingle();
  if (data) BASE.edif.set(data.id, data);
  fimAjuste(); montar(); pintar(); toast('Ponto salvo. Já vale para todos.');
}
async function marcarPontoGPS(id) {
  const b = $('#b-ponto-gps'); if (b) { b.disabled = true; b.textContent = 'Lendo o GPS...'; }
  try { const p = await lerGPS(); await salvarPonto(id, p.lat, p.lng); }
  catch (e) { toast(e.message); if (b) { b.disabled = false; b.textContent = 'Estou na obra: marcar aqui'; } }
}
function ajustarPonto(id) {
  const l = achar(id); if (!l || !mapa) return;
  st.ajuste = { id, lat: l.lat, lng: l.lng };
  if (pinoAjuste) pinoAjuste.remove();
  pinoAjuste = L.marker([l.lat, l.lng], { draggable: true, zIndexOffset: 1000, icon: divi('<div class="obra" style="background:#fff"><span>+</span></div>', 28) }).addTo(mapa);
  pinoAjuste.on('dragend', e => { const p = e.target.getLatLng(); st.ajuste.lat = p.lat; st.ajuste.lng = p.lng; });
  mapa.flyTo([l.lat, l.lng], 17, { duration: .6 });
  let bar = $('#barra-ponto'); if (!bar) { bar = document.createElement('div'); bar.id = 'barra-ponto'; document.body.appendChild(bar); }
  bar.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:calc(86px + env(safe-area-inset-bottom));z-index:60;background:#111;color:#fff;border:1px solid rgba(255,255,255,.25);border-radius:14px;padding:10px 12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;max-width:calc(100vw - 32px);box-shadow:0 8px 30px rgba(0,0,0,.5)';
  bar.innerHTML = `<span class="pq" style="flex:1;min-width:180px">Toque no mapa ou arraste o pino branco até o prédio.</span><button class="btn pq" onclick="fimAjuste()">Cancelar</button><button class="btn pq" style="background:#fff;color:#111" onclick="salvarPonto(st.ajuste.id,st.ajuste.lat,st.ajuste.lng)">Salvar ponto</button>`;
  if ($('#gaveta')) $('#gaveta').hidden = innerWidth <= 820;
}
function fimAjuste() { st.ajuste = null; if (pinoAjuste) { pinoAjuste.remove(); pinoAjuste = null; } const b = $('#barra-ponto'); if (b) b.remove(); if (st.aberto && $('#gaveta')) $('#gaveta').hidden = false; }
function ligarAjuste() {
  if (!mapa || ligarAjuste.ok) return; ligarAjuste.ok = true;
  mapa.on('click', e => { if (!st.ajuste || !pinoAjuste) return; st.ajuste.lat = e.latlng.lat; st.ajuste.lng = e.latlng.lng; pinoAjuste.setLatLng(e.latlng); });
}

/* ---------- login ---------- */
function aparelho() {
  const u = navigator.userAgent, nav = /Edg\//.test(u) ? 'Edge' : /OPR\//.test(u) ? 'Opera' : /Chrome\//.test(u) ? 'Chrome' : /Firefox\//.test(u) ? 'Firefox' : /Safari\//.test(u) ? 'Safari' : 'Navegador';
  const so = /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? 'Android' : /Windows/.test(u) ? 'Windows' : /Mac OS/.test(u) ? 'Mac' : /Linux/.test(u) ? 'Linux' : '';
  return nav + (so ? ' · ' + so : '');
}
function telaLogin(carregando) {
  $('#app').hidden = true; $('#login').hidden = false;
  $('#login').innerHTML = `<div class="cx-login"><div class="faixas"><i style="background:var(--mul)"></i><i style="background:var(--af)"></i><i style="background:var(--pro)"></i></div>
  ${carregando ? `<div class="pilha"><h1>RADAR DE EDIFICAÇÕES</h1><p class="pq" id="carregando">${esc(carregando)}</p></div>` : `<form onsubmit="event.preventDefault();entrar()"><h1>RADAR DE EDIFICAÇÕES</h1>
  ${st.erro ? `<div class="erro" id="erro-login">${esc(st.erro)}</div>` : ''}
  <label class="c">E-mail<input class="inp" id="l-email" type="email" autocomplete="username" required></label>
  <label class="c">Senha<input class="inp" id="l-senha" type="password" autocomplete="current-password" required></label>
  <button class="btn forte" type="submit" id="b-entrar">Entrar</button>
  <p class="pq apagado" style="margin:0">Acesso individual. Entradas, IP e uso são registrados pelo administrador. Esqueceu a senha? Fale com o administrador.</p></form>`}</div>`;
}
async function entrar() {
  const email = $('#l-email').value.trim().toLowerCase(), senha = $('#l-senha').value, b = $('#b-entrar');
  if (b) { b.disabled = true; b.textContent = 'Entrando...'; }
  const { error } = await sb.auth.signInWithPassword({ email, password: senha });
  if (error) { st.erro = /confirm/i.test(error.message) ? 'Conta ainda não confirmada. Fale com o administrador.' : 'E-mail ou senha incorretos.'; return telaLogin(); }
  st.erro = ''; await iniciarSessao(true);
}
async function iniciarSessao(abriu) {
  const { data: { session } } = await sb.auth.getSession(); if (!session) return telaLogin();
  const { data: p, error } = await sb.from('perfis').select('*').eq('id', session.user.id).maybeSingle();
  if (error || !p || p.bloqueado) { await sb.auth.signOut(); st.erro = p && p.bloqueado ? 'Esta conta está bloqueada. Fale com o administrador.' : 'Conta sem acesso. Fale com o administrador.'; return telaLogin(); }
  st.eu = { id: p.id, nome: p.nome, l: p.letra, cor: p.cor, papel: p.papel, bloq: false };
  telaLogin('Carregando as edificações...');
  try { await carregarBase(); await carregarTrabalho(); }
  catch (e) { console.error(e); st.eu = null; st.erro = 'Não consegui carregar os dados. Confira a internet e tente de novo.'; return telaLogin(); }
  sb.rpc('registrar_acesso', { p_aparelho: aparelho(), p_abriu: !!abriu }).then(() => {}, () => {});
  st.quemCart = souAdm() ? (vendedores()[0] || st.eu).id : st.eu.id; st.vista = 'radar'; st.aberto = null; st.opFechada = new Set(); st.opN = {};
  limparFiltros(); $('#login').hidden = true; $('#app').hidden = false; iniciarMapa(); ligarAjuste(); enquadrar(); pintar(); ligarTempoReal();
}
async function sair() {
  st.eu = null; st.rota = []; st.marcando = null; st.perto = null; fecharModal();
  if (ligarTempoReal.c) { sb.removeChannel(ligarTempoReal.c); ligarTempoReal.c = null; }
  await sb.auth.signOut(); telaLogin();
}
function ligarTempoReal() {
  if (ligarTempoReal.c) return;
  const ch = sb.channel('radar');
  ['posses', 'negociacoes', 'visitas', 'pedidos'].forEach(t => ch.on('postgres_changes', { event: '*', schema: 'public', table: t }, agendar));
  ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notificacoes', filter: 'para=eq.' + st.eu.id }, () => { if (st.som) ding(); agendar(); });
  ligarTempoReal.c = ch.subscribe();
  if (!ligarTempoReal.i) {
    ligarTempoReal.i = setInterval(() => { if (st.eu && document.visibilityState === 'visible') sb.rpc('registrar_acesso', { p_aparelho: aparelho(), p_abriu: false }).then(() => {}, () => {}); }, 5 * MIN);
    setInterval(() => { if (st.eu && document.visibilityState === 'visible') recarregar(); }, 4 * MIN);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && st.eu) recarregar(); });
  }
}
sb.auth.onAuthStateChange(ev => { if (ev === 'SIGNED_OUT' && st.eu) { st.eu = null; telaLogin(); } });

(async function iniciar() {
  telaLogin('Abrindo...');
  const { data: { session } } = await sb.auth.getSession();
  if (session) await iniciarSessao(true); else telaLogin();
})();
