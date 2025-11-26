import { app, db } from './firebase-init.js';
import {
  collection, getDocs, doc, getDoc, updateDoc, addDoc, query, orderBy
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';

const auth = getAuth(app);
let dtHist = null;
let editMode = false;

// ======================================================
// Buscador con coma: "t1,t2,..." => exige TODOS los términos (AND)
// ======================================================
const BUSQ_COMA = { activo:false, terminos:[] };

function filtroBusquedaPorComa(settings, rowData){
  // Solo afecta esta tabla
  if (settings.nTable.id !== 'tablaCalendario') return true;
  if (!BUSQ_COMA.activo) return true;

  const rowText = (rowData || []).join(' ').toLowerCase();
  return BUSQ_COMA.terminos.every(t => rowText.includes(t));
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

  // origen/destino + fechas/horas (tolerante a distintos nombres)
  let origen  = _safe(v.origen);
  let destino = _safe(v.destino);

  let fechaIda = v.fechaIda || v.idaFecha || v.fechaIdaTer || v['ida.fecha'] || '';
  let fechaVta = v.fechaVuelta || v.vueltaFecha || v.fechaVueltaTer || v['vuelta.fecha'] || '';

  let horaIda = v.vueloIdaHora || v.idaHora || v.presentacionIdaHora || '';
  let horaVta = v.vueloVueltaHora || v.vueltaHora || v.presentacionVueltaHora || '';

  // Si hay tramos, usar 1º origen y último destino (y horas/fechas si existen)
  if (Array.isArray(v.tramos) && v.tramos.length){
    const first = v.tramos[0] || {};
    const last  = v.tramos[v.tramos.length - 1] || {};
    origen   = _safe(first.origen)  || origen;
    destino  = _safe(last.destino)  || destino;
    fechaIda = first.fecha || fechaIda;
    fechaVta = last.fecha  || fechaVta;
    horaIda  = first.vueloHora || first.hora || horaIda;
    horaVta  = last.vueloHora  || last.hora  || horaVta;
  }

  const idaTxt = [ (origen && destino) ? `${origen}→${destino}` : '', _bon(fechaIda), _safe(horaIda) ]
                  .filter(Boolean).join(' ');
  const vtaTxt = [ (destino && origen) ? `${destino}→${origen}` : '', _bon(fechaVta), _safe(horaVta) ]
                  .filter(Boolean).join(' ');

  const head = `${etiqueta}${prov ? ' ' + prov : ''}${num ? ' ' + num : ''}`.trim();
  return [ head, idaTxt ? `IDA: ${idaTxt}` : '', vtaTxt ? `REG: ${vtaTxt}` : '' ]
         .filter(Boolean).join(' · ');
}

// Devuelve Map<groupId, string[]> a partir de 'vuelos'
async function cargarVuelosIndex(){
  const index = new Map();
  let snap;

  try{
    snap = await getDocs(collection(db, 'vuelos'));
  }catch(e){
    console.warn('[VUELOS] No pude leer colección "vuelos":', e);
    return index;
  }

  const add = (key, line) => {
    const k = String(key || '').trim();
    if (!k) return;

    // Variantes útiles: "1412-101" también indexa "1412"
    const vars = new Set([k]);
    if (k.includes('-')) vars.add(k.split('-')[0]);

    vars.forEach(vk => {
      if (!index.has(vk)) index.set(vk, []);
      const arr = index.get(vk);
      if (!arr.includes(line)) arr.push(line); // dedupe
    });
  };

  snap.forEach(ds => {
    const d = ds.data() || {};
    const resumen = _resumenVuelo(d);

    // Recolectar keys posibles de grupo desde múltiples esquemas
    const keys = new Set();

    // 1) arrays típicos
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

    // 2) mapas por grupo
    if (d.statusPorGrupo && typeof d.statusPorGrupo === 'object'){
      Object.keys(d.statusPorGrupo).forEach(k => keys.add(String(k).trim()));
    }
    if (d.gruposMap && typeof d.gruposMap === 'object'){
      Object.keys(d.gruposMap).forEach(k => keys.add(String(k).trim()));
    }

    // 3) root fields (muchos sistemas guardan 1 grupo acá)
    keys.add(String(d.grupoId || '').trim());
    keys.add(String(d.grupoDocId || '').trim());
    keys.add(String(d.grupoNumero || d.numeroNegocio || '').trim());

    // limpiar vacíos
    const clean = [...keys].filter(Boolean);
    if (!clean.length) return;

    clean.forEach(gk => add(gk, resumen));
  });

  // Orden bonito
  for (const [k, arr] of index) arr.sort((a,b) => a.localeCompare(b));
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

// Cuando el DOM y Firebase Auth estén listos:
$(function () {
  onAuthStateChanged(auth, user => {
    if (!user) {
      location = 'login.html';
    } else {
      generarTablaCalendario(user.email);
    }
  });
}); // ← cierra $(function)

// ------------------------------------------------------------------
// Función principal: carga datos, construye tabla y DataTable
// ------------------------------------------------------------------
async function generarTablaCalendario(userEmail) {
  // 1) Leer todos los grupos de Firestore
  const snapshot = await getDocs(collection(db, "grupos"));
  const grupos = [];
  const fechasUnicas = new Set();
  const destinosSet = new Set();
  const aniosSet = new Set();
  const indexVuelos   = await cargarVuelosIndex();   // Map<groupKey, string[]>
  const indexHoteles  = await cargarHotelesIndex();  // Map<groupKey, string[]>

  snapshot.forEach(docSnap => {
    const d = docSnap.data();
    const id = docSnap.id;
    const itinerario = d.itinerario || {};
    // Recolectar todas las fechas usadas en itinerarios
    Object.keys(itinerario).forEach(fecha => fechasUnicas.add(fecha));
    destinosSet.add(d.destino || "");
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
      fechaInicio: d.fechaInicio || "",
      fechaFin: d.fechaFin || "",
      anoViaje: d.anoViaje || "",        // ← NUEVO: lo usamos para el filtro de año
      itinerario
    });
  });

  // ───────────────────────────  
  // Ordenar grupos solo por fechaInicio (YYYY-MM-DD)
  // ───────────────────────────  
  grupos.sort((a, b) => a.fechaInicio.localeCompare(b.fechaInicio));

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

  // Cabecera de la tabla
  const $trhead = $('#encabezadoCalendario').empty();
  $trhead.append(`
    <th>N° Negocio</th>
    <th>Grupo</th>
    <th>Destino / Programa</th>
    <th>Hoteles</th>
    <th>Vuelos</th>
    <th>Pax</th>
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
  
  // Vuelos (dedupe + saltos de línea)
  const vuelosArr = []
    .concat(indexVuelos.get(k1)  || [])
    .concat(indexVuelos.get(k2)  || [])
    .concat(indexVuelos.get(k1b) || [])
    .concat(indexVuelos.get(k2b) || []);
  const vuelosTxt = [...new Set(vuelosArr)].join("\n");
  
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
    $('<td>')
      .text(`${(g.destino||'').trim()} // ${(g.programa||'').trim()}`.replace(/^\s*\/\/\s*|\s*\/\/\s*$/g,''))
      .attr('data-doc-id', g.id),
  
    // 👇 (antes Programa) ahora Hoteles
    $('<td>')
      .text(hotelesTxt)
      .attr('data-doc-id', g.id)
      .css('white-space','pre-line'),
  
    // 👇 Vuelos/Traslados
    $('<td>')
      .text(vuelosTxt)
      .attr('data-doc-id', g.id)
      .css('white-space','pre-line'),
  
    $('<td>').text(resumenPax).attr('data-doc-id', g.id),
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

  // 4) Inicializar DataTable
  const tabla = $('#tablaCalendario').DataTable({
    scrollX: true,
    dom: 'Brtip',
    pageLength: grupos.length, 
    order: [],
    fixedHeader: {
      header: true,
      headerOffset: 90    // ajusta a la altura del header global
    },
    buttons: [{
      extend: 'colvis',
      text: 'Ver columnas',
      className: 'dt-button',
      columns: ':gt(0)'
    }],
    // Ocultamos la columna "Año" (index 5) pero la dejamos searchable
    columnDefs: [
      { targets: [6], visible: false, searchable: true }
    ],
    language: {
      url: '//cdn.datatables.net/plug-ins/1.13.4/i18n/es-ES.json'
    }
  });

  // Asegura que el filtro por coma se registre 1 sola vez (sin duplicarse)
  $.fn.dataTable.ext.search = $.fn.dataTable.ext.search.filter(fn => fn !== filtroBusquedaPorComa);
  $.fn.dataTable.ext.search.push(filtroBusquedaPorComa);

  
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
  $('#filtroDestino').on('change', function () {
    const val = this.value;
    tabla.column(2).search(val ? '^'+val+'$' : '', true, false).draw();
  });

  // 7) Aplicar filtro año sobre la columna oculta 5 (NUEVO: ahora sí funciona)
  $('#filtroAno').on('change', function () {
    const val = this.value;
    tabla.column(6).search(val ? '^'+val+'$' : '', true, false).draw();
  });

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

