// contador.js

// ———————————————————————————————
// 1️⃣ Importes de Firebase
// ———————————————————————————————
import { app, db } from './firebase-init.js';
import {
  getDocs, getDoc, collection, doc, updateDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';
import {
  getAuth, onAuthStateChanged, signOut
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';

// ———————————————————————————————
// 2️⃣ Estado global
// ———————————————————————————————
let grupos = [];               // documentos de 'grupos'
let fechasOrdenadas = [];      // ['YYYY-MM-DD', ...] con pax > 0
let proveedores = {};          // mapa proveedor -> {contacto, correo}

// ———————————————————————————————
// 3️⃣ Referencias DOM
// ———————————————————————————————
const thead = document.getElementById('thead-actividades');
const tbody = document.getElementById('tbody-actividades');

// ———————————————————————————————
// 4️⃣ Sesión Firebase
// ———————————————————————————————
const auth = getAuth(app);
onAuthStateChanged(auth, user => {
  if (!user) location.href = 'login.html';
  else init();
});
document.getElementById('logoutBtn')?.addEventListener('click', () => signOut(auth));

// —————————————————————————————————————————————————————
// 5️⃣ Init: carga datos y arma tabla
// —————————————————————————————————————————————————————
async function init() {
  // 5.1 Grupos
  const gruposSnap = await getDocs(collection(db, 'grupos'));
  grupos = gruposSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  // 5.2 Servicios (Servicios/{destino}/Listado)
  const servicios = [];
  const serviciosRoot = await getDocs(collection(db, 'Servicios'));
  for (const destinoDoc of serviciosRoot.docs) {
    const destino = destinoDoc.id;
    const listadoSnap = await getDocs(collection(db, 'Servicios', destino, 'Listado'));
    listadoSnap.docs.forEach(sDoc => {
      const data = sDoc.data();
      servicios.push({
        destino,
        nombre: sDoc.id,
        proveedor: data.proveedor || data.Proveedor || ''
      });
    });
  }

  // 5.3 Proveedores (todas las regiones)
  const proveedoresLocal = {};
  const regionesSnap = await getDocs(collection(db, 'Proveedores'));
  for (const regionDoc of regionesSnap.docs) {
    const listadoSnap = await getDocs(collection(db, 'Proveedores', regionDoc.id, 'Listado'));
    listadoSnap.docs.forEach(pSnap => {
      const d = pSnap.data();
      if (d.proveedor) {
        proveedoresLocal[d.proveedor] = {
          contacto: d.contacto || '',
          correo:   d.correo   || ''
        };
      }
    });
  }
  proveedores = proveedoresLocal;

  // 5.4 Fechas únicas con pax > 0
  const fechasSet = new Set();
  grupos.forEach(g => {
    const itin = g.itinerario || {};
    Object.entries(itin).forEach(([fecha, acts]) => {
      if (acts.some(a => (parseInt(a.adultos)||0) + (parseInt(a.estudiantes)||0) > 0)) {
        fechasSet.add(fecha);
      }
    });
  });
  fechasOrdenadas = Array.from(fechasSet).sort();

  // 5.5 <thead> con data-fecha en cada th de fecha
  thead.innerHTML = `
    <tr>
      <th class="sticky-col sticky-header">Actividad</th>
      <th>Destino</th>
      <th>Proveedor</th>
      <th>Reserva</th>
      ${fechasOrdenadas.map(f => `<th data-fecha="${f}">${formatearFechaBonita(f)}</th>`).join('')}
    </tr>`;

  // 5.6 Orden lógico de servicios
  servicios.sort((a, b) => (a.destino + a.nombre).localeCompare(b.destino + b.nombre));

  // 5.7 Prefetch de reservas (por servicio)
  const referencias = servicios.map(s => doc(db, 'Servicios', s.destino, 'Listado', s.nombre));
  const snapshots = await Promise.all(referencias.map(ref => getDoc(ref)));
  const todosLosReservas = snapshots.map(snap =>
    (snap.exists() && snap.data().reservas) ? snap.data().reservas : {}
  );

  // 5.8 Filas HTML (métricas por fecha)
  let rowsHTML = servicios.map((servicio, i) => {
    const reservas = todosLosReservas[i];

    const fechasConPax = fechasOrdenadas.filter(fecha =>
      grupos.some(g => (g.itinerario?.[fecha]||[]).some(a => a.actividad === servicio.nombre))
    );
    const todasEnviadas = fechasConPax.every(fecha => reservas[fecha]?.estado === 'ENVIADA');
    const tieneAlguna = Object.keys(reservas).length > 0;
    const textoBtn = !tieneAlguna ? 'CREAR' : (todasEnviadas ? 'ENVIADA' : 'PENDIENTE');

    const provInfo = proveedores[servicio.proveedor] || {};
    const proveedorStr = provInfo.contacto ? servicio.proveedor : '-';

    let fila = `
      <tr>
        <td class="sticky-col">${servicio.nombre}</td>
        <td>${servicio.destino}</td>
        <td>${proveedorStr}</td>
        <td>
          <button class="btn-reserva"
                  data-destino="${servicio.destino}"
                  data-actividad="${servicio.nombre}"
                  data-proveedor="${servicio.proveedor}">
            ${textoBtn}
          </button>
        </td>`;

    fechasOrdenadas.forEach(fecha => {
      const totalPax = grupos.reduce((sum, g) => {
        return sum + (g.itinerario?.[fecha]||[])
          .filter(a => a.actividad === servicio.nombre)
          .reduce((s2, a) => s2 + ((parseInt(a.adultos)||0) + (parseInt(a.estudiantes)||0)), 0);
      }, 0);

      const groupCount = grupos.filter(g =>
        (g.itinerario?.[fecha]||[]).some(a => a.actividad === servicio.nombre)
      ).length;

      fila += `
        <td class="celda-interactiva"
            data-info='${JSON.stringify({ actividad: servicio.nombre, fecha })}'
            style="cursor:pointer;color:#0055a4;text-decoration:underline;">
          ${totalPax} (${groupCount})
        </td>`;
    });

    return fila + '</tr>';
  }).join('');
  tbody.innerHTML = rowsHTML;

  // 5.9 Delegación de eventos de la tabla
  tbody.addEventListener('click', e => {
    if (e.target.matches('.btn-reserva')) {
      abrirModalReserva({ currentTarget: e.target });
    }
    const celda = e.target.closest('.celda-interactiva');
    if (celda) {
      const { actividad, fecha } = JSON.parse(celda.dataset.info);
      mostrarGruposCoincidentes(actividad, fecha);
    }
  });

  // 5.10 DataTables (búsqueda OR por comas, ignora tildes, export respeta visible/filtrado)
  function stripAccents(s) {
    return (s || '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }
  $.fn.dataTable.ext.type.search.string = d => stripAccents(d);

  const table = $('#tablaConteo').DataTable({
    scrollX: true,
    paging: false,
    fixedHeader: { header: true, headerOffset: 90 },
    fixedColumns: { leftColumns: 1 },
    dom: 'Bfrtip',
    language: { url: 'https://cdn.datatables.net/plug-ins/1.13.4/i18n/es-ES.json' },
    buttons: [
      { extend: 'colvis', text: 'Ver columnas' },
      {
        extend: 'excelHtml5',
        text: 'Descargar Excel',
        exportOptions: { columns: ':visible', modifier: { search: 'applied' } }
      },
      { text: 'Estadísticas', action: () => abrirModalEstadisticas(table) }
    ],
    initComplete: function () {
      const api = this.api();

      // Poblado del select de destino (col 1)
      const destinos = new Set(api.column(1).data().toArray());
      destinos.forEach(d => $('#filtroDestino').append(new Option(d, d)));

      // Buscador: OR por comas/; ignorando tildes
      $('#buscador').on('keyup', () => {
        const val = stripAccents($('#buscador').val());
        const terms = val.split(/[,;]+/).map(t => t.trim()).filter(Boolean);
        if (!terms.length) { api.search('').draw(); return; }
        const rex = '(' + terms.map(t => t.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')).join('|') + ')';
        api.search(rex, true, false).draw();
      });

      // Filtro por destino
      $('#filtroDestino').on('change', () => {
        const v = $('#filtroDestino').val();
        if (!v) api.column(1).search('').draw();
        else {
          const vEsc = v.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
          api.column(1).search(`^${vEsc}$`, true, false).draw();
        }
      });
    }
  });

  // 5.11 Botones del modal de Reserva
  document.getElementById('btnCerrarReserva').onclick = () =>
    document.getElementById('modalReserva').style.display = 'none';
  document.getElementById('btnGuardarPendiente').onclick = guardarPendiente;
  document.getElementById('btnEnviarReserva').onclick = enviarReserva;

  // (Opcional) Botón "Actualizar" del modal detalle: reajusta columnas si ya existe
  const btnAct = document.getElementById('btnActualizarModal');
  if (btnAct) {
    btnAct.onclick = () => {
      if ($.fn.DataTable.isDataTable('#tablaModal')) {
        $('#tablaModal').DataTable().columns.adjust().draw(false);
      }
    };
  }
}

// —————————————————————————————————————————————
// 6️⃣ Reserva (abrir/guardar/enviar)
// —————————————————————————————————————————————
async function abrirModalReserva(event) {
  const btn       = event.currentTarget;
  const destino   = btn.dataset.destino;
  const actividad = btn.dataset.actividad;
  const fecha = fechasOrdenadas.find(f =>
    (grupos.some(g => g.itinerario?.[f]?.some(a=>a.actividad===actividad)))
  );
  const proveedor = btn.dataset.proveedor;

  const provInfo  = proveedores[proveedor] || { contacto:'', correo:'' };
  document.getElementById('modalPara').value   = provInfo.correo;
  document.getElementById('modalAsunto').value = `Reserva: ${actividad} en ${destino}`;

  // Arma cuerpo con totales por fecha
  const perDateData = fechasOrdenadas
    .map(fecha => {
      const lista = grupos.filter(g =>
        (g.itinerario?.[fecha] || []).some(a => a.actividad === actividad)
      );
      const paxTotal = lista.reduce((sum, g) => sum + (parseInt(g.cantidadgrupo) || 0), 0);
      return { fecha, lista, paxTotal };
    })
    .filter(d => d.lista.length > 0);

  const totalGlobal = perDateData.reduce((sum, d) => sum + d.paxTotal, 0);
  const gruposUnicos = new Set();
  perDateData.forEach(({ lista }) => lista.forEach(g => gruposUnicos.add(g.id)));
  const totalGrupos = gruposUnicos.size;

  let cuerpo = `Estimado/a ${provInfo.contacto || ''}:\n\n`;
  cuerpo += `A continuación se envía detalle de reserva para:\n\n`;
  cuerpo += `Actividad: ${actividad}\n`;
  cuerpo += `Destino: ${destino}\n`;
  cuerpo += `Total Grupos: (${totalGrupos})\n`;
  cuerpo += `Total PAX: (${totalGlobal})\n\n`;
  cuerpo += `Fechas y grupos:\n\n`;
  perDateData.forEach(({ fecha, lista, paxTotal }) => {
    cuerpo += `➡️ Fecha ${formatearFechaBonita(fecha)} - Grupos (${lista.length}) - PAX (${paxTotal}):\n\n`;
    lista.forEach(g => {
      cuerpo += `  - N°: ${g.id}, Colegio: ${g.nombreGrupo}, Cantidad de Pax: ${g.cantidadgrupo}\n`;
    });
    cuerpo += `\n`;
  });
  cuerpo += `Atte.\nOperaciones RaiTrai`;

  document.getElementById('modalCuerpo').value = cuerpo;

  // Guarda datos en botones del modal
  const btnPend = document.getElementById('btnGuardarPendiente');
  btnPend.dataset.destino   = destino;
  btnPend.dataset.actividad = actividad;
  btnPend.dataset.fecha     = fecha;

  const btnEnv = document.getElementById('btnEnviarReserva');
  btnEnv.dataset.destino    = destino;
  btnEnv.dataset.actividad  = actividad;

  document.getElementById('modalReserva').style.display = 'block';
}

async function guardarPendiente() {
  const btn       = document.getElementById('btnGuardarPendiente');
  const destino   = btn.dataset.destino;
  const actividad = btn.dataset.actividad;
  const fecha     = btn.dataset.fecha;
  const cuerpo    = document.getElementById('modalCuerpo').value;

  const ref = doc(db, 'Servicios', destino, 'Listado', actividad);
  await updateDoc(ref, { [`reservas.${fecha}`]: { estado: 'PENDIENTE', cuerpo } });

  document.querySelector(`.btn-reserva[data-actividad="${actividad}"]`).textContent = 'PENDIENTE';
  document.getElementById('modalReserva').style.display = 'none';
}

async function enviarReserva() {
  const btn       = document.getElementById('btnEnviarReserva');
  const destino   = btn.dataset.destino;
  const actividad = btn.dataset.actividad;
  const para      = document.getElementById('modalPara').value.trim();
  const asunto    = document.getElementById('modalAsunto').value.trim();
  const cuerpo    = document.getElementById('modalCuerpo').value;

  // Abre redacción de Gmail
  const baseUrl = 'https://mail.google.com/mail/u/0/?view=cm&fs=1';
  const params  = [`to=${encodeURIComponent(para)}`, `su=${encodeURIComponent(asunto)}`, `body=${encodeURIComponent(cuerpo)}`].join('&');
  window.open(`${baseUrl}&${params}`, '_blank');

  // Guarda ENVIADA por cada fecha con pax>0
  try {
    const ref = doc(db, 'Servicios', destino, 'Listado', actividad);
    const payload = {};

    for (const f of fechasOrdenadas) {
      const totalEnviado = grupos.reduce((sum, g) => {
        const acts = g.itinerario?.[f] || [];
        const t = acts
          .filter(a => a.actividad === actividad)
          .reduce((acc, a) => acc + ((parseInt(a.adultos)||0) + (parseInt(a.estudiantes)||0)), 0);
        return sum + t;
      }, 0);

      if (totalEnviado > 0) {
        payload[`reservas.${f}`] = { estado: 'ENVIADA', cuerpo, totalEnviado };
      }
    }

    if (Object.keys(payload).length > 0) await updateDoc(ref, payload);

    const boton = document.querySelector(`.btn-reserva[data-actividad="${actividad}"][data-destino="${destino}"]`);
    if (boton) boton.textContent = 'ENVIADA';
    document.getElementById('modalReserva').style.display = 'none';
  } catch (err) {
    console.error('Error al guardar ENVIADA por fecha:', err);
    alert('No se pudo guardar el estado ENVIADA en Firestore. Revisa la consola.');
  }
}

// —————————————————————————————————————————————
// 7️⃣ Modal “Detalle de grupos” (click en celda)
//     → usa el mismo renderer DataTables que el de estadísticas
// —————————————————————————————————————————————
function mostrarGruposCoincidentes(actividad, fecha) {
  const lista = grupos
    .filter(g => (g.itinerario?.[fecha] || []).some(a => a.actividad === actividad))
    .map(g => ({ numeroNegocio: g.id, nombreGrupo: g.nombreGrupo, cantidadgrupo: g.cantidadgrupo, programa: g.programa }));

  const totalGrupos = lista.length;
  const totalPAX = lista.reduce((sum, g) => sum + (parseInt(g.cantidadgrupo, 10) || 0), 0);

  document.querySelector('#modalDetalle h3').textContent =
    `Detalle de grupos para el día ${formatearFechaBonita(fecha)} — Total PAX: ${totalPAX} — Total Grupos: ${totalGrupos}`;

  // Prepara rows para DataTables
  const dataRows = (!lista.length)
    ? []
    : lista.map(g => [g.numeroNegocio, g.nombreGrupo || '', parseInt(g.cantidadgrupo,10)||0, g.programa || '']);

  renderTablaModal(dataRows);            // ← DataTables renderiza/ordena
  const modalDet = document.getElementById('modalDetalle');
  modalDet.style.zIndex = '11000';
  modalDet.style.display = 'block';
}

// ————————————————————————————————————————
// 8️⃣ Utilidades varias
// ————————————————————————————————————————
function formatearFechaBonita(iso) {
  const [yyyy, mm, dd] = iso.split('-');
  return `${dd}/${mm}`;
}
function escapeRegExp(text) {
  return text.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
}

// ========== ESTADÍSTICAS (respetando filtros/visibles) ==========
function getContextoVisible(table) {
  // Filas visibles (por búsqueda/filtros)
  const rows = table.rows({ search: 'applied' }).nodes().toArray();
  const pares = rows.map(row => {
    const c0 = row.cells[0]?.textContent?.trim() || '';
    const c1 = row.cells[1]?.textContent?.trim() || '';
    return { actividad: c0, destino: c1, key: `${c0}|||${c1}` };
  });
  const map = new Map();
  pares.forEach(p => { if (!map.has(p.key)) map.set(p.key, p); });

  // Fechas visibles = columnas visibles con data-fecha
  const fechasVisibles = [];
  table.columns().every(function () {
    const th = this.header();
    const iso = th?.dataset?.fecha;
    if (iso && this.visible()) fechasVisibles.push(iso);
  });

  return {
    paresVisibles: Array.from(map.values()),     // [{actividad, destino}]
    fechasVisibles,                              // ['YYYY-MM-DD', ...]
    actividadesSet: new Set(Array.from(map.values()).map(p => p.actividad))
  };
}

function sumarPaxDeActividadEnFechas(g, actividad, fechas) {
  let total = 0;
  for (const f of fechas) {
    const acts = g.itinerario?.[f] || [];
    total += acts
      .filter(a => a.actividad === actividad)
      .reduce((s, a) => s + ((parseInt(a.adultos)||0) + (parseInt(a.estudiantes)||0)), 0);
  }
  return total;
}

function abrirModalEstadisticas(table) {
  const ctx = getContextoVisible(table);
  window.__ctxStats = ctx;
  if (!ctx.paresVisibles.length || !ctx.fechasVisibles.length) {
    alert('No hay actividades o fechas visibles para calcular.');
    return;
  }

  // Defaults del UI
  const elModo    = document.getElementById('modoCombinacion');
  const elAlc     = document.getElementById('alcanceCombinacion');
  const elKMax    = document.getElementById('nivelMax');
  const elSoloMax = document.getElementById('soloTamMax');
  if (elModo) elModo.value = 'exacto';
  if (elAlc)  elAlc.value  = 'viaje';
  if (elKMax) elKMax.value = String(ctx.actividadesSet.size); // auto N
  if (elSoloMax) elSoloMax.checked = false;

  pintarStatsActividad(ctx);
  pintarStatsFecha(ctx);
  recalcularCombinaciones(ctx);

  document.getElementById('btnRecalcularStats').onclick = () => recalcularCombinaciones(ctx);
  document.getElementById('btnCerrarStats').onclick = () =>
    (document.getElementById('modalEstadisticas').style.display = 'none');
  document.getElementById('btnExportarStatsExcel').onclick = exportarEstadisticasExcel;

  document.getElementById('modalEstadisticas').style.display = 'block';
}

function pintarStatsActividad(ctx) {
  const tbody = document.getElementById('statsActividadBody');
  tbody.innerHTML = '';
  let totalPax = 0;
  const gruposUnicos = new Set();

  ctx.paresVisibles.forEach(({ actividad, destino }) => {
    let pax = 0;
    const gSet = new Set();
    for (const g of grupos) {
      const t = sumarPaxDeActividadEnFechas(g, actividad, ctx.fechasVisibles);
      if (t > 0) { pax += t; gSet.add(g.id); }
    }
    totalPax += pax;
    gSet.forEach(id => gruposUnicos.add(id));

    const btn = `<button class="ver-grupos"
      data-ids="${Array.from(gSet).join(',')}"
      data-titulo="Grupos — ${actividad} (${destino})"
      data-context="actividad"
      data-actividad="${encodeURIComponent(actividad)}"
    >Ver grupos</button>`;

    tbody.insertAdjacentHTML('beforeend', `
      <tr>
        <td>${actividad}</td>
        <td>${destino}</td>
        <td>${pax}</td>
        <td>${gSet.size}</td>
        <td>${btn}</td>
      </tr>`);
  });

  document.getElementById('statsActividadTotalPax').textContent = totalPax;
  document.getElementById('statsActividadTotalGrupos').textContent = gruposUnicos.size;

  tbody.onclick = (e) => {
    const b = e.target.closest('.ver-grupos');
    if (!b) return;
    const ids = (b.dataset.ids || '').split(',').filter(Boolean);
    mostrarListaDeGrupos(ids, b.dataset.titulo || 'Grupos', b.dataset);
  };
}

function pintarStatsFecha(ctx) {
  const tbody = document.getElementById('statsFechaBody');
  tbody.innerHTML = '';
  const actsVisibles = ctx.actividadesSet;

  ctx.fechasVisibles.forEach(fecha => {
    let pax = 0;
    const gSet = new Set();

    for (const g of grupos) {
      const acts = g.itinerario?.[fecha] || [];
      const t = acts
        .filter(a => actsVisibles.has(a.actividad))
        .reduce((s, a) => s + ((parseInt(a.adultos)||0) + (parseInt(a.estudiantes)||0)), 0);
      if (t > 0) { pax += t; gSet.add(g.id); }
    }

    const btn = `<button class="ver-grupos"
      data-ids="${Array.from(gSet).join(',')}"
      data-titulo="Grupos — ${formatearFechaBonita(fecha)}"
      data-context="fecha"
      data-fecha="${fecha}"
    >Ver grupos</button>`;

    tbody.insertAdjacentHTML('beforeend', `
      <tr>
        <td>${formatearFechaBonita(fecha)}</td>
        <td>${pax}</td>
        <td>${gSet.size}</td>
        <td>${btn}</td>
      </tr>`);
  });

  tbody.onclick = (e) => {
    const b = e.target.closest('.ver-grupos');
    if (!b) return;
    const ids = (b.dataset.ids || '').split(',').filter(Boolean);
    mostrarListaDeGrupos(ids, b.dataset.titulo || 'Grupos', b.dataset);
  };
}

// ———  Combinaciones observadas (EXACTO por defecto)
function recalcularCombinaciones(ctx) {
  const modoEl    = document.getElementById('modoCombinacion');
  const alcanceEl = document.getElementById('alcanceCombinacion');
  const kMaxEl    = document.getElementById('nivelMax');
  const soloMaxEl = document.getElementById('soloTamMax');

  const modo     = (modoEl?.value || 'exacto');   // exacto | incluye
  const alcance  = (alcanceEl?.value || 'viaje'); // viaje | dia
  const kMax     = parseInt(kMaxEl?.value || '999', 10);
  const soloMax  = !!(soloMaxEl?.checked);

  const actsVisibles = new Set(ctx.actividadesSet);
  const nVisibles    = actsVisibles.size;

  const cuerpo = document.getElementById('statsCombosBody');
  cuerpo.innerHTML = '';

  const combosMap = new Map(); // key -> Set(ids)

  const keyFromSet = (set) => Array.from(set).sort((a,b)=>a.localeCompare(b)).join(' + ');
  const addCombo = (key, id) => {
    if (!combosMap.has(key)) combosMap.set(key, new Set());
    combosMap.get(key).add(id);
  };
  const genSubsetsK = (arr, k, cb) => {
    const n = arr.length, idx = [];
    const back = (start, depth) => {
      if (depth === k) { cb(idx.map(i => arr[i]).sort().join(' + ')); return; }
      for (let i = start; i < n; i++) { idx.push(i); back(i+1, depth+1); idx.pop(); }
    };
    back(0, 0);
  };

  for (const g of grupos) {
    if (alcance === 'viaje') {
      const setViaje = new Set();
      for (const f of ctx.fechasVisibles) {
        const acts = g.itinerario?.[f] || [];
        for (const a of acts) if (actsVisibles.has(a.actividad)) setViaje.add(a.actividad);
      }
      if (setViaje.size === 0) continue;

      if (modo === 'exacto') {
        if (setViaje.size <= kMax) addCombo(keyFromSet(setViaje), g.id);
      } else {
        const arr = Array.from(setViaje);
        const maxK = Math.min(kMax, arr.length);
        const minK = soloMax ? nVisibles : 1;
        if (minK <= maxK) {
          for (let k = minK; k <= maxK; k++) genSubsetsK(arr, k, (key) => addCombo(key, g.id));
        }
      }

    } else { // mismo día
      for (const f of ctx.fechasVisibles) {
        const setDia = new Set(
          (g.itinerario?.[f] || [])
            .filter(a => actsVisibles.has(a.actividad))
            .map(a => a.actividad)
        );
        if (setDia.size === 0) continue;

        if (modo === 'exacto') {
          if (setDia.size <= kMax) addCombo(keyFromSet(setDia), g.id);
        } else {
          const arr = Array.from(setDia);
          const maxK = Math.min(kMax, arr.length);
          const minK = soloMax ? nVisibles : 1;
          if (minK <= maxK) {
            for (let k = minK; k <= maxK; k++) genSubsetsK(arr, k, (key) => addCombo(key, g.id));
          }
        }
      }
    }
  }

  // Filtro "solo tamaño máximo" para EXACTO
  if (soloMax && modo === 'exacto') {
    for (const key of Array.from(combosMap.keys())) {
      const size = key.split(' + ').length;
      if (size !== nVisibles) combosMap.delete(key);
    }
  }

  // Ordena por tamaño y alfabético
  const sorted = Array.from(combosMap.entries()).sort((a, b) => {
    const sa = a[0].split(' + ').length, sb = b[0].split(' + ').length;
    if (sa !== sb) return sa - sb;
    return a[0].localeCompare(b[0]);
  });

  sorted.forEach(([key, idSet]) => {
    const idsCsv = Array.from(idSet).join(',');
    const btn = `<button class="ver-grupos"
      data-ids="${idsCsv}"
      data-titulo="Grupos — ${key}"
      data-context="combo"
      data-combo="${key.split(' + ').map(encodeURIComponent).join(',')}"
      data-alcance="${alcance}"
      data-modo="${modo}"
    >Ver grupos</button>`;

    cuerpo.insertAdjacentHTML('beforeend', `
      <tr>
        <td>${key}</td>
        <td>${idSet.size}</td>
        <td>${btn}</td>
      </tr>`);
  });

  cuerpo.onclick = (e) => {
    const b = e.target.closest('.ver-grupos');
    if (!b) return;
    const ids = (b.dataset.ids || '').split(',').filter(Boolean);
    mostrarListaDeGrupos(ids, b.dataset.titulo || 'Grupos', b.dataset);
  };
}

// ———  Modal “Ver grupos” reutilizable desde Estadísticas
function mostrarListaDeGrupos(ids, titulo, dataset = {}) {
  const lista = grupos.filter(g => ids.includes(g.id));
  const ctx = window.__ctxStats || { fechasVisibles: [], actividadesSet: new Set() };

  // PAX según contexto (actividad, fecha, combo)
  function paxSegunContexto(g) {
    const ctxType = dataset.context || '';
    if (ctxType === 'actividad') {
      const act = decodeURIComponent(dataset.actividad || '');
      return ctx.fechasVisibles.reduce((sum, f) => {
        const acts = g.itinerario?.[f] || [];
        return sum + acts
          .filter(a => a.actividad === act)
          .reduce((s, a) => s + ((parseInt(a.adultos)||0) + (parseInt(a.estudiantes)||0)), 0);
      }, 0);
    }
    if (ctxType === 'fecha') {
      const fsel = dataset.fecha;
      const acts = g.itinerario?.[fsel] || [];
      return acts
        .filter(a => ctx.actividadesSet.has(a.actividad))
        .reduce((s, a) => s + ((parseInt(a.adultos)||0) + (parseInt(a.estudiantes)||0)), 0);
    }
    if (ctxType === 'combo') {
      const comboActs = (dataset.combo || '').split(',').map(x => decodeURIComponent(x)).filter(Boolean);
      const alcance = dataset.alcance || 'viaje';
      const modo    = dataset.modo || 'exacto';

      if (alcance === 'viaje') {
        return ctx.fechasVisibles.reduce((sum, f) => {
          const acts = g.itinerario?.[f] || [];
          return sum + acts
            .filter(a => comboActs.includes(a.actividad))
            .reduce((s, a) => s + ((parseInt(a.adultos)||0) + (parseInt(a.estudiantes)||0)), 0);
        }, 0);
      } else {
        // mismo día: suma SOLO en días que cumplen la condición
        let total = 0;
        for (const f of ctx.fechasVisibles) {
          const acts = g.itinerario?.[f] || [];
          const setDia = new Set(acts.filter(a => ctx.actividadesSet.has(a.actividad)).map(a => a.actividad));
          const comboSet = new Set(comboActs);

          const cumpleExacto = () => (setDia.size === comboSet.size) && [...comboSet].every(a => setDia.has(a));
          const cumpleIncluye = () => [...comboSet].every(a => setDia.has(a));
          const ok = (modo === 'exacto') ? cumpleExacto() : cumpleIncluye();

          if (ok) {
            total += acts
              .filter(a => comboActs.includes(a.actividad))
              .reduce((s, a) => s + ((parseInt(a.adultos)||0) + (parseInt(a.estudiantes)||0)), 0);
          }
        }
        return total;
      }
    }
    return parseInt(g.cantidadgrupo, 10) || 0;
  }

  // Título con totales
  const totalPaxSeleccion = lista.reduce((sum, g) => sum + paxSegunContexto(g), 0);
  document.querySelector('#modalDetalle h3').textContent =
    `${titulo} — Total grupos: ${lista.length} — Total PAX: ${totalPaxSeleccion}`;

  // Filas para DataTables (no manipulamos el DOM del tbody a mano)
  const dataRows = (!lista.length)
    ? []
    : lista.map(g => {
        const pax = paxSegunContexto(g);
        return [g.id, g.nombreGrupo || '', pax, g.programa || ''];
      });

  renderTablaModal(dataRows);  // DataTables pinta y permite ordenar
  const modalDet = document.getElementById('modalDetalle');
  modalDet.style.zIndex = '11000';
  modalDet.style.display = 'block';
}

// —————————————————————————————————————————————
// 9️⃣ Excel del modal de estadísticas (3 hojas)
// —————————————————————————————————————————————
function tableToAOA(tableEl, dropLast = false) {
  const aoa = [];
  const pushRow = (row) => {
    const cells = Array.from(row.cells).map(td => (td.innerText || '').trim());
    if (dropLast && cells.length) cells.pop(); // Quita "Ver grupos"
    aoa.push(cells);
  };
  if (tableEl.tHead)  Array.from(tableEl.tHead.rows).forEach(pushRow);
  if (tableEl.tBodies?.[0]) Array.from(tableEl.tBodies[0].rows).forEach(pushRow);
  if (tableEl.tFoot)  Array.from(tableEl.tFoot.rows).forEach(pushRow);
  return aoa;
}

function exportarEstadisticasExcel() {
  try {
    const modal = document.getElementById('modalEstadisticas');
    const tAct = modal.querySelector('#tablaStatsActividad');
    const tFec = modal.querySelector('#tablaStatsFecha');
    const tCom = modal.querySelector('#tablaStatsCombos');

    if (!tAct || !tFec || !tCom) {
      alert('No se encuentran las tablas de estadísticas en el DOM.');
      return;
    }

    const aoaAct = tableToAOA(tAct, true);
    const aoaFec = tableToAOA(tFec, true);
    const aoaCom = tableToAOA(tCom, true);

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoaAct), 'Resumen_Actividad');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoaFec), 'Totales_Fecha');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoaCom), 'Combinaciones');

    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth()+1).padStart(2,'0');
    const dd = String(d.getDate()).padStart(2,'0');
    const hh = String(d.getHours()).padStart(2,'0');
    const mi = String(d.getMinutes()).padStart(2,'0');
    XLSX.writeFile(wb, `Estadisticas_Actividades_${yyyy}-${mm}-${dd}_${hh}${mi}.xlsx`);
  } catch (err) {
    console.error('Error exportando estadísticas:', err);
    alert('No se pudo generar el Excel de estadísticas. Revisa la consola.');
  }
}

// —————————————————————————————————————————————
// 🔧 Renderer único para el modal “Ver grupos” con DataTables
//     - Evita manipular <tbody> manualmente.
//     - Soporta orden por click en encabezados.
// —————————————————————————————————————————————
function renderTablaModal(dataRows) {
  const sel = '#tablaModal';

  if ($.fn.DataTable.isDataTable(sel)) {
    const dt = $(sel).DataTable();
    dt.clear();
    dt.rows.add(dataRows);
    dt.draw();
  } else {
    $(sel).DataTable({
      data: dataRows,
      columns: [
        { data: 0, title: 'N° Negocio' },
        { data: 1, title: 'Nombre Grupo' },
        { data: 2, title: 'PAX' },
        { data: 3, title: 'Programa' }
      ],
      paging: false,
      searching: false,
      info: false,
      order: [], // sin orden inicial
      columnDefs: [
        { targets: 2, type: 'num' } // PAX como numérico
        // Si N° Negocio es numérico puro, puedes añadir:
        // { targets: 0, type: 'num' }
      ],
      language: {
        url: 'https://cdn.datatables.net/plug-ins/1.13.4/i18n/es-ES.json'
      }
    });
  }
}
