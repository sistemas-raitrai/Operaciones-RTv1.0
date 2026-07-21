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
  updateDoc,
  serverTimestamp,
  query,
  where
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';
import {
  getAuth, onAuthStateChanged, signOut
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import { sincronizarPaxGrupoDesdePagos } from './pax-sync.js';

// ———————————————————————————————
// 2️⃣ Estado global
// ———————————————————————————————
let grupos = [];               // documentos de 'grupos'
let fechasOrdenadas = [];      // ['YYYY-MM-DD', ...] con pax > 0
let proveedores = {};          // mapa proveedor -> {contacto, correo}
let reservaActualSnapshot = null;
let ultimaVerificacionPagos = null;
let revisionCambiosReservaActiva = null;
const API_PAGOS_URL = '/api/pagos';
let anoContadorActivo = obtenerAnoComercialContador();

const DESTINOS_CONTADOR = [
  'BRASIL',
  'BARILOCHE',
  'SUR DE CHILE',
  'NORTE DE CHILE'
];

const CACHE_GRUPOS_CONTADOR = new Map();

let proveedoresCargadosContador = false;
let idCargaContador = 0;

function obtenerAnoComercialContador(fecha = new Date()) {
  const ano = fecha.getFullYear();
  const mes = fecha.getMonth() + 1; // enero = 1

  // Año comercial cambia el 1 de marzo
  return mes >= 3 ? String(ano) : String(ano - 1);
}

function getAnoContadorActivo() {
  const sel = document.getElementById('filtroAnoContador');
  return String(sel?.value || anoContadorActivo || obtenerAnoComercialContador());
}

function actualizarProgresoContador(
  porcentaje,
  mensaje,
  visible = true
) {
  const contenedor =
    document.getElementById('cargaContador');

  const barra =
    document.getElementById('cargaContadorBarra');

  const texto =
    document.getElementById('cargaContadorTexto');

  const porcentajeEl =
    document.getElementById('cargaContadorPorcentaje');

  if (!contenedor || !barra || !texto || !porcentajeEl) {
    return;
  }

  const valor = Math.max(
    0,
    Math.min(100, Number(porcentaje) || 0)
  );

  contenedor.style.display =
    visible ? 'block' : 'none';

  barra.style.width = `${valor}%`;
  texto.textContent = mensaje || '';
  porcentajeEl.textContent = `${Math.round(valor)}%`;
}

function ocultarProgresoContador(demora = 0) {
  window.setTimeout(() => {
    const contenedor =
      document.getElementById('cargaContador');

    if (contenedor) {
      contenedor.style.display = 'none';
    }
  }, demora);
}

function mostrarErrorCargaContador(error) {
  const mensaje =
    error?.message || String(error);

  actualizarProgresoContador(
    100,
    `No fue posible cargar el contador: ${mensaje}`
  );

  const barra =
    document.getElementById('cargaContadorBarra');

  const texto =
    document.getElementById('cargaContadorTexto');

  if (barra) {
    barra.style.background = '#b42318';
  }

  if (texto) {
    texto.style.color = '#9d1c13';
  }
}

function restaurarEstiloProgresoContador() {
  const barra =
    document.getElementById('cargaContadorBarra');

  const texto =
    document.getElementById('cargaContadorTexto');

  if (barra) {
    barra.style.background = '#2b73b9';
  }

  if (texto) {
    texto.style.color = '#24496d';
  }
}

function refServicioContador(destino, actividad) {
  // Opción B:
  // Las reservas, snapshots, verificaciones e historial operacional
  // siguen viviendo en la colección antigua Servicios.
  return doc(db, 'Servicios', destino, 'Listado', actividad);
}

function limpiarTablaContadorSiExiste() {
  if ($.fn.DataTable.isDataTable('#tablaConteo')) {
    $('#tablaConteo').DataTable().destroy();
  }

  thead.innerHTML = '';
  tbody.innerHTML = '';

  $('#buscador').off('.contador');
}

function normalizarActividadReserva(txt = '') {
  return String(txt || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function actividadCoincideReserva(a, actividad) {
  return normalizarActividadReserva(a?.actividad) === normalizarActividadReserva(actividad);
}

function normalizarDestinoContador(valor = '') {
  return String(valor || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function grupoCoincideDestinoContador(
  grupo,
  destinoSeleccionado
) {
  if (
    !destinoSeleccionado ||
    destinoSeleccionado === '__TODOS__'
  ) {
    return true;
  }

  return (
    normalizarDestinoContador(grupo?.destino) ===
    normalizarDestinoContador(destinoSeleccionado)
  );
}

async function cargarGruposAnoContador(ano) {
  const claveCache = String(ano);

  if (CACHE_GRUPOS_CONTADOR.has(claveCache)) {
    return CACHE_GRUPOS_CONTADOR.get(claveCache);
  }

  const anoNumero = Number(ano);
  const anoTexto = String(ano);

  const consultas = [
    getDocs(
      query(
        collection(db, 'grupos'),
        where('anoViaje', '==', anoNumero)
      )
    ),

    getDocs(
      query(
        collection(db, 'grupos'),
        where('anoViaje', '==', anoTexto)
      )
    )
  ];

  const [snapNumero, snapTexto] =
    await Promise.all(consultas);

  const mapa = new Map();

  [...snapNumero.docs, ...snapTexto.docs].forEach(docSnap => {
    mapa.set(docSnap.id, {
      id: docSnap.id,
      ...docSnap.data()
    });
  });

  const resultado = Array.from(mapa.values());

  CACHE_GRUPOS_CONTADOR.set(
    claveCache,
    resultado
  );

  return resultado;
}

async function cargarProveedoresContador() {
  if (proveedoresCargadosContador) {
    return proveedores;
  }

  const proveedoresLocal = {};

  const regionesSnap = await getDocs(
    collection(db, 'Proveedores')
  );

  const resultadosRegiones = await Promise.all(
    regionesSnap.docs.map(regionDoc =>
      getDocs(
        collection(
          db,
          'Proveedores',
          regionDoc.id,
          'Listado'
        )
      )
    )
  );

  resultadosRegiones.forEach(listadoSnap => {
    listadoSnap.docs.forEach(pSnap => {
      const data = pSnap.data() || {};

      if (!data.proveedor) return;

      proveedoresLocal[data.proveedor] = {
        contacto: data.contacto || '',
        correo: data.correo || ''
      };
    });
  });

  proveedores = proveedoresLocal;
  proveedoresCargadosContador = true;

  return proveedores;
}

async function cargarServiciosContador(
  ano,
  destinoSeleccionado
) {
  const destinos = destinoSeleccionado === '__TODOS__'
    ? [...DESTINOS_CONTADOR]
    : [destinoSeleccionado];

  const servicios = [];

  const resultados = await Promise.all(
    destinos.map(async destino => {
      const [opSnap, listadoSnap] =
        await Promise.all([
          getDocs(
            collection(
              db,
              'Servicios',
              destino,
              'Listado'
            )
          ),

          getDocs(
            collection(
              db,
              'ServiciosPorAno',
              String(ano),
              'Destinos',
              destino,
              'Listado'
            )
          )
        ]);

      const reservasDestino = new Map();

      opSnap.docs.forEach(docSnap => {
        const data = docSnap.data() || {};

        reservasDestino.set(
          docSnap.id,
          data.reservas || {}
        );
      });

      return listadoSnap.docs.map(sDoc => {
        const data = sDoc.data() || {};

        const nombreServicio =
          data.servicio || sDoc.id;

        const proveedorServicio =
          data.proveedor ||
          data.Proveedor ||
          '';

        return {
          destino,
          nombre: nombreServicio,
          proveedor: proveedorServicio,
          reservas:
            reservasDestino.get(nombreServicio) ||
            reservasDestino.get(sDoc.id) ||
            {}
        };
      });
    })
  );

  resultados.forEach(lista => {
    servicios.push(...lista);
  });

  return servicios;
}

async function recargarGruposContador(ids) {
  const setIds = new Set(ids.map(String));

  const actualizados = await Promise.all(
    Array.from(setIds).map(async id => {
      const snap = await getDoc(doc(db, 'grupos', id));
      return snap.exists() ? { id: snap.id, ...snap.data() } : null;
    })
  );

  const mapActualizados = new Map(
    actualizados.filter(Boolean).map(g => [String(g.id), g])
  );

  grupos = grupos.map(g => mapActualizados.get(String(g.id)) || g);
}

async function sincronizarGruposReservaConPagos(actividad) {
  const ids = grupos
    .filter(g =>
      Object.values(g.itinerario || {}).some(acts =>
        (acts || []).some(a => actividadCoincideReserva(a, actividad))
      )
    )
    .map(g => g.id);

  if (!ids.length) return [];

  const resultados = [];

  for (const grupoId of ids) {
    try {
      const r = await sincronizarPaxGrupoDesdePagos(grupoId);
      resultados.push(r);
    } catch (error) {
      console.error('Error sincronizando PAX con pagos:', grupoId, error);
      resultados.push({
        ok: false,
        grupoId,
        error: error.message || String(error)
      });
    }
  }

  await recargarGruposContador(ids);

  return resultados;
}

// ———————————————————————————————
// 3️⃣ Referencias DOM
// ———————————————————————————————
const thead = document.getElementById('thead-actividades');
const tbody = document.getElementById('tbody-actividades');

// ———————————————————————————————
// 4️⃣ Sesión Firebase
// ———————————————————————————————
const auth = getAuth(app);
onAuthStateChanged(auth, user => {
  if (!user) location.href = 'login.html';
  else init();
});
document.getElementById('logoutBtn')?.addEventListener('click', () => signOut(auth));

// —————————————————————————————————————————————————————
// 5️⃣ Init: carga datos y arma tabla
// —————————————————————————————————————————————————————
async function init() {
  const cargaActual = ++idCargaContador;
  const timerCarga = `CONTADOR carga total ${cargaActual}`;

  console.time(timerCarga);

  restaurarEstiloProgresoContador();
  try {
    limpiarTablaContadorSiExiste();

    const selectorAno =
      document.getElementById('filtroAnoContador');

    const selectorDestino =
      document.getElementById('filtroDestino');

    if (selectorAno) {
      selectorAno.value = anoContadorActivo;

      selectorAno.onchange = () => {
        anoContadorActivo = selectorAno.value;
        init();
      };
    }

    if (selectorDestino) {
      selectorDestino.onchange = () => {
        init();
      };
    }

    const anoComercial =
      getAnoContadorActivo();

    const destinoSeleccionado =
      selectorDestino?.value || '';

    if (!destinoSeleccionado) {
      grupos = [];
      fechasOrdenadas = [];
    
      actualizarProgresoContador(
        0,
        `Año ${anoComercial}: selecciona un destino para cargar la información.`
      );
    
      console.timeEnd(timerCarga);
      return;
    }

    actualizarProgresoContador(
      5,
      `Preparando año ${anoComercial}...`
    );

    /*
     * 1. Grupos del año.
     * Se consultan tanto el número 2026 como el texto "2026".
     */
    actualizarProgresoContador(
      15,
      `Cargando grupos del año ${anoComercial}...`
    );

    const gruposAno =
      await cargarGruposAnoContador(
        anoComercial
      );

    if (cargaActual !== idCargaContador) {
      console.timeEnd(timerCarga);
      return;
    }

    grupos = gruposAno.filter(grupo =>
      grupoCoincideDestinoContador(
        grupo,
        destinoSeleccionado
      )
    );

    actualizarProgresoContador(
      35,
      destinoSeleccionado === '__TODOS__'
        ? `Grupos cargados. Cargando todos los destinos...`
        : `Grupos cargados. Cargando ${destinoSeleccionado}...`
    );

    /*
     * 2. Servicios y proveedores.
     * Se ejecutan simultáneamente.
     */
    const [
      serviciosCargados
    ] = await Promise.all([
      cargarServiciosContador(
        anoComercial,
        destinoSeleccionado
      ),

      cargarProveedoresContador()
    ]);

    if (cargaActual !== idCargaContador) {
      console.timeEnd(timerCarga);
      return;
    }

    const servicios = serviciosCargados;

    actualizarProgresoContador(
      60,
      'Calculando fechas y actividades...'
    );

    /*
     * 3. Fechas vigentes según los grupos cargados.
     */
    const fechasSet = new Set();

    grupos.forEach(grupo => {
      const itinerario =
        grupo.itinerario || {};

      Object.entries(itinerario).forEach(
        ([fecha, actividades]) => {
          const tienePax = (actividades || []).some(
            actividad =>
              (parseInt(actividad.adultos) || 0) +
              (parseInt(actividad.estudiantes) || 0) >
              0
          );

          if (tienePax) {
            fechasSet.add(fecha);
          }
        }
      );
    });

    fechasOrdenadas =
      Array.from(fechasSet).sort();

    servicios.sort((a, b) =>
      `${a.destino} ${a.nombre}`.localeCompare(
        `${b.destino} ${b.nombre}`,
        'es',
        { sensitivity: 'base' }
      )
    );

    const todosLosReservas =
      servicios.map(servicio =>
        servicio.reservas || {}
      );

    actualizarProgresoContador(
      75,
      `Construyendo tabla de ${servicios.length} actividades...`
    );

    thead.innerHTML = `
      <tr>
        <th class="sticky-col sticky-header">
          Actividad
        </th>
        <th>Destino</th>
        <th>Proveedor</th>
        <th>Reserva</th>
        ${fechasOrdenadas
          .map(fecha => `
            <th data-fecha="${fecha}">
              ${formatearFechaBonita(fecha)}
            </th>
          `)
          .join('')}
      </tr>
    `;

    const rowsHTML = servicios
      .map((servicio, indice) => {
        const reservas =
          todosLosReservas[indice];

        const fechasConPax =
          fechasOrdenadas.filter(fecha =>
            grupos.some(grupo =>
              (grupo.itinerario?.[fecha] || [])
                .some(actividad =>
                  actividadCoincideReserva(
                    actividad,
                    servicio.nombre
                  )
                )
            )
          );

        const textoBtn =
          obtenerTextoBotonReserva(
            reservas,
            fechasConPax
          );

        const requiereRevisionInicial =
          textoBtn === 'REVISAR CAMBIOS';
        
        const claseFila =
          requiereRevisionInicial
            ? 'fila-revisar-cambios'
            : '';
        
        const claseCelda =
          requiereRevisionInicial
            ? 'celda-revisar-cambios'
            : '';

        const provInfo =
          proveedores[servicio.proveedor] || {};

        const proveedorStr =
          provInfo.contacto
            ? servicio.proveedor
            : '-';

        let fila = `
          <tr class="${claseFila}">
            <td class="sticky-col ${claseCelda}">
              ${servicio.nombre}
            </td>

            <td class="${claseCelda}">
              ${servicio.destino}
            </td>

            <td class="${claseCelda}">
              ${proveedorStr}
            </td>

            <td class="${claseCelda}">
              <button
                class="btn-reserva"
                data-destino="${servicio.destino}"
                data-actividad="${servicio.nombre}"
                data-proveedor="${servicio.proveedor}"
              >
                ${textoBtn}
              </button>
            </td>
        `;

        fechasOrdenadas.forEach(fecha => {
          const totalPax = grupos.reduce(
            (suma, grupo) => {
              const actividades =
                grupo.itinerario?.[fecha] || [];

              const totalActividad =
                actividades
                  .filter(actividad =>
                    actividadCoincideReserva(
                      actividad,
                      servicio.nombre
                    )
                  )
                  .reduce(
                    (subtotal, actividad) =>
                      subtotal +
                      (parseInt(actividad.adultos) || 0) +
                      (parseInt(actividad.estudiantes) || 0),
                    0
                  );

              return suma + totalActividad;
            },
            0
          );

          const cantidadGrupos =
            grupos.filter(grupo =>
              (grupo.itinerario?.[fecha] || [])
                .some(actividad =>
                  actividadCoincideReserva(
                    actividad,
                    servicio.nombre
                  )
                )
            ).length;

          fila += `
            <td
              class="celda-interactiva ${claseCelda}"
              data-info='${JSON.stringify({
                actividad: servicio.nombre,
                fecha
              })}'
              style="
                cursor:pointer;
                color:#0055a4;
                text-decoration:underline;
              "
            >
              ${totalPax} (${cantidadGrupos})
            </td>
          `;
        });

        return `${fila}</tr>`;
      })
      .join('');

    tbody.innerHTML = rowsHTML;

    actualizarProgresoContador(
      88,
      'Preparando filtros y tabla...'
    );

    /*
     * Se usa onclick para no acumular listeners
     * cada vez que cambia el año o el destino.
     */
    tbody.onclick = event => {
      if (event.target.matches('.btn-reserva')) {
        abrirModalReserva({
          currentTarget: event.target
        });
      }

      const celda =
        event.target.closest('.celda-interactiva');

      if (celda) {
        const { actividad, fecha } =
          JSON.parse(celda.dataset.info);

        mostrarGruposCoincidentes(
          actividad,
          fecha
        );
      }
    };

    function stripAccents(texto) {
      return String(texto || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
    }

    $.fn.dataTable.ext.type.search.string =
      data => stripAccents(data);

    const table =
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
          {
            extend: 'colvis',
            text: 'Ver columnas'
          },
          {
            extend: 'excelHtml5',
            text: 'Descargar Excel',
            exportOptions: {
              columns: ':visible',
              modifier: {
                search: 'applied'
              }
            }
          },
          {
            text: 'Estadísticas',
            action: () =>
              abrirModalEstadisticas(table)
          }
        ]
      });

    $('#buscador')
      .off('.contador')
      .on('keyup.contador', () => {
        const valor =
          stripAccents(
            $('#buscador').val()
          );

        const terminos = valor
          .split(/[,;]+/)
          .map(item => item.trim())
          .filter(Boolean);

        if (!terminos.length) {
          table.search('').draw();
          return;
        }

        const expresion =
          '(' +
          terminos
            .map(termino =>
              termino.replace(
                /[-[\]{}()*+?.,\\^$|#\s]/g,
                '\\$&'
              )
            )
            .join('|') +
          ')';

        table
          .search(expresion, true, false)
          .draw();
      });

    /*
     * Eventos de los modales.
     */
    document.getElementById(
      'btnCerrarReserva'
    ).onclick = () => {
      document.getElementById(
        'modalReserva'
      ).style.display = 'none';
    };

    document.getElementById(
      'btnGuardarPendiente'
    ).onclick = guardarPendiente;

    document.getElementById(
      'btnEnviarReserva'
    ).onclick = enviarReserva;

    const btnSincronizarPaxReserva =
      document.getElementById(
        'btnSincronizarPaxReserva'
      );

    if (btnSincronizarPaxReserva) {
      btnSincronizarPaxReserva.onclick =
        sincronizarPaxReservaManual;
    }

    document.getElementById(
      'btnVerificarPaxPagos'
    ).onclick = verificarPaxReservaConPagos;

    document.getElementById(
      'btnCerrarVerificacionPagos'
    ).onclick = () => {
      document.getElementById(
        'modalVerificacionPagos'
      ).style.display = 'none';
    };

    document.getElementById(
      'btnCerrarDetalleDiferenciaPagos'
    ).onclick = () => {
      document.getElementById(
        'modalDetalleDiferenciaPagos'
      ).style.display = 'none';
    };

    document.getElementById(
      'btnGuardarVerificacionPagos'
    ).onclick =
      abrirModalGuardarVerificacionPagos;

    document.getElementById(
      'btnCancelarGuardarVerificacion'
    ).onclick = () => {
      document.getElementById(
        'modalGuardarVerificacionPagos'
      ).style.display = 'none';
    };

    document.getElementById(
      'btnConfirmarGuardarVerificacion'
    ).onclick =
      guardarVerificacionPagosEnReserva;

    const btnActualizarModal =
      document.getElementById(
        'btnActualizarModal'
      );

    if (btnActualizarModal) {
      btnActualizarModal.onclick = () => {
        const estado =
          window.__ULTIMO_DETALLE_MODAL__;

        if (estado) {
          mostrarListaDeGrupos(
            estado.ids,
            estado.titulo,
            estado.dataset
          );
        }
      };
    }

    actualizarProgresoContador(
      100,
      `Tabla lista: ${servicios.length} actividades. Revisando cambios en segundo plano...`
    );

    console.timeEnd(timerCarga);

    /*
     * La revisión ocurre después de mostrar la tabla.
     */
    revisarCambiosReservasEnviadas(
      servicios,
      todosLosReservas,
      ({ actual, total }) => {
        if (cargaActual !== idCargaContador) {
          return;
        }

        const porcentajeRevision =
          total > 0
            ? Math.round(
                (actual / total) * 100
              )
            : 100;

        actualizarProgresoContador(
          porcentajeRevision,
          `Revisando reservas: ${actual} de ${total}...`
        );
      }
    )
      .then(() => {
        if (cargaActual !== idCargaContador) {
          return;
        }

        actualizarBotonesReservaTabla(
          servicios,
          todosLosReservas
        );

        actualizarProgresoContador(
          100,
          'Tabla y revisión de reservas listas.'
        );

        ocultarProgresoContador(1800);
      })
      .catch(error => {
        console.error(
          'Error revisando cambios de reservas:',
          error
        );

        actualizarProgresoContador(
          100,
          'Tabla lista. Algunas reservas no pudieron revisarse.'
        );

        ocultarProgresoContador(3500);
      });

  } catch (error) {
    console.error(
      'Error cargando contador:',
      error
    );

    console.timeEnd(timerCarga);

    mostrarErrorCargaContador(error);
  }
}

// —————————————————————————————————————————————
// 6️⃣ Reserva (abrir/guardar/enviar)
// —————————————————————————————————————————————
function construirSnapshotReservaPorFecha(destino, actividad, perDateData) {
  const fechas = perDateData.map(({ fecha, lista }) => {
    const gruposFecha = lista.map(g => {
      const acts = g.itinerario?.[fecha] || [];
      const actsActividad = acts.filter(a => actividadCoincideReserva(a, actividad));

      const adultosActividad = actsActividad.reduce(
        (s, a) => s + (parseInt(a.adultos) || 0),
        0
      );

      const estudiantesActividad = actsActividad.reduce(
        (s, a) => s + (parseInt(a.estudiantes) || 0),
        0
      );

      const paxActividad = adultosActividad + estudiantesActividad;

      return {
        id: g.id,
        numeroNegocio: g.numeroNegocio || g.id,
        nombreGrupo: g.nombreGrupo || '',
        paxCorreo: paxActividad,
        totalAdultosCorreo: adultosActividad,
        totalEstudiantesCorreo: estudiantesActividad,
        adultosCorreo: { M: 0, F: 0, O: adultosActividad },
        estudiantesCorreo: { M: 0, F: 0, O: estudiantesActividad }
      };
    });

    return {
      fecha,
      totalPax: gruposFecha.reduce((s, g) => s + Number(g.paxCorreo || 0), 0),
      totalAdultos: gruposFecha.reduce((s, g) => s + Number(g.totalAdultosCorreo || 0), 0),
      totalEstudiantes: gruposFecha.reduce((s, g) => s + Number(g.totalEstudiantesCorreo || 0), 0),
      grupos: gruposFecha
    };
  });

  const gruposMap = new Map();

  fechas.forEach(f => {
    f.grupos.forEach(g => {
      const key = g.numeroNegocio || g.id;

      if (!gruposMap.has(key)) {
        gruposMap.set(key, {
          ...g,
          fechas: [f.fecha]
        });
      } else {
        const actual = gruposMap.get(key);
        actual.paxCorreo += Number(g.paxCorreo || 0);
        actual.totalAdultosCorreo += Number(g.totalAdultosCorreo || 0);
        actual.totalEstudiantesCorreo += Number(g.totalEstudiantesCorreo || 0);
        actual.adultosCorreo.O += Number(g.totalAdultosCorreo || 0);
        actual.estudiantesCorreo.O += Number(g.totalEstudiantesCorreo || 0);
        actual.fechas.push(f.fecha);
      }
    });
  });

  return {
    destino,
    actividad,
    fechas,
    grupos: Array.from(gruposMap.values()),
    resumenLogistico: {
      totalFechas: fechas.length,
      totalGruposFecha: fechas.reduce((s, f) => s + f.grupos.length, 0),
      totalPax: fechas.reduce((s, f) => s + Number(f.totalPax || 0), 0),
      totalAdultos: fechas.reduce((s, f) => s + Number(f.totalAdultos || 0), 0),
      totalEstudiantes: fechas.reduce((s, f) => s + Number(f.totalEstudiantes || 0), 0)
    }
  };
}

function construirSnapshotReservaActual(destino, actividad) {
  const perDateData = fechasOrdenadas
    .map(fecha => {
      const lista = grupos.filter(g =>
        (g.itinerario?.[fecha] || []).some(a => actividadCoincideReserva(a, actividad))
      );

      return {
        fecha,
        lista
      };
    })
    .filter(d => d.lista.length > 0);

  return construirSnapshotReservaPorFecha(destino, actividad, perDateData);
}

function escapeHtmlReserva(txt = '') {
  return String(txt || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function obtenerFechasConPaxActividad(actividad) {
  return fechasOrdenadas.filter(fecha =>
    grupos.some(g =>
      (g.itinerario?.[fecha] || []).some(a => actividadCoincideReserva(a, actividad))
    )
  );
}

function deduplicarCambiosReserva(cambios = []) {
  const vistos = new Set();

  return cambios.filter(c => {
    const key = [
      c.tipo || '',
      c.tipoControl || '',
      c.fecha || '',
      c.numeroNegocio || '',
      c.nombreGrupo || '',
      c.detalle || '',
      c.diferencia?.pax ?? '',
      c.diferencia?.adultos ?? '',
      c.diferencia?.estudiantes ?? ''
    ].join('__');

    if (vistos.has(key)) return false;
    vistos.add(key);
    return true;
  });
}

function consolidarCambiosReserva(cambios = []) {
  const lista = deduplicarCambiosReserva(cambios);
  const usados = new Set();
  const consolidados = [];

  lista.forEach((c, idx) => {
    if (usados.has(idx)) return;

    if (c.tipo !== 'GRUPO_SALE_DE_FECHA') {
      return;
    }

    const entradaIdx = lista.findIndex((x, j) =>
      !usados.has(j) &&
      j !== idx &&
      x.tipo === 'GRUPO_ENTRA_A_FECHA' &&
      String(x.numeroNegocio || '') === String(c.numeroNegocio || '') &&
      String(x.nombreGrupo || '') === String(c.nombreGrupo || '')
    );

    if (entradaIdx >= 0) {
      const entrada = lista[entradaIdx];

      consolidados.push({
        tipo: 'GRUPO_CAMBIA_DE_FECHA',
        numeroNegocio: c.numeroNegocio,
        nombreGrupo: c.nombreGrupo,
        fechaAntes: c.fecha,
        fechaAhora: entrada.fecha,
        antes: c.antes,
        ahora: entrada.ahora,
        diferencia: entrada.diferencia,
        detalle: `Cambia de ${formatearFechaBonita(c.fecha)} a ${formatearFechaBonita(entrada.fecha)}`
      });

      usados.add(idx);
      usados.add(entradaIdx);
    }
  });

  lista.forEach((c, idx) => {
    if (!usados.has(idx)) {
      consolidados.push(c);
    }
  });

  return consolidados;
}

function textoCambioReserva(c) {
  const grupo = [c.numeroNegocio, c.nombreGrupo].filter(Boolean).join(' · ');
  const fecha = c.fecha ? formatearFechaBonita(c.fecha) : '';

  if (c.tipo === 'GRUPO_CAMBIA_DE_FECHA') {
    return `${grupo}: cambió de fecha ${formatearFechaBonita(c.fechaAntes)} → ${formatearFechaBonita(c.fechaAhora)}.`;
  }

  if (c.tipo === 'CAMBIO_PAGOS_GRUPO') {
    return `${grupo}: cambio en sistema de pagos (${c.detalle || 'PAX actualizado'}).`;
  }

  if (c.tipo === 'GRUPO_ENTRA_A_FECHA') {
    return `${fecha}: se agregó ${grupo} con ${c.ahora?.pax || 0} PAX.`;
  }

  if (c.tipo === 'GRUPO_SALE_DE_FECHA') {
    return `${fecha}: se quitó ${grupo}. Antes tenía ${c.antes?.pax || 0} PAX.`;
  }

  if (c.tipo === 'CAMBIO_PAX_EN_FECHA') {
    return `${fecha}: ${grupo} cambia (${c.detalle || 'PAX actualizado'}).`;
  }

  return `${fecha ? fecha + ': ' : ''}${grupo} ${c.detalle || 'cambio detectado'}`.trim();
}

function construirBloqueCambiosReserva(revisionCambios) {
  const cambios = consolidarCambiosReserva(revisionCambios?.cambios || []);
  if (!cambios.length) return '';

  return cambios
    .map(c => `- ${textoCambioReserva(c)}`)
    .join('\n');
}

function construirBloqueHistorialCambiosReserva(historial = []) {
  if (!Array.isArray(historial) || !historial.length) return '';

  return historial
    .map((item, idx) => {
      const fecha = item.fecha
        ? new Date(item.fecha).toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'short' })
        : `Reenvío ${idx + 1}`;

      const cambios = consolidarCambiosReserva(item.cambios || []);

      if (!cambios.length) return '';

      return [
        `Reenvío anterior ${idx + 1} (${fecha}):`,
        ...cambios.map(c => `- ${textoCambioReserva(c)}`)
      ].join('\n');
    })
    .filter(Boolean)
    .join('\n\n');
}

function pintarAlertaRevisionCambiosReserva(revisionCambios) {
  const box = document.getElementById('alertaRevisionCambiosReserva');
  if (!box) return;

  const cambios = consolidarCambiosReserva(revisionCambios?.cambios || []);

  if (!cambios.length) {
    box.style.display = 'none';
    box.innerHTML = '';
    return;
  }

  box.style.display = 'block';
  box.innerHTML = `
    <div style="margin:.75rem 0; padding:.75rem; border:1px solid #d89b00; background:#fff7e0; border-radius:8px;">
      <strong>⚠️ Esta reserva requiere reenvío.</strong>
      <div style="margin-top:.35rem;">
        Motivo: se detectaron cambios posteriores a la última confirmación enviada.
      </div>
      <ul style="margin:.5rem 0 0 1.25rem;">
        ${cambios.map(c => `<li>${escapeHtmlReserva(textoCambioReserva(c))}</li>`).join('')}
      </ul>
    </div>
  `;
}

async function obtenerRevisionCambiosReserva(destino, actividad) {
  const ref = refServicioContador(destino, actividad);
  const snap = await getDoc(ref);

  if (!snap.exists()) {
    return {
      requiereReenvio: false,
      cambios: [],
      historial: []
    };
  }

  const reservas = snap.data()?.reservas || {};
  const fechasActividad = obtenerFechasConPaxActividad(actividad);

  let cambios = [];
  let historial = [];

  fechasActividad.forEach(fecha => {
    const r = reservas?.[fecha];

    if (r?.estado === 'REQUIERE_REENVIO' && r?.revisionCambios?.estado === 'CON_CAMBIOS') {
      cambios = cambios.concat(r.revisionCambios.cambios || []);
    }

    if (Array.isArray(r?.revisionCambiosHistorial)) {
      historial = historial.concat(r.revisionCambiosHistorial);
    }
  });

  cambios = deduplicarCambiosReserva(cambios);

  const historialMap = new Map();

  historial.forEach(item => {
    const key = [
      item.fecha || '',
      item.usuario || '',
      JSON.stringify(item.cambios || [])
    ].join('__');

    if (!historialMap.has(key)) {
      historialMap.set(key, item);
    }
  });

  historial = Array.from(historialMap.values());

  return {
    requiereReenvio: cambios.length > 0,
    cambios,
    historial
  };
}

async function construirVerificacionActualParaReenvio(destino, actividad) {
  const snapshot = reservaActualSnapshot || construirSnapshotReservaActual(destino, actividad);
  const resultados = [];

  for (const g of snapshot.grupos || []) {
    try {
      const numeroNegocio = g.numeroNegocio || g.id;
      const numerosPago = obtenerNumerosNegocioPago(numeroNegocio);
      const resumenPagos = await consultarResumenPagosFusionado(numerosPago);

      const paxPagos = Number(resumenPagos.totalViajan || 0);
      const paxCorreo = Number(g.paxCorreo || 0);

      resultados.push({
        numeroNegocio,
        numerosPago,
        nombreGrupo: g.nombreGrupo || '',
        paxCorreo,
        paxPagos,
        diferencia: paxPagos - paxCorreo,
        estado: paxPagos === paxCorreo ? 'OK' : 'DIFERENCIA',

        adultosCorreo: g.adultosCorreo || { M: 0, F: 0, O: 0 },
        estudiantesCorreo: g.estudiantesCorreo || { M: 0, F: 0, O: 0 },
        totalAdultosCorreo: Number(g.totalAdultosCorreo || 0),
        totalEstudiantesCorreo: Number(g.totalEstudiantesCorreo || 0),

        adultosPagos: resumenPagos.adultos,
        estudiantesPagos: resumenPagos.estudiantes,
        totalAdultosPagos: Number(resumenPagos.totalAdultos || 0),
        totalEstudiantesPagos: Number(resumenPagos.totalEstudiantes || 0),

        fechas: g.fechas || []
      });

    } catch (error) {
      resultados.push({
        numeroNegocio: g.numeroNegocio || g.id,
        numerosPago: obtenerNumerosNegocioPago(g.numeroNegocio || g.id),
        nombreGrupo: g.nombreGrupo || '',
        paxCorreo: Number(g.paxCorreo || 0),
        paxPagos: '',
        diferencia: '',
        estado: 'ERROR CONSULTA',
        fechas: g.fechas || []
      });
    }
  }

  const fechasVerificadas = (snapshot.fechas || []).map(f => ({
    ...f,
    grupos: (f.grupos || []).map(g => {
      const encontrado = resultados.find(r =>
        String(r.numeroNegocio) === String(g.numeroNegocio || g.id)
      );

      return {
        ...g,
        paxPagos: encontrado?.paxPagos ?? '',
        totalAdultosPagos: encontrado?.totalAdultosPagos ?? '',
        totalEstudiantesPagos: encontrado?.totalEstudiantesPagos ?? '',
        estadoPagos: encontrado?.estado || ''
      };
    })
  }));

  return {
    fecha: new Date().toISOString(),
    destino,
    actividad,
    grupos: resultados,
    snapshotLogistico: {
      destino,
      actividad,
      fechas: fechasVerificadas,
      resumenLogistico: snapshot.resumenLogistico || {}
    },
    resumen: calcularResumenVerificacion(resultados),
    comentario: 'Base actualizada automáticamente por reenvío de confirmación.',
    usuario: auth.currentUser?.email || '',
    guardadoEn: new Date().toISOString()
  };
}

function keyGrupoFecha(fecha, grupo) {
  return `${fecha}__${grupo.numeroNegocio || grupo.id}`;
}

function compararSnapshotLogisticoReserva(antesSnapshot, ahoraSnapshot) {
  const cambios = [];

  const antesFechas = Array.isArray(antesSnapshot?.fechas) ? antesSnapshot.fechas : [];
  const ahoraFechas = Array.isArray(ahoraSnapshot?.fechas) ? ahoraSnapshot.fechas : [];

  const antesMap = new Map();
  const ahoraMap = new Map();

  antesFechas.forEach(f => {
    (f.grupos || []).forEach(g => {
      antesMap.set(keyGrupoFecha(f.fecha, g), {
        fecha: f.fecha,
        grupo: g
      });
    });
  });

  ahoraFechas.forEach(f => {
    (f.grupos || []).forEach(g => {
      ahoraMap.set(keyGrupoFecha(f.fecha, g), {
        fecha: f.fecha,
        grupo: g
      });
    });
  });

  for (const [key, antes] of antesMap.entries()) {
    const ahora = ahoraMap.get(key);

    if (!ahora) {
      cambios.push({
        tipo: 'GRUPO_SALE_DE_FECHA',
        fecha: antes.fecha,
        numeroNegocio: antes.grupo.numeroNegocio || antes.grupo.id,
        nombreGrupo: antes.grupo.nombreGrupo || '',
        antes: {
          pax: Number(antes.grupo.paxCorreo || 0),
          adultos: Number(antes.grupo.totalAdultosCorreo || 0),
          estudiantes: Number(antes.grupo.totalEstudiantesCorreo || 0)
        },
        ahora: {
          pax: 0,
          adultos: 0,
          estudiantes: 0
        },
        diferencia: {
          pax: -Number(antes.grupo.paxCorreo || 0),
          adultos: -Number(antes.grupo.totalAdultosCorreo || 0),
          estudiantes: -Number(antes.grupo.totalEstudiantesCorreo || 0)
        },
        detalle: `Sale de ${formatearFechaBonita(antes.fecha)}`
      });

      continue;
    }

    const diffPax = Number(ahora.grupo.paxCorreo || 0) - Number(antes.grupo.paxCorreo || 0);
    const diffAdultos = Number(ahora.grupo.totalAdultosCorreo || 0) - Number(antes.grupo.totalAdultosCorreo || 0);
    const diffEstudiantes = Number(ahora.grupo.totalEstudiantesCorreo || 0) - Number(antes.grupo.totalEstudiantesCorreo || 0);

    if (diffPax !== 0 || diffAdultos !== 0 || diffEstudiantes !== 0) {
      cambios.push({
        tipo: 'CAMBIO_PAX_EN_FECHA',
        fecha: antes.fecha,
        numeroNegocio: antes.grupo.numeroNegocio || antes.grupo.id,
        nombreGrupo: antes.grupo.nombreGrupo || '',
        antes: {
          pax: Number(antes.grupo.paxCorreo || 0),
          adultos: Number(antes.grupo.totalAdultosCorreo || 0),
          estudiantes: Number(antes.grupo.totalEstudiantesCorreo || 0)
        },
        ahora: {
          pax: Number(ahora.grupo.paxCorreo || 0),
          adultos: Number(ahora.grupo.totalAdultosCorreo || 0),
          estudiantes: Number(ahora.grupo.totalEstudiantesCorreo || 0)
        },
        diferencia: {
          pax: diffPax,
          adultos: diffAdultos,
          estudiantes: diffEstudiantes
        },
        detalle: `${formatearFechaBonita(antes.fecha)} · ${construirTextoCambioReserva(diffAdultos, diffEstudiantes, diffPax)}`
      });
    }
  }

  for (const [key, ahora] of ahoraMap.entries()) {
    if (antesMap.has(key)) continue;

    cambios.push({
      tipo: 'GRUPO_ENTRA_A_FECHA',
      fecha: ahora.fecha,
      numeroNegocio: ahora.grupo.numeroNegocio || ahora.grupo.id,
      nombreGrupo: ahora.grupo.nombreGrupo || '',
      antes: {
        pax: 0,
        adultos: 0,
        estudiantes: 0
      },
      ahora: {
        pax: Number(ahora.grupo.paxCorreo || 0),
        adultos: Number(ahora.grupo.totalAdultosCorreo || 0),
        estudiantes: Number(ahora.grupo.totalEstudiantesCorreo || 0)
      },
      diferencia: {
        pax: Number(ahora.grupo.paxCorreo || 0),
        adultos: Number(ahora.grupo.totalAdultosCorreo || 0),
        estudiantes: Number(ahora.grupo.totalEstudiantesCorreo || 0)
      },
      detalle: `Entra a ${formatearFechaBonita(ahora.fecha)}`
    });
  }

  return cambios;
}

function esFechaSyncHoy(valor) {
  if (!valor) return false;

  let d = null;

  if (valor?.toDate) {
    d = valor.toDate();
  } else if (valor?.seconds) {
    d = new Date(valor.seconds * 1000);
  } else {
    d = new Date(valor);
  }

  if (!d || Number.isNaN(d.getTime())) return false;

  const hoy = new Date();

  return (
    d.getFullYear() === hoy.getFullYear() &&
    d.getMonth() === hoy.getMonth() &&
    d.getDate() === hoy.getDate()
  );
}

function formatearFechaHoraSync(valor) {
  if (!valor) return 'sin sincronización';

  let d = null;

  if (valor?.toDate) {
    d = valor.toDate();
  } else if (valor?.seconds) {
    d = new Date(valor.seconds * 1000);
  } else {
    d = new Date(valor);
  }

  if (!d || Number.isNaN(d.getTime())) return 'sin sincronización';

  return d.toLocaleString('es-CL', {
    dateStyle: 'short',
    timeStyle: 'short'
  });
}

function obtenerGruposActividadReserva(actividad) {
  return grupos.filter(g =>
    Object.values(g.itinerario || {}).some(acts =>
      (acts || []).some(a => actividadCoincideReserva(a, actividad))
    )
  );
}

function mostrarEstadoSyncPaxReserva(actividad) {
  const box = document.getElementById('estadoSyncPaxReserva');
  const btnSync = document.getElementById('btnSincronizarPaxReserva');

  if (!box) return;

  const lista = obtenerGruposActividadReserva(actividad);

  const sincronizadosHoy = lista.filter(g => esFechaSyncHoy(g.paxActualizadoEn));
  const pendientes = lista.filter(g => !esFechaSyncHoy(g.paxActualizadoEn));

  box.innerHTML = `
    <div style="margin:.75rem 0; padding:.75rem; background:#f7f7f7; border:1px solid #ddd; border-radius:8px;">
      <strong>Estado PAX pagos:</strong><br>
      Grupos de esta reserva: <strong>${lista.length}</strong><br>
      Sincronizados hoy: <strong>${sincronizadosHoy.length}</strong><br>
      Pendientes/no sincronizados hoy: <strong>${pendientes.length}</strong>
      ${
        lista.length
          ? `<div style="margin-top:.5rem; font-size:.9em;">
              ${lista.map(g => `
                <div>
                  ${g.numeroNegocio || g.id} — ${g.nombreGrupo || ''}:
                  ${esFechaSyncHoy(g.paxActualizadoEn) ? '✅' : '⚠️'}
                  ${formatearFechaHoraSync(g.paxActualizadoEn)}
                </div>
              `).join('')}
            </div>`
          : ''
      }
    </div>
  `;

  if (btnSync) {
    btnSync.style.display = lista.length ? 'inline-block' : 'none';
    btnSync.textContent = pendientes.length
      ? `Sincronizar PAX pendientes (${pendientes.length})`
      : 'Forzar sincronización PAX';
  }
}

function reconstruirCorreoReserva(destino, actividad, proveedor, opciones = {}) {
  const provInfo = proveedores[proveedor] || { contacto: '', correo: '' };
  const revisionCambios = opciones.revisionCambios || null;
  const requiereReenvio = !!revisionCambios?.requiereReenvio;

  const perDateData = fechasOrdenadas
    .map(fecha => {
      const lista = grupos.filter(g =>
        (g.itinerario?.[fecha] || []).some(a => actividadCoincideReserva(a, actividad))
      );

      const paxTotal = lista.reduce((sum, g) => {
        const acts = g.itinerario?.[fecha] || [];
        return sum + acts
          .filter(a => actividadCoincideReserva(a, actividad))
          .reduce((s, a) => s + ((parseInt(a.adultos) || 0) + (parseInt(a.estudiantes) || 0)), 0);
      }, 0);

      return { fecha, lista, paxTotal };
    })
    .filter(d => d.lista.length > 0);

  reservaActualSnapshot = construirSnapshotReservaPorFecha(destino, actividad, perDateData);

  const totalGlobal = reservaActualSnapshot.resumenLogistico.totalPax;
  const totalGrupos = reservaActualSnapshot.grupos.length;

  let cuerpo = `Estimado/a ${provInfo.contacto || ''}:\n\n`;

  if (requiereReenvio) {
    const bloqueActual = construirBloqueCambiosReserva(revisionCambios);
    const bloqueHistorial = construirBloqueHistorialCambiosReserva(revisionCambios.historial || []);

    cuerpo += `Junto con saludar, reenviamos la confirmación actualizada de la reserva, ya que hubo cambios posteriores al último envío.\n\n`;

    cuerpo += `Cambios de este reenvío:\n`;
    cuerpo += `${bloqueActual || '- Sin detalle disponible.'}\n\n`;

    if (bloqueHistorial) {
      cuerpo += `Historial de cambios anteriores desde la reserva original:\n`;
      cuerpo += `${bloqueHistorial}\n\n`;
    }

    cuerpo += `En cualquier caso, el detalle vigente y final de la reserva es el siguiente:\n\n`;
  } else {
    cuerpo += `A continuación se envía detalle de reserva para:\n\n`;
  }

  cuerpo += `Actividad: ${actividad}\n`;
  cuerpo += `Destino: ${destino}\n`;
  cuerpo += `Total Grupos: (${totalGrupos})\n`;
  cuerpo += `Total PAX: (${totalGlobal})\n\n`;
  cuerpo += `Fechas y grupos:\n\n`;

  reservaActualSnapshot.fechas.forEach(({ fecha, grupos, totalPax }) => {
    cuerpo += `➡️ Fecha ${formatearFechaBonita(fecha)} - Grupos (${grupos.length}) - PAX (${totalPax}):\n\n`;

    grupos.forEach(g => {
      cuerpo += `  - N°: ${g.numeroNegocio}, Colegio: ${g.nombreGrupo}, Cantidad de Pax: ${g.paxCorreo}\n`;
    });

    cuerpo += `\n`;
  });

  cuerpo += `Atte.\nEquipo de Operaciones RaiTrai`;

  document.getElementById('modalCuerpo').value = cuerpo;
}

async function sincronizarPaxReservaManual() {
  const btnSync = document.getElementById('btnSincronizarPaxReserva');
  if (!btnSync) return;

  const destino = btnSync.dataset.destino;
  const actividad = btnSync.dataset.actividad;
  const proveedor = btnSync.dataset.proveedor;

  btnSync.disabled = true;
  btnSync.textContent = 'Sincronizando...';

  try {
    await sincronizarGruposReservaConPagos(actividad);

    const revisionNueva = await obtenerRevisionCambiosReserva(destino, actividad);

    const revisionCambios =
      revisionCambiosReservaActiva?.requiereReenvio
        ? revisionCambiosReservaActiva
        : revisionNueva;

    revisionCambiosReservaActiva = revisionCambios;

    pintarAlertaRevisionCambiosReserva(revisionCambios);
    reconstruirCorreoReserva(destino, actividad, proveedor, { revisionCambios });

    const btnEnv = document.getElementById('btnEnviarReserva');
    if (btnEnv) {
      btnEnv.dataset.destino = destino;
      btnEnv.dataset.actividad = actividad;
      btnEnv.dataset.proveedor = proveedor;
      btnEnv.dataset.requiereReenvio = revisionCambios.requiereReenvio ? '1' : '0';
    }

    document.getElementById('modalAsunto').value = revisionCambios.requiereReenvio
      ? `Reenvío de confirmación: ${actividad} en ${destino}`
      : `Reserva: ${actividad} en ${destino}`;

    mostrarEstadoSyncPaxReserva(actividad);

    alert('PAX sincronizado con pagos y correo actualizado.');
  } catch (error) {
    console.error('Error sincronizando PAX manualmente:', error);
    alert('No se pudo sincronizar PAX con pagos. Revisa la consola.');
  } finally {
    btnSync.disabled = false;
  
    // Vuelve a calcular el texto según el estado actual
    // de sincronización de los grupos.
    mostrarEstadoSyncPaxReserva(actividad);
  }
}

async function abrirModalReserva(event) {
  const btn       = event.currentTarget;
  const destino   = btn.dataset.destino;
  const actividad = btn.dataset.actividad;
  const proveedor = btn.dataset.proveedor;

  const provInfo = proveedores[proveedor] || { contacto: '', correo: '' };

  const revisionCambios = await obtenerRevisionCambiosReserva(destino, actividad);
  revisionCambiosReservaActiva = revisionCambios;

  document.getElementById('modalPara').value = provInfo.correo;

  document.getElementById('modalAsunto').value = revisionCambios.requiereReenvio
    ? `Reenvío de confirmación: ${actividad} en ${destino}`
    : `Reserva: ${actividad} en ${destino}`;

  pintarAlertaRevisionCambiosReserva(revisionCambios);
  reconstruirCorreoReserva(destino, actividad, proveedor, { revisionCambios });

  const btnPend = document.getElementById(
    'btnGuardarPendiente'
  );
  
  btnPend.dataset.destino = destino;
  btnPend.dataset.actividad = actividad;

  const btnEnv = document.getElementById('btnEnviarReserva');
  btnEnv.dataset.destino = destino;
  btnEnv.dataset.actividad = actividad;
  btnEnv.dataset.proveedor = proveedor;
  btnEnv.dataset.requiereReenvio = revisionCambios.requiereReenvio ? '1' : '0';

  const btnSync = document.getElementById('btnSincronizarPaxReserva');
  if (btnSync) {
    btnSync.dataset.destino = destino;
    btnSync.dataset.actividad = actividad;
    btnSync.dataset.proveedor = proveedor;
  }

  mostrarEstadoSyncPaxReserva(actividad);

  document.getElementById('modalReserva').style.display = 'block';
}

async function guardarPendiente() {
  const btn = document.getElementById('btnGuardarPendiente');

  const destino = btn.dataset.destino;
  const actividad = btn.dataset.actividad;
  const cuerpo = document.getElementById('modalCuerpo').value;

  if (!destino || !actividad) {
    alert('No se pudo identificar la reserva.');
    return;
  }

  const fechasActividad = obtenerFechasConPaxActividad(
    actividad
  );

  if (!fechasActividad.length) {
    alert('Esta actividad no tiene fechas con grupos.');
    return;
  }

  const ref = refServicioContador(
    destino,
    actividad
  );

  const payload = {};

  fechasActividad.forEach(fecha => {
    // Se usan campos separados para no borrar
    // verificaciones o historiales que ya existan.
    payload[`reservas.${fecha}.estado`] = 'PENDIENTE';
    payload[`reservas.${fecha}.cuerpo`] = cuerpo;
    payload[`reservas.${fecha}.updatedAt`] =
      serverTimestamp();
  });

  try {
    await updateDoc(ref, payload);

    const botonTabla = document.querySelector(
      `.btn-reserva[data-actividad="${CSS.escape(actividad)}"][data-destino="${CSS.escape(destino)}"]`
    );

    if (botonTabla) {
      botonTabla.textContent = 'PENDIENTE';
    
      botonTabla
        .closest('tr')
        ?.classList
        .remove('fila-revisar-cambios');
    }

    document.getElementById('modalReserva').style.display =
      'none';

  } catch (error) {
    console.error(
      'Error guardando reserva pendiente:',
      error
    );

    alert(
      'No se pudo guardar la reserva como pendiente.'
    );
  }
}

async function enviarReserva() {
  const btn = document.getElementById(
    'btnEnviarReserva'
  );

  const destino = btn.dataset.destino;
  const actividad = btn.dataset.actividad;
  const proveedor = btn.dataset.proveedor;

  const requiereReenvio =
    btn.dataset.requiereReenvio === '1';

  const para = document
    .getElementById('modalPara')
    .value
    .trim();

  const asunto = document
    .getElementById('modalAsunto')
    .value
    .trim();

  const cuerpo = document
    .getElementById('modalCuerpo')
    .value;

  if (!destino || !actividad) {
    alert('No se pudo identificar la reserva.');
    return;
  }

  if (!para) {
    alert('Debes indicar el correo del proveedor.');
    return;
  }

  if (!asunto) {
    alert('Debes indicar el asunto del correo.');
    return;
  }

  btn.disabled = true;
  btn.textContent = requiereReenvio
    ? 'Preparando reenvío...'
    : 'Preparando envío...';

  try {
    /*
     * Siempre construimos una fotografía nueva.
     *
     * En el primer envío será la base inicial.
     * En un reenvío reemplazará la base antigua.
     */
    const verificacionActualizada =
      await construirVerificacionActualParaReenvio(
        destino,
        actividad
      );

    const ref = refServicioContador(
      destino,
      actividad
    );

    const snap = await getDoc(ref);

    const reservasActuales = snap.exists()
      ? snap.data()?.reservas || {}
      : {};

    let revisionActual = null;

    if (requiereReenvio) {
      revisionActual =
        revisionCambiosReservaActiva ||
        await obtenerRevisionCambiosReserva(
          destino,
          actividad
        );
    }

    const fechasActividad =
      obtenerFechasConPaxActividad(actividad);

    if (!fechasActividad.length) {
      alert(
        'Esta actividad no tiene fechas con grupos.'
      );
      return;
    }

    const payload = {};

    for (const fecha of fechasActividad) {
      const totalEnviado = grupos.reduce(
        (sum, grupo) => {
          const actividadesFecha =
            grupo.itinerario?.[fecha] || [];

          const totalGrupo = actividadesFecha
            .filter(item =>
              actividadCoincideReserva(
                item,
                actividad
              )
            )
            .reduce(
              (subtotal, item) =>
                subtotal +
                (parseInt(item.adultos) || 0) +
                (parseInt(item.estudiantes) || 0),
              0
            );

          return sum + totalGrupo;
        },
        0
      );

      if (totalEnviado <= 0) {
        continue;
      }

      payload[`reservas.${fecha}.estado`] =
        'ENVIADA';

      payload[`reservas.${fecha}.cuerpo`] =
        cuerpo;

      payload[`reservas.${fecha}.totalEnviado`] =
        totalEnviado;

      payload[`reservas.${fecha}.updatedAt`] =
        serverTimestamp();

      payload[`reservas.${fecha}.enviadaEn`] =
        serverTimestamp();

      payload[`reservas.${fecha}.enviadaPor`] =
        auth.currentUser?.email || '';

      /*
       * Esta es la fotografía base que posteriormente
       * usa revisarCambiosReservasEnviadas().
       */
      payload[
        `reservas.${fecha}.verificacionPagos`
      ] = verificacionActualizada;

      payload[
        `reservas.${fecha}.revisionCambios`
      ] = {
        estado: requiereReenvio
          ? 'REENVIO_ENVIADO'
          : 'SIN_CAMBIOS',

        ultimaRevision: new Date().toISOString(),
        reenviadoEn: requiereReenvio
          ? new Date().toISOString()
          : null,

        cambios: []
      };

      payload[
        `reservas.${fecha}.estadoAntesRevision`
      ] = null;

      /*
       * Solo agregamos historial cuando era un
       * reenvío por cambios.
       */
      if (requiereReenvio) {
        const historialAnterior = Array.isArray(
          reservasActuales?.[fecha]
            ?.revisionCambiosHistorial
        )
          ? reservasActuales[fecha]
              .revisionCambiosHistorial
          : [];

        const nuevoItemHistorial = {
          fecha: new Date().toISOString(),
          usuario: auth.currentUser?.email || '',
          asunto,
          proveedor: proveedor || '',
          cambios: revisionActual?.cambios || []
        };

        payload[
          `reservas.${fecha}.revisionCambiosHistorial`
        ] = [
          ...historialAnterior,
          nuevoItemHistorial
        ];
      }
    }

    if (!Object.keys(payload).length) {
      alert(
        'No hay fechas con PAX para guardar el envío.'
      );
      return;
    }

    await updateDoc(ref, payload);

    /*
     * Se abre Gmail después de dejar guardada
     * correctamente la fotografía de la reserva.
     */
    const baseUrl =
      'https://mail.google.com/mail/u/0/?view=cm&fs=1';

    const params = [
      `to=${encodeURIComponent(para)}`,
      `su=${encodeURIComponent(asunto)}`,
      `body=${encodeURIComponent(cuerpo)}`
    ].join('&');

    window.open(
      `${baseUrl}&${params}`,
      '_blank'
    );

    const botonTabla = document.querySelector(
      `.btn-reserva[data-actividad="${CSS.escape(actividad)}"][data-destino="${CSS.escape(destino)}"]`
    );

    if (botonTabla) {
      botonTabla.textContent = 'ENVIADA';
    
      botonTabla
        .closest('tr')
        ?.classList
        .remove('fila-revisar-cambios');
    }

    revisionCambiosReservaActiva = null;

    btn.dataset.requiereReenvio = '0';

    document.getElementById(
      'modalReserva'
    ).style.display = 'none';

  } catch (error) {
    console.error(
      'Error enviando o guardando reserva:',
      error
    );

    alert(
      'No se pudo preparar y guardar la reserva. ' +
      'No se marcó como enviada.'
    );
  } finally {
    btn.disabled = false;
    btn.textContent = 'Enviar';
  }
}

// —————————————————————————————————————————————
// 7️⃣ Modal “Detalle de grupos” (click en celda)
//     → usa el mismo renderer DataTables que el de estadísticas
// —————————————————————————————————————————————
function mostrarGruposCoincidentes(actividad, fecha) {
  const lista = grupos
    .filter(g => (g.itinerario?.[fecha] || []).some(a => a.actividad === actividad))
    .map(g => ({ numeroNegocio: g.id, nombreGrupo: g.nombreGrupo, cantidadgrupo: g.cantidadgrupo, programa: g.programa }));

  const totalGrupos = lista.length;
  const totalPAX = lista.reduce((sum, g) => sum + (parseInt(g.cantidadgrupo, 10) || 0), 0);

  document.querySelector('#modalDetalle h3').textContent =
    `Detalle de grupos para el día ${formatearFechaBonita(fecha)} — Total PAX: ${totalPAX} — Total Grupos: ${totalGrupos}`;

  // Prepara rows para DataTables
  const dataRows = (!lista.length)
    ? []
    : lista.map(g => [g.numeroNegocio, g.nombreGrupo || '', parseInt(g.cantidadgrupo,10)||0, g.programa || '']);

  renderTablaModal(dataRows);            // ← DataTables renderiza/ordena
  const modalDet = document.getElementById('modalDetalle');
  modalDet.style.zIndex = '11000';
  modalDet.style.display = 'block';
}

// ————————————————————————————————————————
// 8️⃣ Utilidades varias
// ————————————————————————————————————————
function formatearFechaBonita(iso) {
  const [yyyy, mm, dd] = iso.split('-');
  return `${dd}/${mm}`;
}
function escapeRegExp(text) {
  return text.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
}

// ========== ESTADÍSTICAS (respetando filtros/visibles) ==========
function getContextoVisible(table) {
  // Filas visibles (por búsqueda/filtros)
  const rows = table.rows({ search: 'applied' }).nodes().toArray();
  const pares = rows.map(row => {
    const c0 = row.cells[0]?.textContent?.trim() || '';
    const c1 = row.cells[1]?.textContent?.trim() || '';
    return { actividad: c0, destino: c1, key: `${c0}|||${c1}` };
  });
  const map = new Map();
  pares.forEach(p => { if (!map.has(p.key)) map.set(p.key, p); });

  // Fechas visibles = columnas visibles con data-fecha
  const fechasVisibles = [];
  table.columns().every(function () {
    const th = this.header();
    const iso = th?.dataset?.fecha;
    if (iso && this.visible()) fechasVisibles.push(iso);
  });

  return {
    paresVisibles: Array.from(map.values()),     // [{actividad, destino}]
    fechasVisibles,                              // ['YYYY-MM-DD', ...]
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
  window.__ctxStats = ctx;
  if (!ctx.paresVisibles.length || !ctx.fechasVisibles.length) {
    alert('No hay actividades o fechas visibles para calcular.');
    return;
  }

  // Defaults del UI
  const elModo    = document.getElementById('modoCombinacion');
  const elAlc     = document.getElementById('alcanceCombinacion');
  const elKMax    = document.getElementById('nivelMax');
  const elSoloMax = document.getElementById('soloTamMax');
  if (elModo) elModo.value = 'exacto';
  if (elAlc)  elAlc.value  = 'viaje';
  if (elKMax) elKMax.value = String(ctx.actividadesSet.size); // auto N
  if (elSoloMax) elSoloMax.checked = false;

  pintarStatsActividad(ctx);
  pintarStatsFecha(ctx);
  recalcularCombinaciones(ctx);

  document.getElementById('btnRecalcularStats').onclick = () => recalcularCombinaciones(ctx);
  document.getElementById('btnCerrarStats').onclick = () =>
    (document.getElementById('modalEstadisticas').style.display = 'none');
  document.getElementById('btnExportarStatsExcel').onclick = exportarEstadisticasExcel;

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

    const btn = `<button class="ver-grupos"
      data-ids="${Array.from(gSet).join(',')}"
      data-titulo="Grupos — ${actividad} (${destino})"
      data-context="actividad"
      data-actividad="${encodeURIComponent(actividad)}"
    >Ver grupos</button>`;

    tbody.insertAdjacentHTML('beforeend', `
      <tr>
        <td>${actividad}</td>
        <td>${destino}</td>
        <td>${pax}</td>
        <td>${gSet.size}</td>
        <td>${btn}</td>
      </tr>`);
  });

  document.getElementById('statsActividadTotalPax').textContent = totalPax;
  document.getElementById('statsActividadTotalGrupos').textContent = gruposUnicos.size;

  tbody.onclick = (e) => {
    const b = e.target.closest('.ver-grupos');
    if (!b) return;
    const ids = (b.dataset.ids || '').split(',').filter(Boolean);
    mostrarListaDeGrupos(ids, b.dataset.titulo || 'Grupos', b.dataset);
  };
}

function pintarStatsFecha(ctx) {
  const tbody = document.getElementById('statsFechaBody');
  tbody.innerHTML = '';
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

    const btn = `<button class="ver-grupos"
      data-ids="${Array.from(gSet).join(',')}"
      data-titulo="Grupos — ${formatearFechaBonita(fecha)}"
      data-context="fecha"
      data-fecha="${fecha}"
    >Ver grupos</button>`;

    tbody.insertAdjacentHTML('beforeend', `
      <tr>
        <td>${formatearFechaBonita(fecha)}</td>
        <td>${pax}</td>
        <td>${gSet.size}</td>
        <td>${btn}</td>
      </tr>`);
  });

  tbody.onclick = (e) => {
    const b = e.target.closest('.ver-grupos');
    if (!b) return;
    const ids = (b.dataset.ids || '').split(',').filter(Boolean);
    mostrarListaDeGrupos(ids, b.dataset.titulo || 'Grupos', b.dataset);
  };
}

// ———  Combinaciones observadas (EXACTO por defecto)
function recalcularCombinaciones(ctx) {
  const modoEl    = document.getElementById('modoCombinacion');
  const alcanceEl = document.getElementById('alcanceCombinacion');
  const kMaxEl    = document.getElementById('nivelMax');
  const soloMaxEl = document.getElementById('soloTamMax');

  const modo     = (modoEl?.value || 'exacto');   // exacto | incluye
  const alcance  = (alcanceEl?.value || 'viaje'); // viaje | dia
  const kMax     = parseInt(kMaxEl?.value || '999', 10);
  const soloMax  = !!(soloMaxEl?.checked);

  const actsVisibles = new Set(ctx.actividadesSet);
  const nVisibles    = actsVisibles.size;

  const cuerpo = document.getElementById('statsCombosBody');
  cuerpo.innerHTML = '';

  const combosMap = new Map(); // key -> Set(ids)

  const keyFromSet = (set) => Array.from(set).sort((a,b)=>a.localeCompare(b)).join(' + ');
  const addCombo = (key, id) => {
    if (!combosMap.has(key)) combosMap.set(key, new Set());
    combosMap.get(key).add(id);
  };
  const genSubsetsK = (arr, k, cb) => {
    const n = arr.length, idx = [];
    const back = (start, depth) => {
      if (depth === k) { cb(idx.map(i => arr[i]).sort().join(' + ')); return; }
      for (let i = start; i < n; i++) { idx.push(i); back(i+1, depth+1); idx.pop(); }
    };
    back(0, 0);
  };

  for (const g of grupos) {
    if (alcance === 'viaje') {
      const setViaje = new Set();
      for (const f of ctx.fechasVisibles) {
        const acts = g.itinerario?.[f] || [];
        for (const a of acts) if (actsVisibles.has(a.actividad)) setViaje.add(a.actividad);
      }
      if (setViaje.size === 0) continue;

      if (modo === 'exacto') {
        if (setViaje.size <= kMax) addCombo(keyFromSet(setViaje), g.id);
      } else {
        const arr = Array.from(setViaje);
        const maxK = Math.min(kMax, arr.length);
        const minK = soloMax ? nVisibles : 1;
        if (minK <= maxK) {
          for (let k = minK; k <= maxK; k++) genSubsetsK(arr, k, (key) => addCombo(key, g.id));
        }
      }

    } else { // mismo día
      for (const f of ctx.fechasVisibles) {
        const setDia = new Set(
          (g.itinerario?.[f] || [])
            .filter(a => actsVisibles.has(a.actividad))
            .map(a => a.actividad)
        );
        if (setDia.size === 0) continue;

        if (modo === 'exacto') {
          if (setDia.size <= kMax) addCombo(keyFromSet(setDia), g.id);
        } else {
          const arr = Array.from(setDia);
          const maxK = Math.min(kMax, arr.length);
          const minK = soloMax ? nVisibles : 1;
          if (minK <= maxK) {
            for (let k = minK; k <= maxK; k++) genSubsetsK(arr, k, (key) => addCombo(key, g.id));
          }
        }
      }
    }
  }

  // Filtro "solo tamaño máximo" para EXACTO
  if (soloMax && modo === 'exacto') {
    for (const key of Array.from(combosMap.keys())) {
      const size = key.split(' + ').length;
      if (size !== nVisibles) combosMap.delete(key);
    }
  }

  // Ordena por tamaño y alfabético
  const sorted = Array.from(combosMap.entries()).sort((a, b) => {
    const sa = a[0].split(' + ').length, sb = b[0].split(' + ').length;
    if (sa !== sb) return sa - sb;
    return a[0].localeCompare(b[0]);
  });

  sorted.forEach(([key, idSet]) => {
    const idsCsv = Array.from(idSet).join(',');
    const btn = `<button class="ver-grupos"
      data-ids="${idsCsv}"
      data-titulo="Grupos — ${key}"
      data-context="combo"
      data-combo="${key.split(' + ').map(encodeURIComponent).join(',')}"
      data-alcance="${alcance}"
      data-modo="${modo}"
    >Ver grupos</button>`;

    cuerpo.insertAdjacentHTML('beforeend', `
      <tr>
        <td>${key}</td>
        <td>${idSet.size}</td>
        <td>${btn}</td>
      </tr>`);
  });

  cuerpo.onclick = (e) => {
    const b = e.target.closest('.ver-grupos');
    if (!b) return;
    const ids = (b.dataset.ids || '').split(',').filter(Boolean);
    mostrarListaDeGrupos(ids, b.dataset.titulo || 'Grupos', b.dataset);
  };
}

// ———  Modal “Ver grupos” reutilizable desde Estadísticas
function mostrarListaDeGrupos(ids, titulo, dataset = {}) {
  // guardamos el último estado para el botón "Actualizar"
  window.__ULTIMO_DETALLE_MODAL__ = { ids, titulo, dataset };

  const lista = grupos.filter(g => ids.includes(g.id));
  const ctx = window.__ctxStats || { fechasVisibles: [], actividadesSet: new Set() };

  // PAX según contexto (actividad, fecha, combo)
  function paxSegunContexto(g) {
    const ctxType = dataset.context || '';
    if (ctxType === 'actividad') {
      const act = decodeURIComponent(dataset.actividad || '');
      return ctx.fechasVisibles.reduce((sum, f) => {
        const acts = g.itinerario?.[f] || [];
        return sum + acts
          .filter(a => a.actividad === act)
          .reduce((s, a) => s + ((parseInt(a.adultos)||0) + (parseInt(a.estudiantes)||0)), 0);
      }, 0);
    }
    if (ctxType === 'fecha') {
      const fsel = dataset.fecha;
      const acts = g.itinerario?.[fsel] || [];
      return acts
        .filter(a => ctx.actividadesSet.has(a.actividad))
        .reduce((s, a) => s + ((parseInt(a.adultos)||0) + (parseInt(a.estudiantes)||0)), 0);
    }
    if (ctxType === 'combo') {
      const comboActs = (dataset.combo || '').split(',').map(x => decodeURIComponent(x)).filter(Boolean);
      const alcance = dataset.alcance || 'viaje';
      const modo    = dataset.modo || 'exacto';

      if (alcance === 'viaje') {
        return ctx.fechasVisibles.reduce((sum, f) => {
          const acts = g.itinerario?.[f] || [];
          return sum + acts
            .filter(a => comboActs.includes(a.actividad))
            .reduce((s, a) => s + ((parseInt(a.adultos)||0) + (parseInt(a.estudiantes)||0)), 0);
        }, 0);
      } else {
        let total = 0;
        for (const f of ctx.fechasVisibles) {
          const acts = g.itinerario?.[f] || [];
          const setDia = new Set(acts.filter(a => ctx.actividadesSet.has(a.actividad)).map(a => a.actividad));
          const comboSet = new Set(comboActs);

          const cumpleExacto = () => (setDia.size === comboSet.size) && [...comboSet].every(a => setDia.has(a));
          const cumpleIncluye = () => [...comboSet].every(a => setDia.has(a));
          const ok = (modo === 'exacto') ? cumpleExacto() : cumpleIncluye();

          if (ok) {
            total += acts
              .filter(a => comboActs.includes(a.actividad))
              .reduce((s, a) => s + ((parseInt(a.adultos)||0) + (parseInt(a.estudiantes)||0)), 0);
          }
        }
        return total;
      }
    }
    return parseInt(g.cantidadgrupo, 10) || 0;
  }

  // Título con totales
  const totalPaxSeleccion = lista.reduce((sum, g) => sum + paxSegunContexto(g), 0);
  document.querySelector('#modalDetalle h3').textContent =
    `${titulo} — Total grupos: ${lista.length} — Total PAX: ${totalPaxSeleccion}`;

  // Filas para DataTables (agregamos "Vuelo" SOLO si el contexto es por fecha)
  const dataRows = !lista.length
    ? []
    : lista.map(grupo => {
        const pax =
          paxSegunContexto(grupo);
  
        return [
          grupo.id,
          grupo.nombreGrupo || '',
          pax,
          grupo.programa || ''
        ];
      });

  renderTablaModal(dataRows);  // DataTables pinta y permite ordenar
  const modalDet = document.getElementById('modalDetalle');
  modalDet.style.zIndex = '11000';
  modalDet.style.display = 'block';
}


// —————————————————————————————————————————————
// 9️⃣ Excel del modal de estadísticas (3 hojas)
// —————————————————————————————————————————————
function tableToAOA(tableEl, dropLast = false) {
  const aoa = [];
  const pushRow = (row) => {
    const cells = Array.from(row.cells).map(td => (td.innerText || '').trim());
    if (dropLast && cells.length) cells.pop(); // Quita "Ver grupos"
    aoa.push(cells);
  };
  if (tableEl.tHead)  Array.from(tableEl.tHead.rows).forEach(pushRow);
  if (tableEl.tBodies?.[0]) Array.from(tableEl.tBodies[0].rows).forEach(pushRow);
  if (tableEl.tFoot)  Array.from(tableEl.tFoot.rows).forEach(pushRow);
  return aoa;
}

function exportarEstadisticasExcel() {
  try {
    const modal = document.getElementById('modalEstadisticas');
    const tAct = modal.querySelector('#tablaStatsActividad');
    const tFec = modal.querySelector('#tablaStatsFecha');
    const tCom = modal.querySelector('#tablaStatsCombos');

    if (!tAct || !tFec || !tCom) {
      alert('No se encuentran las tablas de estadísticas en el DOM.');
      return;
    }

    const aoaAct = tableToAOA(tAct, true);
    const aoaFec = tableToAOA(tFec, true);
    const aoaCom = tableToAOA(tCom, true);

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoaAct), 'Resumen_Actividad');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoaFec), 'Totales_Fecha');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoaCom), 'Combinaciones');

    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth()+1).padStart(2,'0');
    const dd = String(d.getDate()).padStart(2,'0');
    const hh = String(d.getHours()).padStart(2,'0');
    const mi = String(d.getMinutes()).padStart(2,'0');
    XLSX.writeFile(wb, `Estadisticas_Actividades_${yyyy}-${mm}-${dd}_${hh}${mi}.xlsx`);
  } catch (err) {
    console.error('Error exportando estadísticas:', err);
    alert('No se pudo generar el Excel de estadísticas. Revisa la consola.');
  }
}

// —————————————————————————————————————————————
// 🔧 Renderer único para el modal “Ver grupos” con DataTables
//     - Evita manipular <tbody> manualmente.
//     - Soporta orden por click en encabezados.
// —————————————————————————————————————————————
function renderTablaModal(dataRows) {
  const selector = '#tablaModal';

  const columns = [
    {
      data: 0,
      title: 'N° Negocio'
    },
    {
      data: 1,
      title: 'Nombre Grupo'
    },
    {
      data: 2,
      title: 'PAX'
    },
    {
      data: 3,
      title: 'Programa'
    }
  ];

  if ($.fn.DataTable.isDataTable(selector)) {
    const tabla =
      $(selector).DataTable();

    tabla.clear();
    tabla.rows.add(dataRows);
    tabla.draw();

    return;
  }

  $(selector).DataTable({
    data: dataRows,
    columns,
    paging: false,
    searching: false,
    info: false,
    order: [],

    columnDefs: [
      {
        targets: 2,
        type: 'num'
      }
    ],

    language: {
      url: 'https://cdn.datatables.net/plug-ins/1.13.4/i18n/es-ES.json'
    }
  });
}

// =====================================================
// DETECTAR CAMBIOS POSTERIORES A RESERVAS ENVIADAS
// =====================================================
function actualizarBotonesReservaTabla(
  servicios = [],
  todosLosReservas = []
) {
  const botones = Array.from(
    document.querySelectorAll('.btn-reserva')
  );

  servicios.forEach((servicio, indice) => {
    const reservas =
      todosLosReservas[indice] || {};

    const fechasConPax =
      fechasOrdenadas.filter(fecha =>
        grupos.some(grupo =>
          (grupo.itinerario?.[fecha] || [])
            .some(actividad =>
              actividadCoincideReserva(
                actividad,
                servicio.nombre
              )
            )
        )
      );

    const texto =
      obtenerTextoBotonReserva(
        reservas,
        fechasConPax
      );

    const boton = botones.find(item =>
      item.dataset.destino === servicio.destino &&
      item.dataset.actividad === servicio.nombre
    );

    if (!boton) return;

    boton.textContent = texto;

    const fila = boton.closest('tr');

    if (!fila) return;

    const requiereRevision =
      texto === 'REVISAR CAMBIOS';
    
    fila.classList.toggle(
      'fila-revisar-cambios',
      requiereRevision
    );
    
    fila.querySelectorAll('td').forEach(celda => {
      celda.classList.toggle(
        'celda-revisar-cambios',
        requiereRevision
      );
    });
  });
}

function obtenerTextoBotonReserva(reservas = {}, fechasConPax = []) {
  const fechas = Array.isArray(fechasConPax)
    ? fechasConPax
    : [];

  // Solo consideramos las fechas actualmente vigentes
  // para esta actividad.
  if (!fechas.length) {
    return 'CREAR';
  }

  const reservasVigentes = fechas
    .map(fecha => reservas?.[fecha])
    .filter(Boolean);

  // La actividad tiene fechas, pero aún no se ha guardado
  // ninguna reserva para ellas.
  if (!reservasVigentes.length) {
    return 'CREAR';
  }

  const requiereReenvio = fechas.some(fecha =>
    reservas?.[fecha]?.estado === 'REQUIERE_REENVIO'
  );

  if (requiereReenvio) {
    return 'REVISAR CAMBIOS';
  }

  const todasVerificadas = fechas.every(fecha =>
    reservas?.[fecha]?.estado === 'VERIFICADA'
  );

  if (todasVerificadas) {
    return 'VERIFICADA';
  }

  const todasEnviadas = fechas.every(fecha => {
    const estado = reservas?.[fecha]?.estado;

    return (
      estado === 'ENVIADA' ||
      estado === 'VERIFICADA'
    );
  });

  if (todasEnviadas) {
    return 'ENVIADA';
  }

  const existePendiente = fechas.some(fecha => {
    const estado = reservas?.[fecha]?.estado;

    return (
      estado === 'PENDIENTE' ||
      estado === 'PENDIENTE_VERIFICADA'
    );
  });

  if (existePendiente) {
    return 'PENDIENTE';
  }

  return 'PENDIENTE';
}

async function revisarCambiosReservasEnviadas(
  servicios,
  todosLosReservas,
  onProgreso = null
) {
  for (let i = 0; i < servicios.length; i++) {
    const servicio = servicios[i];
    const reservas = todosLosReservas[i] || {};

    const payload = {};

    /*
     * Evita consultar varias veces la misma fotografía.
     * Una misma verificación normalmente está guardada
     * en todas las fechas de la actividad.
     */
    const cacheRevisiones = new Map();

    for (const [fecha, reserva] of Object.entries(reservas)) {
      if (!reserva) continue;

      const estadosRevisables = [
        'ENVIADA',
        'VERIFICADA',
        'REQUIERE_REENVIO'
      ];

      if (!estadosRevisables.includes(reserva.estado)) {
        continue;
      }

      const verificacion =
        reserva.verificacionPagos;

      if (
        !verificacion ||
        !Array.isArray(verificacion.grupos)
      ) {
        continue;
      }

      /*
       * Las fechas de una misma reserva suelen contener
       * exactamente la misma verificación.
       */
      const claveRevision = [
        verificacion.guardadoEn || '',
        verificacion.fecha || '',
        verificacion.destino || servicio.destino,
        verificacion.actividad || servicio.nombre
      ].join('__');

      let cambios;

      if (cacheRevisiones.has(claveRevision)) {
        cambios =
          cacheRevisiones.get(claveRevision);
      } else {
        cambios =
          await detectarCambiosEnVerificacionGuardada(
            verificacion
          );

        cacheRevisiones.set(
          claveRevision,
          cambios
        );
      }

      const fechaRevision =
        new Date().toISOString();

      if (!cambios.length) {
        payload[
          `reservas.${fecha}.revisionCambios`
        ] = {
          estado: 'SIN_CAMBIOS',
          ultimaRevision: fechaRevision,
          cambios: []
        };

        /*
         * Si estaba marcada para reenvío pero el cambio
         * ya fue revertido, restauramos el estado.
         */
        if (
          reserva.estado === 'REQUIERE_REENVIO'
        ) {
          const estadoRestaurado =
            reserva.estadoAntesRevision ||
            'ENVIADA';

          payload[
            `reservas.${fecha}.estado`
          ] = estadoRestaurado;

          /*
           * No escribimos null en Firestore.
           * Dejamos el campo vacío para evitar errores
           * o inconsistencias de actualización.
           */
          payload[
            `reservas.${fecha}.estadoAntesRevision`
          ] = '';

          reserva.estado =
            estadoRestaurado;

          reserva.estadoAntesRevision = '';
        }

        reserva.revisionCambios = {
          estado: 'SIN_CAMBIOS',
          ultimaRevision: fechaRevision,
          cambios: []
        };

        continue;
      }

      /*
       * Conservamos el estado previo solamente cuando
       * entra por primera vez a REQUIERE_REENVIO.
       */
      if (
        reserva.estado !== 'REQUIERE_REENVIO'
      ) {
        payload[
          `reservas.${fecha}.estadoAntesRevision`
        ] = reserva.estado;

        reserva.estadoAntesRevision =
          reserva.estado;
      }

      payload[
        `reservas.${fecha}.estado`
      ] = 'REQUIERE_REENVIO';

      payload[
        `reservas.${fecha}.revisionCambios`
      ] = {
        estado: 'CON_CAMBIOS',
        ultimaRevision: fechaRevision,
        cambios
      };

      /*
       * También actualizamos el objeto local para que
       * el botón cambie sin recargar la página.
       */
      reserva.estado =
        'REQUIERE_REENVIO';

      reserva.revisionCambios = {
        estado: 'CON_CAMBIOS',
        ultimaRevision: fechaRevision,
        cambios
      };
    }

    if (Object.keys(payload).length) {
      const ref = refServicioContador(
        servicio.destino,
        servicio.nombre
      );

      try {
        await updateDoc(ref, payload);
      } catch (error) {
        /*
         * Un servicio con problemas no debe impedir que
         * se revisen los siguientes.
         */
        console.error(
          `Error guardando revisión de ${servicio.nombre} / ${servicio.destino}:`,
          error
        );
      }
    }

    if (typeof onProgreso === 'function') {
      onProgreso({
        actual: i + 1,
        total: servicios.length,
        servicio
      });
    }
  }
}

async function detectarCambiosEnVerificacionGuardada(verificacion) {
  const cambios = [];

  for (const g of verificacion.grupos || []) {
    if (!g || g.estado === 'ERROR CONSULTA') continue;

    const numerosPago = Array.isArray(g.numerosPago) && g.numerosPago.length
      ? g.numerosPago
      : obtenerNumerosNegocioPago(g.numeroNegocio);

    const actual = await consultarResumenPagosFusionado(numerosPago);

    const antesPax = Number(g.paxPagos || 0);
    const ahoraPax = Number(actual.totalViajan || 0);

    const antesAdultos = Number(g.totalAdultosPagos || 0);
    const ahoraAdultos = Number(actual.totalAdultos || 0);

    const antesEstudiantes = Number(g.totalEstudiantesPagos || 0);
    const ahoraEstudiantes = Number(actual.totalEstudiantes || 0);

    const diffPax = ahoraPax - antesPax;
    const diffAdultos = ahoraAdultos - antesAdultos;
    const diffEstudiantes = ahoraEstudiantes - antesEstudiantes;

    if (diffPax !== 0 || diffAdultos !== 0 || diffEstudiantes !== 0) {
      cambios.push({
        tipo: 'CAMBIO_PAGOS_GRUPO',
        numeroNegocio: g.numeroNegocio,
        nombreGrupo: g.nombreGrupo || '',
        numerosPago,

        antes: {
          pax: antesPax,
          adultos: antesAdultos,
          estudiantes: antesEstudiantes
        },

        ahora: {
          pax: ahoraPax,
          adultos: ahoraAdultos,
          estudiantes: ahoraEstudiantes
        },

        diferencia: {
          pax: diffPax,
          adultos: diffAdultos,
          estudiantes: diffEstudiantes
        },

        detalle: construirTextoCambioReserva(diffAdultos, diffEstudiantes, diffPax)
      });
    }
  }

  if (verificacion.snapshotLogistico) {
    const ahoraSnapshot = construirSnapshotReservaActual(
      verificacion.destino,
      verificacion.actividad
    );

    const cambiosLogisticos = compararSnapshotLogisticoReserva(
      verificacion.snapshotLogistico,
      ahoraSnapshot
    );

    cambiosLogisticos.forEach(c => {
      cambios.push({
        ...c,
        tipoControl: 'LOGISTICA_POR_FECHA'
      });
    });
  }

  return cambios;
}

function construirTextoCambioReserva(diffAdultos, diffEstudiantes, diffPax) {
  const partes = [];

  if (diffAdultos !== 0) {
    partes.push(`Adultos ${diffAdultos > 0 ? '+' : ''}${diffAdultos}`);
  }

  if (diffEstudiantes !== 0) {
    partes.push(`Estudiantes ${diffEstudiantes > 0 ? '+' : ''}${diffEstudiantes}`);
  }

  if (!partes.length && diffPax !== 0) {
    partes.push(`PAX ${diffPax > 0 ? '+' : ''}${diffPax}`);
  }

  return partes.join(' · ');
}

// =====================================================
// VERIFICACIÓN PAX RESERVA vs SISTEMA DE PAGOS
// =====================================================

async function verificarPaxReservaConPagos() {
  if (!reservaActualSnapshot || !Array.isArray(reservaActualSnapshot.grupos)) {
    alert('Primero abre una reserva.');
    return;
  }

  const resumen = document.getElementById('verificacionPagosResumen');
  const tbody = document.getElementById('verificacionPagosBody');

  resumen.innerHTML = 'Consultando sistema de pagos...';
  tbody.innerHTML = '';

  document.getElementById('modalVerificacionPagos').style.display = 'block';

  const resultados = [];
  const cachePagos = new Map();

  async function obtenerResumenPagosGrupo(numeroNegocio) {
    const key = String(numeroNegocio || '').trim();

    if (cachePagos.has(key)) {
      return cachePagos.get(key);
    }

    const numerosPago = obtenerNumerosNegocioPago(key);
    const resumenPagos = await consultarResumenPagosFusionado(numerosPago);

    const data = {
      numerosPago,
      resumenPagos
    };

    cachePagos.set(key, data);
    return data;
  }

  for (const g of reservaActualSnapshot.grupos) {
    try {
      const numeroNegocio = g.numeroNegocio || g.id;
      const { numerosPago, resumenPagos } = await obtenerResumenPagosGrupo(numeroNegocio);

      const paxPagos = resumenPagos.totalViajan;
      const paxCorreo = Number(g.paxCorreo || 0);
      const diferencia = paxPagos - paxCorreo;

      const detalle = construirDetalleDiferencia(g, resumenPagos);

      resultados.push({
        numeroNegocio,
        numerosPago,
        nombreGrupo: g.nombreGrupo || '',
        paxCorreo,
        paxPagos,
        diferencia,
        estado: detalle.tieneDiferenciaReal ? 'DIFERENCIA' : 'OK',

        adultosCorreo: g.adultosCorreo || { M: 0, F: 0, O: 0 },
        estudiantesCorreo: g.estudiantesCorreo || { M: 0, F: 0, O: 0 },
        totalAdultosCorreo: Number(g.totalAdultosCorreo || 0),
        totalEstudiantesCorreo: Number(g.totalEstudiantesCorreo || 0),

        adultosPagos: resumenPagos.adultos,
        estudiantesPagos: resumenPagos.estudiantes,
        totalAdultosPagos: resumenPagos.totalAdultos,
        totalEstudiantesPagos: resumenPagos.totalEstudiantes,

        fechas: g.fechas || [],

        detalle
      });

    } catch (error) {
      console.error('Error verificando grupo con pagos:', g, error);

      resultados.push({
        numeroNegocio: g.numeroNegocio || g.id,
        numerosPago: obtenerNumerosNegocioPago(g.numeroNegocio || g.id),
        nombreGrupo: g.nombreGrupo || '',
        paxCorreo: Number(g.paxCorreo || 0),
        paxPagos: '',
        diferencia: '',
        estado: 'ERROR CONSULTA',
        fechas: g.fechas || [],
        detalle: null
      });
    }
  }

  const fechasVerificadas = reservaActualSnapshot.fechas.map(f => ({
    ...f,
    grupos: f.grupos.map(g => {
      const encontrado = resultados.find(r =>
        String(r.numeroNegocio) === String(g.numeroNegocio || g.id)
      );

      return {
        ...g,
        paxPagos: encontrado?.paxPagos ?? '',
        totalAdultosPagos: encontrado?.totalAdultosPagos ?? '',
        totalEstudiantesPagos: encontrado?.totalEstudiantesPagos ?? '',
        estadoPagos: encontrado?.estado || ''
      };
    })
  }));

  ultimaVerificacionPagos = {
    fecha: new Date().toISOString(),
    destino: reservaActualSnapshot.destino,
    actividad: reservaActualSnapshot.actividad,

    grupos: resultados,

    snapshotLogistico: {
      destino: reservaActualSnapshot.destino,
      actividad: reservaActualSnapshot.actividad,
      fechas: fechasVerificadas,
      resumenLogistico: reservaActualSnapshot.resumenLogistico
    },

    resumen: calcularResumenVerificacion(resultados)
  };

  renderVerificacionPagos(resultados);
}

function obtenerNumerosNegocioPago(numeroNegocio) {
  const raw = String(numeroNegocio || '').trim();

  if (!raw) return [];

  // Solo fusiona si es exactamente formato num-num, ejemplo: 1581-1582
  // Evita romper IDs tipo 1412-101.
  if (/^\d+\s*-\s*\d+$/.test(raw)) {
    return raw
      .split('-')
      .map(x => x.trim())
      .filter(Boolean);
  }

  return [raw];
}

async function consultarResumenPagosFusionado(numerosPago) {
  const acumulado = crearResumenPagosVacio();

  for (const numero of numerosPago) {
    const url = `${API_PAGOS_URL}?modo=detalle&numeroNegocio=${encodeURIComponent(numero)}`;
    const res = await fetch(url);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} consultando ${numero}`);
    }

    const data = await res.json();

    const pasajeros =
      data?.nominas?.data?.pasajeros ||
      data?.saldos?.data?.detalle_pasajeros ||
      [];

    const resumen = calcularResumenPagosContador(pasajeros);
    sumarResumenPagos(acumulado, resumen);
  }

  return acumulado;
}

function crearResumenPagosVacio() {
  return {
    adultos: { M: 0, F: 0, O: 0 },
    estudiantes: { M: 0, F: 0, O: 0 },
    totalAdultos: 0,
    totalEstudiantes: 0,
    totalViajan: 0,
    totalNoViajan: 0,
    totalLeidos: 0
  };
}

function sumarResumenPagos(base, add) {
  ['M', 'F', 'O'].forEach(k => {
    base.adultos[k] += Number(add.adultos?.[k] || 0);
    base.estudiantes[k] += Number(add.estudiantes?.[k] || 0);
  });

  base.totalAdultos += Number(add.totalAdultos || 0);
  base.totalEstudiantes += Number(add.totalEstudiantes || 0);
  base.totalViajan += Number(add.totalViajan || 0);
  base.totalNoViajan += Number(add.totalNoViajan || 0);
  base.totalLeidos += Number(add.totalLeidos || 0);
}

function construirDetalleDiferencia(g, resumenPagos) {
  const totalAdultosCorreo = Number(g.totalAdultosCorreo || 0);
  const totalEstudiantesCorreo = Number(g.totalEstudiantesCorreo || 0);
  const totalCorreo = Number(g.paxCorreo || 0);

  const totalAdultosPagos = Number(resumenPagos.totalAdultos || 0);
  const totalEstudiantesPagos = Number(resumenPagos.totalEstudiantes || 0);
  const totalPagos = Number(resumenPagos.totalViajan || 0);

  const filas = [
    {
      categoria: 'Adultos',
      correo: totalAdultosCorreo,
      pagos: totalAdultosPagos
    },
    {
      categoria: 'Estudiantes',
      correo: totalEstudiantesCorreo,
      pagos: totalEstudiantesPagos
    },
    {
      categoria: 'TOTAL',
      correo: totalCorreo,
      pagos: totalPagos,
      total: true
    }
  ];

  filas.forEach(f => {
    f.diferencia = f.pagos - f.correo;
  });

  return {
    filas,

    desglosePagos: {
      adultos: resumenPagos.adultos || { M: 0, F: 0, O: 0 },
      estudiantes: resumenPagos.estudiantes || { M: 0, F: 0, O: 0 }
    },

    tieneDiferenciaDetalle: filas.some(f => Number(f.diferencia || 0) !== 0),
    tieneDiferenciaReal: filas.some(f => Number(f.diferencia || 0) !== 0)
  };
}

function renderVerificacionPagos(resultados) {
  const resumen = document.getElementById('verificacionPagosResumen');
  const tbody = document.getElementById('verificacionPagosBody');

  const conDiferencia = resultados.filter(r => r.estado !== 'OK');

  const resumenCalc = calcularResumenVerificacion(resultados);
  
  if (resumenCalc.estadoGeneral === 'OK') {
    resumen.innerHTML = `✅ Todos los grupos coinciden con el sistema de pagos. Total grupos revisados: ${resultados.length}.`;
  } else if (resumenCalc.estadoGeneral === 'REDISTRIBUCION') {
    resumen.innerHTML = `
      ⚠️ Redistribución detectada: hay ${resumenCalc.gruposConDiferencia} grupo(s) con diferencia,
      pero la diferencia neta total es 0.
      <br><small>El total general coincide, pero cambió la distribución por grupo.</small>
    `;
  } else {
    resumen.innerHTML = `
      ⚠️ Hay ${resumenCalc.gruposConDiferencia} grupo(s) con diferencia o error de consulta.
      Diferencia neta total: ${resumenCalc.totalDiferencia}.
    `;
  }

  tbody.innerHTML = resultados.map((r, idx) => {
    const color = r.estado === 'OK' ? '#09832e' : '#ca0a1f';
    const diffTxt = r.diferencia === '' ? '' : (r.diferencia > 0 ? `+${r.diferencia}` : r.diferencia);

    const diffHtml = r.estado === 'DIFERENCIA'
      ? `<button class="btn-diff-pagos"
                 data-idx="${idx}"
                 style="border:0; background:transparent; color:${color}; font-weight:bold; text-decoration:underline; cursor:pointer;">
           ${diffTxt}
         </button>`
      : `<span style="font-weight:bold; color:${color};">${diffTxt}</span>`;

    return `
      <tr>
        <td>${r.numeroNegocio}</td>
        <td>${r.nombreGrupo}</td>
        <td>${r.paxCorreo}</td>
        <td>${r.paxPagos}</td>
        <td>${diffHtml}</td>
        <td style="font-weight:bold; color:${color};">${r.estado}</td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('.btn-diff-pagos').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.idx);
      abrirDetalleDiferenciaPagos(resultados[idx]);
    });
  });
}

function abrirDetalleDiferenciaPagos(r) {
  if (!r || !r.detalle) return;

  document.getElementById('detalleDiffTitulo').textContent =
    `Detalle diferencia - ${r.numeroNegocio}`;

  document.getElementById('detalleDiffResumen').innerHTML = `
    <div>${r.nombreGrupo}</div>
    <div style="margin-top:.5rem;">
      PAX correo: ${r.paxCorreo} ·
      PAX pagos: ${r.paxPagos} ·
      Diferencia: <span style="color:${r.diferencia === 0 ? '#09832e' : '#ca0a1f'};">
        ${r.diferencia > 0 ? '+' + r.diferencia : r.diferencia}
      </span>
    </div>
    <div style="font-size:.9em; color:#555; margin-top:.35rem;">
      Información calculada solo con pasajeros activos que viajan.
      ${r.numerosPago?.length > 1 ? ` Se sumaron negocios: ${r.numerosPago.join(' + ')}.` : ''}
    </div>
  `;

  const tbody = document.getElementById('detalleDiffBody');

  tbody.innerHTML = r.detalle.filas.map(f => {
    const color = f.diferencia === 0 ? '#09832e' : '#ca0a1f';
    const diffTxt = f.diferencia > 0 ? `+${f.diferencia}` : f.diferencia;
  
    return `
      <tr style="${f.total ? 'font-weight:bold; background:#f7f7f7;' : ''}">
        <td>${f.categoria}</td>
        <td>${f.correo}</td>
        <td>${f.pagos}</td>
        <td style="color:${color}; font-weight:bold;">${diffTxt}</td>
      </tr>
    `;
  }).join('');
  
  const d = r.detalle.desglosePagos || {};
  const adultos = d.adultos || { M: 0, F: 0, O: 0 };
  const estudiantes = d.estudiantes || { M: 0, F: 0, O: 0 };
  
  tbody.innerHTML += `
    <tr>
      <td colspan="4" style="background:#f7f7f7; font-weight:bold;">
        Desglose informativo del sistema de pagos
      </td>
    </tr>
    <tr>
      <td>Adultos en pagos</td>
      <td colspan="3">Masculino: ${adultos.M} · Femenino: ${adultos.F} · Sin dato: ${adultos.O}</td>
    </tr>
    <tr>
      <td>Estudiantes en pagos</td>
      <td colspan="3">Masculino: ${estudiantes.M} · Femenino: ${estudiantes.F} · Sin dato: ${estudiantes.O}</td>
    </tr>
  `;

  document.getElementById('modalDetalleDiferenciaPagos').style.display = 'block';
}

function calcularResumenVerificacion(resultados) {
  const gruposConDiferencia = resultados.filter(r => r.estado === 'DIFERENCIA').length;
  const gruposError = resultados.filter(r => r.estado === 'ERROR CONSULTA').length;
  const totalDiferencia = resultados.reduce((s, r) => s + (Number(r.diferencia) || 0), 0);

  let estadoGeneral = 'OK';
  let tipoDiferencia = 'SIN_DIFERENCIAS';

  if (gruposError > 0) {
    estadoGeneral = 'CON_DIFERENCIAS';
    tipoDiferencia = 'ERROR_CONSULTA';
  } else if (gruposConDiferencia > 0 && totalDiferencia === 0) {
    estadoGeneral = 'REDISTRIBUCION';
    tipoDiferencia = 'REDISTRIBUCION_ENTRE_GRUPOS';
  } else if (gruposConDiferencia > 0 && totalDiferencia !== 0) {
    estadoGeneral = 'CON_DIFERENCIAS';
    tipoDiferencia = 'CAMBIO_TOTAL_PAX';
  }

  return {
    totalGrupos: resultados.length,
    gruposConDiferencia,
    gruposError,
    totalDiferencia,
    estadoGeneral,
    tipoDiferencia
  };
}

function calcularResumenPagosContador(items) {
  const resumen = crearResumenPagosVacio();

  const pasajeros = Array.isArray(items) ? items : [];

  pasajeros.forEach(item => {
    const p = item?.pasajero || item || {};
    resumen.totalLeidos++;

    const viaja = pasajeroViajaContador(p);

    if (!viaja) {
      resumen.totalNoViajan++;
      return;
    }

    resumen.totalViajan++;

    const tipo = tipoPasajeroPagosContador(p);
    const sexo = sexoPasajeroPagosContador(p);

    if (tipo === 'estudiante') {
      resumen.estudiantes[sexo]++;
      resumen.totalEstudiantes++;
    } else {
      resumen.adultos[sexo]++;
      resumen.totalAdultos++;
    }
  });

  return resumen;
}

function pasajeroViajaContador(p) {
  const v =
    p.viaja ??
    p.estado_viaje ??
    p.estado ??
    p.activo ??
    '';

  if (typeof v === 'number') {
    return Number(v) === 1;
  }

  const txt = normalizarTextoContador(v);

  if (!txt) return true;

  if (
    txt === '1' ||
    txt === 'si' ||
    txt === 'sí' ||
    txt === 'viaja' ||
    txt === 'activo' ||
    txt === 'activa'
  ) {
    return true;
  }

  if (
    txt === '0' ||
    txt === 'no' ||
    txt === 'no viaja' ||
    txt === 'anulado' ||
    txt === 'anulada' ||
    txt === 'baja'
  ) {
    return false;
  }

  return true;
}

function tipoPasajeroPagosContador(p) {
  const categoria = normalizarTextoContador(
    p.ocupacion_categoria ||
    p.categoria ||
    p.tipo_pasajero ||
    p.tipo ||
    p.ocupacion ||
    ''
  );

  if (
    categoria.includes('estudiante') ||
    categoria.includes('alumno') ||
    categoria.includes('alumna')
  ) {
    return 'estudiante';
  }

  return 'adulto';
}

function sexoPasajeroPagosContador(p) {
  const sexo = normalizarTextoContador(
    p.sexo ||
    p.genero ||
    p.gender ||
    ''
  );

  if (
    sexo === 'm' ||
    sexo.includes('masculino') ||
    sexo.includes('hombre')
  ) {
    return 'M';
  }

  if (
    sexo === 'f' ||
    sexo.includes('femenino') ||
    sexo.includes('mujer')
  ) {
    return 'F';
  }

  return 'O';
}

function normalizarTextoContador(txt) {
  return String(txt || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

// =====================================================
// GUARDAR HISTORIAL DE VERIFICACIÓN EN RESERVA
// =====================================================

function abrirModalGuardarVerificacionPagos() {
  if (!ultimaVerificacionPagos) {
    alert('Primero debes verificar PAX con pagos.');
    return;
  }

  const r = ultimaVerificacionPagos.resumen;

  let estadoTexto = 'OK, sin diferencias';
  
  if (r.estadoGeneral === 'REDISTRIBUCION') {
    estadoTexto = 'Redistribución entre grupos';
  } else if (r.estadoGeneral === 'CON_DIFERENCIAS') {
    estadoTexto = 'Con diferencias / pendientes';
  }
  
  document.getElementById('guardarVerificacionResumen').innerHTML = `
    <div><strong>Actividad:</strong> ${ultimaVerificacionPagos.actividad}</div>
    <div><strong>Destino:</strong> ${ultimaVerificacionPagos.destino}</div>
    <div><strong>Grupos revisados:</strong> ${r.totalGrupos}</div>
    <div><strong>Estado:</strong> ${estadoTexto}</div>
    <div><strong>Grupos con diferencia:</strong> ${r.gruposConDiferencia}</div>
    <div><strong>Diferencia neta total:</strong> ${r.totalDiferencia}</div>
    ${
      r.estadoGeneral === 'REDISTRIBUCION'
        ? `<div style="margin-top:.5rem; color:#b26b00; font-weight:bold;">
            ⚠️ El total general coincide, pero hay diferencias por grupo.
          </div>`
        : ''
    }
  `;

  document.getElementById('guardarVerificacionComentario').value = '';

  document.getElementById('modalGuardarVerificacionPagos').style.display = 'block';
}

async function guardarVerificacionPagosEnReserva() {
  if (!ultimaVerificacionPagos || !reservaActualSnapshot) {
    alert('No hay verificación para guardar.');
    return;
  }

  const comentario = document.getElementById('guardarVerificacionComentario').value.trim();
  const resumen = ultimaVerificacionPagos.resumen;

  if (resumen.estadoGeneral !== 'OK' && !comentario) {
    alert('Hay diferencias o redistribución entre grupos. Debes escribir una justificación antes de guardar.');
    return;
  }

  const destino = reservaActualSnapshot.destino;
  const actividad = reservaActualSnapshot.actividad;
  const cuerpo = document.getElementById('modalCuerpo').value;

  const ref = refServicioContador(destino, actividad);

  const payload = {};
  const verificacionGuardada = {
    ...ultimaVerificacionPagos,
    comentario,
    usuario: auth.currentUser?.email || '',
    guardadoEn: new Date().toISOString(),
  
    snapshotLogistico: ultimaVerificacionPagos.snapshotLogistico || {
      destino: reservaActualSnapshot.destino,
      actividad: reservaActualSnapshot.actividad,
      fechas: reservaActualSnapshot.fechas || [],
      resumenLogistico: reservaActualSnapshot.resumenLogistico || {}
    }
  };

  for (const f of fechasOrdenadas) {
    const totalEnviado = grupos.reduce((sum, g) => {
      const acts = g.itinerario?.[f] || [];
      const t = acts
        .filter(a => actividadCoincideReserva(a, actividad))
        .reduce((acc, a) => acc + ((parseInt(a.adultos) || 0) + (parseInt(a.estudiantes) || 0)), 0);
      return sum + t;
    }, 0);

    if (totalEnviado > 0) {
      payload[`reservas.${f}.estado`] =
        resumen.estadoGeneral === 'OK'
          ? 'VERIFICADA'
          : 'PENDIENTE_VERIFICADA';

      payload[`reservas.${f}.cuerpo`] = cuerpo;
      payload[`reservas.${f}.totalEnviado`] = totalEnviado;
      payload[`reservas.${f}.verificacionPagos`] = verificacionGuardada;
      payload[`reservas.${f}.updatedAt`] = serverTimestamp();
    }
  }

  if (!Object.keys(payload).length) {
    alert('No hay fechas con PAX para guardar esta verificación.');
    return;
  }

  await updateDoc(ref, payload);

  document.getElementById('modalGuardarVerificacionPagos').style.display = 'none';

  alert('Verificación guardada como historial de la reserva.');
}
