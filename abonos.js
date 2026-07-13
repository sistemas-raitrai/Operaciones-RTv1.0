import { app, db } from './firebase-init.js';

import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  addDoc,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

import {
  getAuth,
  onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';

import {
  getStorage,
  ref as storageRef,
  uploadBytes,
  getDownloadURL
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-storage.js';

const auth = getAuth(app);
const storage = getStorage(app);

const RUTA_ABONOS = 'AbonosOperaciones';
const RUTA_SERVICIOS_ANO = 'ServiciosPorAno';
const RUTA_GRUPOS = 'grupos';
const RUTA_HOTELES = 'hoteles';
const RUTA_HOTEL_ASSIGNMENTS = 'hotelAssignments';
const RUTA_HOTEL_ABONOS = 'FinanzasHotelesAbonos';

const MONEDAS = ['CLP', 'USD', 'BRL', 'ARS'];

let SERVICIOS = [];
let HOTELES = [];
let ASIGNACIONES = [];
let GRUPOS = [];
let ABONOS = [];

let abonoEditandoId = null;
let comprobanteActualURL = '';
let ENTIDAD_SELECCIONADA = null;

const el = id => document.getElementById(id);

function getTipoSeleccionado() {
  return document.querySelector('input[name="abTipo"]:checked')?.value || 'actividad';
}

function slug(valor = '') {
  return String(valor || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function norm(valor = '') {
  return String(valor || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toUpperCase()
    .trim();
}

function normalizarMoneda(moneda = 'CLP') {
  const m = norm(moneda);

  if (['USD', 'US$', 'DOLAR', 'DOLLAR'].includes(m)) return 'USD';
  if (['BRL', 'R$', 'REAL', 'REALES'].includes(m)) return 'BRL';
  if (['ARS', 'AR$', 'PESO ARGENTINO', 'PESOS ARGENTINOS'].includes(m)) return 'ARS';

  return 'CLP';
}

function nowISODate() {
  return new Date().toISOString().slice(0, 10);
}

function fmtNumero(valor) {
  return Number(valor || 0).toLocaleString('es-CL', {
    maximumFractionDigits: 2
  });
}

function formatTimestamp(valor) {
  if (!valor) return '—';

  try {
    const fecha = typeof valor.toDate === 'function'
      ? valor.toDate()
      : new Date(valor);

    if (Number.isNaN(fecha.getTime())) return '—';

    return fecha.toLocaleString('es-CL');
  } catch (_) {
    return '—';
  }
}

function escapeHTML(valor = '') {
  return String(valor ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function normalizarNombreHotel(nombre = '') {
  return norm(nombre).replace(/\s+/g, ' ');
}

function hotelKeyNormalizado(nombre = '') {
  return slug(normalizarNombreHotel(nombre));
}

function hotelFinKey({ ano, destino, hotelKey }) {
  return `${ano}__${slug(destino || '')}__${hotelKey || ''}`;
}

function estadoClase(estado = '') {
  return String(estado || 'REGISTRADO').toLowerCase();
}

function getAnoGrupo(grupo = {}) {
  return String(
    grupo.anoViaje ||
    grupo.anio ||
    grupo.year ||
    new Date().getFullYear()
  );
}

function getDestinoServicio(servicio = {}) {
  return servicio.destino ||
    servicio.DESTINO ||
    servicio.ciudad ||
    servicio.CIUDAD ||
    '';
}

function getNombreServicio(servicio = {}) {
  return servicio.servicio ||
    servicio.nombre ||
    servicio.actividad ||
    servicio.id ||
    '';
}

function getNombreProveedor(servicio = {}) {
  return servicio.proveedor ||
    servicio.nombreProveedor ||
    '(sin proveedor)';
}

function getDestinoHotel(hotel = {}, asignacion = {}, grupo = {}) {
  return grupo.destino ||
    hotel.destino ||
    asignacion.destino ||
    '';
}

function setEstadoFormulario(texto = '', esError = false) {
  el('formEstado').textContent = texto;
  el('formEstado').style.color = esError ? '#b91c1c' : '#166534';
}

function abrirModalAbono() {
  const modal = el('abonoModal');

  if (!modal) {
    console.error('No se encontró #abonoModal');
    return;
  }

  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function cerrarModalAbono({
  limpiar = true
} = {}) {
  const modal = el('abonoModal');

  if (!modal) return;

  modal.classList.remove('open');
  document.body.style.overflow = '';

  el('abResultadosBusqueda')?.classList.add('hidden');

  if (limpiar) {
    limpiarFormulario();
  }
}

async function cargarGrupos() {
  const snap = await getDocs(collection(db, RUTA_GRUPOS));
  GRUPOS = snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function cargarServicios() {
  SERVICIOS = [];

  const anos = new Set(GRUPOS.map(getAnoGrupo).filter(Boolean));
  const actual = new Date().getFullYear();

  anos.add(String(actual - 1));
  anos.add(String(actual));
  anos.add(String(actual + 1));
  anos.add(String(actual + 2));

  for (const ano of anos) {
    try {
      const snapDestinos = await getDocs(
        collection(db, RUTA_SERVICIOS_ANO, String(ano), 'Destinos')
      );

      for (const destinoDoc of snapDestinos.docs) {
        const destinoId = destinoDoc.id;

        try {
          const snapServicios = await getDocs(
            collection(
              db,
              RUTA_SERVICIOS_ANO,
              String(ano),
              'Destinos',
              destinoId,
              'Listado'
            )
          );

          snapServicios.docs.forEach(servicioDoc => {
            SERVICIOS.push({
              id: servicioDoc.id,
              ano: String(ano),
              destino: destinoId,
              ...servicioDoc.data()
            });
          });
        } catch (error) {
          console.warn('No se pudieron leer servicios de', ano, destinoId, error);
        }
      }
    } catch (_) {
      // El año puede no existir todavía.
    }
  }
}

async function cargarHoteles() {
  const [snapHoteles, snapAsignaciones] = await Promise.all([
    getDocs(collection(db, RUTA_HOTELES)),
    getDocs(collection(db, RUTA_HOTEL_ASSIGNMENTS))
  ]);

  HOTELES = snapHoteles.docs.map(d => ({ id: d.id, ...d.data() }));
  ASIGNACIONES = snapAsignaciones.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function cargarAbonos() {
  const snap = await getDocs(collection(db, RUTA_ABONOS));

  ABONOS = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => {
      const fa = a.createdAt?.toMillis?.() || 0;
      const fb = b.createdAt?.toMillis?.() || 0;
      return fb - fa;
    });
}

function construirCatalogoHoteles() {
  const mapaHoteles = new Map(HOTELES.map(h => [String(h.id), h]));
  const resultados = new Map();

  for (const asg of ASIGNACIONES) {
    const grupoRef = asg.grupoId || asg.numeroNegocio || asg.idGrupo || '';

    const grupo = GRUPOS.find(g =>
      String(g.id || '') === String(grupoRef) ||
      String(g.numeroNegocio || '') === String(grupoRef)
    ) || {};

    const hotel = mapaHoteles.get(String(asg.hotelId || '')) || {};

    const nombre = hotel.nombre ||
      asg.hotelNombre ||
      asg.hotel ||
      asg.hotelId ||
      '(hotel)';

    const ano = String(
      hotel.anoViaje ||
      asg.anoViaje ||
      getAnoGrupo(grupo)
    );

    const destino = getDestinoHotel(hotel, asg, grupo);
    const hotelKey = hotelKeyNormalizado(nombre);

    const key = `${ano}|${norm(destino)}|${hotelKey}`;

    if (!resultados.has(key)) {
      resultados.set(key, {
        ano,
        destino,
        hotelId: hotel.id || asg.hotelId || '',
        hotelKey,
        nombre: normalizarNombreHotel(nombre),
        moneda: normalizarMoneda(
          hotel.moneda ||
          asg.moneda ||
          'CLP'
        )
      });
    }
  }

  for (const hotel of HOTELES) {
    const nombre = hotel.nombre || hotel.hotel || hotel.id;
    const ano = String(hotel.anoViaje || hotel.anio || new Date().getFullYear());
    const destino = hotel.destino || hotel.ciudad || '';
    const hotelKey = hotelKeyNormalizado(nombre);
    const key = `${ano}|${norm(destino)}|${hotelKey}`;

    if (!resultados.has(key)) {
      resultados.set(key, {
        ano,
        destino,
        hotelId: hotel.id,
        hotelKey,
        nombre: normalizarNombreHotel(nombre),
        moneda: normalizarMoneda(hotel.moneda || 'CLP')
      });
    }
  }

  return [...resultados.values()];
}

function obtenerAnosDisponibles() {
  const anos = new Set();

  SERVICIOS.forEach(s => anos.add(String(s.ano)));
  construirCatalogoHoteles().forEach(h => anos.add(String(h.ano)));
  GRUPOS.forEach(g => anos.add(getAnoGrupo(g)));
  ABONOS.forEach(a => anos.add(String(a.ano || '')));

  const actual = new Date().getFullYear();
  anos.add(String(actual));
  anos.add(String(actual + 1));

  return [...anos]
    .filter(Boolean)
    .sort((a, b) => Number(a) - Number(b));
}

function poblarAnos() {
  const anos = obtenerAnosDisponibles();

  el('abAno').innerHTML = anos
    .map(ano => `
      <option value="${escapeHTML(ano)}">
        ${escapeHTML(ano)}
      </option>
    `)
    .join('');

  const anoPredeterminado = '2026';

  if (anos.includes(anoPredeterminado)) {
    el('abAno').value = anoPredeterminado;
  } else {
    const anoActual = String(new Date().getFullYear());

    el('abAno').value = anos.includes(anoActual)
      ? anoActual
      : (anos[0] || '');
  }

  el('filtroAno').innerHTML = `
    <option value="">Todos los años</option>

    ${anos
      .map(ano => `
        <option value="${escapeHTML(ano)}">
          ${escapeHTML(ano)}
        </option>
      `)
      .join('')}
  `;
}

function obtenerDestinosFormulario() {
  const tipo = getTipoSeleccionado();
  const ano = el('abAno').value;
  const destinos = new Set();

  if (tipo === 'actividad') {
    SERVICIOS
      .filter(servicio =>
        String(servicio.ano) === String(ano)
      )
      .forEach(servicio => {
        const destino = getDestinoServicio(servicio);

        if (destino) {
          destinos.add(destino);
        }
      });
  }

  if (tipo === 'hotel') {
    construirCatalogoHoteles()
      .filter(hotel =>
        String(hotel.ano) === String(ano)
      )
      .forEach(hotel => {
        if (hotel.destino) {
          destinos.add(hotel.destino);
        }
      });
  }

  if (tipo === 'otro') {
    SERVICIOS
      .filter(servicio =>
        String(servicio.ano) === String(ano)
      )
      .forEach(servicio => {
        const destino = getDestinoServicio(servicio);

        if (destino) {
          destinos.add(destino);
        }
      });

    construirCatalogoHoteles()
      .filter(hotel =>
        String(hotel.ano) === String(ano)
      )
      .forEach(hotel => {
        if (hotel.destino) {
          destinos.add(hotel.destino);
        }
      });

    destinos.add('GENERAL / SIN DESTINO');
  }

  return [...destinos]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'es'));
}

function poblarDestinosFormulario({
  conservarDestino = true,
  conservarSeleccion = false
} = {}) {
  const valorAnterior = conservarDestino
    ? el('abDestino').value
    : '';

  const destinos = obtenerDestinosFormulario();

  el('abDestino').innerHTML = destinos
    .map(destino => `
      <option value="${escapeHTML(destino)}">
        ${escapeHTML(destino)}
      </option>
    `)
    .join('');

  if (
    valorAnterior &&
    destinos.some(destino => norm(destino) === norm(valorAnterior))
  ) {
    const destinoEncontrado = destinos.find(
      destino => norm(destino) === norm(valorAnterior)
    );

    el('abDestino').value = destinoEncontrado;
  }

  if (!conservarSeleccion) {
    limpiarSeleccionEntidad();
  }

  actualizarVistaTipo();
}

function limpiarSeleccionEntidad() {
  ENTIDAD_SELECCIONADA = null;

  el('abBuscarEntidad').value = '';
  el('abResultadosBusqueda').innerHTML = '';
  el('abResultadosBusqueda').classList.add('hidden');
  el('abSeleccionWrap').classList.add('hidden');

  el('selTipo').textContent = '—';
  el('selProveedorHotel').textContent = '—';
  el('selServicio').textContent = '—';
  el('selDestino').textContent = '—';
  el('selMoneda').textContent = '—';
}

function actualizarVistaTipo() {
  const tipo = getTipoSeleccionado();
  const esOtro = tipo === 'otro';

  el('busquedaCatalogoWrap').classList.toggle(
    'hidden',
    esOtro
  );

  el('otroManualWrap').classList.toggle(
    'hidden',
    !esOtro
  );

  if (esOtro) {
    limpiarSeleccionEntidad();
  }
}

function obtenerResultadosBusqueda(texto = '') {
  const tipo = getTipoSeleccionado();
  const ano = el('abAno').value;
  const destino = el('abDestino').value;
  const termino = norm(texto);

  if (!termino || termino.length < 2) {
    return [];
  }

  if (tipo === 'actividad') {
    return SERVICIOS
      .filter(servicio => {
        if (String(servicio.ano) !== String(ano)) {
          return false;
        }

        if (
          destino &&
          norm(getDestinoServicio(servicio)) !== norm(destino)
        ) {
          return false;
        }

        const proveedor = getNombreProveedor(servicio);
        const nombreServicio = getNombreServicio(servicio);

        const bolsaBusqueda = norm([
          proveedor,
          nombreServicio,
          getDestinoServicio(servicio)
        ].join(' '));

        return bolsaBusqueda.includes(termino);
      })
      .map(servicio => ({
        tipo: 'actividad',

        ano: String(servicio.ano),
        destino: getDestinoServicio(servicio),

        proveedorId: slug(getNombreProveedor(servicio)),
        proveedorNombre: getNombreProveedor(servicio),

        servicioId: servicio.id,
        servicioNombre: getNombreServicio(servicio),

        hotelId: '',
        hotelKey: '',
        hotelNombre: '',

        moneda: normalizarMoneda(
          servicio.moneda ||
          servicio.MONEDA ||
          'CLP'
        )
      }))
      .sort((a, b) => {
        const porProveedor = a.proveedorNombre.localeCompare(
          b.proveedorNombre,
          'es'
        );

        if (porProveedor !== 0) {
          return porProveedor;
        }

        return a.servicioNombre.localeCompare(
          b.servicioNombre,
          'es'
        );
      })
      .slice(0, 40);
  }

  if (tipo === 'hotel') {
    return construirCatalogoHoteles()
      .filter(hotel => {
        if (String(hotel.ano) !== String(ano)) {
          return false;
        }

        if (
          destino &&
          norm(hotel.destino) !== norm(destino)
        ) {
          return false;
        }

        const bolsaBusqueda = norm([
          hotel.nombre,
          hotel.destino
        ].join(' '));

        return bolsaBusqueda.includes(termino);
      })
      .map(hotel => ({
        tipo: 'hotel',

        ano: String(hotel.ano),
        destino: hotel.destino,

        proveedorId: '',
        proveedorNombre: '',

        servicioId: '',
        servicioNombre: 'ALOJAMIENTO',

        hotelId: hotel.hotelId || '',
        hotelKey: hotel.hotelKey,
        hotelNombre: hotel.nombre,

        moneda: normalizarMoneda(
          hotel.moneda ||
          'CLP'
        )
      }))
      .sort((a, b) =>
        a.hotelNombre.localeCompare(
          b.hotelNombre,
          'es'
        )
      )
      .slice(0, 40);
  }

  return [];
}

function pintarResultadosBusqueda(resultados = []) {
  const contenedor = el('abResultadosBusqueda');

  contenedor.innerHTML = '';

  if (!resultados.length) {
    contenedor.innerHTML = `
      <div class="search-result" style="cursor:default;">
        <strong>Sin resultados</strong>
        <small>
          Prueba escribiendo el proveedor, servicio, actividad o hotel.
        </small>
      </div>
    `;

    contenedor.classList.remove('hidden');
    return;
  }

  resultados.forEach(resultado => {
    const div = document.createElement('div');

    div.className = 'search-result';

    if (resultado.tipo === 'actividad') {
      div.innerHTML = `
        <strong>
          ${escapeHTML(resultado.servicioNombre)}
        </strong>

        <small>
          Proveedor: ${escapeHTML(resultado.proveedorNombre)}
          · Destino: ${escapeHTML(resultado.destino)}
          · ${escapeHTML(resultado.moneda)}
        </small>
      `;
    } else {
      div.innerHTML = `
        <strong>
          ${escapeHTML(resultado.hotelNombre)}
        </strong>

        <small>
          Hotel
          · Destino: ${escapeHTML(resultado.destino)}
          · ${escapeHTML(resultado.moneda)}
        </small>
      `;
    }

    div.addEventListener('click', () => {
      seleccionarEntidad(resultado);
    });

    contenedor.appendChild(div);
  });

  contenedor.classList.remove('hidden');
}

function seleccionarEntidad(resultado) {
  ENTIDAD_SELECCIONADA = {
    ...resultado
  };

  el('abResultadosBusqueda').classList.add('hidden');

  el('abBuscarEntidad').value =
    resultado.tipo === 'actividad'
      ? `${resultado.servicioNombre} — ${resultado.proveedorNombre}`
      : resultado.hotelNombre;

  el('selTipo').textContent =
    resultado.tipo === 'actividad'
      ? 'ACTIVIDAD'
      : 'HOTEL';

  el('selProveedorHotel').textContent =
    resultado.tipo === 'actividad'
      ? resultado.proveedorNombre
      : resultado.hotelNombre;

  el('selServicio').textContent =
    resultado.tipo === 'actividad'
      ? resultado.servicioNombre
      : 'ALOJAMIENTO';

  el('selDestino').textContent =
    resultado.destino ||
    el('abDestino').value ||
    '—';

  el('selMoneda').textContent =
    resultado.moneda ||
    'CLP';

  el('abMoneda').value =
    normalizarMoneda(resultado.moneda || 'CLP');

  el('abSeleccionWrap').classList.remove('hidden');
}

function cambiarTipoFormulario() {
  poblarDestinosFormulario({
    conservarDestino: true,
    conservarSeleccion: false
  });

  actualizarVistaTipo();
}

function poblarFiltrosGenerales() {
  const destinos = new Set();

  SERVICIOS.forEach(s => destinos.add(getDestinoServicio(s)));
  construirCatalogoHoteles().forEach(h => destinos.add(h.destino));
  ABONOS.forEach(a => destinos.add(a.destino));

  el('filtroDestino').innerHTML = `
    <option value="">Todos los destinos</option>
    ${[...destinos]
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, 'es'))
      .map(destino => `<option value="${escapeHTML(destino)}">${escapeHTML(destino)}</option>`)
      .join('')}
  `;
}

function validarFormulario() {
  const tipo = getTipoSeleccionado();
  const ano = el('abAno').value;
  const destino = el('abDestino').value;

  const fechaPago = el('abFechaPago').value;
  const moneda = normalizarMoneda(el('abMoneda').value);
  const monto = Number(el('abMonto').value || 0);
  const formaPago = el('abFormaPago').value;

  if (!ano) {
    return 'Debe seleccionar el año.';
  }

  if (!tipo) {
    return 'Debe indicar el tipo de abono.';
  }

  if (!destino) {
    return 'Debe seleccionar el destino.';
  }

  if (
    (tipo === 'actividad' || tipo === 'hotel') &&
    !ENTIDAD_SELECCIONADA
  ) {
    return tipo === 'actividad'
      ? 'Debe buscar y seleccionar un proveedor o servicio.'
      : 'Debe buscar y seleccionar un hotel.';
  }

  if (tipo === 'actividad') {
    if (ENTIDAD_SELECCIONADA?.tipo !== 'actividad') {
      return 'La selección no corresponde a una actividad.';
    }

    if (!ENTIDAD_SELECCIONADA?.servicioId) {
      return 'Debe seleccionar el servicio o actividad.';
    }
  }

  if (tipo === 'hotel') {
    if (ENTIDAD_SELECCIONADA?.tipo !== 'hotel') {
      return 'La selección no corresponde a un hotel.';
    }

    if (!ENTIDAD_SELECCIONADA?.hotelKey) {
      return 'Debe seleccionar el hotel.';
    }
  }

  if (tipo === 'otro') {
    const destinatario =
      el('abOtroDestinatario').value.trim();

    const concepto =
      el('abOtroConcepto').value.trim();

    if (!destinatario) {
      return 'Debe indicar el proveedor o destinatario.';
    }

    if (!concepto) {
      return 'Debe indicar el concepto del abono.';
    }
  }

  if (!fechaPago) {
    return 'Debe indicar la fecha en que se realizó el pago.';
  }

  if (!MONEDAS.includes(moneda)) {
    return 'La moneda seleccionada no es válida.';
  }

  if (!(monto > 0)) {
    return 'El monto debe ser mayor que cero.';
  }

  if (!formaPago) {
    return 'Debe indicar la forma de pago.';
  }

  if (
    abonoEditandoId &&
    !el('abMotivoCambio').value.trim()
  ) {
    return 'Debe indicar el motivo del cambio.';
  }

  return '';
}

function obtenerDatosFormulario() {
  const tipo = getTipoSeleccionado();
  const ano = el('abAno').value;
  const destino = el('abDestino').value;
  const moneda = normalizarMoneda(
    el('abMoneda').value
  );

  const datosComunes = {
    tipo,
    ano,
    destino,

    fechaPago: el('abFechaPago').value,
    moneda,
    monto: Number(el('abMonto').value || 0),

    formaPago: el('abFormaPago').value,
    referencia: el('abReferencia').value.trim(),
    nota: el('abNota').value.trim(),

    estado: abonoEditandoId
      ? 'EDITADO'
      : 'REGISTRADO'
  };

  if (tipo === 'actividad') {
    const seleccion = ENTIDAD_SELECCIONADA;

    if (!seleccion || seleccion.tipo !== 'actividad') {
      throw new Error(
        'No se encontró la actividad seleccionada.'
      );
    }

    return {
      ...datosComunes,

      proveedorId: seleccion.proveedorId,
      proveedorNombre: seleccion.proveedorNombre,

      servicioId: seleccion.servicioId,
      servicioNombre: seleccion.servicioNombre,

      hotelId: '',
      hotelKey: '',
      hotelNombre: '',

      categoriaOtro: '',
      ingresoManual: false,

      rutaDestino:
        `ServiciosPorAno/${ano}` +
        `/Destinos/${destino}` +
        `/Listado/${seleccion.servicioId}` +
        `/Abonos`
    };
  }

  if (tipo === 'hotel') {
    const seleccion = ENTIDAD_SELECCIONADA;

    if (!seleccion || seleccion.tipo !== 'hotel') {
      throw new Error(
        'No se encontró el hotel seleccionado.'
      );
    }

    return {
      ...datosComunes,

      proveedorId: '',
      proveedorNombre: '',

      servicioId: '',
      servicioNombre: 'ALOJAMIENTO',

      hotelId: seleccion.hotelId || '',
      hotelKey: seleccion.hotelKey,
      hotelNombre: seleccion.hotelNombre,

      categoriaOtro: '',
      ingresoManual: false,

      rutaDestino:
        `FinanzasHotelesAbonos/` +
        `${hotelFinKey({
          ano,
          destino,
          hotelKey: seleccion.hotelKey
        })}` +
        `/Abonos`
    };
  }

  const destinatario =
    el('abOtroDestinatario').value.trim();

  const categoria =
    el('abOtroCategoria').value;

  const concepto =
    el('abOtroConcepto').value.trim();

  return {
    ...datosComunes,

    proveedorId: slug(destinatario),
    proveedorNombre: destinatario,

    servicioId: '',
    servicioNombre: concepto,

    hotelId: '',
    hotelKey: '',
    hotelNombre: '',

    categoriaOtro: categoria,
    ingresoManual: true,

    rutaDestino: ''
  };
}

async function subirComprobante(file, datos, abonoId) {
  if (!file) return comprobanteActualURL || '';

  const nombreSeguro = file.name.replace(/[^\w.\-]+/g, '_');

  const ref = storageRef(
    storage,
    `abonos_operaciones/${datos.ano}/${datos.tipo}/${slug(datos.destino)}/${abonoId}/${Date.now()}_${nombreSeguro}`
  );

  await uploadBytes(ref, file);
  return getDownloadURL(ref);
}

function datosParaEspejo(datos, abonoId, comprobanteURL, email, esEdicion, version) {
  if (datos.tipo === 'actividad') {
    return {
      abonoOperacionId: abonoId,
      anoTarifa: String(datos.ano),
      destinoId: datos.destino,
      servicioId: datos.servicioId,
      proveedorNombre: datos.proveedorNombre,
      servicioNombre: datos.servicioNombre,
      fecha: datos.fechaPago,
      fechaPago: datos.fechaPago,
      moneda: datos.moneda,
      monto: datos.monto,
      formaPago: datos.formaPago,
      referencia: datos.referencia,
      nota: datos.nota,
      comprobanteURL,
      estado: esEdicion ? 'EDITADO' : 'ORIGINAL',
      version,
      updatedAt: esEdicion ? serverTimestamp() : null,
      updatedByEmail: esEdicion ? email : '',
      createdAt: esEdicion ? null : serverTimestamp(),
      createdByEmail: esEdicion ? '' : email
    };
  }

  return {
    abonoOperacionId: abonoId,
    anoTarifa: String(datos.ano),
    destino: datos.destino,
    hotelId: datos.hotelId,
    hotelKey: datos.hotelKey,
    hotelNombre: datos.hotelNombre,
    fecha: datos.fechaPago,
    fechaPago: datos.fechaPago,
    moneda: datos.moneda,
    monto: datos.monto,
    formaPago: datos.formaPago,
    referencia: datos.referencia,
    nota: datos.nota,
    comprobanteURL,
    estado: esEdicion ? 'EDITADO' : 'ORIGINAL',
    version,
    updatedAt: esEdicion ? serverTimestamp() : null,
    updatedByEmail: esEdicion ? email : '',
    createdAt: esEdicion ? null : serverTimestamp(),
    createdByEmail: esEdicion ? '' : email
  };
}

function limpiarNulosObjeto(objeto) {
  return Object.fromEntries(
    Object.entries(objeto).filter(([, valor]) => valor !== null)
  );
}

async function guardarEspejo(
  datos,
  abonoId,
  comprobanteURL,
  email,
  esEdicion,
  version
) {
  if (!datos.rutaDestino) {
    return;
  }

  if (
    datos.tipo !== 'actividad' &&
    datos.tipo !== 'hotel'
  ) {
    return;
  }

  const refEspejo = doc(
    db,
    `${datos.rutaDestino}/${abonoId}`
  );

  const espejo = limpiarNulosObjeto(
    datosParaEspejo(
      datos,
      abonoId,
      comprobanteURL,
      email,
      esEdicion,
      version
    )
  );

  await setDoc(
    refEspejo,
    espejo,
    { merge: true }
  );
}

async function guardarAbono() {
  const error = validarFormulario();

  if (error) {
    alert(error);
    return;
  }

  const btn = el('btnGuardarAbono');
  btn.disabled = true;
  setEstadoFormulario('Guardando...');

  try {
    const datos = obtenerDatosFormulario();
    const email = (auth.currentUser?.email || '').toLowerCase();
    const file = el('abComprobante').files[0] || null;

    if (!email) {
      throw new Error('No se pudo identificar al usuario conectado.');
    }

    if (!abonoEditandoId) {
      const refCentral = doc(collection(db, RUTA_ABONOS));
      const abonoId = refCentral.id;
      const comprobanteURL = await subirComprobante(file, datos, abonoId);

      const documento = {
        ...datos,
        comprobanteURL,
        fechaRegistro: serverTimestamp(),
        createdAt: serverTimestamp(),
        createdByEmail: email,
        updatedAt: null,
        updatedByEmail: '',
        archivedAt: null,
        archivedByEmail: '',
        version: 1
      };

      await setDoc(refCentral, documento);

      await guardarEspejo(
        datos,
        abonoId,
        comprobanteURL,
        email,
        false,
        1
      );

      alert('✅ Abono registrado correctamente.');
    } else {
      const refCentral = doc(db, RUTA_ABONOS, abonoEditandoId);
      const snapActual = await getDoc(refCentral);

      if (!snapActual.exists()) {
        throw new Error('El abono que intenta editar ya no existe.');
      }

      const anterior = snapActual.data() || {};
      const versionAnterior = Number(anterior.version || 1);
      const nuevaVersion = versionAnterior + 1;
      const motivoCambio = el('abMotivoCambio').value.trim();

      await addDoc(
        collection(db, RUTA_ABONOS, abonoEditandoId, 'Historial'),
        {
          versionAnterior,
          datosAnteriores: anterior,
          motivoCambio,
          changedAt: serverTimestamp(),
          changedByEmail: email
        }
      );

      const comprobanteURL = await subirComprobante(
        file,
        datos,
        abonoEditandoId
      );

      await updateDoc(refCentral, {
        ...datos,
        comprobanteURL,
        estado: 'EDITADO',
        version: nuevaVersion,
        updatedAt: serverTimestamp(),
        updatedByEmail: email,
        motivoUltimoCambio: motivoCambio
      });

      await guardarEspejo(
        datos,
        abonoEditandoId,
        comprobanteURL,
        email,
        true,
        nuevaVersion
      );

      alert('✅ Abono actualizado y cambio registrado en el historial.');
    }

    await cargarAbonos();
    poblarFiltrosGenerales();
    renderAbonos();
    
    limpiarFormulario();
    
    cerrarModalAbono({
      limpiar: false
    });
  } catch (error) {
    console.error(error);
    setEstadoFormulario(error.message || 'No se pudo guardar.', true);
    alert(`No se pudo guardar el abono: ${error.message || error}`);
  } finally {
    btn.disabled = false;
  }
}

function limpiarFormulario() {
  abonoEditandoId = null;
  comprobanteActualURL = '';
  ENTIDAD_SELECCIONADA = null;

  if (el('abonoModalTitulo')) {
    el('abonoModalTitulo').textContent = 'Agregar abono';
  }

  el('btnGuardarAbono').innerHTML = `
    <span class="material-symbols-outlined">save</span>
    Guardar abono
  `;

  el('btnCancelarEdicion').classList.add('hidden');
  el('motivoCambioWrap').classList.add('hidden');

  el('abTipoActividad').checked = true;
  el('abTipoHotel').checked = false;
  el('abTipoOtro').checked = false;

  const opcionesAno = [...el('abAno').options];

  if (
    opcionesAno.some(opcion => opcion.value === '2026')
  ) {
    el('abAno').value = '2026';
  }

  el('abFechaPago').value = nowISODate();
  el('abMoneda').value = 'CLP';
  el('abMonto').value = '';
  el('abFormaPago').value = 'transferencia';
  el('abReferencia').value = '';
  el('abNota').value = '';
  el('abMotivoCambio').value = '';
  el('abComprobante').value = '';

  el('abOtroDestinatario').value = '';
  el('abOtroCategoria').value = 'transporte';
  el('abOtroConcepto').value = '';

  poblarDestinosFormulario({
    conservarDestino: false,
    conservarSeleccion: false
  });

  actualizarVistaTipo();
  setEstadoFormulario('');
}

function iniciarEdicion(abono) {
  abonoEditandoId = abono.id;

  comprobanteActualURL =
    abono.comprobanteURL || '';

  if (el('abonoModalTitulo')) {
    el('abonoModalTitulo').textContent =
      `Editar abono · versión ${Number(abono.version || 1)}`;
  }

  el('btnGuardarAbono').innerHTML = `
    <span class="material-symbols-outlined">save_as</span>
    Guardar cambios
  `;

  el('btnCancelarEdicion').classList.remove('hidden');
  el('motivoCambioWrap').classList.remove('hidden');

  const tipo = abono.tipo || 'actividad';

  el('abTipoActividad').checked =
    tipo === 'actividad';

  el('abTipoHotel').checked =
    tipo === 'hotel';

  el('abTipoOtro').checked =
    tipo === 'otro';

  if (
    [...el('abAno').options].some(
      opcion =>
        opcion.value === String(abono.ano)
    )
  ) {
    el('abAno').value =
      String(abono.ano);
  }

  poblarDestinosFormulario({
    conservarDestino: false,
    conservarSeleccion: true
  });

  const opcionDestino =
    [...el('abDestino').options].find(
      opcion =>
        norm(opcion.value) ===
        norm(abono.destino)
    );

  if (opcionDestino) {
    el('abDestino').value =
      opcionDestino.value;
  }

  if (tipo === 'actividad') {
    ENTIDAD_SELECCIONADA = {
      tipo: 'actividad',

      ano: String(abono.ano || ''),
      destino: abono.destino || '',

      proveedorId:
        abono.proveedorId ||
        slug(abono.proveedorNombre),

      proveedorNombre:
        abono.proveedorNombre || '',

      servicioId:
        abono.servicioId || '',

      servicioNombre:
        abono.servicioNombre || '',

      hotelId: '',
      hotelKey: '',
      hotelNombre: '',

      moneda: normalizarMoneda(
        abono.moneda || 'CLP'
      )
    };

    seleccionarEntidad(
      ENTIDAD_SELECCIONADA
    );
  }

  if (tipo === 'hotel') {
    ENTIDAD_SELECCIONADA = {
      tipo: 'hotel',

      ano: String(abono.ano || ''),
      destino: abono.destino || '',

      proveedorId: '',
      proveedorNombre: '',

      servicioId: '',
      servicioNombre: 'ALOJAMIENTO',

      hotelId:
        abono.hotelId || '',

      hotelKey:
        abono.hotelKey ||
        hotelKeyNormalizado(
          abono.hotelNombre
        ),

      hotelNombre:
        abono.hotelNombre || '',

      moneda: normalizarMoneda(
        abono.moneda || 'CLP'
      )
    };

    seleccionarEntidad(
      ENTIDAD_SELECCIONADA
    );
  }

  if (tipo === 'otro') {
    limpiarSeleccionEntidad();

    el('abOtroDestinatario').value =
      abono.proveedorNombre || '';

    el('abOtroCategoria').value =
      abono.categoriaOtro || 'otro';

    el('abOtroConcepto').value =
      abono.servicioNombre || '';
  }

  actualizarVistaTipo();

  el('abFechaPago').value =
    abono.fechaPago ||
    abono.fecha ||
    nowISODate();

  el('abMoneda').value =
    normalizarMoneda(
      abono.moneda || 'CLP'
    );

  el('abMonto').value =
    Number(abono.monto || 0);

  el('abFormaPago').value =
    abono.formaPago ||
    'transferencia';

  el('abReferencia').value =
    abono.referencia || '';

  el('abNota').value =
    abono.nota || '';

  el('abMotivoCambio').value = '';
  el('abComprobante').value = '';

  abrirModalAbono();
}

async function archivarAbono(abono) {
  if (!confirm(`¿Archivar el abono de ${abono.moneda} ${fmtNumero(abono.monto)}?`)) {
    return;
  }

  const motivo = prompt('Indique el motivo del archivo:');

  if (!String(motivo || '').trim()) {
    alert('Debe indicar el motivo.');
    return;
  }

  try {
    const email = (auth.currentUser?.email || '').toLowerCase();
    const refCentral = doc(db, RUTA_ABONOS, abono.id);
    const snapActual = await getDoc(refCentral);

    if (!snapActual.exists()) {
      throw new Error('El abono ya no existe.');
    }

    const anterior = snapActual.data() || {};

    await addDoc(
      collection(db, RUTA_ABONOS, abono.id, 'Historial'),
      {
        versionAnterior: Number(anterior.version || 1),
        datosAnteriores: anterior,
        motivoCambio: String(motivo).trim(),
        tipoCambio: 'ARCHIVO',
        changedAt: serverTimestamp(),
        changedByEmail: email
      }
    );

    const nuevaVersion = Number(anterior.version || 1) + 1;

    await updateDoc(refCentral, {
      estado: 'ARCHIVADO',
      version: nuevaVersion,
      archivedAt: serverTimestamp(),
      archivedByEmail: email,
      motivoArchivo: String(motivo).trim()
    });

    if (anterior.rutaDestino) {
      await setDoc(
        doc(db, `${anterior.rutaDestino}/${abono.id}`),
        {
          estado: 'ARCHIVADO',
          version: nuevaVersion,
          archivedAt: serverTimestamp(),
          archivedByEmail: email
        },
        { merge: true }
      );
    }

    await cargarAbonos();
    renderAbonos();

    alert('✅ Abono archivado.');
  } catch (error) {
    console.error(error);
    alert(`No se pudo archivar: ${error.message || error}`);
  }
}

async function mostrarHistorial(abono) {
  const contenido = el('historialContenido');
  contenido.innerHTML = '<p class="muted">Cargando historial...</p>';
  el('historialModal').classList.add('open');

  try {
    const snap = await getDocs(
      collection(db, RUTA_ABONOS, abono.id, 'Historial')
    );

    const cambios = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => {
        const fa = a.changedAt?.toMillis?.() || 0;
        const fb = b.changedAt?.toMillis?.() || 0;
        return fb - fa;
      });

    if (!cambios.length) {
      contenido.innerHTML = `
        <p>No hay cambios anteriores. Este abono se encuentra en su versión original.</p>
      `;
      return;
    }

    contenido.innerHTML = cambios.map(cambio => {
      const ant = cambio.datosAnteriores || {};

      return `
        <div class="history-item">
          <strong>
            Versión ${escapeHTML(cambio.versionAnterior || '')}
            ${cambio.tipoCambio ? `· ${escapeHTML(cambio.tipoCambio)}` : ''}
          </strong>

          <div class="muted" style="margin-top:.25rem;">
            ${escapeHTML(formatTimestamp(cambio.changedAt))}
            · ${escapeHTML(cambio.changedByEmail || '')}
          </div>

          <div style="margin-top:.45rem;">
            <strong>Motivo:</strong>
            ${escapeHTML(cambio.motivoCambio || '—')}
          </div>

          <div class="history-grid">
            <div>
              <span>Fecha pago</span>
              ${escapeHTML(ant.fechaPago || ant.fecha || '—')}
            </div>
            <div>
              <span>Proveedor / hotel</span>
              ${escapeHTML(ant.proveedorNombre || ant.hotelNombre || '—')}
            </div>
            <div>
              <span>Servicio</span>
              ${escapeHTML(ant.servicioNombre || '—')}
            </div>
            <div>
              <span>Moneda</span>
              ${escapeHTML(ant.moneda || '—')}
            </div>
            <div>
              <span>Monto</span>
              ${escapeHTML(fmtNumero(ant.monto || 0))}
            </div>
            <div>
              <span>Forma</span>
              ${escapeHTML(ant.formaPago || '—')}
            </div>
            <div>
              <span>Referencia</span>
              ${escapeHTML(ant.referencia || '—')}
            </div>
            <div>
              <span>Estado</span>
              ${escapeHTML(ant.estado || '—')}
            </div>
          </div>

          <div style="margin-top:.5rem;">
            <strong>Nota anterior:</strong>
            ${escapeHTML(ant.nota || '—')}
          </div>
        </div>
      `;
    }).join('');
  } catch (error) {
    console.error(error);
    contenido.innerHTML = `
      <p style="color:#b91c1c;">No se pudo cargar el historial.</p>
    `;
  }
}

function abonosFiltrados() {
  const ano = el('filtroAno').value;
  const tipo = el('filtroTipo').value;
  const destino = el('filtroDestino').value;
  const estado = el('filtroEstado').value;
  const usuario = norm(el('filtroUsuario').value);
  const buscar = norm(el('filtroBuscar').value);

  return ABONOS.filter(abono => {
    if (ano && String(abono.ano) !== String(ano)) return false;
    if (tipo && abono.tipo !== tipo) return false;
    if (destino && norm(abono.destino) !== norm(destino)) return false;
    if (estado && norm(abono.estado) !== norm(estado)) return false;

    if (usuario && !norm(
      abono.updatedByEmail ||
      abono.createdByEmail ||
      ''
    ).includes(usuario)) return false;

    if (buscar) {
      const bolsa = norm([
        abono.proveedorNombre,
        abono.hotelNombre,
        abono.servicioNombre,
        abono.destino,
        abono.nota,
        abono.referencia,
        abono.formaPago
      ].join(' '));

      if (!bolsa.includes(buscar)) return false;
    }

    return true;
  });
}

function renderResumen(lista) {
  const totales = { CLP: 0, USD: 0, BRL: 0, ARS: 0 };

  lista
    .filter(a => norm(a.estado) !== 'ARCHIVADO')
    .forEach(a => {
      const moneda = normalizarMoneda(a.moneda);
      totales[moneda] += Number(a.monto || 0);
    });

  el('sumCLP').textContent = fmtNumero(totales.CLP);
  el('sumUSD').textContent = fmtNumero(totales.USD);
  el('sumBRL').textContent = fmtNumero(totales.BRL);
  el('sumARS').textContent = fmtNumero(totales.ARS);
}

function renderAbonos() {
  const lista = abonosFiltrados();
  const tbody = el('tblAbonos').querySelector('tbody');

  tbody.innerHTML = '';

  for (const abono of lista) {

    let proveedorHotel = '';
    
    if (abono.tipo === 'hotel') {
      proveedorHotel =
        abono.hotelNombre || '';
    } else {
      proveedorHotel =
        abono.proveedorNombre || '';
    }

    const servicioAsunto = [
      abono.servicioNombre,
      abono.nota
    ].filter(Boolean).join(' · ');

    const usuario = abono.updatedByEmail || abono.createdByEmail || '';

    const tr = document.createElement('tr');

    tr.innerHTML = `
      <td>${escapeHTML(abono.fechaPago || abono.fecha || '')}</td>
      <td>${escapeHTML(abono.tipo || '')}</td>
      <td>${escapeHTML(proveedorHotel || '')}</td>
      <td title="${escapeHTML(servicioAsunto)}">${escapeHTML(servicioAsunto || '—')}</td>
      <td>${escapeHTML(abono.destino || '')}</td>
      <td>${escapeHTML(abono.ano || '')}</td>
      <td>${escapeHTML(abono.moneda || 'CLP')}</td>
      <td class="right mono">${escapeHTML(fmtNumero(abono.monto || 0))}</td>
      <td>${escapeHTML(abono.formaPago || '')}</td>
      <td>${escapeHTML(abono.referencia || '—')}</td>
      <td>
        ${abono.comprobanteURL
          ? `<a class="link-doc" href="${escapeHTML(abono.comprobanteURL)}" target="_blank" rel="noopener">VER</a>`
          : '—'
        }
      </td>
      <td>${escapeHTML(usuario)}</td>
      <td>${escapeHTML(formatTimestamp(abono.createdAt || abono.fechaRegistro))}</td>
      <td>
        <span class="estado ${estadoClase(abono.estado)}">
          ${escapeHTML(abono.estado || 'REGISTRADO')}
        </span>
      </td>
      <td class="right">${escapeHTML(abono.version || 1)}</td>
      <td>
        <div class="acciones">
          <button class="icon-btn btn-editar" type="button" title="Editar">
            <span class="material-symbols-outlined">edit</span>
          </button>

          <button class="icon-btn btn-historial" type="button" title="Ver historial">
            <span class="material-symbols-outlined">history</span>
          </button>

          ${norm(abono.estado) !== 'ARCHIVADO'
            ? `
              <button class="icon-btn danger btn-archivar" type="button" title="Archivar">
                <span class="material-symbols-outlined">archive</span>
              </button>
            `
            : ''
          }
        </div>
      </td>
    `;

    tbody.appendChild(tr);

    tr.querySelector('.btn-editar').onclick = () => iniciarEdicion(abono);
    tr.querySelector('.btn-historial').onclick = () => mostrarHistorial(abono);

    const btnArchivar = tr.querySelector('.btn-archivar');
    if (btnArchivar) {
      btnArchivar.onclick = () => archivarAbono(abono);
    }
  }

  el('pagInfo').textContent = `${lista.length} abono(s)`;
  renderResumen(lista);
}

function limpiarFiltros() {
  el('filtroAno').value = '';
  el('filtroTipo').value = '';
  el('filtroDestino').value = '';
  el('filtroEstado').value = '';
  el('filtroUsuario').value = '';
  el('filtroBuscar').value = '';
  renderAbonos();
}

function conectarEventos() {
  document
    .querySelectorAll('input[name="abTipo"]')
    .forEach(radio => {
      radio.addEventListener(
        'change',
        cambiarTipoFormulario
      );
    });

  el('abAno').addEventListener(
    'change',
    () => {
      poblarDestinosFormulario({
        conservarDestino: false,
        conservarSeleccion: false
      });
    }
  );

  el('abDestino').addEventListener(
    'change',
    () => {
      limpiarSeleccionEntidad();
    }
  );

  el('abBuscarEntidad').addEventListener(
    'input',
    event => {
      const texto =
        event.target.value.trim();

      if (texto.length < 2) {
        el('abResultadosBusqueda')
          .classList.add('hidden');

        el('abResultadosBusqueda')
          .innerHTML = '';

        return;
      }

      const resultados =
        obtenerResultadosBusqueda(texto);

      pintarResultadosBusqueda(resultados);
    }
  );

  el('abBuscarEntidad').addEventListener(
    'focus',
    () => {
      const texto =
        el('abBuscarEntidad').value.trim();

      if (
        texto.length >= 2 &&
        !ENTIDAD_SELECCIONADA
      ) {
        pintarResultadosBusqueda(
          obtenerResultadosBusqueda(texto)
        );
      }
    }
  );

  el('btnCambiarSeleccion').addEventListener(
    'click',
    () => {
      limpiarSeleccionEntidad();
      el('abBuscarEntidad').focus();
    }
  );

  document.addEventListener(
    'click',
    event => {
      const searchWrap =
        el('abBuscarEntidad')
          .closest('.search-wrap');

      if (
        searchWrap &&
        !searchWrap.contains(event.target)
      ) {
        el('abResultadosBusqueda')
          .classList.add('hidden');
      }
    }
  );

  /* AGREGAR ABONO */

  el('btnAgregarAbono').addEventListener(
    'click',
    () => {
      limpiarFormulario();
      abrirModalAbono();

      setTimeout(() => {
        el('abAno')?.focus();
      }, 50);
    }
  );

  /* CERRAR MODAL */

  el('btnCerrarModalAbono').addEventListener(
    'click',
    () => {
      cerrarModalAbono({
        limpiar: true
      });
    }
  );

  /* CERRAR AL TOCAR FONDO */

  el('abonoModal').addEventListener(
    'click',
    event => {
      if (
        event.target ===
        el('abonoModal')
      ) {
        cerrarModalAbono({
          limpiar: true
        });
      }
    }
  );

  /* GUARDAR */

  el('btnGuardarAbono').addEventListener(
    'click',
    guardarAbono
  );

  /* CANCELAR EDICIÓN */

  el('btnCancelarEdicion').addEventListener(
    'click',
    () => {
      cerrarModalAbono({
        limpiar: true
      });
    }
  );

  /* FILTROS */

  el('btnAplicarFiltros').addEventListener(
    'click',
    renderAbonos
  );

  el('btnLimpiarFiltros').addEventListener(
    'click',
    limpiarFiltros
  );

  el('filtroBuscar').addEventListener(
    'input',
    renderAbonos
  );

  el('filtroUsuario').addEventListener(
    'input',
    renderAbonos
  );

  /* HISTORIAL */

  el('btnCerrarHistorial').addEventListener(
    'click',
    () => {
      el('historialModal')
        .classList.remove('open');
    }
  );

  el('historialModal').addEventListener(
    'click',
    event => {
      if (
        event.target ===
        el('historialModal')
      ) {
        el('historialModal')
          .classList.remove('open');
      }
    }
  );

  /* ESCAPE */

  document.addEventListener(
    'keydown',
    event => {
      if (event.key !== 'Escape') {
        return;
      }

      if (
        el('historialModal')
          .classList.contains('open')
      ) {
        el('historialModal')
          .classList.remove('open');

        return;
      }

      if (
        el('abonoModal')
          .classList.contains('open')
      ) {
        cerrarModalAbono({
          limpiar: true
        });
      }
    }
  );
}

async function inicializar() {
  el('abFechaPago').value = nowISODate();

  setEstadoFormulario(
    'Cargando datos del sistema...'
  );

  try {
    await cargarGrupos();

    await Promise.all([
      cargarServicios(),
      cargarHoteles(),
      cargarAbonos()
    ]);

    poblarAnos();

    el('abTipoActividad').checked = true;
    el('abTipoHotel').checked = false;
    el('abTipoOtro').checked = false;

    poblarDestinosFormulario({
      conservarDestino: false,
      conservarSeleccion: false
    });

    poblarFiltrosGenerales();
    conectarEventos();
    actualizarVistaTipo();
    renderAbonos();

    setEstadoFormulario('');

    el('abonoModal').classList.remove('open');
    document.body.style.overflow = '';

    console.log(
      '✅ Página de abonos inicializada'
    );
  } catch (error) {
    console.error(
      'Error inicializando abonos:',
      error
    );

    setEstadoFormulario(
      `No se pudo cargar la página: ${
        error.message || error
      }`,
      true
    );
  }
}

onAuthStateChanged(auth, user => {
  if (!user) {
    window.location.href = 'login.html';
    return;
  }

  inicializar();
});
