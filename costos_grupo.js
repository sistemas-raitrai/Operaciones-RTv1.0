// costos_grupos.js (COMPLETO)
// Objetivo: total COSTO por grupo (no “conteo de actividades”).
// Cruces:
// - Itinerario (grupos/{gid}.itinerario) -> Servicios/{dest}/Listado/{servicioId o actividad} -> valorServicio/tipoCobro/moneda
// - Hotel: noches + comidas hotel (configurable)
// - Coordinador: regla configurable
// - Gastos aprobados: colección/subcolección configurable (mapeo abajo)
//
// ✅ IMPORTANTE: arriba hay un bloque "MAPEO" para ajustar a TU Firestore real.

import { auth, db } from './firebase-init.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs, query, orderBy,
  doc, getDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

/* =========================================================
   0) MAPEO (AJUSTA AQUÍ 1 SOLA VEZ)
   ========================================================= */

// Destinos donde existe Servicios/{DEST}/Listado
const DESTINOS_SERVICIOS = ['BRASIL','BARILOCHE','SUR DE CHILE','NORTE DE CHILE','OTRO'];

// Cómo leer “pax total” desde grupo / actividad
const PAX = {
  // del grupo
  groupTotal: (g) => num(g?.paxTotal ?? g?.pax ?? g?.PAX ?? g?.cantidadgrupo),
  // de una actividad (si viene detalle por actividad)
  actTotal: (a) => {
    const adultos = num(a?.adultos ?? a?.Adultos);
    const est     = num(a?.estudiantes ?? a?.Estudiantes ?? a?.paxEstudiantes);
    const pax     = num(a?.pax ?? a?.Pax);
    return pax || (adultos + est) || 0;
  }
};

// Campos de fechas del grupo (si no existen, inferimos por itinerario)
const FECHAS = {
  // deben devolver ISO YYYY-MM-DD o vacío
  inicio: (g) => iso(g?.fechaInicio ?? g?.inicioViaje ?? g?.fechaDeViajeInicio ?? ''),
  fin:    (g) => iso(g?.fechaFin ?? g?.finViaje ?? g?.fechaDeViajeFin ?? ''),
};

// Hotel del grupo (si existe a nivel grupo)
const HOTEL = {
  nombre:  (g) => (g?.hotel ?? g?.Hotel ?? g?.hotelNombre ?? '').toString().trim(),
  regimen: (g) => (g?.regimen ?? g?.pension ?? g?.regimenHotel ?? '').toString().trim(), // EJ: PC / MP / SA
};

// ¿Dónde está el “pago coordinador”?
// Si no hay campo, usamos regla por defecto.
const COORD = {
  // si hay valor fijo ya calculado en el doc:
  pagoFijo: (g) => num(g?.pagoCoordinador ?? g?.coordinadorPago ?? g?.finanzas?.pagoCoordinador),
  // regla fallback si no hay pago fijo:
  regla: ({ dias, paxTotal }) => 0, // ← AJUSTA (ej: dias*120000, o paxTotal*3000, etc.)
};

// ¿Cómo calculamos hotel?
// Si no tienes tarifas en BD, puedes partir con “0” y luego conectar a tu catálogo.
const HOTEL_COST = {
  // tarifa por NOCHE por persona (ejemplo placeholder)
  // OJO: puedes cambiarlo a lectura desde Firestore (hoteles/{dest}/listado/{hotel})
  tarifaNochePP: ({ destino, hotel, regimen }) => 0,   // ← AJUSTA
  // comidas incluidas por noche según regimen
  // Ej: PC incluye almuerzo+cena; MP incluye cena; etc.
  comidasIncluidas: ({ regimen }) => {
    const r = U(regimen);
    if (r.includes('PC')) return { almuerzo: true, cena: true };
    if (r.includes('MP')) return { almuerzo: false, cena: true };
    return { almuerzo: false, cena: false };
  },
  // costo comida extra por persona (si no está incluida)
  costoAlmuerzoPP: ({ destino }) => 0, // ← AJUSTA
  costoCenaPP:     ({ destino }) => 0, // ← AJUSTA
};

// ¿Dónde están los “gastos extras aprobados (coordinadores)”?
// Opciones típicas:
// A) grupos/{gid}/finanzas/gastos (subcolección)
// B) collectionGroup('finanzas_gastos') con campo gid
// C) grupos/{gid}/finanzas_gastos (subcolección)
// -> Te dejo A por defecto y fallback a 0 si no existe.
const GASTOS = {
  // Devuelve array de docs { montoAprobado, tipoDoc, ... }
  // Si tu ruta es distinta, cámbiala aquí.
  async listarAprobados(gid){
    // Ajuste: subcolección "finanzas/gastos" o "finanzas_gastos"
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
              // Regla que ya vienes usando: si tipoDoc === 'GASTO' => OK si montoAprobado > 0
              if (tipo === 'GASTO') return m > 0;
              // si no es GASTO, igual sumamos si viene montoAprobado > 0
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

// Moneda: si hay múltiples monedas, aquí defines conversión (placeholder 1:1)
const FX = {
  // retorna valor convertido a CLP (o tu moneda base)
  toBase: ({ amount, moneda }) => amount, // ← AJUSTA si quieres (usar tabla de cambios)
  base: 'CLP'
};

/* =========================================================
   1) UI + Auth gate
   ========================================================= */
const $ = (id) => document.getElementById(id);

onAuthStateChanged(auth, (u) => {
  if (!u) return (location.href = 'login.html');
  init().catch(err => {
    console.error(err);
    alert('Error: ' + (err?.message || err));
  });
});

const state = {
  servicesIndex: new Map(), // destino -> Map(key -> svc)
  grupos: [],               // [{id, data}]
  destinos: ['ALL', ...DESTINOS_SERVICIOS],
};

async function init(){
  // llenar destino select
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

  setStatus('Cargando servicios...');
  await loadServiciosIndex();

  setStatus('Cargando grupos...');
  const gSnap = await getDocs(collection(db, 'grupos'));
  state.grupos = gSnap.docs.map(d => ({ id:d.id, data:d.data() || {} }));

  setStatus(`Listo ✅ (grupos: ${state.grupos.length}, servicios indexados)`);
  await aplicar();
}

function setStatus(msg){ const el=$('status'); if(el) el.textContent = msg || ''; }

/* =========================================================
   2) Carga Servicios + Index (para precio por actividad)
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

        // index por id/nombre/aliases
        idx.set(U(id), svc);
        idx.set(nombre, svc);
        aliases.forEach(a => idx.set(a, svc));
      });
    } catch(_){
      // destino puede no existir: ok
    }
  }
}

function findServicio({ destinoHint, servicioId, actividadTxt }){
  const d = U(destinoHint || '');
  const idU = U(servicioId || '');
  const actU = U(actividadTxt || '');

  // 1) con destino
  if (d && state.servicesIndex.has(d)){
    const idx = state.servicesIndex.get(d);
    if (idU && idx.has(idU)) return idx.get(idU);
    if (actU && idx.has(actU)) return idx.get(actU);
  }

  // 2) global
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
   3) Cálculo por grupo
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

    // Fechas
    const { inicio, fin, fechasIt } = getFechasGrupo(G);
    const fechasTxt = (inicio && fin) ? `${inicio} → ${fin}` : (fechasIt.length ? `${fechasIt[0]} → ${fechasIt[fechasIt.length-1]}` : '—');

    // Filtro destino (si aplica)
    if (dest !== 'ALL' && U(dest) !== U(destinoGrupo) && U(dest) !== 'OTRO'){
      // OJO: igual puede haber servicioDestino distinto a destinoGrupo; aquí filtramos por destinoGrupo.
      // Si prefieres filtrar por actividad, lo cambiamos.
      continue;
    }

    // Filtro texto
    if (q){
      const hay = U([gid, nombreGrupo, numeroNegocio, destinoGrupo, (G.coordinador||G.coord||'')].join(' '))
        .includes(q);
      if (!hay) continue;
    }

    // Rango fechas (aplica por inicio/fin si existen; si no, por fechas itinerario)
    if (!grupoEnRango({ inicio, fin, fechasIt }, desde, hasta)) continue;

    // 1) Actividades (itinerario -> servicios -> costo)
    const acts = calcActividades({ G, gid, paxTotal, destinoGrupo });

    // 2) Hotel (noches + comidas)
    const hot = calcHotel({ G, paxTotal, destinoGrupo, inicio, fin, fechasIt });

    // 3) Coordinador
    const coord = calcCoordinador({ G, paxTotal, inicio, fin, fechasIt });

    // 4) Gastos aprobados (async)
    const gastosArr = await GASTOS.listarAprobados(gid);
    const gastos = gastosArr.reduce((acc,x)=> acc + FX.toBase({ amount: GASTOS.monto(x), moneda: GASTOS.moneda(x) }), 0);

    const total = acts.total + hot.total + coord.total + gastos;
    const porPax = paxTotal ? (total / paxTotal) : 0;

    const alerts = []
      .concat(acts.alerts)
      .concat(hot.alerts)
      .concat(coord.alerts)
      .concat(gastosArr.length ? [] : []); // si quieres alertar “sin gastos”: no

    rows.push({
      n: ++n,
      gid, numeroNegocio, nombreGrupo,
      destino: destinoGrupo,
      pax: paxTotal,
      fechas: fechasTxt,
      acts, hot, coord, gastos,
      total, porPax,
      alerts
    });
  }

  // ordenar por total desc
  rows.sort((a,b)=> (b.total - a.total));

  // render
  if (!rows.length){
    tbody.innerHTML = `<tr><td colspan="13" class="muted">Sin resultados.</td></tr>`;
    setStatus('OK ✅ (0 filas)');
    // guarda cache para export
    window.__COSTOS_ROWS__ = [];
    return;
  }

  for (const r of rows){
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${r.n}</td>
      <td title="${esc(r.gid)}">${esc((r.numeroNegocio ? `(${r.numeroNegocio}) ` : '') + (r.nombreGrupo || r.gid))}</td>
      <td>${esc(r.destino || '—')}</td>
      <td class="right">${fmt0(r.pax)}</td>
      <td class="muted">${esc(r.fechas)}</td>
      <td class="right">${fmtMoney(r.acts.total)}</td>
      <td class="right">${fmtMoney(r.hot.hotel)}</td>
      <td class="right">${fmtMoney(r.hot.comidasExtra)}</td>
      <td class="right">${fmtMoney(r.coord.total)}</td>
      <td class="right">${fmtMoney(r.gastos)}</td>
      <td class="right"><b>${fmtMoney(r.total)}</b></td>
      <td class="right">${r.pax ? fmtMoney(r.porPax) : '—'}</td>
      <td class="${r.alerts.length ? 'warn' : 'muted'}" title="${esc(r.alerts.join(' | '))}">
        ${r.alerts.length ? esc(r.alerts.slice(0,2).join(' · ') + (r.alerts.length>2?' …':'')) : '—'}
      </td>
    `;
    tbody.appendChild(tr);
  }

  window.__COSTOS_ROWS__ = rows;
  setStatus(`OK ✅ (${rows.length} grupos)`);
}

/* =========================
   Actividades
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

      // cantidad base para cobrar
      const tipoCobro = U(svc.tipoCobro);
      const paxAct = PAX.actTotal(A) || paxTotal; // si actividad no trae pax, usa pax grupo

      let qty = 1;
      if (tipoCobro.includes('POR PERSONA')) qty = paxAct || paxTotal || 0;
      else if (tipoCobro.includes('POR GRUPO')) qty = 1;
      else if (tipoCobro.includes('POR DIA')) qty = 1; // ocurrencia diaria ya está implícita por fecha
      else qty = 1;

      const amount = precio * qty;
      total += FX.toBase({ amount, moneda: svc.moneda });

      // Si quieres guardar detalle por actividad, lo agregamos después.
    }
  }

  return { total, alerts };
}

/* =========================
   Hotel (noches + comidas)
========================= */
function calcHotel({ G, paxTotal, destinoGrupo, inicio, fin, fechasIt }){
  const alerts = [];

  const hotel = HOTEL.nombre(G);
  const regimen = HOTEL.regimen(G);

  // noches
  const nights = calcNoches({ inicio, fin, fechasIt });
  if (!nights){
    alerts.push('NOCHES? (sin fechas)');
  }

  // tarifa noche PP
  let hotelCost = 0;
  if (!hotel){
    alerts.push('HOTEL? (sin asignación)');
  } else {
    const t = num(HOTEL_COST.tarifaNochePP({ destino: destinoGrupo, hotel, regimen }));
    if (!t) alerts.push('TARIFA HOTEL?');
    hotelCost = t * (paxTotal || 0) * (nights || 0);
  }

  // comidas extra: si regimen no incluye, cobramos por día (nights) o por “días de viaje”
  // Asunción: por noche hay 1 almuerzo + 1 cena (ajustable)
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
   Coordinador
========================= */
function calcCoordinador({ G, paxTotal, inicio, fin, fechasIt }){
  const alerts = [];
  const fijo = COORD.pagoFijo(G);

  if (fijo > 0) return { total: fijo, alerts: [] };

  const dias = calcDias({ inicio, fin, fechasIt });
  const calc = num(COORD.regla({ dias, paxTotal }));

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
   5) Utilidades (fechas / inferencias / formatos)
   ========================================================= */
function U(s){ return (s ?? '').toString().trim().toUpperCase(); }
function num(v){ const n = Number(v); return Number.isFinite(n) ? n : 0; }

function todayISO(){
  const d = new Date();
  const z = new Date(d.getTime() - d.getTimezoneOffset()*60000);
  return z.toISOString().slice(0,10);
}
function iso(s){
  // si ya viene YYYY-MM-DD, ok
  const t = (s||'').toString().trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return '';
}

function getFechasGrupo(G){
  const inicio = FECHAS.inicio(G);
  const fin = FECHAS.fin(G);

  // fallback: por itinerario
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
  // noches = diferencia días (fin - inicio)
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
  // si no hay filtros, ok
  if (!desde && !hasta) return true;

  const a = inicio || (fechasIt[0] || '');
  const b = fin || (fechasIt[fechasIt.length-1] || '');
  if (!a && !b) return true;

  // se considera “en rango” si se superpone
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
