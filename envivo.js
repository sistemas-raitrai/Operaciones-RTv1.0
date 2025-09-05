// envivo.js — Mapa en vivo de actividades por grupo (solo lectura, sin auth)
// ---------------------------------------------------------------------------
// - Lee todos los grupos "activos" para la fecha actual (o simulada).
// - Muestra por DESTINO tarjetas de cada grupo con ANTES / AHORA / DESPUÉS.
// - Línea de progreso simple según hora del día.
// - Simulación: constante DEFAULT_FORCE_NOW_ISO y/o query ?now=YYYY-MM-DD[THH:mm].
// - Auto-refresh: cada 30 min. Botón manual "Refrescar".
// - Modo monitor: CAROUSEL por destino o SCROLL suave, con control de velocidad.
// - Muestra Coordinador por grupo (tolerante a distintos esquemas).

import { app, db } from './firebase-core.js';
import { collection, getDocs } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

/* ========== Configuración rápida ========== */
// Fuerza por código (déjalo '' para desactivar). Ejemplo: '2025-12-15T10:00'
const DEFAULT_FORCE_NOW_ISO = ''; // '2025-12-15T10:00';

// Si una actividad no tiene horaFin y tampoco duración, asumir X minutos:
const DURACION_POR_DEFECTO_MIN = 60;

// Refresh automático (ms):
const AUTO_REFRESH_MS = 30 * 60 * 1000; // 30 minutos

/* ========== Utils de fecha/hora ========== */
function pad2(n){ return String(n).padStart(2,'0'); }
function isoDate(d){ return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; }

// HH:MM -> minutos desde 00:00
function parseHM(hm=''){
  const m = /^(\d{1,2}):(\d{2})$/.exec((hm||'').trim());
  if(!m) return null;
  const hh = Math.min(23, Math.max(0, parseInt(m[1],10)));
  const mm = Math.min(59, Math.max(0, parseInt(m[2],10)));
  return hh*60 + mm;
}
// minutos -> HH:MM
function toHM(mins){ const hh=Math.floor(mins/60), mm=mins%60; return `${pad2(hh)}:${pad2(mm)}`; }
// Suma minutos a "HH:MM"
function addToHM(hm, minutes){
  const base = parseHM(hm) ?? 0;
  const t = Math.max(0, Math.min(24*60-1, base + minutes));
  return toHM(t);
}

/* ========== Manejo de "ahora" (real o simulado) ========== */
function getQueryNow(){
  const qs = new URLSearchParams(location.search);
  const raw = qs.get('now');
  if(!raw) return null;
  if(/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?$/.test(raw)) return raw.replace(' ','T');
  return null;
}
let state = { forceNowIso: getQueryNow() || DEFAULT_FORCE_NOW_ISO || null };
function nowDate(){
  if(state.forceNowIso){
    let v = state.forceNowIso;
    if(/^\d{4}-\d{2}-\d{2}$/.test(v)) v += 'T12:00';
    return new Date(v);
  }
  return new Date();
}

/* ========== Coordinador (texto) ========== */
function coordinadorTexto(g){
  const c = g.coordinador ?? g.coordinadorNombre ?? g.coordinadorAsignado ?? null;
  if(!c) return '—';
  if (typeof c === 'string') return c;
  const nombre = c.nombre || c.name || '—';
  const alias  = c.alias ? ` (${c.alias})` : '';
  const fono   = c.telefono || c.celular || c.fono || '';
  return [nombre + alias, fono].filter(Boolean).join(' · ');
}

/* ========== Carga de datos ========== */
async function leerGruposActivosPara(fechaISO){
  // Lee TODO y filtra en cliente. (Optimizable si crece mucho.)
  const snap = await getDocs(collection(db,'grupos'));
  const todos = snap.docs.map(d => ({ id:d.id, ...d.data() }));
  return todos.filter(g => {
    if(!g.fechaInicio || !g.fechaFin) return false;
    return g.fechaInicio <= fechaISO && fechaISO <= g.fechaFin;
  });
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
  if(act?.horaFin && parseHM(act.horaFin) != null) return act.horaFin;
  const dMin =
    (typeof act?.duracionMin === 'number' && act.duracionMin > 0) ? act.duracionMin :
    (typeof act?.duracion === 'number' && act.duracion > 0) ? act.duracion :
    DURACION_POR_DEFECTO_MIN;
  const hi = act?.horaInicio || '00:00';
  return addToHM(hi, dMin);
}
function analizarDia(arr, nowMin){
  const ord = ordenarPorHora(arr).map(a => ({
    ...a,
    _iniMin: parseHM(a?.horaInicio || '00:00') ?? 0,
    _finMin: parseHM(obtenerFin(a)) ?? 0
  }));
  let prev=null, now=null, next=null;
  for(let i=0;i<ord.length;i++){
    const a = ord[i];
    if(a._iniMin <= nowMin && nowMin < a._finMin){ now=a; prev=ord[i-1]||null; next=ord[i+1]||null; break; }
    if(a._finMin <= nowMin) prev = a;
    if(nowMin < a._iniMin){ next=a; break; }
  }
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

const autoModeSel = document.getElementById('autoMode');
const autoSpeed = document.getElementById('autoSpeed');
const speedLabel = document.getElementById('speedLabel');

function fmtFechaHumana(d){ return d.toLocaleString('es-CL', { dateStyle:'medium', timeStyle:'short' }); }
function setLastRefresh(d){ lastRefresh.textContent = `Actualizado: ${fmtFechaHumana(d)}`; }

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

  const filtro = filtroDestino.value || '__ALL__';
  const porDestino = new Map();
  grupos.forEach(g => {
    if(filtro !== '__ALL__' && g.destino !== filtro) return;
    const key = g.destino || '—';
    if(!porDestino.has(key)) porDestino.set(key, []);
    porDestino.get(key).push(g);
  });
  for(const [k, arr] of porDestino) arr.sort((a,b)=>(a.nombreGrupo||'').localeCompare(b.nombreGrupo||''));

  cont.innerHTML = '';
  if(!porDestino.size){
    cont.innerHTML = `<div class="pill">No hay grupos activos para ${dISO}${filtro==='__ALL__'?'':` en ${filtro}`}</div>`;
    return;
  }

  porDestino.forEach((lista, destino) => {
    const blk = document.createElement('section');
    blk.className = 'destino-bloque';
    blk.dataset.destino = destino;

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
          <div class="sub">Coordinador(a): ${coordinadorTexto(g)}</div>
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

  // Reinicia modo monitor tras cada render (contenido nuevo)
  applyAutoMode();
}

/* ========== Control de UI / Refresh ========== */
function humanSpeedLabel(){ return `x${autoSpeed.value}`; }
function secsForCarousel(){
  // Mapea velocidad (1..10) a segundos por destino (20..2)
  const v = Number(autoSpeed.value||5);
  return Math.max(2, 22 - v*2);
}
function pxPerStepForScroll(){
  // Mapea velocidad 1..10 a px/step (1..6)
  const v = Number(autoSpeed.value||5);
  return Math.min(6, Math.max(1, Math.round(v*0.6)));
}
function stepIntervalMs(){ return 40; } // intervalo del scroll suave

function initUI(){
  if(state.forceNowIso){
    let v = state.forceNowIso;
    if(/^\d{4}-\d{2}-\d{2}$/.test(v)) v += 'T12:00';
    v = v.replace(/:\d{2}$/, '');
    simNowInput.value = v;
  }
  simNowInput.addEventListener('change', () => {
    const val = simNowInput.value;
    state.forceNowIso = val || null;
    cargarYRender();
  });
  btnNowReal.addEventListener('click', () => { state.forceNowIso = null; simNowInput.value = ''; cargarYRender(); });
  btnRefrescar.addEventListener('click', () => cargarYRender());
  filtroDestino.addEventListener('change', () => cargarYRender());

  autoSpeed.addEventListener('input', () => { speedLabel.textContent = humanSpeedLabel(); applyAutoMode(); });
  autoModeSel.addEventListener('change', () => applyAutoMode());

  speedLabel.textContent = humanSpeedLabel();

  // Pausa automática por interacción del usuario
  ['wheel','mousemove','keydown','touchstart'].forEach(evt => {
    window.addEventListener(evt, () => pauseAuto(6000), { passive:true });
  });
}

let dataTimer = null;
async function cargarYRender(){
  const dNow = nowDate();
  setLastRefresh(new Date());

  const dISO = isoDate(dNow);
  const grupos = await leerGruposActivosPara(dISO);

  if(!filtroDestino.options || filtroDestino.options.length <= 1){
    buildDestinos(grupos);
  }
  render(grupos, dNow);
}

function startAutoRefresh(){
  if(dataTimer) clearInterval(dataTimer);
  dataTimer = setInterval(() => { cargarYRender().catch(console.error); }, AUTO_REFRESH_MS);
}

/* ========== Modo monitor: CAROUSEL / SCROLL ========== */
let carouselTimer = null;
let scrollTimer = null;
let pausedUntil = 0;
let currentDestinoIndex = 0;

function nowMs(){ return Date.now(); }
function pauseAuto(ms=6000){ pausedUntil = nowMs() + ms; }
function isPaused(){ return nowMs() < pausedUntil; }

function stopCarousel(){ if(carouselTimer) { clearInterval(carouselTimer); carouselTimer=null; } }
function stopScroll(){ if(scrollTimer){ clearInterval(scrollTimer); scrollTimer=null; } }

function allDestBlocks(){
  return Array.from(cont.querySelectorAll('.destino-bloque'));
}

function showOnlyDestino(idx){
  const blocks = allDestBlocks();
  if(!blocks.length) return;

  // Normaliza índice
  currentDestinoIndex = ((idx % blocks.length) + blocks.length) % blocks.length;

  blocks.forEach((b, i) => {
    if(i === currentDestinoIndex){
      b.classList.remove('is-hidden');
      // pequeño truco para que el fade se note al entrar/salir
      requestAnimationFrame(()=> b.classList.remove('fade-out'));
      // Llevar a la vista (por si hubo scroll)
      b.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      b.classList.add('fade-out');
      setTimeout(()=> b.classList.add('is-hidden'), 300);
    }
  });
}

function startCarousel(){
  stopScroll(); stopCarousel();
  const blocks = allDestBlocks();
  if(!blocks.length) return;

  // Mostrar el primero visible (o mantener destino actual si existía)
  showOnlyDestino(currentDestinoIndex || 0);

  const tick = () => {
    if(isPaused()) return; // no avanza mientras está en pausa por interacción
    showOnlyDestino(currentDestinoIndex + 1);
  };
  const secs = secsForCarousel();
  carouselTimer = setInterval(tick, secs*1000);
}

function startScroll(){
  stopCarousel(); stopScroll();

  // Mostrar TODOS los destinos (por si veníamos del carrusel)
  allDestBlocks().forEach(b => { b.classList.remove('is-hidden','fade-out'); });

  const stepPx = pxPerStepForScroll();
  const stepMs = stepIntervalMs();

  const tick = () => {
    if(isPaused()) return;
    const bottom = Math.ceil(window.innerHeight + window.scrollY);
    const full = Math.ceil(document.body.scrollHeight);
    if(bottom >= full - 2){
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    window.scrollBy(0, stepPx);
  };
  scrollTimer = setInterval(tick, stepMs);
}

function applyAutoMode(){
  const mode = autoModeSel.value || '__OFF__';
  if(mode === 'CAROUSEL'){
    startCarousel();
  } else if(mode === 'SCROLL'){
    startScroll();
  } else {
    stopCarousel(); stopScroll();
    // Mostrar todo si está apagado
    allDestBlocks().forEach(b => { b.classList.remove('is-hidden','fade-out'); });
  }
}

/* ========== Boot ========== */
initUI();
cargarYRender()
  .then(() => { startAutoRefresh(); applyAutoMode(); })
  .catch(err => {
    console.error('Error inicial:', err);
    cont.innerHTML = `<div class="pill">Error cargando datos.</div>`;
  });
