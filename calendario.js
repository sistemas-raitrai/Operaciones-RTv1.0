import { app, db } from './firebase-init.js';
import {
  collection, getDocs, doc, getDoc, updateDoc, addDoc, query, orderBy
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';

const auth = getAuth(app);
let dtHist = null;
let editMode = false;

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
function _bon(fechaISO){
  return (fechaISO && /^\d{4}-\d{2}-\d{2}$/.test(fechaISO))
    ? formatearFechaBonita(fechaISO) : (fechaISO || '');
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
  const snap  = await getDocs(collection(db, 'vuelos'));

  snap.forEach(ds => {
    const d = ds.data() || {};
    // IDs de grupos soportados (tu screenshot muestra un array 'grupos')
    let groupIds = [];
    if (Array.isArray(d.grupos)) groupIds = d.grupos.map(String);
    else if (Array.isArray(d.groups)) groupIds = d.groups.map(String);
    else if (d.statusPorGrupo && typeof d.statusPorGrupo === 'object') groupIds = Object.keys(d.statusPorGrupo);
    else if (d.gruposMap && typeof d.gruposMap === 'object')          groupIds = Object.keys(d.gruposMap);

    if (!groupIds.length) return;

    const resumen = _resumenVuelo(d);
    groupIds.forEach(gid => {
      if (!index.has(gid)) index.set(gid, []);
      index.get(gid).push(resumen);
    });
  });

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
  const indexVuelos = await cargarVuelosIndex(); // Map<groupId, string[]>

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
      numeroNegocio: id,
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

  // Cabecera de la tabla (REEMPLAZO)
  const $trhead = $('#encabezadoCalendario').empty();
  $trhead.append(`
    <th>N° Negocio</th>
    <th>Grupo</th>
    <th>Destino</th>
    <th>Programa</th>
    <th>Vuelos</th>   <!-- NUEVA COLUMNA -->
    <th>Pax</th>
    <th>Año</th>      <!-- columna oculta para filtro de año -->
  `);
  // Encabezados de fechas (domingo con clase 'domingo')
  fechasOrdenadas.forEach(f => {
    const [y1, m1, d1] = f.split('-').map(Number);
    const fechaObj = new Date(y1, m1 - 1, d1);
    const clase = fechaObj.getDay() === 0 ? 'domingo' : '';
    $trhead.append(`<th class="${clase}">${formatearFechaBonita(f)}</th>`);
  });


  // 3) Construir cuerpo de la tabla
  const $tbody = $('#cuerpoCalendario').empty();
  grupos.forEach(g => {
    const $tr = $('<tr>');
   // Siete primeras celdas fijas (la 7ª es "Año" que va oculta en DataTables)
  const resumenPax = `${g.cantidadgrupo} (A: ${g.adultos} E: ${g.estudiantes})`;
  // Busca por g.id y, si no, por g.numeroNegocio (por seguridad)
  const vuelosTxt  = (indexVuelos.get(g.id) || indexVuelos.get(g.numeroNegocio) || []).join("\n");
  
  $tr.append(
    $('<td>').text(g.numeroNegocio).attr('data-doc-id', g.id),
    $('<td>').text(g.nombreGrupo).attr('data-doc-id', g.id),
    $('<td>').text(g.destino).attr('data-doc-id', g.id),
    $('<td>').text(g.programa).attr('data-doc-id', g.id),
    $('<td>').text(vuelosTxt).attr('data-doc-id', g.id),       // ← NUEVA columna "Vuelos"
    $('<td>').text(resumenPax).attr('data-doc-id', g.id),
    $('<td>').text(g.anoViaje).attr('data-doc-id', g.id)       // Año (oculta)
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
  
  // 5) Buscador libre
  $('#buscador').on('input', () => tabla.search($('#buscador').val()).draw());

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
  $('#btn-toggle-edit').off('click').on('click', async () => {
    editMode = !editMode;
    $('#btn-toggle-edit')
      .text(editMode ? '🔒 Desactivar Edición' : '🔓 Activar Edición');
    $('#tablaCalendario tbody td').attr('contenteditable', editMode);
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
// Exportar a Excel con SheetJS
// ------------------------------------------------------------------
document.getElementById('btn-export-excel').addEventListener('click', () => {
  const tabla = $('#tablaCalendario').DataTable();
  const rows = tabla.rows({ search:'applied' }).data().toArray();
  const headers = $("#tablaCalendario thead th")
    .toArray().map(th => th.innerText);
  const datos = rows.map(row => {
    const obj = {};
    headers.forEach((h,i) => obj[h] = row[i]);
    return obj;
  });
  const ws = XLSX.utils.json_to_sheet(datos,{ header:headers });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Calendario");
  XLSX.writeFile(wb, "calendario.xlsx");
});
