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
const moneda = valor => ['CLP','USD','BRL','ARS','SIN_DEFINIR'].includes(norm(valor)) ? norm(valor) : 'CLP';
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

function renderProveedores() {
  const items = proveedoresDestino();
  $('#tituloDestino').textContent = state.destino || 'Seleccione un destino';
  $('#btnExportarDestino').disabled = !items.length;
  $('#sinProveedores').hidden = !!items.length;
  const tbody = $('#tablaProveedores tbody');
  tbody.innerHTML = items.map(r => {
    const saldo = num(r.saldoPendiente);
    const sinTarifa = num(r.obligacionesSinTarifa);
    const revision = sinTarifa > 0
      ? `<span class="cf-badge pending">Falta tarifa (${sinTarifa})</span>`
      : num(r.abonosPendientesRevision) > 0
      ? `<span class="cf-badge pending">${num(r.abonosPendientesRevision)} pendiente(s)</span>`
      : '<span class="cf-badge reviewed">Al día</span>';
    const valorObligacion = r.requiereConfiguracion ? 'PENDIENTE' : fmtMoney(r.totalObligacion, r.monedaObligacion);
    const valorAplicado = r.requiereConfiguracion ? '—' : fmtMoney(r.totalAplicado, r.monedaObligacion);
    const valorSaldo = r.requiereConfiguracion ? 'PENDIENTE' : fmtMoney(saldo, r.monedaObligacion);
    return `<tr data-key="${esc(claveProveedor(r))}">
      <td><strong>${esc(r.proveedorNombre || r.proveedorId || 'Sin proveedor')}</strong></td>
      <td>${esc(norm(r.tipo || 'ACTIVIDAD'))}</td><td>${r.requiereConfiguracion ? 'SIN DEFINIR' : esc(moneda(r.monedaObligacion))}</td>
      <td class="num">${valorObligacion}</td>
      <td class="num multi-money">${dineroEnviadoTexto(r)}</td>
      <td class="num">${valorAplicado}</td>
      <td class="num ${r.requiereConfiguracion || saldo > 0 ? 'saldo' : 'ok'}">${valorSaldo}</td>
      <td>${revision}</td><td><button class="cf-btn btn-detalle" type="button">Ver detalle</button></td>
    </tr>`;
  }).join('');
  const totales = totalesPorMoneda(items, 'saldoPendiente');
  $('#tablaProveedores tfoot').innerHTML = items.length ? `<tr><th colspan="6">TOTAL PENDIENTE ${esc(state.destino)}</th><th class="num saldo">${MONEDAS_ORDEN.filter(m => totales[m] !== undefined).map(m => fmtMoney(totales[m], m)).join('<br>')}</th><th colspan="2"></th></tr>` : '';
  $$('.btn-detalle', tbody).forEach(btn => btn.addEventListener('click', () => {
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
    ['OBLIGACIÓN', pendiente ? 'PENDIENTE DE TARIFA' : fmtMoney(r.totalObligacion, r.monedaObligacion)], ['DINERO ENVIADO', enviado],
    ['APLICADO', pendiente ? '—' : fmtMoney(r.totalAplicado, r.monedaObligacion)], ['SALDO', pendiente ? 'PENDIENTE' : fmtMoney(r.saldoPendiente, r.monedaObligacion)]
  ].map(([l,v]) => `<div class="cf-metric"><span class="cf-metric-label">${l}</span><span class="cf-metric-value">${v}</span></div>`).join('');
}

function renderDetalle() { renderObligaciones(); renderAbonos(); renderReglas(); renderHistorial(); }

function renderObligaciones() {
  const rows = [...state.obligaciones].sort((a,b) => String(a.fechaServicio || '').localeCompare(String(b.fechaServicio || '')));
  $('#panel-obligaciones').innerHTML = `<div class="cf-section-head"><h3>Detalle de obligaciones</h3><span class="cf-muted">${rows.length} movimiento(s)</span></div><div class="cf-table-wrap"><table class="cf-table"><thead><tr><th>Fecha</th><th>Grupo</th><th>Servicio</th><th class="num">PAX</th><th class="num">Noches</th><th class="num">Liberados</th><th class="num">Cobrables</th><th class="num">Tarifa</th><th class="num">Total</th><th>Estado</th></tr></thead><tbody>${rows.map(o => `<tr><td>${fechaTexto(o.fechaServicio)}</td><td>${esc(o.numeroNegocio || '')} · ${esc(o.nombreGrupo || '')}</td><td>${esc(o.servicioNombre || o.hotelNombre || '')}</td><td class="num">${fmtNum(o.paxReales ?? o.paxReservados)}</td><td class="num">${o.tipo === 'HOTEL' ? fmtNum(o.noches) : '—'}</td><td class="num">${fmtNum(o.liberados)}</td><td class="num">${fmtNum(o.unidadesCobrables)}</td><td class="num">${o.requiereConfiguracion ? 'PENDIENTE' : fmtMoney(o.tarifaBase, o.monedaObligacion)}</td><td class="num">${o.requiereConfiguracion ? 'PENDIENTE' : fmtMoney(o.totalObligacion, o.monedaObligacion)}</td><td>${o.requiereConfiguracion ? '<span class="cf-badge pending">SIN TARIFA</span>' : esc(norm(o.estadoFinanciero || o.estadoRealizacion || 'PROGRAMADO'))}</td></tr>`).join('')}</tbody></table></div>${rows.length ? '' : '<div class="cf-empty">No hay obligaciones registradas.</div>'}`;
}

function renderAbonos() {
  const rows = [...state.abonos].sort((a,b) => String(b.fecha || '').localeCompare(String(a.fecha || '')));
  $('#panel-abonos').innerHTML = `<div class="cf-section-head"><h3>Abonos y aplicaciones</h3><span class="cf-muted">El dinero enviado nunca se reemplaza por su equivalencia.</span></div><div class="cf-table-wrap"><table class="cf-table"><thead><tr><th>Fecha</th><th class="num">Enviado</th><th class="num">Tipo de cambio</th><th class="num">Aplicado</th><th class="num">Cobertura</th><th>Estado</th><th>Comprobante</th><th></th></tr></thead><tbody>${rows.map(a => `<tr><td>${fechaTexto(a.fecha)}</td><td class="num">${fmtMoney(a.montoEnviado, a.monedaEnviada)}</td><td class="num">${a.tipoCambioAplicado ? fmtNum(a.tipoCambioAplicado) : '—'}</td><td class="num">${fmtMoney(a.montoAplicado, a.monedaAplicada || a.monedaObligacion)}</td><td class="num">${num(a.unidadesCubiertas) ? `${fmtNum(a.unidadesCubiertas)} ${esc(a.tipoAplicacion || 'unidades')}` : '—'}</td><td><span class="cf-badge ${norm(a.estadoRevision) === 'REVISADO' ? 'reviewed' : 'pending'}">${esc(norm(a.estadoRevision || 'PENDIENTE'))}</span></td><td>${a.comprobanteURL ? `<a href="${esc(a.comprobanteURL)}" target="_blank" rel="noopener">Ver</a>` : '—'}</td><td><button class="cf-btn btn-editar-abono" data-id="${esc(a.id)}" type="button">Editar</button></td></tr>`).join('')}</tbody></table></div>${rows.length ? '' : '<div class="cf-empty">No hay abonos registrados.</div>'}`;
  $$('.btn-editar-abono', $('#panel-abonos')).forEach(btn => btn.addEventListener('click', () => abrirEditorAbono(btn.dataset.id)));
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
  const id = $('#abonoId').value, actual = state.abonos.find(a => a.id === id); if (!actual) return;
  const motivo = $('#abMotivo').value.trim(), montoAplicado = num($('#abMontoAplicado').value), tc = num($('#abTipoCambio').value);
  if (!motivo) { $('#errorEditarAbono').textContent = 'Debe indicar el motivo de la revisión.'; return; }
  if (montoAplicado < 0) { $('#errorEditarAbono').textContent = 'El monto aplicado no puede ser negativo.'; return; }
  const despues = { monedaAplicada: $('#abMonedaAplicada').value, tipoCambioAplicado: tc || null, montoAplicado, unidadesCubiertas: num($('#abUnidadesCubiertas').value), estadoRevision: 'REVISADO' };
  const antes = { monedaAplicada: actual.monedaAplicada || actual.monedaObligacion, tipoCambioAplicado: actual.tipoCambioAplicado ?? null, montoAplicado: num(actual.montoAplicado), unidadesCubiertas: num(actual.unidadesCubiertas), estadoRevision: actual.estadoRevision || 'PENDIENTE' };
  const diferencia = montoAplicado - num(actual.montoAplicado);
  const resumenId = actual.resumenId || state.proveedor.id;
  try {
    setEstado('Guardando revisión…', false, '#detalleEstado');
    await runTransaction(db, async tx => {
      const abRef = doc(db, COLECCIONES.ABONOS, id), resumenRef = doc(db, COLECCIONES.RESUMENES, resumenId);
      const resumenSnap = await tx.get(resumenRef);
      tx.update(abRef, { ...despues, revisadoAt: serverTimestamp(), revisadoPor: state.usuario?.email || '' });
      if (resumenSnap.exists()) {
        const r = resumenSnap.data();
        tx.update(resumenRef, { totalAplicado: num(r.totalAplicado) + diferencia, saldoPendiente: num(r.totalObligacion) - (num(r.totalAplicado) + diferencia), abonosPendientesRevision: Math.max(0, num(r.abonosPendientesRevision) - (norm(actual.estadoRevision) === 'REVISADO' ? 0 : 1)), actualizadoAt: serverTimestamp() });
      }
      const histRef = doc(collection(db, COLECCIONES.HISTORIAL));
      tx.set(histRef, { anoViaje: Number(state.ano), destinoFinanciero: state.proveedor.destinoFinanciero, proveedorId: state.proveedor.proveedorId, proveedorNombre: state.proveedor.proveedorNombre, abonoId: id, accion: 'REVISION_ABONO', motivo, antes, despues, usuarioEmail: state.usuario?.email || '', creadoAt: serverTimestamp() });
    });
    $('#dialogEditarAbono').close();
    Object.assign(actual, despues); state.proveedor.totalAplicado = num(state.proveedor.totalAplicado) + diferencia; state.proveedor.saldoPendiente = num(state.proveedor.totalObligacion) - num(state.proveedor.totalAplicado);
    renderMetricas(); renderAbonos(); await cargarResumenes(); setEstado('Revisión guardada correctamente.', false, '#detalleEstado');
  } catch (e) { console.error(e); $('#errorEditarAbono').textContent = `No fue posible guardar: ${e.message}`; }
}

function filasResumenes(lista) {
  return lista.map(r => ({ Año: r.anoViaje, Destino: r.destinoFinanciero, Proveedor: r.proveedorNombre, Tipo: r.tipo, 'Moneda deuda': r.monedaObligacion, Obligación: num(r.totalObligacion), Aplicado: num(r.totalAplicado), Saldo: num(r.saldoPendiente), 'Enviado CLP': num(r.totalEnviadoPorMoneda?.CLP), 'Enviado USD': num(r.totalEnviadoPorMoneda?.USD), 'Enviado BRL': num(r.totalEnviadoPorMoneda?.BRL), 'Enviado ARS': num(r.totalEnviadoPorMoneda?.ARS), 'Pendientes revisión': num(r.abonosPendientesRevision) }));
}

function descargarExcel(nombre, hojas) {
  if (!window.XLSX) { alert('No se pudo cargar el módulo de Excel.'); return; }
  const libro = XLSX.utils.book_new();
  Object.entries(hojas).forEach(([hoja, filas]) => XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(filas.length ? filas : [{ Información: 'Sin datos' }]), hoja.slice(0,31)));
  XLSX.writeFile(libro, nombre);
}

function exportarTodo() { descargarExcel(`control_finanzas_${state.ano}.xlsx`, { Resumen: filasResumenes(resumenesFiltrados()) }); }
function exportarDestino() { descargarExcel(`control_finanzas_${state.ano}_${norm(state.destino).replace(/\s+/g,'_')}.xlsx`, { Resumen: filasResumenes(proveedoresDestino()) }); }
function exportarProveedor() {
  const r = state.proveedor;
  descargarExcel(`control_finanzas_${state.ano}_${String(r.proveedorNombre || r.proveedorId).replace(/[^a-z0-9]+/gi,'_')}.xlsx`, {
    Resumen: filasResumenes([r]),
    Obligaciones: state.obligaciones.map(o => ({ Fecha:o.fechaServicio, Negocio:o.numeroNegocio, Grupo:o.nombreGrupo, Servicio:o.servicioNombre || o.hotelNombre, PAX:o.paxReales ?? o.paxReservados, Liberados:o.liberados, Cobrables:o.unidadesCobrables, Tarifa:o.tarifaBase, Moneda:o.monedaObligacion, Total:o.totalObligacion, Estado:o.estadoRealizacion })),
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
