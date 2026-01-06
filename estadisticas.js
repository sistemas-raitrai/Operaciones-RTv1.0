// estadisticas.js
// RT · Estadísticas (PAX esperados / declarados / reales + revisión)
// ✅ Mantiene estética (encabezado + estilos.css) y aisla UI con overrides en el HTML
// ✅ Edita PAX Reales
// ✅ NUEVO:
//    - Si Esperados == Declarados => PAX Reales se autocompleta con ese valor (sin escribir en Firestore)
//      y el estado queda OK (auto) + cuenta en KPI de Reales.
//    - Si Esperados != Declarados => estado PENDIENTE hasta que se corrija (reales + revisión).
//      Al corregir => estado "CORREGIDO" en verde (NO "DIFERENCIA" en rojo).
// ✅ Botón Guardar: escribe SOLO cambios (dirty) en Firestore
// ✅ Robusto a HTML parcial (si faltan filtros/IDs, no se cae)

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
const EXPECTED_KEYS = ['cantidadGrupo', 'paxEsperados', 'cantidadgrupo', 'paxTotal', 'pax'];

// Declarados (fallbacks)
const DECLARED_PATHS = [
  ['paxViajando','total'],
  ['paxViajandoTotal'],
  ['paxDeclarados'],
];

// Fecha inicio (fallbacks)
const START_DATE_PATHS = [
  ['fechaInicio'],
  ['fechas','inicio'],
  ['fechaDeViaje'], // si viene como texto, se intenta parse
];

/* =========================
   HELPERS
========================= */
const $ = (id)=> document.getElementById(id);
const exists = (el)=> !!el;

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

function isFiniteNum(v){
  const n = (typeof v === 'number') ? v : Number(v);
  return Number.isFinite(n);
}

/**
 * ✅ Reales “efectivos”:
 * - Si hay reales en Firestore => usa eso
 * - Si NO hay reales y (esperados == declarados) => reales efectivos = declarados (auto OK)
 * - Si no, null
 */
function effectiveReales(row){
  const r = row.paxReales;
  if (r != null && r !== '' && isFiniteNum(r)) return Number(r);

  const expected = row.esperados || 0;
  const declared = row.declarados || 0;

  if (expected === declared) return declared;  // 👈 auto OK
  return null;
}

/**
 * ✅ Baseline para comparar dirty (para que el auto OK NO marque cambios)
 * - Si Firestore trae paxReales => baseline = ese valor
 * - Si no trae y expected==declared => baseline = declared (auto)
 * - Si no, baseline = null
 */
function baselineReales(row){
  const r = row.paxReales;
  if (r != null && r !== '' && isFiniteNum(r)) return Number(r);

  const expected = row.esperados || 0;
  const declared = row.declarados || 0;

  if (expected === declared) return declared;
  return null;
}

/**
 * ✅ Estados:
 * - OK (auto): expected==declared (reales efectivos existe por regla auto) y NO requiere acción
 * - PENDIENTE: expected!=declared y aún no está corregido (falta reales y/o revisión)
 * - CORREGIDO: expected!=declared y ya hay reales + revisión
 */
function calcStatus(row, effectiveRealesValue, revisionText){
  const expected = row.esperados || 0;
  const declared = row.declarados || 0;
  const needsManual = (expected !== declared);

  if (!needsManual){
    return { key:'OK', label:'OK', css:'ok' };
  }

  const hasReales = (effectiveRealesValue != null && Number.isFinite(effectiveRealesValue));
  const hasRev = !!safeText(revisionText).trim();

  if (hasReales && hasRev){
    return { key:'CORREGIDO', label:'CORREGIDO', css:'ok' }; // verde
  }
  return { key:'PENDIENTE', label:'PENDIENTE', css:'warn' }; // ámbar
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
   UI REFS (robusto si faltan IDs)
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

  kReales: $('kReales'),
  kRealesHint: $('kRealesHint'),

  kDelta: $('kDelta'),
  kDeltaBox: $('kDeltaBox'),

  kDeltaReales: $('kDeltaReales'),
  kDeltaRealesBox: $('kDeltaRealesBox'),
};

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
  applyFilters(); // render inicial
  setStatus('Listo.');
}

/* =========================
   EVENTS
========================= */
function wireEvents(){
  if (exists(ui.btnAplicar)) ui.btnAplicar.addEventListener('click', ()=> applyFilters());
  if (exists(ui.btnLimpiar)) ui.btnLimpiar.addEventListener('click', ()=> resetFilters());
  if (exists(ui.btnGuardar)) ui.btnGuardar.addEventListener('click', ()=> guardarCambios());

  if (exists(ui.q)){
    ui.q.addEventListener('keydown', (e)=>{
      if (e.key === 'Enter'){ e.preventDefault(); applyFilters(); }
    });
  }
}

/* =========================
   LOAD GROUPS
========================= */
async function loadGroups(){
  state.rowsAll = [];
  state.dirty.clear();
  if (exists(ui.btnGuardar)) ui.btnGuardar.disabled = true;

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

    const paxReales = Number.isFinite(toNum(g.paxReales)) ? toNum(g.paxReales) : null;
    const revisionPax = safeText(g.revisionPax || '');

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
      paxReales,      // null si no existe
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
   FILTER OPTIONS (solo si existe el select)
========================= */
function buildFilterOptions(){
  if (exists(ui.fDestino)) fillSelect(ui.fDestino, ['(TODOS)', ...uniq(state.rowsAll.map(r=>r.destino).filter(Boolean))]);
  if (exists(ui.fPrograma)) fillSelect(ui.fPrograma, ['(TODOS)', ...uniq(state.rowsAll.map(r=>r.programa).filter(Boolean))]);
  if (exists(ui.fCoord)) fillSelect(ui.fCoord, ['(TODOS)', ...uniq(state.rowsAll.map(r=>r.coord).filter(Boolean))]);
  if (exists(ui.fAno)) fillSelect(ui.fAno, ['(TODOS)', ...uniq(state.rowsAll.map(r=>r.ano).filter(Boolean)).sort()]);
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
   APPLY FILTERS (tolerante a filtros faltantes)
========================= */
function applyFilters(){
  const q = exists(ui.q) ? norm(ui.q.value || '') : '';

  const destino = exists(ui.fDestino) ? (ui.fDestino.value || '(TODOS)') : '(TODOS)';
  const programa = exists(ui.fPrograma) ? (ui.fPrograma.value || '(TODOS)') : '(TODOS)';
  const coord = exists(ui.fCoord) ? (ui.fCoord.value || '(TODOS)') : '(TODOS)';
  const ano = exists(ui.fAno) ? (ui.fAno.value || '(TODOS)') : '(TODOS)';

  const soloDif = exists(ui.fSoloDiferencias) ? (ui.fSoloDiferencias.value === 'SI') : false;
  const soloSinReales = exists(ui.fSoloSinReales) ? (ui.fSoloSinReales.value === 'SI') : false;

  const desde = (exists(ui.fDesde) && ui.fDesde.value) ? new Date(ui.fDesde.value + 'T00:00:00') : null;
  const hasta = (exists(ui.fHasta) && ui.fHasta.value) ? new Date(ui.fHasta.value + 'T23:59:59') : null;

  const rows = state.rowsAll.filter(r=>{
    if (destino !== '(TODOS)' && r.destino !== destino) return false;
    if (programa !== '(TODOS)' && r.programa !== programa) return false;
    if (coord !== '(TODOS)' && r.coord !== coord) return false;
    if (ano !== '(TODOS)' && r.ano !== ano) return false;

    if (desde && r.fechaInicio && r.fechaInicio < desde) return false;
    if (hasta && r.fechaInicio && r.fechaInicio > hasta) return false;
    if ((desde || hasta) && !r.fechaInicio) return false;

    if (q && !r.searchBlob.includes(q)) return false;

    // ✅ “reales efectivos” incluye auto OK cuando expected==declared
    const effReales = effectiveReales(r);

    if (soloSinReales && effReales != null) return false;

    if (soloDif){
      // solo dif entre DECLARADOS y REALES EFECTIVOS (si hay)
      if (effReales == null) return false;
      if (effReales === (r.declarados || 0)) return false;
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

  if (!exists(ui.tbody)) return;

  if (!rows.length){
    ui.tbody.innerHTML = `<tr><td colspan="8" class="es-empty">Sin resultados.</td></tr>`;
    return;
  }

  ui.tbody.innerHTML = '';

  for (const r of rows){
    const tr = document.createElement('tr');
    tr.dataset.gid = r.gid;

    const expected = r.esperados || 0;
    const declared = r.declarados || 0;

    const dirty = state.dirty.get(r.gid);

    // ✅ valor reales a mostrar:
    // - si hay dirty => dirty
    // - si no => reales efectivos (incluye auto OK)
    const baseEff = effectiveReales(r);
    const valReales = (dirty && dirty.paxReales !== undefined) ? dirty.paxReales : baseEff;

    const realesNum = (valReales == null || valReales === '' ? null : Number(valReales));
    const revisionVal = (dirty && dirty.revisionPax !== undefined) ? dirty.revisionPax : (r.revisionPax || '');

    const st = calcStatus(r, realesNum, revisionVal);

    // ✅ Revisión habilitada solo si necesita manual (expected!=declared)
    const needsManual = (expected !== declared);
    const revisionDisabled = needsManual ? '' : 'disabled';

    // placeholder de revisión
    const revPh = needsManual ? 'Motivo / comentario' : '—';

    // badge
    const estadoHTML = (st.key === 'OK')
      ? `<span class="es-badge">OK</span>`
      : (st.key === 'CORREGIDO'
          ? `<span class="es-badge" style="border-color:#16a34a;background:#ecfdf5;color:#166534;">CORREGIDO</span>`
          : `<span class="es-badge warn">PENDIENTE</span>`
        );

    tr.innerHTML = `
      <td class="es-nowrap es-mono">${escapeHtml(r.gid)}</td>
      <td>${escapeHtml(r.nombre || '(sin nombre)')}</td>
      <td class="es-nowrap">${escapeHtml(r.coord || '')}</td>

      <td class="es-nowrap es-right es-mono">${expected}</td>
      <td class="es-nowrap es-right es-mono">${declared}</td>

      <td class="es-nowrap">
        <input class="cell-input num" type="number" min="0" step="1"
               data-role="paxReales"
               value="${valReales == null ? '' : String(valReales)}"
               placeholder="(vacío)" />
      </td>

      <td>
        <input class="cell-input" type="text"
               data-role="revision"
               value="${escapeAttr(revisionVal)}"
               title="${escapeAttr(revisionVal)}"
               placeholder="${revPh}"
               ${revisionDisabled} />
      </td>

      <td class="es-nowrap">${estadoHTML}</td>
    `;

    const inpReales = tr.querySelector('input[data-role="paxReales"]');
    const inpRevision = tr.querySelector('input[data-role="revision"]');

    // ✅ Si NO necesita manual, dejamos revisión deshabilitada y NO exigimos comentario.
    //    Si necesitas permitir comentarios igual, me dices y lo habilitamos.
    if (needsManual){
      // listeners
      inpReales.addEventListener('input', ()=> onEditRow(r.gid, tr));
      inpRevision.addEventListener('input', ()=> onEditRow(r.gid, tr, { onlyRevision:true }));
    } else {
      // Aún permitimos cambiar PAX Reales si alguien quiere, pero eso lo convierte en dirty.
      inpReales.addEventListener('input', ()=> onEditRow(r.gid, tr));
    }

    ui.tbody.appendChild(tr);

    if (state.dirty.has(r.gid)) tr.classList.add('es-row-dirty');
  }
}

function onEditRow(gid, tr){
  const row = state.rowsAll.find(x=>x.gid === gid);
  if (!row) return;

  const expected = row.esperados || 0;
  const declared = row.declarados || 0;
  const needsManual = (expected !== declared);

  const inpReales = tr.querySelector('input[data-role="paxReales"]');
  const inpRevision = tr.querySelector('input[data-role="revision"]');

  const rawReales = inpReales.value;
  const nReales = rawReales === '' ? null : Number(rawReales);
  const realesOk = (nReales == null ? null : (Number.isFinite(nReales) ? nReales : null));

  // ✅ lógica de habilitación de revisión:
  // - Solo si needsManual (expected!=declared) => revisión habilitada
  // - Si no needsManual => revisión siempre deshabilitada + vacía (no se guarda)
  if (!needsManual){
    if (inpRevision){
      inpRevision.disabled = true;
      inpRevision.value = '';
      inpRevision.placeholder = '—';
    }
  } else {
    if (inpRevision){
      inpRevision.disabled = false;
      inpRevision.placeholder = 'Motivo / comentario';
    }
  }

  const revisionTxt = needsManual ? safeText(inpRevision?.value || '') : '';
  if (inpRevision) inpRevision.title = safeText(inpRevision.value || '');

  // ✅ badge estado basado en reglas nuevas
  const st = calcStatus(row, realesOk, revisionTxt);
  const estadoCell = tr.lastElementChild;

  if (st.key === 'OK'){
    estadoCell.innerHTML = `<span class="es-badge">OK</span>`;
  } else if (st.key === 'CORREGIDO'){
    estadoCell.innerHTML = `<span class="es-badge" style="border-color:#16a34a;background:#ecfdf5;color:#166534;">CORREGIDO</span>`;
  } else {
    estadoCell.innerHTML = `<span class="es-badge warn">PENDIENTE</span>`;
  }

  // ✅ marcar dirty comparando contra BASELINE (para no ensuciar por auto-fill)
  const prev = state.dirty.get(gid) || {};
  const next = {
    ...prev,
    paxReales: realesOk,                 // null si vacío
    revisionPax: needsManual ? revisionTxt : '',
  };

  const baseReales = baselineReales(row);
  const baseRev = needsManual ? safeText(row.revisionPax || '') : '';

  const sameReales = (baseReales == null ? null : Number(baseReales)) === (next.paxReales == null ? null : Number(next.paxReales));
  const sameRev = (safeText(baseRev) === safeText(next.revisionPax || ''));

  if (sameReales && sameRev){
    state.dirty.delete(gid);
    tr.classList.remove('es-row-dirty');
  } else {
    state.dirty.set(gid, next);
    tr.classList.add('es-row-dirty');
  }

  if (exists(ui.btnGuardar)) ui.btnGuardar.disabled = (state.dirty.size === 0);
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
  let esperadosBaseReales = 0; // ✅ esperados solo donde hay reales efectivos

  for (const r of rows){
    esperados += (r.esperados || 0);
    declarados += (r.declarados || 0);

    // ✅ Reales deben reflejar lo que el usuario edita (dirty)
    const d = state.dirty.get(r.gid);
    let eff;

    if (d && d.paxReales !== undefined){
      // si el usuario está editando, usamos eso como "reales efectivos"
      eff = (d.paxReales == null ? null : Number(d.paxReales));
    } else {
      eff = effectiveReales(r); // incluye auto OK
    }

    const hasReales = (eff != null && Number.isFinite(eff));
    if (hasReales){
      realesSum += eff;
      realesCount += 1;
      esperadosBaseReales += (r.esperados || 0);
    }
  }

  const deltaDeclarados = declarados - esperados;
  const deltaReales = realesSum - esperadosBaseReales;

  // --- pintar KPIs si existen ---
  if (exists(ui.kGrupos)) ui.kGrupos.textContent = String(grupos);
  if (exists(ui.kGruposHint)) ui.kGruposHint.textContent = `${state.dirty.size} con cambios pendientes`;

  if (exists(ui.kEsperados)) ui.kEsperados.textContent = String(esperados);
  if (exists(ui.kDeclarados)) ui.kDeclarados.textContent = String(declarados);

  if (exists(ui.kReales)) ui.kReales.textContent = String(realesSum);
  if (exists(ui.kRealesHint)) ui.kRealesHint.textContent = String(realesCount);

  // delta declarados (mantiene tu regla clásica: negativo rojo, positivo verde)
  if (exists(ui.kDelta)) ui.kDelta.textContent = String(deltaDeclarados);
  if (exists(ui.kDeltaBox)){
    ui.kDeltaBox.classList.remove('delta-neg','delta-pos');
    if (deltaDeclarados < 0) ui.kDeltaBox.classList.add('delta-neg');
    else if (deltaDeclarados > 0) ui.kDeltaBox.classList.add('delta-pos');
  }

  // ✅ delta reales:
  // IMPORTANTE: tú pediste explícitamente que cuando sea negativo "debería ser en verde".
  // Por eso invertimos el color:
  //   - deltaReales < 0 => verde (delta-pos)
  //   - deltaReales > 0 => rojo (delta-neg)
  if (exists(ui.kDeltaReales)) ui.kDeltaReales.textContent = String(deltaReales);
  if (exists(ui.kDeltaRealesBox)){
    ui.kDeltaRealesBox.classList.remove('delta-neg','delta-pos');

    if (realesCount === 0){
      // neutro
    } else if (deltaReales < 0){
      ui.kDeltaRealesBox.classList.add('delta-pos'); // verde (invertido)
    } else if (deltaReales > 0){
      ui.kDeltaRealesBox.classList.add('delta-neg'); // rojo (invertido)
    }
  }
}

/* =========================
   RESET FILTERS (tolerante a faltantes)
========================= */
function resetFilters(){
  if (exists(ui.q)) ui.q.value = '';

  if (exists(ui.fDestino)) ui.fDestino.value = '(TODOS)';
  if (exists(ui.fPrograma)) ui.fPrograma.value = '(TODOS)';
  if (exists(ui.fCoord)) ui.fCoord.value = '(TODOS)';
  if (exists(ui.fAno)) ui.fAno.value = '(TODOS)';

  if (exists(ui.fDesde)) ui.fDesde.value = '';
  if (exists(ui.fHasta)) ui.fHasta.value = '';

  if (exists(ui.fSoloDiferencias)) ui.fSoloDiferencias.value = 'NO';
  if (exists(ui.fSoloSinReales)) ui.fSoloSinReales.value = 'NO';

  applyFilters();
}

/* =========================
   SAVE
========================= */
async function guardarCambios(){
  if (!state.user) return;
  if (state.dirty.size === 0) return;

  // ✅ validación NUEVA:
  // SOLO exigimos "Revisión" cuando el grupo requiere manual (expected!=declared)
  // y además estamos guardando reales (o cambio) para ese grupo.
  const problems = [];
  for (const [gid, ch] of state.dirty.entries()){
    const row = state.rowsAll.find(x=>x.gid === gid);
    if (!row) continue;

    const needsManual = ((row.esperados || 0) !== (row.declarados || 0));
    if (!needsManual) continue;

    const hasReales = (ch.paxReales != null && Number.isFinite(ch.paxReales));
    const hasRev = !!safeText(ch.revisionPax).trim();

    // Si requiere manual, pedimos comentario siempre (aunque ponga reales igual a declarados)
    if (hasReales && !hasRev){
      problems.push(gid);
    }
  }

  if (problems.length){
    setStatus(`Falta "Revisión" en ${problems.length} grupo(s) que están PENDIENTE/CORRECCIÓN (ej: ${problems.slice(0,3).join(', ')})`, true);
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
    if (exists(ui.btnGuardar)) ui.btnGuardar.disabled = true;

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
  if (!exists(ui.status)) return;
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
