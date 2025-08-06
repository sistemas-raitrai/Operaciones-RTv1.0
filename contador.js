// contador.js

// ———————————————————————————————
// 1️⃣ Importes de Firebase
// ———————————————————————————————
import { app, db } from './firebase-init.js';
import {
  getDocs,
  getDoc,
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
let proveedores = {};

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
  const proveedoresLocal = {};
  proveedoresSnap.docs.forEach(pSnap => {
    const d = pSnap.data();
    if (d.proveedor) {
      proveedoresLocal[d.proveedor] = {
        contacto: d.contacto || '',
        correo:   d.correo   || ''
      };
    }
  });
  // ahora asigna al global:
  proveedores = proveedoresLocal;

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

  // ——— 5.7) PRE-FETCH de TODOS los subdocumentos de reservas en paralelo
  //  a) Creamos un array de referencias apuntando a cada doc de reserva
  const referencias = servicios.map(s =>
    doc(db, 'Servicios', s.destino, 'Listado', s.nombre)
  );
  //  b) Lanzamos todas las lecturas a la vez
  const snapshots = await Promise.all(
    referencias.map(ref => getDoc(ref))
  );
  //  c) Extraemos el objeto `reservas` de cada snapshot
  const todosLosReservas = snapshots.map(snap =>
    (snap.exists() && snap.data().reservas) ? snap.data().reservas : {}
  );

  // ——— 5.8) Montar TODO el HTML de las filas en un string
  let rowsHTML = servicios.map((servicio, i) => {
    const reservas = todosLosReservas[i];
    // ① determinamos el texto del botón
    // 1️⃣ extraigo sólo las fechas donde realmente hubo pasajeros
    const fechasConPax = fechasOrdenadas.filter(fecha =>
      grupos.some(g =>
        (g.itinerario?.[fecha]||[])
          .some(a => a.actividad === servicio.nombre)
      )
    );
    
    // 2️⃣ compruebo que **todas** esas fechas estén enviadas
    const todasEnviadas = fechasConPax.every(fecha =>
      reservas[fecha]?.estado === 'ENVIADA'
    );
    const tieneAlguna = Object.keys(reservas).length > 0;
    let textoBtn;
    if (!tieneAlguna) {
      textoBtn = 'CREAR';
    } else if (todasEnviadas) {
      textoBtn = 'ENVIADA';
    } else {
      textoBtn = 'PENDIENTE';
    }
  
    // ② datos de proveedor
    const provInfo = proveedores[servicio.proveedor] || {};
    const proveedorStr = provInfo.contacto ? servicio.proveedor : '-';
  
    // ③ construimos la fila
    let fila = `
      <tr>
        <td class="sticky-col">${servicio.nombre}</td>
        <td>${servicio.destino}</td>
        <td>${proveedorStr}</td>
        <td>
          <button class="btn-reserva"
                  data-destino="${servicio.destino}"
                  data-actividad="${servicio.nombre}"
                  data-proveedor="${servicio.proveedor}">
            ${textoBtn}
          </button>
        </td>`;
  
  // ——— 5.8) dentro de rowsHTML, ahora con conteo de grupos
  fechasOrdenadas.forEach(fecha => {
    // 1️⃣ Total de pasajeros para esta actividad en esta fecha
    const totalPax = grupos.reduce((sum, g) => {
      return sum + (g.itinerario?.[fecha]||[])
        .filter(a => a.actividad === servicio.nombre)
        .reduce((s2, a) =>
          s2 + (parseInt(a.adultos)||0) + (parseInt(a.estudiantes)||0)
        , 0);
    }, 0);
  
    // 2️⃣ Número de grupos que tienen al menos 1 pax en esa actividad/fecha
    const groupCount = grupos.filter(g =>
      (g.itinerario?.[fecha]||[]).some(a => a.actividad === servicio.nombre)
    ).length;
  
    // 3️⃣ Mostramos "210 (5)" por ejemplo
    fila += `
      <td class="celda-interactiva"
          data-info='${JSON.stringify({ actividad: servicio.nombre, fecha })}'
          style="cursor:pointer;color:#0055a4;text-decoration:underline;">
        ${totalPax} (${groupCount})
      </td>`;
  });
  
    return fila + '</tr>';
  }).join('');
  
  // ⑤ volcamos TODO de una sola vez
  tbody.innerHTML = rowsHTML;

  // ——— 5.9) Delegación de eventos en <tbody>
  tbody.addEventListener('click', e => {
    // si clic en botón RESERVA
    if (e.target.matches('.btn-reserva')) {
      abrirModalReserva({ currentTarget: e.target });
    }
    // si clic en celda interactiva
    const celda = e.target.closest('.celda-interactiva');
    if (celda) {
      const { actividad, fecha } = JSON.parse(celda.dataset.info);
      mostrarGruposCoincidentes(actividad, fecha);
    }
  });

  // ——— 5.10 Inicializar DataTables con filtros y búsqueda
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

  // ——— 5.11 Botones dentro del modal de Reserva
  document.getElementById('btnCerrarReserva').onclick = () => {
    document.getElementById('modalReserva').style.display = 'none';
  };
  document.getElementById('btnGuardarPendiente').onclick = guardarPendiente;
  document.getElementById('btnEnviarReserva').onclick = enviarReserva;
} // ← fin init()

async function abrirModalReserva(event) {
  const btn       = event.currentTarget;
  const destino   = btn.dataset.destino;
  const actividad = btn.dataset.actividad;
  const fecha = fechasOrdenadas.find(f =>
    (grupos.some(g =>
      g.itinerario?.[f]?.some(a=>a.actividad===actividad)
    ))
  );
  const proveedor = btn.dataset.proveedor;

  // 1️⃣ rellenar "Para:" y "Asunto:"
  // provInfo viene de un mapa global `proveedores[actividad]`
  const provInfo  = proveedores[proveedor] || { contacto:'', correo:'' };
  document.getElementById('modalPara').value   = provInfo.correo;
  document.getElementById('modalAsunto').value = `Reserva: ${actividad} en ${destino}`;
  
  // ——— 2️⃣ generar el cuerpo del email con totales y coordinadores ———
  //  a) prefiltrar fechas que tengan pasajeros para esta actividad
  const perDateData = fechasOrdenadas
    .map(fecha => {
      const lista = grupos.filter(g =>
        (g.itinerario?.[fecha]||[]).some(a => a.actividad === actividad)
      );
      const paxTotal = lista.reduce(
        (sum, g) => sum + (parseInt(g.cantidadgrupo)||0),
        0
      );
      return { fecha, lista, paxTotal, coordinators: lista.length };
    })
    .filter(d => d.lista.length > 0);

  //  b) total global de pax
  const totalGlobal = perDateData.reduce((sum, d) => sum + d.paxTotal, 0);

  //  c) construir cuerpo
  let cuerpo = `Estimado/a ${provInfo.contacto}:\n\n`;
  cuerpo += `A continuación se envía detalle de reserva para:\n\n`;
  cuerpo += `Actividad: ${actividad}\n`;
  cuerpo += `Destino: ${destino}\n`;
  cuerpo += `Total PAX: (${totalGlobal})\n\n`;
  cuerpo += `Fechas y grupos:\n\n`;

  perDateData.forEach(({ fecha, lista, paxTotal, coordinators }) => {
    cuerpo += `➡️ Fecha ${formatearFechaBonita(fecha)} - Cantidad Total (${paxTotal}) - Cantidad Coordinadores (${coordinators}):\n\n`;
    lista.forEach(g => {
      cuerpo += `  - N°: ${g.id}, Colegio: ${g.nombreGrupo}, Cantidad de Pax: ${g.cantidadgrupo}\n`;
    });
    cuerpo += `\n`;
  });

  cuerpo += `Atte.\nOperaciones RaiTrai`;

  // ——— 3️⃣ vuelca en el textarea y muestra modal ———
  document.getElementById('modalCuerpo').value = cuerpo;

  // ←––– AÑADE ESTAS LÍNEAS antes de mostrar el modal:
  const btnPend = document.getElementById('btnGuardarPendiente');
  btnPend.dataset.destino   = destino;
  btnPend.dataset.actividad = actividad;
  btnPend.dataset.fecha     = fecha;  

  const btnEnv = document.getElementById('btnEnviarReserva');
  btnEnv.dataset.destino    = destino;
  btnEnv.dataset.actividad  = actividad;
  
  // 4️⃣ finalmente muestra el modal
  document.getElementById('modalReserva').style.display = 'block';
}

// —————————————————————————————————————————————
// Función: guardarPendiente — marca como PENDIENTE en Firestore
// —————————————————————————————————————————————
async function guardarPendiente() {
  // en lugar de parsear el asunto y buscar el botón original:
  const btn      = document.getElementById('btnGuardarPendiente');
  const destino  = btn.dataset.destino;
  const actividad= btn.dataset.actividad;
  const fecha     = btn.dataset.fecha;
  const cuerpo   = document.getElementById('modalCuerpo').value;
 
  const ref = doc(db, 'Servicios', destino, 'Listado', actividad);
  await updateDoc(ref, {
    [`reservas.${fecha}`]: { estado: 'PENDIENTE', cuerpo }
  });

  // actualizo el texto del botón CREAR
  document.querySelector(`.btn-reserva[data-actividad="${actividad}"]`)
          .textContent = 'PENDIENTE';

    // ←––––– aquí cierras el modal
  document.getElementById('modalReserva').style.display = 'none';  
}

/**
 * Dispara mailto y guarda ENVIADA **todas** las fechas
 */
  async function enviarReserva() {
    const btn       = document.getElementById('btnEnviarReserva');
    const destino   = btn.dataset.destino;
    const actividad = btn.dataset.actividad;
    const para      = document.getElementById('modalPara').value;
    const asunto    = document.getElementById('modalAsunto').value;
    const cuerpo    = document.getElementById('modalCuerpo').value;
  
    // ——— Abrir Gmail Web en nueva pestaña ———
    const baseUrl = 'https://mail.google.com/mail/u/0/?view=cm&fs=1';
    const params = [
      `to=${encodeURIComponent(para)}`,
      `su=${encodeURIComponent(asunto)}`,
      `body=${encodeURIComponent(cuerpo)}`
    ].join('&');
    window.open(`${baseUrl}&${params}`, '_blank');
  
    // ——— Luego guardas “ENVIADA” en Firestore igual que antes ———
    for (const f of fechasOrdenadas) {
      if (grupos.some(g =>
        (g.itinerario?.[f]||[]).some(a => a.actividad === actividad)
      )) {
        const ref = doc(db, 'Servicios', destino, 'Listado', actividad);
        await updateDoc(ref, {
          [`reservas.${f}`]: {
            estado: 'ENVIADA',
            cuerpo,
            totalEnviado: totalGlobal   // <-- guardamos el total que enviamos
          }
        });
      }
    }
  
    // Actualizas el botón y cierras modal
    document.querySelector(`.btn-reserva[data-actividad="${actividad}"]`)
            .textContent = 'ENVIADA';
    document.getElementById('modalReserva').style.display = 'none';
  }

// —————————————————————————————————————————————
// Función: mostrarGruposCoincidentes — modal detalle grupos
// —————————————————————————————————————————————
function mostrarGruposCoincidentes(actividad, fecha) {
  // 1️⃣ Filtramos los grupos que coinciden
  const lista = grupos
    .filter(g => (g.itinerario?.[fecha] || [])
      .some(a => a.actividad === actividad)
    )
    .map(g => ({
      numeroNegocio: g.id,
      nombreGrupo:   g.nombreGrupo,
      cantidadgrupo: g.cantidadgrupo,
      programa:      g.programa
    }));

  // 2️⃣ Calculamos totales
  const totalGrupos = lista.length;
  const totalPAX = lista.reduce((sum, g) =>
    sum + (parseInt(g.cantidadgrupo, 10) || 0)
  , 0);

  // 3️⃣ Actualizamos el título del modal con la fecha formateada
  document.querySelector('#modalDetalle h3').textContent =
    `Detalle de grupos para el día ${formatearFechaBonita(fecha)} — Total PAX: ${totalPAX} — Total Grupos: ${totalGrupos}`;

  // 4️⃣ Rellenamos la tabla
  const tb = document.querySelector('#tablaModal tbody');
  tb.innerHTML = '';
  if (!lista.length) {
    tb.innerHTML = `
      <tr>
        <td colspan="4" style="text-align:center;">Sin datos</td>
      </tr>`;
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

  // 5️⃣ Mostramos el modal
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
