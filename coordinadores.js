// coordinadores.js — FINAL con bloqueo por confirmación y guardado por fila

import { app, db } from './firebase-init.js';
import {
  collection, getDocs, addDoc, doc, updateDoc, setDoc, deleteDoc,
  query, where, getDoc, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

// ------------------ Estado ------------------
let COORDS = []; // {id, nombre, rut, telefono, correo, disponibilidad:[{inicio,fin}], activo, notas, _isNew?}
let GRUPOS = [];
let SETS   = [];
let ID2GRUPO = new Map();

const FILTER = { destino:'', programa:'', desde:'', hasta:'', tokens:[] };

let swapMode  = false;
let swapFirst = null;

// ------------------ Fechas ------------------
const toISO = d => (new Date(d)).toISOString().slice(0,10);
const addDaysISO = (iso, n) => { const D=new Date(iso+'T00:00:00'); D.setDate(D.getDate()+n); return toISO(D); };
function asISO(v){
  if (!v) return null;
  if (typeof v === 'string'){ const d = new Date(v); return isNaN(d) ? null : toISO(d); }
  if (v?.toDate)  return toISO(v.toDate());
  if (v?.seconds) return toISO(new Date(v.seconds*1000));
  if (v instanceof Date) return toISO(v);
  return null;
}
const cmpISO = (a,b)=> (new Date(a)-new Date(b));
const overlap = (a1,a2,b1,b2)=>!(new Date(a2)<new Date(b1)||new Date(b2)<new Date(a1));
const inAnyRange = (ini,fin,ranges=[]) => (ranges||[]).some(r=> new Date(ini)>=new Date(r.inicio) && new Date(fin)<=new Date(r.fin));
function gapDays(finA, iniB){ const A=new Date(finA+'T00:00:00'); const B=new Date(iniB+'T00:00:00'); return Math.round((B-A)/86400000)-1; }
function fmtDMY(iso){ if(!iso) return ''; const [y,m,d]=iso.split('-'); return `${d}-${m}-${y}`; }

// ------------------ Carga ------------------
async function loadCoordinadores(){
  COORDS = [];
  const snap = await getDocs(collection(db,'coordinadores'));
  snap.forEach(d=>{
    const x=d.data();
    const disp = Array.isArray(x.disponibilidad) ? x.disponibilidad
               : Array.isArray(x.fechasDisponibles) ? x.fechasDisponibles : [];
    const disponibilidad = (disp||[])
      .map(r=>({inicio:asISO(r.inicio)||null, fin:asISO(r.fin)||null}))
      .filter(r=>r.inicio&&r.fin&&(new Date(r.inicio)<=new Date(r.fin)));
    COORDS.push({
      id:d.id,
      nombre:(x.nombre||'').trim(),
      rut:(x.rut||'').trim(),
      telefono:(x.telefono||'').trim(),
      correo:(x.correo||'').trim().toLowerCase(),
      disponibilidad,
      activo:(x.activo!==false),
      notas:(x.notas||'').trim()
    });
  });
}
async function loadGrupos(){
  GRUPOS=[]; ID2GRUPO.clear();
  const snap = await getDocs(collection(db,'grupos'));
  snap.forEach(d=>{
    const x=d.data(); x.id=d.id;
    x.numeroNegocio = x.numeroNegocio || d.id;
    x.aliasGrupo    = x.aliasGrupo || limpiarAlias(x.nombreGrupo||'');
    const {ini,fin} = normalizarFechasGrupo(x);
    if (!ini||!fin) return;
    const g = {
      ...x,
      fechaInicio:ini, fechaFin:fin,
      identificador: x.identificador || x.identificadorGrupo || x.codigoGrupo || x.codigo || '',
      programa: x.programa || x.nombrePrograma || x.programaNombre || '',
      destino:  x.destino  || x.destinoPrincipal || x.ciudadDestino || x.ciudad || x.paisDestino || ''
    };
    GRUPOS.push(g); ID2GRUPO.set(g.id,g);
  });
  GRUPOS.sort((a,b)=> cmpISO(a.fechaInicio,b.fechaInicio));
}
async function loadSets(){
  SETS=[];
  const snap=await getDocs(collection(db,'conjuntosCoordinadores'));
  snap.forEach(d=>{ const x=d.data(); x.id=d.id; x.viajes||=[]; x.confirmado=!!x.confirmado; SETS.push(x); });
  SETS.forEach(s=> s.viajes = s.viajes.filter(id=>ID2GRUPO.has(id)));
  evaluarAlertas();
  sortSetsInPlace();
  populateFilterOptions();
}

// ------------------ DOM ------------------
const $ = s=>document.querySelector(s);
const elWrapLibres = $('#lista-viajes-libres');
const elWrapSets   = $('#conjuntos-wrap');
const elMsg        = $('#msg');

const selDestino = $('#f-destino');
const selPrograma= $('#f-programa');
const inpDesde   = $('#f-desde');
const inpHasta   = $('#f-hasta');
const inpBuscar  = $('#f-buscar');
const wrapResumen= $('#resumen-wrap');
const wrapStats  = $('#stats-viajes-wrap');

// Modal
const mb               = $('#mb');
const modal            = $('#modal-coords');
const btnOpenModal     = $('#btn-modal-coords');
const btnCloseModal    = $('#close-modal');
const btnCerrar        = $('#btn-cerrar');
const btnGuardarCoords = $('#btn-guardar-coords');
const btnAddCoord      = $('#btn-add-coord');
const btnAddLote       = $('#btn-add-lote');
const inputExcel       = $('#input-excel');
const tbodyCoords      = $('#tabla-coords tbody');
const hintEmptyCoords  = $('#hint-empty-coords');

// Toolbar
$('#btn-sugerir').onclick = sugerirConjuntos;
$('#btn-nuevo-conjunto').onclick = ()=>{
  SETS.unshift({viajes:[], coordinadorId:null, confirmado:false, alertas:[], _isNew:true});
  render();
};
$('#btn-guardar').onclick = ()=>withBusy($('#btn-guardar'), 'Guardando…', guardarTodo, 'Guardar cambios', '✅ Guardado');

// Modal handlers
btnOpenModal.onclick  = ()=>{ openModal(); renderCoordsTable(); };
btnCloseModal.onclick = closeModal;
btnCerrar.onclick     = closeModal;
btnGuardarCoords.onclick = ()=>withBusy(btnGuardarCoords, 'Guardando…', saveCoordsModal, 'Guardar coordinadores', '✅ Guardado');
btnAddCoord.onclick = ()=>{
  COORDS.unshift({nombre:'', rut:'', telefono:'', correo:'', disponibilidad:[], _isNew:true});
  renderCoordsTable(); setTimeout(initPickers,10);
};
btnAddLote.onclick = ()=> inputExcel.click();
inputExcel.onchange = handleExcel;

// Lee un Excel y agrega/actualiza coordinadores en COORDS
function handleExcel(evt){
  const file = evt.target.files?.[0];
  if(!file) return;

  const reader = new FileReader();
  reader.onload = (e)=>{
    try{
      const wb = XLSX.read(e.target.result, { type:'binary' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval:'', raw:false, blankrows:false });

      // índices para evitar duplicados
      const byName = new Map(COORDS.map(c => [ (c.nombre||'').trim().toUpperCase(), c ]));
      const byRut  = new Map(COORDS.filter(c=>c.rut).map(c => [ c.rut.replace(/\s+/g,'').toUpperCase(), c ]));

      for(const r of rows){
        const nombre = (r.Nombre || r.NOMBRE || r.nombre || '').toString().trim();
        if(!nombre) continue;

        const rut      = (r.RUT || r.rut || '').toString().replace(/\s+/g,'').toUpperCase();
        const telefono = (r.TELEFONO || r['TELÉFONO'] || r.tel || r.Tel || r.telefono || '').toString().trim();
        const correo   = (r.Correo || r.CORREO || r.Email || r.EMAIL || r.email || '').toString().trim().toLowerCase();

        // busca por RUT o por nombre
        let c = (rut && byRut.get(rut)) || byName.get(nombre.toUpperCase());
        if (c){
          c.nombre   = nombre;
          c.rut      = rut;
          c.telefono = telefono;
          c.correo   = correo;
        } else {
          c = { nombre, rut, telefono, correo, disponibilidad:[], _isNew:true };
          COORDS.unshift(c);            // se agrega arriba como pediste
          byName.set(nombre.toUpperCase(), c);
          if (rut) byRut.set(rut, c);
        }
      }

      renderCoordsTable();
      setTimeout(initPickers,10);
    } catch (err){
      console.error(err);
      alert('No se pudo leer el Excel. Asegúrate de que sea .xlsx/.xls y que tenga la columna "Nombre".');
    } finally {
      evt.target.value = '';   // limpia el input para permitir recargar
    }
  };
  reader.readAsBinaryString(file);
}

// ------------------ Helpers ------------------
function withBusy(btn, busyText, fn, normalText, okText){
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = busyText;
  Promise.resolve(fn()).then(()=>{
    btn.textContent = okText || 'Listo';
    setTimeout(()=>{ btn.textContent = normalText || prev; btn.disabled=false; }, 900);
  }).catch(err=>{
    console.error(err);
    btn.textContent = '❌ Error';
    setTimeout(()=>{ btn.textContent = normalText || prev; btn.disabled=false; }, 1500);
    alert('Ocurrió un error. Revisa la consola.');
  });
}

function normalizarFechasGrupo(x){
  let ini=asISO(x.fechaInicio||x.fecha_inicio||x.inicio||x.fecha||x.fechaDeViaje||x.fechaViaje||x.fechaInicioViaje);
  let fin=asISO(x.fechaFin   ||x.fecha_fin   ||x.fin   ||x.fechaFinal   ||x.fechaFinViaje);
  if ((!ini||!fin) && x.itinerario && typeof x.itinerario==='object'){
    const ks=Object.keys(x.itinerario).filter(k=>/^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
    if (ks.length){ ini=ini||ks[0]; fin=fin||ks[ks.length-1]; }
  }
  if (ini && !fin && (x.duracion||x.noches)){ const days=Number(x.duracion)||(Number(x.noches)+1)||1; fin=addDaysISO(ini,days-1); }
  if (ini && !fin) fin=ini; if (fin && !ini) ini=fin; return {ini,fin};
}
function sortSetsInPlace(){
  const news = SETS.filter(s=>s._isNew);
  const olds = SETS.filter(s=>!s._isNew);
  olds.sort((A,B)=>{
    const nA=A.viajes?.length||0, nB=B.viajes?.length||0;
    if (nA!==nB) return nB-nA;
    const fA=firstStartISO(A)||'9999-12-31', fB=firstStartISO(B)||'9999-12-31';
    return cmpISO(fA,fB);
  });
  SETS.length=0; SETS.push(...news,...olds);
}
function firstStartISO(s){
  const viajes=(s.viajes||[]).map(id=>ID2GRUPO.get(id)).filter(Boolean).sort((a,b)=>cmpISO(a.fechaInicio,b.fechaInicio));
  return viajes[0]?.fechaInicio || null;
}
function norm(s){ return (s??'').toString().trim().toLowerCase(); }
function parseTokens(s){ return (s||'').split(',').map(t=>norm(t)).filter(Boolean); }
function populateFilterOptions(){
  const dests=[...new Set(GRUPOS.map(g=>g.destino).filter(Boolean))].sort();
  const progs=[...new Set(GRUPOS.map(g=>g.programa).filter(Boolean))].sort();
  selDestino.innerHTML = `<option value="">Todos los destinos</option>` + dests.map(d=>`<option>${escapeHtml(d)}</option>`).join('');
  selPrograma.innerHTML= `<option value="">Todos los programas</option>` + progs.map(p=>`<option>${escapeHtml(p)}</option>`).join('');
  selDestino.onchange = ()=>{ FILTER.destino=selDestino.value; render(); };
  selPrograma.onchange= ()=>{ FILTER.programa=selPrograma.value; render(); };
  inpDesde.onchange   = ()=>{ FILTER.desde = inpDesde.value||''; render(); };
  inpHasta.onchange   = ()=>{ FILTER.hasta = inpHasta.value||''; render(); };
  inpBuscar.oninput   = ()=>{ FILTER.tokens = parseTokens(inpBuscar.value); render(); };
}
function gruposFiltrados(arr=GRUPOS){
  return arr.filter(g=>{
    if (FILTER.destino && !norm(g.destino).includes(norm(FILTER.destino))) return false;
    if (FILTER.programa && !norm(g.programa).includes(norm(FILTER.programa))) return false;
    if (FILTER.desde && g.fechaInicio < FILTER.desde) return false;
    if (FILTER.hasta && g.fechaInicio > FILTER.hasta) return false;
    if (FILTER.tokens?.length){
      const hay=[g.aliasGrupo,g.nombreGrupo,g.numeroNegocio,g.identificador,g.programa,g.destino].map(norm);
      if (!FILTER.tokens.every(tok=>hay.some(h=>h && h.includes(tok)))) return false;
    }
    return true;
  });
}

// -------- BLOQUEO por confirmación --------
function getBlockedCoordIds(exceptSetIdx = null){
  const blocked = new Set();
  SETS.forEach((s, idx)=>{
    if (s.confirmado && s.coordinadorId){
      if (exceptSetIdx !== null && idx === exceptSetIdx) return;
      blocked.add(s.coordinadorId);
    }
  });
  return blocked;
}

// ------------------ Render ------------------
function render(){
  sortSetsInPlace();
  renderResumen();
  renderLibres();
  renderSets();
  renderViajesStats();
  elMsg.textContent='';
}

function renderResumen(){
  const arr=gruposFiltrados(GRUPOS);
  const by=(fn)=>arr.reduce((m,g)=>{ const k=fn(g)||'(sin dato)'; m[k]=(m[k]||0)+1; return m; },{});
  const tDest=by(g=>g.destino);
  const tProg=by(g=>g.programa);
  const tIniISO=by(g=>g.fechaInicio);
  const tIniDMY={}; Object.entries(tIniISO).forEach(([iso,c])=>{ tIniDMY[fmtDMY(iso)]=c; });

  const mk=(title,obj)=>`
    <div class="panel" style="min-width:260px">
      <div class="hd">${title}</div>
      <div class="bd">
        ${Object.keys(obj).length?`
        <table><thead><tr><th>Clave</th><th style="width:72px">Total</th></tr></thead>
        <tbody>${Object.entries(obj).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`<tr><td>${escapeHtml(k)}</td><td>${v}</td></tr>`).join('')}</tbody></table>
        `:`<div class="empty">Sin datos.</div>`}
      </div>
    </div>`;
  $('#resumen-wrap').innerHTML=`
    <div class="row" style="gap:.8rem; align-items:flex-start; flex-wrap:wrap;">
      ${mk('Por destino',tDest)}
      ${mk('Por fecha de inicio',tIniDMY)}
      ${mk('Por programa',tProg)}
    </div>`;
}

function viajesUsadosSetIds(){ const s=new Set(); SETS.forEach(x=>x.viajes.forEach(id=>s.add(id))); return s; }

function renderLibres(){
  const usados=viajesUsadosSetIds();
  const libresAll=GRUPOS.filter(g=>!usados.has(g.id));
  const libres=gruposFiltrados(libresAll);
  if (!libres.length){ elWrapLibres.innerHTML='<div class="empty">No hay viajes libres.</div>'; return; }
  elWrapLibres.innerHTML=libres.map(g=>`
    <div class="card">
      <div class="hd">
        <div><b title="${escapeHtml(g.nombreGrupo||'')}">${g.aliasGrupo||'(sin alias)'}</b> <span class="muted">#${g.numeroNegocio}</span></div>
        <button class="btn small" data-add="${g.id}">Agregar a viaje…</button>
      </div>
      <div class="bd">
        <div class="muted">${fmtDMY(g.fechaInicio)} a ${fmtDMY(g.fechaFin)}</div>
        <div class="muted">${g.identificador?`ID: ${escapeHtml(g.identificador)} · `:''}${g.programa?`Prog: ${escapeHtml(g.programa)} · `:''}${g.destino?`Dest: ${escapeHtml(g.destino)}`:''}</div>
      </div>
    </div>`).join('');
  elWrapLibres.querySelectorAll('button[data-add]').forEach(b=> b.onclick=()=>seleccionarConjuntoDestino(b.dataset.add));
}

function renderSets(){
  if (!SETS.length){ elWrapSets.innerHTML='<div class="empty">Sin viajes asignados.</div>'; return; }
  elWrapSets.innerHTML='';
  SETS.forEach((s,idx)=>{
    const viajes=s.viajes.map(id=>ID2GRUPO.get(id)).filter(Boolean);
    const rows=viajes.map(v=>`
      <tr>
        <td style="width:36%"><input type="text" data-alias="${v.id}" value="${v.aliasGrupo||''}" title="${escapeHtml(v.nombreGrupo||'')}"></td>
        <td style="width:24%">${fmtDMY(v.fechaInicio)} → ${fmtDMY(v.fechaFin)}</td>
        <td style="width:40%">
          <div class="muted">#${v.numeroNegocio}</div>
          ${v.identificador?`<div class="muted">ID: ${escapeHtml(v.identificador)}</div>`:''}
          ${v.programa?`<div class="muted">Programa: ${escapeHtml(v.programa)}</div>`:''}
          ${v.destino?`<div class="muted">Destino: ${escapeHtml(v.destino)}</div>`:''}
        </td>
      </tr>
      <tr><td colspan="3">
        <div class="row">
          <button class="btn small" data-swap="${v.id}" data-set="${idx}">Swap</button>
          <button class="btn small" data-move="${v.id}" data-set="${idx}">Mover…</button>
          <button class="btn small" data-del="${v.id}" data-set="${idx}">Quitar</button>
        </div>
      </td></tr>
    `).join('');

    // BLOQUEO: excluye confirmados de otros grupos
    const blocked = getBlockedCoordIds(idx);
    const opts=['<option value="">(Seleccionar)</option>'].concat(
      COORDS
        .slice()
        .sort((a,b)=>(a.nombre||'').localeCompare(b.nombre||'','es',{sensitivity:'base'}))
        .filter(c => !blocked.has(c.id) || c.id===s.coordinadorId)
        .map(c=>`<option value="${c.id}" ${s.coordinadorId===c.id?'selected':''}>${escapeHtml(c.nombre||'(sin nombre)')}</option>`)
    ).join('');

    const alertas=s.alertas||[];
    const alertHtml = alertas.length
      ? `<div>${alertas.map(a=>`<div class="${a.tipo==='err'?'err':'warn'}">• ${a.msg}</div>`).join('')}</div>`
      : '<div class="muted">Sin alertas.</div>';

    elWrapSets.insertAdjacentHTML('beforeend',`
      <div class="card">
        <div class="hd">
          <div class="row">
            <span class="tag">Viajes ${idx+1}</span>
            ${s._isNew?'<span class="pill">Nuevo</span>':''}
            ${s.confirmado?'<span class="pill">Confirmado</span>':''}
          </div>
          <div class="row">
            <select data-coord="${idx}" title="Coordinador del viaje">${opts}</select>
            <button class="btn small" data-addv="${idx}">Agregar viaje</button>
            <button class="btn small" data-sugerirc="${idx}">Sugerir coord</button>
            <button class="btn small ${s.confirmado?'secondary':''}" data-confirm="${idx}">${s.confirmado?'Desconfirmar':'Confirmar'}</button>
            <button class="btn small" data-delset="${idx}">Eliminar</button>
          </div>
        </div>
        <div class="bd">
          ${viajes.length?`
            <table>
              <thead><tr><th>Alias</th><th>Fechas</th><th>Info</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>`:`<div class="empty">Sin viajes en este grupo.</div>`}
          <div style="margin-top:.5rem">${alertHtml}</div>
        </div>
      </div>`);
  });

  // Handlers
  elWrapSets.querySelectorAll('input[data-alias]').forEach(inp=>{
    inp.onchange=()=>{ const g=ID2GRUPO.get(inp.dataset.alias); if(g){ g.aliasGrupo=inp.value; } };
  });
  elWrapSets.querySelectorAll('button[data-del]').forEach(btn=>{
    btn.onclick=()=>{ const i=+btn.dataset.set; SETS[i].viajes = SETS[i].viajes.filter(id=>id!==btn.dataset.del); evaluarAlertas(); render(); };
  });
  elWrapSets.querySelectorAll('button[data-move]').forEach(btn=>{
    btn.onclick=()=>{ const i=+btn.dataset.set; moverViajeAotroConjunto(btn.dataset.move,i); };
  });
  elWrapSets.querySelectorAll('button[data-addv]').forEach(btn=>{
    btn.onclick=()=>agregarViajeAConjunto(+btn.dataset.addv);
  });
  elWrapSets.querySelectorAll('button[data-delset]').forEach(btn=>{
    btn.onclick=()=>{ const i=+btn.dataset.delset; if(!confirm('¿Eliminar este grupo de viajes?'))return; SETS.splice(i,1); evaluarAlertas(); render(); };
  });
  elWrapSets.querySelectorAll('button[data-sugerirc]').forEach(btn=>{
    btn.onclick=()=>sugerirCoordinador(+btn.dataset.sugerirc);
  });
  elWrapSets.querySelectorAll('button[data-confirm]').forEach(btn=>{
    btn.onclick=()=>{ const i=+btn.dataset.confirm; SETS[i].confirmado=!SETS[i].confirmado; render(); };
  });
  elWrapSets.querySelectorAll('select[data-coord]').forEach(sel=>{
    sel.onchange=()=>{ const i=+sel.dataset.coord; SETS[i].coordinadorId = sel.value||null; evaluarAlertas(); render(); };
  });

  elWrapSets.querySelectorAll('button[data-swap]').forEach(btn=>{
    btn.onclick=()=>{ const setIdx=+btn.dataset.set; const gid=btn.dataset.swap; handleSwapClick(setIdx,gid,btn); };
  });

  document.body.addEventListener('click', e=>{
    if (!e.target.closest('button[data-swap]')){
      swapMode=false; swapFirst=null;
      elWrapSets.querySelectorAll('button[data-swap].selected-swap').forEach(b=>b.classList.remove('selected-swap'));
    }
  }, true);
}

// ------------------ Sugeridor ------------------
// Recalcula solo para los viajes NO confirmados y conserva los confirmados tal cual
function sugerirConjuntos(){
  // 1) Fijar los sets confirmados CON coordinador (se mantienen)
  const fixedSets = SETS.filter(s => s.confirmado && !!s.coordinadorId);

  // IDs de viajes ya fijados
  const fixedTripIds = new Set();
  fixedSets.forEach(s => (s.viajes||[]).forEach(id => fixedTripIds.add(id)));

  // 2) Pool de viajes a re-calcular: todos los que NO están en sets confirmados
  const pool = GRUPOS
    .filter(g => !fixedTripIds.has(g.id))
    .sort((a,b) => cmpISO(a.fechaInicio, b.fechaInicio));

  // 3) Greedy igual que antes, pero SOLO con el pool
  const work = []; // [{viajes:[], lastFin:'YYYY-MM-DD', zeroChain:0}]
  for (const g of pool){
    let best = -1;
    let bestAvail = null;
    for (let i=0;i<work.length;i++){
      const s = work[i];
      const gap = gapDays(s.lastFin, g.fechaInicio);
      const ok = (gap >= 1) || (gap === 0 && s.zeroChain < 2);
      if (!ok) continue;
      const avail = addDaysISO(s.lastFin, 1);
      if (best===-1 || cmpISO(avail, bestAvail) < 0){ best = i; bestAvail = avail; }
    }
    if (best === -1){
      work.push({ viajes:[g.id], lastFin:g.fechaFin, zeroChain:0 });
    } else {
      const s = work[best];
      const gap = gapDays(s.lastFin, g.fechaInicio);
      s.viajes.push(g.id);
      s.zeroChain = (gap === 0) ? s.zeroChain + 1 : 0;
      s.lastFin = g.fechaFin;
    }
  }

  // 4) Volcar sugerencias (borradores) + conservar confirmados
  const suggested = work.map(() => ({ viajes:[], coordinadorId:null, confirmado:false, alertas:[], _isNew:true }));
  for (let i=0;i<work.length;i++){ suggested[i].viajes = work[i].viajes.slice(); }

  // La UI trabajará con: confirmados tal cual + nuevas sugerencias
  SETS = fixedSets.concat(suggested);

  evaluarAlertas();
  sortSetsInPlace();
  render();
}

// ------------------ Alertas / Consistencia ------------------
function evaluarAlertas(){
  SETS.forEach(s=> s.alertas=[]);
  SETS.forEach(s=>{
    const viajes=s.viajes.map(id=>ID2GRUPO.get(id)).filter(Boolean).sort((a,b)=>cmpISO(a.fechaInicio,b.fechaInicio));
    s.viajes=viajes.map(v=>v.id);
    let consec=0;
    for (let i=0;i<viajes.length-1;i++){
      const A=viajes[i], B=viajes[i+1];
      if (overlap(A.fechaInicio,A.fechaFin,B.fechaInicio,B.fechaFin)) s.alertas.push({tipo:'err', msg:`Solape entre ${A.aliasGrupo||A.nombreGrupo} y ${B.aliasGrupo||B.nombreGrupo}`});
      const gap=gapDays(A.fechaFin,B.fechaInicio);
      if (gap<0) s.alertas.push({tipo:'err', msg:`Orden inconsistente entre ${A.aliasGrupo||A.nombreGrupo} y ${B.aliasGrupo||B.nombreGrupo}`});
      else if (gap===0) consec++; else consec=0;
      if (consec>=2) s.alertas.push({tipo:'warn', msg:`3 viajes seguidos sin día de descanso`});
    }
    if (s.coordinadorId){
      const c=COORDS.find(x=>x.id===s.coordinadorId);
      if (c){ viajes.forEach(v=>{ if (!inAnyRange(v.fechaInicio,v.fechaFin,c.disponibilidad||[])) s.alertas.push({tipo:'warn', msg:`Coordinador fuera de disponibilidad en ${v.aliasGrupo||v.nombreGrupo}`}); }); }
    }
  });
  for (let i=0;i<SETS.length;i++){
    for (let j=i+1;j<SETS.length;j++){
      const A=SETS[i], B=SETS[j]; if (!A.coordinadorId || A.coordinadorId!==B.coordinadorId) continue;
      const va=A.viajes.map(id=>ID2GRUPO.get(id)).filter(Boolean);
      const vb=B.viajes.map(id=>ID2GRUPO.get(id)).filter(Boolean);
      const pisado=va.some(a=>vb.some(b=>overlap(a.fechaInicio,a.fechaFin,b.fechaInicio,b.fechaFin)));
      if (pisado){
        const name=(COORDS.find(c=>c.id===A.coordinadorId)?.nombre)||'(coordinador)';
        A.alertas.push({tipo:'err', msg:`${name} también asignado en Viajes ${j+1} con fechas que se cruzan`});
        B.alertas.push({tipo:'err', msg:`${name} también asignado en Viajes ${i+1} con fechas que se cruzan`});
      }
    }
  }
}

// ------------------ Acciones viajes ------------------
function seleccionarConjuntoDestino(grupoId){
  if (!SETS.length){ alert('Primero crea un grupo de viajes.'); return; }
  const n=prompt(`¿A qué grupo mover este viaje? (1..${SETS.length})`); if (!n) return;
  const idx=(+n)-1; if (idx<0||idx>=SETS.length){ alert('Número inválido'); return; }
  if (SETS.some(s=>s.viajes.includes(grupoId))) SETS.forEach(s=> s.viajes=s.viajes.filter(id=>id!==grupoId));
  SETS[idx].viajes.push(grupoId); evaluarAlertas(); render();
}
function moverViajeAotroConjunto(grupoId, desdeIdx){
  if (SETS.length<=1){ alert('No hay otro grupo.'); return; }
  const n=prompt(`Mover al grupo (1..${SETS.length}, distinto de ${desdeIdx+1})`); if(!n) return;
  const to=(+n)-1; if(to===desdeIdx||to<0||to>=SETS.length){ alert('Número inválido'); return; }
  SETS[desdeIdx].viajes = SETS[desdeIdx].viajes.filter(id=>id!==grupoId);
  SETS[to].viajes.push(grupoId); evaluarAlertas(); render();
}
function agregarViajeAConjunto(setIdx){
  const usados=viajesUsadosSetIds();
  const libresAll=GRUPOS.filter(g=>!usados.has(g.id));
  const libres=gruposFiltrados(libresAll);
  if (!libres.length){ alert('No quedan viajes libres con los filtros actuales.'); return; }
  const listado=libres.map((g,i)=>`${i+1}) ${g.aliasGrupo||g.nombreGrupo} [${fmtDMY(g.fechaInicio)}→${fmtDMY(g.fechaFin)}] • #${g.numeroNegocio} • ${g.programa||''} • ${g.destino||''}`).join('\n');
  const n=prompt(`Selecciona # de viaje a agregar (filtrado):\n${listado}`); if(!n) return;
  const i=(+n)-1; if(i<0||i>=libres.length) return;
  SETS[setIdx].viajes.push(libres[i].id); evaluarAlertas(); render();
}
function handleSwapClick(setIdx, grupoId, btn){
  if (!swapMode){ swapMode=true; swapFirst={setIdx,grupoId}; elWrapSets.querySelectorAll('button[data-swap].selected-swap').forEach(b=>b.classList.remove('selected-swap')); btn.classList.add('selected-swap'); return; }
  if (swapFirst && (swapFirst.setIdx!==setIdx || swapFirst.grupoId!==grupoId)) swapBetweenSets(swapFirst,{setIdx,grupoId});
  swapMode=false; swapFirst=null; elWrapSets.querySelectorAll('button[data-swap].selected-swap').forEach(b=>b.classList.remove('selected-swap'));
}
function swapBetweenSets(a,b){
  SETS[a.setIdx].viajes=SETS[a.setIdx].viajes.filter(id=>id!==a.grupoId);
  SETS[b.setIdx].viajes=SETS[b.setIdx].viajes.filter(id=>id!==b.grupoId);
  SETS[a.setIdx].viajes.push(b.grupoId);
  SETS[b.setIdx].viajes.push(a.grupoId);
  evaluarAlertas(); render();
}

// Sugerir coordinador para un grupo (filtra bloqueados)
function sugerirCoordinador(setIdx){
  const s=SETS[setIdx];
  const viajes=s.viajes.map(id=>ID2GRUPO.get(id)).filter(Boolean);
  const blocked = getBlockedCoordIds(setIdx);
  const ok=COORDS.filter(c =>
    !blocked.has(c.id) &&
    viajes.every(v => inAnyRange(v.fechaInicio, v.fechaFin, c.disponibilidad||[]))
  );
  if (!ok.length){ alert('No hay coordinadores disponibles que cubran todo el grupo.'); return; }
  s.coordinadorId = ok[0].id;
  evaluarAlertas(); render();
}

// ------------------ Guardado / IDs ------------------
function slugNombre(nombre){
  return (nombre||'')
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80) || 'coord';
}
async function findCoordId({rut, nombre}) {
  if (rut){ const q1=query(collection(db,'coordinadores'), where('rut','==',rut)); const s1=await getDocs(q1); if(!s1.empty) return s1.docs[0].id; }
  if (nombre){ const q2=query(collection(db,'coordinadores'), where('nombre','==',nombre)); const s2=await getDocs(q2); if(!s2.empty) return s2.docs[0].id; }
  return null;
}
function cleanRanges(arr){
  return (arr||[])
    .map(r=>({ inicio: asISO(r.inicio)||asISO(r.inicioRaw)||null, fin: asISO(r.fin)||asISO(r.finRaw)||null }))
    .filter(r=>r.inicio && r.fin && (new Date(r.inicio)<=new Date(r.fin)));
}

// Guardar UNA fila (botón 💾 de la fila)
async function saveOneCoord(i){
  const c = COORDS[i];
  const nombre=(c.nombre||'').trim();
  if (!nombre){ alert('Debe indicar nombre.'); return; }
  const payload={
    nombre,
    rut:(c.rut||'').replace(/\s+/g,'').toUpperCase(),
    telefono:(c.telefono||'').trim(),
    correo:(c.correo||'').trim().toLowerCase(),
    disponibilidad: cleanRanges(c.disponibilidad),
    activo:(c.activo!==false),
    notas:(c.notas||'').trim(),
    'meta.actualizadoEn': serverTimestamp()
  };
  let id = c.id || await findCoordId({ rut: payload.rut, nombre: payload.nombre });
  if (!id){
    const wanted=slugNombre(payload.nombre);
    const exists=await getDoc(doc(db,'coordinadores', wanted));
    id = exists.exists()? `${wanted}-${Date.now().toString(36).slice(-4)}` : wanted;
  }
  await setDoc(doc(db,'coordinadores', id), {...payload, meta:{ creadoEn: serverTimestamp() }}, { merge:true });
  c.id=id; delete c._isNew;
}

// Guardar todas las filas del modal
async function saveCoordsModal(){
  for (let i=0;i<COORDS.length;i++){
    const c=COORDS[i];
    if (!c.nombre || !c.nombre.trim()) continue;
    await saveOneCoord(i);
  }
  await loadCoordinadores();
  closeModal(); evaluarAlertas(); render();
}

// ------------------ Estadísticas ------------------
function computeViajesStats(){
  const sizes = SETS.map(s => s.viajes?.length || 0);
  const totalGrupos = sizes.length;
  const totalTramos = sizes.reduce((a,b)=>a+b,0);
  const dist = {}; sizes.forEach(n => { dist[n] = (dist[n]||0) + 1; });

  let paresSinDescanso = 0,
      gruposConGap0   = 0,
      paresSolapados  = 0,
      paresOrdenMalo  = 0,
      gruposTodosDescanso = 0;

  let totalErr = 0, totalWarn = 0, confirmados = 0, conCoordinador = 0;
  const coordsAsignados = new Set();

  for (const s of SETS){
    const viajes = (s.viajes||[])
      .map(id => ID2GRUPO.get(id)).filter(Boolean)
      .sort((a,b)=>cmpISO(a.fechaInicio,b.fechaInicio));

    if (s.confirmado) confirmados++;
    if (s.coordinadorId){ conCoordinador++; coordsAsignados.add(s.coordinadorId); }
    (s.alertas||[]).forEach(a => (a.tipo==='err' ? totalErr++ : totalWarn++));

    let tuvo0 = false;
    let todosOK = true;

    for (let i=0;i<viajes.length-1;i++){
      const A = viajes[i], B = viajes[i+1];
      const gap = gapDays(A.fechaFin, B.fechaInicio);
      if (gap < 0) paresOrdenMalo++;
      if (gap === 0){ paresSinDescanso++; tuvo0 = true; }
      if (gap < 1) todosOK = false;
      if (overlap(A.fechaInicio,A.fechaFin,B.fechaInicio,B.fechaFin)) paresSolapados++;
    }

    if (tuvo0) gruposConGap0++;
    if (viajes.length >= 2 && todosOK) gruposTodosDescanso++;
  }

  const min = sizes.length ? Math.min(...sizes) : 0;
  const max = sizes.length ? Math.max(...sizes) : 0;
  const promedio = totalGrupos ? (totalTramos/totalGrupos) : 0;
  const mediana = (() => {
    if (!sizes.length) return 0;
    const s = sizes.slice().sort((a,b)=>a-b), m = Math.floor(s.length/2);
    return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2;
  })();

  return {
    totalGrupos,totalTramos,dist,min,max,promedio,mediana,
    paresSinDescanso,gruposConGap0,gruposTodosDescanso,
    paresSolapados,paresOrdenMalo,
    totalErr,totalWarn,confirmados,conCoordinador,
    coordsUnicos: coordsAsignados.size
  };
}

function renderViajesStats(){
  if (!SETS.length){ wrapStats.innerHTML='<div class="empty">AÚN NO HAY GRUPOS DE VIAJES.</div>'; return; }
  const s=computeViajesStats();

  const tbl=(title,rows)=>`<div class="panel" style="min-width:280px"><div class="hd">${title}</div><div class="bd">${rows}</div></div>`;
  const rowsKV=(kv)=>`<table><thead><tr><th>CLAVE</th><th style="width:90px">TOTAL</th></tr></thead><tbody>${Object.entries(kv).map(([k,v])=>`<tr><td>${escapeHtml(k)}</td><td>${v}</td></tr>`).join('')}</tbody></table>`;

  const totales=`
    <table><tbody>
      <tr><th>TOTAL DE VIAJES (GRUPOS)</th><td>${s.totalGrupos}</td></tr>
      <tr><th>TOTAL DE TRAMOS (VIAJES ASIGNADOS)</th><td>${s.totalTramos}</td></tr>
      <tr><th>PROMEDIO TRAMOS POR VIAJE</th><td>${s.promedio.toFixed(2)}</td></tr>
      <tr><th>MEDIANA TRAMOS POR VIAJE</th><td>${s.mediana}</td></tr>
      <tr><th>MÁXIMO / MÍNIMO TRAMOS</th><td>${s.max} / ${s.min}</td></tr>
    </tbody></table>`;

  const distOrdenada=Object.fromEntries(
    Object.entries(s.dist).sort((a,b)=>Number(b[0])-Number(a[0])).map(([n,c])=>[`${n} TRAMO${n==1?'':'S'}`,c])
  );

  const consistencia=`
    <table><tbody>
      <tr><th>CAMBIOS DE VIAJE SIN DÍA LIBRE (0 DÍAS)</th><td>${s.paresSinDescanso}</td></tr>
      <tr><th>GRUPOS CON ALGÚN CAMBIO SIN DÍA LIBRE</th><td>${s.gruposConGap0}</td></tr>
      <tr><th>GRUPOS QUE RESPETAN 1+ DÍA LIBRE ENTRE TODOS SUS CAMBIOS</th><td>${s.gruposTodosDescanso}</td></tr>
      <tr><th>FECHAS QUE SE PISAN ENTRE VIAJES</th><td>${s.paresSolapados}</td></tr>
      <tr><th>FECHAS EN ORDEN INCORRECTO</th><td>${s.paresOrdenMalo}</td></tr>
      <tr><th>ALERTAS (ERRORES / AVISOS)</th><td>${s.totalErr} / ${s.totalWarn}</td></tr>
    </tbody></table>`;

  const asignaciones=`
    <table><tbody>
      <tr><th>VIAJES CONFIRMADOS</th><td>${s.confirmados}</td></tr>
      <tr><th>VIAJES CON COORDINADOR</th><td>${s.conCoordinador}</td></tr>
      <tr><th>COORDINADORES ÚNICOS ASIGNADOS</th><td>${s.coordsUnicos}</td></tr>
    </tbody></table>`;

  wrapStats.innerHTML=`
    <div class="row" style="gap:.8rem; align-items:flex-start; flex-wrap:wrap;">
      ${tbl('TOTALES',totales)}
      ${tbl('DISTRIBUCIÓN POR TAMAÑO (TRAMOS POR VIAJE)', rowsKV(distOrdenada))}
      ${tbl('CONSISTENCIA / ALERTAS', consistencia)}
      ${tbl('ASIGNACIONES', asignaciones)}
    </div>`;
}

// ------------------ Modal coordinadores ------------------
function openModal(){ mb.style.display='block'; modal.style.display='flex'; }
function closeModal(){ modal.style.display='none'; mb.style.display='none'; }

function renderCoordsTable(){
  tbodyCoords.innerHTML=''; hintEmptyCoords.style.display=COORDS.length?'none':'block';

  const arr=COORDS.slice().sort((a,b)=> (!!a._isNew!==!!b._isNew) ? (a._isNew?-1:1) : (a.nombre||'').localeCompare(b.nombre||'','es',{sensitivity:'base'}));

  arr.forEach((c,visibleIdx)=>{
    const i=COORDS.indexOf(c);
    const filas=(c.disponibilidad||[]).map((r,ri)=>`
      <div style="display:flex; gap:.3rem; align-items:center; margin:.15rem 0;">
        <input class="picker-range" data-cid="${i}" data-ridx="${ri}" type="text" value="${r.inicio && r.fin ? `${fmtDMY(r.inicio)} a ${fmtDMY(r.fin)}` : ''}" placeholder="dd-mm-aaaa a dd-mm-aaaa" readonly>
        <button class="btn small" data-delrng="${i}:${ri}">❌</button>
      </div>`).join('');
    tbodyCoords.insertAdjacentHTML('beforeend',`
      <tr>
        <td style="text-align:center">${visibleIdx+1}</td>
        <td><input type="text" data-f="nombre"   data-i="${i}" value="${c.nombre||''}"   placeholder="Nombre"></td>
        <td><input type="text" data-f="rut"      data-i="${i}" value="${c.rut||''}"      placeholder="RUT"></td>
        <td><input type="text" data-f="telefono" data-i="${i}" value="${c.telefono||''}" placeholder="Teléfono"></td>
        <td><input type="text" data-f="correo"   data-i="${i}" value="${c.correo||''}"   placeholder="Correo"></td>
        <td>${filas}<button class="btn small" data-addrng="${i}">+ Rango</button></td>
        <td>
          <div class="row">
            <button class="btn small" data-saverc="${i}">💾 Guardar</button>
            <button class="btn small" data-delcoord="${i}">🗑️ Eliminar</button>
          </div>
        </td>
      </tr>`);
  });

  tbodyCoords.querySelectorAll('input[data-f]').forEach(inp=>{
    inp.onchange=()=>{ const i=+inp.dataset.i, f=inp.dataset.f; COORDS[i][f]=inp.value; };
  });
  tbodyCoords.querySelectorAll('button[data-addrng]').forEach(btn=>{
    btn.onclick=()=>{ const i=+btn.dataset.addrng; COORDS[i].disponibilidad ||= []; COORDS[i].disponibilidad.push({inicio:'',fin:''}); renderCoordsTable(); setTimeout(initPickers,10); };
  });
  tbodyCoords.querySelectorAll('button[data-delrng]').forEach(btn=>{
    btn.onclick=()=>{ const [i,j]=btn.dataset.delrng.split(':').map(Number); COORDS[i].disponibilidad.splice(j,1); renderCoordsTable(); setTimeout(initPickers,10); };
  });
  tbodyCoords.querySelectorAll('button[data-delcoord]').forEach(btn=>{
    btn.onclick=async()=>{ const i=+btn.dataset.delcoord; if (COORDS[i].id){ await deleteDoc(doc(db,'coordinadores',COORDS[i].id)); } COORDS.splice(i,1); renderCoordsTable(); setTimeout(initPickers,10); };
  });
  tbodyCoords.querySelectorAll('button[data-saverc]').forEach(btn=>{
    btn.onclick=async()=>{
      const i=+btn.dataset.saverc;
      btn.disabled=true; const prev=btn.textContent; btn.textContent='Guardando…';
      try{
        await saveOneCoord(i);
        btn.textContent='✅ Guardado';
        setTimeout(()=>{ btn.textContent=prev; btn.disabled=false; }, 900);
      }catch(e){
        console.error(e); btn.textContent='❌ Error';
        setTimeout(()=>{ btn.textContent=prev; btn.disabled=false; }, 1500);
      }
    };
  });

  initPickers();
}

function initPickers(){
  if (window.flatpickr && window.flatpickr.l10ns && window.flatpickr.l10ns.es){
    flatpickr.localize(flatpickr.l10ns.es);
  }
  tbodyCoords.querySelectorAll('.picker-range').forEach(inp=>{
    if (inp._flatpickr) inp._flatpickr.destroy();
    flatpickr(inp, {
      mode:'range',
      dateFormat:'d-m-Y',
      allowInput:true,
      onClose:(dates)=>{
        if (dates.length===2){
          const inicio = toISO(dates[0]);
          const fin    = toISO(dates[1]);
          const i=+inp.dataset.cid, j=+inp.dataset.ridx;
          COORDS[i].disponibilidad[j]={inicio, fin};
          inp.value = `${fmtDMY(inicio)} a ${fmtDMY(fin)}`;
        }
      }
    });
  });
}

// ------------------ Utils ------------------
function limpiarAlias(nombreCompleto){
  return (nombreCompleto||'').replace(/\d{4}/g,'')
    .replace(/\b(colegio|instituto|escuela|curso|año|de|del|la|el|los)\b/gi,'')
    .replace(/[^\w\s]/g,'').replace(/\s+/g,' ').trim();
}
function escapeHtml(s){ return (s||'').replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

// ------------------ Guardar cambios (grupos/sets) ------------------
async function guardarTodo(){
  // feedback visual lo maneja withBusy() en el botón

  // 0) Guarda alias en cada grupo (no cambia el resto)
  for (const g of GRUPOS){
    await updateDoc(doc(db,'grupos', g.id), { aliasGrupo: g.aliasGrupo || null });
  }

  // 1) Recorremos todos los sets, pero SOLO persistimos los CONFIRMADOS con coordinador
  const usadosConfirmados = new Set(); // ids de grupos que quedan realmente asignados

  for (const s of SETS){
    const estaConfirmado = !!s.confirmado && !!s.coordinadorId;

    if (estaConfirmado){
      // upsert del set confirmado
      let setId = s.id;
      const payload = {
        viajes: s.viajes.slice(),
        coordinadorId: s.coordinadorId,
        confirmado: true,
        meta: { actualizadoEn: serverTimestamp() }
      };

      if (!setId){
        const ref = await addDoc(
          collection(db,'conjuntosCoordinadores'),
          { ...payload, meta:{ creadoEn: serverTimestamp(), actualizadoEn: serverTimestamp() } }
        );
        setId = ref.id; s.id = setId;
      } else {
        await setDoc(doc(db,'conjuntosCoordinadores', setId), payload, { merge:true });
      }

      // nombre del coordinador (para escribirlo en grupos)
      const coordNombre = COORDS.find(c=>c.id===s.coordinadorId)?.nombre || null;

      // escribe en cada grupo: conjuntoId + NOMBRE del coordinador (y opcional coordinadorId)
      for (const gid of s.viajes){
        await updateDoc(doc(db,'grupos', gid), {
          conjuntoId: setId,
          coordinador: coordNombre,                // ← NOMBRE visible
          coordinadorId: s.coordinadorId || null   // ← opcional; bórrala si no la quieres
        });
        usadosConfirmados.add(gid);
      }

      delete s._isNew; // ya no es borrador
    } else {
      // NO confirmado ⇒ limpiar en grupos y (si existía) borrar el set en Firestore
      for (const gid of (s.viajes||[])){
        await updateDoc(doc(db,'grupos', gid), {
          conjuntoId: null,
          coordinador: null,
          coordinadorId: null
        });
      }
      if (s.id){
        try { await deleteDoc(doc(db,'conjuntosCoordinadores', s.id)); }
        catch(e){ console.warn('No se pudo eliminar set desconfirmado', s.id, e); }
      }
      // s.id se mantiene vacío (borrador local). No escribimos nada en la base.
    }
  }

  // 2) Por seguridad adicional: si quedó algún grupo fuera de cualquier set confirmado, se limpia.
  for (const g of GRUPOS){
    if (!usadosConfirmados.has(g.id)){
      await updateDoc(doc(db,'grupos', g.id), {
        conjuntoId: null,
        coordinador: null,
        coordinadorId: null
      });
    }
  }

  // listo
}

// ------------------ Boot ------------------
window.addEventListener('DOMContentLoaded', async ()=>{
  await loadCoordinadores();
  await loadGrupos();
  await loadSets();
  populateFilterOptions();
  render();
});
