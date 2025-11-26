// rendiciones_coordinadores.js
// Pantalla para revisar y rendir gastos a partir de finanzas_snapshots

import { app, db } from './firebase-init.js';
import {
  getAuth,
  onAuthStateChanged,
  signOut
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';

import {
  collection,
  getDocs,
  doc,
  getDoc,
  updateDoc,
  query,
  orderBy,
  limit
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

/* ====================== STATE ====================== */

const state = {
  user: null,

  gruposIndex: new Map(),  // gid -> { numero, nombre }
  currentGrupo: null,      // { id, ...data }
  snapshots: [],           // [{ id, ...data }]
  currentSnap: null,       // snapshot seleccionado ({ id, ...data })

  // Modelo de trabajo para la rendición (se guarda dentro del snapshot)
  rendicion: {
    gastos: {},            // gastoId -> { incluido, montoAprobado }
    docsOk: {},            // { transfer, cashUsd, boleta }
    descuento: { monto: 0, motivo: '' },
    calculado: null        // { abonos, gastos, saldos, saldoFinalCLP }
  }
};

/* ====================== UTILS ====================== */

const parseMonto = (any) => {
  if (any == null || any === '') return 0;
  if (typeof any === 'number' && isFinite(any)) return Math.round(any);
  const n = parseInt(String(any).replace(/[^\d-]/g, ''), 10);
  return isFinite(n) ? n : 0;
};

const moneyCLP = (n) =>
  isFinite(+n)
    ? (+n).toLocaleString('es-CL', {
        style: 'currency',
        currency: 'CLP',
        maximumFractionDigits: 0
      })
    : '—';

const moneyBy = (n, curr = 'CLP') =>
  isFinite(+n)
    ? (+n).toLocaleString('es-CL', {
        style: 'currency',
        currency: curr,
        maximumFractionDigits: 0
      })
    : '—';

// Convierte varias formas de fecha (Timestamp, string, ms, segundos) a ms
function toMs(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return isFinite(t) ? t : 0;
  }
  if (typeof v === 'object') {
    if ('seconds' in v) {
      return v.seconds * 1000 + Math.floor((v.nanoseconds || 0) / 1e6);
    }
    const t = Date.parse(v);
    return isFinite(t) ? t : 0;
  }
  return 0;
}

function fmtDmyFromAny(v) {
  const ms = toMs(v);
  if (!ms) return '';
  const d = new Date(ms);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

// Suma por moneda: rows[] con campos .moneda y .valor (o fieldAlt)
function sumByMoneda(rows, field = 'valor', fieldAlt = 'monto') {
  const out = {};
  (rows || []).forEach((r) => {
    const mon = String(r.moneda || 'CLP').toUpperCase();
    const v = Number(r[field] ?? r[fieldAlt] ?? 0) || 0;
    out[mon] = (out[mon] || 0) + v;
  });
  return out;
}

// Combina abonos y gastos → saldos por moneda
function buildSaldos(abonosMap, gastosMap) {
  const out = {};
  const allMon = new Set([
    ...Object.keys(abonosMap || {}),
    ...Object.keys(gastosMap || {})
  ]);
  allMon.forEach((m) => {
    out[m] = (abonosMap[m] || 0) - (gastosMap[m] || 0);
  });
  return out;
}

// Formatea un mapa { CLP: 1000, USD: 0, ... } a texto tipo "CLP 1.000 · USD 0 · BRL 0 · ARS 0"
function formatMapaMonedas(map) {
  const mons = ['CLP', 'USD', 'BRL', 'ARS'];
  if (!map) return '(sin datos)';
  return mons
    .map((m) => `${m} ${(map[m] || 0).toLocaleString('es-CL')}`)
    .join(' · ');
}

function normStr(s = '') {
  return s
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

/* ====================== CARGA DE DATOS ====================== */

// Índice básico de grupos para el datalist
async function loadGruposIndex() {
  const dl = document.getElementById('dlGrupos');
  dl.innerHTML = '';
  state.gruposIndex.clear();

  const snap = await getDocs(collection(db, 'grupos'));
  snap.forEach((d) => {
    const x = d.data() || {};
    const gid = d.id;
    const numero =
      x.numeroNegocio || x.numNegocio || x.idNegocio || gid;
    const nombre =
      x.nombreGrupo || x.aliasGrupo || x.nombre || x.grupo || gid;

    state.gruposIndex.set(gid, { id: gid, numero, nombre });

    const opt = document.createElement('option');
    opt.value = gid;
    opt.label = `${numero} — ${nombre}`;
    dl.appendChild(opt);
  });

  document.getElementById('estadoCarga').textContent =
    `Grupos cargados: ${state.gruposIndex.size}`;
}

// Trae grupo completo
async function loadGrupo(gid) {
  const ref = doc(db, 'grupos', gid);
  const d = await getDoc(ref);
  if (!d.exists()) throw new Error('Grupo no encontrado');
  state.currentGrupo = { id: gid, ...(d.data() || {}) };
}

// Lista snapshots de finanzas (ordenados desc)
async function listarSnapshotsFinanzas(gid, max = 20) {
  const qs = await getDocs(
    query(
      collection(db, 'grupos', gid, 'finanzas_snapshots'),
      orderBy('createdAt', 'desc'),
      limit(max)
    )
  );
  const out = [];
  qs.forEach((d) => out.push({ id: d.id, ...(d.data() || {}) }));
  return out;
}

/* ====================== RENDICIÓN: MODELO Y RENDER ====================== */

function initRendicionFromSnapshot() {
  const snap = state.currentSnap;
  if (!snap) return;

  const rendPrev = snap.rendicion || {};
  const gastosCfg = {};
  const gastos = Array.isArray(snap.gastosAprobados)
    ? snap.gastosAprobados
    : [];

  gastos.forEach((g) => {
    const id = g.id || g._id || '';
    if (!id) return;
    const prev = (rendPrev.gastos || {})[id] || {};
    const montoBase = Number(g.valor || 0) || 0;
    gastosCfg[id] = {
      incluido: prev.incluido !== false, // por defecto true
      montoAprobado:
        typeof prev.montoAprobado === 'number' && isFinite(prev.montoAprobado)
          ? prev.montoAprobado
          : montoBase
    };
  });

  state.rendicion = {
    gastos: gastosCfg,
    docsOk: rendPrev.docsOk || {},
    descuento: rendPrev.descuento || { monto: 0, motivo: '' },
    calculado: null
  };
}

function calcResumenFinanzas() {
  const snap = state.currentSnap;
  if (!snap) return { abonos: {}, gastos: {}, saldos: {} };

  const abonos = Array.isArray(snap.abonos) ? snap.abonos : [];
  const gastos = Array.isArray(snap.gastosAprobados)
    ? snap.gastosAprobados
    : [];

  const abMap = sumByMoneda(abonos, 'valor');
  const gaMap = {};
  gastos.forEach((g) => {
    const id = g.id || g._id || '';
    if (!id) return;

    const cfg = state.rendicion.gastos[id] || {};
    if (cfg.incluido === false) return;

    const mon = String(g.moneda || 'CLP').toUpperCase();
    const base = Number(g.valor || 0) || 0;
    const val =
      typeof cfg.montoAprobado === 'number' && isFinite(cfg.montoAprobado)
        ? cfg.montoAprobado
        : base;

    gaMap[mon] = (gaMap[mon] || 0) + val;
  });

  const salMap = buildSaldos(abMap, gaMap);

  const descMonto = parseMonto(
    state.rendicion.descuento?.monto || 0
  );
  const saldoCLP = salMap['CLP'] || 0;
  const saldoFinalCLP = saldoCLP - descMonto;

  const calculado = {
    abonos: abMap,
    gastos: gaMap,
    saldos: salMap,
    saldoFinalCLP,
    descuentoCLP: descMonto
  };
  state.rendicion.calculado = calculado;
  return calculado;
}

/* ----- RENDER: INFO GRUPO ----- */

function renderInfoGrupo() {
  const g = state.currentGrupo;
  const snap = state.currentSnap;
  const titulo = document.getElementById('infoTitulo');
  const sub = document.getElementById('infoSub');
  const meta = document.getElementById('infoMeta');

  if (!g || !snap) {
    titulo.textContent = '(elige un grupo y snapshot)';
    sub.textContent = '';
    meta.textContent = '';
    return;
  }

  const numero =
    snap.numeroNegocio ||
    g.numeroNegocio ||
    g.numNegocio ||
    g.idNegocio ||
    g.id ||
    g.gid ||
    '—';
  const nombre = snap.nombreGrupo || g.nombreGrupo || g.aliasGrupo || '—';
  const ident = snap.identificador || g.identificador || '';

  titulo.textContent = `${numero} — ${nombre}`;
  sub.textContent = ident ? `Código interno: ${ident}` : '';

  const coord =
    g.coordinadorEmail ||
    g.coordinador ||
    g.coordEmail ||
    g.responsable ||
    '';
  const destino = snap.destino || g.destino || '—';
  const pax =
    g.paxTotal || g.cantidadgrupo || g.pax || g.pax_total || null;
  const programa = g.programa || g.nombrePrograma || '—';

  const fIni =
    g.fechaInicio ||
    g.fecha_inicio ||
    g.fechas?.inicio ||
    g.fechas?.desde ||
    null;
  const fFin =
    g.fechaFin ||
    g.fecha_fin ||
    g.fechas?.fin ||
    g.fechas?.hasta ||
    null;

  const rango =
    fIni || fFin
      ? `${fmtDmyFromAny(fIni)} — ${fmtDmyFromAny(fFin)}`
      : '—';

  meta.innerHTML = `
    COORDINADOR(A): <span class="mono">${(coord || '—').toUpperCase()}</span><br>
    DESTINO: ${destino || '—'} · PAX TOTAL: ${pax ?? '—'} · PROGRAMA: ${programa || '—'}<br>
    FECHAS: ${rango}
  `;
}

/* ----- RENDER: DOCS (TRANSFER, CASH, BOLETA) ----- */

function renderDocs() {
  const snap = state.currentSnap;
  const rend = state.rendicion;
  const cierre = snap?.cierrePrevio || {};

  const docRows = [
    {
      key: 'transfer',
      linkId: 'linkTransfer',
      chkId: 'chkTransferOk',
      infoId: 'infoTransfer',
      data: cierre.transfer
    },
    {
      key: 'cashUsd',
      linkId: 'linkCash',
      chkId: 'chkCashOk',
      infoId: 'infoCash',
      data: cierre.cashUsd
    },
    {
      key: 'boleta',
      linkId: 'linkBoleta',
      chkId: 'chkBoletaOk',
      infoId: 'infoBoleta',
      data: cierre.boleta
    }
  ];

  docRows.forEach((row) => {
    const link = document.getElementById(row.linkId);
    const chk = document.getElementById(row.chkId);
    const info = document.getElementById(row.infoId);

    const d = row.data || {};
    const url =
      d.comprobanteUrl || d.url || d.href || d.link || '';

    if (url) {
      link.href = url;
      link.textContent = 'VER';
      link.target = '_blank';
      link.classList.remove('muted');
    } else {
      link.href = '#';
      link.textContent = '—';
      link.removeAttribute('target');
      link.classList.add('muted');
    }

    const fechaTxt = d.fecha ? fmtDmyFromAny(d.fecha) : '';
    const medio = d.medio || d.tipo || '';
    info.textContent =
      fechaTxt || medio
        ? `(${[fechaTxt, medio].filter(Boolean).join(' · ')})`
        : '';

    chk.checked = !!(rend.docsOk || {})[row.key];
    chk.onchange = () => {
      rend.docsOk[row.key] = chk.checked;
    };
  });
}

/* ----- RENDER: DESCUENTO ----- */

function renderDescuento() {
  const desc = state.rendicion.descuento || { monto: 0, motivo: '' };
  const inpMonto = document.getElementById('descuentoMonto');
  const txtMotivo = document.getElementById('descuentoMotivo');

  inpMonto.value = desc.monto || '';
  txtMotivo.value = desc.motivo || '';

  inpMonto.oninput = () => {
    const v = parseMonto(inpMonto.value);
    state.rendicion.descuento.monto = v;
    calcResumenFinanzas();
    renderResumen();
  };
  txtMotivo.oninput = () => {
    state.rendicion.descuento.motivo = txtMotivo.value || '';
  };
}

/* ----- RENDER: TABLA DE GASTOS ----- */

function renderGastosTable() {
  const tbody = document.querySelector('#tblGastos tbody');
  const g = state.currentGrupo;
  const snap = state.currentSnap;
  const rows = Array.isArray(snap?.gastosAprobados)
    ? snap.gastosAprobados
    : [];

  tbody.innerHTML = '';

  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.innerHTML =
      '<div class="muted">Este snapshot no tiene gastos aprobados.</div>';
    tr.appendChild(td);
    tbody.appendChild(tr);
    document.getElementById('resumenTotales').textContent =
      '(sin datos)';
    return;
  }

  const coord =
    g?.coordinadorEmail ||
    g?.coordinador ||
    g?.coordEmail ||
    g?.responsable ||
    '';

  rows.forEach((gx) => {
    const id = gx.id || gx._id || '';
    if (!id) return;

    const cfg = state.rendicion.gastos[id] || {
      incluido: true,
      montoAprobado: Number(gx.valor || 0) || 0
    };
    state.rendicion.gastos[id] = cfg;

    const tr = document.createElement('tr');

    // Check OK
    const tdChk = document.createElement('td');
    tdChk.className = 'chk';
    const ch = document.createElement('input');
    ch.type = 'checkbox';
    ch.checked = cfg.incluido !== false;
    ch.onchange = () => {
      cfg.incluido = ch.checked;
      calcResumenFinanzas();
      renderResumen();
    };
    tdChk.appendChild(ch);

    // Asunto (actividad / proveedor)
    const tdAsunto = document.createElement('td');
    const actividad = gx.actividad || gx.asunto || '';
    const prov = gx.proveedor || '';
    tdAsunto.textContent =
      actividad || prov || '(sin descripción)';

    // Autor (correo coord)
    const tdAutor = document.createElement('td');
    tdAutor.textContent =
      (coord || '').toString().toUpperCase() || '—';

    // Moneda
    const tdMon = document.createElement('td');
    const mon = String(gx.moneda || 'CLP').toUpperCase();
    tdMon.textContent = mon;

    // Monto original
    const tdOri = document.createElement('td');
    tdOri.className = 'monto mono';
    tdOri.textContent = moneyBy(Number(gx.valor || 0) || 0, mon);

    // Monto aprobado (editable)
    const tdApr = document.createElement('td');
    tdApr.className = 'monto';
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.step = '1';
    inp.min = '0';
    inp.className = 'mono';
    inp.style.maxWidth = '120px';
    inp.value = cfg.montoAprobado ?? Number(gx.valor || 0) || 0;

    const update = () => {
      const v = parseMonto(inp.value);
      cfg.montoAprobado = v;
      calcResumenFinanzas();
      renderResumen();
    };

    inp.addEventListener('change', update);
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') update();
    });

    tdApr.appendChild(inp);

    // Comprobante
    const tdComp = document.createElement('td');
    const url =
      gx.comprobanteUrl ||
      gx.urlComprobante ||
      gx.fileUrl ||
      gx.url ||
      '';
    if (url) {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.textContent = 'VER';
      a.className = 'small';
      tdComp.appendChild(a);
    } else {
      tdComp.innerHTML = '<span class="muted small">—</span>';
    }

    tr.append(tdChk, tdAsunto, tdAutor, tdMon, tdOri, tdApr, tdComp);
    tbody.appendChild(tr);
  });

  calcResumenFinanzas();
  renderResumen();
}

/* ----- RENDER: RESUMEN (pantalla) ----- */

function renderResumen() {
  const resumenTot = document.getElementById('resumenTotales');
  const resumenFinal = document.getElementById('resumenFinal');
  const calc = state.rendicion.calculado || calcResumenFinanzas();

  const txtAb = formatMapaMonedas(calc.abonos);
  const txtGa = formatMapaMonedas(calc.gastos);
  const txtSa = formatMapaMonedas(calc.saldos);

  resumenTot.textContent =
    `ABONOS: ${txtAb} · GASTOS: ${txtGa} · SALDO: ${txtSa}`;

  resumenFinal.innerHTML = `
    <strong>Resumen final de rendición</strong>
    ABONOS: ${txtAb}<br>
    GASTOS: ${txtGa}<br>
    SALDO: ${txtSa}<br>
    DESCUENTO (CLP): ${moneyCLP(calc.descuentoCLP || 0)}<br>
    <strong>MONTO FINAL A PAGAR (CLP): ${moneyCLP(calc.saldoFinalCLP || 0)}</strong>
  `;
}

/* ====================== GUARDADO EN FIRESTORE ====================== */

async function guardarRendicion() {
  const snap = state.currentSnap;
  const g = state.currentGrupo;
  if (!snap || !g) {
    alert('Selecciona grupo y snapshot.');
    return;
  }

  const desc = state.rendicion.descuento || { monto: 0, motivo: '' };
  const descMonto = parseMonto(desc.monto || 0);
  const descMotivo = (desc.motivo || '').trim();

  if (descMonto > 0 && !descMotivo) {
    alert('Debes indicar el MOTIVO del descuento.');
    return;
  }

  const calc = calcResumenFinanzas();

  const payload = {
    rendicion: {
      gastos: state.rendicion.gastos,
      docsOk: state.rendicion.docsOk,
      descuento: {
        monto: descMonto,
        motivo: descMotivo
      },
      resumen: {
        totalesAbonos: calc.abonos,
        totalesGastos: calc.gastos,
        saldos: calc.saldos,
        saldoFinalCLP: calc.saldoFinalCLP,
        descuentoCLP: descMonto
      },
      updatedAt: Date.now(),
      updatedBy: (state.user?.email || '').toLowerCase()
    }
  };

  try {
    const ref = doc(
      db,
      'grupos',
      g.id || g.grupoId || snap.grupoId,
      'finanzas_snapshots',
      snap.id
    );
    await updateDoc(ref, payload);
    alert('Rendición guardada correctamente.');
  } catch (e) {
    console.error('guardarRendicion', e);
    alert('No se pudo guardar la rendición. Revisa la consola.');
  }
}

/* ====================== IMPRESIÓN ====================== */

function buildPrintHTML() {
  const snap = state.currentSnap;
  const g = state.currentGrupo;
  if (!snap || !g) return '';

  const calc = state.rendicion.calculado || calcResumenFinanzas();
  const desc = state.rendicion.descuento || { monto: 0, motivo: '' };

  const ab = calc.abonos || {};
  const ga = calc.gastos || {};
  const sa = calc.saldos || {};

  const clpAb = ab['CLP'] || 0;
  const clpGa = ga['CLP'] || 0;
  const clpSa = sa['CLP'] || 0;

  const coord =
    g.coordinadorEmail ||
    g.coordinador ||
    g.coordEmail ||
    g.responsable ||
    '';
  const destino = snap.destino || g.destino || '—';
  const pax =
    g.paxTotal || g.cantidadgrupo || g.pax || g.pax_total || '—';
  const programa = g.programa || g.nombrePrograma || '—';

  const fIni =
    g.fechaInicio ||
    g.fecha_inicio ||
    g.fechas?.inicio ||
    g.fechas?.desde ||
    null;
  const fFin =
    g.fechaFin ||
    g.fecha_fin ||
    g.fechas?.fin ||
    g.fechas?.hasta ||
    null;
  const rango =
    fIni || fFin
      ? `${fmtDmyFromAny(fIni)} — ${fmtDmyFromAny(fFin)}`
      : '—';

  const numero =
    snap.numeroNegocio ||
    g.numeroNegocio ||
    g.numNegocio ||
    g.idNegocio ||
    g.id ||
    '—';
  const nombre = snap.nombreGrupo || g.nombreGrupo || g.aliasGrupo || '—';
  const ident = snap.identificador || g.identificador || '';

  const rowsG = Array.isArray(snap.gastosAprobados)
    ? snap.gastosAprobados.filter((gx) => {
        const id = gx.id || gx._id || '';
        if (!id) return false;
        const cfg = state.rendicion.gastos[id] || {};
        return cfg.incluido !== false;
      })
    : [];

  const cierre = snap.cierrePrevio || {};
  const docsOk = state.rendicion.docsOk || {};

  const descMonto = parseMonto(desc.monto || 0);
  const descMotivo = (desc.motivo || '').trim();

  const lineaTotal =
    `TOTAL — CLP: ${clpGa.toLocaleString('es-CL')} · ` +
    `USD: ${(ga['USD'] || 0).toLocaleString('es-CL')} · ` +
    `BRL: ${(ga['BRL'] || 0).toLocaleString('es-CL')} · ` +
    `ARS: ${(ga['ARS'] || 0).toLocaleString('es-CL')}`;

  const transfTxt = cierre.transfer
    ? (docsOk.transfer ? 'REVISADA' : 'PENDIENTE')
    : 'NO HIZO';

  const bolTxt = cierre.boleta
    ? (docsOk.boleta ? 'REVISADA' : 'PENDIENTE')
    : 'NO APLICA';

  const descLinea =
    descMonto > 0
      ? `DESCUENTO (CLP): ${descMonto.toLocaleString(
          'es-CL'
        )} — MOTIVO: ${descMotivo || '(sin detalle)'}`
      : 'DESCUENTO (CLP): 0';

  const htmlRows = rowsG
    .map((gx) => {
      const id = gx.id || gx._id || '';
      const cfg = state.rendicion.gastos[id] || {};
      const mon = String(gx.moneda || 'CLP').toUpperCase();
      const val =
        typeof cfg.montoAprobado === 'number' && isFinite(cfg.montoAprobado)
          ? cfg.montoAprobado
          : Number(gx.valor || 0) || 0;
      const actividad = gx.actividad || gx.asunto || '';
      const compUrl =
        gx.comprobanteUrl ||
        gx.urlComprobante ||
        gx.fileUrl ||
        gx.url ||
        '';

      const compTxt = compUrl ? 'VER' : '';
      return `
        <tr>
          <td>${actividad || '(sin descripción)'}</td>
          <td>${(coord || '—').toString().toUpperCase()}</td>
          <td>${mon}</td>
          <td class="mono" style="text-align:right;">${val.toLocaleString(
            'es-CL'
          )}</td>
          <td>${compTxt}</td>
        </tr>
      `;
    })
    .join('');

  return `
    <div class="print-doc">
      <h1>GASTOS DEL GRUPO</h1>
      <table style="margin-bottom:8px;">
        <tr>
          <td style="width:50%; vertical-align:top;">
            <div><strong>COORDINADOR(A)</strong><br>${(coord ||
              '—')
              .toString()
              .toUpperCase()}</div>
            <div style="margin-top:4px;"><strong>DESTINO</strong><br>${destino}</div>
            <div style="margin-top:4px;"><strong>PAX TOTAL</strong><br>${pax}</div>
            <div style="margin-top:4px;"><strong>PROGRAMA</strong><br>${programa}</div>
            <div style="margin-top:4px;"><strong>FECHAS</strong><br>${rango}</div>
          </td>
          <td style="width:50%; vertical-align:top;">
            <div><strong>${nombre}</strong></div>
            <div style="margin-top:4px;">CÓDIGO: (${numero}${
    ident ? ' - ' + ident : ''
  })</div>
          </td>
        </tr>
      </table>

      <h2>RESUMEN FINANZAS</h2>
      <table class="tbl-resumen" style="margin-bottom:10px;">
        <tr style="background:#f2f2f2;">
          <td style="width:80px;"><strong>ABONOS</strong></td>
          <td>CLP ${clpAb.toLocaleString('es-CL')} · USD ${(ab['USD'] ||
            0).toLocaleString('es-CL')} · BRL ${(ab['BRL'] ||
    0).toLocaleString('es-CL')} · ARS ${(ab['ARS'] ||
    0).toLocaleString('es-CL')}</td>
        </tr>
        <tr style="background:#f7f7f7;">
          <td><strong>GASTOS</strong></td>
          <td>CLP ${clpGa.toLocaleString('es-CL')} · USD ${(ga['USD'] ||
            0).toLocaleString('es-CL')} · BRL ${(ga['BRL'] ||
    0).toLocaleString('es-CL')} · ARS ${(ga['ARS'] ||
    0).toLocaleString('es-CL')}</td>
        </tr>
        <tr style="background:#fffcc0;">
          <td><strong>SALDO</strong></td>
          <td>CLP ${clpSa.toLocaleString('es-CL')} · USD ${(sa['USD'] ||
            0).toLocaleString('es-CL')} · BRL ${(sa['BRL'] ||
    0).toLocaleString('es-CL')} · ARS ${(sa['ARS'] ||
    0).toLocaleString('es-CL')}</td>
        </tr>
      </table>

      <h2>DETALLE DE GASTOS</h2>
      <table class="tbl-detalle" style="margin-bottom:6px;">
        <thead>
          <tr>
            <th>ASUNTO</th>
            <th>AUTOR</th>
            <th>MONEDA</th>
            <th style="text-align:right;">VALOR</th>
            <th>COMPROBANTE</th>
          </tr>
        </thead>
        <tbody>
          ${htmlRows || '<tr><td colspan="5">(sin gastos)</td></tr>'}
        </tbody>
      </table>

      <div style="margin-top:4px;">${lineaTotal}</div>
      <div style="margin-top:8px;">TRANSFERENCIA: ${transfTxt}</div>
      <div>BOLETA: ${bolTxt}</div>
      <div style="margin-top:8px;">${descLinea}</div>
      <div style="margin-top:4px;"><strong>MONTO FINAL A PAGAR (CLP): ${calc.saldoFinalCLP.toLocaleString(
        'es-CL'
      )}</strong></div>
    </div>
  `;
}

function imprimirRendicion() {
  const block = document.getElementById('print-block');
  if (!state.currentSnap || !state.currentGrupo) {
    alert('Selecciona grupo y snapshot antes de imprimir.');
    return;
  }
  block.innerHTML = buildPrintHTML();
  window.print();
}

/* ====================== UI / WIRING ====================== */

function wireUI() {
  const btnRef = document.getElementById('btnRefrescar');
  const btnCargar = document.getElementById('btnCargar');
  const snapSel = document.getElementById('snapshotSelect');
  const btnGuardar = document.getElementById('btnGuardarRendicion');
  const btnPrint = document.getElementById('btnImprimirRendicion');

  btnRef.onclick = async () => {
    try {
      document.getElementById('estadoCarga').textContent =
        'Cargando grupos…';
      await loadGruposIndex();
    } catch (e) {
      console.error(e);
      alert('No se pudieron cargar los grupos.');
    }
  };

  btnCargar.onclick = async () => {
    const gid = (document.getElementById('grupoInput').value || '').trim();
    if (!gid) {
      alert('Selecciona un grupo desde la lista.');
      return;
    }

    try {
      document.getElementById('estadoCarga').textContent =
        'Cargando grupo y snapshots…';
      await loadGrupo(gid);
      state.snapshots = await listarSnapshotsFinanzas(gid);
      if (!state.snapshots.length) {
        document.getElementById('estadoCarga').textContent =
          'Este grupo aún no tiene snapshots de finanzas.';
        snapSel.innerHTML =
          '<option value="">(sin snapshots)</option>';
        state.currentSnap = null;
        renderInfoGrupo();
        renderDocs();
        renderDescuento();
        renderGastosTable();
        return;
      }

      snapSel.innerHTML = '';
      state.snapshots.forEach((s, idx) => {
        const opt = document.createElement('option');
        const fechaTxt = s.createdAt
          ? fmtDmyFromAny(s.createdAt)
          : '(sin fecha)';
        opt.value = s.id;
        opt.textContent = `${fechaTxt} · ${s.motivo || 'snapshot'}`;
        if (idx === 0) opt.selected = true;
        snapSel.appendChild(opt);
      });

      state.currentSnap = state.snapshots[0];
      initRendicionFromSnapshot();
      renderInfoGrupo();
      renderDocs();
      renderDescuento();
      renderGastosTable();

      document.getElementById('estadoCarga').textContent =
        `Snapshots cargados: ${state.snapshots.length} (mostrando el último)`;
    } catch (e) {
      console.error(e);
      alert('Error al cargar grupo/snapshots.');
    }
  };

  snapSel.onchange = () => {
    const id = snapSel.value;
    if (!id) return;
    const snap = state.snapshots.find((s) => s.id === id);
    if (!snap) return;
    state.currentSnap = snap;
    initRendicionFromSnapshot();
    renderInfoGrupo();
    renderDocs();
    renderDescuento();
    renderGastosTable();
  };

  btnGuardar.onclick = () => {
    guardarRendicion();
  };
  btnPrint.onclick = () => {
    imprimirRendicion();
  };
}

/* ====================== ARRANQUE ====================== */

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    location.href = 'login.html';
    return;
  }
  state.user = user;
  try {
    document.getElementById('userEmail').textContent =
      user.email || '';
  } catch (_) {}

  // Logout
  try {
    document
      .getElementById('btn-logout')
      ?.addEventListener('click', () =>
        signOut(auth).then(() => (location.href = 'login.html'))
      );
  } catch (_) {}

  try {
    document.getElementById('estadoCarga').textContent =
      'Cargando grupos…';
    await loadGruposIndex();
  } catch (e) {
    console.error(e);
    document.getElementById('estadoCarga').textContent =
      'No se pudieron cargar los grupos.';
  }

  wireUI();
  renderInfoGrupo();
  renderDocs();
  renderDescuento();
  renderGastosTable();
});
