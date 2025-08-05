// hoteles.js – Distribución Hotelera (versión mejorada)

import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection,
  getDocs,
  doc,
  getDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  query,
  orderBy
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

let hoteles = [];
let grupos   = [];
let isEdit   = false;
let editId   = null;
let currentUserEmail = null;
let choiceGrupos     = null;

/** ——— UTILITARIOS ——— **/
const toUpper = x => typeof x === 'string' ? x.toUpperCase() : x;

/**
 * Formatea una fecha ISO (YYYY-MM-DD) a
 * "Lunes 15 de septiembre de 2025"
 */
function fmtFecha(iso) {
  const dt = new Date(iso + 'T00:00:00');
  return dt.toLocaleDateString('es-CL', {
    weekday: 'long',
    day:     '2-digit',
    month:   'long',
    year:    'numeric'
  }).replace(/^\w/, c => c.toUpperCase());
}

/** ——— INICIALIZACIÓN ——— **/
const auth = getAuth(app);
onAuthStateChanged(auth, user => {
  if (!user) {
    return location.href = 'login.html';
  }
  currentUserEmail = user.email;
  init();
});

async function init() {
  await loadGrupos();
  initUI();
  initModal();
  await renderHoteles();
  hideAllModals();
}

/** Carga todos los grupos disponibles para el selector */
async function loadGrupos() {
  const snap = await getDocs(collection(db, 'grupos'));
  grupos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/** Conecta los controles de la UI principal */
function initUI() {
  // Buscador
  document.getElementById('search-input')
    .addEventListener('input', e => filterHoteles(e.target.value));

  // Botones principales
  document.getElementById('btnAddHotel')
    .addEventListener('click', () => openHotelModal(null));
  document.getElementById('btnHistorial')
    .addEventListener('click', showHistorialModal);
  document.getElementById('btnExportExcel')
    .addEventListener('click', exportToExcel);

  // Cerrar modales
  document.getElementById('hist-close')
    .addEventListener('click', closeHistorialModal);
  document.getElementById('occ-close')
    .addEventListener('click', closeOccupancyModal);

  // Clic en backdrop cierra modales
  document.body.addEventListener('click', e => {
    if (e.target.classList.contains('modal-backdrop')) {
      hideAllModals();
    }
  }, true);
}

/** Oculta todos los modales */
function hideAllModals() {
  document.querySelectorAll('.modal-backdrop').forEach(b => b.style.display = 'none');
  document.querySelectorAll('.modal').forEach(m => m.style.display = 'none');
}

/** ——— MODAL HOTEL (crear/editar/asignar) ——— **/
function initModal() {
  // Choices.js para selección de grupos
  choiceGrupos = new Choices(
    document.getElementById('m-grupos'),
    { removeItemButton: true }
  );

  // Cancelar
  document.getElementById('modal-cancel')
    .addEventListener('click', closeHotelModal);

  // Guardar
  document.getElementById('modal-form')
    .addEventListener('submit', onSubmitHotel);
}

/**
 * Abre el modal de hotel.
 * Si `h` es null, abre en modo 'crear'.
 * Si `h` es un objeto hotel, abre en modo 'editar/asignar'.
 */
function openHotelModal(h) {
  isEdit = !!h;
  editId = h?.id ?? null;

  // Título del modal
  document.getElementById('modal-title').textContent =
    isEdit ? `ASIGNAR GRUPOS — ${toUpper(h.nombre)}` : 'NUEVO HOTEL';

  // Campos del formulario
  const fields = ['nombre','fechaInicio','fechaFin','singles','dobles','triples','cuadruples'];
  fields.forEach(key => {
    document.getElementById(`m-${key}`).value = h?.[key] ?? '';
  });

  // Status default para grupos
  document.getElementById('m-statusDefault').value =
    h?.grupos?.[0]?.status ?? 'confirmado';

  // Precarga grupos asignados
  choiceGrupos.removeActiveItems();
  if (Array.isArray(h?.grupos)) {
    choiceGrupos.setChoiceByValue(h.grupos.map(g => g.id));
  }

  // Muestra modal
  document.getElementById('modal-backdrop').style.display = 'block';
  document.getElementById('modal-hotel').style.display   = 'block';
}

function closeHotelModal() {
  document.getElementById('modal-backdrop').style.display = 'none';
  document.getElementById('modal-hotel').style.display   = 'none';
}

/** Maneja Crear o Editar hotel */
async function onSubmitHotel(evt) {
  evt.preventDefault();

  // Construye payload básico
  const payload = {
    nombre:      toUpper(document.getElementById('m-nombre').value.trim()),
    fechaInicio: document.getElementById('m-fechaInicio').value,
    fechaFin:    document.getElementById('m-fechaFin').value,
    singles:   +document.getElementById('m-singles').value || 0,
    dobles:    +document.getElementById('m-dobles').value  || 0,
    triples:   +document.getElementById('m-triples').value || 0,
    cuadruples:+document.getElementById('m-cuadruples').value||0
  };

  // Asignación de grupos
  const selectedIds = choiceGrupos.getValue(true);
  const defaultStatus = document.getElementById('m-statusDefault').value;
  payload.grupos = selectedIds.map(id => ({
    id,
    status:   defaultStatus,
    changedBy: currentUserEmail
  }));

  if (isEdit) {
    // Editar existente
    const beforeSnap = await getDoc(doc(db,'hoteles',editId));
    const beforeData = beforeSnap.data();
    await updateDoc(doc(db,'hoteles',editId), payload);
    await addDoc(collection(db,'historial'), {
      tipo: 'hotel-edit',
      hotelId: editId,
      antes:  beforeData,
      despues: payload,
      usuario: currentUserEmail,
      ts:     serverTimestamp()
    });
  } else {
    // Nuevo hotel
    const ref = await addDoc(collection(db,'hoteles'), payload);
    await addDoc(collection(db,'historial'), {
      tipo: 'hotel-new',
      hotelId: ref.id,
      antes:  null,
      despues: payload,
      usuario: currentUserEmail,
      ts:     serverTimestamp()
    });
  }

  closeHotelModal();
  await renderHoteles();
}

/** ——— RENDER DE TARJETAS DE HOTEL ——— **/
async function renderHoteles() {
  const cont = document.getElementById('hoteles-container');
  cont.innerHTML = '';

  // Trae todos los hoteles
  const snap = await getDocs(collection(db,'hoteles'));
  hoteles = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  hoteles.forEach(h => {
    const card = document.createElement('div');
    card.className = 'hotel-card';
    card.dataset.id = h.id;

    // Encabezado rojo con rango de fechas
    const header = `
      <div class="encabezado-rojo">
        ${toUpper(h.nombre)} —
        ${fmtFecha(h.fechaInicio)} → ${fmtFecha(h.fechaFin)}
      </div>`;

    // Listado de grupos asignados (opcional)
    const gruposHtml = (h.grupos || []).map((gObj, idx) => {
      const grp = grupos.find(x => x.id === gObj.id) || {};
      const A = +grp.adultos || 0;
      const E = +grp.estudiantes || 0;
      const C = +grp.coordinadores || 0;
      const total = A + E + C;
      return `
        <div class="group-item">
          <div style="width:4em; font-weight:bold;">
            ${toUpper(grp.numeroNegocio)}
          </div>
          <div style="flex:1;">
            <div>${total} (A:${A} E:${E} C:${C})</div>
            <div style="font-size:.9em; color:#555;">
              ${fmtFecha(grp.fechaInicio)} → ${fmtFecha(grp.fechaFin)}
            </div>
          </div>
          <div class="status-cell">
            ${gObj.status==='confirmado' ? '✅ CONFIRMADO' : '🕗 PENDIENTE'}
          </div>
          <div style="display:flex; gap:.3em;">
            <button class="btn-small"
                    onclick="openHotelModal(${JSON.stringify(h)})">
              ✏️
            </button>
            <button class="btn-small"
                    onclick="removeGroup('${h.id}',${idx})">
              🗑️
            </button>
            <button class="btn-small"
                    onclick="swapGroup('${h.id}',${idx})">
              🔄
            </button>
          </div>
        </div>`;
    }).join('');

    // Botones de acción bajo la lista
    const actions = `
      <div style="margin-top:.7em;">
        <button class="btn-small"
                onclick="openHotelModal(${JSON.stringify(h)})">
          ✏️ ASIGNAR GRUPOS
        </button>
        <button class="btn-small"
                onclick="deleteHotel('${h.id}')">
          🗑️ ELIMINAR
        </button>
        <button class="btn-small"
                onclick="openOccupancyModal('${h.id}')">
          📊 OCUPACIÓN
        </button>
      </div>`;

    card.innerHTML = header + gruposHtml + actions;
    cont.appendChild(card);
  });

  // Reaplica filtro
  filterHoteles(document.getElementById('search-input').value);
}

/** ——— ELIMINAR HOTEL ——— **/
async function deleteHotel(id) {
  if (!confirm('¿Eliminar hotel?')) return;
  const snap = await getDoc(doc(db,'hoteles',id));
  const before = snap.data();
  await deleteDoc(doc(db,'hoteles',id));
  await addDoc(collection(db,'historial'), {
    tipo: 'hotel-del',
    hotelId: id,
    antes: before,
    despues: null,
    usuario: currentUserEmail,
    ts: serverTimestamp()
  });
  await renderHoteles();
}

/** ——— QUITAR GRUPO DE HOTEL ——— **/
window.removeGroup = async (hotelId, idx) => {
  const ref = doc(db,'hoteles',hotelId);
  const snap = await getDoc(ref);
  const data = snap.data();
  const before = data.grupos[idx];
  data.grupos.splice(idx,1);
  await updateDoc(ref, { grupos: data.grupos });
  await addDoc(collection(db,'historial'), {
    tipo: 'hotel-grupo-del',
    hotelId,
    antes: before,
    despues: null,
    usuario: currentUserEmail,
    ts: serverTimestamp()
  });
  await renderHoteles();
};

/** ——— INTERCAMBIAR GRUPO ——— **/
window.swapGroup = (hotelId, idx) => {
  // Debes implementar o enlazar aquí tu función de intercambio
  // por ejemplo: window.openSwapModal(hotelId, idx);
  console.warn('swapGroup: implementar modal de intercambio');
};

/** ——— HISTORIAL ——— **/
window.showHistorialModal = () => {
  document.getElementById('hist-backdrop').style.display = 'block';
  document.getElementById('hist-modal').style.display     = 'block';
  loadHistorial();
};
window.closeHistorialModal = () => {
  document.getElementById('hist-backdrop').style.display = 'none';
  document.getElementById('hist-modal').style.display     = 'none';
};
async function loadHistorial() {
  const tbody = document.querySelector('#hist-table tbody');
  tbody.innerHTML = '';
  const start = document.getElementById('hist-start').value;
  const end   = document.getElementById('hist-end').value;
  const qSnap = await getDocs(query(collection(db,'historial'), orderBy('ts','desc')));
  qSnap.docs.forEach(dSnap => {
    const d = dSnap.data(), ts = d.ts?.toDate();
    if (start && ts < new Date(start+'T00:00:00')) return;
    if (end   && ts > new Date(end+'T23:59:59')) return;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${ts?ts.toLocaleString('es-CL'):''}</td>
      <td>${d.usuario||''}</td>
      <td>${d.hotelId||''}</td>
      <td>${d.tipo||''}</td>
      <td>${d.antes?JSON.stringify(d.antes):''}</td>
      <td>${d.despues?JSON.stringify(d.despues):''}</td>`;
    tbody.appendChild(tr);
  });
}

/** ——— OCUPACIÓN DIARIA ——— **/
window.openOccupancyModal = async hotelId => {
  const snap = await getDoc(doc(db,'hoteles',hotelId));
  const h    = { id: snap.id, ...snap.data() };

  // Header
  document.getElementById('occ-header').innerHTML = `
    <strong>${h.nombre}</strong><br>
    ${fmtFecha(h.fechaInicio)} → ${fmtFecha(h.fechaFin)}
  `;

  // Generar días
  const start = new Date(h.fechaInicio);
  const end   = new Date(h.fechaFin);
  const days  = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate()+1)) {
    days.push(new Date(d));
  }

  // Construir tabla
  const tbl = document.getElementById('occ-table');
  tbl.innerHTML = `
    <thead>
      <tr><th>Fecha</th><th>Grupos</th><th>Pax</th></tr>
    </thead>
    <tbody>
      ${days.map(d => {
        const iso = d.toISOString().slice(0,10);
        const arr = (h.grupos||[]).filter(g => {
          const grp = grupos.find(x=>x.id===g.id) || {};
          return grp.fechaInicio <= iso && iso < grp.fechaFin;
        });
        const numG = arr.length;
        const totalPax = arr.reduce((sum, gObj) => {
          const grp = grupos.find(x=>x.id===gObj.id) || {};
          return sum + ((+grp.adultos||0) + (+grp.estudiantes||0) + (+grp.coordinadores||0));
        }, 0);
        return `
          <tr>
            <td>${iso}</td>
            <td>${numG}</td>
            <td>${totalPax}</td>
          </tr>`;
      }).join('')}
    </tbody>`;

  document.getElementById('occ-backdrop').style.display    = 'block';
  document.getElementById('modal-occupancy').style.display = 'block';
};

window.closeOccupancyModal = () => {
  document.getElementById('occ-backdrop').style.display    = 'none';
  document.getElementById('modal-occupancy').style.display = 'none';
};

/** ——— EXPORTAR A EXCEL ——— **/
function exportToExcel() {
  const resumen = hoteles.map(h => ({
    Nombre:     h.nombre,
    Desde:      h.fechaInicio,
    Hasta:      h.fechaFin,
    Singles:    h.singles,
    Dobles:     h.dobles,
    Triples:    h.triples,
    Cuádruples: h.cuadruples,
    Grupos:     (h.grupos||[]).length
  }));

  const detalle = [];
  hoteles.forEach(h => {
    (h.grupos||[]).forEach(gObj => {
      const grp = grupos.find(x=>x.id===gObj.id) || {};
      detalle.push({
        Hotel:   h.nombre,
        Grupo:   grp.numeroNegocio,
        CheckIn: grp.fechaInicio,
        CheckOut:grp.fechaFin,
        Estado:  gObj.status
      });
    });
  });

  const wb  = XLSX.utils.book_new();
  const ws1 = XLSX.utils.json_to_sheet(resumen);
  const ws2 = XLSX.utils.json_to_sheet(detalle);
  XLSX.utils.book_append_sheet(wb, ws1, 'Resumen_Hoteles');
  XLSX.utils.book_append_sheet(wb, ws2, 'Detalle_Grupos');
  XLSX.writeFile(wb, 'distribucion_hotelera.xlsx');
}
