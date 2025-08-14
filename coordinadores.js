/* coordinadores.js — FINAL
   - Conjuntos guardados en coordinadores/{coordId}/conjuntos (subcolección)
   - Carga por collectionGroup('conjuntos')
   - Bloqueo por confirmación (en memoria y persistido)
   - Destinos aptos por coordinador (multi-select + Excel)
   - Guardado por fila (💾) con meta correcto (creado/actualizado)
   - Fechas dd/mm/aaaa (flatpickr ES)
   - Buscador aplicado a CONJUNTOS (coordinador, alias, #negocio, id, programa, destino, fechas…) con tokens separados por coma
*/

import { app, db } from './firebase-init.js';
import {
  collection, collectionGroup, getDocs, addDoc, doc, updateDoc, setDoc, deleteDoc,
  query, where, getDoc, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

/* =========================================================
   Estado
   ========================================================= */
let COORDS = [];   // {id, nombre, rut, telefono, correo, destinos:string[], disponibilidad:[{inicio,fin}], activo, notas, _isNew?}
let GRUPOS = [];   // catálogo de viajes (grupos)
let SETS   = [];   // asignaciones (conjuntos)
let ID2GRUPO = new Map();

let DESTINOS = []; // catálogo (normalizado) desde GRUPOS

// Filtros de catálogo (resumen/libres)
const FILTER = { destino:'', programa:'', desde:'', hasta:'' };

// Buscador de CONJUNTOS (tokens)
const SEARCH = { tokens: [] };

let swapMode  = false;
let swapFirst = null;

/* =========================================================
   Helpers fecha/formato
   ========================================================= */
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

const cmpISO   = (a,b)=> (new Date(a)-new Date(b));
const overlap  = (a1,a2,b1,b2)=>!(new Date(a2)<new Date(b1)||new Date(b2)<new Date(a1));
const inAnyRange = (ini,fin,ranges=[]) => (ranges||[]).some(r=> new Date(ini)>=new Date(r.inicio) && new Date(fin)<=new Date(r.fin));
function gapDays(finA, iniB){ const A=new Date(finA+'T00:00:00'); const B=new Date(iniB+'T00:00:00'); return Math.round((B-A)/86400000)-1; }

// dd/mm/aaaa
function fmtDMY(iso){ if(!iso) return ''; const [y,m,d]=iso.split('-'); return `${d}/${m}/${y}`; }

/* =========================================================
   Normalización de destinos (MAYÚSCULA)
   ========================================================= */
const normDest = s => (s||'').toString().trim().toUpperCase();
function cleanDestinos(arr){
  return (arr||[])
    .map(normDest)
    .filter(Boolean)
    .filter((v,i,a)=>a.indexOf(v)===i)
    .sort();
}
function isAptoDestino(coord, destino){
  const d = normDest(destino);
  if (!d) return true;
  const L = coord?.destinos || [];
  // lista vacía = apto para todos
  return !L.length || L.includes(d);
}

/* =========================================================
   Carga Firestore
   ========================================================= */
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
      destinos: cleanDestinos(x.destinos || x.destinosAptos || []),
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
  SETS = [];
  // Lee TODOS los conjuntos sin saber el coordinador de antemano
  const snap = await getDocs(collectionGroup(db, 'conjuntos'));
  snap.forEach(d => {
    const x = d.data();
    const conjuntoId    = d.id;
    const coordinadorId = d.ref.parent.parent.id;   // doc padre del padre = coordinador
    const viajes        = (x.viajes || []).filter(id => ID2GRUPO.has(id)); // normaliza arreglo

    SETS.push({
      id: conjuntoId,
      viajes,
      coordinadorId,
      confirmado: !!x.confirmado,
      alertas: [],
      _ownerCoordId: coordinadorId  // para detectar “movidas” entre coords al guardar
    });
  });

  evaluarAlertas();
  sortSetsInPlace();
  populateFilterOptions(); // cataloga destinos/programas para filtros
}

/* =========================================================
   DOM refs
   ========================================================= */
const $ = s=>document.querySelector(s);
const elWrapLibres = $('#lista-viajes-libres');
const elWrapSets   = $('#conjuntos-wrap');
const elMsg        = $('#msg');

// Filtros de catálogo (resumen/libres)
const selDestino = $('#f-destino');
const selPrograma= $('#f-programa');
const inpDesde   = $('#f-desde');
const inpHasta   = $('#f-hasta');

// Buscador de CONJUNTOS (ubícalo en la cabecera de “Viajes”)
const inpBuscarSets = $('#buscar-sets');

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
$('#btn-sugerir')?.addEventListener('click', sugerirConjuntos);
$('#btn-nuevo-conjunto')?.addEventListener('click', ()=>{
  SETS.unshift({viajes:[], coordinadorId:null, confirmado:false, alertas:[], _isNew:true});
  render();
});
$('#btn-guardar')?.addEventListener('click', ()=>withBusy($('#btn-guardar'), 'Guardando…', guardarTodo, 'Guardar cambios', '✅ Guardado'));

// Modal handlers
btnOpenModal?.addEventListener('click', ()=>{ openModal(); renderCoordsTable(); });
btnCloseModal?.addEventListener('click', closeModal);
btnCerrar?.addEventListener('click', closeModal);
btnGuardarCoords?.addEventListener('click', ()=>withBusy(btnGuardarCoords, 'Guardando…', saveCoordsModal, 'Guardar coordinadores', '✅ Guardado'));
btnAddCoord?.addEventListener('click', ()=>{
  COORDS.unshift({nombre:'', rut:'', telefono:'', correo:'', destinos:[], disponibilidad:[], _isNew:true});
  renderCoordsTable(); setTimeout(initPickers,10);
});
btnAddLote?.addEventListener('click', ()=> inputExcel.click());
inputExcel?.addEventListener('change', handleExcel);

// Filtros (catálogo)
function populateFilterOptions(){
  // catálogo de destinos en MAYÚSCULA
  DESTINOS = [...new Set(GRUPOS.map(g=>normDest(g.destino)).filter(Boolean))].sort();

  const dests=[...new Set(GRUPOS.map(g=>g.destino).filter(Boolean))].sort();
  const progs=[...new Set(GRUPOS.map(g=>g.programa).filter(Boolean))].sort();
  if (selDestino)  selDestino.innerHTML  = `<option value="">Todos los destinos</option>` + dests.map(d=>`<option>${escapeHtml(d)}</option>`).join('');
  if (selPrograma) selPrograma.innerHTML = `<option value="">Todos los programas</option>` + progs.map(p=>`<option>${escapeHtml(p)}</option>`).join('');

  selDestino?.addEventListener('change',  ()=>{ FILTER.destino = selDestino.value; render(); });
  selPrograma?.addEventListener('change', ()=>{ FILTER.programa= selPrograma.value; render(); });
  inpDesde?.addEventListener('change',    ()=>{ FILTER.desde   = inpDesde.value||''; render(); });
  inpHasta?.addEventListener('change',    ()=>{ FILTER.hasta   = inpHasta.value||''; render(); });

  // Buscador de CONJUNTOS (tokens separados por coma)
  inpBuscarSets?.addEventListener('input', ()=>{
    SEARCH.tokens = parseTokens(inpBuscarSets.value);
    renderSets(); // sólo re-pinto conjuntos (más ágil)
  });
}

/* =========================================================
   Utils generales
   ========================================================= */
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

function gruposFiltrados(arr=GRUPOS){
  return arr.filter(g=>{
    if (FILTER.destino && !norm(g.destino).includes(norm(FILTER.destino))) return false;
    if (FILTER.programa && !norm(g.programa).includes(norm(FILTER.programa))) return false;
    if (FILTER.desde && g.fechaInicio < FILTER.desde) return false;
    if (FILTER.hasta && g.fechaInicio > FILTER.hasta) return false;
    return true;
  });
}

// Conjuntos filtrados por SEARCH.tokens (AND entre tokens)
function setsFiltrados(arr=SETS){
  const toks = SEARCH.tokens || [];
  if (!toks.length) return arr;

  return arr.filter(s=>{
    const coordName = s.coordinadorId ? (COORDS.find(c=>c.id===s.coordinadorId)?.nombre||'') : '';
    const viajes = (s.viajes||[]).map(id=>ID2GRUPO.get(id)).filter(Boolean);

    // Campos buscables (todo en minúsculas)
    const hay = [];
    hay.push(norm(coordName));
    viajes.forEach(v=>{
      hay.push(
        norm(v.aliasGrupo),
        norm(v.nombreGrupo),
        norm('#'+(v.numeroNegocio||'')),
        norm(v.identificador),
        norm(v.programa),
        norm(v.destino),
        norm(v.id||'')
      );
      hay.push(norm(fmtDMY(v.fechaInicio)), norm(fmtDMY(v.fechaFin)));
      hay.push(norm(v.fechaInicio), norm(v.fechaFin));
    });

    return toks.every(tok => hay.some(h => h && h.includes(tok)));
  });
}

/* =========================================================
   BLOQUEO por confirmación (coordinadores ya en uso)
   ========================================================= */
function getBlockedCoordIds(exceptSetIdx = null){
  const blocked = new Set();

  // a) Confirmados en memoria (SETS)
  SETS.forEach((s, idx)=>{
    if (s.confirmado && s.coordinadorId){
      if (exceptSetIdx !== null && idx === exceptSetIdx) return;
      blocked.add(s.coordinadorId);
    }
  });

  // b) Confirmados persistidos en grupos
  GRUPOS.forEach(g=>{
    if (g.conjuntoId && g.coordinadorId){
      if (exceptSetIdx!==null && SETS[exceptSetIdx]?.coordinadorId === g.coordinadorId) return;
      blocked.add(g.coordinadorId);
    }
  });

  return blocked;
}

/* =========================================================
   Render
   ========================================================= */
function render(){
  sortSetsInPlace();
  renderResumen();
  renderLibres();
  renderSets();
  renderViajesStats();
  elMsg && (elMsg.textContent='');
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
  wrapResumen && (wrapResumen.innerHTML=`
    <div class="row" style="gap:.8rem; align-items:flex-start; flex-wrap:wrap;">
      ${mk('Por destino',tDest)}
      ${mk('Por fecha de inicio',tIniDMY)}
      ${mk('Por programa',tProg)}
    </div>`);
}

function viajesUsadosSetIds(){ const s=new Set(); SETS.forEach(x=>x.viajes.forEach(id=>s.add(id))); return s; }

function renderLibres(){
  const usados=viajesUsadosSetIds();
  const libresAll=GRUPOS.filter(g=>!usados.has(g.id));
  const libres=gruposFiltrados(libresAll);
  if (!elWrapLibres) return;
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
  if (!elWrapSets) return;
  const list = setsFiltrados(SETS);      // ← aplica BUSCADOR de conjuntos
  if (!list.length){ elWrapSets.innerHTML='<div class="empty">Sin viajes asignados (sin resultados en la búsqueda).</div>'; return; }

  elWrapSets.innerHTML='';
  list.forEach((s)=>{
    const idx = SETS.indexOf(s); // índice real (para handlers)
    const viajes=s.viajes.map(id=>ID2GRUPO.get(id)).filter(Boolean);

    // Destinos del set (en MAYÚSCULA) para aptitud
    const setDestinos = [...new Set(viajes.map(v=>normDest(v.destino)).filter(Boolean))];

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
        .map(c=>{
          const apto = setDestinos.every(d => isAptoDestino(c, d));
          const name = escapeHtml(c.nombre||'(sin nombre)') + (apto ? '' : ' (NO APTO)');
          const sel  = (s.coordinadorId===c.id)?'selected':'';
          return `<option value="${c.id}" ${sel}>${name}</option>`;
        })
    ).join('');

    const alertas=s.alertas||[];
    const alertHtml = alertas.length
      ? `<div>${alertas.map(a=>`<div class="${a.tipo==='err'?'err':'warn'}">• ${a.msg}</div>`).join('')}</div>`
      : '<div class="muted">Sin alertas.</div>';

    elWrapSets.insertAdjacentHTML('beforeend',`
      <div class="card">
        <div class="hd">
          <div class="row">
            <span class="tag">VIAJES ${idx+1}</span>
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

  // Handlers de la lista (usan índices reales guardados en data-*)
  elWrapSets.querySelectorAll('input[data-alias]').forEach(inp=>{
    inp.onchange=()=>{ const g=ID2GRUPO.get(inp.dataset.alias); if(g){ g.aliasGrupo=inp.value; } };
  });
  elWrapSets.querySelectorAll('button[data-del]').forEach(btn=>{
    btn.onclick=()=>{ const i=+btn.dataset.set; SETS[i].viajes = SETS[i].viajes.filter(id=>id!==btn.dataset.del); evaluarAlertas(); renderSets(); };
  });
  elWrapSets.querySelectorAll('button[data-move]').forEach(btn=>{
    btn.onclick=()=>{ const i=+btn.dataset.set; moverViajeAotroConjunto(btn.dataset.move,i); };
  });
  elWrapSets.querySelectorAll('button[data-addv]').forEach(btn=>{
    btn.onclick=()=>agregarViajeAConjunto(+btn.dataset.addv);
  });
  elWrapSets.querySelectorAll('button[data-delset]').forEach(btn=>{
    btn.onclick=()=>{ const i=+btn.dataset.delset; if(!confirm('¿Eliminar este grupo de viajes?'))return; SETS.splice(i,1); evaluarAlertas(); renderSets(); };
  });
  elWrapSets.querySelectorAll('button[data-sugerirc]').forEach(btn=>{
    btn.onclick=()=>sugerirCoordinador(+btn.dataset.sugerirc);
  });
  elWrapSets.querySelectorAll('button[data-confirm]').forEach(btn=>{
    btn.onclick=()=>{ const i=+btn.dataset.confirm; SETS[i].confirmado=!SETS[i].confirmado; renderSets(); };
  });
  elWrapSets.querySelectorAll('select[data-coord]').forEach(sel=>{
    sel.onchange=()=>{ const i=+sel.dataset.coord; SETS[i].coordinadorId = sel.value||null; evaluarAlertas(); renderSets(); };
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

/* =========================================================
   Sugeridor (respeta confirmados memoria + persistido)
   ========================================================= */
function sugerirConjuntos(){
  // 1) Fijos en memoria (SETS)
  const fixedSetsMem = SETS.filter(s => s.confirmado && !!s.coordinadorId);
  const fixedTripIds = new Set();
  fixedSetsMem.forEach(s => (s.viajes||[]).forEach(id => fixedTripIds.add(id)));

  // 2) Fijos persistidos en GRUPOS (reconstruye por conjuntoId/coordinadorId)
  const mapConjunto = new Map();
  for (const g of GRUPOS){
    if (g.conjuntoId && g.coordinadorId){
      if (!mapConjunto.has(g.conjuntoId)){
        mapConjunto.set(g.conjuntoId, { id:g.conjuntoId, viajes:[], coordinadorId:g.coordinadorId, confirmado:true, alertas:[] });
      }
      mapConjunto.get(g.conjuntoId).viajes.push(g.id);
    }
  }
  const fixedFromGrupos = Array.from(mapConjunto.values());
  const fixedFromGruposFiltered = fixedFromGrupos.filter(fs => !fs.viajes.some(id => fixedTripIds.has(id)));

  // 3) Pool a recalcular = viajes que no están en ningún fijo
  fixedFromGruposFiltered.forEach(fs => fs.viajes.forEach(id => fixedTripIds.add(id)));
  const pool = GRUPOS
    .filter(g => !fixedTripIds.has(g.id))
    .sort((a,b) => cmpISO(a.fechaInicio, b.fechaInicio));

  // 4) Greedy sobre el pool
  const work = []; // [{viajes:[], lastFin, zeroChain}]
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

  // 5) Sugerencias (borradores)
  const suggested = work.map(() => ({ viajes:[], coordinadorId:null, confirmado:false, alertas:[], _isNew:true }));
  for (let i=0;i<work.length;i++){ suggested[i].viajes = work[i].viajes.slice(); }

  // 6) Resultado: fijos (memoria) + fijos (persistido) + sugerencias
  SETS = fixedSetsMem.concat(fixedFromGruposFiltered).concat(suggested);

  evaluarAlertas();
  sortSetsInPlace();
  renderSets(); // solo refresco conjuntos
}

/* =========================================================
   Alertas / Consistencia (incluye aptitud destinos)
   ========================================================= */
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
      if (c){
        viajes.forEach(v=>{
          if (!inAnyRange(v.fechaInicio,v.fechaFin,c.disponibilidad||[])){
            s.alertas.push({tipo:'warn', msg:`Coordinador fuera de disponibilidad en ${v.aliasGrupo||v.nombreGrupo}`});
          }
        });
        if ((c.destinos||[]).length){
          viajes.forEach(v=>{
            const d = normDest(v.destino);
            if (d && !c.destinos.includes(d)){
              s.alertas.push({tipo:'warn', msg:`Coordinador no apto para destino ${d} en ${v.aliasGrupo||v.nombreGrupo}`});
            }
          });
        }
      }
    }
  });

  // Doble asignación con fechas que se pisan
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

/* =========================================================
   Acciones sobre viajes
   ========================================================= */
function seleccionarConjuntoDestino(grupoId){
  if (!SETS.length){ alert('Primero crea un grupo de viajes.'); return; }
  const n=prompt(`¿A qué grupo mover este viaje? (1..${SETS.length})`); if (!n) return;
  const idx=(+n)-1; if (idx<0||idx>=SETS.length){ alert('Número inválido'); return; }
  if (SETS.some(s=>s.viajes.includes(grupoId))) SETS.forEach(s=> s.viajes=s.viajes.filter(id=>id!==grupoId));
  SETS[idx].viajes.push(grupoId); evaluarAlertas(); renderSets();
}
function moverViajeAotroConjunto(grupoId, desdeIdx){
  if (SETS.length<=1){ alert('No hay otro grupo.'); return; }
  const n=prompt(`Mover al grupo (1..${SETS.length}, distinto de ${desdeIdx+1})`); if(!n) return;
  const to=(+n)-1; if(to===desdeIdx||to<0||to>=SETS.length){ alert('Número inválido'); return; }
  SETS[desdeIdx].viajes = SETS[desdeIdx].viajes.filter(id=>id!==grupoId);
  SETS[to].viajes.push(grupoId); evaluarAlertas(); renderSets();
}
function agregarViajeAConjunto(setIdx){
  const usados=viajesUsadosSetIds();
  const libresAll=GRUPOS.filter(g=>!usados.has(g.id));
  const libres=gruposFiltrados(libresAll);
  if (!libres.length){ alert('No quedan viajes libres con los filtros actuales.'); return; }
  const listado=libres.map((g,i)=>`${i+1}) ${g.aliasGrupo||g.nombreGrupo} [${fmtDMY(g.fechaInicio)}→${fmtDMY(g.fechaFin)}] • #${g.numeroNegocio} • ${g.programa||''} • ${g.destino||''}`).join('\n');
  const n=prompt(`Selecciona # de viaje a agregar (filtrado):\n${listado}`); if(!n) return;
  const i=(+n)-1; if(i<0||i>=libres.length) return;
  SETS[setIdx].viajes.push(libres[i].id); evaluarAlertas(); renderSets();
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
  evaluarAlertas(); renderSets();
}

// Sugerir coordinador (filtra bloqueados, disponibilidad y aptitud por destino)
function sugerirCoordinador(setIdx){
  const s=SETS[setIdx];
  const viajes=s.viajes.map(id=>ID2GRUPO.get(id)).filter(Boolean);
  const blocked = getBlockedCoordIds(setIdx);
  const destSet = [...new Set(viajes.map(v=>normDest(v.destino)).filter(Boolean))];

  const ok=COORDS.filter(c =>
    !blocked.has(c.id) &&
    viajes.every(v => inAnyRange(v.fechaInicio, v.fechaFin, c.disponibilidad||[])) &&
    destSet.every(d => isAptoDestino(c, d))
  );
  if (!ok.length){ alert('No hay coordinadores disponibles (fechas/destinos) que cubran todo el grupo.'); return; }
  s.coordinadorId = ok[0].id;
  evaluarAlertas(); renderSets();
}

/* =========================================================
   Guardado / IDs de coordinador
   ========================================================= */
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

// 💾 Guardar UNA fila de coordinador (con meta correcto)
async function saveOneCoord(i){
  const c = COORDS[i];
  const nombre=(c.nombre||'').trim();
  if (!nombre){ alert('Debe indicar nombre.'); return; }

  const base = {
    nombre,
    rut:(c.rut||'').replace(/\s+/g,'').toUpperCase(),
    telefono:(c.telefono||'').trim(),
    correo:(c.correo||'').trim().toLowerCase(),
    destinos: cleanDestinos(c.destinos),
    disponibilidad: cleanRanges(c.disponibilidad),
    activo:(c.activo!==false),
    notas:(c.notas||'').trim(),
  };

  // Resolver ID (por rut o nombre) o crear slug
  let id = c.id || await findCoordId({ rut: base.rut, nombre: base.nombre });
  let isNew = false;

  if (!id){
    const wanted = slugNombre(base.nombre);
    const exists = await getDoc(doc(db,'coordinadores', wanted));
    id   = exists.exists() ? `${wanted}-${Date.now().toString(36).slice(-4)}` : wanted;
    isNew = true;
  }

  const ref = doc(db, 'coordinadores', id);
  await setDoc(
    ref,
    {
      ...base,
      meta: isNew
        ? { creadoEn: serverTimestamp(), actualizadoEn: serverTimestamp() }
        : { actualizadoEn: serverTimestamp() }
    },
    { merge: true }
  );

  c.id = id;
  delete c._isNew;
}

// Guardar todas las filas del modal
async function saveCoordsModal(){
  for (let i=0;i<COORDS.length;i++){
    const c=COORDS[i];
    if (!c.nombre || !c.nombre.trim()) continue;
    await saveOneCoord(i);
  }
  await loadCoordinadores();
  closeModal(); evaluarAlertas(); renderSets();
}

/* =========================================================
   Estadísticas de viajes (sobre todos los SETS)
   ========================================================= */
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
  if (!wrapStats) return;
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

/* =========================================================
   Modal coordinadores (con columna DESTINOS)
   ========================================================= */
function openModal(){ mb && (mb.style.display='block'); modal && (modal.style.display='flex'); }
function closeModal(){ if(modal) modal.style.display='none'; if(mb) mb.style.display='none'; }

function renderCoordsTable(){
  if (!tbodyCoords) return;
  tbodyCoords.innerHTML=''; hintEmptyCoords && (hintEmptyCoords.style.display=COORDS.length?'none':'block');

  const arr=COORDS.slice().sort((a,b)=> (!!a._isNew!==!!b._isNew) ? (a._isNew?-1:1) : (a.nombre||'').localeCompare(b.nombre||'','es',{sensitivity:'base'}));

  arr.forEach((c,visibleIdx)=>{
    const i=COORDS.indexOf(c);

    // rangos de disponibilidad
    const filas=(c.disponibilidad||[]).map((r,ri)=>`
      <div style="display:flex; gap:.3rem; align-items:center; margin:.15rem 0;">
        <input class="picker-range" data-cid="${i}" data-ridx="${ri}" type="text" value="${r.inicio && r.fin ? `${fmtDMY(r.inicio)} a ${fmtDMY(r.fin)}` : ''}" placeholder="dd/mm/aaaa a dd/mm/aaaa" readonly>
        <button class="btn small" data-delrng="${i}:${ri}">❌</button>
      </div>`).join('');

    // multiselect de destinos + input para agregar nuevo
    const optsDest = DESTINOS.map(d=>{
      const sel = (c.destinos||[]).includes(d) ? 'selected' : '';
      return `<option value="${escapeHtml(d)}" ${sel}>${escapeHtml(d)}</option>`;
    }).join('');

    tbodyCoords.insertAdjacentHTML('beforeend',`
      <tr>
        <td style="text-align:center">${visibleIdx+1}</td>
        <td><input type="text" data-f="nombre"   data-i="${i}" value="${c.nombre||''}"   placeholder="Nombre"></td>
        <td><input type="text" data-f="rut"      data-i="${i}" value="${c.rut||''}"      placeholder="RUT"></td>
        <td><input type="text" data-f="telefono" data-i="${i}" value="${c.telefono||''}" placeholder="Teléfono"></td>
        <td><input type="text" data-f="correo"   data-i="${i}" value="${c.correo||''}"   placeholder="Correo"></td>

        <td>
          <select multiple size="3" class="sel-dest" data-i="${i}" style="min-width:180px">
            ${optsDest}
          </select>
          <div class="row" style="margin-top:.25rem">
            <input type="text" class="add-dest" data-i="${i}" placeholder="Agregar destino…" style="width:160px">
            <button class="btn small" data-adddest="${i}">+</button>
          </div>
          <div class="muted" style="margin-top:.25rem; font-size:.85em">(Vacío = apto para todos)</div>
        </td>

        <td>${filas}<button class="btn small" data-addrng="${i}">+ Rango</button></td>

        <td>
          <div class="row">
            <button class="btn small" data-saverc="${i}">💾 Guardar</button>
            <button class="btn small" data-delcoord="${i}">🗑️ Eliminar</button>
          </div>
        </td>
      </tr>`);
  });

  // inputs base
  tbodyCoords.querySelectorAll('input[data-f]').forEach(inp=>{
    inp.onchange=()=>{ const i=+inp.dataset.i, f=inp.dataset.f; COORDS[i][f]=inp.value; };
  });

  // multiselect destinos
  tbodyCoords.querySelectorAll('select.sel-dest').forEach(sel=>{
    sel.onchange=()=>{
      const i=+sel.dataset.i;
      const selected=[...sel.selectedOptions].map(o=>normDest(o.value));
      COORDS[i].destinos = cleanDestinos(selected);
    };
  });

  // agregar destino manual
  tbodyCoords.querySelectorAll('button[data-adddest]').forEach(btn=>{
    btn.onclick=()=>{
      const i=+btn.dataset.adddest;
      const input = tbodyCoords.querySelector(`input.add-dest[data-i="${i}"]`);
      const val = normDest(input.value);
      if (!val) return;
      if (!DESTINOS.includes(val)) DESTINOS.push(val), DESTINOS.sort();
      COORDS[i].destinos = cleanDestinos([...(COORDS[i].destinos||[]), val]);
      renderCoordsTable(); setTimeout(initPickers,10);
    };
  });

  // disponibilidad
  tbodyCoords.querySelectorAll('button[data-addrng]').forEach(btn=>{
    btn.onclick=()=>{ const i=+btn.dataset.addrng; COORDS[i].disponibilidad ||= []; COORDS[i].disponibilidad.push({inicio:'',fin:''}); renderCoordsTable(); setTimeout(initPickers,10); };
  });
  tbodyCoords.querySelectorAll('button[data-delrng]').forEach(btn=>{
    btn.onclick=()=>{ const [i,j]=btn.dataset.delrng.split(':').map(Number); COORDS[i].disponibilidad.splice(j,1); renderCoordsTable(); setTimeout(initPickers,10); };
  });

  // borrar / guardar fila
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
  tbodyCoords?.querySelectorAll('.picker-range')?.forEach(inp=>{
    if (inp._flatpickr) inp._flatpickr.destroy();
    flatpickr(inp, {
      mode:'range',
      dateFormat:'d/m/Y',    // dd/mm/aaaa
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

/* =========================================================
   Utils varios
   ========================================================= */
function limpiarAlias(nombreCompleto){
  return (nombreCompleto||'').replace(/\d{4}/g,'')
    .replace(/\b(colegio|instituto|escuela|curso|año|de|del|la|el|los)\b/gi,'')
    .replace(/[^\w\s]/g,'').replace(/\s+/g,' ').trim();
}
function escapeHtml(s){ return (s||'').replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

/* =========================================================
   Guardar CAMBIOS (persiste SOLO confirmados)
   - Conjuntos se guardan / mueven en coordinadores/{coord}/conjuntos
   - grupos/{gid} recibe { conjuntoId, coordinador (NOMBRE), coordinadorId }
   - Conjuntos NO confirmados ⇒ grupos quedan limpios.
   ========================================================= */
async function guardarTodo(){
  // 0) alias de grupos
  for (const g of GRUPOS){
    await updateDoc(doc(db,'grupos', g.id), { aliasGrupo: g.aliasGrupo || null });
  }

  const usadosConfirmados = new Set();

  for (const s of SETS){
    const estaConfirmado = !!s.confirmado && !!s.coordinadorId;

    if (estaConfirmado){
      const payload = {
        viajes: s.viajes.slice(),
        confirmado: true,
        meta: { actualizadoEn: serverTimestamp() }
      };

      // ¿cambió de dueño? (coordinador distinto)
      if (s.id && s._ownerCoordId && s._ownerCoordId !== s.coordinadorId){
        try { await deleteDoc(doc(db, 'coordinadores', s._ownerCoordId, 'conjuntos', s.id)); } catch (_) {}
        s.id = null; // forzar alta en nuevo dueño
      }

      // upsert bajo el coordinador actual
      let ref;
      if (s.id){
        ref = doc(db, 'coordinadores', s.coordinadorId, 'conjuntos', s.id);
        await setDoc(ref, payload, { merge:true });
      } else {
        ref = await addDoc(collection(db, 'coordinadores', s.coordinadorId, 'conjuntos'), {
          ...payload,
          meta: { creadoEn: serverTimestamp(), actualizadoEn: serverTimestamp() }
        });
        s.id = ref.id;
      }
      s._ownerCoordId = s.coordinadorId;

      // nombre del coord para escribirlo en grupos
      const coordNombre = COORDS.find(c=>c.id===s.coordinadorId)?.nombre || null;

      for (const gid of s.viajes){
        await updateDoc(doc(db,'grupos', gid), {
          conjuntoId: s.id,
          coordinador: coordNombre,                // ← NOMBRE visible
          coordinadorId: s.coordinadorId || null   // ← opcional, útil para bloqueo
        });
        usadosConfirmados.add(gid);
      }

      delete s._isNew;
    } else {
      // no confirmado: limpiar en grupos + borrar doc si existía
      for (const gid of (s.viajes||[])){
        await updateDoc(doc(db,'grupos', gid), {
          conjuntoId: null,
          coordinador: null,
          coordinadorId: null
        });
      }
      const owner = s._ownerCoordId || s.coordinadorId;
      if (s.id && owner){
        try { await deleteDoc(doc(db, 'coordinadores', owner, 'conjuntos', s.id)); } catch(_){}
      }
    }
  }

  // Seguridad extra: si algún grupo quedó fuera de confirmados, dejarlo limpio
  for (const g of GRUPOS){
    if (!usadosConfirmados.has(g.id)){
      await updateDoc(doc(db,'grupos', g.id), {
        conjuntoId: null,
        coordinador: null,
        coordinadorId: null
      });
    }
  }
}

/* =========================================================
   Boot
   ========================================================= */
window.addEventListener('DOMContentLoaded', async ()=>{
  await loadCoordinadores();
  await loadGrupos();
  await loadSets();
  populateFilterOptions();
  render();
});
