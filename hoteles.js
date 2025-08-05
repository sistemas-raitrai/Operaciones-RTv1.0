// hoteles.js – Gestión de Hoteles, Asignación de Grupos y Ocupación Diaria
import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs, doc, getDoc,
  addDoc, updateDoc, deleteDoc,
  serverTimestamp, query, orderBy
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

let grupos = [], hoteles = [];
let isEdit = false, editId = null;
let choiceGrupos, currentUserEmail;

// Auxiliar: convierte cadenas a MAYÚSCULAS
function toUpper(x) {
  return (typeof x === 'string') ? x.toUpperCase() : x;
}

// FILTRO por nombre
function filterHoteles(raw) {
  const terms = raw.toLowerCase().split(',').map(t=>t.trim()).filter(Boolean);
  document.querySelectorAll('.hotel-card').forEach(card => {
    const txt = card.textContent.toLowerCase();
    card.style.display = (terms.length === 0 || terms.some(t=>txt.includes(t))) ? '' : 'none';
  });
}

// LLENA las tablas auxiliares
function renderHotelsList() {
  const tables = document.querySelectorAll('.hotels-list');
  const perCol = Math.ceil(hoteles.length / tables.length);
  const search = document.getElementById('search-input');
  tables.forEach((tbl, idx) => {
    const body = tbl.querySelector('tbody');
    body.innerHTML = '';
    hoteles.slice(idx*perCol, idx*perCol+perCol).forEach(h => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${toUpper(h.nombre)}</td>
        <td>${toUpper(h.direccion||'—')}</td>
        <td>${h.singles+h.dobles+h.triples+h.cuadruples}</td>
      `;
      tr.style.cursor = 'pointer';
      tr.onclick = () => {
        search.value = h.nombre;
        filterHoteles(h.nombre);
        document
          .querySelector(`.hotel-card[data-id="${h.id}"]`)
          ?.scrollIntoView({behavior:'smooth', block:'start'});
      };
      body.appendChild(tr);
    });
  });
}

// AUTENTICACIÓN
const auth = getAuth(app);
onAuthStateChanged(auth, user => {
  if (!user) return location.href = 'login.html';
  currentUserEmail = user.email;
  init();
});

// INICIALIZACIÓN
async function init() {
  await loadGrupos();
  bindUI();
  initModal();
  await renderHoteles();
  // ocultar modales al arrancar
  closeModal();
  closeHistorialModal();
  closeOccupancyModal();

  document.getElementById('btnExportExcel').onclick = exportToExcel;
  document.getElementById('btnAddHotel').onclick    = () => openHotelModal();
  document.getElementById('hist-refresh').onclick   = loadHistorial;
  document.getElementById('hist-close').onclick     = closeHistorialModal;
  document.getElementById('occ-close').onclick      = closeOccupancyModal;
}

// CARGA grupos para Choices.js
async function loadGrupos() {
  const snap = await getDocs(collection(db,'grupos'));
  grupos = snap.docs.map(d=>({ id:d.id, ...d.data() }));
}

// BIND buscador
function bindUI() {
  document.getElementById('search-input')
    .oninput = e => filterHoteles(e.target.value);
}

// CONFIGURA modal de hotel
function initModal() {
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('modal-form').onsubmit  = onSubmitHotel;

  choiceGrupos = new Choices(
    document.getElementById('m-grupos'),
    { removeItemButton:true }
  );
  choiceGrupos.setChoices(
    grupos.map(g=>({
      value: g.id,
      label: toUpper(`${g.numeroNegocio} – ${g.nombreGrupo}`)
    })),
    'value','label', false
  );
}

// RENDER de tarjetas + botón “Ver Ocupación”
async function renderHoteles() {
  const cont = document.getElementById('hoteles-container');
  cont.innerHTML = '';
  const snap = await getDocs(collection(db,'hoteles'));
  hoteles = snap.docs.map(d=>({ id:d.id, ...d.data() }));

  hoteles.forEach(h => {
    // contador de grupos y confirmados
    const totalGr = (h.grupos||[]).length;
    const confGr  = (h.grupos||[]).filter(g=>g.status==='confirmado').length;
    // capacidad total
    const cap = h.singles+h.dobles+h.triples+h.cuadruples;

    const card = document.createElement('div');
    card.className = 'hotel-card';
    card.dataset.id = h.id;
    card.innerHTML = `
      <h3>${toUpper(h.nombre)}</h3>
      <p>Disponibilidad: ${h.fechaInicio} → ${h.fechaFin}</p>
      <p>Distribución: S:${h.singles} D:${h.dobles}
                   T:${h.triples} C:${h.cuadruples}</p>
      <p>Capacidad total: ${cap}</p>
      <p>Grupos: ${totalGr} (✔️${confGr})</p>
      <div class="actions">
        <button class="btn-edit">✏️ EDITAR</button>
        <button class="btn-del">🗑️ ELIMINAR</button>
        <button class="btn-ocup">📊 OCUPACIÓN</button>
      </div>
    `;
    card.querySelector('.btn-edit')
        .onclick = () => openHotelModal(h);
    card.querySelector('.btn-del')
        .onclick = () => deleteHotel(h.id);
    card.querySelector('.btn-ocup')
        .onclick = () => openOccupancyModal(h);
    cont.appendChild(card);
  });

  renderHotelsList();
}

// ABRIR modal hotel (nuevo/edit)
function openHotelModal(h=null) {
  isEdit = !!h; editId = h?.id || null;
  document.getElementById('modal-title')
          .textContent = h ? 'EDITAR HOTEL' : 'NUEVO HOTEL';
  // rellena campos:
  ['nombre','fechaInicio','fechaFin','singles','dobles','triples','cuadruples']
    .forEach(k => document.getElementById(`m-${k}`).value = h?.[k] ?? '');
  document.getElementById('m-statusDefault').value =
    h?.grupos?.[0]?.status || 'confirmado';

  choiceGrupos.removeActiveItems();
  if (h?.grupos) {
    choiceGrupos.setChoiceByValue(h.grupos.map(g=>g.id));
  }

  document.getElementById('modal-backdrop').style.display = 'block';
  document.getElementById('modal-hotel').style.display   = 'block';
}

// CERRAR modal hotel
function closeModal() {
  document.getElementById('modal-backdrop').style.display = 'none';
  document.getElementById('modal-hotel').style.display   = 'none';
}

// GUARDAR / ACTUALIZAR hotel
async function onSubmitHotel(evt) {
  evt.preventDefault();
  // lee distribución y grupos asignados
  const payload = {
    nombre:      toUpper(document.getElementById('m-nombre').value.trim()),
    fechaInicio: document.getElementById('m-fechaInicio').value,
    fechaFin:    document.getElementById('m-fechaFin').value,
    singles:   +document.getElementById('m-singles').value||0,
    dobles:    +document.getElementById('m-dobles').value||0,
    triples:   +document.getElementById('m-triples').value||0,
    cuadruples:+document.getElementById('m-cuadruples').value||0,
  };
  // asociaciones de grupos
  const sel = choiceGrupos.getValue(true);
  const status0 = document.getElementById('m-statusDefault').value;
  payload.grupos = sel.map(id=>({
    id, status: status0, changedBy: currentUserEmail
  }));

  if (isEdit) {
    const before = (await getDoc(doc(db,'hoteles',editId))).data();
    await updateDoc(doc(db,'hoteles',editId), payload);
    await addDoc(collection(db,'historial'),{
      tipo:'hotel-edit', hotelId:editId,
      antes:before, despues:payload,
      usuario:currentUserEmail, ts: serverTimestamp()
    });
  } else {
    const ref = await addDoc(collection(db,'hoteles'), payload);
    await addDoc(collection(db,'historial'),{
      tipo:'hotel-new', hotelId:ref.id,
      antes:null, despues:payload,
      usuario:currentUserEmail, ts: serverTimestamp()
    });
  }
  closeModal(); renderHoteles();
}

// BORRAR hotel
async function deleteHotel(id) {
  if (!confirm('¿Eliminar hotel?')) return;
  const before = (await getDoc(doc(db,'hoteles',id))).data();
  await deleteDoc(doc(db,'hoteles',id));
  await addDoc(collection(db,'historial'),{
    tipo:'hotel-del', hotelId:id,
    antes:before, despues:null,
    usuario:currentUserEmail, ts: serverTimestamp()
  });
  renderHoteles();
}

// ——— Historial ———
function showHistorialModal() {
  document.getElementById('hist-backdrop').style.display = 'block';
  document.getElementById('hist-modal').style.display     = 'block';
  loadHistorial();
}
function closeHistorialModal() {
  document.getElementById('hist-backdrop').style.display = 'none';
  document.getElementById('hist-modal').style.display     = 'none';
}
async function loadHistorial() {
  const tbody = document.querySelector('#hist-table tbody');
  tbody.innerHTML = '';
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

// ——— Ocupación diaria ———
function openOccupancyModal(hotel) {
  // encabezado
  document.getElementById('occ-header').innerHTML = `
    <strong>${hotel.nombre}</strong>
    <p>${hotel.fechaInicio} → ${hotel.fechaFin}</p>
  `;
  // construye array de fechas
  const start = new Date(hotel.fechaInicio);
  const end   = new Date(hotel.fechaFin);
  const days = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate()+1)) {
    days.push(new Date(d));
  }

  // crea la tabla
  const tbl = document.getElementById('occ-table');
  tbl.innerHTML = '';
  // header
  const thead = document.createElement('thead');
  const trh = document.createElement('tr');
  trh.innerHTML = '<th>Fecha</th><th>Grupos</th><th>Pax</th>';
  thead.appendChild(trh);
  tbl.appendChild(thead);

  const tbody = document.createElement('tbody');
  days.forEach(day => {
    const iso = day.toISOString().slice(0,10);
    // filtra grupos que “duermen” ese día
    const arr = (hotel.grupos||[]).filter(g =>
      g.checkIn <= iso && iso < g.checkOut
    );
    const numGr = arr.length;
    // suma pax de cada grupo
    const totalPax = arr.reduce((sum,g)=>{
      const grp = grupos.find(x=>x.id===g.id) || {};
      return sum + ((grp.adultos||0)+(grp.estudiantes||0)+(grp.coordinadores||0));
    },0);

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${iso}</td>
      <td>${numGr}</td>
      <td>${totalPax}</td>
    `;
    tbody.appendChild(tr);
  });
  tbl.appendChild(tbody);

  document.getElementById('occ-backdrop').style.display = 'block';
  document.getElementById('modal-occupancy').style.display = 'block';
}
function closeOccupancyModal() {
  document.getElementById('occ-backdrop').style.display    = 'none';
  document.getElementById('modal-occupancy').style.display = 'none';
}

// ——— Exportar a Excel ———
function exportToExcel() {
  const resumen = hoteles.map(h => ({
    Nombre: h.nombre,
    Desde: h.fechaInicio, Hasta: h.fechaFin,
    Singles: h.singles, Dobles: h.dobles,
    Triples: h.triples, Cuádruples: h.cuadruples,
    Grupos: (h.grupos||[]).length
  }));
  const detalle = [];
  hoteles.forEach(h => {
    (h.grupos||[]).forEach(gObj => {
      const grp = grupos.find(x=>x.id===gObj.id) || {};
      detalle.push({
        Hotel: h.nombre,
        Grupo: grp.numeroNegocio,
        CheckIn: gObj.checkIn,
        CheckOut: gObj.checkOut,
        Estado: gObj.status,
        CambiadoPor: gObj.changedBy
      });
    });
  });
  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.json_to_sheet(resumen);
  const ws2 = XLSX.utils.json_to_sheet(detalle);
  XLSX.utils.book_append_sheet(wb, ws1, 'Resumen_Hoteles');
  XLSX.utils.book_append_sheet(wb, ws2, 'Detalle_Grupos');
  XLSX.writeFile(wb, 'distribucion_hotelera.xlsx');
}

// Cerrar cualquier modal al clicar el backdrop
document.body.addEventListener('click', e => {
  if (e.target.classList.contains('modal-backdrop')) {
    e.target.style.display = 'none';
    document.querySelectorAll('.modal').forEach(m => m.style.display = 'none');
  }
}, true);
