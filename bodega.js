// bodega.js
import { app, db } from './firebase-init.js';

import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';

import {
  getStorage,
  ref as sRef,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-storage.js';

import {
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  orderBy,
  limit,
  startAfter,  
  serverTimestamp,
  runTransaction
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const $ = (id) => document.getElementById(id);
const auth = getAuth(app);
const storage = getStorage(app);

let toastTimer = null;
function toast(msg){
  const el = $('toast');
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=> el.style.display='none', 2400);
}
function safeNum(n, def=0){
  const x = Number(n);
  return Number.isFinite(x) ? x : def;
}
function sumVariants(obj){
  const o = obj && typeof obj === 'object' ? obj : {};
  let s = 0;
  for(const k of Object.keys(o)){
    s += safeNum(o[k], 0);
  }
  return s;
}
function formatVariants(obj){
  const v = (obj && typeof obj === 'object') ? obj : {};
  const parts = Object.keys(v)
    .sort((a,b)=> String(a).localeCompare(String(b), 'es'))
    .map(k => `${k}:${safeNum(v[k],0)}`)
    .filter(s => !s.endsWith(':0'));
  return parts.join(' · ');
}

function setEstado(msg){
  $('lblEstado').textContent = msg || 'Listo.';
}
function U(s){ return String(s||'').trim().toUpperCase(); }
function escapeHtml(str){
  return String(str ?? '')
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'","&#039;");
}

/* ======================
   UBICACIONES (NUEVO)
   - Z1 se considera legacy => HUECHURABA
   - UI muestra siempre HUECHURABA/POCURO/OFICINA
   - Al guardar, normalizamos
   ====================== */
const UBIC_OPTS = ['HUECHURABA','POCURO','OFICINA'];

function normalizeUbic(v){
  const x = U(v);
  if(!x) return '';                 // vacío permitido en algunos casos
  if(x === 'Z1') return 'HUECHURABA';// legacy
  if(UBIC_OPTS.includes(x)) return x;
  return x;                         // si viene algo raro, lo dejamos pero en mayúscula
}

function displayUbic(v){
  const x = normalizeUbic(v);
  return x || ''; // si no hay, mostramos vacío
}

/* ======================
   TALLAS / VARIANTES
   - Devuelve string (ej "M") o "" si stock general
   - Devuelve null si el usuario cancela
   ====================== */
function pedirTalla({ titulo='Talla / Variante', sugerida='M' } = {}){
  const v = prompt(`${titulo} (ej: M, L, XL, XXL)\n(Deja vacío para stock general):`, sugerida);
  if(v === null) return null;      // canceló
  return (v || '').trim();         // '' => stock general
}

/* Paths */
const COL_BODEGAS = 'bodegas';

function bodegasCol(){ return collection(db, COL_BODEGAS); }

function cajasCol(bodegaId){ return collection(db, COL_BODEGAS, bodegaId, 'cajas'); }
function cajaDoc(bodegaId, cajaId){ return doc(db, COL_BODEGAS, bodegaId, 'cajas', cajaId); }

function itemsCol(bodegaId){ return collection(db, COL_BODEGAS, bodegaId, 'items'); }
function itemDoc(bodegaId, itemId){ return doc(db, COL_BODEGAS, bodegaId, 'items', itemId); }

function stocksCol(bodegaId, itemId){ return collection(db, COL_BODEGAS, bodegaId, 'items', itemId, 'stocks'); }
function stockDoc(bodegaId, itemId, cajaId){ return doc(db, COL_BODEGAS, bodegaId, 'items', itemId, 'stocks', cajaId); }

function movsCol(bodegaId, itemId, cajaId){
  return collection(db, COL_BODEGAS, bodegaId, 'items', itemId, 'stocks', cajaId, 'movimientos');
}

function movsBodegaCol(bodegaId){
  return collection(db, COL_BODEGAS, bodegaId, 'movimientos');
}

function buildEventoPayload({ tipo, refId='', itemId='', itemNombre='', cajaId='', cajaNombre='', cajaUbic='', antes=null, despues=null, nota='' }){
  return {
    ts: serverTimestamp(),
    tipo: tipo || 'EVENTO',
    refId: refId || '',
    itemId: itemId || '',
    itemNombre: itemNombre || '',
    cajaId: cajaId || '',
    cajaNombre: cajaNombre || '',
    cajaUbic: normalizeUbic(cajaUbic || ''),
    antes: (antes === undefined ? null : antes),
    despues: (despues === undefined ? null : despues),
    by: state.user?.email || null,
    nota: nota || ''
  };
}

async function logEventoBodega(bodegaId, payload){
  // doc random
  await setDoc(doc(movsBodegaCol(bodegaId)), payload);
}

/* State */
const state = {
  user: null,
  bodegas: [],
  bodegaId: null,

  cajas: [],          // [{id,nombre,ubicacion}]
  cajasById: new Map(),

  items: [],          // [{id,nombre,unidadesTotal,minimo,...}]

  modal: {
    item: null,       // item activo en modal cajas
    stocks: [],       // [{cajaId, unidades}]
    stocksByCaja: new Map(),
  },
  
  mov: { lastDoc:null, done:false, loading:false }  
};

/* Auth UI */
$('btnLogin').addEventListener('click', async ()=>{
  const email = $('loginEmail').value.trim();
  const pass  = $('loginPass').value;
  if(!email || !pass){ toast('Completa email y contraseña.'); return; }

  try{
    setEstado('Ingresando...');
    await signInWithEmailAndPassword(auth, email, pass);
  }catch(err){
    console.error(err);
    toast('No se pudo ingresar.');
    setEstado('Error de login.');
  }
});

$('btnLogout').addEventListener('click', async ()=>{
  try{ await signOut(auth); }catch(e){ console.error(e); }
});

onAuthStateChanged(auth, async (user)=>{
  state.user = user || null;

  $('userPill').textContent = user?.email ? user.email : 'No autenticado';
  $('btnLogout').classList.toggle('hide', !user);

  $('loginView').classList.toggle('hide', !!user);
  $('appView').classList.toggle('hide', !user);

  if(user){
    await boot();
  }else{
    state.bodegas = [];
    state.bodegaId = null;
    state.cajas = [];
    state.cajasById = new Map();
    state.items = [];
    $('selBodega').innerHTML = '';
    $('itemsList').innerHTML = '';
  }
});

/* Boot */
async function boot(){
  try{
    setEstado('Cargando bodegas...');
    await ensureDefaultBodegasIfEmpty();
    await loadBodegasIntoSelect();

    setEstado('Cargando cajas...');
    await loadCajas();

    setEstado('Cargando inventario...');
    await loadItems();

    wireFilters();
    wireCajasModal();
    setEstado('Listo.');
  }catch(err){
    console.error(err);
    setEstado('Error cargando.');
    toast('Error cargando bodega.');
  }
}

async function ensureDefaultBodegasIfEmpty(){
  const snap = await getDocs(query(bodegasCol(), orderBy('nombre','asc'), limit(5)));
  if(snap.empty){
    const defaults = ['Bodega Externa', 'Oficina'];
    for(const nombre of defaults){
      await addDoc(bodegasCol(), {
        nombre,
        creadoEn: serverTimestamp(),
        creadoPor: state.user?.email || null,
        activo: true
      });
    }
  }
}

async function loadBodegasIntoSelect(){
  const sel = $('selBodega');
  sel.innerHTML = '';

  const snap = await getDocs(query(bodegasCol(), orderBy('nombre','asc')));
  state.bodegas = snap.docs.map(d=>({ id:d.id, ...(d.data()||{}) }));

  if(!state.bodegaId){
    state.bodegaId = state.bodegas[0]?.id || null;
  }else if(!state.bodegas.some(b=>b.id===state.bodegaId)){
    state.bodegaId = state.bodegas[0]?.id || null;
  }

  for(const b of state.bodegas){
    const opt = document.createElement('option');
    opt.value = b.id;
    opt.textContent = b.nombre || '(sin nombre)';
    sel.appendChild(opt);
  }
  sel.value = state.bodegaId || '';

  sel.onchange = async ()=>{
    state.bodegaId = sel.value;
    await loadCajas();
    await loadItems();
  };
}

async function loadCajas(){
  state.cajas = [];
  state.cajasById = new Map();

  // ✅ itCajaSel debe existir (es el selector del formulario)
  const itCajaSel = $('itCajaSel');
  if(!itCajaSel){
    console.error('[BODEGA] Falta #itCajaSel en el HTML (loadCajas).');
    toast('Error UI: falta selector de caja del ítem (#itCajaSel).');
    return;
  }

  // ✅ cxSel es OPCIONAL (en tu HTML nuevo ya NO existe)
  const cxSel = $('cxSel');

  // Limpia selects (si existen)
  itCajaSel.innerHTML = '';
  if(cxSel) cxSel.innerHTML = '';

  if(!state.bodegaId) return;

  // ✅ CARGA REAL DESDE FIRESTORE (esto antes NO se ejecutaba si faltaba cxSel)
  const snap = await getDocs(query(cajasCol(state.bodegaId), orderBy('nombre','asc')));
  state.cajas = snap.docs.map(d=>({ id:d.id, ...(d.data()||{}) }));
  for(const c of state.cajas) state.cajasById.set(c.id, c);

  // Opción "(sin caja)" SOLO para el select del formulario de ítem
  const opt0 = document.createElement('option');
  opt0.value = '';
  opt0.textContent = '(sin caja)';
  itCajaSel.appendChild(opt0);

  for(const c of state.cajas){
    const t = `${c.nombre || '(sin nombre)'}${c.ubicacion ? ' · ' + c.ubicacion : ''}`;

    // Select del formulario (crear ítem)
    const o1 = document.createElement('option');
    o1.value = c.id;
    o1.textContent = t;
    itCajaSel.appendChild(o1);

    // ✅ Si existe cxSel (solo en algunos HTML antiguos), también lo poblamos
    if(cxSel){
      const o2 = document.createElement('option');
      o2.value = c.id;
      o2.textContent = t;
      cxSel.appendChild(o2);
    }
  }
}


/* Items */
$('btnCrearItem').addEventListener('click', async ()=>{
  if(!state.bodegaId){ toast('Selecciona bodega.'); return; }

  const nombre = $('itNombre').value.trim();
  const desc = $('itDesc').value.trim();
  const minimo = Math.max(0, safeNum($('itMinimo').value, 0));
  const unidadesInit = Math.max(0, safeNum($('itUnidades').value, 0));
  const file = $('itFoto').files?.[0] || null;

  const cajaSel = $('itCajaSel').value || '';
  const cajaNueva = ($('itCajaNueva').value || '').trim();
  const cajaUbic = ($('itCajaUbic').value || '').trim();

  if(!nombre){ toast('Ponle un nombre al ítem.'); return; }

  try{
    setEstado('Guardando ítem...');

    let cajaId = cajaSel;

    if(cajaNueva){
      const cRef = await addDoc(cajasCol(state.bodegaId), {
        nombre: cajaNueva,
        ubicacion: cajaUbic || '',
        creadoEn: serverTimestamp(),
        creadoPor: state.user?.email || null,
        actualizadoEn: serverTimestamp()
      });
      cajaId = cRef.id;

      await loadCajas();
      $('itCajaSel').value = cajaId;
    }

    const itRef = await addDoc(itemsCol(state.bodegaId), {
      nombre,
      descripcion: desc || '',
      minimo,
      unidadesTotal: 0,
      fotoURL: null,
      fotoPath: null,
      creadoEn: serverTimestamp(),
      creadoPor: state.user?.email || null,
      actualizadoEn: serverTimestamp()
    });

    // ✅ LOG: creación de ítem
    await logEventoBodega(state.bodegaId, buildEventoPayload({
      tipo: 'ITEM_CREATE',
      itemId: itRef.id,
      itemNombre: nombre,
      cajaId: cajaId || '',
      cajaNombre: cajaNueva ? cajaNueva : (state.cajasById.get(cajaId||'')?.nombre || ''),
      cajaUbic: cajaUbic || '',
      despues: { nombre, descripcion: desc||'', minimo, unidadesInit },
      nota: 'Creación de ítem'
    }));


    if(file){
      const path = `bodegas/${state.bodegaId}/items/${itRef.id}/${Date.now()}_${file.name}`;
      const r = sRef(storage, path);

      await new Promise((resolve, reject)=>{
        const task = uploadBytesResumable(r, file);
        task.on('state_changed', null, reject, resolve);
      });

      const url = await getDownloadURL(r);
      await updateDoc(itRef, { fotoURL:url, fotoPath:path, actualizadoEn: serverTimestamp() });
    }

    if(unidadesInit > 0){
      const targetCajaId = cajaId || '_SIN_CAJA_';
    
      // ✅ Lee talla desde input visible
      const tallaInit = ($('itVariante')?.value || '').trim(); // '' => general
      const key = tallaInit ? U(tallaInit) : null;
    
      await applyDeltaToItemCaja({
        bodegaId: state.bodegaId,
        itemId: itRef.id,
        cajaId: targetCajaId,
        delta: +unidadesInit,
        nota: key ? `Carga inicial (${key})` : 'Carga inicial',
        variante: key
      });
    }



    $('itNombre').value = '';
    $('itDesc').value = '';
    $('itUnidades').value = '0';
    $('itMinimo').value = '3';
    $('itFoto').value = '';
    $('itCajaNueva').value = '';
    $('itCajaUbic').value = '';
    $('itCajaSel').value = '';
    if($('itVariante')) $('itVariante').value = '';

    toast('Ítem guardado ✅');
    await loadItems();
    setEstado('Listo.');
  }catch(err){
    console.error(err);
    toast('Error guardando ítem.');
    setEstado('Error.');
  }
});

/* ======================
   VARIANTES (RESUMEN UI)
   - Calcula desglose total por ítem (sumando todas sus cajas)
   ====================== */

function mergeVariants(dst, src){
  if(!src || typeof src !== 'object') return dst;
  for(const k of Object.keys(src)){
    const kk = U(k);
    dst[kk] = safeNum(dst[kk], 0) + safeNum(src[k], 0);
  }
  return dst;
}

function formatVariantsLine({ variantesTotales, general=0 }){
  const parts = [];

  // Si existe stock "general" (sin variantes) lo mostramos como GEN
  if(general > 0) parts.push(``);

  // Orden alfabético por talla (L, M, S... y XXL etc.)
  const keys = Object.keys(variantesTotales || {}).sort((a,b)=> a.localeCompare(b,'es'));
  for(const k of keys){
    const v = safeNum(variantesTotales[k], 0);
    if(v > 0) parts.push(`${k}:${v}`);
  }

  return parts.join(' · ');
}

/** Carga stocks de CADA item para armar:
 *  it._variantsLine  => "L:50 · M:40 · XL:48 · XXL:60"
 *  it._variantsObj   => {L:50, M:40, ...}
 *  it._generalUnits  => unidades sin variantes (GEN)
 */
async function hydrateVariantsForItems(){
  if(!state.bodegaId) return;

  await Promise.all(state.items.map(async (it)=>{
    try{
      const snap = await getDocs(stocksCol(state.bodegaId, it.id));

      const variantesTotales = {};
      let general = 0;

      // ✅ NUEVO: ubicaciones donde existe stock > 0 (según caja)
      const ubicSet = new Set();

      snap.forEach((d)=>{
        const s = d.data() || {};
        const cajaId = d.id;
        const unidadesCaja = safeNum(s.unidades, 0);

        // --- Variantes / General (igual que antes)
        if(s.variantes && typeof s.variantes === 'object'){
          mergeVariants(variantesTotales, s.variantes);
        }else{
          general += unidadesCaja;
        }

        // --- ✅ Ubicación por caja (solo si hay stock > 0)
        if(unidadesCaja > 0){
          if(cajaId !== '_SIN_CAJA_'){
            const cajaMeta = state.cajasById.get(cajaId) || {};
            const ubic = displayUbic(cajaMeta.ubicacion || '');
            if(ubic) ubicSet.add(ubic);
          }
          // Si está en _SIN_CAJA_ no tiene ubicación real => no lo mostramos
        }
      });

      const line = formatVariantsLine({ variantesTotales, general });

      // ✅ Guardamos strings listos para UI
      it._variantsObj   = variantesTotales;
      it._generalUnits  = general;
      it._variantsLine  = line; // puede ser ""
      it._ubicLine      = Array.from(ubicSet).sort((a,b)=>a.localeCompare(b,'es')).join(' · '); // puede ser ""

    }catch(e){
      console.warn('[BODEGA] No pude hidratar variantes/ubicación de item', it?.id, e);
      it._variantsObj  = {};
      it._generalUnits = 0;
      it._variantsLine = '';
      it._ubicLine     = '';
    }
  }));
}


async function loadItems(){
  if(!state.bodegaId){
    $('itemsList').innerHTML = '';
    return;
  }

  setEstado('Cargando inventario...');
  const snap = await getDocs(query(itemsCol(state.bodegaId), orderBy('nombre','asc')));
  state.items = snap.docs.map(d=>({ id:d.id, ...(d.data()||{}) }));

  // ✅ NUEVO: traer desglose de variantes (para pintar en tarjeta)
  setEstado('Cargando variantes...');
  await hydrateVariantsForItems();

  renderItems();
  setEstado(`Listo · ${state.items.length} ítems`);
}

/* UI filters */
function wireFilters(){
  $('btnRefrescar').onclick = async ()=>{
    await loadCajas();
    await loadItems();
  };
  $('txtSearch').oninput = renderItems;
  $('selFiltroStock').onchange = renderItems;

  $('btnVerMovimientos').onclick = async ()=>{
    if(!state.bodegaId) return;
  
    $('movBackdrop').style.display = 'flex';
  
    // reset paginación
    state.mov.lastDoc = null;
    state.mov.done = false;
    $('movTbody').innerHTML = '';
    $('movEstado').textContent = 'Cargando...';
  
    // carga inicial rápida: 10
    await cargarMasMovimientos({ pageSize: 10, reset: true });
  };


  $('btnCerrarMov').onclick = ()=> $('movBackdrop').style.display = 'none';
  $('movBackdrop').addEventListener('click', (ev)=>{
    if(ev.target === $('movBackdrop')) $('movBackdrop').style.display = 'none';
  });
  $('btnMovMas').onclick = async ()=>{
    if(!state.bodegaId) return;
    await cargarMasMovimientos({ pageSize: 50, reset: false });
  };
}



// ======================
// BUSCADOR AVANZADO (cards)
// - Busca en TODO lo visible de la card
// - "," = AND (Y)
// - "." = OR  (O)
// Ej:
//   "huechuraba, pulseras" => debe contener huechuraba Y pulseras
//   "pulseras.huechuraba"  => pulseras O huechuraba
//   "huechuraba, pulseras.nfc" => huechuraba Y (pulseras O nfc)
// ======================

function buildCardHaystack(it){
  const total = safeNum(it?.unidadesTotal, 0);
  const minimo = safeNum(it?.minimo, 3);

  // Todo lo que puede aparecer (o ser relevante) en la card
  const parts = [
    it?.nombre || '',
    it?.descripcion || '',
    it?._variantsLine || '',
    it?._ubicLine || '',
    // badges / números visibles
    String(total),
    String(minimo),
    `TOTAL ${total}`,
    `MIN ${minimo}`,
    `MÍN ${minimo}`,
    // status textual (por si buscas "bajo", "stock 0", etc.)
    (total === 0) ? 'STOCK 0' : (total <= minimo ? 'BAJO' : 'OK')
  ];

  return parts.join(' · ').toLowerCase();
}

/**
 * Parse:
 *  - split por "," => AND clauses
 *  - dentro de cada clause, split por "." => OR terms
 * Retorna: Array< Array<string> >
 */
function parseSearch(qRaw){
  const q = String(qRaw || '').toLowerCase().trim();
  if(!q) return [];

  // AND groups
  const andGroups = q
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(group => {
      // OR terms
      const ors = group
        .split('.')
        .map(s => s.trim())
        .filter(Boolean);
      return ors;
    })
    .filter(g => g.length);

  return andGroups;
}

function matchesAdvancedSearch(it, qRaw){
  const andGroups = parseSearch(qRaw);
  if(andGroups.length === 0) return true;

  const hay = buildCardHaystack(it);

  // AND: todas las clausulas deben cumplirse
  // OR: dentro de cada clausula, basta con 1 término
  return andGroups.every(orTerms => {
    return orTerms.some(term => hay.includes(term));
  });
}

function renderItems(){
  const q = $('txtSearch').value.trim().toLowerCase();
  const f = $('selFiltroStock').value;

  const list = $('itemsList');
  list.innerHTML = '';

  let items = [...state.items];

  if(q){
    items = items.filter(it => matchesAdvancedSearch(it, q));
  }


  if(f === 'low'){
    items = items.filter(it=>{
      const total = safeNum(it.unidadesTotal,0);
      const min = safeNum(it.minimo,3);
      return total <= min && total > 0;
    });
  }else if(f === 'zero'){
    items = items.filter(it=> safeNum(it.unidadesTotal,0) === 0);
  }

  if(items.length === 0){
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.style.padding = '8px 2px';
    empty.textContent = 'No hay ítems para mostrar.';
    list.appendChild(empty);
    return;
  }

  for(const it of items){
    list.appendChild(renderItemCard(it));
  }
}

function renderItemCard(it){
  const total = safeNum(it.unidadesTotal,0);
  const minimo = safeNum(it.minimo,3);

  let badgeClass = 'good';
  let badgeText = 'OK';
  if(total === 0){ badgeClass='bad'; badgeText='STOCK 0'; }
  else if(total <= minimo){ badgeClass='warn'; badgeText='BAJO'; }

  const card = document.createElement('div');
  card.className = 'item';

  card.innerHTML = `
    <div class="top">
      <div class="thumb">
        ${it.fotoURL ? `<img src="${it.fotoURL}" alt="foto">` : `<span class="muted" style="font-size:12px;font-weight:900;">SIN<br>FOTO</span>`}
      </div>
      <div class="meta">
        <b title="${escapeHtml(it.nombre||'')}">${escapeHtml(it.nombre||'(sin nombre)')}</b>
        <div class="desc">${escapeHtml(it.descripcion||'')}</div>
        <div class="badges">
          <span class="badge ${badgeClass}">${badgeText}</span>
          <span class="badge">MÍN: ${minimo}</span>
          <span class="badge">TOTAL: ${total}</span>
        </div>
        
        ${(it._variantsLine || it._ubicLine) ? `
          <div class="muted" style="margin-top:6px; font-size:12px; line-height:1.15;">
            ${it._variantsLine ? `<div>${escapeHtml(it._variantsLine)}</div>` : ``}
          </div>
        ` : ``}


      </div>
    </div>

    <div class="bottom">
      <div>
        ${it._ubicLine ? `<div class="mini" style="color:var(--ink); font-weight:900;">${escapeHtml(it._ubicLine)}</div>` : ``}
        <div class="mini">STOCK TOTAL</div>
        <div class="qty">
          <span>${total}</span>
        </div>
      </div>

      <div class="row" style="justify-content:flex-end;">
        <button class="btn small" data-act="cajas">Detalle</button>
        <button class="btn small" data-act="editar">Editar</button>
        <button class="btn small danger" data-act="borrar">Borrar</button>
      </div>
    </div>
  `;

  card.querySelector('[data-act="cajas"]').onclick = ()=> openCajasModal(it);
  card.querySelector('[data-act="editar"]').onclick = ()=> editItem(it);
  card.querySelector('[data-act="borrar"]').onclick = ()=> deleteItem(it);

  return card;
}

async function editItem(it){
  if(!state.bodegaId) return;

  const nombre = prompt('Nombre del ítem:', it.nombre || '');
  if(nombre === null) return;

  const desc = prompt('Descripción:', it.descripcion || '');
  if(desc === null) return;

  const minimo = prompt('Mínimo (alerta):', String(safeNum(it.minimo,3)));
  if(minimo === null) return;

  const antes = {
    nombre: it.nombre || '',
    descripcion: it.descripcion || '',
    minimo: safeNum(it.minimo, 3)
  };

  const despues = {
    nombre: nombre.trim(),
    descripcion: desc.trim(),
    minimo: Math.max(0, safeNum(minimo, 3))
  };

  try{
    setEstado('Actualizando ítem...');

    await updateDoc(itemDoc(state.bodegaId, it.id), {
      nombre: despues.nombre,
      descripcion: despues.descripcion,
      minimo: despues.minimo,
      actualizadoEn: serverTimestamp()
    });

    // ✅ LOG (DENTRO del try)
    await logEventoBodega(state.bodegaId, buildEventoPayload({
      tipo: 'ITEM_EDIT',
      itemId: it.id,
      itemNombre: despues.nombre,
      antes,
      despues,
      nota: 'Edición de ítem'
    }));

    toast('Ítem actualizado ✅');
    await loadItems();
    setEstado('Listo.');
  }catch(e){
    console.error(e);
    toast('Error actualizando ítem.');
    setEstado('Error.');
  }
}

async function deleteItem(it){
  if(!state.bodegaId) return;

  const ok = confirm(`¿Borrar "${it.nombre}"?\n\nSe borra el ítem.\n(No borra automáticamente subcolecciones en Firestore).`);
  if(!ok) return;

  try{
    setEstado('Borrando ítem...');
  
    // ✅ LOG (antes de borrar)
    await logEventoBodega(state.bodegaId, buildEventoPayload({
      tipo: 'ITEM_DELETE',
      itemId: it.id,
      itemNombre: it.nombre || '',
      antes: {
        nombre: it.nombre || '',
        descripcion: it.descripcion || '',
        minimo: safeNum(it.minimo,3),
        unidadesTotal: safeNum(it.unidadesTotal,0)
      },
      nota: 'Borrado de ítem'
    }));
  
    if(it.fotoPath){
      try{ await deleteObject(sRef(storage, it.fotoPath)); }catch(e){}
    }
  
    await deleteDoc(itemDoc(state.bodegaId, it.id));
  
    toast('Ítem borrado.');
    await loadItems();
    setEstado('Listo.');
  }catch(e){
    console.error(e);
    toast('Error borrando ítem.');
    setEstado('Error.');
  }
}

function wireCajasModal(){
  $('btnCajasCerrar').onclick = ()=> $('cajasBackdrop').style.display = 'none';
  $('cajasBackdrop').addEventListener('click', (ev)=>{
    if(ev.target === $('cajasBackdrop')) $('cajasBackdrop').style.display = 'none';
  });

  // ✅ CREACIÓN MASIVA + STOCK INICIAL (por ítem del modal)
  $('btnCxCrearMasivo').onclick = async ()=>{
    if(!state.bodegaId) return;

    const it = state.modal.item;
    if(!it){
      toast('Abre el modal desde un ítem.');
      return;
    }

    const prefijo = ( $('cxPrefijo').value || '' ).trim();
    const desde = safeNum($('cxDesde').value, 0);
    const hasta = safeNum($('cxHasta').value, 0);
    const ubic = normalizeUbic($('cxUbicMasivo')?.value || '');
    const stockInicial = Math.max(0, safeNum($('cxStockInicial').value, 0));

    if(!prefijo){ toast('Falta prefijo'); return; }
    if(desde <= 0 || hasta <= 0 || hasta < desde){
      toast('Rango inválido (Desde/Hasta)');
      return;
    }

    try{
      setEstado('Creando cajas...');
      await loadCajas(); // asegura state.cajas actualizado
      const existentes = new Set(state.cajas.map(c => U(c.nombre || '')));

      let creadas = 0;
      let stockAplicado = 0;

      // ✅ Si hay stock inicial, preguntamos UNA VEZ si es por talla
      let varianteMasiva = null;
      if(stockInicial > 0){
        const v = ($('cxVarianteMasiva')?.value || '').trim(); // '' => general
        varianteMasiva = v ? U(v) : null;
      }



      for(let i=desde; i<=hasta; i++){
        const nombre = `${prefijo}${i}`.trim();
        const key = U(nombre);
        if(existentes.has(key)) continue;

        const cRef = await addDoc(cajasCol(state.bodegaId), {
          nombre,
          ubicacion: ubic || '',
          creadoEn: serverTimestamp(),
          creadoPor: state.user?.email || null,
          actualizadoEn: serverTimestamp()
        });

        existentes.add(key);
        creadas++;

        // ✅ Si hay stock inicial, lo asignamos a este ítem en esa caja (movimiento "Carga inicial masiva")
        if(stockInicial > 0){
          await applyDeltaToItemCaja({
            bodegaId: state.bodegaId,
            itemId: it.id,
            cajaId: cRef.id,
            delta: +stockInicial,
            nota: varianteMasiva
              ? `Carga inicial masiva (${nombre}) (${varianteMasiva})`
              : `Carga inicial masiva (${nombre})`,
            variante: varianteMasiva
          });
          stockAplicado++;
        }

      }

      toast(`Cajas creadas: ${creadas} ✅ · Stock aplicado: ${stockAplicado}`);
      setEstado('Listo.');

      // refrescar UI
      await loadCajas();
      await loadItems();
      await openCajasModal(it, true);
    }catch(e){
      console.error(e);
      toast('Error en creación masiva');
      setEstado('Error.');
    }
  };
}


async function openCajasModal(it, keepOpen=false){
  if(!state.bodegaId) return;

  state.modal.item = it;
  $('cajasTitle').textContent = `Cajas · ${it.nombre || ''}`;

  $('cxPrefijo').value = 'A';
  $('cxDesde').value = '1';
  $('cxHasta').value = '30';
  $('cxUbicMasivo').value = 'HUECHURABA';
  $('cxStockInicial').value = '50';

  if(!keepOpen) $('cajasBackdrop').style.display = 'flex';

  await loadCajas();
  await loadStocksForItem(it.id);
  await refreshCajasModalTable();
}

async function loadStocksForItem(itemId){
  state.modal.stocks = [];
  state.modal.stocksByCaja = new Map();

  const snap = await getDocs(query(stocksCol(state.bodegaId, itemId)));
  state.modal.stocks = snap.docs.map(d=>({ cajaId: d.id, ...(d.data()||{}) }));
  for(const s of state.modal.stocks){
    state.modal.stocksByCaja.set(s.cajaId, s);
  }
}

async function refreshCajasModalTable(){
  const it = state.modal.item;
  if(!it) return;

  const tb = $('cajasTbody');
  tb.innerHTML = '';

  // ✅ Solo mostramos cajas donde este ÍTEM tiene stock > 0
  // Fuente: stocksByCaja (subcolección items/{itemId}/stocks)
  const filas = [];

  // 1) Cajas reales (solo si tienen stock > 0)
  for(const c of state.cajas){
    const s = state.modal.stocksByCaja.get(c.id);
    const unidades = safeNum(s?.unidades, 0);
    if(unidades > 0){
      const vars = (s?.variantes && typeof s.variantes === 'object') ? s.variantes : null;
      filas.push({
        id: c.id,
        nombre: c.nombre || '(sin nombre)',
        ubicacion: c.ubicacion || '',
        unidades,
        variantes: vars
      });
    }
  }


  // 2) “Sin caja” SOLO si tiene stock > 0
  {
    const s = state.modal.stocksByCaja.get('_SIN_CAJA_');
    const unidades = safeNum(s?.unidades, 0);
    if(unidades > 0){
      const vars = (s?.variantes && typeof s.variantes === 'object') ? s.variantes : null;
      filas.push({
        id: '_SIN_CAJA_',
        nombre: '(sin caja)',
        ubicacion: '',
        unidades,
        variantes: vars
      });
    }
  }


  // 3) Si no hay nada con stock, mostramos mensaje (en vez de listado con 0)
  if(filas.length === 0){
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="4" class="muted">Este ítem no tiene stock asignado a ninguna caja.</td>`;
    tb.appendChild(tr);
    return;
  }

  // 4) Orden por nombre
  filas.sort((a,b)=> String(a.nombre||'').localeCompare(String(b.nombre||''), 'es'));

  // 5) Render + acciones (mismas acciones que ya tenías)
  for(const c of filas){
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="font-weight:900;">${escapeHtml(c.nombre||'')}</td>
      <td class="muted">${escapeHtml(displayUbic(c.ubicacion)||'')}</td>
      <td style="font-weight:900;">
        <div>${c.unidades}</div>
        ${c.variantes ? `<div class="muted" style="font-weight:700; font-size:12px; margin-top:2px;">
          ${escapeHtml(formatVariants(c.variantes))}
        </div>` : ''}
      </td>
      <td>
        <button class="btn small" data-act="dec">−1</button>
        <button class="btn small" data-act="inc">+1</button>
        <button class="btn small" data-act="ajuste">Agregar cantidad o variante</button>
        ${c.id === '_SIN_CAJA_' ? '' : `<button class="btn small" data-act="editBox">Editar</button>`}
        ${c.id === '_SIN_CAJA_' ? '' : `<button class="btn small danger" data-act="del">Borrar</button>`}
      </td>
    `;

    tr.querySelector('[data-act="inc"]').onclick = async ()=>{
      const talla = ($('cxVarianteAccion')?.value || '').trim(); // '' => general
      if(talla === null) return; // canceló
    
      await applyDeltaToItemCaja({
        bodegaId: state.bodegaId,
        itemId: it.id,
        cajaId: c.id,
        delta: +1,
        nota: talla ? `+1 (${U(talla)})` : '+1',
        variante: talla ? U(talla) : null
      });
    
      await loadItems();
      await openCajasModal(it, true);
      toast('OK');
    };


    tr.querySelector('[data-act="dec"]').onclick = async ()=>{
      const talla = pedirTalla();
      if(talla === null) return; // canceló
    
      await applyDeltaToItemCaja({
        bodegaId: state.bodegaId,
        itemId: it.id,
        cajaId: c.id,
        delta: -1,
        nota: talla ? `-1 (${U(talla)})` : '-1',
        variante: talla || null
      });
    
      await loadItems();
      await openCajasModal(it, true);
      toast('OK');
    };


    tr.querySelector('[data-act="ajuste"]').onclick = async ()=>{
      const talla = pedirTalla();
      if(talla === null) return; // canceló
    
      // ✅ Para leer variantes reales necesitamos el stock real (no solo "c.unidades")
      const s = state.modal.stocksByCaja.get(c.id);
      const vars = (s?.variantes && typeof s.variantes === 'object') ? s.variantes : {};
      const key = talla ? U(talla) : null;
    
      // si hay talla => ajustamos esa talla; si no => ajustamos total
      const actual = key ? safeNum(vars[key], 0) : safeNum(s?.unidades, 0);
    
      const v = prompt(
        key ? `Ajuste stock en ${c.nombre} · Talla ${key}\nNuevo stock:` : `Ajuste stock en ${c.nombre}\nNuevo stock:`,
        String(actual)
      );
      if(v === null) return;
    
      const nuevo = Math.max(0, safeNum(v, actual));
      const delta = nuevo - actual;
      if(delta === 0) return toast('Sin cambios');
    
      const nota = prompt('Nota:', 'Ajuste') || 'Ajuste';
    
      await applyDeltaToItemCaja({
        bodegaId: state.bodegaId,
        itemId: it.id,
        cajaId: c.id,
        delta,
        nota: key ? `${nota} (${key})` : nota,
        variante: key || null
      });
    
      await loadItems();
      await openCajasModal(it, true);
      toast('OK');
    };


    if(c.id !== '_SIN_CAJA_'){
      const btnDel = tr.querySelector('[data-act="del"]');
      if(btnDel){
        btnDel.onclick = async ()=>{
          await deleteCajaSeguro(c.id);
          await loadCajas();
          await openCajasModal(it, true);
        };
      }

      const btnEdit = tr.querySelector('[data-act="editBox"]');
      if(btnEdit){
        btnEdit.onclick = async ()=>{
          const nuevoNombre = prompt('Nombre de la caja:', c.nombre || '');
          if(nuevoNombre === null) return;
      
          const nuevaUbic = prompt(
            'Ubicación (HUECHURABA / POCURO / OFICINA):',
            displayUbic(c.ubicacion) || 'HUECHURABA'
          );
          if(nuevaUbic === null) return;
      
          try{
            setEstado('Actualizando caja...');
      
            await updateDoc(cajaDoc(state.bodegaId, c.id), {
              nombre: (nuevoNombre || '').trim(),
              ubicacion: normalizeUbic(nuevaUbic),
              actualizadoEn: serverTimestamp()
            });
      
            toast('Caja actualizada ✅');
            await loadCajas();
            await openCajasModal(it, true);
            setEstado('Listo.');
          }catch(e){
            console.error(e);
            toast('Error actualizando caja');
            setEstado('Error.');
          }
        };
      }
    }

    tb.appendChild(tr);
  }
}


/* Core: delta por caja + total */
async function applyDeltaToItemCaja({ bodegaId, itemId, cajaId, delta, nota, variante=null }){
  const _cajaId = cajaId || '_SIN_CAJA_';

  const itRef = itemDoc(bodegaId, itemId);
  const stRef = stockDoc(bodegaId, itemId, _cajaId);

  await runTransaction(db, async (tx)=>{
    const itSnap = await tx.get(itRef);
    if(!itSnap.exists()) throw new Error('Item missing');

    const itData = itSnap.data() || {};
    const totalOld = safeNum(itData.unidadesTotal, 0);

    const stSnap = await tx.get(stRef);
    const stData = stSnap.exists() ? (stSnap.data()||{}) : {};
    
    // ✅ Si viene "variante" (ej: M/L/XL), modificamos stData.variantes[variante]
    // Si NO viene, operamos como antes sobre "unidades" (stock total sin desglose)
    let variantes = (stData.variantes && typeof stData.variantes === 'object') ? { ...stData.variantes } : null;
    
    let boxOld;
    let boxNew;
    
    if(variante){
      const key = U(variante); // normaliza (m, M -> M)
      if(!variantes) variantes = {};
      const oldVar = safeNum(variantes[key], 0);
      const newVar = oldVar + delta;
      if(newVar < 0) throw new Error('NEG');
      variantes[key] = newVar;
    
      // total caja = suma de variantes
      boxOld = sumVariants(stData.variantes || {});
      boxNew = sumVariants(variantes);
    }else{
      boxOld = safeNum(stData.unidades, 0);
      boxNew = boxOld + delta;
      if(boxNew < 0) throw new Error('NEG');
    }
    
    const totalNew = totalOld + delta;
    if(totalNew < 0) throw new Error('NEG_TOTAL');
    
    if(!stSnap.exists()){
      const payload = {
        cajaId: _cajaId,
        unidades: boxNew,
        actualizadoEn: serverTimestamp()
      };
      if(variante) payload.variantes = variantes;
      tx.set(stRef, payload);
    }else{
      const payload = { unidades: boxNew, actualizadoEn: serverTimestamp() };
      if(variante) payload.variantes = variantes;
      tx.update(stRef, payload);
    }


    const itUpdate = { unidadesTotal: totalNew, actualizadoEn: serverTimestamp() };

    if(variante){
      const key = U(variante);
    
      const current = (itData.variantesTotal && typeof itData.variantesTotal === 'object')
        ? { ...itData.variantesTotal }
        : {};
    
      const oldVal = safeNum(current[key], 0);
      const newVal = oldVal + delta;
      if(newVal < 0) throw new Error('NEG_ITEM_VAR');
    
      current[key] = newVal;
      itUpdate.variantesTotal = current;
    }
    
    tx.update(itRef, itUpdate);

    // 1) Movimiento “por caja” (como ya lo tenías)
    const mvRef = doc(movsCol(bodegaId, itemId, _cajaId));
    tx.set(mvRef, {
      ts: serverTimestamp(),
      delta,
      stock: boxNew,
      by: state.user?.email || null,
      nota: nota || ''
    });
    
    // 2) ✅ NUEVO: Movimiento “rápido” a nivel de bodega (1 query para últimos 200)
    const cajaMeta = (_cajaId === '_SIN_CAJA_')
      ? { nombre: '(sin caja)', ubicacion: '' }
      : (state.cajasById.get(_cajaId) || { nombre:'(caja)', ubicacion:'' });
    
    const mvFastRef = doc(movsBodegaCol(bodegaId)); // id random
    tx.set(mvFastRef, {
      ts: serverTimestamp(),
      delta,
      stock: boxNew,
      by: state.user?.email || null,
      nota: nota || '',
    
      // metadata para render sin joins
      itemId,
      itemNombre: itData.nombre || '(sin nombre)',
      cajaId: _cajaId,
      cajaNombre: cajaMeta.nombre || '(caja)',
      cajaUbic: normalizeUbic(cajaMeta.ubicacion || '')
    });
  });
}

/* Movimientos (últimos) */
async function fetchMovimientosUltimos(bodegaId, maxItems=200){
  // ✅ 1) RÁPIDO: si existe bodegas/{bodegaId}/movimientos => 1 sola query
  try{
    const fastSnap = await getDocs(
      query(movsBodegaCol(bodegaId), orderBy('ts','desc'), limit(maxItems))
    );

    if(!fastSnap.empty){
      return fastSnap.docs.map(d=>{
        const x = d.data() || {};
        return {
          ...x,
          _itemNombre: x.itemNombre || '(sin nombre)',
          _cajaNombre: x.cajaNombre || '(caja)',
          _cajaUbic:   displayUbic(x.cajaUbic || '') // ✅ Z1 -> HUECHURABA también aquí
        };
      });
    }
  }catch(e){
    console.warn('[BODEGA] fast movimientos falló, uso fallback legacy', e);
  }

  // ✅ 2) FALLBACK LEGACY (tu método antiguo) — más lento, pero mantiene historial viejo
  const itemsSnap = await getDocs(query(itemsCol(bodegaId), orderBy('nombre','asc')));
  const moves = [];

  const cajasSnap = await getDocs(query(cajasCol(bodegaId), orderBy('nombre','asc')));
  const cajasMap = new Map();
  cajasSnap.forEach(d=> cajasMap.set(d.id, d.data()||{}));
  cajasMap.set('_SIN_CAJA_', { nombre:'(sin caja)', ubicacion:'' });

  for (const it of itemsSnap.docs){
    const itData = it.data() || {};
    const stSnap = await getDocs(query(stocksCol(bodegaId, it.id)));

    for(const st of stSnap.docs){
      const cajaId = st.id;

      // 🔥 TIP: baja de 10 a 3 si quieres acelerar el fallback (histórico antiguo)
      const ms = await getDocs(query(movsCol(bodegaId, it.id, cajaId), orderBy('ts','desc'), limit(3)));

      const cajaMeta = cajasMap.get(cajaId) || {};
      ms.forEach(d=>{
        moves.push({
          ...d.data(),
          _itemNombre: itData.nombre || '(sin nombre)',
          _cajaNombre: cajaMeta.nombre || '(caja)',
          _cajaUbic: displayUbic(cajaMeta.ubicacion || '') // ✅ Z1 -> HUECHURABA
        });
      });
    }
  }

  moves.sort((a,b)=>{
    const ta = a.ts?.toMillis ? a.ts.toMillis() : 0;
    const tb = b.ts?.toMillis ? b.ts.toMillis() : 0;
    return tb - ta;
  });

  return moves.slice(0, maxItems);
}

function renderMovimientos(moves){
  const tb = $('movTbody');
  tb.innerHTML = '';

  if(!moves.length){
    tb.innerHTML = '<tr><td colspan="8" class="muted">Sin movimientos.</td></tr>';
    return;
  }

  for(const m of moves){
    const tr = document.createElement('tr');
    const fecha = m.ts?.toDate ? m.ts.toDate().toLocaleString('es-CL') : '';
    const delta = safeNum(m.delta,0);
    const stock = safeNum(m.stock,0);

    tr.innerHTML = `
      <td>${escapeHtml(fecha)}</td>
      <td>${escapeHtml(m._itemNombre || '')}</td>
      <td>${escapeHtml(m._cajaNombre || '')}</td>
      <td class="muted">${escapeHtml(displayUbic(m._cajaUbic || ''))}</td>
      <td style="font-weight:900; ${delta<0?'color:#b91c1c':''} ${delta>0?'color:#166534':''}">
        ${delta>0?'+':''}${delta}
      </td>
      <td style="font-weight:900;">${stock}</td>
      <td class="muted">${escapeHtml(m.by || '')}</td>
      <td>${escapeHtml(m.nota || '')}</td>
    `;
    tb.appendChild(tr);
  }
}

async function cargarMasMovimientos({ pageSize=50, reset=false } = {}){
  if(state.mov.loading) return;
  if(state.mov.done && !reset) return;

  state.mov.loading = true;

  try{
    $('movEstado').textContent = 'Cargando...';
    $('btnMovMas').disabled = true;

    const qParts = [ orderBy('ts','desc'), limit(pageSize) ];
    if(!reset && state.mov.lastDoc){
      qParts.splice(1, 0, startAfter(state.mov.lastDoc)); // después del orderBy
    }

    // ✅ 1 sola query por página
    const snap = await getDocs(query(movsBodegaCol(state.bodegaId), ...qParts));
    
    if(snap.empty){
    
      // ✅ FALLBACK: si es la primera carga (reset) y la colección rápida está vacía,
      // mostramos 10 movimientos usando el método legacy (más lento, pero trae histórico).
      if(reset){
        $('movEstado').textContent = 'No hay movimientos rápidos aún. Cargando histórico...';
    
        const legacy = await fetchMovimientosUltimos(state.bodegaId, pageSize); // pageSize=10 en la carga inicial
        renderMovimientos(legacy);
    
        // en legacy no paginamos (porque sería muy lento). Ocultamos "Ver más".
        state.mov.done = true;
        $('btnMovMas').style.display = 'none';
        $('movEstado').textContent = legacy.length ? `Mostrando histórico: ${legacy.length}` : 'Sin movimientos.';
      }else{
        state.mov.done = true;
        $('movEstado').textContent = 'Fin.';
        $('btnMovMas').style.display = 'none';
      }
    
      return;
    }

    // guarda cursor
    state.mov.lastDoc = snap.docs[snap.docs.length - 1];

    const moves = snap.docs.map(d=>{
      const x = d.data() || {};
      return {
        ...x,
        _itemNombre: x.itemNombre || '(sin nombre)',
        _cajaNombre: x.cajaNombre || '(caja)',
        _cajaUbic: displayUbic(x.cajaUbic || '') // ✅ Z1 -> HUECHURABA
      };
    });

    // append (no reemplaza)
    appendMovimientos(moves);

    // si vino menos que pageSize => se acabó
    if(snap.size < pageSize){
      state.mov.done = true;
      $('movEstado').textContent = 'Fin.';
      $('btnMovMas').style.display = 'none';
    }else{
      $('movEstado').textContent = `Mostrando ${document.querySelectorAll('#movTbody tr').length}`;
      $('btnMovMas').style.display = '';
    }

  }catch(e){
    console.error(e);
    $('movEstado').textContent = 'Error.';
    if(reset){
      $('movTbody').innerHTML = '<tr><td colspan="8" class="muted">Error cargando movimientos.</td></tr>';
    }
  }finally{
    state.mov.loading = false;
    $('btnMovMas').disabled = false;
  }
}

function appendMovimientos(moves){
  const tb = $('movTbody');

  for(const m of moves){
    const tr = document.createElement('tr');
    const fecha = m.ts?.toDate ? m.ts.toDate().toLocaleString('es-CL') : '';
    const delta = safeNum(m.delta,0);
    const stock = safeNum(m.stock,0);

    tr.innerHTML = `
      <td>${escapeHtml(fecha)}</td>
      <td>${escapeHtml(m._itemNombre || '')}</td>
      <td>${escapeHtml(m._cajaNombre || '')}</td>
      <td class="muted">${escapeHtml(displayUbic(m._cajaUbic || ''))}</td>
      <td style="font-weight:900; ${delta<0?'color:#b91c1c':''} ${delta>0?'color:#166534':''}">
        ${delta>0?'+':''}${delta}
      </td>
      <td style="font-weight:900;">${stock}</td>
      <td class="muted">${escapeHtml(m.by || '')}</td>
      <td>${escapeHtml(m.nota || '')}</td>
    `;
    tb.appendChild(tr);
  }
}

async function deleteCajaSeguro(cajaId){
  if(!state.bodegaId) return;

  const cajaMeta = state.cajasById.get(cajaId) || {};
  const nombreCaja = cajaMeta.nombre || cajaId;

  const ok = confirm(`¿Borrar caja "${nombreCaja}"?\n\nSolo se puede borrar si NO tiene stock en ningún ítem.`);
  if(!ok) return;

  try{
    setEstado('Revisando stock de la caja...');

    // 1) Recorre todos los ítems de la bodega y verifica si esa caja tiene stock > 0
    const itemsSnap = await getDocs(query(itemsCol(state.bodegaId), orderBy('nombre','asc')));

    for(const it of itemsSnap.docs){
      const stRef = stockDoc(state.bodegaId, it.id, cajaId);
      const stSnap = await getDoc(stRef);
      if(stSnap.exists()){
        const u = safeNum(stSnap.data()?.unidades, 0);
        if(u > 0){
          toast(`No se puede borrar: stock ${u} en "${it.data()?.nombre || it.id}"`);
          setEstado('Listo.');
          return;
        }
      }
    }

    // 2) Si está todo en 0 (o no existe), borramos los stocks (en 0) para no dejar basura
    setEstado('Borrando referencias...');
    for(const it of itemsSnap.docs){
      const stRef = stockDoc(state.bodegaId, it.id, cajaId);
      const stSnap = await getDoc(stRef);
      if(stSnap.exists()){
        // unidades ya sabemos que es 0 aquí
        await deleteDoc(stRef);
        // Nota: no borramos subcolección movimientos automáticamente (Firestore no lo hace solo)
      }
    }

    // 3) Borrar la caja
    setEstado('Borrando caja...');
    await deleteDoc(cajaDoc(state.bodegaId, cajaId));

    toast('Caja borrada ✅');
    setEstado('Listo.');
  }catch(e){
    console.error(e);
    toast('Error borrando caja.');
    setEstado('Error.');
  }
}

