// estadisticas.js
// RT · Estadísticas (PAX esperados / declarados / reales + revisión)
// ✅ Mantiene estética (encabezado + estilos.css) y aisla UI con overrides en el HTML
// ✅ Edita PAX Reales; si difiere de Declarados => habilita Revisión
// ✅ Botón Guardar: escribe SOLO cambios en Firestore

import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs, doc, writeBatch, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

/* =========================
   CONFIG (AJUSTA SOLO SI TU RUTA ES OTRA)
========================= */
const GROUPS_COLLECTION = 'grupos';          // 👈 si tu colección es otra, cámbiala aquí
const LOGIN_PAGE = 'login.html';            // 👈 si tu sistema usa otra, cámbiala aquí

// Campos esperados (fallbacks)
// - Esperados: cantidadGrupo (si no existe, intenta paxEsperados / cantidadgrupo / paxTotal)
// - Declarados: paxViajando.total (si no existe, intenta paxDeclarados / paxViajandoTotal)
const EXPECTED_KEYS = ['cantidadGrupo', 'paxEsperados', 'cantidadgrupo', 'paxTotal', 'pax'];
const DECLARED_PATHS = [
  ['paxViajando','total'],
  ['paxViajandoTotal'],
  ['paxDeclarados'],
];

// Fecha inicio (fallbacks): fechaInicio / fechas.inicio / fechaDeViaje (si es rango no sirve perfecto)
const START_DATE_PATHS = [
  ['fechaInicio'],
  ['fechas','inicio'],
  ['fechaDeViaje'], // si viene como texto, se intenta parse
];

/* =========================
   HELPERS
========================= */
const $ = (id)=> document.getElementById(id);

const norm = (s='') =>
  s.toString()
   .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
   .toLowerCase()
   .trim();

function getByPath(obj, pathArr){
  try{
    if (!pathArr || !pathArr.length) return undefined;
    let cur = obj;
    for (const p of pathArr){
      if (cur == null) return undefined;
      cur = cur[p];
    }
    return cur;
  } catch { return undefined; }
}

function pickNumber(obj, keys){
  for (const k of keys){
    const v = obj?.[k];
    const n = toNum(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function pickDeclared(obj){
  for (const p of DECLARED_PATHS){
    const v = Array.isArray(p) ? getByPath(obj, p) : obj?.[p];
    const n = toNum(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function toNum(v){
  if (v == null || v === '') return NaN;
  if (typeof v === 'number') return v;
  const s = v.toString().replace(/[^\d\-.,]/g,'').replace(/\./g,'').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

function parseDateAny(v){
  if (!v) return null;
  if (v instanceof Date && !isNaN(v.getTime())) return v;

  // Firestore Timestamp-like { seconds, nanoseconds }
  if (typeof v === 'object' && typeof v.seconds === 'number'){
    return new Date(v.seconds * 1000);
  }

  const s = v.toString().trim();
  // ISO
  const iso = new Date(s);
  if (!isNaN(iso.getTime())) return iso;

  // dd-mm-aaaa or dd/mm/aaaa
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m){
    const dd = Number(m[1]), mm = Number(m[2]) - 1, yy = Number(m[3]);
    const d = new Date(yy, mm, dd);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function fmtDate(d){
  if (!d) return '';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  return `${yyyy}-${mm}-${dd}`;
}

function safeText(v){
  if (v == null) return '';
  return String(v);
}

/* =========================
   STATE
========================= */
const auth = getAuth(app);

const state = {
  user: null,
  rowsAll: [],     // rows normalizadas
  rowsView: [],    // filtradas
  dirty: new Map(),// gid -> { paxReales, revisionPax }
};

/* =========================
   UI REFS
========================= */
const ui = {
  q: $('q'),
  fDestino: $('fDestino'),
  fPrograma: $('fPrograma'),
  fCoord: $('fCoord'),
  fAno: $('fAno'),
  fDesde: $('fDesde'),
  fHasta: $('fHasta'),
  fSoloDiferencias: $('fSoloDiferencias'),
  fSoloSinReales: $('fSoloSinReales'),

  btnAplicar: $('btnAplicar'),
  btnLimpiar: $('btnLimpiar'),
  btnGuardar: $('btnGuardar'),

  status: $('status'),
  tbody: $('tbody'),

  kGrupos: $('kGrupos'),
  kGruposHint: $('kGruposHint'),
  kEsperados: $('kEsperados'),
  kDeclarados: $('kDeclarados'),
  kDelta: $('kDelta'),
  kDeltaBox: $('kDeltaBox'),
};

/* =========================
   AUTH GATE
========================= */
onAuthStateChanged(auth, (user)=>{
  if (!user){
    // si tu sistema no redirige, comenta esto
    window.location.href = LOGIN_PAGE;
    return;
  }
  state.user = user;
  boot().catch(err=>{
    console.error(err);
    setStatus('Error al iniciar. Revisa consola.', true);
  });
});

/* =========================
   BOOT
========================= */
async function boot(){
  wireEvents();
  setStatus('Cargando grupos...');
  await loadGroups();
  buildFilterOptions();
  applyFilters(); // render inicial
  setStatus('Listo.');
}

/* =========================
   EVENTS
========================= */
function wireEvents(){
  ui.btnAplicar.addEventListener('click', ()=> applyFilters());
  ui.btnLimpiar.addEventListener('click', ()=> resetFilters());
  ui.btnGuardar.addEventListener('click', ()=> guardarCambios());

  // aplicar con Enter en el buscador
  ui.q.addEventListener('keydown', (e)=>{
    if (e.key === 'Enter'){ e.preventDefault(); applyFilters(); }
  });
}

/* =========================
   LOAD GROUPS
========================= */
async function loadGroups(){
  state.rowsAll = [];
  state.dirty.clear();
  ui.btnGuardar.disabled = true;

  const snap = await getDocs(collection(db, GROUPS_COLLECTION));
  snap.forEach((ds)=>{
    const g = ds.data() || {};
    const gid = ds.id;

    const nombre = g.nombreGrupo || g.nombre || g.grupoNombre || g.colegio || '';
    const destino = g.destino || g.Destino || '';
    const programa = g.programa || g.Programa || '';
    const coord = g.coordinadorEmail || g.coordEmail || g.coordinador || g.coord || '';

    // esperados / declarados
    const esperados = pickNumber(g, EXPECTED_KEYS);
    const declarados = pickDeclared(g);

    // pax reales + revisión
    const paxReales = Number.isFinite(toNum(g.paxReales)) ? toNum(g.paxReales) : null;
    const revisionPax = safeText(g.revisionPax || '');

    // fecha inicio
    let fechaInicio = null;
    for (const p of START_DATE_PATHS){
      const v = getByPath(g, p);
      const d = parseDateAny(v);
      if (d){ fechaInicio = d; break; }
    }
    const ano = fechaInicio ? String(fechaInicio.getFullYear()) : '';

    // texto para búsqueda
    const searchBlob = norm([
      gid, nombre, destino, programa, coord
    ].join(' '));

    state.rowsAll.push({
      gid,
      nombre,
      destino,
      programa,
      coord,
      esperados,
      declarados,
      paxReales,      // null si no existe
      revisionPax,
      fechaInicio,
      ano,
      searchBlob,
    });
  });

  // orden estable: por fecha inicio, luego gid
  state.rowsAll.sort((a,b)=>{
    const ta = a.fechaInicio ? a.fechaInicio.getTime() : 0;
    const tb = b.fechaInicio ? b.fechaInicio.getTime() : 0;
    if (ta !== tb) return ta - tb;
    return a.gid.localeCompare(b.gid);
  });
}

/* =========================
   FILTER OPTIONS
========================= */
function buildFilterOptions(){
  fillSelect(ui.fDestino, ['(TODOS)', ...uniq(state.rowsAll.map(r=>r.destino).filter(Boolean))]);
  fillSelect(ui.fPrograma, ['(TODOS)', ...uniq(state.rowsAll.map(r=>r.programa).filter(Boolean))]);
  fillSelect(ui.fCoord, ['(TODOS)', ...uniq(state.rowsAll.map(r=>r.coord).filter(Boolean))]);
  fillSelect(ui.fAno, ['(TODOS)', ...uniq(state.rowsAll.map(r=>r.ano).filter(Boolean)).sort()]);
}

function fillSelect(sel, values){
  sel.innerHTML = '';
  for (const v of values){
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    sel.appendChild(opt);
  }
  sel.value = values[0] ?? '(TODOS)';
}

function uniq(arr){
  return Array.from(new Set(arr)).sort((a,b)=> a.localeCompare(b));
}

/* =========================
   APPLY FILTERS
========================= */
function applyFilters(){
  const q = norm(ui.q.value || '');
  const destino = ui.fDestino.value || '(TODOS)';
  const programa = ui.fPrograma.value || '(TODOS)';
  const coord = ui.fCoord.value || '(TODOS)';
  const ano = ui.fAno.value || '(TODOS)';
  const soloDif = (ui.fSoloDiferencias.value === 'SI');
  const soloSinReales = (ui.fSoloSinReales.value === 'SI');

  const desde = ui.fDesde.value ? new Date(ui.fDesde.value + 'T00:00:00') : null;
  const hasta = ui.fHasta.value ? new Date(ui.fHasta.value + 'T23:59:59') : null;

  const rows = state.rowsAll.filter(r=>{
    if (destino !== '(TODOS)' && r.destino !== destino) return false;
    if (programa !== '(TODOS)' && r.programa !== programa) return false;
    if (coord !== '(TODOS)' && r.coord !== coord) return false;
    if (ano !== '(TODOS)' && r.ano !== ano) return false;

    if (desde && r.fechaInicio && r.fechaInicio < desde) return false;
    if (hasta && r.fechaInicio && r.fechaInicio > hasta) return false;
    // si no hay fechaInicio y el usuario filtró por fecha => afuera
    if ((desde || hasta) && !r.fechaInicio) return false;

    if (q && !r.searchBlob.includes(q)) return false;

    const declared = r.declarados || 0;
    const reales = (r.paxReales == null ? null : r.paxReales);

    if (soloSinReales && reales != null) return false;

    if (soloDif){
      if (reales == null) return false;
      if (reales === declared) return false;
    }

    return true;
  });

  state.rowsView = rows;
  render();
  recalcKpis();
}

/* =========================
   RENDER
========================= */
function render(){
  const rows = state.rowsView;

  if (!rows.length){
    ui.tbody.innerHTML = `<tr><td colspan="11" class="es-empty">Sin resultados.</td></tr>`;
    return;
  }

  ui.tbody.innerHTML = '';

  for (const r of rows){
    const tr = document.createElement('tr');
    tr.dataset.gid = r.gid;

    const declared = r.declarados || 0;
    const expected = r.esperados || 0;

    // valor a mostrar en input: si el usuario lo cambió (dirty), mostrar dirty; si no, el de firestore
    const dirty = state.dirty.get(r.gid);
    const valReales = (dirty && dirty.paxReales !== undefined) ? dirty.paxReales : r.paxReales;

    const realesNum = (valReales == null || valReales === '' ? null : Number(valReales));
    const diff = (realesNum != null && Number.isFinite(realesNum) && realesNum !== declared);

    const revisionVal = (dirty && dirty.revisionPax !== undefined) ? dirty.revisionPax : (r.revisionPax || '');
    const needsRevision = diff;

    const estadoHTML = needsRevision
      ? `<span class="es-badge warn">DIFERENCIA</span>`
      : `<span class="es-badge">OK</span>`;

    tr.innerHTML = `
      <td class="es-nowrap es-mono">${escapeHtml(r.gid)}</td>
      <td>${escapeHtml(r.nombre || '(sin nombre)')}</td>
      <td class="es-nowrap">${escapeHtml(r.coord || '')}</td>
      <td class="es-nowrap">${escapeHtml(r.destino || '')}</td>
      <td class="es-nowrap">${escapeHtml(r.programa || '')}</td>
      <td class="es-nowrap es-dim">${escapeHtml(r.fechaInicio ? fmtDate(r.fechaInicio) : '')}</td>
      <td class="es-nowrap es-right es-mono">${expected}</td>
      <td class="es-nowrap es-right es-mono">${declared}</td>

      <td class="es-nowrap">
        <input class="cell-input num" type="number" min="0" step="1"
               data-role="paxReales" value="${valReales == null ? '' : String(valReales)}"
               placeholder="(vacío)" />
      </td>

      <td>
        <input class="cell-input" type="text"
               data-role="revision"
               value="${escapeAttr(revisionVal)}"
               placeholder="${needsRevision ? 'Motivo / comentario' : '—'}"
               ${needsRevision ? '' : 'disabled'} />
      </td>

      <td class="es-nowrap">${estadoHTML}</td>
    `;

    // listeners por fila (inputs)
    const inpReales = tr.querySelector('input[data-role="paxReales"]');
    const inpRevision = tr.querySelector('input[data-role="revision"]');

    inpReales.addEventListener('input', ()=>{
      onEditRow(r.gid, tr);
    });
    inpRevision.addEventListener('input', ()=>{
      onEditRow(r.gid, tr, { onlyRevision:true });
    });

    ui.tbody.appendChild(tr);

    // si ya estaba dirty, marca
    if (state.dirty.has(r.gid)) tr.classList.add('es-row-dirty');
  }
}

function onEditRow(gid, tr, opts = {}){
  const row = state.rowsAll.find(x=>x.gid === gid);
  if (!row) return;

  const declared = row.declarados || 0;

  const inpReales = tr.querySelector('input[data-role="paxReales"]');
  const inpRevision = tr.querySelector('input[data-role="revision"]');

  const rawReales = inpReales.value;
  const nReales = rawReales === '' ? null : Number(rawReales);
  const diff = (nReales != null && Number.isFinite(nReales) && nReales !== declared);

  // habilitar/deshabilitar revisión según diff
  if (diff){
    inpRevision.disabled = false;
    if (!inpRevision.placeholder || inpRevision.placeholder === '—'){
      inpRevision.placeholder = 'Motivo / comentario';
    }
  } else {
    inpRevision.disabled = true;
    inpRevision.value = '';         // 👈 recomendación: si no hay diferencia, no guardamos revisión
    inpRevision.placeholder = '—';
  }

  // estado badge
  const estadoCell = tr.lastElementChild;
  estadoCell.innerHTML = diff
    ? `<span class="es-badge warn">DIFERENCIA</span>`
    : `<span class="es-badge">OK</span>`;

  // marcar dirty
  const prev = state.dirty.get(gid) || {};
  const next = {
    ...prev,
    paxReales: nReales, // null si vacío
    revisionPax: diff ? (inpRevision.value || '') : '',
  };

  // Si no cambió nada vs lo que ya hay en Firestore, des-marcar dirty
  const sameReales = (row.paxReales == null ? null : Number(row.paxReales)) === (next.paxReales == null ? null : Number(next.paxReales));
  const sameRev = (safeText(row.revisionPax || '') === safeText(next.revisionPax || ''));

  if (sameReales && sameRev){
    state.dirty.delete(gid);
    tr.classList.remove('es-row-dirty');
  } else {
    state.dirty.set(gid, next);
    tr.classList.add('es-row-dirty');
  }

  ui.btnGuardar.disabled = (state.dirty.size === 0);
  recalcKpis(); // opcional: KPI se mantiene consistente si quieres (no obligatorio)
}

/* =========================
   KPI
========================= */
function recalcKpis(){
  const rows = state.rowsView;

  let grupos = rows.length;
  let esperados = 0;
  let declarados = 0;

  for (const r of rows){
    esperados += (r.esperados || 0);
    declarados += (r.declarados || 0);
  }

  const delta = declarados - esperados;

  ui.kGrupos.textContent = String(grupos);
  ui.kGruposHint.textContent = `${state.dirty.size} con cambios pendientes`;
  ui.kEsperados.textContent = String(esperados);
  ui.kDeclarados.textContent = String(declarados);
  ui.kDelta.textContent = String(delta);

  ui.kDeltaBox.classList.remove('delta-neg','delta-pos');
  if (delta < 0) ui.kDeltaBox.classList.add('delta-neg');
  else if (delta > 0) ui.kDeltaBox.classList.add('delta-pos');
}

/* =========================
   RESET FILTERS
========================= */
function resetFilters(){
  ui.q.value = '';
  ui.fDestino.value = '(TODOS)';
  ui.fPrograma.value = '(TODOS)';
  ui.fCoord.value = '(TODOS)';
  ui.fAno.value = '(TODOS)';
  ui.fDesde.value = '';
  ui.fHasta.value = '';
  ui.fSoloDiferencias.value = 'NO';
  ui.fSoloSinReales.value = 'NO';

  applyFilters();
}

/* =========================
   SAVE
========================= */
async function guardarCambios(){
  if (!state.user) return;
  if (state.dirty.size === 0) return;

  // validación: si hay diferencia, Revisión no puede quedar vacía (recomendación)
  // Si quieres permitir vacío, comenta este bloque.
  const problems = [];
  for (const [gid, ch] of state.dirty.entries()){
    const row = state.rowsAll.find(x=>x.gid === gid);
    if (!row) continue;

    const declared = row.declarados || 0;
    const reales = ch.paxReales;

    const diff = (reales != null && Number.isFinite(reales) && reales !== declared);
    if (diff && !safeText(ch.revisionPax).trim()){
      problems.push(gid);
    }
  }
  if (problems.length){
    setStatus(`Falta "Revisión" en ${problems.length} grupo(s) con diferencia (ej: ${problems.slice(0,3).join(', ')})`, true);
    return;
  }

  try{
    setStatus(`Guardando ${state.dirty.size} cambio(s)...`);

    const batch = writeBatch(db);
    const now = serverTimestamp();

    for (const [gid, ch] of state.dirty.entries()){
      const ref = doc(db, GROUPS_COLLECTION, gid);

      batch.update(ref, {
        paxReales: ch.paxReales,               // null si vacío (Firestore acepta null)
        revisionPax: safeText(ch.revisionPax || ''),
        revisionPaxUpdatedAt: now,
        revisionPaxUpdatedBy: state.user.email || '',
      });
    }

    await batch.commit();

    // aplicar cambios al state base
    for (const [gid, ch] of state.dirty.entries()){
      const row = state.rowsAll.find(x=>x.gid === gid);
      if (row){
        row.paxReales = ch.paxReales;
        row.revisionPax = safeText(ch.revisionPax || '');
      }
    }

    state.dirty.clear();
    ui.btnGuardar.disabled = true;

    // re-render para limpiar marcas y re-desactivar revisión si corresponde
    render();
    recalcKpis();

    setStatus('✅ Cambios guardados.');
  } catch(err){
    console.error(err);
    setStatus('Error al guardar (ver consola).', true);
  }
}

/* =========================
   UI status
========================= */
function setStatus(msg, isErr=false){
  ui.status.textContent = msg;
  ui.status.style.color = isErr ? '#b91c1c' : '#374151';
}

/* =========================
   ESCAPE HTML
========================= */
function escapeHtml(s=''){
  return String(s)
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'","&#039;");
}
function escapeAttr(s=''){ return escapeHtml(s); }
