// costos_grupos.js (COMPLETO)
// ✅ Resumen COSTO por grupo + Detalle editable (revisado/qty/precio/notas)
// ✅ Guarda revisiones en: grupos/{gid}/costosRevision/v1/items/{rowId}
// ✅ Desmarcar revisado pide PIN (window.RT_PIN_DESMARCAR o "0000")

import { auth, db } from './firebase-init.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs, query, orderBy,
  doc, getDoc, setDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

/* =========================================================
   0) MAPEO (AJUSTA AQUÍ 1 SOLA VEZ)
   ========================================================= */
const DESTINOS_SERVICIOS = ['BRASIL','BARILOCHE','SUR DE CHILE','NORTE DE CHILE','OTRO'];

const PAX = {
  groupTotal: (g) => num(g?.paxTotal ?? g?.pax ?? g?.PAX ?? g?.cantidadgrupo),
  actTotal: (a) => {
    const adultos = num(a?.adultos ?? a?.Adultos);
    const est     = num(a?.estudiantes ?? a?.Estudiantes ?? a?.paxEstudiantes);
    const pax     = num(a?.pax ?? a?.Pax);
    return pax || (adultos + est) || 0;
  }
};

const FECHAS = {
  inicio: (g) => iso(g?.fechaInicio ?? g?.inicioViaje ?? g?.fechaDeViajeInicio ?? ''),
  fin:    (g) => iso(g?.fechaFin ?? g?.finViaje ?? g?.fechaDeViajeFin ?? ''),
};

const HOTEL = {
  nombre:  (g) => (g?.hotel ?? g?.Hotel ?? g?.hotelNombre ?? '').toString().trim(),
  regimen: (g) => (g?.regimen ?? g?.pension ?? g?.regimenHotel ?? '').toString().trim(),
};

const COORD = {
  pagoFijo: (g) => num(g?.pagoCoordinador ?? g?.coordinadorPago ?? g?.finanzas?.pagoCoordinador),
  regla: ({ dias, paxTotal }) => 0, // ← AJUSTA si quieres regla fallback
};

const HOTEL_COST = {
  tarifaNochePP: ({ destino, hotel, regimen }) => 0, // ← AJUSTA si conectas catálogo
  comidasIncluidas: ({ regimen }) => {
    const r = U(regimen);
    if (r.includes('PC')) return { almuerzo: true, cena: true };
    if (r.includes('MP')) return { almuerzo: false, cena: true };
    return { almuerzo: false, cena: false };
  },
  costoAlmuerzoPP: ({ destino }) => 0, // ← AJUSTA
  costoCenaPP:     ({ destino }) => 0, // ← AJUSTA
};

const GASTOS = {
  async listarAprobados(gid){
    const paths = [
      ['grupos', gid, 'finanzas', 'gastos'],
      ['grupos', gid, 'finanzas_gastos'],
      ['grupos', gid, 'finanzas', 'gastosCoordinador']
    ];

    for (const p of paths){
      try{
        const colRef = collection(db, ...p);
        const snap = await getDocs(colRef);
        if (!snap.empty){
          return snap.docs
            .map(d => ({ id:d.id, ...d.data() }))
            .filter(x => {
              const tipo = U(x.tipoDoc ?? x.tipo ?? '');
              const m = num(x.montoAprobado ?? x.aprobado ?? x.monto ?? 0);
              if (tipo === 'GASTO') return m > 0;
              return m > 0;
            });
        }
      } catch(_){}
    }
    return [];
  },
  monto: (x) => num(x?.montoAprobado ?? x?.aprobado ?? x?.monto ?? 0),
  moneda: (x) => (x?.moneda ?? x?.currency ?? 'PESO CHILENO').toString()
};

const FX = {
  toBase: ({ amount, moneda }) => amount, // ← AJUSTA si quieres conversión
  base: 'CLP'
};

/* =========================================================
   1) UI + Auth gate
   ========================================================= */
const $ = (id) => document.getElementById(id);

onAuthStateChanged(auth, async (u) => {
  if (!u) return (location.href = 'login.html');
  try{
    await init(u);
  } catch(err){
    console.error(err);
    alert('Error: ' + (err?.message || err));
  }
});

const state = {
  user: null,
  servicesIndex: new Map(), // destino -> Map(key -> svc)
  grupos: [],               // [{id, data}]
};

async function init(u){
  state.user = u;

  // destino select
  const sel = $('dest');
  sel.innerHTML = '';
  sel.appendChild(new Option('— Todos —', 'ALL'));
  DESTINOS_SERVICIOS.forEach(d => sel.appendChild(new Option(d, d)));
  sel.value = 'ALL';

  $('hoy').addEventListener('click', () => {
    const t = todayISO();
    $('desde').value = t;
    $('hasta').value = t;
  });

  $('aplicar').addEventListener('click', aplicar);
  $('exportar').addEventListener('click', exportXLS);

  // click delegado detalle
  $('tbody').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-action="detalle"]');
    if (!btn) return;
    openDetalle(btn.dataset.gid);
  });

  setStatus('Cargando servicios...');
  await loadServiciosIndex();

  setStatus('Cargando grupos...');
  const gSnap = await getDocs(collection(db, 'grupos'));
  state.grupos = gSnap.docs.map(d => ({ id:d.id, data:d.data() || {} }));

  setStatus(`Listo ✅ (grupos: ${state.grupos.length})`);
  await aplicar();
}

function setStatus(msg){ const el=$('status'); if(el) el.textContent = msg || ''; }

/* =========================================================
   2) Servicios index
   ========================================================= */
async function loadServiciosIndex(){
  state.servicesIndex.clear();

  for (const dest of DESTINOS_SERVICIOS){
    const idx = new Map();
    state.servicesIndex.set(U(dest), idx);

    try{
      const snap = await getDocs(query(
        collection(db,'Servicios',dest,'Listado'),
        orderBy('servicio','asc')
      ));

      snap.forEach(docSnap => {
        const o = docSnap.data() || {};
        const id = docSnap.id;

        const nombre = U(o.nombre || o.servicio || id);
        const aliases = new Set([]
          .concat(o.aliases || [])
          .concat(o.prevIds || [])
          .concat([id, nombre])
          .map(U)
          .filter(Boolean)
        );

        const svc = {
          destino: dest,
          id,
          nombre,
          proveedor: U(o.proveedor || ''),
          ciudad: U(o.ciudad || ''),
          tipoCobro: U(o.tipoCobro || ''),
          moneda: (o.moneda || 'PESO CHILENO').toString(),
          valorServicio: num(o.valorServicio || 0),
          voucher: (o.voucher || '').toString(),
          raw: o
        };

        idx.set(U(id), svc);
        idx.set(nombre, svc);
        aliases.forEach(a => idx.set(a, svc));
      });
    } catch(_){
      // ok si no existe destino
    }
  }
}

function findServicio({ destinoHint, servicioId, actividadTxt }){
  const d = U(destinoHint || '');
  const idU = U(servicioId || '');
  const actU = U(actividadTxt || '');

  if (d && state.servicesIndex.has(d)){
    const idx = state.servicesIndex.get(d);
    if (idU && idx.has(idU)) return idx.get(idU);
    if (actU && idx.has(actU)) return idx.get(actU);
  }

  if (idU){
    for (const idx of state.servicesIndex.values()){
      if (idx.has(idU)) return idx.get(idU);
    }
  }
  if (actU){
    for (const idx of state.servicesIndex.values()){
      if (idx.has(actU)) return idx.get(actU);
    }
  }
  return null;
}

/* =========================================================
   3) Resumen por grupo
   ========================================================= */
async function aplicar(){
  const q = U($('q').value || '');
  const dest = $('dest').value || 'ALL';
  const desde = $('desde').value || '';
  const hasta = $('hasta').value || '';

  setStatus('Calculando...');
  const tbody = $('tbody');
  tbody.innerHTML = '';

  const rows = [];
  let n = 0;

  for (const g of state.grupos){
    const G = g.data || {};
    const gid = g.id;

    const nombreGrupo = (G.nombreGrupo || G.nombre || '').toString().trim();
    const numeroNegocio = (G.numeroNegocio || G.numero || '').toString().trim();
    const destinoGrupo = (G.destino || G.Destino || '').toString().trim();

    const paxTotal = PAX.groupTotal(G) || inferPaxFromItinerario(G) || 0;

    const { inicio, fin, fechasIt } = getFechasGrupo(G);
    const fechasTxt = (inicio && fin)
      ? `${inicio} → ${fin}`
      : (fechasIt.length ? `${fechasIt[0]} → ${fechasIt[fechasIt.length-1]}` : '—');

    if (dest !== 'ALL' && U(dest) !== U(destinoGrupo) && U(dest) !== 'OTRO') continue;

    if (q){
      const hay = U([gid, nombreGrupo, numeroNegocio, destinoGrupo, (G.coordinador||G.coord||'')].join(' '))
        .includes(q);
      if (!hay) continue;
    }

    if (!grupoEnRango({ inicio, fin, fechasIt }, desde, hasta)) continue;

    // 1) Actividades base
    const acts = calcActividades({ G, gid, paxTotal, destinoGrupo });

    // 2) Hotel base
    const hot = calcHotel({ G, paxTotal, destinoGrupo, inicio, fin, fechasIt });

    // 3) Coordinador base
    const coord = calcCoordinador({ G, paxTotal, inicio, fin, fechasIt });

    // 4) Gastos aprobados (async)
    const gastosArr = await GASTOS.listarAprobados(gid);
    const gastos = gastosArr.reduce((acc,x)=> acc + FX.toBase({ amount: GASTOS.monto(x), moneda: GASTOS.moneda(x) }), 0);

    // ✅ Si hay overrides guardados, recalculamos TOTAL desde "líneas detalle" (más confiable)
    const totalBase = acts.total + hot.total + coord.total + gastos;
    const totalFinal = await totalDesdeRevisionSiExiste({
      gid, totalBase,
      G, paxTotal, destinoGrupo, inicio, fin, fechasIt,
      actsBase: acts.total,
      hotBase: hot.total,
      coordBase: coord.total,
      gastosBase: gastos
    });

    const porPax = paxTotal ? (totalFinal / paxTotal) : 0;

    const alerts = []
      .concat(acts.alerts)
      .concat(hot.alerts)
      .concat(coord.alerts);

    rows.push({
      n: ++n,
      gid, numeroNegocio, nombreGrupo,
      destino: destinoGrupo,
      pax: paxTotal,
      fechas: fechasTxt,
      acts, hot, coord, gastos,
      total: totalFinal,
      totalBase,
      porPax,
      alerts
    });
  }

  rows.sort((a,b)=> (b.total - a.total));

  if (!rows.length){
    tbody.innerHTML = `<tr><td colspan="14" class="cs-empty">Sin resultados.</td></tr>`;
    setStatus('OK ✅ (0 filas)');
    window.__COSTOS_ROWS__ = [];
    return;
  }

  for (const r of rows){
    const tr = document.createElement('tr');
    tr.setAttribute('data-gid', r.gid);
    tr.innerHTML = `
      <td>${r.n}</td>
      <td title="${esc(r.gid)}">${esc((r.numeroNegocio ? `(${r.numeroNegocio}) ` : '') + (r.nombreGrupo || r.gid))}</td>
      <td>${esc(r.destino || '—')}</td>
      <td class="cs-right cs-mono">${fmt0(r.pax)}</td>
      <td class="cs-dim">${esc(r.fechas)}</td>
      <td class="cs-right cs-mono">${fmtMoney(r.acts.total)}</td>
      <td class="cs-right cs-mono">${fmtMoney(r.hot.hotel)}</td>
      <td class="cs-right cs-mono">${fmtMoney(r.hot.comidasExtra)}</td>
      <td class="cs-right cs-mono">${fmtMoney(r.coord.total)}</td>
      <td class="cs-right cs-mono">${fmtMoney(r.gastos)}</td>
      <td class="cs-right cs-mono"><b>${fmtMoney(r.total)}</b></td>
      <td class="cs-right cs-mono">${r.pax ? fmtMoney(r.porPax) : '—'}</td>
      <td class="${r.alerts.length ? 'warn' : 'cs-dim'}" title="${esc(r.alerts.join(' | '))}">
        ${r.alerts.length ? esc(r.alerts.slice(0,2).join(' · ') + (r.alerts.length>2?' …':'')) : '—'}
      </td>
      <td>
        <button class="ghost" data-action="detalle" data-gid="${esc(r.gid)}">Detalle</button>
      </td>
    `;
    tbody.appendChild(tr);
  }

  window.__COSTOS_ROWS__ = rows;
  setStatus(`OK ✅ (${rows.length} grupos)`);
}

/* =========================
   Actividades (base)
========================= */
function calcActividades({ G, gid, paxTotal, destinoGrupo }){
  const it = G.itinerario || {};
  const alerts = [];
  let total = 0;

  for (const fecha of Object.keys(it)){
    const arr = Array.isArray(it[fecha]) ? it[fecha] : [];
    for (const a0 of arr){
      const A = a0 || {};
      const servicioId = A.servicioId || A.servicio || '';
      const actividad = A.actividad || A.servicioNombre || A.nombre || '';
      const destinoAct = (A.servicioDestino || A.destino || destinoGrupo || '').toString();

      const svc = findServicio({ destinoHint: destinoAct, servicioId, actividadTxt: actividad });

      if (!svc){
        alerts.push(`SIN TARIFA: ${U(actividad||servicioId||'ACT')}`);
        continue;
      }

      const precio = num(svc.valorServicio);
      if (!precio){
        alerts.push(`TARIFA=0: ${svc.nombre}`);
        continue;
      }

      const tipoCobro = U(svc.tipoCobro);
      const paxAct = PAX.actTotal(A) || paxTotal;

      let qty = 1;
      if (tipoCobro.includes('POR PERSONA')) qty = paxAct || paxTotal || 0;
      else if (tipoCobro.includes('POR GRUPO')) qty = 1;
      else if (tipoCobro.includes('POR DIA')) qty = 1;
      else qty = 1;

      const amount = precio * qty;
      total += FX.toBase({ amount, moneda: svc.moneda });
    }
  }

  return { total, alerts };
}

/* =========================
   Hotel (base)
========================= */
function calcHotel({ G, paxTotal, destinoGrupo, inicio, fin, fechasIt }){
  const alerts = [];

  const hotel = HOTEL.nombre(G);
  const regimen = HOTEL.regimen(G);

  const nights = calcNoches({ inicio, fin, fechasIt });
  if (!nights) alerts.push('NOCHES? (sin fechas)');

  let hotelCost = 0;
  if (!hotel){
    alerts.push('HOTEL? (sin asignación)');
  } else {
    const t = num(HOTEL_COST.tarifaNochePP({ destino: destinoGrupo, hotel, regimen }));
    if (!t) alerts.push('TARIFA HOTEL?');
    hotelCost = t * (paxTotal || 0) * (nights || 0);
  }

  const inc = HOTEL_COST.comidasIncluidas({ regimen });
  let comidasExtra = 0;
  const dias = calcDias({ inicio, fin, fechasIt });

  if (!inc.almuerzo){
    const alm = num(HOTEL_COST.costoAlmuerzoPP({ destino: destinoGrupo }));
    if (!alm) alerts.push('COSTO ALMUERZO?');
    comidasExtra += alm * (paxTotal || 0) * (dias || 0);
  }
  if (!inc.cena){
    const cena = num(HOTEL_COST.costoCenaPP({ destino: destinoGrupo }));
    if (!cena) alerts.push('COSTO CENA?');
    comidasExtra += cena * (paxTotal || 0) * (dias || 0);
  }

  return {
    hotel: FX.toBase({ amount: hotelCost, moneda: FX.base }),
    comidasExtra: FX.toBase({ amount: comidasExtra, moneda: FX.base }),
    total: FX.toBase({ amount: (hotelCost + comidasExtra), moneda: FX.base }),
    alerts
  };
}

/* =========================
   Coordinador (base)
========================= */
function calcCoordinador({ G, paxTotal, inicio, fin, fechasIt }){
  const fijo = COORD.pagoFijo(G);
  if (fijo > 0) return { total: fijo, alerts: [] };

  const dias = calcDias({ inicio, fin, fechasIt });
  const calc = num(COORD.regla({ dias, paxTotal }));
  const alerts = [];
  if (!calc) alerts.push('PAGO COORD?');
  return { total: calc, alerts };
}

/* =========================================================
   4) Export XLS (lo que se ve)
   ========================================================= */
function exportXLS(){
  try{
    if (!window.XLSX) throw new Error('XLSX no cargado');
    const rows = window.__COSTOS_ROWS__ || [];
    if (!rows.length) return alert('No hay datos para exportar');

    const aoa = [
      ['#','GID','NumeroNegocio','Grupo','Destino','PAX','Fechas',
       'Actividades','Hotel','Comidas extra','Coord','Gastos aprob','TOTAL','$/PAX','Alertas']
    ];

    rows.forEach(r => {
      aoa.push([
        r.n, r.gid, r.numeroNegocio || '', r.nombreGrupo || '', r.destino || '',
        r.pax, r.fechas,
        r.acts.total, r.hot.hotel, r.hot.comidasExtra, r.coord.total, r.gastos,
        r.total, r.porPax,
        (r.alerts || []).join(' | ')
      ]);
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.utils.book_append_sheet(wb, ws, 'COSTOS');
    const fecha = new Date().toISOString().slice(0,10);
    XLSX.writeFile(wb, `Costos_por_Grupo_${fecha}.xlsx`);
  } catch(e){
    alert('No se pudo exportar: ' + (e?.message || e));
  }
}

/* =========================================================
   5) DETALLE EDITABLE (modal + persistencia)
   ========================================================= */
const REV_DOC_ID = 'v1';
const REV_PIN_DEFAULT = '0000';

const modal = {
  backdrop: $('csModalBackdrop'),
  box: $('csModal'),
  title: $('csModalTitle'),
  sub: $('csModalSub'),
  tbody: $('csModalTbody'),
  btnCerrar: $('csModalCerrar'),
  btnGuardar: $('csModalGuardar'),
  status: $('csModalStatus'),
};

let detalleState = {
  gid: '',
  grupoLabel: '',
  rowsAll: [],
  dirty: new Map(),  // rowId -> patch
  revMap: new Map(), // rowId -> data
};

function getRevPin(){
  return String(window.RT_PIN_DESMARCAR || REV_PIN_DEFAULT);
}
function setModalStatus(msg=''){ if(modal.status) modal.status.textContent = msg || ''; }
function openModal(){
  modal.backdrop.style.display = 'block';
  modal.box.style.display = 'block';
  document.body.classList.add('modal-open');
}
function closeModal(){
  modal.backdrop.style.display = 'none';
  modal.box.style.display = 'none';
  document.body.classList.remove('modal-open');
  detalleState = { gid:'', grupoLabel:'', rowsAll:[], dirty:new Map(), revMap:new Map() };
}
modal.backdrop?.addEventListener('click', closeModal);
modal.btnCerrar?.addEventListener('click', closeModal);
modal.btnGuardar?.addEventListener('click', saveDetalleDirty);

function buildRowId(gid, tipo, fechaISO, key, idx=0){
  return `${gid}__${tipo}__${fechaISO || 'NOFECHA'}__${key || 'KEY'}__${idx}`;
}
function calcRowNumbers(r){
  const precio = (r.precioOverride !== '' && r.precioOverride != null)
    ? Number(r.precioOverride || 0)
    : Number(r.precioBase || 0);

  const qty = (r.qtyOverride !== '' && r.qtyOverride != null)
    ? Number(r.qtyOverride || 0)
    : Number(r.qtyCalc || 0);

  const total = (precio || 0) * (qty || 0);
  return { precio, qty, total };
}
function markDetalleDirty(rowId, patch){
  const curr = detalleState.dirty.get(rowId) || {};
  detalleState.dirty.set(rowId, { ...curr, ...patch });

  const tr = modal.tbody.querySelector(`tr[data-rowid="${cssEsc(rowId)}"]`);
  if (tr) tr.classList.add('cs-row-dirty');
}
async function loadRevisionForGid(gid){
  const itemsCol = collection(db, 'grupos', gid, 'costosRevision', REV_DOC_ID, 'items');
  const snap = await getDocs(itemsCol);
  const map = new Map();
  snap.forEach(d => map.set(d.id, d.data() || {}));
  return map;
}

async function openDetalle(gid){
  setModalStatus('Cargando detalle...');
  openModal();

  const g = state.grupos.find(x => x.id === gid);
  const G = g?.data || {};
  const label = (G?.numeroNegocio ? `(${G.numeroNegocio}) ` : '') + (G?.nombreGrupo || gid);

  detalleState.gid = gid;
  detalleState.grupoLabel = label;

  modal.title.textContent = gid;
  modal.sub.textContent = label;

  detalleState.revMap = await loadRevisionForGid(gid);

  // Construye líneas: ACTIVIDADES detalladas + líneas resumen de HOTEL/COMIDAS/COORD/GASTOS
  detalleState.rowsAll = await buildDetalleRowsForGid(gid);

  // aplica overrides/revisado/notas guardadas
  detalleState.rowsAll = detalleState.rowsAll.map(r => {
    const rev = detalleState.revMap.get(r.rowId) || {};
    return {
      ...r,
      revisado: !!rev.revisado,
      qtyOverride: (rev.qtyOverride ?? ''),
      precioOverride: (rev.precioOverride ?? ''),
      nota: (rev.nota ?? ''),
    };
  });

  renderDetalle();
  bindDetalleEventsOnce();
  setModalStatus('Listo.');
}

async function buildDetalleRowsForGid(gid){
  const g = state.grupos.find(x => x.id === gid);
  const G = g?.data || {};

  const destinoGrupo = (G.destino || G.Destino || '').toString().trim();
  const paxTotal = PAX.groupTotal(G) || inferPaxFromItinerario(G) || 0;
  const { inicio, fin, fechasIt } = getFechasGrupo(G);

  // base totals (para líneas resumen)
  const actsBase = buildLineasServiciosDesdeItinerario({ gid, G, paxTotal, destinoGrupo });
  const hotBase = calcHotel({ G, paxTotal, destinoGrupo, inicio, fin, fechasIt });
  const coordBase = calcCoordinador({ G, paxTotal, inicio, fin, fechasIt });
  const gastosArr = await GASTOS.listarAprobados(gid);
  const gastosBase = gastosArr.reduce((acc,x)=> acc + FX.toBase({ amount: GASTOS.monto(x), moneda: GASTOS.moneda(x) }), 0);

  // líneas resumen (editables igual, por si quieres nota / override)
  const resumen = [
    {
      rowId: buildRowId(gid, 'HOTEL', inicio || fechasIt[0] || 'NOFECHA', 'HOTEL', 0),
      tipo: 'HOTEL',
      fechaISO: inicio || fechasIt[0] || '',
      concepto: HOTEL.nombre(G) ? `HOTEL: ${HOTEL.nombre(G)}` : 'HOTEL (sin asignación)',
      proveedor: HOTEL.nombre(G) ? HOTEL.nombre(G) : '',
      unidad: 'TOTAL',
      moneda: FX.base,
      precioBase: Number(hotBase.hotel || 0),
      qtyCalc: 1
    },
    {
      rowId: buildRowId(gid, 'COMIDAS_EXTRA', inicio || fechasIt[0] || 'NOFECHA', 'COMIDAS', 0),
      tipo: 'COMIDAS_EXTRA',
      fechaISO: inicio || fechasIt[0] || '',
      concepto: 'COMIDAS EXTRA (hotel)',
      proveedor: HOTEL.nombre(G) ? HOTEL.nombre(G) : '',
      unidad: 'TOTAL',
      moneda: FX.base,
      precioBase: Number(hotBase.comidasExtra || 0),
      qtyCalc: 1
    },
    {
      rowId: buildRowId(gid, 'COORD', inicio || fechasIt[0] || 'NOFECHA', 'COORD', 0),
      tipo: 'COORD',
      fechaISO: inicio || fechasIt[0] || '',
      concepto: 'COORDINADOR',
      proveedor: (G.coordinador || G.coord || '').toString(),
      unidad: 'TOTAL',
      moneda: FX.base,
      precioBase: Number(coordBase.total || 0),
      qtyCalc: 1
    },
    {
      rowId: buildRowId(gid, 'GASTOS_APROB', inicio || fechasIt[0] || 'NOFECHA', 'GASTOS', 0),
      tipo: 'GASTOS_APROB',
      fechaISO: inicio || fechasIt[0] || '',
      concepto: `GASTOS APROBADOS (${gastosArr.length})`,
      proveedor: 'COORDINACIÓN',
      unidad: 'TOTAL',
      moneda: FX.base,
      precioBase: Number(gastosBase || 0),
      qtyCalc: 1
    },
  ];

  return [...actsBase, ...resumen];
}

function buildLineasServiciosDesdeItinerario({ gid, G, paxTotal, destinoGrupo }){
  const it = G.itinerario || {};
  const rows = [];
  let idx = 0;

  for (const fecha of Object.keys(it).sort()){
    const arr = Array.isArray(it[fecha]) ? it[fecha] : [];
    for (const a0 of arr){
      const A = a0 || {};
      const servicioId = A.servicioId || A.servicio || '';
      const actividad = A.actividad || A.servicioNombre || A.nombre || '';
      const destinoAct = (A.servicioDestino || A.destino || destinoGrupo || '').toString();

      const svc = findServicio({ destinoHint: destinoAct, servicioId, actividadTxt: actividad });

      const tipo = 'ACTIVIDAD';
      const key = U(servicioId || actividad || 'ACT');
      const rowId = buildRowId(gid, tipo, fecha, key, idx++);

      if (!svc){
        rows.push({
          rowId,
          tipo,
          fechaISO: fecha,
          concepto: actividad || servicioId || 'ACTIVIDAD',
          proveedor: '',
          unidad: 'SIN TARIFA',
          moneda: FX.base,
          precioBase: 0,
          qtyCalc: 0
        });
        continue;
      }

      const precio = num(svc.valorServicio);
      const tipoCobro = U(svc.tipoCobro);
      const paxAct = PAX.actTotal(A) || paxTotal;

      let qty = 1;
      if (tipoCobro.includes('POR PERSONA')) qty = paxAct || paxTotal || 0;
      else if (tipoCobro.includes('POR GRUPO')) qty = 1;
      else if (tipoCobro.includes('POR DIA')) qty = 1;
      else qty = 1;

      rows.push({
        rowId,
        tipo,
        fechaISO: fecha,
        concepto: svc.nombre || actividad || servicioId || 'ACTIVIDAD',
        proveedor: (svc.proveedor || ''),
        unidad: tipoCobro || 'SERVICIO',
        moneda: svc.moneda || FX.base,
        precioBase: Number(precio || 0),
        qtyCalc: Number(qty || 0)
      });
    }
  }

  return rows;
}

// Render modal
let detalleEventsBound = false;

function renderDetalle(){
  const rows = detalleState.rowsAll;

  if (!rows.length){
    modal.tbody.innerHTML = `<tr><td colspan="12" class="cs-empty">Sin líneas.</td></tr>`;
    return;
  }

  modal.tbody.innerHTML = rows.map((r, i) => {
    const { total } = calcRowNumbers(r);
    return `
      <tr data-rowid="${escAttr(r.rowId)}">
        <td class="cs-mono cs-dim">${escHtml(String(i+1))}</td>
        <td><span class="cs-badge">${escHtml(r.tipo || '—')}</span></td>
        <td class="cs-mono">${escHtml(r.fechaISO || '—')}</td>
        <td>
          <div style="font-weight:900">${escHtml(r.concepto || '—')}</div>
          <div class="cs-dim cs-mono" style="font-size:.82rem">${escHtml(r.rowId)}</div>
        </td>
        <td>${escHtml(r.proveedor || '—')}</td>
        <td class="cs-mono">${escHtml(r.unidad || '—')}</td>

        <td class="cs-right">
          <input class="cell-input num" data-field="precioOverride"
            value="${escAttr(r.precioOverride ?? '')}"
            placeholder="${escAttr(String(r.precioBase || 0))}" />
        </td>

        <td class="cs-right">
          <input class="cell-input num" data-field="qtyOverride"
            value="${escAttr(r.qtyOverride ?? '')}"
            placeholder="${escAttr(String(r.qtyCalc || 0))}" />
        </td>

        <td class="cs-right cs-mono">${escHtml(fmtMoney(total || 0))}</td>
        <td class="cs-right cs-mono">${escHtml(r.moneda || '—')}</td>

        <td>
          <input type="checkbox" class="chk" data-field="revisado" ${r.revisado ? 'checked' : ''} />
        </td>

        <td>
          <input class="cell-input" data-field="nota"
            value="${escAttr(r.nota ?? '')}" placeholder="..." />
        </td>
      </tr>
    `;
  }).join('');
}

function bindDetalleEventsOnce(){
  if (detalleEventsBound) return;
  detalleEventsBound = true;

  modal.tbody.addEventListener('input', (ev) => {
    const tr = ev.target.closest('tr[data-rowid]');
    if (!tr) return;
    const rowId = tr.getAttribute('data-rowid');
    const field = ev.target.getAttribute('data-field');
    if (!field) return;

    if (field === 'qtyOverride' || field === 'precioOverride'){
      const raw = String(ev.target.value || '').trim();
      const clean = raw === '' ? '' : String(Number(raw.replace(',', '.')) || 0);
      markDetalleDirty(rowId, { [field]: clean });
      return;
    }
    if (field === 'nota'){
      markDetalleDirty(rowId, { nota: String(ev.target.value || '') });
      return;
    }
  });

  modal.tbody.addEventListener('change', (ev) => {
    const tr = ev.target.closest('tr[data-rowid]');
    if (!tr) return;
    const rowId = tr.getAttribute('data-rowid');
    const field = ev.target.getAttribute('data-field');
    if (field !== 'revisado') return;

    const row = detalleState.rowsAll.find(x => x.rowId === rowId);
    const checked = !!ev.target.checked;

    if (!checked && row?.revisado){
      const pin = prompt('PIN para desmarcar "Revisado":');
      if (String(pin || '') !== getRevPin()){
        alert('PIN incorrecto.');
        ev.target.checked = true;
        return;
      }
    }
    markDetalleDirty(rowId, { revisado: checked });
  });
}

async function saveDetalleDirty(){
  if (!detalleState.dirty.size){
    setModalStatus('No hay cambios.');
    return;
  }

  setModalStatus('Guardando...');
  let ok=0, fail=0;

  for (const [rowId, patch] of detalleState.dirty.entries()){
    try{
      const base = detalleState.rowsAll.find(r => r.rowId === rowId);
      const ref = doc(db, 'grupos', detalleState.gid, 'costosRevision', REV_DOC_ID, 'items', rowId);

      const payload = {
        ...patch,
        updatedAt: new Date().toISOString(),
        updatedBy: state.user?.email || 'unknown',
        _meta: base ? {
          tipo: base.tipo || '',
          fechaISO: base.fechaISO || '',
          concepto: base.concepto || '',
          proveedor: base.proveedor || '',
          moneda: base.moneda || '',
          unidad: base.unidad || '',
        } : {}
      };

      await setDoc(ref, payload, { merge:true });
      ok++;

      // aplica a memoria
      if (base){
        if ('revisado' in patch) base.revisado = !!patch.revisado;
        if ('qtyOverride' in patch) base.qtyOverride = patch.qtyOverride;
        if ('precioOverride' in patch) base.precioOverride = patch.precioOverride;
        if ('nota' in patch) base.nota = patch.nota;
      }
    } catch(e){
      console.error('save detalle fail', rowId, e);
      fail++;
    }
  }

  detalleState.dirty.clear();
  renderDetalle();

  // ✅ Recalcula total del grupo y actualiza la tabla resumen en pantalla
  await refreshResumenRow(detalleState.gid);

  setModalStatus(`Listo. Guardados: ${ok}${fail ? ` · Fallidos: ${fail}` : ''}`);
}

async function refreshResumenRow(gid){
  // recalcula leyendo rev
  const g = state.grupos.find(x => x.id === gid);
  if (!g) return;

  const G = g.data || {};
  const destinoGrupo = (G.destino || G.Destino || '').toString().trim();
  const paxTotal = PAX.groupTotal(G) || inferPaxFromItinerario(G) || 0;
  const { inicio, fin, fechasIt } = getFechasGrupo(G);

  const acts = calcActividades({ G, gid, paxTotal, destinoGrupo });
  const hot = calcHotel({ G, paxTotal, destinoGrupo, inicio, fin, fechasIt });
  const coord = calcCoordinador({ G, paxTotal, inicio, fin, fechasIt });
  const gastosArr = await GASTOS.listarAprobados(gid);
  const gastos = gastosArr.reduce((acc,x)=> acc + FX.toBase({ amount: GASTOS.monto(x), moneda: GASTOS.moneda(x) }), 0);

  const totalBase = acts.total + hot.total + coord.total + gastos;
  const totalFinal = await totalDesdeRevisionSiExiste({
    gid, totalBase,
    G, paxTotal, destinoGrupo, inicio, fin, fechasIt,
    actsBase: acts.total, hotBase: hot.total, coordBase: coord.total, gastosBase: gastos
  });

  // actualiza cache rows
  const rows = window.__COSTOS_ROWS__ || [];
  const r = rows.find(x => x.gid === gid);
  if (r){
    r.acts = acts; r.hot = hot; r.coord = coord; r.gastos = gastos;
    r.totalBase = totalBase; r.total = totalFinal;
    r.porPax = paxTotal ? (totalFinal / paxTotal) : 0;
  }

  // actualiza DOM fila
  const tr = document.querySelector(`#tbody tr[data-gid="${cssEsc(gid)}"]`);
  if (!tr) return;

  const tds = tr.querySelectorAll('td');
  // índices según HTML:
  // 0 N°, 1 Grupo, 2 Destino, 3 PAX, 4 Fechas, 5 Acts, 6 Hotel, 7 Comidas, 8 Coord, 9 Gastos, 10 TOTAL, 11 $/PAX, 12 Alertas, 13 Detalle
  if (tds[5]) tds[5].innerHTML = fmtMoney(acts.total);
  if (tds[6]) tds[6].innerHTML = fmtMoney(hot.hotel);
  if (tds[7]) tds[7].innerHTML = fmtMoney(hot.comidasExtra);
  if (tds[8]) tds[8].innerHTML = fmtMoney(coord.total);
  if (tds[9]) tds[9].innerHTML = fmtMoney(gastos);
  if (tds[10]) tds[10].innerHTML = `<b>${fmtMoney(totalFinal)}</b>`;
  if (tds[11]) tds[11].innerHTML = paxTotal ? fmtMoney((totalFinal / paxTotal)) : '—';
}

// ✅ Recalcula total desde overrides si hay docs en costosRevision
async function totalDesdeRevisionSiExiste({ gid, totalBase, G, paxTotal, destinoGrupo, inicio, fin, fechasIt, actsBase, hotBase, coordBase, gastosBase }){
  try{
    const itemsCol = collection(db, 'grupos', gid, 'costosRevision', REV_DOC_ID, 'items');
    const snap = await getDocs(itemsCol);
    if (snap.empty) return totalBase;

    // construimos las mismas líneas que el modal (para tener rowId estable)
    const lineas = await buildDetalleRowsForGid(gid);

    const revMap = new Map();
    snap.forEach(d => revMap.set(d.id, d.data() || {}));

    let sum = 0;
    for (const r of lineas){
      const rev = revMap.get(r.rowId) || {};
      const rr = {
        ...r,
        qtyOverride: (rev.qtyOverride ?? ''),
        precioOverride: (rev.precioOverride ?? ''),
      };
      const { total } = calcRowNumbers(rr);
      // si línea base era “SIN TARIFA” (precioBase=0, qty=0) y no hay override, total será 0 OK
      sum += FX.toBase({ amount: total, moneda: r.moneda || FX.base });
    }

    return sum || totalBase;
  } catch(e){
    console.warn('totalDesdeRevisionSiExiste error', gid, e);
    return totalBase;
  }
}

/* =========================================================
   6) Utilidades
   ========================================================= */
function U(s){ return (s ?? '').toString().trim().toUpperCase(); }
function num(v){ const n = Number(v); return Number.isFinite(n) ? n : 0; }

function todayISO(){
  const d = new Date();
  const z = new Date(d.getTime() - d.getTimezoneOffset()*60000);
  return z.toISOString().slice(0,10);
}
function iso(s){
  const t = (s||'').toString().trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return '';
}

function getFechasGrupo(G){
  const inicio = FECHAS.inicio(G);
  const fin = FECHAS.fin(G);

  const it = G.itinerario || {};
  const fechasIt = Object.keys(it)
    .filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k))
    .sort();

  return { inicio, fin, fechasIt };
}

function calcNoches({ inicio, fin, fechasIt }){
  const a = inicio || (fechasIt[0] || '');
  const b = fin || (fechasIt[fechasIt.length-1] || '');
  if (!a || !b) return 0;
  const ms = (new Date(b) - new Date(a));
  const days = Math.round(ms / 86400000);
  return Math.max(0, days);
}
function calcDias({ inicio, fin, fechasIt }){
  const a = inicio || (fechasIt[0] || '');
  const b = fin || (fechasIt[fechasIt.length-1] || '');
  if (!a || !b) return fechasIt.length || 0;
  const ms = (new Date(b) - new Date(a));
  const days = Math.round(ms / 86400000) + 1;
  return Math.max(0, days);
}

function inferPaxFromItinerario(G){
  const it = G.itinerario || {};
  let best = 0;
  for (const f of Object.keys(it)){
    const arr = Array.isArray(it[f]) ? it[f] : [];
    for (const A of arr){
      const p = PAX.actTotal(A);
      if (p > best) best = p;
    }
  }
  return best;
}

function grupoEnRango({ inicio, fin, fechasIt }, desde, hasta){
  if (!desde && !hasta) return true;

  const a = inicio || (fechasIt[0] || '');
  const b = fin || (fechasIt[fechasIt.length-1] || '');
  if (!a && !b) return true;

  const start = a || b;
  const end = b || a;

  if (desde && end < desde) return false;
  if (hasta && start > hasta) return false;
  return true;
}

function fmt0(n){ return (Number(n)||0).toLocaleString('es-CL'); }
function fmtMoney(n){
  const v = Number(n)||0;
  return '$' + v.toLocaleString('es-CL');
}
function esc(s){ return (s??'').toString().replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m])); }

// HTML safe (modal)
function escHtml(s){ return esc(s); }
function escAttr(s){ return (s ?? '').toString().replace(/"/g,'&quot;'); }
function cssEsc(s){ return (window.CSS && CSS.escape) ? CSS.escape(s) : (s||'').replace(/"/g,'\\"'); }
