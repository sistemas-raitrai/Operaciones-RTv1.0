import { app, db } from './firebase-init.js';

import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  addDoc,
  writeBatch,
  runTransaction,
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

const ES_VISTA_MOVIL =
  document.documentElement.classList.contains(
    'abonos-mobile'
  );

const RUTA_ABONOS = 'AbonosOperaciones';
const RUTA_SERVICIOS_ANO = 'ServiciosPorAno';
const RUTA_GRUPOS = 'grupos';
const RUTA_HOTELES = 'hoteles';
const RUTA_HOTEL_ASSIGNMENTS = 'hotelAssignments';
const RUTA_HOTEL_ABONOS = 'FinanzasHotelesAbonos';
const RUTA_PROVEEDORES_PAGO = 'ProveedoresPago';
const RUTA_CONFIG_FINANZAS = 'ConfiguracionFinanzas';
const DOC_CONFIG_SOLICITUD = 'solicitudPago';
const RUTA_CONTADORES_ABONOS = 'ContadoresAbonos';

const MONEDAS = ['CLP', 'USD', 'BRL', 'ARS'];

let SERVICIOS = [];
let HOTELES = [];
let ASIGNACIONES = [];
let GRUPOS = [];
let ABONOS = [];

let abonoEditandoId = null;
let comprobanteActualURL = '';

let ARCHIVOS_ACTUALES = [];
let ARCHIVOS_NUEVOS_CONFIG = [];

let ABONO_SOLICITUD_ACTUAL = null;

let ENTIDAD_SELECCIONADA = null;
let LIMITE_ABONOS = 10;
let ULTIMO_ABONO_GUARDADO = null;
let MOSTRAR_ARCHIVADOS = false;

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

function obtenerFechaLocalPartes(fecha = new Date()) {
  const ano = fecha.getFullYear();

  const mes = String(
    fecha.getMonth() + 1
  ).padStart(2, '0');

  const dia = String(
    fecha.getDate()
  ).padStart(2, '0');

  return {
    ano,
    mes,
    dia,

    fechaISO:
      `${ano}-${mes}-${dia}`,

    codigoAAMMDD:
      `${String(ano).slice(-2)}${mes}${dia}`
  };
}

function nowISODate() {
  return obtenerFechaLocalPartes()
    .fechaISO;
}

async function reservarIdRegistroAbono() {
  const fecha =
    obtenerFechaLocalPartes();

  const refContador = doc(
    db,
    RUTA_CONTADORES_ABONOS,
    fecha.codigoAAMMDD
  );

  const resultado =
    await runTransaction(
      db,
      async transaction => {
        const snap =
          await transaction.get(
            refContador
          );

        const ultimoNumero =
          snap.exists()
            ? Number(
                snap.data()?.ultimoNumero ||
                0
              )
            : 0;

        const correlativo =
          ultimoNumero + 1;

        transaction.set(
          refContador,
          {
            fechaIngresoContable:
              fecha.fechaISO,

            codigoFecha:
              fecha.codigoAAMMDD,

            ultimoNumero:
              correlativo,

            updatedAt:
              serverTimestamp(),

            updatedByEmail:
              (
                auth.currentUser?.email ||
                ''
              ).toLowerCase()
          },
          {
            merge: true
          }
        );

        return {
          correlativo,

          idRegistro:
            `RT${String(correlativo).padStart(3, '0')}-${fecha.codigoAAMMDD}`,

          fechaIngresoContable:
            fecha.fechaISO,

          fechaIngresoContableCodigo:
            fecha.codigoAAMMDD
        };
      }
    );

  return resultado;
}

function getAnoComercialActual() {
  const hoy = new Date();
  const anoCalendario = hoy.getFullYear();
  const mes = hoy.getMonth() + 1;

  // Del 1 de marzo al último día de febrero siguiente.
  return mes >= 3
    ? String(anoCalendario)
    : String(anoCalendario - 1);
}

function esVistaMovil() {
  return ES_VISTA_MOVIL;
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

function normalizarTipoDocumento(tipo = '') {
  const valor = norm(tipo);

  if (valor === 'FACTURA') return 'FACTURA';
  if (valor === 'BOLETA') return 'BOLETA';
  if (valor === 'COMPROBANTE') return 'COMPROBANTE';

  return 'OTRO';
}

function obtenerArchivosAbono(abono = {}) {
  const archivos = Array.isArray(abono.archivos)
    ? abono.archivos
        .filter(archivo => archivo?.url)
        .map(archivo => ({
          ...archivo,

          tipoDocumento:
            normalizarTipoDocumento(
              archivo.tipoDocumento ||
              archivo.tipo ||
              'OTRO'
            )
        }))
    : [];

  if (archivos.length) {
    return archivos;
  }

  if (abono.comprobanteURL) {
    return [
      {
        nombre: 'Comprobante anterior',
        url: abono.comprobanteURL,
        tipoDocumento: 'COMPROBANTE',
        legado: true
      }
    ];
  }

  return [];
}

function sincronizarArchivosNuevos() {
  const files = [
    ...(el('abComprobantes')?.files || [])
  ];

  ARCHIVOS_NUEVOS_CONFIG =
    files.map((file, index) => {
      const anterior =
        ARCHIVOS_NUEVOS_CONFIG[index];

      return {
        file,

        tipoDocumento:
          anterior?.tipoDocumento ||
          'COMPROBANTE',

        numeroDocumento:
          anterior?.numeroDocumento ||
          ''
      };
    });
}

function cambiarTipoDocumentoNuevo(
  index,
  tipoDocumento
) {
  if (!ARCHIVOS_NUEVOS_CONFIG[index]) {
    return;
  }

  ARCHIVOS_NUEVOS_CONFIG[index].tipoDocumento =
    normalizarTipoDocumento(
      tipoDocumento
    );

  actualizarEstadoFacturaPorDocumentos();
}

function cambiarNumeroDocumentoNuevo(
  index,
  numeroDocumento
) {
  if (!ARCHIVOS_NUEVOS_CONFIG[index]) {
    return;
  }

  ARCHIVOS_NUEVOS_CONFIG[index]
    .numeroDocumento =
      String(numeroDocumento || '')
        .trim();
}

function pintarArchivosFormulario() {
  sincronizarArchivosNuevos();

  const contenedor =
    el('abArchivosLista');

  if (!contenedor) {
    return;
  }

  const existentesHTML =
    ARCHIVOS_ACTUALES.map(
      (archivo, index) => {
        const tipo =
          normalizarTipoDocumento(
            archivo.tipoDocumento
          );

        const numero =
          String(
            archivo.numeroDocumento ||
            ''
          ).trim();

        return `
          <div class="archivo-item">
            <a
              href="${escapeHTML(archivo.url || '')}"
              target="_blank"
              rel="noopener"
            >
              ${escapeHTML(
                archivo.nombre ||
                `Archivo ${index + 1}`
              )}
            </a>

            <strong>
              ${escapeHTML(tipo)}
            </strong>

            <span class="numero-documento-existente">
              ${
                numero
                  ? `N.º ${escapeHTML(numero)}`
                  : 'SIN N.º'
              }
            </span>
          </div>
        `;
      }
    ).join('');

  const nuevosHTML =
    ARCHIVOS_NUEVOS_CONFIG.map(
      (config, index) => `
        <div class="archivo-item nuevo">
          <span>
            ${escapeHTML(config.file.name)}
          </span>

          <select
            class="tipo-documento-nuevo"
            data-index="${index}"
          >
            <option
              value="FACTURA"
              ${
                config.tipoDocumento ===
                'FACTURA'
                  ? 'selected'
                  : ''
              }
            >
              Factura
            </option>

            <option
              value="BOLETA"
              ${
                config.tipoDocumento ===
                'BOLETA'
                  ? 'selected'
                  : ''
              }
            >
              Boleta
            </option>

            <option
              value="COMPROBANTE"
              ${
                config.tipoDocumento ===
                'COMPROBANTE'
                  ? 'selected'
                  : ''
              }
            >
              Comprobante
            </option>

            <option
              value="OTRO"
              ${
                config.tipoDocumento ===
                'OTRO'
                  ? 'selected'
                  : ''
              }
            >
              Otro
            </option>
          </select>

          <input
            class="numero-documento"
            data-index="${index}"
            type="text"
            value="${escapeHTML(
              config.numeroDocumento || ''
            )}"
            placeholder="N.º documento"
          />
        </div>
      `
    ).join('');

  contenedor.innerHTML =
    existentesHTML ||
    nuevosHTML
      ? `${existentesHTML}${nuevosHTML}`
      : `
        <span class="form-state">
          Sin archivos adjuntos.
        </span>
      `;

  contenedor
    .querySelectorAll(
      '.tipo-documento-nuevo'
    )
    .forEach(select => {
      select.addEventListener(
        'change',
        event => {
          cambiarTipoDocumentoNuevo(
            Number(
              event.target.dataset.index
            ),
            event.target.value
          );
        }
      );
    });

  contenedor
    .querySelectorAll(
      '.numero-documento'
    )
    .forEach(input => {
      input.addEventListener(
        'input',
        event => {
          cambiarNumeroDocumentoNuevo(
            Number(
              event.target.dataset.index
            ),
            event.target.value
          );
        }
      );
    });
}

function actualizarEstadoFacturaPorDocumentos() {
  const tieneDocumentoTributario = [
    ...ARCHIVOS_ACTUALES,
    ...ARCHIVOS_NUEVOS_CONFIG.map(
      item => ({
        tipoDocumento:
          item.tipoDocumento
      })
    )
  ].some(archivo =>
    ['FACTURA', 'BOLETA'].includes(
      normalizarTipoDocumento(
        archivo.tipoDocumento
      )
    )
  );

  if (
    tieneDocumentoTributario &&
    !el('abFacturaNoAplica')?.checked
  ) {
    el('abPendienteFactura').checked =
      false;
  }
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
  const estado = el('formEstado');

  if (!estado) {
    return;
  }

  estado.textContent = texto;
  estado.style.color = esError
    ? '#b91c1c'
    : '#166534';
}

function abrirModalAbono() {
  const modal = el('abonoModal');

  if (!modal) {
    console.error('No se encontró #abonoModal');
    return;
  }

  modal.classList.add('open');

  if (!ES_VISTA_MOVIL) {
    document.body.style.overflow = 'hidden';
  } else {
    document.body.style.overflow = '';
  }
}

function cerrarModalAbono({
  limpiar = true,
  forzar = false
} = {}) {
  const modal = el('abonoModal');

  if (!modal) {
    return;
  }

  /*
   * En móvil el formulario es la página principal.
   * No se cierra salvo que se indique forzar=true.
   */
  if (ES_VISTA_MOVIL && !forzar) {
    if (limpiar) {
      limpiarFormulario();
    }

    return;
  }

  modal.classList.remove('open');
  document.body.style.overflow = '';

  el('abResultadosBusqueda')
    ?.classList.add('hidden');

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
  const snap = await getDocs(
    collection(
      db,
      RUTA_ABONOS
    )
  );

  const prioridadEstado = {
    SOLICITADO: 1,
    EXPORTADO: 2,
    NO_SOLICITADO: 3,
    PAGADO: 4,
    ANULADO: 5
  };

  ABONOS = snap.docs
    .map(documento => ({
      id: documento.id,
      ...documento.data()
    }))
    .sort((a, b) => {
      const estadoA =
        norm(
          a.estadoSolicitudPago ||
          'NO_SOLICITADO'
        );

      const estadoB =
        norm(
          b.estadoSolicitudPago ||
          'NO_SOLICITADO'
        );

      const prioridadA =
        prioridadEstado[estadoA] ||
        99;

      const prioridadB =
        prioridadEstado[estadoB] ||
        99;

      if (
        prioridadA !== prioridadB
      ) {
        return prioridadA - prioridadB;
      }

      const fechaA =
        a.createdAt?.toMillis?.() ||
        a.fechaRegistro?.toMillis?.() ||
        0;

      const fechaB =
        b.createdAt?.toMillis?.() ||
        b.fechaRegistro?.toMillis?.() ||
        0;

      return fechaB - fechaA;
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
  const anoComercial = getAnoComercialActual();

  if (!anos.includes(anoComercial)) {
    anos.push(anoComercial);
    anos.sort((a, b) => Number(a) - Number(b));
  }

  el('abAno').innerHTML = anos
    .map(ano => `
      <option value="${escapeHTML(ano)}">
        ${escapeHTML(ano)}
      </option>
    `)
    .join('');

  el('abAno').value = anoComercial;

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

  el('filtroAno').value = anoComercial;
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

    destinos.add('OTRO');
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

  sincronizarArchivosNuevos();

  for (
    const configuracion
    of ARCHIVOS_NUEVOS_CONFIG
  ) {
    const tipo =
      normalizarTipoDocumento(
        configuracion.tipoDocumento
      );
  
    const numero =
      String(
        configuracion.numeroDocumento ||
        ''
      ).trim();
  
    if (
      ['FACTURA', 'BOLETA', 'COMPROBANTE']
        .includes(tipo) &&
      !numero
    ) {
      return (
        `Debe indicar el número del documento ` +
        `${tipo}: ${configuracion.file.name}`
      );
    }
  }

  if (
    abonoEditandoId &&
    !el('abMotivoCambio').value.trim()
  ) {
    return 'Debe indicar el motivo del cambio.';
  }

  return '';
}

function obtenerEstadoFacturaFormulario() {
  if (
    el('abFacturaNoAplica')
      ?.checked
  ) {
    return 'NO_APLICA';
  }

  if (
    el('abPendienteFactura')
      ?.checked
  ) {
    return 'PENDIENTE';
  }

  return 'COMPLETA';
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
    
    estadoFactura:
      obtenerEstadoFacturaFormulario(),
    
    pendienteFactura:
      obtenerEstadoFacturaFormulario() ===
      'PENDIENTE',
    
    facturaNoAplica:
      obtenerEstadoFacturaFormulario() ===
      'NO_APLICA',

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

async function subirArchivosAbono(
  configuraciones,
  datos,
  abonoId,
  archivosExistentes = []
) {
  const archivosFinales = [
    ...archivosExistentes
  ];

  for (const configuracion of configuraciones) {
    const file = configuracion.file;

    if (!file) {
      continue;
    }

    const tipoDocumento =
      normalizarTipoDocumento(
        configuracion.tipoDocumento
      );

    const numeroDocumento =
      String(
        configuracion.numeroDocumento ||
        ''
      ).trim();

    const nombreSeguro =
      file.name.replace(
        /[^\w.\-]+/g,
        '_'
      );

    const ruta = storageRef(
      storage,
      `abonos_operaciones/${datos.ano}/${datos.tipo}/${slug(datos.destino)}/${abonoId}/${Date.now()}_${nombreSeguro}`
    );

    await uploadBytes(
      ruta,
      file
    );

    const url =
      await getDownloadURL(ruta);

    archivosFinales.push({
      nombre: file.name,
      nombreStorage: nombreSeguro,

      tipoDocumento,
      numeroDocumento,

      url,

      mimeType:
        file.type || '',

      size:
        Number(file.size || 0),

      uploadedAtISO:
        new Date().toISOString(),

      uploadedByEmail:
        (
          auth.currentUser?.email ||
          ''
        ).toLowerCase()
    });
  }

  return archivosFinales;
}

function datosParaEspejo(
  datos,
  abonoId,
  archivos,
  email,
  esEdicion,
  version
) {
  const comprobanteURL =
    archivos[0]?.url || '';

  const datosBase = {
    abonoOperacionId: abonoId,
  
    idRegistro:
      datos.idRegistro || '',
  
    correlativoRegistro:
      Number(
        datos.correlativoRegistro || 0
      ),
  
    fechaIngresoContable:
      datos.fechaIngresoContable || '',
  
    fechaIngresoContableCodigo:
      datos.fechaIngresoContableCodigo || '',

    fecha: datos.fechaPago,
    fechaPago: datos.fechaPago,

    moneda: datos.moneda,
    monto: datos.monto,
    formaPago: datos.formaPago,

    referencia: datos.referencia,
    nota: datos.nota,

    estadoFactura:
      datos.estadoFactura ||
      (
        datos.facturaNoAplica
          ? 'NO_APLICA'
          : datos.pendienteFactura
            ? 'PENDIENTE'
            : 'COMPLETA'
      ),
    
    pendienteFactura:
      Boolean(datos.pendienteFactura),
    
    facturaNoAplica:
      Boolean(datos.facturaNoAplica),
    
    archivos,
    comprobanteURL,

    estadoSolicitudPago:
      datos.estadoSolicitudPago ||
      'NO_SOLICITADO',

    estado: esEdicion
      ? 'EDITADO'
      : 'ORIGINAL',

    version,

    updatedAt: esEdicion
      ? serverTimestamp()
      : null,

    updatedByEmail: esEdicion
      ? email
      : '',

    createdAt: esEdicion
      ? null
      : serverTimestamp(),

    createdByEmail: esEdicion
      ? ''
      : email
  };

  if (datos.tipo === 'actividad') {
    return {
      ...datosBase,

      anoTarifa: String(datos.ano),
      destinoId: datos.destino,

      servicioId: datos.servicioId,
      proveedorNombre: datos.proveedorNombre,
      servicioNombre: datos.servicioNombre
    };
  }

  return {
    ...datosBase,

    anoTarifa: String(datos.ano),
    destino: datos.destino,

    hotelId: datos.hotelId,
    hotelKey: datos.hotelKey,
    hotelNombre: datos.hotelNombre
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
  archivos,
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
      archivos,
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

function obtenerNombreEntidadAbono(abono = {}) {
  if (abono.tipo === 'hotel') {
    return abono.hotelNombre || '';
  }

  return abono.proveedorNombre || '';
}

function obtenerProveedorPagoId(abono = {}) {
  if (abono.tipo === 'hotel') {
    return `hotel__${slug(
      abono.hotelKey ||
      abono.hotelNombre
    )}`;
  }

  return `proveedor__${slug(
    abono.proveedorId ||
    abono.proveedorNombre
  )}`;
}

function cerrarSolicitudPago() {
  el('solicitudPagoModal')
    ?.classList
    .remove('open');

  ABONO_SOLICITUD_ACTUAL = null;

  document.body.style.overflow = '';
}

async function abrirSolicitudPago(abono) {
  if (!abono?.id) {
    alert(
      'Primero debe guardar el abono.'
    );

    return;
  }

  ABONO_SOLICITUD_ACTUAL =
    abono;

  const proveedorPagoId =
    obtenerProveedorPagoId(abono);

  let datosProveedor = {};
  let configuracion = {};

  try {
    const [
      snapProveedor,
      snapConfiguracion
    ] = await Promise.all([
      getDoc(
        doc(
          db,
          RUTA_PROVEEDORES_PAGO,
          proveedorPagoId
        )
      ),

      getDoc(
        doc(
          db,
          RUTA_CONFIG_FINANZAS,
          DOC_CONFIG_SOLICITUD
        )
      )
    ]);

    if (snapProveedor.exists()) {
      datosProveedor =
        snapProveedor.data() || {};
    }

    if (snapConfiguracion.exists()) {
      configuracion =
        snapConfiguracion.data() || {};
    }

  } catch (error) {
    console.warn(
      'No se pudieron cargar datos bancarios anteriores:',
      error
    );
  }

  const solicitudAbono =
    abono.solicitudPago || {};

  const monedaAbono =
    normalizarMoneda(
      abono.moneda || 'CLP'
    );

  el('solicitudPagoResumen').textContent =
    `${obtenerNombreEntidadAbono(abono)} · ` +
    `${abono.servicioNombre || 'PAGO'} · ` +
    `${monedaAbono} ${fmtNumero(abono.monto)}`;

  el('spCuentaOrigen').value =
    solicitudAbono.cuentaOrigen ||
    configuracion.cuentaOrigen ||
    '4109651';

  el('spMonedaOrigen').value =
    normalizarMoneda(
      solicitudAbono.monedaOrigen ||
      configuracion.monedaOrigen ||
      monedaAbono
    );

  el('spCuentaDestino').value =
    solicitudAbono.cuentaDestino ||
    datosProveedor.cuentaDestino ||
    '';

  el('spMonedaDestino').value =
    normalizarMoneda(
      solicitudAbono.monedaDestino ||
      datosProveedor.monedaDestino ||
      monedaAbono
    );

  el('spCodigoBanco').value =
    solicitudAbono.codigoBanco ||
    datosProveedor.codigoBanco ||
    '';

  el('spRutBeneficiario').value =
    solicitudAbono.rutBeneficiario ||
    datosProveedor.rutBeneficiario ||
    '';

  el('spNombreBeneficiario').value =
    solicitudAbono.nombreBeneficiario ||
    datosProveedor.nombreBeneficiario ||
    obtenerNombreEntidadAbono(abono);

  /*
   * Siempre usamos el monto actual del abono.
   * Nunca el monto anterior del proveedor.
   */
  el('spMontoTotal').value =
    Number(abono.monto || 0);

  el('spGlosaTef').value =
    solicitudAbono.glosaTef ||
    datosProveedor.glosaTef ||
    abono.referencia ||
    '';

  el('spCorreo').value =
    solicitudAbono.correo ||
    datosProveedor.correo ||
    '';

  el('spGlosaCorreo').value =
    solicitudAbono.glosaCorreo ||
    datosProveedor.glosaCorreo ||
    abono.referencia ||
    '';

  const estadoSolicitud =
    norm(
      abono.estadoSolicitudPago ||
      'NO_SOLICITADO'
    );

  el('btnMarcarPagada')
    .classList.toggle(
      'hidden',
      estadoSolicitud !== 'EXPORTADO'
    );

  el('btnGuardarSolicitudPago').textContent =
    estadoSolicitud === 'NO_SOLICITADO'
      ? 'Guardar solicitud'
      : 'Guardar cambios';

  el('solicitudPagoModal')
    .classList
    .add('open');

  document.body.style.overflow =
    'hidden';
}

function obtenerDatosSolicitudPago() {
  return {
    cuentaOrigen:
      el('spCuentaOrigen').value.trim(),

    monedaOrigen:
      normalizarMoneda(
        el('spMonedaOrigen').value
      ),

    cuentaDestino:
      el('spCuentaDestino').value.trim(),

    monedaDestino:
      normalizarMoneda(
        el('spMonedaDestino').value
      ),

    codigoBanco:
      el('spCodigoBanco').value.trim(),

    rutBeneficiario:
      el('spRutBeneficiario').value.trim(),

    nombreBeneficiario:
      el('spNombreBeneficiario').value.trim(),

    montoTotal:
      Number(
        el('spMontoTotal').value || 0
      ),

    glosaTef:
      el('spGlosaTef').value.trim(),

    correo:
      el('spCorreo').value.trim(),

    glosaCorreo:
      el('spGlosaCorreo').value.trim()
  };
}

function validarSolicitudPago(datos) {
  if (!datos.cuentaOrigen) {
    return 'Debe indicar la cuenta de origen.';
  }

  if (!datos.cuentaDestino) {
    return 'Debe indicar la cuenta de destino.';
  }

  if (!datos.codigoBanco) {
    return 'Debe indicar el código del banco.';
  }

  if (!datos.rutBeneficiario) {
    return 'Debe indicar el RUT del beneficiario.';
  }

  if (!datos.nombreBeneficiario) {
    return 'Debe indicar el nombre del beneficiario.';
  }

  if (!(datos.montoTotal > 0)) {
    return 'El monto total debe ser mayor que cero.';
  }

  if (!datos.glosaTef) {
    return 'Debe indicar la glosa TEF.';
  }

  if (!datos.correo) {
    return 'Debe indicar el correo.';
  }

  if (!datos.glosaCorreo) {
    return 'Debe indicar la glosa del correo.';
  }

  return '';
}

async function guardarSolicitudPago() {
  const abono =
    ABONO_SOLICITUD_ACTUAL;

  if (!abono?.id) {
    alert(
      'No se encontró el abono seleccionado.'
    );

    return;
  }

  const solicitud =
    obtenerDatosSolicitudPago();

  const error =
    validarSolicitudPago(solicitud);

  if (error) {
    alert(error);
    return;
  }

  const btn =
    el('btnGuardarSolicitudPago');

  btn.disabled = true;

  try {
    const email =
      (
        auth.currentUser?.email ||
        ''
      ).toLowerCase();

    if (!email) {
      throw new Error(
        'No se pudo identificar al usuario conectado.'
      );
    }

    /*
     * Leemos nuevamente el abono para trabajar
     * con la versión más reciente de Firestore.
     */
    const refAbono = doc(
      db,
      RUTA_ABONOS,
      abono.id
    );

    const snapAbono =
      await getDoc(refAbono);

    if (!snapAbono.exists()) {
      throw new Error(
        'El abono ya no existe.'
      );
    }

    const abonoActual =
      snapAbono.data() || {};

    const proveedorPagoId =
      obtenerProveedorPagoId({
        id: abono.id,
        ...abonoActual
      });

    const nombreEntidad =
      obtenerNombreEntidadAbono({
        id: abono.id,
        ...abonoActual
      });

    const estadoAnterior =
      norm(
        abonoActual.estadoSolicitudPago ||
        'NO_SOLICITADO'
      );

    /*
     * Si una solicitud ya había sido exportada y se
     * modifican sus datos, vuelve a SOLICITADO para
     * que se exporte nuevamente.
     *
     * Si ya fue pagada, conserva PAGADO.
     */
    const estadoNuevo =
      estadoAnterior === 'PAGADO'
        ? 'PAGADO'
        : 'SOLICITADO';

    const versionAnterior =
      Number(
        abonoActual.version || 1
      );

    const nuevaVersion =
      versionAnterior + 1;

    const solicitudAnterior =
      abonoActual.solicitudPago ||
      null;

    const solicitudCompleta = {
      ...solicitud,

      proveedorPagoId,

      proveedorNombre:
        nombreEntidad,

      estado:
        estadoNuevo,

      /*
       * Conservamos la primera fecha de solicitud
       * si ya existía.
       */
      solicitadoAt:
        solicitudAnterior?.solicitadoAt ||
        serverTimestamp(),

      solicitadoByEmail:
        solicitudAnterior?.solicitadoByEmail ||
        email,

      updatedAt:
        serverTimestamp(),

      updatedByEmail:
        email
    };

    const batch =
      writeBatch(db);

    /*
     * 1. Actualizar el abono.
     */
    batch.update(
      refAbono,
      {
        solicitudPago:
          solicitudCompleta,

        estadoSolicitudPago:
          estadoNuevo,

        updatedAt:
          serverTimestamp(),

        updatedByEmail:
          email,

        version:
          nuevaVersion
      }
    );

    /*
     * 2. Guardar solamente los datos reutilizables
     * del beneficiario/proveedor.
     *
     * La cuenta origen NO se guarda aquí porque
     * corresponde a Rai Trai, no al proveedor.
     */
    const refProveedor = doc(
      db,
      RUTA_PROVEEDORES_PAGO,
      proveedorPagoId
    );

    batch.set(
      refProveedor,
      {
        proveedorPagoId,

        proveedorNombre:
          nombreEntidad,

        tipo:
          abonoActual.tipo || '',

        proveedorId:
          abonoActual.proveedorId || '',

        servicioId:
          abonoActual.servicioId || '',

        hotelId:
          abonoActual.hotelId || '',

        hotelKey:
          abonoActual.hotelKey || '',

        cuentaDestino:
          solicitud.cuentaDestino,

        monedaDestino:
          solicitud.monedaDestino,

        codigoBanco:
          solicitud.codigoBanco,

        rutBeneficiario:
          solicitud.rutBeneficiario,

        nombreBeneficiario:
          solicitud.nombreBeneficiario,

        glosaTef:
          solicitud.glosaTef,

        correo:
          solicitud.correo,

        glosaCorreo:
          solicitud.glosaCorreo,

        updatedAt:
          serverTimestamp(),

        updatedByEmail:
          email
      },
      {
        merge: true
      }
    );

    /*
     * 3. Guardar la última cuenta origen utilizada
     * como configuración general.
     *
     * Inicialmente aparece 4109651, pero si alguien
     * utiliza otra cuenta, esa será la predeterminada
     * para las siguientes solicitudes.
     */
    const refConfiguracion = doc(
      db,
      RUTA_CONFIG_FINANZAS,
      DOC_CONFIG_SOLICITUD
    );

    batch.set(
      refConfiguracion,
      {
        cuentaOrigen:
          solicitud.cuentaOrigen,

        monedaOrigen:
          solicitud.monedaOrigen,

        updatedAt:
          serverTimestamp(),

        updatedByEmail:
          email
      },
      {
        merge: true
      }
    );

    /*
     * 4. Registrar el cambio en el historial.
     */
    const refHistorial = doc(
      collection(
        db,
        RUTA_ABONOS,
        abono.id,
        'Historial'
      )
    );

    batch.set(
      refHistorial,
      {
        versionAnterior,

        datosAnteriores:
          abonoActual,

        solicitudAnterior,

        solicitudNueva:
          solicitudCompleta,

        tipoCambio:
          solicitudAnterior
            ? 'SOLICITUD_PAGO_EDITADA'
            : 'SOLICITUD_PAGO_CREADA',

        motivoCambio:
          solicitudAnterior
            ? 'Actualización de datos de solicitud de pago'
            : 'Creación de solicitud de ejecución de pago',

        changedAt:
          serverTimestamp(),

        changedByEmail:
          email
      }
    );

    /*
     * Todos los cambios se guardan juntos.
     */
    await batch.commit();

    await cargarAbonos();

    if (!ES_VISTA_MOVIL) {
      renderAbonos();
    }

    const abonoActualizado =
      ABONOS.find(
        item =>
          item.id === abono.id
      );

    if (abonoActualizado) {
      ABONO_SOLICITUD_ACTUAL =
        abonoActualizado;
    }

    /*
     * Actualizamos visualmente el botón del modal.
     */
    if (el('btnGuardarSolicitudPago')) {
      el('btnGuardarSolicitudPago')
        .textContent =
          estadoNuevo === 'PAGADO'
            ? 'Guardar cambios'
            : 'Guardar cambios';
    }

    alert(
      solicitudAnterior
        ? '✅ Solicitud de ejecución actualizada correctamente.'
        : '✅ Solicitud de ejecución guardada correctamente.'
    );

  } catch (error) {
    console.error(
      'Error guardando solicitud de pago:',
      error
    );

    alert(
      `No se pudo guardar la solicitud: ${
        error.message || error
      }`
    );

  } finally {
    btn.disabled = false;
  }
}

function construirFilaSolicitudExcel(abono) {
  const solicitud =
    abono.solicitudPago || {};

  return {
    'Cta_origen':
      solicitud.cuentaOrigen || '',

    'moneda_origen':
      solicitud.monedaOrigen || '',

    'Cta_destino':
      solicitud.cuentaDestino || '',

    'moneda_destino':
      solicitud.monedaDestino || '',

    'Cod_banco':
      solicitud.codigoBanco || '',

    'RUT benef':
      solicitud.rutBeneficiario || '',

    'Nombre benef':
      solicitud.nombreBeneficiario || '',

    'Mto Total':
      Number(solicitud.montoTotal || 0),

    'Glosa TEF':
      solicitud.glosaTef || '',

    'Correo':
      solicitud.correo || '',

    'Glosa correo':
      solicitud.glosaCorreo || ''
  };
}

function descargarArchivoSolicitudes(
  lista,
  nombreArchivo
) {
  if (!window.XLSX) {
    alert(
      'No se pudo cargar la herramienta de exportación Excel.'
    );

    return;
  }

  const filas =
    lista.map(construirFilaSolicitudExcel);

  const hoja =
    window.XLSX.utils.json_to_sheet(
      filas,
      {
        header: [
          'Cta_origen',
          'moneda_origen',
          'Cta_destino',
          'moneda_destino',
          'Cod_banco',
          'RUT benef',
          'Nombre benef',
          'Mto Total',
          'Glosa TEF',
          'Correo',
          'Glosa correo'
        ]
      }
    );

  const libro =
    window.XLSX.utils.book_new();

  window.XLSX.utils.book_append_sheet(
    libro,
    hoja,
    'Pagos'
  );

  window.XLSX.writeFile(
    libro,
    nombreArchivo
  );
}

async function descargarSolicitudActual() {
  const abono =
    ABONO_SOLICITUD_ACTUAL;

  if (!abono?.solicitudPago) {
    alert(
      'Primero debe guardar la solicitud de ejecución.'
    );

    return;
  }

  descargarArchivoSolicitudes(
    [abono],
    `solicitud_pago_${abono.id}.xlsx`
  );

  try {
    await updateDoc(
      doc(
        db,
        RUTA_ABONOS,
        abono.id
      ),
      {
        estadoSolicitudPago:
          'EXPORTADO',

        'solicitudPago.estado':
          'EXPORTADO',

        'solicitudPago.exportadoAt':
          serverTimestamp(),

        'solicitudPago.exportadoByEmail':
          (
            auth.currentUser?.email ||
            ''
          ).toLowerCase()
      }
    );

    await cargarAbonos();
    renderAbonos();

  } catch (error) {
    console.warn(
      'El Excel se descargó, pero no se pudo actualizar el estado:',
      error
    );
  }
}

async function exportarSolicitudesPago() {
  const lista = abonosFiltrados()
    .filter(abono =>
      Boolean(abono.solicitudPago) &&
      norm(abono.estadoSolicitudPago) ===
        'SOLICITADO'
    );

  if (!lista.length) {
    alert(
      'No hay solicitudes pendientes de exportar con los filtros seleccionados.'
    );

    return;
  }

  const fecha =
    new Date()
      .toISOString()
      .slice(0, 10);

  descargarArchivoSolicitudes(
    lista,
    `solicitudes_pago_${fecha}.xlsx`
  );

  const email =
    (auth.currentUser?.email || '')
      .toLowerCase();

  try {
    await Promise.all(
      lista.map(abono =>
        updateDoc(
          doc(
            db,
            RUTA_ABONOS,
            abono.id
          ),
          {
            estadoSolicitudPago:
              'EXPORTADO',

            'solicitudPago.estado':
              'EXPORTADO',

            'solicitudPago.exportadoAt':
              serverTimestamp(),

            'solicitudPago.exportadoByEmail':
              email
          }
        )
      )
    );

    await cargarAbonos();
    renderAbonos();

  } catch (error) {
    console.warn(
      'El archivo se descargó, pero algunos estados no se actualizaron:',
      error
    );
  }
}

function abrirConfirmarPago() {
  if (!ABONO_SOLICITUD_ACTUAL?.id) {
    alert(
      'No se encontró el abono seleccionado.'
    );

    return;
  }

  el('pagoTipoDocumento').value =
    '';
  
  el('pagoNumeroDocumento').value =
    '';
  
  el('pagoArchivo').value =
    '';

  el('confirmarPagoModal')
    .classList
    .add('open');
}

function cerrarConfirmarPago() {
  el('confirmarPagoModal')
    ?.classList
    .remove('open');
}

async function confirmarPagoEjecutado() {
  const abono =
    ABONO_SOLICITUD_ACTUAL;

  if (!abono?.id) {
    alert(
      'No se encontró el abono seleccionado.'
    );

    return;
  }

  const tipoDocumento =
    el('pagoTipoDocumento').value;
  
  const numeroDocumento =
    el('pagoNumeroDocumento')
      .value
      .trim();
  
  const file =
    el('pagoArchivo').files[0] ||
    null;

  if (
    tipoDocumento &&
    !file
  ) {
    alert(
      'Debe seleccionar el archivo del documento.'
    );

    return;
  }

  if (
    file &&
    !tipoDocumento
  ) {
    alert(
      'Debe indicar qué tipo de documento está adjuntando.'
    );

    return;
  }
  
  if (
    file &&
    ['FACTURA', 'BOLETA', 'COMPROBANTE']
      .includes(
        normalizarTipoDocumento(
          tipoDocumento
        )
      ) &&
    !numeroDocumento
  ) {
    alert(
      'Debe indicar el número del documento.'
    );
  
    return;
  }

  if (
    !confirm(
      '¿Confirma que el pago fue ejecutado?'
    )
  ) {
    return;
  }

  const btn =
    el('btnConfirmarPagoEjecutado');

  btn.disabled = true;

  try {
    const email =
      (
        auth.currentUser?.email ||
        ''
      ).toLowerCase();

    const refAbono = doc(
      db,
      RUTA_ABONOS,
      abono.id
    );

    const snap =
      await getDoc(refAbono);

    if (!snap.exists()) {
      throw new Error(
        'El abono ya no existe.'
      );
    }

    const actual =
      snap.data() || {};

    let archivos =
      obtenerArchivosAbono(actual);

    let estadoFactura =
      actual.estadoFactura ||
      (
        actual.facturaNoAplica
          ? 'NO_APLICA'
          : actual.pendienteFactura
            ? 'PENDIENTE'
            : 'COMPLETA'
      );

    let documentoAdjuntado =
      null;

    if (file) {
      const archivosNuevos =
        await subirArchivosAbono(
          [
            {
              file,
              tipoDocumento,
              numeroDocumento
            }
          ],
          actual,
          abono.id,
          archivos
        );

      archivos =
        archivosNuevos;

      documentoAdjuntado =
        archivos[
          archivos.length - 1
        ];

      if (
        ['FACTURA', 'BOLETA'].includes(
          normalizarTipoDocumento(
            tipoDocumento
          )
        )
      ) {
        estadoFactura =
          'COMPLETA';
      }
    }

    await addDoc(
      collection(
        db,
        RUTA_ABONOS,
        abono.id,
        'Historial'
      ),
      {
        versionAnterior:
          Number(actual.version || 1),

        datosAnteriores:
          actual,

        tipoCambio:
          'PAGO_CONFIRMADO',

        motivoCambio:
          'Pago marcado como ejecutado',

        documentoAdjuntado,

        changedAt:
          serverTimestamp(),

        changedByEmail:
          email
      }
    );

    await updateDoc(
      refAbono,
      {
        archivos,

        comprobanteURL:
          archivos[0]?.url ||
          actual.comprobanteURL ||
          '',

        estadoFactura,

        pendienteFactura:
          estadoFactura ===
          'PENDIENTE',

        facturaNoAplica:
          estadoFactura ===
          'NO_APLICA',

        estadoSolicitudPago:
          'PAGADO',

        'solicitudPago.estado':
          'PAGADO',

        'solicitudPago.pagadoAt':
          serverTimestamp(),

        'solicitudPago.pagadoByEmail':
          email,

        updatedAt:
          serverTimestamp(),

        updatedByEmail:
          email,

        version:
          Number(actual.version || 1) + 1
      }
    );

    await cargarAbonos();
    renderAbonos();

    cerrarConfirmarPago();
    cerrarSolicitudPago();

    alert(
      '✅ Pago confirmado como ejecutado.'
    );

  } catch (error) {
    console.error(error);

    alert(
      `No se pudo confirmar el pago: ${
        error.message || error
      }`
    );

  } finally {
    btn.disabled = false;
  }
}

function mostrarConfirmacionAbono(datos = {}) {
  el('confirmacionIdRegistro').textContent =
    datos.idRegistro ||
    '—';

  const proveedor =
    datos.tipo === 'hotel'
      ? datos.hotelNombre
      : datos.proveedorNombre;

  el('confirmacionProveedor').textContent =
    proveedor || '—';

  el('confirmacionServicio').textContent =
    datos.servicioNombre ||
    datos.nota ||
    '—';

  el('confirmacionMonto').textContent =
    `${datos.moneda || 'CLP'} ${fmtNumero(datos.monto || 0)}`;

  el('confirmacionAbonoModal')
    .classList.add('open');

  document.body.style.overflow = 'hidden';
}

function cerrarConfirmacionAbono() {
  el('confirmacionAbonoModal')
    .classList.remove('open');

  document.body.style.overflow = '';
}

async function guardarAbono({
  solicitarDespues = false
} = {}) {
  const error =
    validarFormulario();

  if (error) {
    alert(error);
    return null;
  }

  const btnGuardar =
    el('btnGuardarAbono');

  const btnGuardarYSolicitar =
    el('btnGuardarYSolicitar');

  const eraEdicion =
    Boolean(abonoEditandoId);

  btnGuardar.disabled = true;

  if (btnGuardarYSolicitar) {
    btnGuardarYSolicitar.disabled = true;
  }

  setEstadoFormulario(
    'Guardando...'
  );

  try {
    const datos =
      obtenerDatosFormulario();

    const email =
      (
        auth.currentUser?.email ||
        ''
      ).toLowerCase();

    sincronizarArchivosNuevos();

    if (!email) {
      throw new Error(
        'No se pudo identificar al usuario conectado.'
      );
    }

    let abonoId = abonoEditandoId;
    let documentoFinal = null;

    if (!abonoId) {
      setEstadoFormulario(
        'Asignando ID de registro...'
      );
    
      const datosRegistro =
        await reservarIdRegistroAbono();
    
      const refCentral = doc(
        collection(
          db,
          RUTA_ABONOS
        )
      );
    
      abonoId = refCentral.id;
    
      setEstadoFormulario(
        `Subiendo documentos · ${datosRegistro.idRegistro}...`
      );
    
      const archivos =
        await subirArchivosAbono(
          ARCHIVOS_NUEVOS_CONFIG,
          datos,
          abonoId,
          []
        );

      const documento = {
        ...datos,
      
        idRegistro:
          datosRegistro.idRegistro,
      
        correlativoRegistro:
          datosRegistro.correlativo,
      
        fechaIngresoContable:
          datosRegistro.fechaIngresoContable,
      
        fechaIngresoContableCodigo:
          datosRegistro.fechaIngresoContableCodigo,
      
        archivos,

        comprobanteURL:
          archivos[0]?.url || '',

        estadoSolicitudPago:
          'NO_SOLICITADO',

        solicitudPago:
          null,

        fechaRegistro:
          serverTimestamp(),

        createdAt:
          serverTimestamp(),

        createdByEmail:
          email,

        updatedAt:
          null,

        updatedByEmail:
          '',

        archivedAt:
          null,

        archivedByEmail:
          '',

        version:
          1
      };

      await setDoc(
        refCentral,
        documento
      );

      await guardarEspejo(
        documento,
        abonoId,
        archivos,
        email,
        false,
        1
      );

      documentoFinal = {
        id: abonoId,
        ...documento
      };

    } else {
      const refCentral = doc(
        db,
        RUTA_ABONOS,
        abonoId
      );

      const snapActual =
        await getDoc(refCentral);

      if (!snapActual.exists()) {
        throw new Error(
          'El abono que intenta editar ya no existe.'
        );
      }

      const anterior =
        snapActual.data() || {};

      const versionAnterior =
        Number(anterior.version || 1);

      const nuevaVersion =
        versionAnterior + 1;

      const motivoCambio =
        el('abMotivoCambio')
          .value
          .trim();

      await addDoc(
        collection(
          db,
          RUTA_ABONOS,
          abonoId,
          'Historial'
        ),
        {
          versionAnterior,
          datosAnteriores:
            anterior,

          motivoCambio,

          tipoCambio:
            'EDICION_ABONO',

          changedAt:
            serverTimestamp(),

          changedByEmail:
            email
        }
      );

      const archivosExistentes =
        obtenerArchivosAbono(
          anterior
        );

      const archivos =
        await subirArchivosAbono(
          ARCHIVOS_NUEVOS_CONFIG,
          datos,
          abonoId,
          archivosExistentes
        );

      const documentoActualizado = {
        ...datos,

        archivos,

        comprobanteURL:
          archivos[0]?.url ||
          anterior.comprobanteURL ||
          '',

        estado:
          'EDITADO',

        version:
          nuevaVersion,

        updatedAt:
          serverTimestamp(),

        updatedByEmail:
          email,

        motivoUltimoCambio:
          motivoCambio
      };

      await updateDoc(
        refCentral,
        documentoActualizado
      );

      await guardarEspejo(
        {
          ...anterior,
          ...documentoActualizado
        },
        abonoId,
        archivos,
        email,
        true,
        nuevaVersion
      );

      documentoFinal = {
        id: abonoId,
        ...anterior,
        ...documentoActualizado
      };
    }

    ULTIMO_ABONO_GUARDADO = {
      ...documentoFinal
    };

    await cargarAbonos();

    const abonoGuardado =
      ABONOS.find(
        item =>
          item.id === abonoId
      ) || {
        ...documentoFinal,
        id: abonoId
      };

    poblarFiltrosGenerales();
    renderAbonos();

    if (solicitarDespues) {
      if (!ES_VISTA_MOVIL) {
        cerrarModalAbono({
          limpiar: false,
          forzar: true
        });
      }
    
      await abrirSolicitudPago(
        abonoGuardado
      );
    
      /*
       * En escritorio limpiamos el formulario que quedó
       * detrás del modal de solicitud.
       *
       * En móvil lo mantenemos estable hasta que termine
       * el proceso de solicitud.
       */
      if (!ES_VISTA_MOVIL) {
        limpiarFormulario();
      }
    
      return abonoGuardado;
    }

    const datosConfirmacion = {
      ...abonoGuardado
    };

    limpiarFormulario();

    if (!ES_VISTA_MOVIL) {
      cerrarModalAbono({
        limpiar: false,
        forzar: true
      });
    }

    if (esVistaMovil()) {
      mostrarConfirmacionAbono(
        datosConfirmacion
      );
    } else {
      alert(
        eraEdicion
          ? '✅ Abono actualizado correctamente.'
          : '✅ Abono registrado correctamente.'
      );
    }

    return abonoGuardado;

  } catch (error) {
    console.error(error);

    setEstadoFormulario(
      error.message ||
      'No se pudo guardar.',
      true
    );

    alert(
      `No se pudo guardar el abono: ${
        error.message || error
      }`
    );

    return null;

  } finally {
    btnGuardar.disabled = false;

    if (btnGuardarYSolicitar) {
      btnGuardarYSolicitar.disabled =
        false;
    }
  }
}

function limpiarFormulario() {
  abonoEditandoId = null;
  comprobanteActualURL = '';
  
  ARCHIVOS_ACTUALES = [];
  ARCHIVOS_NUEVOS_CONFIG = [];
  ABONO_SOLICITUD_ACTUAL = null;
  
  ENTIDAD_SELECCIONADA = null;

  if (el('abonoModalTitulo')) {
    el('abonoModalTitulo').textContent = 'Agregar abono';
  }

  el('btnGuardarAbono').innerHTML = `
    <span class="material-symbols-outlined">
      save
    </span>
  
    Guardar abono
  `;
  
  el('btnGuardarYSolicitar').innerHTML = `
    <span class="material-symbols-outlined">
      account_balance
    </span>
  
    Guardar y solicitar ejecución
  `;

  el('btnCancelarEdicion').classList.add('hidden');
  el('motivoCambioWrap').classList.add('hidden');

  el('abTipoActividad').checked = true;
  el('abTipoHotel').checked = false;
  el('abTipoOtro').checked = false;

  const anoComercial = getAnoComercialActual();
  const opcionesAno = [...el('abAno').options];
  
  if (
    opcionesAno.some(
      opcion => opcion.value === anoComercial
    )
  ) {
    el('abAno').value = anoComercial;
  }

  el('abIdRegistro').value =
    '---';
  el('abFechaPago').value = nowISODate();
  el('abMoneda').value = 'CLP';
  el('abMonto').value = '';
  el('abFormaPago').value = 'transferencia';
  el('abReferencia').value = '';
  el('abNota').value = '';
  el('abMotivoCambio').value = '';
  el('abComprobantes').value = '';
  el('abPendienteFactura').checked =
    false;
  
  el('abFacturaNoAplica').checked =
    false;
  
  pintarArchivosFormulario();

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

  ARCHIVOS_ACTUALES =
    obtenerArchivosAbono(abono);
  
  ABONO_SOLICITUD_ACTUAL = abono;

  if (el('abonoModalTitulo')) {
    el('abonoModalTitulo').textContent =
      `Editar abono · versión ${Number(abono.version || 1)}`;
  }

  el('btnGuardarAbono').innerHTML = `
    <span class="material-symbols-outlined">
      save_as
    </span>
  
    Guardar cambios
  `;
  
  el('btnGuardarYSolicitar').innerHTML = `
    <span class="material-symbols-outlined">
      account_balance
    </span>
  
    Guardar cambios y solicitar ejecución
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

  el('abIdRegistro').value =
    abono.idRegistro ||
    'SIN ID REGISTRO';
  
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
  
  el('abComprobantes').value = '';
  
  const estadoFactura =
    abono.estadoFactura ||
    (
      abono.facturaNoAplica
        ? 'NO_APLICA'
        : abono.pendienteFactura
          ? 'PENDIENTE'
          : 'COMPLETA'
    );
  
  el('abPendienteFactura').checked =
    estadoFactura === 'PENDIENTE';
  
  el('abFacturaNoAplica').checked =
    estadoFactura === 'NO_APLICA';
  
  pintarArchivosFormulario();
  
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
        <div class="history-item">
          <strong>Creación del abono</strong>
    
          <div class="muted" style="margin-top:.25rem;">
            ${escapeHTML(
              formatTimestamp(
                abono.createdAt ||
                abono.fechaRegistro
              )
            )}
            ·
            ${escapeHTML(
              abono.createdByEmail ||
              'Usuario no identificado'
            )}
          </div>
    
          <div style="margin-top:.5rem;">
            Este abono no registra modificaciones posteriores.
          </div>
        </div>
      `;
    
      return;
    }

    const bloqueCreacion = `
      <div class="history-item">
        <strong>Creación del abono</strong>
    
        <div class="muted" style="margin-top:.25rem;">
          ${escapeHTML(
            formatTimestamp(
              abono.createdAt ||
              abono.fechaRegistro
            )
          )}
          ·
          ${escapeHTML(
            abono.createdByEmail ||
            'Usuario no identificado'
          )}
        </div>
    
        <div class="history-grid">
          <div>
            <span>ID registro</span>
            ${escapeHTML(
              abono.idRegistro ||
              'SIN ID'
            )}
          </div>
          
          <div>
            <span>Fecha ingreso contable</span>
            ${escapeHTML(
              abono.fechaIngresoContable ||
              '—'
            )}
          </div>
          
          <div>
            <span>Fecha pago</span>
            ${escapeHTML(
              abono.fechaPago ||
              abono.fecha ||
              '—'
            )}
          </div>
    
          <div>
            <span>Proveedor / hotel</span>
            ${escapeHTML(
              abono.proveedorNombre ||
              abono.hotelNombre ||
              '—'
            )}
          </div>
    
          <div>
            <span>Servicio</span>
            ${escapeHTML(
              abono.servicioNombre ||
              '—'
            )}
          </div>
    
          <div>
            <span>Moneda</span>
            ${escapeHTML(
              abono.moneda ||
              '—'
            )}
          </div>
    
          <div>
            <span>Monto</span>
            ${escapeHTML(
              fmtNumero(abono.monto || 0)
            )}
          </div>
    
          <div>
            <span>Forma de pago</span>
            ${escapeHTML(
              abono.formaPago ||
              '—'
            )}
          </div>
        </div>
      </div>
    `;

    contenido.innerHTML =
      bloqueCreacion +
      cambios.map(cambio => {
      const ant = cambio.datosAnteriores || {};

      return `
        <div class="history-item">
          <strong>
            Modificación posterior a la versión
            ${escapeHTML(cambio.versionAnterior || '')}
          
            ${
              cambio.tipoCambio
                ? `· ${escapeHTML(cambio.tipoCambio)}`
                : ''
            }
          </strong>

          <div class="muted" style="margin-top:.25rem;">
            Modificado el
            ${escapeHTML(
              formatTimestamp(cambio.changedAt)
            )}
          
            · por
            ${escapeHTML(
              cambio.changedByEmail ||
              'Usuario no identificado'
            )}
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
  const ano = el('filtroAno')?.value || '';
  const tipo = el('filtroTipo')?.value || '';
  const destino = el('filtroDestino')?.value || '';
  const estado = el('filtroEstado')?.value || '';
  const usuario = norm(el('filtroUsuario')?.value || '');
  const buscar = norm(el('filtroBuscar')?.value || '');

  return ABONOS.filter(abono => {
    const esArchivado =
      norm(abono.estado) === 'ARCHIVADO';

    /*
     * Vista normal: solamente abonos activos.
     * Vista archivados: solamente abonos archivados.
     */
    if (MOSTRAR_ARCHIVADOS && !esArchivado) {
      return false;
    }

    if (!MOSTRAR_ARCHIVADOS && esArchivado) {
      return false;
    }

    if (
      ano &&
      String(abono.ano) !== String(ano)
    ) {
      return false;
    }

    if (
      tipo &&
      abono.tipo !== tipo
    ) {
      return false;
    }

    if (
      destino &&
      norm(abono.destino) !== norm(destino)
    ) {
      return false;
    }

    /*
     * En la vista normal respeta el filtro de estado.
     * En archivados no hace falta, porque ya sabemos
     * que todos tienen estado ARCHIVADO.
     */
    if (
      !MOSTRAR_ARCHIVADOS &&
      estado &&
      norm(abono.estado) !== norm(estado)
    ) {
      return false;
    }

    if (
      usuario &&
      !norm(
        abono.updatedByEmail ||
        abono.createdByEmail ||
        ''
      ).includes(usuario)
    ) {
      return false;
    }

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

      if (!bolsa.includes(buscar)) {
        return false;
      }
    }

    return true;
  });
}

function aplicarLimiteAbonos(lista = []) {
  if (LIMITE_ABONOS === 'todos') {
    return lista;
  }

  const limite = Number(LIMITE_ABONOS || 10);

  return lista.slice(0, limite);
}

function renderResumen(lista = []) {
  const elementos = {
    CLP: el('sumCLP'),
    USD: el('sumUSD'),
    BRL: el('sumBRL'),
    ARS: el('sumARS')
  };

  if (
    !elementos.CLP ||
    !elementos.USD ||
    !elementos.BRL ||
    !elementos.ARS
  ) {
    return;
  }

  const totales = {
    CLP: 0,
    USD: 0,
    BRL: 0,
    ARS: 0
  };

  lista
    .filter(abono =>
      norm(abono.estado) !== 'ARCHIVADO'
    )
    .forEach(abono => {
      const moneda =
        normalizarMoneda(abono.moneda);

      totales[moneda] +=
        Number(abono.monto || 0);
    });

  elementos.CLP.textContent =
    `$${fmtNumero(totales.CLP)}`;

  elementos.USD.textContent =
    fmtNumero(totales.USD);

  elementos.BRL.textContent =
    fmtNumero(totales.BRL);

  elementos.ARS.textContent =
    fmtNumero(totales.ARS);
}

function alternarVistaArchivados() {
  MOSTRAR_ARCHIVADOS = !MOSTRAR_ARCHIVADOS;

  const boton = el('btnVerArchivados');
  const texto = el('textoBtnArchivados');
  const filtroEstado = el('filtroEstado');

  if (boton) {
    boton.classList.toggle(
      'activo',
      MOSTRAR_ARCHIVADOS
    );
  }

  if (texto) {
    texto.textContent = MOSTRAR_ARCHIVADOS
      ? 'Volver a activos'
      : 'Ver archivados';
  }

  /*
   * Al ver archivados, el filtro de estado deja
   * de ser necesario.
   */
  if (filtroEstado) {
    filtroEstado.disabled = MOSTRAR_ARCHIVADOS;

    if (MOSTRAR_ARCHIVADOS) {
      filtroEstado.value = '';
    }
  }

  LIMITE_ABONOS = 10;

  if (el('limiteAbonos')) {
    el('limiteAbonos').value = '10';
  }

  renderAbonos();
}

function formatearVersionAbono(version) {
  const numeroVersion = Math.max(
    1,
    Number(version || 1)
  );

  if (numeroVersion === 1) {
    return 'Original';
  }

  const cantidadCambios = numeroVersion - 1;

  return cantidadCambios === 1
    ? 'Modificado 1 vez'
    : `Modificado ${cantidadCambios} veces`;
}

function renderAbonos() {
  const listaFiltrada =
    abonosFiltrados();

  const listaVisible =
    aplicarLimiteAbonos(
      listaFiltrada
    );

  const tbody =
    el('tblAbonos')
      .querySelector('tbody');

  tbody.innerHTML = '';

  for (const abono of listaVisible) {
    const proveedorHotel =
      abono.tipo === 'hotel'
        ? abono.hotelNombre || ''
        : abono.proveedorNombre || '';

    const servicioAsunto = [
      abono.servicioNombre,
      abono.nota
    ]
      .filter(Boolean)
      .join(' · ');

    const registradoPor =
      abono.createdByEmail ||
      '—';
    
    const registradoEl =
      formatTimestamp(
        abono.createdAt ||
        abono.fechaRegistro
      );
    
    const editadoPor =
      abono.updatedByEmail ||
      '—';
    
    const editadoEl =
      abono.updatedAt
        ? formatTimestamp(abono.updatedAt)
        : '—';

    const archivos =
      obtenerArchivosAbono(abono);

    const archivosAgrupados =
      archivos.reduce(
        (acumulador, archivo) => {
          const tipo =
            normalizarTipoDocumento(
              archivo.tipoDocumento
            );
    
          if (!acumulador[tipo]) {
            acumulador[tipo] = [];
          }
    
          acumulador[tipo].push(
            archivo
          );
    
          return acumulador;
        },
        {}
      );
    
    const archivosHTML =
      archivos.length
        ? `
          <div class="documentos-links">
            ${
              Object.entries(
                archivosAgrupados
              )
                .map(
                  ([tipo, lista]) => `
                    <a
                      href="${escapeHTML(lista[0].url)}"
                      target="_blank"
                      rel="noopener"
                      title="${escapeHTML(
                        lista
                          .map(item => {
                            const numero =
                              item.numeroDocumento
                                ? ` N.º ${item.numeroDocumento}`
                                : ' SIN N.º';
                          
                            return `${item.nombre}${numero}`;
                          })
                          .join(' · ')
                      )}"
                    >
                      ${escapeHTML(tipo)}
                      
                      ${
                        lista[0]?.numeroDocumento
                          ? ` N.º ${escapeHTML(
                              lista[0].numeroDocumento
                            )}`
                          : ' · SIN N.º'
                      }
                      
                      ${
                        lista.length > 1
                          ? ` (+${lista.length - 1})`
                          : ''
                      }
                    </a>
                  `
                )
                .join('')
            }
          </div>
        `
        : '—';

    const estadoFactura =
      abono.estadoFactura ||
      (
        abono.facturaNoAplica
          ? 'NO_APLICA'
          : abono.pendienteFactura
            ? 'PENDIENTE'
            : 'COMPLETA'
      );
    
    let facturaHTML = `
      <span class="badge-finanzas completo">
        COMPLETA
      </span>
    `;
    
    if (estadoFactura === 'PENDIENTE') {
      facturaHTML = `
        <span class="badge-finanzas pendiente">
          PENDIENTE
        </span>
      `;
    }
    
    if (estadoFactura === 'NO_APLICA') {
      facturaHTML = `
        <span class="badge-finanzas no-solicitado">
          NO APLICA
        </span>
      `;
    }

    const estadoSolicitud =
      norm(
        abono.estadoSolicitudPago ||
        'NO_SOLICITADO'
      );

    let claseSolicitud =
      'no-solicitado';

    let textoSolicitud =
      'No solicitada';

    if (estadoSolicitud === 'SOLICITADO') {
      claseSolicitud = 'solicitado';
      textoSolicitud = 'Solicitada';
    }

    if (estadoSolicitud === 'EXPORTADO') {
      claseSolicitud = 'exportado';
      textoSolicitud = 'Exportada';
    }

    if (estadoSolicitud === 'PAGADO') {
      claseSolicitud = 'pagado';
      textoSolicitud = 'Pagada';
    }

    const tr =
      document.createElement('tr');

    tr.innerHTML = `
      <td>
        ${escapeHTML(
          abono.idRegistro ||
          'SIN ID'
        )}
      </td>
    
      <td>
        ${escapeHTML(
          abono.fechaPago ||
          abono.fecha ||
          ''
        )}
      </td>

      <td>
        ${escapeHTML(abono.tipo || '')}
      </td>

      <td>
        ${escapeHTML(proveedorHotel)}
      </td>

      <td title="${escapeHTML(servicioAsunto)}">
        ${escapeHTML(servicioAsunto || '—')}
      </td>

      <td>
        ${escapeHTML(abono.destino || '')}
      </td>

      <td>
        ${escapeHTML(abono.ano || '')}
      </td>

      <td>
        ${escapeHTML(abono.moneda || 'CLP')}
      </td>

      <td class="right mono">
        ${escapeHTML(
          fmtNumero(abono.monto || 0)
        )}
      </td>

      <td>
        ${escapeHTML(abono.formaPago || '')}
      </td>

      <td>
        ${escapeHTML(abono.referencia || '—')}
      </td>

      <td>
        ${archivosHTML}
      </td>

      <td>
        ${facturaHTML}
      </td>

      <td>
        <span class="badge-finanzas ${claseSolicitud}">
          ${textoSolicitud}
        </span>
      </td>

      <td class="email-cell">
        ${escapeHTML(registradoPor)}
      </td>
      
      <td>
        ${escapeHTML(registradoEl)}
      </td>
      
      <td class="email-cell">
        ${escapeHTML(editadoPor)}
      </td>
      
      <td>
        ${escapeHTML(editadoEl)}
      </td>

      <td>
        <span class="estado ${estadoClase(abono.estado)}">
          ${escapeHTML(
            abono.estado ||
            'REGISTRADO'
          )}
        </span>
      </td>

      <td class="right">
        ${escapeHTML(
          formatearVersionAbono(
            abono.version
          )
        )}
      </td>

      <td>
        <div class="acciones">
          <button
            class="icon-btn btn-editar"
            type="button"
            title="Editar abono"
          >
            <span class="material-symbols-outlined">
              edit
            </span>
          </button>

          <button
            class="icon-btn btn-solicitar-pago"
            type="button"
            title="Solicitar o revisar ejecución del pago"
          >
            <span class="material-symbols-outlined">
              account_balance
            </span>
          </button>

          ${
            abono.solicitudPago
              ? `
                <button
                  class="icon-btn btn-xls-pago"
                  type="button"
                  title="Descargar solicitud XLS"
                >
                  <span class="material-symbols-outlined">
                    download
                  </span>
                </button>
              `
              : ''
          }

          <button
            class="icon-btn btn-historial"
            type="button"
            title="Ver historial"
          >
            <span class="material-symbols-outlined">
              history
            </span>
          </button>

          ${
            norm(abono.estado) !== 'ARCHIVADO'
              ? `
                <button
                  class="icon-btn danger btn-archivar"
                  type="button"
                  title="Archivar"
                >
                  <span class="material-symbols-outlined">
                    archive
                  </span>
                </button>
              `
              : ''
          }
        </div>
      </td>
    `;

    tbody.appendChild(tr);

    tr.querySelector('.btn-editar')
      .onclick = () =>
        iniciarEdicion(abono);

    tr.querySelector('.btn-solicitar-pago')
      .onclick = () =>
        abrirSolicitudPago(abono);

    tr.querySelector('.btn-historial')
      .onclick = () =>
        mostrarHistorial(abono);

    const btnXls =
      tr.querySelector('.btn-xls-pago');

    if (btnXls) {
      btnXls.onclick = async () => {
        ABONO_SOLICITUD_ACTUAL = abono;
        await descargarSolicitudActual();
      };
    }

    const btnArchivar =
      tr.querySelector('.btn-archivar');

    if (btnArchivar) {
      btnArchivar.onclick = () =>
        archivarAbono(abono);
    }
  }

  el('pagInfo').textContent =
    listaVisible.length ===
    listaFiltrada.length
      ? `${listaFiltrada.length} abono(s)`
      : `Mostrando ${listaVisible.length} de ${listaFiltrada.length}`;

  renderResumen(listaFiltrada);
}

function limpiarFiltros() {
  el('filtroAno').value =
    getAnoComercialActual();

  el('filtroTipo').value = '';
  el('filtroDestino').value = '';
  el('filtroEstado').value = '';
  if (el('filtroUsuario')) el('filtroUsuario').value = '';
  el('filtroBuscar').value = '';

  LIMITE_ABONOS = 10;

  if (el('limiteAbonos')) {
    el('limiteAbonos').value = '10';
  }

  renderAbonos();
}

function exportarAbonosExcel() {
  const lista = abonosFiltrados();

  if (!lista.length) {
    alert(
      'No hay abonos para exportar con los filtros seleccionados.'
    );
    return;
  }

  if (!window.XLSX) {
    alert(
      'No se pudo cargar la herramienta de exportación Excel.'
    );
    return;
  }

  const filas = lista.map(abono => {
    const proveedorHotel =
      abono.tipo === 'hotel'
        ? abono.hotelNombre || ''
        : abono.proveedorNombre || '';

    return {
      'ID registro':
        abono.idRegistro || '',
      
      'Fecha ingreso contable':
        abono.fechaIngresoContable || '',
      
      'Fecha pago':
        abono.fechaPago ||
        abono.fecha ||
        '',

      'Tipo':
        abono.tipo || '',

      'Proveedor / Hotel':
        proveedorHotel,

      'Servicio / Asunto':
        abono.servicioNombre || '',

      'Nota':
        abono.nota || '',

      'Destino':
        abono.destino || '',

      'Año':
        abono.ano || '',

      'Moneda':
        abono.moneda || 'CLP',

      'Monto':
        Number(abono.monto || 0),

      'Forma de pago':
        abono.formaPago || '',

      'Referencia':
        abono.referencia || '',

      'Cantidad de documentos':
        obtenerArchivosAbono(abono).length,
      
      'Documentos':
        obtenerArchivosAbono(abono)
          .map(archivo => archivo.url)
          .join(' | '),
      
      'Números de documentos':
        obtenerArchivosAbono(abono)
          .map(archivo => {
            const tipo =
              normalizarTipoDocumento(
                archivo.tipoDocumento
              );
      
            const numero =
              archivo.numeroDocumento ||
              'SIN N.º';
      
            return `${tipo}: ${numero}`;
          })
          .join(' | '),
      
      'Estado factura':
        abono.estadoFactura ||
        (
          abono.facturaNoAplica
            ? 'NO_APLICA'
            : abono.pendienteFactura
              ? 'PENDIENTE'
              : 'COMPLETA'
        ),
      
      'Estado solicitud de pago':
        abono.estadoSolicitudPago ||
        'NO_SOLICITADO',

      'Registrado por':
        abono.createdByEmail || '',

      'Fecha de registro':
        formatTimestamp(
          abono.createdAt ||
          abono.fechaRegistro
        ),

      'Última modificación por':
        abono.updatedByEmail || '',

      'Última modificación el':
        formatTimestamp(
          abono.updatedAt
        ),

      'Estado':
        abono.estado || 'REGISTRADO',

      'Versión':
        Number(abono.version || 1)
    };
  });

  const hoja =
    window.XLSX.utils.json_to_sheet(filas);

  const libro =
    window.XLSX.utils.book_new();

  window.XLSX.utils.book_append_sheet(
    libro,
    hoja,
    'Abonos'
  );

  const ano =
    el('filtroAno').value ||
    'todos';

  const tipo =
    el('filtroTipo').value ||
    'todos';

  const fecha =
    new Date()
      .toISOString()
      .slice(0, 10);

  window.XLSX.writeFile(
    libro,
    `abonos_${ano}_${tipo}_${fecha}.xlsx`
  );
}

async function mostrarHistorialMovil() {
  try {
    setEstadoFormulario(
      'Cargando historial...'
    );

    await cargarAbonos();

    poblarFiltrosGenerales();

    if (el('filtroAno')) {
      el('filtroAno').value =
        getAnoComercialActual();
    }

    LIMITE_ABONOS = 10;

    if (el('limiteAbonos')) {
      el('limiteAbonos').value = '10';
    }

    renderAbonos();

    /*
     * Salimos visualmente del formulario móvil
     * y mostramos la vista de historial.
     */
    document.documentElement.classList.remove(
      'abonos-mobile'
    );

    document.documentElement.classList.add(
      'abonos-mobile-historial'
    );

    el('abonoModal').classList.remove('open');
    el('abonosRoot').style.display = 'block';

    document.body.style.overflow = '';

    setEstadoFormulario('');
  } catch (error) {
    console.error(
      'No se pudo cargar el historial móvil:',
      error
    );

    alert(
      `No se pudo cargar el historial: ${
        error.message || error
      }`
    );
  }
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

  /* AGREGAR ABONO EN ESCRITORIO */
  
  if (!ES_VISTA_MOVIL) {
    el('btnAgregarAbono')?.addEventListener(
      'click',
      () => {
        limpiarFormulario();
        abrirModalAbono();
  
        setTimeout(() => {
          el('abAno')?.focus();
        }, 50);
      }
    );
  
    el('btnCerrarModalAbono')?.addEventListener(
      'click',
      () => {
        cerrarModalAbono({
          limpiar: true,
          forzar: true
        });
      }
    );
  
    el('abonoModal')?.addEventListener(
      'click',
      event => {
        if (
          event.target ===
          el('abonoModal')
        ) {
          cerrarModalAbono({
            limpiar: true,
            forzar: true
          });
        }
      }
    );
  }
  
  /* GUARDAR */
  
  el('btnGuardarAbono')
    ?.addEventListener(
      'click',
      () => {
        guardarAbono({
          solicitarDespues: false
        });
      }
    );
  
  el('btnGuardarYSolicitar')
    ?.addEventListener(
      'click',
      () => {
        guardarAbono({
          solicitarDespues: true
        });
      }
    );

  el('abPendienteFactura')
    ?.addEventListener(
      'change',
      event => {
        if (event.target.checked) {
          el('abFacturaNoAplica').checked =
            false;
        }
      }
    );
  
  el('abFacturaNoAplica')
    ?.addEventListener(
      'change',
      event => {
        if (event.target.checked) {
          el('abPendienteFactura').checked =
            false;
        }
      }
    );
  
  el('abComprobantes')
    ?.addEventListener(
      'change',
      () => {
        pintarArchivosFormulario();
        actualizarEstadoFacturaPorDocumentos();
      }
    );

  el('btnMarcarPagada')
    ?.addEventListener(
      'click',
      abrirConfirmarPago
    );
  
  el('btnCerrarConfirmarPago')
    ?.addEventListener(
      'click',
      cerrarConfirmarPago
    );
  
  el('btnConfirmarPagoEjecutado')
    ?.addEventListener(
      'click',
      confirmarPagoEjecutado
    );
  
  el('confirmarPagoModal')
    ?.addEventListener(
      'click',
      event => {
        if (
          event.target ===
          el('confirmarPagoModal')
        ) {
          cerrarConfirmarPago();
        }
      }
    );
  
  el('btnCerrarSolicitudPago')
    ?.addEventListener(
      'click',
      cerrarSolicitudPago
    );
  
  el('btnGuardarSolicitudPago')
    ?.addEventListener(
      'click',
      guardarSolicitudPago
    );
  
  el('btnDescargarSolicitud')
    ?.addEventListener(
      'click',
      descargarSolicitudActual
    );
  
  el('solicitudPagoModal')
    ?.addEventListener(
      'click',
      event => {
        if (
          event.target ===
          el('solicitudPagoModal')
        ) {
          cerrarSolicitudPago();
        }
      }
    );
  
  /* CANCELAR EDICIÓN */
  
  el('btnCancelarEdicion')?.addEventListener(
    'click',
    () => {
      if (ES_VISTA_MOVIL) {
        limpiarFormulario();
        return;
      }
  
      cerrarModalAbono({
        limpiar: true,
        forzar: true
      });
    }
  );
  
  /* CONTROLES SOLO DE ESCRITORIO */
  
  if (!ES_VISTA_MOVIL) {
    el('btnAplicarFiltros')?.addEventListener(
      'click',
      renderAbonos
    );
  
    el('btnLimpiarFiltros')?.addEventListener(
      'click',
      limpiarFiltros
    );
  
    el('filtroBuscar')?.addEventListener(
      'input',
      renderAbonos
    );
  
    el('filtroUsuario')?.addEventListener(
      'input',
      renderAbonos
    );
  
    el('limiteAbonos')?.addEventListener(
      'change',
      event => {
        LIMITE_ABONOS =
          event.target.value === 'todos'
            ? 'todos'
            : Number(event.target.value);
  
        renderAbonos();
      }
    );
  
    el('btnExportarExcel')?.addEventListener(
      'click',
      exportarAbonosExcel
    );

    el('btnExportarSolicitudes')
      ?.addEventListener(
        'click',
        exportarSolicitudesPago
      );

    el('btnVerArchivados')?.addEventListener(
      'click',
      alternarVistaArchivados
    );
  }
  
  /* CONFIRMACIÓN MÓVIL */
  
  el('btnAgregarOtroAbono')?.addEventListener(
    'click',
    () => {
      cerrarConfirmacionAbono();
      limpiarFormulario();
      abrirModalAbono();
    }
  );
  
  el('btnCerrarConfirmacion')?.addEventListener(
    'click',
    async () => {
      cerrarConfirmacionAbono();
  
      /*
       * Recién cuando el usuario pide ver el historial
       * cargamos los abonos.
       */
      if (ES_VISTA_MOVIL) {
        await mostrarHistorialMovil();
      }
    }
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
        el('confirmarPagoModal')
          ?.classList
          .contains('open')
      ) {
        cerrarConfirmarPago();
        return;
      }

      if (
        el('solicitudPagoModal')
          ?.classList
          .contains('open')
      ) {
        cerrarSolicitudPago();
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
        !ES_VISTA_MOVIL &&
        el('abonoModal')
          .classList.contains('open')
      ) {
        cerrarModalAbono({
          limpiar: true,
          forzar: true
        });
      }
    }
  );
}

async function cargarCatalogosFormulario() {
  await cargarGrupos();

  await Promise.all([
    cargarServicios(),
    cargarHoteles()
  ]);

  poblarAnos();

  el('abTipoActividad').checked = true;
  el('abTipoHotel').checked = false;
  el('abTipoOtro').checked = false;

  poblarDestinosFormulario({
    conservarDestino: false,
    conservarSeleccion: false
  });

  actualizarVistaTipo();
}

async function inicializarEscritorio() {
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

    LIMITE_ABONOS = 10;

    if (el('limiteAbonos')) {
      el('limiteAbonos').value = '10';
    }

    renderAbonos();

    setEstadoFormulario('');

    el('abonoModal')
      .classList.remove('open');

    document.body.style.overflow = '';

    console.log(
      '✅ Abonos escritorio inicializado'
    );
  } catch (error) {
    console.error(
      'Error inicializando escritorio:',
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

async function inicializarMovil() {
  el('abFechaPago').value = nowISODate();

  /*
   * El formulario ya está visible por CSS desde antes
   * de cargar Firebase.
   */
  el('abonoModal').classList.add('open');

  if (el('abonoModalTitulo')) {
    el('abonoModalTitulo').textContent =
      'Registrar abono';
  }

  setEstadoFormulario(
    'Cargando proveedores y servicios...'
  );

  try {
    /*
     * En móvil NO cargamos:
     * - AbonosOperaciones
     * - Historial
     * - Tabla
     * - Resumen
     * - Filtros
     */
    await cargarCatalogosFormulario();

    conectarEventos();

    limpiarFormulario();

    el('abonoModal').classList.add('open');
    document.body.style.overflow = '';

    setEstadoFormulario('');

    console.log(
      '✅ Abonos móvil inicializado'
    );
  } catch (error) {
    console.error(
      'Error inicializando móvil:',
      error
    );

    setEstadoFormulario(
      `No se pudieron cargar los datos: ${
        error.message || error
      }`,
      true
    );
  }
}

window.migrarAbonosAntiguos = async function ({
  confirmar = false
} = {}) {
  if (!confirmar) {
    console.warn(`
Para ejecutar realmente la migración usa:

migrarAbonosAntiguos({ confirmar: true })
    `);

    return;
  }

  try {
    const email =
      (auth.currentUser?.email || '')
        .toLowerCase();

    const snap = await getDocs(
      collection(db, RUTA_ABONOS)
    );

    let revisados = 0;
    let actualizados = 0;
    let sinCambios = 0;
    let errores = 0;

    console.log(
      `🔎 Revisando ${snap.size} abono(s)...`
    );

    for (const documento of snap.docs) {
      revisados++;

      const abono = documento.data() || {};
      const cambios = {};

      if (!Array.isArray(abono.archivos)) {
        cambios.archivos =
          abono.comprobanteURL
            ? [
                {
                  nombre:
                    'Comprobante anterior',

                  url:
                    abono.comprobanteURL,

                  tipo:
                    'COMPROBANTE',

                  legado:
                    true
                }
              ]
            : [];
      }

      if (
        typeof abono.pendienteFactura !==
        'boolean'
      ) {
        cambios.pendienteFactura = false;
      }

      if (!abono.estadoFactura) {
        cambios.estadoFactura =
          abono.facturaNoAplica
            ? 'NO_APLICA'
            : abono.pendienteFactura
              ? 'PENDIENTE'
              : 'COMPLETA';
      }
      
      if (
        typeof abono.facturaNoAplica !==
        'boolean'
      ) {
        cambios.facturaNoAplica =
          false;
      }

      if (!abono.estadoSolicitudPago) {
        cambios.estadoSolicitudPago =
          'NO_SOLICITADO';
      }

      if (
        abono.solicitudPago === undefined
      ) {
        cambios.solicitudPago = null;
      }

      if (!Object.keys(cambios).length) {
        sinCambios++;

        console.log(
          `✓ ${documento.id}: sin cambios`
        );

        continue;
      }

      try {
        await updateDoc(
          doc(
            db,
            RUTA_ABONOS,
            documento.id
          ),
          {
            ...cambios,

            migradoNuevaEstructuraAt:
              serverTimestamp(),

            migradoNuevaEstructuraByEmail:
              email
          }
        );

        actualizados++;

        console.log(
          `✅ ${documento.id}`,
          cambios
        );

      } catch (error) {
        errores++;

        console.error(
          `❌ ${documento.id}`,
          error
        );
      }
    }

    console.table({
      revisados,
      actualizados,
      sinCambios,
      errores
    });

    await cargarAbonos();
    renderAbonos();

    alert(
      `Migración terminada.\n\n` +
      `Revisados: ${revisados}\n` +
      `Actualizados: ${actualizados}\n` +
      `Sin cambios: ${sinCambios}\n` +
      `Errores: ${errores}`
    );

  } catch (error) {
    console.error(
      'Error general migrando abonos:',
      error
    );

    alert(
      `No se pudo ejecutar la migración: ${
        error.message || error
      }`
    );
  }
};

window.repararAuditoriaAbonos = async function ({
  confirmar = false
} = {}) {
  if (!confirmar) {
    console.warn(`
Esta función revisará todos los abonos y completará
los campos de auditoría que puedan recuperarse.

Para ejecutarla realmente usa:

repararAuditoriaAbonos({ confirmar: true })
    `);

    return;
  }

  try {
    const snap = await getDocs(
      collection(db, RUTA_ABONOS)
    );

    let revisados = 0;
    let actualizados = 0;
    let sinCambios = 0;
    let noIdentificados = 0;
    let errores = 0;

    console.log(
      `🔎 Revisando ${snap.size} abono(s)...`
    );

    for (const documento of snap.docs) {
      revisados++;

      try {
        const abono =
          documento.data() || {};

        const cambios = {};

        /*
         * Fecha original.
         */
        if (
          !abono.createdAt &&
          abono.fechaRegistro
        ) {
          cambios.createdAt =
            abono.fechaRegistro;
        }

        /*
         * Recuperar creador desde campos alternativos,
         * solamente si existen realmente.
         */
        if (!abono.createdByEmail) {
          const creadorAlternativo =
            abono.registradoPor ||
            abono.usuarioRegistro ||
            abono.createdBy ||
            abono.emailUsuario ||
            '';

          if (creadorAlternativo) {
            cambios.createdByEmail =
              String(
                creadorAlternativo
              ).toLowerCase();
          } else {
            noIdentificados++;
          }
        }

        /*
         * Revisar historial para recuperar
         * la última modificación.
         */
        const snapHistorial =
          await getDocs(
            collection(
              db,
              RUTA_ABONOS,
              documento.id,
              'Historial'
            )
          );

        const historial =
          snapHistorial.docs
            .map(d => d.data() || {})
            .filter(item => item.changedAt)
            .sort((a, b) => {
              const fa =
                a.changedAt
                  ?.toMillis?.() ||
                0;

              const fb =
                b.changedAt
                  ?.toMillis?.() ||
                0;

              return fb - fa;
            });

        const ultimoCambio =
          historial[0] || null;

        if (
          ultimoCambio &&
          !abono.updatedAt
        ) {
          cambios.updatedAt =
            ultimoCambio.changedAt;
        }

        if (
          ultimoCambio &&
          !abono.updatedByEmail &&
          ultimoCambio.changedByEmail
        ) {
          cambios.updatedByEmail =
            String(
              ultimoCambio.changedByEmail
            ).toLowerCase();
        }

        /*
         * Si nunca fue editado, se dejan explícitamente
         * vacíos los datos de edición.
         */
        if (
          !ultimoCambio &&
          abono.updatedByEmail === undefined
        ) {
          cambios.updatedByEmail = '';
        }

        if (
          !ultimoCambio &&
          abono.updatedAt === undefined
        ) {
          cambios.updatedAt = null;
        }

        if (!Object.keys(cambios).length) {
          sinCambios++;

          console.log(
            `✓ ${documento.id}: sin cambios`
          );

          continue;
        }

        await updateDoc(
          doc(
            db,
            RUTA_ABONOS,
            documento.id
          ),
          {
            ...cambios,

            auditoriaReparadaAt:
              serverTimestamp(),

            auditoriaReparadaByEmail:
              (
                auth.currentUser?.email ||
                ''
              ).toLowerCase()
          }
        );

        actualizados++;

        console.log(
          `✅ ${documento.id}`,
          cambios
        );

      } catch (error) {
        errores++;

        console.error(
          `❌ Error en ${documento.id}`,
          error
        );
      }
    }

    console.table({
      revisados,
      actualizados,
      sinCambios,
      noIdentificados,
      errores
    });

    await cargarAbonos();
    renderAbonos();

    alert(
      `Reparación terminada.\n\n` +
      `Revisados: ${revisados}\n` +
      `Actualizados: ${actualizados}\n` +
      `Sin cambios: ${sinCambios}\n` +
      `Creadores no identificables: ${noIdentificados}\n` +
      `Errores: ${errores}`
    );

  } catch (error) {
    console.error(
      'Error general reparando auditoría:',
      error
    );

    alert(
      `No se pudo ejecutar la reparación: ${
        error.message || error
      }`
    );
  }
};

window.migrarIdsRegistroAbonos = async function ({
  confirmar = false
} = {}) {
  if (!confirmar) {
    console.warn(`
Esta función asignará ID registro a los abonos antiguos
que todavía no lo tengan.

Para ejecutarla realmente usa:

migrarIdsRegistroAbonos({ confirmar: true })
    `);

    return;
  }

  const obtenerFechaDocumento = abono => {
    const valor =
      abono.createdAt ||
      abono.fechaRegistro ||
      null;

    if (!valor) {
      return null;
    }

    try {
      const fecha =
        typeof valor.toDate === 'function'
          ? valor.toDate()
          : new Date(valor);

      if (
        Number.isNaN(fecha.getTime())
      ) {
        return null;
      }

      return fecha;

    } catch (_) {
      return null;
    }
  };

  try {
    const email =
      (
        auth.currentUser?.email ||
        ''
      ).toLowerCase();

    const snap =
      await getDocs(
        collection(
          db,
          RUTA_ABONOS
        )
      );

    const documentos =
      snap.docs
        .map(documento => ({
          ref: documento.ref,
          id: documento.id,
          ...documento.data()
        }))
        .sort((a, b) => {
          const fechaA =
            obtenerFechaDocumento(a)
              ?.getTime() || 0;

          const fechaB =
            obtenerFechaDocumento(b)
              ?.getTime() || 0;

          return fechaA - fechaB;
        });

    const maximosPorFecha =
      new Map();

    /*
     * Primero detectamos IDs que ya existen.
     */
    for (const abono of documentos) {
      const coincidencia =
        String(
          abono.idRegistro || ''
        ).match(
          /^RT(\d+)-(\d{6})$/
        );

      if (!coincidencia) {
        continue;
      }

      const numero =
        Number(coincidencia[1]);

      const codigoFecha =
        coincidencia[2];

      maximosPorFecha.set(
        codigoFecha,
        Math.max(
          maximosPorFecha.get(
            codigoFecha
          ) || 0,
          numero
        )
      );
    }

    let revisados = 0;
    let actualizados = 0;
    let sinFecha = 0;
    let yaTenianId = 0;
    let errores = 0;

    for (const abono of documentos) {
      revisados++;

      if (abono.idRegistro) {
        yaTenianId++;
        continue;
      }

      const fecha =
        obtenerFechaDocumento(abono);

      if (!fecha) {
        sinFecha++;

        console.warn(
          `⚠️ ${abono.id}: no tiene fecha recuperable`
        );

        continue;
      }

      const partes =
        obtenerFechaLocalPartes(fecha);

      const ultimo =
        maximosPorFecha.get(
          partes.codigoAAMMDD
        ) || 0;

      const correlativo =
        ultimo + 1;

      const idRegistro =
        `RT${String(correlativo).padStart(3, '0')}-${partes.codigoAAMMDD}`;

      try {
        await updateDoc(
          abono.ref,
          {
            idRegistro,

            correlativoRegistro:
              correlativo,

            fechaIngresoContable:
              partes.fechaISO,

            fechaIngresoContableCodigo:
              partes.codigoAAMMDD,

            idRegistroMigradoAt:
              serverTimestamp(),

            idRegistroMigradoByEmail:
              email
          }
        );

        maximosPorFecha.set(
          partes.codigoAAMMDD,
          correlativo
        );

        actualizados++;

        console.log(
          `✅ ${abono.id} → ${idRegistro}`
        );

      } catch (error) {
        errores++;

        console.error(
          `❌ ${abono.id}`,
          error
        );
      }
    }

    /*
     * Dejamos sincronizado el contador de cada fecha
     * para evitar que un nuevo abono repita un ID.
     */
    for (
      const [
        codigoFecha,
        ultimoNumero
      ]
      of maximosPorFecha.entries()
    ) {
      const ano =
        Number(
          `20${codigoFecha.slice(0, 2)}`
        );

      const mes =
        codigoFecha.slice(2, 4);

      const dia =
        codigoFecha.slice(4, 6);

      await setDoc(
        doc(
          db,
          RUTA_CONTADORES_ABONOS,
          codigoFecha
        ),
        {
          codigoFecha,

          fechaIngresoContable:
            `${ano}-${mes}-${dia}`,

          ultimoNumero,

          updatedAt:
            serverTimestamp(),

          updatedByEmail:
            email
        },
        {
          merge: true
        }
      );
    }

    console.table({
      revisados,
      actualizados,
      yaTenianId,
      sinFecha,
      errores
    });

    await cargarAbonos();
    renderAbonos();

    alert(
      `Migración de ID terminada.\n\n` +
      `Revisados: ${revisados}\n` +
      `Actualizados: ${actualizados}\n` +
      `Ya tenían ID: ${yaTenianId}\n` +
      `Sin fecha recuperable: ${sinFecha}\n` +
      `Errores: ${errores}`
    );

  } catch (error) {
    console.error(
      'Error migrando ID registro:',
      error
    );

    alert(
      `No se pudo ejecutar la migración: ${
        error.message || error
      }`
    );
  }
};

async function inicializar() {
  if (ES_VISTA_MOVIL) {
    await inicializarMovil();
    return;
  }

  await inicializarEscritorio();
}

onAuthStateChanged(auth, user => {
  if (!user) {
    window.location.href = 'login.html';
    return;
  }

  inicializar();
});
