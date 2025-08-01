// Importes de Firebase Auth y Firestore
import { getAuth, onAuthStateChanged, signOut }
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import { getDocs, collection }
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';
import { app, db } from './firebase-init.js';

// Referencias a <thead> y <tbody>
const thead = document.getElementById('thead-actividades');
const tbody = document.getElementById('tbody-actividades');

// 1️⃣ Control de sesión
const auth = getAuth(app);
onAuthStateChanged(auth, user => {
  if (!user) {
    // Redirige al login si no hay sesión
    location.href = 'login.html';
  } else {
    // Si hay sesión, empieza a construir la tabla
    init();
  }
});
// Botón de logout inyectado en encabezado.html
document.getElementById('logoutBtn')?.addEventListener('click', () => {
  signOut(auth);
});

/**
 * 2️⃣ Función principal: monta cabecera y filas,
 *    luego inicia DataTables al final
 */
async function init() {
  // 3️⃣ Leer colecciones en paralelo
  const [gruposSnap, serviciosSnap, proveedoresSnap] = await Promise.all([
    getDocs(collection(db, 'grupos')),
    getDocs(collection(db, 'servicios')),
    getDocs(collection(db, 'proveedores'))
  ]);

  // Convertir snapshots a arrays de objetos
  const grupos = gruposSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const servicios = serviciosSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const proveedores = proveedoresSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  // 4️⃣ Mapa proveedorId → nombre
  const proveedorMap = proveedores.reduce((map, p) => {
    map[p.id] = p.nombreProveedor || p.nombre;
    return map;
  }, {});

  // 5️⃣ Obtener todas las fechas únicas de los itinerarios
  const fechasSet = new Set();
  grupos.forEach(gr => {
    if (Array.isArray(gr.itinerario)) {
      gr.itinerario.forEach(i => fechasSet.add(i.dia));
    }
  });
  const fechas = Array.from(fechasSet).sort();

  // 6️⃣ Construir cabecera dinámica
  const headerCols = ['Actividad', 'Destino', 'Proveedor'];
  thead.innerHTML =
    '<tr>' +
      // Columnas fijas
      headerCols.map((h,i) =>
        `<th class="fixed-col-${i+1}">${h}</th>`
      ).join('') +
      // Columnas de fechas
      fechas.map(f => `<th>${f}</th>`).join('') +
    '</tr>';

  // 7️⃣ Ordenar servicios alfabéticamente
  servicios.sort((a,b) =>
    (a.destino + a.nombreActividad)
      .localeCompare(b.destino + b.nombreActividad)
  );

  // 8️⃣ Rellenar filas con el conteo de PAX por fecha
  servicios.forEach(s => {
    let row = `<tr>
      <td class="fixed-col-1">${s.nombreActividad}</td>
      <td class="fixed-col-2">${s.destino}</td>
      <td class="fixed-col-3">${proveedorMap[s.proveedorId]||'-'}</td>`;

    fechas.forEach(dia => {
      const totalPax = grupos.reduce((sum, gr) => {
        const pax = gr.cantidadgrupo || 0;
        const match = Array.isArray(gr.itinerario) &&
          gr.itinerario.some(i =>
            i.dia === dia &&
            i.actividad === s.nombreActividad &&
            i.destino === s.destino
          );
        return sum + (match ? pax : 0);
      }, 0);
      row += `<td>${totalPax}</td>`;
    });

    row += '</tr>';
    tbody.insertAdjacentHTML('beforeend', row);
  });

  // 9️⃣ FINAL: inicializar DataTables **después** de poblar la tabla
  const table = $('#tablaConteo').DataTable({
    scrollX: true,
    fixedHeader: true,
    dom: 'Bfrtip',
    buttons: [
      { extend: 'colvis', text: 'Ver columnas' },
      { extend: 'excelHtml5', text: 'Descargar Excel' }
    ],
      initComplete() {
        // Obtenemos la instancia API correctamente
        const api = this.api();
      
        // Poblado dinámico del filtro de destinos (columna 1)
        const dests = new Set(api.column(1).data().toArray());
        dests.forEach(d => $('#filtroDestino').append(new Option(d, d)));
      
        // Conexión de filtro y buscador
        $('#filtroDestino').on('change', () => {
          api.column(1).search($('#filtroDestino').val()).draw();
        });
        $('#buscador').on('keyup', () => {
          api.search($('#buscador').val()).draw();
        });
      
        // Botón externo de export
        $('#btn-export-excel').on('click', () =>
          api.button('.buttons-excel').trigger()
        );
      }
  });
}
