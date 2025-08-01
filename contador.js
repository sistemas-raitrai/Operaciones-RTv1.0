// contador.js

// —————————————— Importes de Firebase ——————————————
import { getAuth, onAuthStateChanged, signOut }
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import { getDocs, collection }
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';
import { app, db } from './firebase-init.js';

// ————————— Referencias al DOM —————————
const thead = document.getElementById('thead-actividades');
const tbody = document.getElementById('tbody-actividades');

// —————— 1️⃣ Control de sesión Firebase ——————
const auth = getAuth(app);
onAuthStateChanged(auth, user => {
  if (!user) {
    // Si no hay usuario, redirige a login
    location.href = 'login.html';
  } else {
    // Si está autenticado, arrancar lógica
    init();
  }
});
// Botón “Cerrar sesión” inyectado en encabezado.html
document.getElementById('logoutBtn')?.addEventListener('click', () => {
  signOut(auth);
});

/**
 * 2️⃣ Función principal:
 *   • Lee datos de Firestore (grupos, proveedores, servicios)
 *   • Monta cabecera con fechas dinámicas
 *   • Rellena filas con conteo de pasajeros
 *   • Inicializa DataTables al final
 */
async function init() {
  // ——— 3️⃣ Leer “grupos” de Firestore ———
  const gruposSnap = await getDocs(collection(db, 'grupos'));
  const grupos = gruposSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  // ——— 4️⃣ Leer “Proveedores” (colección plana) ———
  // Para mapear proveedorId → nombreProveedor
  const provSnap = await getDocs(collection(db, 'Proveedores'));
  const proveedores = provSnap.docs.map(d => ({
    id: d.id,
    nombre: d.data().nombreProveedor
  }));
  const proveedorMap = proveedores.reduce((map, p) => {
    map[p.id] = p.nombre;
    return map;
  }, {});

  // ——— 5️⃣ Leer “Servicios” (subcolecciones) ———
  // Cada doc en “Servicios” es un destino; su subcolección “Listado” tiene las actividades
  const servicios = [];
  const serviciosRoot = await getDocs(collection(db, 'Servicios'));
  for (const docDestino of serviciosRoot.docs) {
    const destino = docDestino.id;
    const listadoSnap = await getDocs(collection(db, 'Servicios', destino, 'Listado'));
    listadoSnap.docs.forEach(sDoc => {
      const data = sDoc.data();
      servicios.push({
        destino,
        nombreActividad: sDoc.id,
        proveedorId: data.proveedor   // campo “proveedor” en cada actividad
      });
    });
  }

  // ——— 6️⃣ Extraer fechas únicas de todos los itinerarios ———
  const fechasSet = new Set();
  grupos.forEach(g => {
    if (Array.isArray(g.itinerario)) {
      g.itinerario.forEach(item => {
        const label = item.dia
          .toDate()
          .toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit' });
        fechasSet.add(label);
      });
    }
  });
  const fechas = Array.from(fechasSet).sort((a, b) => {
    const [da, ma] = a.split('/').map(Number);
    const [db, mb] = b.split('/').map(Number);
    return new Date(0, ma - 1, da) - new Date(0, mb - 1, db);
  });

  // ——— 7️⃣ Construir <thead> dinámico con columnas fijas + fechas ———
  const headerCols = ['Actividad', 'Destino', 'Proveedor'];
  thead.innerHTML =
    '<tr>' +
      headerCols.map((h, i) =>
        `<th class="fixed-col-${i+1}">${h}</th>`
      ).join('') +
      fechas.map(f => `<th>${f}</th>`).join('') +
    '</tr>';

  // ——— 8️⃣ Ordenar servicios alfabéticamente por destino+actividad ———
  servicios.sort((a, b) =>
    (a.destino + a.nombreActividad)
      .localeCompare(b.destino + b.nombreActividad)
  );

  // ——— 9️⃣ Rellenar <tbody> con filas y conteo de PAX por fecha ———
  servicios.forEach(s => {
    const proveedorStr = proveedorMap[s.proveedorId] || '-';
    let row = `<tr>
      <td class="fixed-col-1">${s.nombreActividad}</td>
      <td class="fixed-col-2">${s.destino}</td>
      <td class="fixed-col-3">${proveedorStr}</td>`;

    fechas.forEach(dia => {
      const sumaPax = grupos.reduce((sum, g) => {
        const pax = g.cantidadgrupo || 0;
        const coincide = Array.isArray(g.itinerario) &&
          g.itinerario.some(item => {
            const label = item.dia
              .toDate()
              .toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit' });
            return (
              label === dia &&
              item.actividad === s.nombreActividad &&
              item.destino === s.destino
            );
          });
        return sum + (coincide ? pax : 0);
      }, 0);
      row += `<td>${sumaPax}</td>`;
    });

    row += '</tr>';
    tbody.insertAdjacentHTML('beforeend', row);
  });

  // ——— 🔟 Inicializar DataTables tras poblar la tabla ———
  $('#tablaConteo').DataTable({
    scrollX: true,
    fixedHeader: true,
    dom: 'Bfrtip',
    buttons: [
      { extend: 'colvis', text: 'Ver columnas' },
      { extend: 'excelHtml5', text: 'Descargar Excel' }
    ],
    initComplete() {
      const api = this.api();

      // Poblado dinámico del filtro de destinos (columna 1)
      const dests = Array.from(new Set(api.column(1).data().toArray()));
      dests.forEach(d => $('#filtroDestino').append(new Option(d, d)));

      // Conectar buscador y filtro
      $('#buscador').on('keyup', () =>
        api.search($('#buscador').val()).draw()
      );
      $('#filtroDestino').on('change', () =>
        api.column(1).search($('#filtroDestino').val()).draw()
      );

      // Botón externo de export
      $('#btn-export-excel').on('click', () =>
        api.button('.buttons-excel').trigger()
      );
    }
  });
}
