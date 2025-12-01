// rendiciones_coordinadores.js
// Rendición de gastos por grupo/coordinador (basado en Revisión financiera v2)

import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, collectionGroup, getDocs, doc, getDoc,
  updateDoc, setDoc, addDoc, deleteDoc
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
  descuento: { monto: 0, asunto: '' }, // LEGADO (no se usa en el nuevo flujo)
  descuentos: [],              // NUEVO: descuentos múltiples (subcolección finanzas_descuentos)
};

// Categorías de rendición de gastos
const CATEGORIAS_GASTO = [
  'GASTOS DEL GRUPO',
  'GASTOS DE LA EMPRESA',
  'SEGURO DE VIAJES',
  'OTROS'
];

const escapeHtml = (str='') =>
  String(str)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#039;');


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

    // 🔴 AHORA USAMOS SIEMPRE "cantidadGrupo" COMO FUENTE PRINCIPAL
    const cantidadGrupo = Number(
      x.cantidadGrupo ??
      x.paxTotal ??
      x.pax ??
      x.pax_total ??
      0
    );

    const programa = coalesce(x.programa, x.plan, '');
    const fechas   = coalesce(x.fechas, x.fechaDeViaje, x.fechaViaje, '');

    state.caches.grupos.set(gid, {
      numero,
      nombre,
      coordEmail,
      destino,
      paxTotal: cantidadGrupo,   // alias por compatibilidad
      cantidadGrupo,             // campo explícito para esta pantalla
      programa,
      fechas,
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
  const categoriaRendicion = coalesce(
    raw.categoriaRendicion,
    rend.categoria,
    'GASTOS DEL GRUPO'
  );

  const rendOk = (typeof raw.rendicionOk === 'boolean')
    ? !!raw.rendicionOk
    : !!rend.ok;

  const imgUrl = coalesce(
    raw.imgUrl,
    raw.imageUrl,
    raw.imagenUrl,
    raw.comprobanteUrl,
    ''
  );

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
    categoriaRendicion,
    imgUrl,
    rendOk,
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
  state.summary = null;
  if (!gid) return;
  try {
    const ref  = doc(db,'grupos',gid,'finanzas','summary');
    const snap = await getDoc(ref);
    state.summary = snap.exists() ? (snap.data() || {}) : null;
  } catch (e) {
    console.warn('[REN] loadSummaryForGroup', e);
  }
}

// DESCUENTOS — grupos/{gid}/finanzas_descuentos/*
async function loadDescuentosForGroup(gid) {
  state.descuentos = [];
  if (!gid) return;
  try {
    const ref  = collection(db,'grupos',gid,'finanzas_descuentos');
    const snap = await getDocs(ref);
    const out = [];
    snap.forEach(d => {
      const x = d.data() || {};
      out.push({
        id: d.id,
        grupoId: gid,
        monto: parseMonto(x.monto),
        motivo: coalesce(x.motivo, x.asunto, ''),
        coordEmail: (x.coordEmail || x.coordinador || '').toLowerCase(),
        createdAtMs: pickFechaMs(x) || _toMs(x.createdAt || 0),
      });
    });
    state.descuentos = out.sort((a,b)=>(a.createdAtMs||0)-(b.createdAtMs||0));
  } catch (e) {
    console.warn('[REN] loadDescuentosForGroup', e);
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

  await Promise.all([
    loadSummaryForGroup(gid),
    loadDescuentosForGroup(gid)
  ]);
}


/* ====================== ESCRITURA ====================== */
async function updateGastoRendicionFields(item, patch = {}) {
  const gid   = item.grupoId;
  const coord = item.coordinador;
  if (!gid || !coord || !item.id) return false;

  const email = (auth.currentUser?.email || '').toLowerCase();
  const fsPatch = {
    ...(patch.montoAprobado !== undefined ? { montoAprobado: parseMonto(patch.montoAprobado) } : {}),
    ...(patch.categoriaRendicion !== undefined ? {
      categoriaRendicion: patch.categoriaRendicion || 'GASTOS DEL GRUPO'
    } : {}),
    ...(patch.rendicionOk !== undefined ? {
      rendicionOk: !!patch.rendicionOk,
      'rendicion.ok': !!patch.rendicionOk
    } : {}),
    'rendicion.by': email,
    'rendicion.at': Date.now()
  };

  try {
    const ref = doc(db,'coordinadores',coord,'gastos',item.id);
    await updateDoc(ref, fsPatch);

    if (patch.montoAprobado !== undefined) {
      item.montoAprobado = parseMonto(patch.montoAprobado);
    }
    if (patch.categoriaRendicion !== undefined) {
      item.categoriaRendicion = patch.categoriaRendicion || 'GASTOS DEL GRUPO';
    }
    if (patch.rendicionOk !== undefined) {
      item.rendOk = !!patch.rendicionOk;
    }
    return true;
  } catch (e) {
    console.error('[REN] updateGastoRendicionFields', e);
    alert('No se pudo guardar la rendición del gasto.');
    return false;
  }
}

async function saveMontoAprobado(item, nuevoMonto) {
  const val = parseMonto(nuevoMonto);
  return updateGastoRendicionFields(item, {
    montoAprobado: val,
    rendicionOk: true
  });
}

async function saveCategoriaRendicion(item, categoria) {
  const cat = categoria || 'GASTOS DEL GRUPO';
  return updateGastoRendicionFields(item, { categoriaRendicion: cat });
}

async function saveRendicionOk(item, ok) {
  return updateGastoRendicionFields(item, { rendicionOk: !!ok });
}

// CRUD descuentos (subcolección finanzas_descuentos)
async function crearDescuento(gid) {
  const inpMonto  = document.getElementById('nuevoDescMonto');
  const inpMotivo = document.getElementById('nuevoDescMotivo');

  const monto  = parseMonto(inpMonto?.value || 0);
  const motivo = (inpMotivo?.value || '').trim();

  if (!monto || !motivo) {
    alert('Ingresa monto y motivo del descuento.');
    return;
  }

  try {
    const refCol = collection(db,'grupos',gid,'finanzas_descuentos');
    await addDoc(refCol, {
      grupoId: gid,
      monto,
      motivo,
      coordEmail: (state.filtros.coord || '').toLowerCase(),
      createdAt: Date.now(),
      createdBy: (auth.currentUser?.email || '').toLowerCase()
    });

    if (inpMonto)  inpMonto.value = '';
    if (inpMotivo) inpMotivo.value = '';

    await loadDescuentosForGroup(gid);
    renderResumenFinanzas();
  } catch (e) {
    console.error('[REN] crearDescuento', e);
    alert('No se pudo crear el descuento.');
  }
}

async function actualizarDescuento(desc, nuevoMonto, nuevoMotivo) {
  if (!desc?.id || !desc?.grupoId) return;
  const ref = doc(db,'grupos',desc.grupoId,'finanzas_descuentos',desc.id);
  try {
    await updateDoc(ref, {
      monto: parseMonto(nuevoMonto),
      motivo: (nuevoMotivo || '').trim(),
      updatedAt: Date.now(),
      updatedBy: (auth.currentUser?.email || '').toLowerCase()
    });
    await loadDescuentosForGroup(desc.grupoId);
    renderResumenFinanzas();
  } catch (e) {
    console.error('[REN] actualizarDescuento', e);
    alert('No se pudo actualizar el descuento.');
  }
}

async function eliminarDescuento(desc) {
  if (!desc?.id || !desc?.grupoId) return;
  if (!confirm('¿Eliminar este descuento de rendición?')) return;

  const ref = doc(db,'grupos',desc.grupoId,'finanzas_descuentos',desc.id);
  try {
    await deleteDoc(ref);
    await loadDescuentosForGroup(desc.grupoId);
    renderResumenFinanzas();
  } catch (e) {
    console.error('[REN] eliminarDescuento', e);
    alert('No se pudo eliminar el descuento.');
  }
}

async function guardarDocsOk(gid) {
  const chkB = document.getElementById('chkBoletaOk');
  const chkC = document.getElementById('chkComprobanteOk');
  const chkT = document.getElementById('chkTransferenciaOk');

  const docBoletaOk = chkB ? !!chkB.checked : false;
  const docCompOk   = chkC ? !!chkC.checked : false;
  const docTransfOk = chkT ? !!chkT.checked : false;

  const inpDevCLP = document.getElementById('montoDevueltoCLP');
  const inpDevUSD = document.getElementById('montoDevueltoUSD');
  const montoDevCLP = inpDevCLP ? parseMonto(inpDevCLP.value || 0) : 0;
  const montoDevUSD = inpDevUSD ? Number(inpDevUSD.value || 0) || 0 : 0;

  try {
    const ref = doc(db,'grupos',gid,'finanzas','summary');
    await setDoc(ref, {
      docsOk: {
        boleta: docBoletaOk,
        comprobante: docCompOk,
        transferencia: docTransfOk,
        montoDevueltoCLP: montoDevCLP,
        montoDevueltoUSD: montoDevUSD,
        by: (auth.currentUser?.email || '').toLowerCase(),
        at: Date.now()
      }
    }, { merge:true });
    alert('Estado de documentos guardado.');
    await loadSummaryForGroup(gid);
    renderResumenFinanzas();
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
    td.colSpan = 9;
    td.innerHTML = '<div class="muted">Sin gastos registrados para este criterio.</div>';
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    const frag = document.createDocumentFragment();
    rows.forEach(item => {
      const tr = document.createElement('tr');

      const tdFecha      = document.createElement('td');
      const tdAsunto     = document.createElement('td');
      const tdAutor      = document.createElement('td');
      const tdMon        = document.createElement('td');
      const tdMonto      = document.createElement('td');
      const tdMontoAprob = document.createElement('td');
      const tdCat        = document.createElement('td');
      const tdDoc        = document.createElement('td');
      const tdChk        = document.createElement('td');

      tdFecha.textContent  = item.fechaTxt || '—';
      tdAsunto.textContent = item.asunto || '—';
      tdAutor.textContent  = item.autor || item.coordinador || '—';
      tdMon.textContent    = item.moneda || 'CLP';
      tdMonto.innerHTML    = `<span class="mono">${moneyBy(item.monto, item.moneda||'CLP')}</span>`;

      // Monto aprobado
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

      // Categoría
      const sel = document.createElement('select');
      sel.className = 'input-field';
      CATEGORIAS_GASTO.forEach(cat => {
        const opt = document.createElement('option');
        opt.value = cat;
        opt.textContent = cat;
        sel.appendChild(opt);
      });
      sel.value = item.categoriaRendicion || 'GASTOS DEL GRUPO';

      sel.addEventListener('change', async () => {
        const ok = await saveCategoriaRendicion(item, sel.value);
        if (!ok) {
          sel.value = item.categoriaRendicion || 'GASTOS DEL GRUPO';
        } else {
          sel.classList.add('saved');
          setTimeout(()=> sel.classList.remove('saved'), 800);
          renderResumenFinanzas();
        }
      });

      tdCat.appendChild(sel);

      // Comprobante
      if (item.imgUrl) {
        const a = document.createElement('a');
        a.href = item.imgUrl;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = 'VER';
        a.className = 'link-doc';
        tdDoc.appendChild(a);
      } else {
        tdDoc.textContent = '—';
      }

      // Checkbox OK con persistencia
      chk.addEventListener('change', async (e) => {
        const nuevo = !!e.target.checked;
        const ok = await saveRendicionOk(item, nuevo);
        if (!ok) {
          e.target.checked = !nuevo; // revertir
        } else {
          renderResumenFinanzas();
        }
      });

      tdChk.appendChild(chk);

      tr.append(
        tdFecha, tdAsunto, tdAutor, tdMon,
        tdMonto, tdMontoAprob, tdCat, tdDoc, tdChk
      );
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
  }

  if (resumenEl) {
    resumenEl.textContent = `Mostrando ${rows.length} gastos.`;
  }
}

function renderTablaDescuentos() {
  const tbody = document.querySelector('#tblDescuentos tbody');
  if (!tbody) return;

  tbody.innerHTML = '';

  if (!state.descuentos.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 3;
    td.innerHTML = '<div class="muted">Sin descuentos registrados.</div>';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  const frag = document.createDocumentFragment();
  state.descuentos.forEach(desc => {
    const tr = document.createElement('tr');

    const tdMotivo = document.createElement('td');
    const tdMonto  = document.createElement('td');
    const tdAcc    = document.createElement('td');

    const inpMotivo = document.createElement('input');
    inpMotivo.type = 'text';
    inpMotivo.className = 'input-field';
    inpMotivo.value = desc.motivo || '';

    const inpMonto = document.createElement('input');
    inpMonto.type = 'number';
    inpMonto.className = 'input-field mono';
    inpMonto.min = '0';
    inpMonto.step = '1000';
    inpMonto.value = desc.monto || 0;

    const btnSave = document.createElement('button');
    btnSave.type = 'button';
    btnSave.className = 'revbtn';
    btnSave.textContent = '💾';
    btnSave.title = 'Guardar cambios';

    const btnDel = document.createElement('button');
    btnDel.type = 'button';
    btnDel.className = 'revbtn';
    btnDel.textContent = '🗑';
    btnDel.title = 'Eliminar';

    const doSave = () => {
      actualizarDescuento(desc, inpMonto.value, inpMotivo.value);
    };
    const doDel = () => {
      eliminarDescuento(desc);
    };

    btnSave.onclick = doSave;
    btnDel.onclick  = doDel;

    inpMotivo.addEventListener('keydown', e => {
      if (e.key === 'Enter') doSave();
    });
    inpMonto.addEventListener('keydown', e => {
      if (e.key === 'Enter') doSave();
    });

    tdMotivo.appendChild(inpMotivo);
    tdMonto.appendChild(inpMonto);
    tdAcc.append(btnSave, btnDel);

    tr.append(tdMotivo, tdMonto, tdAcc);
    frag.appendChild(tr);
  });

  tbody.appendChild(frag);
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

    // 🔴 Usa cantidadGrupo como fuente principal, con fallback a paxTotal
    const paxMostrar = gInfo.cantidadGrupo ?? gInfo.paxTotal ?? 0;
    if (elPax) elPax.textContent = paxMostrar ? String(paxMostrar) : '—';

    if (elProg)    elProg.textContent    = gInfo.programa || '—';
    if (elFechas)  elFechas.textContent  = gInfo.fechas || '—';
  }

  const gastosOk = state.gastos.filter(it => it.rendOk);
  const totalGastos = gastosOk
    .reduce((s,it)=> s + (isFinite(+it.montoAprobado) ? +it.montoAprobado : +it.monto), 0);
  const totalAbonos = state.abonos
    .reduce((s,it)=> s + (Number(it.monto) || 0), 0);
  const totalDescuentos = state.descuentos
    .reduce((s,d)=> s + (Number(d.monto) || 0), 0);

  const gastosNetos     = totalGastos - totalDescuentos;
  const saldoEsperado   = totalAbonos - gastosNetos;

   const docsOk = (state.summary && state.summary.docsOk) || {};
  const montoDevCLP = parseMonto(docsOk.montoDevueltoCLP || 0);
  const montoDevUSD = Number(docsOk.montoDevueltoUSD || 0) || 0;

  const diff = saldoEsperado - montoDevCLP;
  let textoResultado = '';
  if (Math.abs(diff) < 500) {
    textoResultado = 'Saldo cuadrado (≈ $0)';
  } else if (diff > 0) {
    textoResultado = `A favor de Rai Trai: ${moneyCLP(diff)}`;
  } else {
    textoResultado = `A favor del coordinador: ${moneyCLP(-diff)}`;
  }

  const elAbonos        = document.getElementById('sumAbonos');
  const elGastos        = document.getElementById('sumGastos');
  const elDescuentos    = document.getElementById('sumDescuentos');
  const elGastosNetos   = document.getElementById('sumGastosNetos');
  const elSaldoEsperado = document.getElementById('sumSaldoEsperado');
  const elDevuelto      = document.getElementById('sumDevuelto');
  const elResultado     = document.getElementById('sumResultado');

  if (elAbonos)        elAbonos.textContent        = moneyCLP(totalAbonos);
  if (elGastos)        elGastos.textContent        = moneyCLP(totalGastos);
  if (elDescuentos)    elDescuentos.textContent    = moneyCLP(totalDescuentos);
  if (elGastosNetos)   elGastosNetos.textContent   = moneyCLP(gastosNetos);
  if (elSaldoEsperado) elSaldoEsperado.textContent = moneyCLP(saldoEsperado);
  if (elDevuelto)      elDevuelto.textContent      = moneyCLP(montoDevCLP);
  if (elResultado)     elResultado.textContent     = textoResultado;

  // ====== Estado visual de documentos (lista TRANSF / CONSTANCIA / BOLETA) ======
  if (gInfo) {
    const summary = state.summary || {};

    // Boleta / doc SII (ya funcionaba bien)
    const boletaUrl = coalesce(
      summary.boleta?.url,
      summary.boletaUrl,
      gInfo.urls?.boleta,
      ''
    );

    // Transferencia CLP / comprobante CLP
    // coordinadores.js guarda AHORA en: summary.transfer.comprobanteUrl
    // dejamos también variantes antiguas por compatibilidad
    const compUrl = coalesce(
      summary.transfer?.comprobanteUrl,          // NUEVO: campo real
      summary.transferenciaCLP?.url,
      summary.comprobanteCLP?.url,
      summary.comprobante?.url,
      summary.transfer?.url,
      summary.transferencia?.url,
      summary.transferenciaCLPUrl,
      summary.comprobanteUrl,
      gInfo.urls?.comprobante,
      ''
    );

    // Constancia USD / transferencia coordinador
    // coordinadores.js guarda AHORA en: summary.cashUsd.comprobanteUrl
    // dejamos variantes antiguas como respaldo
    const transfUrl = coalesce(
      summary.cashUsd?.comprobanteUrl,           // NUEVO: campo real
      summary.transferenciaCoord?.url,
      summary.constanciaUSD?.url,
      summary.constancia?.url,
      summary.transferenciaCoordUrl,
      summary.constanciaUrl,
      gInfo.urls?.transferenciaCoord,
      ''
    );



    // Estimamos si "aplica" cada documento
    const aplicaTransfCLP = !!(compUrl || montoDevCLP || docsOk.comprobante);
    const aplicaConstUSD  = !!(transfUrl || montoDevUSD || docsOk.transferencia);

    const linkBoleta = document.getElementById('linkBoleta');
    const linkComp   = document.getElementById('linkComprobante');
    const linkTransf = document.getElementById('linkTransferencia');

    const celdaBoleta     = document.getElementById('celdaEstadoBoleta');
    const celdaTransfCLP  = document.getElementById('celdaEstadoTransf');
    const celdaConstUSD   = document.getElementById('celdaEstadoConstancia');

    // BOLETA / DOC SII
    if (linkBoleta) {
      if (boletaUrl) {
        linkBoleta.href = boletaUrl;
        linkBoleta.textContent = 'VER';
      } else {
        linkBoleta.removeAttribute('href');
        linkBoleta.textContent = 'PENDIENTE';
      }
    }
    if (celdaBoleta && !boletaUrl) {
      celdaBoleta.classList.add('muted');
    } else if (celdaBoleta) {
      celdaBoleta.classList.remove('muted');
    }

    // TRANSFERENCIA CLP
    if (celdaTransfCLP && linkComp) {
      if (!aplicaTransfCLP) {
        // NO APLICA
        linkComp.removeAttribute('href');
        linkComp.textContent = 'NO APLICA';
        celdaTransfCLP.classList.add('muted');
      } else {
        celdaTransfCLP.classList.remove('muted');
        if (compUrl) {
          linkComp.href = compUrl;
          linkComp.textContent = 'VER';
        } else {
          linkComp.removeAttribute('href');
          linkComp.textContent = 'SIN ARCHIVO';
        }
      }
    }

    // CONSTANCIA USD / TRANSFERENCIA COORDINADOR
    if (celdaConstUSD && linkTransf) {
      if (!aplicaConstUSD) {
        linkTransf.removeAttribute('href');
        linkTransf.textContent = 'NO APLICA';
        celdaConstUSD.classList.add('muted');
      } else {
        celdaConstUSD.classList.remove('muted');
        if (transfUrl) {
          linkTransf.href = transfUrl;
          linkTransf.textContent = 'VER';
        } else {
          linkTransf.removeAttribute('href');
          linkTransf.textContent = 'SIN ARCHIVO';
        }
      }
    }
  }


  // checkboxes + montos devueltos desde summary.docsOk
  const chkB = document.getElementById('chkBoletaOk');
  const chkC = document.getElementById('chkComprobanteOk');
  const chkT = document.getElementById('chkTransferenciaOk');
  if (chkB) chkB.checked = !!docsOk.boleta;
  if (chkC) chkC.checked = !!docsOk.comprobante;
  if (chkT) chkT.checked = !!docsOk.transferencia;

  const inpDevCLP = document.getElementById('montoDevueltoCLP');
  const inpDevUSD = document.getElementById('montoDevueltoUSD');
  if (inpDevCLP) inpDevCLP.value = montoDevCLP || 0;
  if (inpDevUSD) inpDevUSD.value = montoDevUSD || 0;

  renderTablaDescuentos();
  renderPrintActa();
}


function renderPrintActa() {
  const gid = state.filtros.grupo || '';
  let gInfo = gid ? state.caches.grupos.get(gid) : null;

  // 👉 Dos posibles contenedores:
  //    - HTML nuevo:  #printActa
  //    - Texto legado: #printSheet  (el que tenías cuando “sí funcionaba”)
  const contHtml = document.getElementById('printActa');
  const contText = document.getElementById('printSheet');

  if (!contHtml && !contText) {
    console.warn('[REN] renderPrintActa: no hay ni #printActa ni #printSheet en el DOM');
    return;
  }

  // Fallback: si no tengo gInfo pero sí hay gastos, intento deducir el grupo
  if (!gInfo && state.gastos.length) {
    const first = state.gastos[0];
    if (first?.grupoId) {
      gInfo = state.caches.grupos.get(first.grupoId) || null;
    }
  }
  if (!gInfo) {
    console.warn('[REN] renderPrintActa: sin gInfo para imprimir');
    if (contHtml) {
      contHtml.innerHTML = '<div class="acta"><p class="muted">No hay datos para imprimir.</p></div>';
    }
    if (contText) {
      contText.textContent = 'No hay datos para imprimir.';
    }
    return;
  }

  console.log('[REN] renderPrintActa -> gid:', gid,
              'gastosOk:', state.gastos.filter(it => it.rendOk).length);

  const gastosOk = state.gastos
    .filter(it => it.rendOk)
    .slice()
    .sort((a,b)=>(a.fechaMs||0)-(b.fechaMs||0));

  const totalGastos = gastosOk
    .reduce((s,it)=> s + (isFinite(+it.montoAprobado) ? +it.montoAprobado : +it.monto), 0);
  const totalAbonos = state.abonos
    .reduce((s,it)=> s + (Number(it.monto) || 0), 0);
  const totalDescuentos = state.descuentos
    .reduce((s,d)=> s + (Number(d.monto) || 0), 0);
  const gastosNetos   = totalGastos - totalDescuentos;
  const saldoEsperado = totalAbonos - gastosNetos;

  const docsOk = (state.summary && state.summary.docsOk) || {};
  const montoDevCLP = parseMonto(docsOk.montoDevueltoCLP || 0);
  const montoDevUSDPrint = Number(docsOk.montoDevueltoUSD || 0) || 0;
  const diff = saldoEsperado - montoDevCLP;

  let textoResultado = '';
  if (Math.abs(diff) < 500) {
    textoResultado = 'Saldo cuadrado (≈ $0)';
  } else if (diff > 0) {
    textoResultado = `A favor de Rai Trai: ${moneyCLP(diff)}`;
  } else {
    textoResultado = `A favor del coordinador: ${moneyCLP(-diff)}`;
  }

  // --- Estado docs para el punto 3 ---
  const summary = state.summary || {};

  // Boleta / doc SII
  const boletaUrl = coalesce(
    summary.boleta?.url,
    summary.boletaUrl,
    gInfo.urls?.boleta,
    ''
  );

  // Transferencia CLP / comprobante CLP
  // coordinadores.js → summary.transfer.comprobanteUrl
  const compUrl = coalesce(
    summary.transfer?.comprobanteUrl,          // NUEVO
    summary.transferenciaCLP?.url,
    summary.comprobanteCLP?.url,
    summary.comprobante?.url,
    summary.transfer?.url,
    summary.transferencia?.url,
    summary.transferenciaCLPUrl,
    summary.comprobanteUrl,
    gInfo.urls?.comprobante,
    ''
  );

  // Constancia USD / transferencia coordinador
  // coordinadores.js → summary.cashUsd.comprobanteUrl
  const transfUrl = coalesce(
    summary.cashUsd?.comprobanteUrl,           // NUEVO
    summary.transferenciaCoord?.url,
    summary.constanciaUSD?.url,
    summary.constancia?.url,
    summary.transferenciaCoordUrl,
    summary.constanciaUrl,
    gInfo.urls?.transferenciaCoord,
    ''
  );


  const aplicaTransfCLP  = !!(compUrl || montoDevCLP || docsOk.comprobante);
  const aplicaConstUSD   = !!(transfUrl || montoDevUSDPrint || docsOk.transferencia);

  const textoBoleta = docsOk.boleta
    ? 'Boleta / documento SII: OK'
    : (boletaUrl ? 'Boleta / documento SII: pendiente de revisión' : 'Boleta / documento SII: no registrada');

  const textoCompCLP = aplicaTransfCLP
    ? (docsOk.comprobante ? 'Comprobante transferencia CLP: OK'
                          : 'Comprobante transferencia CLP: pendiente de revisión')
    : 'Comprobante transferencia CLP: NO APLICA';

  const textoConstUSD = aplicaConstUSD
    ? (docsOk.transferencia ? 'Constancia efectivo USD / transferencia coordinador: OK'
                             : 'Constancia efectivo USD / transferencia coordinador: pendiente de revisión')
    : 'Constancia efectivo USD / transferencia coordinador: NO APLICA';

  const filasGastos = gastosOk.map(it => {
    // ✔ = tiene imagen / comprobante
    // ✗ = no tiene
    const docSymbol = it.imgUrl ? '✓' : '✗';
  
    return `
      <tr>
        <td>${it.fechaTxt || '—'}</td>
        <td>${escapeHtml(it.asunto || '')}</td>
        <td>${escapeHtml(it.categoriaRendicion || 'GASTOS DEL GRUPO')}</td>
        <td>${it.moneda || 'CLP'}</td>
        <td class="num">${moneyBy(it.montoAprobado || it.monto, it.moneda || 'CLP')}</td>
        <td style="text-align:center;">${docSymbol}</td>
      </tr>
    `;
  }).join('') || `
    <tr><td colspan="6" class="muted">Sin gastos aprobados.</td></tr>
  `;


  const filasDescuentos = state.descuentos.map(d => `
    <tr>
      <td>${escapeHtml(d.motivo || '')}</td>
      <td class="num">${moneyCLP(d.monto || 0)}</td>
    </tr>
  `).join('') || `
    <tr><td colspan="2" class="muted">Sin descuentos aplicados.</td></tr>
  `;

  const paxPrint = (gInfo.cantidadGrupo ?? gInfo.paxTotal ?? '—') || '—';

  // 1) ACTA HTML NUEVA (si existe #printActa)
  if (contHtml) {
    contHtml.innerHTML = `
      <div class="acta">
        <header class="acta-header">
          <div class="acta-head-left">
            <h1>GASTOS DEL GRUPO — RENDICIÓN DE COORDINADOR</h1>
            <p class="acta-sub">Grupo ${escapeHtml(gInfo.numero || '')} — ${escapeHtml(gInfo.nombre || '')}</p>
          </div>
          <div class="acta-head-right">
            <img src="Logo Raitrai.png" alt="Rai Trai" class="acta-logo" />
          </div>
        </header>

        <section class="acta-meta">
          <div><span>Coordinador(a)</span><strong>${escapeHtml(gInfo.coordEmail || '—')}</strong></div>
          <div><span>Destino</span><strong>${escapeHtml(gInfo.destino || '—')}</strong></div>
          <div><span>Pax total</span><strong>${paxPrint}</strong></div>
          <div><span>Programa</span><strong>${escapeHtml(gInfo.programa || '—')}</strong></div>
          <div><span>Fechas</span><strong>${escapeHtml(gInfo.fechas || '—')}</strong></div>
        </section>

        <section class="acta-section">
          <h2>1. Gastos aprobados</h2>
          <table class="acta-table">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Asunto</th>
                <th>Categoría</th>
                <th>Moneda</th>
                <th class="num">Monto aprobado</th>
                <th>Boleta</th>
              </tr>
            </thead>
            <tbody>${filasGastos}</tbody>
          </table>
        </section>

        <section class="acta-section">
          <h2>2. Descuentos de rendición</h2>
          <table class="acta-table">
            <thead>
              <tr>
                <th>Motivo</th>
                <th class="num">Monto (CLP)</th>
              </tr>
            </thead>
            <tbody>${filasDescuentos}</tbody>
          </table>
        </section>

        <section class="acta-section">
          <h2>3. Resumen financiero</h2>
          <table class="acta-table acta-resumen">
            <tbody>
              <tr><td>Abonos totales</td><td class="num">${moneyCLP(totalAbonos)}</td></tr>
              <tr><td>Gastos aprobados</td><td class="num">${moneyCLP(totalGastos)}</td></tr>
              <tr><td>Descuentos de rendición</td><td class="num">${moneyCLP(totalDescuentos)}</td></tr>
              <tr><td>Gastos netos</td><td class="num">${moneyCLP(gastosNetos)}</td></tr>
              <tr><td>Saldo esperado (abonos – gastos netos)</td><td class="num">${moneyCLP(saldoEsperado)}</td></tr>
              <tr><td>Monto devuelto (CLP)</td><td class="num">${moneyCLP(montoDevCLP)}</td></tr>
              <tr><td>Resultado final</td><td class="num">${escapeHtml(textoResultado)}</td></tr>
            </tbody>
          </table>

          <p style="margin-top:6px;font-size:9pt;">Estado de documentos:</p>
          <ul style="margin:2px 0 0 16px;font-size:9pt;padding-left:12px;">
            <li>${escapeHtml(textoBoleta)}</li>
            <li>${escapeHtml(textoCompCLP)}</li>
            <li>${escapeHtml(textoConstUSD)}</li>
          </ul>
        </section>

        <section class="acta-section acta-firmas">
          <div>
            <span>FIRMA DE OPERACIONES</span>
            <div class="firm-line"></div>
          </div>
          <div>
            <span>FIRMA DE CONTABILIDAD</span>
            <div class="firm-line"></div>
          </div>
        </section>
      </div>
    `;
  }

  // 2) TEXTO LEGADO (si existe #printSheet) por si tu CSS de impresión aún usa ese id
  if (contText && contText !== contHtml) {
    const lines = [];

    lines.push(`GASTOS DEL GRUPO - RENDICIÓN COORDINADOR`);
    lines.push(`${gInfo.numero || ''} — ${gInfo.nombre || ''}`);
    lines.push('');
    lines.push(`Coordinador(a): ${gInfo.coordEmail || ''}`);
    lines.push(`Destino:       ${gInfo.destino || ''}`);
    lines.push(`Pax total:     ${paxPrint}`);
    lines.push(`Programa:      ${gInfo.programa || ''}`);
    lines.push(`Fechas:        ${gInfo.fechas || ''}`);
    lines.push('');
    lines.push(`ABONOS:        ${moneyCLP(totalAbonos)}`);
    lines.push(`GASTOS APROB.: ${moneyCLP(totalGastos)}`);
    lines.push(`DESCUENTOS:    ${moneyCLP(totalDescuentos)}`);
    lines.push(`GASTOS NETOS:  ${moneyCLP(gastosNetos)}`);
    lines.push(`SALDO ESP.:    ${moneyCLP(saldoEsperado)}`);
    lines.push(`DEVUELTO CLP:  ${moneyCLP(montoDevCLP)}`);
    lines.push(`RESULTADO:     ${textoResultado}`);
    lines.push('');
    lines.push('DETALLE GASTOS APROBADOS:');
    gastosOk.forEach(it => {
      const fecha = it.fechaTxt || '--';
      const monto = moneyBy(it.montoAprobado || it.monto, it.moneda || 'CLP');
      lines.push(`  ${fecha}  ${monto}  ${it.asunto || ''}`);
    });

    contText.textContent = lines.join('\n');
  }
}

/* ====================== WIRING UI ====================== */
function wireUI() {
  // logout (viene del encabezado)
  try {
    document.querySelector('#btn-logout')
      ?.addEventListener('click', () =>
        signOut(auth).then(() => location.href = 'login.html'));
  } catch (_) {}

  /* ---------------------------------------------------
     Helper: reconstruye los datalist de grupos
     coordVal = email del coordinador (lowercase) o ''
  --------------------------------------------------- */
  function rebuildGroupDatalists(coordVal = '') {
    const dlG = document.getElementById('dl-grupos');          // por ID
    const dlN = document.getElementById('dl-grupos-nombre');   // por nombre
    if (dlG) dlG.innerHTML = '';
    if (dlN) dlN.innerHTML = '';

    const addOpt = (gid, info) => {
      if (!info) return;

      // ID / Nº negocio
      if (dlG) {
        const opt = document.createElement('option');
        opt.value = gid; // lo que se escribe en el input
        opt.label = `${info.numero} — ${info.nombre}`;
        dlG.appendChild(opt);
      }

      // Nombre de grupo
      if (dlN) {
        const optN = document.createElement('option');
        optN.value = info.nombre;
        optN.label = `${info.numero} — ${info.nombre}`;
        dlN.appendChild(optN);
      }
    };

    // Si hay coordinador, solo sus grupos
    if (coordVal && state.caches.groupsByCoord.has(coordVal)) {
      for (const gid of state.caches.groupsByCoord.get(coordVal)) {
        const info = state.caches.grupos.get(gid);
        addOpt(gid, info);
      }
    } else {
      // Sin coordinador: todos los grupos
      for (const [gid, info] of state.caches.grupos.entries()) {
        addOpt(gid, info);
      }
    }
  }

  /* ---------------------------------------------------
     COORDINADOR  ⇒ filtra datalist de grupos
  --------------------------------------------------- */
  const inputCoord = document.getElementById('filtroCoord');
  if (inputCoord) {
    inputCoord.addEventListener('input', (e) => {
      const val = (e.target.value || '').toLowerCase().trim();
      state.filtros.coord = val;

      // reconstruye las listas de grupos según el coord
      rebuildGroupDatalists(val);

      // si había un grupo seleccionado que no corresponde a ese coord, lo limpio
      if (state.filtros.grupo) {
        const info = state.caches.grupos.get(state.filtros.grupo);
        const coordGrupo = (info?.coordEmail || '').toLowerCase();
        if (val && coordGrupo && coordGrupo !== val) {
          state.filtros.grupo = '';
          state.filtros.grupoNombre = '';

          const inpG = document.getElementById('filtroGrupo');
          const inpN = document.getElementById('filtroNombreGrupo');
          if (inpG) inpG.value = '';
          if (inpN) inpN.value = '';
        }
      }
    });
  }

  /* ---------------------------------------------------
     GRUPO (ID) ⇒ rellena nombre de grupo + coord
  --------------------------------------------------- */
  const inputGrupo = document.getElementById('filtroGrupo');
  if (inputGrupo) {
    inputGrupo.addEventListener('input', (e) => {
      const gid = e.target.value || '';
      state.filtros.grupo = gid;

      const info = gid ? state.caches.grupos.get(gid) : null;
      if (!info) return;

      // sincroniza nombre de grupo
      const inputNombreGrupo = document.getElementById('filtroNombreGrupo');
      if (inputNombreGrupo) inputNombreGrupo.value = info.nombre;
      state.filtros.grupoNombre = info.nombre;

      // sincroniza coordinador
      const coordEmail = (info.coordEmail || '').toLowerCase();
      const inputCoord = document.getElementById('filtroCoord');
      if (inputCoord) inputCoord.value = coordEmail;
      state.filtros.coord = coordEmail;

      // reconstruye listas de grupos para ese coord
      rebuildGroupDatalists(coordEmail);
    });
  }

  /* ---------------------------------------------------
     NOMBRE DE GRUPO ⇒ rellena ID + coord
  --------------------------------------------------- */
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
          // setea ID grupo
          state.filtros.grupo = gid;
          const inpG = document.getElementById('filtroGrupo');
          if (inpG) inpG.value = gid;

          // setea coord
          const coordEmail = (info.coordEmail || '').toLowerCase();
          const inpC = document.getElementById('filtroCoord');
          if (inpC) inpC.value = coordEmail;
          state.filtros.coord = coordEmail;

          rebuildGroupDatalists(coordEmail);
          break;
        }
      }
    });
  }

  /* ---------------------------------------------------
     BOTÓN CARGAR DATOS
  --------------------------------------------------- */
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

  /* ---------------------------------------------------
     BOTÓN LIMPIAR FILTROS
  --------------------------------------------------- */
  const btnLimpiar = document.getElementById('btnLimpiarFiltros');
  if (btnLimpiar) {
    btnLimpiar.addEventListener('click', () => {
      // 1) Reset estado de filtros
      state.filtros.coord       = '';
      state.filtros.grupo       = '';
      state.filtros.grupoNombre = '';

      // 2) Limpiar inputs
      const inpCoord  = document.getElementById('filtroCoord');
      const inpGrupo  = document.getElementById('filtroGrupo');
      const inpNombre = document.getElementById('filtroNombreGrupo');

      if (inpCoord)  inpCoord.value  = '';
      if (inpGrupo)  inpGrupo.value  = '';
      if (inpNombre) inpNombre.value = '';

      // 3) Regenerar datalists con TODOS los grupos
      rebuildGroupDatalists('');

      // 4) Vaciar datos en pantalla
      state.gastos     = [];
      state.abonos     = [];
      state.descuentos = [];
      state.summary    = null;

      renderTablaGastos();
      renderResumenFinanzas();

      const pagInfo = document.getElementById('pagInfo');
      if (pagInfo) pagInfo.textContent = 'Filtros limpios.';
    });
  }

  /* ---------------------------------------------------
     AGREGAR DESCUENTO
  --------------------------------------------------- */
  const btnAgregarDesc = document.getElementById('btnAgregarDesc');
  if (btnAgregarDesc) {
    btnAgregarDesc.addEventListener('click', async () => {
      const gid = state.filtros.grupo || '';
      if (!gid) { alert('Selecciona un grupo.'); return; }
      await crearDescuento(gid);
    });
  }

  /* ---------------------------------------------------
     GUARDAR ESTADO DOCUMENTOS
  --------------------------------------------------- */
  const btnGuardarDocs = document.getElementById('btnGuardarDocs');
  if (btnGuardarDocs) {
    btnGuardarDocs.addEventListener('click', async () => {
      const gid = state.filtros.grupo || '';
      if (!gid) { alert('Selecciona un grupo.'); return; }
      await guardarDocsOk(gid);
    });
  }

  /* ---------------------------------------------------
     IMPRIMIR RENDICIÓN  (abre una ventana solo con el acta)
  --------------------------------------------------- */
  const btnPrint = document.getElementById('btnImprimirRendicion');
  if (btnPrint) {
    btnPrint.addEventListener('click', () => {
      const gid = state.filtros.grupo || '';
      if (!gid) {
        alert('Selecciona un grupo.');
        return;
      }

      // Recalcula resumen + acta en el DOM actual
      renderResumenFinanzas();

      setTimeout(() => {
        // Nos aseguramos de tener la versión más fresca del acta
        renderPrintActa();

        const contHtml = document.getElementById('printActa');
        const actaHTML = contHtml ? contHtml.innerHTML : '<p>Sin datos para imprimir.</p>';

        // Abrimos una ventana nueva SOLO para imprimir el acta
        const w = window.open('', '_blank');
        if (!w) {
          alert('No se pudo abrir la ventana de impresión (¿pop-up bloqueado?).');
          return;
        }

        const css = `
          @page { size: A4; margin: 18mm; }
          body {
            font-family: Calibri, Arial, sans-serif;
            font-size: 11pt;
            margin: 0;
            padding: 0;
          }
          .acta {
            max-width: 190mm;
            margin: 0 auto;
          }
          .acta-header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            margin-bottom: 12px;
          }
          .acta-head-left h1 {
            font-size: 16pt;
            margin: 0 0 4px;
          }
          .acta-head-left .acta-sub {
            margin: 0;
            font-size: 10pt;
            color: #4b5563;
          }
          .acta-logo {
            max-height: 40px;
            object-fit: contain;
          }
          .acta-meta {
            display: grid;
            grid-template-columns: repeat(2, minmax(0,1fr));
            gap: 4px 12px;
            margin-bottom: 12px;
            font-size: 9.5pt;
          }
          .acta-meta span {
            display: block;
            text-transform: uppercase;
            font-size: 8pt;
            color: #6b7280;
          }
          .acta-meta strong {
            font-weight: 600;
          }
          .acta-section {
            margin-top: 10px;
          }
          .acta-section h2 {
            font-size: 11pt;
            margin: 0 0 4px;
          }
          .acta-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 9.5pt;
          }
          .acta-table th,
          .acta-table td {
            border: 1px solid #e5e7eb;
            padding: 3px 4px;
            vertical-align: top;
          }
          .acta-table th {
            background: #f9fafb;
            font-weight: 600;
          }
          .acta-table .num {
            text-align: right;
            white-space: nowrap;
          }
          .acta-resumen td:first-child {
            width: 70%;
          }
          .acta-firmas {
            display: flex;
            justify-content: space-between;
            gap: 16mm;
            margin-top: 18mm;
            font-size: 9pt;
          }
          .acta-firmas .firm-line {
            border-bottom: 1px solid #000;
            margin-top: 18mm;
          }
        `;

        w.document.open();
        w.document.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Rendición de coordinador</title>
  <style>${css}</style>
</head>
<body>
  ${actaHTML}
</body>
</html>`);
        w.document.close();

        // Damos un pequeño tiempo para que cargue y luego imprimimos
        setTimeout(() => {
          w.focus();
          w.print();
          w.close();
        }, 200);
      }, 100);
    });
  }


  // Al iniciar, dejo los datalist llenos (todos los grupos o filtrados por coord si ya está)
  rebuildGroupDatalists((state.filtros.coord || '').toLowerCase());
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
