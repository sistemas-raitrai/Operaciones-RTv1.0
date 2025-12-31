// bitacora_actividad.js
// Bitácora:
//  - Modo GRUPO: muestra todas las actividades del grupo con todos sus comentarios.
//  - Modo DESTINO/ACTIVIDAD: muestra comentarios en todos los grupos del destino (y/o actividad).
//
// Lectura Firestore esperada:
//  grupos/{gid}/bitacora/{actividadId}/{YYYY-MM-DD}/{entryId}
//
// Campos típicos (soportados por fallback):
//  texto | text | comentario | msg
//  byEmail | email | autorEmail | by
//  ts | at | createdAt | timestamp | time

import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged }
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';

import { collection, getDocs }
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

/* =========================
   HELPERS
========================= */
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

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setStatus(msg) {
  const el = document.getElementById('status');
  if (el) el.textContent = msg;
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
    if ('seconds' in v) return v.seconds * 1000 + Math.floor((v.nanoseconds||0)/1e6);
  }
  return 0;
}

function fmtHora(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2,'0');
  const mm = String(d.getMinutes()).padStart(2,'0');
  return `${hh}:${mm}`;
}

/* =========================
   STATE
========================= */
const state = {
  user: null,
  grupos: new Map(),      // gid -> {gid, numero, nombre, destino, coordEmail}
  actividades: new Set(), // sugeridas
  results: []             // entries planas
};

/* =========================
   UI: leer filtros
========================= */
function readFilters() {
  return {
    destino: (document.getElementById('fDestino')?.value || '').trim(),
    coord: (document.getElementById('fCoord')?.value || '').trim().toLowerCase(),
    grupo: (document.getElementById('fGrupo')?.value || '').trim(),
    actividad: (document.getElementById('fActividad')?.value || '').trim()
  };
}

function computeMode(f) {
  if (f.grupo) return 'GRUPO';
  if (f.destino || f.actividad || f.coord) return 'DESTINO/ACTIVIDAD';
  return 'NONE';
}

/* =========================
   CARGAR CATÁLOGO GRUPOS
========================= */
async function preloadGruposCatalog() {
  state.grupos.clear();

  const dlGrupos = document.getElementById('dl-grupos');
  const dlCoords = document.getElementById('dl-coords');
  const dlDest   = document.getElementById('dl-destinos');

  if (dlGrupos) dlGrupos.innerHTML = '';
  if (dlCoords) dlCoords.innerHTML = '';
  if (dlDest) dlDest.innerHTML = '';

  setStatus('Cargando catálogo de grupos…');

  const snap = await getDocs(collection(db,'grupos'));
  const coordsSet = new Set();
  const destSet = new Set();

  snap.forEach(d => {
    const x = d.data() || {};
    const gid = d.id;

    const numero = coalesce(x.numeroNegocio, x.numNegocio, x.idNegocio, gid);
    const nombre = coalesce(x.nombreGrupo, x.aliasGrupo, x.nombre, x.grupo, gid);

    const destino = String(coalesce(x.destino, x.lugar, '')).trim();
    const coordEmail = String(coalesce(
      x.coordinadorEmail,
      x.coordinador?.email,
      x.coordinador,
      x.coord,
      x.responsable,
      x.owner,
      ''
    )).trim().toLowerCase();

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
   RESOLVER GRUPOS OBJETIVO
========================= */
function resolveTargetGroups(f) {
  // 1) Grupo específico directo
  if (f.grupo) {
    const g = state.grupos.get(f.grupo);
    return g ? [g] : [{ gid: f.grupo, numero: f.grupo, nombre: f.grupo, destino:'', coordEmail:'' }];
  }

  // 2) Por destino / coordinador
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
   CARGAR ACTIVIDADES SUGERIDAS
   (desde grupos objetivo)
========================= */
async function loadSuggestedActivities() {
  const f = readFilters();
  const mode = computeMode(f);

  state.actividades.clear();
  const dlActs = document.getElementById('dl-actividades');
  if (dlActs) dlActs.innerHTML = '';

  if (mode === 'NONE') {
    setStatus('Elige un GRUPO o un DESTINO / COORD para cargar actividades.');
    setText('chipActividades', 'Actividades: —');
    return;
  }

  const targets = resolveTargetGroups(f);
  if (!targets.length) {
    setStatus('No hay grupos objetivo para cargar actividades.');
    setText('chipActividades', 'Actividades: 0');
    return;
  }

  // para no morir, límite razonable
  const MAX_GROUPS = 80;
  const safeTargets = targets.slice(0, MAX_GROUPS);

  setStatus(`Leyendo actividades desde ${safeTargets.length} grupo(s)…`);

  let totalActs = 0;
  for (let i=0; i<safeTargets.length; i++) {
    const g = safeTargets[i];
    try {
      const snapActs = await getDocs(collection(db,'grupos',g.gid,'bitacora'));
      snapActs.forEach(a => state.actividades.add(a.id));
    } catch (_) {}
    totalActs = state.actividades.size;
    if ((i+1) % 6 === 0) await new Promise(r=>setTimeout(r, 20));
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

  setStatus(`Actividades cargadas: ${acts.length}`);
  setText('chipActividades', `Actividades: ${acts.length}`);
}

/* =========================
   LEER BITÁCORA COMPLETA (sin filtro de fechas)
   Estrategia:
   - Por grupo: lista actividades (bitacora) -> lista fechas (subcol) -> lista entradas
   - Por destino/actividad: igual, pero para varios grupos
========================= */
async function fetchAllBitacoraForGroup(g, actividadFiltro='') {
  const out = [];
  const gid = g.gid;

  // 1) Actividades
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

  // 2) Por actividad: fechas dinámicas
  for (const actId of activities) {
    let snapDates;
    try {
      snapDates = await getDocs(collection(db,'grupos',gid,'bitacora',actId));
    } catch {
      continue;
    }

    const dates = snapDates.docs.map(d => d.id).sort(); // ids tipo "2025-12-31"
    for (const dateISO of dates) {
      try {
        const snapEntries = await getDocs(collection(db,'grupos',gid,'bitacora',actId,dateISO));
        snapEntries.forEach(docSnap => {
          const x = docSnap.data() || {};
          const texto = String(coalesce(x.texto, x.text, x.comentario, x.msg, ''));

          const byEmail = String(coalesce(x.byEmail, x.email, x.autorEmail, x.by, '—'));
          const tsMs = parseTsToMs(coalesce(x.ts, x.at, x.createdAt, x.timestamp, x.time, 0));

          // fallback hora: doc id si parece hora
          let hora = tsMs ? fmtHora(tsMs) : '—';
          if (!tsMs && typeof docSnap.id === 'string' && docSnap.id.includes(':')) {
            hora = docSnap.id.slice(0,5); // HH:MM
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
            autor: byEmail,
            tsMs: tsMs || 0
          });
        });
      } catch (_) {}
    }
  }

  return out;
}

/* =========================
   CARGAR BITÁCORA (principal)
========================= */
async function loadBitacora() {
  const f = readFilters();
  const mode = computeMode(f);

  // chips modo
  if (mode === 'GRUPO') setText('chipModo', 'Modo: GRUPO');
  else if (mode === 'DESTINO/ACTIVIDAD') setText('chipModo', 'Modo: DESTINO/ACTIVIDAD');
  else setText('chipModo', 'Modo: —');

  if (mode === 'NONE') {
    alert('Debes elegir un GRUPO o un DESTINO/COORD (y opcional ACTIVIDAD).');
    return;
  }

  const targets = resolveTargetGroups(f);

  setText('chipGrupos', `Grupos: ${targets.length}`);
  setText('chipEntradas', `Entradas: 0`);

  if (!targets.length) {
    setStatus('No hay grupos para ese filtro.');
    state.results = [];
    renderGroupedByActivity([]);
    return;
  }

  setStatus(`Cargando bitácora… (${targets.length} grupo(s))`);

  // performance: limitar si filtras demasiado amplio
  const MAX_GROUPS = 80;
  const safeTargets = targets.slice(0, MAX_GROUPS);

  const all = [];
  for (let i=0; i<safeTargets.length; i++) {
    const g = safeTargets[i];

    setStatus(`Leyendo ${i+1}/${safeTargets.length} · ${g.numero || g.gid}`);
    const chunk = await fetchAllBitacoraForGroup(g, f.actividad);
    all.push(...chunk);

    if ((i+1) % 3 === 0) await new Promise(r=>setTimeout(r, 20));
    setText('chipEntradas', `Entradas: ${all.length}`);
  }

  // ordenar: actividad -> fecha -> hora -> grupo
  all.sort((a,b) => {
    if (a.actividadId !== b.actividadId) return a.actividadId.localeCompare(b.actividadId,'es');
    if (a.fechaISO !== b.fechaISO) return a.fechaISO.localeCompare(b.fechaISO);
    if ((a.tsMs||0) !== (b.tsMs||0)) return (a.tsMs||0) - (b.tsMs||0);
    if (a.hora !== b.hora) return String(a.hora).localeCompare(String(b.hora));
    return a.grupoLabel.localeCompare(b.grupoLabel,'es');
  });

  state.results = all;

  setStatus(`Listo. Entradas: ${all.length}`);
  setText('chipEntradas', `Entradas: ${all.length}`);

  // render: agrupado por actividad
  renderGroupedByActivity(all);
}

/* =========================
   RENDER: agrupado por actividad
========================= */
function renderGroupedByActivity(entries) {
  const root = document.getElementById('results');
  if (!root) return;

  if (!entries.length) {
    root.innerHTML = `<div class="muted">Sin resultados.</div>`;
    return;
  }

  // group by actividadId
  const map = new Map();
  for (const e of entries) {
    if (!map.has(e.actividadId)) map.set(e.actividadId, []);
    map.get(e.actividadId).push(e);
  }

  const html = [];
  for (const [actId, list] of map.entries()) {
    const n = list.length;

    html.push(`
      <div class="act-panel">
        <div class="act-head">
          <div>
            <div class="act-title">${escapeHtml(actId)}</div>
            <div class="muted" style="font-size:.85rem;margin-top:.15rem;">
              ${escapeHtml(n)} comentario(s)
            </div>
          </div>
          <div class="act-meta">
            <span class="mono">${escapeHtml(list[0]?.fechaISO || '')}</span>
            ${list[list.length-1]?.fechaISO && list[list.length-1].fechaISO !== list[0]?.fechaISO
              ? ` → <span class="mono">${escapeHtml(list[list.length-1].fechaISO)}</span>`
              : ''
            }
          </div>
        </div>

        <div class="act-body">
          ${list.map(e => `
            <div class="entry">
              <div class="mono muted">
                ${escapeHtml(e.fechaISO)}<br/>
                <b>${escapeHtml(e.hora || '—')}</b>
              </div>

              <div class="entry-text">
                ${escapeHtml(e.texto || '')}
                <div class="muted" style="margin-top:.35rem;font-size:.85rem;">
                  <span class="chip">${escapeHtml(e.grupoLabel)}</span>
                  ${e.destino ? `<span class="chip">${escapeHtml(e.destino)}</span>` : ''}
                </div>
              </div>

              <div class="right muted" style="font-size:.9rem;">
                <b>Autor:</b> ${escapeHtml(e.autor || '—')}<br/>
                ${e.coordEmail ? `<span class="muted">Coord: ${escapeHtml(e.coordEmail)}</span>` : ''}
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `);
  }

  root.innerHTML = html.join('');
}

/* =========================
   LIMPIAR
========================= */
function clearAll() {
  ['fDestino','fCoord','fGrupo','fActividad'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

  state.actividades.clear();
  state.results = [];

  const dlActs = document.getElementById('dl-actividades');
  if (dlActs) dlActs.innerHTML = '';

  setText('chipModo', 'Modo: —');
  setText('chipGrupos', 'Grupos: —');
  setText('chipActividades', 'Actividades: —');
  setText('chipEntradas', 'Entradas: 0');

  setStatus('Listo.');
  renderGroupedByActivity([]);
}

/* =========================
   UI WIRE
========================= */
function wireUI() {
  document.getElementById('btnLoadActs')?.addEventListener('click', loadSuggestedActivities);
  document.getElementById('btnCargar')?.addEventListener('click', loadBitacora);
  document.getElementById('btnLimpiar')?.addEventListener('click', clearAll);

  // set initial chips
  setText('chipModo', 'Modo: —');
  setText('chipGrupos', 'Grupos: —');
  setText('chipActividades', 'Actividades: —');
  setText('chipEntradas', 'Entradas: 0');

  renderGroupedByActivity([]);
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
