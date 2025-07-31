import { getAuth, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import { getDocs, collection } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';
import { app, db } from './firebase-init.js';

// DOM elements
const thead = document.getElementById('thead-actividades');
const tbody = document.getElementById('tbody-actividades');
const encabezado = document.getElementById('encabezado');

// Authentication
const auth = getAuth(app);
onAuthStateChanged(auth, user => {
  if (!user) {
    location.href = 'login.html';
  } else {
    // Username display handled in encabezado.html script
    init();
  }
});

document.getElementById('logoutBtn')?.addEventListener('click', () => signOut(auth));

// Main Initialization
async function init() {
  // 1. Fetch collections
  const [gruposSnap, serviciosSnap, proveedoresSnap] = await Promise.all([
    getDocs(collection(db, 'grupos')),
    getDocs(collection(db, 'servicios')),
    getDocs(collection(db, 'proveedores'))
  ]);
  const grupos = gruposSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const servicios = serviciosSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const proveedores = proveedoresSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  // Map proveedorId to name
  const proveedorMap = proveedores.reduce((map, p) => {
    map[p.id] = p.nombreProveedor || p.nombre;
    return map;
  }, {});

  // 2. Unique dates
  const fechasSet = new Set();
  grupos.forEach(g => {
    if (Array.isArray(g.itinerario)) {
      g.itinerario.forEach(i => fechasSet.add(i.dia));
    }
  });
  const fechas = Array.from(fechasSet).sort();

  // 3. Build table header
  const headerCols = ['Actividad', 'Destino', 'Proveedor'];
  let trHead = '<tr>' +
    headerCols.map((h, i) => `<th class="fixed-col-${i+1}">${h}</th>`).join('') +
    fechas.map(d => `<th>${d}</th>`).join('') +
    '</tr>';
  thead.innerHTML = trHead;

  // 4. Populate table body
  servicios.sort((a, b) => (a.destino + a.nombreActividad).localeCompare(b.destino + b.nombreActividad));
  servicios.forEach(s => {
    const actividad = s.nombreActividad;
    const destino = s.destino;
    const proveedor = proveedorMap[s.proveedorId] || '-';
    let row = '<tr>' +
      `<td class="fixed-col-1">${actividad}</td>` +
      `<td class="fixed-col-2">${destino}</td>` +
      `<td class="fixed-col-3">${proveedor}</td>`;

    fechas.forEach(dia => {
      const totalPax = grupos.reduce((sum, g) => {
        const pax = g.cantidadgrupo || g.pax || 0;
        const has = Array.isArray(g.itinerario) && g.itinerario.some(i =>
          i.dia === dia && i.actividad === actividad && i.destino === destino
        );
        return sum + (has ? pax : 0);
      }, 0);
      row += `<td>${totalPax}</td>`;
    });

    row += '</tr>';
    tbody.insertAdjacentHTML('beforeend', row);
  });
}
