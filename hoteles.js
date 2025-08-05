// hoteles.js – Distribución Hotelera al estilo de viajes.js
import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs, doc, getDoc,
  addDoc, updateDoc, deleteDoc,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

let grupos = [], hoteles = [];
let currentUserEmail;

// ——— Utilitarios ———
function toUpper(x) {
  return typeof x === 'string' ? x.toUpperCase() : x;
}
function fmtFecha(iso) {
  const dt = new Date(iso + 'T00:00:00');
  return dt.toLocaleDateString('es-CL', {
    weekday: 'long', day: '2-digit',
    month: 'long', year: 'numeric'
  }).replace(/^\w/, c=>c.toUpperCase());
}

// ——— Filtro buscador ———
function filterHoteles(q) {
  const terms = q.toLowerCase().split(',').map(t=>t.trim()).filter(Boolean);
  document.querySelectorAll('.hotel-card').forEach(card => {
    const txt = card.textContent.toLowerCase();
    card.style.display = (!terms.length || terms.some(t=>txt.includes(t)))
                        ? '' : 'none';
  });
}

// ——— Render tarjetas ———
async function renderHoteles() {
  const cont = document.getElementById('hoteles-container');
  cont.innerHTML = '';
  // Carga hoteles
  const snap = await getDocs(collection(db, 'hoteles'));
  hoteles = snap.docs.map(d=>({ id:d.id, ...d.data() }));

  hoteles.forEach(h => {
    // Crea tarjeta
    const card = document.createElement('div');
    card.className = 'hotel-card';
    card.dataset.id = h.id;

    // 1) Encabezado rojo
    const encabezado = `
      <div style="
        color:red; font-weight:bold;
        font-size:1.1em; margin-bottom:.5em;
      ">
        ${toUpper(h.nombre)} — 
        ${fmtFecha(h.fechaInicio)} → ${fmtFecha(h.fechaFin)}
      </div>`;

    // 2) Listado de grupos
    let listaGrupos = '';
    (h.grupos||[]).forEach((gObj, idx) => {
      const g = grupos.find(x=>x.id===gObj.id) || {};
      const A = +g.adultos||0, E = +g.estudiantes||0, C = +g.coordinadores||0;
      const total = A+E+C;
      const ci = fmtFecha(g.fechaInicio), co = fmtFecha(g.fechaFin);

      listaGrupos += `
        <div class="group-item" style="display:flex; align-items:center; margin: .4em 0;">
          <div style="width:4em; font-weight:bold;">${toUpper(g.numeroNegocio)}</div>
          <div style="flex:1;">
            <div>${total} (A:${A} E:${E} C:${C})</div>
            <div style="font-size:.9em; color:#555;">${ci} → ${co}</div>
          </div>
          <div style="width:10em; text-align:center;">
            ${gObj.status==='confirmado'
              ? '✅ CONFIRMADO'
              : '🕗 PENDIENTE'}
          </div>
          <div style="display:flex; gap:.3em;">
            <button class="btn-small" onclick="openGroupModal('${g.id}')">✏️</button>
            <button class="btn-small" onclick="removeGroup('${h.id}',${idx})">🗑️</button>
            <button class="btn-small" onclick="swapGroup('${h.id}',${idx})">🔄</button>
          </div>
        </div>`;
    });

    // 3) Botón ocupación
    const btnOcup = `<button class="btn-ocup" onclick="openOccupancyModal('${h.id}')">
                       📊 OCUPACIÓN
                     </button>`;

    card.innerHTML = encabezado + listaGrupos + btnOcup;
    cont.appendChild(card);
  });

  // Vuelve a aplicar filtro tras render
  const q = document.getElementById('search-input').value;
  filterHoteles(q);
}

// ——— CRUD Hotel ———
async function deleteHotel(id) {
  if (!confirm('¿Eliminar hotel?')) return;
  const before = (await getDoc(doc(db,'hoteles',id))).data();
  await deleteDoc(doc(db,'hoteles',id));
  await addDoc(collection(db,'historial'), {
    tipo:'hotel-del', hotelId:id,
    antes: before, despues: null,
    usuario: currentUserEmail, ts: serverTimestamp()
  });
  await renderHoteles();
}

// ——— CRUD Grupos en Hotel ———
window.removeGroup = async (hotelId, idx) => {
  const ref = doc(db,'hoteles',hotelId);
  const snap = await getDoc(ref);
  const data = snap.data();
  const before = data.grupos[idx];
  data.grupos.splice(idx,1);
  await updateDoc(ref, { grupos: data.grupos });
  await addDoc(collection(db,'historial'), {
    tipo:'hotel-grupo-del', hotelId, antes, despues:null,
    usuario: currentUserEmail, ts: serverTimestamp()
  });
  await renderHoteles();
};

window.swapGroup = (hotelId, idx) => {
  // Llama tu lógica existente de intercambio (itinerario.js)
  // p.ej. window.openSwapModal(hotelId, idx);
  console.warn('swapGroup not implemented – llama tu función de intercambio');
};

// ——— Historial ———
window.showHistorialModal = () => {
  document.getElementById('hist-backdrop').style.display = 'block';
  document.getElementById('hist-modal').style.display   = 'block';
  loadHistorial();
};
window.closeHistorialModal = () => {
  document.getElementById('hist-backdrop').style.display = 'none';
  document.getElementById('hist-modal').style.display   = 'none';
};
async function loadHistorial() {
  const tbody = document.querySelector('#hist-table tbody');
  tbody.innerHTML = '';
  const start = document.getElementById('hist-start').value;
  const end   = document.getElementById('hist-end').value;
  const snap  = await getDocs(query(collection(db,'historial'),
                  orderBy('ts','desc')));
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
window.openOccupancyModal = async hotelId => {
  const hSnap = await getDoc(doc(db,'hoteles',hotelId));
  const h = { id: hSnap.id, ...hSnap.data() };
  // Header
  document.getElementById('occ-header').innerHTML = `
    <strong>${h.nombre}</strong><br>
    ${h.fechaInicio} → ${h.fechaFin}
  `;
  // Construye array de fechas
  const start = new Date(h.fechaInicio), end = new Date(h.fechaFin);
  const days = [];
  for (let d=new Date(start); d<=end; d.setDate(d.getDate()+1)) {
    days.push(new Date(d));
  }
  // Monta tabla
  const tbl = document.getElementById('occ-table');
  tbl.innerHTML = `
    <thead>
      <tr><th>Fecha</th><th>Grupos</th><th>Pax</th></tr>
    </thead>
    <tbody>
      ${days.map(d=>{
        const iso = d.toISOString().slice(0,10);
        const arr = (h.grupos||[]).filter(g=>{
          const grp = grupos.find(x=>x.id===g.id) || {};
          return grp.fechaInicio <= iso && iso < grp.fechaFin;
        });
        const numG = arr.length;
        const totalPax = arr.reduce((sum,g)=>{
          const grp=grupos.find(x=>x.id===g.id)||{};
          return sum + ((+grp.adultos||0)+(+grp.estudiantes||0)+(+grp.coordinadores||0));
        },0);
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

// ——— Exportar a Excel ———
function exportToExcel() {
  const resumen = hoteles.map(h => ({
    Nombre:    h.nombre,
    Desde:     h.fechaInicio,
    Hasta:     h.fechaFin,
    Singles:   h.singles,
    Dobles:    h.dobles,
    Triples:   h.triples,
    Cuádruples:h.cuadruples,
    Grupos:    (h.grupos||[]).length
  }));
  const detalle = [];
  hoteles.forEach(h=>{
    (h.grupos||[]).forEach(gObj=>{
      const grp = grupos.find(x=>x.id===gObj.id) || {};
      detalle.push({
        Hotel:    h.nombre,
        Grupo:    grp.numeroNegocio,
        CheckIn:  grp.fechaInicio,
        CheckOut: grp.fechaFin,
        Estado:   gObj.status
      });
    });
  });
  const wb  = XLSX.utils.book_new();
  const ws1 = XLSX.utils.json_to_sheet(resumen);
  const ws2 = XLSX.utils.json_to_sheet(detalle);
  XLSX.utils.book_append_sheet(wb, ws1, 'Resumen');
  XLSX.utils.book_append_sheet(wb, ws2, 'Detalle');
  XLSX.writeFile(wb, 'distribucion_hotelera.xlsx');
}

// ——— Cerrar modales al click en backdrop ———
document.body.addEventListener('click', e=>{
  if (e.target.classList.contains('modal-backdrop')) {
    document.querySelectorAll('.modal').forEach(m=>m.style.display='none');
  }
}, true);

// ——— Arranque ———
onAuthStateChanged(getAuth(app), async user=>{
  if (!user) return location.href='login.html';
  currentUserEmail = user.email;
  // Carga grupos
  const snapG = await getDocs(collection(db,'grupos'));
  grupos = snapG.docs.map(d=>({ id:d.id, ...d.data() }));
  // UI
  document.getElementById('search-input')
          .oninput = e => filterHoteles(e.target.value);
  document.getElementById('btnAddHotel')
          .onclick = () => {/* abrir modal de hotel */};
  document.getElementById('btnExportExcel')
          .onclick = exportToExcel;
  document.getElementById('hist-close')
          .onclick = closeHistorialModal;
  document.getElementById('hist-refresh')
          .onclick = loadHistorial;
  document.getElementById('occ-close')
          .onclick = closeOccupancyModal;

  await renderHoteles();
});
