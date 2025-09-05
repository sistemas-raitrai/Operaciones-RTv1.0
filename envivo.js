// En vivo — dónde están los grupos (solo lectura, sin auth)
// - Cards DOBLES de ancho (grilla usa --col-min: 560px)
// - Vista TRIPTYCH / FULL_DAY, multiselect para ocultar actividades
// - Monitor (ocultar panel), HUD, atajos M/F, carrusel/scroll en loop
// - Coordinador(a), simulación ?now=, auto-refresh 30min

import { app, db } from './firebase-core.js';
import { collection, getDocs } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

/* ===== Config ===== */
const DEFAULT_FORCE_NOW_ISO = '';            // ej. '2025-12-15T10:00'
const DURACION_POR_DEFECTO_MIN = 60;
const AUTO_REFRESH_MS = 30 * 60 * 1000;

/* ===== Utils fecha/hora ===== */
const pad2 = n => String(n).padStart(2,'0');
const isoDate = d => `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
function parseHM(hm=''){ const m=/^(\d{1,2}):(\d{2})$/.exec((hm||'').trim()); if(!m) return null; const hh=Math.min(23,Math.max(0,parseInt(m[1],10))); const mm=Math.min(59,Math.max(0,parseInt(m[2],10))); return hh*60+mm; }
const toHM = mins => `${pad2(Math.floor(mins/60))}:${pad2(mins%60)}`;
function addToHM(hm, minutes){ const base=parseHM(hm) ?? 0; const t=Math.max(0,Math.min(24*60-1, base+minutes)); return toHM(t); }
const normName = s => (s||'').toString().trim().toUpperCase();

/* ===== Query/helpers ===== */
function getParam(name){ const qs=new URLSearchParams(location.search); const v=qs.get(name); return v===null?null:String(v); }
function getBoolParam(name){ const v=getParam(name); if(v===null) return false; return ['1','true','on','yes'].includes(v.toLowerCase()); }
async function toggleFullscreen(){ try{ if(!document.fullscreenElement) await document.documentElement.requestFullscreen(); else await document.exitFullscreen(); }catch(_){} }

/* ===== "Ahora" ===== */
function getQueryNow(){ const raw=getParam('now'); if(!raw) return null; if(/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?$/.test(raw)) return raw.replace(' ','T'); return null; }
let state = { forceNowIso: getQueryNow() || DEFAULT_FORCE_NOW_ISO || null };
function nowDate(){ if(state.forceNowIso){ let v=state.forceNowIso; if(/^\d{4}-\d{2}-\d{2}$/.test(v)) v+='T12:00'; return new Date(v); } return new Date(); }

/* ===== Coordinador ===== */
function coordinadorTexto(g){
  const c = g.coordinador ?? g.coordinadorNombre ?? g.coordinadorAsignado ?? null;
  if(!c) return '—';
  if(typeof c === 'string') return c;
  const nombre = c.nombre || c.name || '—';
  const alias  = c.alias ? ` (${c.alias})` : '';
  const fono   = c.telefono || c.celular || c.fono || '';
  return [nombre + alias, fono].filter(Boolean).join(' · ');
}

// Devuelve un texto bonito con la vendedora (o ejecutivo comercial)
function vendedoraTexto(g){
  // Soporta varios nombres de campo y formatos (string u objeto)
  const v =
    g.vendedora ?? g.vendedoraNombre ?? g.vendedoraAsignada ??
    g.vendedor ?? g.vendedorNombre ??
    g.ejecutiva ?? g.ejecutivo ??
    g.ejecutivaComercial ?? g.ejecutivoComercial ??
    g.comercial ?? null;

  if (!v) return '—';
  if (typeof v === 'string') return v;

  // Si viene como objeto
  const nombre = v.nombre || v.name || '—';
  const alias  = v.alias ? ` (${v.alias})` : '';
  const fono   = v.telefono || v.celular || v.fono || '';
  const mail   = v.email || v.correo || '';
  return [nombre + alias, fono, mail].filter(Boolean).join(' · ');
}

/* ===== Datos ===== */
async function leerGruposActivosPara(fechaISO){
  const snap = await getDocs(collection(db,'grupos'));
  const todos = snap.docs.map(d => ({ id:d.id, ...d.data() }));
  return todos.filter(g => g.fechaInicio && g.fechaFin && g.fechaInicio <= fechaISO && fechaISO <= g.fechaFin);
}

/* ===== Cálculos del día ===== */
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

/* ===== DOM ===== */
const cont = document.getElementById('contenedor');
const filtroDestino = document.getElementById('filtroDestino');
const simNowInput = document.getElementById('simNow');
const btnNowReal = document.getElementById('btnNowReal');
const btnRefrescar = document.getElementById('btnRefrescar');
const btnToggleUI = document.getElementById('btnToggleUI');
const lastRefresh = document.getElementById('lastRefresh');
const autoModeSel = document.getElementById('autoMode');
const autoSpeed = document.getElementById('autoSpeed');
const speedLabel = document.getElementById('speedLabel');
const viewModeSel = document.getElementById('viewMode');
const actFilter = document.getElementById('actFilter');
const btnClearActs = document.getElementById('btnClearActs');
const hiddenCount = document.getElementById('hiddenCount');
const hud = document.getElementById('hud');

function fmtFechaHumana(d){ return d.toLocaleString('es-CL',{dateStyle:'medium', timeStyle:'short'}); }
function setLastRefresh(d){ if(lastRefresh) lastRefresh.textContent = `Actualizado: ${fmtFechaHumana(d)}`; updateHUD(); }

/* ===== Filtros de actividades ===== */
const hiddenActs = new Set();
function setHiddenFromSelect(){
  hiddenActs.clear();
  Array.from(actFilter.selectedOptions).forEach(o => hiddenActs.add(o.value));
  hiddenCount.textContent = `${hiddenActs.size} ocultas`;
}
function buildActivityOptions(grupos, fechaISO){
  const set = new Set();
  for(const g of grupos){
    const list = Array.isArray(g.itinerario?.[fechaISO]) ? g.itinerario[fechaISO] : [];
    for(const a of list){ const n = normName(a?.actividad); if(n) set.add(n); }
  }
  const arr = [...set].sort((a,b)=>a.localeCompare(b));
  actFilter.innerHTML = arr.map(n => `<option value="${n}" ${hiddenActs.has(n)?'selected':''}>${n}</option>`).join('');
  hiddenCount.textContent = `${hiddenActs.size} ocultas`;
}
function filtrarActividades(lista){
  if(!hiddenActs.size) return lista;
  return (lista||[]).filter(a => !hiddenActs.has(normName(a?.actividad)));
}

/* ===== Render ===== */
function buildDestinos(grupos){
  const set = new Set(); grupos.forEach(g=>{ if(g.destino) set.add(g.destino); });
  const list = ['__ALL__', ...[...set].sort((a,b)=>a.localeCompare(b))];
  filtroDestino.innerHTML = list.map(v=>`<option value="${v}">${v==='__ALL__'?'Todos':v}</option>`).join('');
}

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
    applyAutoMode();
    return;
  }

  const viewMode = (viewModeSel?.value || 'TRIPTYCH');

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
      <div class="grupo-grid"></div>
    `;
    const grid = blk.querySelector('.grupo-grid');

    lista.forEach(g=>{
      const crudo = Array.isArray(g.itinerario?.[dISO]) ? g.itinerario[dISO] : [];
      const hoy = filtrarActividades(crudo);
      const anal = analizarDia(hoy, nowMin);

      const card = document.createElement('article');
      card.className = 'group-card';

      const headerHTML = `
        <div>
          <h3>${(g.nombreGrupo||'—')}</h3>
          <br>
          <div class="sub">Programa: ${(g.programa||'—')} · N° ${g.numeroNegocio ?? g.id}</div>
          <div class="sub">Coordinador(a): ${coordinadorTexto(g)}</div>
          <div class="sub">Vendedor(a): ${vendedoraTexto(g)}</div> 
        </div>
      `;

      if(viewMode === 'TRIPTYCH'){
        const prevTxt   = anal.prev ? normName(anal.prev.actividad) : '—';
        const nowTxt    = anal.now  ? normName(anal.now.actividad)  : '—';
        const nextTxt   = anal.next ? normName(anal.next.actividad) : '—';

        const prevRange = anal.prev ? `${anal.prev.horaInicio||'--:--'} – ${obtenerFin(anal.prev)}` : '';
        const nowRange  = anal.now  ? `${anal.now.horaInicio||'--:--'} – ${obtenerFin(anal.now)}`   : '';
        const nextRange = anal.next ? `${anal.next.horaInicio||'--:--'} – ${obtenerFin(anal.next)}` : '';

        card.innerHTML = `
          ${headerHTML}
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
      } else {
        const list = ordenarPorHora(hoy);
        const items = list.map(a=>{
          const ini = parseHM(a?.horaInicio || '00:00') ?? 0;
          const fin = parseHM(obtenerFin(a)) ?? 0;
          const cls = (ini<=nowMin && nowMin<fin) ? 'is-now' : (fin<=nowMin ? 'is-past' : '');
          return `
            <div class="act-item ${cls}">
              <div class="name">${normName(a?.actividad)}</div>
              <div class="time">${a?.horaInicio||'--:--'} – ${obtenerFin(a)}</div>
            </div>
          `;
        }).join('') || `<div class="act-item"><div class="name">—</div><div class="time">—</div></div>`;

        card.innerHTML = `${headerHTML}<div class="day-list">${items}</div>`;
      }

      grid.appendChild(card);
    });

    cont.appendChild(blk);
  });

  applyAutoMode();  // re-aplica movimiento tras cada render
}

/* ===== UI / eventos ===== */
function humanSpeedLabel(){ return `x${autoSpeed.value}`; }
function secsForCarousel(){ const v=Number(autoSpeed.value||5); return Math.max(2, 22 - v*2); } // 20..2s
function pxPerStepForScroll(){ const v=Number(autoSpeed.value||5); return Math.min(6, Math.max(1, Math.round(v*0.6))); }
function stepIntervalMs(){ return 40; }

function applyUIMonitorClass(on){
  document.body.classList.toggle('monitor', !!on);
  if(btnToggleUI) btnToggleUI.textContent = on ? 'Mostrar panel' : 'Ocultar panel';
  updateHUD();
}
function toggleMonitor(){ applyUIMonitorClass(!document.body.classList.contains('monitor')); }
function updateHUD(){
  if(!hud) return;
  const mode = (autoModeSel?.value || '__OFF__');
  const label = (mode==='__OFF__') ? 'SIN MOVIMIENTO' : mode;
  hud.textContent = `Actualizado: ${fmtFechaHumana(new Date())} · ${label} · vel ${humanSpeedLabel()} · click/M: UI · F: fullscreen`;
}

function initUI(){
  // Modo/velocidad por URL (opcional)
  const urlMode  = (getParam('mode') || '').toUpperCase();
  const urlSpeed = parseInt(getParam('speed') || '', 10);
  if(['SCROLL','CAROUSEL','__OFF__'].includes(urlMode)) autoModeSel.value = urlMode;
  if(urlSpeed>=1 && urlSpeed<=10){ autoSpeed.value=String(urlSpeed); if(speedLabel) speedLabel.textContent = `x${urlSpeed}`; }

  // Simulación input
  if(state.forceNowIso){
    let v=state.forceNowIso; if(/^\d{4}-\d{2}-\d{2}$/.test(v)) v+='T12:00'; v=v.replace(/:\d{2}$/,'');
    simNowInput && (simNowInput.value = v);
  }

  simNowInput?.addEventListener('change', ()=>{ state.forceNowIso = simNowInput.value || null; cargarYRender(); });
  btnNowReal?.addEventListener('click', ()=>{ state.forceNowIso=null; simNowInput.value=''; cargarYRender(); });
  btnRefrescar?.addEventListener('click', ()=>cargarYRender());
  filtroDestino?.addEventListener('change', ()=>cargarYRender());
  viewModeSel?.addEventListener('change', ()=>render(lastGrupos, lastNow));
  autoSpeed?.addEventListener('input', ()=>{ speedLabel && (speedLabel.textContent=humanSpeedLabel()); applyAutoMode(); updateHUD(); });
  autoModeSel?.addEventListener('change', ()=>{ applyAutoMode(); updateHUD(); });

  // Filtros actividades
  actFilter?.addEventListener('change', ()=>{ setHiddenFromSelect(); render(lastGrupos, lastNow); });
  btnClearActs?.addEventListener('click', ()=>{ hiddenActs.clear(); buildActivityOptions(lastGrupos, isoDate(lastNow)); render(lastGrupos, lastNow); });

  // Ocultar/mostrar panel
  btnToggleUI?.addEventListener('click', ()=> toggleMonitor());
  hud?.addEventListener('click', ()=> toggleMonitor());

  // Pausa breve por interacción usuario
  ['wheel','mousemove','keydown','touchstart'].forEach(evt=>{
    window.addEventListener(evt, ()=>pauseAuto(6000), { passive:true });
  });

  // Iniciar en monitor si ?monitor=1 o ?ui=off
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

/* ===== Carga/render ===== */
let dataTimer=null;
let lastGrupos=[], lastNow=new Date();
async function cargarYRender(){
  const dNow = nowDate();
  lastNow = dNow;
  setLastRefresh(new Date());
  const dISO = isoDate(dNow);
  const grupos = await leerGruposActivosPara(dISO);
  lastGrupos = grupos;

  if(!filtroDestino.options || filtroDestino.options.length<=1) buildDestinos(grupos);
  buildActivityOptions(grupos, dISO); // opciones multiselect
  render(grupos, dNow);
}
function startAutoRefresh(){ if(dataTimer) clearInterval(dataTimer); dataTimer = setInterval(()=>cargarYRender().catch(console.error), AUTO_REFRESH_MS); }

/* ===== Monitor: CAROUSEL / SCROLL (loop robusto) ===== */
let carouselTimer=null, scrollTimer=null, pausedUntil=0, currentDestinoIndex=0;
const nowMs = ()=>Date.now();
const pauseAuto = (ms=6000)=>{ pausedUntil = nowMs()+ms; };
const isPaused = ()=> nowMs() < pausedUntil;
const stopCarousel = ()=>{ if(carouselTimer){ clearTimeout(carouselTimer); carouselTimer=null; } };
const stopScroll   = ()=>{ if(scrollTimer){ clearInterval(scrollTimer); scrollTimer=null; } };
const allDestBlocks = ()=> Array.from(cont.querySelectorAll('.destino-bloque'));

function showOnlyDestino(idx){
  const blocks = allDestBlocks(); if(!blocks.length) return;
  currentDestinoIndex = ((idx%blocks.length)+blocks.length)%blocks.length;
  blocks.forEach((b,i)=>{
    if(i===currentDestinoIndex){
      b.classList.remove('is-hidden'); requestAnimationFrame(()=>b.classList.remove('fade-out'));
      b.scrollIntoView({ behavior:'instant', block:'start' });
    } else {
      b.classList.add('fade-out'); setTimeout(()=>b.classList.add('is-hidden'), 300);
    }
  });
}

function scheduleCarouselNext(){
  if(isPaused()){ carouselTimer = setTimeout(scheduleCarouselNext, 250); return; }
  showOnlyDestino(currentDestinoIndex + 1);
  carouselTimer = setTimeout(scheduleCarouselNext, secsForCarousel()*1000);
}
function startCarousel(){
  stopScroll(); stopCarousel();
  if(!allDestBlocks().length) return;
  showOnlyDestino(currentDestinoIndex || 0);
  scheduleCarouselNext();
}

function startScroll(){
  stopCarousel(); stopScroll();
  allDestBlocks().forEach(b=>b.classList.remove('is-hidden','fade-out'));
  const stepPx = pxPerStepForScroll();
  const stepMs = stepIntervalMs();
  scrollTimer = setInterval(()=>{
    if(isPaused()) return;
    const doc = document.documentElement;
    const body = document.body;
    const viewH = window.innerHeight;
    const fullH = Math.max(doc.scrollHeight, body.scrollHeight);
    const maxY  = fullH - viewH;

    if(window.scrollY >= maxY - 2){
      window.scrollTo(0, 0);
      return;
    }
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

/* ===== Boot ===== */
initUI();
cargarYRender()
  .then(()=>{ startAutoRefresh(); applyAutoMode(); })
  .catch(err=>{
    console.error('Error inicial:', err);
    cont.innerHTML = `<div class="pill">Error cargando datos.</div>`;
  });
