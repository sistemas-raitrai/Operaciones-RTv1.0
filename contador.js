// contador.js

// ———————————————————————————————
// 1️⃣ Importes de Firebase
// ———————————————————————————————
import { app, db } from './firebase-init.js';
import {
  getDocs, getDoc, collection, doc, updateDoc, serverTimestamp
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
let reservaActualSnapshot = null;
let ultimaVerificacionPagos = null;
const API_PAGOS_URL = '/api/pagos';

// ===== [NUEVO] Índice de vuelos por grupo (root collection 'vuelos') =====
let IDX_VUELOS_POR_GRUPO = new Map();

// Helpers para leer campos con múltiples nombres posibles
const _val = (o, k) => (o && o[k] != null && String(o[k]).trim() !== '') ? String(o[k]).trim() : '';
function _pick(o, ...cands) {
  for (const c of cands) {
    if (typeof c === 'string') {
      const v = _val(o, c); if (v) return v;
    } else if (c instanceof RegExp) {
      const k = Object.keys(o || {}).find(kk => c.test(kk));
      if (k) { const v = _val(o, k); if (v) return v; }
    }
  }
  return '';
}
const _join = (arr, sep=' · ') => arr.filter(Boolean).join(sep);

// === REEMPLAZO ===
function makeVueloLabel(v) {
  // Identidad del vuelo
  const aerolinea = _pick(v, 'aerolinea', 'proveedor');
  const tipo      = _pick(v, 'tipo', 'tipoVuelo') || (v.isTransfer ? 'TRANSFER' : 'AÉREO');

  // Número(s)
  const numero    = _pick(v, 'numero');
  const numIda    = _pick(v, 'numeroIda', /num.*ida/i);
  const numVta    = _pick(v, 'numeroVuelta', /num.*vuel/i);
  const numeroMix = numero || _join([numIda, numVta], ' // ');

  // Tramo
  const origen    = _pick(v, 'origen', 'origenIda', /origen.*/i, /desde/i);
  const destino   = _pick(v, 'destino', 'destinoIda', /destino.*/i, /hasta/i);
  const tramo     = (origen || destino) ? ` (${origen || '¿?'}→${destino || '¿?'})` : '';

  // Fechas (para matching por día)
  const fechaIda      = _pick(v, 'fechaIda', /fecha.*ida/i, 'idaFecha');
  const fechaVuelta   = _pick(v, 'fechaVuelta', /fecha.*vuel/i, 'vueltaFecha');

  // Horarios IDA
  const presIda   = _pick(v, 'presentacionIdaHora', /presentaci.*ida/i);
  const salIda    = _pick(v, 'salidaIdaHora', /salida.*ida/i, /despegue.*ida/i);
  const arrIda    = _pick(v, 'arriboIdaHora', /arrib.*ida/i, /llegad.*ida/i);

  // Horarios VUELTA
  const presVta   = _pick(v, 'presentacionVueltaHora', /presentaci.*vuel/i);
  const salVta    = _pick(v, 'salidaVueltaHora', /salida.*vuel/i, /despegue.*vuel/i);
  const arrVta    = _pick(v, 'arriboVueltaHora', /arrib.*vuel/i, /llegad.*vuel/i);

  // Cabecera y detalle compactos (una sola línea para la celda)
  const head = _join([numeroMix, aerolinea, tipo]);
  const ida  = _join([
    'Ida:',
    presIda ? `Pres ${presIda}` : '',
    salIda  ? `Sal ${salIda}`   : '',
    arrIda  ? `Arr ${arrIda}`   : '',
    fechaIda
  ], ' | ');
  const vta  = _join([
    'Vuelta:',
    presVta ? `Pres ${presVta}` : '',
    salVta  ? `Sal ${salVta}`   : '',
    arrVta  ? `Arr ${arrVta}`   : '',
    fechaVuelta
  ], ' | ');

  // Resultado final
  return _join([ head + tramo, ida, vta ], '  ||  ');
}

/** Lee todos los vuelos y arma un Map: grupoId -> [ {label, v, idDoc} ] */
// === REEMPLAZO ===
async function buildIndexVuelosPorGrupo() {
  IDX_VUELOS_POR_GRUPO.clear();

  const snap = await getDocs(collection(db, 'vuelos'));
  snap.forEach(ds => {
    const v = ds.data() || {};
    if (v.isTransfer) return; // no mezclar transfers en esta columna

    const label = makeVueloLabel(v);

    // A) grupoIds: ["1412-101", ...]
    const a1 = Array.isArray(v.grupoIds) ? v.grupoIds : [];

    // B) grupos: [{id:"1412-101"}, ...]
    const a2 = Array.isArray(v.grupos) ? v.grupos.map(x => x && x.id).filter(Boolean) : [];

    const todos = [...new Set([...a1, ...a2])]; // únicos

    todos.forEach(keyRaw => {
      const key = String(keyRaw || '').trim();
      if (!key) return;
      const list = IDX_VUELOS_POR_GRUPO.get(key) || [];
      list.push({ idDoc: ds.id, label, v });
      IDX_VUELOS_POR_GRUPO.set(key, list);
    });
  });
}


// === REEMPLAZO ===
function getVuelosLabelForGrupo(grupoKey, fechaISO) {
  const list = IDX_VUELOS_POR_GRUPO.get(String(grupoKey).trim()) || [];
  if (!list.length) return '—';

  const sameDay = (d) => {
    if (!d) return false;
    // d puede venir como "YYYY-MM-DD" o Date/string
    const iso = new Date(d).toISOString().slice(0,10);
    return iso === fechaISO;
  };

  // prioriza el que calza con la fecha del modal
  const prefer = list.find(({ v }) =>
    sameDay(_pick(v, 'fechaIda', /fecha.*ida/i, 'idaFecha')) ||
    sameDay(_pick(v, 'fechaVuelta', /fecha.*vuel/i, 'vueltaFecha')) ||
    sameDay(_pick(v, 'fecha', /date/i))
  );

  if (prefer) return prefer.label;

  // si hay varios, concatenamos
  return list.map(x => x.label).join(' • ');
}


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
  // 5.1 Grupos
  const gruposSnap = await getDocs(collection(db, 'grupos'));
  
  // Año actual automático
  const anoActual = String(new Date().getFullYear());
  
  // Solo grupos del año actual
  grupos = gruposSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(g => String(g.anoViaje || '').trim() === anoActual);

  await buildIndexVuelosPorGrupo();

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
  
  document.getElementById('btnVerificarPaxPagos').onclick = verificarPaxReservaConPagos;
  
  document.getElementById('btnCerrarVerificacionPagos').onclick = () => {
    document.getElementById('modalVerificacionPagos').style.display = 'none';
  };
  
  document.getElementById('btnCerrarDetalleDiferenciaPagos').onclick = () => {
    document.getElementById('modalDetalleDiferenciaPagos').style.display = 'none';
  };
  
  document.getElementById('btnGuardarVerificacionPagos').onclick = abrirModalGuardarVerificacionPagos;
  
  document.getElementById('btnCancelarGuardarVerificacion').onclick = () => {
    document.getElementById('modalGuardarVerificacionPagos').style.display = 'none';
  };
  
  document.getElementById('btnConfirmarGuardarVerificacion').onclick = guardarVerificacionPagosEnReserva;

  // (Opcional) Botón "Actualizar" del modal detalle: reajusta columnas si ya existe
  const btnAct = document.getElementById('btnActualizarModal');
  if (btnAct) {
    btnAct.addEventListener('click', async () => {
      await buildIndexVuelosPorGrupo();
      const S = window.__ULTIMO_DETALLE_MODAL__;
      if (S) {
        mostrarListaDeGrupos(S.ids, S.titulo, S.dataset); // repinta y vuelve a calcular la columna "Vuelo"
      } else if ($.fn.DataTable.isDataTable('#tablaModal')) {
        $('#tablaModal').DataTable().columns.adjust().draw(false);
      }
    });
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
  
  const gruposReservaMap = new Map();
  
  perDateData.forEach(({ lista }) => {
    lista.forEach(g => {
      if (!gruposReservaMap.has(g.id)) {
        gruposReservaMap.set(g.id, {
          id: g.id,
          numeroNegocio: g.numeroNegocio || g.id,
          nombreGrupo: g.nombreGrupo || '',
          paxCorreo: Number(g.cantidadgrupo || g.cantidadGrupo || 0),
        
          adultosCorreo: {
            M: 0,
            F: 0,
            O: Number(g.adultos || 0)
          },
        
          estudiantesCorreo: {
            M: 0,
            F: 0,
            O: Number(g.estudiantes || 0)
          },
        
          totalAdultosCorreo: Number(g.adultos || 0),
          totalEstudiantesCorreo: Number(g.estudiantes || 0)
        });
      }
    });
  });
  
  const totalGrupos = gruposReservaMap.size;
  
  reservaActualSnapshot = {
    destino,
    actividad,
    grupos: Array.from(gruposReservaMap.values())
  };

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
        payload[`reservas.${f}.estado`] = 'ENVIADA';
        payload[`reservas.${f}.cuerpo`] = cuerpo;
        payload[`reservas.${f}.totalEnviado`] = totalEnviado;
        payload[`reservas.${f}.updatedAt`] = serverTimestamp();
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
  // guardamos el último estado para el botón "Actualizar"
  window.__ULTIMO_DETALLE_MODAL__ = { ids, titulo, dataset };

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

  // Filas para DataTables (agregamos "Vuelo" SOLO si el contexto es por fecha)
  const dataRows = (!lista.length)
    ? []
    : lista.map(g => {
        const pax = paxSegunContexto(g);
        const base = [g.id, g.nombreGrupo || '', pax, g.programa || ''];
        if ((dataset.context || '') === 'fecha') {
          const vuelo = getVuelosLabelForGrupo(g.id, dataset.fecha); // ← usa el índice
          base.push(vuelo); // 5ª columna
        }
        return base;
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
  const colCount = dataRows[0]?.length || 4;

  const baseCols = [
    { data: 0, title: 'N° Negocio' },
    { data: 1, title: 'Nombre Grupo' },
    { data: 2, title: 'PAX' },
    { data: 3, title: 'Programa' }
  ];
  const columns = (colCount === 5)
    ? [...baseCols, { data: 4, title: 'Vuelo' }]
    : baseCols;

  if ($.fn.DataTable.isDataTable(sel)) {
    const dt = $(sel).DataTable();
    const currentCols = dt.columns().count();
    if (currentCols !== colCount) {
      dt.destroy();
      $(sel).empty(); // limpia thead/tbody para que DataTables reconstruya los headers
      $(sel).DataTable({
        data: dataRows,
        columns,
        paging: false,
        searching: false,
        info: false,
        order: [],
        columnDefs: [
          { targets: 2, type: 'num' }
        ],
        language: { url: 'https://cdn.datatables.net/plug-ins/1.13.4/i18n/es-ES.json' }
      });
    } else {
      dt.clear();
      dt.rows.add(dataRows);
      dt.draw();
    }
  } else {
    $(sel).DataTable({
      data: dataRows,
      columns,
      paging: false,
      searching: false,
      info: false,
      order: [],
      columnDefs: [
        { targets: 2, type: 'num' }
      ],
      language: { url: 'https://cdn.datatables.net/plug-ins/1.13.4/i18n/es-ES.json' }
    });
  }
}

// =====================================================
// VERIFICACIÓN PAX RESERVA vs SISTEMA DE PAGOS
// =====================================================

async function verificarPaxReservaConPagos() {
  if (!reservaActualSnapshot || !Array.isArray(reservaActualSnapshot.grupos)) {
    alert('Primero abre una reserva.');
    return;
  }

  const resumen = document.getElementById('verificacionPagosResumen');
  const tbody = document.getElementById('verificacionPagosBody');

  resumen.innerHTML = 'Consultando sistema de pagos...';
  tbody.innerHTML = '';

  document.getElementById('modalVerificacionPagos').style.display = 'block';

  const resultados = [];

  for (const g of reservaActualSnapshot.grupos) {
    try {
      const numeroNegocio = g.numeroNegocio || g.id;

      // Si viene fusionado tipo 1581-1582, consulta ambos por separado y suma.
      const numerosPago = obtenerNumerosNegocioPago(numeroNegocio);

      const resumenPagos = await consultarResumenPagosFusionado(numerosPago);

      const paxPagos = resumenPagos.totalViajan;
      const paxCorreo = Number(g.paxCorreo || 0);
      const diferencia = paxPagos - paxCorreo;

      const detalle = construirDetalleDiferencia(g, resumenPagos);

      resultados.push({
        numeroNegocio,
        numerosPago,
        nombreGrupo: g.nombreGrupo || '',
        paxCorreo,
        paxPagos,
        diferencia,
        estado: detalle.tieneDiferenciaReal ? 'DIFERENCIA' : 'OK',

        adultosCorreo: g.adultosCorreo || { M: 0, F: 0, O: 0 },
        estudiantesCorreo: g.estudiantesCorreo || { M: 0, F: 0, O: 0 },
        totalAdultosCorreo: Number(g.totalAdultosCorreo || 0),
        totalEstudiantesCorreo: Number(g.totalEstudiantesCorreo || 0),

        adultosPagos: resumenPagos.adultos,
        estudiantesPagos: resumenPagos.estudiantes,
        totalAdultosPagos: resumenPagos.totalAdultos,
        totalEstudiantesPagos: resumenPagos.totalEstudiantes,

        detalle
      });

    } catch (error) {
      console.error('Error verificando grupo con pagos:', g, error);

      resultados.push({
        numeroNegocio: g.numeroNegocio || g.id,
        numerosPago: obtenerNumerosNegocioPago(g.numeroNegocio || g.id),
        nombreGrupo: g.nombreGrupo || '',
        paxCorreo: Number(g.paxCorreo || 0),
        paxPagos: '',
        diferencia: '',
        estado: 'ERROR CONSULTA',
        detalle: null
      });
    }
  }

  ultimaVerificacionPagos = {
    fecha: new Date().toISOString(),
    destino: reservaActualSnapshot.destino,
    actividad: reservaActualSnapshot.actividad,
    grupos: resultados,
    resumen: calcularResumenVerificacion(resultados)
  };

  renderVerificacionPagos(resultados);
}

function obtenerNumerosNegocioPago(numeroNegocio) {
  const raw = String(numeroNegocio || '').trim();

  if (!raw) return [];

  // Solo fusiona si es exactamente formato num-num, ejemplo: 1581-1582
  // Evita romper IDs tipo 1412-101.
  if (/^\d+\s*-\s*\d+$/.test(raw)) {
    return raw
      .split('-')
      .map(x => x.trim())
      .filter(Boolean);
  }

  return [raw];
}

async function consultarResumenPagosFusionado(numerosPago) {
  const acumulado = crearResumenPagosVacio();

  for (const numero of numerosPago) {
    const url = `${API_PAGOS_URL}?modo=detalle&numeroNegocio=${encodeURIComponent(numero)}`;
    const res = await fetch(url);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} consultando ${numero}`);
    }

    const data = await res.json();

    const pasajeros =
      data?.nominas?.data?.pasajeros ||
      data?.saldos?.data?.detalle_pasajeros ||
      [];

    const resumen = calcularResumenPagosContador(pasajeros);
    sumarResumenPagos(acumulado, resumen);
  }

  return acumulado;
}

function crearResumenPagosVacio() {
  return {
    adultos: { M: 0, F: 0, O: 0 },
    estudiantes: { M: 0, F: 0, O: 0 },
    totalAdultos: 0,
    totalEstudiantes: 0,
    totalViajan: 0,
    totalNoViajan: 0,
    totalLeidos: 0
  };
}

function sumarResumenPagos(base, add) {
  ['M', 'F', 'O'].forEach(k => {
    base.adultos[k] += Number(add.adultos?.[k] || 0);
    base.estudiantes[k] += Number(add.estudiantes?.[k] || 0);
  });

  base.totalAdultos += Number(add.totalAdultos || 0);
  base.totalEstudiantes += Number(add.totalEstudiantes || 0);
  base.totalViajan += Number(add.totalViajan || 0);
  base.totalNoViajan += Number(add.totalNoViajan || 0);
  base.totalLeidos += Number(add.totalLeidos || 0);
}

function construirDetalleDiferencia(g, resumenPagos) {
  const adultosCorreo = g.adultosCorreo || { M: 0, F: 0, O: Number(g.totalAdultosCorreo || 0) };
  const estudiantesCorreo = g.estudiantesCorreo || { M: 0, F: 0, O: Number(g.totalEstudiantesCorreo || 0) };

  const filas = [
    {
      categoria: 'Adultos Masculino',
      correo: Number(adultosCorreo.M || 0),
      pagos: Number(resumenPagos.adultos.M || 0)
    },
    {
      categoria: 'Adultos Femenino',
      correo: Number(adultosCorreo.F || 0),
      pagos: Number(resumenPagos.adultos.F || 0)
    },
    {
      categoria: 'Adultos Otro',
      correo: Number(adultosCorreo.O || 0),
      pagos: Number(resumenPagos.adultos.O || 0)
    },
    {
      categoria: 'Total Adultos',
      correo: Number(g.totalAdultosCorreo || 0),
      pagos: Number(resumenPagos.totalAdultos || 0),
      total: true
    },
    {
      categoria: 'Estudiantes Masculino',
      correo: Number(estudiantesCorreo.M || 0),
      pagos: Number(resumenPagos.estudiantes.M || 0)
    },
    {
      categoria: 'Estudiantes Femenino',
      correo: Number(estudiantesCorreo.F || 0),
      pagos: Number(resumenPagos.estudiantes.F || 0)
    },
    {
      categoria: 'Estudiantes Otro',
      correo: Number(estudiantesCorreo.O || 0),
      pagos: Number(resumenPagos.estudiantes.O || 0)
    },
    {
      categoria: 'Total Estudiantes',
      correo: Number(g.totalEstudiantesCorreo || 0),
      pagos: Number(resumenPagos.totalEstudiantes || 0),
      total: true
    },
    {
      categoria: 'TOTAL',
      correo: Number(g.paxCorreo || 0),
      pagos: Number(resumenPagos.totalViajan || 0),
      total: true
    }
  ];

  filas.forEach(f => {
    f.diferencia = f.pagos - f.correo;
  });

  const diffAdultos =
    Number(resumenPagos.totalAdultos || 0) - Number(g.totalAdultosCorreo || 0);
  
  const diffEstudiantes =
    Number(resumenPagos.totalEstudiantes || 0) - Number(g.totalEstudiantesCorreo || 0);
  
  const diffTotal =
    Number(resumenPagos.totalViajan || 0) - Number(g.paxCorreo || 0);
  
  return {
    filas,
    tieneDiferenciaDetalle: filas.some(f => Number(f.diferencia || 0) !== 0),
    tieneDiferenciaReal: diffAdultos !== 0 || diffEstudiantes !== 0 || diffTotal !== 0
  };
}

function renderVerificacionPagos(resultados) {
  const resumen = document.getElementById('verificacionPagosResumen');
  const tbody = document.getElementById('verificacionPagosBody');

  const conDiferencia = resultados.filter(r => r.estado !== 'OK');

  if (!conDiferencia.length) {
    resumen.innerHTML = `✅ Todos los grupos coinciden con el sistema de pagos. Total grupos revisados: ${resultados.length}.`;
  } else {
    resumen.innerHTML = `⚠️ Hay ${conDiferencia.length} grupo(s) con diferencia o error de consulta.`;
  }

  tbody.innerHTML = resultados.map((r, idx) => {
    const color = r.estado === 'OK' ? '#09832e' : '#ca0a1f';
    const diffTxt = r.diferencia === '' ? '' : (r.diferencia > 0 ? `+${r.diferencia}` : r.diferencia);

    const diffHtml = r.estado === 'DIFERENCIA'
      ? `<button class="btn-diff-pagos"
                 data-idx="${idx}"
                 style="border:0; background:transparent; color:${color}; font-weight:bold; text-decoration:underline; cursor:pointer;">
           ${diffTxt}
         </button>`
      : `<span style="font-weight:bold; color:${color};">${diffTxt}</span>`;

    return `
      <tr>
        <td>${r.numeroNegocio}</td>
        <td>${r.nombreGrupo}</td>
        <td>${r.paxCorreo}</td>
        <td>${r.paxPagos}</td>
        <td>${diffHtml}</td>
        <td style="font-weight:bold; color:${color};">${r.estado}</td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('.btn-diff-pagos').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.idx);
      abrirDetalleDiferenciaPagos(resultados[idx]);
    });
  });
}

function abrirDetalleDiferenciaPagos(r) {
  if (!r || !r.detalle) return;

  document.getElementById('detalleDiffTitulo').textContent =
    `Detalle diferencia - ${r.numeroNegocio}`;

  document.getElementById('detalleDiffResumen').innerHTML = `
    <div>${r.nombreGrupo}</div>
    <div style="margin-top:.5rem;">
      PAX correo: ${r.paxCorreo} ·
      PAX pagos: ${r.paxPagos} ·
      Diferencia: <span style="color:${r.diferencia === 0 ? '#09832e' : '#ca0a1f'};">
        ${r.diferencia > 0 ? '+' + r.diferencia : r.diferencia}
      </span>
    </div>
    <div style="font-size:.9em; color:#555; margin-top:.35rem;">
      Información calculada solo con pasajeros activos que viajan.
      ${r.numerosPago?.length > 1 ? ` Se sumaron negocios: ${r.numerosPago.join(' + ')}.` : ''}
    </div>
  `;

  const tbody = document.getElementById('detalleDiffBody');

  tbody.innerHTML = r.detalle.filas.map(f => {
    const color = f.diferencia === 0 ? '#09832e' : '#ca0a1f';
    const diffTxt = f.diferencia > 0 ? `+${f.diferencia}` : f.diferencia;

    return `
      <tr style="${f.total ? 'font-weight:bold; background:#f7f7f7;' : ''}">
        <td>${f.categoria}</td>
        <td>${f.correo}</td>
        <td>${f.pagos}</td>
        <td style="color:${color}; font-weight:bold;">${diffTxt}</td>
      </tr>
    `;
  }).join('');

  document.getElementById('modalDetalleDiferenciaPagos').style.display = 'block';
}

function calcularResumenVerificacion(resultados) {
  const gruposConDiferencia = resultados.filter(r => r.estado === 'DIFERENCIA').length;
  const gruposError = resultados.filter(r => r.estado === 'ERROR CONSULTA').length;
  const totalDiferencia = resultados.reduce((s, r) => s + (Number(r.diferencia) || 0), 0);

  return {
    totalGrupos: resultados.length,
    gruposConDiferencia,
    gruposError,
    totalDiferencia,
    estadoGeneral:
      gruposConDiferencia === 0 && gruposError === 0
        ? 'OK'
        : 'CON_DIFERENCIAS'
  };
}

function calcularResumenPagosContador(items) {
  const resumen = crearResumenPagosVacio();

  const pasajeros = Array.isArray(items) ? items : [];

  pasajeros.forEach(item => {
    const p = item?.pasajero || item || {};
    resumen.totalLeidos++;

    const viaja = pasajeroViajaContador(p);

    if (!viaja) {
      resumen.totalNoViajan++;
      return;
    }

    resumen.totalViajan++;

    const tipo = tipoPasajeroPagosContador(p);
    const sexo = sexoPasajeroPagosContador(p);

    if (tipo === 'estudiante') {
      resumen.estudiantes[sexo]++;
      resumen.totalEstudiantes++;
    } else {
      resumen.adultos[sexo]++;
      resumen.totalAdultos++;
    }
  });

  return resumen;
}

function pasajeroViajaContador(p) {
  const v =
    p.viaja ??
    p.estado_viaje ??
    p.estado ??
    p.activo ??
    '';

  if (typeof v === 'number') {
    return Number(v) === 1;
  }

  const txt = normalizarTextoContador(v);

  if (!txt) return true;

  if (
    txt === '1' ||
    txt === 'si' ||
    txt === 'sí' ||
    txt === 'viaja' ||
    txt === 'activo' ||
    txt === 'activa'
  ) {
    return true;
  }

  if (
    txt === '0' ||
    txt === 'no' ||
    txt === 'no viaja' ||
    txt === 'anulado' ||
    txt === 'anulada' ||
    txt === 'baja'
  ) {
    return false;
  }

  return true;
}

function tipoPasajeroPagosContador(p) {
  const categoria = normalizarTextoContador(
    p.ocupacion_categoria ||
    p.categoria ||
    p.tipo_pasajero ||
    p.tipo ||
    p.ocupacion ||
    ''
  );

  if (
    categoria.includes('estudiante') ||
    categoria.includes('alumno') ||
    categoria.includes('alumna')
  ) {
    return 'estudiante';
  }

  return 'adulto';
}

function sexoPasajeroPagosContador(p) {
  const sexo = normalizarTextoContador(
    p.sexo ||
    p.genero ||
    p.gender ||
    ''
  );

  if (
    sexo === 'm' ||
    sexo.includes('masculino') ||
    sexo.includes('hombre')
  ) {
    return 'M';
  }

  if (
    sexo === 'f' ||
    sexo.includes('femenino') ||
    sexo.includes('mujer')
  ) {
    return 'F';
  }

  return 'O';
}

function normalizarTextoContador(txt) {
  return String(txt || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

// =====================================================
// GUARDAR HISTORIAL DE VERIFICACIÓN EN RESERVA
// =====================================================

function abrirModalGuardarVerificacionPagos() {
  if (!ultimaVerificacionPagos) {
    alert('Primero debes verificar PAX con pagos.');
    return;
  }

  const r = ultimaVerificacionPagos.resumen;

  document.getElementById('guardarVerificacionResumen').innerHTML = `
    <div><strong>Actividad:</strong> ${ultimaVerificacionPagos.actividad}</div>
    <div><strong>Destino:</strong> ${ultimaVerificacionPagos.destino}</div>
    <div><strong>Grupos revisados:</strong> ${r.totalGrupos}</div>
    <div><strong>Estado:</strong> ${r.estadoGeneral === 'OK' ? 'OK, sin diferencias' : 'Con diferencias / pendientes'}</div>
    <div><strong>Grupos con diferencia:</strong> ${r.gruposConDiferencia}</div>
    <div><strong>Diferencia total:</strong> ${r.totalDiferencia}</div>
  `;

  document.getElementById('guardarVerificacionComentario').value = '';

  document.getElementById('modalGuardarVerificacionPagos').style.display = 'block';
}

async function guardarVerificacionPagosEnReserva() {
  if (!ultimaVerificacionPagos || !reservaActualSnapshot) {
    alert('No hay verificación para guardar.');
    return;
  }

  const comentario = document.getElementById('guardarVerificacionComentario').value.trim();
  const resumen = ultimaVerificacionPagos.resumen;

  if (resumen.estadoGeneral !== 'OK' && !comentario) {
    alert('Hay diferencias. Debes escribir una justificación antes de guardar.');
    return;
  }

  const destino = reservaActualSnapshot.destino;
  const actividad = reservaActualSnapshot.actividad;
  const cuerpo = document.getElementById('modalCuerpo').value;

  const ref = doc(db, 'Servicios', destino, 'Listado', actividad);

  const payload = {};
  const verificacionGuardada = {
    ...ultimaVerificacionPagos,
    comentario,
    usuario: auth.currentUser?.email || '',
    guardadoEn: new Date().toISOString()
  };

  for (const f of fechasOrdenadas) {
    const totalEnviado = grupos.reduce((sum, g) => {
      const acts = g.itinerario?.[f] || [];
      const t = acts
        .filter(a => a.actividad === actividad)
        .reduce((acc, a) => acc + ((parseInt(a.adultos) || 0) + (parseInt(a.estudiantes) || 0)), 0);
      return sum + t;
    }, 0);

    if (totalEnviado > 0) {
      payload[`reservas.${f}.estado`] =
        resumen.estadoGeneral === 'OK'
          ? 'VERIFICADA'
          : 'PENDIENTE_VERIFICADA';

      payload[`reservas.${f}.cuerpo`] = cuerpo;
      payload[`reservas.${f}.totalEnviado`] = totalEnviado;
      payload[`reservas.${f}.verificacionPagos`] = verificacionGuardada;
      payload[`reservas.${f}.updatedAt`] = serverTimestamp();
    }
  }

  if (!Object.keys(payload).length) {
    alert('No hay fechas con PAX para guardar esta verificación.');
    return;
  }

  await updateDoc(ref, payload);

  document.getElementById('modalGuardarVerificacionPagos').style.display = 'none';

  alert('Verificación guardada como historial de la reserva.');
}
