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

const el = id => document.getElementById(id);

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
    .map(ano => `<option value="${escapeHTML(ano)}">${escapeHTML(ano)}</option>`)
    .join('');

  const anoActual = String(new Date().getFullYear());
  el('abAno').value = anos.includes(anoActual) ? anoActual : (anos[0] || '');

  el('filtroAno').innerHTML = `
    <option value="">Todos los años</option>
    ${anos.map(ano => `<option value="${escapeHTML(ano)}">${escapeHTML(ano)}</option>`).join('')}
  `;
}

function obtenerDestinosFormulario() {
  const tipo = el('abTipo').value;
  const ano = el('abAno').value;
  const destinos = new Set();

  if (tipo === 'actividad') {
    SERVICIOS
      .filter(s => String(s.ano) === String(ano))
      .forEach(s => destinos.add(getDestinoServicio(s)));
  } else {
    construirCatalogoHoteles()
      .filter(h => String(h.ano) === String(ano))
      .forEach(h => destinos.add(h.destino));
  }

  return [...destinos]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'es'));
}

function poblarDestinosFormulario() {
  const valorPrevio = el('abDestino').value;
  const destinos = obtenerDestinosFormulario();

  el('abDestino').innerHTML = destinos
    .map(destino => `<option value="${escapeHTML(destino)}">${escapeHTML(destino)}</option>`)
    .join('');

  if (destinos.includes(valorPrevio)) {
    el('abDestino').value = valorPrevio;
  }

  poblarProveedoresFormulario();
}

function obtenerProveedoresFormulario() {
  const tipo = el('abTipo').value;
  const ano = el('abAno').value;
  const destino = el('abDestino').value;

  if (tipo === 'actividad') {
    const mapa = new Map();

    SERVICIOS
      .filter(s =>
        String(s.ano) === String(ano) &&
        norm(getDestinoServicio(s)) === norm(destino)
      )
      .forEach(s => {
        const nombre = getNombreProveedor(s);
        mapa.set(slug(nombre), {
          id: slug(nombre),
          nombre
        });
      });

    return [...mapa.values()].sort((a, b) =>
      a.nombre.localeCompare(b.nombre, 'es')
    );
  }

  return construirCatalogoHoteles()
    .filter(h =>
      String(h.ano) === String(ano) &&
      norm(h.destino) === norm(destino)
    )
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
    .map(h => ({
      id: h.hotelKey,
      nombre: h.nombre,
      hotelId: h.hotelId,
      moneda: h.moneda
    }));
}

function poblarProveedoresFormulario() {
  const valorPrevio = el('abProveedor').value;
  const opciones = obtenerProveedoresFormulario();

  el('abProveedor').innerHTML = opciones
    .map(op => `<option value="${escapeHTML(op.id)}">${escapeHTML(op.nombre)}</option>`)
    .join('');

  if (opciones.some(op => op.id === valorPrevio)) {
    el('abProveedor').value = valorPrevio;
  }

  poblarServiciosFormulario();
  sugerirMoneda();
}

function obtenerServiciosFormulario() {
  if (el('abTipo').value !== 'actividad') return [];

  const ano = el('abAno').value;
  const destino = el('abDestino').value;
  const proveedorSlug = el('abProveedor').value;

  return SERVICIOS
    .filter(s =>
      String(s.ano) === String(ano) &&
      norm(getDestinoServicio(s)) === norm(destino) &&
      slug(getNombreProveedor(s)) === proveedorSlug
    )
    .sort((a, b) =>
      getNombreServicio(a).localeCompare(getNombreServicio(b), 'es')
    );
}

function poblarServiciosFormulario() {
  const esActividad = el('abTipo').value === 'actividad';
  el('servicioWrap').classList.toggle('hidden', !esActividad);
  el('abProveedorLabel').textContent = esActividad ? 'Proveedor' : 'Hotel';

  if (!esActividad) {
    el('abServicio').innerHTML = '';
    return;
  }

  const valorPrevio = el('abServicio').value;
  const servicios = obtenerServiciosFormulario();

  el('abServicio').innerHTML = servicios
    .map(s => `
      <option value="${escapeHTML(s.id)}">
        ${escapeHTML(getNombreServicio(s))}
      </option>
    `)
    .join('');

  if (servicios.some(s => s.id === valorPrevio)) {
    el('abServicio').value = valorPrevio;
  }

  sugerirMoneda();
}

function sugerirMoneda() {
  const tipo = el('abTipo').value;

  if (tipo === 'actividad') {
    const servicio = obtenerServiciosFormulario()
      .find(s => s.id === el('abServicio').value);

    if (servicio) {
      el('abMoneda').value = normalizarMoneda(
        servicio.moneda ||
        servicio.MONEDA ||
        'CLP'
      );
    }

    return;
  }

  const hotel = construirCatalogoHoteles().find(h =>
    String(h.ano) === String(el('abAno').value) &&
    norm(h.destino) === norm(el('abDestino').value) &&
    h.hotelKey === el('abProveedor').value
  );

  if (hotel) {
    el('abMoneda').value = normalizarMoneda(hotel.moneda || 'CLP');
  }
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
  const tipo = el('abTipo').value;
  const ano = el('abAno').value;
  const destino = el('abDestino').value;
  const proveedor = el('abProveedor').value;
  const fechaPago = el('abFechaPago').value;
  const moneda = el('abMoneda').value;
  const monto = Number(el('abMonto').value || 0);
  const formaPago = el('abFormaPago').value;

  if (!tipo) return 'Debe indicar el tipo de abono.';
  if (!ano) return 'Debe seleccionar el año.';
  if (!destino) return 'Debe seleccionar el destino.';
  if (!proveedor) return tipo === 'actividad'
    ? 'Debe seleccionar el proveedor.'
    : 'Debe seleccionar el hotel.';

  if (tipo === 'actividad' && !el('abServicio').value) {
    return 'Debe seleccionar el servicio o actividad.';
  }

  if (!fechaPago) return 'Debe indicar la fecha en que se realizó el pago.';
  if (!MONEDAS.includes(moneda)) return 'La moneda seleccionada no es válida.';
  if (!(monto > 0)) return 'El monto debe ser mayor que cero.';
  if (!formaPago) return 'Debe indicar la forma de pago.';

  if (abonoEditandoId && !el('abMotivoCambio').value.trim()) {
    return 'Debe indicar el motivo del cambio.';
  }

  return '';
}

function obtenerDatosFormulario() {
  const tipo = el('abTipo').value;
  const ano = el('abAno').value;
  const destino = el('abDestino').value;
  const moneda = normalizarMoneda(el('abMoneda').value);

  if (tipo === 'actividad') {
    const servicio = obtenerServiciosFormulario()
      .find(s => s.id === el('abServicio').value);

    if (!servicio) {
      throw new Error('No se encontró el servicio seleccionado.');
    }

    return {
      tipo,
      ano,
      destino,
      proveedorId: slug(getNombreProveedor(servicio)),
      proveedorNombre: getNombreProveedor(servicio),
      servicioId: servicio.id,
      servicioNombre: getNombreServicio(servicio),
      hotelId: '',
      hotelKey: '',
      hotelNombre: '',
      fechaPago: el('abFechaPago').value,
      moneda,
      monto: Number(el('abMonto').value || 0),
      formaPago: el('abFormaPago').value,
      referencia: el('abReferencia').value.trim(),
      nota: el('abNota').value.trim(),
      estado: abonoEditandoId ? 'EDITADO' : 'REGISTRADO',
      rutaDestino: `ServiciosPorAno/${ano}/Destinos/${destino}/Listado/${servicio.id}/Abonos`
    };
  }

  const hotel = construirCatalogoHoteles().find(h =>
    String(h.ano) === String(ano) &&
    norm(h.destino) === norm(destino) &&
    h.hotelKey === el('abProveedor').value
  );

  if (!hotel) {
    throw new Error('No se encontró el hotel seleccionado.');
  }

  return {
    tipo,
    ano,
    destino,
    proveedorId: '',
    proveedorNombre: '',
    servicioId: '',
    servicioNombre: 'ALOJAMIENTO',
    hotelId: hotel.hotelId || '',
    hotelKey: hotel.hotelKey,
    hotelNombre: hotel.nombre,
    fechaPago: el('abFechaPago').value,
    moneda,
    monto: Number(el('abMonto').value || 0),
    formaPago: el('abFormaPago').value,
    referencia: el('abReferencia').value.trim(),
    nota: el('abNota').value.trim(),
    estado: abonoEditandoId ? 'EDITADO' : 'REGISTRADO',
    rutaDestino: `FinanzasHotelesAbonos/${hotelFinKey({
      ano,
      destino,
      hotelKey: hotel.hotelKey
    })}/Abonos`
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

async function guardarEspejo(datos, abonoId, comprobanteURL, email, esEdicion, version) {
  const refEspejo = doc(db, `${datos.rutaDestino}/${abonoId}`);
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

  await setDoc(refEspejo, espejo, { merge: true });
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

  el('formTitulo').textContent = 'Registrar abono';
  el('btnGuardarAbono').innerHTML = `
    <span class="material-symbols-outlined">save</span>
    Guardar abono
  `;

  el('btnCancelarEdicion').classList.add('hidden');
  el('motivoCambioWrap').classList.add('hidden');

  el('abFechaPago').value = nowISODate();
  el('abMonto').value = '';
  el('abFormaPago').value = 'transferencia';
  el('abReferencia').value = '';
  el('abNota').value = '';
  el('abMotivoCambio').value = '';
  el('abComprobante').value = '';

  setEstadoFormulario('');
  sugerirMoneda();
}

function iniciarEdicion(abono) {
  abonoEditandoId = abono.id;
  comprobanteActualURL = abono.comprobanteURL || '';

  el('formTitulo').textContent = `Editar abono — versión ${Number(abono.version || 1)}`;
  el('btnGuardarAbono').innerHTML = `
    <span class="material-symbols-outlined">save_as</span>
    Guardar cambios
  `;

  el('btnCancelarEdicion').classList.remove('hidden');
  el('motivoCambioWrap').classList.remove('hidden');

  el('abTipo').value = abono.tipo || 'actividad';
  poblarAnos();

  if ([...el('abAno').options].some(o => o.value === String(abono.ano))) {
    el('abAno').value = String(abono.ano);
  }

  poblarDestinosFormulario();

  if ([...el('abDestino').options].some(o => norm(o.value) === norm(abono.destino))) {
    el('abDestino').value = [...el('abDestino').options]
      .find(o => norm(o.value) === norm(abono.destino)).value;
  }

  poblarProveedoresFormulario();

  const proveedorValor = abono.tipo === 'actividad'
    ? slug(abono.proveedorNombre)
    : abono.hotelKey;

  if ([...el('abProveedor').options].some(o => o.value === proveedorValor)) {
    el('abProveedor').value = proveedorValor;
  }

  poblarServiciosFormulario();

  if (abono.tipo === 'actividad' &&
      [...el('abServicio').options].some(o => o.value === abono.servicioId)) {
    el('abServicio').value = abono.servicioId;
  }

  el('abFechaPago').value = abono.fechaPago || abono.fecha || nowISODate();
  el('abMoneda').value = normalizarMoneda(abono.moneda || 'CLP');
  el('abMonto').value = Number(abono.monto || 0);
  el('abFormaPago').value = abono.formaPago || 'transferencia';
  el('abReferencia').value = abono.referencia || '';
  el('abNota').value = abono.nota || '';
  el('abMotivoCambio').value = '';
  el('abComprobante').value = '';

  window.scrollTo({ top: 0, behavior: 'smooth' });
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
    const proveedorHotel = abono.tipo === 'hotel'
      ? abono.hotelNombre
      : abono.proveedorNombre;

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
  el('abTipo').addEventListener('change', poblarDestinosFormulario);
  el('abAno').addEventListener('change', poblarDestinosFormulario);
  el('abDestino').addEventListener('change', poblarProveedoresFormulario);
  el('abProveedor').addEventListener('change', poblarServiciosFormulario);
  el('abServicio').addEventListener('change', sugerirMoneda);

  el('btnGuardarAbono').addEventListener('click', guardarAbono);
  el('btnCancelarEdicion').addEventListener('click', limpiarFormulario);

  el('btnAplicarFiltros').addEventListener('click', renderAbonos);
  el('btnLimpiarFiltros').addEventListener('click', limpiarFiltros);

  el('filtroBuscar').addEventListener('input', renderAbonos);
  el('filtroUsuario').addEventListener('input', renderAbonos);

  el('btnCerrarHistorial').addEventListener('click', () => {
    el('historialModal').classList.remove('open');
  });

  el('historialModal').addEventListener('click', event => {
    if (event.target === el('historialModal')) {
      el('historialModal').classList.remove('open');
    }
  });
}

async function inicializar() {
  el('abFechaPago').value = nowISODate();
  setEstadoFormulario('Cargando datos del sistema...');

  try {
    await cargarGrupos();

    await Promise.all([
      cargarServicios(),
      cargarHoteles(),
      cargarAbonos()
    ]);

    poblarAnos();
    poblarDestinosFormulario();
    poblarFiltrosGenerales();
    conectarEventos();
    renderAbonos();

    setEstadoFormulario('');
    console.log('✅ Página de abonos inicializada');
  } catch (error) {
    console.error('Error inicializando abonos:', error);
    setEstadoFormulario(
      `No se pudo cargar la página: ${error.message || error}`,
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
