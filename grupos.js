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
  "identificador",      // 1
  "nombreGrupo",        // 2
  "anoViaje",           // 3
  "vendedora",          // 4 
  "cantidadgrupo",      // 5
  "adultos",            // 6
  "estudiantes",        // 7
  "colegio",            // 8
  "curso",              // 9
  "destino",            // 10
  "programa",           // 11
  "fechaInicio",        // 12
  "fechaFin",           // 13
  "asistenciaEnViajes", // 14
  "autorizacion",       // 15
  "hoteles",            // 16
  "ciudades",           // 17
  "transporte",         // 18
  "tramos",             // 19
  "fechaDeViaje",       // 20
  "observaciones",      // 21
  "creadoPor",          // 22
  "fechaCreacion"      //  23
];

let editMode = false;
let dtHist = null;
let GRUPOS_RAW = [];

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

// ==== Helpers de normalización para Totales ====
function toNum(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}
function parseFechaPosible(v) {
  if (!v) return null;
  if (v instanceof Timestamp) return v.toDate();
  if (v?.toDate) return v.toDate();
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + 'T00:00:00');
    const m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
    if (m) {
      let [ , dd, mm, yy ] = m;
      dd = dd.padStart(2,'0'); mm = mm.padStart(2,'0');
      yy = yy.length === 2 ? ('20' + yy) : yy;
      return new Date(`${yy}-${mm}-${dd}T00:00:00`);
    }
  }
  return null;
}

async function cargarYMostrarTabla() {
  // 1) Leer coleccion "grupos"
  const snap = await getDocs(collection(db,'grupos'));
  if (snap.empty) return console.warn('No hay grupos');

  // 2) Mapear docs → {id,fila:[]} PARA LA TABLA
  const valores = snap.docs.map(docSnap => {
    const d = docSnap.data();
    return {
      id:  docSnap.id,
      fila: camposFire.map(c => d[c] || '')
    };
  });

  // 2.b) Normalizar datos crudos → GRUPOS_RAW (para Totales)
  GRUPOS_RAW = snap.docs.map(s => {
    const d = s.data();
    return {
      _id: s.id,
      numeroNegocio: d.numeroNegocio ?? '',
      identificador: d.identificador ?? '',
      nombreGrupo: d.nombreGrupo ?? '',
      anoViaje: d.anoViaje ?? '',
      vendedora: d.vendedora ?? '',
      cantidadgrupo: toNum(d.cantidadgrupo),
      adultos: toNum(d.adultos),
      estudiantes: toNum(d.estudiantes),
      colegio: d.colegio ?? '',
      curso: d.curso ?? '',
      destino: d.destino ?? '',
      programa: d.programa ?? '',
      fechaInicio: parseFechaPosible(d.fechaInicio),
      fechaFin: parseFechaPosible(d.fechaFin),
      hoteles: d.hoteles ?? '',
      transporte: d.transporte ?? ''
    };
  });

  // Para filtros rápido (Destino/Año)
  const destinosUnicos = new Set();
  const aniosUnicos    = new Set();
  valores.forEach(item => {
    const fila = item.fila;
    destinosUnicos.add(fila[10]); // Destino
    aniosUnicos.add(fila[3]);     // Año
  });
  const destinos = Array.from(destinosUnicos).sort();
  const anios    = Array.from(aniosUnicos).sort();

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
          .text(formatearCelda(celda, camposFire[idx]))
          .attr('data-doc-id', item.id)
          .attr('data-campo', camposFire[idx])
          .attr('data-original', celda)
      );
    });
    $tb.append($tr);
  });

  // 4) Iniciar DataTable principal
  const tabla = $('#tablaGrupos').DataTable({
    language:   { url:'https://cdn.datatables.net/plug-ins/1.13.4/i18n/es-ES.json' },
    dom:        'Brtip',
    buttons: [
      {
        extend: 'colvis',
        text:    'Ver columnas',
        className: 'dt-button',
        columns: ':gt(0)'
      }
    ],
    pageLength: -1,
    lengthChange: false,
    order: [[9,'desc'],[10,'desc'],[11,'desc'],[1,'desc']],
    scrollX: true,
    autoWidth: false,
    fixedHeader: {
      header: true,
      headerOffset: $('header.header').outerHeight() + $('.filter-bar').outerHeight()
    },
    columnDefs: [
      { targets: [8,9,14,15,17,19,22,23], visible: false },
      { targets: 0, width: '20px' },
      { targets: 1, width: '20px' },
      { targets: 2, width: '100px' },
      { targets: 3, width: '20px' },
      { targets: 4, width: '50px' },
      { targets: 5, width: '20px' },
      { targets: 6, width: '20px' },
      { targets: 7, width: '20px' },
      { targets: 8, width: '70px' },
      { targets: 9, width: '20px' },
      { targets: 10, width: '70px' },
      { targets: 11, width: '70px' },
      { targets: 12, width: '40px' },
      { targets: 13, width: '40px' },
      { targets: 14, width: '30px' },
      { targets: 15, width: '80px' },
      { targets: 16, width: '50px' },
      { targets: 17, width: '80px' },
      { targets: 18, width: '50px' },
      { targets: 19, width: '50px' },
      { targets: 20, width: '80px' },
      { targets: 21, width: '100px' },
      { targets: 22, width: '50px' },
      { targets: 23, width: '50px' }
    ]
  });
  tabla.buttons().container().appendTo('#toolbar');

  // 1) Buscador
  $('#buscador').on('input', function(){ tabla.search(this.value).draw(); });

  // 2) Filtro por Destino
  $('#filtroDestino').on('change', function(){
    tabla.column(10).search(this.value).draw();
  });

  // 3) Filtro por Año
  $('#filtroAno').on('change', function(){
    tabla.column(3).search(this.value).draw();
  });

  // 5) Edición inline en blur
  $('#tablaGrupos tbody').on('focusout','td[contenteditable]', async function(){
    const $td = $(this);
    const nuevo = $td.text().trim().toUpperCase();
    const orig  = $td.attr('data-original');
    if (nuevo === orig) return;

    const docId = $td.attr('data-doc-id');
    const campo = $td.attr('data-campo');
    await updateDoc(doc(db,'grupos',docId),{ [campo]: nuevo });
    await addDoc(collection(db,'historial'),{
      numeroNegocio: $td.closest('tr').find('td').eq(0).text().trim(),
      campo, anterior: orig, nuevo,
      modificadoPor: auth.currentUser.email,
      timestamp: new Date()
    });
    $td.attr('data-original', nuevo);
  });

  // 6) Toggle edición
  $('#btn-toggle-edit').off('click').on('click', async () => {
    editMode = !editMode;
    $('#btn-toggle-edit').text(editMode?'🔒 Desactivar Edición':'🔓 Activar Edición');
    $('#tablaGrupos tbody tr').each((_,tr)=>{
      $(tr).find('td').each((i,td)=>{
        if (i>1) $(td).attr('contenteditable', editMode);
        else $(td).removeAttr('contenteditable');
      });
    });
    await addDoc(collection(db,'historial'),{
      accion: editMode?'ACTIVÓ MODO EDICIÓN':'DESACTIVÓ MODO EDICIÓN',
      usuario: auth.currentUser.email,
      timestamp: new Date()
    });
  });

  // 7) Ver Historial
  $('#btn-view-history').off('click').on('click', async () => {
    await recargarHistorial();
    $('#modalHistorial').show();
  });

  // =========================================================
  // 8) TOTALES — botón + lógica + popover (DRILL-DOWN)
  // =========================================================
  const $modalTot = $('#modalTotales');
  const $popover  = $('#tot-popover');

  // abrir/cerrar
  $('#btn-totales').off('click').on('click', () => {
    $('#tot-resumen').empty();
    $('#tot-tablas').empty();
    $popover.hide();
    $modalTot.show();
  });
  $('#btn-tot-cerrar').off('click').on('click', () => {
    $popover.hide();
    $modalTot.hide();
  });

  // cerrar popover al hacer click fuera
  $(document).off('click.totales').on('click.totales', (e) => {
    if (!$(e.target).closest('#tot-popover, .tot-pill, .mini-link').length) $popover.hide();
  });

  // Calcular
  $('#btn-tot-calcular').off('click').on('click', () => {
    renderTotales();
  });

  function overlaps(ini, fin, min, max) {
    if (!ini && !fin) return false;
    ini = ini || fin; fin = fin || ini;
    if (min && fin < min) return false;
    if (max && ini > max) return false;
    return true;
  }

  function renderTotales() {
    const min = $('#totInicio').val() ? new Date($('#totInicio').val() + 'T00:00:00') : null;
    const max = $('#totFin').val()    ? new Date($('#totFin').val()    + 'T23:59:59') : null;

    // Filtrar por rango de fechas (solapamiento con inicio/fin del grupo)
    const lista = GRUPOS_RAW.filter(g => {
      if (!min && !max) return true;
      return overlaps(g.fechaInicio, g.fechaFin, min, max);
    });

    // Categorías por identificador
    const cats = { '101': [], '201/202': [], '301/302/303': [] };
    for (const g of lista) {
      const idn = parseInt(String(g.identificador).replace(/[^\d]/g,''), 10);
      if (idn === 101) cats['101'].push(g);
      else if (idn === 201 || idn === 202) cats['201/202'].push(g);
      else if ([301,302,303].includes(idn)) cats['301/302/303'].push(g);
    }

    // Totales pax
    const sum = (arr, k) => arr.reduce((acc,x)=>acc+(x[k]||0),0);
    const totPax  = sum(lista,'cantidadgrupo');
    const totAdul = sum(lista,'adultos');
    const totEst  = sum(lista,'estudiantes');

    // Rango efectivo detectado
    const fechasValidas = lista.flatMap(g => [g.fechaInicio, g.fechaFin]).filter(Boolean).sort((a,b)=>a-b);
    const minReal = fechasValidas[0] ? fechasValidas[0].toLocaleDateString('es-CL') : '—';
    const maxReal = fechasValidas[fechasValidas.length-1] ? fechasValidas[fechasValidas.length-1].toLocaleDateString('es-CL') : '—';

    // —— Resumen en “pills”
    const $res = $('#tot-resumen').empty();
    const PILL_INDEX = [];

    const addPill = (label, arr, key) => {
      const i = PILL_INDEX.push({ key, arr }) - 1;
      const $p = $(`<div class="tot-pill" data-pill="${i}" title="Click para ver grupos"></div>`)
        .append(`<span>${label}:</span>`)
        .append(`<span>${arr.length}</span>`)
        .append(`<small>grupos</small>`)
        .on('click', (ev) => showPopover(ev, PILL_INDEX[i], label));
      $res.append($p);
    };

    addPill('Identificador 101', cats['101'], 'id101');
    addPill('Identificador 201/202', cats['201/202'], 'id201_202');
    addPill('Identificador 301/302/303', cats['301/302/303'], 'id301_303');

    const $pax = $(`<div class="tot-pill" title="Totales de personas"></div>`)
      .append(`<span>👥 Pax</span><span>${totPax}</span>`)
      .append(`<small>(Adultos ${totAdul} / Estudiantes ${totEst})</small>`);
    $res.append($pax);

    const $rng = $(`<div class="tot-pill" title="Rango efectivo"></div>`)
      .append(`<span>🗓️ Rango</span><span>${minReal} → ${maxReal}</span>`);
    $res.append($rng);

    // —— Desgloses
    const $tbx = $('#tot-tablas').empty();

    const mkTabla = (titulo, filas, includePax=true) => {
      const $wrap = $('<div></div>');
      $wrap.append(`<h3 style="margin:.5rem 0;">${titulo}</h3>`);
      const $t = $(`<table><thead><tr>
        <th>${titulo}</th><th># Grupos</th>${includePax?'<th>Pax</th>':''}
      </tr></thead><tbody></tbody></table>`);
      const $tb = $t.find('tbody');

      filas.forEach(row => {
        const i = PILL_INDEX.push({ key: `${titulo}:${row.clave}`, arr: row.grupos }) - 1;
        const paxTd = includePax ? `<td>${row.pax}</td>` : '';
        const $tr = $(`<tr>
          <td>${row.clave || '—'}</td>
          <td><button class="mini-link" data-pill="${i}">${row.grupos.length}</button></td>
          ${paxTd}
        </tr>`);
        $tb.append($tr);
      });

      $t.on('click','button.mini-link', (ev) => {
        const idx = parseInt(ev.currentTarget.getAttribute('data-pill'),10);
        showPopover(ev, PILL_INDEX[idx], titulo);
      });

      $wrap.append($t);
      $tbx.append($wrap);
    };

    const groupBy = (arr, key) => {
      const map = new Map();
      for (const g of arr) {
        const k = (g[key] ?? '').toString().trim();
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(g);
      }
      return [...map.entries()].map(([clave, grupos]) => ({
        clave,
        grupos,
        pax: sum(grupos,'cantidadgrupo')
      })).sort((a,b)=> b.grupos.length - a.grupos.length);
    };

    mkTabla('Año',        groupBy(lista, 'anoViaje'));
    mkTabla('Vendedor(a)',groupBy(lista, 'vendedora'));
    mkTabla('Destino',    groupBy(lista, 'destino'));
    mkTabla('Programa',   groupBy(lista, 'programa'));
    mkTabla('Hoteles',    groupBy(lista, 'hoteles'));
    mkTabla('Transporte', groupBy(lista, 'transporte'));

    // —— Popover flotante con lista de grupos
    function showPopover(ev, bucket, titulo) {
      const items = (bucket?.arr || []);
      const html = `
        <h4>${titulo}</h4>
        <ul>
          ${items.map(g => `<li>
            <a href="#" class="go-row" data-num="${g.numeroNegocio}">
              ${g.numeroNegocio} — ${g.nombreGrupo}
            </a>
          </li>`).join('')}
        </ul>
      `;
      $popover.html(html);

      // posicionarlo cerca del cursor
      const vw = $(window).width(), vh = $(window).height();
      const w  = Math.min(420, vw - 24);
      $popover.css({ width: w + 'px' });
      const clickX = ev.pageX, clickY = ev.pageY;
      const left = Math.min(clickX + 12, window.scrollX + vw - w - 12);
      const top  = Math.min(clickY + 12, window.scrollY + vh - 24);
      $popover.css({ left: left + 'px', top: top + 'px' }).show();

      // click en un grupo → resaltar fila en la tabla principal
      $popover.off('click', 'a.go-row').on('click', 'a.go-row', (e) => {
        e.preventDefault();
        const num = e.currentTarget.getAttribute('data-num') || '';
        let foundNode = null;
        tabla.rows().every(function(){
          const data = this.data();
          if ((data?.[0]||'').toString().trim() === num.toString().trim()) {
            foundNode = this.node();
          }
        });
        if (foundNode) {
          $('#tablaGrupos tbody tr').removeClass('highlight-row');
          $(foundNode).addClass('highlight-row')[0]
            .scrollIntoView({ behavior:'smooth', block:'center' });
        } else {
          tabla.search(num).draw();
        }
      });
    }
  }
  // ======= FIN TOTALES =======

  // ————————————————————————————————————————————————————————————
  // 9) Función que carga y pivota historial (igual que tenías)
  // ————————————————————————————————————————————————————————————
  async function recargarHistorial() {
    console.group('🔄 recargarHistorial()');
    try {
      const $tabla = $('#tablaHistorial');
      if (!$tabla.length) { console.error('No encontré #tablaHistorial'); console.groupEnd(); return; }

      const q    = query(collection(db, 'historial'), orderBy('timestamp', 'desc'));
      const snap = await getDocs(q);

      const $tbH = $tabla.find('tbody').empty();
      snap.forEach((s, i) => {
        const d     = s.data();
        const fecha = d.timestamp?.toDate?.();
        if (!fecha) return;
        const ts  = fecha.getTime();
        $tbH.append(`
          <tr>
            <td data-timestamp="${ts}">${fecha.toLocaleString('es-CL')}</td>
            <td>${d.modificadoPor || d.usuario || ''}</td>
            <td>${d.numeroNegocio || ''}</td>
            <td>${d.accion || d.campo || ''}</td>
            <td>${d.anterior || ''}</td>
            <td>${d.nuevo || ''}</td>
          </tr>
        `);
      });

      if ($.fn.DataTable.isDataTable('#tablaHistorial')) {
        $('#tablaHistorial').DataTable().destroy();
      }
      dtHist = $('#tablaHistorial').DataTable({
        language:   { url:'https://cdn.datatables.net/plug-ins/1.13.4/i18n/es-ES.json' },
        pageLength: 15,
        lengthMenu: [[15,30,50,-1],[15,30,50,'Todos']],
        order:      [[0,'desc']],
        dom:        'ltip'
      });
    } catch (err) {
      console.error('🔥 recargarHistorial() error:', err);
    }
    console.groupEnd();
  }

  // 10) Botones del Historial
  $('#btn-refresh-history').off('click').on('click', recargarHistorial);
  $('#btn-close-history').off('click').on('click', () => $('#modalHistorial').hide());
  $('#buscadorHistorial').off('input').on('input', () => dtHist.search($('#buscadorHistorial').val()).draw());

  // 12) Filtro de fechas del Historial (ext.search)
  $.fn.dataTable.ext.search.push((settings, rowData, rowIdx) => {
    if (settings.nTable.id !== 'tablaHistorial') return true;
    const cell = dtHist.row(rowIdx).node().querySelector('td[data-timestamp]');
    if (!cell) return true;
    const ts = parseInt(cell.getAttribute('data-timestamp'), 10);
    const min = $('#histInicio').val() ? new Date($('#histInicio').val()).getTime() : -Infinity;
    const max = $('#histFin').val()    ? new Date($('#histFin').val()).getTime()    : +Infinity;
    return ts >= min && ts <= max;
  });
  $('#histInicio, #histFin').off('change').on('change', () => dtHist.draw());
} // ← cierre de cargarYMostrarTabla()

// 1) Función que lee toda la tabla de DataTables y genera un Excel
function exportarGrupos() {
  // Usamos DataTables API para obtener datos tal como se muestran (filtrados, ordenados)
  const tabla = $('#tablaGrupos').DataTable();
  // Obtiene un array de arrays: cada fila en un sub-array de celdas de texto
  const rows = tabla.rows({ search: 'applied' }).data().toArray();

  // Opcional: encabezados igual a las columnas definidas en el HTML (ordenado)
const headers = [
  "N° Negocio","Identificador","Nombre de Grupo","Año","Vendedor(a)","Pax","Adultos","Estudiantes",
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
