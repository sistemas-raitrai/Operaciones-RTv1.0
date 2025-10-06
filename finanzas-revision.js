/* Revisión financiera v3 — Abonos y Gastos con montos aprobados + comprobantes */
import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, collectionGroup, getDocs, query, doc, getDoc, updateDoc, setDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-storage.js';

const auth = getAuth(app);
const storage = getStorage(app);

/* ====================== STATE ====================== */
const state = {
  user: null,
  filtros: { estado:'', tipo:'', coord:'', grupo:'' },
  sort: { key:'', dir:'asc' },
  caches: {
    grupos: new Map(),
    coords: [],
    groupsByCoord: new Map(),
  },
  items: [],
  cierre: {
    pagosSeleccionados: new Set(),
    comprobanteFile: null,
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
  if (s === 'cerrada' || x.cerrada) return 'cerrada';
  
  const r1 = (x.rev1 || '').toString().toLowerCase();
  const r2 = (x.rev2 || '').toString().toLowerCase();
  const rp = (x.revPago || '').toString().toLowerCase();
  
  if (rp === 'rechazado') return 'rechazado';
  
  if (x.tipo === 'abono') {
    if (rp === 'pagado') return 'cerrada';
    if (r1 === 'aprobado' && r2 === 'aprobado') return 'aprobado';
    if (r1 === 'rechazado' || r2 === 'rechazado') return 'rechazado';
  } else {
    // GASTOS: aprobado si ambos aprueban O si rev1 rechaza pero ajusta monto + rev2 aprueba
    if (r1 === 'aprobado' && r2 === 'aprobado') return 'aprobado';
    if (r1 === 'rechazado' && r2 === 'aprobado' && x.montoAprobado !== x.monto) return 'aprobado';
    if (r1 === 'rechazado' || r2 === 'rechazado') return 'rechazado';
  }
  
  return 'pendiente';
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
  const montoAprobado = parseMonto(raw.montoAprobado ?? monto);
  const moneda = (raw.moneda || raw.currency || 'CLP').toString().toUpperCase();

  const rev1  = (raw.revision1?.estado || raw.rev1?.estado || raw.rev1 || '').toString().toLowerCase() || 'pendiente';
  const rev2  = (raw.revision2?.estado || raw.rev2?.estado || raw.rev2 || '').toString().toLowerCase() || 'pendiente';
  const revPago = tipo==='abono'
    ? (raw.pago?.estado || raw.revPago || '').toString().toLowerCase() || 'pendiente'
    : '';

  const rev1By = coalesce(raw.revision1?.user, raw.rev1By, '').toLowerCase();
  const rev2By = coalesce(raw.revision2?.user, raw.rev2By, '').toLowerCase();
  const pagoBy = coalesce(raw.pago?.user, raw.revPagoBy, '').toLowerCase();

  const asunto = coalesce(raw.asunto, raw.detalle, raw.descripcion, raw.concepto, raw.motivo, '');
  const coordFromPath = (raw.__coordPath || '').toLowerCase();
  const coordEmailCat = (gInfo?.coordEmail || '').toLowerCase();
  const coordRaw = coalesce(raw.coordinadorEmail, raw.coordinador, '').toLowerCase();
  const coord = coordFromPath || coordEmailCat || coordRaw;

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
    montoAprobado,
    moneda,
    rev1, rev2, revPago,
    rev1By, rev2By, pagoBy,
    comentario1: raw.revision1?.comentario || '',
    comentario2: raw.revision2?.comentario || '',
    comentarioPago: raw.pago?.comentario || '',
    comprobanteUrl: raw.pago?.comprobanteUrl || '',
    cerrada: !!raw.cerrada,
    estado: deriveEstado({ tipo, rev1, rev2, revPago, estado: raw.estado, cerrada: raw.cerrada, monto, montoAprobado }),
  };
}

/* ====================== LECTURA DE DATOS ====================== */
async function fetchGastosCGFiltered({ coordHint = '', grupoId = '' } = {}) {
  const out = [];
  try {
    const normCoord = (s='') =>
      s.toString()
       .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
       .toLowerCase()
       .replace(/[\s_]+/g, '-')
       .trim();

    const hint = normCoord(coordHint);
    const snap = await getDocs(collectionGroup(db, 'gastos'));
    
    snap.forEach(docSnap => {
      const x = docSnap.data() || {};
      const gid = coalesce(
        x.grupoId, x.grupo_id, x.gid, x.idGrupo, x.grupo, x.id_grupo,
        (x.numeroNegocio && x.identificador) ? `${x.numeroNegocio}-${x.identificador}` : ''
      );
      if (!gid) return;

      const coordFromPath = (docSnap.ref.parent.parent?.id || '').toLowerCase();

      if (hint) {
        const blob = [
          normCoord(coordFromPath),
          normCoord(x.coordinadorEmail || ''),
          normCoord(x.coordinador || '')
        ].join(' ');
        if (!blob.includes(hint)) return;
      }

      if (grupoId && gid !== grupoId) return;

      const gInfo = state.caches.grupos.get(gid) ||
                    { numero: gid, nombre: '', coordEmail: coordFromPath };

      const enriched = {
        id: docSnap.id,
        ...x,
        __from: 'cg:gastos',
        __coordPath: coordFromPath,
      };
      out.push(toItem(gid, gInfo, enriched, 'gasto'));
    });
  } catch (e) {
    console.warn('fetchGastosCGFiltered', e);
  }
  return out;
}

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

async function loadDataForFilters() {
  state.items = [];
  const tipo  = state.filtros.tipo;
  const coord = (state.filtros.coord || '').toLowerCase();
  const gid   = state.filtros.grupo || '';

  if (!coord && !gid) return [];

  const tasks = [];

  if (!tipo || tipo === 'gasto') {
    tasks.push(fetchGastosCGFiltered({ coordHint: coord, grupoId: gid }));
  }

  if ((!tipo || tipo === 'abono') && gid) {
    tasks.push(fetchAbonosByGroup(gid));
  }

  const batches = await Promise.all(tasks);
  state.items = batches.flat();
  return state.items;
}

/* ====================== ESCRITURA: REVISIONES ====================== */
function getDocRefForItem(it) {
  return (it.tipo === 'gasto')
    ? doc(db, 'coordinadores', it.coordinador, 'gastos', it.id)
    : doc(db, 'grupos', it.grupoId, 'finanzas_abonos', it.id);
}

async function saveRevision(it, which, nuevoEstado, comentario='', montoAjustado=null) {
  const me  = (auth.currentUser?.email || '').toLowerCase();
  const ref = getDocRefForItem(it);

  // Validar usuarios distintos
  if (which === 'rev1' && it.rev2By && it.rev2By === me) {
    alert('REV.1 debe ser realizada por un usuario distinto a REV.2');
    return false;
  }
  if (which === 'rev2' && it.rev1By && it.rev1By === me) {
    alert('REV.2 debe ser realizada por un usuario distinto a REV.1');
    return false;
  }
  if (which === 'revPago' && (me === it.rev1By || me === it.rev2By)) {
    alert('REV. PAGO debe ser realizada por un usuario distinto a REV.1 y REV.2');
    return false;
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
  
  // GASTOS: si REV1 rechaza con ajuste de monto
  if (it.tipo === 'gasto' && which === 'rev1' && nuevoEstado === 'rechazado' && montoAjustado !== null) {
    payload['montoAprobado'] = montoAjustado;
  }
  
  // ABONOS: cerrar si marca pago como pagado
  if (which === 'revPago' && nuevoEstado === 'pagado') {
    payload['cerrada'] = true;
  }

  try {
    await updateDoc(ref, payload);

    // Actualizar local
    if (which === 'rev1') {
      it.rev1 = nuevoEstado;
      it.rev1By = me;
      if (comentario) it.comentario1 = comentario;
      if (montoAjustado !== null) it.montoAprobado = montoAjustado;
    }
    if (which === 'rev2') {
      it.rev2 = nuevoEstado;
      it.rev2By = me;
      if (comentario) it.comentario2 = comentario;
    }
    if (which === 'revPago') {
      it.revPago = nuevoEstado;
      it.pagoBy = me;
      if (comentario) it.comentarioPago = comentario;
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
      case 'montoAprobado': return Number(it.montoAprobado) || 0;
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

  if (f.tipo) out = out.filter(x => x.tipo === f.tipo);

  if (f.estado === 'pagables') {
    out = out.filter(x => x.tipo==='abono' && x.rev1==='aprobado' && x.rev2==='aprobado' && x.revPago!=='pagado');
  } else if (f.estado === 'cerrada') {
    out = out.filter(x => x.estado === 'cerrada' || x.cerrada === true);
  } else if (f.estado) {
    out = out.filter(x => x.estado === f.estado);
  }

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

  // Totales usando montoAprobado para gastos
  let sumG = 0, sumA = 0;
  data.forEach(x => {
    if (x.tipo==='gasto') sumG += x.montoAprobado;
    else sumA += x.monto;
  });
  const saldo = sumA - sumG;
  totalesEl.textContent = `GASTOS: ${moneyCLP(sumG)} · ABONOS: ${moneyCLP(sumA)} · SALDO: ${moneyCLP(saldo)}`;

  tbody.innerHTML = '';
  if (!data.length){
    const tr=document.createElement('tr');
    const td=document.createElement('td');
    td.colSpan=11;
    td.innerHTML='<div class="muted">SIN MOVIMIENTOS PARA ESTE CRITERIO.</div>';
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    const frag=document.createDocumentFragment();
    data.forEach(x=>{
      const tr=document.createElement('tr');

      const tdTipo = document.createElement('td');
      tdTipo.textContent=(x.tipo||'—').toUpperCase();
      
      const tdGrupo= document.createElement('td');
      tdGrupo.innerHTML=`<div class="mono">${x.grupoId}</div><span class="small">${(x.numeroNegocio||'')}${x.nombreGrupo?' · '+x.nombreGrupo:''}</span>`;
      
      const tdCoord= document.createElement('td');
      tdCoord.innerHTML=`<span>${x.coordinador||'—'}</span>`;
      
      const tdAsunto=document.createElement('td');
      tdAsunto.textContent=x.asunto || '—';
      
      const tdMonto =document.createElement('td');
      tdMonto.innerHTML=`<span class="mono">${moneyBy(x.monto, x.moneda||'CLP')}</span>`;
      
      // Nueva columna: Monto Aprobado (solo para gastos)
      const tdMontoAprob = document.createElement('td');
      if (x.tipo === 'gasto') {
        const diff = x.montoAprobado !== x.monto;
        tdMontoAprob.innerHTML = `<span class="mono ${diff?'text-warning':''}">${moneyBy(x.montoAprobado, x.moneda||'CLP')}</span>`;
        if (diff) tdMontoAprob.title = 'Monto ajustado';
      } else {
        tdMontoAprob.innerHTML = '<span class="muted">—</span>';
      }
      
      const tdMon  =document.createElement('td');
      tdMon.textContent=(x.moneda||'CLP');

      const makeRev = (which, estado, by, comentario) => {
        const td = document.createElement('td');
        if (which==='revPago' && x.tipo!=='abono') {
          td.innerHTML='<span class="muted">—</span>';
          return td;
        }

        const wrap=document.createElement('div');
        wrap.className='rev-cell';
        const btn=document.createElement('button');
        btn.className='revbtn';
        btn.type='button';
        const who=document.createElement('span');
        who.className='small';

        const apply = () => {
          const cur = (which==='rev1'? x.rev1 : which==='rev2'? x.rev2 : x.revPago) || 'pendiente';
          if (which==='revPago' && cur==='pagado') {
            btn.textContent='✓';
            btn.dataset.state='aprobado';
          } else if (cur==='aprobado') {
            btn.textContent='✓';
            btn.dataset.state='aprobado';
          } else if (cur==='rechazado') {
            btn.textContent='✗';
            btn.dataset.state='rechazado';
          } else {
            btn.textContent='—';
            btn.dataset.state='pendiente';
          }
          who.textContent = (which==='rev1'? x.rev1By : which==='rev2'? x.rev2By : x.pagoBy) || '';
        };
        apply();

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
          else if (cur==='aprobado') next='rechazado';
          else if (cur==='rechazado') next='pendiente';
          
          if (which==='revPago' && next==='aprobado') next='pagado';

          let comentario = '';
          let montoAjustado = null;
          
          // GASTOS + REV1 + RECHAZO: permitir ajustar monto
          if (x.tipo === 'gasto' && which === 'rev1' && next === 'rechazado') {
            const respuesta = await promptAjusteMonto(x.monto, x.moneda);
            if (respuesta === null) return;
            comentario = respuesta.comentario;
            montoAjustado = respuesta.monto;
          } else if (next==='rechazado') {
            comentario = await promptComentario(`MOTIVO DEL RECHAZO — ${which.toUpperCase()}`);
            if (comentario === null) return;
          }

          const ok = await saveRevision(x, which, next, comentario, montoAjustado);
          if (ok) {
            apply();
            icon.style.display = (next==='rechazado' ? '' : 'none');
            tdEstado.innerHTML = `<span class="badge ${x.estado}">${x.estado.toUpperCase()}</span>`;
            if (montoAjustado !== null) {
              tdMontoAprob.innerHTML = `<span class="mono text-warning">${moneyBy(x.montoAprobado, x.moneda)}</span>`;
            }
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
    const val = r.tipo === 'gasto' ? r.montoAprobado : r.monto;
    map.set(k, (map.get(k)||0) + Number(val||0));
  });
  return [...map.entries()].map(([mon, tot]) => `${mon} ${tot.toLocaleString('es-CL')}`).join(' · ');
}

function renderCierres(){
  const tipo = state.filtros.tipo;
  const gid = state.filtros.grupo || '';

  const showPagos = (!tipo || tipo==='abono') && gid;
  const showGastos = (!tipo || tipo==='gasto' || tipo==='') && gid;

  // CIERRE DE PAGOS
  const boxP = document.getElementById('cierrePagos');
  const listP= document.getElementById('cierrePagosList');
  const totP = document.getElementById('cierrePagosTotals');
  
  if (showPagos){
    const pagos = applyFiltersLocal(state.items).filter(x =>
      x.tipo==='abono' && x.rev1==='aprobado' && x.rev2==='aprobado' && x.revPago!=='pagado'
    );
    boxP.style.display = '';
    listP.innerHTML = '';
    
    if (!pagos.length) {
      listP.innerHTML = '<div class="muted">No hay pagos aprobados pendientes de transferencia.</div>';
      totP.textContent = 'TOTAL: —';
    } else {
      pagos.forEach(p=>{
        const item = document.createElement('div');
        item.className = 'pago-item';
        item.innerHTML = `
          <div class="pago-header">
            <input type="checkbox" data-id="${p.id}" style="width:20px; height:20px; cursor:pointer; accent-color:#2563eb;" ${state.cierre.pagosSeleccionados.has(p.id)?'checked':''}>
            <span class="pago-codigo">${p.id}</span>
          </div>
          <div style="display:flex; justify-content:space-between; align-items:center; padding-left:2rem;">
            <span class="pago-concepto">${p.asunto||'—'}</span>
            <span class="pago-monto">${moneyBy(p.monto, p.moneda)}</span>
          </div>
        `;
        listP.appendChild(item);
        
        item.querySelector('input').onchange = (e) => {
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

  // CIERRE DE GASTOS
  const boxG = document.getElementById('cierreGastos');
  if (showGastos){
    const gastosAprob = state.items.filter(x =>
