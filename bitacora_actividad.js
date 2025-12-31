// bitacora_actividad.js
// Bitácora por Grupo / por Actividad (lee desde Firestore)
// FUENTE (según COORDINADORES.JS v2.5):
// - índice: grupos/{gid}.asistencias[fechaISO][actKey].notas (sirve para saber qué fechas consultar)
// - bitácora real: grupos/{gid}/bitacora/{actKey}/{fechaISO}/{timeId} => {texto, byEmail, ts}

import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs, doc, getDoc, query, where
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

/* ====================== UI ====================== */
const el = {
  destino:   document.getElementById('fDestino'),
  coord:     document.getElementById('fCoord'),
  grupo:     document.getElementById('fGrupo'),
  modo:      document.getElementById('fModo'),
  actividad: document.getElementById('fActividad'),
  limite:    document.getElementById('fLimite'),

  btnCargar: document.getElementById('btnCargar'),
  btnLimpiar:document.getElementById('btnLimpiar'),
  status:    document.getElementById('status'),

  buscador:  document.getElementById('buscador'),
  tbody:     document.getElementById('tbody'),
  count:     document.getElementById('countEntradas'),
};

/* ====================== STATE ====================== */
const state = {
  user: null,
  grupos: [],          // [{id, destino, coordinadorEmail, numeroNegocio, nombreGrupo, ...fullData}]
  grupoById: new Map(),
  destinos: [],
  coords: [],
  // Mapa de actividad para mostrar bonito:
  // actKey -> "Nombre Actividad"
  actNameByKey: new Map(),
  // ActKeys disponibles por filtro actual (para dropdown)
  filteredActKeys: [],
  // resultados
  rows: [],            // [{fechaISO, hora, grupoLabel, actName, texto, autor, tsMs, tsStr}]
};

const TZ = 'America/Santiago';

/* ====================== HELPERS ====================== */
const norm = (s='') => (s ?? '')
  .toString()
  .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
  .toLowerCase()
  .trim();

function slug(s=''){
  return norm(s)
    .replace(/[^a-z0-9]+/g,'-')
    .replace(/-+/g,'-')
    .replace(/^-|-$/g,'');
}

// MISMA IDEA QUE EN COORDINADORES.JS (slugActKey)
function slugActKey(actName=''){
  const k = slug(actName);
  // prevención: si queda vacío, algo estable
  return k || 'actividad';
}

function setStatus(msg){ el.status.textContent = msg; }

function option(sel, value, label){
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  sel.appendChild(o);
}

function clearSelect(sel){
  sel.innerHTML = '';
}

function grupoLabel(g){
  const n = (g.numeroNegocio ?? g.numero ?? '').toString().trim();
  const ng = (g.nombreGrupo ?? g.nombre ?? '').toString().trim();
  if(n && ng) return `(${n}) ${ng}`;
  if(ng) return ng;
  if(n) return `(${n})`;
  return g.id;
}

// ts -> string simple
function fmtTS(ms){
  if(!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleString('es-CL', { timeZone: TZ });
}

function pad2(n){ return String(n).padStart(2,'0'); }
function fmtHoraFromMs(ms){
  if(!ms) return '—';
  const d = new Date(ms);
  // ojo: toLocaleTimeString con TZ
  return d.toLocaleTimeString('es-CL', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
}

/* ======================
   CARGA BASE: GRUPOS
====================== */
async function cargarGruposBase(){
  setStatus('Cargando grupos...');
  const snap = await getDocs(collection(db,'grupos'));

  state.grupos = [];
  state.grupoById.clear();
  state.actNameByKey.clear();

  const destinosSet = new Set();
  const coordsSet = new Set();

  snap.forEach(d => {
    const data = d.data() || {};
    const g = { id: d.id, ...data };

    // Normalizamos campos típicos
    g.destino = (g.destino ?? '').toString().trim();
    g.coordinadorEmail = (g.coordinadorEmail ?? g.coordEmail ?? g.coordinador ?? '').toString().trim().toLowerCase();
    g.numeroNegocio = (g.numeroNegocio ?? g.numero ?? g.id ?? '').toString().trim();
    g.nombreGrupo = (g.nombreGrupo ?? g.nombre ?? '').toString().trim();

    state.grupos.push(g);
    state.grupoById.set(g.id, g);

    if(g.destino) destinosSet.add(g.destino);
    if(g.coordinadorEmail) coordsSet.add(g.coordinadorEmail);

    // ✅ Mapeo actKey -> nombre actividad (si existe itinerario)
    // itinerario[fechaISO] = [{actividad, hora, ...}, ...]
    const itin = g.itinerario || {};
    Object.keys(itin).forEach(fechaISO => {
      const arr = Array.isArray(itin[fechaISO]) ? itin[fechaISO] : [];
      arr.forEach(item => {
        const act = (item?.actividad ?? item?.act ?? '').toString().trim();
        if(!act) return;
        const key = slugActKey(act);
        if(!state.actNameByKey.has(key)) state.actNameByKey.set(key, act);
      });
    });
  });

  state.destinos = Array.from(destinosSet).sort((a,b)=> a.localeCompare(b,'es'));
  state.coords = Array.from(coordsSet).sort((a,b)=> a.localeCompare(b,'es'));

  setStatus(`Listo. Grupos cargados: ${state.grupos.length}.`);
}

/* ======================
   POBLAR FILTROS
====================== */
function poblarFiltros(){
  // DESTINO
  clearSelect(el.destino);
  option(el.destino, '', '(Todos)');
  state.destinos.forEach(d => option(el.destino, d, d));

  // COORD
  clearSelect(el.coord);
  option(el.coord, '', '(Todos)');
  state.coords.forEach(c => option(el.coord, c, c));

  // GRUPO
  clearSelect(el.grupo);
  option(el.grupo, '', '(Todos)');
  state.grupos
    .slice()
    .sort((a,b)=> grupoLabel(a).localeCompare(grupoLabel(b),'es'))
    .forEach(g => option(el.grupo, g.id, grupoLabel(g)));

  // ACTIVIDAD (se llena dinámico según filtro)
  clearSelect(el.actividad);
  option(el.actividad, '', '(Selecciona destino y/o carga)');
  el.actividad.disabled = (el.modo.value !== 'ACTIVIDAD');
}

/* ======================
   FILTRAR GRUPOS ACTUALES
====================== */
function gruposFiltrados(){
  const d = el.destino.value;
  const c = el.coord.value;
  const gid = el.grupo.value;

  let arr = state.grupos;

  if(gid){
    const g = state.grupoById.get(gid);
    return g ? [g] : [];
  }
  if(d) arr = arr.filter(g => (g.destino || '') === d);
  if(c) arr = arr.filter(g => (g.coordinadorEmail || '') === c);

  return arr;
}

/* ======================
   ACTIVIDADES DISPONIBLES SEGÚN FILTRO
   (usamos asistencias como índice)
====================== */
function recalcularActividadesDisponibles(){
  const grupos = gruposFiltrados();
  const keysSet = new Set();

  grupos.forEach(g => {
    const asist = g.asistencias || {};
    Object.keys(asist).forEach(fechaISO => {
      const day = asist[fechaISO] || {};
      Object.keys(day).forEach(actKey => {
        const v = day[actKey] || {};
        // si hay "notas" en índice, asumimos que existe bitácora
        if(v?.notas) keysSet.add(actKey);
      });
    });
  });

  const keys = Array.from(keysSet);
  keys.sort((a,b)=>{
    const A = state.actNameByKey.get(a) || a;
    const B = state.actNameByKey.get(b) || b;
    return A.localeCompare(B,'es');
  });

  state.filteredActKeys = keys;

  clearSelect(el.actividad);
  option(el.actividad, '', '(Selecciona actividad)');
  keys.forEach(k => {
    const name = state.actNameByKey.get(k) || k;
    option(el.actividad, k, name);
  });

  // si no hay nada, deja un placeholder útil
  if(!keys.length){
    clearSelect(el.actividad);
    option(el.actividad, '', '(Sin actividades con bitácora en este filtro)');
  }
}

/* ======================
   LECTURA BITÁCORA REAL
====================== */
async function fetchBitacoraDocs(grupoId, actKey, fechaISO){
  // ruta: grupos/{gid}/bitacora/{actKey}/{fechaISO}/{timeId}
  const col = collection(db, 'grupos', grupoId, 'bitacora', actKey, fechaISO);
  const snap = await getDocs(col);

  const out = [];
  snap.forEach(d => {
    const x = d.data() || {};
    out.push({
      texto: (x.texto ?? '').toString(),
      byEmail: (x.byEmail ?? '').toString(),
      ts: x.ts || null,
      _id: d.id
    });
  });
  return out;
}

/* ======================
   CONSTRUIR ROWS (Modo GRUPO / ACTIVIDAD)
====================== */
async function cargarBitacora(){
  const modo = el.modo.value;
  const limite = Number(el.limite.value || 200);
  const grupos = gruposFiltrados();

  if(!grupos.length){
    renderRows([]);
    setStatus('Sin grupos para ese filtro.');
    return;
  }

  if(modo === 'ACTIVIDAD'){
    const actKey = el.actividad.value;
    if(!actKey){
      renderRows([]);
      setStatus('Selecciona una actividad.');
      return;
    }
  }

  setStatus('Leyendo bitácora en Firebase...');
  el.btnCargar.disabled = true;
  el.btnLimpiar.disabled = true;

  const rows = [];

  try{
    if(modo === 'GRUPO'){
      // trae todas las actividades con notas (índice) y luego lee bitácora real
      for(const g of grupos){
        const asist = g.asistencias || {};
        const fechas = Object.keys(asist).sort(); // asc

        for(const fechaISO of fechas){
          const day = asist[fechaISO] || {};
          const actKeys = Object.keys(day);

          for(const actKey of actKeys){
            const idx = day[actKey] || {};
            if(!idx?.notas) continue; // sin índice => no buscamos

            // lee docs reales
            const docs = await fetchBitacoraDocs(g.id, actKey, fechaISO);

            for(const d of docs){
              const tsMs = d.ts?.toMillis ? d.ts.toMillis() : null;
              rows.push({
                fechaISO,
                hora: fmtHoraFromMs(tsMs),
                grupoLabel: grupoLabel(g),
                grupoId: g.id,
                actKey,
                actName: state.actNameByKey.get(actKey) || actKey,
                texto: d.texto,
                autor: d.byEmail || '—',
                tsMs,
                tsStr: fmtTS(tsMs)
              });
              if(rows.length >= limite) break;
            }
            if(rows.length >= limite) break;
          }
          if(rows.length >= limite) break;
        }
        if(rows.length >= limite) break;
      }
    } else {
      // modo ACTIVIDAD: trae sólo esa actKey en todos los grupos filtrados
      const actKey = el.actividad.value;

      for(const g of grupos){
        const asist = g.asistencias || {};
        const fechas = Object.keys(asist).sort();

        for(const fechaISO of fechas){
          const day = asist[fechaISO] || {};
          const idx = day[actKey] || null;
          if(!idx?.notas) continue;

          const docs = await fetchBitacoraDocs(g.id, actKey, fechaISO);

          for(const d of docs){
            const tsMs = d.ts?.toMillis ? d.ts.toMillis() : null;
            rows.push({
              fechaISO,
              hora: fmtHoraFromMs(tsMs),
              grupoLabel: grupoLabel(g),
              grupoId: g.id,
              actKey,
              actName: state.actNameByKey.get(actKey) || actKey,
              texto: d.texto,
              autor: d.byEmail || '—',
              tsMs,
              tsStr: fmtTS(tsMs)
            });
            if(rows.length >= limite) break;
          }
          if(rows.length >= limite) break;
        }
        if(rows.length >= limite) break;
      }
    }

    // Orden: más nuevo primero
    rows.sort((a,b)=>{
      const A = a.tsMs || 0;
      const B = b.tsMs || 0;
      if(B !== A) return B - A;
      // fallback: por fecha
      return String(b.fechaISO).localeCompare(String(a.fechaISO));
    });

    state.rows = rows;
    renderRows(rows);
    setStatus(`Listo. Entradas: ${rows.length} (límite ${limite}).`);
  } catch(err){
    console.error(err);
    renderRows([]);
    setStatus('Error leyendo Firebase (ver consola).');
  } finally {
    el.btnCargar.disabled = false;
    el.btnLimpiar.disabled = false;
  }
}

/* ======================
   RENDER + BUSCADOR
====================== */
function renderRows(rows){
  el.count.textContent = String(rows.length);

  if(!rows.length){
    el.tbody.innerHTML = `<tr><td colspan="7" class="empty">Sin resultados.</td></tr>`;
    return;
  }

  el.tbody.innerHTML = rows.map(r => `
    <tr>
      <td class="mono nowrap">${r.fechaISO || '—'}</td>
      <td class="mono nowrap">${r.hora || '—'}</td>
      <td>${escapeHtml(r.grupoLabel || '—')}</td>
      <td>${escapeHtml(r.actName || r.actKey || '—')}</td>
      <td class="texto">${escapeHtml(r.texto || '')}</td>
      <td class="hide-m">${escapeHtml(r.autor || '—')}</td>
      <td class="hide-m mono nowrap">${escapeHtml(r.tsStr || '—')}</td>
    </tr>
  `).join('');
}

function escapeHtml(s=''){
  return String(s)
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'","&#039;");
}

function applySearch(){
  const q = norm(el.buscador.value || '');
  if(!q){
    renderRows(state.rows);
    return;
  }
  const filtered = state.rows.filter(r => {
    const blob = norm([
      r.fechaISO, r.hora, r.grupoLabel, r.actName, r.actKey, r.texto, r.autor, r.tsStr
    ].join(' '));
    return blob.includes(q);
  });
  renderRows(filtered);
  setStatus(`Filtrado: ${filtered.length}/${state.rows.length}`);
}

/* ======================
   LIMPIAR
====================== */
function limpiar(){
  el.destino.value = '';
  el.coord.value = '';
  el.grupo.value = '';
  el.modo.value = 'GRUPO';
  el.actividad.disabled = true;
  el.limite.value = '200';
  el.buscador.value = '';
  state.rows = [];
  renderRows([]);
  setStatus('Listo.');
}

/* ======================
   EVENTOS
====================== */
function wire(){
  el.modo.addEventListener('change', () => {
    const isAct = el.modo.value === 'ACTIVIDAD';
    el.actividad.disabled = !isAct;

    // recalcula actividades disponibles cuando corresponde
    if(isAct){
      recalcularActividadesDisponibles();
    }
  });

  // cada cambio de filtro recalcula actividades (si está en modo actividad)
  const refilter = () => {
    if(el.modo.value === 'ACTIVIDAD') recalcularActividadesDisponibles();
  };
  el.destino.addEventListener('change', refilter);
  el.coord.addEventListener('change', refilter);
  el.grupo.addEventListener('change', refilter);

  el.btnCargar.addEventListener('click', cargarBitacora);
  el.btnLimpiar.addEventListener('click', limpiar);
  el.buscador.addEventListener('input', applySearch);
}

/* ======================
   INIT + AUTH
====================== */
async function init(){
  await cargarGruposBase();
  poblarFiltros();
  wire();

  // precarga actividades si parte en modo actividad (no es el caso por defecto)
  if(el.modo.value === 'ACTIVIDAD'){
    recalcularActividadesDisponibles();
  }

  renderRows([]);
}

onAuthStateChanged(auth, async (u) => {
  if(!u){
    // ajusta si tu login se llama distinto
    window.location.href = 'login.html';
    return;
  }
  state.user = u;
  await init();
});
