import { app, db } from './firebase-init.js';
import {
  collection, getDocs, doc, updateDoc, addDoc, query, orderBy
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';

const auth = getAuth(app);
let dtHist = null;
let editMode = false;

$(function () {
  onAuthStateChanged(auth, user => {
    if (!user) location = 'login.html';
    else generarTablaCalendario(user.email);
  });
});

async function generarTablaCalendario(userEmail) {
  const snapshot = await getDocs(collection(db, "grupos"));
  const grupos = [];
  const fechasUnicas = new Set();
  const destinosSet = new Set();
  const aniosSet = new Set();

  snapshot.forEach(docSnap => {
    const d = docSnap.data();
    const id = docSnap.id;
    const itinerario = d.itinerario || {};
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

  const fechasOrdenadas = Array.from(fechasUnicas).sort();
  const destinos = Array.from(destinosSet).sort();
  const anios = Array.from(aniosSet).sort();

  $('#filtroDestino').empty().append('<option value="">Todos</option>');
  destinos.forEach(d => $('#filtroDestino').append(`<option value="${d}">${d}</option>`));

  $('#filtroAno').empty().append('<option value="">Todos</option>');
  anios.forEach(a => $('#filtroAno').append(`<option value="${a}">${a}</option>`));

  const $thead = $('#encabezadoCalendario').empty();
  $thead.append(`<th>N° Negocio</th><th>Grupo</th><th>Destino</th><th>Programa</th><th>Pax</th>`);
  fechasOrdenadas.forEach(f => $thead.append(`<th>${formatearFechaBonita(f)}</th>`));

  const $tbody = $('#cuerpoCalendario').empty();
  grupos.forEach(g => {
    const $tr = $('<tr>');
    const resumenPax = `${g.cantidadgrupo} (A: ${g.adultos} E: ${g.estudiantes})`;
    $tr.append(
      $('<td>').text(g.numeroNegocio).attr('data-doc-id', g.id),
      $('<td>').text(g.nombreGrupo).attr('data-doc-id', g.id),
      $('<td>').text(g.destino).attr('data-doc-id', g.id),
      $('<td>').text(g.programa).attr('data-doc-id', g.id),
      $('<td>').text(resumenPax).attr('data-doc-id', g.id)
    );

    fechasOrdenadas.forEach(f => {
      const actividades = g.itinerario[f] || [];
      const texto = actividades.map(a => `${a.horaInicio || ""}–${a.horaFin || ""} ${a.actividad || ""}`).join("\n");
      const clase = (f === g.fechaInicio || f === g.fechaFin) ? 'inicio-fin' : '';
      const $td = $('<td>')
        .addClass(clase)
        .text(texto)
        .attr('data-doc-id', g.id)
        .attr('data-fecha', f)
        .attr('data-original', texto);
      $tr.append($td);
    });

    $tbody.append($tr);
  });

  const tabla = $('#tablaCalendario').DataTable({
    scrollX: true,
    dom: 'Brtip',
    buttons: [
      {
        extend: 'colvis',
        text: 'Ver columnas',
        className: 'dt-button',
        columns: ':gt(0)'
      }
    ],
    language: {
      url: '//cdn.datatables.net/plug-ins/1.13.4/i18n/es-ES.json'
    }
  });

  tabla.buttons().container().appendTo('#toolbar');

  $('#buscador').on('input', function () {
    tabla.search(this.value).draw();
  });

  $('#filtroDestino').on('change', function () {
    tabla.column(2).search(this.value).draw();
  });

  $('#filtroAno').on('change', function () {
    tabla.column(7).search(this.value).draw();
  });

  $('#btn-toggle-edit').off('click').on('click', async () => {
    editMode = !editMode;
    $('#btn-toggle-edit').text(editMode ? '🔒 Desactivar Edición' : '🔓 Activar Edición');
    $('#tablaCalendario tbody td').attr('contenteditable', editMode);
    await addDoc(collection(db, 'historial'), {
      accion: editMode ? 'ACTIVÓ MODO EDICIÓN' : 'DESACTIVÓ MODO EDICIÓN',
      usuario: userEmail,
      timestamp: new Date()
    });
  });

  $('#tablaCalendario tbody').on('focusout', 'td[contenteditable]', async function () {
    const $td = $(this);
    const nuevo = $td.text().trim();
    const original = $td.attr('data-original') || "";
    const docId = $td.attr('data-doc-id');
    const fecha = $td.attr('data-fecha');

    if (!docId || nuevo === original) return;

    if (fecha) {
      const actividades = nuevo.split("\n").map(linea => {
        const match = linea.match(/^(.*?)[–\-](.*)\s+(.*)$/);
        return match ? {
          horaInicio: match[1].trim(),
          horaFin: match[2].trim(),
          actividad: match[3].trim()
        } : { actividad: linea.trim() };
      });

      await updateDoc(doc(db, 'grupos', docId), {
        [`itinerario.${fecha}`]: actividades
      });

      await addDoc(collection(db, 'historial'), {
        numeroNegocio: docId,
        campo: `itinerario.${fecha}`,
        anterior: original,
        nuevo: nuevo,
        modificadoPor: userEmail,
        timestamp: new Date()
      });

      $td.attr('data-original', nuevo);
    }
  });

  $('#btn-view-history').off('click').on('click', async () => {
    await recargarHistorial();
    $('#modalHistorial').show();
  });

  $('#btn-close-history').on('click', () => $('#modalHistorial').hide());
  $('#btn-refresh-history').on('click', recargarHistorial);
}

async function recargarHistorial() {
  const $tabla = $('#tablaHistorial');
  const snap = await getDocs(query(collection(db, 'historial'), orderBy('timestamp', 'desc')));
  const $tb = $tabla.find('tbody').empty();

  snap.forEach(doc => {
    const d = doc.data();
    const fecha = d.timestamp?.toDate?.();
    if (!fecha) return;
    $tb.append(`
      <tr>
        <td>${fecha.toLocaleString('es-CL')}</td>
        <td>${d.modificadoPor || d.usuario}</td>
        <td>${d.numeroNegocio || ''}</td>
        <td>${d.accion || d.campo}</td>
        <td>${d.anterior || ''}</td>
        <td>${d.nuevo || ''}</td>
      </tr>
    `);
  });

  if ($.fn.DataTable.isDataTable('#tablaHistorial')) {
    $('#tablaHistorial').DataTable().destroy();
  }

  dtHist = $('#tablaHistorial').DataTable({
    language: { url: '//cdn.datatables.net/plug-ins/1.13.4/i18n/es-ES.json' },
    order: [[0, 'desc']],
    dom: 'ltip',
    pageLength: 15
  });
}

function formatearFechaBonita(fechaISO) {
  const fecha = new Date(fechaISO);
  const opciones = { day: 'numeric', month: 'short' };
  return fecha.toLocaleDateString('es-CL', opciones);
}

// Exportar
document.getElementById('btn-export-excel').addEventListener('click', () => {
  const tabla = $('#tablaCalendario').DataTable();
  const rows = tabla.rows({ search: 'applied' }).data().toArray();
  const headers = $("#tablaCalendario thead th").toArray().map(th => th.innerText);
  const datos = rows.map(row => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = row[i]);
    return obj;
  });

  const ws = XLSX.utils.json_to_sheet(datos, { header: headers });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Calendario");
  XLSX.writeFile(wb, "calendario.xlsx");
});
