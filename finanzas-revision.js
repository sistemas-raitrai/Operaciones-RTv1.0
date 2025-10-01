// finanzas-revision.js — Revisión financiera (v2)
// Doble auditoría + pagables, autodetección de colección mejorada, override por ?col y localStorage, y util de diagnóstico.

import { app, db } from './firebase-init.js';
import {
  getAuth, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, query, where, orderBy, limit, startAfter,
  getDocs, getDoc, doc, updateDoc, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

/* ===================== DOM / Estado ===================== */
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
let lastDocSnap      = null;

/* =========================================================
   1) Colección activa (autodetección + override)
   ========================================================= */

// ⚙️ Puedes pasar ?col=nombreColeccion para forzar en tiempo de ejecución
const QS_OVERRIDE_COLLECTION = (qs.get('col') || '').trim();

// ⚙️ Guardamos/Leemos override persistente
const LS_KEY_COLLECTION = 'rt_finanzas_collection';
const LS_OVERRIDE_COLLECTION = (localStorage.getItem(LS_KEY_COLLECTION) || '').trim();

// Lista ampliada de posibles nombres (agregué plurales/alias comunes)
const CANDIDATE_COLLECTIONS = [
  // overrides primero
  QS_OVERRIDE_COLLECTION,
  LS_OVERRIDE_COLLECTION,

  // candidatos frecuentes
  'finanzasMovimientos',
  'movimientos',
  'finanzas',
  'situacionFinanciera',
  'situacionesFinancieras',
  'situacionFinanzas',
  'gastosAbonos',
  'gastoAbono',
  'gastos',
  'abonos',
  'movFinanzas',
  'movimientosFinancieros',
  'movsFinanzas',
  'finanzas_movimientos'
].filter(Boolean); // quita vacíos

let ACTIVE_COLLECTION = null;

/**
 * Intenta leer 1 doc de una colección; si existe, la fija como activa.
 */
async function autoDetectCollection() {
  if (ACTIVE_COLLECTION) return ACTIVE_COLLECTION;

  // Si forzaste por querystring, úsalo directo y si falla, mostramos mensaje claro.
  if (QS_OVERRIDE_COLLECTION) {
    const snap = await getDocs(query(collection(db, QS_OVERRIDE_COLLECTION), limit(1)));
    if (!snap.empty) {
      ACTIVE_COLLECTION = QS_OVERRIDE_COLLECTION;
      console.log('✅ Colección activa (querystring):', ACTIVE_COLLECTION);
      localStorage.setItem(LS_KEY_COLLECTION, ACTIVE_COLLECTION);
      return ACTIVE_COLLECTION;
    } else {
      throw new Error(`No hay documentos en la colección forzada por ?col=${QS_OVERRIDE_COLLECTION}`);
    }
  }

  // Si hay override en localStorage, probamos primero
  if (LS_OVERRIDE_COLLECTION) {
    try {
      const snap = await getDocs(query(collection(db, LS_OVERRIDE_COLLECTION), limit(1)));
      if (!snap.empty) {
        ACTIVE_COLLECTION = LS_OVERRIDE_COLLECTION;
        console.log('✅ Colección activa (localStorage):', ACTIVE_COLLECTION);
        return ACTIVE_COLLECTION;
      } else {
        console.warn('⚠️ Override en localStorage no tiene datos:', LS_OVERRIDE_COLLECTION);
      }
    } catch (e) {
      console.warn('⚠️ Override en localStorage no válido:', LS_OVERRIDE_COLLECTION, e);
    }
  }

  // Exploramos candidatos
  for (const name of CANDIDATE_COLLECTIONS) {
    try {
      const snap = await getDocs(query(collection(db, name), limit(1)));
      if (!snap.empty) {
        ACTIVE_COLLECTION = name;
        console.log('✅ Colección activa (detectada):', name);
        localStorage.setItem(LS_KEY_COLLECTION, ACTIVE_COLLECTION);
        return name;
      }
    } catch (_) { /* sigue intentando */ }
  }

  // Si no encontramos, pedimos el nombre una única vez y lo persistimos
  const entered = prompt('No se encontró la colección de finanzas. Ingresa el nombre exacto de la colección (como aparece en Firestore):');
  if (entered && entered.trim()) {
    const tryName = entered.trim();
    const snap = await getDocs(query(collection(db, tryName), limit(1)));
    if (!snap.empty) {
      ACTIVE_COLLECTION = tryName;
      localStorage.setItem(LS_KEY_COLLECTION, ACTIVE_COLLECTION);
      console.log('✅ Colección activa (manual):', ACTIVE_COLLECTION);
      return ACTIVE_COLLECTION;
    } else {
      throw new Error(`No hay documentos en la colección "${tryName}". Verifica el nombre en Firestore.`);
    }
  }

  throw new Error('No se encontró colección de finanzas con datos. Revisa el nombre en Firestore o usa ?col=...');
}

/* =========================================================
   2) Normalización de documentos + helpers de UI
   ========================================================= */

function dmy(tsOrIso) {
  if (!tsOrIso) return '';
  try {
    const d = typeof tsOrIso === 'string'
      ? new Date(tsOrIso)
      : (tsOrIso?.toDate ? tsOrIso.toDate() : new Date(tsOrIso));
    return d.toLocaleString('es-CL', { dateStyle:'short', timeStyle:'short' });
  } catch { return String(tsOrIso); }
}

function money(n, curr = 'CLP') {
  if (n == null || n === '') return '-';
  try {
    return Number(n).toLocaleString('es-CL', { style:'currency', currency: curr, maximumFractionDigits:0 });
  } catch { return n; }
}

function computeEstadoGeneral(rev1, rev2) {
  const s1 = rev1?.status || 'pendiente';
  const s2 = rev2?.status || 'pendiente';
  if (s1 === 'aprobado' && s2 === 'aprobado') return 'aprobado';
  if (s1 === 'rechazado' || s2 === 'rechazado') return 'rechazado';
  return 'pendiente';
}

function mapDoc(raw, id) {
  const x = raw || {};

  const tipoRaw   = x.tipo ?? x.Tipo ?? x.concepto ?? x.movimiento ?? '';
  const tipo      = String(tipoRaw).trim();
  const tipoLower = tipo.toLowerCase();

  const monto   = x.monto ?? x.valor ?? x.total ?? null;
  const moneda  = x.moneda ?? x.currency ?? 'CLP';

  const grupoId     = x.grupoId ?? x.idGrupo ?? x.grupo ?? x.numeroNegocio ?? null;
  const grupoNombre = x.grupoNombre ?? x.nombreGrupo ?? x.aliasGrupo ?? '';

  const coordinadorEmail =
    (x.coordinadorEmail ?? x.coordinadorCorreo ?? x.emailCoordinador ?? x.coordinador?.correo ?? '')
      .toString().trim().toLowerCase();

  const fecha = x.fecha ?? x.fechaISO ?? x.fechaMovimiento ?? x.creadoEn ?? x.meta?.creadoEn ?? x.meta?.actualizadoEn ?? null;

  const rev1 = x.rev1 ?? { status:'pendiente', by:null, at:null, nota:'' };
  const rev2 = x.rev2 ?? { status:'pendiente', by:null, at:null, nota:'' };

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

function badgeEstado(est) {
  const cls = `badge ${est || 'pendiente'}`;
  return `<span class="${cls}">${(est || 'pendiente').toUpperCase()}</span>`;
}

/* =========================================================
   3) Query builder (tolerante a variantes) + carga/paginación
   ========================================================= */

function estFromTabsValue(v) { return v; }

function buildQuery({ estado, tipo, coord, grupo, afterSnap } = {}) {
  const col = collection(db, ACTIVE_COLLECTION);
  const clauses = [];

  // tipo con IN (máx 10 elementos)
  if (tipo === 'gasto') {
    clauses.push(where('tipo', 'in', ['gasto','Gasto','GASTO','gastos','Gastos']));
  } else if (tipo === 'abono') {
    clauses.push(where('tipo', 'in', ['abono','Abono','ABONO','abonos','Abonos']));
  }

  if (coord) clauses.push(where('coordinadorEmail', '==', coord));

  if (grupo && /^[A-Za-z0-9_-]+$/.test(grupo.trim())) {
    clauses.push(where('grupoId', '==', grupo.trim()));
  }

  if (estado && estado !== 'pagables') clauses.push(where('estadoGeneral', '==', estado));
  if (estado === 'pagables') {
    clauses.push(where('pagable', '==', true));
    clauses.push(where('pagado', '==', false));
  }

  // orden → intenta por 'fecha', si falla cae a 'meta.actualizadoEn'
  let q;
  try {
    q = query(col, ...clauses, orderBy('fecha','desc'), ...(afterSnap ? [startAfter(afterSnap)] : []), limit(PAGE_SIZE));
  } catch {
    q = query(col, ...clauses, orderBy('meta.actualizadoEn','desc'), ...(afterSnap ? [startAfter(afterSnap)] : []), limit(PAGE_SIZE));
  }
  return q;
}

async function loadPage({ reset = false } = {}) {
  if (!$tbody) return;

  if (reset) {
    $tbody.innerHTML = '';
    lastDocSnap = null;
    if ($pagInfo) $pagInfo.textContent = '';
  }

  await autoDetectCollection();

  const estado = estFromTabsValue(currentEstadoTab);
  const tipo   = ($fTipo?.value || '').toLowerCase();
  const coord  = ($fCoord?.value || '').trim().toLowerCase();
  const grupo  = ($fGrupo?.value || '').trim();

  const q = buildQuery({ estado, tipo, coord, grupo, afterSnap: lastDocSnap });
  const snap = await getDocs(q);

  let rows = snap.docs.map(d => mapDoc(d.data(), d.id));

  // Filtro por nombre de grupo (si el input no parece ID)
  if (grupo && !/^[A-Za-z0-9_-]+$/.test(grupo)) {
    const gnorm = grupo.toLowerCase();
    rows = rows.filter(x => (x.grupoNombre || '').toLowerCase().includes(gnorm));
  }

  for (const mov of rows) $tbody.appendChild(renderRow(mov));

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

/* =========================================================
   4) Render de filas + handlers (revisiones y pago)
   ========================================================= */

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

  tr.querySelector('.rev1-status').value = rev1.status || 'pendiente';
  tr.querySelector('.rev2-status').value = rev2.status || 'pendiente';
  tr.querySelector('.rev1-by').value     = rev1.by || currentUserEmail || '';
  tr.querySelector('.rev2-by').value     = rev2.by || '';
  if (rev1.nota) tr.querySelector('.rev1-nota').value = rev1.nota;
  if (rev2.nota) tr.querySelector('.rev2-nota').value = rev2.nota;

  const isReadonly = ($root?.dataset.mode === 'portal');
  if (isReadonly) {
    tr.querySelectorAll('.rev1-status, .rev1-by, .rev1-nota, .rev1-guardar, .rev2-status, .rev2-by, .rev2-nota, .rev2-guardar, .actions button')
      .forEach(el => { el.classList.add('is-readonly'); el.disabled = true; });
  } else {
    bindRowEvents(tr, mov);
  }
  return tr;
}

function bindRowEvents(tr, mov) {
  const estCell = tr.querySelector('.estado-cell');
  const payBtn  = tr.querySelector('.actions .pay');

  const saveRev = async (slot) => {
    const status = tr.querySelector(`.rev${slot}-status`).value;
    const by     = tr.querySelector(`.rev${slot}-by`).value.trim() || currentUserEmail || '';
    const nota   = tr.querySelector(`.rev${slot}-nota`).value.trim();

    await setRevision(mov.id, slot, { status, by, nota });

    const ref  = doc(db, ACTIVE_COLLECTION, mov.id);
    const snap = await getDoc(ref);
    const d    = mapDoc(snap.data(), mov.id);

    estCell.innerHTML = badgeEstado(d.estadoGeneral || 'pendiente');
    payBtn.disabled  = !(d.pagable && !d.pagado);

    if (slot === 1) tr.querySelector('.rev1-nota').value = d.rev1?.nota || '';
    if (slot === 2) tr.querySelector('.rev2-nota').value = d.rev2?.nota || '';
  };

  tr.querySelector('.rev1-guardar').addEventListener('click', () => saveRev(1));
  tr.querySelector('.rev2-guardar').addEventListener('click', () => saveRev(2));

  payBtn.addEventListener('click', async () => {
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

async function setRevision(movId, slot, { status, by, nota }) {
  const field = slot === 1 ? 'rev1' : 'rev2';
  const ref   = doc(db, ACTIVE_COLLECTION, movId);

  await updateDoc(ref, {
    [field]: {
      status: status || 'pendiente',
      by: by || null,
      at: serverTimestamp(),
      nota: (nota || '').slice(0, 240)
    }
  });

  const snap = await getDoc(ref);
  const d    = snap.data() || {};
  const estadoGeneral = computeEstadoGeneral(d.rev1, d.rev2);
  const pagable       = (estadoGeneral === 'aprobado');

  await updateDoc(ref, { estadoGeneral, pagable });
}

/* =========================================================
   5) Tabs / Filtros / Paginación
   ========================================================= */
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

/* =========================================================
   6) Arranque + util de diagnóstico
   ========================================================= */
onAuthStateChanged(auth, async (user) => {
  currentUserEmail = user?.email || '';
  currentEstadoTab = '';
  try {
    await loadPage({ reset:true });
  } catch (e) {
    console.error('❌ Error cargando revisión financiera:', e);
    if ($pagInfo) $pagInfo.textContent = 'No se pudo cargar datos. Revisa la consola.';
  }
});

// 🔧 Diagnóstico desde consola:
//  - window.__finz.probe('miColeccion') → prueba una colección y lista 5 docs (normalizados)
//  - window.__finz.set('miColeccion')   → guarda override en localStorage y recarga
window.__finz = {
  async probe(name) {
    try {
      const snap = await getDocs(query(collection(db, name), limit(5)));
      if (snap.empty) { console.warn('Colección sin datos:', name); return []; }
      const out = snap.docs.map(d => mapDoc(d.data(), d.id));
      console.table(out.map(o => ({
        id:o.id, tipo:o.tipo, monto:o.monto, coord:o.coordinadorEmail, grupo:o.grupoId, estado:o.estadoGeneral
      })));
      return out;
    } catch (e) {
      console.error('Probe error:', e);
      return [];
    }
  },
  set(name) {
    if (!name) return;
    localStorage.setItem(LS_KEY_COLLECTION, name);
    alert(`Colección fijada en localStorage: ${name}\nRecargando...`);
    location.reload();
  },
  clear() {
    localStorage.removeItem(LS_KEY_COLLECTION);
    alert('Override de colección eliminado. Recargando...');
    location.reload();
  }
};
