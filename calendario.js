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

const COLUMNAS_FIJAS = 6;
const INDICE_COLUMNA_ANO = 6;

let dtHist = null;
let editMode = false;
let unsubscribeCalendario = null;
let refrescandoCalendario = false;
let cargaInicialRealizada = false;
let sincronizandoScroll = false;


// ======================================================
// AÑO COMERCIAL
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

  if (!box || !bar || !title || !detail) {
    return;
  }

  box.classList.remove('ok', 'error');
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

  if (!box || !bar || !title || !detail) {
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

  if (!box || !bar || !title || !detail) {
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
    'Error desconocido.';
}


// ======================================================
// HELPERS GENERALES
// ======================================================

function normalizarTexto(valor = '') {
  return String(valor)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}


function fechaAISO(valor) {
  if (!valor) {
    return '';
  }

  if (typeof valor?.toDate === 'function') {
    return valor
      .toDate()
      .toISOString()
      .slice(0, 10);
  }

  if (valor?.seconds !== undefined) {
    return new Date(valor.seconds * 1000)
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

  if (/^\d{4}-\d{2}-\d{2}$/.test(texto)) {
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

  if (Number.isNaN(fecha.getTime())) {
    return '';
  }

  return fecha
    .toISOString()
    .slice(0, 10);
}


function formatearFechaBonita(fechaISO) {
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

  const [ano, mes, dia] = partes;

  const fecha =
    new Date(ano, mes - 1, dia);

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

  const [ano, mes, dia] = partes;

  const fecha =
    new Date(ano, mes - 1, dia);

  return fecha.getDay() === 0;
}


function escaparRegex(texto = '') {
  return String(texto)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


// ======================================================
// FILTRO DE DESTINOS
// ======================================================

const DESTINOS_FILTRO = [
  {
    value: '',
    label: 'Todos los destinos'
  },
  {
    value: 'brasil',
    label: 'Brasil'
  },
  {
    value: 'sur_bariloche',
    label: 'Sur de Chile y Bariloche'
  },
  {
    value: 'bariloche',
    label: 'Bariloche'
  },
  {
    value: 'sur_chile',
    label: 'Sur de Chile'
  },
  {
    value: 'norte_chile',
    label: 'Norte de Chile'
  },
  {
    value: 'otros',
    label: 'Otros'
  }
];


const FLT_DESTINO = {
  value: ''
};


function contieneBrasil(destino, programa) {
  const texto =
    normalizarTexto(
      `${destino} ${programa}`
    );

  return (
    texto.includes('brasil') ||
    texto.includes('camboriu') ||
    texto.includes('florianopolis')
  );
}


function contieneBariloche(destino) {
  return normalizarTexto(destino)
    .includes('bariloche');
}


function contieneSurChile(destino) {
  const texto =
    normalizarTexto(destino);

  return (
    texto.includes('sur de chile') ||
    texto.includes('sur chile')
  );
}


function contieneNorteChile(destino) {
  const texto =
    normalizarTexto(destino);

  return (
    texto.includes('norte de chile') ||
    texto.includes('norte chile')
  );
}


function esSurChileYBariloche(destino) {
  return (
    contieneSurChile(destino) &&
    contieneBariloche(destino)
  );
}


function perteneceFiltroDestino(
  destino,
  programa,
  filtro
) {
  if (!filtro) {
    return true;
  }

  const esBrasil =
    contieneBrasil(
      destino,
      programa
    );

  const esBariloche =
    contieneBariloche(destino);

  const esSur =
    contieneSurChile(destino);

  const esNorte =
    contieneNorteChile(destino);

  const esMixto =
    esSurChileYBariloche(destino);

  switch (filtro) {
    case 'brasil':
      return esBrasil;

    case 'sur_bariloche':
      return esMixto;

    case 'bariloche':
      return esBariloche;

    case 'sur_chile':
      return esSur;

    case 'norte_chile':
      return esNorte;

    case 'otros':
      return (
        !esBrasil &&
        !esBariloche &&
        !esSur &&
        !esNorte
      );

    default:
      return true;
  }
}


function filtroDestinoCalendario(
  settings,
  rowData,
  rowIndex
) {
  if (
    settings.nTable.id !==
    'tablaCalendario'
  ) {
    return true;
  }

  const filtro =
    String(
      FLT_DESTINO.value || ''
    ).trim();

  if (!filtro) {
    return true;
  }

  const api =
    new $.fn.dataTable.Api(
      settings
    );

  const nodoFila =
    api
      .row(rowIndex)
      .node();

  const destino =
    nodoFila
      ? String(
          nodoFila.dataset.destino ||
          ''
        )
      : '';

  const programa =
    nodoFila
      ? String(
          nodoFila.dataset.programa ||
          ''
        )
      : '';

  return perteneceFiltroDestino(
    destino,
    programa,
    filtro
  );
}


// ======================================================
// BUSCADOR POR COMAS
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
        textoFila.includes(termino)
    );
}


// ======================================================
// ACTIVIDADES
// ======================================================

function horaAMinutos(hora) {
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
    parseInt(match[1], 10);

  const minutos =
    match[2]
      ? parseInt(match[2], 10)
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

  return horas * 60 + minutos;
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
      actividad.horaInicio || ''
    ).trim();

  const fin =
    String(
      actividad.horaFin || ''
    ).trim();

  const nombre =
    String(
      actividad.actividad || ''
    ).trim();

  if (inicio && fin) {
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
  if (!Array.isArray(actividades)) {
    return '';
  }

  return [...actividades]
    .sort(compararActividades)
    .map(actividadATexto)
    .filter(Boolean)
    .join('\n\n');
}


// ======================================================
// PAX, HOTELES Y VUELOS
// ======================================================

function prepararPax(pax = {}) {
  const adultos =
    Number(pax.adultos || 0);

  const estudiantes =
    Number(pax.estudiantes || 0);

  const totalInformado =
    Number(pax.total || 0);

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


function formatearPax(pax = {}) {
  const datos =
    prepararPax(pax);

  return (
    `${datos.total}\n` +
    `A: ${datos.adultos} · ` +
    `E: ${datos.estudiantes}`
  );
}


function formatearHoteles(hoteles = []) {
  if (!Array.isArray(hoteles)) {
    return '';
  }

  const lineas =
    hoteles
      .map(hotel => {
        const nombre =
          String(
            hotel?.nombre || ''
          )
            .trim()
            .toUpperCase();

        const checkIn =
          fechaAISO(hotel?.checkIn);

        const checkOut =
          fechaAISO(hotel?.checkOut);

        let rango = '';

        if (checkIn || checkOut) {
          rango =
            `\n${checkIn
              ? formatearFechaBonita(checkIn)
              : '—'
            } → ${checkOut
              ? formatearFechaBonita(checkOut)
              : '—'
            }`;
        }

        return (
          `${nombre}${rango}`
        ).trim();
      })
      .filter(Boolean);

  return [...new Set(lineas)]
    .join('\n\n');
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
    Number.isNaN(milisegundos)
  ) {
    return Number.MAX_SAFE_INTEGER;
  }

  return milisegundos;
}


function formatearVuelos(vuelos = []) {
  if (!Array.isArray(vuelos)) {
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
            vuelo?.resumen || ''
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
            vuelo?.tipo || 'AÉREO'
          ).trim();

        const proveedor =
          String(
            vuelo?.proveedor || ''
          ).trim();

        const numero =
          String(
            vuelo?.numero || ''
          ).trim();

        const origen =
          String(
            vuelo?.origen || ''
          ).trim();

        const destino =
          String(
            vuelo?.destino || ''
          ).trim();

        const fecha =
          fechaAISO(vuelo?.fecha);

        let texto = [
          tipo,
          proveedor,
          numero
        ]
          .filter(Boolean)
          .join(' ');

        if (origen || destino) {
          texto +=
            `\n${origen} → ${destino}`;
        }

        if (fecha) {
          texto +=
            `\n${fecha}`;
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
    if (!unicos.has(item.texto)) {
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
        .map(item => item.texto)
        .join('\n\n'),

    orden:
      ordenados.length
        ? ordenados[0].orden
        : Number.MAX_SAFE_INTEGER
  };
}


// ======================================================
// PREPARAR DOCUMENTO RESUMEN
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

  if (!fechasItinerario.length) {
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
        datos.nombreGrupo || ''
      ).trim(),

    destino:
      String(
        datos.destino || ''
      ).trim(),

    programa:
      String(
        datos.programa || ''
      ).trim(),

    anoViaje:
      String(
        datos.anoViaje || ''
      ).trim(),

    fechaInicio:
      fechaAISO(
        datos.fechaInicio
      ),

    fechaFin:
      fechaAISO(
        datos.fechaFin
      ),

    pax:
      prepararPax(
        datos.pax || {}
      ),

    hoteles:
      Array.isArray(datos.hoteles)
        ? datos.hoteles
        : [],

    vuelos:
      Array.isArray(datos.vuelos)
        ? datos.vuelos
        : [],

    itinerario,
    fechasItinerario
  };
}


// ======================================================
// URL
// ======================================================

function getParametroURL(nombre) {
  const parametros =
    new URLSearchParams(
      window.location.search
    );

  return parametros.get(nombre);
}

const numeroNegocioInicial =
  getParametroURL(
    'numeroNegocio'
  );


// ======================================================
// AUTENTICACIÓN
// ======================================================

$(function () {
  onAuthStateChanged(
    auth,
    user => {
      if (!user) {
        location = 'login.html';
        return;
      }

      escucharCambiosCalendario(
        user.email
      );
    }
  );
});


// ======================================================
// ESCUCHAR RESUMEN
// ======================================================

function escucharCambiosCalendario(
  userEmail
) {
  if (unsubscribeCalendario) {
    unsubscribeCalendario();
  }

  setCarga(
    10,
    'Cargando calendario...',
    'Leyendo resumen operativo'
  );

  unsubscribeCalendario =
    onSnapshot(
      collection(
        db,
        COLECCION_RESUMEN
      ),

      async snapshot => {
        if (refrescandoCalendario) {
          return;
        }

        refrescandoCalendario = true;

        try {
          await generarTablaCalendario(
            userEmail,
            snapshot
          );

          cargaInicialRealizada = true;
        } finally {
          refrescandoCalendario = false;
        }
      },

      error => {
        console.error(
          'Error escuchando calendario:',
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
    const filtrosActuales = {
      buscador:
        $('#buscador').val() ||
        '',

      destino:
        $('#filtroDestino').val() ||
        '',

      ano:
        $('#filtroAno').val() ||
        ANO_COMERCIAL_ACTUAL,

      fechaDesde:
        $('#filtroFechaDesde').val() ||
        ''
    };

    const scrollHorizontalActual =
      obtenerScrollHorizontalActual();

    setCarga(
      25,
      'Resumen cargado',
      `${snapshotResumen.size} documentos encontrados`
    );

    destruirDataTableCalendario();

    $('#encabezadoCalendario')
      .empty();

    $('#cuerpoCalendario')
      .empty();

    const grupos = [];
    const fechasUnicas =
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

        grupo.fechasItinerario
          .forEach(fecha => {
            fechasUnicas.add(fecha);
          });

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

    const fechasOrdenadas =
      [...fechasUnicas].sort();

    const anios =
      [...aniosSet].sort(
        (a, b) =>
          Number(a) -
          Number(b)
      );

    setCarga(
      45,
      'Preparando calendario...',
      `${grupos.length} grupos listos`
    );

    prepararFiltrosDestino(
      filtrosActuales.destino
    );

    prepararFiltroAno(
      anios,
      filtrosActuales.ano
    );

    construirEncabezado(
      fechasOrdenadas
    );

    construirCuerpo(
      grupos,
      fechasOrdenadas
    );

    setCarga(
      75,
      'Construyendo tabla...',
      'Aplicando columnas fijas y desplazamiento'
    );

    const tabla =
      inicializarDataTable(
        grupos
      );

    registrarFiltrosDataTable();

    restaurarFiltros(
      tabla,
      filtrosActuales
    );

    registrarEventosFiltros(
      tabla
    );

    registrarEventosEdicion(
      userEmail
    );

    registrarEventosHistorial();

    aplicarNumeroNegocioInicial(
      tabla
    );

    aplicarModoEdicionVisual();

    window.setTimeout(
      () => {
        configurarScrollSuperior(
          scrollHorizontalActual
        );

        ajustarVistaCalendario(
          tabla
        );
      },
      250
    );

    setCargaOk(
      `Calendario cargado con ${grupos.length} grupos.`
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
      'Error generando calendario:',
      error
    );

    setCargaError(error);
  }
}


// ======================================================
// DESTRUIR TABLA
// ======================================================

function destruirDataTableCalendario() {
  desconectarScrollSuperior();

  if (
    $.fn.DataTable.isDataTable(
      '#tablaCalendario'
    )
  ) {
    $('#tablaCalendario')
      .DataTable()
      .destroy();
  }
}


// ======================================================
// FILTROS
// ======================================================

function prepararFiltrosDestino(
  valorActual
) {
  const $select =
    $('#filtroDestino');

  $select.empty();

  DESTINOS_FILTRO.forEach(
    opcion => {
      $('<option>')
        .val(opcion.value)
        .text(opcion.label)
        .appendTo($select);
    }
  );

  const existe =
    DESTINOS_FILTRO.some(
      opcion =>
        opcion.value ===
        valorActual
    );

  $select.val(
    existe
      ? valorActual
      : ''
  );
}


function prepararFiltroAno(
  anios,
  valorActual
) {
  const $select =
    $('#filtroAno');

  $select
    .empty()
    .append(
      '<option value="">Todos los años</option>'
    );

  anios.forEach(
    ano => {
      $('<option>')
        .val(ano)
        .text(ano)
        .appendTo($select);
    }
  );

  const anoFinal =
    anios.includes(
      String(valorActual)
    )
      ? String(valorActual)
      : anios.includes(
          ANO_COMERCIAL_ACTUAL
        )
        ? ANO_COMERCIAL_ACTUAL
        : '';

  $select.val(anoFinal);
}


// ======================================================
// ENCABEZADO
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
      $('<th>')
        .addClass(
          esDomingo(fecha)
            ? 'domingo'
            : ''
        )
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
// CUERPO
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
        $('<tr>')
          .attr(
            'data-destino',
            grupo.destino
          )
          .attr(
            'data-programa',
            grupo.programa
          )
          .attr(
            'data-grupo-id',
            grupo.id
          );

      const hotelesTexto =
        formatearHoteles(
          grupo.hoteles
        );

      const vuelos =
        formatearVuelos(
          grupo.vuelos
        );

      const destinoPrograma =
        [
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
            String(vuelos.orden)
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
              grupo.itinerario?.[fecha]
            )
              ? grupo.itinerario[fecha]
              : [];

          const texto =
            actividadesATexto(
              actividades
            );

          const clases = [];

          if (
            fecha === grupo.fechaInicio ||
            fecha === grupo.fechaFin
          ) {
            clases.push(
              'inicio-fin'
            );
          }

          if (esDomingo(fecha)) {
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

      $tbody.append($fila);
    }
  );
}


// ======================================================
// DATATABLE
// ======================================================

function inicializarDataTable(
  grupos
) {
  const altoDisponible =
    Math.max(
      420,
      window.innerHeight - 305
    );

  return $('#tablaCalendario')
    .DataTable({
      scrollX: true,

      scrollY:
        `${altoDisponible}px`,

      scrollCollapse: true,
      autoWidth: true,
      deferRender: true,

      paging: false,
      info: true,
      searching: true,

      dom: 'Brt',

      order: [
        [5, 'asc']
      ],

      buttons: [
        {
          extend: 'colvis',

          text:
            'Ver columnas',

          className:
            'dt-button',

          columns:
            ':gt(5)'
        }
      ],

      columnDefs: [
        {
          targets: [0],
          width: '90px'
        },
        {
          targets: [1],
          width: '225px'
        },
        {
          targets: [2],
          width: '100px'
        },
        {
          targets: [3],
          width: '190px'
        },
        {
          targets: [4],
          width: '225px'
        },
        {
          targets: [5],
          width: '320px'
        },
        {
          targets: [
            INDICE_COLUMNA_ANO
          ],
          visible: false,
          searchable: true
        },
        {
          targets:
            '_all',

          defaultContent:
            ''
        }
      ],

      language: {
        url:
          '//cdn.datatables.net/plug-ins/1.13.4/i18n/es-ES.json'
      },

      drawCallback: function () {
        aplicarModoEdicionVisual();

        window.setTimeout(
          actualizarAnchoScrollSuperior,
          20
        );
      },

      initComplete: function () {
        window.setTimeout(
          configurarScrollSuperior,
          80
        );
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
  $('#buscador').val(
    filtros.buscador
  );

  $('#filtroDestino').val(
    filtros.destino
  );

  $('#filtroFechaDesde').val(
    filtros.fechaDesde
  );

  FLT_DESTINO.value =
    filtros.destino;

  const anoSeleccionado =
    $('#filtroAno').val() ||
    '';

  tabla
    .column(
      INDICE_COLUMNA_ANO
    )
    .search(
      anoSeleccionado
        ? `^${escaparRegex(
            anoSeleccionado
          )}$`
        : '',
      true,
      false
    );

  if (
    filtros.buscador.includes(',')
  ) {
    const terminos =
      filtros.buscador
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
    BUSQ_COMA.activo = false;
    BUSQ_COMA.terminos = [];

    tabla.search(
      filtros.buscador
    );
  }

  aplicarFiltroFechaColumnas(
    tabla,
    filtros.fechaDesde
  );

  tabla.draw(false);
}


// ======================================================
// EVENTOS FILTROS
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
            this.value || ''
          );

        if (texto.includes(',')) {
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
          BUSQ_COMA.activo = false;
          BUSQ_COMA.terminos = [];

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
            this.value || ''
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
            this.value || ''
          );

        tabla
          .column(
            INDICE_COLUMNA_ANO
          )
          .search(
            valor
              ? `^${escaparRegex(
                  valor
                )}$`
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
          fechaColumna >= fechaDesde;

        this.visible(
          mostrar,
          false
        );
      }
    );

  window.setTimeout(
    actualizarAnchoScrollSuperior,
    60
  );
}


// ======================================================
// AJUSTE VISUAL
// ======================================================

function ajustarVistaCalendario(
  tabla
) {
  window.setTimeout(
    () => {
      try {
        if (
          !$.fn.DataTable.isDataTable(
            '#tablaCalendario'
          )
        ) {
          return;
        }

        tabla.columns.adjust();

        actualizarAnchoScrollSuperior();

        $(window).trigger('resize');
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
// DOBLE SCROLL HORIZONTAL
// ======================================================

function obtenerScrollBody() {
  return document.querySelector(
    '#tablaCalendario_wrapper .dataTables_scrollBody'
  );
}


function obtenerScrollSuperior() {
  return document.getElementById(
    'scrollCalendarioSuperior'
  );
}


function obtenerScrollHorizontalActual() {
  const scrollBody =
    obtenerScrollBody();

  return scrollBody
    ? scrollBody.scrollLeft
    : 0;
}


function desconectarScrollSuperior() {
  const superior =
    obtenerScrollSuperior();

  const inferior =
    obtenerScrollBody();

  if (superior) {
    superior.onscroll = null;
  }

  if (inferior) {
    inferior.onscroll = null;
  }

  window.removeEventListener(
    'resize',
    actualizarAnchoScrollSuperior
  );
}


function configurarScrollSuperior(
  scrollInicial = 0
) {
  const superior =
    obtenerScrollSuperior();

  const contenido =
    document.getElementById(
      'scrollCalendarioSuperiorContenido'
    );

  const inferior =
    obtenerScrollBody();

  if (!superior || !contenido || !inferior) {
    return;
  }

  actualizarAnchoScrollSuperior();

  superior.style.display = 'block';

  superior.onscroll = () => {
    if (sincronizandoScroll) {
      return;
    }

    sincronizandoScroll = true;

    inferior.scrollLeft =
      superior.scrollLeft;

    sincronizandoScroll = false;
  };

  inferior.onscroll = () => {
    if (sincronizandoScroll) {
      return;
    }

    sincronizandoScroll = true;

    superior.scrollLeft =
      inferior.scrollLeft;

    sincronizandoScroll = false;
  };

  const limite =
    Math.max(
      0,
      inferior.scrollWidth -
      inferior.clientWidth
    );

  const posicion =
    Math.min(
      Number(scrollInicial) || 0,
      limite
    );

  inferior.scrollLeft =
    posicion;

  superior.scrollLeft =
    posicion;

  window.removeEventListener(
    'resize',
    actualizarAnchoScrollSuperior
  );

  window.addEventListener(
    'resize',
    actualizarAnchoScrollSuperior
  );
}


function actualizarAnchoScrollSuperior() {
  const superior =
    obtenerScrollSuperior();

  const contenido =
    document.getElementById(
      'scrollCalendarioSuperiorContenido'
    );

  const inferior =
    obtenerScrollBody();

  if (!superior || !contenido || !inferior) {
    return;
  }

  contenido.style.width =
    `${inferior.scrollWidth}px`;

  superior.style.display =
    inferior.scrollWidth >
    inferior.clientWidth
      ? 'block'
      : 'none';
}


// ======================================================
// NÚMERO DE NEGOCIO POR URL
// ======================================================

function aplicarNumeroNegocioInicial(
  tabla
) {
  if (!numeroNegocioInicial) {
    return;
  }

  const $buscador =
    $('#buscador');

  if ($buscador.val()) {
    return;
  }

  $buscador.val(
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
// ======================================================

function registrarEventosEdicion(
  userEmail
) {
  $('#btn-toggle-edit')
    .off('click.calendario')
    .on(
      'click.calendario',
      async () => {
        editMode = !editMode;

        aplicarModoEdicionVisual();

        try {
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
        } catch (error) {
          console.warn(
            'No se pudo registrar cambio de modo:',
            error
          );
        }
      }
    );

  $('#tablaCalendario tbody')
    .off(
      'focusout.calendario',
      'td[data-fecha][contenteditable="true"]'
    )
    .on(
      'focusout.calendario',
      'td[data-fecha][contenteditable="true"]',
      async function () {
        await guardarCeldaItinerario(
          this
        );
      }
    );
}


function aplicarModoEdicionVisual() {
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

  $('#tablaCalendario tbody td[data-fecha]')
    .attr(
      'contenteditable',
      editMode
        ? 'true'
        : 'false'
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
    textoNuevo === textoAnterior
  ) {
    return;
  }

  try {
    $celda
      .removeClass(
        'error-guardado guardado'
      )
      .addClass('guardando');

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

    if (!snapshotGrupo.exists()) {
      throw new Error(
        `No se encontró el grupo ${grupoId}.`
      );
    }

    const datosGrupo =
      snapshotGrupo.data() || {};

    const actividadesAnteriores =
      Array.isArray(
        datosGrupo
          ?.itinerario
          ?.[fecha]
      )
        ? datosGrupo.itinerario[fecha]
        : [];

    const actividadesNuevas =
      parsearTextoActividades(
        textoNuevo,
        actividadesAnteriores
      );

    const actividadesOrdenadas =
      [...actividadesNuevas]
        .sort(compararActividades);

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
          auth.currentUser?.email ||
          '',

        timestamp:
          new Date()
      }
    );

    $celda
      .text(textoOrdenado)
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
      1300
    );
  } catch (error) {
    console.error(
      'Error guardando itinerario:',
      error
    );

    $celda
      .text(textoAnterior)
      .addClass(
        'error-guardado'
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
        originales[indice] ||
        {};

      const matchCompleto =
        linea.match(
          /^(\d{1,2}[:h.]\d{2})\s*[–—-]\s*(\d{1,2}[:h.]\d{2})\s+(.*)$/
        );

      if (matchCompleto) {
        return {
          ...original,

          horaInicio:
            matchCompleto[1]
              .replace(/[h.]/, ':')
              .trim(),

          horaFin:
            matchCompleto[2]
              .replace(/[h.]/, ':')
              .trim(),

          actividad:
            matchCompleto[3]
              .trim()
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
              .replace(/[h.]/, ':')
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

  $('#buscadorHistorial')
    .off('input.calendario')
    .on(
      'input.calendario',
      aplicarFiltrosHistorial
    );

  $('#histInicio, #histFin')
    .off('change.calendario')
    .on(
      'change.calendario',
      aplicarFiltrosHistorial
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
        docSnap.data() || {};

      const fecha =
        datos.timestamp
          ?.toDate?.();

      if (!fecha) {
        return;
      }

      const fechaISO =
        fechaAISO(fecha);

      const $fila =
        $('<tr>')
          .attr(
            'data-fecha',
            fechaISO
          );

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

      $tbody.append($fila);
    }
  );

  if (
    $.fn.DataTable.isDataTable(
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

  aplicarFiltrosHistorial();
}


function aplicarFiltrosHistorial() {
  if (!dtHist) {
    return;
  }

  const texto =
    String(
      $('#buscadorHistorial').val() ||
      ''
    );

  const inicio =
    $('#histInicio').val() ||
    '';

  const fin =
    $('#histFin').val() ||
    '';

  dtHist.search(texto);

  $.fn.dataTable.ext.search =
    $.fn.dataTable.ext.search
      .filter(
        filtro =>
          filtro !== filtroFechaHistorial
      );

  filtroFechaHistorial.inicio =
    inicio;

  filtroFechaHistorial.fin =
    fin;

  $.fn.dataTable.ext.search.push(
    filtroFechaHistorial
  );

  dtHist.draw();
}


function filtroFechaHistorial(
  settings,
  data,
  dataIndex
) {
  if (
    settings.nTable.id !==
    'tablaHistorial'
  ) {
    return true;
  }

  const fila =
    settings.aoData[
      dataIndex
    ]?.nTr;

  const fecha =
    fila?.dataset?.fecha ||
    '';

  if (
    filtroFechaHistorial.inicio &&
    fecha <
      filtroFechaHistorial.inicio
  ) {
    return false;
  }

  if (
    filtroFechaHistorial.fin &&
    fecha >
      filtroFechaHistorial.fin
  ) {
    return false;
  }

  return true;
}

filtroFechaHistorial.inicio = '';
filtroFechaHistorial.fin = '';


// ======================================================
// EXPORTACIÓN EXCELJS
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


async function exportarCalendarioExcel() {
  if (
    !$.fn.DataTable.isDataTable(
      '#tablaCalendario'
    )
  ) {
    alert(
      'El calendario todavía no está listo.'
    );

    return;
  }

  if (
    typeof ExcelJS === 'undefined'
  ) {
    alert(
      'No se pudo cargar ExcelJS.'
    );

    return;
  }

  try {
    const $boton =
      $('#btn-export-excel');

    const textoOriginal =
      $boton.text();

    $boton
      .prop('disabled', true)
      .text(
        '⏳ Generando Excel...'
      );

    const tabla =
      $('#tablaCalendario')
        .DataTable();

    const columnasVisibles =
      tabla
        .columns(':visible')
        .indexes()
        .toArray();

    const filasVisibles =
      tabla
        .rows({
          search: 'applied',
          order: 'applied'
        })
        .indexes()
        .toArray();

    const workbook =
      new ExcelJS.Workbook();

    workbook.creator =
      'Operaciones RaiTrai';

    workbook.created =
      new Date();

    const worksheet =
      workbook.addWorksheet(
        'Calendario',
        {
          views: [
            {
              state: 'frozen',
              xSplit:
                COLUMNAS_FIJAS,
              ySplit: 1
            }
          ],

          pageSetup: {
            orientation:
              'landscape',

            fitToPage: true,

            fitToWidth: 1,

            fitToHeight: 0,

            paperSize: 9,

            margins: {
              left: 0.25,
              right: 0.25,
              top: 0.4,
              bottom: 0.4,
              header: 0.2,
              footer: 0.2
            }
          }
        }
      );

    worksheet.properties.defaultRowHeight =
      22;

    worksheet.autoFilter = {
      from: {
        row: 1,
        column: 1
      },

      to: {
        row: 1,
        column:
          columnasVisibles.length
      }
    };

    const encabezados =
      columnasVisibles.map(
        indiceColumna => {
          const th =
            tabla
              .column(
                indiceColumna
              )
              .header();

          const fechaISO =
            th?.getAttribute?.(
              'data-fechaiso'
            );

          return {
            indice:
              indiceColumna,

            texto:
              fechaISO
                ? formatearFechaBonita(
                    fechaISO
                  )
                : th?.innerText
                    ?.trim() ||
                  '',

            fechaISO:
              fechaISO || '',

            domingo:
              fechaISO
                ? esDomingo(
                    fechaISO
                  )
                : false
          };
        }
      );

    worksheet.addRow(
      encabezados.map(
        encabezado =>
          encabezado.texto
      )
    );

    aplicarEstiloEncabezadoExcel(
      worksheet,
      encabezados
    );

    filasVisibles.forEach(
      (indiceFila, posicion) => {
        const valores = [];

        columnasVisibles.forEach(
          indiceColumna => {
            const nodo =
              tabla
                .cell(
                  indiceFila,
                  indiceColumna
                )
                .node();

            valores.push(
              nodo
                ? $(nodo)
                    .text()
                    .trim()
                : ''
            );
          }
        );

        const filaExcel =
          worksheet.addRow(
            valores
          );

        aplicarEstiloFilaExcel(
          filaExcel,
          {
            posicion,
            indiceFila,
            columnasVisibles,
            tabla
          }
        );
      }
    );

    aplicarAnchosExcel(
      worksheet,
      encabezados
    );

    worksheet.eachRow(
      {
        includeEmpty: true
      },
      row => {
        row.eachCell(
          {
            includeEmpty: true
          },
          cell => {
            cell.alignment = {
              ...cell.alignment,

              vertical: 'top',
              wrapText: true
            };
          }
        );
      }
    );

    const buffer =
      await workbook.xlsx
        .writeBuffer();

    const ano =
      $('#filtroAno').val() ||
      'todos';

    const fechaArchivo =
      new Date()
        .toISOString()
        .slice(0, 10);

    saveAs(
      new Blob(
        [buffer],
        {
          type:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        }
      ),

      `calendario_operaciones_${ano}_${fechaArchivo}.xlsx`
    );

    $boton
      .prop('disabled', false)
      .text(textoOriginal);
  } catch (error) {
    console.error(
      'Error exportando Excel:',
      error
    );

    $('#btn-export-excel')
      .prop('disabled', false)
      .text(
        '📤 Exportar Excel'
      );

    alert(
      `No se pudo generar el Excel: ${error.message}`
    );
  }
}


function aplicarEstiloEncabezadoExcel(
  worksheet,
  encabezados
) {
  const fila =
    worksheet.getRow(1);

  fila.height = 32;

  encabezados.forEach(
    (encabezado, posicion) => {
      const cell =
        fila.getCell(
          posicion + 1
        );

      const esColumnaFija =
        posicion <
        COLUMNAS_FIJAS;

      cell.font = {
        bold: true,
        size: 10,
        color: {
          argb: 'FF18334F'
        }
      };

      cell.alignment = {
        horizontal: 'center',
        vertical: 'middle',
        wrapText: true
      };

      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: {
          argb:
            encabezado.domingo
              ? 'FFD8DEE6'
              : esColumnaFija
                ? 'FFDCE9F5'
                : 'FFEAF1F8'
        }
      };

      cell.border = {
        top: {
          style: 'thin',
          color: {
            argb: 'FF94A3B8'
          }
        },
        left: {
          style: 'thin',
          color: {
            argb: 'FFB8C4D0'
          }
        },
        bottom: {
          style: 'medium',
          color: {
            argb: 'FF7D97B0'
          }
        },
        right: {
          style:
            posicion ===
            COLUMNAS_FIJAS - 1
              ? 'medium'
              : 'thin',

          color: {
            argb:
              posicion ===
              COLUMNAS_FIJAS - 1
                ? 'FF7D97B0'
                : 'FFB8C4D0'
          }
        }
      };
    }
  );
}


function aplicarEstiloFilaExcel(
  filaExcel,
  {
    posicion,
    indiceFila,
    columnasVisibles,
    tabla
  }
) {
  const fondoFila =
    posicion % 2 === 0
      ? 'FFFFFFFF'
      : 'FFF5F8FB';

  const fondoFijo =
    posicion % 2 === 0
      ? 'FFF1F6FB'
      : 'FFE8F0F7';

  let maxLineas = 1;

  columnasVisibles.forEach(
    (indiceColumna, posicionColumna) => {
      const cell =
        filaExcel.getCell(
          posicionColumna + 1
        );

      const nodo =
        tabla
          .cell(
            indiceFila,
            indiceColumna
          )
          .node();

      const esColumnaFija =
        posicionColumna <
        COLUMNAS_FIJAS;

      const esInicioFin =
        nodo?.classList
          ?.contains(
            'inicio-fin'
          );

      const esDomingoCelda =
        nodo?.classList
          ?.contains(
            'domingo'
          );

      let colorFondo =
        esColumnaFija
          ? fondoFijo
          : fondoFila;

      if (esDomingoCelda) {
        colorFondo =
          'FFEDF1F5';
      }

      if (esInicioFin) {
        colorFondo =
          'FFE1EFFF';
      }

      cell.fill = {
        type: 'pattern',
        pattern: 'solid',

        fgColor: {
          argb: colorFondo
        }
      };

      cell.font = {
        size: 9,
        color: {
          argb: 'FF263746'
        }
      };

      cell.alignment = {
        vertical: 'top',
        horizontal:
          posicionColumna === 0 ||
          posicionColumna === 2
            ? 'center'
            : 'left',

        wrapText: true,
        indent:
          posicionColumna === 0 ||
          posicionColumna === 2
            ? 0
            : 1
      };

      cell.border = {
        top: {
          style: 'thin',
          color: {
            argb: 'FFD9E0E7'
          }
        },
        left: {
          style: 'thin',
          color: {
            argb: 'FFD9E0E7'
          }
        },
        bottom: {
          style: 'thin',
          color: {
            argb: 'FFD9E0E7'
          }
        },
        right: {
          style:
            posicionColumna ===
            COLUMNAS_FIJAS - 1
              ? 'medium'
              : 'thin',

          color: {
            argb:
              posicionColumna ===
              COLUMNAS_FIJAS - 1
                ? 'FF7D97B0'
                : 'FFD9E0E7'
          }
        }
      };

      const texto =
        String(
          cell.value || ''
        );

      const lineas =
        estimarLineasExcel(
          texto,
          obtenerAnchoExcel(
            posicionColumna
          )
        );

      maxLineas =
        Math.max(
          maxLineas,
          lineas
        );
    }
  );

  filaExcel.height =
    Math.min(
      230,
      Math.max(
        28,
        maxLineas * 13
      )
    );
}


function estimarLineasExcel(
  texto,
  anchoColumna
) {
  if (!texto) {
    return 1;
  }

  const lineasReales =
    String(texto)
      .split('\n');

  let total = 0;

  const caracteresPorLinea =
    Math.max(
      8,
      Math.floor(
        anchoColumna * 1.45
      )
    );

  lineasReales.forEach(
    linea => {
      total += Math.max(
        1,
        Math.ceil(
          linea.length /
          caracteresPorLinea
        )
      );
    }
  );

  return total;
}


function obtenerAnchoExcel(
  posicionColumna
) {
  const anchos = [
    14,
    34,
    15,
    29,
    34,
    48
  ];

  if (
    posicionColumna <
    anchos.length
  ) {
    return anchos[
      posicionColumna
    ];
  }

  return 31;
}


function aplicarAnchosExcel(
  worksheet,
  encabezados
) {
  encabezados.forEach(
    (encabezado, posicion) => {
      worksheet.getColumn(
        posicion + 1
      ).width =
        obtenerAnchoExcel(
          posicion
        );
    }
  );
}
