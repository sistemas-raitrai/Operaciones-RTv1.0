// control-stock.js
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
  getBlob,
  deleteObject
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-storage.js';

import {
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
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
   ORDEN NATURAL (NUEVO)
   - B2 antes que B11
   - 1.2 antes que 1.11
   - A10 después de A2
   ====================== */

// Convierte "B11" => ["B", 11]
// Convierte "1.11" => [1, 11]
// Convierte "A2-1.3" => ["A", 2, "-",
function naturalTokens(str){
  const s = String(str ?? '').trim();
  if(!s) return [];

  const out = [];
  // separamos por grupos: números con decimales o texto
  const re = /(\d+(?:\.\d+)*)|([^\d]+)/g;
  let m;

  while((m = re.exec(s))){
    if(m[1]){
      // "1.11" => [1, 11]
      const parts = m[1].split('.').map(n => Number(n));
      out.push(...parts);
    }else if(m[2]){
      out.push(m[2].toUpperCase());
    }
  }
  return out;
}

function naturalCompare(a, b){
  const A = naturalTokens(a);
  const B = naturalTokens(b);

  const n = Math.max(A.length, B.length);
  for(let i=0; i<n; i++){
    const x = A[i];
    const y = B[i];

    if(x === undefined) return -1;
    if(y === undefined) return  1;

    const xNum = typeof x === 'number' && Number.isFinite(x);
    const yNum = typeof y === 'number' && Number.isFinite(y);

    // número vs número
    if(xNum && yNum){
      if(x !== y) return x - y;
      continue;
    }

    // texto vs texto
    if(!xNum && !yNum){
      const c = String(x).localeCompare(String(y), 'es');
      if(c !== 0) return c;
      continue;
    }

    // si uno es número y el otro texto:
    // priorizamos texto primero (ej: "B" antes que 2 dentro del tokenizado)
    if(xNum && !yNum) return 1;
    if(!xNum && yNum) return -1;
  }

  // fallback por longitud original
  return String(a ?? '').localeCompare(String(b ?? ''), 'es');
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
function getVariantOptionsInBox(itemId, cajaId) {
  if (state.modal.item?.id !== itemId) return [];

  const variantes = state.modal.stocksByCaja.get(cajaId)?.variantes;
  if (!variantes || typeof variantes !== 'object') return [];

  return Object.keys(variantes)
    .map(talla => U(talla))
    .filter(talla => safeNum(variantes[talla], 0) > 0)
    .sort((a, b) => a.localeCompare(b, 'es'));
}

function pedirCantidad({ titulo='Cantidad', sugerida=0 } = {}){
  const v = prompt(titulo, String(sugerida));
  if(v === null) return null;
  const n = Math.max(0, safeNum(v, 0));
  return n;
}

const BODEGA_TALLAS = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'];

function instalarSelectorVarianteBodega(id) {
  const anterior = $(id);
  if (!anterior || anterior.tagName === 'SELECT') return;

  const selector = document.createElement('select');
  selector.id = id;
  selector.setAttribute('aria-label', 'Talla o variante');
  selector.add(new Option('Sin talla', ''));

  for (const talla of BODEGA_TALLAS) {
    selector.add(new Option(talla, talla));
  }

  selector.add(new Option('Otra variante', '__OTRA__'));

  const libre = document.createElement('input');
  libre.id = `${id}Libre`;
  libre.type = 'text';
  libre.placeholder = 'Escribe la variante';
  libre.setAttribute('aria-label', 'Nombre de la variante');
  libre.maxLength = 60;
  libre.hidden = true;

  anterior.replaceWith(selector);
  selector.after(libre);

  selector.addEventListener('change', () => {
    libre.hidden = selector.value !== '__OTRA__';
    if (!libre.hidden) libre.focus();
  });
}

function leerVarianteBodega(id) {
  const valor = $(id)?.value || '';
  return U(valor === '__OTRA__' ? $(`${id}Libre`)?.value : valor);
}

function limpiarVarianteBodega(id) {
  const selector = $(id);
  const libre = $(`${id}Libre`);
  if (selector) selector.value = '';
  if (libre) {
    libre.value = '';
    libre.hidden = true;
  }
}

function abrirAccionBodega({
  titulo,
  contexto = '',
  accion = 'Guardar',
  campos,
  guardar,
  refrescar
}) {
  const modal = $('bdAccionModal');
  const formulario = $('bdAccionForm');
  const contenedor = $('bdAccionCampos');
  const estado = $('bdAccionEstado');
  const confirmar = $('bdAccionGuardar');
  const cancelar = $('bdAccionCancelar');

  if (modal.open) return;

  let guardando = false;
  const controles = {};

  $('bdAccionTitulo').textContent = titulo;
  $('bdAccionContexto').textContent = contexto;
  estado.textContent = '';
  confirmar.textContent = accion;
  confirmar.disabled = false;
  cancelar.disabled = false;
  contenedor.replaceChildren();

  for (const campo of campos) {
    const fila = document.createElement('label');
    fila.className = 'field';

    const texto = document.createElement('span');
    texto.textContent = campo.etiqueta;

    const control = document.createElement(
      campo.opciones ? 'select' : campo.multilinea ? 'textarea' : 'input'
    );

    if (campo.opciones) {
      for (const [valor, etiqueta] of campo.opciones) {
        control.add(new Option(etiqueta, valor));
      }
    } else if (!campo.multilinea) {
      control.type = campo.tipo || 'text';
    }

    if (campo.min !== undefined) control.min = campo.min;
    if (campo.max !== undefined) control.max = campo.max;
    if (campo.tipo === 'number') control.step = '1';

    control.required = Boolean(campo.requerido);
    control.value = campo.valor ?? '';
    control.readOnly = Boolean(campo.soloLectura);
    controles[campo.nombre] = control;
    fila.append(texto, control);
    contenedor.append(fila);

    if (campo.dependeDe) {
      const origen = controles[campo.dependeDe];
      const actualizarVisibilidad = () => {
        const mostrar = origen.value === campo.mostrarCon;
        fila.hidden = !mostrar;
        fila.style.display = mostrar ? '' : 'none';
        control.disabled = !mostrar;
      };
      origen.addEventListener('change', actualizarVisibilidad);
      actualizarVisibilidad();
    }
  }

  cancelar.onclick = () => modal.close();
  modal.oncancel = evento => {
    if (guardando) evento.preventDefault();
  };

  formulario.onsubmit = async evento => {
    evento.preventDefault();
    if (guardando) return;

    const valores = Object.fromEntries(
      Object.entries(controles).map(([nombre, control]) => [
        nombre,
        control.disabled ? '' : control.value.trim()
      ])
    );

    guardando = true;
    confirmar.disabled = true;
    cancelar.disabled = true;
    confirmar.textContent = 'Guardando…';
    estado.textContent = 'Guardando…';

    let mensaje;

    try {
      mensaje = await guardar(valores);
    } catch (error) {
      console.error('[BODEGA]', error);
      estado.textContent = error.message || 'No se pudo guardar.';
      confirmar.disabled = false;
      cancelar.disabled = false;
      confirmar.textContent = accion;
      guardando = false;
      return;
    }

    modal.close();
    toast(mensaje);

    try {
      await refrescar?.();
    } catch (error) {
      console.error('[BODEGA] Actualizar pantalla', error);
      toast(`${mensaje} Pulsa Actualizar para recargar los saldos.`);
    }
  };

  modal.showModal();
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
  if (location.hash.startsWith("#firmar-guia=")) return;
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
    for (const id of ['itVariante', 'cxVarianteEntrada', 'cxVarianteMasiva']) {
      instalarSelectorVarianteBodega(id);
    }
    setEstado('Listo.');
  }catch(err){
    console.error(err);
    setEstado('Error cargando.');
    toast('Error cargando bodega.');
  }
}

async function ensureDefaultBodegasIfEmpty(){
  const snap = await getDocs(
    query(
      bodegasCol(),
      orderBy('nombre', 'asc'),
      limit(5)
    )
  );

  if(!snap.empty){
    return;
  }

  const defaults = [
    'BODEGAS',
    'Oficina'
  ];

  for(const nombre of defaults){
    await addDoc(bodegasCol(), {
      nombre,
      creadoEn: serverTimestamp(),
      creadoPor: state.user?.email || null,
      activo: true
    });
  }
}

async function loadBodegasIntoSelect(){
  const sel = $('selBodega');
  sel.innerHTML = '';

  const snap = await getDocs(
    query(
      bodegasCol(),
      orderBy('nombre', 'asc')
    )
  );

  state.bodegas = snap.docs.map(d => ({
    id: d.id,
    ...(d.data() || {})
  }));

  /*
   * Bodega preferida del sistema.
   *
   * No dependemos del orden alfabético.
   */
  const bodegaPrincipal = state.bodegas.find(b => {
    return U(b.nombre) === 'BODEGAS';
  });

  /*
   * Si todavía no existe una selección:
   * 1. Preferimos BODEGAS.
   * 2. Si no existe, usamos la primera.
   */
  if(!state.bodegaId){
    state.bodegaId =
      bodegaPrincipal?.id ||
      state.bodegas[0]?.id ||
      null;
  }

  /*
   * Si la bodega que estaba seleccionada ya no existe,
   * volvemos a BODEGAS.
   */
  else if(
    !state.bodegas.some(
      b => b.id === state.bodegaId
    )
  ){
    state.bodegaId =
      bodegaPrincipal?.id ||
      state.bodegas[0]?.id ||
      null;
  }

  for(const b of state.bodegas){
    const opt = document.createElement('option');

    opt.value = b.id;
    opt.textContent =
      b.nombre ||
      '(sin nombre)';

    sel.appendChild(opt);
  }

  sel.value =
    state.bodegaId ||
    '';

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
  
  // ✅ Orden humano (B2 < B11, 1.2 < 1.11)
  state.cajas.sort((a,b)=> naturalCompare(a?.nombre, b?.nombre));
  
  for(const c of state.cajas) state.cajasById.set(c.id, c);

  // Opción "(sin caja)" SOLO para el select del formulario de ítem
  const opt0 = document.createElement('option');
  opt0.value = '';
  opt0.textContent = '(sin caja)';
  itCajaSel.appendChild(opt0);

  for(const c of state.cajas){
  
    // ✅ Normaliza visualmente: Z1 -> HUECHURABA (y mayúsculas consistentes)
    const ubicTxt = displayUbic(c.ubicacion || '');
  
    const t = `${c.nombre || '(sin nombre)'}${ubicTxt ? ' · ' + ubicTxt : ''}`;
  
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

  const boton = $('btnCrearItem');
  if (boton.disabled) return;

  const varianteInicial = leerVarianteBodega('itVariante');

  if (unidadesInit > 0 && $('itVariante')?.value === '__OTRA__' && !varianteInicial) {
    return toast('Escribe la variante de la carga inicial.');
  }

  const textoBoton = boton.textContent;
  boton.disabled = true;
  boton.textContent = 'Guardando…';
  let guardado = false;

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
    
      const key = varianteInicial || null;
    
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
    limpiarVarianteBodega('itVariante');
    guardado = true;
    toast(`Ítem guardado · ${nombre}`);

    await loadItems();
    setEstado('Listo.');
  } catch (error) {
    console.error('[BODEGA] Guardar ítem', error);
    toast(guardado
      ? `Ítem guardado · ${nombre}. Pulsa Actualizar para verlo.`
      : 'El guardado se interrumpió. Actualiza y revisa si el ítem o su caja ya se crearon.');
    setEstado('Error.');
  } finally {
    boton.disabled = false;
    boton.textContent = textoBoton;
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


  $('txtSearch').oninput =
    renderItems;


  $('selFiltroStock').onchange =
    renderItems;


  /*
   * MODAL MOVIMIENTOS
   */
  $('btnVerMovimientos').onclick = async ()=>{

    if(!state.bodegaId){
      return;
    }

    $('movBackdrop').style.display =
      'flex';


    /*
     * Reset paginación.
     */
    state.mov.lastDoc = null;
    state.mov.done = false;

    $('movTbody').innerHTML = '';

    $('movEstado').textContent =
      'Cargando...';


    /*
     * Carga inicial rápida.
     */
    await cargarMasMovimientos({
      pageSize: 10,
      reset: true
    });
  };


  /*
   * IMPORTANTE:
   *
   * El modal se cierra SOLAMENTE
   * con este botón.
   *
   * Ya no cerramos haciendo clic
   * en el backdrop.
   */
  $('btnCerrarMov').onclick = ()=>{
    $('movBackdrop').style.display =
      'none';
  };


  /*
   * VER MÁS MOVIMIENTOS
   */
  $('btnMovMas').onclick = async ()=>{

    if(!state.bodegaId){
      return;
    }

    await cargarMasMovimientos({
      pageSize: 50,
      reset: false
    });
  };


  /*
   * EXPORTAR INVENTARIO
   */
  $('btnExportInv').onclick = async ()=>{

    try{

      if(!state.bodegaId){
        return;
      }


      setEstado(
        'Preparando exportación...'
      );

      toast(
        'Generando Excel...'
      );


      exportarInventarioExcelFiltrado();


      setEstado(
        'Listo.'
      );

      toast(
        'Excel descargado ✅'
      );


    }catch(e){

      console.error(e);

      setEstado(
        'Error exportando.'
      );

      toast(
        'Error exportando inventario.'
      );
    }
  };


  /*
   * EXPORTAR MOVIMIENTOS
   */
  $('btnExportMov').onclick = async ()=>{

    if(!state.bodegaId){
      return;
    }

    try{

      setEstado(
        'Exportando movimientos...'
      );

      toast(
        'Preparando Excel...'
      );


      await exportarMovimientosExcel({
        bodegaId:
          state.bodegaId,

        pageSize:
          800
      });


      setEstado(
        'Listo.'
      );

      toast(
        'Excel descargado ✅'
      );


    }catch(e){

      console.error(e);

      setEstado(
        'Error exportando.'
      );

      toast(
        'Error exportando Excel.'
      );
    }
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

function editItem(it) {
  const bodegaId = state.bodegaId;
  if (!bodegaId) return;

  abrirAccionBodega({
    titulo: 'Editar ítem',
    contexto: it.nombre,
    campos: [
      { nombre: 'nombre', etiqueta: 'Nombre', valor: it.nombre, requerido: true },
      {
        nombre: 'descripcion',
        etiqueta: 'Descripción',
        valor: it.descripcion,
        multilinea: true
      },
      {
        nombre: 'minimo',
        etiqueta: 'Mínimo de stock para alerta',
        tipo: 'number',
        min: 0,
        valor: safeNum(it.minimo, 3),
        requerido: true
      }
    ],

    guardar: async datos => {
      const minimo = Number(datos.minimo);
      if (!datos.nombre || !Number.isSafeInteger(minimo) || minimo < 0) {
        throw new Error('Completa el nombre y un mínimo entero igual o mayor que cero.');
      }

      const ref = itemDoc(bodegaId, it.id);
      const evento = doc(movsBodegaCol(bodegaId));
      const despues = { nombre: datos.nombre, descripcion: datos.descripcion, minimo };

      await runTransaction(db, async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error('Este ítem ya no está disponible.');

        const actual = snap.data();
        tx.update(ref, { ...despues, actualizadoEn: serverTimestamp() });
        tx.set(evento, buildEventoPayload({
          tipo: 'ITEM_EDIT',
          itemId: it.id,
          itemNombre: datos.nombre,
          antes: {
            nombre: actual.nombre || '',
            descripcion: actual.descripcion || '',
            minimo: safeNum(actual.minimo, 3)
          },
          despues,
          nota: 'Edición de ítem'
        }));
      });

      return `Ítem actualizado · ${datos.nombre}`;
    },

    refrescar: loadItems
  });
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

  /*
   * CERRAR MODAL
   *
   * IMPORTANTE:
   * Ya NO cerramos el modal haciendo clic
   * sobre el fondo/backdrop.
   *
   * Solo se cierra con el botón "Cerrar".
   */
  $('btnCajasCerrar').onclick = ()=>{
    $('cajasBackdrop').style.display = 'none';
  };


  /*
   * CREACIÓN DE CAJAS
   *
   * Hasta:
   *
   * 0     => crea solamente "Desde"
   * vacío => crea solamente "Desde"
   * >=Desde => crea rango
   */
  $('btnCxCrearMasivo').onclick = async ()=>{

    if(!state.bodegaId){
      return;
    }

    const it = state.modal.item;

    if(!it){
      toast('Abre el modal desde un ítem.');
      return;
    }


    const prefijo =
      ($('cxPrefijo').value || '')
        .trim();


    const desde =
      Math.floor(
        safeNum(
          $('cxDesde').value,
          0
        )
      );


    const hastaIngresado =
      Math.floor(
        safeNum(
          $('cxHasta').value,
          0
        )
      );


    const ubic =
      normalizeUbic(
        $('cxUbicMasivo')?.value || ''
      );


    const stockInicial =
      Math.max(
        0,
        Math.floor(
          safeNum(
            $('cxStockInicial').value,
            0
          )
        )
      );


    /*
     * VALIDACIONES
     */

    if(!prefijo){
      toast('Falta prefijo');
      return;
    }


    if(desde <= 0){
      toast('Desde debe ser mayor a 0');
      return;
    }


    /*
     * Si Hasta es:
     *
     * 0
     * vacío
     *
     * entendemos:
     *
     * "crear solamente la caja Desde"
     */
    const hasta =
      hastaIngresado <= 0
        ? desde
        : hastaIngresado;


    if(hasta < desde){
      toast('Hasta no puede ser menor que Desde');
      return;
    }

    const varianteMasiva = stockInicial > 0
      ? leerVarianteBodega('cxVarianteMasiva') || null
      : null;

    if (stockInicial > 0 &&
        $('cxVarianteMasiva')?.value === '__OTRA__' &&
        !varianteMasiva) {
      return toast('Escribe la variante del stock inicial.');
    }

    const botonCrear = $('btnCxCrearMasivo');
    if (botonCrear.disabled) return;

    const textoBoton = botonCrear.textContent;
    botonCrear.disabled = true;
    botonCrear.textContent = 'Creando…';


    try{

      /*
       * MENSAJE DE CARGA
       */

      if(desde === hasta){

        setEstado(
          `Creando caja ${prefijo}${desde}...`
        );

      }else{

        setEstado(
          `Creando cajas ${prefijo}${desde} a ${prefijo}${hasta}...`
        );

      }


      /*
       * Aseguramos que state.cajas
       * esté actualizado.
       */
      await loadCajas();


      const existentes =
        new Set(
          state.cajas.map(
            c => U(c.nombre || '')
          )
        );


      let creadas = 0;
      let existentesOmitidas = 0;
      let stockAplicado = 0;


      /*
       * TALLA / VARIANTE
       *
       * Se lee UNA VEZ.
       *
       * Ej:
       * M
       * L
       * XL
       *
       * vacío = stock general
       */


      /*
       * CREACIÓN
       */

      for(
        let i = desde;
        i <= hasta;
        i++
      ){

        const nombre =
          `${prefijo}${i}`.trim();


        const key =
          U(nombre);


        /*
         * No duplicamos cajas.
         */
        if(existentes.has(key)){
          existentesOmitidas++;
          continue;
        }


        /*
         * Crear caja.
         */
        const cRef =
          await addDoc(
            cajasCol(state.bodegaId),
            {
              nombre,

              ubicacion:
                ubic || '',

              creadoEn:
                serverTimestamp(),

              creadoPor:
                state.user?.email || null,

              actualizadoEn:
                serverTimestamp()
            }
          );


        existentes.add(key);

        creadas++;


        /*
         * STOCK INICIAL
         *
         * Solo si es > 0.
         *
         * Aquí se mantiene exactamente
         * la lógica actual de variantes.
         */
        if(stockInicial > 0){

          await applyDeltaToItemCaja({
            bodegaId:
              state.bodegaId,

            itemId:
              it.id,

            cajaId:
              cRef.id,

            delta:
              +stockInicial,

            nota:
              varianteMasiva
                ? `Carga inicial (${nombre}) (${varianteMasiva})`
                : `Carga inicial (${nombre})`,

            variante:
              varianteMasiva
          });


          stockAplicado++;
        }
      }

      const mensaje = [
        creadas === 1 ? '1 caja creada' : `${creadas} cajas creadas`,
        existentesOmitidas > 0
          ? `${existentesOmitidas} ya existían`
          : '',
        stockAplicado > 0
          ? `Stock inicial guardado en ${stockAplicado} ${stockAplicado === 1 ? 'caja' : 'cajas'}`
          : ''
      ].filter(Boolean).join(' · ');

      toast(mensaje);

      try {
        await openCajasModal(it, true);
        await loadItems();
        setEstado('Listo.');
      } catch (error) {
        console.error('[BODEGA] Actualizar después de crear cajas', error);
        toast(`${mensaje}. Pulsa Actualizar para recargar la pantalla.`);
        setEstado('Pulsa Actualizar para ver los cambios.');
      }

    } catch (error) {
      console.error('[BODEGA] Crear cajas', error);
      toast('La operación se interrumpió. Pulsa Actualizar para revisar qué cajas se crearon.');
      setEstado('Error.');
    } finally {
      botonCrear.disabled = false;
      botonCrear.textContent = textoBoton;
    }
  };
}

async function openCajasModal(
  it,
  keepOpen = false
){
  if(!state.bodegaId){
    return;
  }

  state.modal.item = it;

  $('cajasTitle').textContent =
    `Cajas · ${it.nombre || ''}`;


  /*
   * Solo reseteamos el formulario
   * cuando el usuario ABRE realmente el modal.
   *
   * Si keepOpen=true significa que estamos
   * refrescando después de una operación.
   *
   * En ese caso NO borramos lo que el usuario
   * tenía escrito.
   */
  if(!keepOpen){

    $('cxPrefijo').value =
      'A';

    $('cxDesde').value =
      '1';

    /*
     * 0 = una sola caja
     */
    $('cxHasta').value =
      '0';


    /*
     * Ubicación predeterminada.
     */
    $('cxUbicMasivo').value =
      'HUECHURABA';


    /*
     * Evitamos crear stock accidentalmente.
     */
    $('cxStockInicial').value =
      '0';


    /*
     * Sin talla predeterminada.
     */
    limpiarVarianteBodega('cxVarianteMasiva');


    $('cajasBackdrop').style.display =
      'flex';
  }


  await loadCajas();

  await loadStocksForItem(
    it.id
  );

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

async function cargarResumenDetalleBodega(item, filas) {
  const bodegaId = state.bodegaId;
  const selector = $('cxCajaEntrada');
  const resumen = $('cxResumenMovimientos');
  const tbody = $('cxHistorialTbody');

  const cajasConStock = filas.filter(fila => fila.id !== '_SIN_CAJA_').length;
  const unidades = filas.reduce((total, fila) => total + fila.unidades, 0);

  $('cxResumenStock').textContent =
    `${cajasConStock} cajas con stock · ${unidades} unidades en total`;

  const cajaSeleccionada = selector.value;
  selector.replaceChildren(new Option('Selecciona una caja', ''));

  const etiquetas = state.cajas.map(caja =>
    `${caja.nombre || '(sin nombre)'} · ${displayUbic(caja.ubicacion || '')}`
  );
  const frecuencias = new Map();

  for (const etiqueta of etiquetas) {
    frecuencias.set(etiqueta, (frecuencias.get(etiqueta) || 0) + 1);
  }

  state.cajas.forEach((caja, indice) => {
    const etiqueta = etiquetas[indice];
    const texto = frecuencias.get(etiqueta) > 1
      ? `${etiqueta} · ID ${caja.id}`
      : etiqueta;
    selector.add(new Option(texto, caja.id));
  });

  if (state.cajasById.has(cajaSeleccionada)) {
    selector.value = cajaSeleccionada;
  }

  $('btnCxAgregarExistente').onclick = () => agregarStockCajaExistente(item);

  tbody.replaceChildren();
  resumen.textContent = 'Cargando movimientos…';

  const desde = new Date();
  const dia = desde.getDate();
  desde.setDate(1);
  desde.setMonth(desde.getMonth() - 3);
  const ultimoDiaDelMes = new Date(
    desde.getFullYear(), desde.getMonth() + 1, 0
  ).getDate();
  desde.setDate(Math.min(dia, ultimoDiaDelMes));

  try {
    const snap = await getDocs(query(
      movsBodegaCol(bodegaId),
      where('itemId', '==', item.id),
      where('ts', '>=', desde),
      orderBy('ts', 'desc')
    ));

    if (state.bodegaId !== bodegaId || state.modal.item?.id !== item.id) return;

    let entradas = 0;
    let salidas = 0;
    let unidadesIngresadas = 0;
    let unidadesRetiradas = 0;
    const filasHistorial = document.createDocumentFragment();

    for (const registro of snap.docs) {
      const mov = registro.data();
      const delta = Number(mov.delta);
      if (!Number.isFinite(delta) || delta === 0) continue;

      if (delta > 0) {
        entradas++;
        unidadesIngresadas += delta;
      } else {
        salidas++;
        unidadesRetiradas += Math.abs(delta);
      }

      const fecha = mov.ts?.toDate();
      const fila = document.createElement('tr');
      const valores = [
        fecha ? fecha.toLocaleString('es-CL', {
          timeZone: 'America/Santiago'
        }) : '—',
        [mov.cajaNombre, displayUbic(mov.cajaUbic || '')].filter(Boolean).join(' · '),
        delta > 0 ? 'Entrada' : 'Salida de unidades',
        `${delta > 0 ? '+' : ''}${delta}${mov.variante ? ` (${mov.variante})` : ''}`,
        mov.stock ?? '—',
        delta < 0 ? mov.motivo || 'Sin registrar' : '—',
        mov.destino || '—',
        mov.by || '—'
      ];

      for (const valor of valores) {
        const celda = document.createElement('td');
        celda.textContent = String(valor);
        fila.appendChild(celda);
      }

      filasHistorial.appendChild(fila);
    }

    tbody.replaceChildren(filasHistorial);
    resumen.textContent =
      `${entradas + salidas} movimientos · ` +
      `${entradas} entradas (+${unidadesIngresadas} unidades) · ` +
      `${salidas} salidas (−${unidadesRetiradas} unidades)`;
  } catch (error) {
    console.error('[BODEGA] Historial del producto', error);
    if (state.bodegaId === bodegaId && state.modal.item?.id === item.id) {
      resumen.textContent = 'No se pudo cargar el historial del producto.';
    }
  }
}

async function agregarStockCajaExistente(item) {
  const boton = $('btnCxAgregarExistente');
  if (boton.disabled) return;

  const bodegaId = state.bodegaId;
  const cajaId = $('cxCajaEntrada').value;
  const caja = state.cajasById.get(cajaId);
  const cantidad = $('cxCantidadEntrada').valueAsNumber;
  const variante = leerVarianteBodega('cxVarianteEntrada') || null;

  if (!caja) return toast('Selecciona una caja.');
  if (!Number.isSafeInteger(cantidad) || cantidad < 1) {
    return toast('Ingresa una cantidad entera mayor que cero.');
  }

  if ($('cxVarianteEntrada').value === '__OTRA__' && !variante) {
    return toast('Escribe la variante de la entrada.');
  }

  boton.disabled = true;
  const textoBoton = boton.textContent;
  boton.textContent = 'Guardando…';

  const mensaje = `Entrada guardada · +${cantidad} ${item.nombre}` +
    `${variante ? ` · ${variante}` : ''} · ${caja.nombre}`;

  try {
    try {
      await applyDeltaToItemCaja({
        bodegaId,
        itemId: item.id,
        cajaId,
        delta: cantidad,
        nota: 'Entrada a caja existente',
        variante
      });
    } catch (error) {
      console.error('[BODEGA] Entrada de stock', error);
      toast(error.message || 'No se pudo guardar la entrada.');
      return;
    }

    $('cxCantidadEntrada').value = '1';
    limpiarVarianteBodega('cxVarianteEntrada');
    toast(mensaje);

    if (state.bodegaId !== bodegaId) return;

    try {
      await loadItems();
      if (state.bodegaId === bodegaId && state.modal.item?.id === item.id) {
        await openCajasModal(item, true);
      }
    } catch (error) {
      console.error('[BODEGA] Actualizar detalle tras entrada', error);
      toast(`${mensaje}. Pulsa Actualizar para ver el saldo.`);
    }
  } finally {
    boton.disabled = false;
    boton.textContent = textoBoton;
  }
}

function registrarSalidaUnidades(item, caja, cantidadFija = null) {
  const bodegaId = state.bodegaId;
  const stock = state.modal.stocksByCaja.get(caja.id);
  const variantes = getVariantOptionsInBox(item.id, caja.id);

  const campos = [];

  if (variantes.length) {
    campos.push({
      nombre: 'variante',
      etiqueta: 'Talla o variante',
      opciones: [
        ['', 'Selecciona una talla'],
        ...variantes.map(talla => [
          talla,
          `${talla} · ${safeNum(stock?.variantes?.[talla], 0)} disponibles`
        ])
      ],
      requerido: true
    });
  }

  campos.push(
    {
      nombre: 'cantidad',
      etiqueta: 'Unidades a retirar',
      tipo: 'number',
      min: 1,
      max: caja.unidades,
      valor: cantidadFija ?? 1,
      soloLectura: cantidadFija !== null,
      requerido: true
    },
    {
      nombre: 'motivo',
      etiqueta: 'Motivo del retiro',
      requerido: true,
      opciones: [
        ['', 'Selecciona un motivo'],
        ['Entrega a grupo', 'Entrega a grupo'],
        ['Consumo interno', 'Consumo interno'],
        ['Baja', 'Baja'],
        ['Ajuste de inventario', 'Ajuste de inventario'],
        ['Otro', 'Otro']
      ]
    },
    {
      nombre: 'otroMotivo',
      etiqueta: 'Escribe el motivo',
      dependeDe: 'motivo',
      mostrarCon: 'Otro',
      requerido: true
    },
    {
      nombre: 'destino',
      etiqueta: 'Destino o referencia (para grupos, ID o número de negocio)',
      requerido: true
    }
  );

  abrirAccionBodega({
    titulo: 'Retirar stock',
    contexto: [item.nombre, caja.nombre, displayUbic(caja.ubicacion)]
      .filter(Boolean).join(' · '),
    accion: 'Confirmar retiro',
    campos,

    guardar: async datos => {
      const cantidad = Number(datos.cantidad);
      const variante = datos.variante || null;
      const motivo = datos.motivo === 'Otro' ? datos.otroMotivo : datos.motivo;
      const destino = datos.destino;

      if (!Number.isSafeInteger(cantidad) || cantidad < 1) {
        throw new Error('Ingresa una cantidad entera mayor que cero.');
      }

      if (!motivo || !destino) {
        throw new Error('Completa el motivo y el destino o referencia.');
      }

      if (motivo === 'Entrega a grupo' && !/\d/.test(destino)) {
        throw new Error('Ingresa el ID del grupo o el número de negocio.');
      }

      const disponible = variante
        ? safeNum(stock?.variantes?.[variante], 0)
        : caja.unidades;

      if (cantidad > disponible) {
        throw new Error(`Solo hay ${disponible} unidades disponibles para este retiro.`);
      }

      try {
        await applyDeltaToItemCaja({
          bodegaId,
          itemId: item.id,
          cajaId: caja.id,
          delta: -cantidad,
          variante,
          motivo,
          destino,
          nota: `${motivo} · ${destino}`
        });
      } catch (error) {
        if (['NEG', 'NEG_TOTAL', 'NEG_ITEM_VAR'].includes(error.message)) {
          throw new Error('El stock cambió o es insuficiente. Cancela y vuelve a abrir Detalle.');
        }
        throw error;
      }

      return `Retiro guardado · ${cantidad} ${item.nombre}` +
        `${variante ? ` · ${variante}` : ''} · ${caja.nombre} → ${destino}`;
    },

    refrescar: async () => {
      if (state.bodegaId !== bodegaId) return;
      await loadItems();
      await openCajasModal(item, true);
    }
  });
}

function editarCajaBodega(item, caja) {
  const bodegaId = state.bodegaId;
  const ubicacionActual = normalizeUbic(caja.ubicacion);

  abrirAccionBodega({
    titulo: 'Editar caja',
    contexto: caja.nombre,
    campos: [
      {
        nombre: 'nombre',
        etiqueta: 'Nombre de la caja',
        valor: caja.nombre,
        requerido: true
      },
      {
        nombre: 'ubicacion',
        etiqueta: 'Ubicación',
        valor: UBIC_OPTS.includes(ubicacionActual) ? ubicacionActual : '',
        requerido: true,
        opciones: [
          ['', 'Selecciona una ubicación'],
          ['OFICINA', 'Oficina'],
          ['HUECHURABA', 'Huechuraba'],
          ['POCURO', 'Pocuro']
        ]
      }
    ],

    guardar: async datos => {
      if (!datos.nombre || !UBIC_OPTS.includes(datos.ubicacion)) {
        throw new Error('Completa el nombre y selecciona una ubicación.');
      }

      await updateDoc(cajaDoc(bodegaId, caja.id), {
        nombre: datos.nombre,
        ubicacion: datos.ubicacion,
        actualizadoEn: serverTimestamp()
      });

      return `Caja actualizada · ${datos.nombre} · ${datos.ubicacion}`;
    },

    refrescar: async () => {
      if (state.bodegaId !== bodegaId) return;
      await loadCajas();
      await loadItems();
      await openCajasModal(item, true);
    }
  });
}
function abrirEntradaDesdeFilaBodega(item, caja, cantidadFija = null) {
  const bodegaId = state.bodegaId;
  const variantes = getVariantOptionsInBox(item.id, caja.id);
  const tieneTallas = variantes.length > 0;

  const campos = [{
    nombre: 'cantidad',
    etiqueta: 'Unidades a agregar',
    tipo: 'number',
    min: 1,
    valor: cantidadFija ?? 1,
    soloLectura: cantidadFija !== null,
    requerido: true
  }];

  if (tieneTallas) {
    const opciones = [...new Set([...BODEGA_TALLAS, ...variantes])];

    campos.push(
      {
        nombre: 'variante',
        etiqueta: 'Talla o variante',
        opciones: [
          ['', 'Selecciona una talla'],
          ...opciones.map(talla => [talla, talla]),
          ['__OTRA__', 'Otra variante']
        ],
        requerido: true
      },
      {
        nombre: 'varianteLibre',
        etiqueta: 'Escribe la variante',
        dependeDe: 'variante',
        mostrarCon: '__OTRA__',
        requerido: true
      }
    );
  }

  abrirAccionBodega({
    titulo: 'Agregar stock',
    contexto: [item.nombre, caja.nombre, displayUbic(caja.ubicacion)]
      .filter(Boolean).join(' · '),
    accion: 'Guardar entrada',
    campos,

    guardar: async datos => {
      const cantidad = Number(datos.cantidad);
      const variante = U(
        datos.variante === '__OTRA__' ? datos.varianteLibre : datos.variante
      );

      if (!Number.isSafeInteger(cantidad) || cantidad < 1) {
        throw new Error('Ingresa una cantidad entera mayor que cero.');
      }

      if (tieneTallas && !variante) {
        throw new Error('Selecciona una talla o escribe la variante.');
      }

      await applyDeltaToItemCaja({
        bodegaId,
        itemId: item.id,
        cajaId: caja.id,
        delta: cantidad,
        variante: variante || null,
        nota: 'Entrada de stock'
      });

      return `Entrada guardada · +${cantidad} ${item.nombre}` +
        `${variante ? ` · ${variante}` : ''} · ${caja.nombre}`;
    },

    refrescar: async () => {
      if (state.bodegaId !== bodegaId) return;
      await loadItems();
      await openCajasModal(item, true);
    }
  });
}

async function refreshCajasModalTable() {
  const it = state.modal.item;
  if (!it) return;

  const tb = $('cajasTbody');
  tb.replaceChildren();

  const filas = [];
  const cajas = [
    ...state.cajas,
    { id: '_SIN_CAJA_', nombre: '(sin caja)', ubicacion: '' }
  ];

  for (const caja of cajas) {
    const stock = state.modal.stocksByCaja.get(caja.id);
    const unidades = safeNum(stock?.unidades, 0);
    if (unidades <= 0) continue;

    filas.push({
      id: caja.id,
      nombre: caja.nombre || '(sin nombre)',
      ubicacion: caja.ubicacion || '',
      unidades,
      variantes: stock.variantes || null
    });
  }

  void cargarResumenDetalleBodega(it, filas);

  if (!filas.length) {
    tb.innerHTML = `
      <tr>
        <td colspan="4" class="muted">Este ítem no tiene stock.</td>
      </tr>
    `;
    return;
  }

  filas.sort((a, b) => naturalCompare(a.nombre, b.nombre));

  for (const c of filas) {
    const tr = document.createElement('tr');
    const esCajaReal = c.id !== '_SIN_CAJA_';

    tr.innerHTML = `
      <td style="font-weight:900;">${escapeHtml(c.nombre)}</td>
      <td class="muted">${escapeHtml(displayUbic(c.ubicacion))}</td>
      <td style="font-weight:900;">
        <div>${c.unidades}</div>
        ${c.variantes ? `
          <div class="muted" style="font-weight:700;font-size:12px;margin-top:2px;">
            ${escapeHtml(formatVariants(c.variantes))}
          </div>
        ` : ''}
      </td>
      <td>
        <button type="button" class="btn small" data-act="dec">−1</button>
        <button type="button" class="btn small" data-act="inc">+1</button>
        <button type="button" class="btn small" data-act="add">Agregar</button>
        <button type="button" class="btn small" data-act="rem">Retirar</button>
        ${esCajaReal ? `
          <button type="button" class="btn small" data-act="editBox">Editar</button>
          <button type="button" class="btn small danger" data-act="del">Borrar</button>
        ` : ''}
      </td>
    `;

    tr.querySelector('[data-act="dec"]').onclick = () =>
      registrarSalidaUnidades(it, c, 1);

    tr.querySelector('[data-act="rem"]').onclick = () =>
      registrarSalidaUnidades(it, c);

    tr.querySelector('[data-act="inc"]').onclick = () =>
      abrirEntradaDesdeFilaBodega(it, c, 1);

    tr.querySelector('[data-act="add"]').onclick = () =>
      abrirEntradaDesdeFilaBodega(it, c);

    if (esCajaReal) {
      tr.querySelector('[data-act="editBox"]').onclick = () =>
        editarCajaBodega(it, c);

      tr.querySelector('[data-act="del"]').onclick = async () => {
        await deleteCajaSeguro(c.id);
        await openCajasModal(it, true);
      };
    }

    tb.appendChild(tr);
  }
}

async function applyDeltaToItemCaja({
  bodegaId,
  itemId,
  cajaId,
  delta,
  nota,
  variante = null,
  motivo = '',
  destino = ''
}) {
  if (!Number.isSafeInteger(delta) || delta === 0) {
    throw new Error('La cantidad del movimiento debe ser un entero distinto de cero.');
  }

  const idCaja = cajaId || '_SIN_CAJA_';
  const claveVariante = U(variante) || null;
  const refItem = itemDoc(bodegaId, itemId);
  const refStock = stockDoc(bodegaId, itemId, idCaja);
  const refCaja = idCaja === '_SIN_CAJA_' ? null : cajaDoc(bodegaId, idCaja);
  const refMovimientoCaja = doc(movsCol(bodegaId, itemId, idCaja));
  const refMovimientoBodega = doc(movsBodegaCol(bodegaId));
  const usuario = state.user?.email || null;

  await runTransaction(db, async tx => {
    const [itemSnap, stockSnap, cajaSnap] = await Promise.all([
      tx.get(refItem),
      tx.get(refStock),
      refCaja ? tx.get(refCaja) : Promise.resolve(null)
    ]);

    if (!itemSnap.exists()) throw new Error('Este ítem ya no está disponible.');
    if (refCaja && !cajaSnap.exists()) {
      throw new Error('Esta caja ya no existe. Actualiza el inventario.');
    }

    const item = itemSnap.data();
    const stock = stockSnap.data() || {};
    const caja = cajaSnap?.data();
    const unidadesCaja = safeNum(stock.unidades, 0);
    const variantes = { ...(stock.variantes || {}) };
    const unidadesConVariante = sumVariants(variantes);
    const saldoCaja = unidadesCaja + delta;
    const saldoItem = safeNum(item.unidadesTotal, 0) + delta;

    if (saldoCaja < 0) throw new Error('NEG');
    if (saldoItem < 0) throw new Error('NEG_TOTAL');

    if (unidadesCaja > 0 && claveVariante && unidadesConVariante === 0) {
      throw new Error('Esta caja tiene stock general para este ítem. Selecciona Sin talla o usa otra caja.');
    }

    if (!claveVariante && unidadesConVariante > 0) {
      throw new Error('Esta caja tiene stock por talla. Selecciona una variante.');
    }

    const cambiosStock = {
      cajaId: idCaja,
      unidades: saldoCaja,
      actualizadoEn: serverTimestamp()
    };

    const cambiosItem = {
      unidadesTotal: saldoItem,
      actualizadoEn: serverTimestamp()
    };

    if (claveVariante) {
      const saldoVarianteCaja = safeNum(variantes[claveVariante], 0) + delta;
      if (saldoVarianteCaja < 0) throw new Error('NEG');

      const variantesTotal = { ...(item.variantesTotal || {}) };
      const saldoVarianteItem = safeNum(variantesTotal[claveVariante], 0) + delta;
      if (saldoVarianteItem < 0) throw new Error('NEG_ITEM_VAR');

      variantes[claveVariante] = saldoVarianteCaja;
      variantesTotal[claveVariante] = saldoVarianteItem;

      cambiosStock.variantes = variantes;
      cambiosItem.variantesTotal = variantesTotal;
    }

    tx.set(refStock, cambiosStock, { merge: true });
    tx.update(refItem, cambiosItem);

    const movimiento = {
      ts: serverTimestamp(),
      delta,
      stock: saldoCaja,
      by: usuario,
      nota: nota || '',
      variante: claveVariante,
      motivo,
      destino
    };

    tx.set(refMovimientoCaja, movimiento);
    tx.set(refMovimientoBodega, {
      ...movimiento,
      itemId,
      itemNombre: item.nombre || '(sin nombre)',
      cajaId: idCaja,
      cajaNombre: caja?.nombre || (refCaja ? '(caja)' : '(sin caja)'),
      cajaUbic: normalizeUbic(caja?.ubicacion || '')
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

/* =========================================================
   EXPORT INVENTARIO (CARDS)
   - Exporta SOLO lo que se ve según buscador + filtro stock
   - Incluye: nombre, desc, ubicaciones, variantes, min, total, estado
   Requiere: XLSX global
   ========================================================= */

function getItemsFiltradosActuales(){
  const q = $('txtSearch').value.trim().toLowerCase();
  const f = $('selFiltroStock').value;

  let items = [...state.items];

  // mismo criterio que renderItems()
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

  return items;
}

function estadoStock(it){
  const total = safeNum(it.unidadesTotal,0);
  const minimo = safeNum(it.minimo,3);
  if(total === 0) return 'STOCK 0';
  if(total <= minimo) return 'BAJO';
  return 'OK';
}

function exportarInventarioExcelFiltrado(){
  if(typeof XLSX === 'undefined'){
    throw new Error('XLSX no está cargado (falta script CDN).');
  }

  const items = getItemsFiltradosActuales();

  // Encabezados
  const rows = [];
  rows.push([
    'BodegaId',
    'ItemId',
    'Nombre',
    'Descripción',
    'Ubicación(es)',
    'Variantes (resumen)',
    'Mínimo',
    'Stock Total',
    'Estado'
  ]);

  for(const it of items){
    rows.push([
      state.bodegaId || '',
      it.id || '',
      it.nombre || '',
      it.descripcion || '',
      it._ubicLine || '',         // ya viene normalizado (Z1->HUECHURABA)
      it._variantsLine || '',     // "L:50 · M:40 ..."
      safeNum(it.minimo,3),
      safeNum(it.unidadesTotal,0),
      estadoStock(it)
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(rows);

  // ancho columnas
  ws['!cols'] = [
    { wch: 18 }, // BodegaId
    { wch: 18 }, // ItemId
    { wch: 30 }, // Nombre
    { wch: 40 }, // Desc
    { wch: 20 }, // Ubic
    { wch: 28 }, // Variantes
    { wch: 10 }, // Min
    { wch: 12 }, // Total
    { wch: 10 }  // Estado
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Inventario');

  const d = new Date();
  const pad = (n)=> String(n).padStart(2,'0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;

  // Nombre incluye filtro actual (opcional)
  const filtro = $('selFiltroStock')?.value || 'all';
  const fname = `Inventario_${state.bodegaId}_${filtro}_${stamp}.xlsx`;

  XLSX.writeFile(wb, fname);
}


/* =========================================================
   EXPORTAR MOVIMIENTOS A EXCEL (TODOS)
   - Fuente: bodegas/{bodegaId}/movimientos (colección rápida)
   - Orden: ts desc
   - Descarga: .xlsx
   Requiere: XLSX global (cdn xlsx.full.min.js)
   ========================================================= */

function toIsoLocal(ts){
  try{
    const d = ts?.toDate ? ts.toDate() : (ts instanceof Date ? ts : null);
    if(!d) return '';
    // ISO sin milisegundos, en hora local
    const pad = (n)=> String(n).padStart(2,'0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }catch(e){
    return '';
  }
}

async function exportarMovimientosExcel({ bodegaId, pageSize=800 } = {}){
  if(typeof XLSX === 'undefined'){
    throw new Error('XLSX no está cargado (falta script CDN).');
  }

  const rows = [];

  // header “humano” (ordenado y claro)
  // Puedes agregar columnas si quieres: tipo, refId, antes/despues…
  rows.push([
    'Fecha',
    'Ítem',
    'Caja',
    'Ubicación',
    'Δ',
    'Stock',
    'Usuario',
    'Nota',
    'Tipo'
  ]);

  // Paginación para traer TODO (sin reventar memoria de una sola)
  let last = null;
  let total = 0;
  let page = 0;

  while(true){
    page++;

    const parts = [ orderBy('ts','desc'), limit(pageSize) ];
    if(last) parts.splice(1, 0, startAfter(last));

    const snap = await getDocs(query(movsBodegaCol(bodegaId), ...parts));
    if(snap.empty) break;

    last = snap.docs[snap.docs.length - 1];

    for(const d of snap.docs){
      const x = d.data() || {};
      const fecha = toIsoLocal(x.ts);
      const item  = x.itemNombre || '';
      const caja  = x.cajaNombre || '';
      const ubic  = displayUbic(x.cajaUbic || '');
      const delta = safeNum(x.delta, 0);
      const stock = safeNum(x.stock, 0);
      const by    = x.by || '';
      const nota  = x.nota || '';
      const tipo  = x.tipo || 'MOV'; // si no existe, queda MOV

      rows.push([fecha, item, caja, ubic, delta, stock, by, nota, tipo]);
      total++;
    }

    // feedback liviano
    setEstado(`Exportando... (${total} filas)`);
  }

  // Armar workbook
  const ws = XLSX.utils.aoa_to_sheet(rows);

  // ancho columnas (opcional, mejora lectura)
  ws['!cols'] = [
    { wch: 20 }, // Fecha
    { wch: 28 }, // Ítem
    { wch: 16 }, // Caja
    { wch: 14 }, // Ubicación
    { wch: 8  }, // Δ
    { wch: 10 }, // Stock
    { wch: 22 }, // Usuario
    { wch: 40 }, // Nota
    { wch: 14 }  // Tipo
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Movimientos');

  const stamp = new Date();
  const pad = (n)=> String(n).padStart(2,'0');
  const fname = `Movimientos_${bodegaId}_${stamp.getFullYear()}-${pad(stamp.getMonth()+1)}-${pad(stamp.getDate())}_${pad(stamp.getHours())}${pad(stamp.getMinutes())}.xlsx`;

  XLSX.writeFile(wb, fname);
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
// Stock de guías. Catálogo vinculado por ID, cantidades independientes.
const guiaCol = nombre => collection(db, nombre);
const guiaStock = id => doc(guiaCol('bodega_guia_stock'), id);
const guiaEntregas = guiaCol('bodega_guia_entregas');
const guiaFirmas = guiaCol('bodega_guia_firmas');
const guiaMov = guiaCol('bodega_guia_movimientos');
const guiaFecha = valor => {
  const d = valor?.toDate?.() || (valor ? new Date(valor) : null);
  if (!d || !Number.isFinite(+d)) return '';
  return typeof valor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(valor)
    ? valor : new Intl.DateTimeFormat('sv-SE', {timeZone:'America/Santiago'}).format(d);
};
const guiaNorm = valor => String(valor || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().trim();
const guiaTexto = (tag, texto) => Object.assign(document.createElement(tag), {textContent:texto});
const guiaBoton = (titulo, fn) => {
  const b = guiaTexto('button', titulo);
  b.type = 'button';
  b.className = 'btn small';
  b.onclick = async () => {
    if (b.disabled) return;
    b.disabled = true;
    try { await fn(); }
    catch (e) { $('guiaEstado').textContent = e.message; }
    finally { b.disabled = false; }
  };
  return b;
};

async function guiaActualizar() {
  const [stock, entregas] = await Promise.all([getDocs(guiaCol('bodega_guia_stock')), getDocs(guiaEntregas)]);
  const panel = $('guiaLista');
  panel.replaceChildren();
  const inventario = guiaTexto('details', '');
  inventario.append(guiaTexto('summary', 'Disponible para entregar'));
  for (const d of stock.docs) {
    const s = d.data();
    inventario.append(guiaTexto('div', `${s.nombre} · ${s.talla || 'Sin talla'} · ${s.unidades}`));
  }
  panel.append(inventario);
  const hoy = guiaFecha(new Date());
  const orden = entregas.docs.sort((a,b) => (b.data().creado?.seconds || 0) - (a.data().creado?.seconds || 0));
  for (const d of orden) {
    const e = d.data();
    const pendientes = e.estado === 'entregada' ? e.lineas.filter(l => !l.cortesia && l.devuelto < l.cantidad) : [];
    const monto = pendientes.reduce((s,l) => s + (l.cantidad-l.devuelto)*l.valor, 0);
    const fila = guiaTexto('div', '');
    fila.className = 'card';
    fila.style.marginTop = '10px';
    fila.append(guiaTexto('strong', e.coordinador), guiaTexto('div',
      e.estado === 'preparada' ? 'Preparada' : pendientes.length
        ? `${e.plazo < hoy ? 'Vencida' : 'Pendiente'} · ${e.plazo} · CLP ${monto.toLocaleString('es-CL')}`
        : 'Cerrada'));
    fila.append(guiaTexto('div', e.viajes.map(v=>v.nombre).join(' · ')));
    const detalle = guiaTexto('details', '');
    detalle.append(guiaTexto('summary', 'Ver artículos y devoluciones'));
    for (const l of e.lineas) {
      const saldo = e.estado === 'preparada' ? 'Por entregar' : l.cortesia
        ? 'Cortesía' : `${l.devuelto} devueltas · ${l.cantidad - l.devuelto} pendientes`;
      detalle.append(guiaTexto('div', `${l.nombre} · ${l.talla || 'Sin talla'} · ${l.cantidad} un. · ${saldo}`));
    }
    fila.append(detalle);
    fila.append(
      guiaBoton('Anexo / imprimir', async () => {
        const firma = await guiaLeerFirma(e);
        guiaImprimir(d.id, e, firma);
      }),
      guiaBoton('Copiar enlace de firma', async () => {
        if (!e.firmaId) throw new Error('Este anexo usa respaldo en papel.');
        const url = new URL(location.href);
        url.hash = 'firmar-guia=' + e.firmaId;
        await navigator.clipboard.writeText(url.href);
        $('guiaEstado').textContent = 'Enlace copiado.';
      }),
      guiaBoton('Adjuntar anexo firmado', () => guiaAdjuntar(d.ref))
    );
    if (e.estado === 'preparada') fila.append(guiaBoton('Confirmar entrega física', async () => {
      if (confirm(`¿Confirmar la entrega física a ${e.coordinador}?`)) await guiaMover(d.ref);
    }));
    if (pendientes.length) fila.append(guiaBoton('Registrar devolución', () => guiaDevolver(d.ref, e)));
    panel.append(fila);
  }
  $('guiaEstado').textContent = `${entregas.size} entregas registradas.`;
}

async function guiaIngresar() {
  const bodegaId = state.bodegaId;
  const catalogo = state.items.slice();
  abrirAccionBodega({
    titulo:'Ingresar stock de guías',
    campos:[
      {nombre:'item', etiqueta:'Producto del catálogo', opciones:[['','Selecciona'],...catalogo.map(i=>[i.id,i.nombre])], requerido:true},
      {nombre:'talla', etiqueta:'Talla', opciones:[['','Sin talla'],...BODEGA_TALLAS.map(t=>[t,t]),['__OTRA__','Otra variante']]},
      {nombre:'otra', etiqueta:'Variante', dependeDe:'talla', mostrarCon:'__OTRA__', requerido:true},
      {nombre:'cantidad', etiqueta:'Unidades', tipo:'number', min:1, requerido:true}
    ],
    guardar:async datos => {
      const item = catalogo.find(i=>i.id===datos.item);
      const talla = U(datos.talla==='__OTRA__' ? datos.otra : datos.talla);
      const cantidad = Number(datos.cantidad);
      if (!item || !Number.isSafeInteger(cantidad) || cantidad<1 || (datos.talla==='__OTRA__' && !talla)) {
        throw new Error('Revisa producto, cantidad y variante.');
      }
      const id = encodeURIComponent(JSON.stringify([bodegaId,item.id,talla]));
      const ref = guiaStock(id);
      await runTransaction(db, async tx => {
        const anterior = (await tx.get(ref)).data()?.unidades ?? 0;
        tx.set(ref,{nombre:item.nombre,talla,unidades:anterior+cantidad,bodegaId,itemId:item.id});
        tx.set(doc(guiaMov),{tipo:'ingreso',stockId:id,cantidad,fecha:serverTimestamp(),por:state.user.uid});
      });
      return 'Stock de guías ingresado.';
    },
    refrescar:guiaActualizar
  });
}

async function guiaDatosViajes(ano) {
  const [personas, texto, numero, conjuntos] = await Promise.all([
    getDocs(guiaCol('coordinadores')),
    getDocs(query(guiaCol('grupos'),where('anoViaje','==',String(ano)))),
    getDocs(query(guiaCol('grupos'),where('anoViaje','==',ano))),
    getDocs(collectionGroup(db,'conjuntos'))
  ]);
  const asignados = new Map();
  for (const d of conjuntos.docs) {
    const padre = d.ref.parent.parent;
    if (padre?.parent.id !== 'coordinadores') continue;
    const s = d.data();
    if (s.anoViaje && Number(s.anoViaje) !== ano) continue;
    for (const gid of Array.isArray(s.viajes) ? s.viajes : []) {
      const clave = String(gid);
      if (!asignados.has(clave)) asignados.set(clave,[]);
      asignados.get(clave).push(padre.id);
    }
  }
  const viajes = [...new Map([...texto.docs,...numero.docs].map(d=>[d.id,d])).values()].map(d=>{
    const g = d.data();
    return {id:d.id,nombre:String(g.aliasGrupo || [g.colegio,g.curso].filter(Boolean).join(' ') || d.id),
      destino:String(g.destino || g.destinoPrincipal || ''), inicio:guiaFecha(g.fechaInicio), fin:guiaFecha(g.fechaFin),
      coords:[...(Array.isArray(g.coordinadorIds)?g.coordinadorIds:[g.coordinadorId]),...(asignados.get(d.id)||[])].map(String)};
  });
  return {personas:personas.docs,viajes};
}

async function guiaNuevaEntrega() {
  const hoy = guiaFecha(new Date());
  const anoActual = Number(hoy.slice(0,4)) - (Number(hoy.slice(5,7))<3 ? 1 : 0);
  const entrada = prompt('Año operativo de los viajes', String(anoActual));
  if (entrada === null) return;
  const ano = Number(entrada);
  if (!Number.isInteger(ano) || ano<2000 || ano>2100) throw new Error('Año inválido.');
  const [{personas,viajes}, inventario] = await Promise.all([
    guiaDatosViajes(ano),getDocs(guiaCol('bodega_guia_stock'))
  ]);
  const stock = inventario.docs.map(d=>({id:d.id,...d.data()})).filter(s=>s.unidades>0);
  const campos = [{nombre:'coord',etiqueta:'Coordinador',requerido:true,
    opciones:[['','Selecciona'],...personas.filter(p=>viajes.some(v=>v.coords.includes(p.id)))
      .sort((a,b)=>String(a.data().nombre).localeCompare(String(b.data().nombre),'es'))
      .map(p=>[p.id,p.data().nombre || p.id])]}];
  abrirAccionBodega({
    titulo:'Preparar anexo de entrega',
    contexto:'Selecciona los viajes y agrega las líneas de una sola entrega.',
    campos,
    guardar:async datos => {
      const persona = personas.find(p=>p.id===datos.coord);
      const seleccion = viajes.filter(v=>v.coords.includes(datos.coord) && controlesViajes.get(v.id)?.checked);
      if (!persona || !seleccion.length || seleccion.some(v=>!v.fin)) throw new Error('Selecciona viajes con fecha de término.');
      const lineas = [...contenedorLineas.children].map(f=>{
        const s = stock.find(s=>s.id===f.querySelector('select').value);
        const [cantidad, valor, cortesia] = f.querySelectorAll('input');
        const n = cantidad.valueAsNumber;
        const precio = valor.valueAsNumber;
        if (!s || !Number.isSafeInteger(n) || n<1 || !Number.isSafeInteger(precio) || precio<0 || (!cortesia.checked && precio===0)) {
          throw new Error('Completa producto, cantidad y valor de reposición. Solo la cortesía admite valor cero.');
        }
        return {stockId:s.id,nombre:s.nombre,talla:s.talla,cantidad:n,valor:precio,cortesia:cortesia.checked,devuelto:0};
      });
      if (!lineas.length || lineas.length>20) throw new Error('Agrega entre 1 y 20 líneas.');
      const resumenViajes = seleccion.map(({id,nombre,destino,inicio,fin})=>({id,nombre,destino,inicio,fin}));
      const plazo = resumenViajes.map(v=>v.fin).sort().at(-1);
      const entrega = doc(guiaEntregas);
      const firma = activarFirma.checked ? doc(guiaFirmas,crypto.randomUUID().replaceAll('-','')) : null;
      const anexo = {folio:entrega.id,coordinador:persona.data().nombre || persona.id,viajes:resumenViajes,plazo,lineas};
      await runTransaction(db, async tx => {
        if (firma) tx.set(firma,{...anexo,firma:'',vence:new Date(Date.now()+7*86400000)});
        tx.set(entrega,{...anexo,coordinadorId:persona.id,firmaId:firma?.id || '',estado:'preparada',creado:serverTimestamp(),por:state.user.uid});
      });
      return 'Anexo preparado. Confirma la entrega física cuando corresponda.';
    },
    refrescar:guiaActualizar
  });
  const raiz = $('bdAccionCampos');
  const controlesViajes = new Map();
  const listaViajes = guiaTexto('div','');
  const sugerencia = guiaTexto('p','');
  const contenedorLineas = guiaTexto('div','');
  const activarFirma = document.createElement('input');
  activarFirma.type = 'checkbox';
  activarFirma.style.width = 'auto';
  const etiquetaFirma = guiaTexto('label',' Habilitar enlace de firma por 7 días');
  etiquetaFirma.prepend(activarFirma);

  function sugerir() {
    const elegidos = viajes.filter(v=>controlesViajes.get(v.id)?.checked);
    const polar = elegidos.some(v=>['BARILOCHE','SUR DE CHILE','SUR DE CHILE Y BARILOCHE'].includes(guiaNorm(v.destino)));
    sugerencia.textContent = elegidos.length
      ? 'Kit sugerido: 6 poleras guía amarillas, 2 blusas amarillas, 1 cortaviento amarillo' +
        (polar ? ' y 1 polar amarillo.' : '.') + ' Agrega el equipo efectivamente entregado.'
      : 'Selecciona los viajes que cubre el equipo.';
  }

  raiz.querySelector('select').onchange = ev => {
    listaViajes.replaceChildren();
    controlesViajes.clear();
    for (const v of viajes.filter(v=>v.coords.includes(ev.target.value))) {
      const c = document.createElement('input');
      c.type = 'checkbox';
      c.style.width = 'auto';
      c.onchange = sugerir;
      controlesViajes.set(v.id,c);
      const etiqueta = guiaTexto('label', ` ${v.nombre} · ${v.destino} · ${v.inicio} a ${v.fin}`);
      etiqueta.style.display = 'block';
      etiqueta.prepend(c);
      listaViajes.append(etiqueta);
    }
    sugerir();
  };
  const agregar = () => {
    const f = guiaTexto('div','');
    f.className = 'card';
    f.style.marginTop = '8px';
    const select = document.createElement('select');
    select.required = true;
    select.setAttribute('aria-label','Producto y talla');
    select.add(new Option('Selecciona producto y talla',''));
    stock.forEach(s=>select.add(new Option(`${s.nombre} · ${s.talla || 'Sin talla'} (${s.unidades} disponibles)`,s.id)));
    f.append(select);
    for (const [nombre,min,valor] of [['Cantidad',1,1],['Valor unitario CLP',0,'']]) {
      const label = guiaTexto('label',nombre);
      const input = document.createElement('input');
      Object.assign(input,{type:'number',step:'1',min:String(min),value:String(valor),required:true});
      label.append(input);
      f.append(label);
    }
    const cortesia = document.createElement('input');
    cortesia.type = 'checkbox';
    cortesia.style.width = 'auto';
    const label = guiaTexto('label',' Cortesía · sin devolución');
    label.prepend(cortesia);
    f.append(label,guiaBoton('Quitar línea',()=>f.remove()));
    contenedorLineas.append(f);
  };
  raiz.append(listaViajes,sugerencia,contenedorLineas,guiaBoton('Agregar artículo',agregar),etiquetaFirma);
  sugerir();
  agregar();
}

async function guiaMover(ref, devoluciones = null) {
  const movimiento = doc(guiaMov);
  const uid = state.user.uid;
  await runTransaction(db, async tx => {
    const e = (await tx.get(ref)).data();
    if (!e || e.estado !== (devoluciones ? 'entregada' : 'preparada')) throw new Error('La entrega cambió. Actualiza el módulo.');
    const cambios = new Map();
    const lineas = e.lineas.map((l,i)=>{
      const cantidad = devoluciones ? (devoluciones[i] ?? 0) : -l.cantidad;
      if (devoluciones && (!Number.isSafeInteger(cantidad) || cantidad<0 || cantidad>l.cantidad-l.devuelto || (l.cortesia && cantidad))) {
        throw new Error('Una devolución supera lo pendiente.');
      }
      if (cantidad) cambios.set(l.stockId,(cambios.get(l.stockId)||0)+cantidad);
      return {...l,devuelto:l.devuelto+(devoluciones ? cantidad : 0)};
    });
    if (!cambios.size) throw new Error('Ingresa al menos una unidad.');
    const saldos = await Promise.all([...cambios].map(async ([id,delta])=>{
      const s = await tx.get(guiaStock(id));
      const unidades = s.data()?.unidades + delta;
      if (!s.exists() || !Number.isSafeInteger(unidades) || unidades<0) {
        throw new Error(`Stock insuficiente para ${s.data()?.nombre || id}.`);
      }
      return {ref:s.ref,unidades};
    }));
    for (const s of saldos) tx.update(s.ref,{unidades:s.unidades});
    tx.update(ref,devoluciones ? {lineas} : {estado:'entregada',fechaEntrega:serverTimestamp()});
    tx.set(movimiento,{tipo:devoluciones?'devolucion':'entrega',entregaId:ref.id,
      lineas:[...cambios].map(([stockId,cantidad])=>({stockId,cantidad})),fecha:serverTimestamp(),por:uid});
  });
  try { await guiaActualizar(); }
  catch (error) { $('guiaEstado').textContent = 'Movimiento guardado. Actualiza el módulo para ver el saldo.'; }
  if (!devoluciones) toast('Entrega registrada.');
}

function guiaDevolver(ref,e) {
  abrirAccionBodega({
    titulo:'Registrar devolución', contexto:e.coordinador,
    campos:e.lineas.flatMap((l,i)=> l.cortesia || l.devuelto>=l.cantidad ? [] : [{
      nombre:String(i),etiqueta:`${l.nombre} · ${l.talla || 'Sin talla'} · ${l.cantidad-l.devuelto} pendientes`,
      tipo:'number',min:0,max:l.cantidad-l.devuelto,valor:0,requerido:true
    }]),
    guardar:async datos=>{
      await guiaMover(ref,Object.fromEntries(Object.entries(datos).map(([i,n])=>[i,Number(n)])));
      return 'Devolución registrada.';
    }
  });
}

function guiaAdjuntar(ref) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/jpeg,image/png,application/pdf';
  input.onchange = async () => {
    const archivo = input.files[0];
    if (!archivo || !['image/jpeg','image/png','application/pdf'].includes(archivo.type) || archivo.size>10*1024*1024) {
      $('guiaEstado').textContent = 'Selecciona JPG, PNG o PDF de hasta 10 MB.';
      return;
    }
    try {
      const ruta = `bodega_guia_anexos/${ref.id}/${crypto.randomUUID()}`;
      const tarea = uploadBytesResumable(sRef(storage,ruta),archivo);
      await new Promise((ok,fail)=>tarea.on('state_changed',null,fail,ok));
      await updateDoc(ref,{respaldoRuta:ruta,respaldoFecha:serverTimestamp(),respaldoPor:state.user.uid});
      try { await guiaActualizar(); }
      catch (error) { console.error('[GUÍAS] Recargar anexo',error); }
      $('guiaEstado').textContent = 'Anexo firmado adjuntado.';
    } catch (e) { $('guiaEstado').textContent = e.message; }
  };
  input.click();
}

async function guiaLeerFirma(e) {
  if (e.respaldoRuta) {
    const archivo = await getBlob(sRef(storage,e.respaldoRuta),10*1024*1024);
    return {respaldo:URL.createObjectURL(archivo)};
  }
  if (!e.firmaId) return {};
  const s = await getDoc(doc(guiaFirmas,e.firmaId));
  return s.data() || {};
}

function guiaAnexo(e,folio) {
  const nodo = guiaTexto('article','');
  nodo.append(guiaTexto('h1','Anexo de entrega de equipamiento'),
    guiaTexto('p',`Folio ${folio} · Coordinador: ${e.coordinador}`),
    guiaTexto('p',`Devolución prevista: ${e.plazo}`));
  for (const v of e.viajes) nodo.append(guiaTexto('div',`${v.nombre} · ${v.destino} · ${v.inicio} a ${v.fin}`));
  const tabla = document.createElement('table');
  const cabecera = tabla.createTHead().insertRow();
  for (const valor of ['Artículo','Talla','Cantidad','Valor unitario CLP','Devolución']) cabecera.append(guiaTexto('th',valor));
  const cuerpo = tabla.createTBody();
  for (const l of e.lineas) {
    const fila = cuerpo.insertRow();
    for (const valor of [l.nombre,l.talla || '—',l.cantidad,l.valor,l.cortesia?'Cortesía':'Sí']) fila.insertCell().textContent=valor;
  }
  nodo.append(tabla,guiaTexto('p','Los artículos marcados para devolución deben entregarse al término del último viaje indicado. Los artículos de cortesía quedan con el coordinador.'));
  return nodo;
}

function guiaImprimir(id,e,firma) {
  const modal = $('guiaImpresion');
  modal.replaceChildren(guiaAnexo(e,id));
  modal.onclose = () => {
    if (firma.respaldo) URL.revokeObjectURL(firma.respaldo);
  };
  if (firma.respaldo) {
    const enlace = guiaTexto('a','Abrir anexo firmado en papel');
    enlace.href = firma.respaldo;
    enlace.target = '_blank';
    enlace.rel = 'noopener noreferrer';
    modal.append(enlace);
  }
  if (/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(firma.firma || '')) {
    const img = new Image();
    img.alt = 'Firma del coordinador';
    img.width = 320;
    img.src = firma.firma;
    modal.append(img,guiaTexto('p',`Firma registrada: ${firma.firmadoEn?.toDate?.().toLocaleString('es-CL') || ''}`));
  } else modal.append(guiaTexto('p','Firma del coordinador: _________________________'));
  modal.append(guiaBoton('Imprimir / Guardar como PDF',()=>window.print()),guiaBoton('Cerrar',()=>modal.close()));
  modal.showModal();
}

async function guiaAbrirFirma(token) {
  document.body.replaceChildren();
  const panel = guiaTexto('main','');
  panel.className = 'wrap';
  document.body.append(panel);
  try {
    const ref = doc(guiaFirmas,token);
    const e = (await getDoc(ref)).data();
    if (!e) throw new Error('Enlace inválido o vencido.');
    panel.append(guiaAnexo(e,e.folio));
    if (e.firma) {
      panel.append(guiaTexto('p','La firma ya fue registrada.'));
      return;
    }
    const lienzo = document.createElement('canvas');
    lienzo.width = 640;
    lienzo.height = 220;
    lienzo.style.cssText = 'width:100%;max-width:640px;border:1px solid;touch-action:none;background:white';
    const ctx = lienzo.getContext('2d');
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    let trazo = false;
    let puntero = null;
    const punto = ev=>{
      const r=lienzo.getBoundingClientRect();
      return [(ev.clientX-r.left)*lienzo.width/r.width,(ev.clientY-r.top)*lienzo.height/r.height];
    };
    lienzo.onpointerdown=ev=>{
      if (puntero!==null) return;
      puntero=ev.pointerId;
      lienzo.setPointerCapture(puntero);
      ctx.beginPath();
      ctx.moveTo(...punto(ev));
    };
    lienzo.onpointermove=ev=>{
      if (ev.pointerId!==puntero) return;
      ctx.lineTo(...punto(ev));
      ctx.stroke();
      trazo=true;
    };
    lienzo.onpointerup=lienzo.onpointercancel=()=>{puntero=null;};
    const confirma=document.createElement('input');
    confirma.type='checkbox';
    confirma.style.width='auto';
    const etiqueta=guiaTexto('label',' He revisado el anexo y confirmo mi firma.');
    etiqueta.prepend(confirma);
    const estado=guiaTexto('p','');
    estado.setAttribute('role','status');
    const firmar=guiaBoton('Guardar firma',async()=>{
      if (!trazo || !confirma.checked) {estado.textContent='Dibuja tu firma y marca la confirmación.';return;}
      try {
        await updateDoc(ref,{firma:lienzo.toDataURL('image/png'),firmadoEn:serverTimestamp()});
        panel.replaceChildren(guiaTexto('h1','Firma registrada'),guiaTexto('p',`Folio ${e.folio}`));
      } catch (error) {estado.textContent='No se pudo guardar. El enlace puede estar vencido o ya utilizado.';}
    });
    panel.append(guiaTexto('p','Firma aquí con tu dedo.'),lienzo,etiqueta,
      guiaBoton('Limpiar firma',()=>{ctx.clearRect(0,0,lienzo.width,lienzo.height);trazo=false;}),firmar,estado);
  } catch (e) { panel.append(guiaTexto('p','Enlace inválido, vencido o inaccesible.')); }
}

const guiaToken = location.hash.match(/^#firmar-guia=([a-f0-9]{32})$/)?.[1];
if (guiaToken) {
  void guiaAbrirFirma(guiaToken);
} else {
  $('guiaCargar').onclick = () => guiaActualizar().catch(e => {$('guiaEstado').textContent=e.message;});
  $('guiaEntrada').onclick = () => guiaIngresar().catch(e => {$('guiaEstado').textContent=e.message;});
  $('guiaNueva').onclick = () => guiaNuevaEntrega().catch(e => {$('guiaEstado').textContent=e.message;});
}
