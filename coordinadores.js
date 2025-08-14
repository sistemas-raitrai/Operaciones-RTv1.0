// coordinadores.js — VIAJES + GESTIÓN DE COORDINADORES
// ----------------------------------------------------
// - Esquema coordinadores: { nombre, rut, telefono, correo, disponibilidad:[{inicio,fin}], activo, notas, meta }
// - Back-compat: mapea fechasDisponibles → disponibilidad al cargar.
// - UI: "Conjuntos" → "Viajes". Sugerir, mover, swap, confirmar, alertas.
// - Filtros + Resumen (destino, programa, fechas, buscador por comas).
// - Estadísticas de viajes (totales, distribución, consistencia, asignaciones).
// - Guardado: alias en grupos; conjuntosCoordinadores; refs en grupos (conjuntoId, coordinador).

import { app, db } from './firebase-init.js';
import {
  collection, getDocs, addDoc, doc, updateDoc, setDoc, deleteDoc,
  query, where, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

// ------------------------------
// Estado
// ------------------------------
let COORDS = [];   // [{id, nombre, rut, telefono, correo, disponibilidad:[{inicio,fin}], activo, notas}]
let GRUPOS = [];   // [{id, numeroNegocio, nombreGrupo, aliasGrupo, fechaInicio, fechaFin, identificador, programa, destino}]
let SETS   = [];   // [{id?, viajes:[grupoId], coordinadorId:null, confirmado:false, alertas:[]}]
let ID2GRUPO = new Map();

// Filtros
const FILTER = { destino:'', programa:'', desde:'', hasta:'', tokens:[] };

// Swap
let swapMode  = false;
let swapFirst = null;

// ------------------------------
// Fecha helpers
// ------------------------------
const toISO = d => (new Date(d)).toISOString().slice(0,10);
const addDaysISO = (iso, n) => { const d = new Date(iso+'T00:00:00'); d.setDate(d.getDate()+n); return toISO(d); };
function asISO(v){
  if (!v) return null;
  if (typeof v === 'string'){ const d=new Date(v); return isNaN(d)?null:toISO(d); }
  if (v?.toDate)  return toISO(v.toDate());
  if (v?.seconds) return toISO(new Date(v.seconds*1000));
  if (v instanceof Date) return toISO(v);
  return null;
}
const cmpISO = (a,b)=> (new Date(a)-new Date(b));
const overlap = (a1,a2,b1,b2)=>!(new Date(a2)<new Date(b1)||new Date(b2)<new Date(a1));
const inAnyRange = (ini,fin,ranges=[]) => (ranges||[]).some(r=> new Date(ini)>=new Date(r.inicio) && new Date(fin)<=new Date(r.fin));
function gapDays(finA, iniB){ const A=new Date(finA+'T00:00:00'); const B=new Date(iniB+'T00:00:00'); return Math.round((B-A)/86400000)-1; }

function normalizarFechasGrupo(x){
  let ini = asISO(x.fechaInicio||x.fecha_inicio||x.inicio||x.fecha||x.fechaDeViaje||x.fechaViaje||x.fechaInicioViaje);
  let fin = asISO(x.fechaFin   ||x.fecha_fin   ||x.fin   ||x.fechaFinal   ||x.fechaFinViaje);
  if ((!ini||!fin) && x.itinerario && typeof x.itinerario==='object'){
    const ks=Object.keys(x.itinerario).filter(k=>/^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
    if (ks.length){ ini=ini||ks[0]; fin=fin||ks[ks.length-1]; }
  }
  if (ini && !fin && (x.duracion||x.noches)){
    const days = Number(x.duracion)||(Number(x.noches)+1)||1; fin = addDaysISO(ini, days-1);
  }
  if (ini && !fin) fin=ini; if (fin && !ini) ini=fin;
  return {ini,fin};
}

// ------------------------------
// Carga
// ------------------------------
async function loadCoordinadores(){
  COORDS = [];
  const snap = await getDocs(collection(db,'coordinadores'));
  snap.forEach(d=>{
    const x = d.data(); x.id = d.id;
    const disp = Array.isArray(x.disponibilidad) ? x.disponibilidad
                : Array.isArray(x.fechasDisponibles) ? x.fechasDisponibles
                : [];
    const disponibilidad = (disp||[])
      .map(r=>({inicio:asISO(r.inicio)||null, fin:asISO(r.fin)||null}))
      .filter(r=>r.inicio&&r.fin&&(new Date(r.inicio)<=new Date(r.fin)));
    COORDS.push({
      id:x.id,
      nombre:(x.nombre||'').trim(),
      rut:(x.rut||'').trim(),
      telefono:(x.telefono||'').trim(),
      correo:((x.correo||'').trim()||'').toLowerCase(),
      disponibilidad,
      activo:(x.activo!==false),
      notas:(x.notas||'').trim()
    });
  });
}

async function loadGrupos(){
  GRUPOS = []; ID2GRUPO.clear();
  const snap = await getDocs(collection(db,'grupos'));
  snap.forEach(d=>{
    const x = d.data(); x.id = d.id;
    x.numeroNegocio = x.numeroNegocio || d.id;
    x.aliasGrupo    = x.aliasGrupo || limpiarAlias(x.nombreGrupo||'');
    const {ini,fin} = normalizarFechasGrupo(x);
    if (!ini||!fin) return;

    const identificador = x.identificador || x.identificadorGrupo || x.codigoGrupo || x.codigo || '';
    const programa      = x.programa || x.nombrePrograma || x.programaNombre || '';
    const destino       = x.destino || x.destinoPrincipal || x.ciudadDestino || x.ciudad || x.paisDestino || '';

    const g = { ...x, fechaInicio:ini, fechaFin:fin, identificador, programa, destino };
    GRUPOS.push(g);
    ID2GRUPO.set(g.id, g);
  });
  GRUPOS.sort((a,b)=> cmpISO(a.fechaInicio,b.fechaInicio));
}

async function loadSets(){
  SETS = [];
  const snap = await getDocs(collection(db,'conjuntosCoordinadores'));
  snap.forEach(d=>{
    const x = d.data(); x.id = d.id;
    x.viajes ||= []; x.confirmado = !!x.confirmado;
    SETS.push(x);
  });
  SETS.forEach(s=> s.viajes = s.viajes.filter(id=>ID2GRUPO.has(id)));
  evaluarAlertas();
  populateFilterOptions();
}

// ------------------------------
// DOM
// ------------------------------
const $ = sel => document.querySelector(sel);

const elWrapLibres = $('#lista-viajes-libres');
const elWrapSets   = $('#conjuntos-wrap');
const elMsg        = $('#msg');

const selDestino = $('#f-destino');
const selPrograma= $('#f-programa');
const inpDesde   = $('#f-desde');
const inpHasta   = $('#f-hasta');
const inpBuscar  = $('#f-buscar');
const wrapResumen= $('#resumen-wrap');

// NUEVO: estadísticas
const wrapStatsViajes = $('#stats-viajes-wrap');

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
$('#btn-sugerir').onclick        = sugerirConjuntos;
$('#btn-nuevo-conjunto').onclick = ()=>{ SETS.push({viajes:[], coordinadorId:null, confirmado:false, alertas:[]}); render(); };
$('#btn-guardar').onclick        = guardarTodo;

// Modal
btnOpenModal.onclick     = ()=>{ openModal(); renderCoordsTable(); };
btnCloseModal.onclick    = closeModal;
btnCerrar.onclick        = closeModal;
btnGuardarCoords.onclick = saveCoordsModal;
btnAddCoord.onclick      = ()=>{ COORDS.push({nombre:'', rut:'', telefono:'', correo:'', disponibilidad:[]}); renderCoordsTable(); };
btnAddLote.onclick       = ()=> inputExcel.click();
inputExcel.onchange      = handleExcel;

// ------------------------------
// Filtros + Resumen
// ------------------------------
function norm(s){ return (s??'').toString().trim().toLowerCase(); }
function parseTokens(s){ return (s||'').split(',').map(t=>norm(t)).filter(Boolean); }

function populateFilterOptions(){
  if (!selDestino || !selPrograma) return;
  const dests = [...new Set(GRUPOS.map(g=>g.destino).filter(Boolean))].sort();
  const progs = [...new Set(GRUPOS.map(g=>g.programa).filter(Boolean))].sort();
  selDestino.innerHTML = `<option value="">Todos los destinos</option>` + dests.map(d=>`<option>${escapeHtml(d)}</option>`).join('');
  selPrograma.innerHTML= `<option value="">Todos los programas</option>` + progs.map(p=>`<option>${escapeHtml(p)}</option>`).join('');

  selDestino.onchange = ()=>{ FILTER.destino = selDestino.value; render(); };
  selPrograma.onchange= ()=>{ FILTER.programa= selPrograma.value; render(); };
  inpDesde && (inpDesde.onchange = ()=>{ FILTER.desde = inpDesde.value||''; render(); });
  inpHasta && (inpHasta.onchange = ()=>{ FILTER.hasta = inpHasta.value||''; render(); });
  inpBuscar && (inpBuscar.oninput = ()=>{ FILTER.tokens = parseTokens(inpBuscar.value); render(); });
}

function matchFilter(g){
  if (FILTER.destino && !norm(g.destino).includes(norm(FILTER.destino))) return false;
  if (FILTER.programa && !norm(g.programa).includes(norm(FILTER.programa))) return false;
  if (FILTER.desde && g.fechaInicio < FILTER.desde) return false;
  if (FILTER.hasta && g.fechaInicio > FILTER.hasta) return false;
  if (FILTER.tokens?.length){
    const hay = [g.aliasGrupo,g.nombreGrupo,g.numeroNegocio,g.identificador,g.programa,g.destino].map(norm);
    const ok = FILTER.tokens.every(tok => hay.some(h=>h && h.includes(tok)));
    if (!ok) return false;
  }
  return true;
}
function gruposFiltrados(baseArr){ return (baseArr||GRUPOS).filter(matchFilter); }

function renderResumen(){
  if (!wrapResumen) return;
  const arr = gruposFiltrados(GRUPOS);
  const by = (keyFn)=> arr.reduce((m,g)=>{ const k=keyFn(g)||'(sin dato)'; m[k]=(m[k]||0)+1; return m; },{});
  const tDest = by(g=>g.destino);
  const tProg = by(g=>g.programa);
  const tIni  = by(g=>g.fechaInicio);

  const mkTable = (title, obj)=>`
    <div class="panel" style="min-width:260px">
      <div class="hd">${title}</div>
      <div class="bd">
        ${Object.keys(obj).length?`
          <table>
            <thead><tr><th>Clave</th><th style="width:72px">Total</th></tr></thead>
            <tbody>
              ${Object.entries(obj).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`
                <tr><td>${escapeHtml(k)}</td><td>${v}</td></tr>
              `).join('')}
            </tbody>
          </table>` : `<div class="empty">Sin datos.</div>`}
      </div>
    </div>`;
  wrapResumen.innerHTML = `
    <div class="row" style="gap:.8rem; align-items:flex-start; flex-wrap:wrap;">
      ${mkTable('Por destino', tDest)}
      ${mkTable('Por fecha de inicio', tIni)}
      ${mkTable('Por programa', tProg)}
    </div>
  `;
}

// ------------------------------
// Render principal
// ------------------------------
function render(){
  renderResumen();
  renderLibres();
  renderSets();
  renderViajesStats(); // NUEVO: estadísticas
  elMsg && (elMsg.textContent = '');
}

function viajesUsadosSetIds(){
  const used = new Set();
  SETS.forEach(s=> s.viajes.forEach(id=>used.add(id)));
  return used;
}

function renderLibres(){
  if (!elWrapLibres) return;
  const usados = viajesUsadosSetIds();
  const libresAll = GRUPOS.filter(g=>!usados.has(g.id));
  const libres = gruposFiltrados(libresAll);

  if (!libres.length){
    elWrapLibres.innerHTML = '<div class="empty">No hay viajes libres.</div>';
    return;
  }
  elWrapLibres.innerHTML = libres.map(g=>`
    <div class="card">
      <div class="hd">
        <div><b title="${escapeHtml(g.nombreGrupo||'')}">${g.aliasGrupo||'(sin alias)'}</b> <span class="muted">#${g.numeroNegocio}</span></div>
        <button class="btn small" data-add="${g.id}">Agregar a viaje…</button>
      </div>
      <div class="bd">
        <div class="muted">${g.fechaInicio} a ${g.fechaFin}</div>
        <div class="muted">${g.identificador?`ID: ${escapeHtml(g.identificador)} · `:''}${g.programa?`Prog: ${escapeHtml(g.programa)} · `:''}${g.destino?`Dest: ${escapeHtml(g.destino)}`:''}</div>
      </div>
    </div>
  `).join('');
  elWrapLibres.querySelectorAll('button[data-add]').forEach(btn=>{
    btn.onclick = ()=> seleccionarConjuntoDestino(btn.dataset.add);
  });
}

function renderSets(){
  if (!elWrapSets) return;
  if (!SETS.length){
    elWrapSets.innerHTML = '<div class="empty">Sin viajes asignados.</div>';
    return;
  }
  elWrapSets.innerHTML = '';

  SETS.forEach((s, idx)=>{
    const viajes = s.viajes.map(id=>ID2GRUPO.get(id)).filter(Boolean);

    const rows = viajes.map(v=>`
      <tr>
        <td style="width:34%"><input type="text" data-alias="${v.id}" value="${v.aliasGrupo||''}" title="${escapeHtml(v.nombreGrupo||'')}"></td>
        <td style="width:22%">${v.fechaInicio} → ${v.fechaFin}</td>
        <td style="width:28%">
          <div class="muted">#${v.numeroNegocio}</div>
          ${v.identificador? `<div class="muted">ID: ${escapeHtml(v.identificador)}</div>`:''}
          ${v.programa? `<div class="muted">Programa: ${escapeHtml(v.programa)}</div>`:''}
          ${v.destino? `<div class="muted">Destino: ${escapeHtml(v.destino)}</div>`:''}
        </td>
        <td style="width:16%">
          <button class="btn small" data-swap="${v.id}" data-set="${idx}">Swap</button>
          <button class="btn small" data-move="${v.id}" data-set="${idx}">Mover…</button>
          <button class="btn small" data-del="${v.id}" data-set="${idx}">Quitar</button>
        </td>
      </tr>
    `).join('');

    // select de coordinador (solo nombre)
    const opts = ['<option value="">(Seleccionar)</option>'].concat(
      COORDS.map(c=>{
        const name = escapeHtml(c.nombre||'(sin nombre)');
        const sel = (s.coordinadorId===c.id)?'selected':'';
        return `<option value="${c.id}" ${sel}>${name}</option>`;
      })
    ).join('');

    const alertas = (s.alertas||[]);
    const alertHtml = alertas.length
      ? `<div>${alertas.map(a=>`<div class="${a.tipo==='err'?'err':'warn'}">• ${a.msg}</div>`).join('')}</div>`
      : '<div class="muted">Sin alertas.</div>';

    elWrapSets.insertAdjacentHTML('beforeend', `
      <div class="card">
        <div class="hd">
          <div class="row">
            <span class="tag">Viajes ${idx+1}</span>
            ${s.confirmado ? '<span class="pill">Confirmado</span>' : ''}
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
          ${viajes.length ? `
            <table>
              <thead><tr><th>Alias</th><th>Fechas</th><th>Info</th><th>Acción</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          ` : `<div class="empty">Sin viajes en este grupo.</div>`}
          <div style="margin-top:.5rem">${alertHtml}</div>
        </div>
      </div>
    `);
  });

  // Handlers
  elWrapSets.querySelectorAll('input[data-alias]').forEach(inp=>{
    inp.onchange = ()=>{ const g=ID2GRUPO.get(inp.dataset.alias); if (g){ g.aliasGrupo = inp.value; } };
  });
  elWrapSets.querySelectorAll('button[data-del]').forEach(btn=>{
    btn.onclick = ()=>{ const i=+btn.dataset.set; SETS[i].viajes = SETS[i].viajes.filter(id=>id!==btn.dataset.del); evaluarAlertas(); render(); };
  });
  elWrapSets.querySelectorAll('button[data-move]').forEach(btn=>{
    btn.onclick = ()=>{ const i=+btn.dataset.set; moverViajeAotroConjunto(btn.dataset.move, i); };
  });
  elWrapSets.querySelectorAll('button[data-addv]').forEach(btn=>{
    btn.onclick = ()=> agregarViajeAConjunto(+btn.dataset.addv);
  });
  elWrapSets.querySelectorAll('button[data-delset]').forEach(btn=>{
    btn.onclick = ()=>{ const i=+btn.dataset.delset; if(!confirm('¿Eliminar este grupo de viajes?'))return; SETS.splice(i,1); evaluarAlertas(); render(); };
  });
  elWrapSets.querySelectorAll('button[data-sugerirc]').forEach(btn=>{
    btn.onclick = ()=> sugerirCoordinador(+btn.dataset.sugerirc);
  });
  elWrapSets.querySelectorAll('button[data-confirm]').forEach(btn=>{
    btn.onclick = ()=>{ const i=+btn.dataset.confirm; SETS[i].confirmado=!SETS[i].confirmado; render(); };
  });
  elWrapSets.querySelectorAll('select[data-coord]').forEach(sel=>{
    sel.onchange = ()=>{ const i=+sel.dataset.coord; SETS[i].coordinadorId = sel.value || null; evaluarAlertas(); render(); };
  });

  // Swap
  elWrapSets.querySelectorAll('button[data-swap]').forEach(btn=>{
    btn.onclick = ()=>{ const setIdx=+btn.dataset.set; const gid=btn.dataset.swap; handleSwapClick(setIdx, gid, btn); };
  });

  // Cancelar swap al hacer click fuera
  document.body.addEventListener('click', e=>{
    if (!e.target.closest('button[data-swap]')) {
      swapMode=false; swapFirst=null;
      elWrapSets.querySelectorAll('button[data-swap].selected-swap').forEach(b=> b.classList.remove('selected-swap'));
    }
  }, true);
}

// ------------------------------
// Sugerir grupos (UI: “Viajes”)
// ------------------------------
function sugerirConjuntos(){
  const ordenados = GRUPOS.slice().sort((a,b)=> cmpISO(a.fechaInicio, b.fechaInicio));
  const workSets = []; // [{viajes:[], lastFin, zeroChain}]
  for (const g of ordenados){
    let bestIdx=-1, bestAvail=null;
    for (let i=0;i<workSets.length;i++){
      const s=workSets[i];
      const gap=gapDays(s.lastFin,g.fechaInicio);
      const ok=(gap>=1)||(gap===0 && s.zeroChain<2);
      if(!ok) continue;
      const avail = addDaysISO(s.lastFin,1);
      if(bestIdx===-1 || cmpISO(avail,bestAvail)<0){ bestIdx=i; bestAvail=avail; }
    }
    if (bestIdx===-1) workSets.push({viajes:[g.id], lastFin:g.fechaFin, zeroChain:0});
    else { const s=workSets[bestIdx]; const gap=gapDays(s.lastFin,g.fechaInicio); s.viajes.push(g.id); s.zeroChain=(gap===0)?(s.zeroChain+1):0; s.lastFin=g.fechaFin; }
  }
  SETS = workSets.map(ws=>({ viajes:ws.viajes.slice(), coordinadorId:null, confirmado:false, alertas:[] }));
  evaluarAlertas(); render();
}

// ------------------------------
// Alertas
// ------------------------------
function evaluarAlertas(){
  SETS.forEach(s=> s.alertas=[]);
  SETS.forEach(s=>{
    const viajes = s.viajes.map(id=>ID2GRUPO.get(id)).filter(Boolean)
      .sort((a,b)=>cmpISO(a.fechaInicio,b.fechaInicio));
    s.viajes = viajes.map(v=>v.id);

    let consec=0;
    for (let i=0;i<viajes.length-1;i++){
      const A=viajes[i], B=viajes[i+1];
      if (overlap(A.fechaInicio,A.fechaFin,B.fechaInicio,B.fechaFin))
        s.alertas.push({tipo:'err', msg:`Solape entre ${A.aliasGrupo||A.nombreGrupo} y ${B.aliasGrupo||B.nombreGrupo}`});
      const gap=gapDays(A.fechaFin,B.fechaInicio);
      if (gap<0) s.alertas.push({tipo:'err', msg:`Orden inconsistente entre ${A.aliasGrupo||A.nombreGrupo} y ${B.aliasGrupo||B.nombreGrupo}`});
      else if (gap===0) consec++; else consec=0;
      if (consec>=2) s.alertas.push({tipo:'warn', msg:`3 viajes seguidos sin día de descanso`});
    }
    if (s.coordinadorId){
      const coord = COORDS.find(c=>c.id===s.coordinadorId);
      if (coord){
        viajes.forEach(v=>{
          if (!inAnyRange(v.fechaInicio,v.fechaFin,coord.disponibilidad||[]))
            s.alertas.push({tipo:'warn', msg:`Coordinador fuera de disponibilidad en ${v.aliasGrupo||v.nombreGrupo}`});
        });
      }
    }
  });
  for (let i=0;i<SETS.length;i++){
    for (let j=i+1;j<SETS.length;j++){
      const A=SETS[i], B=SETS[j];
      if (!A.coordinadorId || A.coordinadorId!==B.coordinadorId) continue;
      const viajesA=A.viajes.map(id=>ID2GRUPO.get(id)).filter(Boolean);
      const viajesB=B.viajes.map(id=>ID2GRUPO.get(id)).filter(Boolean);
      const pisado = viajesA.some(a=> viajesB.some(b=> overlap(a.fechaInicio,a.fechaFin,b.fechaInicio,b.fechaFin)));
      if (pisado){
        const name=(COORDS.find(c=>c.id===A.coordinadorId)?.nombre)||'(coordinador)';
        A.alertas.push({tipo:'err', msg:`${name} también asignado en Viajes ${j+1} con fechas que se cruzan`});
        B.alertas.push({tipo:'err', msg:`${name} también asignado en Viajes ${i+1} con fechas que se cruzan`});
      }
    }
  }
}

// ------------------------------
// Acciones sobre viajes
// ------------------------------
function seleccionarConjuntoDestino(grupoId){
  if (!SETS.length){ alert('Primero crea un grupo de viajes.'); return; }
  const n = prompt(`¿A qué grupo mover este viaje? (1..${SETS.length})`);
  if (!n) return;
  const idx=(+n)-1;
  if (idx<0||idx>=SETS.length){ alert('Número inválido'); return; }
  if (SETS.some(s=>s.viajes.includes(grupoId))){
    SETS.forEach(s=> s.viajes = s.viajes.filter(id=>id!==grupoId));
  }
  SETS[idx].viajes.push(grupoId);
  evaluarAlertas(); render();
}
function moverViajeAotroConjunto(grupoId, desdeIdx){
  if (SETS.length<=1){ alert('No hay otro grupo.'); return; }
  const n = prompt(`Mover al grupo (1..${SETS.length}, distinto de ${desdeIdx+1})`);
  if (!n) return;
  const to=(+n)-1;
  if (to===desdeIdx||to<0||to>=SETS.length){ alert('Número inválido'); return; }
  SETS[desdeIdx].viajes = SETS[desdeIdx].viajes.filter(id=>id!==grupoId);
  SETS[to].viajes.push(grupoId);
  evaluarAlertas(); render();
}
function agregarViajeAConjunto(setIdx){
  const usados = viajesUsadosSetIds();
  const libresAll = GRUPOS.filter(g=>!usados.has(g.id));
  const libres = gruposFiltrados(libresAll);
  if (!libres.length){ alert('No quedan viajes libres con los filtros actuales.'); return; }
  const listado = libres.map((g,i)=>`${i+1}) ${g.aliasGrupo||g.nombreGrupo} [${g.fechaInicio}→${g.fechaFin}] • #${g.numeroNegocio} • ${g.programa||''} • ${g.destino||''}`).join('\n');
  const n = prompt(`Selecciona # de viaje a agregar (filtrado):\n${listado}`);
  if (!n) return;
  const i=(+n)-1;
  if (i<0||i>=libres.length) return;
  SETS[setIdx].viajes.push(libres[i].id);
  evaluarAlertas(); render();
}

// Swap
function handleSwapClick(setIdx, grupoId, btn){
  if (!swapMode){
    swapMode=true; swapFirst={setIdx, grupoId};
    elWrapSets.querySelectorAll('button[data-swap].selected-swap').forEach(b=> b.classList.remove('selected-swap'));
    btn.classList.add('selected-swap'); return;
  }
  if (swapFirst && (swapFirst.setIdx!==setIdx || swapFirst.grupoId!==grupoId)){
    swapBetweenSets(swapFirst, { setIdx, grupoId });
  }
  swapMode=false; swapFirst=null;
  elWrapSets.querySelectorAll('button[data-swap].selected-swap').forEach(b=> b.classList.remove('selected-swap'));
}
function swapBetweenSets(a,b){
  SETS[a.setIdx].viajes = SETS[a.setIdx].viajes.filter(id=>id!==a.grupoId);
  SETS[b.setIdx].viajes = SETS[b.setIdx].viajes.filter(id=>id!==b.grupoId);
  SETS[a.setIdx].viajes.push(b.grupoId);
  SETS[b.setIdx].viajes.push(a.grupoId);
  evaluarAlertas(); render();
}

// Sugerir coordinador para todo el grupo
function sugerirCoordinador(setIdx){
  const s=SETS[setIdx];
  const viajes=s.viajes.map(id=>ID2GRUPO.get(id)).filter(Boolean);
  const ok=COORDS.filter(c=> viajes.every(v=> inAnyRange(v.fechaInicio,v.fechaFin,c.disponibilidad||[])));
  if (!ok.length){ alert('No hay ninguno que cubra todo el grupo.'); return; }
  s.coordinadorId = ok[0].id; evaluarAlertas(); render();
}

// ------------------------------
// Guardado
// ------------------------------
async function guardarTodo(){
  elMsg && (elMsg.textContent='Guardando…');

  // 1) Alias
  for (const g of GRUPOS){ await updateDoc(doc(db,'grupos', g.id), { aliasGrupo: g.aliasGrupo || null }); }

  // 2) Conjuntos/Viajes y refs en grupos
  for (const s of SETS){
    let setId = s.id;
    const payload = { viajes:s.viajes.slice(), coordinadorId:s.coordinadorId||null, confirmado:!!s.confirmado, meta:{actualizadoEn:serverTimestamp()} };
    if (!setId){
      const ref = await addDoc(collection(db,'conjuntosCoordinadores'), { ...payload, meta:{ creadoEn:serverTimestamp(), actualizadoEn:serverTimestamp() } });
      setId=ref.id; s.id=setId;
    } else {
      await setDoc(doc(db,'conjuntosCoordinadores', setId), payload, { merge:true });
    }
    for (const gid of s.viajes){
      await updateDoc(doc(db,'grupos', gid), { conjuntoId:setId, coordinador:s.coordinadorId||null });
    }
  }

  // 3) Limpiar grupos sin set
  const usados = viajesUsadosSetIds();
  for (const g of GRUPOS){
    if (!usados.has(g.id)){
      await updateDoc(doc(db,'grupos', g.id), { conjuntoId:null, coordinador:null });
    }
  }
  elMsg && (elMsg.textContent='✅ Cambios guardados');
  setTimeout(()=> elMsg && (elMsg.textContent=''), 2000);
}

// ------------------------------
// Modal coordinadores
// ------------------------------
function openModal(){ mb.style.display='block'; modal.style.display='block'; }
function closeModal(){ modal.style.display='none'; mb.style.display='none'; }

function renderCoordsTable(){
  tbodyCoords.innerHTML = '';
  hintEmptyCoords.style.display = COORDS.length ? 'none' : 'block';

  COORDS.forEach((c, idx)=>{
    const filasRangos = (c.disponibilidad||[]).map((r,i)=>`
      <div style="display:flex; gap:.3rem; align-items:center; margin:.15rem 0;">
        <input class="picker-range" data-cid="${idx}" data-ridx="${i}" type="text" value="${r.inicio && r.fin ? `${r.inicio} a ${r.fin}` : ''}" readonly>
        <button class="btn small" data-delrng="${idx}:${i}">❌</button>
      </div>
    `).join('');

    tbodyCoords.insertAdjacentHTML('beforeend', `
      <tr>
        <td><input type="text" data-f="nombre"   data-i="${idx}" value="${c.nombre||''}"   placeholder="Nombre"></td>
        <td><input type="text" data-f="rut"      data-i="${idx}" value="${c.rut||''}"      placeholder="RUT"></td>
        <td><input type="text" data-f="telefono" data-i="${idx}" value="${c.telefono||''}" placeholder="Teléfono"></td>
        <td><input type="text" data-f="correo"   data-i="${idx}" value="${c.correo||''}"   placeholder="Correo"></td>
        <td>${filasRangos}<button class="btn small" data-addrng="${idx}">+ Rango</button></td>
        <td><button class="btn small" data-delcoord="${idx}">🗑️</button></td>
      </tr>
    `);
  });

  // inputs base
  tbodyCoords.querySelectorAll('input[data-f]').forEach(inp=>{
    inp.onchange = ()=> { const i=+inp.dataset.i, f=inp.dataset.f; COORDS[i][f] = inp.value; };
  });

  // add rango
  tbodyCoords.querySelectorAll('button[data-addrng]').forEach(btn=>{
    btn.onclick = ()=>{ const i=+btn.dataset.addrng; COORDS[i].disponibilidad ||= []; COORDS[i].disponibilidad.push({inicio:'', fin:''}); renderCoordsTable(); setTimeout(initPickers,10); };
  });

  // del rango
  tbodyCoords.querySelectorAll('button[data-delrng]').forEach(btn=>{
    btn.onclick = ()=>{ const [i,j]=btn.dataset.delrng.split(':').map(n=>+n); COORDS[i].disponibilidad.splice(j,1); renderCoordsTable(); setTimeout(initPickers,10); };
  });

  // del coordinador
  tbodyCoords.querySelectorAll('button[data-delcoord]').forEach(btn=>{
    btn.onclick = async ()=>{ const i=+btn.dataset.delcoord; if (COORDS[i].id){ await deleteDoc(doc(db,'coordinadores', COORDS[i].id)); } COORDS.splice(i,1); renderCoordsTable(); setTimeout(initPickers,10); };
  });

  initPickers();
}

function initPickers(){
  tbodyCoords.querySelectorAll('.picker-range').forEach(inp=>{
    if (inp._flatpickr) inp._flatpickr.destroy();
    flatpickr(inp, {
      mode:'range', dateFormat:'Y-m-d',
      onClose:(sel)=>{
        if (sel.length===2){
          const inicio=toISO(sel[0]), fin=toISO(sel[1]);
          const i=+inp.dataset.cid, j=+inp.dataset.ridx;
          COORDS[i].disponibilidad[j]={inicio,fin};
          inp.value = `${inicio} a ${fin}`;
        }
      }
    });
  });
}

// Normalizadores + dedup
function normRut(r){ return (r||'').replace(/\s+/g,'').toUpperCase(); }
function normEmail(e){ return (e||'').trim().toLowerCase(); }
function cleanRanges(arr){
  return (arr||[])
    .map(r=>({ inicio: asISO(r.inicio)||null, fin: asISO(r.fin)||null }))
    .filter(r=>r.inicio && r.fin && (new Date(r.inicio)<=new Date(r.fin)));
}
async function findCoordId({rut, nombre}) {
  if (rut) { const q1=query(collection(db,'coordinadores'), where('rut','==',rut)); const s1=await getDocs(q1); if(!s1.empty) return s1.docs[0].id; }
  if (nombre) { const q2=query(collection(db,'coordinadores'), where('nombre','==',nombre)); const s2=await getDocs(q2); if(!s2.empty) return s2.docs[0].id; }
  return null;
}

async function saveCoordsModal(){
  for (const c of COORDS){
    const nombre=(c.nombre||'').trim(); if (!nombre) continue;
    const payload = {
      nombre,
      rut: normRut(c.rut),
      telefono: (c.telefono||'').trim(),
      correo: normEmail(c.correo),
      disponibilidad: cleanRanges(c.disponibilidad),
      activo: (c.activo!==false),
      notas: (c.notas||'').trim(),
      'meta.actualizadoEn': serverTimestamp()
    };
    let id = c.id || await findCoordId({ rut: payload.rut, nombre: payload.nombre });
    if (id){ await setDoc(doc(db,'coordinadores', id), payload, { merge:true }); c.id=id; }
    else { const ref=await addDoc(collection(db,'coordinadores'), { ...payload, meta:{ creadoEn:serverTimestamp(), actualizadoEn:serverTimestamp() } }); c.id=ref.id; }
  }
  await loadCoordinadores();
  closeModal(); evaluarAlertas(); render();
}

function handleExcel(evt){
  const file = evt.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = (e)=>{
    const wb = XLSX.read(e.target.result, {type:'binary'});
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, {defval:''});
    const ya = new Set(COORDS.map(c=> (c.nombre||'').trim().toUpperCase()));
    rows.forEach(r=>{
      const nombre = (r.Nombre||r.nombre||'').toString().trim(); if (!nombre) return;
      const key = nombre.toUpperCase(); if (ya.has(key)) return;
      COORDS.push({
        nombre,
        rut: (r.RUT||r.rut||'').toString().trim(),
        telefono: (r.Teléfono||r.Telefono||r.telefono||'').toString().trim(),
        correo: (r.Correo||r.correo||'').toString().trim(),
        disponibilidad:[]
      });
      ya.add(key);
    });
    renderCoordsTable(); setTimeout(initPickers,10);
    inputExcel.value='';
  };
  reader.readAsBinaryString(file);
}

// ------------------------------
// Estadísticas de VIAJES
// ------------------------------
function computeViajesStats(){
  const sizes = SETS.map(s => (s.viajes||[]).length);
  const totalGrupos = sizes.length;
  const totalTramos = sizes.reduce((a,b)=>a+b,0);

  const dist = {}; sizes.forEach(n => { dist[n] = (dist[n]||0) + 1; });

  let paresSinDescanso = 0;
  let gruposConGap0 = 0;
  let paresSolapados = 0;
  let paresOrdenMalo = 0;

  let totalErr = 0, totalWarn = 0;
  let confirmados = 0;
  let conCoordinador = 0;
  const coordsAsignados = new Set();

  for (const s of SETS){
    const viajes = (s.viajes||[])
      .map(id => ID2GRUPO.get(id))
      .filter(Boolean)
      .sort((a,b)=> new Date(a.fechaInicio) - new Date(b.fechaInicio));

    if (s.confirmado) confirmados++;
    if (s.coordinadorId){ conCoordinador++; coordsAsignados.add(s.coordinadorId); }
    (s.alertas||[]).forEach(a => (a.tipo==='err'? totalErr++ : totalWarn++));

    let tuvoGap0 = false;
    for (let i=0;i<viajes.length-1;i++){
      const A = viajes[i], B = viajes[i+1];
      const gap = gapDays(A.fechaFin, B.fechaInicio);
      if (gap < 0) paresOrdenMalo++;
      if (gap === 0){ paresSinDescanso++; tuvoGap0 = true; }
      if (overlap(A.fechaInicio, A.fechaFin, B.fechaInicio, B.fechaFin)) paresSolapados++;
    }
    if (tuvoGap0) gruposConGap0++;
  }

  const min = sizes.length ? Math.min(...sizes) : 0;
  const max = sizes.length ? Math.max(...sizes) : 0;
  const promedio = totalGrupos ? (totalTramos / totalGrupos) : 0;
  const mediana = (() => {
    if (!sizes.length) return 0;
    const s = sizes.slice().sort((a,b)=>a-b);
    const m = Math.floor(s.length/2);
    return s.length%2 ? s[m] : (s[m-1]+s[m])/2;
  })();

  return {
    totalGrupos, totalTramos, dist,
    min, max, promedio, mediana,
    paresSinDescanso, gruposConGap0, paresSolapados, paresOrdenMalo,
    totalErr, totalWarn, confirmados, conCoordinador,
    coordsUnicos: coordsAsignados.size
  };
}

function renderViajesStats(){
  if (!wrapStatsViajes) return;
  if (!SETS.length){
    wrapStatsViajes.innerHTML = '<div class="empty">AÚN NO HAY GRUPOS DE VIAJES.</div>';
    return;
  }
  const s = computeViajesStats();

  const tbl = (title, rowsHtml) => `
    <div class="panel" style="min-width:280px">
      <div class="hd">${title}</div>
      <div class="bd">${rowsHtml}</div>
    </div>`;

  const rowsKV = (kv) => `
    <table>
      <thead><tr><th>CLAVE</th><th style="width:90px">TOTAL</th></tr></thead>
      <tbody>${Object.entries(kv).map(([k,v]) => `<tr><td>${escapeHtml(String(k))}</td><td>${v}</td></tr>`).join('')}</tbody>
    </table>`;

  const totales = `
    <table>
      <tbody>
        <tr><th>TOTAL DE VIAJES (GRUPOS)</th><td>${s.totalGrupos}</td></tr>
        <tr><th>TOTAL DE TRAMOS (VIAJES ASIGNADOS)</th><td>${s.totalTramos}</td></tr>
        <tr><th>PROMEDIO TRAMOS POR VIAJE</th><td>${s.promedio.toFixed(2)}</td></tr>
        <tr><th>MEDIANA TRAMOS POR VIAJE</th><td>${s.mediana}</td></tr>
        <tr><th>MÁXIMO / MÍNIMO TRAMOS</th><td>${s.max} / ${s.min}</td></tr>
      </tbody>
    </table>`;

  const distOrdenada = Object.fromEntries(
    Object.entries(s.dist)
      .sort((a,b)=> Number(b[0]) - Number(a[0]))
      .map(([tam,cant]) => [`${tam} TRAMO${tam==1?'':'S'}`, cant])
  );

  const consistencia = `
    <table>
      <tbody>
        <tr><th>PARES SIN DESCANSO (GAP = 0)</th><td>${s.paresSinDescanso}</td></tr>
        <tr><th>VIAJES CON AL MENOS UN GAP = 0</th><td>${s.gruposConGap0}</td></tr>
        <tr><th>PARES SOLAPADOS</th><td>${s.paresSolapados}</td></tr>
        <tr><th>PARES EN ORDEN INCONSISTENTE</th><td>${s.paresOrdenMalo}</td></tr>
        <tr><th>ALERTAS (ERR / WARN)</th><td>${s.totalErr} / ${s.totalWarn}</td></tr>
      </tbody>
    </table>`;

  const asignaciones = `
    <table>
      <tbody>
        <tr><th>VIAJES CONFIRMADOS</th><td>${s.confirmados}</td></tr>
        <tr><th>VIAJES CON COORDINADOR</th><td>${s.conCoordinador}</td></tr>
        <tr><th>COORDINADORES ÚNICOS ASIGNADOS</th><td>${s.coordsUnicos}</td></tr>
      </tbody>
    </table>`;

  wrapStatsViajes.innerHTML = `
    <div class="row" style="gap:.8rem; align-items:flex-start; flex-wrap:wrap;">
      ${tbl('TOTALES', totales)}
      ${tbl('DISTRIBUCIÓN POR TAMAÑO (TRAMOS POR VIAJE)', rowsKV(distOrdenada))}
      ${tbl('CONSISTENCIA / ALERTAS', consistencia)}
      ${tbl('ASIGNACIONES', asignaciones)}
    </div>
  `;
}

// ------------------------------
// Utils
// ------------------------------
function limpiarAlias(nombreCompleto){
  return (nombreCompleto||'')
    .replace(/\d{4}/g,'')
    .replace(/\b(colegio|instituto|escuela|curso|año|de|del|la|el|los)\b/gi,'')
    .replace(/[^\w\s]/g,'')
    .replace(/\s+/g,' ')
    .trim();
}
function escapeHtml(s){ return (s||'').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

// ------------------------------
// Boot
// ------------------------------
window.addEventListener('DOMContentLoaded', async ()=>{
  await loadCoordinadores();
  await loadGrupos();
  await loadSets();
  populateFilterOptions();
  render();
});
