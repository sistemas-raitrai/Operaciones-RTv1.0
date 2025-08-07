// coordinadores.js
// - Conjuntos de viajes en cards (como hoteles).
// - Modal para gestionar coordinadores (manual + Excel).
// - Guardado en Firestore: conjuntosCoordinadores + actualiza grupo.coordinador / grupo.conjuntoId.

import { app, db } from './firebase-init.js';
import {
  collection, getDocs, addDoc, doc, updateDoc, setDoc, deleteDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

// ------------------------------
// Estado
// ------------------------------
let COORDS = [];   // [{id?, nombre, rut, correo, fechasDisponibles:[{inicio,fin}]}]
let GRUPOS = [];   // [{id, numeroNegocio, nombreGrupo, aliasGrupo, fechaInicio, fechaFin}]
let SETS = [];     // [{id?, viajes:[grupoId], coordinadorId:null, confirmado:false, alertas:[]}]
let ID2GRUPO = new Map();

// ------------------------------
// Helpers fecha
// ------------------------------
const toISO = d => (new Date(d)).toISOString().slice(0,10);
const addDaysISO = (iso, n) => {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return toISO(d);
};
const cmpISO = (a,b) => (new Date(a) - new Date(b));
const overlap = (a1,a2,b1,b2) => !(new Date(a2) < new Date(b1) || new Date(b2) < new Date(a1));
const inAnyRange = (ini, fin, ranges=[]) =>
  ranges.some(r => new Date(ini)>=new Date(r.inicio) && new Date(fin)<=new Date(r.fin));

function gapDays(finA, iniB){ // días de descanso entre viajes (excluye el día fin y el día inicio)
  const A = new Date(finA + 'T00:00:00');
  const B = new Date(iniB + 'T00:00:00');
  return Math.round((B - A)/86400000) - 1;
}

function normalizarFechasGrupo(x) {
  // 1) Si ya vienen fechas normalizadas
  let ini = x.fechaInicio || x.fecha_inicio || x.inicio || x.fecha || x.fechaDeViaje;
  let fin = x.fechaFin || x.fecha_fin || x.fin;

  // 2) Si hay itinerario: usa el primer y último día como rango
  if ((!ini || !fin) && x.itinerario && typeof x.itinerario === 'object') {
    const keys = Object.keys(x.itinerario)
      .filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k))
      .sort();
    if (keys.length) {
      ini = ini || keys[0];
      fin = fin || keys[keys.length - 1];
    }
  }

  // 3) Si solo hay fechaDeViaje + duracion/noches
  if (ini && !fin && (x.duracion || x.noches)) {
    const days = Number(x.duracion) || (Number(x.noches) + 1) || 1;
    fin = addDaysISO(ini, days - 1);
  }

  return { ini, fin };
}

// ------------------------------
// Carga datos
// ------------------------------
async function loadCoordinadores(){
  COORDS = [];
  const snap = await getDocs(collection(db,'coordinadores'));
  snap.forEach(d=>{
    const x = d.data();
    x.id = d.id;
    x.fechasDisponibles ||= [];
    COORDS.push(x);
  });
}

async function loadGrupos(){
  GRUPOS = [];
  ID2GRUPO.clear();

  const snap = await getDocs(collection(db,'grupos'));
  snap.forEach(d=>{
    const x = d.data();
    x.id = d.id;
    x.numeroNegocio = x.numeroNegocio || d.id;
    x.aliasGrupo = x.aliasGrupo || limpiarAlias(x.nombreGrupo || '');

    const { ini, fin } = normalizarFechasGrupo(x);
    if (!ini || !fin) {
      // grupo sin rango utilizable -> lo ignoramos
      console.warn('Grupo sin rango de fechas, omitido:', x.numeroNegocio || x.id, x);
      return;
    }

    x.fechaInicio = ini;
    x.fechaFin = fin;

    GRUPOS.push(x);
    ID2GRUPO.set(x.id, x);
  });

  GRUPOS.sort((a,b)=>cmpISO(a.fechaInicio,b.fechaInicio));

  console.log(`GRUPOS cargados: ${GRUPOS.length}`);
}

async function loadSets(){
  SETS = [];
  const snap = await getDocs(collection(db,'conjuntosCoordinadores'));
  snap.forEach(d=>{
    const x = d.data();
    x.id = d.id;
    x.viajes ||= [];
    x.confirmado = !!x.confirmado;
    SETS.push(x);
  });
  // Elimina ids de viajes que ya no existan en la base (por seguridad)
  SETS.forEach(s=> s.viajes = s.viajes.filter(id=>ID2GRUPO.has(id)));
  evaluarAlertas();
}

// ------------------------------
// UI: referencias
// ------------------------------
const $ = sel => document.querySelector(sel);
const elWrapLibres = $('#lista-viajes-libres');
const elWrapSets = $('#conjuntos-wrap');
const elMsg = $('#msg');

// Modal
const mb = $('#mb');
const modal = $('#modal-coords');
const btnOpenModal = $('#btn-modal-coords');
const btnCloseModal = $('#close-modal');
const btnCerrar = $('#btn-cerrar');
const btnGuardarCoords = $('#btn-guardar-coords');
const btnAddCoord = $('#btn-add-coord');
const btnAddLote = $('#btn-add-lote');
const inputExcel = $('#input-excel');
const tbodyCoords = $('#tabla-coords tbody');
const hintEmptyCoords = $('#hint-empty-coords');

// Toolbar
$('#btn-sugerir').onclick = sugerirConjuntos;
$('#btn-nuevo-conjunto').onclick = ()=>{ SETS.push({viajes:[], coordinadorId:null, confirmado:false}); render(); };
$('#btn-guardar').onclick = guardarTodo;

// Modal handlers
btnOpenModal.onclick = ()=>{ openModal(); renderCoordsTable(); };
btnCloseModal.onclick = closeModal;
btnCerrar.onclick = closeModal;
btnGuardarCoords.onclick = saveCoordsModal;
btnAddCoord.onclick = ()=>{ COORDS.push({nombre:'', rut:'', correo:'', fechasDisponibles:[]}); renderCoordsTable(); };
btnAddLote.onclick = ()=> inputExcel.click();
inputExcel.onchange = handleExcel;

// ------------------------------
// Render principal
// ------------------------------
function render(){
  renderLibres();
  renderSets();
  elMsg.textContent = '';
}

function viajesUsadosSetIds(){
  const used = new Set();
  SETS.forEach(s=> s.viajes.forEach(id=>used.add(id)));
  return used;
}

function renderLibres(){
  const usados = viajesUsadosSetIds();
  const libres = GRUPOS.filter(g=>!usados.has(g.id));
  if (!libres.length){
    elWrapLibres.innerHTML = '<div class="empty">No hay viajes libres.</div>';
    return;
  }
  elWrapLibres.innerHTML = libres.map(g=>`
    <div class="card">
      <div class="hd">
        <div><b>${g.aliasGrupo||'(sin alias)'}</b> <span class="muted">#${g.numeroNegocio}</span></div>
        <button class="btn small" data-add="${g.id}">Agregar a conjunto…</button>
      </div>
      <div class="bd">
        <div class="muted">${g.fechaInicio} a ${g.fechaFin}</div>
      </div>
    </div>
  `).join('');
  elWrapLibres.querySelectorAll('button[data-add]').forEach(btn=>{
    btn.onclick = ()=> seleccionarConjuntoDestino(btn.dataset.add);
  });
}

function renderSets(){
  if (!SETS.length){
    elWrapSets.innerHTML = '<div class="empty">Sin conjuntos.</div>';
    return;
  }
  elWrapSets.innerHTML = '';
  SETS.forEach((s, idx)=>{
    const viajes = s.viajes.map(id=>ID2GRUPO.get(id)).filter(Boolean);
    // lista viajes
    const rows = viajes.map(v=>`
      <tr>
        <td style="width:36%"><input type="text" data-alias="${v.id}" value="${v.aliasGrupo||''}"></td>
        <td style="width:24%">${v.fechaInicio} → ${v.fechaFin}</td>
        <td style="width:24%"><span class="muted">#${v.numeroNegocio}</span></td>
        <td style="width:16%">
          <button class="btn small" data-move="${v.id}" data-set="${idx}">Mover…</button>
          <button class="btn small" data-del="${v.id}" data-set="${idx}">Quitar</button>
        </td>
      </tr>
    `).join('');

    // opciones de coordinador
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
            <span class="tag">Conjunto ${idx+1}</span>
            ${s.confirmado ? '<span class="pill">Confirmado</span>' : ''}
          </div>
          <div class="row">
            <select data-coord="${idx}" title="Coordinador del conjunto">${opts}</select>
            <button class="btn small" data-addv="${idx}">Agregar viaje</button>
            <button class="btn small" data-sugerirc="${idx}">Sugerir coord</button>
            <button class="btn small ${s.confirmado?'secondary':''}" data-confirm="${idx}">${s.confirmado?'Desconfirmar':'Confirmar'}</button>
            <button class="btn small" data-delset="${idx}">Eliminar</button>
          </div>
        </div>
        <div class="bd">
          ${viajes.length ? `
            <table>
              <thead><tr><th>Alias</th><th>Fechas</th><th>#Negocio</th><th>Acción</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          ` : `<div class="empty">Sin viajes en este conjunto.</div>`}
          <div style="margin-top:.5rem">${alertHtml}</div>
        </div>
      </div>
    `);
  });

  // Handlers alias
  elWrapSets.querySelectorAll('input[data-alias]').forEach(inp=>{
    inp.onchange = ()=>{
      const g = ID2GRUPO.get(inp.dataset.alias);
      if (g){ g.aliasGrupo = inp.value; }
    };
  });

  // Handlers acciones
  elWrapSets.querySelectorAll('button[data-del]').forEach(btn=>{
    btn.onclick = ()=>{
      const setIndex = +btn.dataset.set;
      SETS[setIndex].viajes = SETS[setIndex].viajes.filter(id=>id!==btn.dataset.del);
      evaluarAlertas(); render();
    };
  });
  elWrapSets.querySelectorAll('button[data-move]').forEach(btn=>{
    btn.onclick = ()=>{
      const setIndex = +btn.dataset.set;
      moverViajeAotroConjunto(btn.dataset.move, setIndex);
    };
  });
  elWrapSets.querySelectorAll('button[data-addv]').forEach(btn=>{
    btn.onclick = ()=> agregarViajeAConjunto(+btn.dataset.addv);
  });
  elWrapSets.querySelectorAll('button[data-delset]').forEach(btn=>{
    btn.onclick = ()=>{
      const i = +btn.dataset.delset;
      if (!confirm('¿Eliminar este conjunto?')) return;
      SETS.splice(i,1);
      evaluarAlertas(); render();
    };
  });
  elWrapSets.querySelectorAll('button[data-sugerirc]').forEach(btn=>{
    btn.onclick = ()=> sugerirCoordinador(+btn.dataset.sugerirc);
  });
  elWrapSets.querySelectorAll('button[data-confirm]').forEach(btn=>{
    btn.onclick = ()=>{
      const i = +btn.dataset.confirm;
      SETS[i].confirmado = !SETS[i].confirmado;
      render();
    };
  });
  elWrapSets.querySelectorAll('select[data-coord]').forEach(sel=>{
    sel.onchange = ()=>{
      const i = +sel.dataset.coord;
      SETS[i].coordinadorId = sel.value || null;
      evaluarAlertas(); render();
    };
  });
}

// ------------------------------
// Sugerir conjuntos (greedy con 1 día descanso)
// ------------------------------
function sugerirConjuntos(){
  const usados = new Set();
  const ordenados = GRUPOS.slice().sort((a,b)=>cmpISO(a.fechaInicio,b.fechaInicio));
  const sets = [];

  for (const g of ordenados){
    if (usados.has(g.id)) continue;
    // intenta poner en un set existente que termine antes con 1 día libre
    let puesto = false;
    for (const s of sets){
      const last = ID2GRUPO.get(s.viajes[s.viajes.length-1]);
      if (cmpISO(addDaysISO(last.fechaFin,1), g.fechaInicio) <= 0){ // >=1 día descanso
        s.viajes.push(g.id); usados.add(g.id); puesto = true; break;
      }
    }
    if (!puesto){ sets.push({viajes:[g.id], coordinadorId:null, confirmado:false}); usados.add(g.id); }
  }
  SETS = sets;
  evaluarAlertas(); render();
}

// ------------------------------
// Alertas por conjunto
// ------------------------------
function evaluarAlertas(){
  // Limpia alertas
  SETS.forEach(s=> s.alertas=[]);

  // 1) Alertas internas del conjunto (solapes / sin descanso / orden)
  SETS.forEach(s=>{
    const viajes = s.viajes.map(id=>ID2GRUPO.get(id)).filter(Boolean)
      .sort((a,b)=>cmpISO(a.fechaInicio,b.fechaInicio));
    s.viajes = viajes.map(v=>v.id); // asegura orden
    // pares consecutivos
    let consecSinDesc = 0;
    for (let i=0;i<viajes.length-1;i++){
      const A = viajes[i], B = viajes[i+1];
      if (overlap(A.fechaInicio,A.fechaFin,B.fechaInicio,B.fechaFin)){
        s.alertas.push({tipo:'err', msg:`Solape entre ${A.aliasGrupo||A.nombreGrupo} y ${B.aliasGrupo||B.nombreGrupo}`});
      }
      const gap = gapDays(A.fechaFin, B.fechaInicio);
      if (gap < 0) {
        s.alertas.push({tipo:'err', msg:`Orden inconsistente entre ${A.aliasGrupo||A.nombreGrupo} y ${B.aliasGrupo||B.nombreGrupo}`});
      } else if (gap === 0){
        consecSinDesc++;
      } else {
        consecSinDesc = 0;
      }
      if (consecSinDesc >= 2){
        s.alertas.push({tipo:'warn', msg:`3 viajes seguidos sin día de descanso`});
      }
    }

    // 2) Disponibilidad del coordinador para TODO el rango de cada viaje
    if (s.coordinadorId){
      const coord = COORDS.find(c=>c.id===s.coordinadorId);
      if (coord){
        viajes.forEach(v=>{
          if (!inAnyRange(v.fechaInicio, v.fechaFin, coord.fechasDisponibles||[])){
            s.alertas.push({tipo:'warn', msg:`Coordinador fuera de disponibilidad en ${v.aliasGrupo||v.nombreGrupo}`});
          }
        });
      }
    }
  });

  // 3) Doble asignación de un mismo coordinador en fechas que se pisan entre conjuntos
  for (let i=0;i<SETS.length;i++){
    for (let j=i+1;j<SETS.length;j++){
      const A = SETS[i], B = SETS[j];
      if (!A.coordinadorId || A.coordinadorId!==B.coordinadorId) continue;
      // ¿pisa alguna pareja de viajes?
      const viajesA = A.viajes.map(id=>ID2GRUPO.get(id)).filter(Boolean);
      const viajesB = B.viajes.map(id=>ID2GRUPO.get(id)).filter(Boolean);
      const pisado = viajesA.some(a => viajesB.some(b => overlap(a.fechaInicio,a.fechaFin,b.fechaInicio,b.fechaFin)));
      if (pisado){
        const name = (COORDS.find(c=>c.id===A.coordinadorId)?.nombre)||'(coordinador)';
        A.alertas.push({tipo:'err', msg:`${name} también asignado en Conjunto ${j+1} con fechas que se cruzan`});
        B.alertas.push({tipo:'err', msg:`${name} también asignado en Conjunto ${i+1} con fechas que se cruzan`});
      }
    }
  }
}

// ------------------------------
// Acciones sobre viajes
// ------------------------------
function seleccionarConjuntoDestino(grupoId){
  if (!SETS.length){ alert('Primero crea un conjunto.'); return; }
  const n = prompt(`¿A qué conjunto mover este viaje? (1..${SETS.length})`);
  if (!n) return;
  const idx = (+n)-1;
  if (idx<0 || idx>=SETS.length){ alert('Número inválido'); return; }
  if (SETS.some(s=>s.viajes.includes(grupoId))){
    // ya existe en algún set → muévelo
    SETS.forEach(s=> s.viajes = s.viajes.filter(id=>id!==grupoId));
  }
  SETS[idx].viajes.push(grupoId);
  evaluarAlertas(); render();
}

function moverViajeAotroConjunto(grupoId, desdeIdx){
  if (SETS.length<=1){ alert('No hay otro conjunto.'); return; }
  const n = prompt(`Mover al conjunto (1..${SETS.length}, distinto de ${desdeIdx+1})`);
  if (!n) return;
  const to = (+n)-1;
  if (to===desdeIdx || to<0 || to>=SETS.length){ alert('Número inválido'); return; }
  SETS[desdeIdx].viajes = SETS[desdeIdx].viajes.filter(id=>id!==grupoId);
  SETS[to].viajes.push(grupoId);
  evaluarAlertas(); render();
}

function agregarViajeAConjunto(setIdx){
  const usados = viajesUsadosSetIds();
  const libres = GRUPOS.filter(g=>!usados.has(g.id));
  if (!libres.length){ alert('No quedan viajes libres.'); return; }
  const listado = libres.map((g,i)=>`${i+1}) ${g.aliasGrupo||g.nombreGrupo} [${g.fechaInicio}→${g.fechaFin}]`).join('\n');
  const n = prompt(`Selecciona # de viaje a agregar:\n${listado}`);
  if (!n) return;
  const i = (+n)-1;
  if (i<0 || i>=libres.length) return;
  SETS[setIdx].viajes.push(libres[i].id);
  evaluarAlertas(); render();
}

// ------------------------------
// Sugerir coordinador para un conjunto (disponible en todos los viajes)
// ------------------------------
function sugerirCoordinador(setIdx){
  const s = SETS[setIdx];
  const viajes = s.viajes.map(id=>ID2GRUPO.get(id)).filter(Boolean);
  const ok = COORDS.filter(c => viajes.every(v => inAnyRange(v.fechaInicio, v.fechaFin, c.fechasDisponibles||[])));
  if (!ok.length){ alert('No hay ninguno que cubra todo el conjunto.'); return; }
  s.coordinadorId = ok[0].id;
  evaluarAlertas(); render();
}

// ------------------------------
// Guardado
// ------------------------------
async function guardarTodo(){
  elMsg.textContent = 'Guardando…';

  // 1) Guarda alias y set para cada grupo
  for (const g of GRUPOS){
    await updateDoc(doc(db,'grupos', g.id), {
      aliasGrupo: g.aliasGrupo || null
    });
  }

  // 2) Guarda / actualiza los conjuntos, y escribe coordinador y conjunto en cada grupo
  for (const s of SETS){
    let setId = s.id;
    const payload = {
      viajes: s.viajes.slice(),
      coordinadorId: s.coordinadorId || null,
      confirmado: !!s.confirmado
    };
    if (!setId){
      const ref = await addDoc(collection(db,'conjuntosCoordinadores'), payload);
      setId = ref.id; s.id = setId;
    } else {
      await updateDoc(doc(db,'conjuntosCoordinadores', setId), payload);
    }
    // Actualiza cada grupo con coordenadas del set
    for (const gid of s.viajes){
      await updateDoc(doc(db,'grupos', gid), {
        conjuntoId: setId,
        coordinador: s.coordinadorId || null
      });
    }
  }

  // 3) Limpia grupos que quedaron sin set: borra referencias antiguas
  const usados = viajesUsadosSetIds();
  for (const g of GRUPOS){
    if (!usados.has(g.id)){
      await updateDoc(doc(db,'grupos', g.id), {
        conjuntoId: null
      });
    }
  }

  elMsg.textContent = '✅ Cambios guardados';
  setTimeout(()=> elMsg.textContent = '', 2000);
}

// ------------------------------
// MODAL: Coordinadores (tabla editable + Excel)
// ------------------------------
function openModal(){ mb.style.display='block'; modal.style.display='block'; }
function closeModal(){ modal.style.display='none'; mb.style.display='none'; }

function renderCoordsTable(){
  tbodyCoords.innerHTML = '';
  if (!COORDS.length) hintEmptyCoords.style.display='block';
  else hintEmptyCoords.style.display='none';

  COORDS.forEach((c, idx)=>{
    const filasRangos = (c.fechasDisponibles||[]).map((r,i)=>`
      <div style="display:flex; gap:.3rem; align-items:center; margin:.15rem 0;">
        <input class="picker-range" data-cid="${idx}" data-ridx="${i}" type="text" value="${r.inicio && r.fin ? `${r.inicio} a ${r.fin}` : ''}" readonly>
        <button class="btn small" data-delrng="${idx}:${i}">❌</button>
      </div>
    `).join('');
    tbodyCoords.insertAdjacentHTML('beforeend', `
      <tr>
        <td><input type="text" data-f="nombre" data-i="${idx}" value="${c.nombre||''}" placeholder="Nombre"></td>
        <td><input type="text" data-f="rut" data-i="${idx}" value="${c.rut||''}"></td>
        <td><input type="text" data-f="correo" data-i="${idx}" value="${c.correo||''}"></td>
        <td>
          ${filasRangos}
          <button class="btn small" data-addrng="${idx}">+ Rango</button>
        </td>
        <td>
          <button class="btn small" data-delcoord="${idx}">🗑️</button>
        </td>
      </tr>
    `);
  });

  // inputs base
  tbodyCoords.querySelectorAll('input[data-f]').forEach(inp=>{
    inp.onchange = ()=> {
      const i = +inp.dataset.i, f = inp.dataset.f;
      COORDS[i][f] = inp.value;
    };
  });

  // add rango
  tbodyCoords.querySelectorAll('button[data-addrng]').forEach(btn=>{
    btn.onclick = ()=>{
      const i = +btn.dataset.addrng;
      COORDS[i].fechasDisponibles ||= [];
      COORDS[i].fechasDisponibles.push({inicio:'', fin:''});
      renderCoordsTable();
      setTimeout(initPickers,10);
    };
  });

  // del rango
  tbodyCoords.querySelectorAll('button[data-delrng]').forEach(btn=>{
    btn.onclick = ()=>{
      const [i,j] = btn.dataset.delrng.split(':').map(n=>+n);
      COORDS[i].fechasDisponibles.splice(j,1);
      renderCoordsTable(); setTimeout(initPickers,10);
    };
  });

  // del coord
  tbodyCoords.querySelectorAll('button[data-delcoord]').forEach(btn=>{
    btn.onclick = async ()=>{
      const i = +btn.dataset.delcoord;
      if (COORDS[i].id){
        await deleteDoc(doc(db,'coordinadores', COORDS[i].id));
      }
      COORDS.splice(i,1);
      renderCoordsTable(); setTimeout(initPickers,10);
    };
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
          const inicio = toISO(sel[0]), fin = toISO(sel[1]);
          const i = +inp.dataset.cid, j = +inp.dataset.ridx;
          COORDS[i].fechasDisponibles[j] = {inicio, fin};
          inp.value = `${inicio} a ${fin}`;
        }
      }
    });
  });
}

async function saveCoordsModal(){
  // guarda cada fila (update si tiene id, add si no)
  for (const c of COORDS){
    if (!c.nombre || !c.nombre.trim()) continue; // omite vacíos
    const payload = {
      nombre: c.nombre.trim(),
      rut: (c.rut||'').trim(),
      correo: (c.correo||'').trim(),
      fechasDisponibles: (c.fechasDisponibles||[]).filter(r=>r.inicio && r.fin)
    };
    if (c.id){
      await updateDoc(doc(db,'coordinadores', c.id), payload);
    } else {
      const ref = await addDoc(collection(db,'coordinadores'), payload);
      c.id = ref.id;
    }
  }
  await loadCoordinadores();
  closeModal();
  evaluarAlertas(); render();
}

function handleExcel(evt){
  const file = evt.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e)=>{
    const wb = XLSX.read(e.target.result, {type:'binary'});
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, {defval:''});
    // columnas esperadas: Nombre, RUT, Correo  (solo Nombre obligatorio)
    const ya = new Set(COORDS.map(c=> (c.nombre||'').trim().toUpperCase()));
    rows.forEach(r=>{
      const nombre = (r.Nombre || r.nombre || '').toString().trim();
      if (!nombre) return;
      const key = nombre.toUpperCase();
      if (ya.has(key)) return; // evita duplicados por nombre
      COORDS.push({
        nombre,
        rut: (r.RUT || r.rut || '').toString().trim(),
        correo: (r.Correo || r.correo || '').toString().trim(),
        fechasDisponibles:[]
      });
      ya.add(key);
    });
    renderCoordsTable(); setTimeout(initPickers,10);
    inputExcel.value = '';
  };
  reader.readAsBinaryString(file);
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
  await loadSets();   // si no hay, puedes pulsar "Sugerir conjuntos"
  render();
});
