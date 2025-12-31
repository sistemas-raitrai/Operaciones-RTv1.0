// bitacora_actividad.js
// RT · Bitácora por grupo / por destino (actividad transversal)
// Estructura esperada:
//   grupos/{gid}/bitacora/{actividadId}/{YYYY-MM-DD}/{docId}
// donde docId suele ser tipo "19:24:01.338"
// y cada doc tiene: texto, byEmail, byUid, ts (Timestamp o number)

import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged, signOut }
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';

import {
  collection, getDocs, doc, getDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

/* =========================
   HELPERS
========================= */
const TZ = 'America/Santiago';

const coalesce = (...xs) =>
  xs.find(v => v !== undefined && v !== null && v !== '') ?? '';

const norm = (s='') =>
  String(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();

function escapeHtml(str='') {
  return String(str)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#039;');
}

function fmtClockNow() {
  try {
    const d = new Date();
    const date = d.toLocaleDateString('es-CL', { timeZone: TZ, weekday:'long', year:'numeric', month:'long', day:'numeric' });
    const time = d.toLocaleTimeString('es-CL', { timeZone: TZ });
    return `${time} | ${date}`;
  } catch {
    return new Date().toLocaleString();
  }
}

function setStatus(msg) {
  const el = document.getElementById('status');
  if (el) el.textContent = msg;
}

function setModeHint(msg) {
  const el = document.getElementById('modeHint');
  if (el) el.textContent = msg;
}

function setKpis({ grupos='—', dias='—', entradas=0 } = {}) {
  const g = document.getElementById('kpiGrupos');
  const d = document.getElementById('kpiDias');
  const e = document.getElementById('kpiEntradas');
  if (g) g.textContent = grupos;
  if (d) d.textContent = dias;
  if (e) e.textContent = String(entradas ?? 0);
}

function toISODate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  return `${yyyy}-${mm}-${dd}`;
}

function parseTsToMs(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return isFinite(t) ? t : 0;
  }
  if (typeof v === 'object') {
    // Firestore Timestamp
    if (typeof v.toDate === 'function') {
      try { return v.toDate().getTime(); } catch { return 0; }
    }
    if ('seconds' in v) return v.seconds*1000 + Math.floor((v.nanoseconds||0)/1e6);
  }
  return 0;
}

function msToHora(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2,'0');
  const mm = String(d.getMinutes()).padStart(2,'0');
  const ss = String(d.getSeconds()).padStart(2,'0');
  return `${hh}:${mm}:${ss}`;
}

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

/* =========================
   STATE
========================= */
const state = {
  user: null,

  // cache grupos: gid -> info
  grupos: new Map(),

  // filtros UI
  filtros: {
    destino: '',
    coord: '',
    grupo: '',
    actividad: '',
    desde: '',
    hasta: '',
    buscarTxt: ''
  },

  // actividades sugeridas (Set)
  actividades: new Set(),

  // resultados completos (sin filtro texto) y visibles
  resultsAll: [],
  resultsView: []
};

/* =========================
   UI GETTERS
========================= */
function readFiltersFromUI() {
  state.filtros.destino = (document.getElementById('fDestino')?.value || '').trim();
  state.filtros.coord   = (document.getElementById('fCoord')?.value || '').trim().toLowerCase();
  state.filtros.grupo   = (document.getElementById('fGrupo')?.value || '').trim();
  state.filtros.actividad = (document.getElementById('fActividad')?.value || '').trim();
  state.filtros.desde = (document.getElementById('fDesde')?.value || '').trim();
  state.filtros.hasta = (document.getElementById('fHasta')?.value || '').trim();
  state.filtros.buscarTxt = (document.getElementById('fBuscarTxt')?.value || '').trim();
}

function ensureDateRange() {
  // default: hoy .. hoy si no hay nada
  const today = toISODate(new Date());
  const inpD = document.getElementById('fDesde');
  const inpH = document.getElementById('fHasta');

  if (inpD && !inpD.value) inpD.value = today;
  if (inpH && !inpH.value) inpH.value = today;
}

/* =========================
   CATALOGOS (grupos, destinos, coords)
========================= */
async function preloadGruposCatalog() {
  state.grupos.clear();

  const dlGrupos = document.getElementById('dl-grupos');
  const dlCoords = document.getElementById('dl-coords');
  const dlDest   = document.getElementById('dl-destinos');
  if (dlGrupos) dlGrupos.innerHTML = '';
  if (dlCoords) dlCoords.innerHTML = '';
  if (dlDest)   dlDest.innerHTML = '';

  setStatus('Cargando catálogo de grupos…');

  const snap = await getDocs(collection(db,'grupos'));

  const coordsSet = new Set();
  const destSet   = new Set();

  snap.forEach(d => {
    const x = d.data() || {};
    const gid = d.id;

    const numero = coalesce(x.numeroNegocio, x.numNegocio, x.idNegocio, gid);
    const nombre = coalesce(x.nombreGrupo, x.aliasGrupo, x.nombre, x.grupo, gid);

    const destino = coalesce(x.destino, x.lugar, '').toString().trim();
    const coordEmail = coalesce(
      x.coordinadorEmail,
      x.coordinador?.email,
      x.coordinador,
      x.coord,
      x.responsable,
      x.owner,
      ''
    ).toString().trim().toLowerCase();

    state.grupos.set(gid, { gid, numero, nombre, destino, coordEmail });

    if (coordEmail) coordsSet.add(coordEmail);
    if (destino) destSet.add(destino);

    if (dlGrupos) {
      const opt = document.createElement('option');
      opt.value = gid;
      opt.label = `${numero} — ${nombre}`;
      dlGrupos.appendChild(opt);
    }
  });

  // coords
  if (dlCoords) {
    [...coordsSet].sort().forEach(email => {
      const opt = document.createElement('option');
      opt.value = email;
      opt.label = email;
      dlCoords.appendChild(opt);
    });
  }

  // destinos
  if (dlDest) {
    [...destSet].sort((a,b)=>a.localeCompare(b,'es')).forEach(dest => {
      const opt = document.createElement('option');
      opt.value = dest;
      opt.label = dest;
      dlDest.appendChild(opt);
    });
  }

  setStatus(`Catálogo listo. Grupos: ${state.grupos.size}`);
}

/* =========================
   MODO SELECCIÓN
========================= */
function computeMode() {
  // si hay grupo => modo GRUPO
  // si no hay grupo pero hay destino => modo DESTINO
  // si ninguno => invalido
  const gid = (state.filtros.grupo || '').trim();
  const dest = (state.filtros.destino || '').trim();

  if (gid) return 'GRUPO';
  if (dest) return 'DESTINO';
  return 'NONE';
}

/* =========================
   RESOLVER GRUPOS OBJETIVO
========================= */
function resolveTargetGroups() {
  // Si hay grupo específico, solo ese.
  // Si no, filtra por destino (obligatorio en este modo) y opcionalmente coord.
  const gid = (state.filtros.grupo || '').trim();
  const dest = (state.filtros.destino || '').trim();
  const coord = (state.filtros.coord || '').trim().toLowerCase();

  if (gid) {
    const g = state.grupos.get(gid);
    return g ? [g] : [{ gid, numero: gid, nombre: gid, destino:'', coordEmail:'' }];
  }

  const destN = norm(dest);
  const out = [];
  for (const g of state.grupos.values()) {
    if (destN && norm(g.destino) !== destN) continue;
    if (coord && (g.coordEmail || '').toLowerCase() !== coord) continue;
    out.push(g);
  }
  return out;
}

/* =========================
   ACTIVIDADES: sugerencias
========================= */
async function loadSuggestedActivities() {
  readFiltersFromUI();
  const targets = resolveTargetGroups();
  state.actividades.clear();

  const dlActs = document.getElementById('dl-actividades');
  if (dlActs) dlActs.innerHTML = '';
  const actCount = document.getElementById('actCount');
  if (actCount) actCount.textContent = 'Actividades sugeridas: 0';

  if (!targets.length) {
    setStatus('Sin grupos objetivo para cargar actividades.');
    return;
  }

  setStatus(`Cargando actividades (leyendo bitacora/*) en ${targets.length} grupo(s)…`);

  // Para no saturar: limitamos a primeras N lecturas si fuese enorme
  const MAX_GROUPS = 80;
  const safeTargets = targets.slice(0, MAX_GROUPS);

  let groupsDone = 0;

  for (const g of safeTargets) {
    try {
      const refActs = collection(db,'grupos',g.gid,'bitacora');
      const snapActs = await getDocs(refActs);
      snapActs.forEach(a => state.actividades.add(a.id));
    } catch (e) {
      // si no existe bitacora, no pasa nada
      console.warn('[BIT] loadSuggestedActivities group', g.gid, e);
    }
    groupsDone++;
    if (groupsDone % 6 === 0) await sleep(30);
  }

  // Render datalist
  const acts = [...state.actividades].sort((a,b)=>a.localeCompare(b,'es'));
  if (dlActs) {
    acts.forEach(id => {
      const opt = document.createElement('option');
      opt.value = id;
      opt.label = id;
      dlActs.appendChild(opt);
    });
  }

  if (actCount) actCount.textContent = `Actividades sugeridas: ${acts.length}`;
  setStatus(`Actividades cargadas: ${acts.length} (desde ${safeTargets.length} grupo(s)).`);
}

/* =========================
   LECTURA BITÁCORA
========================= */
function listDatesInRange(desdeISO, hastaISO) {
  const out = [];
  const d1 = new Date(`${desdeISO}T00:00:00`);
  const d2 = new Date(`${hastaISO}T00:00:00`);
  if (isNaN(d1) || isNaN(d2)) return out;

  const step = d1 <= d2 ? 1 : -1;
  const cur = new Date(d1);

  while (true) {
    out.push(toISODate(cur));
    if (toISODate(cur) === toISODate(d2)) break;
    cur.setDate(cur.getDate() + step);

    // safety
    if (out.length > 370) break;
  }

  // si venía invertido, igual devolvemos en orden ascendente
  return out.sort();
}

async function fetchBitacoraForGroup(g, datesISO, actividadFiltro='') {
  // Devuelve array de entradas normalizadas para ese grupo.
  const out = [];
  const gid = g.gid;

  // Actividades: si hay filtro, usamos solo esa.
  let activities = [];
  if (actividadFiltro) {
    activities = [actividadFiltro];
  } else {
    // listar actividades reales del grupo
    try {
      const snapActs = await getDocs(collection(db,'grupos',gid,'bitacora'));
      activities = snapActs.docs.map(d => d.id);
    } catch (e) {
      // no bitacora
      return out;
    }
  }

  for (const actId of activities) {
    for (const dateISO of datesISO) {
      try {
        const refDay = collection(db,'grupos',gid,'bitacora',actId,dateISO);
        const snapDay = await getDocs(refDay);

        snapDay.forEach(docSnap => {
          const x = docSnap.data() || {};

          const texto = coalesce(x.texto, x.text, x.comentario, x.msg, '');
          const byEmail = coalesce(x.byEmail, x.email, x.autorEmail, x.by, '');
          const tsMs = parseTsToMs(coalesce(x.ts, x.at, x.createdAt, x.timestamp, x.time, 0));

          // Hora: preferimos ts; si no hay, intentamos parsear docId "19:24:01.338"
          let hora = tsMs ? msToHora(tsMs) : '—';
          if (!tsMs && typeof docSnap.id === 'string' && docSnap.id.includes(':')) {
            hora = docSnap.id;
          }

          out.push({
            gid,
            grupoLabel: `${g.numero || gid} — ${g.nombre || gid}`,
            destino: g.destino || '',
            coordEmail: g.coordEmail || '',
            actividadId: actId,
            fechaISO: dateISO,
            hora,
            texto,
            byEmail,
            byUid: coalesce(x.byUid, x.uid, ''),
            tsMs: tsMs || 0
          });
        });
      } catch (e) {
        // si no existe esa subcolección, Firestore devuelve vacío, pero si hay error real, seguimos
        // console.warn('[BIT] day fetch', gid, actId, dateISO, e);
      }
    }
  }

  return out;
}

async function loadBitacora() {
  readFiltersFromUI();
  ensureDateRange();

  const mode = computeMode();
  if (mode === 'NONE') {
    alert('Debes elegir al menos un GRUPO específico o un DESTINO.');
    return;
  }

  const desde = state.filtros.desde || document.getElementById('fDesde')?.value;
  const hasta = state.filtros.hasta || document.getElementById('fHasta')?.value;

  if (!desde || !hasta) {
    alert('Selecciona un rango de fechas (Desde / Hasta).');
    return;
  }

  const datesISO = listDatesInRange(desde, hasta);
  if (!datesISO.length) {
    alert('Rango de fechas inválido.');
    return;
  }

  const targets = resolveTargetGroups();

  // Hint modo
  if (mode === 'GRUPO') setModeHint('Modo: GRUPO (todas las actividades del grupo)');
  if (mode === 'DESTINO') setModeHint('Modo: DESTINO (actividades y comentarios de todos los grupos)');

  if (!targets.length) {
    setStatus('No hay grupos que coincidan con ese destino/coordinador.');
    setKpis({ grupos: 0, dias: datesISO.length, entradas: 0 });
    state.resultsAll = [];
    applyTextFilterAndRender();
    return;
  }

  setStatus(`Consultando bitácora… grupos: ${targets.length} · días: ${datesISO.length}`);
  setKpis({ grupos: targets.length, dias: datesISO.length, entradas: 0 });

  const actividadFiltro = (state.filtros.actividad || '').trim();

  // Para no reventar UI si hay muchos grupos, hacemos lazo y render parcial
  const all = [];
  let processed = 0;

  for (const g of targets) {
    const chunk = await fetchBitacoraForGroup(g, datesISO, actividadFiltro);
    all.push(...chunk);

    processed++;
    setStatus(`Consultando bitácora… ${processed}/${targets.length} grupos. Entradas: ${all.length}`);
    setKpis({ grupos: targets.length, dias: datesISO.length, entradas: all.length });

    if (processed % 3 === 0) await sleep(30);
  }

  // Orden: fecha + (ts) + grupo + actividad
  all.sort((a,b) => {
    if (a.fechaISO !== b.fechaISO) return a.fechaISO.localeCompare(b.fechaISO);
    const ta = a.tsMs || 0;
    const tb = b.tsMs || 0;
    if (ta !== tb) return ta - tb;
    if (a.grupoLabel !== b.grupoLabel) return a.grupoLabel.localeCompare(b.grupoLabel,'es');
    return a.actividadId.localeCompare(b.actividadId,'es');
  });

  state.resultsAll = all;
  applyTextFilterAndRender();

  setStatus(`Listo. Entradas: ${all.length}`);
}

/* =========================
   FILTRO TEXTO + RENDER
========================= */
function applyTextFilterAndRender() {
  const q = norm(state.filtros.buscarTxt || '');
  if (!q) {
    state.resultsView = state.resultsAll.slice();
  } else {
    state.resultsView = state.resultsAll.filter(r => {
      const hay = [
        r.texto, r.byEmail, r.grupoLabel, r.actividadId, r.fechaISO, r.hora
      ].map(norm).join(' | ');
      return hay.includes(q);
    });
  }
  renderTable();
}

function renderTable() {
  const tbody = document.querySelector('#tbl tbody');
  const info = document.getElementById('resultInfo');
  if (!tbody) return;

  const rows = state.resultsView || [];
  if (info) {
    const total = (state.resultsAll || []).length;
    const shown = rows.length;
    info.textContent = total === shown
      ? `Mostrando ${shown} entradas.`
      : `Mostrando ${shown} de ${total} entradas (filtrado).`;
  }

  tbody.innerHTML = '';

  if (!rows.length) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="6" class="muted">Sin resultados para ese criterio.</td>`;
    tbody.appendChild(tr);
    return;
  }

  const frag = document.createDocumentFragment();

  rows.forEach(r => {
    const tr = document.createElement('tr');

    const tdF = document.createElement('td');
    tdF.innerHTML = `<span class="pill mono">${escapeHtml(r.fechaISO)}</span>`;

    const tdH = document.createElement('td');
    tdH.innerHTML = `<span class="mono">${escapeHtml(r.hora || '—')}</span>`;

    const tdG = document.createElement('td');
    tdG.innerHTML = `
      <div style="font-weight:800;">${escapeHtml(r.grupoLabel)}</div>
      <div class="muted small">${escapeHtml(r.destino || '')}</div>
    `;

    const tdA = document.createElement('td');
    tdA.innerHTML = `<span class="mono">${escapeHtml(r.actividadId)}</span>`;

    const tdT = document.createElement('td');
    tdT.innerHTML = `<div>${escapeHtml(r.texto || '')}</div>`;

    const tdU = document.createElement('td');
    tdU.innerHTML = `
      <div>${escapeHtml(r.byEmail || '—')}</div>
      ${r.byUid ? `<div class="muted small mono">${escapeHtml(r.byUid)}</div>` : ''}
    `;

    tr.append(tdF, tdH, tdG, tdA, tdT, tdU);
    frag.appendChild(tr);
  });

  tbody.appendChild(frag);
}

/* =========================
   LIMPIAR
========================= */
function clearAll() {
  // inputs
  const ids = ['fDestino','fCoord','fGrupo','fActividad','fBuscarTxt'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

  // fechas quedan “hoy”
  const today = toISODate(new Date());
  const d = document.getElementById('fDesde');
  const h = document.getElementById('fHasta');
  if (d) d.value = today;
  if (h) h.value = today;

  // state
  state.actividades.clear();
  state.resultsAll = [];
  state.resultsView = [];
  setKpis({ grupos:'—', dias:'—', entradas:0 });

  const dlActs = document.getElementById('dl-actividades');
  if (dlActs) dlActs.innerHTML = '';
  const actCount = document.getElementById('actCount');
  if (actCount) actCount.textContent = 'Actividades sugeridas: 0';

  setModeHint('Modo: —');
  setStatus('Filtros limpios.');
  renderTable();
}

/* =========================
   HEADER COMMON ACTIONS
========================= */
function wireHeader() {
  document.getElementById('btn-home')?.addEventListener('click', () => {
    // tu home que dijiste fijo:
    location.href = 'https://sistemas-raitrai.github.io/Operaciones-RTv1.0';
  });

  document.getElementById('btn-refresh')?.addEventListener('click', () => location.reload());

  document.getElementById('btn-back')?.addEventListener('click', () => history.back());

  document.getElementById('btn-logout')?.addEventListener('click', async () => {
    await signOut(auth);
    location.href = 'login.html';
  });

  // reloj
  const clock = document.getElementById('clock');
  if (clock) {
    clock.textContent = fmtClockNow();
    setInterval(() => clock.textContent = fmtClockNow(), 1000);
  }
}

/* =========================
   WIRING UI
========================= */
function wireUI() {
  ensureDateRange();
  wireHeader();

  // muestra email
  const emailEl = document.getElementById('userEmail');
  if (emailEl) emailEl.textContent = (auth.currentUser?.email || '—').toLowerCase();

  // botones
  document.getElementById('btnLoadActs')?.addEventListener('click', loadSuggestedActivities);
  document.getElementById('btnCargar')?.addEventListener('click', loadBitacora);
  document.getElementById('btnLimpiar')?.addEventListener('click', clearAll);

  // filtro texto en vivo
  document.getElementById('fBuscarTxt')?.addEventListener('input', (e) => {
    state.filtros.buscarTxt = e.target.value || '';
    applyTextFilterAndRender();
  });

  // si cambian filtros principales, ajustamos hint modo
  const modeInputs = ['fDestino','fCoord','fGrupo'];
  modeInputs.forEach(id => {
    document.getElementById(id)?.addEventListener('input', () => {
      readFiltersFromUI();
      const mode = computeMode();
      if (mode === 'GRUPO') setModeHint('Modo: GRUPO (todas las actividades del grupo)');
      else if (mode === 'DESTINO') setModeHint('Modo: DESTINO (actividades y comentarios de todos los grupos)');
      else setModeHint('Modo: —');
    });
  });

  renderTable();
  setStatus('Listo.');
}

/* =========================
   ARRANQUE (AUTH)
========================= */
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    location.href = 'login.html';
    return;
  }
  state.user = user;

  await preloadGruposCatalog();
  wireUI();
});
