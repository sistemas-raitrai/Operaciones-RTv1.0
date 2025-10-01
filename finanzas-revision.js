// finanzas-revision.js — Revisión financiera (doble auditoría + pagables)
// ----------------------------------------------------------------------
// • Autodetecta la colección con datos.
// • Normaliza documentos con campos heterogéneos (tipo/fecha/monto/etc.).
// • Doble revisión (rev1 y rev2) con email + nota + timestamp.
// • Estado general derivado: aprobado | rechazado | pendiente.
// • “Pagables” = estadoGeneral === 'aprobado' y pagado === false.
// • Modo portal (solo lectura) via ?src=portal&coord=...&grupo=...,
//   y modo sistema (roles finanzas/supervisión/admin) con controles activos.

import { app, db } from './firebase-init.js';
import {
  getAuth, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, query, where, orderBy, limit, startAfter,
  getDocs, getDoc, doc, updateDoc, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

// ----------------------------------------------------------------------
// 0) DOM y estado base
// ----------------------------------------------------------------------
const auth        = getAuth(app);
const $root       = document.getElementById('finanzasRoot');
const $tbody      = document.querySelector('#tblFinanzas tbody');
const $stateTabs  = document.getElementById('stateTabs');
const $fTipo      = document.getElementById('filtroTipo');
const $fCoord     = document.getElementById('filtroCoord');
const $fGrupo     = document.getElementById('filtroGrupo');
const $btnAplicar = document.getElementById('btnAplicar');
const $btnRecarga = document.getElementById('btnRecargar');
const $btnMas     = document.getElementById('btnMas');
const $resumen    = document.getElementById('resumen');
const $pagInfo    = document.getElementById('pagInfo');

// QueryString para modo portal y pre-filtros
const qs         = new URLSearchParams(location.search);
const fromPortal = qs.get('src') === 'portal';
const prefCoord  = qs.get('coord') || '';
const prefGrupo  = qs.get('grupo') || '';
if (fromPortal) $root.dataset.mode = 'portal';
if (prefCoord)  $fCoord.value = prefCoord;
if (prefGrupo)  $fGrupo.value = prefGrupo;

let currentUserEmail = '';
let currentEstadoTab = '';     // '', 'pendiente', 'aprobado', 'rechazado', 'pagables'
const PAGE_SIZE      = 40;
let lastDocSnap      = null;   // cursor de paginación

// ----------------------------------------------------------------------
// 1) Autodetección de colección + normalización de documentos
// ----------------------------------------------------------------------

// Intentos en orden hasta encontrar datos
const CANDIDATE_COLLECTIONS = [
  'finanzasMovimientos',
  'movimientos',
  'finanzas',
  'situacionFinanciera',
  'gastosAbonos'
];

let ACTIVE_COLLECTION = null;

/**
 * Detecta cuál colección tiene datos y la fija como activa.
 */
async function autoDetectCollection() {
  if (ACTIVE_COLLECTION) return ACTIVE_COLLECTION;
  for (const name of CANDIDATE_COLLECTIONS) {
    try {
      const snap = await getDocs(query(collection(db, name), limit(1)));
      if (!snap.empty) {
        ACTIVE_COLLECTION = name;
        console.log('✅ Colección activa para revisión financiera:', name);
        return name;
      }
    } catch (_) { /* sigue intentando */ }
  }
  throw new Error('No se encontró colección de finanzas con datos. Revisa el nombre de la colección.');
}

/**
 * Convierte distintas variantes de fechas a un objeto Date imprimible.
 */
function dmy(tsOrIso) {
  if (!tsOrIso) return '';
  try {
    const d = typeof tsOrIso === 'string'
      ? new Date(tsOrIso)
      : (tsOrIso?.toDate ? tsOrIso.toDate() : new Date(tsOrIso));
    return d.toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'short' });
  } catch { return String(tsOrIso); }
}

/**
 * Da formato CLP por defecto.
 */
function money(n, curr = 'CLP') {
  if (n == null || n === '') return '-';
  try {
    return Number(n).toLocaleString('es-CL', { style:'currency', currency: curr, maximumFractionDigits:0 });
  } catch { return n; }
}

/**
 * Determina el estado general a partir de rev1 & rev2.
 */
function computeEstadoGeneral(rev1, rev2) {
  const s1 = rev1?.status || 'pendiente';
  const s2 = rev2?.status || 'pendiente';
  if (s1 === 'aprobado' && s2 === 'aprobado') return 'aprobado';
  if (s1 === 'rechazado' || s2 === 'rechazado') return 'rechazado';
  return 'pendiente';
}

/**
 * Normaliza un documento crudo de Firestore a la forma que usa la UI.
 */
function mapDoc(raw, id) {
  const x = raw || {};

  // Tipo (acepta variantes y mayúsculas)
  const tipoRaw   = x.tipo ?? x.Tipo ?? x.concepto ?? x.movimiento ?? '';
  const tipo      = String(tipoRaw).trim();
  const tipoLower = tipo.toLowerCase();

  // Monto/moneda
  const monto   = x.monto ?? x.valor ?? x.total ?? null;
  const moneda  = x.moneda ?? x.currency ?? 'CLP';

  // Grupo (id/nombre)
  const grupoId     = x.grupoId ?? x.idGrupo ?? x.grupo ?? x.numeroNegocio ?? null;
  const grupoNombre = x.grupoNombre ?? x.nombreGrupo ?? x.aliasGrupo ?? '';

  // Coordinador
  const coordinadorEmail =
    (x.coordinadorEmail ?? x.coordinadorCorreo ?? x.emailCoordinador ?? x.coordinador?.correo ?? '')
      .toString().trim().toLowerCase();

  // Fecha (varias posibilidades)
  const fecha = x.fecha ?? x.fechaISO ?? x.fechaMovimiento ?? x.creadoEn ?? x.meta?.creadoEn ?? x.meta?.actualizadoEn ?? null;

  // Revisiones
  const rev1 = x.rev1 ?? { status:'pendiente', by:null, at:null, nota:'' };
  const rev2 = x.rev2 ?? { status:'pendiente', by:null, at:null, nota:'' };

  // Estado general y pago
  const estadoGeneral = x.estadoGeneral ?? computeEstadoGeneral(rev1, rev2);
  const pagable       = x.pagable ?? (estadoGeneral === 'aprobado');
  const pagado        = x.pagado ?? false;

  return {
    id,
    tipo, tipoLower,
    monto, moneda,
    grupoId, grupoNombre,
    coordinadorEmail,
    fecha,
    rev1, rev2,
    estadoGeneral, pagable, pagado,
    pagadoAt: x.pagadoAt ?? null,
    pagadoBy: x.pagadoBy ?? null,
    comprobanteURL: x.comprobanteURL ?? x.comprobante ?? null
  };
}

// ----------------------------------------------------------------------
// 2) Construcción de consultas tolerantes (filtros + tabs)
// ----------------------------------------------------------------------

/**
 * Tabs: '', 'pendiente', 'aprobado', 'rechazado', 'pagables'
 */
function estFromTabsValue(v) { return v; }

/**
 * Construye una query tolerante a variantes.
 * - tipo usa IN para cubrir "gasto"/"GASTO"/"Gastos", etc. (máx 10 valores)
 * - estado 'pagables' se resuelve con pagable==true && pagado==false
 * - orden por 'fecha' y si no existe, cae a 'meta.actualizadoEn'
 */
function buildQuery({ estado, tipo, coord, grupo, afterSnap } = {}) {
  const col = collection(db, ACTIVE_COLLECTION);
  const clauses = [];

  // Filtro por tipo (si se selecciona)
  if (tipo === 'gasto') {
    clauses.push(where('tipo', 'in', ['gasto','Gasto','GASTO','gastos','Gastos']));
  } else if (tipo === 'abono') {
    clauses.push(where('tipo', 'in', ['abono','Abono','ABONO','abonos','Abonos']));
  }

  // Coordinador
  if (coord) clauses.push(where('coordinadorEmail', '==', coord));

  // Grupo: si parece ID (safe) se filtra en Firestore; si es nombre, se filtrará luego en memoria
  if (grupo && /^[A-Za-z0-9_-]+$/.test(grupo.trim())) {
    clauses.push(where('grupoId', '==', grupo.trim()));
  }

  // Estado
  if (estado && estado !== 'pagables') clauses.push(where('estadoGeneral', '==', estado));
  if (estado === 'pagables') {
    clauses.push(where('pagable', '==', true));
    clauses.push(where('pagado', '==', false));
  }

  // Orden con fallback
  let q;
  try {
    q = query(col, ...clauses, orderBy('fecha','desc'), ...(afterSnap ? [startAfter(afterSnap)] : []), limit(PAGE_SIZE));
  } catch {
    q = query(col, ...clauses, orderBy('meta.actualizadoEn','desc'), ...(afterSnap ? [startAfter(afterSnap)] : []), limit(PAGE_SIZE));
  }
  return q;
}

// ----------------------------------------------------------------------
// 3) Carga + paginación + render
// ----------------------------------------------------------------------

/**
 * Carga una página de resultados y renderiza filas.
 * Si el usuario puso texto de grupo que NO es ID, filtra por nombre en memoria.
 */
async function loadPage({ reset = false } = {}) {
  if (!$tbody) return;

  if (reset) {
    $tbody.innerHTML = '';
    lastDocSnap = null;
    if ($pagInfo) $pagInfo.textContent = '';
  }

  await autoDetectCollection();

  const estado = estFromTabsValue(currentEstadoTab);
  const tipo   = ($fTipo?.value || '').toLowerCase();            // '', 'gasto', 'abono'
  const coord  = ($fCoord?.value || '').trim().toLowerCase();
  const grupo  = ($fGrupo?.value || '').trim();

  const q = buildQuery({ estado, tipo, coord, grupo, afterSnap: lastDocSnap });
  const snap = await getDocs(q);

  // Normaliza resultados
  let rows = snap.docs.map(d => mapDoc(d.data(), d.id));

  // Grupo por nombre (si no es patrón de ID)
  if (grupo && !/^[A-Za-z0-9_-]+$/.test(grupo)) {
    const gnorm = grupo.toLowerCase();
    rows = rows.filter(x => (x.grupoNombre || '').toLowerCase().includes(gnorm));
  }

  // Render
  for (const mov of rows) $tbody.appendChild(renderRow(mov));

  // Paginación
  if ($btnMas && $pagInfo) {
    if (snap.docs.length === PAGE_SIZE) {
      lastDocSnap = snap.docs[snap.docs.length - 1];
      $btnMas.disabled = false;
      $pagInfo.textContent = 'Hay más resultados...';
    } else {
      lastDocSnap = null;
      $btnMas.disabled = true;
      $pagInfo.textContent = rows.length ? 'Fin de resultados.' : 'Sin resultados.';
    }
  }

  if ($resumen) $resumen.textContent = `Mostrando ${$tbody.children.length} ítems`;
}

/**
 * Pinta una fila de la tabla y vincula handlers (si no es modo portal).
 */
function renderRow(mov) {
  const tr = document.createElement('tr');

  const rev1 = mov.rev1 || {};
  const rev2 = mov.rev2 || {};
  const estadoGeneral = mov.estadoGeneral || computeEstadoGeneral(rev1, rev2);
  const pagable = mov.pagable === true;
  const puedePagar = pagable && !mov.pagado;

  tr.innerHTML = `
    <td>
      <b>${(mov.tipo || '').toUpperCase()}</b>
      <span class="small muted">${mov.moneda || 'CLP'}</span>
    </td>
    <td>
      <div><b>${mov.grupoNombre || '-'}</b></div>
      <div class="small mono">${mov.grupoId || '-'}</div>
    </td>
    <td>
      <div>${mov.coordinadorEmail || '-'}</div>
      <div class="small muted">${dmy(mov.fecha)}</div>
    </td>
    <td>
      <div>${money(mov.monto, mov.moneda)}</div>
      ${mov.comprobanteURL ? `<a class="small" target="_blank" rel="noopener" href="${mov.comprobanteURL}">ver comprobante</a>` : '<span class="small muted">sin comprobante</span>'}
    </td>

    <td>
      <div class="rev-grid">
        <select class="rev1-status">
          <option value="pendiente">Pendiente</option>
          <option value="aprobado">Aprobado</option>
          <option value="rechazado">Rechazado</option>
        </select>
        <input class="rev1-by" type="email" placeholder="email revisor 1" />
        <input class="rev1-nota" type="text" placeholder="nota (opcional)" />
        <button class="go rev1-guardar only-admin" title="Guardar revisión 1">✓</button>
      </div>
      <div class="small muted">últ.: ${rev1.at ? dmy(rev1.at) : '-'}</div>
    </td>

    <td>
      <div class="rev-grid">
        <select class="rev2-status">
          <option value="pendiente">Pendiente</option>
          <option value="aprobado">Aprobado</option>
          <option value="rechazado">Rechazado</option>
        </select>
        <input class="rev2-by" type="email" placeholder="email revisor 2" />
        <input class="rev2-nota" type="text" placeholder="nota (opcional)" />
        <button class="go rev2-guardar only-admin" title="Guardar revisión 2">✓</button>
      </div>
      <div class="small muted">últ.: ${rev2.at ? dmy(rev2.at) : '-'}</div>
    </td>

    <td class="estado-cell">
      ${badgeEstado(estadoGeneral)}
    </td>

    <td>
      <div class="actions">
        <button class="pay only-admin" ${puedePagar ? '' : 'disabled'}>Pagar</button>
        <span class="small ${mov.pagado ? '' : 'muted'}">
          ${mov.pagado ? `Pagado ${dmy(mov.pagadoAt)} por ${(mov.pagadoBy||'')}` : 'Pendiente de pago'}
        </span>
      </div>
    </td>
  `;

  // Prefill valores actuales
  tr.querySelector('.rev1-status').value = rev1.status || 'pendiente';
  tr.querySelector('.rev2-status').value = rev2.status || 'pendiente';
  tr.querySelector('.rev1-by').value     = rev1.by || currentUserEmail || '';
  tr.querySelector('.rev2-by').value     = rev2.by || '';
  if (rev1.nota) tr.querySelector('.rev1-nota').value = rev1.nota;
  if (rev2.nota) tr.querySelector('.rev2-nota').value = rev2.nota;

  // Modo portal → solo lectura
  const isReadonly = ($root?.dataset.mode === 'portal');
  if (isReadonly) {
    tr.querySelectorAll('.rev1-status, .rev1-by, .rev1-nota, .rev1-guardar, .rev2-status, .rev2-by, .rev2-nota, .rev2-guardar, .actions button')
      .forEach(el => { el.classList.add('is-readonly'); el.disabled = true; });
  } else {
    bindRowEvents(tr, mov);
  }
  return tr;
}

function badgeEstado(est) {
  const cls = `badge ${est || 'pendiente'}`;
  return `<span class="${cls}">${(est || 'pendiente').toUpperCase()}</span>`;
}

// ----------------------------------------------------------------------
// 4) Handlers de fila (guardar revisiones + pagar)
// ----------------------------------------------------------------------

function bindRowEvents(tr, mov) {
  const estCell = tr.querySelector('.estado-cell');
  const payBtn  = tr.querySelector('.actions .pay');

  const saveRev = async (slot) => {
    const status = tr.querySelector(`.rev${slot}-status`).value;
    const by     = tr.querySelector(`.rev${slot}-by`).value.trim() || currentUserEmail || '';
    const nota   = tr.querySelector(`.rev${slot}-nota`).value.trim();

    await setRevision(mov.id, slot, { status, by, nota });

    // Refresco: leemos el doc para asegurar coherencia UI
    const ref  = doc(db, ACTIVE_COLLECTION, mov.id);
    const snap = await getDoc(ref);
    const d    = mapDoc(snap.data(), mov.id);

    estCell.innerHTML = badgeEstado(d.estadoGeneral || 'pendiente');
    const puedePagar = d.pagable && !d.pagado;
    payBtn.disabled  = !puedePagar;

    // Actualiza notas (por si otra persona editó)
    if (slot === 1) tr.querySelector('.rev1-nota').value = d.rev1?.nota || '';
    if (slot === 2) tr.querySelector('.rev2-nota').value = d.rev2?.nota || '';
  };

  tr.querySelector('.rev1-guardar').addEventListener('click', () => saveRev(1));
  tr.querySelector('.rev2-guardar').addEventListener('click', () => saveRev(2));

  payBtn.addEventListener('click', async () => {
    // Relee doc para check de gating (evita pagar si no corresponde)
    const ref  = doc(db, ACTIVE_COLLECTION, mov.id);
    const snap = await getDoc(ref);
    const d    = mapDoc(snap.data(), mov.id);

    if (!(d.pagable === true && !d.pagado && d.estadoGeneral === 'aprobado')) {
      alert('Este ítem no es pagable aún.');
      return;
    }
    if (!confirm(`¿Confirmar pago de ${money(d.monto, d.moneda)}?`)) return;

    await updateDoc(ref, {
      pagado: true,
      pagadoAt: serverTimestamp(),
      pagadoBy: currentUserEmail || null
    });

    payBtn.disabled = true;
  });
}

/**
 * Guarda una revisión (slot 1 o 2) y recalcula estado/pagable.
 */
async function setRevision(movId, slot, { status, by, nota }) {
  const field = slot === 1 ? 'rev1' : 'rev2';
  const ref   = doc(db, ACTIVE_COLLECTION, movId);

  // 1) Actualiza el slot de revisión
  await updateDoc(ref, {
    [field]: {
      status: status || 'pendiente',
      by: by || null,
      at: serverTimestamp(),
      nota: (nota || '').slice(0, 240)
    }
  });

  // 2) Relee y recalcula estado/pagable
  const snap = await getDoc(ref);
  const d    = snap.data() || {};
  const estadoGeneral = computeEstadoGeneral(d.rev1, d.rev2);
  const pagable       = (estadoGeneral === 'aprobado');

  await updateDoc(ref, { estadoGeneral, pagable });
}

// ----------------------------------------------------------------------
// 5) UI: tabs, filtros y paginación
// ----------------------------------------------------------------------
$stateTabs?.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-estado]');
  if (!btn) return;
  $stateTabs.querySelectorAll('button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentEstadoTab = btn.dataset.estado || '';
  loadPage({ reset:true }).catch(console.error);
});

$btnAplicar?.addEventListener('click', () => loadPage({ reset:true }).catch(console.error));
$btnRecarga?.addEventListener('click',  () => loadPage({ reset:true }).catch(console.error));
$btnMas?.addEventListener('click',      () => loadPage({ reset:false }).catch(console.error));

// ----------------------------------------------------------------------
// 6) Arranque con sesión (solo para tomar email actual y mostrar algo)
// ----------------------------------------------------------------------
onAuthStateChanged(auth, async (user) => {
  currentUserEmail = user?.email || '';
  currentEstadoTab = ''; // “Todos” por defecto
  try {
    await loadPage({ reset:true });
  } catch (e) {
    console.error('❌ Error cargando revisión financiera:', e);
    if ($pagInfo) $pagInfo.textContent = 'No se pudo cargar datos. Revisa la consola.';
  }
});
