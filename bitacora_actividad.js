// bitacora_actividad.js
// Bitácora por actividad en todos los grupos (por destino) o completa por grupo.
//
// Estructura Firestore esperada:
//   grupos/{gid}/bitacora/{actividadId}/{YYYY-MM-DD}/{docId}
// Campos típicos: texto, byEmail, byUid, ts (Timestamp/Date/number)

import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged }
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';

import {
  collection, getDocs
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

  // cache catálogo grupos
  grupos: new Map(), // gid -> {gid, numero, nombre, destino, coordEmail}

  // actividades sugeridas (Set)
  actividades: new Set(),

  // resultados
  resultsAll: [],
  resultsView: []
};

/* =========================
   UI
========================= */
function readFilters() {
  return {
    destino: (document.getElementById('fDestino')?.value || '').trim(),
    coord: (document.getElementById('fCoord')?.value || '').trim().toLowerCase(),
    grupo: (document.getElementById('fGrupo')?.value || '').trim(),
    actividad: (document.getElementById('fActividad')?.value || '').trim(),
    desde: (document.getElementById('fDesde')?.value || '').trim(),
    hasta: (document.getElementById('fHasta')?.value || '').trim(),
    buscarTxt: (document.getElementById('fBuscarTxt')?.value || '').trim()
  };
}

function ensureDateRange() {
  const today = toISODate(new Date());
  const d = document.getElementById('fDesde');
  const h = document.getElementById('fHasta');
  if (d && !d.value) d.value = today;
  if (h && !h.value) h.value = today;
}

function computeMode(f) {
  if (f.grupo) return 'GRUPO';
  if (f.destino) return 'DESTINO';
  return 'NONE';
}

/* =========================
   CATÁLOGO GRUPOS
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

  if (dlCoords) {
    [...coordsSet].sort().forEach(email => {
      const opt = document.createElement('option');
      opt.value = email;
      opt.label = email;
      dlCoords.appendChild(opt);
    });
  }

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
   GRUPOS OBJETIVO
========================= */
function resolveTargetGroups(f) {
  if (f.grupo) {
    const g = state.grupos.get(f.grupo);
    return g ? [g] : [{ gid: f.grupo, numero: f.grupo, nombre: f.grupo, destino:'', coordEmail:'' }];
  }

  const destN = norm(f.destino);
  const out = [];
  for (const g of state.grupos.values()) {
    if (destN && norm(g.destino) !== destN) continue;
    if (f.coord && (g.coordEmail || '') !== f.coord) continue;
    out.push(g);
  }
  return out;
}

/* =========================
   ACTIVIDADES SUGERIDAS
========================= */
async function loadSuggestedActivities() {
  const f = readFilters();
  const mode = computeMode(f);

  state.actividades.clear();
  const dlActs = document.getElementById('dl-actividades');
  if (dlActs) dlActs.innerHTML = '';
  const actCount = document.getElementById('actCount');
  if (actCount) actCount.textContent = 'Actividades sugeridas: 0';

  if (mode === 'NONE') {
    setStatus('Elige un DESTINO o un GRUPO para cargar actividades.');
    return;
  }

  const targets = resolveTargetGroups(f);
  if (!targets.length) {
    setStatus('Sin grupos objetivo para cargar actividades.');
    return;
  }

  setStatus(`Cargando actividades desde bitacora/* en ${targets.length} grupo(s)…`);

  // Seguridad: si hay demasiados grupos, no explotar
  const MAX_GROUPS = 80;
  const safeTargets = targets.slice(0, MAX_GROUPS);

  let i = 0;
  for (const g of safeTargets) {
    try {
      const snapActs = await getDocs(collection(db,'grupos',g.gid,'bitacora'));
      snapActs.forEach(a => state.actividades.add(a.id));
    } catch (e) {
      // sin bitácora, ok
    }
    i++;
    if (i % 6 === 0) await sleep(30);
  }

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
  setStatus(`Actividades cargadas: ${acts.length}`);
}

/* =========================
   RANGO DE FECHAS
========================= */
function listDatesInRange(desdeISO, hastaISO) {
  const out = [];
  const d1 = new Date(`${desdeISO}T00:00:00`);
  const d2 = new Date(`${hastaISO}T00:00:00`);
  if (isNaN(d1) || isNaN(d2)) return out;

  const cur = new Date(d1);
  const end = new Date(d2);

  // soporta invertido
  const step = cur <= end ? 1 : -1;

  while (true) {
    out.push(toISODate(cur));
    if (toISODate(cur) === toISODate(end)) break;
    cur.setDate(cur.getDate() + step);
    if (out.length > 370) break;
  }

  return out.sort();
}

/* =========================
   LECTURA BITÁCORA
========================= */
async function fetchBitacoraForGroup(g, datesISO, actividadFiltro='') {
  const out = [];
  const gid = g.gid;

  let activities = [];
  if (actividadFiltro) {
    activities = [actividadFiltro];
  } else {
    try {
      const snapActs = await getDocs(collection(db,'grupos',gid,'bitacora'));
      activities = snapActs.docs.map(d => d.id);
    } catch {
      return out;
    }
  }

  for (const actId of activities) {
    for (const dateISO of datesISO) {
      try {
        const snapDay = await getDocs(collection(db,'grupos',gid,'bitacora',actId,dateISO));

        snapDay.forEach(docSnap => {
          const x = docSnap.data() || {};

          const texto = coalesce(x.texto, x.text, x.comentario, x.msg, '');
          const byEmail = coalesce(x.byEmail, x.email, x.autorEmail, x.by, '');
          const tsMs = parseTsToMs(coalesce(x.ts, x.at, x.createdAt, x.timestamp, x.time, 0));

          let hora = tsMs ? msToHora(tsMs) : '—';
          // fallback: docId "19:24:01.338"
          if (!tsMs && typeof docSnap.id === 'string' && docSnap.id.includes(':')) {
            hora = docSnap.id;
          }

          out.push({
            fechaISO: dateISO,
            hora,
            grupoLabel: `${g.numero || gid} — ${g.nombre || gid}`,
            actividadId: actId,
            texto,
            autor: String(byEmail || '—'),
            tsMs: tsMs || 0
          });
        });
      } catch {
        // subcolección no existe → vacío
      }
    }
  }

  return out;
}

async function loadBitacora() {
  const f = readFilters();
  ensureDateRange();

  const mode = computeMode(f);
  if (mode === 'NONE') {
    alert('Debes elegir al menos un GRUPO específico o un DESTINO.');
    return;
  }

  if (mode === 'GRUPO') setModeHint('Modo: GRUPO (todas las actividades del grupo)');
  if (mode === 'DESTINO') setModeHint('Modo: DESTINO (todas las actividades en todos los grupos)');

  if (!f.desde || !f.hasta) {
    alert('Selecciona un rango de fechas (Desde / Hasta).');
    return;
  }

  const datesISO = listDatesInRange(f.desde, f.hasta);
  if (!datesISO.length) {
    alert('Rango de fechas inválido.');
    return;
  }

  const targets = resolveTargetGroups(f);
  if (!targets.length) {
    setStatus('No hay grupos que coincidan con ese destino/coordinador.');
    state.resultsAll = [];
    applyTextFilterAndRender(f.buscarTxt);
    setKpis({ grupos: 0, dias: datesISO.length, entradas: 0 });
    return;
  }

  setStatus(`Consultando… grupos: ${targets.length} · días: ${datesISO.length}`);
  setKpis({ grupos: targets.length, dias: datesISO.length, entradas: 0 });

  const all = [];
  let done = 0;

  for (const g of targets) {
    const chunk = await fetchBitacoraForGroup(g, datesISO, f.actividad);
    all.push(...chunk);

    done++;
    setStatus(`Consultando… ${done}/${targets.length} grupos. Entradas: ${all.length}`);
    setKpis({ grupos: targets.length, dias: datesISO.length, entradas: all.length });

    if (done % 3 === 0) await sleep(30);
  }

  all.sort((a,b) => {
    if (a.fechaISO !== b.fechaISO) return a.fechaISO.localeCompare(b.fechaISO);
    const ta = a.tsMs || 0;
    const tb = b.tsMs || 0;
    if (ta !== tb) return ta - tb;
    if (a.grupoLabel !== b.grupoLabel) return a.grupoLabel.localeCompare(b.grupoLabel,'es');
    return a.actividadId.localeCompare(b.actividadId,'es');
  });

  state.resultsAll = all;
  applyTextFilterAndRender(f.buscarTxt);

  setStatus(`Listo. Entradas: ${all.length}`);
}

/* =========================
   FILTRO TEXTO + RENDER
========================= */
function applyTextFilterAndRender(qRaw='') {
  const q = norm(qRaw || '');
  state.resultsView = !q
    ? state.resultsAll.slice()
    : state.resultsAll.filter(r => {
        const hay = norm(
          `${r.fechaISO} ${r.hora} ${r.grupoLabel} ${r.actividadId} ${r.texto} ${r.autor}`
        );
        return hay.includes(q);
      });

  renderTable();
}

function renderTable() {
  const tbody = document.querySelector('#tbl tbody');
  const info = document.getElementById('resultInfo');
  if (!tbody) return;

  const total = state.resultsAll.length;
  const shown = state.resultsView.length;

  if (info) {
    info.textContent = total === shown
      ? `Mostrando ${shown} entradas.`
      : `Mostrando ${shown} de ${total} entradas (filtrado).`;
  }

  tbody.innerHTML = '';

  if (!shown) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted">Sin resultados para ese criterio.</td></tr>`;
    return;
  }

  const frag = document.createDocumentFragment();

  state.resultsView.forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="mono">${escapeHtml(r.fechaISO)}</td>
      <td class="mono">${escapeHtml(r.hora || '—')}</td>
      <td>${escapeHtml(r.grupoLabel)}</td>
      <td class="mono">${escapeHtml(r.actividadId)}</td>
      <td>${escapeHtml(r.texto || '')}</td>
      <td>${escapeHtml(r.autor || '—')}</td>
    `;
    frag.appendChild(tr);
  });

  tbody.appendChild(frag);
}

/* =========================
   LIMPIAR
========================= */
function clearAll() {
  const ids = ['fDestino','fCoord','fGrupo','fActividad','fBuscarTxt'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

  const today = toISODate(new Date());
  const d = document.getElementById('fDesde');
  const h = document.getElementById('fHasta');
  if (d) d.value = today;
  if (h) h.value = today;

  state.actividades.clear();
  state.resultsAll = [];
  state.resultsView = [];

  const dlActs = document.getElementById('dl-actividades');
  if (dlActs) dlActs.innerHTML = '';

  const actCount = document.getElementById('actCount');
  if (actCount) actCount.textContent = 'Actividades sugeridas: 0';

  setKpis({ grupos:'—', dias:'—', entradas:0 });
  setModeHint('Modo: —');
  setStatus('Listo.');
  renderTable();
}

/* =========================
   WIRE UI
========================= */
function wireUI() {
  ensureDateRange();

  document.getElementById('btnLoadActs')?.addEventListener('click', loadSuggestedActivities);
  document.getElementById('btnCargar')?.addEventListener('click', loadBitacora);
  document.getElementById('btnLimpiar')?.addEventListener('click', clearAll);

  document.getElementById('fBuscarTxt')?.addEventListener('input', (e) => {
    applyTextFilterAndRender(e.target.value || '');
  });

  // modo hint dinámico
  ['fDestino','fGrupo'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', () => {
      const f = readFilters();
      const mode = computeMode(f);
      if (mode === 'GRUPO') setModeHint('Modo: GRUPO (todas las actividades del grupo)');
      else if (mode === 'DESTINO') setModeHint('Modo: DESTINO (todas las actividades en todos los grupos)');
      else setModeHint('Modo: —');
    });
  });

  renderTable();
  setStatus('Listo.');
}

/* =========================
   START (AUTH)
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
