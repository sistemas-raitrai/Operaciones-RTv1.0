// hoteles.js - Gestión de Hoteles y Asignación de Grupos
import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs, doc, getDoc,
  addDoc, updateDoc, deleteDoc,
  serverTimestamp, query, orderBy
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

let grupos = [], hoteles = [];
let isEdit = false, editId = null;
let choiceGrupos, currentUserEmail, dtHist = null;

/** Convierte texto a mayúsculas si es cadena */
function toUpper(x) { return (typeof x === 'string') ? x.toUpperCase() : x; }

/** Filtra tarjetas de hotel según búsqueda */
function filterHoteles(rawQuery) {
  const terms = rawQuery.toLowerCase().split(',').map(t=>t.trim()).filter(Boolean);
  document.querySelectorAll('.hotel-card').forEach(card => {
    const text = card.textContent.toLowerCase();
    const match = terms.length === 0 || terms.some(term => text.includes(term));
    card.style.display = match ? '' : 'none';
  });
}

/** Rellena tablas auxiliares con hotel / dirección / capacidad */
function renderHotelsList() {
  const tables = document.querySelectorAll('.hotels-list');
  if (!tables.length) return;
  const perColumn = Math.ceil(hoteles.length / tables.length);
  const searchEl = document.getElementById('search-input');
  tables.forEach((table, colIdx) => {
    const tbody = table.querySelector('tbody'); tbody.innerHTML = '';
    const start = colIdx * perColumn, end = start + perColumn;
    hoteles.slice(start, end).forEach(h => {
      const tr = document.createElement('tr');
      tr.style.cursor = 'pointer';
      tr.innerHTML = `
        <td>${toUpper(h.nombre)}</td>
        <td>${toUpper(h.direccion)}</td>
        <td>${h.capacidad}</td>
      `;
      tr.onclick = () => {
        searchEl.value = h.nombre;
        filterHoteles(h.nombre.toLowerCase());
        document.querySelector(`.hotel-card[data-id="${h.id}"]`)?.scrollIntoView({behavior:'smooth',block:'start'});
      };
      tbody.appendChild(tr);
    });
  });
}

// Autenticación y arranque
const auth = getAuth(app);
onAuthStateChanged(auth, user => {
  if (!user) return location.href = 'login.html';
  currentUserEmail = user.email;
  init();
});

/** Inicialización: carga datos y configura UI */
async function init() {
  await loadGrupos();
  bindUI();
  initModal();
  await renderHoteles();
  document.getElementById('btnExportExcel').onclick = exportToExcel;
  document.getElementById('hist-refresh').onclick = loadHistorial;
  document.getElementById('btnAddHotel').onclick = () => openModal();
  document.getElementById('hist-close').onclick  = closeHistorialModal;
}

/** Carga la lista de grupos para los selects */
async function loadGrupos() {
  const snap = await getDocs(collection(db, 'grupos'));
  grupos = snap.docs.map(d=>({ id:d.id, ...d.data() }));
}

/** Botones de búsqueda y tablas */
function bindUI() {
  document.getElementById('search-input').oninput = e => filterHoteles(e.target.value);
}

/** Configura modal de hotel y Choices.js para grupos */
function initModal() {
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('modal-form').onsubmit  = onSubmitHotel;

  choiceGrupos = new Choices(document.getElementById('m-grupos'), { removeItemButton:true });
  choiceGrupos.setChoices(
    grupos.map(g=>({ value:g.id, label: toUpper(`${g.numeroNegocio} – ${g.nombreGrupo}`) })),
    'value','label', false
  );
}

/** Renderiza las tarjetas de hotel con datos y grupos asignados */
async function renderHoteles() {
  const cont = document.getElementById('hoteles-container'); cont.innerHTML = '';
  const snap = await getDocs(collection(db, 'hoteles'));
  hoteles = snap.docs.map(d=>({ id:d.id, ...d.data() }));

  hoteles.forEach(h => {
    const totalGr = (h.grupos||[]).length;
    const confGr  = (h.grupos||[]).filter(g=>g.status==='confirmado').length;

    const card = document.createElement('div');
    card.className = 'hotel-card';
    card.dataset.id = h.id;
    card.innerHTML = `
      <h3>${toUpper(h.nombre)}</h3>
      <p>${toUpper(h.direccion)}</p>
      <p>Capacidad: ${h.capacidad} — Grupos: ${totalGr} (${confGr} confirmados)</p>
      <div class="actions">
        <button class="btn-edit">✏️ EDITAR</button>
        <button class="btn-del">🗑️ ELIMINAR</button>
      </div>
    `;
    card.querySelector('.btn-edit').onclick = () => openModal(h);
    card.querySelector('.btn-del').onclick  = () => deleteHotel(h.id);
    cont.appendChild(card);
  });
  renderHotelsList();
}

/** Abre modal para nuevo/editar hotel */
function openModal(h=null) {
  isEdit = !!h; editId = h?.id || null;
  document.getElementById('modal-title').textContent = h ? 'EDITAR HOTEL' : 'NUEVO HOTEL';
  ['nombre','direccion','capacidad','fechaInicio','fechaFin']
    .forEach(k => document.getElementById(`m-${k}`).value = h?.[k] || '');
  document.getElementById('m-statusDefault').value = h?.grupos?.[0]?.status || 'confirmado';
  choiceGrupos.removeActiveItems();
  if (h?.grupos) choiceGrupos.setChoiceByValue(h.grupos.map(g=>g.id));
  document.getElementById('modal-backdrop').style.display = 'block';
  document.getElementById('modal-hotel').style.display = 'block';
}

/** Cierra el modal */
function closeModal() {
  document.getElementById('modal-backdrop').style.display = 'none';
  document.getElementById('modal-hotel').style.display = 'none';
}

/** Guarda o actualiza hotel en Firestore */
async function onSubmitHotel(evt) {
  evt.preventDefault();
  const sel = choiceGrupos.getValue(true);
  const defaultStatus = document.getElementById('m-statusDefault').value;
  const gruposArr = sel.map(id=>({ id, status: defaultStatus, changedBy: currentUserEmail }));
  const payload = {
    nombre:      toUpper(document.getElementById('m-nombre').value.trim()),
    direccion:   toUpper(document.getElementById('m-direccion').value.trim()),
    capacidad:   +document.getElementById('m-capacidad').value || 0,
    fechaInicio: document.getElementById('m-fechaInicio').value,
    fechaFin:    document.getElementById('m-fechaFin').value,
    grupos:      gruposArr
  };

  if (isEdit) {
    const before = (await getDoc(doc(db,'hoteles',editId))).data();
    await updateDoc(doc(db,'hoteles',editId), payload);
    await addDoc(collection(db,'historial'), { tipo:'hotel-edit', hotelId:editId, antes:before, despues:payload, usuario:currentUserEmail, ts:serverTimestamp() });
  } else {
    const ref = await addDoc(collection(db,'hoteles'), payload);
    await addDoc(collection(db,'historial'), { tipo:'hotel-new', hotelId:ref.id, antes: null, despues: payload, usuario:currentUserEmail, ts:serverTimestamp() });
  }
  closeModal(); renderHoteles();
}

/** Elimina un hotel */
async function deleteHotel(id) {
  if (!confirm('¿Eliminar hotel?')) return;
  const before = (await getDoc(doc(db,'hoteles',id))).data();
  await deleteDoc(doc(db,'hoteles',id));
  await addDoc(collection(db,'historial'), { tipo:'hotel-del', hotelId:id, antes:before, despues:null, usuario:currentUserEmail, ts:serverTimestamp() });
  renderHoteles();
}

/** Historial */
function showHistorialModal() {
  document.getElementById('hist-backdrop').style.display = 'block';
  document.getElementById('hist-modal').style.display = 'block';
  loadHistorial();
}
function closeHistorialModal() {
  document.getElementById('hist-backdrop').style.display = 'none';
  document.getElementById('hist-modal').style.display = 'none';
}
async function loadHistorial() {
  const tbody = document.querySelector('#hist-table tbody'); tbody.innerHTML = '';
  const start = document.getElementById('hist-start').value;
  const end   = document.getElementById('hist-end').value;
  const snap  = await getDocs(query(collection(db,'historial'), orderBy('ts','desc')));
  snap.docs.forEach(dSnap => {
    const d = dSnap.data(), ts = d.ts?.toDate?.();
    if (start && ts < new Date(start+'T00:00:00')) return;
    if (end   && ts > new Date(end+'T23:59:59')) return;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${ts?ts.toLocaleString('es-CL'):''}</td>
      <td>${d.usuario||''}</td>
      <td>${d.hotelId||''}</td>
      <td>${d.tipo||''}</td>
      <td>${d.antes?JSON.stringify(d.antes):''}</td>
      <td>${d.despues?JSON.stringify(d.despues):''}</td>
    `;
    tbody.appendChild(tr);
  });
}

/** Exportar a Excel */
function exportToExcel() {
  const resumen = hoteles.map(h => ({
    Nombre: h.nombre,
    Direccion: h.direccion,
    Capacidad: h.capacidad,
    GruposTotales: (h.grupos||[]).length,
    Confirmados: (h.grupos||[]).filter(g=>g.status==='confirmado').length
  }));

  const detalle = [];
  hoteles.forEach(h => {
    (h.grupos||[]).forEach(gObj => {
      const g = grupos.find(x=>x.id===gObj.id) || {};
      detalle.push({
        Hotel: h.nombre,
        GrupoNum: g.numeroNegocio,
        GrupoNom: g.nombreGrupo,
        Estado: gObj.status,
        CambiadoPor: gObj.changedBy
      });
    });
  });

  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.json_to_sheet(resumen);
  const ws2 = XLSX.utils.json_to_sheet(detalle);
  XLSX.utils.book_append_sheet(wb, ws1, 'Resumen_Hoteles');
  XLSX.utils.book_append_sheet(wb, ws2, 'Detalle_Hoteles');
  XLSX.writeFile(wb, 'hoteles_asignacion.xlsx');
}

// Cerrar modales al hacer click fuera
document.body.addEventListener('click', e => {
  if (e.target.classList.contains('modal-backdrop')) {
    e.target.style.display = 'none';
    document.querySelector('.modal[style*="display: block"]')?.style.display = 'none';
  }
}, true);
