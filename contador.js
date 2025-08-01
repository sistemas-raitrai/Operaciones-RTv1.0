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
// 2️⃣ Variables de estado global
// ———————————————————————————————
// Guardamos los grupos y las fechas para poder reutilizarlos en los eventos
let grupos = [];
let fechasOrdenadas = [];

// ———————————————————————————————
// 3️⃣ Referencias al DOM
// ———————————————————————————————
const thead = document.getElementById('thead-actividades');
const tbody = document.getElementById('tbody-actividades');

// ———————————————————————————————
// 4️⃣ Control de sesión Firebase
// ———————————————————————————————
const auth = getAuth(app);
onAuthStateChanged(auth, user => {
  if (!user) {
    // Sin sesión activa → login
    location.href = 'login.html';
  } else {
    // Con sesión → init
    init();
  }
});
document.getElementById('logoutBtn')?.addEventListener('click', () => {
  signOut(auth);
});

// —————————————————————————————————————————————————————
// 5️⃣ Función principal: carga datos y construye la tabla
// —————————————————————————————————————————————————————
async function init() {
  // ——— 5.1) Leer colección "grupos"
  const gruposSnap = await getDocs(collection(db, 'grupos'));
  grupos = gruposSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  // ——— 5.2) Leer "Servicios" (cada destino → subcolección "Listado")
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

  // ——— 5.3) Leer "Proveedores" (BRASIL/Listado)
  const proveedoresSnap = await getDocs(collection(db, 'Proveedores', 'BRASIL', 'Listado'));
  const proveedores = {};
  proveedoresSnap.docs.forEach(pSnap => {
    const d = pSnap.data();
    if (d.proveedor) {
      proveedores[d.proveedor] = {
        contacto: d.contacto || '',
        correo:   d.correo   || ''
      };
    }
  });

  // ——— 5.4) Extraer fechas únicas con algún pax > 0
  const fechasSet = new Set();
  grupos.forEach(g => {
    const itin = g.itinerario || {};
    Object.entries(itin).forEach(([fecha, acts]) => {
      if (acts.some(a =>
          (parseInt(a.adultos)||0) + (parseInt(a.estudiantes)||0) > 0
        )) {
        fechasSet.add(fecha);
      }
    });
  });
  fechasOrdenadas = Array.from(fechasSet).sort();

  // ——— 5.5) Generar <thead> dinámico (incluye columna Reserva)
  thead.innerHTML = `
    <tr>
      <th class="sticky-col sticky-header">Actividad</th>
      <th>Destino</th>
      <th>Proveedor</th>
      <th>Reserva</th>
      ${fechasOrdenadas.map(f => `<th>${formatearFechaBonita(f)}</th>`).join('')}
    </tr>`;

  // ——— 5.6) Ordenar alfabéticamente los servicios
  servicios.sort((a, b) =>
    (a.destino + a.nombre).localeCompare(b.destino + b.nombre)
  );

  // ——— 5.7) Construir filas por cada servicio
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
        (g.itinerario?.[fecha] || []).forEach(a => {
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

  // ——— 5.8) Inicializar DataTables con filtros y búsqueda
  const table = $('#tablaConteo').DataTable({
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
      // Poblado dinámico del filtroDestino
      new Set(api.column(1).data().toArray())
        .forEach(d => $('#filtroDestino').append(new Option(d, d)));

      // Buscador con comas/puntos y comas
      $('#buscador').on('keyup', () => {
        const val = $('#buscador').val();
        const terms = val.split(/[,;]+/).map(t => t.trim()).filter(Boolean);
        const rex = terms.length
          ? terms.map(t => `(?=.*${escapeRegExp(t)})`).join('|')
          : '';
        api.search(rex, true, false).draw();
      });

      // Filtro por destino
      $('#filtroDestino').on('change', () =>
        api.column(1).search($('#filtroDestino').val()).draw()
      );
    }
  });

  // ——— 5.9) Click en celdas para mostrar modal detalle
  document.querySelectorAll('.celda-interactiva').forEach(celda => {
    celda.addEventListener('click', () => {
      const { actividad, fecha } = JSON.parse(celda.dataset.info);
      mostrarGruposCoincidentes(actividad, fecha);
    });
  });

  // ——— 5.🔟 Click en “CREAR” para abrir modal de Reserva
  document.querySelectorAll('.btn-reserva').forEach(btn => {
    btn.addEventListener('click', abrirModalReserva);
  });

  // ——— 5.⓫ Botones dentro del modal de Reserva
  document.getElementById('btnCerrarReserva').onclick = () => {
    document.getElementById('modalReserva').style.display = 'none';
  };
  document.getElementById('btnGuardarPendiente').onclick = guardarPendiente;
  document.getElementById('btnEnviarReserva').onclick = enviarReserva;
} // ← fin init()

// —————————————————————————————————————————————
// Función: abrirModalReserva — carga datos y muestra modal
// —————————————————————————————————————————————
async function abrirModalReserva(event) {
  const btn = event.currentTarget;
  const destino   = btn.dataset.destino;
  const actividad = btn.dataset.actividad;

  // Poblar selector de fechas
  const selF = document.getElementById('modalFecha');
  selF.innerHTML = fechasOrdenadas
    .map(f => `<option value="${f}">${formatearFechaBonita(f)}</option>`)
    .join('');

  // Obtener contacto y correo del proveedor
  const provSnap = await getDocs(collection(db, 'Proveedores', destino, 'Listado'));
  let contacto = '', correo = '';
  provSnap.docs.forEach(dSnap => {
    const d = dSnap.data();
    if (d.proveedor === actividad) {
      contacto = d.contacto  || '';
      correo   = d.correo    || '';
    }
  });
  document.getElementById('modalPara').value    = correo;
  document.getElementById('modalAsunto').value  = `Reserva: ${actividad} en ${destino}`;

  // Generar plantilla
  function generarPlantilla() {
    const f = selF.value;
    let cuerpo = `Estimado/a ${contacto}:\n\nEnvío detalle de reserva para:\n\n`;
    cuerpo += `Actividad: ${actividad}\nFecha: ${formatearFechaBonita(f)}\n\nGrupos:\n`;
    grupos.forEach(g => {
      if ((g.itinerario?.[f] || []).find(a => a.actividad === actividad)) {
        cuerpo += `- N° Negocio: ${g.id}, Grupo: ${g.nombreGrupo}, Pax: ${g.cantidadgrupo}\n`;
      }
    });
    cuerpo += `\nAtte.\nOperaciones RaiTrai`;
    document.getElementById('modalCuerpo').value = cuerpo;
  }
  selF.onchange = generarPlantilla;
  generarPlantilla();

  // Mostrar modal
  document.getElementById('modalReserva').style.display = 'block';
}

// —————————————————————————————————————————————
// Función: guardarPendiente — marca como PENDIENTE en Firestore
// —————————————————————————————————————————————
async function guardarPendiente() {
  const asunto   = document.getElementById('modalAsunto').value;
  const actividad = asunto.split('Reserva: ')[1];
  const destino   = document.querySelector(`.btn-reserva[data-actividad="${actividad}"]`).dataset.destino;
  const fecha     = document.getElementById('modalFecha').value;
  const cuerpo    = document.getElementById('modalCuerpo').value;

  const ref = doc(db, 'Servicios', destino, 'Listado', actividad);
  await updateDoc(ref, {
    [`reservas.${fecha}`]: { estado: 'PENDIENTE', cuerpo }
  });
  document.querySelector(`.btn-reserva[data-actividad="${actividad}"]`)
    .textContent = 'PENDIENTE';
}

// —————————————————————————————————————————————
// Función: enviarReserva — dispara mailto y marca ENVIADA
// —————————————————————————————————————————————
async function enviarReserva() {
  const para     = document.getElementById('modalPara').value;
  const asunto   = document.getElementById('modalAsunto').value;
  const cuerpo   = document.getElementById('modalCuerpo').value;
  const fecha    = document.getElementById('modalFecha').value;
  const actividad = asunto.split('Reserva: ')[1];
  const destino   = document.querySelector(`.btn-reserva[data-actividad="${actividad}"]`).dataset.destino;

  window.location.href =
    `mailto:${para}?subject=${encodeURIComponent(asunto)}&body=${encodeURIComponent(cuerpo)}`;

  const ref = doc(db, 'Servicios', destino, 'Listado', actividad);
  await updateDoc(ref, {
    [`reservas.${fecha}`]: { estado: 'ENVIADA', cuerpo }
  });
  document.querySelector(`.btn-reserva[data-actividad="${actividad}"]`)
    .textContent = 'ENVIADA';
  document.getElementById('modalReserva').style.display = 'none';
}

// —————————————————————————————————————————————
// Función: mostrarGruposCoincidentes — modal detalle grupos
// —————————————————————————————————————————————
function mostrarGruposCoincidentes(actividad, fecha) {
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
  if (!lista.length) {
    tb.innerHTML = '<tr><td colspan="4" style="text-align:center;">Sin datos</td></tr>';
  } else {
    lista.forEach(g => {
      tb.insertAdjacentHTML('beforeend', `
        <tr>
          <td>${g.numeroNegocio}</td>
          <td>${g.nombreGrupo}</td>
          <td>${g.cantidadgrupo}</td>
          <td>${g.programa}</td>
        </tr>`);
    });
  }
  document.getElementById('modalDetalle').style.display = 'block';
}

// ————————————————————————————————————————
// Utilitaria: formatearFechaBonita (YYYY-MM-DD → DD/MM)
// ————————————————————————————————————————
function formatearFechaBonita(iso) {
  const [yyyy, mm, dd] = iso.split('-');
  return `${dd}/${mm}`;
}

// ————————————————————————————————————————
// Utilitaria: escapeRegExp (para búsqueda segura)
// ————————————————————————————————————————
function escapeRegExp(text) {
  return text.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
}
