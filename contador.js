// Importamos Auth y Firestore
import { getAuth, onAuthStateChanged, signOut } 
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import { getDocs, collection } 
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';
import { app, db } from './firebase-init.js';

// Referencias al DOM
const thead = document.getElementById('thead-actividades');
const tbody = document.getElementById('tbody-actividades');

// 1️⃣ Control de sesión Firebase
const auth = getAuth(app);
onAuthStateChanged(auth, user => {
  if (!user) {
    // Si no hay usuario logueado, volvemos al login
    location.href = 'login.html';
  } else {
    // Si hay sesión, arrancamos la lógica
    init();
  }
});
// Botón Cerrar sesión (inyectado en encabezado.html)
document.getElementById('logoutBtn')?.addEventListener('click', () => {
  signOut(auth);
});

/**
 * Función principal: lee datos de Firestore y monta la tabla
 */
async function init() {
  // 2️⃣ Leer las tres colecciones en paralelo
  const [gruposSnap, serviciosSnap, proveedoresSnap] = await Promise.all([
    getDocs(collection(db, 'grupos')),
    getDocs(collection(db, 'servicios')),
    getDocs(collection(db, 'proveedores'))
  ]);

  // Transformamos a arrays de objetos
  const grupos = gruposSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const servicios = serviciosSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const proveedores = proveedoresSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  // 3️⃣ Mapa rápido proveedorId → nombre
  const proveedorMap = proveedores.reduce((map, p) => {
    map[p.id] = p.nombreProveedor || p.nombre;
    return map;
  }, {});

  // 4️⃣ Extraer fechas únicas de todos los itinerarios
  const fechasSet = new Set();
  grupos.forEach(gr => {
    if (Array.isArray(gr.itinerario)) {
      gr.itinerario.forEach(i => fechasSet.add(i.dia));
    }
  });
  const fechas = Array.from(fechasSet).sort();

  // 5️⃣ Construir el <thead> dinámico
  const headerCols = ['Actividad', 'Destino', 'Proveedor'];
  const ths =
    '<tr>' +
    headerCols.map((h, i) => `<th class="fixed-col-${i+1}">${h}</th>`).join('') +
    fechas.map(fecha => `<th>${fecha}</th>`).join('') +
    '</tr>';
  thead.innerHTML = ths;

  // 6️⃣ Orden alfabético de servicios por destino + nombre de actividad
  servicios.sort((a, b) =>
    (a.destino + a.nombreActividad).localeCompare(b.destino + b.nombreActividad)
  );

  // 7️⃣ Rellenar <tbody> con cada fila y el conteo de PAX
  servicios.forEach(s => {
    const actividad = s.nombreActividad;
    const destino = s.destino;
    const proveedor = proveedorMap[s.proveedorId] || '-';

    // Empezamos la fila con los tres campos fijos
    let row = 
      `<tr>
        <td class="fixed-col-1">${actividad}</td>
        <td class="fixed-col-2">${destino}</td>
        <td class="fixed-col-3">${proveedor}</td>`;

    // Para cada fecha, sumamos los pax de todos los grupos que hagan esa actividad+destino en ese día
    fechas.forEach(dia => {
      const totalPax = grupos.reduce((sum, gr) => {
        const pax = gr.cantidadgrupo || 0;
        const haceEstaActividad = 
          Array.isArray(gr.itinerario) &&
          gr.itinerario.some(i =>
            i.dia === dia &&
            i.actividad === actividad &&
            i.destino === destino
          );
        return sum + (haceEstaActividad ? pax : 0);
      }, 0);

      row += `<td>${totalPax}</td>`;
    });

    row += '</tr>';
    tbody.insertAdjacentHTML('beforeend', row);
  });
}
