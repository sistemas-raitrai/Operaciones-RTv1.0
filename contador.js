// contador.js

// ———————————————————————————————
// 1️⃣ Importes de Firebase
// ———————————————————————————————
import { app, db } from './firebase-init.js';
import {
  getDocs, collection
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';
import {
  getAuth, onAuthStateChanged, signOut
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';

// ———————————————————————————————
// 2️⃣ Referencias al DOM
// ———————————————————————————————
const thead = document.getElementById('thead-actividades');
const tbody = document.getElementById('tbody-actividades');

// ———————————————————————————————
// 3️⃣ Control de sesión
// ———————————————————————————————
const auth = getAuth(app);
onAuthStateChanged(auth, user => {
  if (!user) location.href = 'login.html';
  else init(); // si hay sesión, ejecuta todo
});
document.getElementById('logoutBtn')?.addEventListener('click', () => {
  signOut(auth);
});

// —————————————————————————————————————————————————————
// 4️⃣ Función principal: lee y muestra tabla de conteo
// —————————————————————————————————————————————————————
async function init() {
  // ——— 4.1) Leer colección 'grupos'
  const gruposSnap = await getDocs(collection(db, 'grupos'));
  const grupos = gruposSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  // ——— 4.2) Leer todos los servicios desde todas las subcolecciones
  const servicios = [];
  const serviciosRoot = await getDocs(collection(db, 'Servicios'));
  for (const doc of serviciosRoot.docs) {
    const destino = doc.id;
    const listadoSnap = await getDocs(collection(db, 'Servicios', destino, 'Listado'));
    listadoSnap.docs.forEach(s => {
      const data = s.data();
      servicios.push({
        destino,
        nombre: s.id,
        proveedor: data.proveedor || ''
      });
    });
  }

  // ——— 4.3) Leer proveedores una sola vez
  const proveedoresSnap = await getDocs(collection(db, 'Proveedores', 'BRASIL', 'Listado'));
  const proveedores = {};
  proveedoresSnap.docs.forEach(doc => {
    const data = doc.data();
    if (data.proveedor) {
      proveedores[data.proveedor] = {
        contacto: data.contacto || '',
        telefono: data.telefono || '',
        correo: data.correo || '',
        destino: data.destino || ''
      };
    }
  });

  // ——— 4.4) Extraer fechas únicas que tengan al menos un total mayor a 0
  const fechasSet = new Set();
  grupos.forEach(g => {
    const itinerario = g.itinerario || {};
    Object.entries(itinerario).forEach(([fecha, actividades]) => {
      const hayPax = actividades?.some(act => {
        const adultos = parseInt(act.adultos) || 0;
        const estudiantes = parseInt(act.estudiantes) || 0;
        return adultos + estudiantes > 0;
      });
      if (hayPax) fechasSet.add(fecha);
    });
  });
  const fechasOrdenadas = Array.from(fechasSet).sort();

  // ——— 4.5) Generar <thead> dinámico
  thead.innerHTML = `
    <tr>
      <th class="sticky-col sticky-header">Actividad</th>
      <th>Destino</th>
      <th>Proveedor</th>
      ${fechasOrdenadas.map(f => `<th>${formatearFechaBonita(f)}</th>`).join('')}
    </tr>`;

  // ——— 4.6) Ordenar servicios por destino + nombre
  servicios.sort((a, b) =>
    (a.destino + a.nombre).localeCompare(b.destino + b.nombre)
  );

  // ——— 4.7) Generar filas por servicio
  servicios.forEach(servicio => {
    const prov = proveedores[servicio.proveedor];
    const proveedorStr = prov ? servicio.proveedor : '-';

    let fila = `
      <tr>
        <td class="sticky-col">${servicio.nombre}</td>
        <td>${servicio.destino}</td>
        <td>${proveedorStr}</td>`;

    fechasOrdenadas.forEach(fecha => {
      let totalPax = 0;

      grupos.forEach(g => {
        const actividades = g.itinerario?.[fecha] || [];
  
        actividades.forEach(act => {
          if (act.actividad === servicio.nombre) {
            // ✅ Corregido: asegurarse que se sumen como números
            const adultos = parseInt(act.adultos) || 0;
            const estudiantes = parseInt(act.estudiantes) || 0;
            totalPax += adultos + estudiantes;
          }
        });
      });

      const datosCelda = {
        actividad: servicio.nombre,
        fecha,
      };
      
      fila += `<td class="celda-interactiva" data-info='${JSON.stringify(datosCelda)}' style="cursor:pointer; color:#0055a4; text-decoration:underline;">
        ${totalPax}
      </td>`;
    });

    fila += '</tr>';
    tbody.insertAdjacentHTML('beforeend', fila);
  });

  // ——— 4.8) Activar DataTables con filtros
  $('#tablaConteo').DataTable({
    scrollX: true,
    paging: false, 
    fixedHeader: {
      header: true,
      headerOffset: 90
    },
    fixedColumns: {
      leftColumns: 1
    },
    dom: 'Bfrtip',
    language: {
      url: 'https://cdn.datatables.net/plug-ins/1.13.4/i18n/es-ES.json'
    },
    buttons: [
      { extend: 'colvis', text: 'Ver columnas' },
      { extend: 'excelHtml5', text: 'Descargar Excel' }
    ],
    initComplete: function () {
      const api = this.api();

      // Agrega filtro de destinos
      const destinos = new Set(api.column(1).data().toArray());
      destinos.forEach(d => {
        $('#filtroDestino').append(new Option(d, d));
      });

      // Buscador general y filtro por destino
      $('#buscador').on('keyup', function () {
        const entrada = $(this).val();
        const palabras = entrada.split(/[,;]+/).map(p => p.trim()).filter(p => p);
        const regex = palabras.length
          ? palabras.map(p => `(?=.*${escapeRegExp(p)})`).join('|')
          : '';
        api.search(regex, true, false).draw();
      });
      
      // Utilidad para escapar caracteres especiales en RegExp
      function escapeRegExp(text) {
        return text.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
      }
      $('#filtroDestino').on('change', () =>
        api.column(1).search($('#filtroDestino').val()).draw());

      // Exportar Excel (botón externo)
      $('#btn-export-excel').on('click', () =>
        api.button('.buttons-excel').trigger());
    }
  });
    document.querySelectorAll('.celda-interactiva').forEach(celda => {
    celda.addEventListener('click', () => {
      const { actividad, fecha } = JSON.parse(celda.dataset.info);
      const tbodyModal = document.querySelector('#tablaModal tbody');
      tbodyModal.innerHTML = '';
  
      const gruposCoincidentes = [];
  
      grupos.forEach(g => {
        const actividades = g.itinerario?.[fecha] || [];
        const match = actividades.find(act => act.actividad === actividad);
        if (match) {
          gruposCoincidentes.push({
            numeroNegocio: g.numeroNegocio || '',
            nombreGrupo: g.nombreGrupo || '',
            cantidadgrupo: g.cantidadgrupo || '',
            programa: g.programa || ''
          });
        }
      });
  
      if (gruposCoincidentes.length > 0) {
        gruposCoincidentes.forEach(g => {
          tbodyModal.insertAdjacentHTML('beforeend', `
            <tr>
              <td>${g.numeroNegocio}</td>
              <td>${g.nombreGrupo}</td>
              <td>${g.cantidadgrupo}</td>
              <td>${g.programa}</td>
            </tr>
          `);
        });
      } else {
        tbodyModal.innerHTML = '<tr><td colspan="4" style="text-align:center;">Sin datos</td></tr>';
      }
  
      document.getElementById('modalDetalle').style.display = 'block';
    });
  });
}

// ————————————————————————————————————————
// Función utilitaria para mostrar fechas bonitas
// ————————————————————————————————————————
function formatearFechaBonita(isoDate) {
  const [yyyy, mm, dd] = isoDate.split('-');
  return `${dd}/${mm}`;
}
