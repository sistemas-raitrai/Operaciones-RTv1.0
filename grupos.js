import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged, signOut }
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs, query, orderBy,
  doc, updateDoc, addDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

// Propiedades en el mismo orden que aparecen en la tabla
const camposFire = [
  "numeroNegocio",  // 0
  "nombreGrupo",    // 1
  "cantidadgrupo",  // 2
  "adultos",        // 3
  "estudiantes",    // 4
  "colegio",        // 5
  "curso",          // 6
  "anoViaje",       // 7
  "destino",        // 8
  "programa",       // 9
  "fechaInicio",         // 10
  "hotel",          // 11
  "asistenciaEnViajes", // 12
  "autorizacion",   // 13
  "fechaDeViaje",   // 14
  "observaciones",  // 15
  "versionFicha",   // 16
  "creadoPor",      // 17
  "fechaCreacion",  // 18
  "fechaFin",            // 19
  "transporte",     // 20
  "ciudades",       // 21
  "hoteles",        // 22
  "tramos",         // 23
  "obsLogist"       // 24
];

let editMode = false;
let dtHist = null;

$(function(){
  $('#btn-logout').click(() => signOut(auth).then(()=>location='login.html'));
  onAuthStateChanged(auth, user => {
    if (!user) location = 'login.html';
    else cargarYMostrarTabla();
  });
});

async function cargarYMostrarTabla() {
  // 1) Leer coleccion "grupos"
  const snap = await getDocs(collection(db,'grupos'));
  if (snap.empty) return console.warn('No hay grupos');

  // 2) Mapear docs → {id,fila:[]}
  const valores = snap.docs.map(docSnap => {
    const d = docSnap.data();
    return {
      id:  docSnap.id,                        // el ID interno de Firestore
      fila: camposFire.map(c => d[c] || '')   // [ d["numeroNegocio"], d["nombreGrupo"], … ]
    };
  });

  const destinosUnicos = new Set();
  const aniosUnicos    = new Set();
  
  valores.forEach(item => {
    const fila = item.fila;
    destinosUnicos.add(fila[8]);   // columna “Destino” en índice 8
    aniosUnicos.add(fila[7]);      // columna “Año” en índice 7
  });
  
  // convierte Sets a Arrays ordenados
  const destinos = Array.from(destinosUnicos).sort();
  const anios    = Array.from(aniosUnicos).sort();
  
  // ahora vuelca al <select>
  const $filtroDestino = $('#filtroDestino').empty().append('<option value="">Todos</option>');
  destinos.forEach(d => $filtroDestino.append(`<option value="${d}">${d}</option>`));
  
  const $filtroAno = $('#filtroAno').empty().append('<option value="">Todos</option>');
  anios.forEach(a => $filtroAno.append(`<option value="${a}">${a}</option>`));
  
    // 3) Renderizar <tbody>
    const $tb = $('#tablaGrupos tbody').empty();
    valores.forEach(item => {
      const $tr = $('<tr>');
      item.fila.forEach((celda, idx) => {
        $tr.append(
          $('<td>')
            .text(celda)                          // el valor
            .attr('data-doc-id', item.id)         // para saber de qué doc viene
            .attr('data-campo', camposFire[idx])  // para saber qué campo actualiza
            .attr('data-original', celda)         // para comparar si se edita
        );
      });
      $tb.append($tr);
    });

  // 4) Iniciar DataTable principal
  const tabla = $('#tablaGrupos').DataTable({
    language:   { url:'https://cdn.datatables.net/plug-ins/1.13.4/i18n/es-ES.json' },
    dom:        'Brtip',        // B = buttons, f = filtro, r = procesamiento, t = tabla
    buttons: [
      {
        extend: 'colvis',
        text:    'Ver columnas',
        className: 'dt-button',
        columns: ':gt(0)'           // opcional, ":gt(0)" lista todas menos la primera
      }
    ],
    pageLength: -1,
    lengthChange: false,
    order: [[8,'desc'],[9,'desc'],[10,'desc'],[1,'desc']],
    scrollX: true,
    columnDefs: [
      { targets: [5,6], visible: false }  // p. ej. Colegio y Curso ocultos por defecto
    ]
  });
  tabla.buttons().container().appendTo('#toolbar');

  // 1) Buscador de palabras clave
  $('#buscador').on('input', function() {
    tabla.search(this.value).draw();
  });
  
  // 2) Filtro por Destino (columna índice 8)
  $('#filtroDestino').on('change', function() {
    tabla
      .column(8)            // índice de “Destino”
      .search(this.value)   // vacío ("") = todos
      .draw();
  });
  
  // 3) Filtro por Año de Viaje (columna índice 7)
  $('#filtroAno').on('change', function() {
    tabla
      .column(7)            // índice de “Año de Viaje”
      .search(this.value)
      .draw();
  });

  // 5) Edición inline en blur
  $('#tablaGrupos tbody').on('focusout','td[contenteditable]', async function(){
    const $td = $(this);
    const nuevo = $td.text().trim();
    const orig  = $td.attr('data-original');
    if (nuevo === orig) return;

    const docId = $td.attr('data-doc-id');
    const campo = $td.attr('data-campo');
    // 5.1) Update Firestore
    await updateDoc(doc(db,'grupos',docId),{ [campo]: nuevo });
    // 5.2) Log en historial
    await addDoc(collection(db,'historial'),{
      numeroNegocio: $td.closest('tr').find('td').eq(0).text().trim(),
      campo, anterior: orig, nuevo,
      modificadoPor: auth.currentUser.email,
      timestamp: new Date()
    });
    $td.attr('data-original', nuevo);
  });

  // 6) Toggle modo edición
  $('#btn-toggle-edit').off('click').on('click', async () => {
    editMode = !editMode;
    $('#btn-toggle-edit').text(editMode?'🔒 Desactivar Edición':'🔓 Activar Edición');
    // solo td índices >1
    $('#tablaGrupos tbody tr').each((_,tr)=>{
      $(tr).find('td').each((i,td)=>{
        if (i>1) $(td).attr('contenteditable', editMode);
        else $(td).removeAttr('contenteditable');
      });
    });
    // log acción global
    await addDoc(collection(db,'historial'),{
      accion: editMode?'ACTIVÓ MODO EDICIÓN':'DESACTIVÓ MODO EDICIÓN',
      usuario: auth.currentUser.email,
      timestamp: new Date()
    });
  });

  // 7) “Ver Historial”
  $('#btn-view-history').off('click').on('click', async () => {
    await recargarHistorial();
    $('#modalHistorial').show();
  });

// ————————————————————————————————————————————————————————————
// 8) Función que carga y pivota historial (con más logs)
// ————————————————————————————————————————————————————————————
  async function recargarHistorial() {
    console.group('🔄 recargarHistorial()');
    try {
      // 8.1) Comprueba que el <table> exista
      const $tabla = $('#tablaHistorial');
      console.log('  → ¿Selector #tablaHistorial existe?', $tabla.length === 1);
      if (!$tabla.length) {
        console.error('  × No encontré #tablaHistorial en el DOM');
        console.groupEnd();
        return;
      }
  
      // 8.2) Hago la consulta
      console.log('  → Consulta a Firestore…');
      const q    = query(collection(db, 'historial'), orderBy('timestamp', 'desc'));
      const snap = await getDocs(q);
      console.log(`  → Documentos recuperados: ${snap.docs.length}`);
  
      // 8.3) Vuelco las filas
      const $tbH = $tabla.find('tbody').empty();
      snap.forEach((s, i) => {
        const d     = s.data();
        const fecha = d.timestamp?.toDate?.();
        if (!fecha) {
          console.warn(`    ⚠️ Doc #${i} no tiene timestamp válido`, d);
          return;
        }
        const ts  = fecha.getTime();
        $tbH.append(`
          <tr>
            <td data-timestamp="${ts}">${fecha.toLocaleString('es-CL')}</td>
            <td>${d.modificadoPor || d.usuario}</td>
            <td>${d.numeroNegocio || ''}</td>
            <td>${d.accion || d.campo}</td>
            <td>${d.anterior || ''}</td>
            <td>${d.nuevo || ''}</td>
          </tr>
        `);
      });
      console.log('  → Filas volcadas en el DOM');
  
      // 8.4) Destroy si existía
      if ($.fn.DataTable.isDataTable('#tablaHistorial')) {
        console.log('  → Destruyendo instancia previa de DataTable');
        $('#tablaHistorial').DataTable().destroy();
      }
  
      // 8.5) Re-init DataTable
      console.log('  → Inicializando DataTable en #tablaHistorial');
      dtHist = $('#tablaHistorial').DataTable({
        language:   { url:'https://cdn.datatables.net/plug-ins/1.13.4/i18n/es-ES.json' },
        pageLength: 15,
        lengthMenu: [[15,30,50,-1],[15,30,50,'Todos']],
        order:      [[0,'desc']],
        dom:        'ltip'
      });
  
      console.log('✅ recargarHistorial() completado correctamente');
    } catch (err) {
      console.error('🔥 recargarHistorial() falló con error:', err);
    }
    console.groupEnd();
  }
  
  // 9) Conectar botón “Actualizar”
  $('#btn-refresh-history')
    .off('click')
    .on('click', recargarHistorial);
  
  // 10) Botón “Cerrar”
  $('#btn-close-history')
    .off('click')
    .on('click', () => $('#modalHistorial').hide());
  
  // 11) Buscador global del historial
  $('#buscadorHistorial')
    .off('input')
    .on('input', () => dtHist.search($('#buscadorHistorial').val()).draw());
  
  // 12) Filtro de fechas (se agrega a ext.search)
  $.fn.dataTable.ext.search.push((settings, rowData, rowIdx) => {
    // Solo nos interesa el historial
    if (settings.nTable.id !== 'tablaHistorial') return true;
  
    // Localiza la celda que tiene el data-timestamp
    const cell = dtHist.row(rowIdx).node().querySelector('td[data-timestamp]');
    if (!cell) return true; // seguridad
  
    const ts = parseInt(cell.getAttribute('data-timestamp'), 10);
  
    // Lee los inputs de fecha
    const min = $('#histInicio').val()
      ? new Date($('#histInicio').val()).getTime()
      : -Infinity;
    const max = $('#histFin').val()
      ? new Date($('#histFin').val()).getTime()
      : +Infinity;
  
    // Devuelve true si ts está dentro del rango
    return ts >= min && ts <= max;
  });
  $('#histInicio, #histFin')
    .off('change')
    .on('change', () => dtHist.draw());

} // ← cierre de cargarYMostrarTabla()

// --- al final de grupos.js ---

// 1) Función que lee toda la tabla de DataTables y genera un Excel
function exportarGrupos() {
  // Usamos DataTables API para obtener datos tal como se muestran (filtrados, ordenados)
  const tabla = $('#tablaGrupos').DataTable();
  // Obtiene un array de arrays: cada fila en un sub-array de celdas de texto
  const rows = tabla.rows({ search: 'applied' }).data().toArray();

  // Opcional: encabezados igual a las columnas definidas en el HTML (ordenado)
  const headers = [
    "N° Negocio","Nombre de Grupo","Pax","Adultos","Estudiantes","Colegio","Curso","Año",
    "Destino","Programa","Inicio","Hotel","Asist. Viajes","Autoriz.","Fecha de Viaje",
    "Obs.","Versión","Creado Por","F. Creación","Fin","Transporte","Ciudades","Hoteles",
    "Tramos","Obs. Logist."
  ];

  // Prepara un array de objetos (clave=header, valor=celda)
  const datos = rows.map(row => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = row[i]);
    return obj;
  });

  // 2) Genera worksheet y workbook con SheetJS
  const ws = XLSX.utils.json_to_sheet(datos, { header: headers });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Grupos");

  // 3) Desencadena la descarga
  XLSX.writeFile(wb, "grupos.xlsx");
}

// 4) Asocia el botón
document
  .getElementById('btn-export-excel')
  .addEventListener('click', exportarGrupos);


