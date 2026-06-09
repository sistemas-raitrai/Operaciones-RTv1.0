import { app, db } from './firebase-init.js';
import {
  collection, getDocs, doc, getDoc, updateDoc, addDoc, query, orderBy, onSnapshot
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';

const auth = getAuth(app);
let dtHist = null;
let editMode = false;
let unsubscribeGruposCalendario = null;
let refrescandoCalendario = false;

function getAnoComercialActual() {
  const hoy = new Date();
  const mes = hoy.getMonth(); // enero=0, febrero=1, marzo=2

  // Enero y febrero pertenecen al año comercial anterior
  if (mes < 2) {
    return hoy.getFullYear() - 1;
  }

  return hoy.getFullYear();
}

const ANO_COMERCIAL_ACTUAL = String(getAnoComercialActual());

// ======================================================
// Barra de carga visual (igual lógica grupos.js)
// ======================================================
function setCarga(porcentaje, titulo, detalle = '') {
  const box = document.getElementById('loadBox');
  const bar = document.getElementById('loadProgress');
  const title = document.getElementById('loadTitle');
  const detail = document.getElementById('loadDetail');

  if (!box || !bar || !title || !detail) return;

  box.classList.remove('ok', 'error');
  box.style.display = 'block';

  bar.style.width = `${Math.max(0, Math.min(100, porcentaje))}%`;
  title.textContent = titulo;
  detail.textContent = detalle;
}

function setCargaOk(detalle = 'Datos cargados correctamente.') {
  const box = document.getElementById('loadBox');
  const bar = document.getElementById('loadProgress');
  const title = document.getElementById('loadTitle');
  const detail = document.getElementById('loadDetail');

  if (!box || !bar || !title || !detail) return;

  box.classList.remove('error');
  box.classList.add('ok');
  box.style.display = 'block';

  bar.style.width = '100%';
  title.textContent = 'Listo';
  detail.textContent = detalle;
}

function setCargaError(error) {
  const box = document.getElementById('loadBox');
  const bar = document.getElementById('loadProgress');
  const title = document.getElementById('loadTitle');
  const detail = document.getElementById('loadDetail');

  if (!box || !bar || !title || !detail) return;

  box.classList.remove('ok');
  box.classList.add('error');
  box.style.display = 'block';

  bar.style.width = '100%';
  title.textContent = 'Error al cargar';
  detail.textContent =
    error?.message || String(error) || 'Error desconocido. Revisa consola.';
}

// ======================================================
// Filtro Destino (robusto aunque la celda sea "DESTINO // PROGRAMA")
// + Regla especial: "SUR DE CHILE Y BARILOCHE" entra en ambos filtros.
// ======================================================
const FLT_DESTINO = { value: '' };

function _normKey(s=''){
  return String(s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase()
    .replace(/\s+/g,'')
    .trim();
}
function _destinoBaseFromCell(txt=''){
  // La celda puede ser: "DESTINO // PROGRAMA"
  return String(txt || '').split('//')[0].trim();
}
function _isMixSurBar(rawDestino=''){
  const k = _normKey(rawDestino);
  return k.includes('surdechile') && k.includes('bariloche');
}

// DataTables ext.search callback
function filtroDestinoCalendario(settings, rowData){
  if (settings.nTable.id !== 'tablaCalendario') return true;

  const sel = (FLT_DESTINO.value || '').trim();
  if (!sel) return true;

  const selK  = _normKey(sel);
  const cell  = (rowData && rowData[3]) ? rowData[3] : ''; // columna 3 = "Destino / Programa"
  const base  = _destinoBaseFromCell(cell);
  const baseK = _normKey(base);

  const mixed = _isMixSurBar(base);

  // Si seleccionan BARILOCHE o SUR DE CHILE, incluir también el mixto
  if (selK === 'bariloche' || selK === 'surdechile') {
    return baseK === selK || mixed;
  }

  // Para otros destinos: match exacto del destino base
  return baseK === selK;
}


// ======================================================
// Buscador con coma: "t1,t2,..." => acepta CUALQUIER término (OR)
// Ej: "1358, 1511" muestra filas que contengan 1358 O 1511
// ======================================================
const BUSQ_COMA = { activo:false, terminos:[] };

function filtroBusquedaPorComa(settings, rowData){
  // Solo afecta esta tabla
  if (settings.nTable.id !== 'tablaCalendario') return true;
  if (!BUSQ_COMA.activo) return true;

  const rowText = (rowData || []).join(' ').toLowerCase();
  return BUSQ_COMA.terminos.some(t => rowText.includes(t));
}


// ======================================================
// Helpers de hora y orden de actividades (NUEVO)
// - Convierte "HH:mm" en minutos; si no hay hora, va al final.
// - Compara por horaInicio y desempatando por horaFin.
// ======================================================
function horaToMin(h) {
  if (!h || typeof h !== 'string') return Number.POSITIVE_INFINITY;
  // acepta 8:00, 08:00, 8.00, 8h00
  const m = h.match(/(\d{1,2})[:h\.]?(\d{2})?/i);
  if (!m) return Number.POSITIVE_INFINITY;
  const HH = parseInt(m[1], 10);
  const MM = m[2] ? parseInt(m[2], 10) : 0;
  if (isNaN(HH) || isNaN(MM) || HH < 0 || HH > 23 || MM < 0 || MM > 59) {
    return Number.POSITIVE_INFINITY;
  }
  return HH * 60 + MM;
}
function compararActividades(a = {}, b = {}) {
  const ai = horaToMin(a.horaInicio);
  const bi = horaToMin(b.horaInicio);
  if (ai !== bi) return ai - bi;
  const af = horaToMin(a.horaFin);
  const bf = horaToMin(b.horaFin);
  return af - bf;
}

// ======================================================
// Helpers de "Vuelos" (LEE COLECCIÓN 'vuelos')
// ======================================================
function _safe(v){ return (v ?? '').toString().trim(); }
// ---------- Helpers tolerantes para leer campos por "paths" ----------
const BIG_SORT = 9e15;

function _getPath(obj, path){
  try{
    return path.split('.').reduce((acc,k)=> (acc && acc[k]!==undefined) ? acc[k] : undefined, obj);
  }catch{ return undefined; }
}
function _pick(obj, ...paths){
  for (const p of paths){
    const v = _getPath(obj, p);
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}
function _fmtHM(v){
  const s = String(v||'').trim();
  if (!s) return '';
  const m = s.match(/(\d{1,2})[:h\.]?(\d{2})/i);
  if (!m) return s;
  const hh = String(parseInt(m[1],10)).padStart(2,'0');
  const mm = String(parseInt(m[2],10)).padStart(2,'0');
  return `${hh}:${mm}`;
}
function _sortNumFrom(dateAny, timeAny){
  const iso = _toISODate(dateAny);
  if (!iso) return BIG_SORT;
  const t = _fmtHM(timeAny) || '23:59';
  const d = new Date(`${iso}T${t}:00`);
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : BIG_SORT;
}
function _sortNumVuelo(v = {}){
  // fecha/hora de SALIDA (IDA) como criterio principal
  let fechaIda = _pick(v,
    'fechaIda','idaFecha','fechaSalida','salida.fecha','ida.fecha','fecha','fecha_ida'
  );
  let horaSal = _pick(v,
    'vueloIdaHora','idaHora','salidaHora','salida.hora','horaSalidaIda'
  );

  // si hay tramos, primera salida manda
  if (Array.isArray(v.tramos) && v.tramos.length){
    const first = v.tramos[0] || {};
    fechaIda = _pick(first,'fecha','fechaIda','salida.fecha') || fechaIda;
    horaSal  = _pick(first,'vueloHora','hora','salidaHora','salida.hora') || horaSal;
  }

  return _sortNumFrom(fechaIda, horaSal);
}

function _toISODate(x){
  if (!x) return '';
  // Firestore Timestamp
  if (x?.toDate) return x.toDate().toISOString().slice(0,10);
  // Timestamp-like
  if (x?.seconds != null) return new Date(x.seconds * 1000).toISOString().slice(0,10);
  // Date
  if (x instanceof Date) return x.toISOString().slice(0,10);

  // String
  const t = String(x).trim();
  if (!t) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;

  // dd-mm-yyyy / dd/mm/yyyy / dd.mm.yyyy
  const m = t.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
  if (m){
    let dd = m[1].padStart(2,'0');
    let mm = m[2].padStart(2,'0');
    let yy = m[3];
    yy = (yy.length === 2) ? ('20' + yy) : yy;
    return `${yy}-${mm}-${dd}`;
  }

  const d = new Date(t);
  return isNaN(d) ? '' : d.toISOString().slice(0,10);
}

function _bon(x){
  const iso = _toISODate(x);
  return iso ? formatearFechaBonita(iso) : (x ? String(x) : '');
}


// Resumen compacto del vuelo/trayecto
function _resumenVuelo(v = {}){
  const transporte = (_safe(v.transporte) || _safe(v.tipoTransporte) || 'aereo').toUpperCase();
  const etiqueta   = (transporte === 'TERRESTRE') ? 'BUS' : 'AÉREO';
  const prov       = _safe(v.proveedor);
  const num        = _safe(v.numero);

  // origen/destino
  let origen  = _safe(v.origen);
  let destino = _safe(v.destino);

  // fechas ida/vuelta (tolerante)
  let fechaIda = _pick(v,'fechaIda','idaFecha','fechaSalida','salida.fecha','ida.fecha','fecha','fecha_ida');
  let fechaVta = _pick(v,'fechaVuelta','fechaVueltaTer','vueltaFecha','fechaRegreso','regreso.fecha','vuelta.fecha','fecha_vuelta');

  // horas ida (PRES / SAL / ARR)
  let presIda = _pick(v,'presentacionIdaHora','idaPresentacionHora','presentacionHoraIda','ida.presentacionHora','salida.presentacionHora');
  let salIda  = _pick(v,'vueloIdaHora','idaHora','salidaHora','salida.hora','horaSalidaIda');
  let arrIda  = _pick(v,'arriboIdaHora','llegadaIdaHora','horaArriboIda','idaArriboHora','ida.llegadaHora','llegada.hora','arribo.hora');

  // horas vuelta (PRES / SAL / ARR)
  let presVta = _pick(v,'presentacionVueltaHora','vueltaPresentacionHora','presentacionHoraVuelta','vuelta.presentacionHora','regreso.presentacionHora');
  let salVta  = _pick(v,'vueloVueltaHora','vueltaHora','regresoHora','regreso.hora','horaSalidaVuelta');
  let arrVta  = _pick(v,'arriboVueltaHora','llegadaVueltaHora','horaArriboVuelta','vueltaArriboHora','vuelta.llegadaHora','llegadaVuelta.hora');

  // Si hay tramos: ORIGEN = primer tramo, DESTINO = último tramo,
  // y la SALIDA/ARRIBO se pueden sacar de esos tramos si existen.
  if (Array.isArray(v.tramos) && v.tramos.length){
    const first = v.tramos[0] || {};
    const last  = v.tramos[v.tramos.length - 1] || {};
    origen   = _safe(first.origen)  || origen;
    destino  = _safe(last.destino)  || destino;

    fechaIda = _pick(first,'fecha','fechaIda','salida.fecha') || fechaIda;

    // salida/arribo desde tramos si vienen
    presIda  = _pick(first,'presentacionHora','presentacionIdaHora','presentacion') || presIda;
    salIda   = _pick(first,'vueloHora','hora','salidaHora','salida.hora') || salIda;
    arrIda   = _pick(last,'arriboHora','llegadaHora','horaArribo','arribo.hora','llegada.hora') || arrIda;
  }

  const head = `${etiqueta}${prov ? ' ' + prov : ''}${num ? ' ' + num : ''}`.trim();

  const idaParts = [];
  const idaRuta  = (origen && destino) ? `${origen}→${destino}` : '';
  if (idaRuta) idaParts.push(idaRuta);
  if (fechaIda) idaParts.push(_bon(fechaIda));
  if (_fmtHM(presIda)) idaParts.push(`PRES ${_fmtHM(presIda)}`);
  if (_fmtHM(salIda))  idaParts.push(`SAL ${_fmtHM(salIda)}`);
  if (_fmtHM(arrIda))  idaParts.push(`ARR ${_fmtHM(arrIda)}`);

  const vtaParts = [];
  const vtaRuta  = (destino && origen) ? `${destino}→${origen}` : '';
  if (vtaRuta) vtaParts.push(vtaRuta);
  if (fechaVta) vtaParts.push(_bon(fechaVta));
  if (_fmtHM(presVta)) vtaParts.push(`PRES ${_fmtHM(presVta)}`);
  if (_fmtHM(salVta))  vtaParts.push(`SAL ${_fmtHM(salVta)}`);
  if (_fmtHM(arrVta))  vtaParts.push(`ARR ${_fmtHM(arrVta)}`);

  return [
    head,
    idaParts.length ? `IDA: ${idaParts.join(' · ')}` : '',
    vtaParts.length ? `REG: ${vtaParts.join(' · ')}` : ''
  ].filter(Boolean).join(' · ');
}


// Devuelve Map<groupId, string[]> a partir de 'vuelos'
// Devuelve Map<groupKey, {items:[{text, sort}], minSort:number}>
async function cargarVuelosIndex(){
  const index = new Map();
  let snap;

  try{
    snap = await getDocs(collection(db, 'vuelos'));
  }catch(e){
    console.warn('[VUELOS] No pude leer colección "vuelos":', e);
    return index;
  }

  const ensure = (vk) => {
    if (!index.has(vk)) index.set(vk, { items: [], minSort: BIG_SORT });
    return index.get(vk);
  };

  const add = (key, item) => {
    const k = String(key || '').trim();
    if (!k) return;

    // Variantes útiles: "1412-101" también indexa "1412"
    const vars = new Set([k]);
    if (k.includes('-')) vars.add(k.split('-')[0]);

    vars.forEach(vk => {
      const box = ensure(vk);
      if (!box.items.some(x => x.text === item.text)) box.items.push(item);
      box.minSort = Math.min(box.minSort, item.sort);
    });
  };

  snap.forEach(ds => {
    const d = ds.data() || {};
    const text = _resumenVuelo(d);
    if (!text) return;

    const item = { text, sort: _sortNumVuelo(d) };

    // Recolectar keys posibles de grupo desde múltiples esquemas
    const keys = new Set();

    const arrs = []
      .concat(Array.isArray(d.grupoIds) ? d.grupoIds : [])
      .concat(Array.isArray(d.grupos) ? d.grupos : [])
      .concat(Array.isArray(d.groups) ? d.groups : []);

    arrs.forEach(x => {
      if (typeof x === 'string' || typeof x === 'number') keys.add(String(x).trim());
      else if (x && typeof x === 'object'){
        keys.add(String(x.id || x.grupoId || '').trim());
        keys.add(String(x.numeroNegocio || x.grupoNumero || x.numNegocio || '').trim());
      }
    });

    if (d.statusPorGrupo && typeof d.statusPorGrupo === 'object'){
      Object.keys(d.statusPorGrupo).forEach(k => keys.add(String(k).trim()));
    }
    if (d.gruposMap && typeof d.gruposMap === 'object'){
      Object.keys(d.gruposMap).forEach(k => keys.add(String(k).trim()));
    }

    keys.add(String(d.grupoId || '').trim());
    keys.add(String(d.grupoDocId || '').trim());
    keys.add(String(d.grupoNumero || d.numeroNegocio || '').trim());

    const clean = [...keys].filter(Boolean);
    if (!clean.length) return;

    clean.forEach(gk => add(gk, item));
  });

  // Orden bonito dentro de cada grupo
  for (const [k, box] of index){
    box.items.sort((a,b) => (a.sort - b.sort) || a.text.localeCompare(b.text));
  }

  return index;
}

async function cargarHotelesIndex(){
  const index = new Map();

  // 1) Índice hoteles: hotelDocId -> nombre
  const hotelesById = new Map();
  try{
    const snapH = await getDocs(collection(db, 'hoteles'));
    snapH.forEach(ds => {
      const h = ds.data() || {};
      const name = _safe(h.nombre || h.name || h.hotel || ds.id);
      hotelesById.set(String(ds.id), name);
    });
  }catch(e){
    console.warn('[HOTELES] No pude leer colección "hoteles":', e);
  }

  // 2) Leer asignaciones hoteleras (1 pasada)
  let snapA;
  try{
    snapA = await getDocs(collection(db, 'hotelAssignments'));
  }catch(e){
    console.warn('[HOTELES] No pude leer colección "hotelAssignments":', e);
    return index;
  }

  const add = (key, line) => {
    const k = String(key || '').trim();
    if (!k) return;

    const vars = new Set([k]);
    if (k.includes('-')) vars.add(k.split('-')[0]);

    vars.forEach(vk => {
      if (!index.has(vk)) index.set(vk, []);
      const arr = index.get(vk);
      if (!arr.includes(line)) arr.push(line); // dedupe
    });
  };

  snapA.forEach(ds => {
    const a = ds.data() || {};

    // keys posibles de grupo
    const keys = new Set();
    keys.add(String(a.grupoId || '').trim());
    keys.add(String(a.grupoDocId || '').trim());
    keys.add(String(a.grupoNumero || a.numeroNegocio || '').trim());
    if (a.grupo && typeof a.grupo === 'object'){
      keys.add(String(a.grupo.id || a.grupo.grupoId || '').trim());
      keys.add(String(a.grupo.numeroNegocio || a.grupo.grupoNumero || '').trim());
    }
    if (Array.isArray(a.grupos)){
      a.grupos.forEach(x => keys.add(String(x).trim()));
    }

    const clean = [...keys].filter(Boolean);
    if (!clean.length) return;

    // resolver nombre hotel
    let hotelName = _safe(a.hotelNombre || a.nombre || (a.hotel && a.hotel.nombre) || '');
    if (!hotelName){
      const hid = _safe(a.hotelId || a.hotelDocId || (a.hotel && a.hotel.id) || '');
      if (hid && hotelesById.has(hid)) hotelName = hotelesById.get(hid);
      else {
        const m = _safe(a.hotelPath || '').match(/hoteles\/([^/]+)/i);
        if (m && hotelesById.has(m[1])) hotelName = hotelesById.get(m[1]);
        else hotelName = hid; // fallback
      }
    }

    // fechas (tolerante)
    const ciISO = _toISODate(a.checkIn || a.checkin || a.fechaInicio || '');
    const coISO = _toISODate(a.checkOut || a.checkout || a.fechaFin || '');

    const rango = (ciISO || coISO)
      ? ` (${ciISO ? formatearFechaBonita(ciISO) : '—'} → ${coISO ? formatearFechaBonita(coISO) : '—'})`
      : '';

    const line = `${hotelName}${rango}`.trim();
    if (!line) return;

    clean.forEach(gk => add(gk, line));
  });

  for (const [k, arr] of index) arr.sort((a,b)=>a.localeCompare(b));
  return index;
}

// Extrae parámetro de URL (si lo quieres usar luego)
function getParametroURL(nombre) {
  const params = new URLSearchParams(window.location.search);
  return params.get(nombre);
}
const numeroNegocioInicial = getParametroURL("numeroNegocio");

function ajustarVistaCalendario(tabla) {
  setTimeout(() => {
    try {
      if (!$.fn.DataTable.isDataTable('#tablaCalendario')) return;

      tabla.draw(false);

      try {
        tabla.columns.adjust();
      } catch (e) {
        console.warn('columns.adjust omitido:', e);
      }

      $(window).trigger('resize');
    } catch (e) {
      console.warn('Ajuste visual calendario omitido:', e);
    }
  }, 200);
}

// Cuando el DOM y Firebase Auth estén listos:
$(function () {
  onAuthStateChanged(auth, user => {
    if (!user) {
      location = 'login.html';
    } else {
      escucharCambiosCalendario(user.email);
    }
  });
}); // ← cierra $(function)

// ------------------------------------------------------------------
// Escucha cambios en tiempo real desde Firestore
// Cada cambio en grupos actualiza calendario.html para todos los usuarios
// ------------------------------------------------------------------
function escucharCambiosCalendario(userEmail) {
  if (unsubscribeGruposCalendario) {
    unsubscribeGruposCalendario();
  }

  unsubscribeGruposCalendario = onSnapshot(
    collection(db, "grupos"),
    async () => {
      if (refrescandoCalendario) return;

      refrescandoCalendario = true;
      try {
        await generarTablaCalendario(userEmail);
      } finally {
        refrescandoCalendario = false;
      }
    },
    error => {
      console.error("Error escuchando cambios en calendario:", error);
      setCargaError(error);
    }
  );
}

// ------------------------------------------------------------------
// Función principal: carga datos, construye tabla y DataTable
// ------------------------------------------------------------------
async function generarTablaCalendario(userEmail) {
  try {
  // 0) Guardar filtros actuales antes de refrescar
  const filtroBuscadorActual = $('#buscador').val() || '';
  const filtroDestinoActual  = $('#filtroDestino').val() || '';
  const filtroAnoActual      = $('#filtroAno').val() || ANO_COMERCIAL_ACTUAL;
  const filtroFechaActual    = $('#filtroFechaDesde').val() || '';

  // 0.1) Destruir DataTable ANTES de reconstruir la tabla
  if ($.fn.DataTable.isDataTable('#tablaCalendario')) {
    $('#tablaCalendario').DataTable().destroy();
  }

  $('#encabezadoCalendario').empty();
  $('#cuerpoCalendario').empty();

  // 1) Leer todos los grupos de Firestore
  const snapshot = await getDocs(collection(db, "grupos"));
  setCarga(15, 'Grupos cargados', `${snapshot.size} grupos encontrados`);
  const grupos = [];
  const fechasUnicas = new Set();
  const destinosSet = new Set();
  const aniosSet = new Set();
  setCarga(25, 'Cargando vuelos...', 'Leyendo colección vuelos');
  const indexVuelos = await cargarVuelosIndex();

  setCarga(40, 'Cargando hoteles...', 'Leyendo hoteles y asignaciones');
  const indexHoteles = await cargarHotelesIndex();

  snapshot.forEach(docSnap => {
    const d = docSnap.data();
    const id = docSnap.id;
    const itinerario = d.itinerario || {};
    // Recolectar todas las fechas usadas en itinerarios
    Object.keys(itinerario).forEach(fecha => fechasUnicas.add(fecha));
    const destRaw = (d.destino || '').toString().trim();
    if (destRaw) {
      // Si es mixto "SUR DE CHILE Y BARILOCHE", no lo agregamos como opción,
      // sino que agregamos ambos destinos base.
      if (_isMixSurBar(destRaw)) {
        destinosSet.add('SUR DE CHILE');
        destinosSet.add('BARILOCHE');
      } else {
        destinosSet.add(destRaw.toUpperCase());
      }
    }

    aniosSet.add(d.anoViaje || "");

    grupos.push({
      id,
      numeroNegocio: (d.numeroNegocio ?? id),  // ← mejor: usa el campo si existe
      nombreGrupo: d.nombreGrupo || "",
      destino: d.destino || "",
      programa: d.programa || "",
      cantidadgrupo: d.cantidadgrupo || "",
      adultos: d.adultos || "",
      estudiantes: d.estudiantes || "",
      fechaInicio: _toISODate(d.fechaInicio) || "",
      fechaFin: _toISODate(d.fechaFin) || "",
      anoViaje: d.anoViaje || "",        // ← NUEVO: lo usamos para el filtro de año
      itinerario
    });
  });

  // ───────────────────────────  
  // Ordenar grupos solo por fechaInicio (YYYY-MM-DD)
  // ───────────────────────────  
  grupos.sort((a, b) => {
    const fa = _toISODate(a.fechaInicio) || '9999-12-31';
    const fb = _toISODate(b.fechaInicio) || '9999-12-31';
    return fa.localeCompare(fb);
  });

  setCarga(60, 'Procesando grupos...', `${grupos.length} grupos preparados`);    
  // 2) Preparar selects de filtros y cabecera
  const fechasOrdenadas = Array.from(fechasUnicas).sort();
  const destinos = Array.from(destinosSet).sort();
  const anios = Array.from(aniosSet).sort();

  // Filtro destino
  $('#filtroDestino').empty().append('<option value="">Todos</option>');
  destinos.forEach(d =>
    $('#filtroDestino').append(`<option value="${d}">${d}</option>`)
  );

  // Filtro año
  $('#filtroAno').empty().append('<option value="">Todos</option>');
  anios.forEach(a =>
    $('#filtroAno').append(`<option value="${a}">${a}</option>`)
  );
    
  $('#filtroAno').val(ANO_COMERCIAL_ACTUAL);

  // Cabecera de la tabla
  const $trhead = $('#encabezadoCalendario').empty();
  $trhead.append(`
    <th>N° Negocio</th>
    <th>Grupo</th>
    <th>Pax</th>
    <th>Destino / Programa</th>
    <th>Hoteles</th>
    <th>Vuelos</th>
    <th>Año</th>
  `);


  // Encabezados de fechas (domingo con clase 'domingo')
  // Guardamos además el ISO real en data-fechaiso para la exportación
  fechasOrdenadas.forEach(f => {
    const [y1, m1, d1] = f.split('-').map(Number);
    const fechaObj = new Date(y1, m1 - 1, d1);
    const clase = fechaObj.getDay() === 0 ? 'domingo' : '';
    $trhead.append(
      `<th class="${clase}" data-fechaiso="${f}">${formatearFechaBonita(f)}</th>`
    );
  });



  // 3) Construir cuerpo de la tabla
  const $tbody = $('#cuerpoCalendario').empty();
  grupos.forEach(g => {
    const $tr = $('<tr>');
   // Siete primeras celdas fijas (la 7ª es "Año" que va oculta en DataTables)
  const resumenPax = `${g.cantidadgrupo} (A: ${g.adultos} E: ${g.estudiantes})`;
  
  // Keys variantes para calzar con distintos esquemas (ej: "1412-101" y "1412")
  const k1 = String(g.id || '').trim();
  const k2 = String(g.numeroNegocio || '').trim();
  const k1b = k1.includes('-') ? k1.split('-')[0] : '';
  const k2b = k2.includes('-') ? k2.split('-')[0] : '';
  
  // Vuelos (dedupe + orden por fecha salida)
  const vBoxes = []
    .concat(indexVuelos.get(k1)  || null)
    .concat(indexVuelos.get(k2)  || null)
    .concat(indexVuelos.get(k1b) || null)
    .concat(indexVuelos.get(k2b) || null)
    .filter(Boolean);
  
  // Aplanar a items [{text, sort}] (compatible si te queda algún array legacy)
  const flat = [];
  vBoxes.forEach(b => {
    if (Array.isArray(b)) {
      b.forEach(s => flat.push({ text: String(s||''), sort: BIG_SORT }));
    } else if (Array.isArray(b.items)) {
      b.items.forEach(it => flat.push(it));
    }
  });
  
  const uniq = new Map(); // text -> bestSort
  flat.forEach(it => {
    const t = String(it?.text || '').trim();
    if (!t) return;
    const s = Number.isFinite(it.sort) ? it.sort : BIG_SORT;
    if (!uniq.has(t) || s < uniq.get(t)) uniq.set(t, s);
  });
  
  const vuelosList = [...uniq.entries()]
    .map(([text, sort]) => ({ text, sort }))
    .sort((a,b) => (a.sort - b.sort) || a.text.localeCompare(b.text));
  
  const vuelosTxt  = vuelosList.map(x => x.text).join("\n");
  const vuelosSort = vuelosList.length ? vuelosList[0].sort : BIG_SORT;

  
  // Hoteles (dedupe + saltos de línea)
  const hotelesArr = []
    .concat(indexHoteles.get(k1)  || [])
    .concat(indexHoteles.get(k2)  || [])
    .concat(indexHoteles.get(k1b) || [])
    .concat(indexHoteles.get(k2b) || []);
  const hotelesTxt = [...new Set(hotelesArr)]
  .map(s => String(s || '').toUpperCase())
  .join("\n");
  
$tr.append(
  $('<td>').text(g.numeroNegocio).attr('data-doc-id', g.id),
  $('<td>').text(g.nombreGrupo).attr('data-doc-id', g.id),

  // 👇 Pax queda fijo como tercera columna
  $('<td>').text(resumenPax).attr('data-doc-id', g.id),

  $('<td>')
    .text(`${(g.destino||'').trim()} // ${(g.programa||'').trim()}`.replace(/^\s*\/\/\s*|\s*\/\/\s*$/g,''))
    .attr('data-doc-id', g.id),

  // 👇 Hoteles
  $('<td>')
    .text(hotelesTxt)
    .attr('data-doc-id', g.id)
    .css('white-space','pre-line'),

  // 👇 Vuelos/Traslados
  $('<td>')
    .text(vuelosTxt)
    .attr('data-doc-id', g.id)
    .attr('data-order', String(vuelosSort))
    .css('white-space','pre-line'),

  // 👇 Año queda oculto, pero sirve para filtro
  $('<td>').text(g.anoViaje).attr('data-doc-id', g.id)
);




    // Una celda por cada fecha (ordenando actividades por hora al mostrar)
    fechasOrdenadas.forEach(f => {
      const actividades = g.itinerario[f] || [];
      const actividadesOrdenadas = [...actividades].sort(compararActividades);
      const texto = actividadesOrdenadas
        .map(a => `${a.horaInicio||""}–${a.horaFin||""} ${a.actividad||""}`)
        .join("\n");

      // Clases condicionales por día
      const clases = [];
      if (f === g.fechaInicio || f === g.fechaFin) clases.push('inicio-fin');

      // Domingo → clase "domingo"
      const [y2, m2, d2] = f.split('-').map(Number);
      const fechaObj = new Date(y2, m2 - 1, d2);
      if (fechaObj.getDay() === 0) clases.push('domingo');

      const $td = $('<td>')
        .addClass(clases.join(' '))
        .text(texto)
        .attr('data-doc-id', g.id)
        .attr('data-fecha', f)
        .attr('data-original', texto);

      $tr.append($td);
    }); // ← cierra fechasOrdenadas.forEach

    $tbody.append($tr);
  }); // ← cierra grupos.forEach
  
  // 4.1) Inicializar DataTable
  setCarga(85, 'Construyendo tabla...', 'Inicializando DataTable');
  const tabla = $('#tablaCalendario').DataTable({
    scrollX: false,
    autoWidth: false,
    dom: 'Brtip',
    pageLength: grupos.length,
    order: [[5, 'asc']],
    buttons: [{
      extend: 'colvis',
      text: 'Ver columnas',
      className: 'dt-button',
      columns: ':gt(2)' // no permite ocultar N° Negocio, Grupo ni Pax
    }],
    // Ocultamos la columna "Año" pero la dejamos searchable
    columnDefs: [
      { targets: [5], type: 'num' }, // Vuelos ahora está en columna 5
      { targets: [6], visible: false, searchable: true }
    ],
    language: {
      url: '//cdn.datatables.net/plug-ins/1.13.4/i18n/es-ES.json'
    }
  });

  // Registrar filtros ext.search SIN declarar variables duplicadas
  if (!$.fn.dataTable.ext.search.includes(filtroDestinoCalendario)) {
    $.fn.dataTable.ext.search.push(filtroDestinoCalendario);
  }
  
  if (!$.fn.dataTable.ext.search.includes(filtroBusquedaPorComa)) {
    $.fn.dataTable.ext.search.push(filtroBusquedaPorComa);
  }
  
  // Reaplicar filtros que tenía el usuario antes del refresco
  $('#buscador').val(filtroBuscadorActual);
  $('#filtroDestino').val(filtroDestinoActual);
  $('#filtroAno').val(filtroAnoActual);
  $('#filtroFechaDesde').val(filtroFechaActual);
  
  // Destino
  FLT_DESTINO.value = filtroDestinoActual;
  
  // Año
  tabla.column(6).search(
    filtroAnoActual ? '^' + filtroAnoActual + '$' : '',
    true,
    false
  );
  
  // Buscador
  tabla.search(filtroBuscadorActual || '');
  
  // Fecha desde: ocultar columnas anteriores
  if (filtroFechaActual) {
    tabla.columns().every(function () {
      const th = this.header();
      const fechaColumna = th?.getAttribute?.('data-fechaiso');
  
      if (!fechaColumna) return;
  
      const mostrar = fechaColumna >= filtroFechaActual;
      this.visible(mostrar, false);
    });
  }
  
  ajustarVistaCalendario(tabla);
  
  // 5) Buscador libre
  // - Sin coma: búsqueda normal DataTables
  // - Con coma: "t1,t2,..." => AND (tienen que estar TODOS)
  $('#buscador').off('input').on('input', function () {
    const raw = String(this.value || '');
  
    if (raw.includes(',')) {
      const terms = raw
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(s => s.toLowerCase());
  
      BUSQ_COMA.activo = terms.length > 0;
      BUSQ_COMA.terminos = terms;
  
      // Apagamos búsqueda global para que mande el filtro por coma
      tabla.search('');
      tabla.draw();
    } else {
      BUSQ_COMA.activo = false;
      BUSQ_COMA.terminos = [];
      tabla.search(raw).draw();
    }
  });


  // 6) Aplicar filtro destino (columna 2)
  $('#filtroDestino').off('change').on('change', function () {
    FLT_DESTINO.value = (this.value || '').trim();
    tabla.draw(); // aplica ext.search
  });

  // 7) Aplicar filtro año sobre la columna oculta 5 (NUEVO: ahora sí funciona)
  $('#filtroAno').on('change', function () {
    const val = this.value;
    tabla.column(6).search(val ? '^'+val+'$' : '', true, false).draw();
  });

  // 7.1) Filtro de columnas por fecha:
  // Oculta/Muestra columnas de fecha, NO filtra grupos.
  $('#filtroFechaDesde').off('change').on('change', function () {
    const fechaDesde = this.value; // YYYY-MM-DD
  
    tabla.columns().every(function () {
      const th = this.header();
      const fechaColumna = th?.getAttribute?.('data-fechaiso');
  
      // Solo afecta columnas que son fechas
      if (!fechaColumna) return;
  
      const mostrar = !fechaDesde || fechaColumna >= fechaDesde;
  
      this.visible(mostrar, false);
    });
  
    // Redibuja sin usar columns.adjust(), porque con FixedColumns puede romper
    ajustarVistaCalendario(tabla);
  });
    
  // const hoyISO = new Date().toISOString().slice(0, 10);
  // $('#filtroFechaDesde').val(hoyISO).trigger('change');

  // 8) Toggle modo edición (activa contenteditable en todas las celdas del body)
  // 8) Toggle modo edición
  //    Solo las celdas de itinerario (las que tienen data-fecha) serán editables.
  //    Las columnas fijas (incluida PAX) quedan siempre deshabilitadas.
  $('#btn-toggle-edit').off('click').on('click', async () => {
    editMode = !editMode;

    $('#btn-toggle-edit')
      .text(editMode ? '🔒 Desactivar Edición' : '🔓 Activar Edición');

    // Solo hacemos contenteditable en las celdas que representan itinerario (tienen data-fecha)
    $('#tablaCalendario tbody td').each(function () {
      const tieneFecha = $(this).attr('data-fecha'); // solo las columnas de días lo tienen
      $(this).attr('contenteditable', editMode && !!tieneFecha);
    });

    await addDoc(collection(db, 'historial'), {
      accion: editMode ? 'ACTIVÓ MODO EDICIÓN' : 'DESACTIVÓ MODO EDICIÓN',
      usuario: userEmail,
      timestamp: new Date()
    });
  });


  // 9) Guardar cambios al salir de una celda editable del itinerario
  $('#tablaCalendario tbody').on('focusout', 'td[contenteditable]', async function () {
    const $td      = $(this);
    const nuevoTxt = $td.text().trim();
    const original = $td.attr('data-original') || "";
    const docId    = $td.attr('data-doc-id');
    const fecha    = $td.attr('data-fecha'); // solo existe en celdas de itinerario
    if (!docId || !fecha || nuevoTxt === original) return;   // ← GUARDIA extra

    // 1) Traer el documento completo para conservar datos originales
    const ref    = doc(db, 'grupos', docId);
    const snap   = await getDoc(ref);
    const g      = snap.data();
    const arrOld = g?.itinerario?.[fecha] || [];

    // 2) Parsear cada línea en {horaInicio, horaFin, actividad}
    //    Acepta "8:00–9:00 Texto", con guion -, – o — y también sin horas.
    const lineas = nuevoTxt.split("\n").map(s => s.trim()).filter(s => s.length);
    const parsed = lineas.map(linea => {
      const m = linea.match(/^(.*?)\s*[–—-]\s*(.*?)\s+(.*)$/); // start – end actividad
      return m
        ? { horaInicio: m[1].trim(), horaFin: m[2].trim(), actividad: m[3].trim() }
        : { actividad: linea.trim() };
    });

    // 3) Mezclar con el original para no perder campos no escritos
    const arrUp = parsed.map((n, idx) => {
      const orig = arrOld[idx] || {};
      return {
        ...orig,
        horaInicio: n.horaInicio ?? orig.horaInicio,
        horaFin:    n.horaFin    ?? orig.horaFin,
        actividad:  n.actividad  ?? orig.actividad
      };
    });

    // 4) Ordenar por hora y guardar en Firestore (NUEVO)
    const arrOrdenada = [...arrUp].sort(compararActividades);
    await updateDoc(ref, {
      [`itinerario.${fecha}`]: arrOrdenada
    });

    // 5) Construir texto ordenado, registrar historial y sincronizar UI (NUEVO)
    const textoOrdenado = arrOrdenada
      .map(a => `${a.horaInicio||""}–${a.horaFin||""} ${a.actividad||""}`)
      .join("\n");

    await addDoc(collection(db, 'historial'), {
      numeroNegocio: docId,
      campo:         `itinerario.${fecha}`,
      anterior:      original,
      nuevo:         textoOrdenado,
      modificadoPor: auth.currentUser.email,
      timestamp:     new Date()
    });

    // Refleja inmediatamente el orden aplicado en la celda
    $td.text(textoOrdenado).attr('data-original', textoOrdenado);
  });

  // 10) Ver historial
  $('#btn-view-history').off('click').on('click', async () => {
    await recargarHistorial();
    $('#modalHistorial').show();
  });
  $('#btn-close-history').on('click', () => $('#modalHistorial').hide());
  $('#btn-refresh-history').on('click', recargarHistorial);
  setCargaOk(`Calendario cargado correctamente con ${grupos.length} grupos.`);

  } catch (err) {
    console.error('🔥 Error general en generarTablaCalendario:', err);
    setCargaError(err);
  }
} // ← cierra generarTablaCalendario

// ------------------------------------------------------------------
// Recargar historial desde Firestore para modal
// ------------------------------------------------------------------
async function recargarHistorial() {
  const $tabla = $('#tablaHistorial');
  const snap = await getDocs(query(
    collection(db, 'historial'),
    orderBy('timestamp', 'desc')
  ));
  const $tb = $tabla.find('tbody').empty();

  snap.forEach(docSnap => {
    const d = docSnap.data();
    const fecha = d.timestamp?.toDate?.();
    if (!fecha) return;
    $tb.append(`
      <tr>
        <td>${fecha.toLocaleString('es-CL')}</td>
        <td>${d.modificadoPor||d.usuario||''}</td>
        <td>${d.numeroNegocio||''}</td>
        <td>${d.accion||d.campo||''}</td>
        <td>${d.anterior||''}</td>
        <td>${d.nuevo||''}</td>
      </tr>
    `);
  });

  if ($.fn.DataTable.isDataTable('#tablaHistorial')) {
    $('#tablaHistorial').DataTable().destroy();
  }
  dtHist = $('#tablaHistorial').DataTable({
    language: { url: '//cdn.datatables.net/plug-ins/1.13.4/i18n/es-ES.json' },
    order: [[0,'desc']],
    dom: 'ltip',
    pageLength: 15
  });
}

// ------------------------------------------------------------------
// Formatea ISO → “12 dic” en español
// ------------------------------------------------------------------
function formatearFechaBonita(fechaISO) {
  const [yyyy, mm, dd] = fechaISO.split('-').map(Number);
  const fecha = new Date(yyyy, mm - 1, dd);
  return fecha.toLocaleDateString('es-CL',{ day:'numeric', month:'short' });
}

// ------------------------------------------------------------------
// Exportar a Excel con SheetJS (usa DOM real, respeta filtros y ediciones)
// ------------------------------------------------------------------
document.getElementById('btn-export-excel').addEventListener('click', () => {
  const tabla = $('#tablaCalendario').DataTable();

  // 1) Encabezados: usamos data-fechaiso si existe (para columnas de días)
  const ths = $("#tablaCalendario thead th").toArray();
  const headers = ths.map(th => {
    const iso = th.getAttribute('data-fechaiso');
    return iso || th.innerText.trim();
  });

  const datos = [];

  // 2) Recorremos las filas tal como se muestran (respeta orden + filtros)
  tabla.rows({ search: 'applied', order: 'applied' }).every(function () {
    const rowNode = this.node(); // <tr> real
    const rowObj = {};

    $(rowNode).find('td').each((i, td) => {
      const header = headers[i] || `Col_${i + 1}`;
      // Tomamos el texto exactamente como está en la celda (incluye ediciones)
      rowObj[header] = $(td).text().trim();
    });

    datos.push(rowObj);
  });

  // 3) Generar y descargar Excel
  const ws = XLSX.utils.json_to_sheet(datos, { header: headers });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Calendario");
  XLSX.writeFile(wb, "calendario.xlsx");
});

