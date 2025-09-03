// finanzas.js — Finanzas Operaciones RT (toolbar corregida + sorters)
// =====================================================================================
// - Equivalencias en USD/BRL/ARS/CLP (pivote CLP) con TC actuales (inputs de cabecera)
// - Modal por proveedor:
//    • Resumen por servicio (totales eq.) con "VER DETALLE"
//    • Detalle fila a fila; moneda nativa en NARANJO
//    • Sección ABONOS por servicio: responsable (email), estado (ORIGINAL/EDITADO/ARCHIVADO),
//      acciones (VER COMPROBANTE / EDITAR / ARCHIVAR), buscador, y botón VER ARCHIVADOS (toggle).
//    • Totales en negrita. SALDO POR PAGAR en rojo si ≠ 0.
//    • Exportar a EXCEL (HTML compatible con Excel).
// - Tablas con encabezados ordenables (flechas ↑/↓/↕).
// - Ruta de abonos: Servicios/{DESTINO}/Listado/{SERVICIO}/Abonos/*

// Firebase
import { app, db } from './firebase-init.js';
import {
  collection, getDocs, addDoc, updateDoc, doc, serverTimestamp, getDoc, setDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';
import {
  getAuth, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  getStorage, ref as storageRef, uploadBytes, getDownloadURL
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-storage.js';

// -------------------------------
// 0) Rutas raíz
// -------------------------------
const RUTA_SERVICIOS  = 'Servicios';
const RUTA_PROV_ROOT  = 'Proveedores';
const RUTA_HOTEL_ROOT = 'Hoteles';
const RUTA_GRUPOS     = 'grupos';

// ---- TC persistente (Firestore) ----
const RUTA_TC_DOC = ['Config','Finanzas']; // doc("Config/Finanzas")

async function cargarTCGuardado(){
  try {
    const ref = doc(db, ...RUTA_TC_DOC);
    const snap = await getDoc(ref);
    if (snap.exists()) {
      const d = snap.data() || {};
      if (el('tcUSD')) el('tcUSD').value = d.tcUSD ?? '';
      if (el('tcBRL')) el('tcBRL').value = d.tcBRL ?? '';
      if (el('tcARS')) el('tcARS').value = d.tcARS ?? '';
      if (el('tcInfo') && d.fechaGuardado) {
        const f = (d.fechaGuardado || '').toString();
        const nice = f.slice(0,16).replace('T',' ');
        el('tcInfo').textContent = `Tipo de cambio – unidades por 1 USD (guardado el ${nice})`;
      }
    }
  } catch(e){ console.warn('No se pudo cargar TC guardado', e); }
}

async function guardarTCGuardado(){
  const data = {
    tcUSD: Number(el('tcUSD')?.value || 0) || null,
    tcBRL: Number(el('tcBRL')?.value || 0) || null,
    tcARS: Number(el('tcARS')?.value || 0) || null,
    fechaGuardado: new Date().toISOString(),
    usuario: (auth.currentUser?.email || '').toLowerCase()
  };
  await setDoc(doc(db, ...RUTA_TC_DOC), data, { merge:true });

  if (el('tcInfo')) {
    const nice = data.fechaGuardado.slice(0,16).replace('T',' ');
    el('tcInfo').textContent = `Tipo de cambio – unidades por 1 USD (guardado el ${nice})`;
  }
  // Opcional: recalcular inmediatamente con el TC guardado
  recalcular();
}


// -------------------------------
// 1) Estado + helpers
// -------------------------------
const auth = getAuth(app);
const storage = getStorage(app);

let GRUPOS = [];
let SERVICIOS = [];
let PROVEEDORES = {};
let HOTELES = [];
let ASIGNACIONES = [];

let LINE_ITEMS = [];
let LINE_HOTEL = [];

const el    = id => document.getElementById(id);
const $     = (sel, root=document) => root.querySelector(sel);
const $$    = (sel, root=document) => [...root.querySelectorAll(sel)];
const fmt   = n => (n ?? 0).toLocaleString('es-CL');
const money = n => '$' + fmt(Math.round(n || 0));
const slug  = s => (s || '').toString().normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase().trim().replace(/[^a-z0-9]+/g,'-');
const norm  = s => (s || '').toString().normalize('NFD').replace(/\p{Diacritic}/gu,'').toUpperCase().trim();
// === Estilos del modal (inyectados 1 sola vez) ===
(function ensureFinModalStyles(){
  if (document.getElementById('finModalStyles')) return;
  const css = `
    /* Botón Excel verde */
    #btnExportXLS.btn-excel{ background:#217346 !important; color:#fff !important; border-color:#1e5e38 !important; }
    #btnExportXLS.btn-excel:hover{ filter:brightness(0.93); }

    /* Colorear SALDO (rojo si >0, verde si <=0) y ABONO (azul) */
    .saldo-neg{ color:#b91c1c !important; font-weight:600; }   /* rojo */
    .saldo-ok { color:#166534 !important; font-weight:600; }   /* verde */
    .abono-cell{ color:#1d4ed8 !important; font-weight:600; }  /* azul */

    /* Fila de SUBTOTAL PAGO RESERVADO en naranjo claro */
    #tblDetalleProv tfoot tr.row-subtotal-reservado{ background:#fff7ed; }            /* naranja muy claro */
    #tblDetalleProv tfoot tr.row-subtotal-reservado th,
    #tblDetalleProv tfoot tr.row-subtotal-reservado td{ border-top:2px solid #fdba74; }

    /* Botón HIZO + correo responsable al lado */
    .hizo-wrap{ display:flex; gap:.5rem; align-items:center; }
    .hizo-wrap .resp-email{ font-size:.85em; color:#6b7280; }
  `;
  const style = document.createElement('style');
  style.id = 'finModalStyles';
  style.textContent = css;
  document.head.appendChild(style);
})();

// --- Realizaciones (overlay de "hizo" por item) ---
const RUTA_REALIZACIONES = 'FinanzasRealizaciones';
const REALIZACIONES = new Map();       // key -> boolean (true=Sí, false=No)
const REALIZACIONES_INFO = new Map();  // key -> { email, updatedAt }

const keyRealiza = (grupoId, fechaISO, servicioId) =>
  `${grupoId||''}|${fechaISO||''}|${servicioId||''}`;

// ===== Filtro de destinos y reglas de monedas =====
function getDestinoFilter(){
  const sel = el('filtroDestino');
  const vals = [...sel.selectedOptions].map(o => o.value);
  const all  = vals.includes('*');
  const tokens = new Set(vals.filter(v => v !== '*'));
  return { all, tokens };
}

// inclusión según modo
function includeBy(mode, tokens, destino){
  if (mode === 'ALL') return true;
  if (!destino) return false;
  if (!tokens || tokens.size === 0) return true;
  const D = norm(destino);
  if (mode === 'EXACT') return tokens.has(destino);
  if (mode === 'TOKEN') {
    for (const t of tokens) if (D.includes(norm(t))) return true;
    return false;
  }
  return true;
}

// Compatibilidad: Set | Function
function includeDestinoCheck(destinosSel, destinoGrupo){
  if (typeof destinosSel === 'function') return !!destinosSel(destinoGrupo);
  if (destinosSel && destinosSel.size)   return destinosSel.has(destinoGrupo);
  return true; // sin filtro
}

// Reglas de monedas visibles por destino
const DESTINO_MONEDAS = {
  'BARILOCHE': new Set(['USD','ARS']),
  'SUR DE CHILE': new Set(['CLP']),
  'NORTE DE CHILE': new Set(['CLP']),
  'SUR DE CHILE Y BARILOCHE': new Set(['CLP','USD','ARS']),
  'BRASIL': new Set(['USD','BRL']),
  'DEFAULT': new Set(['USD','CLP']),
};
const TODAS_MONEDAS = ['CLP','USD','BRL','ARS'];

function monedasVisiblesFromFilter(filtro){
  if (filtro.all || filtro.tokens.size === 0) return TODAS_MONEDAS;
  const uni = new Set();
  for (const tok of filtro.tokens){
    const set = DESTINO_MONEDAS[tok] || DESTINO_MONEDAS.DEFAULT;
    set.forEach(m => uni.add(m));
  }
  return TODAS_MONEDAS.filter(m => uni.has(m));
}


// ---------- parsers + sort ----------
function parseNumber(val){
  if (typeof val === 'number') return val;
  const s = (val ?? '').toString().trim();
  if (!s) return 0;
  const clean = s.replace(/[^\d,.\-]/g,'').replace(/\.(?=\d{3}(?:\D|$))/g,'').replace(',', '.');
  const n = Number(clean);
  return isNaN(n) ? 0 : n;
}
function parseDate(val){
  const s = (val ?? '').toString().trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s+'T00:00:00').getTime();
  const t = Date.parse(s);
  return isNaN(t) ? 0 : t;
}
// === Fecha corta ES (DD-mes 3 letras) ===
const MESES_CORTO_ES = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
function fechaCortaEs(iso) {
  if (!iso) return '';
  // admitimos "YYYY-MM-DD" o Date parseable
  let y=0, m=0, d=0;
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    y = Number(iso.slice(0,4)); m = Number(iso.slice(5,7)); d = Number(iso.slice(8,10));
  } else {
    const t = new Date(iso);
    if (isNaN(t.getTime())) return '';
    y = t.getFullYear(); m = t.getMonth()+1; d = t.getDate();
  }
  const dd = String(d).padStart(2,'0');
  const mes = MESES_CORTO_ES[(m-1+12)%12];
  return `${dd}-${mes}`;
}
function makeSortable(table, colTypes=[], options={}){
  if (!table) return;
  const thead = table.tHead; if (!thead) return;
  const ths = [...thead.rows[0].cells];
  const skip = new Set(options.skipIdx || []);
  function setArrow(idx, dir){
    ths.forEach((th,i)=>{
      const span = th.querySelector('.sort-arrow') || th.appendChild(Object.assign(document.createElement('span'), {className:'sort-arrow'}));
      if (i!==idx) { span.textContent = ' ↕'; return; }
      span.textContent = dir>0 ? ' ↑' : ' ↓';
    });
  }
  function cellValue(tr, idx, type){
    const txt = tr.cells[idx]?.textContent ?? '';
    switch((type||'text')){
      case 'num': case 'money': return parseNumber(txt);
      case 'date': return parseDate(txt);
      default: return (txt||'').toString().toLowerCase();
    }
  }
  ths.forEach((th, idx)=>{
    if (skip.has(idx)) return;
    th.style.cursor = 'pointer';
    if (!th.querySelector('.sort-arrow')) {
      const span = document.createElement('span');
      span.className = 'sort-arrow'; span.textContent = ' ↕';
      th.appendChild(span);
    }
    let dir = 0;
    th.addEventListener('click', ()=>{
      dir = dir===1 ? -1 : 1;
      const type = colTypes[idx] || 'text';
      const tbody = table.tBodies[0];
      const rows = Array.from(tbody.rows);
      rows.sort((a,b)=>{
        const va = cellValue(a, idx, type);
        const vb = cellValue(b, idx, type);
        if (va < vb) return -1*dir;
        if (va > vb) return  1*dir;
        return 0;
      });
      rows.forEach(r => tbody.appendChild(r));
      setArrow(idx, dir);
    });
  });
}

// === ESTILOS ADICIONALES PARA EL MODAL (una sola vez) ===
function ensureFinanceStyles() {
  if (document.getElementById('finanzas-extra-styles')) return;
  const css = `
    /* Botón Excel en verde */
    #btnExportXLS, .btn-excel { background:#1db954 !important; color:#fff !important; }

    /* Abonos (azul) */
    .abono-amount, #tblAbonos tbody td:nth-child(5) { color:#1976d2; font-weight:600; }

    /* Saldos (rojo si >0, verde si <=0) */
    .saldo-rojo { color:#b00020 !important; font-weight:700; }
    .saldo-ok   { color:#2e7d32 !important; font-weight:700; }

    /* Subtotal pago reservado (naranjo) */
    #tblDetalleProv tfoot tr.row-subtotal-naranja th,
    #tblDetalleProv tfoot tr.row-subtotal-naranja td {
      background:#ffedd5; color:#b45309;
    }

    /* HIZO: botón + email al lado */
    .hizo-wrap{ display:flex; align-items:center; gap:.5rem; }
    .hizo-wrap .hizo-email{ font-size:.85em; color:#555; }
  `;
  const st = document.createElement('style');
  st.id = 'finanzas-extra-styles';
  st.textContent = css;
  document.head.appendChild(st);
}

// -------------------------------
// Moneda nativa → estándar
// -------------------------------
function normalizarMoneda(m){
  const M = (m||'').toString().toUpperCase().trim();
  if (['REAL','REALES','R$','BRL'].includes(M)) return 'BRL';
  if (['ARS','AR$','ARG','PESO ARGENTINO','PESOS ARGENTINOS','ARGENTINOS','ARGENTINO'].includes(M)) return 'ARS';
  if (['USD','US$','DOLAR','DÓLAR','DOLLAR'].includes(M)) return 'USD';
  return 'CLP';
}
function parsePagoTipo(raw){
  const s = (raw||'').toString().normalize('NFD').replace(/\p{Diacritic}/gu,'').toUpperCase();
  if (/(PAX|PERSONA)/.test(s)) return 'por_pax';
  if (/(DIA|POR DIA)/.test(s)) return 'por_dia';
  if (/OTRO|OTHER/.test(s))     return 'otro';
  return 'por_grupo';
}
function paxDeGrupo(g) {
  const a = Number(g.adultos || g.ADULTOS || 0);
  const e = Number(g.estudiantes || g.ESTUDIANTES || 0);
  const cg = Number(g.cantidadgrupo || g.CANTIDADGRUPO || g.pax || g.PAX || 0);
  return (a + e) || cg || 0;
}
function within(dateISO, d1, d2) {
  if (!dateISO) return false;
  const t  = new Date(dateISO + 'T00:00:00').getTime();
  const t1 = d1 ? new Date(d1 + 'T00:00:00').getTime() : -Infinity;
  const t2 = d2 ? new Date(d2 + 'T00:00:00').getTime() : Infinity;
  return t >= t1 && t <= t2;
}

// TC actuales (desde inputs)
function pickTC(moneda) {
  const m = normalizarMoneda(moneda);
  const clpPerUSD = Number(el('tcUSD')?.value || 0) || null; // CLP / USD
  const brlPerUSD = Number(el('tcBRL')?.value || 0) || null; // BRL / USD
  const arsPerUSD = Number(el('tcARS')?.value || 0) || null; // ARS / USD

  if (m === 'USD') return 1;
  if (m === 'CLP') return clpPerUSD;
  if (m === 'BRL') return brlPerUSD;
  if (m === 'ARS') return arsPerUSD;
  return null;
}

// Convierte monto desde su moneda origen a {USD, BRL, ARS, CLP} usando USD como pivote
function convertirTodas(monedaOrigen, monto) {
  const from = normalizarMoneda(monedaOrigen);
  const rFrom = pickTC(from);           // unidades FROM por 1 USD (excepto USD=1)
  const rCLP  = pickTC('CLP');
  const rBRL  = pickTC('BRL');
  const rARS  = pickTC('ARS');

  // Paso 1: llevar a USD
  let usdVal = null;
  if (from === 'USD') {
    usdVal = (typeof monto === 'number') ? monto : Number(monto || 0);
  } else if (rFrom) {
    usdVal = (monto || 0) / rFrom;      // (unidades FROM) / (FROM por USD) = USD
  }

  // Paso 2: desde USD a cada moneda
  const to = { USD: usdVal, BRL: null, ARS: null, CLP: null };
  const scale = (rate) => (usdVal != null && rate) ? (usdVal * rate) : null;

  to.BRL = scale(rBRL);
  to.ARS = scale(rARS);
  to.CLP = scale(rCLP);

  return to;
}

// === Moneda nativa del proveedor (asumo 1 sola; si hay mixtas, marco mixed) ===
function getMonedaProveedor(items){
  const set = new Set(items.map(i => normalizarMoneda(i.moneda || 'CLP')));
  const all = [...set];
  return { code: all[0] || 'CLP', mixed: all.length > 1, all };
}

// === Pedir clave para acciones sensibles ===
function pedirClaveDialog(cont){
  return new Promise((resolve)=>{
    const box = $('#claveDialog', cont);
    const pw  = $('#pwField', box);
    const tog = $('#pwToggle', box);
    const ok  = $('#pwOk', box);
    const cc  = $('#pwCancel', box);
    box.hidden = false;
    pw.value = '';
    pw.type = 'password';
    tog.setAttribute('aria-pressed','false');

    function close(v){ box.hidden = true; resolve(v); }
    tog.onclick = () => {
      const pressed = tog.getAttribute('aria-pressed') === 'true';
      tog.setAttribute('aria-pressed', pressed ? 'false' : 'true');
      pw.type = pressed ? 'password' : 'text';
    };
    ok.onclick = () => close( (pw.value || '').trim().toLowerCase() === 'nena' );
    cc.onclick = () => close(false);
  });
}


// === Pairs destino/servicio con MONEDA ===
function buildSvcPairs(items){
  const map = new Map();
  for (const it of items){
    if (!it.servicioId || !it.destinoGrupo) continue;
    const key = `${it.destinoGrupo}||${it.servicioId}`;
    if (!map.has(key)){
      map.set(key, {
        destinoId: it.destinoGrupo,
        servicioId: it.servicioId,
        servicioNombre: it.servicio || '',
        moneda: normalizarMoneda(it.moneda || 'CLP'),
      });
    }
  }
  return [...map.values()];
}

// -------------------------------
// 2) Carga de datos
// -------------------------------
async function loadServicios() {
  const rootSnap = await getDocs(collection(db, RUTA_SERVICIOS));
  const promSub = [];
  for (const docTop of rootSnap.docs) {
    const destinoId = docTop.id;
    promSub.push(
      getDocs(collection(docTop.ref, 'Listado'))
        .then(snap => snap.docs.map(d => {
          const data = d.data() || {};
          return { id: d.id, destino: destinoId, servicio: data.servicio || d.id, ...data };
        }))
        .catch(() => [])
    );
  }
  const arrays = await Promise.all(promSub);
  SERVICIOS = arrays.flat();
}
async function loadProveedores() {
  PROVEEDORES = {};
  try {
    const rootSnap = await getDocs(collection(db, RUTA_PROV_ROOT));
    const promSub = [];
    for (const docTop of rootSnap.docs) {
      promSub.push(
        getDocs(collection(docTop.ref, 'Listado'))
          .then(snap => snap.docs.map(d => ({ id:d.id, ...d.data() })))
          .catch(() => [])
      );
    }
    const arrays = await Promise.all(promSub);
    arrays.flat().forEach(d => {
      const key = slug(d.proveedor || d.nombre || d.id);
      PROVEEDORES[key] = { ...d };
    });
  } catch (e) {
    console.warn('Proveedores no disponibles:', e);
  }
}
async function loadGrupos() {
  const snap = await getDocs(collection(db, RUTA_GRUPOS));
  GRUPOS = snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
async function loadHotelesYAsignaciones() {
  HOTELES = []; ASIGNACIONES = [];
  try {
    const rootSnap = await getDocs(collection(db, RUTA_HOTEL_ROOT));
    const promListado = [], promAsign = [];
    for (const docTop of rootSnap.docs) {
      const destinoId = docTop.id;
      promListado.push(
        getDocs(collection(docTop.ref, 'Listado'))
          .then(snap => snap.docs.map(d => ({ id:d.id, destino:destinoId, ...d.data() })))
          .catch(() => [])
      );
      promAsign.push(
        getDocs(collection(docTop.ref, 'Asignaciones'))
          .then(snap => snap.docs.map(d => ({ id:d.id, destino:destinoId, ...d.data() })))
          .catch(() => [])
      );
    }
    const [arrH, arrA] = await Promise.all([Promise.all(promListado), Promise.all(promAsign)]);
    HOTELES = arrH.flat();
    ASIGNACIONES = arrA.flat();
  } catch (e) {
    console.warn('Hoteles/Asignaciones no disponibles:', e);
  }
}

// -------------------------------
// 3) Resolver Servicio
// -------------------------------
function resolverServicio(itemActividad, destinoGrupo) {
  const act    = norm(itemActividad?.actividad || itemActividad?.servicio || '');
  const dest   = norm(destinoGrupo || '');
  const provIt = norm(itemActividad?.proveedor || '');
  let cand = SERVICIOS.filter(s =>
    norm(s.servicio) === act &&
    norm(s.destino || s.DESTINO || s.ciudad || s.CIUDAD) === dest
  );
  if (cand.length === 0) cand = SERVICIOS.filter(s => norm(s.servicio) === act);
  if (cand.length > 1 && provIt) {
    const afin = cand.filter(s => norm(s.proveedor) === provIt);
    if (afin.length) cand = afin;
  }
  return cand[0] || null;
}

// -------------------------------
// 4) Construcción de line items
// -------------------------------
function construirLineItems(fechaDesde, fechaHasta, destinosSel, incluirActividades) {
  const out = [];
  if (!incluirActividades) return out;

  // Set local por llamada (evita subcuentas entre recalculados)
  const seenDia = new Set();

  for (const g of GRUPOS) {
    const destinoGrupo = g.destino || g.DESTINO || g.ciudad || '';
    if (!includeDestinoCheck(destinosSel, destinoGrupo)) continue;

    const pax = paxDeGrupo(g);
    const it  = g.itinerario || {};

    for (const fechaISO of Object.keys(it)) {
      if (!within(fechaISO, fechaDesde, fechaHasta)) continue;
      const arr = Array.isArray(it[fechaISO]) ? it[fechaISO] : [];

      for (const item of arr) {
        const svc = resolverServicio(item, destinoGrupo);

        // Overlay de realizaciones: si está “No”, se excluye
        const svcIdOverlay = (svc && svc.id) ? svc.id : null;
        const kOverlay = keyRealiza(g.id, fechaISO, svcIdOverlay);
        if (svcIdOverlay && REALIZACIONES.has(kOverlay) && REALIZACIONES.get(kOverlay) === false) {
          continue;
        }

        if (!svc) {
          out.push({
            tipo:'actividad',
            proveedor: item.proveedor || '(desconocido)',
            proveedorSlug: slug(item.proveedor || '(desconocido)'),
            servicio: item.actividad || item.servicio || '(sin nombre)',
            servicioId: null,
            destinoGrupo, fecha: fechaISO,
            programa: g.programa || g.PROGRAMA || '',
            paxReal: Number(g.paxFinal || g.PAXFINAL || 0),
            realizada: (typeof item.realizado === 'boolean') ? !!item.realizado : (Number(g.paxFinal || 0) > 0),
            grupoId: g.id, nombreGrupo: g.nombreGrupo || g.NOMBRE || '',
            numeroNegocio: g.numeroNegocio || g.id,
            identificador: g.identificador || g.IDENTIFICADOR || '',
            pax, moneda:'CLP', tarifa:0,
            pagoTipo:'por_grupo', pagoFrecuencia:'unitario',
            totalMoneda:0,
          });
          continue;
        }

        const proveedor   = svc.proveedor || '(sin proveedor)';
        const moneda      = normalizarMoneda(svc.moneda || svc.MONEDA || 'CLP');
        const tipoCobroRaw= (svc.tipoCobro || svc.tipo_cobro || '').toString();
        const pagoTipo    = parsePagoTipo(tipoCobroRaw);
        const valor       = Number(svc.valorServicio ?? svc.valor_servicio ?? svc.valor ?? svc.precio ?? 0);

        let totalMoneda = 0;
        let diaKey = null, diaOwner = 0;

        if (pagoTipo === 'por_dia') {
          // 1 cargo por (fecha + destino + servicio)
          diaKey = `${fechaISO}||${destinoGrupo}||${svc.id}`;
          if (!seenDia.has(diaKey)) {
            seenDia.add(diaKey);
            totalMoneda = valor;  // cobra 1 vez ese día
            diaOwner = 1;         // esta fila “posee” el cobro del día
          } else {
            totalMoneda = 0;      // filas extra del mismo día no suman
          }
        } else if (pagoTipo === 'por_pax') {
          totalMoneda = valor * pax;
        } else if (pagoTipo === 'por_grupo') {
          totalMoneda = valor;
        } else { // 'otro'
          totalMoneda = 0;        // no suma hasta definir regla
        }

        out.push({
          tipo:'actividad',
          proveedor, proveedorSlug: slug(proveedor),
          servicio: svc.servicio || item.actividad || '(sin nombre)',
          servicioId: svc.id,
          destinoGrupo, fecha: fechaISO,
          programa: g.programa || g.PROGRAMA || '',
          paxReal: Number(g.paxFinal || g.PAXFINAL || 0),
          realizada: (typeof item.realizado === 'boolean') ? !!item.realizado : (Number(g.paxFinal || 0) > 0),
          grupoId: g.id, nombreGrupo: g.nombreGrupo || g.NOMBRE || '',
          numeroNegocio: g.numeroNegocio || g.id,
          identificador: g.identificador || g.IDENTIFICADOR || '',
          pax, moneda, tarifa: valor,
          pagoTipo,
          pagoFrecuencia:'unitario',
          totalMoneda,
          diaKey, diaOwner
        });
      }
    }
  }
  return out;
}

function construirLineItemsHotel(fechaDesde, fechaHasta, destinosSel, incluirHoteles) {
  const out = [];
  if (!incluirHoteles || !ASIGNACIONES.length) return out;

  const mapHotel = {}; for (const h of HOTELES) mapHotel[h.id] = h;

  for (const asg of ASIGNACIONES) {
    const g = GRUPOS.find(x => x.id === (asg.grupoId || asg.idGrupo));
    if (!g) continue;

    const destinoGrupo = g.destino || asg.destino || '';
    if (!includeDestinoCheck(destinosSel, destinoGrupo)) continue;

    const start = asg.fechaInicio, end = asg.fechaFin;
    if (!start || !end) continue;

    const nights = [];
    let cur = new Date(start + 'T00:00:00');
    const fin = new Date(end + 'T00:00:00');
    while (cur < fin) {
      const iso = cur.toISOString().slice(0,10);
      if (within(iso, fechaDesde, fechaHasta)) nights.push(iso);
      cur.setDate(cur.getDate()+1);
    }

    const hotel = mapHotel[asg.hotelId] || {};
    const hotelNombre = hotel.nombre || asg.hotelNombre || '(hotel)';

    const pax       = paxDeGrupo(g);
    const moneda    = normalizarMoneda(asg.moneda || hotel.moneda || 'CLP');
    const tarifa    = Number(asg.tarifa || hotel.tarifa || 0);
    const tipoCobro = (asg.tipoCobro || hotel.tipoCobro || 'por_pax_noche').toLowerCase();

    let totalPorNoche = 0;
    if (tipoCobro === 'por_pax_noche') totalPorNoche = tarifa * pax;
    else if (tipoCobro === 'por_grupo_noche') totalPorNoche = tarifa;
    else if (tipoCobro === 'por_hab_noche') totalPorNoche = tarifa;

    const totalMoneda = totalPorNoche * nights.length;

    out.push({
      tipo:'hotel',
      hotel:hotelNombre, destinoGrupo,
      grupoId:g.id, nombreGrupo:g.nombreGrupo || '',
      numeroNegocio:g.numeroNegocio || g.id,
      identificador:g.identificador || g.IDENTIFICADOR || '',
      noches:nights.length,
      moneda, tarifa, tipoCobro,
      totalMoneda,
    });
  }
  return out;
}

// -------------------------------
// 5) Agregaciones
// -------------------------------
function agruparPorDestino(items) {
  const r = new Map();
  for (const it of items) {
    const key = it.destinoGrupo || it.destino || '(sin destino)';
    const acc = r.get(key) || { clpEq:0, usdEq:0, brlEq:0, arsEq:0, count:0 };
    const conv = convertirTodas(it.moneda, it.totalMoneda);
    if (conv.CLP != null) acc.clpEq += conv.CLP;
    if (conv.USD != null) acc.usdEq += conv.USD;
    if (conv.BRL != null) acc.brlEq += conv.BRL;
    if (conv.ARS != null) acc.arsEq += conv.ARS;
    acc.count++;
    r.set(key, acc);
  }
  return r;
}
function agruparPorProveedor(items) {
  const r = new Map();
  for (const it of items) {
    const slugProv = it.proveedorSlug || slug(it.proveedor || '(sin proveedor)');
    const nombre   = it.proveedor || '(sin proveedor)';
    const acc = r.get(slugProv) || { nombre, destinos:new Set(), clpEq:0, usdEq:0, brlEq:0, arsEq:0, count:0, items:[] };
    acc.destinos.add(it.destinoGrupo || '(sin destino)');
    const conv = convertirTodas(it.moneda, it.totalMoneda);
    if (conv.CLP != null) acc.clpEq += conv.CLP;
    if (conv.USD != null) acc.usdEq += conv.USD;
    if (conv.BRL != null) acc.brlEq += conv.BRL;
    if (conv.ARS != null) acc.arsEq += conv.ARS;
    acc.count++;
    acc.items.push(it);
    r.set(slugProv, acc);
  }
  return r;
}
// ===== Proveedores por MONEDA NATIVA =====
function agruparPorProveedorMonedaNativa(items){
  const r = new Map();
  for (const it of items){
    const slugProv = it.proveedorSlug || slug(it.proveedor || '(sin proveedor)');
    const nombre   = it.proveedor || '(sin proveedor)';
    const m = normalizarMoneda(it.moneda || 'CLP');
    const acc = r.get(slugProv) || {
      nombre,
      destinos: new Set(),
      totals: { CLP:0, USD:0, BRL:0, ARS:0 },
      count: 0,
      items: []
    };
    acc.destinos.add(it.destinoGrupo || '(sin destino)');
    acc.totals[m] = (acc.totals[m] || 0) + (it.totalMoneda || 0); // suma nativa
    acc.count++;
    acc.items.push(it);
    r.set(slugProv, acc);
  }
  return r;
}

function renderTablaProveedoresMonedaNativa(mapProv, visibleCurrencies){
  const tbl = el('tblProveedores');
  const thead = tbl.querySelector('thead');
  const tb = tbl.querySelector('tbody');
  tb.innerHTML = '';

  // Encabezado dinámico
  const cols = [];
  visibleCurrencies.forEach(m => {
    cols.push({ key:`T_${m}`, label:`${m} TOTAL` });
    cols.push({ key:`A_${m}`, label:`${m} ABONO` });
    cols.push({ key:`S_${m}`, label:`${m} SALDO` });
  });
  thead.innerHTML = `
    <tr>
      <th class="col-prov">Proveedor</th>
      <th class="col-dest">Destino(s)</th>
      ${
        cols.map(c => {
          const [kind, cur] = c.key.split('_');             // p.ej. "T_CLP"
          const tipo = kind === 'T' ? 'total' : kind === 'A' ? 'abono' : 'saldo';
          const m = cur.toLowerCase();                      // clp | usd | brl | ars
          return `<th class="right col-${m} ${tipo}">${c.label}</th>`;
        }).join('')
      }
      <th class="right col-items"># ítems</th>
      <th class="col-act"></th>
    </tr>`;

  // Filas
  const rows = [];
  mapProv.forEach((v, key) => rows.push({
    slug: key,
    nombre: v.nombre,
    destinos: [...v.destinos].join(', '),
    totals: v.totals,
    count: v.count,
    items: v.items
  }));
  rows.sort((a,b)=>{
    const sa = (a.totals.CLP||0)+(a.totals.USD||0)+(a.totals.BRL||0)+(a.totals.ARS||0);
    const sb = (b.totals.CLP||0)+(b.totals.USD||0)+(b.totals.BRL||0)+(b.totals.ARS||0);
    return sb - sa;
  });

  // Subtotales (pie)
  const subtotales = { T:{}, A:{}, S:{} };
  visibleCurrencies.forEach(m => { subtotales.T[m]=0; subtotales.A[m]=0; subtotales.S[m]=0; });

  for (const r of rows){
    const tr = document.createElement('tr');
    tr.setAttribute('data-prov', r.slug);

    let moneyTds = '';
    for (const c of cols){
      const [kind, cur] = c.key.split('_');                 // T|A|S + moneda
      const tipo = kind === 'T' ? 'total' : kind === 'A' ? 'abono' : 'saldo';
      const m = cur.toLowerCase();
    
      if (kind === 'T'){                                     // TOTAL (nativa)
        const val = r.totals[cur] || 0;
        moneyTds += `<td class="right col-${m} ${tipo}" data-key="${c.key}" data-raw="${val||0}">
                       ${val ? fmt(val) : '—'}
                     </td>`;
      } else {                                               // ABONO y SALDO (se completan luego)
        moneyTds += `<td class="right col-${m} ${tipo}" data-key="${c.key}" data-raw="0">—</td>`;
      }
    }

    tr.innerHTML = `
      <td class="col-prov"  title="${r.nombre}">${r.nombre}</td>
      <td class="col-dest"  title="${r.destinos}">${r.destinos}</td>
      ${moneyTds}
      <td class="right col-items">${fmt(r.count)}</td>
      <td class="right col-act"><button class="btn secondary" data-prov="${r.slug}">VER DETALLE</button></td>
    `;
    tb.appendChild(tr);
  }

  // botones detalle
  tb.querySelectorAll('button[data-prov]').forEach(btn => {
    btn.addEventListener('click', () => {
      const slugProv = btn.getAttribute('data-prov');
      openModalProveedor(slugProv, mapProv.get(slugProv));
    });
  });

  // sorters (saltando columna de acciones)
  const colTypes = ['text','text', ...cols.map(()=> 'num'), 'num', 'text'];
  const actionIdx = 2 + cols.length + 1; // última columna
  makeSortable(tbl, colTypes, { skipIdx:[actionIdx] });

  // Completar ABONOS y SALDOS por moneda y pie de subtotales
  completarAbonosEnTablaProveedoresMonedas(mapProv, visibleCurrencies).then(result => {
    const tbody = tbl.querySelector('tbody');
    for (const [slugProv, agg] of Object.entries(result.porProv)){
      const tr = tbody.querySelector(`tr[data-prov="${slugProv}"]`);
      if (!tr) continue;
      let ci = 2; // empieza en la primera monetaria
      for (const m of visibleCurrencies){
        // T está en ci; A en ci+1; S en ci+2
        const tdA = tr.children[ci+1];
        const tdS = tr.children[ci+2];
        tdA.textContent = agg.A[m] ? fmt(agg.A[m]) : '—';
        tdA.dataset.raw = String(agg.A[m] || 0);
        tdS.textContent = agg.S[m] ? fmt(agg.S[m]) : '—';
        tdS.dataset.raw = String(agg.S[m] || 0);
        ci += 3;
      }
    }

    const tfoot = tbl.querySelector('tfoot') || tbl.createTFoot();
    tfoot.innerHTML = `
      <tr class="bold">
        <th colspan="2" class="right">SUBTOTALES</th>
        ${visibleCurrencies.map(m => {
          const mm = m.toLowerCase();
          return `
            <th class="right col-${mm} total">${result.subtotales.T[m] ? fmt(result.subtotales.T[m]) : '—'}</th>
            <th class="right col-${mm} abono">${result.subtotales.A[m] ? fmt(result.subtotales.A[m]) : '—'}</th>
            <th class="right col-${mm} saldo">${result.subtotales.S[m] ? fmt(result.subtotales.S[m]) : '—'}</th>
          `;
        }).join('')}
        <th colspan="2"></th>
      </tr>`;
  });
}

async function completarAbonosEnTablaProveedoresMonedas(mapProv, visibleCurrencies){
  const porProv = {};
  const subtotales = { T:{}, A:{}, S:{} };
  visibleCurrencies.forEach(m => { subtotales.T[m]=0; subtotales.A[m]=0; subtotales.S[m]=0; });

  for (const [slugProv, provData] of mapProv.entries()) {
    const pares = serviciosUnicosDeProveedor(provData.items);
    const lotes = await loadAbonosLote(pares);

    const A = { CLP:0, USD:0, BRL:0, ARS:0 };
    const T = provData.totals;
    const S = { CLP:T.CLP||0, USD:T.USD||0, BRL:T.BRL||0, ARS:T.ARS||0 };

    for (const lote of lotes) {
      for (const ab of (lote.abonos || [])) {
        if (!abonoIncluido(ab)) continue;
        const m = normalizarMoneda(ab.moneda || 'CLP');
        const v = Number(ab.monto || 0);
        A[m] += v;
      }
    }
    for (const m of TODAS_MONEDAS) S[m] = (T[m]||0) - (A[m]||0);

    for (const m of visibleCurrencies){
      subtotales.T[m] += (T[m]||0);
      subtotales.A[m] += (A[m]||0);
      subtotales.S[m] += (S[m]||0);
    }

    porProv[slugProv] = { A, S };
  }
  return { porProv, subtotales };
}
function agruparPorHotel(itemsHotel) {
  const r = new Map();
  for (const it of itemsHotel) {
    const key = it.hotel || '(hotel)';
    const acc = r.get(key) || { destino: it.destinoGrupo || '(sin destino)', clpEq:0, usdEq:0, brlEq:0, arsEq:0, noches:0 };
    const conv = convertirTodas(it.moneda, it.totalMoneda);
    if (conv.CLP != null) acc.clpEq += conv.CLP;
    if (conv.USD != null) acc.usdEq += conv.USD;
    if (conv.BRL != null) acc.brlEq += conv.BRL;
    if (conv.ARS != null) acc.arsEq += conv.ARS;
    acc.noches += (it.noches || 0);
    r.set(key, acc);
  }
  return r;
}

// -------------------------------
// 6) Render KPIs + tablas
// -------------------------------
function renderKPIs(items, itemsHotel) {
  const all = [...items, ...itemsHotel];
  let totCLP = 0, missUSD = 0, missBRL = 0, missARS = 0;
  for (const it of all){
    const c = convertirTodas(it.moneda, it.totalMoneda);
    if (c.CLP != null) totCLP += c.CLP;
    if (c.USD == null) missUSD += (it.totalMoneda || 0);
    if (c.BRL == null) missBRL += (it.totalMoneda || 0);
    if (c.ARS == null) missARS += (it.totalMoneda || 0);
  }
  el('kpiTotCLP').textContent = money(totCLP);
  el('kpiOtrosMon').textContent = `USD no conv.: ${fmt(missUSD)} — BRL no conv.: ${fmt(missBRL)} — ARS no conv.: ${fmt(missARS)}`;

  const provSet = new Set(items.filter(x => x.tipo==='actividad').map(x => x.proveedorSlug));
  el('kpiProv').textContent = provSet.size;

  const destSet = new Set(items.map(x => x.destinoGrupo).filter(Boolean));
  el('kpiDest').textContent = destSet.size;
}
function renderTablaDestinos(mapDest) {
  const tb = el('tblDestinos').querySelector('tbody');
  tb.innerHTML = '';
  const rows = [];
  mapDest.forEach((v, k) => rows.push({
    destino:k,
    clpEq:v.clpEq||0, usdEq:v.usdEq||0, brlEq:v.brlEq||0, arsEq:v.arsEq||0,
    count:v.count||0
  }));
  rows.sort((a,b)=>b.clpEq - a.clpEq);
  for (const r of rows) {
    tb.insertAdjacentHTML('beforeend', `
      <tr>
        <td title="${r.destino}">${r.destino || '(sin destino)'}</td>
        <td class="right" title="${r.clpEq}">${money(r.clpEq)}</td>
        <td class="right" title="${r.usdEq}">${fmt(r.usdEq)}</td>
        <td class="right" title="${r.brlEq}">${fmt(r.brlEq)}</td>
        <td class="right" title="${r.arsEq}">${fmt(r.arsEq)}</td>
        <td class="right" title="${r.count}">${fmt(r.count)}</td>
      </tr>
    `);
  }
  makeSortable(el('tblDestinos'), ['text','money','num','num','num','num']);
}
function renderTablaProveedores(mapProv) {
  const tbl = el('tblProveedores');
  const thead = tbl.querySelector('thead');
  const tb = tbl.querySelector('tbody');
  tb.innerHTML = '';

  // ——— Encabezado con clases por banda/moneda
  if (thead) {
    thead.innerHTML = `
      <tr>
        <th class="col-prov">Proveedor</th>
        <th class="col-dest">Destino(s)</th>

        <th class="right col-clp total">CLP TOTAL</th>
        <th class="right col-usd total">USD TOTAL</th>

        <th class="right col-clp abono">CLP ABONO</th>
        <th class="right col-usd abono">USD ABONO</th>

        <th class="right col-clp saldo">CLP SALDO</th>
        <th class="right col-usd saldo">USD SALDO</th>

        <th class="right col-items"># items</th>
        <th class="col-act"></th>
      </tr>`;
  }

  // ——— Filas base (totales por proveedor)
  const rows = [];
  mapProv.forEach((v, key) => rows.push({
    slug: key,
    nombre: v.nombre,
    destinos: [...v.destinos].join(', '),
    totalCLP: v.clpEq || 0,
    totalUSD: v.usdEq || 0,
    count: v.count || 0,
    items: v.items
  }));
  rows.sort((a,b)=>b.totalCLP - a.totalCLP);

  for (const r of rows) {
    tb.insertAdjacentHTML('beforeend', `
      <tr data-prov="${r.slug}">
        <td class="col-prov" title="${r.nombre}">${r.nombre}</td>
        <td class="col-dest" title="${r.destinos}">${r.destinos}</td>

        <td class="right col-clp total" data-field="totalclp" data-raw="${Math.round(r.totalCLP)}">${money(r.totalCLP)}</td>
        <td class="right col-usd total" data-field="totalusd" data-raw="${r.totalUSD}">${fmt(r.totalUSD)}</td>

        <td class="right col-clp abono" data-field="abonoclp">—</td>
        <td class="right col-usd abono" data-field="abonousd">—</td>

        <td class="right bold col-clp saldo" data-field="saldoclp">—</td>
        <td class="right bold col-usd saldo" data-field="saldousd">—</td>

        <td class="right col-items" title="${r.count}">${fmt(r.count)}</td>
        <td class="right col-act">
          <button class="btn secondary" data-prov="${r.slug}">VER DETALLE</button>
        </td>
      </tr>
    `);
  }

  // ——— Botones "VER DETALLE"
  tb.querySelectorAll('button[data-prov]').forEach(btn => {
    btn.addEventListener('click', () => {
      const slugProv = btn.getAttribute('data-prov');
      openModalProveedor(slugProv, mapProv.get(slugProv));
    });
  });

  // ——— Sorters (mismo orden, saltando columna acciones)
  makeSortable(tbl,
    ['text','text','money','num','money','num','money','num','num','text'],
    { skipIdx:[9] }  // la última columna (acciones)
  );

  // ——— Completar abonos/saldos (ya usa data-field, no cambia)
  completarAbonosEnTablaProveedores(mapProv);
}
  
async function completarAbonosEnTablaProveedores(mapProv){
  const tbody = el('tblProveedores').querySelector('tbody');

  for (const [slugProv, provData] of mapProv.entries()) {
    // pares únicos destino/servicio del proveedor
    const pares = serviciosUnicosDeProveedor(provData.items);  // ← ya la tienes del modal "TODOS"
    const lotes = await loadAbonosLote(pares);                  // ← ya la tienes también

    let aCLP = 0, aUSD = 0;
    for (const lote of lotes) {
      for (const ab of (lote.abonos || [])) {
        if (!abonoIncluido(ab)) continue;       // ignora archivados
        const eq = abonoEquivalentes(ab);       // CLP|USD equivalentes
        aCLP += (eq.CLP || 0);
        aUSD += (eq.USD || 0);
      }
    }

    // Pinta en la fila
    const tr = tbody.querySelector(`tr[data-prov="${slugProv}"]`);
    if (!tr) continue;

    // Totales (raw desde dataset)
    const totCLP = parseNumber(tr.querySelector('[data-field="totalclp"]').dataset.raw);
    const totUSD = parseNumber(tr.querySelector('[data-field="totalusd"]').dataset.raw);

    // Abonos
    tr.querySelector('[data-field="abonoclp"]').textContent = money(aCLP);
    tr.querySelector('[data-field="abonousd"]').textContent = fmt(aUSD);

    // Saldos
    const sCLP = (totCLP || 0) - (aCLP || 0);
    const sUSD = (totUSD || 0) - (aUSD || 0);
    const cCLP = tr.querySelector('[data-field="saldoclp"]');
    const cUSD = tr.querySelector('[data-field="saldousd"]');
    cCLP.textContent = money(sCLP);
    cUSD.textContent = fmt(sUSD);
    cCLP.classList.toggle('saldo-rojo', Math.abs(sCLP) > 0.0001);
    cUSD.classList.toggle('saldo-rojo', Math.abs(sUSD) > 0.0001);
  }
}

function renderTablaHoteles(mapHoteles) {
  const tb = el('tblHoteles').querySelector('tbody');
  tb.innerHTML = '';
  const rows = [];
  mapHoteles.forEach((v,k)=>rows.push({
    hotel:k, destino:v.destino,
    clpEq:v.clpEq||0, usdEq:v.usdEq||0, brlEq:v.brlEq||0, arsEq:v.arsEq||0,
    noches:v.noches||0
  }));
  rows.sort((a,b)=>b.clpEq - a.clpEq);
  for (const r of rows) {
    tb.insertAdjacentHTML('beforeend', `
      <tr>
        <td title="${r.hotel}">${r.hotel}</td>
        <td title="${r.destino || ''}">${r.destino || ''}</td>
        <td class="right" title="${r.clpEq}">${money(r.clpEq)}</td>
        <td class="right" title="${r.usdEq}">${fmt(r.usdEq)}</td>
        <td class="right" title="${r.brlEq}">${fmt(r.brlEq)}</td>
        <td class="right" title="${r.arsEq}">${fmt(r.arsEq)}</td>
        <td class="right" title="${r.noches}">${fmt(r.noches)}</td>
      </tr>
    `);
  }
  makeSortable(el('tblHoteles'), ['text','text','money','num','num','num','num']);
}

// -------------------------------
// 7) Modal — helpers ABONOS
// -------------------------------
function abonoEquivalentes(ab) { return convertirTodas(ab.moneda, Number(ab.monto || 0)); }
function abonoEstadoLabel(ab) { return (ab.estado || 'ORIGINAL').toUpperCase(); }
function abonoIncluido(ab) { return (ab.estado || 'ORIGINAL') !== 'ARCHIVADO'; }
function nowISODate(){ return new Date().toISOString().slice(0,10); }
function currentTCSnapshot(){ return {
  USD: Number(el('tcUSD')?.value || 0) || null,
  BRL: Number(el('tcBRL')?.value || 0) || null,
  ARS: Number(el('tcARS')?.value || 0) || null,
}; }

async function loadAbonos(destinoId, servicioId) {
  const col = collection(db, `${RUTA_SERVICIOS}/${destinoId}/Listado/${servicioId}/Abonos`);
  const snap = await getDocs(col);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
async function guardarAbono({ destinoId, servicioId, abonoId, data, file }) {
  let comprobanteURL = data.comprobanteURL || null;
  if (file) {
    const ref = storageRef(storage, `abonos/${destinoId}/${servicioId}/${Date.now()}_${file.name}`);
    await uploadBytes(ref, file);
    comprobanteURL = await getDownloadURL(ref);
  }

  const email = (auth.currentUser?.email || '').toLowerCase();
  const base = {
    servicioId,
    fecha: data.fecha || nowISODate(),
    moneda: normalizarMoneda(data.moneda || 'CLP'),
    monto: Number(data.monto || 0),
    nota: data.nota || '',
    comprobanteURL: comprobanteURL || '',
    estado: data.estado || 'ORIGINAL',
    tcSnapshot: currentTCSnapshot(),
  };

  if (!abonoId) {
    await addDoc(collection(db, `${RUTA_SERVICIOS}/${destinoId}/Listado/${servicioId}/Abonos`), {
      ...base, createdAt: serverTimestamp(), createdByEmail: email, version: 1, historial: [],
    });
  } else {
    const docRef = doc(db, `${RUTA_SERVICIOS}/${destinoId}/Listado/${servicioId}/Abonos/${abonoId}`);
    await updateDoc(docRef, {
      ...base, updatedAt: serverTimestamp(), updatedByEmail: email,
      estado: (data.estado || 'EDITADO'),
      version: (Number(data.version || 1) + 1),
    });
  }
}
async function archivarAbono({ destinoId, servicioId, abonoId }) {
  const email = (auth.currentUser?.email || '').toLowerCase();
  const docRef = doc(db, `${RUTA_SERVICIOS}/${destinoId}/Listado/${servicioId}/Abonos/${abonoId}`);
  await updateDoc(docRef, { estado: 'ARCHIVADO', archivedAt: serverTimestamp(), archivedByEmail: email });
}

async function desarchivarAbono({ destinoId, servicioId, abonoId }) {
  const email = (auth.currentUser?.email || '').toLowerCase();
  const docRef = doc(db, `${RUTA_SERVICIOS}/${destinoId}/Listado/${servicioId}/Abonos/${abonoId}`);
  await updateDoc(docRef, { estado: 'EDITADO', unarchivedAt: serverTimestamp(), unarchivedByEmail: email });
}

// --- Cargar realizaciones guardadas (Sí/No por item) ---
async function loadRealizaciones(){
  try{
    const snap = await getDocs(collection(db, RUTA_REALIZACIONES));
    REALIZACIONES.clear();
    REALIZACIONES_INFO.clear();
    for (const d of snap.docs){
      const x = d.data() || {};
      const k = keyRealiza(x.grupoId, x.fecha, x.servicioId);
      REALIZACIONES.set(k, !!x.realizado);
      REALIZACIONES_INFO.set(k, {
        email: (x.updatedByEmail || x.createdByEmail || '').toLowerCase(),
        updatedAt: x.updatedAt || null
      });
    }
  }catch(e){ console.warn('No se pudo cargar FinanzasRealizaciones', e); }
}

// --- Guardar lote de cambios de realizaciones ---
async function saveRealizacionesBatch(entries){
  for (const [k, realizado] of entries){
    const [grupoId, fecha, servicioId] = k.split('|');
    await setDoc(
      doc(db, RUTA_REALIZACIONES, k),
      {
        grupoId, fecha, servicioId,
        realizado: !!realizado,
        updatedByEmail: (auth.currentUser?.email || '').toLowerCase(),
        updatedAt: serverTimestamp()
      },
      { merge:true }
    );
  }
}

// --- NUEVO: armar pares destino/servicio únicos para un proveedor ---
function serviciosUnicosDeProveedor(items){
  const map = new Map();
  for (const it of items){
    if (!it.servicioId || !it.destinoGrupo) continue; // si no hay id no podemos leer Abonos
    const key = `${it.destinoGrupo}||${it.servicioId}`;
    if (!map.has(key)) {
      map.set(key, {
        destinoId: it.destinoGrupo,
        servicioId: it.servicioId,
        servicioNombre: it.servicio || '',
      });
    }
  }
  return [...map.values()];
}

// --- NUEVO: carga de abonos en lote para varios servicios ---
async function loadAbonosLote(pares){
  return Promise.all(pares.map(async p => {
    try {
      const ab = await loadAbonos(p.destinoId, p.servicioId);
      return { ...p, abonos: ab };
    } catch(e){
      return { ...p, abonos: [] };
    }
  }));
}

// Agrupa items por servicio (nativo) → {servicio, total, count, servicioId, items[]}
function agruparItemsPorServicioNativo(items){
  const map = new Map();
  for (const it of items){
    const k = it.servicio || '(sin nombre)';
    const acc = map.get(k) || { total:0, count:0, items:[], servicioId: it.servicioId || null };
    acc.total += (it.totalMoneda || 0);
    acc.count++; acc.items.push(it);
    acc.servicioId = acc.servicioId || it.servicioId || null;
    map.set(k, acc);
  }
  return [...map.entries()].map(([servicio,v])=>({servicio,...v})).sort((a,b)=>b.total - a.total);
}

// Calcula abonos por servicio (moneda NAT) + llena RESUMEN TOTAL y SALDO por servicio
async function poblarResumenYSaldo({ data, cont }) {
  const nat = cont.__nat || 'CLP';
  const pairs = cont.__svcPairs || []; // [{destinoId, servicioId, servicioNombre, moneda}, ...]

  // 1) Resumen de items por servicio (sumas NATIVAS por servicio)
  const resumen = agruparItemsPorServicioNativo(data.items); // [{servicio,total,count,servicioId,items:[]}, ...]

  // 2) Lote de abonos por servicio
  const lotes = await loadAbonosLote(pairs);
  const abonoPorServicio = {}; // servicioId -> suma (NAT)
  for (const lote of lotes) {
    let sum = 0;
    for (const ab of (lote.abonos || [])) {
      const estado = (ab.estado || 'ORIGINAL').toUpperCase();
      if (estado === 'ARCHIVADO') continue;
      if (normalizarMoneda(ab.moneda) !== nat) continue;
      sum += Number(ab.monto || 0);
    }
    abonoPorServicio[lote.servicioId] = (abonoPorServicio[lote.servicioId] || 0) + sum;
  }

  // 3) RESUMEN TOTAL (una sola fila + "VER TODOS")
  const tbRes = $('#tblProvResumen tbody', cont);
  tbRes.innerHTML = '';
  let TOT_T=0, TOT_A=0, TOT_S=0, TOT_I=0;
  for (const r of resumen) {
    const abo = r.servicioId ? (abonoPorServicio[r.servicioId] || 0) : 0;
    const sal = (r.total || 0) - abo;
    TOT_T += (r.total || 0);
    TOT_A += abo;
    TOT_S += sal;
    TOT_I += (r.count || 0);
  }
  const trTotal = document.createElement('tr');
  trTotal.innerHTML = `
    <td class="bold">TOTAL</td>
    <td id="resTotNAT" class="right bold">${money(TOT_T)}</td>
    <td id="resAboNAT" class="right abono-amount">${money(TOT_A)}</td>
    <td id="resSalNAT" class="right ${TOT_S>0?'saldo-rojo':'saldo-ok'}">${money(TOT_S)}</td>
    <td id="resItems" class="right">${fmt(TOT_I)}</td>
    <td class="right"><button id="btnVerTodos" class="btn secondary">VER TODOS</button></td>
  `;
  tbRes.appendChild(trTotal);

  // 4) SALDOS POR ACTIVIDAD/SERVICIO (con botón VER DETALLE)
  const tbSaldo = $('#tblSaldo tbody', cont);
  tbSaldo.innerHTML = '';
  let S_T=0, S_A=0, S_S=0;
  for (const r of resumen) {
    const abo = r.servicioId ? (abonoPorServicio[r.servicioId] || 0) : 0;
    const sal = (r.total || 0) - abo;
    S_T += (r.total || 0); S_A += abo; S_S += sal;

    const tr = document.createElement('tr');
    tr.setAttribute('data-svc', slug(r.servicio));
    tr.innerHTML = `
      <td>${r.servicio}</td>
      <td class="right">${money(r.total || 0)}</td>
      <td class="right abono-amount">${money(abo)}</td>
      <td class="right ${sal>0?'saldo-rojo':'saldo-ok'}">${money(sal)}</td>
      <td class="right">
        <button class="btn secondary btn-saldo-detalle" data-svc="${slug(r.servicio)}">VER DETALLE</button>
      </td>
    `;
    tbSaldo.appendChild(tr);
  }
  $('#saldoTotNAT', cont).textContent = money(S_T);
  $('#saldoAboNAT', cont).textContent = money(S_A);
  const celSN = $('#saldoNAT', cont);
  celSN.textContent = money(S_S);
  celSN.classList.toggle('saldo-rojo', S_S > 0.0001);
  celSN.classList.toggle('saldo-ok',   S_S <= 0.0001);

  // 5) Acciones: VER TODOS
  const btnTodos = $('#btnVerTodos', cont);
  if (btnTodos) {
    btnTodos.onclick = async () => {
      // Mostrar todas las actividades y todos los ítems
      $$('#tblSaldo tbody tr', cont).forEach(tr => tr.style.display = '');
      $$('#tblDetalleProv tbody tr', cont).forEach(tr => tr.style.display = '');
      cont.dataset.curMode = 'ALL';
      await pintarAbonosTodosProveedor({ data, cont });
      calcSaldoDesdeTablas(cont);
    };
  }

  // 6) Acciones: VER DETALLE por actividad (filtra detalle + abonos)
  tbSaldo.querySelectorAll('.btn-saldo-detalle').forEach(btn => {
    btn.addEventListener('click', async () => {
      const svcSlug = btn.getAttribute('data-svc');

      // Filtra filas de SALDO
      $$('#tblSaldo tbody tr', cont).forEach(tr => {
        tr.style.display = (tr.getAttribute('data-svc') === svcSlug) ? '' : 'none';
      });

      // Filtra DETALLE
      $$('#tblDetalleProv tbody tr', cont).forEach(tr => {
        tr.style.display = (tr.getAttribute('data-svc') === svcSlug) ? '' : 'none';
      });

      // Cargar abonos de ese servicio
      const itemSvc = data.items.find(i => slug(i.servicio||'') === svcSlug);
      if (itemSvc?.servicioId && itemSvc?.destinoGrupo) {
        cont.dataset.curMode = 'ONE';
        await pintarAbonos({
          destinoId: itemSvc.destinoGrupo,
          servicioId: itemSvc.servicioId,
          servicioNombre: itemSvc.servicio || '',
          cont,
        });
      }
      calcSaldoDesdeTablas(cont);
    });
  });
}

// --- NUEVO: pintar TODOS los abonos del proveedor en el modal ---
async function pintarAbonosTodosProveedor({ data, cont }){
  cont.dataset.curMode = 'ALL';
  cont.dataset.curDestinoId = '';
  cont.dataset.curServicioId = '';
  cont.dataset.curServicioNombre = '';

  const verArch = cont.dataset.verArchivados === '1';
  const tbody = $('#tblAbonos tbody', cont);
  tbody.innerHTML = '';

  const pares = serviciosUnicosDeProveedor(data.items);
  const lotes = await loadAbonosLote(pares);

  const nat = cont.__nat || 'CLP';
  let tNAT = 0;

  for (const lote of lotes){
    for (const ab of (lote.abonos || [])){
      const estado = (ab.estado || 'ORIGINAL').toUpperCase();
      const incluir = (estado !== 'ARCHIVADO') || verArch;
      if (estado !== 'ARCHIVADO' && normalizarMoneda(ab.moneda) === nat) {
        tNAT += Number(ab.monto || 0);
      }
      const tr = document.createElement('tr');
      if (estado === 'ARCHIVADO') tr.classList.add('abono-archivado');
      tr.innerHTML = `
        <td title="${lote.servicioNombre}">${lote.servicioNombre}</td>
        <td title="${(ab.updatedByEmail || ab.createdByEmail || '').toLowerCase()}">
          <span class="email-normal">${(ab.updatedByEmail || ab.createdByEmail || '').toLowerCase()}</span>
        </td>
        <td title="${ab.fecha || ''}">${fechaCortaEs(ab.fecha || '')}</td>
        <td title="${(ab.moneda||'CLP').toUpperCase()}">${(ab.moneda||'CLP').toUpperCase()}</td>
        <td class="right" title="${ab.monto || 0}">${fmt(ab.monto || 0)}</td>
        <td title="${ab.nota || ''}">${ab.nota || ''}</td>
        <td>${ab.comprobanteURL ? `<a href="${ab.comprobanteURL}" target="_blank" rel="noopener">VER</a>` : '—'}</td>
        <td class="actions">
          <div class="icon-actions">
            <button type="button" class="icon-btn edit btn-edit" aria-label="Editar" title="Editar">
              <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M13.586 3.586a2 2 0 012.828 2.828l-8.95 8.95a2 2 0 01-.878.507l-3.13.9a.5.5 0 01-.62-.62l.9-3.13a2 2 0 01.507-.878l8.95-8.95zM12 4.999l3 3" /></svg>
            </button>
            ${estado==='ARCHIVADO' ? `
              <button type="button" class="icon-btn archive btn-unarch" aria-label="Desarchivar" title="Desarchivar">
                <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M3 3h14v3H3V3zm2 4h10v9a2 2 0 01-2 2H7a2 2 0 01-2-2V7zm2 3h6v2H7v-2z"/></svg>
              </button>
            ` : `
              <button type="button" class="icon-btn archive btn-arch" aria-label="Archivar" title="Archivar">
                <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M3 3a1 1 0 011-1h12a1 1 0 011 1v3H3V3zm0 4h14v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7zm4 2h6v2H7V9z"/></svg>
              </button>
            `}
          </div>
        </td>
        <td title="${estado}">${estado}</td>
      `;
      if (incluir) tbody.appendChild(tr);

      tr.querySelector('.btn-edit').addEventListener('click', async () => {
        if (!(await pedirClaveDialog(cont))) return;
        abrirSubmodalAbono({
          cont,
          destinoId: lote.destinoId,
          servicioId: lote.servicioId,
          abono: { ...ab, id: ab.id }
        });
      });

      const btnArch = tr.querySelector('.btn-arch');
      if (btnArch) btnArch.addEventListener('click', async () => {
        if (!(await pedirClaveDialog(cont))) return;
        if (!confirm('¿ARCHIVAR ESTE ABONO?')) return;
        await archivarAbono({ destinoId: lote.destinoId, servicioId: lote.servicioId, abonoId: ab.id });
        await pintarAbonosTodosProveedor({ data, cont });
        calcSaldoDesdeTablas(cont);
      });

      const btnUn = tr.querySelector('.btn-unarch');
      if (btnUn) btnUn.addEventListener('click', async () => {
        if (!(await pedirClaveDialog(cont))) return;
        await desarchivarAbono({ destinoId: lote.destinoId, servicioId: lote.servicioId, abonoId: ab.id });
        await pintarAbonosTodosProveedor({ data, cont });
        calcSaldoDesdeTablas(cont);
      });
    }
  }

  $('#abTotNAT', cont).textContent = money(tNAT);

  makeSortable($('#tblAbonos', cont),
    ['text','text','date','text','num','text','text','text','text'],
    {skipIdx:[7]}
  );
}

// -------------------------------
// 8) Modal — UI
// -------------------------------
function buildModalShell(natCode) {
  const cont = $('.fin-modal-body', el('modal'));
  cont.dataset.verArchivados = '0';
  cont.innerHTML = `
    <div class="modal-toolbar">
      <input id="modalSearch" type="search" placeholder="BUSCAR EN ABONOS Y DETALLE…" />
      <div class="spacer"></div>
      <button class="btn" id="btnGuardarCambios" style="background:#f97316;color:#fff;">GUARDAR CAMBIOS</button>
      <button class="btn blue" id="btnAbonar">ABONAR DINERO</button>
      <button class="btn btn-dark" id="btnVerArch" aria-pressed="false">VER ARCHIVADOS</button>
      <button class="btn btn-excel" id="btnExportXLS">EXPORTAR EXCEL</button>
    </div>

    <!-- RESUMEN POR SERVICIO (MONEDA NATIVA) -->
    <div class="scroll-x" style="margin-bottom:.5rem;">
      <table class="fin-table upper" id="tblProvResumen">
        <thead>
          <tr>
            <th>SERVICIO</th>
            <th class="right">TOTAL (${natCode})</th>
            <th class="right">ABONO (${natCode})</th>
            <th class="right">SALDO (${natCode})</th>
            <th class="right">N°</th>
            <th></th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>

    <!-- ABONOS -->
    <section class="panel abonos-panel">
      <div class="abonos-header upper"><span><b>ABONOS</b></span></div>
      <div class="scroll-x">
        <table class="fin-table upper" id="tblAbonos">
          <thead>
            <tr>
              <th>SERVICIO</th>
              <th>RESPONSABLE</th>
              <th>FECHA</th>
              <th>MONEDA</th>
              <th class="right">MONTO</th>
              <th>NOTA</th>
              <th>COMPROBANTE</th>
              <th class="actions">ACCIONES</th>
              <th>ESTADO</th>
            </tr>
          </thead>
          <tbody></tbody>
          <tfoot>
            <tr class="bold">
              <th colspan="4" class="right">TOTAL ABONADO (${natCode})</th>
              <th id="abTotNAT" class="right">$0</th>
              <th colspan="4"></th>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>

    <!-- SALDOS POR ACTIVIDAD/SERVICIO -->
    <section class="panel">
      <h4 class="upper bold">SALDO POR PAGAR</h4>
      <div class="scroll-x">
        <table class="fin-table upper" id="tblSaldo">
          <thead>
            <tr>
              <th>SERVICIO</th>
              <th class="right">TOTAL (${natCode})</th>
              <th class="right">ABONO (${natCode})</th>
              <th class="right">SALDO (${natCode})</th>
              <th></th>
            </tr>
          </thead>
          <tbody></tbody>
          <tfoot>
            <tr class="bold">
              <th class="right">TOTAL</th>
              <th id="saldoTotNAT" class="right">$0</th>
              <th id="saldoAboNAT" class="right">$0</th>
              <th id="saldoNAT"     class="right">$0</th>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>

    <!-- DETALLE POR ÍTEM -->
    <div class="scroll-x">
      <table class="fin-table upper" id="tblDetalleProv">
        <thead>
          <tr>
            <th>FECHA</th>
            <th>NEGOCIO-ID</th>
            <th>GRUPO</th>
            <th>PROGRAMA</th>
            <th>SERVICIO</th>
            <th class="right">PAX</th>
            <th class="right">PAX REAL</th>
            <th>HIZO</th>
            <th>MODALIDAD</th>
            <th>MONEDA</th>
            <th class="right">TARIFA</th>
            <th class="right">PAGO RESERVADO (${natCode})</th>
            <th class="right">VALOR REAL (${natCode})</th>
          </tr>
        </thead>
        <tbody></tbody>
        <tfoot>
          <tr class="bold row-subtotal-reservado">
            <th colspan="11" class="right">SUBTOTAL PAGO RESERVADO (${natCode})</th>
            <th id="modalTotalNAT" class="right">$0</th>
            <th></th>
          </tr>
          <tr class="bold row-subtotal-naranja">
            <th colspan="11" class="right">SUBTOTAL VALOR REAL (${natCode})</th>
            <th id="modalTotalRealNAT" class="right">$0</th>
            <th></th>
          </tr>
        </tfoot>
      </table>
    </div>

    <!-- Submodal Abono -->
    <div id="submodalAbono" class="submodal" hidden>
      <div class="card">
        <header class="upper bold">ABONO</header>
        <div class="grid">
          <label>SERVICIO
            <select id="abSvc"></select>
          </label>
          <label>DESTINO
            <select id="abDest"></select>
          </label>
          <label>FECHA
            <input type="date" id="abFecha" />
          </label>
          <label>MONEDA
            <select id="abMoneda" disabled>
              <option>CLP</option><option>USD</option><option>BRL</option><option>ARS</option>
            </select>
          </label>
          <label>MONTO
            <input type="number" id="abMonto" step="0.01" />
          </label>
          <label>NOTA
            <input type="text" id="abNota" maxlength="140" />
          </label>
          <label>COMPROBANTE (IMAGEN/PDF)
            <input type="file" id="abFile" accept="image/*,application/pdf" />
          </label>
        </div>
        <footer>
          <button class="btn secondary" id="abCancelar">CANCELAR</button>
          <button class="btn" id="abGuardar">GUARDAR</button>
        </footer>
      </div>
    </div>

    <!-- Diálogo de clave -->
    <div id="claveDialog" class="submodal" hidden>
      <div class="card">
        <header class="upper bold">CLAVE REQUERIDA</header>
        <div>
          <label>Ingrese la clave para continuar</label>
          <div style="display:flex;gap:.5rem;align-items:center;margin-top:.35rem;">
            <input id="pwField" type="password" placeholder="••••" style="flex:1;"/>
            <button id="pwToggle" class="btn secondary" type="button" aria-pressed="false">👁️</button>
          </div>
        </div>
        <footer>
          <button class="btn secondary" id="pwCancel">CANCELAR</button>
          <button class="btn blue" id="pwOk">ACEPTAR</button>
        </footer>
      </div>
    </div>
  `;
  return cont;
}

function paintSaldoCells({ clp, usd, brl, ars }) {
  const neg = (v) => v && Math.abs(v) > 0.0001;
  const set = (id, val, isMoney=false) => {
    const cell = el(id);
    cell.textContent = isMoney ? money(val||0) : fmt(val||0);
    cell.classList.toggle('saldo-rojo', neg(val));
  };
  set('saldoCLP', clp, true);
  set('saldoUSD', usd);
  set('saldoBRL', brl);
  set('saldoARS', ars);
}

// -------------------------------
// 9) Modal — Abrir
// -------------------------------
function agruparItemsPorServicio(items) {
  const map = new Map();
  for (const it of items) {
    const key = it.servicio || '(sin nombre)';
    const acc = map.get(key) || { usdEq:0, brlEq:0, arsEq:0, clpEq:0, count:0, items:[], servicioId: it.servicioId || null };
    const conv = convertirTodas(it.moneda, it.totalMoneda);
    if (conv.CLP != null) acc.clpEq += conv.CLP;
    if (conv.USD != null) acc.usdEq  += conv.USD;
    if (conv.BRL != null) acc.brlEq  += conv.BRL;
    if (conv.ARS != null) acc.arsEq  += conv.ARS;
    acc.count++; acc.items.push(it);
    acc.servicioId = acc.servicioId || it.servicioId || null;
    map.set(key, acc);
  }
  return [...map.entries()].map(([servicio,v])=>({servicio,...v})).sort((a,b)=>b.clpEq - a.clpEq);
}

async function openModalProveedor(slugProv, data) {
  const modal = el('modal');
  const dests = [...data.destinos];
  const gruposSet = new Set(data.items.map(i => i.grupoId));
  const paxTotal = data.items.reduce((s,i)=> s + (Number(i.pax||0)), 0);

  const { code:nat, mixed } = getMonedaProveedor(data.items);
  el('modalTitle').textContent = `DETALLE — ${(data?.nombre || slugProv).toUpperCase()}`;
  el('modalSub').textContent = `DESTINOS: ${dests.join(', ').toUpperCase()} • GRUPOS: ${gruposSet.size} • PAX: ${fmt(paxTotal)}${mixed ? ' • ⚠ proveedor con monedas mixtas' : ''}`;

  ensureFinanceStyles();
  
  const cont = buildModalShell(nat);
  cont.__nat = nat;
  cont.__svcPairs = buildSvcPairs(data.items);
  cont.__provData = data;
  
  // Guardar cambios HIZO (Sí/No)
  const btnSave = $('#btnGuardarCambios', cont);
  if (btnSave) {
    btnSave.onclick = async () => {
      const pending = Array.from((cont.__hizoDirty || new Map()).entries());
      if (!pending.length) { alert('No hay cambios.'); return; }
      if (!confirm(`Se guardarán ${pending.length} cambio(s). ¿Estás seguro?`)) return;
  
      try {
        await saveRealizacionesBatch(pending);
        await loadRealizaciones();           // refresca overlay
        cont.__hizoDirty.clear();
  
        // refresca abonos/tabla según modo actual
        if (cont.dataset.curMode === 'ONE' && cont.dataset.curServicioId && cont.dataset.curDestinoId) {
          await pintarAbonos({
            destinoId: cont.dataset.curDestinoId,
            servicioId: cont.dataset.curServicioId,
            servicioNombre: cont.dataset.curServicioNombre || '',
            cont,
          });
        } else {
          await pintarAbonosTodosProveedor({ data, cont });
        }
        calcSaldoDesdeTablas(cont);
        alert('Cambios guardados.');
      } catch(e){
        console.error(e);
        alert('No se pudieron guardar los cambios.');
      }
    };
  }

  // botón XLS
  const btnXLS = $('#btnExportXLS', cont);
  if (btnXLS) btnXLS.addEventListener('click', () => {
    exportModalToExcel(cont, data?.nombre || slugProv);
  });

  // === Resumen por servicio (suma nativa) ===
  function agruparItemsPorServicioNativo(items){
    const map = new Map();
    for (const it of items){
      const k = it.servicio || '(sin nombre)';
      const acc = map.get(k) || { total:0, count:0, items:[], servicioId: it.servicioId || null };
      acc.total += (it.totalMoneda || 0);
      acc.count++; acc.items.push(it);
      acc.servicioId = acc.servicioId || it.servicioId || null;
      map.set(k, acc);
    }
    return [...map.entries()].map(([servicio,v])=>({servicio,...v})).sort((a,b)=>b.total - a.total);
  }

  await poblarResumenYSaldo({ data, cont });
  
  // Activar “VER DETALLE” por servicio (filtro + abonos modo ONE + saldo parcial)
  cont.querySelectorAll('.btn-det-svc').forEach(btn => {
    btn.addEventListener('click', async () => {
      const svcSlug = btn.getAttribute('data-svc');
  
      // Filtra detalle a ese servicio
      const rows = $$('#tblDetalleProv tbody tr', cont);
      rows.forEach(tr => {
        const ok = tr.getAttribute('data-svc') === svcSlug;
        tr.style.display = ok ? '' : 'none';
      });
  
      // Abonos de ese servicio
      const itemSvc = data.items.find(i => slug(i.servicio||'') === svcSlug);
      if (itemSvc?.servicioId && itemSvc?.destinoGrupo) {
        cont.dataset.curMode = 'ONE';
        await pintarAbonos({
          destinoId: itemSvc.destinoGrupo,
          servicioId: itemSvc.servicioId,
          servicioNombre: itemSvc.servicio || '',
          cont,
        });
      }
  
      // Recalcular saldos con el filtro aplicado
      // Además, mostrar en #tblSaldo solo esa fila
      $$('#tblSaldo tbody tr', cont).forEach(tr => {
        tr.style.display = (tr.getAttribute('data-svc') === svcSlug) ? '' : 'none';
      });
      calcSaldoDesdeTablas(cont);
    });
  });


  // === Detalle nativo + columnas nuevas ===
  const tb = $('#tblDetalleProv tbody', cont);
  tb.innerHTML = '';
  const rows = [...data.items].sort((a,b) =>
    (a.fecha || '').localeCompare(b.fecha || '') ||
    (a.nombreGrupo || '').localeCompare(b.nombreGrupo || '')
  );
  
  let totalReservado = 0;
  let totalReal      = 0;
  
  for (const it of rows) {
    const negocioId = (it.numeroNegocio || it.grupoId || '') + (it.identificador ? `-${it.identificador}`:'');
    const grupoTxt  = it.nombreGrupo || '';
    const modalidad = (it.pagoTipo === 'por_pax' ? 'POR PAX' : 'POR GRUPO') + ' — ' + (it.pagoFrecuencia || 'unitario').toUpperCase();
  
    const reservado = (it.pagoTipo === 'por_dia')
      ? (it.diaOwner ? Number(it.tarifa||0) : 0)
      : Number(it.totalMoneda || 0);
    
    const deberia = (it.pagoTipo === 'por_pax')
      ? (Number(it.tarifa||0) * Number(it.paxReal||0))
      : (it.pagoTipo === 'por_grupo' ? Number(it.tarifa||0) : 0);
  
    totalReservado += reservado;
    totalReal      += deberia;
  
    const tr = document.createElement('tr');
    if (it.pagoTipo === 'por_dia') {
      tr.dataset.diaKey   = it.diaKey || '';
      tr.dataset.diaOwner = it.diaOwner ? '1' : '0';
    }
    tr.setAttribute('data-svc', slug(it.servicio || ''));
    tr.setAttribute('data-hizo', '1'); // por defecto SÍ
    tr.innerHTML = `
      <td title="${it.fecha || ''}">${fechaCortaEs(it.fecha || '')}</td>
      <td title="${negocioId}">${negocioId}</td>
      <td title="${grupoTxt}">${grupoTxt}</td>
      <td title="${it.programa || ''}">${it.programa || ''}</td>
      <td title="${it.servicio || ''}">${it.servicio || ''}</td>
      <td class="right" title="${it.pax || 0}">${fmt(it.pax || 0)}</td>
      <td class="right" title="${it.paxReal || 0}">${fmt(it.paxReal || 0)}</td>
      <td>
        <div class="hizo-wrap">
          <button type="button" class="btn dark btn-hizo" aria-pressed="true">Sí</button>
          <span class="hizo-email">-</span>
        </div>
      </td>
      <td title="${modalidad}">${modalidad}</td>
      <td title="${(it.moneda || 'CLP').toUpperCase()}">${(it.moneda || 'CLP').toUpperCase()}</td>
      <td class="right" title="${it.tarifa || 0}">${fmt(it.tarifa || 0)}</td>
      <td class="right cel-res" data-reservado="${reservado}" title="${reservado}">${fmt(reservado)}</td>
      <td class="right cel-real" data-real="${deberia}" data-dia-tarifa="${it.tarifa||0}" title="${deberia}">${fmt(deberia)}</td>
    `;
    tb.appendChild(tr);

    // --- Estado inicial HIZO desde Realizaciones guardadas ---
    cont.__hizoDirty = cont.__hizoDirty || new Map();
    const btnHizo = tr.querySelector('.btn-hizo');
    const emailSpan = tr.querySelector('.hizo-email');
    const keyHz = keyRealiza(it.grupoId, it.fecha, it.servicioId || null);
    
    // aplica overlay guardado
    const saved = REALIZACIONES.get(keyHz);
    if (saved === false) {
      tr.setAttribute('data-hizo','0');
      btnHizo.setAttribute('aria-pressed','false');
      btnHizo.textContent = 'No';
      emailSpan.textContent = REALIZACIONES_INFO.get(keyHz)?.email || '-';
    } else {
      tr.setAttribute('data-hizo','1');
      btnHizo.setAttribute('aria-pressed','true');
      btnHizo.textContent = 'Sí';
      emailSpan.textContent = '-';
    }
    
    // toggle HIZO
    btnHizo.addEventListener('click', () => {
      const on = tr.getAttribute('data-hizo') === '1';
      const newOn = !on;                      // true = Sí, false = No
      tr.setAttribute('data-hizo', newOn ? '1' : '0');
      btnHizo.setAttribute('aria-pressed', newOn ? 'true' : 'false');
      btnHizo.textContent = newOn ? 'Sí' : 'No';
    
      if (!newOn) {
        emailSpan.textContent = (auth.currentUser?.email || '').toLowerCase();
      } else {
        emailSpan.textContent = '-';
      }
    
      // marca cambio pendiente
      cont.__hizoDirty.set(keyHz, newOn);
    
      // recalcula totales (afecta saldos, resumen TOTAL y pie)
      calcSaldoDesdeTablas(cont);
    });
  }
  
  $('#modalTotalNAT', cont).textContent      = money(totalReservado);
  $('#modalTotalRealNAT', cont).textContent  = money(totalReal);
  makeSortable($('#tblDetalleProv', cont),
    ['date','text','text','text','text','num','num','text','text','text','num','num','num']
  );

  // === Buscador global (filtra DETALLE y ABONOS) ===
  $('#modalSearch', cont).addEventListener('input', (e) => {
    // "t1, t2, t3" => OR entre tokens
    const raw = (e.target.value || '').toLowerCase();
    const tokens = raw.split(',').map(s => s.trim()).filter(Boolean); // coma agrega conceptos
  
    const anyMatch = (txt) => {
      if (!tokens.length) return true;                   // vacío = mostrar todo
      const low = (txt || '').toLowerCase();
      return tokens.some(t => low.includes(t));          // NO excluyente (OR)
    };
  
    $$('#tblDetalleProv tbody tr', cont).forEach(tr => {
      tr.style.display = anyMatch(tr.textContent) ? '' : 'none';
    });
    $$('#tblAbonos tbody tr', cont).forEach(tr => {
      tr.style.display = anyMatch(tr.textContent) ? '' : 'none';
    });
  
    calcSaldoDesdeTablas(cont);
  });

  // === Toggle VER ARCHIVADOS ===
  const btnArch = $('#btnVerArch', cont);
  const updateBtnArch = ()=>{
    const on = cont.dataset.verArchivados === '1';
    btnArch.setAttribute('aria-pressed', on ? 'true' : 'false');
    btnArch.textContent = on ? 'VER ARCHIVADOS: ON' : 'VER ARCHIVADOS';
  };
  btnArch.addEventListener('click', async ()=>{
    cont.dataset.verArchivados = cont.dataset.verArchivados === '1' ? '0' : '1';
    updateBtnArch();
    await pintarAbonosTodosProveedor({ data, cont }); // repintar con filtro
    calcSaldoDesdeTablas(cont);
  });
  updateBtnArch();

  // === Filtro por servicio (desde el resumen) ===
  cont.querySelectorAll('.btn-det-svc').forEach(btn => {
    btn.addEventListener('click', async () => {
      const svcSlug = btn.getAttribute('data-svc');
      const rows = $$('#tblDetalleProv tbody tr', cont);
      let hayFiltro = false;
      rows.forEach(tr => {
        const ok = tr.getAttribute('data-svc') === svcSlug;
        tr.style.display = ok ? '' : 'none';
        if (ok) hayFiltro = true;
      });
      // En modo ONE: mostramos abonos de ese servicio
      const itemSvc = data.items.find(i => slug(i.servicio||'') === svcSlug);
      if (itemSvc?.servicioId && itemSvc?.destinoGrupo) {
        cont.dataset.curMode = 'ONE';
        await pintarAbonos({
          destinoId: itemSvc.destinoGrupo,
          servicioId: itemSvc.servicioId,
          servicioNombre: itemSvc.servicio || '',
          cont,
        });
        calcSaldoDesdeTablas(cont);
      }
    });
  });

  // === Botón ABONAR (siempre abre y eliges servicio) ===
  $('#btnAbonar', cont).onclick = () => {
    abrirSubmodalAbono({ cont, destinoId: null, servicioId: null, abono: null });
  };

  // === Al abrir: modo TODOS por defecto + abonos de todos ===
  cont.dataset.curMode = 'ALL';
  await pintarAbonosTodosProveedor({ data, cont });
  calcSaldoDesdeTablas(cont);

  // Mostrar modal
  el('backdrop').style.display = 'block';
  modal.style.display = 'block';
  document.body.classList.add('modal-open');
}
window.openModalProveedor = openModalProveedor;

// -------------------------------
// 10) Modal — Abonos
// -------------------------------
function limpiarAbonos(cont){
  $('#tblAbonos tbody', cont).innerHTML = '';
  $('#abTotCLP', cont).textContent = '$0';
  $('#abTotUSD', cont).textContent = '0';
  $('#abTotBRL', cont).textContent = '0';
  $('#abTotARS', cont).textContent = '0';
  paintSaldoCells({clp:0,usd:0,brl:0,ars:0});
  $('#btnAbonar', cont).onclick = null;
  cont.dataset.verArchivados = '0';
  const btnArch = $('#btnVerArch', cont);
  if (btnArch) { btnArch.setAttribute('aria-pressed','false'); btnArch.textContent = 'VER ARCHIVADOS'; }
}
async function pintarAbonos({ destinoId, servicioId, servicioNombre, cont }) {
  cont.dataset.curDestinoId = destinoId;
  cont.dataset.curServicioId = servicioId;
  cont.dataset.curServicioNombre = servicioNombre || '';
  cont.dataset.curMode = 'ONE';

  const verArch = cont.dataset.verArchivados === '1';
  const tbody = $('#tblAbonos tbody', cont);
  tbody.innerHTML = '';

  let abonos = await loadAbonos(destinoId, servicioId);
  abonos.sort((a,b)=> (b.fecha||'').localeCompare(a.fecha||''));

  const nat = cont.__nat || 'CLP';
  let tNAT=0;

  for (const ab of abonos) {
    const estado = (ab.estado || 'ORIGINAL').toUpperCase();
    const incluir = (estado !== 'ARCHIVADO') || verArch;
    if (estado !== 'ARCHIVADO' && normalizarMoneda(ab.moneda) === nat) {
      tNAT += Number(ab.monto || 0);
    }

    const tr = document.createElement('tr');
    if (estado === 'ARCHIVADO') tr.classList.add('abono-archivado');
    tr.innerHTML = `
      <td title="${servicioNombre}">${servicioNombre}</td>
      <td title="${(ab.updatedByEmail || ab.createdByEmail || '').toLowerCase()}">
        <span class="email-normal">${(ab.updatedByEmail || ab.createdByEmail || '').toLowerCase()}</span>
      </td>
      <td title="${ab.fecha || ''}">${fechaCortaEs(ab.fecha || '')}</td>
      <td title="${(ab.moneda||'CLP').toUpperCase()}">${(ab.moneda||'CLP').toUpperCase()}</td>
      <td class="right" title="${ab.monto || 0}">${fmt(ab.monto || 0)}</td>
      <td title="${ab.nota || ''}">${ab.nota || ''}</td>
      <td>${ab.comprobanteURL ? `<a href="${ab.comprobanteURL}" target="_blank" rel="noopener">VER</a>` : '—'}</td>
      <td class="actions">
        <div class="icon-actions">
          <button type="button" class="icon-btn edit btn-edit" aria-label="Editar" title="Editar">
            <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M13.586 3.586a2 2 0 012.828 2.828l-8.95 8.95a2 2 0 01-.878.507l-3.13.9a.5.5 0 01-.62-.62l.9-3.13a2 2 0 01.507-.878l8.95-8.95zM12 4.999l3 3" /></svg>
          </button>
          ${estado==='ARCHIVADO' ? `
            <button type="button" class="icon-btn archive btn-unarch" aria-label="Desarchivar" title="Desarchivar">
              <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M3 3h14v3H3V3zm2 4h10v9a2 2 0 01-2 2H7a2 2 0 01-2-2V7zm2 3h6v2H7v-2z"/></svg>
            </button>
          ` : `
            <button type="button" class="icon-btn archive btn-arch" aria-label="Archivar" title="Archivar">
              <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M3 3a1 1 0 011-1h12a1 1 0 011 1v3H3V3zm0 4h14v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7zm4 2h6v2H7V9z"/></svg>
            </button>
          `}
        </div>
      </td>
      <td title="${estado}">${estado}</td>
    `;
    if (incluir) tbody.appendChild(tr);

    tr.querySelector('.btn-edit').addEventListener('click', async () => {
      if (!(await pedirClaveDialog(cont))) return;
      abrirSubmodalAbono({ cont, destinoId, servicioId, abono: { ...ab, id: ab.id } });
    });
    const btnArch = tr.querySelector('.btn-arch');
    if (btnArch) btnArch.addEventListener('click', async () => {
      if (!(await pedirClaveDialog(cont))) return;
      if (!confirm('¿ARCHIVAR ESTE ABONO?')) return;
      await archivarAbono({ destinoId, servicioId, abonoId: ab.id });
      await pintarAbonos({ destinoId, servicioId, servicioNombre, cont });
      calcSaldoDesdeTablas(cont);
    });

    const btnUn = tr.querySelector('.btn-unarch');
    if (btnUn) btnUn.addEventListener('click', async () => {
      if (!(await pedirClaveDialog(cont))) return;
      await desarchivarAbono({ destinoId, servicioId, abonoId: ab.id });
      await pintarAbonos({ destinoId, servicioId, servicioNombre, cont });
      calcSaldoDesdeTablas(cont);
    });
  }

  $('#abTotNAT', cont).textContent = money(tNAT);

  // Botón Abonar (permite re-abrir para el mismo servicio)
  $('#btnAbonar', cont).onclick = () =>
    abrirSubmodalAbono({ cont, destinoId, servicioId, abono: null });

  makeSortable($('#tblAbonos', cont),
    ['text','text','date','text','num','text','text','text','text'],
    {skipIdx:[7]}
  );
}

function calcSaldoDesdeTablas(cont){
  // 1) Abonos (igual)
  let abonado = 0;
  $$('#tblAbonos tbody tr', cont).forEach(tr => {
    if (tr.style.display === 'none') return;
    if (tr.classList.contains('abono-archivado')) return;
    abonado += parseNumber(tr.cells[4].textContent);
  });

  // 2) Detalle: filas normales por HIZO=Sí + agrupado POR DÍA
  let reservado = 0, real = 0;
  const diaAgg = new Map(); // key -> { anyOn:boolean, tarifa:number, owner:tr }

  $$('#tblDetalleProv tbody tr', cont).forEach(tr => {
    if (tr.style.display === 'none') return;
    const hizo = (tr.getAttribute('data-hizo') === '1');
    const diaKey = tr.dataset.diaKey || '';

    if (diaKey) {
      const tarifa = Number(tr.querySelector('.cel-real')?.dataset?.diaTarifa || 0);
      const rec = diaAgg.get(diaKey) || { anyOn:false, tarifa:tarifa, owner:null };
      rec.anyOn = rec.anyOn || hizo;                   // OR entre filas del mismo día
      if (tr.dataset.diaOwner === '1') rec.owner = tr; // “fila dueña” del cargo
      if (!rec.tarifa) rec.tarifa = tarifa;
      diaAgg.set(diaKey, rec);
    } else if (hizo) {
      reservado += Number(tr.querySelector('.cel-res')?.dataset?.reservado || 0);
      real      += Number(tr.querySelector('.cel-real')?.dataset?.real || 0);
    }
  });

  // Consolidar cargos por día (1 vez por key si hubo uso)
  diaAgg.forEach(({anyOn, tarifa, owner}) => {
    if (!owner) return;
    const rCell = owner.querySelector('.cel-real');
    const pCell = owner.querySelector('.cel-res');
    const rVal  = anyOn ? tarifa : 0;
    const pVal  = anyOn ? tarifa : 0;
    if (rCell){ rCell.dataset.real = String(rVal);   rCell.textContent = fmt(rVal); }
    if (pCell){ pCell.dataset.reservado = String(pVal); pCell.textContent = fmt(pVal); }
    real      += rVal;
    reservado += pVal;
  });

  const saldo = reservado - abonado;

  // Actualiza pies y resumen
  $('#abTotNAT', cont).textContent          = money(abonado);
  $('#modalTotalNAT', cont).textContent     = money(reservado);
  $('#modalTotalRealNAT', cont).textContent = money(real);

  $('#saldoTotNAT', cont).textContent = money(reservado);
  $('#saldoAboNAT', cont).textContent = money(abonado);
  const cN = $('#saldoNAT', cont);
  cN.textContent = money(saldo);
  cN.classList.toggle('saldo-rojo', Math.abs(saldo) > 0.0001);
  cN.classList.toggle('saldo-ok',   Math.abs(saldo) <= 0.0001);

  const rT = $('#resTotNAT', cont), rA = $('#resAboNAT', cont), rS = $('#resSalNAT', cont);
  if (rT) rT.textContent = money(reservado);
  if (rA) rA.textContent = money(abonado);
  if (rS){ rS.textContent = money(saldo); rS.classList.toggle('saldo-rojo', saldo > 0.0001); rS.classList.toggle('saldo-ok', saldo <= 0.0001); }
}


// Submodal (crear/editar)
function abrirSubmodalAbono({ cont, destinoId, servicioId, abono }) {
  const box = $('#submodalAbono', cont);
  box.hidden = false;

  const pairs = cont.__svcPairs || [];
  const selSvc  = $('#abSvc',  box);
  const selDest = $('#abDest', box);
  const selMon  = $('#abMoneda', box);

  // Poblar selects (servicios únicos)
  selSvc.innerHTML = pairs.map(p => `<option value="${p.servicioId}">${p.servicioNombre}</option>`).join('');
  // Default: si viene servicioId, seleccionarlo
  if (servicioId) selSvc.value = servicioId;
  // Destinos asociados al servicio seleccionado
  function refreshDestMon(){
    const svc = selSvc.value;
    const ds = pairs.filter(p => p.servicioId === svc);
    selDest.innerHTML = ds.map(d => `<option value="${d.destinoId}">${d.destinoId}</option>`).join('');
    // moneda (tomo la del primero)
    selMon.value = (ds[0]?.moneda || cont.__nat || 'CLP').toUpperCase();
  }
  refreshDestMon();
  selSvc.onchange = refreshDestMon;

  // Si venían explícitos, forzar selección
  if (destinoId) selDest.value = destinoId;

  $('#abFecha',  box).value = abono?.fecha || nowISODate();
  $('#abMonto',  box).value = abono?.monto || '';
  $('#abNota',   box).value = abono?.nota  || '';
  $('#abFile',   box).value = '';

  const close = () => { box.hidden = true; };
  $('#abCancelar', box).onclick = close;

  $('#abGuardar', box).onclick = async () => {
    const dId = selDest.value;
    const sId = selSvc.value;
    if (!dId || !sId) { alert('Selecciona SERVICIO y DESTINO'); return; }

    const data = {
      fecha: $('#abFecha', box).value,
      moneda: selMon.value,
      monto: Number($('#abMonto', box).value || 0),
      nota:  $('#abNota', box).value.trim(),
      estado: abono ? 'EDITADO' : 'ORIGINAL',
      version: abono?.version || 1,
      comprobanteURL: abono?.comprobanteURL || '',
    };
    const file = $('#abFile', box).files[0] || null;

    await guardarAbono({ destinoId: dId, servicioId: sId, abonoId: abono?.id || null, data, file });

    close();
    // Repintar según modo actual
    // Repintar según modo actual
    if (cont.dataset.curMode === 'ONE' && cont.dataset.curServicioId === sId && cont.dataset.curDestinoId === dId){
      await pintarAbonos({ destinoId: dId, servicioId: sId, servicioNombre: cont.dataset.curServicioNombre || '', cont });
    } else {
      await pintarAbonosTodosProveedor({ data: cont.__provData, cont });
    }
    calcSaldoDesdeTablas(cont);
  };
}

// -------------------------------
// 11) Export Excel (HTML workbook)
// -------------------------------
function exportModalToExcel(cont, nombre) {
  const tables = [
    { title:'RESUMEN',  el: $('#tblProvResumen', cont) },
    { title:'ABONOS',   el: $('#tblAbonos', cont) },
    { title:'DETALLE',  el: $('#tblDetalleProv', cont) },
    { title:'SALDO',    el: $('#tblSaldo', cont) },
  ];
  const htmlSheets = tables.map(t => `<h2>${t.title}</h2>${t.el.outerHTML}<br/>`).join('\n');

  const html = `<!doctype html>
  <html xmlns:o="urn:schemas-microsoft-com:office:office"
        xmlns:x="urn:schemas-microsoft-com:office:excel"
        xmlns="http://www.w3.org/TR/REC-html40">
  <head><meta charset="UTF-8" /></head>
  <body>${htmlSheets}</body></html>`;
  const blob = new Blob([html], { type: 'application/vnd.ms-excel;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `finanzas_${slug(nombre)}_${new Date().toISOString().slice(0,10)}.xls`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function boot() {
  onAuthStateChanged(auth, async () => {
    try {
      await Promise.all([
      loadGrupos(),
      loadServicios(),
      loadProveedores(),
      loadHotelesYAsignaciones(),
      loadRealizaciones()     // ← NUEVO: overlay de HIZO
    ]);
      await cargarTCGuardado();     // ← carga TC persistido (si existe)
      poblarFiltrosBasicos();
      aplicarRangoPorAnio();
      bindUI();
      recalcular();
    } catch (e) {
      console.error('Error cargando datos', e);
    }
  });
}
// -------------------------------
// 12) Recalcular + export CSV
// -------------------------------
function getDestinosSeleccionados() {
  const sel = el('filtroDestino');
  return new Set([...sel.selectedOptions].map(o => o.value));
}
function poblarFiltrosBasicos() {
  const anios = new Set();
  const hoy = new Date();
  const anioActual = hoy.getFullYear();

  for (const g of GRUPOS) {
    const a = Number(g.anoViaje || g.anio || g.year || anioActual);
    if (a) anios.add(a);
  }
  if (!anios.size) { anios.add(anioActual); anios.add(anioActual + 1); }
  const arrAnios = [...anios].sort((a,b)=>a-b);
  el('filtroAnio').innerHTML = arrAnios
    .map(a => `<option value="${a}" ${a===anioActual?'selected':''}>${a}</option>`).join('');

  const dests = [...new Set(GRUPOS.map(g => g.destino).filter(Boolean))]
                 .sort((a,b)=>a.localeCompare(b));

  // “Todos los destinos” (valor *) seleccionado por defecto
  el('filtroDestino').innerHTML =
    `<option value="*" selected>Todos los destinos</option>` +
    dests.map(d => `<option value="${d}">${d}</option>`).join('');
}
function aplicarRangoPorAnio() {
  const anio = el('filtroAnio').value;
  if (!anio) return;
  el('fechaDesde').value = `${anio}-01-01`;
  el('fechaHasta').value = `${anio}-12-31`;
}

function logDiagnostico(items){
  const faltantes = items.filter(x => x.servicioId == null);
  if (faltantes.length){
    const top = {};
    for (const f of faltantes){
      const k = `${norm(f.destinoGrupo)} | ${norm(f.servicio)}`;
      top[k] = (top[k]||0)+1;
    }
    console.group('Actividades SIN match en Servicios (destino+actividad)');
    console.table(Object.entries(top).map(([k,v]) => ({ clave:k, ocurrencias:v })));
    console.groupEnd();
  }
}

function recalcular() {
  const fechaDesde = el('fechaDesde').value || null;
  const fechaHasta = el('fechaHasta').value || null;

  const filtro = getDestinoFilter();
  const inclAct = el('inclActividades').checked;
  const inclHot = el('inclHoteles').checked;

  // include fns
  const includeExactFn = (d) => filtro.all || filtro.tokens.size===0 || filtro.tokens.has(d);
  const includeTokenFn = (d) => filtro.all || filtro.tokens.size===0 ||
                                 [...filtro.tokens].some(tok => norm(d).includes(norm(tok)));

  // KPIs, Destinos y Hoteles: EXACTO
  LINE_ITEMS = construirLineItems(fechaDesde, fechaHasta, includeExactFn, inclAct);
  LINE_HOTEL = construirLineItemsHotel(fechaDesde, fechaHasta, includeExactFn, inclHot);

  logDiagnostico(LINE_ITEMS);

  // KPIs
  renderKPIs(LINE_ITEMS, LINE_HOTEL);

  // Tabla Destinos (con conversiones)
  const mapDest = agruparPorDestino([...LINE_ITEMS, ...LINE_HOTEL]);
  renderTablaDestinos(mapDest);

  // Proveedores: TOKEN + moneda nativa + columnas visibles por destino
  const itemsProv = construirLineItems(fechaDesde, fechaHasta, includeTokenFn, inclAct);
  const mapProvNative = agruparPorProveedorMonedaNativa(itemsProv);
  const visibles = monedasVisiblesFromFilter(filtro);
  renderTablaProveedoresMonedaNativa(mapProvNative, visibles);

  // Hoteles sección (EXACTO)
  const secH = el('secHoteles');
  if (LINE_HOTEL.length) {
    secH.style.display = '';
    const mapHot = agruparPorHotel(LINE_HOTEL);
    renderTablaHoteles(mapHot);
  } else {
    secH.style.display = 'none';
  }
}

function exportCSV() {
  const header = ['Fecha','Proveedor','Servicio','Grupo','Destino','Pax','Modalidad','Moneda','Tarifa','TotalMoneda','TotalCLP'];
  const rows = [header.join(',')];

  for (const it of LINE_ITEMS) {
    const modalidad = `${it.pagoTipo||''}/${it.pagoFrecuencia||''}`;
    const cod = [it.numeroNegocio || it.grupoId, it.identificador].filter(Boolean).join('-');
    const conv = convertirTodas(it.moneda, it.totalMoneda);
    rows.push([
      it.fecha || '',
      (it.proveedor || '').replaceAll(',',' '),
      (it.servicio || '').replaceAll(',',' '),
      ((cod ? `${cod} — ` : '') + (it.nombreGrupo || '')).replaceAll(',',' '),
      (it.destinoGrupo || '').replaceAll(',',' '),
      it.pax || 0,
      modalidad,
      it.moneda || 'CLP',
      it.tarifa || 0,
      it.totalMoneda || 0,
      (typeof conv.CLP === 'number' ? Math.round(conv.CLP) : '')
    ].join(','));
  }

  for (const it of LINE_HOTEL) {
    const cod = [it.numeroNegocio || it.grupoId, it.identificador].filter(Boolean).join('-');
    const conv = convertirTodas(it.moneda, it.totalMoneda);
    rows.push([
      '',
      (it.hotel || '').replaceAll(',',' '),
      `HOTEL (${it.tipoCobro})`,
      ((cod ? `${cod} — ` : '') + (it.nombreGrupo || '')).replaceAll(',',' '),
      (it.destinoGrupo || '').replaceAll(',',' '),
      it.noches || 0,
      it.tipoCobro || '',
      it.moneda || 'CLP',
      it.tarifa || 0,
      it.totalMoneda || 0,
      (typeof conv.CLP === 'number' ? Math.round(conv.CLP) : '')
    ].join(','));
  }

  const blob = new Blob([rows.join('\n')], { type:'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `finanzas_RT_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// -------------------------------
function closeModal() {
  el('backdrop').style.display = 'none';
  el('modal').style.display = 'none';
  document.body.classList.remove('modal-open');
}
window.closeModal = closeModal;

// -------------------------------
// 14) Boot
// -------------------------------
function bindUI() {
  el('filtroAnio').addEventListener('change', () => { aplicarRangoPorAnio(); recalcular(); });
  // Auto-deselección de “Todos los destinos” (*)
  const selDest = el('filtroDestino');
  function enforceTodos() {
    const vals = [...selDest.selectedOptions].map(o => o.value);
    if (vals.includes('*') && vals.length > 1) {
      [...selDest.options].forEach(o => o.selected = (o.value === '*'));
    }
  }
  selDest.addEventListener('change', () => { enforceTodos(); recalcular(); });
  el('fechaDesde').addEventListener('change', recalcular);
  el('fechaHasta').addEventListener('change', recalcular);
  el('inclActividades').addEventListener('change', recalcular);
  el('inclHoteles').addEventListener('change', recalcular);
  el('tcUSD').addEventListener('change', recalcular);
  el('tcBRL').addEventListener('change', recalcular);
  const tcARS = el('tcARS'); if (tcARS) tcARS.addEventListener('change', recalcular);

  el('btnRecalcular').addEventListener('click', recalcular);
  el('btnExportCSV').addEventListener('click', exportCSV);

  // ⬇️ NUEVO: guardar TC persistente
  const btnGuardarTC = el('btnGuardarTC');
  if (btnGuardarTC) btnGuardarTC.addEventListener('click', guardarTCGuardado);

  el('modalClose').addEventListener('click', closeModal);
  el('backdrop').addEventListener('click', closeModal);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
}
boot();
