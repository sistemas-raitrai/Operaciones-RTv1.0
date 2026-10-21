import { app, db } from './firebase-init.js';
import {
  collection, doc, getDoc, getDocs, query, where, orderBy, limit,
  runTransaction, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';

const COLECCIONES = Object.freeze({
  RESUMENES: 'finanzas_resumenes',
  OBLIGACIONES: 'finanzas_obligaciones',
  ABONOS: 'finanzas_abonos',
  REGLAS: 'finanzas_reglas_proveedores',
  HISTORIAL: 'finanzas_historial'
});

const DESTINOS_ORDEN = ['BRASIL', 'BARILOCHE', 'SUR DE CHILE', 'NORTE DE CHILE'];
const MONEDAS_ORDEN = ['CLP', 'USD', 'BRL', 'ARS'];
const auth = getAuth(app);
const state = {
  usuario: null, ano: new Date().getFullYear(), tipo: 'TODOS', destino: null,
  resumenes: [], proveedor: null, obligaciones: [], abonos: [], reglas: [], historial: []
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = valor => String(valor ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const num = valor => Number(valor || 0);
const norm = valor => String(valor || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').trim().toUpperCase();
const moneda = valor => {
  const codigo = norm(valor);

  const equivalencias = {
    CLP: 'CLP',
    '$': 'CLP',
    'PESO CHILENO': 'CLP',
    'PESOS CHILENOS': 'CLP',

    USD: 'USD',
    'US$': 'USD',
    US: 'USD',
    DOLAR: 'USD',
    DOLARES: 'USD',
    DOLLAR: 'USD',
    DOLLARS: 'USD',
    'DOLAR AMERICANO': 'USD',
    'DOLARES AMERICANOS': 'USD',
    'DOLAR ESTADOUNIDENSE': 'USD',
    'DOLARES ESTADOUNIDENSES': 'USD',

    BRL: 'BRL',
    'R$': 'BRL',
    REAL: 'BRL',
    REALES: 'BRL',
    'REAL BRASILENO': 'BRL',
    'REALES BRASILENOS': 'BRL',

    ARS: 'ARS',
    'AR$': 'ARS',
    ARG: 'ARS',
    'PESO ARGENTINO': 'ARS',
    'PESOS ARGENTINOS': 'ARS'
  };

  return equivalencias[codigo] || 'SIN_DEFINIR';
};
const fmtNum = valor => num(valor).toLocaleString('es-CL', { maximumFractionDigits: 2 });
const fmtMoney = (valor, codigo) => {
  if (moneda(codigo) === 'SIN_DEFINIR') return 'PENDIENTE';
  const prefijos = { CLP: '$', USD: 'US$', BRL: 'R$', ARS: 'AR$' };
  return `${prefijos[moneda(codigo)]} ${fmtNum(valor)}`;
};
const fechaTexto = valor => {
  if (!valor) return '—';
  const raw = typeof valor?.toDate === 'function' ? valor.toDate() : new Date(`${String(valor).slice(0,10)}T00:00:00`);
  return Number.isNaN(raw.getTime()) ? '—' : raw.toLocaleDateString('es-CL');
};
const claveProveedor = r => `${r.proveedorId || ''}__${r.monedaObligacion || ''}__${r.tipo || ''}`;
const setEstado = (texto, error = false, destino = '#estadoCarga') => {
  const nodo = $(destino); if (!nodo) return;
  nodo.textContent = texto || ''; nodo.classList.toggle('error', error);
};

function resumenesFiltrados() {
  return state.resumenes.filter(r => state.tipo === 'TODOS' || norm(r.tipo) === state.tipo);
}

function totalesPorMoneda(lista, campo) {
  const out = {};
  for (const item of lista) {
    const m = moneda(item.monedaObligacion);
    out[m] = (out[m] || 0) + num(item[campo]);
  }
  return out;
}

function dineroEnviadoTexto(item) {
  const mapa = item.totalEnviadoPorMoneda || {};
  const lineas = MONEDAS_ORDEN.filter(m => num(mapa[m])).map(m => `<span>${fmtMoney(mapa[m], m)}</span>`);
  return lineas.length ? lineas.join('') : '<span>—</span>';
}

function construirAnos() {
  const actual = new Date().getFullYear();
  const anos = [];
  for (let a = actual - 1; a <= actual + 3; a++) anos.push(a);
  $('#filtroAno').innerHTML = anos.map(a => `<option value="${a}" ${a === state.ano ? 'selected' : ''}>${a}</option>`).join('');
}

async function cargarResumenes() {
  setEstado('Cargando saldos…');
  const q = query(collection(db, COLECCIONES.RESUMENES), where('anoViaje', '==', Number(state.ano)));
  const snap = await getDocs(q);
  state.resumenes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const destinosDisponibles = ordenarDestinos([...new Set(resumenesFiltrados().map(r => norm(r.destinoFinanciero)).filter(Boolean))]);
  if (!state.destino || !destinosDisponibles.includes(state.destino)) state.destino = destinosDisponibles[0] || DESTINOS_ORDEN[0];
  renderDestinos(); renderProveedores();
  setEstado(state.resumenes.length ? `Información actualizada: ${state.resumenes.length} resúmenes.` : 'Aún no existen resúmenes financieros para este año.');
}

function ordenarDestinos(destinos) {
  return destinos.sort((a,b) => {
    const ia = DESTINOS_ORDEN.indexOf(a), ib = DESTINOS_ORDEN.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return a.localeCompare(b, 'es');
  });
}

function renderDestinos() {
  const lista = resumenesFiltrados();
  const encontrados = [...new Set(lista.map(r => norm(r.destinoFinanciero)).filter(Boolean))];
  const destinos = ordenarDestinos([...new Set([...DESTINOS_ORDEN, ...encontrados])]);
  $('#destinos').innerHTML = destinos.map(dest => {
    const items = lista.filter(r => norm(r.destinoFinanciero) === dest);
    const saldos = totalesPorMoneda(items, 'saldoPendiente');
    const sinTarifa = items.reduce((suma, item) => suma + num(item.obligacionesSinTarifa), 0);
    const lineas = MONEDAS_ORDEN.filter(m => Object.prototype.hasOwnProperty.call(saldos, m))
      .map(m => `<span class="cf-destination-balance">Por pagar: ${fmtMoney(saldos[m], m)}</span>`).join('');
    const alertaHotel = sinTarifa ? `<span class="cf-destination-balance">⚠ ${sinTarifa} alojamiento(s) sin tarifa</span>` : '';
    return `<button class="cf-destination ${dest === state.destino ? 'active' : ''}" data-destino="${esc(dest)}" type="button"><span class="cf-destination-name">${esc(dest)}</span>${lineas || (sinTarifa ? '' : '<span class="cf-muted">Sin obligaciones</span>')}${alertaHotel}</button>`;
  }).join('');
  $$('.cf-destination').forEach(btn => btn.addEventListener('click', () => {
    state.destino = btn.dataset.destino; renderDestinos(); renderProveedores();
  }));
}

function proveedoresDestino() {
  return resumenesFiltrados().filter(r => norm(r.destinoFinanciero) === state.destino)
    .sort((a,b) => num(b.saldoPendiente) - num(a.saldoPendiente) || String(a.proveedorNombre).localeCompare(String(b.proveedorNombre), 'es'));
}

function estadoFinancieroResumen(resumen) {
  if (num(resumen.obligacionesSinTarifa) > 0 || resumen.requiereConfiguracion) {
    return { texto: 'Sin tarifa', clase: 'warning' };
  }
  if (num(resumen.abonosPendientesRevision) > 0) {
    return { texto: 'Requiere revisión', clase: 'warning' };
  }
  const costo = num(resumen.totalObligacion);
  const aplicado = num(resumen.totalAplicado);
  const saldo = num(resumen.saldoPendiente);
  if (saldo < 0) return { texto: 'Saldo a favor', clase: 'credit' };
  if (costo > 0 && saldo <= 0) return { texto: 'Pagado', clase: 'paid' };
  if (aplicado > 0) return { texto: 'Pago parcial', clase: 'partial' };
  return { texto: 'Por pagar', clase: 'payable' };
}

function agruparPorTipoYMoneda(items) {
  const tipos = ['ACTIVIDAD', 'HOTEL'];
  return tipos.map(tipo => {
    const delTipo = items.filter(item => norm(item.tipo) === tipo);
    const monedasEncontradas = [...new Set(delTipo.map(item => moneda(item.monedaObligacion)))];
    const monedas = [...MONEDAS_ORDEN, 'SIN_DEFINIR']
      .filter((m, indice, lista) => monedasEncontradas.includes(m) && lista.indexOf(m) === indice);
    return {
      tipo,
      items: delTipo,
      monedas: monedas.map(codigo => ({
        codigo,
        items: delTipo.filter(item => moneda(item.monedaObligacion) === codigo)
      }))
    };
  }).filter(grupo => grupo.items.length);
}

function filaProveedor(resumen) {
  const saldo = num(resumen.saldoPendiente);
  const pendiente = !!resumen.requiereConfiguracion;
  const estado = estadoFinancieroResumen(resumen);
  const avisos = [];
  if (num(resumen.obligacionesSinTarifa)) avisos.push(`${num(resumen.obligacionesSinTarifa)} sin tarifa`);
  if (num(resumen.abonosPendientesRevision)) avisos.push(`${num(resumen.abonosPendientesRevision)} abono(s) por revisar`);
  return `<tr data-key="${esc(claveProveedor(resumen))}">
    <td class="cf-provider-name">
      <strong>${esc(resumen.proveedorNombre || resumen.proveedorId || 'Sin proveedor')}</strong>
      ${avisos.length ? `<small>${esc(avisos.join(' · '))}</small>` : ''}
    </td>
    <td class="num">${pendiente ? 'PENDIENTE' : fmtMoney(resumen.totalObligacion, resumen.monedaObligacion)}</td>
    <td class="num multi-money">${dineroEnviadoTexto(resumen)}</td>
    <td class="num">${pendiente ? '—' : fmtMoney(resumen.totalAplicado, resumen.monedaObligacion)}</td>
    <td class="num ${saldo > 0 || pendiente ? 'saldo' : 'ok'}">${pendiente ? 'PENDIENTE' : fmtMoney(saldo, resumen.monedaObligacion)}</td>
    <td><span class="cf-state ${estado.clase}">${estado.texto}</span></td>
    <td><button class="cf-btn btn-detalle" type="button">Ver detalle</button></td>
  </tr>`;
}

function bloqueMoneda(grupo, codigo) {
  const items = codigo.items;
  const costo = items.reduce((suma, item) => suma + num(item.totalObligacion), 0);
  const aplicado = items.reduce((suma, item) => suma + num(item.totalAplicado), 0);
  const saldo = items.reduce((suma, item) => suma + num(item.saldoPendiente), 0);
  const etiqueta = codigo.codigo === 'SIN_DEFINIR' ? 'SIN MONEDA' : codigo.codigo;
  return `<section class="cf-currency-group">
    <header class="cf-currency-head">
      <div class="cf-currency-name"><span class="cf-currency-pill">${esc(etiqueta)}</span> Proveedores pagados en ${esc(etiqueta)}</div>
      <div class="cf-currency-totals">Costo: <strong>${fmtMoney(costo, codigo.codigo)}</strong> · Abonos: <strong>${fmtMoney(aplicado, codigo.codigo)}</strong> · Por pagar: <strong>${fmtMoney(saldo, codigo.codigo)}</strong></div>
    </header>
    <div class="cf-table-wrap">
      <table class="cf-table cf-provider-table">
        <thead><tr><th>Proveedor</th><th class="num">Costo total</th><th class="num">Monto enviado</th><th class="num">Abonos aplicados</th><th class="num">Saldo por pagar</th><th>Estado</th><th></th></tr></thead>
        <tbody>${items.map(filaProveedor).join('')}</tbody>
        <tfoot><tr><th>Subtotal ${esc(etiqueta)}</th><th class="num">${fmtMoney(costo, codigo.codigo)}</th><th></th><th class="num">${fmtMoney(aplicado, codigo.codigo)}</th><th class="num saldo">${fmtMoney(saldo, codigo.codigo)}</th><th colspan="2"></th></tr></tfoot>
      </table>
    </div>
  </section>`;
}

function renderProveedores() {
  const items = proveedoresDestino();
  $('#tituloDestino').textContent = state.destino || 'Seleccione un destino';
  $('#btnExportarDestino').disabled = !items.length;
  $('#sinProveedores').hidden = !!items.length;
  const contenedor = $('#gruposFinancieros');
  const grupos = agruparPorTipoYMoneda(items);
  contenedor.innerHTML = grupos.map(grupo => {
    const esHotel = grupo.tipo === 'HOTEL';
    return `<article class="cf-service-block ${esHotel ? 'hotel' : 'activity'}">
      <header class="cf-service-title">
        <div><h3>${esHotel ? 'HOTELES' : 'ACTIVIDADES'}</h3><p>${esHotel ? 'Alojamientos agrupados por moneda de cobro.' : 'Servicios y actividades agrupados por moneda de cobro.'}</p></div>
        <span class="cf-badge">${grupo.items.length} proveedor(es)</span>
      </header>
      ${grupo.monedas.map(codigo => bloqueMoneda(grupo, codigo)).join('')}
    </article>`;
  }).join('');
  $$('.btn-detalle', contenedor).forEach(btn => btn.addEventListener('click', () => {
    const key = btn.closest('tr').dataset.key;
    const resumen = items.find(r => claveProveedor(r) === key);
    if (resumen) abrirDetalle(resumen);
  }));
}

async function consultarColeccionDetalle(nombre, proveedorId, monedaObligacion, tipo) {
  const condiciones = [where('anoViaje', '==', Number(state.ano)), where('proveedorId', '==', proveedorId)];
  if (monedaObligacion) condiciones.push(where('monedaObligacion', '==', monedaObligacion));
  if (tipo && nombre === COLECCIONES.OBLIGACIONES) condiciones.push(where('tipo', '==', tipo));
  const snap = await getDocs(query(collection(db, nombre), ...condiciones));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function abrirDetalle(resumen) {
  state.proveedor = resumen; state.obligaciones = []; state.abonos = []; state.reglas = []; state.historial = [];
  $('#detalleTitulo').textContent = resumen.proveedorNombre || resumen.proveedorId;
  $('#detalleSubtitulo').textContent = `${norm(resumen.destinoFinanciero)} · ${norm(resumen.tipo)} · DEUDA EN ${moneda(resumen.monedaObligacion)}`;
  $('#detalleBackdrop').classList.add('open'); $('#detalleBackdrop').setAttribute('aria-hidden', 'false'); document.body.classList.add('modal-open');
  activarTab('obligaciones'); renderMetricas(); setEstado('Cargando detalle…', false, '#detalleEstado');
  try {
    const [obligaciones, abonos, reglas, historial] = await Promise.all([
      consultarColeccionDetalle(COLECCIONES.OBLIGACIONES, resumen.proveedorId, moneda(resumen.monedaObligacion), norm(resumen.tipo)),
      consultarColeccionDetalle(COLECCIONES.ABONOS, resumen.proveedorId, moneda(resumen.monedaObligacion)),
      consultarColeccionDetalle(COLECCIONES.REGLAS, resumen.proveedorId, null),
      consultarHistorial(resumen.proveedorId)
    ]);
    state.obligaciones = obligaciones; state.abonos = abonos; state.reglas = reglas; state.historial = historial;
    renderDetalle(); setEstado('', false, '#detalleEstado');
  } catch (e) {
    console.error(e); setEstado(`No fue posible cargar el detalle: ${e.message}`, true, '#detalleEstado');
  }
}

async function consultarHistorial(proveedorId) {
  const q = query(collection(db, COLECCIONES.HISTORIAL), where('anoViaje', '==', Number(state.ano)), where('proveedorId', '==', proveedorId), limit(300));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a,b) => fechaMillis(b.creadoAt) - fechaMillis(a.creadoAt));
}

function fechaMillis(v) { return typeof v?.toMillis === 'function' ? v.toMillis() : new Date(v || 0).getTime(); }

function renderMetricas() {
  const r = state.proveedor;
  const enviado = Object.entries(r.totalEnviadoPorMoneda || {}).filter(([,v]) => num(v)).map(([m,v]) => fmtMoney(v,m)).join('<br>') || '—';
  const pendiente = !!r.requiereConfiguracion;
  $('#metricasProveedor').innerHTML = [
    ['COSTO TOTAL', pendiente ? 'PENDIENTE DE TARIFA' : fmtMoney(r.totalObligacion, r.monedaObligacion)], ['MONTO ENVIADO', enviado],
    ['ABONOS APLICADOS', pendiente ? '—' : fmtMoney(r.totalAplicado, r.monedaObligacion)], ['SALDO POR PAGAR', pendiente ? 'PENDIENTE' : fmtMoney(r.saldoPendiente, r.monedaObligacion)]
  ].map(([l,v]) => `<div class="cf-metric"><span class="cf-metric-label">${l}</span><span class="cf-metric-value">${v}</span></div>`).join('');
}

function renderDetalle() { renderObligaciones(); renderAbonos(); renderReglas(); renderHistorial(); }

function valorPaxReal(obligacion) {
  const valor = obligacion.paxReales;
  return valor === null || valor === undefined || valor === ''
    ? '<span class="cf-badge pending">Pendiente</span>'
    : fmtNum(valor);
}

function estadoCosto(obligacion) {
  if (obligacion.requiereConfiguracion) return '<span class="cf-state warning">Sin tarifa</span>';
  if (obligacion.paxReales === null || obligacion.paxReales === undefined || obligacion.paxReales === '') {
    return '<span class="cf-state warning">Pax por revisar</span>';
  }
  return `<span class="cf-state payable">${esc(norm(obligacion.estadoFinanciero || obligacion.estadoRealizacion || 'PROGRAMADO'))}</span>`;
}

function renderCostosActividades(rows) {
  return `<div class="cf-table-wrap"><table class="cf-table"><thead><tr><th>Fecha</th><th>Grupo</th><th>Servicio</th><th class="num">Pax acordados</th><th class="num">Pax reales</th><th class="num">Pax cobrados</th><th>Forma de cobro</th><th class="num">Valor unitario</th><th class="num">Costo total</th><th>Estado</th></tr></thead><tbody>${rows.map(o => `<tr><td>${fechaTexto(o.fechaServicio)}</td><td>${esc(o.numeroNegocio || '')} · ${esc(o.nombreGrupo || '')}</td><td>${esc(o.servicioNombre || '')}</td><td class="num">${fmtNum(o.paxAcordados ?? o.paxReservados)}</td><td class="num">${valorPaxReal(o)}</td><td class="num">${o.paxCobrados === null || o.paxCobrados === undefined ? '—' : fmtNum(o.paxCobrados)}</td><td>${esc(norm(o.tipoCobro || 'POR_GRUPO').replaceAll('_', ' '))}</td><td class="num">${o.requiereConfiguracion ? 'PENDIENTE' : fmtMoney(o.tarifaBase, o.monedaObligacion)}</td><td class="num">${o.requiereConfiguracion ? 'PENDIENTE' : fmtMoney(o.totalObligacion, o.monedaObligacion)}</td><td>${estadoCosto(o)}</td></tr>`).join('')}</tbody></table></div>`;
}

function renderCostosHoteles(rows) {
  return `<div class="cf-table-wrap"><table class="cf-table"><thead><tr><th>Estadía</th><th>Grupo</th><th>Hotel</th><th class="num">Noches</th><th class="num">Pax acordados</th><th class="num">Pax reales</th><th class="num">Pax cobrados</th><th>Modalidad de cobro</th><th class="num">Tarifa</th><th class="num">Costo total</th><th>Estado</th></tr></thead><tbody>${rows.map(o => `<tr><td>${fechaTexto(o.checkIn)} – ${fechaTexto(o.checkOut)}</td><td>${esc(o.numeroNegocio || '')} · ${esc(o.nombreGrupo || '')}</td><td>${esc(o.servicioNombre || o.hotelNombre || '')}</td><td class="num">${fmtNum(o.noches)}</td><td class="num">${fmtNum(o.paxAcordados ?? o.paxReservados)}</td><td class="num">${valorPaxReal(o)}</td><td class="num">${o.paxCobrados === null || o.paxCobrados === undefined ? '—' : fmtNum(o.paxCobrados)}</td><td>${esc(norm(o.tipoCobro || '').replaceAll('_', ' '))}</td><td class="num">${o.requiereConfiguracion ? 'PENDIENTE' : fmtMoney(o.tarifaBase, o.monedaObligacion)}</td><td class="num">${o.requiereConfiguracion ? 'PENDIENTE' : fmtMoney(o.totalObligacion, o.monedaObligacion)}</td><td>${estadoCosto(o)}</td></tr>`).join('')}</tbody></table></div>`;
}

function renderObligaciones() {
  const rows = [...state.obligaciones].sort((a,b) => String(a.fechaServicio || '').localeCompare(String(b.fechaServicio || '')));
  const tipo = norm(state.proveedor?.tipo);
  const tabla = tipo === 'HOTEL' ? renderCostosHoteles(rows) : renderCostosActividades(rows);
  $('#panel-obligaciones').innerHTML = `<div class="cf-section-head"><div><h3>${tipo === 'HOTEL' ? 'Detalle de costos de hotel' : 'Detalle de costos de actividades'}</h3><div class="cf-muted">Pax acordados, reales y cobrados se conservan como datos independientes.</div></div><span class="cf-muted">${rows.length} registro(s)</span></div>${tabla}${rows.length ? '' : '<div class="cf-empty">No hay costos registrados.</div>'}`;
}

function renderAbonos() {
  const rows = [...state.abonos].sort(
    (a, b) =>
      String(b.fecha || '').localeCompare(
        String(a.fecha || '')
      )
  );

  const filas = rows.map(a => {
    const estado = norm(
      a.estadoRevision || 'PENDIENTE'
    );

    const revisado = [
      'REVISADO',
      'REVISADO_AUTOMATICO'
    ].includes(estado);

    return `
      <tr>
        <td>${fechaTexto(a.fecha)}</td>

        <td class="num">
          ${fmtMoney(
            a.montoEnviado,
            a.monedaEnviada
          )}
        </td>

        <td class="num">
          ${
            a.tipoCambioAplicado
              ? fmtNum(a.tipoCambioAplicado)
              : '—'
          }
        </td>

        <td class="num">
          ${fmtMoney(
            a.montoAplicado,
            a.monedaAplicada || a.monedaObligacion
          )}
        </td>

        <td class="num">
          ${
            num(a.unidadesCubiertas)
              ? (
                  `${fmtNum(a.unidadesCubiertas)} ` +
                  `${esc(a.tipoAplicacion || 'unidades')}`
                )
              : '—'
          }
        </td>

        <td>
          <span
            class="cf-badge ${
              revisado ? 'reviewed' : 'pending'
            }"
          >
            ${esc(estado)}
          </span>
        </td>

        <td>
          ${
            a.comprobanteURL
              ? `
                <a
                  href="${esc(a.comprobanteURL)}"
                  target="_blank"
                  rel="noopener"
                >
                  Ver
                </a>
              `
              : '—'
          }
        </td>

        <td>
          <button
            class="cf-btn btn-editar-abono"
            data-id="${esc(a.id)}"
            type="button"
          >
            Editar
          </button>
        </td>
      </tr>
    `;
  }).join('');

  $('#panel-abonos').innerHTML = `
    <div class="cf-section-head">
      <h3>Abonos y aplicaciones</h3>

      <span class="cf-muted">
        El dinero enviado nunca se reemplaza
        por su equivalencia.
      </span>
    </div>

    <div class="cf-table-wrap">
      <table class="cf-table">
        <thead>
          <tr>
            <th>Fecha</th>
            <th class="num">Enviado</th>
            <th class="num">Tipo de cambio</th>
            <th class="num">Aplicado</th>
            <th class="num">Cobertura</th>
            <th>Estado</th>
            <th>Comprobante</th>
            <th></th>
          </tr>
        </thead>

        <tbody>${filas}</tbody>
      </table>
    </div>

    ${
      rows.length
        ? ''
        : `
          <div class="cf-empty">
            No hay abonos registrados.
          </div>
        `
    }
  `;

  $$(
    '.btn-editar-abono',
    $('#panel-abonos')
  ).forEach(btn => {
    btn.addEventListener('click', () => {
      abrirEditorAbono(btn.dataset.id);
    });
  });
}

function renderReglas() {
  const rows = [...state.reglas].sort((a,b) => Number(!!b.servicioId) - Number(!!a.servicioId));
  $('#panel-reglas').innerHTML = `<div class="cf-section-head"><h3>Reglas del proveedor</h3><span class="cf-muted">La regla del servicio y año tiene prioridad sobre la general.</span></div><div class="cf-table-wrap"><table class="cf-table"><thead><tr><th>Alcance</th><th>Servicio</th><th>Año</th><th>Tipo</th><th>Descripción</th><th>Estado</th></tr></thead><tbody>${rows.map(r => `<tr><td>${r.servicioId ? 'Servicio' : 'General proveedor'}</td><td>${esc(r.servicioNombre || 'Todos')}</td><td>${esc(r.anoViaje || 'Todos')}</td><td>${esc(norm(r.tipoRegla || 'INFORMATIVA'))}</td><td>${esc(r.descripcion || '')}</td><td>${r.activa === false ? 'Inactiva' : 'Activa'}</td></tr>`).join('')}</tbody></table></div>${rows.length ? '' : '<div class="cf-empty">Este proveedor no tiene reglas especiales registradas.</div>'}`;
}

function renderHistorial() {
  const rows = state.historial;
  $('#panel-historial').innerHTML = `<div class="cf-section-head"><h3>Historial de auditoría</h3></div><div class="cf-table-wrap"><table class="cf-table"><thead><tr><th>Fecha</th><th>Acción</th><th>Usuario</th><th>Motivo</th><th>Antes</th><th>Después</th></tr></thead><tbody>${rows.map(h => `<tr><td>${fechaTexto(h.creadoAt)}</td><td>${esc(h.accion || '')}</td><td>${esc(h.usuarioEmail || '')}</td><td>${esc(h.motivo || '')}</td><td>${esc(resumenCambio(h.antes))}</td><td>${esc(resumenCambio(h.despues))}</td></tr>`).join('')}</tbody></table></div>${rows.length ? '' : '<div class="cf-empty">No hay modificaciones auditadas.</div>'}`;
}

function resumenCambio(v) {
  if (!v || typeof v !== 'object') return '—';
  return [`TC: ${v.tipoCambioAplicado ?? '—'}`, `Aplicado: ${v.montoAplicado ?? '—'}`, `Cobertura: ${v.unidadesCubiertas ?? '—'}`].join(' · ');
}

function activarTab(nombre) {
  $$('.cf-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === nombre));
  $$('.cf-tab-panel').forEach(panel => { panel.hidden = panel.id !== `panel-${nombre}`; });
}

function cerrarDetalle() {
  $('#detalleBackdrop').classList.remove('open'); $('#detalleBackdrop').setAttribute('aria-hidden', 'true'); document.body.classList.remove('modal-open');
}

function abrirEditorAbono(id) {
  const a = state.abonos.find(x => x.id === id); if (!a) return;
  $('#abonoId').value = a.id; $('#abMonedaEnviada').value = moneda(a.monedaEnviada); $('#abMontoEnviado').value = num(a.montoEnviado);
  $('#abMonedaAplicada').value = moneda(a.monedaAplicada || a.monedaObligacion); $('#abTipoCambio').value = a.tipoCambioAplicado ?? '';
  $('#abMontoAplicado').value = num(a.montoAplicado); $('#abUnidadesCubiertas').value = num(a.unidadesCubiertas) || '';
  $('#abMotivo').value = ''; $('#errorEditarAbono').textContent = ''; $('#dialogEditarAbono').showModal();
}

function recalcularMontoDesdeTC() {
  const enviada = $('#abMonedaEnviada').value, aplicada = $('#abMonedaAplicada').value;
  const monto = num($('#abMontoEnviado').value), tc = num($('#abTipoCambio').value);
  if (!monto || !tc) return;
  if (enviada === 'USD' && aplicada !== 'USD') $('#abMontoAplicado').value = (monto * tc).toFixed(2);
}

async function guardarRevisionAbono(event) {
  event.preventDefault();

  const id = $('#abonoId').value;

  const actual = state.abonos.find(
    a => a.id === id
  );

  if (!actual) return;

  const errorNodo = $('#errorEditarAbono');
  errorNodo.textContent = '';

  const motivo = $('#abMotivo').value.trim();

  const montoTexto =
    $('#abMontoAplicado').value.trim();

  const montoAplicado = Number(montoTexto);

  const tcTexto =
    $('#abTipoCambio').value.trim();

  const tc = tcTexto === ''
    ? null
    : Number(tcTexto);

  const unidadesCubiertas = Number(
    $('#abUnidadesCubiertas').value || 0
  );

  const monedaAplicada = moneda(
    $('#abMonedaAplicada').value
  );

  if (!motivo) {
    errorNodo.textContent =
      'Debe indicar el motivo de la revisión.';
    return;
  }

  if (
    montoTexto === '' ||
    !Number.isFinite(montoAplicado) ||
    montoAplicado < 0
  ) {
    errorNodo.textContent =
      'El monto aplicado debe ser un número válido mayor o igual a cero.';
    return;
  }

  if (
    tc !== null &&
    (!Number.isFinite(tc) || tc <= 0)
  ) {
    errorNodo.textContent =
      'El tipo de cambio debe ser mayor que cero o quedar vacío.';
    return;
  }

  if (
    !Number.isFinite(unidadesCubiertas) ||
    unidadesCubiertas < 0 ||
    !Number.isInteger(unidadesCubiertas)
  ) {
    errorNodo.textContent =
      'Los ingresos o cupos cubiertos deben ser un número entero mayor o igual a cero.';
    return;
  }

  if (monedaAplicada === 'SIN_DEFINIR') {
    errorNodo.textContent =
      'Seleccione una moneda aplicada válida.';
    return;
  }

  const proveedorActual = state.proveedor;

  const resumenId =
    actual.resumenId || proveedorActual?.id;

  if (!resumenId) {
    errorNodo.textContent =
      'No se pudo identificar el resumen del proveedor.';
    return;
  }

  const botonGuardar = $(
    '#formEditarAbono button[type="submit"]'
  );

  if (botonGuardar?.disabled) return;

  if (botonGuardar) {
    botonGuardar.disabled = true;
  }

  const redondear = valor => Math.round(
    (valor + Number.EPSILON) * 100
  ) / 100;

  const importeValido = valor => (
    valor !== null &&
    valor !== undefined &&
    String(valor).trim() !== '' &&
    Number.isFinite(Number(valor)) &&
    Number(valor) >= 0
  );

  const mismoImporte = (a, b) => (
    importeValido(a) &&
    importeValido(b) &&
    redondear(Number(a)) === redondear(Number(b))
  );

  let resultado;

  try {
    setEstado(
      'Guardando revisión y sincronizando Abonos…',
      false,
      '#detalleEstado'
    );

    const abRef = doc(
      db,
      COLECCIONES.ABONOS,
      id
    );

    const resumenRef = doc(
      db,
      COLECCIONES.RESUMENES,
      resumenId
    );

    const histRef = doc(
      collection(db, COLECCIONES.HISTORIAL)
    );

    resultado = await runTransaction(
      db,
      async tx => {
        /*
         * Todas las lecturas se realizan
         * antes de escribir.
         */
        const abonoSnap = await tx.get(abRef);
        const resumenSnap = await tx.get(resumenRef);

        if (!abonoSnap.exists()) {
          throw new Error(
            'El abono ya no existe. Actualice el detalle.'
          );
        }

        if (!resumenSnap.exists()) {
          throw new Error(
            'El resumen ya no existe. Actualice la información.'
          );
        }

        const vigente = abonoSnap.data();
        const resumen = resumenSnap.data();

        if (
          vigente.resumenId &&
          vigente.resumenId !== resumenId
        ) {
          throw new Error(
            'El abono cambió de resumen. Cierre y vuelva a abrir el detalle.'
          );
        }

        /*
         * Evitar sobrescribir una revisión realizada
         * por otra persona desde que se abrió el editor.
         */
        const revisionCambio = (
          !mismoImporte(
            vigente.montoAplicado,
            actual.montoAplicado
          ) ||

          moneda(
            vigente.monedaAplicada ||
            vigente.monedaObligacion
          ) !== moneda(
            actual.monedaAplicada ||
            actual.monedaObligacion
          ) ||

          (vigente.tipoCambioAplicado ?? null) !==
            (actual.tipoCambioAplicado ?? null) ||

          num(vigente.unidadesCubiertas) !==
            num(actual.unidadesCubiertas) ||

          norm(vigente.estadoRevision) !==
            norm(actual.estadoRevision)
        );

        if (revisionCambio) {
          throw new Error(
            'La aplicación del abono cambió desde que abrió el detalle. ' +
            'Cierre y vuelva a abrirlo antes de editar.'
          );
        }

        const monedaDeuda = moneda(
          resumen.monedaObligacion
        );

        if (
          monedaDeuda === 'SIN_DEFINIR' ||
          monedaAplicada !== monedaDeuda
        ) {
          throw new Error(
            'La moneda aplicada debe coincidir con la moneda de la deuda. ' +
            'Si falta configurar esa moneda, debe completarla primero.'
          );
        }

        const origenPath = String(
          vigente.origenPath || ''
        ).trim();

        const partes = origenPath.split('/');

        const esActividad = (
          partes.length === 8 &&
          partes[0] === 'ServiciosPorAno' &&
          partes[2] === 'Destinos' &&
          partes[4] === 'Listado' &&
          partes[6] === 'Abonos'
        );

        const esHotel = (
          partes.length === 4 &&
          partes[0] === 'FinanzasHotelesAbonos' &&
          partes[2] === 'Abonos'
        );

        if (
          (!esActividad && !esHotel) ||
          partes.some(parte => !parte)
        ) {
          throw new Error(
            'El abono no tiene una ruta de origen reconocida. ' +
            'Debe revisarse su vinculación antes de guardar.'
          );
        }

        const origenRef = doc(db, origenPath);
        const origenSnap = await tx.get(origenRef);

        if (!origenSnap.exists()) {
          throw new Error(
            'No se encontró el pago original del servicio u hotel.'
          );
        }

        const origen = origenSnap.data();

        if (norm(origen.estado) === 'ARCHIVADO') {
          throw new Error(
            'El pago original está archivado. Actualice la información.'
          );
        }

        if (
          !mismoImporte(
            origen.monto,
            vigente.montoEnviado
          ) ||
          moneda(origen.moneda) !==
            moneda(vigente.monedaEnviada)
        ) {
          throw new Error(
            'El monto o la moneda del pago original cambiaron. ' +
            'Debe actualizarse su reflejo financiero antes de revisarlo.'
          );
        }

        const monedaEnviada = moneda(origen.moneda);
        const montoEnviado = Number(origen.monto);

        if (monedaEnviada === 'SIN_DEFINIR') {
          throw new Error(
            'La moneda enviada no está configurada.'
          );
        }

        const idCentralOrigen = String(
          origen.abonoOperacionId || ''
        ).trim();

        const idCentralFinanzas = String(
          vigente.abonoOperacionId || ''
        ).trim();

        if (
          idCentralOrigen &&
          idCentralFinanzas &&
          idCentralOrigen !== idCentralFinanzas
        ) {
          throw new Error(
            'La vinculación del abono central no coincide. ' +
            'Debe revisarse antes de guardar.'
          );
        }

        const idCentral =
          idCentralOrigen || idCentralFinanzas;

        if (idCentral.includes('/')) {
          throw new Error(
            'El identificador del abono central no es válido.'
          );
        }

        let centralRef = null;
        let central = null;

        if (idCentral) {
          centralRef = doc(
            db,
            'AbonosOperaciones',
            idCentral
          );

          const centralSnap = await tx.get(
            centralRef
          );

          if (!centralSnap.exists()) {
            throw new Error(
              'No se encontró el registro central de Abonos.'
            );
          }

          central = centralSnap.data();

          if (norm(central.estado) === 'ARCHIVADO') {
            throw new Error(
              'El registro central del pago está archivado.'
            );
          }

          if (
            !mismoImporte(
              central.monto,
              montoEnviado
            ) ||
            moneda(central.moneda) !== monedaEnviada
          ) {
            throw new Error(
              'El registro central y su copia tienen diferencias de monto o moneda. ' +
              'Corrija el pago desde Abonos antes de continuar.'
            );
          }
        }

        /*
         * Determinar cómo se documenta la aplicación.
         *
         * MISMA_MONEDA: el mismo monto.
         * TC: coincide con monto enviado × TC.
         * MANUAL: monto reconocido y justificado.
         */
        const aplicado = redondear(montoAplicado);

        let modo = 'MANUAL';
        let tipoCambioGuardado = null;

        if (
          monedaEnviada === monedaDeuda &&
          aplicado === redondear(montoEnviado)
        ) {
          modo = 'MISMA_MONEDA';
          tipoCambioGuardado = 1;
        } else if (
          monedaEnviada !== monedaDeuda &&
          tc !== null &&
          Number.isFinite(montoEnviado * tc) &&
          redondear(montoEnviado * tc) === aplicado
        ) {
          modo = 'TC';
          tipoCambioGuardado = tc;
        }

        if (
          modo === 'MANUAL' &&
          tc !== null &&
          monedaEnviada !== monedaDeuda
        ) {
          throw new Error(
            'El monto aplicado no coincide con monto enviado × TC. ' +
            'Corrija el TC o déjelo vacío para registrar un monto reconocido manualmente.'
          );
        }

        const email = state.usuario?.email || '';

        const aplicacionFinanciera = {
          versionEsquema: 1,
          modo,
          monedaDeuda,

          tipoCambio:
            tipoCambioGuardado,

          montoAplicado:
            aplicado,

          monedaEnviadaBase:
            monedaEnviada,

          montoEnviadoBase:
            montoEnviado,

          detalle: motivo,
          estado: 'CONFIGURADO',
          actualizadoPor: email,
          actualizadoAt: serverTimestamp()
        };

        const antes = {
          monedaAplicada:
            vigente.monedaAplicada ||
            vigente.monedaObligacion,

          tipoCambioAplicado:
            vigente.tipoCambioAplicado ?? null,

          montoAplicado:
            num(vigente.montoAplicado),

          unidadesCubiertas:
            num(vigente.unidadesCubiertas),

          estadoRevision:
            vigente.estadoRevision || 'PENDIENTE'
        };

        const despues = {
          monedaAplicada: monedaDeuda,
          tipoCambioAplicado: tipoCambioGuardado,
          montoAplicado: aplicado,
          unidadesCubiertas,
          estadoRevision: 'REVISADO'
        };

        const diferencia =
          aplicado - num(vigente.montoAplicado);

        const diferenciaUnidades =
          unidadesCubiertas -
          num(vigente.unidadesCubiertas);

        const estabaPendiente =
          norm(
            vigente.estadoRevision || 'PENDIENTE'
          ) === 'PENDIENTE';

        const totalAplicado = redondear(
          num(resumen.totalAplicado) +
          diferencia
        );

        const totalUnidadesCubiertas =
          num(resumen.unidadesCubiertas) +
          diferenciaUnidades;

        const cambiosResumen = {
          totalAplicado,

          saldoPendiente: redondear(
            num(resumen.totalObligacion) -
            totalAplicado
          ),

          unidadesCubiertas:
            totalUnidadesCubiertas,

          unidadesPendientes: Math.max(
            0,
            num(resumen.unidadesTotales) -
            totalUnidadesCubiertas
          ),

          abonosPendientesRevision: Math.max(
            0,
            num(resumen.abonosPendientesRevision) -
            (estabaPendiente ? 1 : 0)
          )
        };

        const cambiosOrigen = {
          aplicacionFinanciera,
          unidadesCubiertas,

          actualizadoDesde:
            'CONTROL_FINANZAS',

          updatedAt: serverTimestamp(),
          updatedByEmail: email
        };

        /*
         * A partir de aquí solamente escrituras.
         */
        tx.update(origenRef, cambiosOrigen);

        if (centralRef) {
          const versionAnterior =
            num(central.version) || 1;

          const nuevaVersion =
            versionAnterior + 1;

          tx.update(centralRef, {
            ...cambiosOrigen,
            version: nuevaVersion,
            motivoUltimoCambio: motivo
          });

          tx.update(origenRef, {
            version: nuevaVersion
          });

          const historialCentralRef = doc(
            collection(
              db,
              'AbonosOperaciones',
              idCentral,
              'Historial'
            )
          );

          tx.set(historialCentralRef, {
            versionAnterior,
            datosAnteriores: central,

            tipoCambio:
              'REVISION_APLICACION_FINANZAS',

            motivoCambio: motivo,
            changedAt: serverTimestamp(),
            changedByEmail: email
          });
        }

        tx.update(abRef, {
          ...despues,

          abonoOperacionId:
            idCentral || '',

          aplicacionFinancieraOrigen:
            aplicacionFinanciera,

          motivoPendiente: '',
          revisadoAt: serverTimestamp(),
          revisadoPor: email
        });

        tx.update(resumenRef, {
          ...cambiosResumen,
          actualizadoAt: serverTimestamp()
        });

        tx.set(histRef, {
          anoViaje: Number(resumen.anoViaje),

          destinoFinanciero:
            resumen.destinoFinanciero || '',

          proveedorId:
            resumen.proveedorId || '',

          proveedorNombre:
            resumen.proveedorNombre || '',

          abonoId: id,
          abonoOperacionId: idCentral || '',
          origenPath,

          accion:
            'REVISION_ABONO_SINCRONIZADA',

          motivo,
          antes,
          despues,

          aplicacionAnteriorOrigen:
            origen.aplicacionFinanciera || null,

          aplicacionNueva:
            aplicacionFinanciera,

          usuarioEmail: email,
          creadoAt: serverTimestamp()
        });

        return {
          cambiosResumen,
          despues,
          idCentral
        };
      }
    );
  } catch (e) {
    console.error(e);

    errorNodo.textContent =
      `No fue posible guardar: ${e.message}`;

    setEstado(
      'No se pudo guardar la revisión.',
      true,
      '#detalleEstado'
    );

    return;
  } finally {
    if (botonGuardar) {
      botonGuardar.disabled = false;
    }
  }

  $('#dialogEditarAbono').close();

  Object.assign(
    actual,
    resultado.despues
  );

  Object.assign(
    proveedorActual,
    resultado.cambiosResumen
  );

  renderMetricas();
  renderAbonos();

  try {
    await cargarResumenes();

    state.historial = await consultarHistorial(
      proveedorActual.proveedorId
    );

    renderHistorial();

    setEstado(
      resultado.idCentral
        ? 'Revisión guardada y sincronizada con Abonos.'
        : 'Revisión guardada en el pago de origen. Este pago antiguo no tiene registro central vinculado.',
      false,
      '#detalleEstado'
    );
  } catch (e) {
    console.error(e);

    setEstado(
      'La revisión fue guardada, pero no se pudo actualizar toda la pantalla. ' +
      'Cierre y vuelva a abrir el detalle.',
      true,
      '#detalleEstado'
    );
  }
}
function filasResumenes(lista) {
  return lista.map(r => ({ Año: r.anoViaje, Destino: r.destinoFinanciero, Proveedor: r.proveedorNombre, Tipo: r.tipo, 'Moneda de cobro': r.monedaObligacion, 'Costo total': num(r.totalObligacion), 'Abonos aplicados': num(r.totalAplicado), 'Saldo por pagar': num(r.saldoPendiente), 'Enviado CLP': num(r.totalEnviadoPorMoneda?.CLP), 'Enviado USD': num(r.totalEnviadoPorMoneda?.USD), 'Enviado BRL': num(r.totalEnviadoPorMoneda?.BRL), 'Enviado ARS': num(r.totalEnviadoPorMoneda?.ARS), 'Pendientes de revisión': num(r.abonosPendientesRevision), 'Servicios sin tarifa': num(r.obligacionesSinTarifa) }));
}

function descargarExcel(nombre, hojas) {
  if (!window.XLSX) { alert('No se pudo cargar el módulo de Excel.'); return; }
  const libro = XLSX.utils.book_new();
  Object.entries(hojas).forEach(([hoja, filas]) => XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(filas.length ? filas : [{ Información: 'Sin datos' }]), hoja.slice(0,31)));
  XLSX.writeFile(libro, nombre);
}

function hojasResumen(lista) {
  return {
    Resumen: filasResumenes(lista),
    Actividades: filasResumenes(lista.filter(r => norm(r.tipo) === 'ACTIVIDAD')),
    Hoteles: filasResumenes(lista.filter(r => norm(r.tipo) === 'HOTEL')),
    'Pendientes revisión': filasResumenes(lista.filter(r => num(r.abonosPendientesRevision) || num(r.obligacionesSinTarifa)))
  };
}

function exportarTodo() { descargarExcel(`control_finanzas_${state.ano}.xlsx`, hojasResumen(resumenesFiltrados())); }
function exportarDestino() { descargarExcel(`control_finanzas_${state.ano}_${norm(state.destino).replace(/\s+/g,'_')}.xlsx`, hojasResumen(proveedoresDestino())); }
function exportarProveedor() {
  const r = state.proveedor;
  descargarExcel(`control_finanzas_${state.ano}_${String(r.proveedorNombre || r.proveedorId).replace(/[^a-z0-9]+/gi,'_')}.xlsx`, {
    Resumen: filasResumenes([r]),
    Costos: state.obligaciones.map(o => ({ Fecha:o.fechaServicio, CheckIn:o.checkIn, CheckOut:o.checkOut, Noches:o.noches, Negocio:o.numeroNegocio, Grupo:o.nombreGrupo, Servicio:o.servicioNombre || o.hotelNombre, 'Pax acordados':o.paxAcordados ?? o.paxReservados, 'Pax reales':o.paxReales, 'Pax cobrados':o.paxCobrados, 'Forma de cobro':o.tipoCobro, 'Valor unitario':o.tarifaBase, Moneda:o.monedaObligacion, 'Costo total':o.totalObligacion, Estado:o.estadoFinanciero || o.estadoRealizacion })),
    Abonos: state.abonos.map(a => ({ Fecha:a.fecha, 'Moneda enviada':a.monedaEnviada, 'Monto enviado':a.montoEnviado, 'Tipo de cambio':a.tipoCambioAplicado, 'Moneda aplicada':a.monedaAplicada, 'Monto aplicado':a.montoAplicado, 'Unidades cubiertas':a.unidadesCubiertas, Estado:a.estadoRevision, Observación:a.nota, Comprobante:a.comprobanteURL })),
    Reglas: state.reglas.map(rg => ({ Alcance:rg.servicioId ? 'Servicio' : 'Proveedor', Servicio:rg.servicioNombre, Año:rg.anoViaje, Tipo:rg.tipoRegla, Descripción:rg.descripcion, Activa:rg.activa !== false })),
    Historial: state.historial.map(h => ({ Fecha:fechaTexto(h.creadoAt), Acción:h.accion, Usuario:h.usuarioEmail, Motivo:h.motivo, Antes:resumenCambio(h.antes), Después:resumenCambio(h.despues) }))
  });
}

function bindUI() {
  $('#filtroAno').addEventListener('change', async e => { state.ano = Number(e.target.value); state.destino = null; await cargarResumenes(); });
  $('#filtroTipo').addEventListener('change', e => { state.tipo = e.target.value; renderDestinos(); renderProveedores(); });
  $('#btnRecargar').addEventListener('click', cargarResumenes); $('#btnExportarTodo').addEventListener('click', exportarTodo);
  $('#btnExportarDestino').addEventListener('click', exportarDestino); $('#btnExportarProveedor').addEventListener('click', exportarProveedor);
  $('#btnCerrarDetalle').addEventListener('click', cerrarDetalle); $('#detalleBackdrop').addEventListener('click', e => { if (e.target === $('#detalleBackdrop')) cerrarDetalle(); });
  $$('.cf-tab').forEach(btn => btn.addEventListener('click', () => activarTab(btn.dataset.tab)));
  $('#btnCancelarEdicion').addEventListener('click', () => $('#dialogEditarAbono').close());
  $('#formEditarAbono').addEventListener('submit', guardarRevisionAbono); $('#abTipoCambio').addEventListener('change', recalcularMontoDesdeTC);
}

onAuthStateChanged(auth, async user => {
  if (!user) { window.location.href = 'login.html'; return; }
  state.usuario = user; $('#usuarioConectado').textContent = user.email || '';
  construirAnos(); bindUI();
  try { await cargarResumenes(); } catch (e) { console.error(e); setEstado(`Error cargando Control Finanzas: ${e.message}`, true); }
});
