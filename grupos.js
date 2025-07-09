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
  "numeroNegocio","nombreGrupo","cantidadgrupo",
  "adultos","estudiantes","colegio","curso","anoViaje",
  "destino","programa","inicio","hotel","asistenciaEnViajes",
  "autorizacion","fechaDeViaje","observaciones","versionFicha",
  "creadoPor","fechaCreacion","fin","transporte","ciudades",
  "hoteles","tramos","obsLogist"
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
      id: docSnap.id,
      fila: camposFire.map(c => d[c] || '')
    };
  });

  // 3) Renderizar <tbody>
  const $tb = $('#tablaGrupos tbody').empty();
  valores.forEach(item => {
    const $tr = $('<tr>');
    item.fila.forEach((celda, idx) => {
      $tr.append(
        $('<td>')
          .text(celda)
          .attr('data-doc-id', item.id)
          .attr('data-campo', camposFire[idx])
          .attr('data-original', celda)
      );
    });
    $tb.append($tr);
  });

  // 4) Iniciar DataTable principal
  const tabla = $('#tablaGrupos').DataTable({
    language:{ url:'https://cdn.datatables.net/plug-ins/1.13.4/i18n/es-ES.json' },
    dom:'rtip', pageLength:-1, lengthChange:false,
    order:[[8,'desc'],[9,'desc'],[10,'desc'],[1,'desc']],
    scrollX:true,
    columnDefs:[{ targets:[5,6], visible:false }]
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
// 8) Función que carga y pivota historial
// ————————————————————————————————————————————————————————————
  async function recargarHistorial() {
    // 8.1) Hacer la consulta ordenada
    const q    = query(collection(db,'historial'), orderBy('timestamp','desc'));
    const snap = await getDocs(q);
    console.log('Historial docs:', snap.docs.length);
  
    // 8.2) Volcar al <tbody> (vaciar antes)
    const $tbH = $('#tablaHistorial tbody').empty();
    snap.forEach(s => {
      const d     = s.data();
      const fecha = d.timestamp.toDate();
      const ts    = fecha.getTime();
      // Construyo la fila con antes/después
      $tbH.append(`
        <tr>
          <td data-timestamp="${ts}">${fecha.toLocaleString('es-CL')}</td>
          <td>${d.modificadoPor || d.usuario}</td>
          <td>${d.numeroNegocio}</td>
          <td>${d.accion || d.campo}</td>
          <td>${d.anterior || ''}</td>
          <td>${d.nuevo    || ''}</td>
        </tr>
      `);
    });
  
    // 8.3) (Re)Inicializar DataTable
    if ($.fn.DataTable.isDataTable('#tablaHistorial')) {
      $('#tablaHistorial').DataTable().destroy();
    }
    dtHist = $('#tablaHistorial').DataTable({
      language:   { url:'https://cdn.datatables.net/plug-ins/1.13.4/i18n/es-ES.json' },
      pageLength: 15,
      lengthMenu: [[15,30,50,-1],[15,30,50,'Todos']],
      order:      [[0,'desc']],
      dom:        'fltip'  // f = filtro, l = length, t = table, i = info, p = paging
    });
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
  $.fn.dataTable.ext.search.push((settings, rowData) => {
    if (settings.nTable.id !== 'tablaHistorial') return true;
    const cellDate = Date.parse(rowData[0]);
    const min = $('#histInicio').val() ? new Date($('#histInicio').val()).getTime() : -Infinity;
    const max = $('#histFin').val()   ? new Date($('#histFin').val()).getTime()   : +Infinity;
    return cellDate >= min && cellDate <= max;
  });
  $('#histInicio, #histFin')
    .off('change')
    .on('change', () => dtHist.draw());

} // ← cierre de cargarYMostrarTabla()
