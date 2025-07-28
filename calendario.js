import { app, db } from './firebase-init.js';
import {
  collection, getDocs, doc, updateDoc, addDoc, query, orderBy
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';

const auth = getAuth(app);
let dtHist = null;
let editMode = false;

// Extrae parámetro de URL
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

// Devuelve “Domingo 14 dic”, “Lunes 15 dic”, etc.
function formatearDiaFechaBonita(fechaISO) {
  const [yyyy, mm, dd] = fechaISO.split('-').map(Number);
  const fecha = new Date(yyyy, mm - 1, dd);
  const dias = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
  const nombreDia = dias[fecha.getDay()];
  const diaMes = fecha.toLocaleDateString('es-CL', { day:'numeric', month:'short' });
  // Capitalizar primera letra
  return nombreDia.charAt(0).toUpperCase() + nombreDia.slice(1) + ' ' + diaMes;
}

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

  snapshot.forEach(docSnap => {
    const d = docSnap.data();
    const id = docSnap.id;
    const itinerario = d.itinerario || {};
    // Recolectar todas las fechas usadas
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
      itinerario
    });
  });

  // ───────────────────────────  
  // Ordenar grupos solo por fechaInicio  
  // ───────────────────────────  
  grupos.sort((a, b) =>
    a.fechaInicio.localeCompare(b.fechaInicio)
  );

  // ────────────────  
  // Ordenar grupos por destino y luego por fechaInicio  
  // ────────────────  
  //grupos.sort((a, b) => {
    // 1) Comparar destinos
    //const cmp = a.destino.localeCompare(b.destino);
    //if (cmp !== 0) return cmp;
    // 2) Si destinos iguales, comparar fechaInicio (YYYY-MM-DD)
    //return a.fechaInicio.localeCompare(b.fechaInicio);
  //});

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
    <th>Destino</th>
    <th>Programa</th>
    <th>Pax</th>
  `);
  fechasOrdenadas.forEach(f => {
    // detectar si es domingo
    const [yyyy, mm, dd] = f.split('-').map(Number);
    const fechaObj = new Date(yyyy, mm - 1, dd);
    const clase = fechaObj.getDay() === 0 ? 'domingo' : '';
    // insertar <th> con o sin la clase
    $trhead.append(
      `<th class="${clase}">${formatearDiaFechaBonita(f)}</th>`
    );
  });

  // 3) Construir cuerpo de la tabla
  const $tbody = $('#cuerpoCalendario').empty();
  grupos.forEach(g => {
    const $tr = $('<tr>');
    const resumenPax = `${g.cantidadgrupo} (A: ${g.adultos} E: ${g.estudiantes})`;
    // Cinco primeras celdas fijas
    $tr.append(
      $('<td>').text(g.numeroNegocio).attr('data-doc-id', g.id),
      $('<td>').text(g.nombreGrupo).attr('data-doc-id', g.id),
      $('<td>').text(g.destino).attr('data-doc-id', g.id),
      $('<td>').text(g.programa).attr('data-doc-id', g.id),
      $('<td>').text(resumenPax).attr('data-doc-id', g.id)
    );

    // Una celda por cada fecha
    fechasOrdenadas.forEach(f => {
      const actividades = g.itinerario[f] || [];
      const texto = actividades
        .map(a => `${a.horaInicio||""}–${a.horaFin||""} ${a.actividad||""}`)
        .join("\n");

      // Clases condicionales
      const clases = [];
      if (f === g.fechaInicio || f === g.fechaFin) clases.push('inicio-fin');

      // Domingo → clase "domingo"
      const [yyyy, mm, dd] = f.split('-').map(Number);
      const fechaObj = new Date(yyyy, mm - 1, dd);
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
      headerOffset: 90    // ajusta este valor a la altura de tu header global
    },
    buttons: [{
      extend: 'colvis',
      text: 'Ver columnas',
      className: 'dt-button',
      columns: ':gt(0)'
    }],
    language: {
      url: '//cdn.datatables.net/plug-ins/1.13.4/i18n/es-ES.json'
    }
  });

  // ——————————————————————
  //  Reajustar anchos para evitar descuadres
  // ——————————————————————
  tabla.columns.adjust();                        // al cargar
  $(window).on('resize', () => tabla.columns.adjust());               // al redimensionar ventana
  tabla.on('column-visibility.dt', () => tabla.columns.adjust());    // al ocultar/mostrar columnas
  
  // 5) Buscador libre
  $('#buscador').on('input', () => tabla.search($('#buscador').val()).draw());

  // 6) Aplicar filtro destino
  $('#filtroDestino').on('change', function () {
    const val = this.value;
    tabla.column(2).search(val ? '^'+val+'$' : '', true, false).draw();
  });

  // 7) Aplicar filtro año (columna 7 asume 5 fijas + 2 selectores)
  $('#filtroAno').on('change', function () {
    const val = this.value;
    tabla.column(7).search(val ? '^'+val+'$' : '', true, false).draw();
  });

  // 8) Toggle modo edición
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

  // 9) Al salir de edición en cualquier celda, guardo cambios
  $('#tablaCalendario tbody').on('focusout', 'td[contenteditable]', async function () {
    const $td = $(this);
    const nuevo = $td.text().trim();
    const original = $td.attr('data-original') || "";
    const docId = $td.attr('data-doc-id');
    const fecha = $td.attr('data-fecha');
    if (!docId || nuevo === original) return;

    // Parsear líneas en actividades
    const actividades = nuevo.split("\n").map(linea => {
      const match = linea.match(/^(.*?)[–\-](.*)\s+(.*)$/);
      return match
        ? { horaInicio: match[1].trim(), horaFin: match[2].trim(), actividad: match[3].trim() }
        : { actividad: linea.trim() };
    });

    // Actualizar Firestore
    await updateDoc(doc(db, 'grupos', docId), {
      [`itinerario.${fecha}`]: actividades
    });
    // Registrar historial
    await addDoc(collection(db, 'historial'), {
      numeroNegocio: docId,
      campo: `itinerario.${fecha}`,
      anterior: original,
      nuevo: nuevo,
      modificadoPor: userEmail,
      timestamp: new Date()
    });
    $td.attr('data-original', nuevo);
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
        <td>${d.modificadoPor||d.usuario}</td>
        <td>${d.numeroNegocio||''}</td>
        <td>${d.accion||d.campo}</td>
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
