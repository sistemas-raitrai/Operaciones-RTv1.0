// costos_grupo.js — Costos por Grupo (PAX contable + costos servicios)
// Colecciones usadas:
// - grupos
// - Servicios/{DESTINO}/Listado/{SERVICIO}
// Reglas:
// - paxContable = paxReales - paxLiberados (fallback a pax base)
// - por_pax => tarifa * paxContable
// - por_grupo => tarifa
// - por_dia => 1 vez por día (si aparece el servicio ese día)

// Firebase
import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import { collection, getDocs } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

// ---------- helpers ----------
const el = (id) => document.getElementById(id);
const fmt = (n) => (n ?? 0).toLocaleString('es-CL');
const money = (n) => '$' + fmt(Math.round(n || 0));
const norm = (s) => (s || '').toString().normalize('NFD').replace(/\p{Diacritic}/gu,'').toUpperCase().trim();
const slug = (s) => (s || '').toString().normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase().trim().replace(/[^a-z0-9]+/g,'-');

function parseNumber(val){
  if (typeof val === 'number') return val;
  const s = (val ?? '').toString().trim();
  if (!s) return 0;
  const clean = s.replace(/[^\d,.\-]/g,'').replace(/\.(?=\d{3}(?:\D|$))/g,'').replace(',', '.');
  const n = Number(clean);
  return isNaN(n) ? 0 : n;
}

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

function paxBaseDeGrupo(g){
  // intenta campos típicos
  const baseDirect = Number(g.cantidadPax || g.cantidadgrupo || g.pax || g.PAX || 0);
  const a = Number(g.adultos || g.ADULTOS || 0);
  const e = Number(g.estudiantes || g.ESTUDIANTES || 0);
  return (a + e) || baseDirect || 0;
}

function paxContableDeGrupo(g){
  const base = paxBaseDeGrupo(g);

  // tus campos (ajusta nombres si difieren)
  const paxReales    = Number(g.paxReales ?? g.paxReal ?? g.paxFinal ?? g.PAXFINAL ?? 0);
  const paxLiberados = Number(g.paxLiberados ?? g.liberados ?? 0);

  // si no existe paxReales, usamos base
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

// TC pivot USD -> otras
function pickTC(moneda){
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

function convertirCLP(monedaOrigen, monto){
  const from = normalizarMoneda(monedaOrigen);
  const rFrom = pickTC(from);  // unidades FROM por 1 USD
  const rCLP  = pickTC('CLP');

  // a USD
  let usd = null;
  if (from === 'USD') usd = Number(monto || 0);
  else if (rFrom) usd = (Number(monto || 0) / rFrom);

  // USD a CLP
  if (usd == null || !rCLP) return null;
  return usd * rCLP;
}

function labelModo(pagoTipo){
  if (pagoTipo === 'por_pax') return 'POR PAX';
  if (pagoTipo === 'por_grupo') return 'POR GRUPO';
  if (pagoTipo === 'por_dia') return 'POR DÍA';
  return 'OTRO';
}

// ---------- state ----------
const auth = getAuth(app);

let GRUPOS = [];
let SERVICIOS = []; // flatten Servicios/*/Listado/*
let SERV_BY_DEST_ACT = new Map(); // key: DESTINO||ACT_NORM -> svc

// ---------- load data ----------
async function loadGrupos(){
  const snap = await getDocs(collection(db, 'grupos'));
  GRUPOS = snap.docs.map(d => ({ id:d.id, ...d.data() }));
}

async function loadServicios(){
  // Servicios/{DESTINO}/Listado/{SERVICIO}
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

  // index para resolver rápido
  SERV_BY_DEST_ACT.clear();
  for (const s of SERVICIOS){
    const dest = s.destino || s.DESTINO || s.ciudad || s.CIUDAD || '';
    const act  = s.servicio || s.actividad || s.nombre || s.id || '';
    const k = `${norm(dest)}||${norm(act)}`;
    if (!SERV_BY_DEST_ACT.has(k)) SERV_BY_DEST_ACT.set(k, s);
  }
}

function resolverServicio(itemActividad, destinoGrupo){
  const act = norm(itemActividad?.actividad || itemActividad?.servicio || '');
  const dest = norm(destinoGrupo || '');

  // match exact dest+act
  const k = `${dest}||${act}`;
  if (SERV_BY_DEST_ACT.has(k)) return SERV_BY_DEST_ACT.get(k);

  // fallback por act (primer match)
  const cand = SERVICIOS.find(s => norm(s.servicio || s.actividad || s.nombre || '') === act);
  return cand || null;
}

// ---------- UI ----------
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
      const cod = [g.numeroNegocio || g.id, g.identificador].filter(Boolean).join('-');
      const nom = g.nombreGrupo || g.NOMBRE || '';
      const dest = g.destino || g.DESTINO || g.ciudad || '';
      return { id:g.id, label:`${cod} — ${nom}`.trim(), dest };
    })
    .sort((a,b)=>a.label.localeCompare(b.label,'es'));

  const sel = el('selGrupo');
  sel.innerHTML = `<option value="">— Selecciona —</option>` + groups.map(x => `<option value="${x.id}">${x.label}</option>`).join('');
}

function setLog(msg){
  el('log').textContent = msg || '—';
}

function paintKPIs(g){
  const { base, reales, liberados, contable } = paxContableDeGrupo(g);
  el('kpiPaxBase').textContent = fmt(base);
  el('kpiPaxReales').textContent = fmt(reales);
  el('kpiPaxLiberados').textContent = fmt(liberados);
  el('kpiPaxContable').textContent = fmt(contable);

  const cod = [g.numeroNegocio || g.id, g.identificador].filter(Boolean).join('-');
  const nom = g.nombreGrupo || g.NOMBRE || '';
  const dest = g.destino || g.DESTINO || g.ciudad || '';
  const prog = g.programa || g.PROGRAMA || '';
  el('grupoInfo').innerHTML = `<span class="ok">${cod}</span> • ${nom} • <b>${dest}</b> • ${prog}`;
}

function calcCostosPorGrupo(g){
  const destinoGrupo = g.destino || g.DESTINO || g.ciudad || '';
  const { contable: paxContable } = paxContableDeGrupo(g);

  const fDesde = el('fechaDesde').value || null;
  const fHasta = el('fechaHasta').value || null;

  const it = g.itinerario || {};
  const seenDia = new Set(); // fecha||servicioId (para por_dia)

  // map servicioId -> agg
  const map = new Map();

  const add = ({ servicioId, servicioNombre, proveedor, moneda, pagoTipo, tarifa, unidades, totalNativo }) => {
    const key = servicioId || `NOID||${servicioNombre}||${proveedor}`;
    const acc = map.get(key) || {
      servicioId: servicioId || null,
      servicio: servicioNombre || '(sin servicio)',
      proveedor: proveedor || '(sin proveedor)',
      moneda: normalizarMoneda(moneda || 'CLP'),
      pagoTipo,
      tarifa: Number(tarifa || 0),
      unidades: 0,
      totalNativo: 0,
    };
    acc.unidades += Number(unidades || 0);
    acc.totalNativo += Number(totalNativo || 0);
    // si vienen mixtos, nos quedamos con el primero (lo típico: 1 servicio = 1 moneda)
    map.set(key, acc);
  };

  let itemsCount = 0;
  for (const fechaISO of Object.keys(it)){
    if (!within(fechaISO, fDesde, fHasta)) continue;
    const arr = Array.isArray(it[fechaISO]) ? it[fechaISO] : [];
    for (const item of arr){
      const svc = resolverServicio(item, destinoGrupo);
      if (!svc) continue;

      const moneda = normalizarMoneda(svc.moneda || svc.MONEDA || 'CLP');
      const tipoCobroRaw = (svc.tipoCobro || svc.tipo_cobro || '').toString();
      const pagoTipo = parsePagoTipo(tipoCobroRaw);

      const valor = Number(svc.valorServicio ?? svc.valor_servicio ?? svc.valor ?? svc.precio ?? 0);
      const servicioNombre = svc.servicio || item.actividad || item.servicio || svc.id;
      const proveedor = svc.proveedor || item.proveedor || '(sin proveedor)';
      const servicioId = svc.id || null;

      let unidades = 0;
      let totalNativo = 0;

      if (pagoTipo === 'por_pax'){
        unidades = paxContable;            // “unidades” = pax contable
        totalNativo = valor * paxContable;
      } else if (pagoTipo === 'por_grupo'){
        unidades = 1;
        totalNativo = valor;
      } else if (pagoTipo === 'por_dia'){
        // 1 vez por día si aparece el servicio ese día
        const k = `${fechaISO}||${servicioId || slug(servicioNombre)}`;
        if (seenDia.has(k)) continue;
        seenDia.add(k);
        unidades = 1;                      // “unidades” = días
        totalNativo = valor;
      } else {
        // OTRO: lo mostramos pero sin sumar
        unidades = 0;
        totalNativo = 0;
      }

      add({ servicioId, servicioNombre, proveedor, moneda, pagoTipo, tarifa: valor, unidades, totalNativo });
      itemsCount++;
    }
  }

  const rows = [...map.values()].sort((a,b)=> (b.totalNativo||0) - (a.totalNativo||0));
  return { rows, itemsCount };
}

function renderTabla(rows){
  const tb = el('tbl').querySelector('tbody');
  tb.innerHTML = '';

  let sumNativo = 0;
  let sumCLP = 0;

  for (const r of rows){
    const clpEq = convertirCLP(r.moneda, r.totalNativo);
    if (clpEq != null) sumCLP += clpEq;

    sumNativo += (r.totalNativo || 0);

    const pillClass = r.pagoTipo === 'por_pax' ? 'pax' : r.pagoTipo === 'por_grupo' ? 'grp' : r.pagoTipo === 'por_dia' ? 'dia' : '';
    tb.insertAdjacentHTML('beforeend', `
      <tr>
        <td title="${r.servicio}">${r.servicio}</td>
        <td title="${r.proveedor}">${r.proveedor}</td>
        <td>${r.moneda}</td>
        <td><span class="pill ${pillClass}">${labelModo(r.pagoTipo)}</span></td>
        <td class="right" title="${r.tarifa}">${fmt(r.tarifa)}</td>
        <td class="right" title="${r.unidades}">${fmt(r.unidades)}</td>
        <td class="right" title="${r.totalNativo}">${fmt(r.totalNativo)}</td>
        <td class="right" title="${clpEq ?? ''}">${clpEq == null ? '—' : money(clpEq)}</td>
      </tr>
    `);
  }

  el('totNativo').textContent = fmt(sumNativo);
  el('totCLP').textContent = sumCLP ? money(sumCLP) : '—';
  el('kpiTotalCLP').textContent = sumCLP ? money(sumCLP) : '—';
}

function exportTableToExcelVisible(){
  // Exporta SOLO lo que se ve (tbody actual)
  const table = el('tbl').cloneNode(true);

  // deja el footer tal cual
  // arma un HTML compatible con Excel
  const html = `
    <html>
    <head><meta charset="UTF-8"></head>
    <body>
      <h3>Costos por Grupo</h3>
      ${table.outerHTML}
    </body>
    </html>
  `;

  const blob = new Blob([html], { type: 'application/vnd.ms-excel;charset=utf-8;' });
  const a = document.createElement('a');
  const gid = el('selGrupo').value || 'grupo';
  a.href = URL.createObjectURL(blob);
  a.download = `costos_${gid}.xls`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href), 1500);
}

// ---------- main ----------
async function boot(){
  onAuthStateChanged(auth, (user)=>{
    el('who').textContent = user?.email ? `Conectado: ${user.email}` : '—';
  });

  setLog('Cargando grupos y servicios…');

  await Promise.all([loadGrupos(), loadServicios()]);

  fillDestinoFilter();
  fillGrupoSelect();

  // default rango fechas: si el grupo tiene fechas, igual puedes ajustar luego
  const today = new Date().toISOString().slice(0,10);
  el('fechaHasta').value = today;

  el('filtroDestino').addEventListener('change', ()=> fillGrupoSelect());
  el('btnCalcular').addEventListener('click', ()=>{
    const gid = el('selGrupo').value;
    if (!gid) { alert('Selecciona un grupo'); return; }
    const g = GRUPOS.find(x => x.id === gid);
    if (!g) { alert('Grupo no encontrado'); return; }

    paintKPIs(g);
    const { rows, itemsCount } = calcCostosPorGrupo(g);
    renderTabla(rows);

    setLog(`OK • servicios calculados: ${rows.length} • items de itinerario procesados: ${itemsCount}`);
  });

  el('btnExport').addEventListener('click', ()=>{
    const gid = el('selGrupo').value;
    if (!gid) { alert('Selecciona un grupo'); return; }
    exportTableToExcelVisible();
  });

  setLog('Listo. Selecciona un grupo y presiona CALCULAR.');
}

boot().catch(e=>{
  console.error(e);
  setLog('Error cargando datos. Revisa consola.');
});
