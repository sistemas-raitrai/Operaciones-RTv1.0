// envivo.js — Mapa en vivo de actividades por grupo (solo lectura, sin auth)
// ---------------------------------------------------------------------------
// - Lee todos los grupos "activos" para la fecha actual (o simulada).
// - Muestra por DESTINO tarjetas de cada grupo con ANTES / AHORA / DESPUÉS.
// - Línea de progreso simple según hora del día.
// - Simulación: constante DEFAULT_FORCE_NOW_ISO y/o query ?now=YYYY-MM-DD[THH:mm].
// - Auto-refresh: cada 30 min. Botón manual "Refrescar".
// - Importa app/db desde tu firebase-core.js (público).

import { app, db } from './firebase-core.js';
import {
  collection, getDocs
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

/* ========== Configuración rápida ========== */
// Fuerza por código (déjalo '' para desactivar). Ejemplo: '2025-12-15T10:00'
const DEFAULT_FORCE_NOW_ISO = ''; // '2025-12-15T10:00';

// Si una actividad no tiene horaFin y tampoco duración, asumir X minutos:
const DURACION_POR_DEFECTO_MIN = 60;

// Refresh automático (ms):
const AUTO_REFRESH_MS = 30 * 60 * 1000; // 30 minutos

/* ========== Utils de fecha/hora ========== */
function pad2(n){ return String(n).padStart(2,'0'); }

function isoDate(d){
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
}

// HH:MM -> minutos desde 00:00
function parseHM(hm=''){
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if(!m) return null;
  const hh = Math.min(23, Math.max(0, parseInt(m[1],10)));
  const mm = Math.min(59, Math.max(0, parseInt(m[2],10)));
  return hh*60 + mm;
}

// minutos -> HH:MM
function toHM(mins){
  const hh = Math.floor(mins/60);
  const mm = mins%60;
  return `${pad2(hh)}:${pad2(mm)}`;
}

// Suma minutos a una "HH:MM"
function addToHM(hm, minutes){
  const m = parseHM(hm) ?? 0;
  const t = Math.max(0, Math.min(24*60-1, m + minutes));
  return toHM(t);
}

/* ========== Manejo de "ahora" (real o simulado) ========== */
function getQueryNow(){
  const qs = new URLSearchParams(location.search);
  const raw = qs.get('now');
  if(!raw) return null;
  // Acepta YYYY-MM-DD o YYYY-MM-DDTHH:mm
  if(/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?$/.test(raw)){
    // Normaliza el espacio a 'T'
    return raw.replace(' ','T');
  }
  return null;
}

let state = {
  forceNowIso: getQueryNow() || DEFAULT_FORCE_NOW_ISO || null, // string o null
};

function nowDate(){
  if(state.forceNowIso){
    // Si viene solo fecha, asigna 12:00 local
    let v = state.forceNowIso;
    if(/^\d{4}-\d{2}-\d{2}$/.test(v)) v = v + 'T12:00';
    return new Date(v);
  }
  return new Date();
}

/* ========== Carga de datos ========== */
async function leerGruposActivosPara(fechaISO){
  // Leemos TODOS y filtramos en cliente (evitamos índices compuestos).
  // Si llegasen a ser muchos, podemos optimizar luego con rangos.
  const snap = await getDocs(collection(db,'grupos'));
  const todos = snap.docs.map(d => ({ id:d.id, ...d.data() }));

  // Filtra por rango de viaje que contenga fechaISO
  const activos = todos.filter(g => {
    if(!g.fechaInicio || !g.fechaFin) return false;
    // formato YYYY-MM-DD compara bien como string
    return g.fechaInicio <= fechaISO && fechaISO <= g.fechaFin;
  });

  // Además, que tengan itinerario para ese día (si no, igual mostramos como "sin actividades hoy")
  return activos;
}

/* ========== Cálculos ANTES/AHORA/DESPUÉS por grupo ========== */
function ordenarPorHora(arr){
  return (arr||[]).slice().sort((a,b) => {
    const ai = parseHM(a?.horaInicio || '99:99') ?? 9999;
    const bi = parseHM(b?.horaInicio || '99:99') ?? 9999;
    return ai - bi;
  });
}

function obtenerFin(act){
  // Si tiene horaFin válida, úsala; si no, prueba 'duracionMin'/'duracion' (min); si no, por defecto.
  if(act?.horaFin && parseHM(act.horaFin) != null) return act.horaFin;
  const dMin =
    (typeof act?.duracionMin === 'number' && act.duracionMin > 0) ? act.duracionMin :
    (typeof act?.duracion === 'number' && act.duracion > 0) ? act.duracion :
    DURACION_POR_DEFECTO_MIN;
  const hi = act?.horaInicio || '00:00';
  return addToHM(hi, dMin);
}

/**
 * Dado el itinerario del día y la "hora actual" (minutos), devuelve:
 * { prev, now, next, progressPct }
 * - prev/now/next: actividad completa (o null) + campos calculados ._iniMin ._finMin
 * - progressPct: 0..100 para llenar la barra (progreso del día, no solo la actividad)
 */
function analizarDia(arr, nowMin){
  const ord = ordenarPorHora(arr).map(a => ({
    ...a,
    _iniMin: parseHM(a?.horaInicio || '00:00') ?? 0,
    _finMin: parseHM(obtenerFin(a)) ?? 0
  }));

  let prev = null, now = null, next = null;

  for(let i=0;i<ord.length;i++){
    const a = ord[i];
    if(a._iniMin <= nowMin && nowMin < a._finMin){ // AHORA
      now = a;
      prev = ord[i-1] || null;
      next = ord[i+1] || null;
      break;
    }
    if(a._finMin <= nowMin) prev = a; // se va actualizando hasta la última finalizada
    if(nowMin < a._iniMin){ next = a; break; }
  }

  // Si no encontraron "now", prev/next se habrán quedado correctos
  // Progreso del día: entre primera y última actividad
  const diaIni = ord.length ? ord[0]._iniMin : 0;
  const diaFin = ord.length ? ord[ord.length-1]._finMin : 24*60;
  const span = Math.max(1, diaFin - diaIni);
  const clamped = Math.min(diaFin, Math.max(diaIni, nowMin));
  const progressPct = Math.round(((clamped - diaIni) / span) * 100);

  return { prev, now, next, progressPct, ordenadas: ord };
}

/* ========== Render ========== */
const cont = document.getElementById('contenedor');
const filtroDestino = document.getElementById('filtroDestino');
const simNowInput = document.getElementById('simNow');
const btnNowReal = document.getElementById('btnNowReal');
const btnRefrescar = document.getElementById('btnRefrescar');
const lastRefresh = document.getElementById('lastRefresh');

function fmtFechaHumana(d){
  return d.toLocaleString('es-CL', { dateStyle:'medium', timeStyle:'short' });
}

function setLastRefresh(d){
  lastRefresh.textContent = `Actualizado: ${fmtFechaHumana(d)}`;
}

function buildDestinos(grupos){
  const set = new Set();
  grupos.forEach(g => { if(g.destino) set.add(g.destino); });
  const list = ['__ALL__', ...[...set].sort((a,b)=>a.localeCompare(b))];
  filtroDestino.innerHTML = list.map(v =>
    `<option value="${v}">${v==='__ALL__'?'Todos':v}</option>`).join('');
}

function render(grupos, dNow){
  const dISO = isoDate(dNow);
  const nowMin = dNow.getHours()*60 + dNow.getMinutes();

  // Agrupar por destino (según filtro)
  const filtro = filtroDestino.value || '__ALL__';
  const porDestino = new Map();
  grupos.forEach(g => {
    if(filtro !== '__ALL__' && g.destino !== filtro) return;
    const key = g.destino || '—';
    if(!porDestino.has(key)) porDestino.set(key, []);
    porDestino.get(key).push(g);
  });

  // Orden: por nombre grupo
  for(const [k, arr] of porDestino) arr.sort((a,b)=>(a.nombreGrupo||'').localeCompare(b.nombreGrupo||''));

  // HTML
  cont.innerHTML = '';
  if(!porDestino.size){
    cont.innerHTML = `<div class="pill">No hay grupos activos para ${dISO}${filtro==='__ALL__'?'':` en ${filtro}`}</div>`;
    return;
  }

  porDestino.forEach((lista, destino) => {
    const blk = document.createElement('section');
    blk.className = 'destino-bloque';

    blk.innerHTML = `
      <div class="destino-hd">
        <h2>Destino: ${destino}</h2>
        <span class="pill">${lista.length} grupo(s)</span>
        <span class="pill">Hoy: ${dISO}</span>
      </div>
      <div class="grid"></div>
    `;

    const grid = blk.querySelector('.grid');

    lista.forEach(g => {
      const hoy = Array.isArray(g.itinerario?.[dISO]) ? g.itinerario[dISO] : [];
      const anal = analizarDia(hoy, nowMin);

      const prevTxt = anal.prev ? (anal.prev.actividad||'—').toString().toUpperCase() : '—';
      const nowTxt  = anal.now  ? (anal.now.actividad ||'—').toString().toUpperCase() : '—';
      const nextTxt = anal.next ? (anal.next.actividad||'—').toString().toUpperCase() : '—';

      const prevRange = anal.prev ? `${anal.prev.horaInicio||'--:--'}–${obtenerFin(anal.prev)}` : '';
      const nowRange  = anal.now  ? `${anal.now.horaInicio||'--:--'}–${obtenerFin(anal.now)}`   : '';
      const nextRange = anal.next ? `${anal.next.horaInicio||'--:--'}–${obtenerFin(anal.next)}` : '';

      const card = document.createElement('article');
      card.className = 'card';
      card.innerHTML = `
        <div>
          <h3>${(g.nombreGrupo||'—')}</h3>
          <div class="sub">Programa: ${(g.programa||'—')} · N° ${g.numeroNegocio ?? g.id}</div>
        </div>

        <div class="tl">
          <div class="tl-label">Antes</div>
          <div class="bar"><div class="fill" style="width:${anal.progressPct}%;"></div></div>
          <div class="tl-label">Después</div>
        </div>

        <div class="row">
          <span class="badge ok">✔ ${prevRange||'—'}</span>
          <span class="badge now">AHORA ${nowRange||''}</span>
          <span class="badge nx">➡ ${nextRange||'—'}</span>
        </div>

        <div class="row" style="gap:.6rem;">
          <div class="tile" style="min-width:0;flex:1 1 33%;">
            <small>Antes</small>
            <strong>${prevTxt}</strong>
          </div>
          <div class="tile" style="min-width:0;flex:1 1 33%;">
            <small>Ahora</small>
            <strong>${nowTxt}</strong>
          </div>
          <div class="tile" style="min-width:0;flex:1 1 33%;">
            <small>Próxima</small>
            <strong>${nextTxt}</strong>
          </div>
        </div>
      `;

      grid.appendChild(card);
    });

    cont.appendChild(blk);
  });
}

/* ========== Control de UI / Refresh ========== */
function initUI(){
  // Cargar valor inicial del simNow desde state.forceNowIso (si existe)
  if(state.forceNowIso){
    // normalizar a value de input datetime-local (requiere 'YYYY-MM-DDTHH:mm')
    let v = state.forceNowIso;
    if(/^\d{4}-\d{2}-\d{2}$/.test(v)) v = v + 'T12:00';
    // quitar segundos si viniesen
    v = v.replace(/:\d{2}$/, ''); // opcional
    simNowInput.value = v;
  }

  simNowInput.addEventListener('change', () => {
    const val = simNowInput.value; // '' o 'YYYY-MM-DDTHH:mm'
    state.forceNowIso = val || null;
    // Re-render inmediato con nueva hora simulada
    cargarYRender();
  });

  btnNowReal.addEventListener('click', () => {
    state.forceNowIso = null;
    simNowInput.value = '';
    cargarYRender();
  });

  btnRefrescar.addEventListener('click', () => cargarYRender());
  filtroDestino.addEventListener('change',   () => cargarYRender());
}

let autoTimer = null;

async function cargarYRender(){
  const dNow = nowDate();
  setLastRefresh(new Date());

  const dISO = isoDate(dNow);
  const grupos = await leerGruposActivosPara(dISO);

  // Primer render: construir filtro de destinos si está vacío
  if(!filtroDestino.options || filtroDestino.options.length <= 1){
    buildDestinos(grupos);
  }

  render(grupos, dNow);
}

function startAutoRefresh(){
  if(autoTimer) clearInterval(autoTimer);
  autoTimer = setInterval(() => {
    cargarYRender().catch(console.error);
  }, AUTO_REFRESH_MS);
}

/* ========== Boot ========== */
initUI();
cargarYRender().then(() => startAutoRefresh()).catch(err => {
  console.error('Error inicial:', err);
  cont.innerHTML = `<div class="pill">Error cargando datos.</div>`;
});
