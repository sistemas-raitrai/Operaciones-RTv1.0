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
        proveedor: data.proveedor || data.Proveedor || ''
      });
    });
  }

  // ——— 5.3) Leer TODOS los proveedores de **todas** las regiones
  const proveedoresLocal = {};
  //  a) lee cada documento de nivel región en "Proveedores"
  const regionesSnap = await getDocs(collection(db, 'Proveedores'));
  for (const regionDoc of regionesSnap.docs) {
    const region = regionDoc.id; // p.ej. "SUR DE CHILE", "BRASIL", etc.
    const listadoSnap = await getDocs(
      collection(db, 'Proveedores', region, 'Listado')
    );
    listadoSnap.docs.forEach(pSnap => {
      const d = pSnap.data();
      if (d.proveedor) {
        proveedoresLocal[d.proveedor] = {
          contacto: d.contacto || '',
          correo:   d.correo   || ''
        };
      }
    });
  }
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

  // ——— 5.5) Generar <thead> dinámico (incluye columna Reserva) con data-fecha
  thead.innerHTML = `
    <tr>
      <th class="sticky-col sticky-header">Actividad</th>
      <th>Destino</th>
      <th>Proveedor</th>
      <th>Reserva</th>
      ${fechasOrdenadas.map(f => `<th data-fecha="${f}">${formatearFechaBonita(f)}</th>`).join('')}
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

  // Normaliza strings para que la búsqueda no considere tildes (á->a, ñ->n, etc.)
  function stripAccents(s) {
    return (s || '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }
  // Hace que DataTables compare datos normalizados
  $.fn.dataTable.ext.type.search.string = function (d) {
    return stripAccents(d);
  };


  // ——— 5.10 Inicializar DataTables con filtros, búsqueda sin tildes y botones
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
      {
        extend: 'excelHtml5',
        text: 'Descargar Excel',
        exportOptions: {
          // Solo lo que está visible/filtrado
          columns: ':visible',
          modifier: { search: 'applied' }
        }
      },
      {
        text: 'Estadísticas',
        action: () => abrirModalEstadisticas(table)
      }
    ],
    initComplete: function () {
      const api = this.api();
  
      // Poblado dinámico del filtroDestino (columna 1) según filas filtradas al inicio
      new Set(api.column(1).data().toArray())
        .forEach(d => $('#filtroDestino').append(new Option(d, d)));
  
      // Buscador multi-término ignorando tildes
      $('#buscador').on('keyup', () => {
        const val = stripAccents($('#buscador').val());
        const terms = val.split(/[,;]+/).map(t => t.trim()).filter(Boolean);
        // Construimos regex AND (términos separados por coma) usando lookahead
        const rex = terms.length
          ? terms.map(t => `(?=.*${t.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')})`).join('')
          : '';
        api.search(rex, true, false).draw();
      });
  
      // Filtro por destino (coincidencia exacta)
      $('#filtroDestino').on('change', () => {
        const v = $('#filtroDestino').val();
        api.column(1).search(v || '', true, false).draw();
      });
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

  console.log('🛈 abrirModalReserva:', { destino, actividad, proveedor });
  console.log('🛈 proveedores disponibles:', proveedores);

  // 1️⃣ rellenar "Para:" y "Asunto:"
  // provInfo viene de un mapa global `proveedores[actividad]`
  const provInfo  = proveedores[proveedor] || { contacto:'', correo:'' };
  document.getElementById('modalPara').value   = provInfo.correo;
  document.getElementById('modalAsunto').value = `Reserva: ${actividad} en ${destino}`;
  
  // ——— 2️⃣ generar el cuerpo del email (totales + conteo de grupos) ———
  //  a) prefiltrar fechas que tengan pasajeros para esta actividad
  const perDateData = fechasOrdenadas
    .map(fecha => {
      const lista = grupos.filter(g =>
        (g.itinerario?.[fecha] || []).some(a => a.actividad === actividad)
      );
      const paxTotal = lista.reduce(
        (sum, g) => sum + (parseInt(g.cantidadgrupo) || 0),
        0
      );
      return { fecha, lista, paxTotal };
    })
    .filter(d => d.lista.length > 0);
  
  //  b) totales globales
  const totalGlobal = perDateData.reduce((sum, d) => sum + d.paxTotal, 0);
  //    grupos únicos a través de TODAS las fechas
  const gruposUnicos = new Set();
  perDateData.forEach(({ lista }) => lista.forEach(g => gruposUnicos.add(g.id)));
  const totalGrupos = gruposUnicos.size;
  
  //  c) construir cuerpo
  let cuerpo = `Estimado/a ${provInfo.contacto || ''}:\n\n`;
  cuerpo += `A continuación se envía detalle de reserva para:\n\n`;
  cuerpo += `Actividad: ${actividad}\n`;
  cuerpo += `Destino: ${destino}\n`;
  cuerpo += `Total Grupos: (${totalGrupos})\n`;
  cuerpo += `Total PAX: (${totalGlobal})\n\n`;
  cuerpo += `Fechas y grupos:\n\n`;
  
  perDateData.forEach(({ fecha, lista, paxTotal }) => {
    cuerpo += `➡️ Fecha ${formatearFechaBonita(fecha)} - Grupos (${lista.length}) - PAX (${paxTotal}):\n\n`;
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
    const para      = document.getElementById('modalPara').value.trim();
    const asunto    = document.getElementById('modalAsunto').value.trim();
    const cuerpo    = document.getElementById('modalCuerpo').value;
  
    // 1) Abrir Gmail con el borrador
    const baseUrl = 'https://mail.google.com/mail/u/0/?view=cm&fs=1';
    const params  = [
      `to=${encodeURIComponent(para)}`,
      `su=${encodeURIComponent(asunto)}`,
      `body=${encodeURIComponent(cuerpo)}`
    ].join('&');
    window.open(`${baseUrl}&${params}`, '_blank');
  
    // 2) Construir el payload de actualización por cada fecha con pax>0
    try {
      const ref = doc(db, 'Servicios', destino, 'Listado', actividad);
      const payload = {};
  
      for (const f of fechasOrdenadas) {
        // Total de pax de ESTA actividad en ESTA fecha (adultos + estudiantes)
        const totalEnviado = grupos.reduce((sum, g) => {
          const acts = g.itinerario?.[f] || [];
          const t = acts
            .filter(a => a.actividad === actividad)
            .reduce((acc, a) => acc + ((parseInt(a.adultos)||0) + (parseInt(a.estudiantes)||0)), 0);
          return sum + t;
        }, 0);
  
        if (totalEnviado > 0) {
          payload[`reservas.${f}`] = {
            estado: 'ENVIADA',
            cuerpo,
            totalEnviado
          };
        }
      }
  
      // Si hay algo que guardar, lo guardamos de una
      if (Object.keys(payload).length > 0) {
        await updateDoc(ref, payload);
      }
  
      // 3) Actualizar UI y cerrar modal
      const boton = document.querySelector(
        `.btn-reserva[data-actividad="${actividad}"][data-destino="${destino}"]`
      );
      if (boton) boton.textContent = 'ENVIADA';
  
      document.getElementById('modalReserva').style.display = 'none';
    } catch (err) {
      console.error('Error al guardar ENVIADA por fecha:', err);
      alert('No se pudo guardar el estado ENVIADA en Firestore. Revisa la consola.');
    }
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

// ========== ESTADÍSTICAS ==========
function getContextoVisible(table) {
  // 1) Actividades/destinos visibles (filas filtradas)
  const rows = table.rows({ search: 'applied' }).nodes().toArray();
  const pares = rows.map(row => {
    const c0 = row.cells[0]?.textContent?.trim() || '';
    const c1 = row.cells[1]?.textContent?.trim() || '';
    return { actividad: c0, destino: c1, key: `${c0}|||${c1}` };
  });
  // deduplicar
  const map = new Map();
  pares.forEach(p => { if (!map.has(p.key)) map.set(p.key, p); });

  // 2) Fechas visibles (columnas visibles con data-fecha)
  const fechasVisibles = [];
  table.columns().every(function () {
    const col = this;
    const th = col.header();
    const iso = th?.dataset?.fecha;
    if (iso && col.visible()) fechasVisibles.push(iso);
  });

  return {
    paresVisibles: Array.from(map.values()), // [{actividad, destino}]
    fechasVisibles,                          // ['YYYY-MM-DD', ...]
    actividadesSet: new Set(Array.from(map.values()).map(p => p.actividad))
  };
}

function sumarPaxDeActividadEnFechas(g, actividad, fechas) {
  let total = 0;
  for (const f of fechas) {
    const acts = g.itinerario?.[f] || [];
    total += acts
      .filter(a => a.actividad === actividad)
      .reduce((s, a) => s + ((parseInt(a.adultos)||0) + (parseInt(a.estudiantes)||0)), 0);
  }
  return total;
}

function abrirModalEstadisticas(table) {
  const ctx = getContextoVisible(table);
  // Si no hay nada visible, mostramos aviso
  if (!ctx.paresVisibles.length || !ctx.fechasVisibles.length) {
    alert('No hay actividades o fechas visibles para calcular.');
    return;
  }

  // Pintar secciones base
  pintarStatsActividad(ctx);
  pintarStatsFecha(ctx);
  // Combinaciones (default: incluye + viaje, nivel 3)
  recalcularCombinaciones(ctx);

  // Eventos UI
  document.getElementById('btnRecalcularStats').onclick = () => recalcularCombinaciones(ctx);
  document.getElementById('btnCerrarStats').onclick = () => {
    document.getElementById('modalEstadisticas').style.display = 'none';
  };

  // Mostrar
  document.getElementById('modalEstadisticas').style.display = 'block';
}

function pintarStatsActividad(ctx) {
  const tbody = document.getElementById('statsActividadBody');
  tbody.innerHTML = '';
  let totalPax = 0;
  const gruposUnicos = new Set();

  ctx.paresVisibles.forEach(({ actividad, destino }) => {
    let pax = 0;
    const gSet = new Set();
    for (const g of grupos) {
      const t = sumarPaxDeActividadEnFechas(g, actividad, ctx.fechasVisibles);
      if (t > 0) { pax += t; gSet.add(g.id); }
    }
    totalPax += pax;
    gSet.forEach(id => gruposUnicos.add(id));

    const btn = `<button class="ver-grupos" data-ids="${Array.from(gSet).join(',')}" data-titulo="Grupos — ${actividad} (${destino})">Ver grupos</button>`;
    tbody.insertAdjacentHTML('beforeend', `
      <tr>
        <td>${actividad}</td>
        <td>${destino}</td>
        <td>${pax}</td>
        <td>${gSet.size}</td>
        <td>${btn}</td>
      </tr>
    `);
  });

  // totales
  document.getElementById('statsActividadTotalPax').textContent = totalPax;
  document.getElementById('statsActividadTotalGrupos').textContent = gruposUnicos.size;

  // Delegación de Ver grupos
  tbody.onclick = (e) => {
    const b = e.target.closest('.ver-grupos');
    if (!b) return;
    const ids = (b.dataset.ids || '').split(',').filter(Boolean);
    mostrarListaDeGrupos(ids, b.dataset.titulo || 'Grupos');
  };
}

function pintarStatsFecha(ctx) {
  const tbody = document.getElementById('statsFechaBody');
  tbody.innerHTML = '';

  // Conjunto de actividades visibles (ignoramos destino para conteos)
  const actsVisibles = ctx.actividadesSet;

  ctx.fechasVisibles.forEach(fecha => {
    let pax = 0;
    const gSet = new Set();

    for (const g of grupos) {
      const acts = g.itinerario?.[fecha] || [];
      const t = acts
        .filter(a => actsVisibles.has(a.actividad))
        .reduce((s, a) => s + ((parseInt(a.adultos)||0) + (parseInt(a.estudiantes)||0)), 0);
      if (t > 0) { pax += t; gSet.add(g.id); }
    }

    const btn = `<button class="ver-grupos" data-ids="${Array.from(gSet).join(',')}" data-titulo="Grupos — ${formatearFechaBonita(fecha)}">Ver grupos</button>`;
    tbody.insertAdjacentHTML('beforeend', `
      <tr>
        <td>${formatearFechaBonita(fecha)}</td>
        <td>${pax}</td>
        <td>${gSet.size}</td>
        <td>${btn}</td>
      </tr>
    `);
  });

  tbody.onclick = (e) => {
    const b = e.target.closest('.ver-grupos');
    if (!b) return;
    const ids = (b.dataset.ids || '').split(',').filter(Boolean);
    mostrarListaDeGrupos(ids, b.dataset.titulo || 'Grupos');
  };
}

function recalcularCombinaciones(ctx) {
  const modo = (document.getElementById('modoCombinacion').value || 'incluye'); // incluye | exacto
  const alcance = (document.getElementById('alcanceCombinacion').value || 'viaje'); // viaje | dia
  const kMax = parseInt(document.getElementById('nivelMax').value || '3', 10);

  // Actividades que realmente tienen presencia (>0 pax) en fechas visibles
  const actividadesPresentes = Array.from(ctx.actividadesSet).filter(act => {
    for (const g of grupos) {
      if (sumarPaxDeActividadEnFechas(g, act, ctx.fechasVisibles) > 0) return true;
    }
    return false;
  });

  // Generamos combinaciones tamaño 2..kMax
  const combos = [];
  for (let k = 2; k <= Math.min(kMax, actividadesPresentes.length); k++) {
    combos.push(...generarCombinaciones(actividadesPresentes, k));
  }

  // Pre-cálculos por grupo
  const actsPorGrupoViaje = new Map();    // id -> Set(acts visibles en fechas visibles)
  const actsPorGrupoPorDia = new Map();   // id -> {fecha -> Set(acts)}

  for (const g of grupos) {
    const setViaje = new Set();
    const porDia = {};
    for (const f of ctx.fechasVisibles) {
      const setDia = new Set((g.itinerario?.[f] || [])
        .filter(a => ctx.actividadesSet.has(a.actividad))
        .map(a => a.actividad));
      if (setDia.size) porDia[f] = setDia;
      setDia.forEach(a => setViaje.add(a));
    }
    actsPorGrupoViaje.set(g.id, setViaje);
    actsPorGrupoPorDia.set(g.id, porDia);
  }

  const cuerpo = document.getElementById('statsCombosBody');
  cuerpo.innerHTML = '';

  combos.forEach(combo => {
    const comboSet = new Set(combo);
    const listaIds = [];

    for (const g of grupos) {
      const ok = (alcance === 'viaje')
        ? cumpleEnViaje(actsPorGrupoViaje.get(g.id), comboSet, modo)
        : cumpleEnAlgúnDia(actsPorGrupoPorDia.get(g.id) || {}, comboSet, modo);
      if (ok) listaIds.push(g.id);
    }

    if (listaIds.length > 0) {
      const btn = `<button class="ver-grupos" data-ids="${listaIds.join(',')}" data-titulo="Grupos — ${combo.join(' + ')}">Ver grupos</button>`;
      cuerpo.insertAdjacentHTML('beforeend', `
        <tr>
          <td>${combo.join(' + ')}</td>
          <td>${listaIds.length}</td>
          <td>${btn}</td>
        </tr>
      `);
    }
  });

  cuerpo.onclick = (e) => {
    const b = e.target.closest('.ver-grupos');
    if (!b) return;
    const ids = (b.dataset.ids || '').split(',').filter(Boolean);
    mostrarListaDeGrupos(ids, b.dataset.titulo || 'Grupos');
  };

  // Helpers de combinación
  function cumpleEnViaje(setViaje, comboSet, modo) {
    if (!setViaje || setViaje.size === 0) return false;
    if (modo === 'incluye') {
      for (const a of comboSet) if (!setViaje.has(a)) return false;
      return true;
    } else { // exacto
      if (setViaje.size !== comboSet.size) return false;
      for (const a of comboSet) if (!setViaje.has(a)) return false;
      return true;
    }
  }

  function cumpleEnAlgúnDia(porDia, comboSet, modo) {
    const fechas = Object.keys(porDia);
    for (const f of fechas) {
      const setDia = porDia[f];
      if (!setDia || setDia.size === 0) continue;
      if (modo === 'incluye') {
        let ok = true;
        for (const a of comboSet) if (!setDia.has(a)) { ok = false; break; }
        if (ok) return true;
      } else { // exacto
        if (setDia.size !== comboSet.size) continue;
        let ok = true;
        for (const a of comboSet) if (!setDia.has(a)) { ok = false; break; }
        if (ok) return true;
      }
    }
    return false;
    }
}

function generarCombinaciones(arr, k) {
  const res = [];
  const n = arr.length;
  function backtrack(start, combo) {
    if (combo.length === k) { res.push([...combo]); return; }
    for (let i = start; i < n; i++) {
      combo.push(arr[i]);
      backtrack(i + 1, combo);
      combo.pop();
    }
  }
  backtrack(0, []);
  return res;
}

// Reusa tu modal de detalle para listas arbitrarias de IDs de grupo
function mostrarListaDeGrupos(ids, titulo) {
  const tb = document.querySelector('#tablaModal tbody');
  tb.innerHTML = '';
  const lista = grupos.filter(g => ids.includes(g.id));

  document.querySelector('#modalDetalle h3').textContent =
    `${titulo} — Total grupos: ${lista.length}`;

  if (!lista.length) {
    tb.innerHTML = `<tr><td colspan="4" style="text-align:center;">Sin datos</td></tr>`;
  } else {
    lista.forEach(g => {
      tb.insertAdjacentHTML('beforeend', `
        <tr>
          <td>${g.id}</td>
          <td>${g.nombreGrupo || ''}</td>
          <td>${g.cantidadgrupo || ''}</td>
          <td>${g.programa || ''}</td>
        </tr>
      `);
    });
  }
  document.getElementById('modalDetalle').style.display = 'block';
}
