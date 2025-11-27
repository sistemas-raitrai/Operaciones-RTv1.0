// rendiciones_coordinadores.js
// Rendición de gastos por grupo/coordinador (basado en Revisión financiera v2)

import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, collectionGroup, getDocs, doc, getDoc, updateDoc, setDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

/* ====================== STATE ====================== */
const state = {
  user: null,
  filtros: { coord: '', grupo: '', grupoNombre: '' },
  caches: {
    grupos: new Map(),         // gid -> {numero,nombre,coordEmail,destino,paxTotal,programa,fechas,urls}
    coords: [],                // correos coordinadores
    groupsByCoord: new Map(),  // coordEmail -> Set(gid)
  },
  gastos: [],
  abonos: [],
  summary: null,               // grupos/{gid}/finanzas/summary
  descuento: { monto: 0, asunto: '' },
};

/* ====================== UTILS ====================== */
const norm = (s='') =>
  s.toString().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();

const coalesce = (...xs) =>
  xs.find(v => v !== undefined && v !== null && v !== '') ?? '';

const parseMonto = (any) => {
  if (any == null) return 0;
  if (typeof any === 'number' && isFinite(any)) return Math.round(any);
  const n = parseInt(String(any).replace(/[^\d-]/g,''),10);
  return isFinite(n) ? n : 0;
};

const moneyCLP = n =>
  (isFinite(+n)
    ? (+n).toLocaleString('es-CL',{ style:'currency', currency:'CLP', maximumFractionDigits:0 })
    : '—');

const moneyBy = (n, curr='CLP') =>
  (isFinite(+n)
    ? (+n).toLocaleString('es-CL',{ style:'currency', currency:curr, maximumFractionDigits:2 })
    : '—');

// --- fechas ---
function _toMs(v){
  if (v == null) return 0;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') {
    const t = Date.parse(v); return isFinite(t) ? t : 0;
  }
  if (typeof v === 'object') {
    if ('seconds' in v) return v.seconds*1000 + Math.floor((v.nanoseconds||0)/1e6);
    const t = Date.parse(v); return isFinite(t) ? t : 0;
  }
  return 0;
}
function pickFechaMs(raw){
  const cands = [
    raw.fecha, raw.fechaPago, raw.fechaAbono,
    raw.createdAt, raw.created, raw.ts, raw.at, raw.timestamp, raw.time
  ];
  for (const c of cands){
    const ms = _toMs(c);
    if (ms) return ms;
  }
  return 0;
}
function fmtDDMMYYYY(ms){
  if (!ms) return '';
  const d = new Date(ms);
  const dd = String(d.getDate()).padStart(2,'0');
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

/* ====================== CATALOGOS ====================== */
async function preloadCatalogs() {
  state.caches.grupos.clear();
  state.caches.coords.length = 0;
  state.caches.groupsByCoord.clear();

  const snap = await getDocs(collection(db,'grupos'));
  const dlG = document.getElementById('dl-grupos');
  const dlN = document.getElementById('dl-grupos-nombre');
  const dlC = document.getElementById('dl-coords');

  if (dlG) dlG.innerHTML = '';
  if (dlN) dlN.innerHTML = '';
  if (dlC) dlC.innerHTML = '';


  snap.forEach(d => {
    const x   = d.data() || {};
    const gid = d.id;

    const numero   = coalesce(x.numeroNegocio, x.numNegocio, x.idNegocio, gid);
    const nombre   = coalesce(x.nombreGrupo, x.aliasGrupo, x.nombre, x.grupo, gid);
    const coordEmail = coalesce(
      x.coordinadorEmail, x.coordinador?.email, x.coordinador,
      x.coord, x.responsable, x.owner, ''
    ).toLowerCase();
    const destino  = coalesce(x.destino, x.lugar, '');
    const paxTotal = Number(x.paxTotal || x.pax || x.pax_total || 0);
    const programa = coalesce(x.programa, x.plan, '');
    const fechas   = coalesce(x.fechas, x.fechaDeViaje, x.fechaViaje, '');

    state.caches.grupos.set(gid, {
      numero, nombre, coordEmail, destino, paxTotal, programa, fechas,
      urls:{
        boleta: x?.finanzas?.boletaUrl || x.boletaUrl || '',
        comprobante: x?.finanzas?.comprobanteUrl || x.comprobanteUrl || '',
        transferenciaCoord: x?.finanzas?.transferenciaCoordUrl || x.transferenciaCoordUrl || ''
      }
    });

    if (coordEmail) {
      if (!state.caches.groupsByCoord.has(coordEmail)) {
        state.caches.groupsByCoord.set(coordEmail, new Set());
      }
      state.caches.groupsByCoord.get(coordEmail).add(gid);
      if (!state.caches.coords.includes(coordEmail)) {
        state.caches.coords.push(coordEmail);
      }
    }

    if (dlG) {
      const opt = document.createElement('option');
      opt.value = gid;                          // busca por ID / nº negocio
      opt.label = `${numero} — ${nombre}`;
      dlG.appendChild(opt);
    }

    if (dlN) {
      const optN = document.createElement('option');
      optN.value = nombre;                      // busca por nombre de grupo
      optN.label = `${numero} — ${nombre}`;
      dlN.appendChild(optN);
    }
  });

  if (dlC) {
    for (const email of state.caches.coords) {
      const opt = document.createElement('option');
      opt.value = email;
      opt.label = email;
      dlC.appendChild(opt);
    }
  }
}


/* ====================== NORMALIZADOR ====================== */
function gastoToItem(grupoId, gInfo, raw, coordFromPath) {
  const brutoMonto = coalesce(
    raw.monto, raw.montoCLP, raw.neto, raw.importe,
    raw.valor, raw.total, raw.totalCLP, raw.monto_str, 0
  );
  const monto   = parseMonto(brutoMonto);
  const moneda  = (raw.moneda || raw.currency || 'CLP').toString().toUpperCase();
  const montoAprobadoRaw = coalesce(
    raw.montoAprobado, raw.aprobado, raw.monto_aprobado, null
  );
  const montoAprobado = (montoAprobadoRaw == null) ? monto : parseMonto(montoAprobadoRaw);

  const asunto = coalesce(raw.asunto, raw.detalle, raw.descripcion, raw.concepto, raw.motivo, '');
  const autor  = coalesce(raw.autor, raw.user, raw.creadoPor, raw.email, gInfo?.coordEmail || '', '');

  const fechaMs  = pickFechaMs(raw);
  const fechaTxt = fechaMs ? fmtDDMMYYYY(fechaMs) : '';

  const rend = raw.rendicion || {};

  return {
    id: raw.id || raw._id || '',
    grupoId,
    nombreGrupo: gInfo?.nombre || '',
    numeroNegocio: gInfo?.numero || grupoId,
    coordinador: coordFromPath || gInfo?.coordEmail || '',
    asunto,
    autor,
    monto,
    moneda,
    montoAprobado,
    fechaMs,
    fechaTxt,
    rendOk: !!rend.ok,
  };
}

/* ====================== LECTURA DE DATOS ====================== */
// GASTOS — collectionGroup('gastos')
async function fetchGastosByGroup({ coordEmailHint = '', grupoId = '' } = {}) {
  const out = [];
  try {
    const normCoord = (s='') =>
      s.toString()
       .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
       .toLowerCase()
       .replace(/[\s_]+/g,'-')
       .trim();

    const hint = normCoord(coordEmailHint);

    const snap = await getDocs(collectionGroup(db,'gastos'));
    snap.forEach(docSnap => {
      const raw = docSnap.data() || {};

      const gid = coalesce(
        raw.grupoId, raw.grupo_id, raw.gid, raw.idGrupo,
        raw.grupo, raw.id_grupo,
        (raw.numeroNegocio && raw.identificador)
          ? `${raw.numeroNegocio}-${raw.identificador}` : ''
      );
      if (!gid) return;
      if (grupoId && gid !== grupoId) return;

      const coordFromPath = (docSnap.ref.parent.parent?.id || '').toLowerCase();

      if (hint) {
        const blob = [
          normCoord(coordFromPath),
          normCoord(raw.coordinadorEmail || ''),
          normCoord(raw.coordinador || '')
        ].join(' ');
        if (!blob.includes(hint)) return;
      }

      const gInfo = state.caches.grupos.get(gid) ||
                    { numero: gid, nombre:'', coordEmail: coordFromPath };

      const item = gastoToItem(gid, gInfo, { id: docSnap.id, ...raw }, coordFromPath);
      out.push(item);
    });
  } catch (e) {
    console.warn('[REN] fetchGastosByGroup', e);
  }
  return out;
}

// ABONOS — grupos/{gid}/finanzas_abonos/*
async function fetchAbonosByGroup(gid) {
  const out = [];
  if (!gid) return out;
  try {
    const ref  = collection(db,'grupos',gid,'finanzas_abonos');
    const snap = await getDocs(ref);
    const gInfo = state.caches.grupos.get(gid) || { numero: gid, nombre:'', coordEmail:'' };

    snap.forEach(d => {
      const x = d.data() || {};
      const brutoMonto = coalesce(
        x.monto, x.montoCLP, x.neto, x.importe,
        x.valor, x.total, x.totalCLP, x.monto_str, 0
      );
      const monto  = parseMonto(brutoMonto);
      const moneda = (x.moneda || x.currency || 'CLP').toString().toUpperCase();
      const fechaMs  = pickFechaMs(x);
      const fechaTxt = fechaMs ? fmtDDMMYYYY(fechaMs) : '';
      const asunto   = coalesce(x.asunto, x.detalle, x.descripcion, x.concepto, 'ABONO');

      out.push({
        id: d.id,
        grupoId: gid,
        nombreGrupo: gInfo.nombre,
        numeroNegocio: gInfo.numero,
        asunto,
        monto,
        moneda,
        fechaMs,
        fechaTxt,
      });
    });
  } catch (e) {
    console.warn('[REN] fetchAbonosByGroup', e);
  }
  return out;
}

// SUMMARY — grupos/{gid}/finanzas/summary
async function loadSummaryForGroup(gid) {
  state.summary   = null;
  state.descuento = { monto: 0, asunto: '' };
  if (!gid) return;
  try {
    const ref  = doc(db,'grupos',gid,'finanzas','summary');
    const snap = await getDoc(ref);
    if (snap.exists()) {
      const data = snap.data() || {};
      state.summary = data;
      if (data.descuento) {
        state.descuento = {
          monto: Number(data.descuento.monto || 0),
          asunto: data.descuento.asunto || ''
        };
      }
    }
  } catch (e) {
    console.warn('[REN] loadSummaryForGroup', e);
  }
}

// Carga principal
async function loadDataForCurrentFilters() {
  state.gastos = [];
  state.abonos = [];

  let gid   = state.filtros.grupo || '';
  const coord = (state.filtros.coord || '').toLowerCase();
  const nombreGrupo = (state.filtros.grupoNombre || '').trim();

  // Si no hay gid pero sí nombre de grupo, lo buscamos en el catálogo
  if (!gid && nombreGrupo) {
    for (const [id, info] of state.caches.grupos.entries()) {
      if (
        info.nombre === nombreGrupo ||
        `${info.numero} — ${info.nombre}` === nombreGrupo
      ) {
        gid = id;
        state.filtros.grupo = id;
        break;
      }
    }
  }

  if (!gid && !coord) return;

  const gInfo = gid ? state.caches.grupos.get(gid) : null;
  const coordHint = coord || (gInfo?.coordEmail || '');


  const [gastos, abonos] = await Promise.all([
    fetchGastosByGroup({ coordEmailHint: coordHint, grupoId: gid }),
    gid ? fetchAbonosByGroup(gid) : Promise.resolve([])
  ]);

  state.gastos = gastos;
  state.abonos = abonos;
  await loadSummaryForGroup(gid);
}

/* ====================== ESCRITURA ====================== */
async function saveMontoAprobado(item, nuevoMonto) {
  const gid   = item.grupoId;
  const coord = item.coordinador;
  if (!gid || !coord || !item.id) return false;

  const val = parseMonto(nuevoMonto);
  try {
    const ref = doc(db,'coordinadores',coord,'gastos',item.id);
    await updateDoc(ref, {
      montoAprobado: val,
      'rendicion.ok': true,
      'rendicion.by': (auth.currentUser?.email || '').toLowerCase(),
      'rendicion.at': Date.now()
    });
    item.montoAprobado = val;
    item.rendOk = true;
    return true;
  } catch (e) {
    console.error('[REN] saveMontoAprobado', e);
    alert('No se pudo guardar el monto aprobado.');
    return false;
  }
}

async function guardarDescuento(gid) {
  const monto  = parseMonto(document.getElementById('descuentoMonto').value || 0);
  const asunto = (document.getElementById('descuentoAsunto').value || '').trim();
  state.descuento = { monto, asunto };
  try {
    const ref = doc(db,'grupos',gid,'finanzas','summary');
    await setDoc(ref, {
      descuento: {
        monto,
        asunto,
        by: (auth.currentUser?.email || '').toLowerCase(),
        at: Date.now()
      }
    }, { merge:true });
    alert('Descuento guardado.');
  } catch (e) {
    console.error('[REN] guardarDescuento', e);
    alert('No se pudo guardar el descuento.');
  }
}

async function guardarDocsOk(gid) {
  const chkB = document.getElementById('chkBoletaOk');
  const chkC = document.getElementById('chkComprobanteOk');
  const chkT = document.getElementById('chkTransferenciaOk');

  const docBoletaOk = chkB ? !!chkB.checked : false;
  const docCompOk   = chkC ? !!chkC.checked : false;
  const docTransfOk = chkT ? !!chkT.checked : false;

  try {
    const ref = doc(db,'grupos',gid,'finanzas','summary');
    await setDoc(ref, {
      docsOk: {
        boleta: docBoletaOk,
        comprobante: docCompOk,
        transferencia: docTransfOk,
        by: (auth.currentUser?.email || '').toLowerCase(),
        at: Date.now()
      }
    }, { merge:true });
    alert('Estado de documentos guardado.');
  } catch (e) {
    console.error('[REN] guardarDocsOk', e);
    alert('No se pudo guardar el estado de documentos.');
  }
}

/* ====================== RENDER TABLA ====================== */
function renderTablaGastos() {
  const tbody      = document.querySelector('#tblGastos tbody');
  const resumenEl  = document.getElementById('resumenTabla');
  if (!tbody) return;

  const rows = state.gastos.slice().sort((a,b)=> (a.fechaMs||0) - (b.fechaMs||0));

  tbody.innerHTML = '';
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.innerHTML = '<div class="muted">Sin gastos registrados para este criterio.</div>';
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    const frag = document.createDocumentFragment();
    rows.forEach(item => {
      const tr = document.createElement('tr');

      const tdFecha  = document.createElement('td');
      const tdAsunto = document.createElement('td');
      const tdAutor  = document.createElement('td');
      const tdMon    = document.createElement('td');
      const tdMonto  = document.createElement('td');
      const tdMontoAprob = document.createElement('td');
      const tdChk    = document.createElement('td');

      tdFecha.textContent  = item.fechaTxt || '—';
      tdAsunto.textContent = item.asunto || '—';
      tdAutor.textContent  = item.autor || item.coordinador || '—';
      tdMon.textContent    = item.moneda || 'CLP';
      tdMonto.innerHTML    = `<span class="mono">${moneyBy(item.monto, item.moneda||'CLP')}</span>`;

      const wrap = document.createElement('div');
      wrap.className = 'monto-aprob-wrap rev-cell';

      const inp = document.createElement('input');
      inp.type = 'number';
      inp.step = '1';
      inp.min  = '0';
      inp.inputMode = 'numeric';
      inp.className = 'mono monto-aprob-input';
      inp.value = isFinite(+item.montoAprobado) ? +item.montoAprobado : +item.monto;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'revbtn ghost';
      btn.title = 'Guardar monto aprobado (y marcar rendido)';
      btn.textContent = '💾';

      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = !!item.rendOk;
      chk.title = 'Marcar gasto incluido en rendición';
      // el check se fuerza a true cuando se guarda el monto

      const doSave = async () => {
        const val = parseMonto(inp.value);
        const ok  = await saveMontoAprobado(item, val);
        if (ok) {
          chk.checked = true;
          wrap.classList.add('saved');
          setTimeout(()=> wrap.classList.remove('saved'), 800);
          renderResumenFinanzas();
        }
      };

      btn.onclick = doSave;
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doSave();
      });

      wrap.append(btn, inp);
      tdMontoAprob.appendChild(wrap);
      tdChk.appendChild(chk);

      tr.append(tdFecha, tdAsunto, tdAutor, tdMon, tdMonto, tdMontoAprob, tdChk);
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
  }

  if (resumenEl) {
    resumenEl.textContent = `Mostrando ${rows.length} gastos.`;
  }
}

/* ====================== RESUMEN + PRINT ====================== */
function renderResumenFinanzas() {
  const gid   = state.filtros.grupo || '';
  const gInfo = gid ? state.caches.grupos.get(gid) : null;

  if (gInfo) {
    const elGrupo   = document.getElementById('infoGrupo');
    const elCoord   = document.getElementById('infoCoord');
    const elDestino = document.getElementById('infoDestino');
    const elPax     = document.getElementById('infoPax');
    const elProg    = document.getElementById('infoPrograma');
    const elFechas  = document.getElementById('infoFechas');

    if (elGrupo)   elGrupo.textContent   = `${gInfo.numero} — ${gInfo.nombre}`;
    if (elCoord)   elCoord.textContent   = gInfo.coordEmail || '—';
    if (elDestino) elDestino.textContent = gInfo.destino || '—';
    if (elPax)     elPax.textContent     = gInfo.paxTotal ? `${gInfo.paxTotal}` : '—';
    if (elProg)    elProg.textContent    = gInfo.programa || '—';
    if (elFechas)  elFechas.textContent  = gInfo.fechas || '—';
  }

  const totalGastos = state.gastos
    .reduce((s,it)=> s + (isFinite(+it.montoAprobado) ? +it.montoAprobado : +it.monto), 0);
  const totalAbonos = state.abonos
    .reduce((s,it)=> s + (Number(it.monto) || 0), 0);

  const saldo     = totalAbonos - totalGastos;
  const descMonto = state.descuento.monto || 0;
  const saldoNeto = saldo - descMonto;

  const elAbonos    = document.getElementById('sumAbonos');
  const elGastos    = document.getElementById('sumGastos');
  const elSaldo     = document.getElementById('sumSaldo');
  const elSaldoNeto = document.getElementById('sumSaldoNeto');

  if (elAbonos)    elAbonos.textContent    = moneyCLP(totalAbonos);
  if (elGastos)    elGastos.textContent    = moneyCLP(totalGastos);
  if (elSaldo)     elSaldo.textContent     = moneyCLP(saldo);
  if (elSaldoNeto) elSaldoNeto.textContent = moneyCLP(saldoNeto);

  const inDescMonto  = document.getElementById('descuentoMonto');
  const inDescAsunto = document.getElementById('descuentoAsunto');
  if (inDescMonto)  inDescMonto.value  = state.descuento.monto || 0;
  if (inDescAsunto) inDescAsunto.value = state.descuento.asunto || '';

  // links docs
  if (gInfo) {
    const boletaUrl = gInfo.urls?.boleta || '';
    const compUrl   = gInfo.urls?.comprobante || '';
    const transfUrl = gInfo.urls?.transferenciaCoord || '';

    const linkBoleta = document.getElementById('linkBoleta');
    const linkComp   = document.getElementById('linkComprobante');
    const linkTransf = document.getElementById('linkTransferencia');

    if (linkBoleta) {
      if (boletaUrl) { linkBoleta.href = boletaUrl; linkBoleta.textContent = 'VER'; }
      else { linkBoleta.href = '#'; linkBoleta.textContent = '—'; }
    }
    if (linkComp) {
      if (compUrl) { linkComp.href = compUrl; linkComp.textContent = 'VER'; }
      else { linkComp.href = '#'; linkComp.textContent = '—'; }
    }
    if (linkTransf) {
      if (transfUrl) { linkTransf.href = transfUrl; linkTransf.textContent = 'VER'; }
      else { linkTransf.href = '#'; linkTransf.textContent = '—'; }
    }
  }

  // checkboxes docs desde summary
  if (state.summary && state.summary.docsOk) {
    const chkB = document.getElementById('chkBoletaOk');
    const chkC = document.getElementById('chkComprobanteOk');
    const chkT = document.getElementById('chkTransferenciaOk');
    if (chkB) chkB.checked = !!state.summary.docsOk.boleta;
    if (chkC) chkC.checked = !!state.summary.docsOk.comprobante;
    if (chkT) chkT.checked = !!state.summary.docsOk.transferencia;
  }

  renderPrintSheet();
}

function renderPrintSheet() {
  const gid   = state.filtros.grupo || '';
  const gInfo = gid ? state.caches.grupos.get(gid) : null;
  const print = document.getElementById('printSheet');
  if (!print || !gInfo) return;

  const totalGastos = state.gastos
    .reduce((s,it)=> s + (isFinite(+it.montoAprobado) ? +it.montoAprobado : +it.monto), 0);
  const totalAbonos = state.abonos
    .reduce((s,it)=> s + (Number(it.monto) || 0), 0);

  const saldo     = totalAbonos - totalGastos;
  const desc      = state.descuento.monto || 0;
  const saldoNeto = saldo - desc;

  const lines = [];

  lines.push(`GASTOS DEL GRUPO`.padEnd(40) + `${gInfo.nombre} (${gInfo.numero})`);
  lines.push('');
  lines.push(`COORDINADOR(A): ${gInfo.coordEmail || ''}`);
  lines.push(`DESTINO:        ${gInfo.destino || ''}`);
  lines.push(`PAX TOTAL:      ${gInfo.paxTotal || ''}`);
  lines.push(`PROGRAMA:       ${gInfo.programa || ''}`);
  lines.push(`FECHAS:         ${gInfo.fechas || ''}`);
  lines.push('');
  lines.push('RESUMEN FINANZAS');
  lines.push(`  ABONOS: ${moneyCLP(totalAbonos)}`);
  lines.push(`  GASTOS: ${moneyCLP(totalGastos)}`);
  lines.push(`  SALDO:  ${moneyCLP(saldo)}`);
  if (desc) {
    lines.push(`  DESCTO: ${moneyCLP(desc)} — ${state.descuento.asunto || ''}`);
    lines.push(`  NETO:   ${moneyCLP(saldoNeto)}`);
  }
  lines.push('');
  lines.push('DETALLE DE GASTOS:');
  state.gastos
    .slice()
    .sort((a,b)=> (a.fechaMs||0)-(b.fechaMs||0))
    .forEach(it => {
      const fecha = it.fechaTxt || '--';
      const monto = moneyBy(it.montoAprobado || it.monto, it.moneda || 'CLP');
      lines.push(`  ${fecha}  ${monto}  ${it.asunto || ''}`);
    });

  print.textContent = lines.join('\n');
}

/* ====================== WIRING UI ====================== */
function wireUI() {
  // logout (viene del encabezado)
  try {
    document.querySelector('#btn-logout')
      ?.addEventListener('click', () =>
        signOut(auth).then(()=> location.href='login.html'));
  } catch (_) {}

  // coord ⇒ limita grupos
  const inputCoord = document.getElementById('filtroCoord');
  if (inputCoord) {
    inputCoord.addEventListener('input', (e) => {
      const val = (e.target.value || '').toLowerCase().trim();
      state.filtros.coord = val;

      const dlG = document.getElementById('dl-grupos');
      if (!dlG) return;
      dlG.innerHTML = '';

      if (state.caches.groupsByCoord.has(val)) {
        for (const gid of state.caches.groupsByCoord.get(val)) {
          const info = state.caches.grupos.get(gid);
          const opt = document.createElement('option');
          opt.value = gid;
          opt.label = `${info.numero} — ${info.nombre}`;
          dlG.appendChild(opt);
        }
      } else {
        for (const [gid,info] of state.caches.grupos.entries()) {
          const opt = document.createElement('option');
          opt.value = gid;
          opt.label = `${info.numero} — ${info.nombre}`;
          dlG.appendChild(opt);
        }
      }
    });
  }

  // grupo
  const inputGrupo = document.getElementById('filtroGrupo');
  if (inputGrupo) {
    inputGrupo.addEventListener('input', (e) => {
      state.filtros.grupo = e.target.value || '';
    });
  }

    // nombre de grupo (usa datalist de nombres, resuelve gid automático)
  const inputNombreGrupo = document.getElementById('filtroNombreGrupo');
  if (inputNombreGrupo) {
    inputNombreGrupo.addEventListener('input', (e) => {
      const val = (e.target.value || '').trim();
      state.filtros.grupoNombre = val;

      if (!val) return;

      for (const [gid, info] of state.caches.grupos.entries()) {
        if (
          info.nombre === val ||
          `${info.numero} — ${info.nombre}` === val
        ) {
          state.filtros.grupo = gid;
          const inpG = document.getElementById('filtroGrupo');
          if (inpG) inpG.value = gid;   // refleja en el campo de ID
          break;
        }
      }
    });
  }


  // Cargar datos
  const btnCargar = document.getElementById('btnCargar');
  if (btnCargar) {
    btnCargar.addEventListener('click', async () => {
      const gid = state.filtros.grupo || '';
      if (!gid && !state.filtros.coord) {
        alert('Selecciona al menos un grupo o un coordinador.');
        return;
      }
      const pagInfo = document.getElementById('pagInfo');
      if (pagInfo) pagInfo.textContent = 'Cargando datos…';
      await loadDataForCurrentFilters();
      renderTablaGastos();
      renderResumenFinanzas();
      if (pagInfo) pagInfo.textContent = 'Listo.';
    });
  }

  // Guardar descuento
  const btnGuardarDesc = document.getElementById('btnGuardarDescuento');
  if (btnGuardarDesc) {
    btnGuardarDesc.addEventListener('click', async () => {
      const gid = state.filtros.grupo || '';
      if (!gid) { alert('Selecciona un grupo.'); return; }
      await guardarDescuento(gid);
      renderResumenFinanzas();
    });
  }

  // Guardar docs OK
  const btnGuardarDocs = document.getElementById('btnGuardarDocs');
  if (btnGuardarDocs) {
    btnGuardarDocs.addEventListener('click', async () => {
      const gid = state.filtros.grupo || '';
      if (!gid) { alert('Selecciona un grupo.'); return; }
      await guardarDocsOk(gid);
    });
  }

  // Imprimir
  const btnPrint = document.getElementById('btnImprimirRendicion');
  if (btnPrint) {
    btnPrint.addEventListener('click', () => {
      const gid = state.filtros.grupo || '';
      if (!gid) { alert('Selecciona un grupo.'); return; }
      renderPrintSheet();
      window.print();
    });
  }
}

/* ====================== ARRANQUE ====================== */
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    location.href = 'login.html';
    return;
  }
  state.user = user;

  await preloadCatalogs();
  wireUI();
  renderTablaGastos();
  renderResumenFinanzas();
});
