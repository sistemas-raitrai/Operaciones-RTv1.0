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
    location.href = 'login.html';
  } else {
    init();  // arrancar solo si hay usuario
  }
});
document.getElementById('logoutBtn')?.addEventListener('click', () =>
  signOut(auth)
);

/**
 * 2️⃣ Función principal: lee datos, monta tabla y luego activa DataTables
 */
async function init() {
  // —————— Lectura de Grupos ——————
  const gruposSnap = await getDocs(collection(db, 'grupos'));
  const grupos = gruposSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  // —————— Lectura de Servicios en subcolecciones ——————
  const servicios = [];
  const serviciosRoot = await getDocs(collection(db, 'Servicios'));
  for (const docDestino of serviciosRoot.docs) {
    const destino = docDestino.id;
    const listado = await getDocs(collection(db, 'Servicios', destino, 'Listado'));
    listado.docs.forEach(s => {
      servicios.push({ destino, nombreActividad: s.id });
    });
  }

  // —————— Lectura de Proveedores en subcolecciones ——————
  const proveedores = [];
  const provRoot = await getDocs(collection(db, 'Proveedores'));
  for (const docDestino of provRoot.docs) {
    const destino = docDestino.id;
    const listado = await getDocs(collection(db, 'Proveedores', destino, 'Listado'));
    listado.docs.forEach(p => {
      proveedores.push({ destino, nombreProveedor: p.id });
    });
  }
  // Mapa destino → lista de proveedores
  const proveedorMap = proveedores.reduce((m, p) => {
    m[p.destino] = m[p.destino] || [];
    m[p.destino].push(p.nombreProveedor);
    return m;
  }, {});

  // —————— Extraer todas las fechas de itinerarios ——————
  const fechasSet = new Set();
  grupos.forEach(g => {
    if (Array.isArray(g.itinerario)) {
      g.itinerario.forEach(i => fechasSet.add(i.dia));
    }
  });
  const fechas = Array.from(fechasSet).sort();

  // —————— Construir <thead> dinámico ——————
  const headerCols = ['Actividad','Destino','Proveedor'];
  thead.innerHTML =
    '<tr>' +
      headerCols.map((h,i) =>
        `<th class="fixed-col-${i+1}">${h}</th>`
      ).join('') +
      fechas.map(f => `<th>${f}</th>`).join('') +
    '</tr>';

  // —————— Ordenar servicios alfabéticamente ——————
  servicios.sort((a,b) =>
    (a.destino + a.nombreActividad)
      .localeCompare(b.destino + b.nombreActividad)
  );

  // —————— Rellenar <tbody> con conteo de PAX cruzando itinerarios ——————
  servicios.forEach(s => {
    // cada fila: nombreActividad, destino, proveedores
    const provStr = (proveedorMap[s.destino] || []).join(', ');
    let row = `<tr>
      <td class="fixed-col-1">${s.nombreActividad}</td>
      <td class="fixed-col-2">${s.destino}</td>
      <td class="fixed-col-3">${provStr || '-'}</td>`;

    // Para cada fecha, sumar los grupos que tengan esa actividad en el itinerario
    fechas.forEach(dia => {
      const sumaPax = grupos.reduce((sum, g) => {
        const pax = g.cantidadgrupo || 0;
        // ¿Tiene este grupo la actividad s.nombreActividad el día 'dia'?
        const tiene = Array.isArray(g.itinerario) &&
          g.itinerario.some(item =>
            item.dia === dia &&
            item.actividad === s.nombreActividad &&
            item.destino === s.destino
          );
        return sum + (tiene ? pax : 0);
      }, 0);
      row += `<td>${sumaPax}</td>`;
    });

    row += '</tr>';
    tbody.insertAdjacentHTML('beforeend', row);
  });

  // —————— Inicializar DataTables ——————
  const table = $('#tablaConteo').DataTable({
    scrollX: true,
    fixedHeader: true,
    dom: 'Bfrtip',
    buttons: [
      { extend: 'colvis', text: 'Ver columnas' },
      { extend: 'excelHtml5', text: 'Descargar Excel' }
    ],
    initComplete() {
      const api = this.api();
      // Pasa valores al filtroDestino
      const dests = Array.from(new Set(api.column(1).data().toArray()));
      dests.forEach(d => $('#filtroDestino').append(new Option(d,d)));

      // Enlaces buscador y filtro
      $('#buscador').on('keyup', () => api.search($('#buscador').val()).draw());
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
