// contador.js

// ———————————————————————————————
// 1️⃣ Importes de Firebase
// ———————————————————————————————
import { app, db } from './firebase-init.js';
import {
  getDocs,
  collection,
  doc,
  updateDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';
import {
  getAuth,
  onAuthStateChanged,
  signOut
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';

// ———————————————————————————————
// 2️⃣ Referencias al DOM
// ———————————————————————————————
const thead = document.getElementById('thead-actividades');
const tbody = document.getElementById('tbody-actividades');

// ———————————————————————————————
// 3️⃣ Control de sesión Firebase
// ———————————————————————————————
const auth = getAuth(app);
onAuthStateChanged(auth, user => {
  if (!user) {
    // Si no hay sesión, vuelve al login
    location.href = 'login.html';
  } else {
    // Si está autenticado, arrancamos la app
    init();
  }
});
document.getElementById('logoutBtn')?.addEventListener('click', () => {
  signOut(auth);
});

// —————————————————————————————————————————————————————
// 4️⃣ Función principal: carga datos, construye tabla y eventos
// —————————————————————————————————————————————————————
async function init() {
  // ——— 4.1) Leer colección "grupos"
  const gruposSnap = await getDocs(collection(db, 'grupos'));
  const grupos = gruposSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  // ——— 4.2) Leer "Servicios" (cada destino → subcolección "Listado")
  const servicios = [];
  const serviciosRoot = await getDocs(collection(db, 'Servicios'));
  for (const destinoDoc of serviciosRoot.docs) {
    const destino = destinoDoc.id;
    const listadoSnap = await getDocs(collection(db, 'Servicios', destino, 'Listado'));
    listadoSnap.docs.forEach(sDoc => {
      const data = sDoc.data();
      servicios.push({
        destino,
        nombre: sDoc.id,
        proveedor: data.proveedor || ''
      });
    });
  }

  // ——— 4.3) Leer "Proveedores" (plano BRASIL/Listado)
  const proveedoresSnap = await getDocs(collection(db, 'Proveedores', 'BRASIL', 'Listado'));
  const proveedores = {};
  proveedoresSnap.docs.forEach(docSnap => {
    const d = docSnap.data();
    if (d.proveedor) {
      proveedores[d.proveedor] = {
        contacto: d.contacto || '',
        correo:   d.correo   || ''
      };
    }
  });

  // ——— 4.4) Extraer fechas únicas con al menos un pax > 0
  const fechasSet = new Set();
  grupos.forEach(g => {
    const itin = g.itinerario || {};
    Object.entries(itin).forEach(([fecha, acts]) => {
      if (acts.some(a => (parseInt(a.adultos)||0)+(parseInt(a.estudiantes)||0) > 0)) {
        fechasSet.add(fecha);
      }
    });
  });
  const fechasOrdenadas = Array.from(fechasSet).sort();

  // ——— 4.5) Generar <thead> dinámico (incluye columna Reserva)
  thead.innerHTML = `
    <tr>
      <th class="sticky-col sticky-header">Actividad</th>
      <th>Destino</th>
      <th>Proveedor</th>
      <th>Reserva</th>
      ${fechasOrdenadas.map(f => `<th>${formatearFechaBonita(f)}</th>`).join('')}
    </tr>`;

  // ——— 4.6) Orden alfabético de servicios
  servicios.sort((a, b) =>
    (a.destino + a.nombre).localeCompare(b.destino + b.nombre)
  );

  // ——— 4.7) Construir filas por servicio
  servicios.forEach(servicio => {
    const provInfo = proveedores[servicio.proveedor] || {};
    const proveedorStr = provInfo.contacto ? servicio.proveedor : '-';

    let fila = `
      <tr>
        <td class="sticky-col">${servicio.nombre}</td>
        <td>${servicio.destino}</td>
        <td>${proveedorStr}</td>
        <td>
          <button class="btn-reserva"
                  data-destino="${servicio.destino}"
                  data-actividad="${servicio.nombre}">
            CREAR
          </button>
        </td>`;

    fechasOrdenadas.forEach(fecha => {
      let totalPax = 0;
      grupos.forEach(g => {
        const acts = g.itinerario?.[fecha] || [];
        acts.forEach(a => {
          if (a.actividad === servicio.nombre) {
            totalPax += (parseInt(a.adultos)||0) + (parseInt(a.estudiantes)||0);
          }
        });
      });

      fila += `
        <td class="celda-interactiva"
            data-info='${JSON.stringify({ actividad: servicio.nombre, fecha })}'
            style="cursor:pointer;color:#0055a4;text-decoration:underline;">
          ${totalPax}
        </td>`;
    });

    fila += '</tr>';
    tbody.insertAdjacentHTML('beforeend', fila);
  });

  // ——— 4.8) Inicializar DataTables con filtros y búsqueda
  $('#tablaConteo').DataTable({
    scrollX: true,
    paging: false,
    fixedHeader: { header: true, headerOffset: 90 },
    fixedColumns: { leftColumns: 1 },
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
      // Poblado dinámico de filtroDestino
      const dests = new Set(api.column(1).data().toArray());
      dests.forEach(d => $('#filtroDestino').append(new Option(d, d)));

      // Búsqueda tolerante a comas/puntos y comas
      $('#buscador').on('keyup', () => {
        const val = $('#buscador').val();
        const palabras = val.split(/[,;]+/).map(p => p.trim()).filter(p => p);
        const regex = palabras.length
          ? palabras.map(p => `(?=.*${escapeRegExp(p)})`).join('|')
          : '';
        api.search(regex, true, false).draw();
      });

      // Filtro de destinos
      $('#filtroDestino').on('change', () =>
        api.column(1).search($('#filtroDestino').val()).draw()
      );
    }
  });

  // ——— 4.9) Click en celdas para detalle de grupos
  document.querySelectorAll('.celda-interactiva').forEach(celda => {
    celda.addEventListener('click', () => {
      const { actividad, fecha } = JSON.parse(celda.dataset.info);
      mostrarGruposCoincidentes(actividad, fecha, grupos);
    });
  });

  // ——— 4.10) Click en “CREAR” para abrir modal de Reserva
  document.querySelectorAll('.btn-reserva').forEach(btn => {
    btn.addEventListener('click', async () => {
      const destino   = btn.dataset.destino;
      const actividad = btn.dataset.actividad;

      // 1) Poblar selector de fechas
      const selF = document.getElementById('modalFecha');
      selF.innerHTML = fechasOrdenadas
        .map(f => `<option value="${f}">${formatearFechaBonita(f)}</option>`)
        .join('');

      // 2) Obtener datos de proveedor (contacto, correo)
      const provSnap = await getDocs(collection(db, 'Proveedores', destino, 'Listado'));
      let contacto = '', correo = '';
      provSnap.docs.forEach(dSnap => {
        const d = dSnap.data();
        if (d.proveedor === actividad) {
          contacto = d.contacto  || '';
          correo   = d.correo    || '';
        }
      });
      document.getElementById('modalPara').value   = correo;
      document.getElementById('modalAsunto').value = `Reserva: ${actividad} en ${destino}`;

      // 3) Generar plantilla base
      const generarPlantilla = () => {
        const f = selF.value;
        let cuerpo = `Estimado/a ${contacto}:\n\n`;
        cuerpo += `Envío detalle de reserva para:\n\n`;
        cuerpo += `Actividad: ${actividad}\n`;
        cuerpo += `Fecha: ${formatearFechaBonita(f)}\n\n`;
        cuerpo += `Grupos:\n`;
        grupos.forEach(g => {
          if ((g.itinerario?.[f] || []).find(a => a.actividad === actividad)) {
            cuerpo += `- N° Negocio: ${g.id}, Grupo: ${g.nombreGrupo}, Pax: ${g.cantidadgrupo}\n`;
          }
        });
        cuerpo += `\nAtte.\nOperaciones RaiTrai`;
        document.getElementById('modalCuerpo').value = cuerpo;
      };
      selF.onchange = generarPlantilla;
      generarPlantilla();

      // 4) Mostrar modal
      document.getElementById('modalReserva').style.display = 'block';
    });
  });

  // ——— 4.11) Botones dentro del modal de Reserva
  document.getElementById('btnCerrarReserva').onclick = () => {
    document.getElementById('modalReserva').style.display = 'none';
  };

  document.getElementById('btnGuardarPendiente').onclick = async () => {
    const cuerpo   = document.getElementById('modalCuerpo').value;
    const fecha    = document.getElementById('modalFecha').value;
    const asunto   = document.getElementById('modalAsunto').value;
    const actividad = asunto.split('Reserva: ')[1];
    const destino   = document.querySelector(`.btn-reserva[data-actividad="${actividad}"]`).dataset.destino;

    // Guardar en Firestore como PENDIENTE
    const ref = doc(db, 'Servicios', destino, 'Listado', actividad);
    await updateDoc(ref, {
      [`reservas.${fecha}`]: { estado: 'PENDIENTE', cuerpo }
    });

    // Actualizar texto del botón
    document.querySelector(`.btn-reserva[data-actividad="${actividad}"]`).textContent = 'PENDIENTE';
  };

  document.getElementById('btnEnviarReserva').onclick = async () => {
    const para     = document.getElementById('modalPara').value;
    const asunto   = document.getElementById('modalAsunto').value;
    const cuerpo   = document.getElementById('modalCuerpo').value;
    const fecha    = document.getElementById('modalFecha').value;
    const actividad = asunto.split('Reserva: ')[1];
    const destino   = document.querySelector(`.btn-reserva[data-actividad="${actividad}"]`).dataset.destino;

    // Disparar mailto:
    window.location.href = `mailto:${para}?subject=${encodeURIComponent(asunto)}&body=${encodeURIComponent(cuerpo)}`;

    // Guardar en Firestore como ENVIADA
    const ref = doc(db, 'Servicios', destino, 'Listado', actividad);
    await updateDoc(ref, {
      [`reservas.${fecha}`]: { estado: 'ENVIADA', cuerpo }
    });

    // Actualizar botón y cerrar modal
    document.querySelector(`.btn-reserva[data-actividad="${actividad}"]`).textContent = 'ENVIADA';
    document.getElementById('modalReserva').style.display = 'none';
  };
} // ← fin de init()

// ————————————————————————————————————————
// Función para mostrar detalle de grupos en modal
// ————————————————————————————————————————
function mostrarGruposCoincidentes(actividad, fecha, grupos) {
  const tb = document.querySelector('#tablaModal tbody');
  tb.innerHTML = '';

  const lista = grupos
    .filter(g => (g.itinerario?.[fecha] || []).some(a => a.actividad === actividad))
    .map(g => ({
      numeroNegocio: g.id,
      nombreGrupo:   g.nombreGrupo,
      cantidadgrupo: g.cantidadgrupo,
      programa:      g.programa
    }));

  if (lista.length === 0) {
    tb.innerHTML = '<tr><td colspan="4" style="text-align:center;">Sin datos</td></tr>';
  } else {
    lista.forEach(g => {
      tb.insertAdjacentHTML('beforeend', `
        <tr>
          <td>${g.numeroNegocio}</td>
          <td>${g.nombreGrupo}</td>
          <td>${g.cantidadgrupo}</td>
          <td>${g.programa}</td>
        </tr>
      `);
    });
  }

  document.getElementById('modalDetalle').style.display = 'block';
}

// ————————————————————————————————————————
// Función utilitaria para formatear fecha YYYY-MM-DD → DD/MM
// ————————————————————————————————————————
function formatearFechaBonita(isoDate) {
  const [yyyy, mm, dd] = isoDate.split('-');
  return `${dd}/${mm}`;
}

// ————————————————————————————————————————
// Escapar caracteres especiales en regex
// ————————————————————————————————————————
function escapeRegExp(text) {
  return text.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
}
