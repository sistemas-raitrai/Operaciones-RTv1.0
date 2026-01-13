// costos_master.js
// ✅ Lo que hace (según lo que pediste):
// - Construye una "PRINCIPAL" por grupo con totales por ítem en CLP y USD.
// - Crea hojas de DETALLE POR ÍTEM (global, todos los grupos), con moneda original + conversión a USD.
// - Soporta destino normal (Chile/Exterior) y destino compuesto (Chile+Exterior paralelo) usando SEGMENTO.
// - Exporta XLSX con fórmulas (SUMIFS / XLOOKUP) para que Excel calcule.
// - En pantalla muestra: Principal + tabs con cada hoja detalle.
//
// ⚠️ Importante (mapeo):
// - ACTIVIDADES: sale de grupos/{gid}.itinerario + Servicios/{DESTINO}/Listado
// - GASTOS: busca en rutas comunes (ajústalo si tu Firestore difiere)
// - AÉREOS / HOTEL / TERRESTRE / ETC: quedan listos como "emitters" para que conectes tu fuente real
//   (porque en tus 2 códigos no venía una fuente estándar para aéreos/hotel).
//
// Requiere:
// - firebase-init.js exporte { app, db } (como en tu costos.js actual)
// - Firestore: colección 'grupos', y colección 'Servicios' con subcolección 'Listado' por destino.
//
// Export formulas:
// - Excel guarda fórmulas en inglés aunque tu Excel esté en español (normal). Excel las traduce al abrir.

import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs, doc, getDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

/* =========================
   CONFIG (AJUSTA AQUÍ)
========================= */
const CHILE_DESTINOS = new Set([
  'CHILE', 'SUR DE CHILE', 'NORTE DE CHILE', 'SANTIAGO', 'PUCON', 'PÚCON', 'PUERTO VARAS'
]);

// Ítems que tendrán hoja detalle
const ITEMS = [
  { key:'ACTIVIDADES', sheet:'DET_ACTIVIDADES' },
  { key:'GASTOS',      sheet:'DET_GASTOS' },
  // Puedes activar estos cuando conectes sus fuentes:
  // { key:'AEREOS',      sheet:'DET_AEREOS' },
  // { key:'HOTEL',       sheet:'DET_HOTEL' },
  // { key:'TERRESTRE',   sheet:'DET_TERRESTRE' },
];

// Rutas posibles de gastos aprobados (ajusta si tu estructura real es otra)
const GASTOS_PATHS = [
  (gid) => ['grupos', gid, 'finanzas', 'gastos'],
  (gid) => ['grupos', gid, 'finanzas_gastos'],
  (gid) => ['grupos', gid, 'finanzas', 'gastosCoordinador'],
];

// Regla de “aprobado” (coherente con tu lógica previa)
function gastoEsAprobado(x){
  const tipo = U(x?.tipoDoc ?? x?.tipo ?? '');
  const m = num(x?.montoAprobado ?? x?.aprobado ?? x?.monto ?? 0);
  if (tipo === 'GASTO') return m > 0;
  return m > 0;
}

/* =========================
   HELPERS
========================= */
const el = (id) => document.getElementById(id);
const U = (s='') => (s ?? '').toString().normalize('NFD').replace(/\p{Diacritic}/gu,'').trim().toUpperCase();
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const fmt0 = (n) => (Number(n)||0).toLocaleString('es-CL');
const moneyCLP = (n) => '$' + fmt0(Math.round(Number(n)||0));
const moneyUSD = (n) => 'US$' + (Number(n)||0).toLocaleString('es-CL', { maximumFractionDigits: 2 });

function todayISO(){
  const d = new Date();
  const z = new Date(d.getTime() - d.getTimezoneOffset()*60000);
  return z.toISOString().slice(0,10);
}

function paxBaseDeGrupo(g){
  const baseDirect = Number(g.cantidadPax || g.cantidadgrupo || g.pax || g.PAX || 0);
  const a = Number(g.adultos || g.ADULTOS || 0);
  const e = Number(g.estudiantes || g.ESTUDIANTES || 0);
  return (a + e) || baseDirect || 0;
}
function paxContableDeGrupo(g){
  const base = paxBaseDeGrupo(g);
  const paxReales    = Number(g.paxReales ?? g.paxReal ?? g.paxFinal ?? g.PAXFINAL ?? 0);
  const paxLiberados = Number(g.paxLiberados ?? g.liberados ?? 0);
  const reales = paxReales > 0 ? paxReales : base;
  const contable = Math.max(0, reales - paxLiberados);
  return { base, reales, liberados: paxLiberados, contable };
}

function within(dateISO, d1, d2) {
  if (!dateISO) return false;
  const t  = new Date(dateISO + 'T00:00:00').getTime();
  const t1 = d1 ? new Date(d1 + 'T00:00:00').getTime() : -Infinity;
  const t2 = d2 ? new Date(d2 + 'T00:00:00').getTime() : Infinity;
  return t >= t1 && t <= t2;
}

function normalizarMoneda(m){
  const M = U(m);
  if (['REAL','REALES','R$','BRL'].includes(M)) return 'BRL';
  if (['ARS','AR$','ARG','PESO ARGENTINO','PESOS ARGENTINOS'].includes(M)) return 'ARS';
  if (['USD','US$','DOLAR','DÓLAR','DOLLAR'].includes(M)) return 'USD';
  if (!M) return 'CLP';
  return M; // CLP u otra
}

/* =========================
   FX (USD por 1 unidad)
   - Siempre convertimos a USD (montoUSD = montoOriginal * USD_por_1)
========================= */
function fxTableFromUI(){
  const fxCLP = num(el('fxCLP').value || 0);
  const fxBRL = num(el('fxBRL').value || 0);
  const fxARS = num(el('fxARS').value || 0);

  // USD por 1 unidad
  const map = new Map();
  map.set('USD', 1);
  if (fxCLP > 0) map.set('CLP', fxCLP);
  if (fxBRL > 0) map.set('BRL', fxBRL);
  if (fxARS > 0) map.set('ARS', fxARS);
  return map;
}

function toUSD(moneda, monto, fxMap){
  const m = normalizarMoneda(moneda);
  const r = fxMap.get(m);
  if (!r) return null;
  return num(monto) * r;
}

function usdToCLP(usd, fxMap){
  // CLP USD por 1 CLP => para pasar USD->CLP hacemos: CLP = USD / (USD_por_1_CLP)
  const rCLP = fxMap.get('CLP');
  if (!rCLP) return null;
  return num(usd) / rCLP;
}

/* =========================
   SEGMENTO (CHILE vs EXTERIOR)
   - Para destinos compuestos, el segmento se define por subdestino del servicio/ítem.
========================= */
function segmentoFromDestino(destinoTxt){
  const d = U(destinoTxt);
  if (!d) return 'EXTERIOR';
  // Heurística: si contiene un destino chileno, lo tratamos como CHILE
  // (en servicios: destino suele ser el "top doc" Servicios/{DESTINO})
  for (const c of CHILE_DESTINOS){
    if (d.includes(c)) return 'CHILE';
  }
  return 'EXTERIOR';
}

function tipoDestinoGrupo(destinoGrupo){
  // Chile si es 100% Chile
  const d = U(destinoGrupo);
  const hasChile = segmentoFromDestino(d) === 'CHILE';
  const hasExterior = /BARILOCHE|BRASIL|ARGENTINA|URUGUAY|PARAGUAY|PERU|PERÚ|BOLIVIA|USA|EEUU|EUROPA/.test(d);
  // Si dice explícitamente "Y" o "/" o mezcla, lo marcamos compuesto si detecta ambos
  if ((d.includes('Y') || d.includes('/') || d.includes(',')) && (hasChile || hasExterior)) return 'COMPUESTO';
  if (hasChile && hasExterior) return 'COMPUESTO';
  if (hasChile && !hasExterior) return 'CHILE';
  return 'EXTERIOR';
}

/* =========================
   DATA LOAD
========================= */
let GRUPOS = [];
let SERVICIOS = [];
let SERV_IDX = new Map(); // key DEST||ACT -> svc (rápido)

async function loadGrupos(){
  const snap = await getDocs(collection(db, 'grupos'));
  GRUPOS = snap.docs.map(d => ({ id:d.id, ...d.data() }));
}

async function loadServicios(){
  const rootSnap = await getDocs(collection(db, 'Servicios'));
  const prom = [];
  for (const top of rootSnap.docs){
    const destinoId = top.id;
    prom.push(
      getDocs(collection(top.ref, 'Listado'))
        .then(snap => snap.docs.map(d => ({ id:d.id, destino: destinoId, ...d.data() })))
        .catch(()=>[])
    );
  }
  const arrays = await Promise.all(prom);
  SERVICIOS = arrays.flat();

  SERV_IDX.clear();
  for (const s of SERVICIOS){
    const dest = U(s.destino || s.DESTINO || s.ciudad || s.CIUDAD || '');
    const act  = U(s.servicio || s.actividad || s.nombre || s.id || '');
    const k = `${dest}||${act}`;
    if (!SERV_IDX.has(k)) SERV_IDX.set(k, s);

    // aliases simples
    const idU = U(s.id);
    if (idU) SERV_IDX.set(`${dest}||${idU}`, s);
  }
}

function resolverServicio(itemActividad, destinoGrupo){
  const act = U(itemActividad?.actividad || itemActividad?.servicio || itemActividad?.servicioId || '');
  const dest = U(destinoGrupo || '');
  const k = `${dest}||${act}`;
  if (SERV_IDX.has(k)) return SERV_IDX.get(k);

  // fallback: primer match por act (sin destino)
  return SERVICIOS.find(s => U(s.servicio || s.actividad || s.nombre || s.id || '') === act) || null;
}

/* =========================
   UI helpers
========================= */
function setLog(msg){ el('log').textContent = msg || '—'; }

function fillDestinoFilter(){
  const sel = el('filtroDestino');
  const destinos = [...new Set(GRUPOS.map(g => (g.destino || g.DESTINO || g.ciudad || '').trim()).filter(Boolean))].sort();
  sel.innerHTML = `<option value="*">TODOS</option>` + destinos.map(d => `<option value="${d}">${d}</option>`).join('');
}

function fillGrupoSelect(){
  const destinoSel = el('filtroDestino').value;
  const groups = GRUPOS
    .filter(g => destinoSel === '*' ? true : (g.destino || g.DESTINO || g.ciudad || '') === destinoSel)
    .map(g => {
      const cod = (g.numeroNegocio || g.id || '').toString();
      const nom = (g.nombreGrupo || g.NOMBRE || '').toString();
      return { id:g.id, label:`${cod} — ${nom}`.trim() };
    })
    .sort((a,b)=>a.label.localeCompare(b.label,'es'));

  const sel = el('selGrupo');
  sel.innerHTML = `<option value="">— Todos los grupos filtrados —</option>` + groups.map(x => `<option value="${x.id}">${x.label}</option>`).join('');
}

function activateTab(key){
  [...document.querySelectorAll('.cm-tab')].forEach(b => b.classList.toggle('active', b.dataset.key === key));
  [...document.querySelectorAll('.cm-pane')].forEach(p => p.classList.toggle('active', p.dataset.key === key));
}

/* =========================
   EMIT: construir líneas detalle por ítem
   Cada línea tiene:
   { item, gid, codigo, grupo, anio, destinoGrupo, segmento, empresa, asunto, cantidad, monedaOriginal, montoOriginal, montoUSD, montoCLP? }
========================= */
function makeBaseLine({ item, g, segmento, empresa, asunto, cantidad, monedaOriginal, montoOriginal, fxMap }){
  const gid = g.id;
  const codigo = (g.numeroNegocio || g.id || '').toString();
  const grupo = (g.nombreGrupo || g.NOMBRE || '').toString();
  const anio = (g.anoViaje || g.ano || g.anio || '').toString();
  const destinoGrupo = (g.destino || g.DESTINO || g.ciudad || '').toString();

  const mon = normalizarMoneda(monedaOriginal || 'CLP');
  const montoUSD = toUSD(mon, montoOriginal, fxMap);
  const montoCLP = (montoUSD == null) ? null : usdToCLP(montoUSD, fxMap);

  return {
    item,
    gid, codigo, grupo, anio, destinoGrupo,
    segmento, // CHILE / EXTERIOR
    empresa: (empresa || '').toString(),
    asunto: (asunto || '').toString(),
    cantidad: num(cantidad),
    monedaOriginal: mon,
    montoOriginal: num(montoOriginal),
    montoUSD: montoUSD == null ? null : num(montoUSD),
    montoCLP: montoCLP == null ? null : num(montoCLP),
  };
}

// 1) ACTIVIDADES (itinerario + Servicios)
function emitActividades(g, fxMap, fDesde, fHasta){
  const destinoGrupo = (g.destino || g.DESTINO || g.ciudad || '').toString();
  const { contable: paxContable } = paxContableDeGrupo(g);

  const it = g.itinerario || {};
  const out = [];
  const seenDia = new Set(); // para por_dia

  for (const fechaISO of Object.keys(it)){
    if (!within(fechaISO, fDesde, fHasta)) continue;

    const arr = Array.isArray(it[fechaISO]) ? it[fechaISO] : [];
    for (const item of arr){
      const svc = resolverServicio(item, destinoGrupo);
      if (!svc) continue;

      const svcDestino = (svc.destino || destinoGrupo || '').toString();
      const segmento = segmentoFromDestino(svcDestino); // clave para compuestos

      const moneda = normalizarMoneda(svc.moneda || svc.MONEDA || 'CLP');
      const tipoCobroRaw = (svc.tipoCobro || svc.tipo_cobro || '').toString();
      const tipo = U(tipoCobroRaw);

      const valor = num(svc.valorServicio ?? svc.valor_servicio ?? svc.valor ?? svc.precio ?? 0);
      const servicioNombre = (svc.servicio || item.actividad || item.servicio || svc.id || '').toString();
      const proveedor = (svc.proveedor || item.proveedor || '(sin proveedor)').toString();

      let cantidad = 1;
      let monto = 0;

      if (tipo.includes('PAX') || tipo.includes('PERSONA') || tipo.includes('POR PERSONA')){
        cantidad = paxContable;
        monto = valor * paxContable;
      } else if (tipo.includes('POR DIA') || tipo.includes('DIA')){
        const k = `${fechaISO}||${U(svc.id || servicioNombre)}`;
        if (seenDia.has(k)) continue;
        seenDia.add(k);
        cantidad = 1;
        monto = valor;
      } else {
        // default por grupo
        cantidad = 1;
        monto = valor;
      }

      out.push(makeBaseLine({
        item: 'ACTIVIDADES',
        g,
        segmento,
        empresa: proveedor,
        asunto: servicioNombre,
        cantidad,
        monedaOriginal: moneda,
        montoOriginal: monto,
        fxMap
      }));
    }
  }

  return out;
}

// 2) GASTOS (subcolecciones)
async function emitGastos(g, fxMap){
  const gid = g.id;
  let docs = [];

  for (const fn of GASTOS_PATHS){
    try{
      const path = fn(gid);
      const snap = await getDocs(collection(db, ...path));
      if (!snap.empty){
        docs = snap.docs.map(d => ({ id:d.id, ...d.data() }));
        break;
      }
    } catch(_) {}
  }

  const out = [];
  for (const x of docs){
    if (!gastoEsAprobado(x)) continue;

    const segmento = 'EXTERIOR'; // default: gastos suelen ser del destino exterior; AJUSTA si tienes campo destino/segmento en el gasto
    const moneda = normalizarMoneda(x.moneda || x.currency || 'CLP');
    const monto = num(x.montoAprobado ?? x.aprobado ?? x.monto ?? 0);

    out.push(makeBaseLine({
      item: 'GASTOS',
      g,
      segmento,
      empresa: (x.proveedor || x.comercio || x.rutProveedor || '').toString(),
      asunto: (x.descripcion || x.detalle || x.tipoDoc || 'Gasto').toString(),
      cantidad: 1,
      monedaOriginal: moneda,
      montoOriginal: monto,
      fxMap
    }));
  }

  return out;
}

/* =========================
   CÁLCULO: genera estructura final
========================= */
async function buildAll(){
  const fxMap = fxTableFromUI();

  const destinoSel = el('filtroDestino').value;
  const gidSel = el('selGrupo').value || '';
  const fDesde = el('fechaDesde').value || '';
  const fHasta = el('fechaHasta').value || '';

  // filtra grupos
  let groups = GRUPOS.filter(g => destinoSel === '*' ? true : (g.destino || g.DESTINO || g.ciudad || '') === destinoSel);
  if (gidSel) groups = groups.filter(g => g.id === gidSel);

  // detalles por item (global)
  const detailsByItem = new Map();
  ITEMS.forEach(it => detailsByItem.set(it.key, []));

  // Recorremos grupos y emitimos líneas
  for (const g of groups){
    // ACTIVIDADES (sync)
    detailsByItem.get('ACTIVIDADES').push(...emitActividades(g, fxMap, fDesde, fHasta));

    // GASTOS (async)
    detailsByItem.get('GASTOS').push(...await emitGastos(g, fxMap));

    // TODO: aquí sumas otros emisores (AEREOS/HOTEL/etc.) cuando conectes fuente real
  }

  // Construir principal (totales por grupo y por segmento)
  const principalRows = [];
  let i = 0;

  for (const g of groups){
    const destinoGrupo = (g.destino || g.DESTINO || g.ciudad || '').toString();
    const tipo = tipoDestinoGrupo(destinoGrupo);
    const { contable: paxContable } = paxContableDeGrupo(g);

    // suma por item/segmento
    const sum = (itemKey, seg, field) => {
      const arr = detailsByItem.get(itemKey) || [];
      return arr
        .filter(x => x.gid === g.id && x.segmento === seg)
        .reduce((acc,x)=> acc + num(x[field]), 0);
    };

    // ACTIVIDADES
    const actCLP = sum('ACTIVIDADES', 'CHILE', 'montoCLP');
    const actUSD = sum('ACTIVIDADES', 'EXTERIOR', 'montoUSD');

    // GASTOS
    const gasCLP = sum('GASTOS', 'CHILE', 'montoCLP');      // probablemente 0 hoy por default segmento
    const gasUSD = sum('GASTOS', 'EXTERIOR', 'montoUSD');

    const totalCLP = actCLP + gasCLP;
    const totalUSD = actUSD + gasUSD;

    const fxCLP = fxMap.get('CLP') || null;
    const totalUSDConsol = totalUSD + (fxCLP ? (totalCLP * fxCLP) : 0);

    principalRows.push({
      n: ++i,
      gid: g.id,
      codigo: (g.numeroNegocio || g.id || '').toString(),
      grupo: (g.nombreGrupo || g.NOMBRE || '').toString(),
      destino: destinoGrupo,
      tipo,
      paxContable,
      actCLP, actUSD,
      gasCLP, gasUSD,
      totalCLP,
      totalUSD,
      totalUSDConsol
    });
  }

  // Orden: mayor total consolidado USD
  principalRows.sort((a,b)=> (b.totalUSDConsol - a.totalUSDConsol));

  return { principalRows, detailsByItem, fxMap, meta: { destinoSel, gidSel, fDesde, fHasta } };
}

/* =========================
   RENDER: Principal + Tabs Detalle
========================= */
function renderPrincipal(principalRows){
  const tb = el('tblPrincipal').querySelector('tbody');
  tb.innerHTML = '';

  for (const r of principalRows){
    tb.insertAdjacentHTML('beforeend', `
      <tr>
        <td>${r.n}</td>
        <td title="${r.gid}">${r.gid}</td>
        <td>${r.codigo}</td>
        <td>${r.grupo}</td>
        <td>${r.destino}</td>
        <td>${r.tipo}</td>
        <td class="cm-right">${fmt0(r.paxContable)}</td>
        <td class="cm-right">${r.actCLP ? moneyCLP(r.actCLP) : '—'}</td>
        <td class="cm-right">${r.actUSD ? moneyUSD(r.actUSD) : '—'}</td>
        <td class="cm-right">${r.gasCLP ? moneyCLP(r.gasCLP) : '—'}</td>
        <td class="cm-right">${r.gasUSD ? moneyUSD(r.gasUSD) : '—'}</td>
        <td class="cm-right"><b>${r.totalCLP ? moneyCLP(r.totalCLP) : '—'}</b></td>
        <td class="cm-right"><b>${r.totalUSD ? moneyUSD(r.totalUSD) : '—'}</b></td>
        <td class="cm-right"><b>${r.totalUSDConsol ? moneyUSD(r.totalUSDConsol) : '—'}</b></td>
      </tr>
    `);
  }
}

function renderTabs(detailsByItem){
  const tabs = el('tabs');
  const panes = el('panes');
  tabs.innerHTML = '';
  panes.innerHTML = '';

  const keys = [...detailsByItem.keys()];
  keys.forEach((k, idx) => {
    const btn = document.createElement('button');
    btn.className = 'cm-tab' + (idx===0 ? ' active':'' );
    btn.textContent = k;
    btn.dataset.key = k;
    btn.addEventListener('click', ()=> activateTab(k));
    tabs.appendChild(btn);

    const pane = document.createElement('div');
    pane.className = 'cm-pane' + (idx===0 ? ' active':'' );
    pane.dataset.key = k;
    pane.innerHTML = `
      <div style="margin-top:12px; font-weight:950; color:#111827;">Detalle: ${k}</div>
      <div class="cm-muted">Global (todos los grupos). Original + USD + (CLP opcional).</div>
      <div class="cm-tablewrap" style="margin-top:10px;">
        <table id="tbl_${k}">
          <thead>
            <tr>
              <th>GID</th>
              <th>Código</th>
              <th>Grupo</th>
              <th>Destino</th>
              <th>Segmento</th>
              <th>Empresa</th>
              <th>Asunto</th>
              <th class="cm-right">Cantidad</th>
              <th>Moneda</th>
              <th class="cm-right">Monto Original</th>
              <th class="cm-right">Monto USD</th>
              <th class="cm-right">Monto CLP</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
    `;
    panes.appendChild(pane);
  });

  // llenar tablas
  for (const [k, arr] of detailsByItem.entries()){
    const tb = document.querySelector(`#tbl_${k} tbody`);
    tb.innerHTML = '';
    for (const x of arr){
      tb.insertAdjacentHTML('beforeend', `
        <tr>
          <td title="${x.gid}">${x.gid}</td>
          <td>${x.codigo}</td>
          <td>${x.grupo}</td>
          <td>${x.destinoGrupo}</td>
          <td>${x.segmento}</td>
          <td>${x.empresa}</td>
          <td>${x.asunto}</td>
          <td class="cm-right">${fmt0(x.cantidad)}</td>
          <td>${x.monedaOriginal}</td>
          <td class="cm-right">${x.monedaOriginal==='USD' ? moneyUSD(x.montoOriginal) : moneyCLP(x.montoOriginal)}</td>
          <td class="cm-right">${x.montoUSD==null ? '—' : moneyUSD(x.montoUSD)}</td>
          <td class="cm-right">${x.montoCLP==null ? '—' : moneyCLP(x.montoCLP)}</td>
        </tr>
      `);
    }
  }
}

/* =========================
   EXPORT XLSX (con fórmulas)
========================= */
function exportXLSX({ principalRows, detailsByItem, fxMap }){
  if (!window.XLSX) return alert('XLSX no está cargado');

  // ---------- FX sheet ----------
  const fxAOA = [
    ['fecha','moneda','USD_por_1'],
    [todayISO(),'USD', 1],
    [todayISO(),'CLP', fxMap.get('CLP') ?? ''],
    [todayISO(),'BRL', fxMap.get('BRL') ?? ''],
    [todayISO(),'ARS', fxMap.get('ARS') ?? ''],
  ];
  const wb = XLSX.utils.book_new();
  const wsFX = XLSX.utils.aoa_to_sheet(fxAOA);
  XLSX.utils.book_append_sheet(wb, wsFX, 'FX');

  // ---------- Detail sheets ----------
  // Estructura estándar (igual para todas)
  // Nota: fórmulas en Excel se guardan en inglés (SUMIFS / XLOOKUP).
  const detailSheetNames = new Map(ITEMS.map(x => [x.key, x.sheet]));

  for (const [itemKey, lines] of detailsByItem.entries()){
    const sheetName = detailSheetNames.get(itemKey) || `DET_${itemKey}`;
    const aoa = [[
      'gid','Codigo','Grupo','Ano','DestinoGrupo','Segmento',
      'Item','Empresa','Asunto','Cantidad',
      'MonedaOriginal','MontoOriginal','USD_por_1','MontoUSD','MontoCLP'
    ]];

    for (const x of lines){
      // Columna USD_por_1 y MontoUSD/MontoCLP como FÓRMULAS referenciando FX:
      // USD_por_1 = XLOOKUP(MonedaOriginal, FX[moneda], FX[USD_por_1])
      // MontoUSD  = MontoOriginal * USD_por_1
      // MontoCLP  = IFERROR(MontoUSD / XLOOKUP("CLP", FX[moneda], FX[USD_por_1]), "")
      //
      // En SheetJS: usamos objeto { f:"..." } para fórmula.
      const rowIndex = aoa.length + 1; // 1-based en Excel
      const col = (c) => XLSX.utils.encode_cell({ r: rowIndex-1, c }); // helper no usado aquí, dejamos por claridad

      // En AOA podemos meter objetos con {f: "..."} para fórmulas
      // Columnas:
      // 0 gid,1 Codigo,2 Grupo,3 Ano,4 DestinoGrupo,5 Segmento,6 Item,7 Empresa,8 Asunto,9 Cantidad,
      // 10 MonedaOriginal,11 MontoOriginal,12 USD_por_1,13 MontoUSD,14 MontoCLP
      //
      // Referencias: K = MonedaOriginal (col 11? no, col 10 es K si A=0 => K=10),
      //              L = MontoOriginal (11), M = USD_por_1 (12), N = MontoUSD (13)
      const monedaCell = `K${rowIndex}`;
      const montoOrigCell = `L${rowIndex}`;
      const usdPor1Cell = `M${rowIndex}`;
      const montoUsdCell = `N${rowIndex}`;

      aoa.push([
        x.gid, x.codigo, x.grupo, x.anio, x.destinoGrupo, x.segmento,
        x.item, x.empresa, x.asunto, x.cantidad,
        x.monedaOriginal, x.montoOriginal,
        { f: `XLOOKUP(${monedaCell}, FX!B:B, FX!C:C, "")` },
        { f: `IF(${usdPor1Cell}="", "", ${montoOrigCell}*${usdPor1Cell})` },
        { f: `IFERROR(${montoUsdCell}/XLOOKUP("CLP", FX!B:B, FX!C:C, ""), "")` },
      ]);
    }

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  }

  // ---------- PRINCIPAL sheet ----------
  // La PRINCIPAL se alimenta por SUMIFS desde cada DET_*:
  // Ejemplo (Actividades CLP):
  // =SUMIFS(DET_ACTIVIDADES!O:O, DET_ACTIVIDADES!A:A, $B2, DET_ACTIVIDADES!F:F, "CHILE")
  // Donde:
  // - gid en col B de principal
  // - DET_*: gid col A, Segmento col F, MontoCLP col O (15? en nuestra hoja es col O=15? revisemos)
  //
  // En detalle:
  // A gid
  // F Segmento
  // N MontoUSD (col 14 -> N)
  // O MontoCLP (col 15 -> O)
  //
  // En principal:
  // B gid
  //
  const pAOA = [[
    '#','GID','Codigo','Grupo','Destino','Tipo','PAX_contable',
    'Actividades_CLP','Actividades_USD',
    'Gastos_CLP','Gastos_USD',
    'TOTAL_CLP','TOTAL_USD','TOTAL_USD_CONSOL'
  ]];

  for (let idx=0; idx<principalRows.length; idx++){
    const r = principalRows[idx];
    const rowIndex = pAOA.length + 1; // excel row
    const gidCell = `B${rowIndex}`;

    const fxCLPCell = `XLOOKUP("CLP", FX!B:B, FX!C:C, "")`;

    // refs a hojas
    const detAct = 'DET_ACTIVIDADES';
    const detGas = 'DET_GASTOS';

    const actCLP = { f: `SUMIFS(${detAct}!O:O, ${detAct}!A:A, ${gidCell}, ${detAct}!F:F, "CHILE")` };
    const actUSD = { f: `SUMIFS(${detAct}!N:N, ${detAct}!A:A, ${gidCell}, ${detAct}!F:F, "EXTERIOR")` };
    const gasCLP = { f: `SUMIFS(${detGas}!O:O, ${detGas}!A:A, ${gidCell}, ${detGas}!F:F, "CHILE")` };
    const gasUSD = { f: `SUMIFS(${detGas}!N:N, ${detGas}!A:A, ${gidCell}, ${detGas}!F:F, "EXTERIOR")` };

    // totals
    const totalCLPCell = `L${rowIndex}`;
    const totalUSDCell = `M${rowIndex}`;
    const totalUSDConsol = { f: `IF(${fxCLPCell}="", ${totalUSDCell}, ${totalUSDCell} + (${totalCLPCell}*${fxCLPCell}))` };

    pAOA.push([
      idx+1,
      r.gid,
      r.codigo,
      r.grupo,
      r.destino,
      r.tipo,
      r.paxContable,
      actCLP,
      actUSD,
      gasCLP,
      gasUSD,
      { f: `SUM(H${rowIndex}, J${rowIndex})` }, // total CLP = ActCLP + GasCLP
      { f: `SUM(I${rowIndex}, K${rowIndex})` }, // total USD = ActUSD + GasUSD
      totalUSDConsol
    ]);
  }

  const wsP = XLSX.utils.aoa_to_sheet(pAOA);
  XLSX.utils.book_append_sheet(wb, wsP, 'PRINCIPAL');

  const fname = `Costos_Master_${todayISO()}.xlsx`;
  XLSX.writeFile(wb, fname);
}

/* =========================
   BOOT
========================= */
async function calcularYRender(){
  setLog('Calculando…');
  const result = await buildAll();
  renderPrincipal(result.principalRows);
  renderTabs(result.detailsByItem);
  setLog(`OK ✅ Principal: ${result.principalRows.length} grupos • Detalles: ${[...result.detailsByItem.values()].reduce((a,b)=>a+b.length,0)} líneas`);
  window.__COSTOS_MASTER__ = result; // cache para export
}

async function boot(){
  onAuthStateChanged(auth, (user)=>{
    el('who').textContent = user?.email ? `Conectado: ${user.email}` : '—';
  });

  setLog('Cargando grupos y servicios…');
  await Promise.all([loadGrupos(), loadServicios()]);

  fillDestinoFilter();
  fillGrupoSelect();

  // defaults
  el('fechaHasta').value = todayISO();

  // Si quieres valores por defecto:
  // el('fxCLP').value = '0.00105';
  // el('fxBRL').value = '0.20';
  // el('fxARS').value = '0.0010';

  el('filtroDestino').addEventListener('change', ()=> fillGrupoSelect());
  el('btnCalcular').addEventListener('click', calcularYRender);

  el('btnExportXLSX').addEventListener('click', ()=>{
    const data = window.__COSTOS_MASTER__;
    if (!data) return alert('Primero presiona CALCULAR.');
    exportXLSX(data);
  });

  setLog('Listo. Ajusta FX (USD por 1 unidad), filtra si quieres, y presiona CALCULAR.');
}

boot().catch(e=>{
  console.error(e);
  setLog('Error cargando datos. Revisa consola.');
});
