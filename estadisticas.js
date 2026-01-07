// estadisticas.js
// RT · Estadísticas (PAX esperados / declarados / liberados / reales + revisión)
// ✅ Edita PAX Reales y PAX Liberados
// ✅ PAX Liberados default = floor(esperados/10) pero editable
// ✅ Si esperados == declarados y NO hay paxReales en FS => PAX Reales se precarga (solo visual) y cuenta como revisado OK
// ✅ Estados: OK / PENDIENTE / CORREGIDO (verde)
// ✅ Tooltip flotante en Revisión (title)
// ✅ Coordinador en MAYÚSCULAS (visual)
// ✅ Guardar: escribe SOLO cambios en Firestore

import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs, doc, writeBatch, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

/* =========================
   CONFIG
========================= */
const GROUPS_COLLECTION = 'grupos';
const LOGIN_PAGE = 'login.html';

// Esperados / Declarados
const EXPECTED_KEYS = ['cantidadGrupo', 'paxEsperados', 'cantidadgrupo', 'paxTotal', 'pax'];
const DECLARED_PATHS = [
  ['paxViajando','total'],
  ['paxViajandoTotal'],
  ['paxDeclarados'],
];

// Fecha inicio (fallbacks)
const START_DATE_PATHS = [
  ['fechaInicio'],
  ['fechas','inicio'],
  ['fechaDeViaje'],
];

// Campo Firestore para liberados
const LIBERADOS_KEY = 'paxLiberados';

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

function toNum(v){
  if (v == null || v === '') return NaN;
  if (typeof v === 'number') return v;
  const s = v.toString().replace(/[^\d\-.,]/g,'').replace(/\./g,'').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
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

function parseDateAny(v){
  if (!v) return null;
  if (v instanceof Date && !isNaN(v.getTime())) return v;

  if (typeof v === 'object' && typeof v.seconds === 'number'){
    return new Date(v.seconds * 1000);
  }

  const s = v.toString().trim();

  const iso = new Date(s);
  if (!isNaN(iso.getTime())) return iso;

  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m){
    const dd = Number(m[1]), mm = Number(m[2]) - 1, yy = Number(m[3]);
    const d = new Date(yy, mm, dd);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function safeText(v){
  if (v == null) return '';
  return String(v);
}

function defaultLiberados(esperados){
  const n = Number(esperados) || 0;
  return Math.floor(n / 10);
}

/* =========================
   STATE
========================= */
const auth = getAuth(app);

const state = {
  user: null,
  rowsAll: [],
  rowsView: [],
  // dirty: gid -> { paxReales, paxLiberados, revisionPax }
  dirty: new Map(),
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
  btnExportar: $('btnExportar'),

  status: $('status'),
  tbody: $('tbody'),

  kGrupos: $('kGrupos'),
  kGruposHint: $('kGruposHint'),

  kEsperados: $('kEsperados'),
  kDeclarados: $('kDeclarados'),

  kReales: $('kReales'),
  kRealesHint: $('kRealesHint'),

  kDelta: $('kDelta'),
  kDeltaBox: $('kDeltaBox'),

  kDeltaReales: $('kDeltaReales'),
  kDeltaRealesBox: $('kDeltaRealesBox'),

  kLiberados: $('kLiberados'),
  kLiberadosBox: $('kLiberadosBox'),
  kNeto: $('kNeto'),
  kNetoBox: $('kNetoBox'),
};

/* =========================
   AUTO-REALES (solo UI)
   - Si esperados == declarados, y no hay paxReales en FS, y no hay dirty => mostrar declarados
========================= */
function effectiveReales(row){
  const d = state.dirty.get(row.gid);
  if (d && d.paxReales !== undefined) return d.paxReales;

  if (row.paxReales != null && row.paxReales !== '') return row.paxReales;

  const exp = Number(row.esperados || 0);
  const dec = Number(row.declarados || 0);
  if (exp > 0 && dec > 0 && exp === dec) return dec;

  return null;
}

function effectiveLiberados(row){
  const d = state.dirty.get(row.gid);
  if (d && d.paxLiberados !== undefined) return d.paxLiberados;

  // si viene null por alguna razón, volvemos a base
  if (row.paxLiberados == null || row.paxLiberados === '') return Number(row.paxLiberadosDefault || 0);

  return row.paxLiberados;
}

/* =========================
   REGLAS DE ESTADO
========================= */
function computeStatus(row, revisionText){
  const expected = Number(row.esperados || 0);
  const declared = Number(row.declarados || 0);

  const reales = effectiveReales(row);
  const liberados = effectiveLiberados(row);

  const realesNum = (reales == null || reales === '') ? null : Number(reales);
  const liberadosNum = (liberados == null || liberados === '') ? null : Number(liberados);

  const hasReales = (realesNum != null && Number.isFinite(realesNum));
  const hasReason = safeText(revisionText).trim().length > 0;

  // 1) mismatch base: esperados != declarados => requiere revisión
  const mismatch = (expected !== declared);

  // 2) liberados: si usuario se aparta del default => requiere revisión
  //    (si es null no cuenta como cambio, pero en UI igual debe verse base)
  const liberadosChangedFromDefault =
    (liberadosNum != null && Number.isFinite(liberadosNum) && liberadosNum !== Number(row.paxLiberadosDefault || 0));

  // 3) reales: si usuario puso un real distinto a declarado => requiere revisión
  //    OJO: si mismatch existe, aunque reales sea igual, igual quieres revisión (porque el problema está antes)
  const realesDiffFromDeclared =
    (realesNum != null && Number.isFinite(realesNum) && realesNum !== declared);

  const needsRevision = mismatch || liberadosChangedFromDefault || realesDiffFromDeclared;

  // 4) estado final
  if (!needsRevision) return { status:'OK', needsRevision:false };

  // Para que sea CORREGIDO: debe haber MOTIVO.
  // y además debe existir "algo" confirmado (reales presentes). Si no hay reales, no hay confirmación.
  // Nota: si mismatch existe, y reales auto-cargado no aplica (porque auto solo cuando exp==dec).
  if (hasReason && hasReales) return { status:'CORREGIDO', needsRevision:true };

  return { status:'PENDIENTE', needsRevision:true };
}

/* =========================
   AUTH GATE
========================= */
onAuthStateChanged(auth, (user)=>{
  if (!user){
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
  applyFilters();
  setStatus('Listo.');
}

/* =========================
   EVENTS
========================= */
function wireEvents(){
  ui.btnAplicar?.addEventListener('click', ()=> applyFilters());
  ui.btnLimpiar?.addEventListener('click', ()=> resetFilters());
  ui.btnGuardar?.addEventListener('click', ()=> guardarCambios());
  ui.btnExportar?.addEventListener('click', ()=> exportarXLS());

  ui.q?.addEventListener('keydown', (e)=>{
    if (e.key === 'Enter'){ e.preventDefault(); applyFilters(); }
  });
}

/* =========================
   LOAD GROUPS
========================= */
async function loadGroups(){
  state.rowsAll = [];
  state.dirty.clear();
  if (ui.btnGuardar) ui.btnGuardar.disabled = true;

  const snap = await getDocs(collection(db, GROUPS_COLLECTION));
  snap.forEach((ds)=>{
    const g = ds.data() || {};
    const gid = ds.id;

    const nombre = g.nombreGrupo || g.nombre || g.grupoNombre || g.colegio || '';
    const destino = g.destino || g.Destino || '';
    const programa = g.programa || g.Programa || '';
    const coord = g.coordinadorEmail || g.coordEmail || g.coordinador || g.coord || '';

    const esperados = pickNumber(g, EXPECTED_KEYS);
    const declarados = pickDeclared(g);

    // reales (FS)
    const paxRealesFS = Number.isFinite(toNum(g.paxReales)) ? toNum(g.paxReales) : null;

    // liberados: FS o default
    const liberadosFSNum = Number.isFinite(toNum(g[LIBERADOS_KEY])) ? toNum(g[LIBERADOS_KEY]) : null;
    const liberadosDefault = defaultLiberados(esperados);
    const paxLiberados = (liberadosFSNum == null ? liberadosDefault : liberadosFSNum);

    const revisionPax = safeText(g.revisionPax || '');

    // fecha inicio
    let fechaInicio = null;
    for (const p of START_DATE_PATHS){
      const v = getByPath(g, p);
      const d = parseDateAny(v);
      if (d){ fechaInicio = d; break; }
    }
    const ano = fechaInicio ? String(fechaInicio.getFullYear()) : '';

    const searchBlob = norm([gid, nombre, destino, programa, coord].join(' '));

    state.rowsAll.push({
      gid,
      nombre,
      destino,
      programa,
      coord,

      esperados,
      declarados,

      paxReales: paxRealesFS,         // null si no existe
      paxLiberados,                   // num (default o FS)
      paxLiberadosDefault: liberadosDefault,

      revisionPax,
      fechaInicio,
      ano,
      searchBlob,
    });
  });

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
  if (ui.fDestino) fillSelect(ui.fDestino, ['(TODOS)', ...uniq(state.rowsAll.map(r=>r.destino).filter(Boolean))]);
  if (ui.fPrograma) fillSelect(ui.fPrograma, ['(TODOS)', ...uniq(state.rowsAll.map(r=>r.programa).filter(Boolean))]);
  if (ui.fCoord) fillSelect(ui.fCoord, ['(TODOS)', ...uniq(state.rowsAll.map(r=>r.coord).filter(Boolean))]);
  if (ui.fAno) fillSelect(ui.fAno, ['(TODOS)', ...uniq(state.rowsAll.map(r=>r.ano).filter(Boolean)).sort()]);
}

function fillSelect(sel, values){
  if (!sel) return;
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
  const q = norm(ui.q?.value || '');
  const destino = ui.fDestino?.value || '(TODOS)';
  const programa = ui.fPrograma?.value || '(TODOS)';
  const coord = ui.fCoord?.value || '(TODOS)';
  const ano = ui.fAno?.value || '(TODOS)';

  const soloDif = (ui.fSoloDiferencias?.value === 'SI');
  const soloSinReales = (ui.fSoloSinReales?.value === 'SI');

  const desde = ui.fDesde?.value ? new Date(ui.fDesde.value + 'T00:00:00') : null;
  const hasta = ui.fHasta?.value ? new Date(ui.fHasta.value + 'T23:59:59') : null;

  const rows = state.rowsAll.filter(r=>{
    if (destino !== '(TODOS)' && r.destino !== destino) return false;
    if (programa !== '(TODOS)' && r.programa !== programa) return false;
    if (coord !== '(TODOS)' && r.coord !== coord) return false;
    if (ano !== '(TODOS)' && r.ano !== ano) return false;

    if (desde && r.fechaInicio && r.fechaInicio < desde) return false;
    if (hasta && r.fechaInicio && r.fechaInicio > hasta) return false;
    if ((desde || hasta) && !r.fechaInicio) return false;

    if (q && !r.searchBlob.includes(q)) return false;

    // OJO: filtros “soloDif / soloSinReales” deben usar effectiveReales (incluye auto)
    const declared = Number(r.declarados || 0);
    const realesEff = effectiveReales(r);
    const realesNum = (realesEff == null || realesEff === '') ? null : Number(realesEff);

    if (soloSinReales && (realesNum != null && Number.isFinite(realesNum))) return false;

    if (soloDif){
      if (realesNum == null || !Number.isFinite(realesNum)) return false;
      if (realesNum === declared) return false;
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
  if (!ui.tbody) return;

  if (!rows.length){
    ui.tbody.innerHTML = `<tr><td colspan="9" class="es-empty">Sin resultados.</td></tr>`;
    return;
  }

  ui.tbody.innerHTML = '';

  for (const r of rows){
    const tr = document.createElement('tr');
    tr.dataset.gid = r.gid;

    const expected = Number(r.esperados || 0);
    const declared = Number(r.declarados || 0);

    const dirty = state.dirty.get(r.gid);

    const valLiberados = (dirty && dirty.paxLiberados !== undefined) ? dirty.paxLiberados : r.paxLiberados;
    const valReales = effectiveReales(r);

    const revisionVal = (dirty && dirty.revisionPax !== undefined) ? dirty.revisionPax : (r.revisionPax || '');

    const { status, needsRevision } = computeStatus(r, revisionVal);

    // clases visuales (para CSS)
    const revClass =
      (status === 'CORREGIDO') ? 'rev-ok' :
      (status === 'PENDIENTE') ? 'rev-warn' : 'rev-neutral';

    const estadoHTML =
      (status === 'CORREGIDO') ? `<span class="es-badge ok">CORREGIDO</span>` :
      (status === 'PENDIENTE') ? `<span class="es-badge warn">PENDIENTE</span>` :
                                 `<span class="es-badge">OK</span>`;

    tr.innerHTML = `
      <td class="es-nowrap es-mono">${escapeHtml(r.gid)}</td>
      <td>${escapeHtml(r.nombre || '(sin nombre)')}</td>

      <!-- Coordinador en mayúsculas (visual) -->
      <td class="es-nowrap col-coord">${escapeHtml((r.coord || '').toUpperCase())}</td>

      <td class="es-nowrap es-right es-mono">${expected}</td>
      <td class="es-nowrap es-right es-mono">${declared}</td>

      <!-- PAX LIBERADOS -->
      <td class="es-nowrap">
        <input class="cell-input num" type="number" min="0" step="1"
               data-role="paxLiberados"
               value="${valLiberados == null ? '' : String(valLiberados)}"
               placeholder="${String(r.paxLiberadosDefault)}" />
      </td>

      <!-- PAX REALES (usa effectiveReales => puede venir auto-cargado) -->
      <td class="es-nowrap">
        <input class="cell-input num" type="number" min="0" step="1"
               data-role="paxReales"
               value="${valReales == null ? '' : String(valReales)}"
               placeholder="(vacío)" />
      </td>

      <td>
        <input class="cell-input rev ${revClass}" type="text"
               data-role="revision"
               value="${escapeAttr(revisionVal)}"
               placeholder="${needsRevision ? 'Motivo / comentario' : 'OK'}"
               title="${escapeAttr(revisionVal || '')}"
               ${needsRevision ? '' : 'disabled'} />
      </td>

      <td class="es-nowrap">${estadoHTML}</td>
    `;

    // listeners
    const inpLiberados = tr.querySelector('input[data-role="paxLiberados"]');
    const inpReales = tr.querySelector('input[data-role="paxReales"]');
    const inpRevision = tr.querySelector('input[data-role="revision"]');

    inpLiberados.addEventListener('input', ()=> onEditRow(r.gid, tr));
    inpReales.addEventListener('input', ()=> onEditRow(r.gid, tr));
    inpRevision.addEventListener('input', ()=> onEditRow(r.gid, tr, { onlyRevision:true }));

    ui.tbody.appendChild(tr);

    if (state.dirty.has(r.gid)) tr.classList.add('es-row-dirty');
  }
}

function onEditRow(gid, tr, opts = {}){
  const row = state.rowsAll.find(x=>x.gid === gid);
  if (!row) return;

  const inpLiberados = tr.querySelector('input[data-role="paxLiberados"]');
  const inpReales = tr.querySelector('input[data-role="paxReales"]');
  const inpRevision = tr.querySelector('input[data-role="revision"]');

  // leer valores
  const rawLiberados = inpLiberados.value;
  const nLiberados = rawLiberados === '' ? null : Number(rawLiberados);

  const rawReales = inpReales.value;
  const nReales = rawReales === '' ? null : Number(rawReales);

  // construir next dirty
  const prev = state.dirty.get(gid) || {};
  const next = {
    ...prev,
    paxLiberados: nLiberados,
    paxReales: nReales,
    // ojo: la revisión se decide abajo con needsRevision
    revisionPax: safeText(inpRevision.value || ''),
  };

  // aplicar provisionalmente a state.dirty para que computeStatus use effective* con dirty
  state.dirty.set(gid, next);

  // recalcular estado (con lo que el usuario escribió)
  const { status, needsRevision } = computeStatus(row, next.revisionPax);

  // habilitar/deshabilitar revisión según needsRevision
  if (needsRevision){
    inpRevision.disabled = false;
    if (!inpRevision.placeholder || inpRevision.placeholder === 'OK'){
      inpRevision.placeholder = 'Motivo / comentario';
    }
  } else {
    inpRevision.disabled = true;
    inpRevision.value = '';         // si ya no requiere, limpiamos
    next.revisionPax = '';
  }

  // tooltip siempre sincronizado si está habilitado
  inpRevision.title = inpRevision.disabled ? '' : (inpRevision.value || '');

  // clases visuales revisión
  inpRevision.classList.remove('rev-ok','rev-warn','rev-neutral');
  if (status === 'CORREGIDO') inpRevision.classList.add('rev-ok');
  else if (status === 'PENDIENTE') inpRevision.classList.add('rev-warn');
  else inpRevision.classList.add('rev-neutral');

  // badge
  const estadoCell = tr.lastElementChild;
  estadoCell.innerHTML =
    (status === 'CORREGIDO') ? `<span class="es-badge ok">CORREGIDO</span>` :
    (status === 'PENDIENTE') ? `<span class="es-badge warn">PENDIENTE</span>` :
                               `<span class="es-badge">OK</span>`;

  // decidir si realmente queda dirty (comparado con base)
  const baseLiberados = Number(row.paxLiberados); // base ya trae FS o default
  const curLiberados = (next.paxLiberados == null ? baseLiberados : Number(next.paxLiberados));
  const sameLiberados = Number.isFinite(curLiberados) && (curLiberados === baseLiberados);

  const baseReales = (row.paxReales == null ? null : Number(row.paxReales));
  const curReales = (next.paxReales == null ? null : Number(next.paxReales));
  const sameReales = (baseReales === curReales);

  const sameRev = (safeText(row.revisionPax || '') === safeText(next.revisionPax || ''));

  // IMPORTANTE:
  // - el auto-reales NO es dirty, porque no queremos escribir a FS.
  // - si el usuario no tocó reales/liberados/revision, no debe quedar dirty.
  if (sameLiberados && sameReales && sameRev){
    state.dirty.delete(gid);
    tr.classList.remove('es-row-dirty');
  } else {
    state.dirty.set(gid, next);
    tr.classList.add('es-row-dirty');
  }

  if (ui.btnGuardar) ui.btnGuardar.disabled = (state.dirty.size === 0);
  recalcKpis();
}

/* =========================
   KPI
========================= */
function recalcKpis(){
  const rows = state.rowsView;

  let grupos = rows.length;
  let esperados = 0;
  let declarados = 0;

  let realesSum = 0;
  let realesCount = 0;
  let esperadosBaseReales = 0;

  let liberadosSum = 0;

  for (const r of rows){
    esperados += Number(r.esperados || 0);
    declarados += Number(r.declarados || 0);

    // reales (incluye auto)
    const vReales = effectiveReales(r);
    const hasReales = (vReales != null && vReales !== '' && Number.isFinite(Number(vReales)));

    // liberados (dirty o base)
    const vLiberadosRaw = effectiveLiberados(r);
    const vLiberados = (vLiberadosRaw == null || vLiberadosRaw === '' ? Number(r.paxLiberadosDefault || 0) : Number(vLiberadosRaw));
    if (Number.isFinite(vLiberados)) liberadosSum += vLiberados;

    if (hasReales){
      realesSum += Number(vReales);
      realesCount += 1;

      // ✅ Para delta reales, mantenemos tu criterio anterior:
      // solo sumamos esperados en los grupos que tienen "reales informados" (incluye auto-reales)
      esperadosBaseReales += Number(r.esperados || 0);
    }
  }

  const deltaDeclarados = declarados - esperados;
  const deltaReales = (realesCount === 0) ? 0 : (realesSum - esperadosBaseReales);
  const neto = realesSum - liberadosSum;

  if (ui.kGrupos) ui.kGrupos.textContent = String(grupos);
  if (ui.kGruposHint) ui.kGruposHint.textContent = `${state.dirty.size} con cambios pendientes`;

  if (ui.kEsperados) ui.kEsperados.textContent = String(esperados);
  if (ui.kDeclarados) ui.kDeclarados.textContent = String(declarados);

  if (ui.kReales) ui.kReales.textContent = String(realesSum);
  if (ui.kRealesHint) ui.kRealesHint.textContent = String(realesCount);

  if (ui.kLiberados) ui.kLiberados.textContent = String(liberadosSum);
  if (ui.kNeto) ui.kNeto.textContent = String(neto);

  if (ui.kDelta) ui.kDelta.textContent = String(deltaDeclarados);
  if (ui.kDeltaBox){
    ui.kDeltaBox.classList.remove('delta-neg','delta-pos');
    if (deltaDeclarados < 0) ui.kDeltaBox.classList.add('delta-neg');
    else if (deltaDeclarados > 0) ui.kDeltaBox.classList.add('delta-pos');
  }

  if (ui.kDeltaReales) ui.kDeltaReales.textContent = String(deltaReales);
  if (ui.kDeltaRealesBox){
    ui.kDeltaRealesBox.classList.remove('delta-neg','delta-pos');
    if (realesCount === 0){
      // neutro
    } else if (deltaReales < 0) ui.kDeltaRealesBox.classList.add('delta-neg');
    else if (deltaReales > 0) ui.kDeltaRealesBox.classList.add('delta-pos');
  }
}

/* =========================
   RESET FILTERS
========================= */
function resetFilters(){
  if (ui.q) ui.q.value = '';
  if (ui.fDestino) ui.fDestino.value = '(TODOS)';
  if (ui.fPrograma) ui.fPrograma.value = '(TODOS)';
  if (ui.fCoord) ui.fCoord.value = '(TODOS)';
  if (ui.fAno) ui.fAno.value = '(TODOS)';
  if (ui.fDesde) ui.fDesde.value = '';
  if (ui.fHasta) ui.fHasta.value = '';
  if (ui.fSoloDiferencias) ui.fSoloDiferencias.value = 'NO';
  if (ui.fSoloSinReales) ui.fSoloSinReales.value = 'NO';

  applyFilters();
}

/* =========================
   SAVE
========================= */
async function guardarCambios(){
  if (!state.user) return;
  if (state.dirty.size === 0) return;

  // validación: si requiere revisión => motivo obligatorio
  const problems = [];
  for (const [gid, ch] of state.dirty.entries()){
    const row = state.rowsAll.find(x=>x.gid === gid);
    if (!row) continue;

    // computeStatus usando el texto guardado
    const { needsRevision, status } = computeStatus(row, ch.revisionPax || '');

    if (needsRevision && !safeText(ch.revisionPax).trim()){
      problems.push(gid);
    }
  }
  if (problems.length){
    setStatus(`Falta "Revisión" en ${problems.length} grupo(s) (ej: ${problems.slice(0,3).join(', ')})`, true);
    return;
  }

  try{
    setStatus(`Guardando ${state.dirty.size} cambio(s)...`);

    const batch = writeBatch(db);
    const now = serverTimestamp();

    for (const [gid, ch] of state.dirty.entries()){
      const ref = doc(db, GROUPS_COLLECTION, gid);

      const row = state.rowsAll.find(x=>x.gid === gid);

      const liberadosFinal =
        (ch.paxLiberados == null || ch.paxLiberados === '')
          ? Number(row?.paxLiberados ?? row?.paxLiberadosDefault ?? 0)
          : Number(ch.paxLiberados);

      batch.update(ref, {
        paxReales: ch.paxReales, // puede ser null si lo dejaste vacío
        [LIBERADOS_KEY]: Number.isFinite(liberadosFinal) ? liberadosFinal : 0,

        revisionPax: safeText(ch.revisionPax || ''),
        revisionPaxUpdatedAt: now,
        revisionPaxUpdatedBy: state.user.email || '',
      });
    }

    await batch.commit();

    // aplicar cambios al state base
    for (const [gid, ch] of state.dirty.entries()){
      const row = state.rowsAll.find(x=>x.gid === gid);
      if (!row) continue;

      row.paxReales = ch.paxReales;
      row.revisionPax = safeText(ch.revisionPax || '');

      const liberadosFinal =
        (ch.paxLiberados == null || ch.paxLiberados === '')
          ? Number(row.paxLiberados)
          : Number(ch.paxLiberados);

      row.paxLiberados = Number.isFinite(liberadosFinal) ? liberadosFinal : row.paxLiberados;
    }

    state.dirty.clear();
    if (ui.btnGuardar) ui.btnGuardar.disabled = true;

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
  if (!ui.status) return;
  ui.status.textContent = msg;
  ui.status.style.color = isErr ? '#b91c1c' : '#374151';
}

function exportarXLS(){
  if (!state.rowsView || !state.rowsView.length){
    setStatus('No hay datos para exportar.', true);
    return;
  }

  if (typeof XLSX === 'undefined'){
    setStatus('No se cargó la librería XLSX. Revisa que el <script src="...xlsx..."> esté en el HTML.', true);
    return;
  }

  // Construimos filas
  const rows = state.rowsView.map(r=>{
    const reales = effectiveReales(r);
    const liberados = effectiveLiberados(r);

    const d = state.dirty.get(r.gid);
    const revisionNow = (d && d.revisionPax !== undefined) ? d.revisionPax : (r.revisionPax || '');
    const { status } = computeStatus(r, revisionNow);

    return {
      GID: r.gid,
      Grupo: r.nombre || '',
      Coordinador: (r.coord || '').toUpperCase(),
      'PAX Esperados': Number(r.esperados || 0),
      'PAX Declarados': Number(r.declarados || 0),
      'PAX Liberados': Number(liberados || 0),
      'PAX Reales': (reales == null ? '' : Number(reales)),
      Estado: status,
      Revisión: safeText(revisionNow || ''),
    };
  });

  // Crear worksheet
  const ws = XLSX.utils.json_to_sheet(rows);

  // Auto ancho de columnas
  ws['!cols'] = Object.keys(rows[0]).map(k=>({
    wch: Math.max(
      k.length,
      ...rows.map(r=> String(r[k] ?? '').length)
    ) + 2
  }));

  // Crear workbook
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Estadísticas');

  const today = new Date().toISOString().slice(0,10);
  const filename = `RT_Estadisticas_PAX_${today}.xlsx`;

  XLSX.writeFile(wb, filename);

  setStatus('📊 Archivo XLS exportado.');
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


