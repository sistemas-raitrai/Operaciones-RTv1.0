import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged, signOut }
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs, query, orderBy,
  doc, updateDoc, addDoc, Timestamp
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

// Propiedades en el mismo orden que aparecen en la tabla
const camposFire = [
  "numeroNegocio",      // 0
  "nombreGrupo",        // 1
  "anoViaje",           // 2
  "vendedora",          // 3 
  "cantidadgrupo",      // 4
  "adultos",            // 5
  "estudiantes",        // 6
  "colegio",            // 7
  "curso",              // 8
  "destino",            // 9
  "programa",           //10
  "fechaInicio",        //11
  "fechaFin",           //12
  "asistenciaEnViajes", //13
  "autorizacion",       //14
  "hoteles",            //15
  "ciudades",           //16
  "transporte",         //17
  "tramos",             //18
  "fechaDeViaje",       //19
  "observaciones",      //20
  "creadoPor",          //21
  "fechaCreacion"      //22
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

function formatearCelda(valor, campo) {
  // Si es un campo de fecha, lo formatea a dd-mm-aa
  const camposFecha = ['fechaInicio', 'fechaFin', 'fechaDeViaje', 'fechaCreacion'];
  if (camposFecha.includes(campo) && valor instanceof Timestamp) {
    const date = valor.toDate();
    return date.toLocaleDateString('es-CL', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit'
    });
  }
  return valor?.toString() || '';
}

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
            .text(formatearCelda(celda, camposFire[idx]))  // el valor
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
    autoWidth: false,
    columnDefs: [
      { targets: [7,8,13,14,18,21,22], visible: false },
      { targets: 0, width: '20px' },   // N° Negocio
      { targets: 1, width: '100px' },  // Nombre Grupo
      { targets: 2, width: '20px' },   // Año
      { targets: 3, width: '50px' },  // Vendedor(a)
      { targets: 4, width: '20px' },   // Pax
      { targets: 5, width: '20px' },   // Adultos
      { targets: 6, width: '20px' },   // Estudiantes
      { targets: 7, width: '70px' },  // Colegio
      { targets: 8, width: '20px' },  // Curso
      { targets: 9, width: '70px' },  // Destino
      { targets: 10, width: '70px' }, // Programa
      { targets: 11, width: '40px' },  // Inicio
      { targets: 12, width: '40px' },  // Fin
      { targets: 13, width: '30px' },  // Seguro
      { targets: 14, width: '80px' },  // Autorización
      { targets: 15, width: '50px' },  // Hoteles
      { targets: 16, width: '80px' }, // Ciudades
      { targets: 17, width: '50px' }, // Transporte
      { targets: 18, width: '50px' },  // Tramos
      { targets: 19, width: '80px' },  // Indicaciones fecha
      { targets: 20, width: '100px' }, // Observaciones
      { targets: 21, width: '50px' }, // Creado por
      { targets: 22, width: '50px' }  // Fecha creación
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
      .column(9)            // índice de “Destino”
      .search(this.value)   // vacío ("") = todos
      .draw();
  });
  
  // 3) Filtro por Año de Viaje (columna índice 7)
  $('#filtroAno').on('change', function() {
    tabla
      .column(2)            // índice de “Año de Viaje”
      .search(this.value)
      .draw();
  });

  // 5) Edición inline en blur
  $('#tablaGrupos tbody').on('focusout','td[contenteditable]', async function(){
    const $td = $(this);
    const nuevo = $td.text().trim().toUpperCase();
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
  "N° Negocio","Nombre de Grupo","Año","Vendedor(a)","Pax","Adultos","Estudiantes",
  "Colegio","Curso","Destino","Programa"," Fecha Inicio","Fecha Fin",
  "Seguro Médico","Autoriz.","Hoteles","Ciudades","Transporte","Tramos","Indicaciones de la Fecha",
  "Observaciones","Creado Por","Fecha Creación"
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


