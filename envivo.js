// envivo.js — En vivo: dónde están los grupos (solo lectura, sin auth)
// - Vista por DESTINO, tarjetas con “Antes / AHORA / Después”.
// - Coordinador(a) en cabecera de la tarjeta.
// - Simulación de fecha/hora (?now=YYYY-MM-DD[THH:mm] o constante).
// - Auto-refresh cada 30 min.
// - Modo monitor: oculta UI (header/footer) + HUD; atajos M (UI) y F (fullscreen).
// - Animación de monitor: Carrusel por destino o Scroll suave con control de velocidad.

import { app, db } from './firebase-core.js';
import { collection, getDocs } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

/* ========== Configuración rápida ========== */
const DEFAULT_FORCE_NOW_ISO = '';           // '2025-12-15T10:00' para forzar por código
const DURACION_POR_DEFECTO_MIN = 60;        // si actividad no tiene horaFin/duración
const AUTO_REFRESH_MS = 30 * 60 * 1000;     // 30 minutos

/* ========== Utils fecha/hora ========== */
const pad2 = n => String(n).padStart(2,'0');
const isoDate = d => `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
function parseHM(hm=''){ const m=/^(\d{1,2}):(\d{2})$/.exec((hm||'').trim()); if(!m) return null; const hh=Math.min(23,Math.max(0,parseInt(m[1],10))); const mm=Math.min(59,Math.max(0,parseInt(m[2],10))); return hh*60+mm; }
const toHM = mins => `${pad2(Math.floor(mins/60))}:${pad2(mins%60)}`;
function addToHM(hm, minutes){ const base=parseHM(hm) ?? 0; const t=Math.max(0,Math.min(24*60-1, base+minutes)); return toHM(t); }

/* ===== Query helpers ===== */
function getParam(name){ const qs=new URLSearchParams(location.search); const v=qs.get(name); return v===null?null:String(v); }
function getBoolParam(name){ const v=getParam(name); if(v===null) return false; return ['1','true','on','yes'].includes(v.toLowerCase()); }

/* ===== Fullscreen toggle ===== */
async function toggleFullscreen(){ try{ if(!document.fullscreenElement) await document.documentElement.requestFullscreen(); else await document.exitFullscreen(); }catch(_){} }

/* ========== Manejo de “ahora” real/simulado ========== */
function getQueryNow(){
  const raw = getParam('now');
  if(!raw) return null;
  if(/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?$/.test(raw)) return raw.replace(' ','T');
  return null;
}
let state = { forceNowIso: getQueryNow() || DEFAULT_FORCE_NOW_ISO || null };
function nowDate(){
  if(state.forceNowIso){
    let v=state.forceNowIso;
    if(/^\d{4}-\d{2}-\d{2}$/.test(v)) v+='T12:00';
    return new Date(v);
  }
  return new Date();
}

/* ========== Coordinador: texto bonito ========== */
function coordinadorTexto(g){
  const c = g.coordinador ?? g.coordinadorNombre ?? g.coordinadorAsignado ?? null;
  if(!c) return '—';
  if(typeof c === 'string') return c;
  const nombre = c.nombre || c.name || '—';
  const alias  = c.alias ? ` (${c.alias})` : '';
  const fono   = c.telefono || c.celular || c.fono || '';
  return [nombre + alias, fono].filter(Boolean).join(' · ');
}

/* ========== Lectura de grupos activos para un día ========== */
async function leerGruposActivosPara(fechaISO){
  const snap = await getDocs(collection(db,'grupos'));
  const todos = snap.docs.map(d => ({ id:d.id, ...d.data() }));
  return todos.filter(g => g.fechaInicio && g.fechaFin && g.fechaInicio <= fechaISO && fechaISO <= g.fechaFin);
}

/* ========== Cálculos ANTES/AHORA/DESPUÉS ========== */
function ordenarPorHora(arr){
  return (arr||[]).slice().sort((a,b)=>{
    const ai=parseHM(a?.horaInicio || '99:99') ?? 9999;
    const bi=parseHM(b?.horaInicio || '99:99') ?? 9999;
    return ai-bi;
  });
}
function obtenerFin(act){
  if(act?.horaFin && parseHM(act.horaFin)!=null) return act.horaFin;
  const dMin = (typeof act?.duracionMin==='number' && act.duracionMin>0) ? act.duracionMin
            : (typeof act?.duracion==='number'   && act.duracion>0)     ? act.duracion
            : DURACION_POR_DEFECTO_MIN;
  return addToHM(act?.horaInicio || '00:00', dMin);
}
function analizarDia(arr, nowMin){
  const ord = ordenarPorHora(arr).map(a=>({ ...a, _iniMin: parseHM(a?.horaInicio || '00:00') ?? 0, _finMin: parseHM(obtenerFin(a)) ?? 0 }));
  let prev=null, now=null, next=null;
  for(let i=0;i<ord.length;i++){
    const a=ord[i];
    if(a._iniMin <= nowMin && nowMin < a._finMin){ now=a; prev=ord[i-1]||null; next=ord[i+1]||null; break; }
    if(a._finMin <= nowMin) prev=a;
    if(nowMin < a._iniMin){ next=a; break; }
  }
  return { prev, now, next, ordenadas: ord };
}

/* ========== DOM refs ========== */
const cont = document.getElementById('contenedor');
const filtroDestino = document.getElementById('filtroDestino');
const simNowInput = document.getElementById('simNow');
const btnNowReal = document.getElementById('btnNowReal');
const btnRefrescar = document.getElementById('btnRefrescar');
const lastRefresh = document.getElementById('lastRefresh');
const autoModeSel = document.getElementById('autoMode');
const autoSpeed = document.getElementById('autoSpeed');
const speedLabel = document.getElementById('speedLabel');
const hud = document.getElementById('hud');

function fmtFechaHumana(d){ return d.toLocaleString('es-CL',{dateStyle:'medium', timeStyle:'short'}); }
function setLastRefresh(d){ if(lastRefresh) lastRefresh.textContent = `Actualizado: ${fmtFechaHumana(d)}`; updateHUD(); }

/* Build filtro destinos */
function buildDestinos(grupos){
  const set = new Set(); grupos.forEach(g=>{ if(g.destino) set.add(g.destino); });
  const list = ['__ALL__', ...[...set].sort((a,b)=>a.localeCompare(b))];
  filtroDestino.innerHTML = list.map(v=>`<option value="${v}">${v==='__ALL__'?'Todos':v}</option>`).join('');
}

/* Render principal */
function render(grupos, dNow){
  const dISO = isoDate(dNow);
  const nowMin = dNow.getHours()*60 + dNow.getMinutes();

  const filtro = filtroDestino.value || '__ALL__';
  const porDestino = new Map();
  grupos.forEach(g=>{
    if(filtro!=='__ALL__' && g.destino!==filtro) return;
    const key = g.destino || '—';
    if(!porDestino.has(key)) porDestino.set(key, []);
    porDestino.get(key).push(g);
  });
  for(const [,arr] of porDestino) arr.sort((a,b)=>(a.nombreGrupo||'').localeCompare(b.nombreGrupo||''));

  cont.innerHTML = '';
  if(!porDestino.size){
    cont.innerHTML = `<div class="pill">No hay grupos activos para ${dISO}${filtro==='__ALL__'?'':` en ${filtro}`}</div>`;
    applyAutoMode(); // limpia timers igual
    return;
  }

  porDestino.forEach((lista, destino)=>{
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

    lista.forEach(g=>{
      const hoy = Array.isArray(g.itinerario?.[dISO]) ? g.itinerario[dISO] : [];
      const anal = analizarDia(hoy, nowMin);

      const prevTxt   = anal.prev ? (anal.prev.actividad||'—').toString().toUpperCase() : '—';
      const nowTxt    = anal.now  ? (anal.now.actividad ||'—').toString().toUpperCase() : '—';
      const nextTxt   = anal.next ? (anal.next.actividad||'—').toString().toUpperCase() : '—';

      const prevRange = anal.prev ? `${anal.prev.horaInicio||'--:--'} – ${obtenerFin(anal.prev)}` : '';
      const nowRange  = anal.now  ? `${anal.now.horaInicio||'--:--'} – ${obtenerFin(anal.now)}`   : '';
      const nextRange = anal.next ? `${anal.next.horaInicio||'--:--'} – ${obtenerFin(anal.next)}` : '';

      const card = document.createElement('article');
      card.className = 'card';
      card.innerHTML = `
        <div>
          <h3>${(g.nombreGrupo||'—')}</h3>
          <div class="sub">Programa: ${(g.programa||'—')} · N° ${g.numeroNegocio ?? g.id}</div>
          <div class="sub">Coordinador(a): ${coordinadorTexto(g)}</div>
        </div>

        <div class="stage">
          <div class="stage-hd">Antes</div>
          <div class="stage-box">
            <div class="title">${prevTxt}</div>
            <div class="time">${prevRange || '—'}</div>
          </div>
        </div>

        <div class="stage">
          <div class="stage-hd">Ahora</div>
          <div class="stage-box stage-now">
            <div class="title">${nowTxt}</div>
            <div class="time">${nowRange || '—'}</div>
          </div>
        </div>

        <div class="stage">
          <div class="stage-hd">Después</div>
          <div class="stage-box">
            <div class="title">${nextTxt}</div>
            <div class="time">${nextRange || '—'}</div>
          </div>
        </div>
      `;
      grid.appendChild(card);
    });

    cont.appendChild(blk);
  });

  applyAutoMode();  // re-aplica modo monitor tras cada render
}

/* ========== UI / eventos ========== */
function humanSpeedLabel(){ return `x${autoSpeed.value}`; }
function secsForCarousel(){ const v=Number(autoSpeed.value||5); return Math.max(2, 22 - v*2); } // 20..2s
function pxPerStepForScroll(){ const v=Number(autoSpeed.value||5); return Math.min(6, Math.max(1, Math.round(v*0.6))); }
function stepIntervalMs(){ return 40; }

function applyUIMonitorClass(on){
  document.body.classList.toggle('monitor', !!on);
  updateHUD();
}
function toggleMonitor(){ applyUIMonitorClass(!document.body.classList.contains('monitor')); }
function updateHUD(){
  if(!hud) return;
  const mode = (autoModeSel.value || '__OFF__');
  const label = (mode==='__OFF__') ? 'SIN MOVIMIENTO' : mode;
  hud.textContent = `Actualizado: ${fmtFechaHumana(new Date())} · ${label} · vel ${humanSpeedLabel()} · [M] UI · [F] Fullscreen`;
}

function initUI(){
  // URL inicial para modo/velocidad
  const urlMode  = (getParam('mode') || '').toUpperCase();   // SCROLL | CAROUSEL | __OFF__
  const urlSpeed = parseInt(getParam('speed') || '', 10);
  if(['SCROLL','CAROUSEL','__OFF__'].includes(urlMode)) autoModeSel.value = urlMode;
  if(urlSpeed>=1 && urlSpeed<=10){ autoSpeed.value=String(urlSpeed); if(speedLabel) speedLabel.textContent = `x${urlSpeed}`; }

  // Simulación input
  if(state.forceNowIso){
    let v=state.forceNowIso; if(/^\d{4}-\d{2}-\d{2}$/.test(v)) v+='T12:00'; v=v.replace(/:\d{2}$/,'');
    if(simNowInput) simNowInput.value = v;
  }

  simNowInput?.addEventListener('change', ()=>{ state.forceNowIso = simNowInput.value || null; cargarYRender(); });
  btnNowReal?.addEventListener('click', ()=>{ state.forceNowIso=null; simNowInput.value=''; cargarYRender(); });
  btnRefrescar?.addEventListener('click', ()=>cargarYRender());
  filtroDestino?.addEventListener('change', ()=>cargarYRender());

  autoSpeed?.addEventListener('input', ()=>{ if(speedLabel) speedLabel.textContent=humanSpeedLabel(); applyAutoMode(); updateHUD(); });
  autoModeSel?.addEventListener('change', ()=>{ applyAutoMode(); updateHUD(); });

  // Pausa breve por interacción del usuario
  ['wheel','mousemove','keydown','touchstart'].forEach(evt=>{
    window.addEventListener(evt, ()=>pauseAuto(6000), { passive:true });
  });

  // arrancar en monitor si ?monitor=1 o ?ui=off
  const startMonitor = getBoolParam('monitor') || (getParam('ui')||'').toLowerCase()==='off';
  applyUIMonitorClass(startMonitor);

  // Atajos
  window.addEventListener('keydown', e=>{
    const k=e.key.toLowerCase();
    if(k==='m') toggleMonitor();
    if(k==='f') toggleFullscreen();
  });

  updateHUD();
}

let dataTimer=null;
async function cargarYRender(){
  const dNow = nowDate();
  setLastRefresh(new Date());
  const dISO = isoDate(dNow);
  const grupos = await leerGruposActivosPara(dISO);

  if(!filtroDestino.options || filtroDestino.options.length<=1) buildDestinos(grupos);
  render(grupos, dNow);
}
function startAutoRefresh(){ if(dataTimer) clearInterval(dataTimer); dataTimer = setInterval(()=>cargarYRender().catch(console.error), AUTO_REFRESH_MS); }

/* ========== Modo monitor: carrusel / scroll ========== */
let carouselTimer=null, scrollTimer=null, pausedUntil=0, currentDestinoIndex=0;
const nowMs = ()=>Date.now();
const pauseAuto = (ms=6000)=>{ pausedUntil = nowMs()+ms; };
const isPaused = ()=> nowMs() < pausedUntil;
const stopCarousel = ()=>{ if(carouselTimer){ clearInterval(carouselTimer); carouselTimer=null; } };
const stopScroll   = ()=>{ if(scrollTimer){ clearInterval(scrollTimer); scrollTimer=null; } };
const allDestBlocks = ()=> Array.from(cont.querySelectorAll('.destino-bloque'));

function showOnlyDestino(idx){
  const blocks = allDestBlocks(); if(!blocks.length) return;
  currentDestinoIndex = ((idx%blocks.length)+blocks.length)%blocks.length;
  blocks.forEach((b,i)=>{
    if(i===currentDestinoIndex){
      b.classList.remove('is-hidden'); requestAnimationFrame(()=>b.classList.remove('fade-out'));
      b.scrollIntoView({ behavior:'smooth', block:'start' });
    } else {
      b.classList.add('fade-out'); setTimeout(()=>b.classList.add('is-hidden'), 300);
    }
  });
}
function startCarousel(){
  stopScroll(); stopCarousel();
  const blocks = allDestBlocks(); if(!blocks.length) return;
  showOnlyDestino(currentDestinoIndex||0);
  carouselTimer = setInterval(()=>{ if(!isPaused()) showOnlyDestino(currentDestinoIndex+1); }, secsForCarousel()*1000);
}
function startScroll(){
  stopCarousel(); stopScroll();
  allDestBlocks().forEach(b=>b.classList.remove('is-hidden','fade-out'));
  const stepPx = pxPerStepForScroll(); const stepMs = stepIntervalMs();
  scrollTimer = setInterval(()=>{
    if(isPaused()) return;
    const bottom = Math.ceil(window.innerHeight + window.scrollY);
    const full   = Math.ceil(document.body.scrollHeight);
    if(bottom >= full - 2){ window.scrollTo({ top:0, behavior:'smooth' }); return; }
    window.scrollBy(0, stepPx);
  }, stepMs);
}
function applyAutoMode(){
  const mode = autoModeSel?.value || '__OFF__';
  if(mode==='CAROUSEL') startCarousel();
  else if(mode==='SCROLL') startScroll();
  else { stopCarousel(); stopScroll(); allDestBlocks().forEach(b=>b.classList.remove('is-hidden','fade-out')); }
  updateHUD();
}

/* ========== Boot ========== */
initUI();
cargarYRender()
  .then(()=>{ startAutoRefresh(); applyAutoMode(); })
  .catch(err=>{
    console.error('Error inicial:', err);
    cont.innerHTML = `<div class="pill">Error cargando datos.</div>`;
  });
