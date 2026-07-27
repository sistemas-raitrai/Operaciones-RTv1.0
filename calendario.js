import { app, db } from './firebase-init.js';

import {
  collection,
  getDocs,
  doc,
  getDoc,
  updateDoc,
  addDoc,
  query,
  orderBy,
  onSnapshot
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

import {
  getAuth,
  onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';

const auth = getAuth(app);

const COLECCION_RESUMEN =
  'operaciones_calendario_resumen';

const COLECCION_GRUPOS =
  'grupos';

let dtHist = null;
let editMode = false;

let unsubscribeCalendario = null;
let refrescandoCalendario = false;
let cargaInicialRealizada = false;


// ======================================================
// AÑO COMERCIAL
// Marzo del año actual a febrero del siguiente
// ======================================================

function getAnoComercialActual() {
  const hoy = new Date();
  const mes = hoy.getMonth();

  if (mes < 2) {
    return hoy.getFullYear() - 1;
  }

  return hoy.getFullYear();
}

const ANO_COMERCIAL_ACTUAL =
  String(getAnoComercialActual());


// ======================================================
// BARRA DE CARGA
// ======================================================

function setCarga(
  porcentaje,
  titulo,
  detalle = ''
) {
  const box =
    document.getElementById('loadBox');

  const bar =
    document.getElementById('loadProgress');

  const title =
    document.getElementById('loadTitle');

  const detail =
    document.getElementById('loadDetail');

  if (
    !box ||
    !bar ||
    !title ||
    !detail
  ) {
    return;
  }

  box.classList.remove(
    'ok',
    'error'
  );

  box.style.display = 'block';

  bar.style.width =
    `${Math.max(
      0,
      Math.min(100, porcentaje)
    )}%`;

  title.textContent = titulo;
  detail.textContent = detalle;
}


function setCargaOk(
  detalle = 'Datos cargados correctamente.'
) {
  const box =
    document.getElementById('loadBox');

  const bar =
    document.getElementById('loadProgress');

  const title =
    document.getElementById('loadTitle');

  const detail =
    document.getElementById('loadDetail');

  if (
    !box ||
    !bar ||
    !title ||
    !detail
  ) {
    return;
  }

  box.classList.remove('error');
  box.classList.add('ok');
  box.style.display = 'block';

  bar.style.width = '100%';
  title.textContent = 'Listo';
  detail.textContent = detalle;
}


function setCargaError(error) {
  const box =
    document.getElementById('loadBox');

  const bar =
    document.getElementById('loadProgress');

  const title =
    document.getElementById('loadTitle');

  const detail =
    document.getElementById('loadDetail');

  if (
    !box ||
    !bar ||
    !title ||
    !detail
  ) {
    return;
  }

  box.classList.remove('ok');
  box.classList.add('error');
  box.style.display = 'block';

  bar.style.width = '100%';
  title.textContent = 'Error al cargar';

  detail.textContent =
    error?.message ||
    String(error) ||
    'Error desconocido. Revisa consola.';
}


// ======================================================
// NORMALIZACIÓN GENERAL
// ======================================================

function normalizarTexto(valor = '') {
  return String(valor)
    .normalize('NFD')
    .replace(
      /[\u0300-\u036f]/g,
      ''
    )
    .toLowerCase()
    .replace(/\s+/g, '')
    .trim();
}


function fechaAISO(valor) {
  if (!valor) {
    return '';
  }

  if (
    typeof valor?.toDate === 'function'
  ) {
    return valor
      .toDate()
      .toISOString()
      .slice(0, 10);
  }

  if (
    valor?.seconds !== undefined
  ) {
    return new Date(
      valor.seconds * 1000
    )
      .toISOString()
      .slice(0, 10);
  }

  if (valor instanceof Date) {
    return valor
      .toISOString()
      .slice(0, 10);
  }

  const texto =
    String(valor).trim();

  if (!texto) {
    return '';
  }

  if (
    /^\d{4}-\d{2}-\d{2}$/.test(
      texto
    )
  ) {
    return texto;
  }

  const match = texto.match(
    /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/
  );

  if (match) {
    const dia =
      match[1].padStart(2, '0');

    const mes =
      match[2].padStart(2, '0');

    let ano = match[3];

    if (ano.length === 2) {
      ano = `20${ano}`;
    }

    return `${ano}-${mes}-${dia}`;
  }

  const fecha =
    new Date(texto);

  if (
    Number.isNaN(fecha.getTime())
  ) {
    return '';
  }

  return fecha
    .toISOString()
    .slice(0, 10);
}


function formatearFechaBonita(
  fechaISO
) {
  if (!fechaISO) {
    return '';
  }

  const partes =
    fechaISO
      .split('-')
      .map(Number);

  if (partes.length !== 3) {
    return fechaISO;
  }

  const [
    ano,
    mes,
    dia
  ] = partes;

  const fecha =
    new Date(
      ano,
      mes - 1,
      dia
    );

  return fecha.toLocaleDateString(
    'es-CL',
    {
      day: 'numeric',
      month: 'short'
    }
  );
}


function esDomingo(fechaISO) {
  const partes =
    String(fechaISO)
      .split('-')
      .map(Number);

  if (partes.length !== 3) {
    return false;
  }

  const [
    ano,
    mes,
    dia
  ] = partes;

  const fecha =
    new Date(
      ano,
      mes - 1,
      dia
    );

  return fecha.getDay() === 0;
}


// ======================================================
// FILTRO DESTINO
// Incluye SUR DE CHILE Y BARILOCHE
// en ambos filtros
// ======================================================

const FLT_DESTINO = {
  value: ''
};


function esDestinoMixtoSurBariloche(
  destino = ''
) {
  const clave =
    normalizarTexto(destino);

  return (
    clave.includes('surdechile') &&
    clave.includes('bariloche')
  );
}


function destinoBaseDesdeCelda(
  texto = ''
) {
  return String(texto)
    .split('//')[0]
    .trim();
}


function filtroDestinoCalendario(
  settings,
  rowData
) {
  if (
    settings.nTable.id !==
    'tablaCalendario'
  ) {
    return true;
  }

  const seleccionado =
    String(
      FLT_DESTINO.value || ''
    ).trim();

  if (!seleccionado) {
    return true;
  }

  const claveSeleccionada =
    normalizarTexto(seleccionado);

  const textoCelda =
    rowData?.[3] || '';

  const destinoBase =
    destinoBaseDesdeCelda(
      textoCelda
    );

  const claveDestino =
    normalizarTexto(
      destinoBase
    );

  const esMixto =
    esDestinoMixtoSurBariloche(
      destinoBase
    );

  if (
    claveSeleccionada ===
      'bariloche' ||
    claveSeleccionada ===
      'surdechile'
  ) {
    return (
      claveDestino ===
        claveSeleccionada ||
      esMixto
    );
  }

  return (
    claveDestino ===
    claveSeleccionada
  );
}


// ======================================================
// BUSCADOR CON COMAS
// Ejemplo: 1422, 1500
// Busca 1422 O 1500
// ======================================================

const BUSQ_COMA = {
  activo: false,
  terminos: []
};


function filtroBusquedaPorComa(
  settings,
  rowData
) {
  if (
    settings.nTable.id !==
    'tablaCalendario'
  ) {
    return true;
  }

  if (!BUSQ_COMA.activo) {
    return true;
  }

  const textoFila =
    (rowData || [])
      .join(' ')
      .toLowerCase();

  return BUSQ_COMA
    .terminos
    .some(
      termino =>
        textoFila.includes(
          termino
        )
    );
}


// ======================================================
// ORDEN DE ACTIVIDADES
// ======================================================

function horaAMinutos(
  hora
) {
  if (
    !hora ||
    typeof hora !== 'string'
  ) {
    return Number.POSITIVE_INFINITY;
  }

  const match =
    hora.match(
      /(\d{1,2})[:h.]?(\d{2})?/i
    );

  if (!match) {
    return Number.POSITIVE_INFINITY;
  }

  const horas =
    parseInt(
      match[1],
      10
    );

  const minutos =
    match[2]
      ? parseInt(
          match[2],
          10
        )
      : 0;

  if (
    Number.isNaN(horas) ||
    Number.isNaN(minutos) ||
    horas < 0 ||
    horas > 23 ||
    minutos < 0 ||
    minutos > 59
  ) {
    return Number.POSITIVE_INFINITY;
  }

  return (
    horas * 60 +
    minutos
  );
}


function compararActividades(
  actividadA = {},
  actividadB = {}
) {
  const inicioA =
    horaAMinutos(
      actividadA.horaInicio
    );

  const inicioB =
    horaAMinutos(
      actividadB.horaInicio
    );

  if (inicioA !== inicioB) {
    return inicioA - inicioB;
  }

  const finA =
    horaAMinutos(
      actividadA.horaFin
    );

  const finB =
    horaAMinutos(
      actividadB.horaFin
    );

  return finA - finB;
}


function actividadATexto(
  actividad = {}
) {
  const inicio =
    String(
      actividad.horaInicio ||
      ''
    ).trim();

  const fin =
    String(
      actividad.horaFin ||
      ''
    ).trim();

  const nombre =
    String(
      actividad.actividad ||
      ''
    ).trim();

  if (
    inicio &&
    fin
  ) {
    return (
      `${inicio}–${fin} ${nombre}`
    ).trim();
  }

  if (inicio) {
    return (
      `${inicio} ${nombre}`
    ).trim();
  }

  return nombre;
}


function actividadesATexto(
  actividades = []
) {
  if (
    !Array.isArray(actividades)
  ) {
    return '';
  }

  return [...actividades]
    .sort(compararActividades)
    .map(actividadATexto)
    .filter(Boolean)
    .join('\n');
}


// ======================================================
// FORMATO PAX, HOTELES Y VUELOS
// ======================================================

function prepararPax(
  pax = {}
) {
  const adultos =
    Number(
      pax.adultos || 0
    );

  const estudiantes =
    Number(
      pax.estudiantes || 0
    );

  const totalInformado =
    Number(
      pax.total || 0
    );

  const total =
    totalInformado ||
    adultos +
    estudiantes;

  return {
    adultos,
    estudiantes,
    total
  };
}


function formatearPax(
  pax = {}
) {
  const datos =
    prepararPax(pax);

  return (
    `${datos.total} ` +
    `(A: ${datos.adultos} ` +
    `E: ${datos.estudiantes})`
  );
}


function formatearHoteles(
  hoteles = []
) {
  if (
    !Array.isArray(hoteles)
  ) {
    return '';
  }

  const lineas =
    hoteles
      .map(hotel => {
        const nombre =
          String(
            hotel?.nombre ||
            ''
          )
            .trim()
            .toUpperCase();

        const checkIn =
          fechaAISO(
            hotel?.checkIn
          );

        const checkOut =
          fechaAISO(
            hotel?.checkOut
          );

        let rango = '';

        if (
          checkIn ||
          checkOut
        ) {
          rango =
            ` (` +
            `${checkIn
              ? formatearFechaBonita(
                  checkIn
                )
              : '—'}` +
            ` → ` +
            `${checkOut
              ? formatearFechaBonita(
                  checkOut
                )
              : '—'}` +
            `)`;
        }

        return (
          `${nombre}${rango}`
        ).trim();
      })
      .filter(Boolean);

  return [
    ...new Set(lineas)
  ].join('\n');
}


function obtenerFechaOrdenVuelo(
  vuelo = {}
) {
  const fecha =
    fechaAISO(
      vuelo.fecha ||
      vuelo.fechaIda ||
      vuelo.fechaSalida
    );

  if (!fecha) {
    return Number.MAX_SAFE_INTEGER;
  }

  const salida =
    String(
      vuelo.salida ||
      '23:59'
    ).trim();

  const fechaHora =
    new Date(
      `${fecha}T${salida}:00`
    );

  const milisegundos =
    fechaHora.getTime();

  if (
    Number.isNaN(
      milisegundos
    )
  ) {
    return Number.MAX_SAFE_INTEGER;
  }

  return milisegundos;
}


function formatearVuelos(
  vuelos = []
) {
  if (
    !Array.isArray(vuelos)
  ) {
    return {
      texto: '',
      orden:
        Number.MAX_SAFE_INTEGER
    };
  }

  const preparados =
    vuelos
      .map(vuelo => {
        const resumen =
          String(
            vuelo?.resumen ||
            ''
          ).trim();

        if (resumen) {
          return {
            texto: resumen,
            orden:
              obtenerFechaOrdenVuelo(
                vuelo
              )
          };
        }

        const tipo =
          String(
            vuelo?.tipo ||
            'AÉREO'
          ).trim();

        const proveedor =
          String(
            vuelo?.proveedor ||
            ''
          ).trim();

        const numero =
          String(
            vuelo?.numero ||
            ''
          ).trim();

        const origen =
          String(
            vuelo?.origen ||
            ''
          ).trim();

        const destino =
          String(
            vuelo?.destino ||
            ''
          ).trim();

        const fecha =
          fechaAISO(
            vuelo?.fecha
          );

        const partes = [
          tipo,
          proveedor,
          numero
        ].filter(Boolean);

        let texto =
          partes.join(' ');

        if (
          origen ||
          destino
        ) {
          texto +=
            ` · ${origen}` +
            ` → ${destino}`;
        }

        if (fecha) {
          texto +=
            ` · ${fecha}`;
        }

        return {
          texto:
            texto.trim(),
          orden:
            obtenerFechaOrdenVuelo(
              vuelo
            )
        };
      })
      .filter(item => item.texto);

  const unicos =
    new Map();

  preparados.forEach(item => {
    if (
      !unicos.has(
        item.texto
      )
    ) {
      unicos.set(
        item.texto,
        item
      );
    }
  });

  const ordenados =
    [...unicos.values()]
      .sort(
        (a, b) =>
          a.orden -
            b.orden ||
          a.texto.localeCompare(
            b.texto
          )
      );

  return {
    texto:
      ordenados
        .map(
          item => item.texto
        )
        .join('\n'),

    orden:
      ordenados.length
        ? ordenados[0].orden
        : Number.MAX_SAFE_INTEGER
  };
}


// ======================================================
// NORMALIZAR DOCUMENTO DEL RESUMEN
// ======================================================

function prepararGrupoResumen(
  docSnap
) {
  const datos =
    docSnap.data() || {};

  const grupoId =
    String(
      datos.grupoId ||
      docSnap.id
    ).trim();

  const numeroNegocio =
    String(
      datos.numeroNegocio ||
      grupoId
    ).trim();

  const fechaInicio =
    fechaAISO(
      datos.fechaInicio
    );

  const fechaFin =
    fechaAISO(
      datos.fechaFin
    );

  const itinerario =
    datos.itinerario &&
    typeof datos.itinerario ===
      'object'
      ? datos.itinerario
      : {};

  let fechasItinerario =
    Array.isArray(
      datos.fechasItinerario
    )
      ? datos.fechasItinerario
          .map(fechaAISO)
          .filter(Boolean)
      : [];

  if (
    !fechasItinerario.length
  ) {
    fechasItinerario =
      Object.keys(itinerario)
        .map(fechaAISO)
        .filter(Boolean);
  }

  fechasItinerario =
    [...new Set(
      fechasItinerario
    )].sort();

  return {
    id: grupoId,
    grupoId,
    numeroNegocio,

    nombreGrupo:
      String(
        datos.nombreGrupo ||
        ''
      ).trim(),

    destino:
      String(
        datos.destino ||
        ''
      ).trim(),

    programa:
      String(
        datos.programa ||
        ''
      ).trim(),

    anoViaje:
      String(
        datos.anoViaje ||
        ''
      ).trim(),

    fechaInicio,
    fechaFin,

    pax:
      prepararPax(
        datos.pax || {}
      ),

    hoteles:
      Array.isArray(
        datos.hoteles
      )
        ? datos.hoteles
        : [],

    vuelos:
      Array.isArray(
        datos.vuelos
      )
        ? datos.vuelos
        : [],

    itinerario,
    fechasItinerario,

    busquedaTexto:
      String(
        datos.busquedaTexto ||
        ''
      ).trim()
  };
}


// ======================================================
// PARÁMETRO URL
// ======================================================

function getParametroURL(
  nombre
) {
  const parametros =
    new URLSearchParams(
      window.location.search
    );

  return parametros.get(
    nombre
  );
}

const numeroNegocioInicial =
  getParametroURL(
    'numeroNegocio'
  );


// ======================================================
// AJUSTE VISUAL DATATABLE
// ======================================================

function ajustarVistaCalendario(
  tabla
) {
  window.setTimeout(
    () => {
      try {
        if (
          !$.fn.DataTable
            .isDataTable(
              '#tablaCalendario'
            )
        ) {
          return;
        }

        tabla.draw(false);

        try {
          tabla.columns.adjust();
        } catch (error) {
          console.warn(
            'columns.adjust omitido:',
            error
          );
        }

        $(window).trigger(
          'resize'
        );
      } catch (error) {
        console.warn(
          'Ajuste visual omitido:',
          error
        );
      }
    },
    200
  );
}


// ======================================================
// INICIO CON AUTENTICACIÓN
// ======================================================

$(function () {
  onAuthStateChanged(
    auth,
    user => {
      if (!user) {
        location =
          'login.html';

        return;
      }

      escucharCambiosCalendario(
        user.email
      );
    }
  );
});


// ======================================================
// ESCUCHAR SOLO LA COLECCIÓN LIVIANA
// ======================================================

function escucharCambiosCalendario(
  userEmail
) {
  if (
    unsubscribeCalendario
  ) {
    unsubscribeCalendario();
  }

  setCarga(
    10,
    'Cargando calendario...',
    'Leyendo resumen de operaciones'
  );

  unsubscribeCalendario =
    onSnapshot(
      collection(
        db,
        COLECCION_RESUMEN
      ),

      async snapshot => {
        if (
          refrescandoCalendario
        ) {
          return;
        }

        refrescandoCalendario =
          true;

        try {
          await generarTablaCalendario(
            userEmail,
            snapshot
          );

          cargaInicialRealizada =
            true;
        } finally {
          refrescandoCalendario =
            false;
        }
      },

      error => {
        console.error(
          'Error escuchando resumen del calendario:',
          error
        );

        setCargaError(error);
      }
    );
}


// ======================================================
// FUNCIÓN PRINCIPAL
// ======================================================

async function generarTablaCalendario(
  userEmail,
  snapshotResumen
) {
  try {
    const filtroBuscadorActual =
      $('#buscador').val() ||
      '';

    const filtroDestinoActual =
      $('#filtroDestino').val() ||
      '';

    const filtroAnoActual =
      $('#filtroAno').val() ||
      ANO_COMERCIAL_ACTUAL;

    const filtroFechaActual =
      $('#filtroFechaDesde').val() ||
      '';

    setCarga(
      25,
      'Resumen cargado',
      `${snapshotResumen.size} documentos encontrados`
    );

    if (
      $.fn.DataTable
        .isDataTable(
          '#tablaCalendario'
        )
    ) {
      $('#tablaCalendario')
        .DataTable()
        .destroy();
    }

    $('#encabezadoCalendario')
      .empty();

    $('#cuerpoCalendario')
      .empty();

    const grupos = [];
    const fechasUnicas =
      new Set();

    const destinosSet =
      new Set();

    const aniosSet =
      new Set();

    snapshotResumen.forEach(
      docSnap => {
        const grupo =
          prepararGrupoResumen(
            docSnap
          );

        if (!grupo.id) {
          return;
        }

        grupo
          .fechasItinerario
          .forEach(fecha => {
            fechasUnicas.add(
              fecha
            );
          });

        const destino =
          grupo.destino.trim();

        if (destino) {
          if (
            esDestinoMixtoSurBariloche(
              destino
            )
          ) {
            destinosSet.add(
              'SUR DE CHILE'
            );

            destinosSet.add(
              'BARILOCHE'
            );
          } else {
            destinosSet.add(
              destino.toUpperCase()
            );
          }
        }

        if (grupo.anoViaje) {
          aniosSet.add(
            grupo.anoViaje
          );
        }

        grupos.push(grupo);
      }
    );

    grupos.sort(
      (grupoA, grupoB) => {
        const fechaA =
          grupoA.fechaInicio ||
          '9999-12-31';

        const fechaB =
          grupoB.fechaInicio ||
          '9999-12-31';

        const porFecha =
          fechaA.localeCompare(
            fechaB
          );

        if (porFecha !== 0) {
          return porFecha;
        }

        return grupoA
          .nombreGrupo
          .localeCompare(
            grupoB.nombreGrupo,
            'es'
          );
      }
    );

    setCarga(
      45,
      'Preparando calendario...',
      `${grupos.length} grupos listos`
    );

    const fechasOrdenadas =
      [...fechasUnicas].sort();

    const destinos =
      [...destinosSet].sort(
        (a, b) =>
          a.localeCompare(
            b,
            'es'
          )
      );

    const anios =
      [...aniosSet].sort(
        (a, b) =>
          Number(a) -
          Number(b)
      );

    prepararFiltros(
      destinos,
      anios,
      filtroDestinoActual,
      filtroAnoActual
    );

    construirEncabezado(
      fechasOrdenadas
    );

    construirCuerpo(
      grupos,
      fechasOrdenadas
    );

    setCarga(
      80,
      'Construyendo tabla...',
      'Inicializando filtros y columnas'
    );

    const tabla =
      inicializarDataTable(
        grupos
      );

    registrarFiltrosDataTable();

    restaurarFiltros(
      tabla,
      {
        filtroBuscadorActual,
        filtroDestinoActual,
        filtroAnoActual,
        filtroFechaActual
      }
    );

    registrarEventosFiltros(
      tabla
    );

    registrarEventosEdicion(
      tabla,
      userEmail
    );

    registrarEventosHistorial();

    aplicarNumeroNegocioInicial(
      tabla
    );

    ajustarVistaCalendario(
      tabla
    );

    setCargaOk(
      `Calendario cargado con ${grupos.length} grupos desde el resumen operativo.`
    );

    console.log(
      '[CALENDARIO] Resumen cargado',
      {
        grupos:
          grupos.length,

        fechas:
          fechasOrdenadas.length,

        cargaInicial:
          !cargaInicialRealizada
      }
    );
  } catch (error) {
    console.error(
      'Error general generando calendario:',
      error
    );

    setCargaError(error);
  }
}


// ======================================================
// PREPARAR FILTROS
// ======================================================

function prepararFiltros(
  destinos,
  anios,
  destinoSeleccionado,
  anoSeleccionado
) {
  const $destino =
    $('#filtroDestino');

  $destino
    .empty()
    .append(
      '<option value="">Todos</option>'
    );

  destinos.forEach(
    destino => {
      $('<option>')
        .val(destino)
        .text(destino)
        .appendTo($destino);
    }
  );

  const $ano =
    $('#filtroAno');

  $ano
    .empty()
    .append(
      '<option value="">Todos</option>'
    );

  anios.forEach(
    ano => {
      $('<option>')
        .val(ano)
        .text(ano)
        .appendTo($ano);
    }
  );

  if (
    destinoSeleccionado &&
    destinos.includes(
      destinoSeleccionado
    )
  ) {
    $destino.val(
      destinoSeleccionado
    );
  }

  const anoFinal =
    anoSeleccionado &&
    anios.includes(
      String(anoSeleccionado)
    )
      ? String(
          anoSeleccionado
        )
      : anios.includes(
          ANO_COMERCIAL_ACTUAL
        )
        ? ANO_COMERCIAL_ACTUAL
        : '';

  $ano.val(anoFinal);
}


// ======================================================
// CONSTRUIR ENCABEZADO
// ======================================================

function construirEncabezado(
  fechasOrdenadas
) {
  const $encabezado =
    $('#encabezadoCalendario')
      .empty();

  $encabezado.append(`
    <th>N° Negocio</th>
    <th>Grupo</th>
    <th>Pax</th>
    <th>Destino / Programa</th>
    <th>Hoteles</th>
    <th>Vuelos</th>
    <th>Año</th>
  `);

  fechasOrdenadas.forEach(
    fecha => {
      const clase =
        esDomingo(fecha)
          ? 'domingo'
          : '';

      $('<th>')
        .addClass(clase)
        .attr(
          'data-fechaiso',
          fecha
        )
        .text(
          formatearFechaBonita(
            fecha
          )
        )
        .appendTo(
          $encabezado
        );
    }
  );
}


// ======================================================
// CONSTRUIR CUERPO
// ======================================================

function construirCuerpo(
  grupos,
  fechasOrdenadas
) {
  const $tbody =
    $('#cuerpoCalendario')
      .empty();

  grupos.forEach(
    grupo => {
      const $fila =
        $('<tr>');

      const hotelesTexto =
        formatearHoteles(
          grupo.hoteles
        );

      const vuelos =
        formatearVuelos(
          grupo.vuelos
        );

      const destinoPrograma = [
        grupo.destino,
        grupo.programa
      ]
        .filter(
          valor =>
            String(valor)
              .trim()
        )
        .join(' // ');

      $fila.append(
        $('<td>')
          .text(
            grupo.numeroNegocio
          )
          .attr(
            'data-doc-id',
            grupo.id
          ),

        $('<td>')
          .text(
            grupo.nombreGrupo
          )
          .attr(
            'data-doc-id',
            grupo.id
          ),

        $('<td>')
          .text(
            formatearPax(
              grupo.pax
            )
          )
          .attr(
            'data-doc-id',
            grupo.id
          ),

        $('<td>')
          .text(
            destinoPrograma
          )
          .attr(
            'data-doc-id',
            grupo.id
          ),

        $('<td>')
          .text(
            hotelesTexto
          )
          .attr(
            'data-doc-id',
            grupo.id
          )
          .css(
            'white-space',
            'pre-line'
          ),

        $('<td>')
          .text(
            vuelos.texto
          )
          .attr(
            'data-doc-id',
            grupo.id
          )
          .attr(
            'data-order',
            String(
              vuelos.orden
            )
          )
          .css(
            'white-space',
            'pre-line'
          ),

        $('<td>')
          .text(
            grupo.anoViaje
          )
          .attr(
            'data-doc-id',
            grupo.id
          )
      );

      fechasOrdenadas.forEach(
        fecha => {
          const actividades =
            Array.isArray(
              grupo.itinerario?.[
                fecha
              ]
            )
              ? grupo.itinerario[
                  fecha
                ]
              : [];

          const texto =
            actividadesATexto(
              actividades
            );

          const clases = [];

          if (
            fecha ===
              grupo.fechaInicio ||
            fecha ===
              grupo.fechaFin
          ) {
            clases.push(
              'inicio-fin'
            );
          }

          if (
            esDomingo(fecha)
          ) {
            clases.push(
              'domingo'
            );
          }

          $('<td>')
            .addClass(
              clases.join(' ')
            )
            .text(texto)
            .attr(
              'data-doc-id',
              grupo.id
            )
            .attr(
              'data-fecha',
              fecha
            )
            .attr(
              'data-original',
              texto
            )
            .appendTo(
              $fila
            );
        }
      );

      $tbody.append(
        $fila
      );
    }
  );
}


// ======================================================
// DATATABLE
// ======================================================

function inicializarDataTable(
  grupos
) {
  return $('#tablaCalendario')
    .DataTable({
      scrollX: false,
      autoWidth: false,
      dom: 'Brtip',

      pageLength:
        Math.max(
          grupos.length,
          10
        ),

      order: [
        [5, 'asc']
      ],

      buttons: [
        {
          extend: 'colvis',
          text: 'Ver columnas',
          className:
            'dt-button',

          columns: ':gt(2)'
        }
      ],

      columnDefs: [
        {
          targets: [5],
          type: 'num'
        },
        {
          targets: [6],
          visible: false,
          searchable: true
        }
      ],

      language: {
        url:
          '//cdn.datatables.net/plug-ins/1.13.4/i18n/es-ES.json'
      }
    });
}


function registrarFiltrosDataTable() {
  if (
    !$.fn.dataTable.ext.search
      .includes(
        filtroDestinoCalendario
      )
  ) {
    $.fn.dataTable.ext.search
      .push(
        filtroDestinoCalendario
      );
  }

  if (
    !$.fn.dataTable.ext.search
      .includes(
        filtroBusquedaPorComa
      )
  ) {
    $.fn.dataTable.ext.search
      .push(
        filtroBusquedaPorComa
      );
  }
}


// ======================================================
// RESTAURAR FILTROS
// ======================================================

function restaurarFiltros(
  tabla,
  filtros
) {
  const {
    filtroBuscadorActual,
    filtroDestinoActual,
    filtroAnoActual,
    filtroFechaActual
  } = filtros;

  $('#buscador').val(
    filtroBuscadorActual
  );

  $('#filtroDestino').val(
    filtroDestinoActual
  );

  const anoDisponible =
    $('#filtroAno option')
      .toArray()
      .some(
        option =>
          option.value ===
          String(
            filtroAnoActual
          )
      );

  const anoFinal =
    anoDisponible
      ? String(
          filtroAnoActual
        )
      : $('#filtroAno').val() ||
        '';

  $('#filtroAno').val(
    anoFinal
  );

  $('#filtroFechaDesde').val(
    filtroFechaActual
  );

  FLT_DESTINO.value =
    filtroDestinoActual;

  tabla
    .column(6)
    .search(
      anoFinal
        ? `^${anoFinal}$`
        : '',
      true,
      false
    );

  if (
    filtroBuscadorActual
      .includes(',')
  ) {
    const terminos =
      filtroBuscadorActual
        .split(',')
        .map(
          texto =>
            texto
              .trim()
              .toLowerCase()
        )
        .filter(Boolean);

    BUSQ_COMA.activo =
      terminos.length > 0;

    BUSQ_COMA.terminos =
      terminos;

    tabla.search('');
  } else {
    BUSQ_COMA.activo =
      false;

    BUSQ_COMA.terminos =
      [];

    tabla.search(
      filtroBuscadorActual
    );
  }

  aplicarFiltroFechaColumnas(
    tabla,
    filtroFechaActual
  );

  tabla.draw();
}


// ======================================================
// EVENTOS DE FILTROS
// ======================================================

function registrarEventosFiltros(
  tabla
) {
  $('#buscador')
    .off('input.calendario')
    .on(
      'input.calendario',
      function () {
        const texto =
          String(
            this.value ||
            ''
          );

        if (
          texto.includes(',')
        ) {
          const terminos =
            texto
              .split(',')
              .map(
                item =>
                  item
                    .trim()
                    .toLowerCase()
              )
              .filter(Boolean);

          BUSQ_COMA.activo =
            terminos.length > 0;

          BUSQ_COMA.terminos =
            terminos;

          tabla.search('');
          tabla.draw();
        } else {
          BUSQ_COMA.activo =
            false;

          BUSQ_COMA.terminos =
            [];

          tabla
            .search(texto)
            .draw();
        }
      }
    );

  $('#filtroDestino')
    .off('change.calendario')
    .on(
      'change.calendario',
      function () {
        FLT_DESTINO.value =
          String(
            this.value ||
            ''
          ).trim();

        tabla.draw();
      }
    );

  $('#filtroAno')
    .off('change.calendario')
    .on(
      'change.calendario',
      function () {
        const valor =
          String(
            this.value ||
            ''
          );

        tabla
          .column(6)
          .search(
            valor
              ? `^${valor}$`
              : '',
            true,
            false
          )
          .draw();
      }
    );

  $('#filtroFechaDesde')
    .off('change.calendario')
    .on(
      'change.calendario',
      function () {
        aplicarFiltroFechaColumnas(
          tabla,
          this.value
        );

        ajustarVistaCalendario(
          tabla
        );
      }
    );
}


function aplicarFiltroFechaColumnas(
  tabla,
  fechaDesde
) {
  tabla
    .columns()
    .every(
      function () {
        const encabezado =
          this.header();

        const fechaColumna =
          encabezado
            ?.getAttribute?.(
              'data-fechaiso'
            );

        if (!fechaColumna) {
          return;
        }

        const mostrar =
          !fechaDesde ||
          fechaColumna >=
            fechaDesde;

        this.visible(
          mostrar,
          false
        );
      }
    );
}


// ======================================================
// NÚMERO DE NEGOCIO DESDE URL
// ======================================================

function aplicarNumeroNegocioInicial(
  tabla
) {
  if (
    !numeroNegocioInicial
  ) {
    return;
  }

  const buscador =
    $('#buscador');

  if (
    buscador.val()
  ) {
    return;
  }

  buscador.val(
    numeroNegocioInicial
  );

  tabla
    .search(
      numeroNegocioInicial
    )
    .draw();
}


// ======================================================
// EDICIÓN
// Sigue guardando en colección grupos.
// La Cloud Function actualizará el resumen.
// ======================================================

function registrarEventosEdicion(
  tabla,
  userEmail
) {
  $('#btn-toggle-edit')
    .off('click.calendario')
    .on(
      'click.calendario',
      async () => {
        editMode =
          !editMode;

        $('#btn-toggle-edit')
          .text(
            editMode
              ? '🔒 Desactivar Edición'
              : '🔓 Activar Edición'
          )
          .toggleClass(
            'activo',
            editMode
          );

        $('#tablaCalendario tbody td')
          .each(
            function () {
              const fecha =
                $(this).attr(
                  'data-fecha'
                );

              $(this).attr(
                'contenteditable',
                editMode &&
                  Boolean(fecha)
              );
            }
          );

        await addDoc(
          collection(
            db,
            'historial'
          ),
          {
            accion:
              editMode
                ? 'ACTIVÓ MODO EDICIÓN'
                : 'DESACTIVÓ MODO EDICIÓN',

            usuario:
              userEmail,

            timestamp:
              new Date()
          }
        );
      }
    );

  $('#tablaCalendario tbody')
    .off(
      'focusout.calendario',
      'td[contenteditable="true"]'
    )
    .on(
      'focusout.calendario',
      'td[contenteditable="true"]',
      async function () {
        await guardarCeldaItinerario(
          this
        );
      }
    );
}


async function guardarCeldaItinerario(
  celda
) {
  const $celda =
    $(celda);

  const textoNuevo =
    $celda.text().trim();

  const textoAnterior =
    $celda.attr(
      'data-original'
    ) || '';

  const grupoId =
    $celda.attr(
      'data-doc-id'
    );

  const fecha =
    $celda.attr(
      'data-fecha'
    );

  if (
    !grupoId ||
    !fecha ||
    textoNuevo ===
      textoAnterior
  ) {
    return;
  }

  try {
    $celda.addClass(
      'guardando'
    );

    const referenciaGrupo =
      doc(
        db,
        COLECCION_GRUPOS,
        grupoId
      );

    const snapshotGrupo =
      await getDoc(
        referenciaGrupo
      );

    if (
      !snapshotGrupo.exists()
    ) {
      throw new Error(
        `No se encontró el grupo ${grupoId}.`
      );
    }

    const datosGrupo =
      snapshotGrupo.data() ||
      {};

    const actividadesAnteriores =
      Array.isArray(
        datosGrupo
          ?.itinerario
          ?.[fecha]
      )
        ? datosGrupo
            .itinerario[
              fecha
            ]
        : [];

    const actividadesNuevas =
      parsearTextoActividades(
        textoNuevo,
        actividadesAnteriores
      );

    const actividadesOrdenadas =
      [...actividadesNuevas]
        .sort(
          compararActividades
        );

    await updateDoc(
      referenciaGrupo,
      {
        [`itinerario.${fecha}`]:
          actividadesOrdenadas
      }
    );

    const textoOrdenado =
      actividadesATexto(
        actividadesOrdenadas
      );

    await addDoc(
      collection(
        db,
        'historial'
      ),
      {
        numeroNegocio:
          grupoId,

        campo:
          `itinerario.${fecha}`,

        anterior:
          textoAnterior,

        nuevo:
          textoOrdenado,

        modificadoPor:
          auth.currentUser
            ?.email ||
          '',

        timestamp:
          new Date()
      }
    );

    $celda
      .text(
        textoOrdenado
      )
      .attr(
        'data-original',
        textoOrdenado
      )
      .removeClass(
        'error-guardado'
      )
      .addClass(
        'guardado'
      );

    window.setTimeout(
      () => {
        $celda.removeClass(
          'guardado'
        );
      },
      1200
    );
  } catch (error) {
    console.error(
      'Error guardando itinerario:',
      error
    );

    $celda
      .addClass(
        'error-guardado'
      )
      .text(
        textoAnterior
      );

    alert(
      `No se pudo guardar el cambio: ${error.message}`
    );
  } finally {
    $celda.removeClass(
      'guardando'
    );
  }
}


function parsearTextoActividades(
  texto,
  originales = []
) {
  const lineas =
    String(texto)
      .split('\n')
      .map(
        linea =>
          linea.trim()
      )
      .filter(Boolean);

  return lineas.map(
    (linea, indice) => {
      const original =
        originales[
          indice
        ] || {};

      const match =
        linea.match(
          /^(\d{1,2}[:h.]\d{2})\s*[–—-]\s*(\d{1,2}[:h.]\d{2})\s+(.*)$/
        );

      if (match) {
        return {
          ...original,

          horaInicio:
            match[1]
              .replace(
                /[h.]/,
                ':'
              )
              .trim(),

          horaFin:
            match[2]
              .replace(
                /[h.]/,
                ':'
              )
              .trim(),

          actividad:
            match[3].trim()
        };
      }

      const soloInicio =
        linea.match(
          /^(\d{1,2}[:h.]\d{2})\s+(.*)$/
        );

      if (soloInicio) {
        return {
          ...original,

          horaInicio:
            soloInicio[1]
              .replace(
                /[h.]/,
                ':'
              )
              .trim(),

          horaFin:
            original.horaFin ||
            '',

          actividad:
            soloInicio[2]
              .trim()
        };
      }

      return {
        ...original,

        horaInicio:
          original.horaInicio ||
          '',

        horaFin:
          original.horaFin ||
          '',

        actividad:
          linea
      };
    }
  );
}


// ======================================================
// HISTORIAL
// ======================================================

function registrarEventosHistorial() {
  $('#btn-view-history')
    .off('click.calendario')
    .on(
      'click.calendario',
      async () => {
        await recargarHistorial();

        $('#modalHistorial')
          .show();
      }
    );

  $('#btn-close-history')
    .off('click.calendario')
    .on(
      'click.calendario',
      () => {
        $('#modalHistorial')
          .hide();
      }
    );

  $('#btn-refresh-history')
    .off('click.calendario')
    .on(
      'click.calendario',
      recargarHistorial
    );
}


async function recargarHistorial() {
  const $tabla =
    $('#tablaHistorial');

  const snapshot =
    await getDocs(
      query(
        collection(
          db,
          'historial'
        ),
        orderBy(
          'timestamp',
          'desc'
        )
      )
    );

  const $tbody =
    $tabla
      .find('tbody')
      .empty();

  snapshot.forEach(
    docSnap => {
      const datos =
        docSnap.data() ||
        {};

      const fecha =
        datos.timestamp
          ?.toDate?.();

      if (!fecha) {
        return;
      }

      const $fila =
        $('<tr>');

      $('<td>')
        .text(
          fecha.toLocaleString(
            'es-CL'
          )
        )
        .appendTo($fila);

      $('<td>')
        .text(
          datos.modificadoPor ||
          datos.usuario ||
          ''
        )
        .appendTo($fila);

      $('<td>')
        .text(
          datos.numeroNegocio ||
          ''
        )
        .appendTo($fila);

      $('<td>')
        .text(
          datos.accion ||
          datos.campo ||
          ''
        )
        .appendTo($fila);

      $('<td>')
        .text(
          datos.anterior ||
          ''
        )
        .appendTo($fila);

      $('<td>')
        .text(
          datos.nuevo ||
          ''
        )
        .appendTo($fila);

      $tbody.append(
        $fila
      );
    }
  );

  if (
    $.fn.DataTable
      .isDataTable(
        '#tablaHistorial'
      )
  ) {
    $('#tablaHistorial')
      .DataTable()
      .destroy();
  }

  dtHist =
    $('#tablaHistorial')
      .DataTable({
        language: {
          url:
            '//cdn.datatables.net/plug-ins/1.13.4/i18n/es-ES.json'
        },

        order: [
          [0, 'desc']
        ],

        dom: 'ltip',
        pageLength: 15
      });
}


// ======================================================
// EXPORTAR EXCEL
// Respeta filtros, orden y columnas visibles
// ======================================================

const botonExportar =
  document.getElementById(
    'btn-export-excel'
  );

if (botonExportar) {
  botonExportar.addEventListener(
    'click',
    exportarCalendarioExcel
  );
}


function exportarCalendarioExcel() {
  if (
    !$.fn.DataTable
      .isDataTable(
        '#tablaCalendario'
      )
  ) {
    alert(
      'El calendario todavía no está listo.'
    );

    return;
  }

  const tabla =
    $('#tablaCalendario')
      .DataTable();

  const columnasVisibles = [];

  tabla
    .columns(':visible')
    .every(
      function () {
        const indice =
          this.index();

        const encabezado =
          this.header();

        const fechaISO =
          encabezado
            ?.getAttribute?.(
              'data-fechaiso'
            );

        columnasVisibles.push({
          indice,

          nombre:
            fechaISO ||
            encabezado
              ?.innerText
              ?.trim() ||
            `Col_${indice + 1}`
        });
      }
    );

  const headers =
    columnasVisibles.map(
      columna =>
        columna.nombre
    );

  const datos = [];

  tabla
    .rows({
      search: 'applied',
      order: 'applied'
    })
    .every(
      function () {
        const nodoFila =
          this.node();

        const celdas =
          $(nodoFila)
            .find('td')
            .toArray();

        const fila = {};

        columnasVisibles.forEach(
          columna => {
            const celda =
              celdas[
                columna.indice
              ];

            fila[
              columna.nombre
            ] =
              celda
                ? $(celda)
                    .text()
                    .trim()
                : '';
          }
        );

        datos.push(fila);
      }
    );

  const hoja =
    XLSX.utils
      .json_to_sheet(
        datos,
        {
          header: headers
        }
      );

  const libro =
    XLSX.utils
      .book_new();

  XLSX.utils
    .book_append_sheet(
      libro,
      hoja,
      'Calendario'
    );

  const ano =
    $('#filtroAno').val() ||
    'todos';

  XLSX.writeFile(
    libro,
    `calendario_operaciones_${ano}.xlsx`
  );
}
