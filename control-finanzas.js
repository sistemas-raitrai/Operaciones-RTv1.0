function tieneExcepcionHotel(f = {}) {
  if (f.usarReglaHotel === true) return false;
  return !!(f.pension || f.moneda || f.modalidad === 'total' ||
    f.personasCobradas !== null && f.personasCobradas !== undefined && f.personasCobradas !== '' ||
    f.tarifaParticular !== null && f.tarifaParticular !== undefined && f.tarifaParticular !== '' ||
    f.totalAcordado !== null && f.totalAcordado !== undefined && f.totalAcordado !== '' ||
    Number(f.adicionales) || Number(f.descuentos) || f.detalle);
}


import { app, db } from './firebase-init.js';
import {
  collection, doc, getDoc, getDocs, query, where, orderBy, limit,
  runTransaction, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-functions.js';
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
const llamarCuentasHoteles=httpsCallable(getFunctions(app,'southamerica-west1'),'gestionarCuentasProveedoresHoteles',{timeout:120000});
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
const claveProveedor = r => r.id ||  `${r.proveedorId || ''}__${r.monedaObligacion || ''}__${r.tipo || ''}`;
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
  const turno=++state.cargaVisual,ano=Number(state.ano);
  setEstado('Actualizando costos, pagos, cuentas y saldos…');
  try {
    const [resumenes,costos,cuentas]=await Promise.all([
      getDocs(query(collection(db,COLECCIONES.RESUMENES),where('anoViaje','==',ano))),
      getDocs(query(collection(db,COLECCIONES.OBLIGACIONES),where('anoViaje','==',ano))),
      llamarCuentasHoteles({accion:'CONSULTAR',anoViaje:ano})
    ]);
    if(turno!==state.cargaVisual||ano!==Number(state.ano))return false;
    state.configCuentasHoteles=cuentas.data.documentos||[];
    state.resumenes=adjuntarCuentasHoteles(resumenes.docs.map(d=>({...d.data(),id:d.id})),state.configCuentasHoteles);
    state.costosAno=costos.docs.map(d=>({...d.data(),id:d.id}));
    if((preferenciasFinanzas().ocultos||[]).includes(state.destino))state.destino=null;
    renderDestinos();renderProveedores();
    setEstado(`Información consultada a las ${new Date().toLocaleTimeString('es-CL')}. Las cuentas compartidas conservan el origen de cada costo y pago.`);
    return true;
  } catch(error) {setEstado(`No se pudo actualizar: ${error.message}. Compruebe que esté desplegada gestionarCuentasProveedoresHoteles.`,true);return false;}
}

function ordenarDestinos(destinos) {
  return destinos.sort((a,b) => {
    const ia = DESTINOS_ORDEN.indexOf(a), ib = DESTINOS_ORDEN.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return a.localeCompare(b, 'es');
  });
}

function renderDestinos() {
  const ocultos=preferenciasFinanzas().ocultos||[];
  $('#destinos').innerHTML=[['TODOS_DESTINOS','TODOS LOS DESTINOS'],...destinosVisiblesFinanzas().filter(d=>!ocultos.includes(d)).map(d=>[d,d])].map(([dest,label])=>`
    <button class="cf-destination ${dest===state.destino?'active':''}" type="button" data-destino="${esc(dest)}" aria-pressed="${dest===state.destino}"><span class="cf-destination-name">${esc(label)}</span></button>`).join('');
  $$('.cf-destination').forEach(b=>b.onclick=()=>{state.destino=b.dataset.destino;renderDestinos();renderProveedores();});
}

function proveedoresDestino() {
  return seleccionResumenes().sort((a,b)=>compararNombre(a.proveedorNombre,b.proveedorNombre)||compararNombre(a.tipo,b.tipo)||compararNombre(a.destinoFinanciero,b.destinoFinanciero));
}

function estadoFinancieroResumen(resumen) {
  if(resumen.sinCostoVinculado)return {texto:'Pendiente de vinculación',clase:'attention'};
  if(resumen.requiereConfiguracion||num(resumen.obligacionesSinTarifa))return {texto:'Costo incompleto',clase:'warning'};
  if(num(resumen.abonosPendientesRevision))return {texto:'Pago por revisar',clase:'warning'};
  if(num(resumen.saldoPendiente)<0)return {texto:'Saldo a favor · revisar',clase:'attention'};
  if(num(resumen.totalObligacion)>0&&num(resumen.saldoPendiente)<=0)return {texto:'Pagado',clase:'paid'};
  return num(resumen.totalAplicado)>0?{texto:'Pago parcial',clase:'partial'}:{texto:'Por pagar',clase:'payable'};
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
  state.proveedoresDesplegados ||= new Set();
  const clave=String(claveProveedor(resumen)),abierto=state.proveedoresDesplegados.has(clave),pendiente=!!resumen.requiereConfiguracion;
  const cuenta=resumen.cuentaCompartida,raiz=esRaizCompartida(resumen),saldo=raiz?cuenta.saldosPorMoneda[moneda(resumen.monedaObligacion)]:resumen;
  const estado=estadoFinancieroResumen(raiz?saldo:resumen),servicios=new Map();
  for(const o of resumen.sinteticoCuenta?[]:costosResumen(resumen)) {
    const key=o.servicioId||o.servicioNombre||o.hotelNombre||'Servicio';
    if(!servicios.has(key))servicios.set(key,{nombre:o.servicioNombre||o.hotelNombre||key,costo:0,pendientes:0,cantidad:0});
    const s=servicios.get(key);s.costo+=num(o.totalObligacion);s.pendientes+=o.requiereConfiguracion?1:0;s.cantidad++;
  }
  const hijos=[...servicios.values()].sort((a,b)=>compararNombre(a.nombre,b.nombre));
  const atributos=`data-proveedor-padre="${esc(clave)}" ${abierto?'':'hidden style="display:none"'}`;
  const monedaDeuda=resumen.monedaObligacion;
  const leyenda=cuenta?(raiz?`CUENTA COMPARTIDA · ${cuenta.miembros.map(x=>x.nombre).join(' + ')}`:`Cuenta principal: ${cuenta.raizNombre}`):'';
  const avisos=[num(resumen.obligacionesSinTarifa)?`${num(resumen.obligacionesSinTarifa)} costo(s) pendientes`:'',num(resumen.abonosPendientesRevision)?`${num(resumen.abonosPendientesRevision)} pago(s) por revisar`:''].filter(Boolean);
  return `<tr class="cf-provider-total ${raiz?'cf-account-root':''}" data-key="${esc(clave)}">
    <td class="cf-provider-name"><div class="cf-provider-fold"><button type="button" class="btn-desplegar-proveedor" aria-expanded="${abierto}" aria-label="${esc((abierto?'Ocultar':'Mostrar')+' servicios de '+resumen.proveedorNombre)}" title="${abierto?'Ocultar':'Mostrar'} servicios">${abierto?'−':'+'}</button><div><strong>${esc(resumen.proveedorNombre||resumen.proveedorId)}</strong><small>${norm(resumen.tipo)==='HOTEL'?'HOTEL':'ACTIVIDADES'}${avisos.length?' · '+esc(avisos.join(' · ')):''}</small>${leyenda?`<small class="cf-account-caption">${esc(leyenda)}</small>`:''}</div></div></td>
    <td class="cf-total-label">${resumen.sinteticoCuenta?'RAÍZ DE CUENTA · SIN COSTO PROPIO EN ESTA MONEDA':norm(resumen.tipo)==='HOTEL'?'TOTAL DEL HOTEL':'TOTAL PROVEEDOR'}<small>${hijos.length} servicio(s)</small></td>
    <td class="num">${fmtMoney(resumen.totalObligacion,monedaDeuda)}${pendiente?'<small class="cf-partial">PARCIAL</small>':''}${raiz?`<small class="cf-account-caption">Conjunto: ${fmtMoney(saldo.totalObligacion,monedaDeuda)}${saldo.requiereConfiguracion?' · PARCIAL':''}</small>`:''}</td>
    <td class="num multi-money">${dineroEnviadoTexto(resumen)}${raiz?`<small class="cf-account-caption">Conjunto: ${dineroEnviadoTexto(saldo)}</small>`:''}</td>
    <td class="num">${fmtMoney(resumen.totalAplicado,monedaDeuda)}${raiz?`<small class="cf-account-caption">Conjunto: ${fmtMoney(saldo.totalAplicado,monedaDeuda)}</small>`:''}</td>
    <td class="num saldo ${raiz?'cf-account-balance':''}">${cuenta&&!raiz?`<span class="cf-account-included">Incluido en ${esc(cuenta.raizNombre)}</span>`:saldo.requiereConfiguracion&&num(saldo.saldoPendiente)<0?'PENDIENTE':fmtMoney(saldo.saldoPendiente,monedaDeuda)}${raiz?'<small class="cf-account-caption">SALDO CONJUNTO · no sumar nuevamente los integrantes</small>':''}</td>
    <td>${cuenta&&!raiz?'<span class="cf-state partial">Cuenta compartida</span>':`<span class="cf-state ${estado.clase}">${esc(estado.texto)}</span>`}</td>
    <td><button type="button" class="cf-btn btn-detalle">${raiz?'Ver cuenta':'Ver detalle'}</button></td></tr>
    ${hijos.length?hijos.map(s=>`<tr class="cf-service-child" ${atributos}><td></td><td><span class="cf-child-marker">↳</span> ${esc(s.nombre)}<small>${s.cantidad} registro(s)</small></td><td class="num">${fmtMoney(s.costo,monedaDeuda)}${s.pendientes?'<small class="cf-partial">PARCIAL</small>':''}</td><td colspan="3" class="cf-child-payment">${cuenta?'El saldo se consolida en la cuenta principal.':'Los pagos y el saldo se muestran en el total del proveedor.'}</td><td>${s.pendientes?'<span class="cf-state warning">Faltan datos de costo</span>':''}</td><td></td></tr>`).join(''):`<tr class="cf-service-child" ${atributos}><td></td><td colspan="7">${resumen.sinteticoCuenta?'Los costos de esta cuenta pertenecen a los hoteles integrantes.':'Sin costos vinculados. El pago permanece visible y pendiente de configuración.'}</td></tr>`}`;
}

function bloqueMoneda(grupo,codigo) {
  const items=[...codigo.items].sort((a,b)=>compararNombre(a.proveedorNombre,b.proveedorNombre)||compararNombre(a.tipo,b.tipo));
  const m=codigo.codigo,t=totalesNecesidades(items)[m],etiqueta=m==='SIN_DEFINIR'?'MONEDA SIN DEFINIR':m;
  return `<section class="cf-currency-group moneda-${m}"><header class="cf-currency-head"><div class="cf-currency-name"><span class="cf-currency-pill">${esc(etiqueta)}</span> Proveedores que cobran en ${esc(etiqueta)}</div><span>${items.length} registro(s) de proveedor · orden alfabético</span></header>
    <div class="cf-table-wrap"><table class="cf-table cf-provider-table"><thead><tr><th>Proveedor</th><th>Servicio / actividad</th><th class="num">Costo conocido</th><th class="num">Monto enviado</th><th class="num">Abonos aplicados</th><th class="num">Saldo del proveedor</th><th>Estado</th><th></th></tr></thead>
    <tbody>${items.map(filaProveedor).join('')}</tbody>
    <tfoot><tr class="cf-destination-total"><th colspan="2">TOTAL ${esc(grupo?.destino||state.destino)} · ${esc(etiqueta)}${t.parcial?' · PARCIAL':''}</th><th class="num">${fmtMoney(t.costo,m)}</th><th>Sin sumar monedas distintas</th><th class="num">${fmtMoney(t.aplicado,m)}</th><th class="num">POR PAGAR ${fmtMoney(t.pagar,m)}</th><th colspan="2">${t.favor?`A favor: ${fmtMoney(t.favor,m)}`:''}</th></tr></tfoot></table></div></section>`;
}

function renderProveedores() {
  prepararDesplegablesProveedores();
  const items=state.destino?filasConRaicesVisibles(proveedoresDestino()):[],todos=state.destino==='TODOS_DESTINOS';
  $('#tituloDestino').textContent=todos?'TODOS LOS DESTINOS':state.destino||'Selecciona un destino';
  $('#subtituloDestino').textContent='Actividades y hoteles separados · proveedores A–Z · monedas originales primero.';
  const etiqueta=todos?'todos los destinos':state.destino||'la selección';
  $('#btnExportarTodo').textContent=`Exportar ${etiqueta} a Excel`;
  $('#btnExportarTodo').disabled=!items.length;
  $('#btnExportarDestino').hidden=true;
  $('#sinProveedores').hidden=!!items.length;$('#sinProveedores').textContent=state.destino?'No hay proveedores para esta selección.':'Selecciona un destino o Todos los destinos.';
  if(todos)$('#planificacionDestino').innerHTML='<div class="cf-selection-note">Vista general: cada destino conserva sus monedas y subtotales. Selecciona un destino para planificar sus tipos de cambio.</div>';
  else renderPlanificacion(items);
  const destinos=todos?ordenarDestinos([...new Set(items.map(r=>destinoVista(r.destinoFinanciero)))]):state.destino?[state.destino]:[];
  const contenedor=$('#gruposFinancieros');
  contenedor.innerHTML=destinos.map(dest=>{
    const delDestino=items.filter(r=>destinoVista(r.destinoFinanciero)===dest);
    return `<section class="cf-destination-section">${todos?`<h2 class="cf-destination-heading">${esc(dest)}</h2>`:''}${['ACTIVIDAD','HOTEL'].map(tipo=>{
      const rs=delDestino.filter(r=>norm(r.tipo)===tipo);if(!rs.length)return '';
      const orden=monedasDestino(dest,rs.map(r=>r.monedaObligacion));
      return `<article class="cf-type-section"><header class="cf-type-heading"><h3>${tipo==='HOTEL'?'HOTELES':'ACTIVIDADES'}</h3><span>${esc(dest)} · ${rs.length} registro(s) de proveedor</span></header>${orden.filter(m=>rs.some(r=>moneda(r.monedaObligacion)===m)).map(m=>bloqueMoneda({destino:dest},{codigo:m,items:rs.filter(r=>moneda(r.monedaObligacion)===m)})).join('')}</article>`;
    }).join('')}</section>`;
  }).join('');
  $$('.btn-detalle',contenedor).forEach(btn=>btn.onclick=()=>{const r=items.find(r=>claveProveedor(r)===btn.closest('tr').dataset.key);if(r)abrirDetalle(r);});
}

async function consultarColeccionDetalle(nombre,proveedorId,monedaObligacion,tipo) {
  const p=state.proveedor;
  if(p?.esDetalleCuenta) {
    const snap=await getDocs(query(collection(db,nombre),where('anoViaje','==',Number(state.ano))));
    const ids=new Set(p.resumenIdsCuenta),proveedores=new Set(p.cuentaCompartida.miembros.map(x=>x.proveedorId));
    return snap.docs.map(d=>({...d.data(),id:d.id})).filter(r=>norm(r.destinoFinanciero)===norm(p.destinoFinanciero)&&(nombre===COLECCIONES.REGLAS?proveedores.has(r.proveedorId):ids.has(r.resumenId)));
  }
  const condiciones=[where('anoViaje','==',Number(state.ano)),where('proveedorId','==',proveedorId)];
  if(monedaObligacion)condiciones.push(where('monedaObligacion','==',monedaObligacion));
  if(tipo&&[COLECCIONES.OBLIGACIONES,COLECCIONES.ABONOS].includes(nombre))condiciones.push(where('tipo','==',tipo));
  const snap=await getDocs(query(collection(db,nombre),...condiciones));
  return snap.docs.map(d=>({...d.data(),id:d.id})).filter(r=>!r.destinoFinanciero||norm(r.destinoFinanciero)===norm(p?.destinoFinanciero));
}

async function abrirDetalle(resumen) {
  state.proveedor = resumenParaDetalle(resumen); resumen=state.proveedor; state.obligaciones = []; state.abonos = []; state.reglas = []; state.historial = [];
  $('#detalleTitulo').textContent = (resumen.proveedorNombre || resumen.proveedorId)+(resumen.esDetalleCuenta?' · CUENTA COMPARTIDA':'');
  $('#detalleSubtitulo').textContent = `${norm(resumen.destinoFinanciero)} · ${norm(resumen.tipo)} · DEUDA EN ${moneda(resumen.monedaObligacion)}${resumen.esDetalleCuenta?' · '+resumen.cuentaCompartida.miembros.map(x=>x.nombre).join(' + '):''}`;
  $('#detalleBackdrop').classList.add('open'); $('#detalleBackdrop').setAttribute('aria-hidden', 'false'); document.body.classList.add('modal-open');
  activarTab('obligaciones'); renderMetricas(); setEstado('Cargando detalle…', false, '#detalleEstado');
  try {
    const [obligaciones, abonos, reglas, historial] = await Promise.all([
      consultarColeccionDetalle(COLECCIONES.OBLIGACIONES, resumen.proveedorId, moneda(resumen.monedaObligacion), norm(resumen.tipo)),
      consultarColeccionDetalle(COLECCIONES.ABONOS, resumen.proveedorId, moneda(resumen.monedaObligacion),norm(resumen.tipo)),
      consultarColeccionDetalle(COLECCIONES.REGLAS, resumen.proveedorId, null),
      consultarHistorial(resumen.proveedorId)
    ]);
    state.obligaciones = obligaciones; state.abonos = abonos; state.reglas = reglas; state.historial = historial;
    renderMetricas(); renderDetalle(); setEstado('', false, '#detalleEstado');
  } catch (e) {
    console.error(e); setEstado(`No fue posible cargar el detalle: ${e.message}`, true, '#detalleEstado');
  }
}

async function consultarHistorial(proveedorId) {
  const p=state.proveedor,ids=new Set(p?.esDetalleCuenta?p.cuentaCompartida.miembros.map(x=>x.proveedorId):[proveedorId]);
  const snap=await getDocs(query(collection(db,COLECCIONES.HISTORIAL),where('anoViaje','==',Number(state.ano))));
  return snap.docs.map(d=>({...d.data(),id:d.id})).filter(h=>(!h.destinoFinanciero||norm(h.destinoFinanciero)===norm(p?.destinoFinanciero))&&(ids.has(h.proveedorId)||(h.proveedoresAfectados||[]).some(id=>ids.has(id)))).sort((a,b)=>fechaMillis(b.creadoAt)-fechaMillis(a.creadoAt)).slice(0,300);
}

function fechaMillis(v) { return typeof v?.toMillis === 'function' ? v.toMillis() : new Date(v || 0).getTime(); }

function renderMetricas() {
  const r=state.proveedor;if(!r)return;
  const enviado=Object.entries(r.totalEnviadoPorMoneda||{}).filter(([,v])=>num(v)).map(([m,v])=>fmtMoney(v,m)).join('<br>')||'—';
  const filas=[['COSTO TOTAL',r.requiereConfiguracion?'PENDIENTE / PARCIAL':fmtMoney(r.totalObligacion,r.monedaObligacion),textoCoberturaMetrica(r,'total')],
    ['MONTO ENVIADO',enviado,'Se conserva la moneda original del pago.'],
    ['ABONOS APLICADOS',fmtMoney(r.totalAplicado,r.monedaObligacion),textoCoberturaMetrica(r,'cubiertos')],
    ['SALDO POR PAGAR',r.requiereConfiguracion?'PENDIENTE / PARCIAL':fmtMoney(r.saldoPendiente,r.monedaObligacion),textoCoberturaMetrica(r,'pendientes')]];
  $('#metricasProveedor').innerHTML=filas.map(([l,v,c])=>`<div class="cf-metric"><span class="cf-metric-label">${l}</span><strong class="cf-metric-value">${v}</strong><small class="cf-pax-line">${esc(c)}</small></div>`).join('');
}

function renderDetalle() { renderObligaciones(); renderAbonos(); renderCuentaProveedor(); renderReglas(); renderHistorial(); }

function valorPaxReal(obligacion) {
  const valor = obligacion.paxReales;
  return valor === null || valor === undefined || valor === ''
    ? '<span class="cf-badge pending">Pendiente</span>'
    : fmtNum(valor);
}

function estadoCosto(obligacion) {
  if (obligacion.requiereConfiguracion) return '<span class="cf-state warning">Faltan datos de costo</span>';
  if (obligacion.paxReales === null || obligacion.paxReales === undefined || obligacion.paxReales === '') {
    return '<span class="cf-state warning">Pax por revisar</span>';
  }
  return `<span class="cf-state payable">${esc(norm(obligacion.estadoFinanciero || obligacion.estadoRealizacion || 'PROGRAMADO'))}</span>`;
}

function renderCostosActividades(rows) { return tablaCostosAgrupados(rows,false); }

function renderCostosHoteles(rows) { return tablaCostosAgrupados(rows,true); }

function renderObligaciones() {
  const rows = [...state.obligaciones].sort(ordenarCostosGrupo);

  const esHotel =
    norm(state.proveedor?.tipo) === 'HOTEL';

  const tabla = esHotel
    ? renderCostosHoteles(rows)
    : renderCostosActividades(rows);

  let editores = '';

  if (esHotel && rows.length) {
    const hoteles = [
      ...new Map(
        rows
          .filter(o => o.hotelId)
          .map(o => [
            o.hotelId,
            {
              hotelId: o.hotelId,
              nombre:
                o.servicioNombre ||
                o.hotelNombre ||
                o.hotelId
            }
          ])
      ).values()
    ];

    editores = `
      <div class="cf-card" style="margin:14px 0;">
        <h3>Condiciones económicas</h3>

        <p class="cf-muted">
          Las tarifas generales se comparten con Hoteles.
          Los acuerdos particulares se guardan
          en la asignación del grupo.
        </p>

        <div class="cf-row" style="flex-wrap:wrap;">
          ${hoteles.map(h => `
            <button
              type="button"
              class="cf-btn btn-tarifa-hotel"
              data-hotel="${esc(h.hotelId)}"
            >
              Tarifas: ${esc(h.nombre)}
            </button>
          `).join('')}
        </div>

        <div class="cf-table-wrap" style="margin-top:14px;">
          <table class="cf-table">
            <thead>
              <tr>
                <th>Grupo</th>
                <th>Estadía</th>
                <th></th>
              </tr>
            </thead>

            <tbody>
              ${rows.map(o => `
                <tr>
                  <td>
                    ${esc(o.numeroNegocio || '')}
                    · ${esc(o.nombreGrupo || '')}
                  </td>

                  <td>
                    ${fechaTexto(o.checkIn)}
                    –
                    ${fechaTexto(o.checkOut)}
                  </td>

                  <td>
                    <button
                      type="button"
                      class="cf-btn btn-acuerdo-hotel"
                      data-obligacion="${esc(o.id)}"
                    >
                      Editar acuerdo
                    </button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  $('#panel-obligaciones').innerHTML = `
    <div class="cf-section-head">
      <div>
        <h3>
          ${
            esHotel
              ? 'Detalle de costos de hotel'
              : 'Detalle de costos de actividades'
          }
        </h3>

        <div class="cf-muted">
          Pax acordados, reales y cobrados
          se conservan como datos independientes.
        </div>
      </div>

      <span class="cf-muted">
        ${rows.length} registro(s)
      </span>
    </div>

    ${editores}
    ${tabla}

    ${
      rows.length
        ? ''
        : '<div class="cf-empty">No hay costos registrados.</div>'
    }
  `;

  const panel = $('#panel-obligaciones');

  $$('.btn-tarifa-hotel', panel).forEach(btn => {
    btn.addEventListener('click', () => {
      abrirCondicionesHotelFinanzas({
        tipo: 'general',
        hotelId: btn.dataset.hotel
      });
    });
  });

  $$('.btn-acuerdo-hotel', panel).forEach(btn => {
    btn.addEventListener('click', () => {
      const obligacion = rows.find(
        o => o.id === btn.dataset.obligacion
      );

      if (obligacion) {
        abrirCondicionesHotelFinanzas({
          tipo: 'grupo',
          obligacion
        });
      }
    });
  });
}

async function abrirCondicionesHotelFinanzas({
  tipo,
  hotelId,
  obligacion
}) {
  try {
    const ano = Number(state.ano);

    hotelId = hotelId || obligacion?.hotelId;

    if (!hotelId) {
      throw new Error(
        'No se pudo identificar el hotel.'
      );
    }

    const hotelSnap = await getDoc(
      doc(db, 'hoteles', hotelId)
    );

    if (!hotelSnap.exists()) {
      throw new Error(
        'El hotel ya no existe.'
      );
    }

    const hotel = hotelSnap.data();

    let ref;
    let valores;
    let datosLeidos;

    if (tipo === 'general') {
      ref = doc(
        db,
        'FinanzasHotelesTarifas',
        `${ano}__hotel__${hotelId}`
      );

      const snap = await getDoc(ref);

      datosLeidos = snap.exists()
        ? snap.data()
        : null;

      const tarifa = datosLeidos || {};

      valores = {
        reglaPersonas: tarifa.reglaPersonas || {},
        moneda:
          tarifa.moneda === 'SIN_DEFINIR'
            ? ''
            : tarifa.moneda || '',

        ad:
          tarifa.tarifasPorPension
            ?.alojamiento_desayuno ?? '',

        mp:
          tarifa.tarifasPorPension?.media ?? '',

        pc:
          tarifa.tarifasPorPension?.completa ?? '',

        detalle:
          tarifa.observaciones || ''
      };
    } else {
      ref = await localizarAsignacionFinanzas(
        obligacion,
        ano
      );

      const snap = await getDoc(ref);

      if (!snap.exists()) {
        throw new Error(
          'La asignación ya no existe.'
        );
      }

      datosLeidos = snap.data();

      valores = {
        ...(datosLeidos.finanzas || {})
      };
    }

    mostrarEditorHotelFinanzas({
      tipo,
      ano,
      hotelId,
      hotel,
      ref,
      valores,
      datosLeidos
    });
  } catch (error) {
    console.error(error);

    setEstado(
      error.message ||
      'No se pudieron cargar las condiciones.',
      true,
      '#detalleEstado'
    );
  }
}

async function localizarAsignacionFinanzas(
  obligacion,
  ano
) {
  if (obligacion.fuenteAsignacionId) {
    const ref = doc(
      db,
      'hotelAssignments',
      obligacion.fuenteAsignacionId
    );

    const snap = await getDoc(ref);

    if (!snap.exists()) {
      throw new Error(
        'No se encontró la asignación de esta obligación.'
      );
    }

    const a = snap.data();

    if (
      String(a.hotelId) !==
        String(obligacion.hotelId) ||

      String(a.grupoId) !==
        String(obligacion.grupoId) ||

      Number(a.anoViaje || 2025) !== ano
    ) {
      throw new Error(
        'La asignación cambió de hotel, grupo o año. ' +
        'Actualice la información antes de editar.'
      );
    }

    return ref;
  }

  /*
   * Compatibilidad con obligaciones antiguas
   * sin fuenteAsignacionId.
   */
  const snap = await getDocs(
    query(
      collection(db, 'hotelAssignments'),
      where(
        'hotelId',
        '==',
        obligacion.hotelId
      )
    )
  );

  const coincidencias = snap.docs.filter(d => {
    const a = d.data();

    return (
      String(a.grupoId) ===
        String(obligacion.grupoId) &&

      Number(a.anoViaje || 2025) === ano &&

      String(a.checkIn || '') ===
        String(obligacion.checkIn || '') &&

      String(a.checkOut || '') ===
        String(obligacion.checkOut || '')
    );
  });

  if (coincidencias.length !== 1) {
    throw new Error(
      'No se pudo identificar una asignación única. ' +
      'Revise esta estadía desde Hoteles.'
    );
  }

  return coincidencias[0].ref;
}

function mostrarEditorHotelFinanzas(contexto) {
  const {
    tipo,
    ano,
    hotel,
    valores: v
  } = contexto;

  let dialogo = $('#dialogCondicionesHotel');

  if (!dialogo) {
    dialogo = document.createElement('dialog');
    dialogo.id = 'dialogCondicionesHotel';
    document.body.appendChild(dialogo);
  }

  const general = tipo === 'general';

  const campoNumero = (nombre, titulo, valor, entero = false) => `
    <div class="cf-field">
      <label for="hf-${nombre}">${titulo}</label>

      <input
        id="hf-${nombre}"
        name="${nombre}"
        type="number"
        min="0"
        step="${entero ? '1' : '0.01'}"
        value="${esc(valor ?? '')}"
      >
    </div>
  `;

  const opcionesMoneda = `
    <option value="">${
      general
        ? 'Pendiente de configurar'
        : 'Usar moneda del hotel'
    }</option>

    ${['CLP', 'USD', 'BRL', 'ARS'].map(m => `
      <option
        value="${m}"
        ${v.moneda === m ? 'selected' : ''}
      >
        ${m}
      </option>
    `).join('')}
  `;

  dialogo.innerHTML = `
    <div class="cf-dialog-head">
      <h3>
        ${
          general
            ? 'Tarifas generales'
            : 'Acuerdo de la estadía'
        }
      </h3>

      <p>${esc(hotel.nombre || '')} · ${ano}</p>
    </div>

    <form class="cf-dialog-body">
      <p class="cf-muted">
        ${
          general
            ? 'Tarifas por persona por noche. Vacío significa pendiente; cero significa sin costo.'
            : 'Esta edición es opcional. Los valores vacíos heredan la regla del hotel y las personas se calculan desde la asignación.'
        }
      </p>

      ${general ? '' : '<label><input type="checkbox" name="acuerdoExcepcional"> Este grupo tiene un acuerdo excepcional</label>'}
      <div class="cf-form-grid">
        <div class="cf-field">
          <label for="hf-moneda">Moneda</label>

          <select id="hf-moneda" name="moneda">
            ${opcionesMoneda}
          </select>
        </div>

        ${
          general
            ? `
              <fieldset><legend>Personas que cobra el hotel · regla para todas sus estadías</legend><label><input type="checkbox" id="hf-estudiantes" name="regla-estudiantes" ${(v.reglaPersonas?.estudiantes ?? true) ? 'checked' : ''}> Estudiantes</label><label><input type="checkbox" id="hf-adultos" name="regla-adultos" ${(v.reglaPersonas?.adultos ?? true) ? 'checked' : ''}> Adultos</label><label><input type="checkbox" id="hf-coordinadores" name="regla-coordinadores" ${(v.reglaPersonas?.coordinadores ?? false) ? 'checked' : ''}> Coordinadores</label><label><input type="checkbox" id="hf-conductores" name="regla-conductores" ${(v.reglaPersonas?.conductores ?? false) ? 'checked' : ''}> Conductores</label><label>Liberados por estadía (se descuentan de las personas seleccionadas)<input type="number" min="0" step="1" id="hf-liberados" name="regla-liberados" value="${esc(v.reglaPersonas?.liberadosPorAsignacion ?? 0)}"></label><p>Esta regla se aplica sin guardar cada grupo. Las habitaciones y sus suplementos requieren un acuerdo adicional cuando corresponda.</p></fieldset>
              ${campoNumero(
                'ad',
                'Alojamiento con desayuno',
                v.ad
              )}

              ${campoNumero(
                'mp',
                'Media pensión',
                v.mp
              )}

              ${campoNumero(
                'pc',
                'Pensión completa',
                v.pc
              )}
            `
            : `
              <div class="cf-field">
                <label for="hf-pension">Pensión</label>

                <select id="hf-pension" name="pension">
                  ${[
                    ['', 'Usar la del hotel'],
                    ['alojamiento_desayuno', 'Desayuno'],
                    ['media', 'Media pensión'],
                    ['completa', 'Pensión completa']
                  ].map(([valor, etiqueta]) => `
                    <option
                      value="${valor}"
                      ${
                        (v.pension || '') === valor
                          ? 'selected'
                          : ''
                      }
                    >
                      ${etiqueta}
                    </option>
                  `).join('')}
                </select>
              </div>

              <div class="cf-field">
                <label for="hf-modalidad">Cálculo</label>

                <select id="hf-modalidad" name="modalidad">
                  <option
                    value="pax_noche"
                    ${
                      v.modalidad !== 'total'
                        ? 'selected'
                        : ''
                    }
                  >
                    Personas × noches × tarifa
                  </option>

                  <option
                    value="total"
                    ${
                      v.modalidad === 'total'
                        ? 'selected'
                        : ''
                    }
                  >
                    Total acordado
                  </option>
                </select>
              </div>

              ${campoNumero(
                'personasCobradas',
                'Personas cobradas',
                v.personasCobradas,
                true
              )}

              ${campoNumero(
                'tarifaParticular',
                'Tarifa particular por persona por noche',
                v.tarifaParticular
              )}

              ${campoNumero(
                'totalAcordado',
                'Total acordado de la estadía',
                v.totalAcordado
              )}

              ${campoNumero(
                'adicionales',
                'Adicionales',
                v.adicionales
              )}

              ${campoNumero(
                'descuentos',
                'Descuentos',
                v.descuentos
              )}

              <p class="cf-muted wide">
                En modalidad total, el monto debe incluir
                todos los ajustes. Deje adicionales
                y descuentos en cero.
              </p>
            `
        }

        <div class="cf-field wide">
          <label for="hf-detalle">
            ${
              general
                ? 'Observaciones del acuerdo'
                : 'Detalle del acuerdo particular'
            }
          </label>

          <textarea
            id="hf-detalle"
            name="detalle"
            rows="3"
          >${esc(v.detalle || '')}</textarea>
        </div>

        <div class="cf-field wide">
          <label for="hf-motivo">
            Motivo de esta modificación
          </label>

          <textarea
            id="hf-motivo"
            name="motivo"
            rows="2"
            required
          ></textarea>
        </div>
      </div>

      <div class="cf-status error" data-error></div>

      <div class="cf-form-actions">
        <button type="button" class="cf-btn" data-cancelar>
          Cancelar
        </button>

        <button type="submit" class="cf-btn blue">
          Guardar condiciones
        </button>
      </div>
    </form>
  `;

  if (!general) {
    const activar = dialogo.querySelector('[name="acuerdoExcepcional"]');
    activar.checked = tieneExcepcionHotel(v);
    activar.onchange = () => {
      dialogo.querySelectorAll('.cf-form-grid input, .cf-form-grid select, .cf-form-grid textarea').forEach(el => {
        if (el.name !== 'motivo') el.disabled = !activar.checked;
      });
    };
    activar.onchange();
  }
  $('[data-cancelar]', dialogo).addEventListener(
    'click',
    () => dialogo.close()
  );

  $('form', dialogo).addEventListener(
    'submit',
    event => guardarCondicionesHotelFinanzas(
      event,
      contexto,
      dialogo
    )
  );

  if (!dialogo.open) {
    dialogo.showModal();
  }
}

async function guardarCondicionesHotelFinanzas(
  event,
  contexto,
  dialogo
) {
  event.preventDefault();

  const {
    tipo,
    ano,
    hotelId,
    hotel,
    ref,
    datosLeidos
  } = contexto;

  const formulario = event.currentTarget;

  const boton = $(
    'button[type="submit"]',
    formulario
  );

  const errorNodo = $('[data-error]', formulario);

  if (boton.disabled) return;

  errorNodo.textContent = '';

  const valor = nombre =>
    formulario.elements.namedItem(nombre).value.trim();

  const opcional = nombre => {
    const texto = valor(nombre);

    if (texto === '') return null;

    const numero = Number(texto);

    if (!Number.isFinite(numero) || numero < 0) {
      throw new Error(
        'Los importes deben ser números mayores o iguales a cero.'
      );
    }

    return numero;
  };

  try {
    const motivo = valor('motivo');

    if (!motivo) {
      throw new Error(
        'Indique el motivo de la modificación.'
      );
    }

    const codigoMoneda = valor('moneda');

    if (
      codigoMoneda &&
      !['CLP', 'USD', 'BRL', 'ARS'].includes(codigoMoneda)
    ) {
      throw new Error(
        'La moneda seleccionada no es válida.'
      );
    }

    let condiciones;

    if (tipo === 'general') {
      const tarifasPorPension = {
        alojamiento_desayuno: opcional('ad'),
        media: opcional('mp'),
        completa: opcional('pc')
      };

      if (
        !codigoMoneda &&
        Object.values(tarifasPorPension).some(
          n => n !== null
        )
      ) {
        throw new Error(
          'Seleccione la moneda de las tarifas.'
        );
      }

      condiciones = {
        versionEsquema: 2,
        anoViaje: ano,
        hotelId,
        hotelNombre: hotel.nombre || '',
        destino: hotel.destino || '',
        ciudad: hotel.ciudad || '',
        moneda: codigoMoneda || 'SIN_DEFINIR',
        tipoTarifa: 'pax_noche',
        tarifasPorPension,
        reglaPersonas: Object.fromEntries([
          ...['estudiantes','adultos','coordinadores','conductores'].map(k => [k, dialogo.querySelector(`[name="regla-${k}"]`).checked]),
          ['liberadosPorAsignacion', opcional('regla-liberados') ?? 0]
        ]),
        observaciones: valor('detalle')
      };
    } else if (!formulario.elements.namedItem('acuerdoExcepcional').checked) {
      condiciones = {versionEsquema: 2, usarReglaHotel: true};
    } else {
      const modalidad = valor('modalidad');
      const personas = opcional('personasCobradas');
      const tarifa = opcional('tarifaParticular');
      const total = opcional('totalAcordado');
      const adicionales = opcional('adicionales') ?? 0;
      const descuentos = opcional('descuentos') ?? 0;
      const detalle = valor('detalle');

      if (
        personas !== null &&
        !Number.isInteger(personas)
      ) {
        throw new Error(
          'Las personas cobradas deben ser un número entero.'
        );
      }

      if (!['pax_noche', 'total'].includes(modalidad)) {
        throw new Error(
          'La modalidad no es válida.'
        );
      }

      if (modalidad === 'total' && total === null) {
        throw new Error(
          'Ingrese el total acordado.'
        );
      }

      if (
        modalidad === 'total' &&
        (adicionales > 0 || descuentos > 0)
      ) {
        throw new Error(
          'El total acordado debe incluir los ajustes. ' +
          'Deje adicionales y descuentos en cero.'
        );
      }

      if (
        (
          modalidad === 'total' ||
          tarifa !== null ||
          adicionales > 0 ||
          descuentos > 0
        ) &&
        !detalle
      ) {
        throw new Error(
          'Describa el acuerdo particular.'
        );
      }

      condiciones = {
        versionEsquema: 2,
        usarReglaHotel: false,
        pension: valor('pension'),
        modalidad,
        moneda: codigoMoneda,
        personasCobradas: personas,

        tarifaParticular:
          modalidad === 'pax_noche' ? tarifa : null,

        totalAcordado:
          modalidad === 'total' ? total : null,

        adicionales,
        descuentos,
        detalle
      };
    }

    if (condiciones.reglaPersonas && !Number.isInteger(condiciones.reglaPersonas.liberadosPorAsignacion)) {
      throw new Error('Los liberados deben ser un número entero.');
    }
    boton.disabled = true;

    const historialRef = doc(
      collection(db, COLECCIONES.HISTORIAL)
    );

    const email = state.usuario?.email || '';

    await runTransaction(db, async tx => {
      const snap = await tx.get(ref);

      const vigente = snap.exists()
        ? snap.data()
        : null;

      /*
       * Si alguien cambió las condiciones mientras
       * el editor estaba abierto, volver a cargarlas.
       */
      const antesComparable = tipo === 'general'
        ? datosLeidos
        : datosLeidos?.finanzas || null;

      const vigenteComparable = tipo === 'general'
        ? vigente
        : vigente?.finanzas || null;

      if (
        JSON.stringify(antesComparable) !==
        JSON.stringify(vigenteComparable)
      ) {
        throw new Error(
          'Las condiciones cambiaron mientras editaba. ' +
          'Cierre y vuelva a abrir el editor.'
        );
      }

      if (
        tipo !== 'general' &&
        (
          !vigente ||
          String(vigente.hotelId) !== String(hotelId) ||
          Number(vigente.anoViaje || 2025) !== ano ||
          String(vigente.grupoId) !==
            String(datosLeidos.grupoId) ||
          String(vigente.checkIn || '') !==
            String(datosLeidos.checkIn || '') ||
          String(vigente.checkOut || '') !==
            String(datosLeidos.checkOut || '')
        )
      ) {
        throw new Error(
          'La asignación cambió. Vuelva a abrir el editor.'
        );
      }

      const despues = {
        ...condiciones,
        actualizadoPor: email,
        actualizadoAt: serverTimestamp()
      };

      if (tipo === 'general') {
        tx.set(ref, despues, { merge: true });
      } else {
        tx.update(ref, {
          finanzas: despues,
          updatedAt: serverTimestamp()
        });
      }

      tx.set(historialRef, {
        anoViaje: ano,

        proveedorId:
          state.costosAno.find(o=>o.hotelId===hotelId&&norm(o.destinoFinanciero)===norm(state.proveedor?.destinoFinanciero))?.proveedorId || state.proveedor?.proveedorId || '',

        proveedorNombre:
          state.costosAno.find(o=>o.hotelId===hotelId&&norm(o.destinoFinanciero)===norm(state.proveedor?.destinoFinanciero))?.proveedorNombre || state.proveedor?.proveedorNombre || '',

        destinoFinanciero:
          state.proveedor?.destinoFinanciero || '',

        hotelId,
        fuentePath: ref.path,

        accion: tipo === 'general'
          ? 'EDICION_TARIFA_HOTEL'
          : 'EDICION_ACUERDO_HOTEL',

        motivo,
        antes: vigenteComparable,
        despues,
        usuarioEmail: email,
        creadoAt: serverTimestamp()
      });
    });
  } catch (error) {
    console.error(error);
    errorNodo.textContent = error.message;
    return;
  } finally {
    boton.disabled = false;
  }

  dialogo.close();

  setEstado(
    'Condiciones guardadas y disponibles en Hoteles. ' +
    'Los costos y saldos mostrados aún requieren recálculo.',
    false,
    '#detalleEstado'
  );

  try {
    state.historial = await consultarHistorial(
      state.proveedor.proveedorId
    );

    renderHistorial();
  } catch (error) {
    console.error(error);
  }
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
        <td>${esc(a.servicioNombre||a.proveedorNombre||a.proveedorId||'')}</td>

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
            a.coberturaPax?.estado==='INFORMADA' ? `${fmtNum(a.coberturaPax.cantidad)} ${esc(textoUnidadCobertura(a.coberturaPax.unidad))}` : a.coberturaPax?.estado==='NO_APLICA' ? 'No aplica' : 'Por confirmar'
          }
        </td>

        <td>
          <span
            class="cf-badge ${
              revisado ? 'reviewed' : 'pending'
            }"
          >
            ${a.requiereVinculacion ? 'PENDIENTE DE VINCULACIÓN' : esc(estado)}
          </span>
          ${a.motivoPendiente ? `<small style="display:block">${esc(a.motivoPendiente.replaceAll('_', ' '))}</small>` : ''}
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
            ${a.requiereVinculacion ? 'disabled title="Primero debe vincularse el pago"' : ''}
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
            <th>Fecha</th><th>Hotel / servicio de origen</th>
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
  $('#panel-reglas').innerHTML = `<div class="cf-section-head"><h3>Reglas del proveedor</h3><span class="cf-muted">La regla del servicio y año tiene prioridad sobre la general.</span></div><div class="cf-table-wrap"><table class="cf-table"><thead><tr><th>Hotel / proveedor de origen</th><th>Alcance</th><th>Servicio</th><th>Año</th><th>Tipo</th><th>Descripción</th><th>Estado</th></tr></thead><tbody>${rows.map(r => `<tr><td>${esc(r.proveedorNombre||r.proveedorId||'')}</td><td>${r.servicioId ? 'Servicio' : 'General proveedor'}</td><td>${esc(r.servicioNombre || 'Todos')}</td><td>${esc(r.anoViaje || 'Todos')}</td><td>${esc(norm(r.tipoRegla || 'INFORMATIVA'))}</td><td>${esc(r.descripcion || '')}</td><td>${r.activa === false ? 'Inactiva' : 'Activa'}</td></tr>`).join('')}</tbody></table></div>${rows.length ? '' : '<div class="cf-empty">Este proveedor no tiene reglas especiales registradas.</div>'}`;
}

function renderHistorial() {
  const rows = state.historial;
  $('#panel-historial').innerHTML = `<div class="cf-section-head"><h3>Historial de auditoría</h3></div><div class="cf-table-wrap"><table class="cf-table"><thead><tr><th>Fecha</th><th>Acción</th><th>Usuario</th><th>Motivo</th><th>Antes</th><th>Después</th></tr></thead><tbody>${rows.map(h => `<tr><td>${fechaTexto(h.creadoAt)}</td><td>${esc(h.accion || '')}</td><td>${esc(h.usuarioEmail || '')}</td><td>${esc(h.motivo || '')}</td><td>${esc(resumenCambio(h.antes))}</td><td>${esc(resumenCambio(h.despues))}</td></tr>`).join('')}</tbody></table></div>${rows.length ? '' : '<div class="cf-empty">No hay modificaciones auditadas.</div>'}`;
}

function resumenCambio(v) {
  if(v?.miembrosProveedorIds) {
    const nombre=id=>v.nombres?.[id]||id;
    return `Raíz: ${nombre(v.raizProveedorId)} · Integrantes: ${v.miembrosProveedorIds.map(nombre).join(' + ')}`;
  }
  if (!v || typeof v !== 'object') {
    return '—';
  }

  if (v.tarifasPorPension) {
    const t = v.tarifasPorPension;

    const tarifa = valor =>
      valor === null || valor === undefined
        ? 'Pendiente'
        : fmtNum(valor);

    return [
      `Moneda: ${v.moneda || 'Pendiente'}`,
      `AD: ${tarifa(t.alojamiento_desayuno)}`,
      `MP: ${tarifa(t.media)}`,
      `PC: ${tarifa(t.completa)}`,
      v.observaciones || ''
    ].filter(Boolean).join(' · ');
  }

  if (
    Object.prototype.hasOwnProperty.call(
      v,
      'personasCobradas'
    )
  ) {
    const mostrar = valor =>
      valor === null || valor === undefined
        ? 'Pendiente'
        : fmtNum(valor);

    return [
      `Modalidad: ${v.modalidad || 'pax_noche'}`,
      `Pensión: ${v.pension || 'Del hotel'}`,
      `Moneda: ${v.moneda || 'Del hotel'}`,
      `Personas: ${mostrar(v.personasCobradas)}`,
      `Tarifa: ${
        v.tarifaParticular == null
          ? 'Del hotel'
          : fmtNum(v.tarifaParticular)
      }`,
      `Total acordado: ${mostrar(v.totalAcordado)}`,
      `Adicionales: ${fmtNum(v.adicionales || 0)}`,
      `Descuentos: ${fmtNum(v.descuentos || 0)}`,
      v.detalle || ''
    ].filter(Boolean).join(' · ');
  }

  return [
    `TC: ${v.tipoCambioAplicado ?? '—'}`,
    `Aplicado: ${v.montoAplicado ?? '—'}`,
    `Cobertura: ${v.unidadesCubiertas ?? '—'}`
  ].join(' · ');
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
  if (a.requiereVinculacion) {
    setEstado('Este pago está registrado, pero falta vincularlo a un servicio o costo hotelero. Corrige la vinculación antes de aplicar dinero al saldo.', true, '#detalleEstado');
    return;
  }
  $('#abonoId').value = a.id; $('#abMonedaEnviada').value = moneda(a.monedaEnviada); $('#abMontoEnviado').value = num(a.montoEnviado);
  $('#abMonedaAplicada').value = moneda(a.monedaAplicada || a.monedaObligacion); $('#abTipoCambio').value = a.tipoCambioAplicado ?? '';
  $('#abMontoAplicado').value = num(a.montoAplicado); $('#abUnidadesCubiertas').value = a.coberturaPax?.estado==='INFORMADA' ? a.coberturaPax.cantidad : '';
  $('#abCoberturaUnidad').value = norm(a.tipo)==='HOTEL'?'PAX_NOCHE':'PAX';
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
  if (actual.requiereVinculacion) { $('#errorEditarAbono').textContent = 'Primero debe corregirse la vinculación del pago.'; return; }


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

  const cantidadCoberturaTexto=$('#abUnidadesCubiertas').value.trim();
  const unidadesCubiertas=Number(cantidadCoberturaTexto||0);
  if(!Number.isInteger(unidadesCubiertas)||unidadesCubiertas<0){$('#errorEditarAbono').textContent='La cobertura debe ser una cantidad entera, desde cero, o quedar vacía si no se conoce.';return;}

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
          JSON.stringify(vigente.coberturaPax||null)!==JSON.stringify(actual.coberturaPax||null) ||

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

        const coberturaPax={versionEsquema:1,estado:cantidadCoberturaTexto===''?(vigente.coberturaPax?.estado==='NO_APLICA'?'NO_APLICA':'PENDIENTE'):'INFORMADA',unidad:esHotel?'PAX_NOCHE':'PAX',cantidad:cantidadCoberturaTexto===''?null:unidadesCubiertas,servicioId:vigente.servicioId||'',montoEnviadoBase:montoEnviado,monedaEnviadaBase:monedaEnviada,detalle:motivo,actualizadoPor:email,actualizadoAt:serverTimestamp()};
        const antes = {
          coberturaPax:vigente.coberturaPax||null,
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
          coberturaPax,
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
          coberturaPax,
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
  Object.assign(actual,resultado.despues);
  const actualizado=await cargarResumenes();
  if(actualizado) {
    const siguiente=filasConRaicesVisibles(state.resumenes).find(r=>r.id===proveedorActual.id);
    if(siguiente){await abrirDetalle(siguiente);activarTab('abonos');}else cerrarDetalle();
  }
  setEstado(actualizado?'Revisión guardada y sincronizada con el pago de origen y la cuenta del proveedor.':'Revisión guardada. Actualice la información para consultar el saldo.',!actualizado,'#detalleEstado');
}

function filasResumenes(lista) {
  return [...lista].sort((a,b)=>compararNombre(a.destinoFinanciero,b.destinoFinanciero)||compararNombre(a.proveedorNombre,b.proveedorNombre)).map(r=>({
    'Cuenta ID':claveCuentaMoneda(r),'Proveedor raíz':r.cuentaCompartida?.raizNombre||r.proveedorNombre,'Tipo de cuenta':r.cuentaCompartida?'COMPARTIDA':'INDIVIDUAL',
    'Año':r.anoViaje, Destino:destinoVista(r.destinoFinanciero),'Destino original':r.destinoFinanciero, Tipo:r.tipo, Proveedor:r.proveedorNombre,
    Moneda:moneda(r.monedaObligacion), 'Costo conocido':num(r.totalObligacion),
    'Abonos aplicados':num(r.totalAplicado), 'Saldo conocido':num(r.saldoPendiente),
    'Por pagar conocido':Math.max(0,num(r.saldoPendiente)),
    'Saldo a favor confirmado':r.requiereConfiguracion?0:Math.max(0,-num(r.saldoPendiente)),
    'Costos pendientes':num(r.obligacionesSinTarifa), 'Abonos por revisar':num(r.abonosPendientesRevision),
    Estado:r.requiereConfiguracion||num(r.abonosPendientesRevision)?'PARCIAL / PENDIENTE':'COMPLETO',
    'Enviado CLP':num(r.totalEnviadoPorMoneda?.CLP),'Enviado USD':num(r.totalEnviadoPorMoneda?.USD),
    'Enviado BRL':num(r.totalEnviadoPorMoneda?.BRL),'Enviado ARS':num(r.totalEnviadoPorMoneda?.ARS),
    'Resumen ID':r.id
  }));
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

function exportarTodo() {
  return exportarSeleccionFinanzas(seleccionResumenes(),`control_finanzas_${state.ano}_${state.destino==='TODOS_DESTINOS'?'todos_destinos':String(state.destino||'seleccion').replace(/\s+/g,'_')}_${state.tipo}.xlsx`);
}

function exportarDestino(){return exportarSeleccionFinanzas(proveedoresDestino(),`control_finanzas_${state.ano}_${state.destino.replace(/\s+/g,'_')}.xlsx`);}

function exportarProveedor() {
  const p=state.proveedor;if(!p)return;
  const ids=p.esDetalleCuenta?new Set(p.resumenIdsCuenta):new Set([p.id]);
  return exportarSeleccionFinanzas(state.resumenes.filter(r=>ids.has(r.id)),`control_finanzas_${state.ano}_${String(p.proveedorNombre).replace(/[^a-z0-9]+/gi,'_')}.xlsx`);
}

function clavePreferenciasFinanzas() { return `cf-vista-v2:${state.usuario?.uid || state.usuario?.email || 'usuario'}:${state.ano}`; }

function preferenciasFinanzas() {
  try { return JSON.parse(localStorage.getItem(clavePreferenciasFinanzas()) || '{}') || {}; }
  catch { return {}; }
}

function guardarPreferenciasFinanzas(p) {
  try { localStorage.setItem(clavePreferenciasFinanzas(), JSON.stringify(p)); }
  catch { setEstado('El navegador no pudo recordar tus preferencias. Los datos financieros no se modificaron.', true); }
}

function planDestino(destino = state.destino) { return preferenciasFinanzas().planes?.[destino] || {}; }

function monedaLocalDestino(destino) {
  if (norm(destino).includes('BRASIL')) return 'BRL';
  if (norm(destino).includes('BARILOCHE')) return 'ARS';
  if (norm(destino).includes('CHILE')) return 'CLP';
  return null;
}

function monedasDestino(destino, lista = []) {
  return [...new Set([monedaLocalDestino(destino), 'USD', 'CLP', ...lista.map(moneda)])]
    .filter(Boolean).sort((a,b) => {
      const orden = [...new Set([monedaLocalDestino(destino), 'USD', 'CLP', 'BRL', 'ARS'].filter(Boolean))];
      return (orden.includes(a)?orden.indexOf(a):99)-(orden.includes(b)?orden.indexOf(b):99);
    });
}

function compararNombre(a,b) { return String(a || '').localeCompare(String(b || ''), 'es', {sensitivity:'base',numeric:true}); }

function fechaOrdenCosto(o) { return String(o.fechaServicio || o.checkIn || '').slice(0,10); }

function ordenarCostosGrupo(a,b) { return compararNombre(fechaOrdenCosto(a),fechaOrdenCosto(b)) || compararNombre(a.nombreGrupo,b.nombreGrupo) || compararNombre(a.numeroNegocio,b.numeroNegocio); }

function costosResumen(r) { return (state.costosAno || []).filter(o => o.resumenId === r.id); }

function totalesNecesidades(items) {
  const salida = {};
  for (const r of totalesCuentaSeleccion(items)) {
    const m = moneda(r.monedaObligacion);
    const t = salida[m] ||= {costo:0, aplicado:0, pagar:0, favor:0, sinTarifa:0, revision:0, parcial:false};
    t.costo += num(r.totalObligacion); t.aplicado += num(r.totalAplicado);
    t.pagar += Math.max(0,num(r.saldoPendiente));
    if (!r.requiereConfiguracion) t.favor += Math.max(0,-num(r.saldoPendiente));
    t.sinTarifa += num(r.obligacionesSinTarifa); t.revision += num(r.abonosPendientesRevision);
    t.parcial ||= !!r.requiereConfiguracion || num(r.abonosPendientesRevision)>0 || m === 'SIN_DEFINIR';
  }
  return salida;
}

function estimarFondos(items, plan) {
  const totales = totalesNecesidades(items);
  let usd = totales.USD?.pagar || 0;
  let faltaTC = false;
  for (const m of ['BRL','ARS']) {
    const pagar=totales[m]?.pagar || 0, tc=Number(plan[m]);
    if (pagar>0) { if (Number.isFinite(tc)&&tc>0) usd+=pagar/tc; else faltaTC=true; }
  }
  const usdFinal = faltaTC ? null : usd;
  const tcCLP = Number(plan.CLP);
  const clpDirectos=totales.CLP?.pagar || 0;
  const clp = usdFinal === null || usdFinal>0 && !(Number.isFinite(tcCLP)&&tcCLP>0)
    ? null : clpDirectos + usdFinal*(tcCLP>0?tcCLP:0);
  return {totales, usd:usdFinal, clp, parcial:Object.values(totales).some(t=>t.parcial)};
}

function gestionarDestinos() {
  let dialogo=$('#dialogDestinos');if(!dialogo){dialogo=document.createElement('dialog');dialogo.id='dialogDestinos';document.body.appendChild(dialogo);}
  const p=preferenciasFinanzas(),destinos=destinosVisiblesFinanzas();
  dialogo.innerHTML=`<form class="cf-dialog-body"><h3>Destinos visibles</h3><p>Solo cambia tu vista en este navegador. Todos los destinos incluye también los ocultos.</p>${destinos.map(d=>`<label class="cf-dest-choice"><input type="checkbox" name="visible" value="${esc(d)}" ${!(p.ocultos||[]).includes(d)?'checked':''}> ${esc(d)}</label>`).join('')}<div class="cf-form-actions"><button type="button" class="cf-btn" data-cancelar>Cancelar</button><button type="submit" class="cf-btn blue">Guardar vista</button></div></form>`;
  $('[data-cancelar]',dialogo).onclick=()=>dialogo.close();$('form',dialogo).onsubmit=e=>{e.preventDefault();const visibles=$$('input[name=visible]:checked',dialogo).map(x=>x.value);p.ocultos=destinos.filter(d=>!visibles.includes(d));guardarPreferenciasFinanzas(p);if(p.ocultos.includes(state.destino))state.destino=null;dialogo.close();renderDestinos();renderProveedores();};dialogo.showModal();
}

function renderPlanificacion(items) {
  const panel=$('#planificacionDestino');
  if(!state.destino){panel.innerHTML='';return;}
  const plan=planDestino(), e=estimarFondos(items,plan);
  const monedas=monedasDestino(state.destino,Object.keys(e.totales)).filter(m=>e.totales[m] && (m!=='CLP'||monedaLocalDestino(state.destino)==='CLP'||plan.mostrarCLP||['costo','aplicado','pagar','favor'].some(k=>num(e.totales.CLP?.[k])!==0)));
  const convertir=['USD','BRL','ARS'].filter(m=>num(e.totales[m]?.pagar)>0);
  panel.innerHTML=`<section class="cf-planning" aria-label="Necesidad de fondos">
    <div class="cf-plan-title"><div><h3>¿Cuánto falta pagar en ${esc(state.destino)}?</h3><p>Importes originales y estimación para preparar fondos.</p></div><span class="cf-state ${e.parcial?'warning':'partial'}">${e.parcial?'TOTAL PARCIAL · HAY PENDIENTES':'DATOS PARA CALCULAR'}</span></div>
    <div class="cf-kpi-grid">${monedas.map(m=>{const t=e.totales[m];return `<article class="cf-kpi moneda-${m}"><span>POR PAGAR EN ${m==='SIN_DEFINIR'?'MONEDA PENDIENTE':m}</span><strong>${fmtMoney(t.pagar,m)}</strong><small>${t.parcial?'Importe conocido · faltan datos':'Saldo por pagar'}${t.favor?` · Saldo a favor: ${fmtMoney(t.favor,m)}`:''}</small></article>`;}).join('')}</div>
    <div class="cf-rates">${['BRL','ARS'].filter(m=>(e.totales[m]?.pagar||0)>0).map(m=>`<label class="cf-field"><span>Tipo de cambio para planificar</span><span class="cf-rate-line">1 USD = <input type="number" min="0.000001" step="any" inputmode="decimal" data-tc="${m}" value="${esc(plan[m]??'')}" placeholder="Ingresar TC" aria-label="${m} por dólar"> ${m}</span></label>`).join('')}
      <label class="cf-check-line"><input id="mostrarCLP" type="checkbox" ${plan.mostrarCLP?'checked':''}> Mostrar presupuesto en pesos chilenos</label>
      ${plan.mostrarCLP?`<label class="cf-field"><span>Compra de dólares</span><span class="cf-rate-line">1 USD = <input type="number" min="0.000001" step="any" inputmode="decimal" data-tc="CLP" value="${esc(plan.CLP??'')}" placeholder="Ingresar TC" aria-label="Pesos chilenos por dólar"> CLP</span></label>`:''}
    </div>
    <div class="cf-budget-grid"><article class="cf-budget"><span>USD NECESARIOS${convertir.length?' PARA PAGAR '+convertir.join(' + '):''}</span><strong>${e.usd===null?'FALTA TIPO DE CAMBIO':fmtMoney(e.usd,'USD')}</strong><small>${num(e.totales.CLP?.pagar)>0?'Las cuentas cobradas en CLP se pagan por separado.':'Estimación de dólares para las cuentas seleccionadas.'}</small></article>
      ${plan.mostrarCLP?`<article class="cf-budget clp"><span>PRESUPUESTO TOTAL EN CLP</span><strong>${e.clp===null?'FALTA TIPO DE CAMBIO':fmtMoney(e.clp,'CLP')}</strong><small>Dólares estimados × CLP por USD + cuentas cobradas directamente en CLP.</small></article>`:''}</div>
    <p class="cf-plan-note">TC de planificación: no modifica pagos ni conversiones históricas. Los hoteles vinculados comparten saldo por moneda; el saldo a favor de una cuenta no compensa otras cuentas.${e.parcial?' Hay tarifas, monedas o abonos por completar; la estimación es parcial.':''}</p>
  </section>`;
  $$('[data-tc]',panel).forEach(input=>input.addEventListener('change',()=>{
    const p=preferenciasFinanzas();p.planes ||= {};p.planes[state.destino] ||= {};
    const n=Number(input.value);p.planes[state.destino][input.dataset.tc]=Number.isFinite(n)&&n>0?n:null;
    guardarPreferenciasFinanzas(p);renderPlanificacion(items);
  }));
  $('#mostrarCLP',panel).onchange=event=>{const p=preferenciasFinanzas();p.planes ||= {};p.planes[state.destino] ||= {};p.planes[state.destino].mostrarCLP=event.target.checked;guardarPreferenciasFinanzas(p);renderPlanificacion(items);};
}

function tablaCostosAgrupados(rows,esHotel) {
  const grupos=new Map();
  for(const o of rows){const k=o.servicioId||o.servicioNombre||o.hotelNombre||'Servicio';if(!grupos.has(k))grupos.set(k,[]);grupos.get(k).push(o);}
  return [...grupos.values()].sort((a,b)=>compararNombre(a[0].servicioNombre||a[0].hotelNombre,b[0].servicioNombre||b[0].hotelNombre)).map(items=>{
    items.sort(ordenarCostosGrupo);const nombre=items[0].servicioNombre||items[0].hotelNombre||'Servicio';
    const costo=items.reduce((s,o)=>s+num(o.totalObligacion),0),pendientes=items.filter(o=>o.requiereConfiguracion).length,m=items[0].monedaObligacion;
    return `<section class="cf-detail-service"><header><h3>${esc(nombre)}</h3><span>${items.length} registro(s) · ${pendientes?'TOTAL PARCIAL':'TOTAL'} ${fmtMoney(costo,m)}</span></header>${cabeceraCoberturaServicio(items)}<div class="cf-table-wrap"><table class="cf-table"><thead><tr><th>${esHotel?'Entrada / salida':'Fecha'}</th><th>N.º negocio</th><th>Grupo</th>${esHotel?'<th class="num">Noches</th>':''}<th class="num">Pax acordados</th><th class="num">Pax reales</th><th class="num">Pax cobrados</th><th>Forma de cobro</th><th class="num">Tarifa</th><th class="num">Costo</th><th>Estado</th></tr></thead><tbody>${items.map(o=>`<tr><td class="cf-date">${fechaTexto(o.fechaServicio||o.checkIn)}${esHotel?' → '+fechaTexto(o.checkOut):''}</td><td>${esc(o.numeroNegocio||'')}</td><td>${esc(o.nombreGrupo||'')}</td>${esHotel?`<td class="num">${fmtNum(o.noches)}</td>`:''}<td class="num">${fmtNum(o.paxAcordados??o.paxReservados)}</td><td class="num">${valorPaxReal(o)}</td><td class="num">${o.paxCobrados==null?'—':fmtNum(o.paxCobrados)}</td><td>${esc(norm(o.tipoCobro).replaceAll('_',' '))}</td><td class="num">${o.requiereConfiguracion?'PENDIENTE':fmtMoney(o.tarifaBase,m)}</td><td class="num">${o.requiereConfiguracion?'PENDIENTE':fmtMoney(o.totalObligacion,m)}</td><td>${estadoCosto(o)}</td></tr>`).join('')}</tbody><tfoot><tr><th colspan="${esHotel?9:8}">TOTAL DEL SERVICIO${pendientes?' · PARCIAL':''}</th><th class="num">${fmtMoney(costo,m)}</th><th>${pendientes?pendientes+' pendiente(s)':''}</th></tr></tfoot></table></div></section>`;
  }).join('');
}

function filasCostosExcel(lista) {
  return [...lista].sort((a,b)=>compararNombre(a.destinoFinanciero,b.destinoFinanciero)||compararNombre(a.proveedorNombre,b.proveedorNombre)||compararNombre(a.servicioNombre,b.servicioNombre)||ordenarCostosGrupo(a,b)).map(o=>({
    'Año':o.anoViaje, Destino:destinoVista(o.destinoFinanciero),'Destino original':o.destinoFinanciero, Tipo:o.tipo, Proveedor:o.proveedorNombre,
    Servicio:o.servicioNombre||o.hotelNombre||'', 'N.º negocio':String(o.numeroNegocio||''),
    Grupo:o.nombreGrupo||'', Fecha:fechaOrdenCosto(o), Salida:o.checkOut||'', Noches:o.noches??null,
    Moneda:moneda(o.monedaObligacion), 'Pax acordados':o.paxAcordados??o.paxReservados??null,
    'Pax reales':o.paxReales??null,'Pax cobrados':o.paxCobrados??o.personasCobradas??null,
    'Forma de cobro':o.tipoCobro||'', 'Valor unitario':o.tarifaBase??null,
    'Unidades cobrables':o.unidadesCobrables??null,Adicionales:o.adicionales??null,Descuentos:o.descuentos??null,
    'Costo conocido':o.totalObligacion??null, Estado:o.requiereConfiguracion?'PENDIENTE':o.estadoFinanciero||o.estadoRealizacion||'',
    'Datos pendientes':(o.pendientesConfiguracion||[]).join(', '),'Resumen ID':o.resumenId,'Registro ID':o.id
  }));
}

function filasAbonosExcel(lista) {
  return [...lista].sort((a,b)=>compararNombre(a.destinoFinanciero,b.destinoFinanciero)||compararNombre(a.proveedorNombre,b.proveedorNombre)||compararNombre(a.fecha,b.fecha)).map(a=>({
    'Año':a.anoViaje, Destino:destinoVista(a.destinoFinanciero),'Destino original':a.destinoFinanciero, Tipo:a.tipo, Proveedor:a.proveedorNombre,
    Fecha:a.fecha||'',Servicio:a.servicioNombre||'', 'Moneda enviada':a.monedaEnviada,
    'Monto enviado':num(a.montoEnviado), 'Tipo de cambio histórico':a.tipoCambioAplicado??null,
    'Moneda aplicada':a.monedaAplicada||a.monedaObligacion, 'Monto aplicado':num(a.montoAplicado),
    'Cobertura informada':a.coberturaPax?.estado==='INFORMADA'?a.coberturaPax.cantidad:null,'Unidad de cobertura':a.coberturaPax?.unidad||'','Estado cobertura':a.coberturaPax?.estado||'PENDIENTE', Estado:a.estadoRevision,
    'Pendiente de vinculación':a.requiereVinculacion?'SÍ':'NO',Motivo:a.motivoPendiente||'',
    Observación:a.nota||'',Comprobante:a.comprobanteURL||'',
    'Resumen ID':a.resumenId,'Abono original ID':a.abonoOperacionId||'', 'Origen':a.origenPath||'','Registro ID':a.id
  }));
}

function hojaExcelFinanzas(libro,nombre,filas,camposVacios=['Información']) {
  const hoja=libro.addWorksheet(nombre,{views:[{state:'frozen',ySplit:1,showGridLines:false}]});
  const campos=filas.length?Object.keys(filas[0]):camposVacios;
  hoja.addRow(campos);
  for(const fila of filas)hoja.addRow(campos.map(c=>fila[c]??null));
  const header=hoja.getRow(1);header.height=32;
  header.eachCell(cell=>{cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFEAF0F7'}};cell.font={bold:true,color:{argb:'FF253B53'}};cell.alignment={vertical:'middle',wrapText:true};});
  hoja.autoFilter={from:{row:1,column:1},to:{row:Math.max(1,hoja.rowCount),column:campos.length}};
  hoja.columns.forEach((col,i)=>{
    col.width=Math.min(52,Math.max(15,campos[i].length+3,...filas.slice(0,200).map(r=>String(r[campos[i]]??'').length+2)));
    if(/costo|monto|saldo|pagar|enviado|aplicado|valor|adicional|descuento|cambio|TC|USD necesarios|presupuesto/i.test(campos[i]))col.numFmt='#,##0.00;[Red](#,##0.00)';
  });
  for(let row=2;row<=hoja.rowCount;row++)hoja.getRow(row).eachCell({includeEmpty:true},cell=>{
    cell.font={name:'Calibri',size:11};cell.alignment={vertical:'top',wrapText:true};
    if(row%2===0)cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF7F9FC'}};
  });
  return {hoja,campos,col:nombreCampo=>hoja.getColumn(campos.indexOf(nombreCampo)+1).letter};
}

function crearLibroFinanzas(lista,costos,abonos) {
  if(!window.ExcelJS)throw new Error('No se cargó ExcelJS. Recarga la página y vuelve a exportar.');
  const libro=new window.ExcelJS.Workbook();libro.creator='Rai Trai · Control Finanzas';libro.created=new Date();libro.calcProperties.fullCalcOnLoad=true;
  const resumen=hojaExcelFinanzas(libro,'Resumen proveedores',filasResumenes(lista));
  const detalle=hojaExcelFinanzas(libro,'Costos',filasCostosExcel(costos),Object.keys(filasCostosExcel([{id:'',resumenId:''}])[0]));
  const pagos=hojaExcelFinanzas(libro,'Abonos',filasAbonosExcel(abonos),Object.keys(filasAbonosExcel([{id:'',resumenId:''}])[0]));
  const cobertura=resumirCoberturaServicios(costos,abonos).map(c=>{const r=lista.find(r=>r.id===c.resumenId)||{};return {Destino:destinoVista(r.destinoFinanciero),'Destino original':r.destinoFinanciero||'',Tipo:r.tipo||'',Proveedor:r.proveedorNombre||'',Servicio:c.servicioNombre,Unidad:c.unidad,'Cantidad facturada':c.total,'Cantidad cubierta conocida':c.cubiertos,'Cantidad pendiente conocida':c.pendientes,'Pagos sin cobertura informada':c.coberturaPendiente,Exceso:c.exceso,Estado:c.estado};});
  hojaExcelFinanzas(libro,'Cobertura por servicio',cobertura);
  const finCostos=Math.max(2,detalle.hoja.rowCount),finPagos=Math.max(2,pagos.hoja.rowCount);
  for(let row=2;row<=resumen.hoja.rowCount;row++){
    const idRef=`${resumen.col('Resumen ID')}${row}`;
    const formulas=[
      ['Costo conocido',`SUMIF(Costos!$${detalle.col('Resumen ID')}$2:$${detalle.col('Resumen ID')}$${finCostos},${idRef},Costos!$${detalle.col('Costo conocido')}$2:$${detalle.col('Costo conocido')}$${finCostos})`],
      ['Abonos aplicados',`SUMIF(Abonos!$${pagos.col('Resumen ID')}$2:$${pagos.col('Resumen ID')}$${finPagos},${idRef},Abonos!$${pagos.col('Monto aplicado')}$2:$${pagos.col('Monto aplicado')}$${finPagos})`],
      ['Saldo conocido',`${resumen.col('Costo conocido')}${row}-${resumen.col('Abonos aplicados')}${row}`],
      ['Por pagar conocido',`MAX(0,${resumen.col('Saldo conocido')}${row})`],
      ['Saldo a favor confirmado',`IF(${resumen.col('Costos pendientes')}${row}>0,0,MAX(0,-${resumen.col('Saldo conocido')}${row}))`]
    ];
    for(const [campo,formula]of formulas){const cell=resumen.hoja.getCell(`${resumen.col(campo)}${row}`);cell.value={formula,result:cell.value??0};}
  }
  const cuentasHoja=hojaExcelFinanzas(libro,'Cuentas proveedores',cuentasParaExcel(lista));
  const finResumen=Math.max(2,resumen.hoja.rowCount);
  for(let row=2;row<=cuentasHoja.hoja.rowCount;row++) {
    const cuentaRef=`${cuentasHoja.col('Cuenta ID')}${row}`;
    for(const [campo,origen] of [['Costo conocido','Costo conocido'],['Abonos aplicados','Abonos aplicados'],['Costos pendientes','Costos pendientes']]) {
      const celda=cuentasHoja.hoja.getCell(`${cuentasHoja.col(campo)}${row}`);
      celda.value={formula:`SUMIF('Resumen proveedores'!$${resumen.col('Cuenta ID')}$2:$${resumen.col('Cuenta ID')}$${finResumen},${cuentaRef},'Resumen proveedores'!$${resumen.col(origen)}$2:$${resumen.col(origen)}$${finResumen})`,result:celda.value};
    }
    for(const [campo,formula] of [
      ['Saldo conjunto',`${cuentasHoja.col('Costo conocido')}${row}-${cuentasHoja.col('Abonos aplicados')}${row}`],
      ['Por pagar conocido',`MAX(0,${cuentasHoja.col('Saldo conjunto')}${row})`],
      ['Saldo a favor confirmado',`IF(${cuentasHoja.col('Costos pendientes')}${row}>0,0,MAX(0,-${cuentasHoja.col('Saldo conjunto')}${row}))`]
    ]) {const celda=cuentasHoja.hoja.getCell(`${cuentasHoja.col(campo)}${row}`);celda.value={formula,result:celda.value};}
  }
  const destinos=ordenarDestinos([...new Set(lista.map(r=>destinoVista(r.destinoFinanciero)))]);
  const planes=destinos.map(dest=>{
    const plan=planDestino(dest),items=lista.filter(r=>destinoVista(r.destinoFinanciero)===dest),e=estimarFondos(items,plan);
    return {Destino:dest,'Por pagar BRL':e.totales.BRL?.pagar||0,'Por pagar ARS':e.totales.ARS?.pagar||0,
      'Por pagar USD':e.totales.USD?.pagar||0,'Por pagar CLP':e.totales.CLP?.pagar||0,
      'TC BRL por USD':plan.BRL??null,'TC ARS por USD':plan.ARS??null,
      'USD necesarios':e.usd??'PENDIENTE','Mostrar CLP':plan.mostrarCLP?'SÍ':'NO',
      'TC CLP por USD':plan.CLP??null,'Presupuesto CLP':plan.mostrarCLP?(e.clp??'PENDIENTE'):'NO SOLICITADO',
      Estado:e.parcial?'PARCIAL / HAY DATOS PENDIENTES':'COMPLETO'};
  });
  const planHoja=hojaExcelFinanzas(libro,'Planificacion',planes);
  const finCuentas=Math.max(2,cuentasHoja.hoja.rowCount);
  for(let row=2;row<=planHoja.hoja.rowCount;row++){
    for(const codigo of ['BRL','ARS','USD','CLP']){
      const celda=planHoja.hoja.getCell(`${planHoja.col('Por pagar '+codigo)}${row}`);
      const formula=`SUMIFS('Cuentas proveedores'!$${cuentasHoja.col('Por pagar conocido')}$2:$${cuentasHoja.col('Por pagar conocido')}$${finCuentas},'Cuentas proveedores'!$${cuentasHoja.col('Destino')}$2:$${cuentasHoja.col('Destino')}$${finCuentas},A${row},'Cuentas proveedores'!$${cuentasHoja.col('Moneda')}$2:$${cuentasHoja.col('Moneda')}$${finCuentas},"${codigo}")`;
      celda.value={formula,result:celda.value};
    }
    const usd=planHoja.hoja.getCell(`H${row}`),clp=planHoja.hoja.getCell(`K${row}`);
    usd.value={formula:`IF(OR(AND(B${row}>0,OR(NOT(ISNUMBER(F${row})),F${row}<=0)),AND(C${row}>0,OR(NOT(ISNUMBER(G${row})),G${row}<=0))),"PENDIENTE",D${row}+IF(B${row}=0,0,B${row}/F${row})+IF(C${row}=0,0,C${row}/G${row}))`,result:usd.value};
    clp.value={formula:`IF(I${row}<>"SÍ","NO SOLICITADO",IF(NOT(ISNUMBER(H${row})),"PENDIENTE",IF(AND(H${row}>0,OR(NOT(ISNUMBER(J${row})),J${row}<=0)),"PENDIENTE",E${row}+IF(H${row}=0,0,H${row}*J${row}))))`,result:clp.value};
    for(const letra of ['F','G','I','J'])planHoja.hoja.getCell(`${letra}${row}`).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFFFF7E3'}};
    for(const letra of ['F','G','J'])planHoja.hoja.getCell(`${letra}${row}`).dataValidation={type:'decimal',operator:'greaterThan',formulae:[0],allowBlank:true,showErrorMessage:true,error:'Ingrese un tipo de cambio mayor que cero.'};
    planHoja.hoja.getCell(`I${row}`).dataValidation={type:'list',formulae:['"SÍ,NO"'],allowBlank:false};
  }
  const notas=[
    {Tema:'Cuentas compartidas',Detalle:'Cuentas proveedores es la base de saldos y planificación: cada cuenta/moneda figura una vez. Resumen proveedores conserva las cifras individuales para rastrear el hotel de origen; no sume sus deudas positivas para estimar fondos si hay cuentas compartidas. La cobertura de pax se mantiene por servicio.'},
    {Tema:'Alcance',Detalle:`Año ${state.ano}. Tipos incluidos: ${[...new Set(lista.map(r=>r.tipo))].join(', ')}. El archivo respeta el destino y el tipo seleccionados. Todos los destinos incluye los ocultos.`},
    {Tema:'Celdas amarillas',Detalle:'Tipos de cambio de planificación editables. No modifican los pagos originales ni los TC históricos.'},
    {Tema:'Planificación',Detalle:'USD necesarios = deuda USD + BRL / TC BRL por USD + ARS / TC ARS por USD. CLP = USD necesarios × TC CLP por USD + deuda directa CLP.'},
    {Tema:'Totales parciales',Detalle:'Los costos sin tarifa quedan vacíos. Los pagos sin conversión o vinculación no se aplican. Los totales conocidos no constituyen un total definitivo.'},
    {Tema:'Saldos a favor',Detalle:'Los hoteles explícitamente vinculados comparten saldo por moneda. No se compensan saldos entre cuentas diferentes. Sin tarifa completa no se confirma un saldo a favor.'},
    {Tema:'Filtrar detalle',Detalle:'Los filtros de las hojas Costos y Abonos no cambian los SUMIF/SUMIFS del resumen. La hoja Consulta filtrada permite sumar las filas visibles sin mezclar monedas.'},
    {Tema:'Edición de datos',Detalle:'Las hojas resumen y planificación usan fórmulas. Los estados y cantidades pendientes son una foto del sistema al exportar; editar Excel no actualiza el sistema.'}
  ];
  hojaExcelFinanzas(libro,'Notas',notas);
  const idsDetalle=new Set(state.proveedor?.esDetalleCuenta?state.proveedor.resumenIdsCuenta:state.proveedor?[state.proveedor.id]:[]);
  if(lista.length>0 && lista.length===idsDetalle.size && lista.every(r=>idsDetalle.has(r.id))) {
    hojaExcelFinanzas(libro,'Reglas',(state.reglas || []).map(r=>({Proveedor:r.proveedorNombre||r.proveedorId||'',Servicio:r.servicioNombre || '',Tipo:r.tipoRegla || '',Descripción:r.descripcion || '',Activa:r.activa!==false?'SÍ':'NO'})));
    hojaExcelFinanzas(libro,'Historial',(state.historial || []).map(h=>({Fecha:fechaTexto(h.creadoAt),Acción:h.accion || '',Usuario:h.usuarioEmail || '',Motivo:h.motivo || '',Antes:resumenCambio(h.antes),Después:resumenCambio(h.despues)})));
  }
  const consulta=hojaExcelFinanzas(libro,'Consulta filtrada',[
    {Origen:'Costos',Moneda:'BRL',Instrucción:'Filtre la hoja Costos por destino, proveedor, servicio y moneda. Aquí solo se suman filas visibles en la moneda indicada.',Total:0},
    {Origen:'Costos',Moneda:'ARS',Instrucción:'',Total:0},{Origen:'Costos',Moneda:'USD',Instrucción:'',Total:0},{Origen:'Costos',Moneda:'CLP',Instrucción:'',Total:0},
    {Origen:'Abonos aplicados',Moneda:'BRL',Instrucción:'Filtre Abonos por Moneda aplicada; el total usa filas visibles.',Total:0},
    {Origen:'Abonos aplicados',Moneda:'ARS',Instrucción:'',Total:0},{Origen:'Abonos aplicados',Moneda:'USD',Instrucción:'',Total:0},{Origen:'Abonos aplicados',Moneda:'CLP',Instrucción:'',Total:0}
  ]);
  for(let row=2;row<=9;row++){
    const esCosto=row<=5,src=esCosto?detalle:pagos,fin=esCosto?finCostos:finPagos,
      campo=esCosto?'Costo conocido':'Monto aplicado',mon=esCosto?'Moneda':'Moneda aplicada',
      valores=`${src.col(campo)}2:${src.col(campo)}${fin}`,
      rangoMon=`${src.col(mon)}2:${src.col(mon)}${fin}`,
      nombre=esCosto?'Costos':'Abonos',
      formula=`SUMPRODUCT(SUBTOTAL(109,OFFSET('${nombre}'!${src.col(campo)}2,ROW('${nombre}'!${valores})-ROW('${nombre}'!${src.col(campo)}2),0,1)),--('${nombre}'!${rangoMon}=B${row}))`;
    const monedaFila=consulta.hoja.getCell(`B${row}`).value;
    const cache=(esCosto?costos:abonos).filter(x=>moneda(esCosto?x.monedaObligacion:x.monedaAplicada||x.monedaObligacion)===monedaFila).reduce((v,x)=>v+num(esCosto?x.totalObligacion:x.montoAplicado),0);
    consulta.hoja.getCell(`D${row}`).value={formula,result:cache};
  }
  return libro;
}

async function exportarSeleccionFinanzas(lista,nombre) {
  const botones=$$('#btnExportarTodo, #btnExportarDestino, #btnExportarProveedor');botones.forEach(b=>b.disabled=true);
  try {
    setEstado('Preparando Excel con costos, pagos, filtros y fórmulas…');
    const ano=Number(state.ano),ids=new Set(lista.map(r=>r.id));
    const [costos,pagos]=await Promise.all([
      getDocs(query(collection(db,COLECCIONES.OBLIGACIONES),where('anoViaje','==',ano))),
      getDocs(query(collection(db,COLECCIONES.ABONOS),where('anoViaje','==',ano)))
    ]);
    if(ano!==Number(state.ano))throw new Error('Cambió el año durante la exportación. Vuelve a exportar.');
    const cs=costos.docs.map(d=>({...d.data(),id:d.id})).filter(o=>ids.has(o.resumenId));
    const as=pagos.docs.map(d=>({...d.data(),id:d.id})).filter(a=>ids.has(a.resumenId));
    // Los resúmenes se refrescan para exportar importes recientes junto con sus detalles.
    const recientes=await getDocs(query(collection(db,COLECCIONES.RESUMENES),where('anoViaje','==',ano)));
    const configNueva=(await llamarCuentasHoteles({accion:'CONSULTAR',anoViaje:ano})).data.documentos||[];
    const versiones=ds=>JSON.stringify(ds.map(d=>[d.id,d.version]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));
    if(versiones(configNueva)!==versiones(state.configCuentasHoteles||[]))throw new Error('Cambió una cuenta compartida. Actualice la información antes de exportar.');
    const rs=adjuntarCuentasHoteles(recientes.docs.map(d=>({...d.data(),id:d.id})),configNueva).filter(r=>ids.has(r.id));
    for (const r of rs) {
      const costo=cs.filter(o=>o.resumenId===r.id).reduce((v,o)=>v+num(o.totalObligacion),0);
      const aplicado=as.filter(a=>a.resumenId===r.id).reduce((v,a)=>v+num(a.montoAplicado),0);
      if(Math.abs(costo-num(r.totalObligacion))>0.02 || Math.abs(aplicado-num(r.totalAplicado))>0.02) {
        throw new Error('Los datos se están recalculando. Actualiza la información y vuelve a exportar cuando termine.');
      }
    }
    const libro=crearLibroFinanzas(rs,cs,as),buffer=await libro.xlsx.writeBuffer();
    const url=URL.createObjectURL(new Blob([buffer],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
    const enlace=document.createElement('a');enlace.href=url;enlace.download=nombre;enlace.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
    setEstado('Excel generado. Incluye tablas filtrables y tipos de cambio editables.');
  }catch(error){console.error(error);setEstado(`No se pudo exportar: ${error.message}`,true);}
  finally{botones.forEach(b=>b.disabled=false);$('#btnExportarDestino').disabled=!state.destino||!proveedoresDestino().length;}
}

state.costosAno = [];
state.cargaVisual = 0;
state.configCuentasHoteles = [];

function destinoVista(valor) {
  const d=norm(valor);
  if(['BRASIL','BARILOCHE','SUR DE CHILE','NORTE DE CHILE','SUR DE CHILE Y BARILOCHE'].includes(d))return d;
  if(!d||['SIN DEFINIR','SIN_DEFINIR'].includes(d))return 'SIN DEFINIR';
  return 'OTRO';
}

function seleccionResumenes() {
  const lista=resumenesFiltrados();
  return state.destino==='TODOS_DESTINOS'?lista:lista.filter(r=>destinoVista(r.destinoFinanciero)===state.destino);
}

function destinosVisiblesFinanzas() {
  return ordenarDestinos([...new Set([...DESTINOS_ORDEN,'OTRO',...resumenesFiltrados().map(r=>destinoVista(r.destinoFinanciero))])]);
}

function textoUnidadCobertura(unidad) { return unidad==='PAX_NOCHE'?'personas-noches':'pax / cupos'; }

function coberturasProveedor(r=state.proveedor) {
  if(!r)return [];
  const costos=(state.costosAno||[]).filter(o=>o.resumenId===r.id);
  const pagos=state.proveedor?.id===r.id?state.abonos:[];
  if(state.proveedor?.id===r.id&&state.obligaciones?.length)return resumirCoberturaServicios(state.obligaciones,pagos);
  return r.coberturaPorServicio||[];
}

function textoCoberturaMetrica(r,tipo) {
  const grupos=coberturasProveedor(r);
  if(!grupos.length)return 'Cobertura no registrada o no aplicable';
  if(grupos.length>1)return `Cobertura separada en ${grupos.length} servicios`;
  const c=grupos[0],unidad=textoUnidadCobertura(c.unidad);
  if(tipo==='total')return `${fmtNum(c.total)} ${unidad} cobrados${c.datosPendientes?' · cantidad parcial':''}`;
  if(tipo==='cubiertos')return `${fmtNum(c.cubiertos)} ${unidad} con cobertura informada${c.coberturaPendiente?' · faltan pagos por confirmar':''}`;
  return c.estado==='POR_CONFIRMAR'?`${fmtNum(c.pendientes)} ${unidad} aún sin cobertura informada · por confirmar`:
    c.exceso?`${fmtNum(c.exceso)} ${unidad} de exceso · revisar`:`${fmtNum(c.pendientes)} ${unidad} pendientes de pago`;
}

function cabeceraCoberturaServicio(items) {
  const servicio=items[0],grupos=coberturasProveedor();
  const c=grupos.find(c=>c.servicioId===servicio.servicioId&&c.resumenId===servicio.resumenId);
  if(!c)return '<div class="cf-service-coverage">Cobertura no aplicable al tipo de cobro o pendiente de registrar.</div>';
  const u=textoUnidadCobertura(c.unidad);
  return `<div class="cf-service-coverage"><span><b>${fmtNum(c.total)}</b> ${u} cobrados</span><span><b>${fmtNum(c.cubiertos)}</b> cubiertos</span><span><b>${fmtNum(c.pendientes)}</b> ${c.estado==='POR_CONFIRMAR'?'sin cobertura confirmada':'pendientes de pago'}</span>${c.exceso?`<span class="cf-state attention">Exceso: ${fmtNum(c.exceso)} · revisar</span>`:''}${c.coberturaPendiente?`<span class="cf-state warning">${c.coberturaPendiente} pago(s) sin cobertura confirmada</span>`:''}</div>`;
}

function resumirCoberturaServicios(costos, pagos) {
  const numeroSeguro=v=>v!==null&&v!==undefined&&String(v).trim()!==''&&Number.isFinite(Number(v))&&Number(v)>=0?Number(v):null;
  const grupos=new Map();
  for(const o of costos){
    const hotel=String(o.tipo).toUpperCase()==='HOTEL';
    const cobro=String(o.tipoCobro||'').toUpperCase();
    const unidad=hotel&&['PAX_NOCHE'].includes(cobro)?'PAX_NOCHE':!hotel&&['POR_PAX','PAX'].includes(cobro)?'PAX':null;
    if(!unidad)continue;
    const clave=`${o.resumenId}||${o.servicioId || o.hotelId || o.servicioNombre}||${unidad}`;
    if(!grupos.has(clave))grupos.set(clave,{resumenId:o.resumenId,servicioId:o.servicioId||'',hotelId:o.hotelId||'',servicioNombre:o.servicioNombre||o.hotelNombre||'',unidad,total:0,cubiertos:0,coberturaPendiente:0,datosPendientes:0,exceso:0});
    const g=grupos.get(clave),n=numeroSeguro(o.unidadesCobrables);
    if(n===null)g.datosPendientes++;else g.total+=n;
  }
  for(const a of pagos){
    const candidatos=[...grupos.values()].filter(g=>g.resumenId===a.resumenId&&(!g.servicioId||g.servicioId===a.servicioId));
    if(!candidatos.length)continue;
    const c=a.coberturaPax||{},cantidad=numeroSeguro(c.cantidad);
    const montoBase=numeroSeguro(c.montoEnviadoBase);
    const monedaBase=String(c.monedaEnviadaBase||'').toUpperCase();
    const mismoPago=montoBase===null||Math.abs(montoBase-Number(a.montoEnviado))<0.005&&monedaBase===String(a.monedaEnviada||'').toUpperCase();
    const informada=c.estado==='INFORMADA'&&cantidad!==null&&Number.isInteger(cantidad)&&mismoPago&&!a.requiereVinculacion;
    const exactos=informada?candidatos.filter(g=>g.unidad===c.unidad&&(!c.servicioId||g.servicioId===c.servicioId)):[];
    if(informada&&exactos.length===1)exactos[0].cubiertos+=cantidad;
    else if(c.estado!=='NO_APLICA'||!mismoPago)candidatos.forEach(g=>g.coberturaPendiente++);
  }
  return [...grupos.values()].map(g=>({...g,
    pendientes:Math.max(0,g.total-g.cubiertos),exceso:Math.max(0,g.cubiertos-g.total),
    estado:g.datosPendientes||g.coberturaPendiente?'POR_CONFIRMAR':g.cubiertos>g.total?'REVISAR_EXCESO':'INFORMADA'
  }));
}

function claveCuentaMoneda(r) {
  const c=r.cuentaCompartida;
  return c?`${c.documentoId}|${c.id}|${moneda(r.monedaObligacion)}`:`INDIVIDUAL|${r.id}`;
}

function totalesCuentaSeleccion(items) {
  const grupos=new Map();
  for(const r of items.filter(r=>!r.sinteticoCuenta)) {
    const key=claveCuentaMoneda(r);
    if(!grupos.has(key))grupos.set(key,{...r,totalObligacion:0,totalAplicado:0,saldoPendiente:0,totalEnviadoPorMoneda:{},obligacionesSinTarifa:0,abonosPendientesRevision:0,requiereConfiguracion:false});
    const g=grupos.get(key);
    g.totalObligacion+=num(r.totalObligacion);g.totalAplicado+=num(r.totalAplicado);g.saldoPendiente=g.totalObligacion-g.totalAplicado;
    g.obligacionesSinTarifa+=num(r.obligacionesSinTarifa);g.abonosPendientesRevision+=num(r.abonosPendientesRevision);g.requiereConfiguracion ||= !!r.requiereConfiguracion;
    for(const [m,n] of Object.entries(r.totalEnviadoPorMoneda||{}))g.totalEnviadoPorMoneda[m]=num(g.totalEnviadoPorMoneda[m])+num(n);
  }
  return [...grupos.values()];
}

function filasConRaicesVisibles(items) {
  const salida=[...items], vistos=new Set();
  for(const r of items) {
    const c=r.cuentaCompartida;if(!c)continue;
    const k=claveCuentaMoneda(r);if(vistos.has(k))continue;vistos.add(k);
    if(!items.some(x=>claveCuentaMoneda(x)===k&&x.proveedorId===c.raizProveedorId)) {
      salida.push({...r,id:`CUENTA|${k}`,sinteticoCuenta:true,proveedorId:c.raizProveedorId,proveedorNombre:c.raizNombre,totalObligacion:0,totalAplicado:0,saldoPendiente:0,totalEnviadoPorMoneda:{},obligacionesSinTarifa:0,abonosPendientesRevision:0,requiereConfiguracion:false});
    }
  }
  return salida;
}

function esRaizCompartida(r) {return !!r.cuentaCompartida&&r.proveedorId===r.cuentaCompartida.raizProveedorId;}

function resumenParaDetalle(r) {
  if(!esRaizCompartida(r))return {...r,esDetalleCuenta:false};
  const c=r.cuentaCompartida,t=c.saldosPorMoneda[moneda(r.monedaObligacion)];
  const ids=state.resumenes.filter(x=>x.cuentaCompartida?.id===c.id&&x.cuentaCompartida?.documentoId===c.documentoId&&moneda(x.monedaObligacion)===moneda(r.monedaObligacion)).map(x=>x.id);
  return {...r,...t,esDetalleCuenta:true,resumenIdsCuenta:ids,proveedorNombre:c.raizNombre};
}

function prepararDesplegablesProveedores() {
  const contenedor=$('#gruposFinancieros');
  if(!contenedor||contenedor.dataset.desplegablesPreparados==='1')return;
  contenedor.dataset.desplegablesPreparados='1';
  contenedor.addEventListener('click',event=>{
    const boton=event.target.closest('.btn-desplegar-proveedor');if(!boton||!contenedor.contains(boton))return;
    const fila=boton.closest('.cf-provider-total'),clave=fila.dataset.key,abrir=boton.getAttribute('aria-expanded')!=='true';
    state.proveedoresDesplegados ||= new Set();if(abrir)state.proveedoresDesplegados.add(clave);else state.proveedoresDesplegados.delete(clave);
    boton.textContent=abrir?'−':'+';boton.setAttribute('aria-expanded',String(abrir));
    boton.title=abrir?'Ocultar servicios':'Mostrar servicios';boton.setAttribute('aria-label',`${boton.title} de ${fila.querySelector('.cf-provider-name strong')?.textContent||'proveedor'}`);
    let siguiente=fila.nextElementSibling;
    while(siguiente&&siguiente.classList.contains('cf-service-child')&&siguiente.dataset.proveedorPadre===clave){siguiente.hidden=!abrir;siguiente.style.display=abrir?'':'none';siguiente=siguiente.nextElementSibling;}
  });
}

function renderCuentaProveedor() {
  const panel=$('#panel-cuenta'),p=state.proveedor;
  if(!panel||!p)return;
  if(norm(p.tipo)!=='HOTEL'){panel.innerHTML='<div class="cf-empty">Las cuentas compartidas están disponibles para hoteles. Las actividades conservan su proveedor actual.</div>';return;}
  const docActual=(state.configCuentasHoteles||[]).find(d=>Number(d.anoViaje)===Number(state.ano)&&norm(d.destinoFinanciero)===norm(p.destinoFinanciero));
  const cuenta=(docActual?.cuentas||[]).find(c=>c.miembrosProveedorIds.includes(p.proveedorId));
  const catalogo=new Map(state.resumenes.filter(r=>norm(r.tipo)==='HOTEL'&&!r.sinCostoVinculado&&norm(r.destinoFinanciero)===norm(p.destinoFinanciero)).map(r=>[r.proveedorId,{id:r.proveedorId,nombre:r.proveedorNombre}]));
  for(const id of cuenta?.miembrosProveedorIds||[])if(!catalogo.has(id))catalogo.set(id,{id,nombre:cuenta.nombres?.[id]||id});
  const seleccion=new Set(cuenta?.miembrosProveedorIds||[p.proveedorId]);
  const lista=[...catalogo.values()].sort((a,b)=>compararNombre(a.nombre,b.nombre));
  const cc=p.cuentaCompartida;
  panel.innerHTML=`<div class="cf-section-head"><h3>Cuenta del proveedor</h3><span class="cf-muted">Año ${state.ano} · ${esc(p.destinoFinanciero)}</span></div>
    <div class="cf-account-note">Cada hotel conserva sus tarifas, grupos, pagos y cobertura. La cuenta reúne costos y abonos para calcular un saldo por moneda. Los vínculos se aplican a todos los costos y pagos del año seleccionado, incluidos los anteriores.</div>
    ${cc?`<div class="cf-account-current"><b>Raíz: ${esc(cc.raizNombre)}</b><p>${cc.miembros.map(x=>esc(x.nombre)).join(' + ')}</p>${Object.entries(cc.saldosPorMoneda).map(([m,t])=>`<p><b>${esc(m)}</b> · Costo conjunto: ${fmtMoney(t.totalObligacion,m)} · Aplicado: ${fmtMoney(t.totalAplicado,m)} · Saldo: <b>${fmtMoney(t.saldoPendiente,m)}</b>${t.requiereConfiguracion?' · PARCIAL':''}</p>`).join('')}</div>`:''}
    <form id="formCuentaHoteles" data-version="${num(docActual?.version)}" data-cuenta-id="${esc(cuenta?.id||'')}">
      <p>Selecciona los hoteles integrantes. Un hotel solo puede pertenecer a una cuenta en este año y destino.</p>
      <div class="cf-account-members">${lista.map(h=>{const otra=(docActual?.cuentas||[]).find(c=>c.id!==cuenta?.id&&c.miembrosProveedorIds.includes(h.id));return `<label><input type="checkbox" name="hotelCuenta" value="${esc(h.id)}" ${seleccion.has(h.id)?'checked':''} ${otra?'disabled':''}> ${esc(h.nombre)}${otra?' · ya pertenece a otra cuenta':''}</label>`;}).join('')}</div>
      <label class="cf-field">Hotel raíz<select id="cuentaHotelRaiz">${lista.filter(h=>seleccion.has(h.id)).map(h=>`<option value="${esc(h.id)}" ${h.id===(cuenta?.raizProveedorId||p.proveedorId)?'selected':''}>${esc(h.nombre)}</option>`).join('')}</select></label>
      <label class="cf-field">Motivo del cambio<textarea id="cuentaHotelMotivo" rows="2" maxlength="2000" required placeholder="Por qué comparten la cuenta o qué se está modificando"></textarea></label>
      <div id="cuentaHotelesEstado" class="cf-status" role="status"></div>
      <div class="cf-row"><button type="submit" class="cf-btn blue">Guardar cuenta compartida</button>${cuenta?'<button type="button" id="btnDisolverCuentaHoteles" class="cf-btn">Desvincular todos los hoteles</button>':''}</div>
    </form>`;
  const form=$('#formCuentaHoteles');
  $$('input[name=hotelCuenta]',form).forEach(input=>input.addEventListener('change',()=>{
    const raiz=$('#cuentaHotelRaiz'),previa=raiz.value,seleccionados=new Set($$('input[name=hotelCuenta]:checked',form).map(x=>x.value));
    raiz.innerHTML=lista.filter(h=>seleccionados.has(h.id)).map(h=>`<option value="${esc(h.id)}">${esc(h.nombre)}</option>`).join('');if(seleccionados.has(previa))raiz.value=previa;
  }));
  form.onsubmit=e=>{e.preventDefault();guardarCuentaHotelesDesdePanel('GUARDAR');};
  const eliminar=$('#btnDisolverCuentaHoteles');if(eliminar)eliminar.onclick=()=>{if(confirm('¿Separar esta cuenta? Cada hotel volverá a mostrar su saldo individual. No se eliminarán costos ni pagos.'))guardarCuentaHotelesDesdePanel('ELIMINAR');};
}

async function guardarCuentaHotelesDesdePanel(accion) {
  const form=$('#formCuentaHoteles'),p=state.proveedor,motivo=$('#cuentaHotelMotivo').value.trim();
  const estado=$('#cuentaHotelesEstado');
  if(!motivo){estado.textContent='Indique el motivo del cambio.';return;}
  const miembros=$$('input[name=hotelCuenta]:checked',form).map(x=>x.value),raiz=$('#cuentaHotelRaiz').value;
  if(accion==='GUARDAR'&&(miembros.length<2||!miembros.includes(raiz))){estado.textContent='Seleccione al menos dos hoteles e indique una raíz incluida en la selección.';return;}
  const botones=$$('button',form);botones.forEach(b=>b.disabled=true);estado.textContent='Guardando cuenta y solicitando recálculo…';
  try {
    await llamarCuentasHoteles({accion,anoViaje:Number(state.ano),destinoFinanciero:p.destinoFinanciero,versionEsperada:Number(form.dataset.version),cuentaId:form.dataset.cuentaId||'',raizProveedorId:raiz,miembrosProveedorIds:miembros,motivo});
    if(!await cargarResumenes())throw new Error('La cuenta se guardó, pero falta actualizar la pantalla. Use Actualizar información.');
    const siguiente=state.resumenes.find(r=>r.id===p.id)||state.resumenes.find(r=>r.proveedorId===(accion==='GUARDAR'?raiz:p.proveedorId)&&norm(r.destinoFinanciero)===norm(p.destinoFinanciero));
    if(siguiente){await abrirDetalle(siguiente);activarTab('cuenta');setEstado('Cuenta guardada. Los saldos ya reflejan el vínculo; el backend conserva la agrupación en los siguientes recálculos.',false,'#detalleEstado');}else cerrarDetalle();
  } catch(error){console.error(error);estado.textContent=`No fue posible completar la operación: ${error.message}`;}
  finally{botones.forEach(b=>b.disabled=false);}
}

function cuentasParaExcel(lista) {
  return totalesCuentaSeleccion(lista).map(r=>({
    'Cuenta ID':claveCuentaMoneda(r),Destino:destinoVista(r.destinoFinanciero),'Destino original':r.destinoFinanciero,Tipo:r.tipo,
    'Proveedor raíz':r.cuentaCompartida?.raizNombre||r.proveedorNombre,
    Integrantes:r.cuentaCompartida?r.cuentaCompartida.miembros.map(x=>x.nombre).join(' + '):r.proveedorNombre,
    Moneda:moneda(r.monedaObligacion),'Costo conocido':num(r.totalObligacion),'Abonos aplicados':num(r.totalAplicado),'Saldo conjunto':num(r.saldoPendiente),
    'Por pagar conocido':Math.max(0,num(r.saldoPendiente)),'Saldo a favor confirmado':r.requiereConfiguracion?0:Math.max(0,-num(r.saldoPendiente)),
    'Costos pendientes':num(r.obligacionesSinTarifa),Estado:r.requiereConfiguracion||num(r.abonosPendientesRevision)?'PARCIAL / PENDIENTE':'DATOS PARA CALCULAR',
    Alcance:r.cuentaCompartida&&state.resumenes.some(x=>claveCuentaMoneda(x)===claveCuentaMoneda(r)&&!lista.some(y=>y.id===x.id))?'PARCIAL: solo integrantes incluidos en esta exportación':'Selección exportada'
  }));
}

// Agrupa cuentas monetarias; nunca cambia los IDs ni el origen de costos y pagos.

function adjuntarCuentasHoteles(resumenes, documentos) {
  const normal=v=>String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toUpperCase();
  const n=v=>Number(v)||0, red=v=>Math.round((v+Number.EPSILON)*100)/100;
  const filas=resumenes.map(r=>{const x={...r};delete x.cuentaCompartida;return x;});
  const usados=new Set();
  for(const documento of documentos) {
    for(const cuenta of documento.cuentas||[]) {
      const ids=[...new Set(cuenta.miembrosProveedorIds||[])];
      if(ids.length<2||!ids.includes(cuenta.raizProveedorId))throw new Error('Cuenta hotelera inválida: faltan integrantes o raíz.');
      for(const id of ids){const k=`${documento.anoViaje}|${normal(documento.destinoFinanciero)}|${id}`;if(usados.has(k))throw new Error('Un hotel figura en más de una cuenta compartida.');usados.add(k);}
      const miembros=filas.filter(r=>normal(r.tipo)==='HOTEL'&&Number(r.anoViaje)===Number(documento.anoViaje)&&normal(r.destinoFinanciero)===normal(documento.destinoFinanciero)&&ids.includes(r.proveedorId));
      const nombres=ids.map(id=>({proveedorId:id,nombre:miembros.find(r=>r.proveedorId===id)?.proveedorNombre||cuenta.nombres?.[id]||id}));
      const saldosPorMoneda={};
      for(const r of miembros) {
        const m=r.monedaObligacion||'SIN_DEFINIR';
        const t=saldosPorMoneda[m] ||= {totalObligacion:0,totalAplicado:0,saldoPendiente:0,totalEnviadoPorMoneda:{},obligacionesSinTarifa:0,abonosPendientesRevision:0,requiereConfiguracion:false};
        t.totalObligacion=red(t.totalObligacion+n(r.totalObligacion));t.totalAplicado=red(t.totalAplicado+n(r.totalAplicado));
        t.obligacionesSinTarifa+=n(r.obligacionesSinTarifa);t.abonosPendientesRevision+=n(r.abonosPendientesRevision);
        t.requiereConfiguracion ||= !!r.requiereConfiguracion;
        for(const [mon,monto] of Object.entries(r.totalEnviadoPorMoneda||{}))t.totalEnviadoPorMoneda[mon]=red(n(t.totalEnviadoPorMoneda[mon])+n(monto));
        t.saldoPendiente=red(t.totalObligacion-t.totalAplicado);
      }
      const datos={id:cuenta.id,documentoId:documento.id,versionConfig:n(documento.version),anoViaje:Number(documento.anoViaje),destinoFinanciero:documento.destinoFinanciero,raizProveedorId:cuenta.raizProveedorId,raizNombre:nombres.find(x=>x.proveedorId===cuenta.raizProveedorId)?.nombre||cuenta.raizProveedorId,miembros:nombres,saldosPorMoneda};
      miembros.forEach(r=>{r.cuentaCompartida=datos;});
    }
  }
  return filas;
}

function bindUI() {
  $('#filtroAno').addEventListener('change', async e => { state.ano = Number(e.target.value); state.destino = null; await cargarResumenes(); });
  $('#filtroTipo').addEventListener('change', e => { state.tipo = e.target.value; renderDestinos(); renderProveedores(); });
  $('#btnGestionarDestinos').addEventListener('click', gestionarDestinos);
  $('#btnRecargar').addEventListener('click', cargarResumenes); $('#btnExportarTodo').addEventListener('click', exportarTodo);
  $('#btnExportarDestino').addEventListener('click', exportarDestino); $('#btnExportarProveedor').addEventListener('click', exportarProveedor);
  $('#btnCerrarDetalle').addEventListener('click', cerrarDetalle); $('#detalleBackdrop').addEventListener('click', e => { if (e.target === $('#detalleBackdrop')) cerrarDetalle(); });
  $$('.cf-tab').forEach(btn => btn.addEventListener('click', () => activarTab(btn.dataset.tab)));
  $('#btnCancelarEdicion').addEventListener('click', () => $('#dialogEditarAbono').close());
  $('#formEditarAbono').addEventListener('submit', guardarRevisionAbono); $('#abTipoCambio').addEventListener('change', recalcularMontoDesdeTC);
}

onAuthStateChanged(auth, async user => {
  document.body.style.visibility='hidden';
  if(!user){window.location.replace('login.html');return;}
  const permitidos=new Set(['anamaria@raitrai.cl', 'aleoperaciones@raitrai.cl', 'operaciones@raitrai.cl', 'yenny@raitrai.cl','sistemas@raitrai.cl']);
  if(!permitidos.has(String(user.email||'').trim().toLowerCase())){state.usuario=null;window.location.replace('index.html');return;}
  state.usuario=user;$('#usuarioConectado').textContent=user.email||'';construirAnos();
  if(!state.eventosFinanzasPreparados){bindUI();state.eventosFinanzasPreparados=true;}
  document.body.style.visibility='visible';await cargarResumenes();
});
