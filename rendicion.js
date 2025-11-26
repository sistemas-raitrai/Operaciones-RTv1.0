/* Revisión financiera v2 — carga bajo demanda + cierres + comentarios rechazo */
import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, collectionGroup, getDocs, query, where, doc, getDoc, updateDoc, setDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

import { getStorage, ref as sRef, uploadBytes, getDownloadURL } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-storage.js';
const storage = getStorage(app);

const auth = getAuth(app);

/* ===== MODO PRUEBA (permitir mismo usuario en REV1/REV2/REV PAGO) ===== */
const TEST_SINGLE_USER_MODE = true; 
// Cambia a false para volver a exigir usuarios distintos.

/* ====================== STATE ====================== */
const state = {
  user: null,
  filtros: { estado:'', tipo:'', coord:'', grupo:'' },
  sort: { key:'', dir:'asc' },
  caches: {
    grupos: new Map(),          // gid -> {numero,nombre,coordEmail, urls...}
    coords: [],                 // emails/nombres para datalist
    groupsByCoord: new Map(),   // coordEmail -> Set(gid)
  },
  items: [],        // filas normalizadas
  cierre: {
    pagosSeleccionados: new Set(),   // ids de abonos para marcar transferencia
    grupoActual: null,
  }
};

/* ====================== UTILS ====================== */
const norm = (s='') => s.toString().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
const coalesce = (...xs) => xs.find(v => v !== undefined && v !== null && v !== '') ?? '';
const parseMonto = (any) => {
  if (any == null) return 0;
  if (typeof any === 'number' && isFinite(any)) return Math.round(any);
  const n = parseInt(String(any).replace(/[^\d-]/g,''),10);
  return isFinite(n) ? n : 0;
};
const moneyCLP = n => (isFinite(+n) ? (+n).toLocaleString('es-CL',{style:'currency',currency:'CLP',maximumFractionDigits:0}) : '—');
const moneyBy = (n, curr='CLP') => (isFinite(+n) ? (+n).toLocaleString('es-CL',{style:'currency',currency:curr,maximumFractionDigits:2}) : '—');

function deriveEstado(x) {
  const s = (x.estado || '').toString().toLowerCase();
  if (s === 'cerrada') return 'cerrada';

  const tipo = (x.tipo || '').toLowerCase();
  const r1 = (x.rev1 || '').toLowerCase();
  const r2 = (x.rev2 || '').toLowerCase();
  const rp = (x.revPago || '').toLowerCase();

  // Reglas de rechazo general
  if (r1 === 'rechazado' && r2 !== 'aprobado') return 'rechazado';
  if (r2 === 'rechazado') return 'rechazado';
  if (rp === 'rechazado') return 'rechazado';

  if (tipo === 'abono') {
    // para abonos, si quedó pagado => cerrada
    if (rp === 'pagado') return 'cerrada';
    if (r1 === 'aprobado' && r2 === 'aprobado') return 'aprobado';
    return 'pendiente';
  }

  // GASTO: caso especial → Rev1 rechazado + Rev2 aprobado == Aprobado (monto ajustado)
  if (tipo === 'gasto') {
    if ((r1 === 'aprobado' && r2 === 'aprobado') || (r1 === 'rechazado' && r2 === 'aprobado')) {
      return 'aprobado';
    }
    return 'pendiente';
  }

  return 'pendiente';
}

function montoGastoEfectivo(it){
  // si el gasto está aprobado (o Rev1=rechazado & Rev2=aprobado), usar montoAprobado
  const ok = deriveEstado(it) === 'aprobado';
  return (ok && isFinite(+it.montoAprobado)) ? +it.montoAprobado : +it.monto;
}

// ====== FECHAS: parsear lo que venga (Timestamp, número, string) ======
function _toMs(v){
  if (v == null) return 0;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000; // s → ms
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
    raw.createdAt, raw.created, raw.ts, raw.at, raw.timestamp, raw.time,
    raw.revision1?.at, raw.pago?.at
  ];
  for (const c of cands){ const ms = _toMs(c); if (ms) return ms; }
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

  const gs = await getDocs(collection(db,'grupos'));
  const dlG = document.getElementById('dl-grupos');
  const dlC = document.getElementById('dl-coords');
  dlG.innerHTML = ''; dlC.innerHTML = '';

  gs.forEach(d => {
    const x = d.data() || {};
    const gid = d.id;
    const numero = coalesce(x.numeroNegocio, x.numNegocio, x.idNegocio, gid);
    const nombre = coalesce(x.nombreGrupo, x.aliasGrupo, x.nombre, x.grupo, gid);
    const coordEmail = coalesce(
      x.coordinadorEmail, x.coordinador?.email, x.coordinador, x.coord, x.responsable, x.owner, ''
    ).toLowerCase();

    state.caches.grupos.set(gid, {
      numero, nombre, coordEmail,
      urls:{
        boleta: x?.finanzas?.boletaUrl || x.boletaUrl || '',
        comprobante: x?.finanzas?.comprobanteUrl || x.comprobanteUrl || ''
      },
      metas:{
        diasTrabajados: Number(x?.finanzas?.diasTrabajados || x.diasTrabajados || 0)
      }
    });

    if (coordEmail) {
      if (!state.caches.groupsByCoord.has(coordEmail)) state.caches.groupsByCoord.set(coordEmail, new Set());
      state.caches.groupsByCoord.get(coordEmail).add(gid);
      if (!state.caches.coords.includes(coordEmail)) state.caches.coords.push(coordEmail);
    }

    const opt = document.createElement('option');
    opt.value = gid;
    opt.label = `${numero} — ${nombre}`;
    dlG.appendChild(opt);
  });

  for (const email of state.caches.coords) {
    const opt = document.createElement('option');
    opt.value = email;
    opt.label = email;
    dlC.appendChild(opt);
  }
}

/* ====================== NORMALIZADOR ====================== */
function toItem(grupoId, gInfo, raw, hintedTipo) {
  const tipo0 = (raw.tipo || raw.type || hintedTipo || '').toString().toLowerCase();
  const tipo = (tipo0 === 'abono' || tipo0 === 'pago') ? 'abono' : 'gasto';

  const brutoMonto = coalesce(
    raw.monto, raw.montoCLP, raw.neto, raw.importe, raw.valor, raw.total, raw.totalCLP, raw.monto_str, 0
  );
  const monto = parseMonto(brutoMonto);
  const moneda = (raw.moneda || raw.currency || 'CLP').toString().toUpperCase();

    // ⬇️ pegar justo después de const monto... / const moneda...
  const montoAprobadoRaw = coalesce(
    raw.montoAprobado, raw.aprobado, raw.monto_aprobado, null
  );
  const montoAprobado = (montoAprobadoRaw == null) ? monto : parseMonto(montoAprobadoRaw);

  const rev1  = (raw.revision1?.estado || raw.rev1?.estado || raw.rev1 || '').toString().toLowerCase() || 'pendiente';
  const rev2  = (raw.revision2?.estado || raw.rev2?.estado || raw.rev2 || '').toString().toLowerCase() || 'pendiente';
  const revPago = tipo==='abono'
    ? (raw.pago?.estado || raw.revPago || '').toString().toLowerCase() || 'pendiente'
    : '';

  const rev1By = coalesce(raw.revision1?.user, raw.rev1By, '').toLowerCase();
  const rev2By = coalesce(raw.revision2?.user, raw.rev2By, '').toLowerCase();
  const pagoBy = coalesce(raw.pago?.user, raw.revPagoBy, '').toLowerCase();

  const asunto = coalesce(raw.asunto, raw.detalle, raw.descripcion, raw.concepto, raw.motivo, '');
  // Si viene desde CG:gastos, raw.__coordPath trae el coordId real del path
  const coordFromPath = (raw.__coordPath || '').toLowerCase();
  const coordEmailCat = (gInfo?.coordEmail || '').toLowerCase();
  const coordRaw = coalesce(raw.coordinadorEmail, raw.coordinador, '').toLowerCase();
  const coord = coordFromPath || coordEmailCat || coordRaw;

  const fechaMs  = pickFechaMs(raw);
  const fechaTxt = fechaMs ? fmtDDMMYYYY(fechaMs) : '';


  return {
    id: raw.id || raw._id || '',
    __from: raw.__from || '',
    tipo,
    grupoId,
    nombreGrupo: gInfo?.nombre || '',
    numeroNegocio: gInfo?.numero || grupoId,
    coordinador: coord || '',
    asunto,
    monto,
    moneda,
    montoAprobado, 
    rev1, rev2, revPago,
    rev1By, rev2By, pagoBy,
    fechaMs,
    fechaTxt,
    comentario1: raw.revision1?.comentario || '',
    comentario2: raw.revision2?.comentario || '',
    comentarioPago: raw.pago?.comentario || '',
    cerrada: !!raw.cerrada,
    estado: deriveEstado({ tipo, rev1, rev2, revPago, estado: raw.estado, cerrada: raw.cerrada }),
  };
}

/* ====================== LECTURA DE DATOS ====================== */
// === REEMPLAZO COMPLETO ===
// Lee TODOS los gastos desde collectionGroup('gastos') y filtra localmente
// por coordinador y/o grupo. Sin 'where' → no requiere índice.
async function fetchGastosCGFiltered({ coordHint = '', grupoId = '' } = {}) {
  const out = [];
  try {
    // normalización tolerante para coord: quita acentos, minúsculas, une espacios/guiones
    const normCoord = (s='') =>
      s.toString()
       .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
       .toLowerCase()
       .replace(/[\s_]+/g, '-')        // "elias lagos" -> "elias-lagos"
       .trim();

    const hint = normCoord(coordHint);

    const snap = await getDocs(collectionGroup(db, 'gastos'));
    snap.forEach(docSnap => {
      const x = docSnap.data() || {};

      // 1) Derivar GID de varias formas (incluye numeroNegocio + identificador)
      const gid =
        coalesce(
          x.grupoId, x.grupo_id, x.gid, x.idGrupo, x.grupo, x.id_grupo,
          (x.numeroNegocio && x.identificador) ? `${x.numeroNegocio}-${x.identificador}` : ''
        );
      if (!gid) return;                         // sin grupo no mostramos

      // 2) Coord real del path: coordinadores/{coordId}/gastos/{id}
      const coordFromPath = (docSnap.ref.parent.parent?.id || '').toLowerCase();

      // 3) Filtrado por coordinador (si el usuario escribió algo)
      if (hint) {
        const blob = [
          normCoord(coordFromPath),
          normCoord(x.coordinadorEmail || ''),
          normCoord(x.coordinador || '')
        ].join(' ');
        if (!blob.includes(hint)) return;       // no coincide → fuera
      }

      // 4) Filtrado por grupo (si se pidió)
      if (grupoId && gid !== grupoId) return;

      // 5) Info de catálogo del grupo
      const gInfo = state.caches.grupos.get(gid) ||
                    { numero: gid, nombre: '', coordEmail: coordFromPath };

      // 6) Empaquetar y normalizar
      const enriched = {
        id: docSnap.id,
        ...x,
        __from: 'cg:gastos',
        __coordPath: coordFromPath,            // ← nos permite escribir luego
      };
      out.push(toItem(gid, gInfo, enriched, 'gasto'));
    });
  } catch (e) {
    console.warn('fetchGastosCGFiltered', e);
  }
  return out;
}

// ABONOS (PAGOS): grupos/{gid}/finanzas_abonos/*
async function fetchAbonosByGroup(gid) {
  const out = [];
  if (!gid) return out;
  try {
    const ref = collection(db, 'grupos', gid, 'finanzas_abonos');
    const snap = await getDocs(ref);
    const gInfo = state.caches.grupos.get(gid) || { numero: gid, nombre:'', coordEmail:'' };
    snap.forEach(d => {
      const x = { id: d.id, ...d.data(), __from:'abono' };
      out.push(toItem(gid, gInfo, x, 'abono'));
    });
  } catch (e) {
    console.warn('fetchAbonosByGroup', e);
  }
  return out;
}

/* Carga principal según filtros */
async function loadDataForFilters() {
  state.items = [];
  const tipo  = state.filtros.tipo;    // '', 'gasto', 'abono'
  const coord = (state.filtros.coord || '').toLowerCase(); // puede ser email, nombre o coordId
  const gid   = state.filtros.grupo || '';

  // Si no eliges ni coord ni grupo, no cargamos (igual que antes)
  if (!coord && !gid) return [];

  const tasks = [];

  // GASTOS desde CG (filtrado local por coord y opcionalmente por grupo)
  if (!tipo || tipo === 'gasto') {
    tasks.push(fetchGastosCGFiltered({ coordHint: coord, grupoId: gid }));
  }

  // ABONOS por grupo si hay gid
  if ((!tipo || tipo === 'abono') && gid) {
    tasks.push(fetchAbonosByGroup(gid));
  }

  const batches = await Promise.all(tasks);
  state.items = batches.flat();
  return state.items;
}

/* ====================== ESCRITURA: REVISIONES ====================== */
// Devuelve el doc correcto para una fila (gasto o abono)
function getDocRefForItem(it) {
  return (it.tipo === 'gasto')
    ? doc(db, 'coordinadores', it.coordinador, 'gastos', it.id)          // GASTOS
    : doc(db, 'grupos', it.grupoId, 'finanzas_abonos', it.id);           // ABONOS/PAGOS
}

// which: 'rev1' | 'rev2' | 'revPago'
// nuevoEstado: 'pendiente' | 'aprobado' | 'rechazado' | ('pagado' solo para revPago)
// comentario: texto obligatorio cuando se rechaza
async function saveRevision(it, which, nuevoEstado, comentario='') {
  const me  = (auth.currentUser?.email || '').toLowerCase();
  const ref = getDocRefForItem(it);

  // ===== Regla de usuarios distintos (se desactiva en modo prueba) =====
  if (!TEST_SINGLE_USER_MODE) {
    if (which === 'rev1' && it.rev2By && it.rev2By === me) {
      alert('REV.1 debe ser distinta de REV.2'); return false;
    }
    if (which === 'rev2' && it.rev1By && it.rev1By === me) {
      alert('REV.2 debe ser distinta de REV.1'); return false;
    }
    if (which === 'revPago' && (me === it.rev1By || me === it.rev2By)) {
      alert('REV. PAGO debe ser distinta de REV.1 y REV.2'); return false;
    }
  }

  const path = (k) => (k === 'rev1' ? 'revision1' : (k === 'rev2' ? 'revision2' : 'pago'));

  const payload = {
    [`${path(which)}.estado`]: nuevoEstado,
    [`${path(which)}.user`]: me,
    [`${path(which)}.at`]: Date.now(),
  };
  if (nuevoEstado === 'rechazado' && comentario) {
    payload[`${path(which)}.comentario`] = comentario;
  }
  // Cerrar automáticamente si se marca pago como "pagado"
  if (which === 'revPago' && nuevoEstado === 'pagado') {
    payload['cerrada'] = true;
  }

  try {
    await updateDoc(ref, payload);

        // Aviso al revisor 1 si Rev2 rechaza
    if (which === 'rev2' && nuevoEstado === 'rechazado' && it.rev1By) {
      await updateDoc(ref, {
        'revision1.notify': 'rechazado',
        'revision1.notifyAt': Date.now()
      });
    }

    // Refrescar local
    if (which === 'rev1') { it.rev1 = nuevoEstado; it.rev1By = me; if (comentario) it.comentario1 = comentario; }
    if (which === 'rev2') { it.rev2 = nuevoEstado; it.rev2By = me; if (comentario) it.comentario2 = comentario; }
    if (which === 'revPago') {
      it.revPago = nuevoEstado; it.pagoBy = me; if (comentario) it.comentarioPago = comentario;
      if (nuevoEstado === 'pagado') it.cerrada = true;
    }
    it.estado = deriveEstado(it);
    return true;
  } catch (e) {
    console.error('saveRevision', e);
    alert('No se pudo guardar la revisión.');
    return false;
  }
}

async function saveMontoAprobado(it, nuevoMonto){
  if (it.tipo !== 'gasto') return false;
  const ref = doc(db, 'coordinadores', it.coordinador, 'gastos', it.id);
  const val = parseMonto(nuevoMonto);
  try{
    await updateDoc(ref, { montoAprobado: val });
    it.montoAprobado = val;
    return true;
  }catch(e){
    console.error('saveMontoAprobado', e);
    alert('No se pudo guardar el MONTO APROBADO.');
    return false;
  }
}

/* ====================== TABLA ====================== */
function sortItems(arr){
  const { key, dir } = state.sort;
  if (!key) return arr.slice();
  const m = dir==='asc' ? 1 : -1;
  const val = (it,k)=>{
    switch(k){
      case 'tipo': return it.tipo;
      case 'grupo': return it.grupoId;
      case 'coord': return it.coordinador;
      case 'asunto': return it.asunto || '';
      case 'monto': return Number(it.monto) || 0;
      case 'montoAprobado': return Number(it.montoAprobado) || Number(it.monto) || 0;
      case 'moneda': return it.moneda || 'CLP';
      case 'rev1': return it.rev1 || '';
      case 'rev2': return it.rev2 || '';
      case 'revpago': return it.revPago || '';
      case 'estado': return it.estado || '';
      default: return '';
    }
  };
  return arr.slice().sort((a,b)=>{
    const A = val(a,key), B = val(b,key);
    if (typeof A==='number' && typeof B==='number') return (A-B)*m;
    return String(A).localeCompare(String(B),'es',{numeric:true,sensitivity:'base'})*m;
  });
}

function applyFiltersLocal(arr){
  const f = state.filtros;
  let out = arr;

  // tipo
  if (f.tipo) out = out.filter(x => x.tipo === f.tipo);

  // estado
  if (f.estado === 'pagables') {
    out = out.filter(x => x.tipo==='abono' && x.rev1==='aprobado' && x.rev2==='aprobado' && x.revPago!=='pagado');
  } else if (f.estado === 'cerrada') {
    out = out.filter(x => x.estado === 'cerrada' || x.cerrada === true);
  } else if (f.estado) {
    out = out.filter(x => x.estado === f.estado);
  }

  // coord y grupo (si se escribieron a mano, tolerante)
  if (f.coord) out = out.filter(x => norm(x.coordinador).includes(norm(f.coord)));
  if (f.grupo) out = out.filter(x => norm([x.grupoId,x.nombreGrupo,x.numeroNegocio].join(' ')).includes(norm(f.grupo)));

  return out;
}

function renderTable(){
  const tbody = document.querySelector('#tblFinanzas tbody');
  const resumen = document.getElementById('resumen');
  const totalesEl = document.getElementById('totales');
  const pagInfo = document.getElementById('pagInfo');

  const filtered = applyFiltersLocal(state.items);
  const data = sortItems(filtered);

  // Totales
  let sumG = 0, sumA = 0;
  data.forEach(x => { if (x.tipo==='gasto') sumG += x.monto; else sumA += x.monto; });
  const saldo = sumA - sumG;
  totalesEl.textContent = `GASTOS: ${moneyCLP(sumG)} · ABONOS: ${moneyCLP(sumA)} · SALDO: ${moneyCLP(saldo)}`;

  // cuerpo
  tbody.innerHTML = '';
  if (!data.length){
    const tr=document.createElement('tr');
    const td=document.createElement('td');
    td.colSpan=10; td.innerHTML='<div class="muted">SIN MOVIMIENTOS PARA ESTE CRITERIO.</div>';
    tr.appendChild(td); tbody.appendChild(tr);
  } else {
    const frag=document.createDocumentFragment();
    data.forEach(x=>{
      const tr=document.createElement('tr');

      const tdTipo = document.createElement('td'); tdTipo.textContent=(x.tipo||'—').toUpperCase();
      const tdGrupo= document.createElement('td'); tdGrupo.innerHTML=`<div class="mono">${x.grupoId}</div><span class="small">${(x.numeroNegocio||'')}${x.nombreGrupo?' · '+x.nombreGrupo:''}</span>`;
      const tdCoord= document.createElement('td'); tdCoord.innerHTML=`<span>${x.coordinador||'—'}</span>`;
      const tdAsunto=document.createElement('td'); tdAsunto.textContent=x.asunto || '—';
      const tdMonto =document.createElement('td'); tdMonto.innerHTML=`<span class="mono">${moneyBy(x.monto, x.moneda||'CLP')}</span>`;
      // Monto Aprobado (solo aplica a gastos, editable) — REEMPLAZO
      const tdMontoAprob = document.createElement('td');
      if (x.tipo === 'gasto') {
        const wrap = document.createElement('div');
        wrap.className = 'monto-aprob-wrap rev-cell';
      
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'revbtn ghost'; // mismo look que REV1/REV2 (fondo transparente)
        btn.title = 'Guardar monto aprobado';
        btn.textContent = '💾';
      
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.step = '1';
        inp.min = '0';
        inp.inputMode = 'numeric';
        inp.className = 'mono monto-aprob-input';
        inp.value = isFinite(+x.montoAprobado) ? +x.montoAprobado : +x.monto;
      
        const doSave = async () => {
          const val = parseMonto(inp.value);
          const saved = await saveMontoAprobado(x, val);
          if (saved) {
            wrap.classList.add('saved');
            setTimeout(() => wrap.classList.remove('saved'), 800);
            renderCierres();
          }
        };
      
        btn.onclick = doSave;
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSave(); });
      
        // Orden: botón a la izquierda, input a la derecha
        wrap.append(btn, inp);
        tdMontoAprob.appendChild(wrap);
      } else {
        tdMontoAprob.innerHTML = '<span class="muted">—</span>';
      }

      const tdMon  =document.createElement('td'); tdMon.textContent=(x.moneda||'CLP');

      // helper botón + correo + comentario
      const makeRev = (which, estado, by, comentario) => {
        const td = document.createElement('td');
        // REV PAGO no aplica a gastos → celda gris
        if (which==='revPago' && x.tipo!=='abono') { td.innerHTML='<span class="muted">—</span>'; return td; }

        const wrap=document.createElement('div'); wrap.className='rev-cell';
        const btn=document.createElement('button'); btn.className='revbtn'; btn.type='button';
        const who=document.createElement('span'); who.className='small';

        const apply = () => {
          const cur = (which==='rev1'? x.rev1 : which==='rev2'? x.rev2 : x.revPago) || 'pendiente';
          if (which==='revPago' && cur==='pagado') { btn.textContent='✓'; btn.dataset.state='aprobado'; }
          else if (cur==='aprobado') { btn.textContent='✓'; btn.dataset.state='aprobado'; }
          else if (cur==='rechazado') { btn.textContent='✗'; btn.dataset.state='rechazado'; }
          else { btn.textContent='—'; btn.dataset.state='pendiente'; }
          who.textContent = (which==='rev1'? x.rev1By : which==='rev2'? x.rev2By : x.pagoBy) || '';
        };
        apply();

        // icono comentario (si rechazo)
        const icon = document.createElement('button');
        icon.className='icon-btn warn';
        icon.title='Ver comentario';
        icon.textContent='!';
        const hasComment = !!((which==='rev1' && x.comentario1) || (which==='rev2' && x.comentario2) || (which==='revPago' && x.comentarioPago));
        icon.style.display = hasComment ? '' : 'none';
        icon.onclick = () => {
          const msg = (which==='rev1'? x.comentario1 : which==='rev2'? x.comentario2 : x.comentarioPago) || '(sin comentario)';
          alert(msg.toUpperCase());
        };

        btn.onclick = async () => {
          const cur = (which==='rev1'? x.rev1 : which==='rev2'? x.rev2 : x.revPago) || 'pendiente';
          let next = 'pendiente';
          if (cur==='pendiente') next='aprobado';
          else if (cur==='aprobado') next = (which==='revPago' ? 'rechazado' : 'rechazado');
          else if (cur==='rechazado') next='pendiente';
          // Para REV.PAGO usamos 'pagado' como "aprobado final"
          if (which==='revPago' && next==='aprobado') next='pagado';

          let comentario = '';
          if (next==='rechazado') {
            comentario = await promptComentario(`MOTIVO DEL RECHAZO — ${which.toUpperCase()}`);
            if (comentario === null) return; // canceló
          }

          const ok = await saveRevision(x, which, next, comentario);
          if (ok) {
            apply();
            icon.style.display = (next==='rechazado' ? '' : 'none');
            tdEstado.innerHTML = `<span class="badge ${x.estado}">${x.estado.toUpperCase()}</span>`;
            // refrescar cierres si cambia revPago
            renderCierres();
          }
        };

        wrap.append(btn, who, icon);
        td.appendChild(wrap);
        return td;
      };

      const tdR1 = makeRev('rev1', x.rev1, x.rev1By, x.comentario1);
      const tdR2 = makeRev('rev2', x.rev2, x.rev2By, x.comentario2);
      const tdRP = makeRev('revPago', x.revPago, x.pagoBy, x.comentarioPago);

      const tdEstado=document.createElement('td');
      tdEstado.innerHTML = `<span class="badge ${x.estado}">${x.estado.toUpperCase()}</span>`;

      tr.append(tdTipo, tdGrupo, tdCoord, tdAsunto, tdMonto, tdMontoAprob, tdMon, tdR1, tdR2, tdRP, tdEstado);
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
  }

  resumen.textContent = `MOSTRANDO ${data.length} / TOTAL ${state.items.length}`;
  pagInfo.textContent = 'Listo.';
  applySortHeaderUI();
  renderCierres();
}

function applySortHeaderUI(){
  document.querySelectorAll('#tblFinanzas thead th.sortable').forEach(th=>{
    th.classList.remove('asc','desc');
    if (th.dataset.sortKey === state.sort.key) th.classList.add(state.sort.dir);
  });
}

/* ====================== CIERRES ====================== */
function groupByMonedaTotal(rows){
  const map = new Map();
  rows.forEach(r=>{
    const k = r.moneda || 'CLP';
    map.set(k, (map.get(k)||0) + Number(r.monto||0));
  });
  return [...map.entries()].map(([mon, tot]) => `${mon} ${tot.toLocaleString('es-CL')}`).join(' · ');
}

function renderCierres(){
  const tipo = state.filtros.tipo;
  const gid = state.filtros.grupo || '';
  const coord = state.filtros.coord || (gid ? state.caches.grupos.get(gid)?.coordEmail : '');

  // Mostrar cierres sólo si hay contexto (grupo o coord) + tipo elegido
  const showPagos = (!tipo || tipo==='abono') && gid;
  const showGastos = (!tipo || tipo==='gasto' || tipo==='') && gid;

  // PAGOS
  const boxP = document.getElementById('cierrePagos');
  const listP= document.getElementById('cierrePagosList');
  const totP = document.getElementById('cierrePagosTotals');
  if (showPagos){
    let pagos = applyFiltersLocal(state.items).filter(x => x.tipo==='abono' && x.rev1==='aprobado' && x.rev2==='aprobado' && x.revPago!=='pagado');
    pagos.sort((a,b) => (b.fechaMs||0) - (a.fechaMs||0)); // más recientes arriba

    boxP.style.display = '';
    listP.innerHTML = '';
    if (!pagos.length) {
      listP.innerHTML = '<div class="muted">No hay pagos aprobados pendientes de transferencia.</div>';
      totP.textContent = 'TOTAL: —';
    } else {
      pagos.forEach(p=>{
        const id = `selp_${p.id}`;
        const row = document.createElement('label');
        row.className='row';
        const etiqueta = p.fechaTxt || p.id;
        row.innerHTML = `
          <input type="checkbox" id="${id}" ${state.cierre.pagosSeleccionados.has(p.id)?'checked':''}/>
          <span class="mono" title="${p.id}">${etiqueta}</span> · ${p.asunto||'—'} · ${p.moneda||'CLP'} ${(p.monto||0).toLocaleString('es-CL')}
        `;
        listP.appendChild(row);
        row.querySelector('input').onchange = (e) => {
          if (e.target.checked) state.cierre.pagosSeleccionados.add(p.id);
          else state.cierre.pagosSeleccionados.delete(p.id);
          const elig = pagos.filter(z => state.cierre.pagosSeleccionados.has(z.id));
          totP.textContent = 'TOTAL: ' + (elig.length ? groupByMonedaTotal(elig) : '—');
        };
      });
      const elig = pagos.filter(z => state.cierre.pagosSeleccionados.has(z.id));
      totP.textContent = 'TOTAL: ' + (elig.length ? groupByMonedaTotal(elig) : '—');
    }
  } else {
    boxP.style.display = 'none';
  }

  // GASTOS
  const boxG = document.getElementById('cierreGastos');
  if (showGastos){
    // Gasto aprobado: (Rev1=aprobado & Rev2=aprobado) OR (Rev1=rechazado & Rev2=aprobado)
    const gastosAprob = state.items.filter(x =>
      x.tipo==='gasto' && x.grupoId===gid &&
      ((x.rev1==='aprobado' && x.rev2==='aprobado') || (x.rev1==='rechazado' && x.rev2==='aprobado'))
    );
    const abonosAprob = state.items.filter(x =>
      x.tipo==='abono' && x.grupoId===gid && x.rev1==='aprobado' && x.rev2==='aprobado' && x.revPago==='pagado'
    );
    const sumG = gastosAprob.reduce((s,x)=> s + montoGastoEfectivo(x), 0);

    const sumA = abonosAprob.reduce((s,x)=> s + x.monto, 0);
    const saldo = sumA - sumG;
    document.getElementById('sumGastosAprobados').textContent = moneyCLP(sumG);
    document.getElementById('sumAbonosAprobados').textContent = moneyCLP(sumA);
    document.getElementById('saldoAG').textContent = moneyCLP(saldo);

    // URLs desde catálogo
    const gInfo = state.caches.grupos.get(gid) || {};
    const boletaUrl = gInfo?.urls?.boleta || '';
    const compUrl   = gInfo?.urls?.comprobante || '';
    const dias = Number(gInfo?.metas?.diasTrabajados || 0);
    document.getElementById('boletaUrl').textContent = boletaUrl ? 'VER' : '—';
    document.getElementById('boletaUrl').href = boletaUrl || '#';
    document.getElementById('comprobanteUrl').textContent = compUrl ? 'VER' : '—';
    document.getElementById('comprobanteUrl').href = compUrl || '#';
    document.getElementById('diasTrab').value = dias || 0;

    calcPagoNetoGuia();
    boxG.style.display = '';
  } else {
    boxG.style.display = 'none';
  }
}

/* ====================== MODAL COMENTARIO ====================== */
function promptComentario(title='COMENTARIO'){
  const back = document.getElementById('modalBack');
  const ttl  = document.getElementById('modalTitle');
  const txt  = document.getElementById('modalText');
  const btnOk= document.getElementById('modalOk');
  const btnC = document.getElementById('modalCancel');

  ttl.textContent = title.toUpperCase();
  txt.value = '';
  back.style.display='flex';

  return new Promise(resolve => {
    const close = (v)=>{ back.style.display='none'; btnOk.onclick=null; btnC.onclick=null; resolve(v); };
    btnOk.onclick = () => close(txt.value.trim() || '');
    btnC.onclick  = () => close(null);
  });
}

/* ====================== ACCIONES CIERRE ====================== */
document.getElementById('btnMarcarTransferencia').onclick = async () => {
  const gid = state.filtros.grupo || '';
  if (!gid) { alert('Selecciona un grupo.'); return; }

  const elig = state.items.filter(x =>
    x.tipo==='abono' && x.grupoId===gid && state.cierre.pagosSeleccionados.has(x.id)
  );
  if (!elig.length) { alert('Selecciona pagos.'); return; }

  // Verificación de suma:
  const sumaCLP = elig
    .filter(z => (z.moneda || 'CLP').toUpperCase() === 'CLP')
    .reduce((s,z)=> s + (Number(z.monto)||0), 0);

  const userMonto = parseMonto(document.getElementById('montoTransferido').value || 0);
  if (!userMonto) {
    alert('Ingresa el MONTO TRANSFERIDO (CLP).');
    return;
  }
  if (sumaCLP !== userMonto) {
    const cont = confirm(`ATENCIÓN: la suma de abonos seleccionados (${sumaCLP.toLocaleString('es-CL')}) es distinta al monto ingresado (${userMonto.toLocaleString('es-CL')}). ¿Continuar de todas formas?`);
    if (!cont) return;
  }

  // Subir comprobante (opcional pero recomendado)
  let compUrl = '';
  const fileEl = document.getElementById('fileComprobante');
  const f = fileEl?.files?.[0];
  if (f) {
    try{
      const nameSafe = f.name.replace(/[^\w.\-]+/g,'_');
      const r = sRef(storage, `grupos/${gid}/finanzas/transferencias/${Date.now()}_${nameSafe}`);
      const up = await uploadBytes(r, f);
      compUrl = await getDownloadURL(up.ref);
    }catch(e){
      console.warn('upload comprobante', e);
      alert('No se pudo subir el comprobante. Puedes intentar de nuevo o continuar sin archivo.');
    }
  }

  const me = (auth.currentUser?.email || '').toLowerCase();

  try {
    // 1) Registrar la transferencia "lote" (para trazabilidad)
    const transfRef = doc(db, 'grupos', gid, 'finanzas', `transfer_${Date.now()}`);
    await setDoc(transfRef, {
      tipo: 'abonos',
      abonos: elig.map(p => p.id),
      montoCLP: userMonto,
      comprobanteUrl: compUrl || '',
      nota: (document.getElementById('notaTransferencia').value || '').trim(),
      by: me,
      at: Date.now()
    });

    // 2) Marcar cada abono como pagado + cerrar
    for (const p of elig) {
      const ref = getDocRefForItem(p);
      await updateDoc(ref, {
        'pago.estado': 'pagado',
        'pago.user': me,
        'pago.at': Date.now(),
        'pago.comprobanteUrl': compUrl || '',
        'cerrada': true
      });
      p.revPago = 'pagado'; p.pagoBy = me; p.cerrada = true; p.estado = deriveEstado(p);
    }

    state.cierre.pagosSeleccionados.clear();
    renderTable();
    alert('Transferencia registrada y abonos cerrados.');
  } catch (e) {
    console.error('transferencia abonos', e);
    alert('No se pudo registrar la transferencia.');
  }
};



function calcPagoNetoGuia(){
  const dias = Number(document.getElementById('diasTrab').value || 0);
  const valor= Number(document.getElementById('valorDia').value || 70000);
  const ret = Number(document.getElementById('retencionSII').value || 0.14);
  const bruto = dias * valor;
  const neto  = Math.round(bruto * (1 - ret));
  document.getElementById('pagoNetoGuia').textContent = moneyCLP(neto);
  return { bruto, neto, dias, valor, ret };
}

document.getElementById('diasTrab').oninput = calcPagoNetoGuia;
document.getElementById('valorDia').oninput = calcPagoNetoGuia;
document.getElementById('retencionSII').onchange = calcPagoNetoGuia;

document.getElementById('btnMarcarPagoGuia').onclick = async () => {
  const gid = state.filtros.grupo || '';
  if (!gid) { alert('Selecciona un grupo.'); return; }
  const { bruto, neto, dias, valor, ret } = calcPagoNetoGuia();
  try{
    // guardamos resumen simple en grupos/{gid}/finanzas/summary
    const ref = doc(db,'grupos', gid, 'finanzas', 'summary');
    await setDoc(ref, {
      pagoDias:{ dias, valor, retencion:ret, bruto, neto, by:(auth.currentUser?.email||'').toLowerCase(), at:Date.now() },
    }, { merge:true });
    alert('Pago de días registrado.');
  }catch(e){ console.warn('pago dias', e); alert('No se pudo registrar el pago.'); }
};

document.getElementById('btnVerificarTransferencia').onclick = async () => {
  const gid = state.filtros.grupo || '';
  if (!gid) { alert('Selecciona un grupo.'); return; }
  try{
    const ref = doc(db,'grupos', gid, 'finanzas', 'summary');
    const saldoDevueltoOk = !!document.getElementById('saldoDevueltoOk')?.checked;
    await setDoc(ref, {
      transferenciaVerificada:{
        ok:true,
        saldoDevueltoOk,
        by:(auth.currentUser?.email||'').toLowerCase(),
        at:Date.now()
      }
    }, { merge:true });
    alert('Verificación registrada.');
  }catch(e){ console.warn('verificar transf', e); alert('No se pudo marcar verificada.'); }
};

/* ====================== IMPRESIÓN CIERRE ====================== */
document.getElementById('btnImprimirCierre').onclick = () => {
  const gid = state.filtros.grupo || '';
  if (!gid) { alert('Selecciona un grupo.'); return; }
  const g = state.caches.grupos.get(gid) || { numero:gid, nombre:'' };

  const rows = applyFiltersLocal(state.items).filter(x=> x.grupoId===gid);
  const gastos = rows.filter(x=> x.tipo==='gasto');
  const abonos = rows.filter(x=> x.tipo==='abono');

  const p = [];
  p.push(`RENDICIÓN FINANCIERA — ${g.nombre?.toUpperCase()} (N° ${g.numero})\n`);
  p.push(`COORDINADOR: ${(g.coordEmail||'').toUpperCase()}\n`);
  p.push(`\n— PAGOS (ABONOS) —`);
  if (!abonos.length) p.push('  (sin registros)');
  else abonos.forEach(a=> p.push(`  • ${a.asunto||'—'}  ${a.moneda||'CLP'} ${a.monto.toLocaleString('es-CL')}  [R1:${a.rev1} R2:${a.rev2} PAGO:${a.revPago||'—'}]`));

  p.push(`\n— GASTOS —`);
  if (!gastos.length) p.push('  (sin registros)');
  else gastos.forEach(gx=> p.push(`  • ${gx.asunto||'—'}  ${gx.moneda||'CLP'} ${gx.monto.toLocaleString('es-CL')}  [R1:${gx.rev1} R2:${gx.rev2}]`));

  const sumG = gastos.reduce((s,x)=> s+x.monto,0);
  const sumA = abonos.reduce((s,x)=> s+x.monto,0);
  p.push(`\nTOTALES → GASTOS: ${moneyCLP(sumG)} · ABONOS: ${moneyCLP(sumA)} · SALDO: ${moneyCLP(sumA - sumG)}`);

  document.getElementById('printSheet').textContent = p.join('\n');
  window.print();
};

/* ====================== UI / WIRING ====================== */
function wireUI(){
  // pestañas estado
  const tabs = document.getElementById('stateTabs');
  tabs.addEventListener('click', ev=>{
    const btn = ev.target.closest('button[data-estado]');
    if (!btn) return;
    tabs.querySelectorAll('button').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    state.filtros.estado = btn.getAttribute('data-estado') || '';
    renderTable();
  });

  // tipo
  document.getElementById('filtroTipo').onchange = async (e)=>{
    state.filtros.tipo = e.target.value || '';
    // no recargamos de Firestore si ya tenemos; sólo render
    renderTable();
  };

  // coord: limita datalist de grupos
  const inputCoord = document.getElementById('filtroCoord');
  inputCoord.oninput = (e)=>{
    const val = (e.target.value||'').toLowerCase().trim();
    state.filtros.coord = val;
    // limitar grupos visibles en datalist si el coord existe en índice
    const dlG = document.getElementById('dl-grupos');
    dlG.innerHTML = '';
    if (state.caches.groupsByCoord.has(val)) {
      for (const gid of state.caches.groupsByCoord.get(val)) {
        const info = state.caches.grupos.get(gid);
        const opt = document.createElement('option');
        opt.value = gid; opt.label = `${info.numero} — ${info.nombre}`;
        dlG.appendChild(opt);
      }
    } else {
      // sin filtro (muestra todos)
      for (const [gid,info] of state.caches.grupos.entries()){
        const opt = document.createElement('option');
        opt.value = gid; opt.label = `${info.numero} — ${info.nombre}`;
        dlG.appendChild(opt);
      }
    }
  };

  // grupo
  document.getElementById('filtroGrupo').oninput = (e)=>{
    state.filtros.grupo = e.target.value || '';
  };

  // aplicar = cargar desde Firestore (si hay coord o grupo)
  document.getElementById('btnAplicar').onclick = async ()=>{
    try{
      document.getElementById('pagInfo').textContent = 'Cargando…';
      if (!state.filtros.coord && !state.filtros.grupo) {
        state.items = []; renderTable(); return;
      }
      await loadDataForFilters();
      renderTable();
    }catch(e){
      console.error('[FINZ] aplicar filtros', e);
      alert('No se pudo cargar. Revisa la consola.');
    }
  };

  document.getElementById('btnRecargar').onclick = async ()=>{
    await preloadCatalogs();
    state.items = []; renderTable();
  };

  // sort headers
  document.querySelectorAll('#tblFinanzas thead th.sortable').forEach(th=>{
    th.addEventListener('click', ()=>{
      const key = th.dataset.sortKey;
      if (!key) return;
      if (state.sort.key === key) state.sort.dir = (state.sort.dir==='asc'?'desc':'asc');
      else { state.sort.key = key; state.sort.dir = 'asc'; }
      renderTable();
    });
  });

  // “Cargar más” (no paginamos; sólo re-render)
  document.getElementById('btnMas').onclick = () => renderTable();
}

/* ====================== ARRANQUE ====================== */
onAuthStateChanged(auth, async (user) => {
  if (!user){ location.href='login.html'; return; }
  state.user = user;
  try { document.querySelector('#btn-logout')?.addEventListener('click', () => signOut(auth).then(()=>location='login.html')); } catch(_){}

  await preloadCatalogs();      // sólo catálogos (no datos)
  wireUI();
  renderTable();                // arranca vacío hasta que apliques filtros
});
