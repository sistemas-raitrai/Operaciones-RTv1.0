// turnos-comidas.js
// Asignador de turnos de comida (almuerzo / cena) para Bariloche.

import { app, db } from './firebase-init.js';
import {
  collection,
  getDocs
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

// =========================
// Estado en memoria
// =========================
const state = {
  fechaISO: null,
  grupos: [],         // [{id, numeroNegocio, nombreGrupo, pax, coordinador, comeAlmuerzo, comeCena}]
  config: {
    maxPax: 96,
    horas: {
      almuerzo: ['12:30', '13:30', '14:30', ''], // 4º opcional
      cena:     ['19:30', '20:30', '21:30', '']  // 4º opcional
    }
  },
  asignacion: {
    almuerzo: { 1: [], 2: [], 3: [], 4: [] },  // ids de grupos
    cena:     { 1: [], 2: [], 3: [], 4: [] }
  }
};

// =========================
// Utilidades básicas
// =========================
function normDateISO(d = new Date()){
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

// Devuelve la fecha de MAÑANA en ISO (día calendario siguiente)
function tomorrowISO() {
  const d = new Date();
  d.setHours(0,0,0,0);
  d.setDate(d.getDate() + 1);
  return normDateISO(d);
}

function getGrupoById(id){
  return state.grupos.find(g => g.id === id) || null;
}

function sumPax(ids){
  return ids.reduce((acc,id)=>{
    const g = getGrupoById(id);
    return acc + (g ? g.pax : 0);
  },0);
}

// Número de turnos activos (según horas NO vacías)
function getNumTurnos(tipo){
  const horas = tipo === 'almuerzo'
    ? state.config.horas.almuerzo
    : state.config.horas.cena;
  return horas.filter(h => h && h.trim()).length;
}

function normTxt(s=''){
  return String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'')
    .toUpperCase();
}

// =========================
// Modal Itinerario
// =========================
function abrirModalItin(){
  const mb = document.getElementById('modal-itin-backdrop');
  const m  = document.getElementById('modal-itin');
  if(mb) mb.style.display = 'block';
  if(m)  m.style.display  = 'block';
  document.body.classList.add('modal-open');
}

function cerrarModalItin(){
  const mb = document.getElementById('modal-itin-backdrop');
  const m  = document.getElementById('modal-itin');
  if(mb) mb.style.display = 'none';
  if(m)  m.style.display  = 'none';
  document.body.classList.remove('modal-open');
}

function initModalItinListeners(){
  const btnClose = document.getElementById('modal-itin-close');
  const mb = document.getElementById('modal-itin-backdrop');
  if(btnClose) btnClose.addEventListener('click', cerrarModalItin);
  if(mb) mb.addEventListener('click', cerrarModalItin);
}

function safeHora(h) {
  if (!h) return '';
  const [H,M] = String(h).split(':');
  return `${String(H).padStart(2,'0')}:${String(M || '0').padStart(2,'0')}`;
}

/**
 * Lee el itinerario de un grupo para la fecha seleccionada
 * y lo muestra en el modal.
 */
async function verItinerarioGrupo(gid, nombreGrupo){
  const fechaISO = state.fechaISO || (document.getElementById('fechaTurno')?.value) || '';
  if(!gid || !fechaISO) return;

  const titleEl = document.getElementById('modal-itin-title');
  const fechaEl = document.getElementById('modal-itin-fecha');
  const listEl  = document.getElementById('modal-itin-list');

  if(titleEl) titleEl.textContent = `Itinerario · ${nombreGrupo || ''}`;
  if(fechaEl) fechaEl.textContent = `Fecha: ${fechaISO}`;
  if(listEl)  listEl.innerHTML = '<li class="muted">Cargando…</li>';

  abrirModalItin();

  try{
    const itinRef = collection(db, 'grupos', gid, 'itinerario');
    const snap = await getDocs(itinRef);

    const items = [];
    snap.forEach(docSnap => {
      const d = docSnap.data() || {};
      const f = d.fecha || d.fechaISO || d.diaISO || null;
      if(f !== fechaISO) return; // solo ese día

      const hora = safeHora(d.horaInicio || d.hora || d.desde);
      const act  = d.actividad || d.nombre || d.titulo || '(sin actividad)';
      items.push({ hora, actividad: act });
    });

    items.sort((a,b)=>a.hora.localeCompare(b.hora));

    if(listEl){
      listEl.innerHTML = '';
      if(!items.length){
        const li = document.createElement('li');
        li.textContent = 'No hay actividades registradas para esta fecha.';
        listEl.appendChild(li);
      }else{
        for(const it of items){
          const li = document.createElement('li');
          const spanHora = document.createElement('span');
          spanHora.className = 'hora';
          spanHora.textContent = it.hora || '--:--';
          li.appendChild(spanHora);
          li.appendChild(document.createTextNode(' ' + it.actividad));
          listEl.appendChild(li);
        }
      }
    }
  }catch(err){
    console.error('[TurnosComida] Error leyendo itinerario', gid, err);
    if(listEl){
      listEl.innerHTML = '';
      const li = document.createElement('li');
      li.textContent = 'Error al cargar el itinerario. Revisa la consola.';
      listEl.appendChild(li);
    }
  }
}

// =========================
// Loader REAL desde Firestore
// =========================

// ¿El destino del grupo incluye BARILOCHE?
function incluyeBariloche(destinoRaw = '') {
  return normTxt(destinoRaw).includes('BARILOCHE');
}

// Convierte diferentes formatos de fecha (Timestamp, string ISO, Date) a Date
function toDateSafe(v) {
  if (!v) return null;
  if (typeof v.toDate === 'function') return v.toDate(); // Firestore Timestamp
  if (typeof v === 'string') {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  if (v instanceof Date) return v;
  return null;
}

// ¿La fecha objetivo está dentro del rango [inicio, fin]?
function dentroRangoFechas(targetDate, inicioRaw, finRaw) {
  const ini = toDateSafe(inicioRaw);
  const fin = toDateSafe(finRaw);
  if (!ini || !fin) return false;
  const t  = targetDate.getTime();
  const ti = new Date(ini); ti.setHours(0,0,0,0);
  const tf = new Date(fin); tf.setHours(23,59,59,999);
  return t >= ti.getTime() && t <= tf.getTime();
}

/**
 * Para un grupo y una fecha, mira su itinerario
 * y devuelve {comeAlmuerzo, comeCena}.
 */
async function calcularComidasGrupo(gid, fechaISO){
  const res = { comeAlmuerzo: false, comeCena: false };
  try{
    const itinRef = collection(db, 'grupos', gid, 'itinerario');
    const snap = await getDocs(itinRef);

    snap.forEach(docSnap => {
      const d = docSnap.data() || {};
      const f = d.fecha || d.fechaISO || d.diaISO || null;
      if(f !== fechaISO) return;
      const act = normTxt(d.actividad || d.nombre || d.titulo || '');
      if(act.includes('ALMUERZO HOTEL')) res.comeAlmuerzo = true;
      if(act.includes('CENA HOTEL'))     res.comeCena     = true;
    });
  }catch(err){
    console.warn('[TurnosComida] Error calculando comidas para grupo', gid, err);
  }
  return res;
}

/**
 * Carga grupos que:
 *  - Están en BARILOCHE (por destino)
 *  - Están "en viaje" en la fecha seleccionada (entre fechaInicioViaje y fechaFinViaje)
 *  - Marca comeAlmuerzo / comeCena según itinerario de ese día.
 */
async function cargarGruposDelDia(fechaISO) {
  const fechaObj = new Date(`${fechaISO}T00:00:00`);
  if (isNaN(fechaObj.getTime())) return [];

  const gruposRef = collection(db, 'grupos');
  const snap = await getDocs(gruposRef);

  const resultados = [];

  snap.forEach(docSnap => {
    const data = docSnap.data() || {};

    // 1) Destino debe incluir BARILOCHE
    if (!incluyeBariloche(data.destino || data.destinoBase || '')) return;

    // 2) Rango de fechas
    const ini = data.fechaInicioViaje || data.fechaInicio || data.inicioViaje;
    const fin = data.fechaFinViaje    || data.fechaFin    || data.finViaje;
    if (!dentroRangoFechas(fechaObj, ini, fin)) return;

    const pax = Number(
      data.cantidadGrupo ??
      data.pax ??
      data.paxTotal ??
      0
    );

    const grupo = {
      id: docSnap.id,
      numeroNegocio: data.numeroNegocio || data.numNegocio || data.numero || docSnap.id,
      nombreGrupo:   data.nombreGrupo   || data.grupo      || data.nombre || '(sin nombre)',
      pax,
      coordinador:
        data.coordinadorNombre ||
        data.coordinador ||
        data.coordNombre ||
        data.coordinadorPrincipal ||
        ''
    };

    resultados.push(grupo);
  });

  // Cálculo de comidas según itinerario (uno por grupo)
  for(const g of resultados){
    const flags = await calcularComidasGrupo(g.id, fechaISO);
    g.comeAlmuerzo = flags.comeAlmuerzo;
    g.comeCena     = flags.comeCena;
  }

  return resultados;
}

// =========================
// Render tabla de grupos
// =========================
function renderTablaGrupos(){
  const tbody = document.getElementById('tablaGruposBody');
  if(!tbody) return;
  tbody.innerHTML = '';

  let totalPax = 0;
  for(const g of state.grupos){
    totalPax += g.pax;

    const tr = document.createElement('tr');

    const tdNeg = document.createElement('td');
    tdNeg.textContent = g.numeroNegocio;
    tdNeg.style.fontWeight = '600';
    tdNeg.style.fontSize = '.75rem';

    const tdNombre = document.createElement('td');
    const btnNombre = document.createElement('button');
    btnNombre.type = 'button';
    btnNombre.className = 'link-like btn-grupo-itin';
    btnNombre.textContent = g.nombreGrupo;
    btnNombre.addEventListener('click', () => {
      verItinerarioGrupo(g.id, g.nombreGrupo);
    });
    tdNombre.appendChild(btnNombre);

    const tdPax = document.createElement('td');
    tdPax.textContent = g.pax;
    tdPax.style.textAlign = 'right';

    const tdCoord = document.createElement('td');
    const spanCoord = document.createElement('span');
    spanCoord.className = 'coord-tag';
    spanCoord.innerHTML = `<span class="coord-dot"></span><span>${g.coordinador || '—'}</span>`;
    tdCoord.appendChild(spanCoord);

    const tdAlm = document.createElement('td');
    const selAlm = document.createElement('select');
    selAlm.className = 'select-turno sel-almuerzo';
    selAlm.dataset.gid = g.id;

    let htmlAlm = `<option value="0">—</option>`;
    const nAlm = getNumTurnos('almuerzo');
    for(let i=1;i<=nAlm;i++){
      htmlAlm += `<option value="${i}">T${i}</option>`;
    }
    selAlm.innerHTML = htmlAlm;

    if(g.comeAlmuerzo === false){
      selAlm.disabled = true;
      selAlm.title = 'Este grupo no almuerza en el hotel en esta fecha.';
    }
    tdAlm.appendChild(selAlm);

    const tdCen = document.createElement('td');
    const selCen = document.createElement('select');
    selCen.className = 'select-turno sel-cena';
    selCen.dataset.gid = g.id;

    let htmlCen = `<option value="0">—</option>`;
    const nCen = getNumTurnos('cena');
    for(let i=1;i<=nCen;i++){
      htmlCen += `<option value="${i}">T${i}</option>`;
    }
    selCen.innerHTML = htmlCen;

    if(g.comeCena === false){
      selCen.disabled = true;
      selCen.title = 'Este grupo no cena en el hotel en esta fecha.';
    }
    tdCen.appendChild(selCen);

    tr.appendChild(tdNeg);
    tr.appendChild(tdNombre);
    tr.appendChild(tdPax);
    tr.appendChild(tdCoord);
    tr.appendChild(tdAlm);
    tr.appendChild(tdCen);

    tbody.appendChild(tr);
  }

  const resumen = document.getElementById('resumenGrupos');
  if(resumen){
    resumen.textContent = `${state.grupos.length} grupo(s) · ${totalPax} pax`;
  }

  // Eventos de cambio en select almuerzo/cena
  tbody.querySelectorAll('.sel-almuerzo').forEach(sel=>{
    sel.addEventListener('change', ()=>{
      reconstruirAsignacionDesdeSelects();
      renderTurnos();
      renderTextoWhats();
    });
  });
  tbody.querySelectorAll('.sel-cena').forEach(sel=>{
    sel.addEventListener('change', ()=>{
      reconstruirAsignacionDesdeSelects();
      renderTurnos();
      renderTextoWhats();
    });
  });
}

// =========================
// Asignación automática
// =========================
function resetAsignacionVacia(){
  const nAlm = getNumTurnos('almuerzo');
  const nCen = getNumTurnos('cena');

  state.asignacion = { almuerzo:{}, cena:{} };

  for(let i=1;i<=nAlm;i++){
    state.asignacion.almuerzo[i] = [];
  }
  for(let i=1;i<=nCen;i++){
    state.asignacion.cena[i] = [];
  }
}

/**
 * Algoritmo "greedy balanceado":
 * - Ordena grupos por pax DESC.
 * - Va poniendo cada grupo en el turno con menos pax,
 *   respetando maxPax cuando se pueda.
 */
function sugerirTurnos(tipo){
  const maxPax = state.config.maxPax;
  const asign = state.asignacion[tipo];
  const n = getNumTurnos(tipo);

  // Limpia asignación actual
  for(let i=1;i<=n;i++){
    asign[i] = [];
  }

  if(n === 0) return;

  const gruposOrdenados = [...state.grupos]
    .filter(g => {
      if(tipo === 'almuerzo' && g.comeAlmuerzo === false) return false;
      if(tipo === 'cena'     && g.comeCena     === false) return false;
      return true;
    })
    .sort((a,b)=>b.pax - a.pax);

  for(const g of gruposOrdenados){
    if(!g.pax) continue;

    const opciones = [];
    for(let i=1;i<=n;i++){
      opciones.push({ turno:i, total: sumPax(asign[i]) });
    }
    opciones.sort((a,b)=>a.total - b.total);

    let elegido = null;

    // 1) Intentar turno que NO supere maxPax
    for(const op of opciones){
      if(op.total + g.pax <= maxPax){
        elegido = op.turno;
        break;
      }
    }

    // 2) Si ninguno cabe → no se asigna
    if(!elegido){
      console.warn('[TurnosComida] Grupo no cabe en ningún turno sin sobrepasar capacidad:', g.nombreGrupo, g.pax);
      continue;
    }

    asign[elegido].push(g.id);
  }
}

/**
 * Sincroniza los <select> con state.asignacion
 */
function syncSelectsConAsignacion(){
  document.querySelectorAll('.sel-almuerzo').forEach(sel=> sel.value = '0');
  document.querySelectorAll('.sel-cena').forEach(sel=> sel.value = '0');

  const nAlm = getNumTurnos('almuerzo');
  const nCen = getNumTurnos('cena');

  for(let turno=1; turno<=nAlm; turno++){
    const lista = state.asignacion.almuerzo[turno] || [];
    for(const gid of lista){
      const sel = document.querySelector(`.sel-almuerzo[data-gid="${gid}"]`);
      if(sel) sel.value = String(turno);
    }
  }
  for(let turno=1; turno<=nCen; turno++){
    const lista = state.asignacion.cena[turno] || [];
    for(const gid of lista){
      const sel = document.querySelector(`.sel-cena[data-gid="${gid}"]`);
      if(sel) sel.value = String(turno);
    }
  }
}

/**
 * Reconstruye state.asignacion leyendo lo que el usuario
 * cambió manualmente en los selects.
 */
function reconstruirAsignacionDesdeSelects(){
  resetAsignacionVacia();

  document.querySelectorAll('.sel-almuerzo').forEach(sel=>{
    const turno = Number(sel.value);
    if(!turno) return;
    const gid = sel.dataset.gid;
    state.asignacion.almuerzo[turno].push(gid);
  });

  document.querySelectorAll('.sel-cena').forEach(sel=>{
    const turno = Number(sel.value);
    if(!turno) return;
    const gid = sel.dataset.gid;
    state.asignacion.cena[turno].push(gid);
  });
}

// =========================
// Render de tarjetas de turnos
// =========================
function renderTurnos(){
  const grid = document.getElementById('turnosGrid');
  if(!grid) return;
  grid.innerHTML = '';

  const horasA = state.config.horas.almuerzo;
  const horasC = state.config.horas.cena;
  const maxPax = state.config.maxPax;

  function getEstadoClass(total){
    if(total === 0) return '';
    if(total <= maxPax) return 'turno-status-ok';
    if(total <= maxPax * 1.1) return 'turno-status-warn';
    return 'turno-status-danger';
  }
  function getEstadoText(total){
    if(total === 0) return 'Sin grupos';
    if(total <= maxPax) return 'Dentro de capacidad';
    if(total <= maxPax * 1.1) return 'Al límite';
    return 'Sobrecupo';
  }

  const bloques = [
    { tipo:'almuerzo', label:'Almuerzo', horas:horasA },
    { tipo:'cena',     label:'Cena',     horas:horasC }
  ];

  for(const bloque of bloques){
    const tipo = bloque.tipo;
    const nTurnos = getNumTurnos(tipo);

    for(let t=1; t<=nTurnos; t++){
      const ids = state.asignacion[tipo][t] || [];
      const total = sumPax(ids);
      const hora = bloque.horas[t-1] || '—';
      const estClass = getEstadoClass(total);
      const estText  = getEstadoText(total);

      const card = document.createElement('div');
      card.className = 'turno-card';

      const header = document.createElement('div');
      header.className = 'turno-header';
      header.innerHTML = `
        <span>${bloque.label.toUpperCase()} · TURNO ${t} · ${hora} H</span>
        <span class="turno-pill">
          <span class="turno-badge ${estClass}">${total} pax</span>
          <span class="${estClass}" style="font-size:.7rem;">${estText}</span>
        </span>
      `;

      const ul = document.createElement('ul');
      ul.className = 'turno-list';

      if(ids.length === 0){
        const li = document.createElement('li');
        li.innerHTML = `<span style="color:#9ca3af;">— Sin grupos asignados —</span><span></span>`;
        ul.appendChild(li);
      }else{
        for(const gid of ids){
          const g = getGrupoById(gid);
          if(!g) continue;
          const li = document.createElement('li');
          li.innerHTML = `
            <span>${g.nombreGrupo}</span>
            <span>${g.pax} pax</span>
          `;
          ul.appendChild(li);
        }
      }

      card.appendChild(header);
      card.appendChild(ul);
      grid.appendChild(card);
    }
  }

  const resumenCap = document.getElementById('resumenCapacidad');
  if(resumenCap){
    resumenCap.textContent = `Máx ${maxPax} pax por turno`;
  }
}

// =========================
// Texto para WhatsApp / correo
// =========================
function renderTextoWhats(){
  const horasA = state.config.horas.almuerzo;
  const horasC = state.config.horas.cena;
  const maxPax = state.config.maxPax;
  const fechaLabel = formatearFechaHumana(state.fechaISO);

  const lineas = [];
  lineas.push(`TURNO COMIDAS · FECHA ${fechaLabel}`);
  lineas.push(`Capacidad referencia: ${maxPax} pax por turno`);
  lineas.push('');

  function pushBloque(tipo,label,horas){
    lineas.push(`➡️ ${label.toUpperCase()}:`);
    const nTurnos = getNumTurnos(tipo);

    for(let t=1; t<=nTurnos; t++){
      const ids = state.asignacion[tipo][t] || [];
      const total = sumPax(ids);
      const hora = horas[t-1] || '—';
      lineas.push('');
      lineas.push(`${label.toUpperCase()} - TURNO ${hora} H (${total} pax)`);

      if(ids.length === 0){
        lineas.push(`- (sin grupos asignados)`);
      }else{
        for(const gid of ids){
          const g = getGrupoById(gid);
          if(!g) continue;
          lineas.push(`- ${g.nombreGrupo} – ${g.pax} pax`);
        }
      }
    }
    lineas.push('');
  }

  pushBloque('almuerzo','Almuerzo',horasA);
  pushBloque('cena','Cena',horasC);

  const textarea = document.getElementById('whatsText');
  if(textarea){
    textarea.value = lineas.join('\n');
  }
}

function formatearFechaHumana(fechaISO){
  if(!fechaISO) return 'SIN FECHA';
  const [y,m,d] = fechaISO.split('-').map(Number);
  const date = new Date(y,m-1,d);
  const dia = String(d).padStart(2,'0');
  const meses = ['ENE','FEB','MAR','ABR','MAY','JUN','JUL','AGO','SEP','OCT','NOV','DIC'];
  return `${dia}-${meses[date.getMonth()]}-${y}`;
}

// =========================
// Config desde UI + eventos
// =========================
function leerConfigDesdeUI(){
  const maxInput = document.getElementById('maxPaxTurno');
  const alm1 = document.getElementById('horaAlm1');
  const alm2 = document.getElementById('horaAlm2');
  const alm3 = document.getElementById('horaAlm3');
  const alm4 = document.getElementById('horaAlm4');
  const cen1 = document.getElementById('horaCen1');
  const cen2 = document.getElementById('horaCen2');
  const cen3 = document.getElementById('horaCen3');
  const cen4 = document.getElementById('horaCen4');

  const maxPax = Number(maxInput?.value) || 96;
  state.config.maxPax = maxPax;

  state.config.horas.almuerzo = [
    alm1?.value || '12:30',
    alm2?.value || '13:30',
    alm3?.value || '14:30',
    alm4?.value || ''
  ];
  state.config.horas.cena = [
    cen1?.value || '19:30',
    cen2?.value || '20:30',
    cen3?.value || '21:30',
    cen4?.value || ''
  ];
}

async function cargarDia(fechaISO){
  state.fechaISO = fechaISO;

  state.grupos = await cargarGruposDelDia(fechaISO);

  resetAsignacionVacia();
  renderTablaGrupos();

  sugerirTurnos('almuerzo');
  sugerirTurnos('cena');
  syncSelectsConAsignacion();
  renderTurnos();
  renderTextoWhats();

  const inputFecha = document.getElementById('fechaTurno');
  if(inputFecha && !inputFecha.value){
    inputFecha.value = fechaISO;
  }

  console.log('[TurnosComida] Grupos cargados para', fechaISO, state.grupos);
}

// =========================
// Inicialización principal
// =========================
function initTurnosComidas(){
  const fechaInicial = tomorrowISO();

  initModalItinListeners();

  const inputFecha = document.getElementById('fechaTurno');
  if(inputFecha){
    inputFecha.value = fechaInicial;
    inputFecha.addEventListener('change', ()=>{
      const f = inputFecha.value || fechaInicial;
      cargarDia(f);
    });
  }

  const maxPaxInput = document.getElementById('maxPaxTurno');
  if(maxPaxInput){
    maxPaxInput.addEventListener('change', ()=>{
      leerConfigDesdeUI();
      sugerirTurnos('almuerzo');
      sugerirTurnos('cena');
      syncSelectsConAsignacion();
      renderTurnos();
      renderTextoWhats();
    });
  }

  ['horaAlm1','horaAlm2','horaAlm3','horaAlm4','horaCen1','horaCen2','horaCen3','horaCen4'].forEach(id=>{
    const el = document.getElementById(id);
    if(!el) return;
    el.addEventListener('change', ()=>{
      leerConfigDesdeUI();
      sugerirTurnos('almuerzo');
      sugerirTurnos('cena');
      syncSelectsConAsignacion();
      renderTurnos();
      renderTextoWhats();
    });
  });

  const btnRecalcular = document.getElementById('btnRecalcular');
  if(btnRecalcular){
    btnRecalcular.addEventListener('click', ()=>{
      leerConfigDesdeUI();
      resetAsignacionVacia();
      sugerirTurnos('almuerzo');
      sugerirTurnos('cena');
      syncSelectsConAsignacion();
      renderTurnos();
      renderTextoWhats();
      console.log('[TurnosComidas] Recalcular ejecutado con maxPax =', state.config.maxPax);
    });
  }

  const btnGuardar = document.getElementById('btnGuardar');
  if(btnGuardar){
    btnGuardar.addEventListener('click', ()=>{
      console.log('Turnos a guardar (mock):', JSON.stringify(state, null, 2));
      alert('Turnos guardados en memoria (mock). Luego conectamos a Firestore.');
    });
  }

  const btnCopiar = document.getElementById('btnCopiarWhats');
  if(btnCopiar){
    btnCopiar.addEventListener('click', ()=>{
      const txt = document.getElementById('whatsText')?.value || '';
      if(!txt) return;
      navigator.clipboard.writeText(txt)
        .then(()=> alert('Texto copiado al portapapeles.'))
        .catch(()=> alert('No se pudo copiar automáticamente, copia manualmente.'));
    });
  }

  leerConfigDesdeUI();
  cargarDia(fechaInicial);
}

// Como este módulo se carga al final del body, inicializamos directo
initTurnosComidas();
