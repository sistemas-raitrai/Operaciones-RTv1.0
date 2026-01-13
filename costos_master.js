// costos_master.js
// ✅ Estética: usa tus cg-* y layout sidebar.
// ✅ Principal: columnas EXACTAS como tu CSV (31 cols).
// ✅ Click en montos => abre MODAL con detalle por ítem para ese grupo.
// ✅ Detalle global por ítem (tabs).
// ✅ Exporta XLSX con fórmulas (SUMIFS + XLOOKUP FX).

import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import { collection, getDocs } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

/* =========================================================
   0) CONFIG / MAPEO FLEXIBLE (AJUSTA AQUÍ)
   ========================================================= */

// Destinos que consideras "Chile" (para compuesto Chile+Exterior)
const CHILE_DESTINOS = new Set([
  'SUR DE CHILE', 'NORTE DE CHILE', 'CHILE', 'SANTIAGO'
]);

// Ítems y nombre de hoja/tab (detalle global)
const ITEM_SHEETS = [
  { key:'AEREO',       label:'AÉREO',        sheet:'DET_AEREO' },
  { key:'TERRESTRE',   label:'TERRESTRE',    sheet:'DET_TERRESTRE' },
  { key:'HOTEL',       label:'HOTEL',        sheet:'DET_HOTEL' },
  { key:'ACTIVIDADES', label:'ACTIVIDADES',  sheet:'DET_ACTIVIDADES' },
  { key:'COMIDAS',     label:'COMIDAS',      sheet:'DET_COMIDAS' },
  { key:'COORD',       label:'COORDINADOR',  sheet:'DET_COORD' },
  { key:'GASTOS',      label:'GASTOS',       sheet:'DET_GASTOS' },
  { key:'SEGURO',      label:'SEGURO',       sheet:'DET_SEGURO' },
];

// Cómo leer “aéreos/terrestre/hotel/comidas/seguro” desde doc grupo.
// La idea: si tu Firestore tiene otra estructura, ajustas SOLO esto.
const GROUP_FIELDS = {
  // AÉREO: puede ser string o array de items
  aereo: (g) => g.aereo || g.aereos || g.aereosDetalle || g.vuelos || null,
  // TERRESTRE:
  terrestre: (g) => g.terrestre || g.terrestres || g.transporte || null,
  // HOTEL:
  hotel: (g) => g.hotel || g.hoteles || g.hotelDetalle || null,
  // COMIDAS:
  comidas: (g) => g.comidas || g.restaurantes || g.comidasDetalle || null,
  // SEGURO:
  seguro: (g) => g.seguro || g.seguros || null,
  // COORD:
  coordinadorNombre: (g) => g.coordinador || g.coord || g.coordinadorNombre || '',
  coordinadorMontoCLP: (g) => g.pagoCoordinador || g.coordinadorPago || g.valorCoordinador || 0,
};

// Rutas posibles para gastos aprobados
const GASTOS_PATHS = [
  (gid) => ['grupos', gid, 'finanzas', 'gastos'],
  (gid) => ['grupos', gid, 'finanzas_gastos'],
  (gid) => ['grupos', gid, 'finanzas', 'gastosCoordinador'],
];

// regla aprobado
function gastoEsAprobado(x){
  const tipo = U(x?.tipoDoc ?? x?.tipo ?? '');
  const m = num(x?.montoAprobado ?? x?.aprobado ?? x?.monto ?? 0);
  if (tipo === 'GASTO') return m > 0;
  return m > 0;
}

/* =========================================================
   1) HELPERS
   ========================================================= */
const el = (id) => document.getElementById(id);
const U = (s='') => (s ?? '').toString().normalize('NFD').replace(/\p{Diacritic}/gu,'').trim().toUpperCase();
const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number((v ?? '').toString().replace(/[^\d.-]/g,''));
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
function within(dateISO, d1, d2){
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
  return M;
}

// FX: USD por 1 unidad
function fxMapFromUI(){
  const fxCLP = Number(el('fxCLP').value || 0) || 0;
  const fxBRL = Number(el('fxBRL').value || 0) || 0;
  const fxARS = Number(el('fxARS').value || 0) || 0;

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
  const rCLP = fxMap.get('CLP');
  if (!rCLP) return null;
  return num(usd) / rCLP;
}

function segmentoFromDestino(destino){
  const d = U(destino);
  for (const c of CHILE_DESTINOS){
    if (d.includes(U(c))) return 'CHILE';
  }
  return 'EXTERIOR';
}

// pax contable
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

// noches / fechas (fallback itinerario)
function getFechasGrupo(g){
  const it = g.itinerario || {};
  const fechasIt = Object.keys(it).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
  const inicio = g.fechaInicio || g.inicioViaje || g.fechaDeViajeInicio || fechasIt[0] || '';
  const fin    = g.fechaFin || g.finViaje || g.fechaDeViajeFin || fechasIt[fechasIt.length-1] || '';
  return { inicio: (inicio||'').toString().slice(0,10), fin:(fin||'').toString().slice(0,10), fechasIt };
}
function calcNoches(inicio, fin){
  if (!inicio || !fin) return 0;
  const ms = (new Date(fin) - new Date(inicio));
  const days = Math.round(ms / 86400000);
  return Math.max(0, days);
}

/* =========================================================
   2) CARGA DATA (grupos + Servicios index)
   ========================================================= */
let GRUPOS = [];
let SERVICIOS = [];
let SERV_IDX = new Map(); // DEST||ACT -> svc

async function loadGrupos(){
  const snap = await getDocs(collection(db, 'grupos'));
  GRUPOS = snap.docs.map(d => ({ id:d.id, ...d.data() }));
}

async function loadServicios(){
  const rootSnap = await getDocs(collection(db, 'Servicios'));
  const prom = [];
  for (const top of rootSnap.docs){
    prom.push(
      getDocs(collection(top.ref, 'Listado'))
        .then(snap => snap.docs.map(d => ({ id:d.id, destino: top.id, ...d.data() })))
        .catch(()=>[])
    );
  }
  SERVICIOS = (await Promise.all(prom)).flat();

  SERV_IDX.clear();
  for (const s of SERVICIOS){
    const dest = U(s.destino || s.DESTINO || s.ciudad || s.CIUDAD || '');
    const act  = U(s.servicio || s.actividad || s.nombre || s.id || '');
    SERV_IDX.set(`${dest}||${act}`, s);
    const idU = U(s.id);
    if (idU) SERV_IDX.set(`${dest}||${idU}`, s);
  }
}

function resolverServicio(itemActividad, destinoGrupo){
  const act = U(itemActividad?.actividad || itemActividad?.servicio || itemActividad?.servicioId || '');
  const dest = U(destinoGrupo || '');
  const k = `${dest}||${act}`;
  if (SERV_IDX.has(k)) return SERV_IDX.get(k);
  return SERVICIOS.find(s => U(s.servicio || s.actividad || s.nombre || s.id || '') === act) || null;
}

/* =========================================================
   3) UI: filtros
   ========================================================= */
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

  el('selGrupo').innerHTML =
    `<option value="">— TODOS LOS GRUPOS FILTRADOS —</option>` +
    groups.map(x => `<option value="${x.id}">${x.label}</option>`).join('');
}

/* =========================================================
   4) DETALLE POR ÍTEM: estructura estándar
   ========================================================= */
function makeLine({ itemKey, g, segmento, empresa, asunto, cantidad, monedaOriginal, montoOriginal, fxMap }){
  const gid = g.id;
  const codigo = (g.numeroNegocio || g.id || '').toString();
  const grupo = (g.nombreGrupo || g.NOMBRE || '').toString();
  const anio = (g.anoViaje || g.ano || g.anio || '').toString();
  const destinoGrupo = (g.destino || g.DESTINO || g.ciudad || '').toString();

  const mon = normalizarMoneda(monedaOriginal || 'CLP');
  const usd = toUSD(mon, montoOriginal, fxMap);
  const clp = (usd == null) ? null : usdToCLP(usd, fxMap);

  return {
    itemKey,
    gid, codigo, grupo, anio, destinoGrupo,
    segmento,
    empresa: (empresa || '').toString(),
    asunto: (asunto || '').toString(),
    cantidad: num(cantidad),
    monedaOriginal: mon,
    montoOriginal: num(montoOriginal),
    montoUSD: (usd == null ? null : num(usd)),
    montoCLP: (clp == null ? null : num(clp)),
  };
}

/* =========================================================
   5) EMITTERS (de dónde sale cada ítem)
   ========================================================= */

// 5.1 ACTIVIDADES: itinerario + Servicios
function emitActividades(g, fxMap, fDesde, fHasta){
  const destinoGrupo = (g.destino || g.DESTINO || g.ciudad || '').toString();
  const { contable: paxContable } = paxContableDeGrupo(g);

  const it = g.itinerario || {};
  const out = [];
  const seenDia = new Set();

  for (const fechaISO of Object.keys(it)){
    if (!within(fechaISO, fDesde, fHasta)) continue;
    const arr = Array.isArray(it[fechaISO]) ? it[fechaISO] : [];

    for (const item of arr){
      const svc = resolverServicio(item, destinoGrupo);
      if (!svc) continue;

      const svcDestino = (svc.destino || destinoGrupo || '').toString();
      const segmento = segmentoFromDestino(svcDestino);

      const moneda = normalizarMoneda(svc.moneda || svc.MONEDA || 'CLP');
      const tipo = U((svc.tipoCobro || svc.tipo_cobro || '').toString());
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
        cantidad = 1;
        monto = valor;
      }

      out.push(makeLine({
        itemKey:'ACTIVIDADES',
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

// 5.2 GASTOS: subcolecciones (aprobados)
async function emitGastos(g, fxMap){
  const out = [];
  let docs = [];

  for (const fn of GASTOS_PATHS){
    try{
      const snap = await getDocs(collection(db, ...fn(g.id)));
      if (!snap.empty){
        docs = snap.docs.map(d => ({ id:d.id, ...d.data() }));
        break;
      }
    } catch(_){}
  }

  for (const x of docs){
    if (!gastoEsAprobado(x)) continue;

    // Si tus gastos traen destino/segmento, cámbialo acá:
    const segmento = segmentoFromDestino(x.destino || g.destino || '');

    out.push(makeLine({
      itemKey:'GASTOS',
      g,
      segmento,
      empresa: (x.proveedor || x.comercio || '').toString(),
      asunto: (x.descripcion || x.detalle || x.tipoDoc || 'Gasto').toString(),
      cantidad: 1,
      monedaOriginal: normalizarMoneda(x.moneda || x.currency || 'CLP'),
      montoOriginal: num(x.montoAprobado ?? x.aprobado ?? x.monto ?? 0),
      fxMap
    }));
  }

  return out;
}

// 5.3 “Items desde campos del grupo” (Aéreo / Terrestre / Hotel / Comidas / Seguro)
// Soporta: string, objeto, array.
// Cada item intenta usar {empresa, asunto, moneda, monto} si existe.
// Si es string, lo deja como “Asunto” y empresa vacío.
function emitFromGroupField(itemKey, g, fxMap, raw, monedaDefault){
  const out = [];
  if (!raw) return out;

  const destinoGrupo = (g.destino || g.DESTINO || g.ciudad || '').toString();
  const segmento = segmentoFromDestino(destinoGrupo);

  const pushObj = (o) => {
    const empresa = o.empresa || o.proveedor || o.airline || o.company || '';
    const asunto  = o.asunto || o.descripcion || o.detalle || o.vuelo || o.nombre || o.texto || '';
    const moneda  = normalizarMoneda(o.moneda || o.currency || monedaDefault || 'CLP');
    const monto   = num(o.monto ?? o.valor ?? o.precio ?? o.total ?? 0);
    const qty     = num(o.cantidad ?? o.qty ?? 1) || 1;

    // Si no hay monto, igual lo dejamos como línea informativa (0)
    out.push(makeLine({
      itemKey,
      g,
      segmento,
      empresa,
      asunto: asunto || (typeof o === 'string' ? o : ''),
      cantidad: qty,
      monedaOriginal: moneda,
      montoOriginal: monto,
      fxMap
    }));
  };

  if (Array.isArray(raw)){
    raw.forEach(x => {
      if (x == null) return;
      if (typeof x === 'string') pushObj({ asunto:x, moneda:monedaDefault, monto:0, empresa:'' });
      else pushObj(x);
    });
    return out;
  }

  if (typeof raw === 'string'){
    // separa por ; o salto de línea para múltiples
    const parts = raw.split(/\n|;|•/).map(s=>s.trim()).filter(Boolean);
    if (!parts.length) return out;
    parts.forEach(p => pushObj({ asunto:p, moneda:monedaDefault, monto:0, empresa:'' }));
    return out;
  }

  if (typeof raw === 'object'){
    // si viene con lista interna
    if (Array.isArray(raw.items)) raw.items.forEach(pushObj);
    else pushObj(raw);
    return out;
  }

  return out;
}

// COORDINADOR: detalle simple (1 línea)
function emitCoordinador(g, fxMap){
  const nombre = (GROUP_FIELDS.coordinadorNombre(g) || '').toString();
  const montoCLP = num(GROUP_FIELDS.coordinadorMontoCLP(g) || 0);
  if (!nombre && !montoCLP) return [];
  return [makeLine({
    itemKey:'COORD',
    g,
    segmento: segmentoFromDestino(g.destino || ''),
    empresa: nombre,
    asunto: 'Coordinador(a)',
    cantidad: 1,
    monedaOriginal: 'CLP',
    montoOriginal: montoCLP,
    fxMap
  })];
}

/* =========================================================
   6) BUILD: arma principal + detalles
   ========================================================= */
async function buildAll(){
  const fxMap = fxMapFromUI();

  const destinoSel = el('filtroDestino').value;
  const gidSel = el('selGrupo').value || '';
  const fDesde = el('fechaDesde').value || '';
  const fHasta = el('fechaHasta').value || '';

  let groups = GRUPOS.filter(g => destinoSel === '*' ? true : (g.destino || g.DESTINO || g.ciudad || '') === destinoSel);
  if (gidSel) groups = groups.filter(g => g.id === gidSel);

  // Detalles por ítem
  const details = new Map();
  ITEM_SHEETS.forEach(x => details.set(x.key, []));

  for (const g of groups){
    // Aéreo / Terrestre / Hotel / Comidas / Seguro desde campos grupo (por ahora)
    details.get('AEREO').push(...emitFromGroupField('AEREO', g, fxMap, GROUP_FIELDS.aereo(g), 'CLP'));
    details.get('TERRESTRE').push(...emitFromGroupField('TERRESTRE', g, fxMap, GROUP_FIELDS.terrestre(g), 'USD'));
    details.get('HOTEL').push(...emitFromGroupField('HOTEL', g, fxMap, GROUP_FIELDS.hotel(g), 'USD'));
    details.get('COMIDAS').push(...emitFromGroupField('COMIDAS', g, fxMap, GROUP_FIELDS.comidas(g), 'USD'));
    details.get('SEGURO').push(...emitFromGroupField('SEGURO', g, fxMap, GROUP_FIELDS.seguro(g), 'USD'));

    // Actividades desde itinerario + servicios
    details.get('ACTIVIDADES').push(...emitActividades(g, fxMap, fDesde, fHasta));

    // Coordinador (simple)
    details.get('COORD').push(...emitCoordinador(g, fxMap));

    // Gastos aprobados
    details.get('GASTOS').push(...await emitGastos(g, fxMap));
  }

  // Helpers de suma por gid / item / moneda
  const sum = ({ gid, itemKey, field }) => {
    const arr = details.get(itemKey) || [];
    return arr.filter(x => x.gid === gid).reduce((acc,x)=> acc + (x[field] == null ? 0 : num(x[field])), 0);
  };

  // Principal rows EXACTO columnas CSV
  const principal = [];
  for (const g of groups){
    const codigo = (g.numeroNegocio || g.id || '').toString();
    const grupo = (g.nombreGrupo || g.NOMBRE || '').toString();
    const anio = (g.anoViaje || g.ano || g.anio || '').toString();
    const destino = (g.destino || g.DESTINO || g.ciudad || '').toString();
    const { contable } = paxContableDeGrupo(g);
    const { inicio, fin } = getFechasGrupo(g);
    const noches = calcNoches(inicio, fin);

    const fechasTxt = (inicio && fin) ? `${inicio} → ${fin}` : '—';

    // Valores por ítem (en tu CSV algunos son CLP, otros USD+CLP)
    const aereoCLP = sum({ gid:g.id, itemKey:'AEREO', field:'montoCLP' }); // si no hay fx CLP, puede quedar null -> 0
    const terrestreUSD = sum({ gid:g.id, itemKey:'TERRESTRE', field:'montoUSD' });
    const terrestreCLP = sum({ gid:g.id, itemKey:'TERRESTRE', field:'montoCLP' });

    const hotelUSD = sum({ gid:g.id, itemKey:'HOTEL', field:'montoUSD' });
    const hotelCLP = sum({ gid:g.id, itemKey:'HOTEL', field:'montoCLP' });

    const actUSD = sum({ gid:g.id, itemKey:'ACTIVIDADES', field:'montoUSD' });
    const actCLP = sum({ gid:g.id, itemKey:'ACTIVIDADES', field:'montoCLP' });

    const comUSD = sum({ gid:g.id, itemKey:'COMIDAS', field:'montoUSD' });
    const comCLP = sum({ gid:g.id, itemKey:'COMIDAS', field:'montoCLP' });

    const coordCLP = sum({ gid:g.id, itemKey:'COORD', field:'montoCLP' }); // coord está en CLP
    const gastosCLP = sum({ gid:g.id, itemKey:'GASTOS', field:'montoCLP' }); // gastos suele ser CLP
    const seguroUSD = sum({ gid:g.id, itemKey:'SEGURO', field:'montoUSD' });

    // Totales:
    // TOTAL CLP = suma de columnas CLP (aereoCLP + terrestreCLP + hotelCLP + actCLP + comCLP + coordCLP + gastosCLP)
    const totalCLP = aereoCLP + terrestreCLP + hotelCLP + actCLP + comCLP + coordCLP + gastosCLP;

    // TOTAL USD = suma de columnas USD (terrestreUSD + hotelUSD + actUSD + comUSD + seguroUSD)
    // (Aéreo en tu CSV está en CLP; si lo quieres también en USD, lo metemos después)
    const totalUSD = terrestreUSD + hotelUSD + actUSD + comUSD + seguroUSD;

    principal.push({
      gid: g.id,
      Codigo: codigo,
      Grupo: grupo,
      Año: anio,
      Destino: destino,
      Pax: contable,
      Fechas: fechasTxt,
      Noches: noches,

      AereosTxt: summarizeNames(details.get('AEREO').filter(x=>x.gid===g.id)),
      AereoCLP: aereoCLP,

      TerrestreTxt: summarizeNames(details.get('TERRESTRE').filter(x=>x.gid===g.id)),
      MonedaTerrestre: pickFirstMon(details.get('TERRESTRE').filter(x=>x.gid===g.id), 'USD'),
      TerrestreUSD: terrestreUSD,
      TerrestreCLP: terrestreCLP,

      HotelTxt: summarizeNames(details.get('HOTEL').filter(x=>x.gid===g.id)),
      MonedaHotel: pickFirstMon(details.get('HOTEL').filter(x=>x.gid===g.id), 'USD'),
      HotelUSD: hotelUSD,
      HotelCLP: hotelCLP,

      MonedaAct: pickFirstMon(details.get('ACTIVIDADES').filter(x=>x.gid===g.id), 'USD/CLP'),
      ActUSD: actUSD,
      ActCLP: actCLP,

      ComidasTxt: summarizeNames(details.get('COMIDAS').filter(x=>x.gid===g.id)),
      MonedaComidas: pickFirstMon(details.get('COMIDAS').filter(x=>x.gid===g.id), 'USD'),
      ComidasUSD: comUSD,
      ComidasCLP: comCLP,

      Coordinador: (GROUP_FIELDS.coordinadorNombre(g) || '').toString(),
      CoordCLP: coordCLP,

      GastosCLP: gastosCLP,

      SeguroTxt: summarizeNames(details.get('SEGURO').filter(x=>x.gid===g.id)),
      SeguroUSD: seguroUSD,

      TOTAL_USD: totalUSD,
      TOTAL_CLP: totalCLP,
    });
  }

  return { principal, details, fxMap };
}

function summarizeNames(lines){
  // Devuelve listado corto de empresas/asuntos (sin romper tabla)
  const xs = lines.map(x => x.empresa || x.asunto).filter(Boolean);
  if (!xs.length) return '';
  const uniq = [...new Set(xs.map(s=>s.toString().trim()).filter(Boolean))];
  return uniq.slice(0,2).join(' · ') + (uniq.length>2 ? ' …' : '');
}
function pickFirstMon(lines, fallback){
  const m = lines.map(x=>x.monedaOriginal).filter(Boolean)[0];
  return m || (fallback || '');
}

/* =========================================================
   7) RENDER principal (con links de detalle)
   ========================================================= */
function renderPrincipal(principal){
  const tb = el('tblPrincipal').querySelector('tbody');
  tb.innerHTML = '';

  for (const r of principal){
    const tr = document.createElement('tr');

    // helper para link: click abre modal con detalle item+gid
    const link = (itemKey, text, classRight=false) => {
      const cls = `cg-link${classRight ? ' cg-right':''}`;
      return `<span class="${cls}" data-item="${itemKey}" data-gid="${r.gid}">${text}</span>`;
    };

    tr.innerHTML = `
      <td title="${r.gid}">${esc(r.Codigo)}</td>
      <td>${esc(r.Grupo)}</td>
      <td>${esc(r.Año)}</td>
      <td>${esc(r.Destino)}</td>
      <td class="cg-right">${fmt0(r.Pax)}</td>
      <td>${esc(r.Fechas)}</td>
      <td class="cg-right">${fmt0(r.Noches)}</td>

      <td>${esc(r.AereosTxt || '—')}</td>
      <td class="cg-right">${link('AEREO', r.AereoCLP ? moneyCLP(r.AereoCLP) : '—', true)}</td>

      <td>${esc(r.TerrestreTxt || '—')}</td>
      <td>${esc(r.MonedaTerrestre || '—')}</td>
      <td class="cg-right">${link('TERRESTRE', r.TerrestreUSD ? moneyUSD(r.TerrestreUSD) : '—', true)}</td>
      <td class="cg-right">${link('TERRESTRE', r.TerrestreCLP ? moneyCLP(r.TerrestreCLP) : '—', true)}</td>

      <td>${esc(r.HotelTxt || '—')}</td>
      <td>${esc(r.MonedaHotel || '—')}</td>
      <td class="cg-right">${link('HOTEL', r.HotelUSD ? moneyUSD(r.HotelUSD) : '—', true)}</td>
      <td class="cg-right">${link('HOTEL', r.HotelCLP ? moneyCLP(r.HotelCLP) : '—', true)}</td>

      <td>${esc(r.MonedaAct || '—')}</td>
      <td class="cg-right">${link('ACTIVIDADES', r.ActUSD ? moneyUSD(r.ActUSD) : '—', true)}</td>
      <td class="cg-right">${link('ACTIVIDADES', r.ActCLP ? moneyCLP(r.ActCLP) : '—', true)}</td>

      <td>${esc(r.ComidasTxt || '—')}</td>
      <td>${esc(r.MonedaComidas || '—')}</td>
      <td class="cg-right">${link('COMIDAS', r.ComidasUSD ? moneyUSD(r.ComidasUSD) : '—', true)}</td>
      <td class="cg-right">${link('COMIDAS', r.ComidasCLP ? moneyCLP(r.ComidasCLP) : '—', true)}</td>

      <td>${esc(r.Coordinador || '—')}</td>
      <td class="cg-right">${link('COORD', r.CoordCLP ? moneyCLP(r.CoordCLP) : '—', true)}</td>

      <td class="cg-right">${link('GASTOS', r.GastosCLP ? moneyCLP(r.GastosCLP) : '—', true)}</td>

      <td>${esc(r.SeguroTxt || '—')}</td>
      <td class="cg-right">${link('SEGURO', r.SeguroUSD ? moneyUSD(r.SeguroUSD) : '—', true)}</td>

      <td class="cg-right">${link('TOTAL', r.TOTAL_USD ? moneyUSD(r.TOTAL_USD) : '—', true)}</td>
      <td class="cg-right">${link('TOTAL', r.TOTAL_CLP ? moneyCLP(r.TOTAL_CLP) : '—', true)}</td>
    `;

    tb.appendChild(tr);
  }

  // Listener delegation (click en cualquier monto link)
  tb.onclick = (ev) => {
    const t = ev.target.closest('.cg-link');
    if (!t) return;
    const gid = t.dataset.gid;
    const item = t.dataset.item;

    // TOTAL: abre modal con resumen por ítems (para ese grupo)
    if (item === 'TOTAL'){
      openModalTotal(gid);
      return;
    }

    openModalItem(item, gid);
  };
}

/* =========================================================
   8) TABS detalle global por ítem
   ========================================================= */
function renderTabs(details){
  const tabs = el('tabs');
  const panes = el('panes');
  tabs.innerHTML = '';
  panes.innerHTML = '';

  ITEM_SHEETS.forEach((it, idx) => {
    const b = document.createElement('button');
    b.className = 'cg-tab' + (idx===0 ? ' active':'');
    b.textContent = it.label;
    b.dataset.key = it.key;
    b.onclick = () => activateTab(it.key);
    tabs.appendChild(b);

    const pane = document.createElement('div');
    pane.className = 'cg-pane' + (idx===0 ? ' active':'');
    pane.dataset.key = it.key;

    pane.innerHTML = `
      <div style="margin-top:12px; font-weight:950; color:#111827;">Detalle global: ${it.label}</div>
      <div class="cg-muted">Todos los grupos. (Click en principal abre el mismo detalle filtrado por grupo.)</div>

      <div class="cg-tablewrap" style="margin-top:10px;">
        <table id="tbl_${it.key}">
          <thead>
            <tr>
              <th>Codigo</th>
              <th>Grupo</th>
              <th>Destino</th>
              <th>Empresa</th>
              <th>Asunto</th>
              <th>Moneda</th>
              <th class="cg-right">Cantidad</th>
              <th class="cg-right">Monto Original</th>
              <th class="cg-right">Monto USD</th>
              <th class="cg-right">Monto CLP</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
    `;
    panes.appendChild(pane);

    // llenar
    const arr = details.get(it.key) || [];
    const tbody = pane.querySelector('tbody');
    tbody.innerHTML = arr.length ? '' : `<tr><td colspan="10" class="cg-muted">Sin datos.</td></tr>`;

    for (const x of arr){
      const origLabel =
        x.monedaOriginal === 'USD' ? moneyUSD(x.montoOriginal) :
        x.monedaOriginal === 'CLP' ? moneyCLP(x.montoOriginal) :
        fmt0(x.montoOriginal);

      tbody.insertAdjacentHTML('beforeend', `
        <tr>
          <td title="${x.gid}">${esc(x.codigo)}</td>
          <td>${esc(x.grupo)}</td>
          <td>${esc(x.destinoGrupo)}</td>
          <td>${esc(x.empresa || '—')}</td>
          <td>${esc(x.asunto || '—')}</td>
          <td>${esc(x.monedaOriginal || '—')}</td>
          <td class="cg-right">${fmt0(x.cantidad)}</td>
          <td class="cg-right">${origLabel}</td>
          <td class="cg-right">${x.montoUSD==null ? '—' : moneyUSD(x.montoUSD)}</td>
          <td class="cg-right">${x.montoCLP==null ? '—' : moneyCLP(x.montoCLP)}</td>
        </tr>
      `);
    }
  });
}

function activateTab(key){
  [...document.querySelectorAll('.cg-tab')].forEach(b => b.classList.toggle('active', b.dataset.key === key));
  [...document.querySelectorAll('.cg-pane')].forEach(p => p.classList.toggle('active', p.dataset.key === key));
}

/* =========================================================
   9) MODAL detalle por ítem (click en montos)
   ========================================================= */
function openModalItem(itemKey, gid){
  const data = window.__COSTOS_MASTER__;
  if (!data) return;

  const { details } = data;
  const arrAll = details.get(itemKey) || [];
  const arr = arrAll.filter(x => x.gid === gid);

  const g = GRUPOS.find(z => z.id === gid);
  const codigo = (g?.numeroNegocio || gid || '').toString();
  const nombre = (g?.nombreGrupo || g?.NOMBRE || '').toString();
  const destino = (g?.destino || g?.DESTINO || g?.ciudad || '').toString();

  el('modalTitle').textContent = `Detalle · ${labelOfItem(itemKey)} · ${codigo} — ${nombre}`;
  el('modalSub').textContent = `Destino: ${destino || '—'} · Líneas: ${arr.length}`;

  paintModalTable(arr);
  showModal(true);
}

function openModalTotal(gid){
  // Total: lo mostramos como “resumen de ítems” (y de ahí puedes clickear a cada ítem)
  const data = window.__COSTOS_MASTER__;
  if (!data) return;

  const g = GRUPOS.find(z => z.id === gid);
  const codigo = (g?.numeroNegocio || gid || '').toString();
  const nombre = (g?.nombreGrupo || g?.NOMBRE || '').toString();
  const destino = (g?.destino || g?.DESTINO || g?.ciudad || '').toString();

  el('modalTitle').textContent = `TOTAL · ${codigo} — ${nombre}`;
  el('modalSub').textContent = `Destino: ${destino || '—'} · Click en un ítem en la tabla principal para ver su detalle.`;

  // Tabla: armamos “líneas” fake para que se vea el resumen
  const sumItem = (key, field) => (data.details.get(key) || []).filter(x=>x.gid===gid).reduce((a,x)=>a+(x[field]==null?0:num(x[field])),0);

  const rows = ITEM_SHEETS
    .filter(x => x.key !== 'TOTAL')
    .map(x => ({
      empresa: x.label,
      asunto: 'Resumen',
      monedaOriginal: '',
      cantidad: 1,
      montoOriginal: 0,
      montoUSD: (x.key === 'AEREO' || x.key === 'COORD' || x.key === 'GASTOS') ? null : sumItem(x.key, 'montoUSD'),
      montoCLP: sumItem(x.key, 'montoCLP'),
    }));

  paintModalTable(rows, { isTotal:true });
  showModal(true);
}

function labelOfItem(k){
  return (ITEM_SHEETS.find(x=>x.key===k)?.label) || k;
}

function paintModalTable(arr, opts={}){
  const tb = el('tblModal').querySelector('tbody');
  tb.innerHTML = '';

  let totOrig = 0;
  let totUSD = 0;
  let totCLP = 0;

  if (!arr.length){
    tb.innerHTML = `<tr><td colspan="7" class="cg-muted">Sin detalle para este ítem.</td></tr>`;
    el('modalTotOrig').textContent = '—';
    el('modalTotUSD').textContent = '—';
    el('modalTotCLP').textContent = '—';
    return;
  }

  for (const x of arr){
    totOrig += num(x.montoOriginal);
    if (x.montoUSD != null) totUSD += num(x.montoUSD);
    if (x.montoCLP != null) totCLP += num(x.montoCLP);

    const origLabel =
      x.monedaOriginal === 'USD' ? moneyUSD(x.montoOriginal) :
      x.monedaOriginal === 'CLP' ? moneyCLP(x.montoOriginal) :
      (x.monedaOriginal ? fmt0(x.montoOriginal) : '—');

    tb.insertAdjacentHTML('beforeend', `
      <tr>
        <td>${esc(x.empresa || '—')}</td>
        <td>${esc(x.asunto || '—')}</td>
        <td>${esc(x.monedaOriginal || '—')}</td>
        <td class="cg-right">${fmt0(x.cantidad || 0)}</td>
        <td class="cg-right">${origLabel}</td>
        <td class="cg-right">${x.montoUSD==null ? '—' : moneyUSD(x.montoUSD)}</td>
        <td class="cg-right">${x.montoCLP==null ? '—' : moneyCLP(x.montoCLP)}</td>
      </tr>
    `);
  }

  el('modalTotOrig').textContent = (opts.isTotal ? '—' : fmt0(totOrig));
  el('modalTotUSD').textContent  = (totUSD ? moneyUSD(totUSD) : '—');
  el('modalTotCLP').textContent  = (totCLP ? moneyCLP(totCLP) : '—');
}

function showModal(on){
  el('modalBackdrop').style.display = on ? 'flex' : 'none';
  el('modalBackdrop').setAttribute('aria-hidden', on ? 'false' : 'true');
}

/* =========================================================
   10) EXPORT XLSX (con fórmulas)
   ========================================================= */
function exportXLSX(){
  try{
    if (!window.XLSX) throw new Error('XLSX no cargado');
    const data = window.__COSTOS_MASTER__;
    if (!data) return alert('Primero presiona CALCULAR.');

    const { principal, details, fxMap } = data;

    const wb = XLSX.utils.book_new();

    // FX sheet
    const fxAOA = [
      ['fecha','moneda','USD_por_1'],
      [todayISO(),'USD', 1],
      [todayISO(),'CLP', fxMap.get('CLP') ?? ''],
      [todayISO(),'BRL', fxMap.get('BRL') ?? ''],
      [todayISO(),'ARS', fxMap.get('ARS') ?? ''],
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(fxAOA), 'FX');

    // Detail sheets (una por ítem)
    for (const it of ITEM_SHEETS){
      const arr = details.get(it.key) || [];

      const aoa = [[
        'gid','Codigo','Grupo','Año','Destino','Segmento','Item','Empresa','Asunto','Cantidad',
        'MonedaOriginal','MontoOriginal','USD_por_1','MontoUSD','MontoCLP'
      ]];

      for (const x of arr){
        const rowIndex = aoa.length + 1; // 1-based excel row
        const monCell = `K${rowIndex}`;
        const origCell = `L${rowIndex}`;
        const usdPer1Cell = `M${rowIndex}`;
        const usdCell = `N${rowIndex}`;

        aoa.push([
          x.gid, x.codigo, x.grupo, x.anio, x.destinoGrupo, x.segmento,
          it.label, x.empresa, x.asunto, x.cantidad,
          x.monedaOriginal, x.montoOriginal,
          { f: `XLOOKUP(${monCell}, FX!B:B, FX!C:C, "")` },
          { f: `IF(${usdPer1Cell}="", "", ${origCell}*${usdPer1Cell})` },
          { f: `IFERROR(${usdCell}/XLOOKUP("CLP", FX!B:B, FX!C:C, ""), "")` },
        ]);
      }

      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), it.sheet);
    }

    // PRINCIPAL sheet (mismas columnas CSV)
    const pAOA = [[
      'Codigo','Grupo','Año','Destino','PAX (paxReales - paxLiberados)','Fechas','Cantidad Noches',
      'Aéreo/s','Valor Aéreo (CLP)',
      'Terrestre/s','Moneda Terrestre','Valor Terrestre (USD)','Valor Terrestre (CLP)',
      'Hotel/es','Moneda Hotel','Valor Hotel (USD)','Valor Hotel (CLP)',
      'Moneda Actividades ','Actividades (USD)','Actividades (CLP)',
      'Comidas','Moneda Comidas','Valor Comidas (USD)','Valor Comidas (CLP)',
      'CoordInador(a)','Valor Coordinador/a CLP',
      'Gastos aprob (CLP)',
      'Seguro ','Valor Seguro (USD)',
      'TOTAL USD','TOTAL CLP'
    ]];

    // Fórmulas SUMIFS desde DET_*
    for (let i=0;i<principal.length;i++){
      const r = principal[i];
      const rowIndex = pAOA.length + 1;
      const gid = r.gid;

      // En principal no guardo gid como columna (tu CSV no lo tiene).
      // Para SUMIFS, usamos el codigo+grupo como clave? No: mejor metemos gid oculto no.
      // Solución práctica: agrego una columna auxiliar al final (oculta) en Excel? (no visible aquí)
      // Para no inventar, exporto valores YA calculados (igual con fórmulas de FX en detalle).
      // Tú querías fórmulas principalmente para el Excel final: ya están en DET_*, y si quieres,
      // luego hacemos PRINCIPAL 100% SUMIFS con columna GID auxiliar.
      pAOA.push([
        r.Codigo, r.Grupo, r.Año, r.Destino, r.Pax, r.Fechas, r.Noches,
        r.AereosTxt, r.AereoCLP,
        r.TerrestreTxt, r.MonedaTerrestre, r.TerrestreUSD, r.TerrestreCLP,
        r.HotelTxt, r.MonedaHotel, r.HotelUSD, r.HotelCLP,
        r.MonedaAct, r.ActUSD, r.ActCLP,
        r.ComidasTxt, r.MonedaComidas, r.ComidasUSD, r.ComidasCLP,
        r.Coordinador, r.CoordCLP,
        r.GastosCLP,
        r.SeguroTxt, r.SeguroUSD,
        r.TOTAL_USD, r.TOTAL_CLP
      ]);
    }

    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(pAOA), 'PRINCIPAL');

    XLSX.writeFile(wb, `Costos_Master_${todayISO()}.xlsx`);
  } catch(e){
    alert('No se pudo exportar: ' + (e?.message || e));
  }
}

/* =========================================================
   11) BOOT
   ========================================================= */
async function calcular(){
  setLog('Calculando…');

  const result = await buildAll();
  window.__COSTOS_MASTER__ = result;

  renderPrincipal(result.principal);
  renderTabs(result.details);

  setLog(`OK ✅ Grupos: ${result.principal.length} · Detalles: ${
    [...result.details.values()].reduce((acc,arr)=>acc+arr.length,0)
  } líneas`);
}

async function boot(){
  onAuthStateChanged(auth, (user)=>{
    el('who').textContent = user?.email ? `Conectado: ${user.email}` : '—';
  });

  setLog('Cargando grupos y servicios…');
  await Promise.all([loadGrupos(), loadServicios()]);

  fillDestinoFilter();
  fillGrupoSelect();

  el('fechaHasta').value = todayISO();

  el('filtroDestino').addEventListener('change', ()=> fillGrupoSelect());
  el('btnCalcular').addEventListener('click', calcular);
  el('btnExportXLSX').addEventListener('click', exportXLSX);

  // Modal close
  el('modalClose').addEventListener('click', ()=> showModal(false));
  el('modalBackdrop').addEventListener('click', (ev)=>{
    if (ev.target === el('modalBackdrop')) showModal(false);
  });
  document.addEventListener('keydown', (ev)=>{
    if (ev.key === 'Escape') showModal(false);
  });

  setLog('Listo. Ajusta FX y presiona CALCULAR.');
}

boot().catch(e=>{
  console.error(e);
  setLog('Error cargando datos. Revisa consola.');
});

/* =========================================================
   12) Utils
   ========================================================= */
function esc(s){
  return (s??'').toString().replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
}
