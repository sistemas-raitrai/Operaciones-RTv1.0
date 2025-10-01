// finanzas-revision.js — Revisión financiera con doble aprobación y gating de pago
// - Modo 'sistema' (controles activos) vs 'portal' (solo lectura) según querystring ?src=portal
// - Filtros por estado/tipo/coordinador/grupo
// - Render de dos revisiones con email + nota + timestamp
// - Estado general: aprobado / rechazado / pendiente
// - Pagables = estadoGeneral 'aprobado' y pagado === false

import { app, db } from './firebase-init.js';
import {
  getAuth, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, query, where, orderBy, limit, startAfter,
  getDocs, getDoc, doc, updateDoc, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

// ===== DOM refs
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

// ===== Estado de UI/consulta
const qs = new URLSearchParams(location.search);
const fromPortal = qs.get('src') === 'portal';
const prefCoord  = qs.get('coord') || '';
const prefGrupo  = qs.get('grupo') || '';

if (fromPortal) $root.dataset.mode = 'portal';
if (prefCoord)  $fCoord.value = prefCoord;
if (prefGrupo)  $fGrupo.value = prefGrupo;

let currentUserEmail = '';
let currentEstadoTab = ''; // '', 'pendiente', 'aprobado', 'rechazado', 'pagables'

// Paginación
const PAGE_SIZE = 40;
let lastDocSnap = null; // cursor

// ===== Helpers
function money(n) {
  if (n == null) return '-';
  try {
    return Number(n).toLocaleString('es-CL', { style:'currency', currency:'CLP', maximumFractionDigits:0 });
  } catch {
    return n;
  }
}

function dmy(tsOrIso) {
  if (!tsOrIso) return '';
  try {
    const d = typeof tsOrIso === 'string' ? new Date(tsOrIso) : tsOrIso.toDate ? tsOrIso.toDate() : new Date(tsOrIso);
    return d.toLocaleString('es-CL', { dateStyle:'short', timeStyle:'short' });
  } catch {
    return String(tsOrIso);
  }
}

function computeEstadoGeneral(rev1, rev2) {
  const s1 = rev1?.status || 'pendiente';
  const s2 = rev2?.status || 'pendiente';
  if (s1 === 'aprobado' && s2 === 'aprobado') return 'aprobado';
  if (s1 === 'rechazado' || s2 === 'rechazado') return 'rechazado';
  return 'pendiente';
}

function badgeEstado(est) {
  const cls = `badge ${est || 'pendiente'}`;
  return `<span class="${cls}">${(est || 'pendiente').toUpperCase()}</span>`;
}

function estFromTabsValue(val) {
  // mapping: 'pagables' es un pseudo-estado (pagable == true && pagado == false)
  return val; // devolvemos tal cual; tratamos 'pagables' en la query
}

// ====== Firestore query builder
function buildQuery({ estado, tipo, coord, grupo, afterSnap } = {}) {
  const col = collection(db, 'finanzasMovimientos');
  let clauses = [];

  // Filtros de igualdad combinables
  if (tipo)  clauses.push(where('tipo', '==', tipo));
  if (coord) clauses.push(where('coordinadorEmail', '==', coord.trim().toLowerCase()));

  // Grupo puede ser ID exacto o búsqueda por nombre (si exacto)
  // Para mantener simple y con índices: primero probamos por grupoId exacto.
  // Si usuario escribe nombre, recomendamos buscar por ID (o añade un input oculto con ID).
  if (grupo) clauses.push(where('grupoId', '==', grupo.trim()));

  // Estado:
  if (estado && estado !== 'pagables') clauses.push(where('estadoGeneral', '==', estado));
  if (estado === 'pagables') {
    // pagables: requiere doble condición
    clauses.push(where('pagable', '==', true));
    clauses.push(where('pagado', '==', false));
  }

  // Orden
  clauses.push(orderBy('fecha', 'desc'));

  // Base query
  let q = query(col, ...clauses, limit(PAGE_SIZE));
  if (afterSnap) {
    q = query(col, ...clauses, startAfter(afterSnap), limit(PAGE_SIZE));
  }
  return q;
}

// ===== Carga
async function loadPage({ reset = false } = {}) {
  if (reset) { $tbody.innerHTML = ''; lastDocSnap = null; $pagInfo.textContent = ''; }

  const estado = estFromTabsValue(currentEstadoTab);
  const tipo   = $fTipo.value || '';
  const coord  = ($fCoord.value || '').trim().toLowerCase();
  const grupo  = ($fGrupo.value || '').trim();

  const q = buildQuery({ estado, tipo, coord, grupo, afterSnap: lastDocSnap });
  const snap = await getDocs(q);
  const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  // Render
  for (const mov of docs) {
    $tbody.appendChild(renderRow(mov));
  }

  // Paginación
  if (snap.docs.length === PAGE_SIZE) {
    lastDocSnap = snap.docs[snap.docs.length - 1];
    $btnMas.disabled = false;
    $pagInfo.textContent = 'Hay más resultados...';
  } else {
    lastDocSnap = null;
    $btnMas.disabled = true;
    $pagInfo.textContent = docs.length ? 'Fin de resultados.' : 'Sin resultados.';
  }

  // Resumen
  $resumen.textContent = `Mostrando ${$tbody.children.length} ítems`;
}

// ===== Render de fila
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
      <div>${money(mov.monto)}</div>
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
        <span class="small ${mov.pagado ? '' : 'muted'}">${mov.pagado ? `Pagado ${dmy(mov.pagadoAt)} por ${(mov.pagadoBy||'')}` : 'Pendiente de pago'}</span>
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

  // Modo portal → readonly
  const isReadonly = ($root.dataset.mode === 'portal');
  if (isReadonly) {
    tr.querySelectorAll('.rev1-status, .rev1-by, .rev1-nota, .rev1-guardar, .rev2-status, .rev2-by, .rev2-nota, .rev2-guardar, .actions button').forEach(el => {
      el.classList.add('is-readonly');
      el.disabled = true;
    });
  } else {
    // Bind eventos (solo en modo sistema)
    bindRowEvents(tr, mov);
  }
  return tr;
}

// ===== Eventos por fila
function bindRowEvents(tr, mov) {
  const estCell = tr.querySelector('.estado-cell');
  const payBtn  = tr.querySelector('.actions .pay');

  const saveRev = async (slot) => {
    const status = tr.querySelector(`.rev${slot}-status`).value;
    const by     = tr.querySelector(`.rev${slot}-by`).value.trim() || currentUserEmail || '';
    const nota   = tr.querySelector(`.rev${slot}-nota`).value.trim();

    await setRevision(mov.id, slot, { status, by, nota });

    // Refresco parcial: vuelve a leer el doc para actualizar UI
    const ref = doc(db, 'finanzasMovimientos', mov.id);
    const snap = await getDoc(ref);
    const d = snap.data() || {};

    // refresca estado badge / pago
    estCell.innerHTML = badgeEstado(d.estadoGeneral || 'pendiente');

    const pagable = d.pagable === true;
    const puedePagar = pagable && !d.pagado;
    payBtn.disabled = !puedePagar;

    // timestamps
    if (slot === 1) tr.querySelector('.rev1-nota').value = d.rev1?.nota || '';
    if (slot === 2) tr.querySelector('.rev2-nota').value = d.rev2?.nota || '';
  };

  tr.querySelector('.rev1-guardar').addEventListener('click', () => saveRev(1));
  tr.querySelector('.rev2-guardar').addEventListener('click', () => saveRev(2));

  payBtn.addEventListener('click', async () => {
    // Doble seguridad en UI (además de reglas en backend)
    const ref = doc(db, 'finanzasMovimientos', mov.id);
    const snap = await getDoc(ref);
    const d = snap.data() || {};
    if (!(d.pagable === true && !d.pagado && (d.estadoGeneral === 'aprobado'))) {
      alert('Este ítem no es pagable aún.');
      return;
    }
    if (!confirm(`¿Confirmar pago de ${money(d.monto)}?`)) return;

    await updateDoc(ref, {
      pagado: true,
      pagadoAt: serverTimestamp(),
      pagadoBy: currentUserEmail || null
    });

    payBtn.disabled = true;
  });
}

// ===== Guardado de revisión (slot 1 o 2)
async function setRevision(movId, slot, { status, by, nota }) {
  const field = slot === 1 ? 'rev1' : 'rev2';
  const ref   = doc(db, 'finanzasMovimientos', movId);

  // 1) Actualiza el slot
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
  const d = snap.data() || {};
  const estadoGeneral = computeEstadoGeneral(d.rev1, d.rev2);
  const pagable = (estadoGeneral === 'aprobado');

  await updateDoc(ref, { estadoGeneral, pagable });
}

// ===== Tabs estado
$stateTabs.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-estado]');
  if (!btn) return;

  $stateTabs.querySelectorAll('button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentEstadoTab = btn.dataset.estado || '';
  loadPage({ reset:true }).catch(console.error);
});

// ===== Filtros / Recarga / Más
$btnAplicar.addEventListener('click', () => loadPage({ reset:true }).catch(console.error));
$btnRecarga.addEventListener('click',  () => loadPage({ reset:true }).catch(console.error));
$btnMas.addEventListener('click',      () => loadPage({ reset:false }).catch(console.error));

// ===== Auth gate + arranque
onAuthStateChanged(auth, async (user) => {
  // Si tu encabezado ya gestiona redirección, esto puede quedar solo informativo:
  if (!user && !fromPortal) {
    // En sistema principal, si no hay sesión, puedes redirigir al login:
    // location.href = 'login.html'; return;
    console.warn('⚠️ Sin sesión. Vista podría ser limitada.');
  }
  currentUserEmail = user?.email || '';

  // Arranque: por defecto "Todos"
  currentEstadoTab = '';
  await loadPage({ reset:true });
});
