// turnos-comidas.js
// Asignador de turnos de comida (almuerzo / cena) para Bariloche.
// Versión inicial: trabaja en memoria con datos de prueba.

import { app, db } from './firebase-init.js';
import {
  collection, getDocs, doc, getDoc, setDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

// =========================
// Estado en memoria
// =========================
const state = {
  fechaISO: null,
  grupos: [],         // [{id, numeroNegocio, nombreGrupo, pax, coordinador}]
  config: {
    maxPax: 96,
    horas: {
      almuerzo: ['12:00', '13:00', '14:00'],
      cena:     ['20:00', '21:00', '22:00']
    }
  },
  asignacion: {
    almuerzo: { 1: [], 2: [], 3: [] },  // ids de grupos
    cena:     { 1: [], 2: [], 3: [] }
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

function getGrupoById(id){
  return state.grupos.find(g => g.id === id) || null;
}

function sumPax(ids){
  return ids.reduce((acc,id)=>{
    const g = getGrupoById(id);
    return acc + (g ? g.pax : 0);
  },0);
}

// =========================
// Loader REAL desde Firestore
// =========================

// ¿El destino del grupo incluye BARILOCHE?
function incluyeBariloche(destinoRaw = '') {
  const txt = String(destinoRaw).normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toUpperCase();
  // Ej: "BARILOCHE", "SUR DE CHILE Y BARILOCHE", etc.
  return txt.includes('BARILOCHE');
}

// Convierte diferentes formatos de fecha (Timestamp, string ISO, Date) a Date
function toDateSafe(v) {
  if (!v) return null;
  // Firestore Timestamp
  if (typeof v.toDate === 'function') return v.toDate();
  // String tipo "2025-12-09"
  if (typeof v === 'string') {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  // Date
  if (v instanceof Date) return v;
  return null;
}

// ¿La fecha objetivo está dentro del rango [inicio, fin]?
function dentroRangoFechas(targetDate, inicioRaw, finRaw) {
  const ini = toDateSafe(inicioRaw);
  const fin = toDateSafe(finRaw);
  if (!ini || !fin) return false;
  const t = targetDate.getTime();
  return t >= ini.setHours(0,0,0,0) && t <= fin.setHours(23,59,59,999);
}

/**
 * Carga grupos que:
 *  - Están en BARILOCHE (por destino)
 *  - Están "en viaje" en la fecha seleccionada (entre fechaInicioViaje y fechaFinViaje)
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

    // 2) Rango de fechas: ajusta a tus nombres reales
    //   - aquí supongo campos "fechaInicioViaje" y "fechaFinViaje"
    const ini = data.fechaInicioViaje || data.fechaInicio || data.inicioViaje;
    const fin = data.fechaFinViaje    || data.fechaFin    || data.finViaje;

    if (!dentroRangoFechas(fechaObj, ini, fin)) return;

    // 3) Campos visibles en el módulo
    const pax = Number(
      data.cantidadGrupo ??
      data.pax ??
      data.paxTotal ??
      0
    );

    const grupo = {
      id: docSnap.id,
      numeroNegocio: data.numeroNegocio || data.numNegocio || data.numero || docSnap.id,
      nombreGrupo: data.nombreGrupo || data.grupo || data.nombre || `(sin nombre)`,
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

  return resultados;
}

// =========================
// Itinerario por grupo / día
// =========================

/**
 * Extrae las actividades de un día específico desde el campo "itinerario"
 * de grupos/{gid}.
 *
 * Estructura esperada aproximada:
 * itinerario: {
 *   "2025-12-06": {
 *      "0": { hora:"09:00", actividad:"City tour", ... },
 *      "1": { hora:"14:00", actividad:"Cerro Otto", ... },
 *      ...
 *   },
 *   ...
 * }
 */
function extraerItinerarioDia(itinerarioRaw, fechaISO){
  if (!itinerarioRaw || typeof itinerarioRaw !== 'object') return [];

  const dia = itinerarioRaw[fechaISO];
  if (!dia || typeof dia !== 'object') return [];

  // Helpers internos para detectar y ordenar por hora
  const regexHora = /([01]\d|2[0-3]):[0-5]\d/;

  function pickHoraFromAct(act){
    if (!act || typeof act !== 'object') return '';

    // 1) Candidatos típicos que podrías estar usando
    const candidatos = [
      act.hora,
      act.horario,
      act.horaInicio,
      act.horaSalida,
      act.horaTexto,
      act.horaLabel
    ];

    for (const c of candidatos){
      if (typeof c === 'string' && regexHora.test(c)) return c.match(regexHora)[0];
    }

    // 2) Si lo anterior no sirvió, buscar en TODOS los valores string del objeto
    for (const val of Object.values(act)){
      if (typeof val === 'string' && regexHora.test(val)){
        return val.match(regexHora)[0];
      }
    }

    return '';
  }

  function horaToMinutos(horaStr){
    if (!horaStr || !regexHora.test(horaStr)) return 9999; // al final si no hay hora
    const m = horaStr.match(regexHora);
    if (!m) return 9999;
    const [hh, mm] = m[0].split(':').map(n => parseInt(n, 10));
    if (Number.isNaN(hh) || Number.isNaN(mm)) return 9999;
    return hh * 60 + mm;
  }

  const actividades = [];

  // Recorremos todas las claves (0,1,2...) pero luego ordenamos por hora real
  for (const k of Object.keys(dia)){
    const act = dia[k];
    if (!act || typeof act !== 'object') continue;

    const horaStr = pickHoraFromAct(act);

    actividades.push({
      hora:       horaStr,
      actividad:  act.actividad  || act.titulo  || act.nombre || '(sin nombre)',
      lugar:      act.lugar      || act.ciudad  || '',
      notas:      act.notas      || act.detalle || act.obs || '',
      _orden:     horaToMinutos(horaStr)
    });
  }

  // Ordenar por hora (las sin hora quedan al final)
  actividades.sort((a,b)=> a._orden - b._orden);

  // Devolver sin el campo interno _orden
  return actividades.map(({ _orden, ...rest }) => rest);
}


/**
 * Devuelve un texto legible para pegar en textarea o alert()
 */
function formatearItinerarioGrupo(lista){
  if (!lista.length){
    return 'No hay actividades registradas para este día.';
  }

  const lineas = [];
  lineas.push('ITINERARIO DEL DÍA');
  lineas.push('');

  lista.forEach((item, idx)=>{
    const hora = item.hora || '--:--';
    let linea = `${idx+1}) ${hora} · ${item.actividad}`;
    const extras = [];

    if (item.lugar) extras.push(item.lugar);
    if (item.notas) extras.push(item.notas);

    if (extras.length){
      linea += ` (${extras.join(' · ')})`;
    }
    lineas.push(linea);
  });

  return lineas.join('\n');
}

/**
 * Lee grupos/{gid}, extrae itinerario[state.fechaISO] y lo muestra.
 * - Si existe <textarea id="itinerarioGrupo"> lo rellena ahí.
 * - Si no existe, usa alert().
 */
async function mostrarItinerarioGrupo(gid, nombreGrupo){
  if (!state.fechaISO){
    alert('Primero selecciona una fecha.');
    return;
  }

  try{
    const ref = doc(db, 'grupos', gid);
    const snap = await getDoc(ref);

    if (!snap.exists()){
      alert('No se encontró el grupo en la base de datos.');
      return;
    }

    const data = snap.data() || {};
    const lista = extraerItinerarioDia(data.itinerario || {}, state.fechaISO);
    const texto = `GRUPO: ${nombreGrupo}\nFECHA: ${formatearFechaHumana(state.fechaISO)}\n\n`
      + formatearItinerarioGrupo(lista);

    const textarea = document.getElementById('itinerarioGrupo');
    if (textarea){
      textarea.value = texto;
      textarea.scrollIntoView({ behavior:'smooth', block:'center' });
    }else{
      alert(texto);
    }
  }catch(err){
    console.error('[TurnosComidas] Error al leer itinerario', err);
    alert('No se pudo leer el itinerario de este grupo.');
  }
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
    const linkNombre = document.createElement('span');
    linkNombre.textContent = g.nombreGrupo;
    linkNombre.className = 'link-itinerario';
    linkNombre.addEventListener('click', () => {
      mostrarItinerarioGrupo(g.id, g.nombreGrupo);
    });
    tdNombre.appendChild(linkNombre);


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
    selAlm.innerHTML = `
      <option value="0">—</option>
      <option value="1">T1</option>
      <option value="2">T2</option>
      <option value="3">T3</option>
    `;
    tdAlm.appendChild(selAlm);

    const tdCen = document.createElement('td');
    const selCen = document.createElement('select');
    selCen.className = 'select-turno sel-cena';
    selCen.dataset.gid = g.id;
    selCen.innerHTML = `
      <option value="0">—</option>
      <option value="1">T1</option>
      <option value="2">T2</option>
      <option value="3">T3</option>
    `;
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
  state.asignacion = {
    almuerzo: { 1: [], 2: [], 3: [] },
    cena:     { 1: [], 2: [], 3: [] }
  };
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

  asign[1] = [];
  asign[2] = [];
  asign[3] = [];

  const gruposOrdenados = [...state.grupos].sort((a,b)=>b.pax - a.pax);

  for(const g of gruposOrdenados){
    const t1 = sumPax(asign[1]);
    const t2 = sumPax(asign[2]);
    const t3 = sumPax(asign[3]);

    const opciones = [
      { turno:1, total:t1 },
      { turno:2, total:t2 },
      { turno:3, total:t3 }
    ].sort((a,b)=>a.total - b.total);

    let elegido = null;

    // Intentar no superar el máximo
    for(const op of opciones){
      if(op.total + g.pax <= maxPax){
        elegido = op.turno;
        break;
      }
    }
    // Si no cabe "limpio", tirarlo al más vacío de todas formas
    if(!elegido){
      elegido = opciones[0].turno;
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

  for(const turno of [1,2,3]){
    for(const gid of state.asignacion.almuerzo[turno]){
      const sel = document.querySelector(`.sel-almuerzo[data-gid="${gid}"]`);
      if(sel) sel.value = String(turno);
    }
  }
  for(const turno of [1,2,3]){
    for(const gid of state.asignacion.cena[turno]){
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
// Persistencia de turnos (turnosCasino/{fechaISO})
// =========================

/**
 * Construye un mapa por grupo:
 * grupos[gid] = { numeroNegocio, nombreGrupo, pax, coordinador, almuerzoTurno, cenaTurno }
 * leyendo directamente los <select> del DOM.
 */
function buildAsignacionPorGrupo(){
  const resultado = {};

  for (const g of state.grupos){
    const selAlm = document.querySelector(`.sel-almuerzo[data-gid="${g.id}"]`);
    const selCen = document.querySelector(`.sel-cena[data-gid="${g.id}"]`);

    resultado[g.id] = {
      numeroNegocio: g.numeroNegocio,
      nombreGrupo:   g.nombreGrupo,
      pax:           g.pax,
      coordinador:   g.coordinador || '',
      almuerzoTurno: Number(selAlm?.value || 0),
      cenaTurno:     Number(selCen?.value || 0)
    };
  }

  return resultado;
}

/**
 * Aplica al state.asignacion lo que viene guardado en Firestore.
 * Espera un objeto:
 * {
 *   gid: { almuerzoTurno:1..3, cenaTurno:1..3, ... },
 *   ...
 * }
 */
function aplicarAsignacionGuardada(gruposGuardados){
  resetAsignacionVacia();

  if (!gruposGuardados || typeof gruposGuardados !== 'object') return;

  for (const [gid, cfg] of Object.entries(gruposGuardados)){
    if (!cfg) continue;

    const alm = Number(cfg.almuerzoTurno || 0);
    const cen = Number(cfg.cenaTurno     || 0);

    if (alm >= 1 && alm <= 3){
      state.asignacion.almuerzo[alm].push(gid);
    }
    if (cen >= 1 && cen <= 3){
      state.asignacion.cena[cen].push(gid);
    }
  }
}

/**
 * Guarda el día actual en turnosCasino/{fechaISO}.
 */
async function guardarTurnosDia(){
  if (!state.fechaISO){
    alert('Selecciona una fecha antes de guardar.');
    return;
  }
  if (!state.grupos.length){
    alert('No hay grupos para este día.');
    return;
  }

  try{
    // Aseguramos que config esté alineada con la UI
    leerConfigDesdeUI();

    // Reconstruimos asignación por si hubo cambios manuales
    reconstruirAsignacionDesdeSelects();

    const gruposAsign = buildAsignacionPorGrupo();

    const ref = doc(db, 'turnosCasino', state.fechaISO);
    const payload = {
      fecha: state.fechaISO,
      config: {
        maxPax: state.config.maxPax,
        horas: {
          almuerzo: state.config.horas.almuerzo,
          cena:     state.config.horas.cena
        }
      },
      grupos: gruposAsign,
      updatedAt: new Date().toISOString()
    };

    await setDoc(ref, payload);
    console.log('[TurnosComidas] Turnos guardados en', ref.path, payload);
    alert('Turnos guardados correctamente en la base de datos.');
  }catch(err){
    console.error('[TurnosComidas] Error al guardar turnos', err);
    alert('Ocurrió un error al guardar los turnos.');
  }
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
    for(let t=1;t<=3;t++){
      const ids = state.asignacion[tipo][t] || [];
      const total = sumPax(ids);
      const hora = bloque.horas[t-1] || '—';
      const estClass = getEstadoClass(total);
      const estText = getEstadoText(total);

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
    for(let t=1;t<=3;t++){
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
  const cen1 = document.getElementById('horaCen1');
  const cen2 = document.getElementById('horaCen2');
  const cen3 = document.getElementById('horaCen3');

  const maxPax = Number(maxInput?.value) || 96;
  state.config.maxPax = maxPax;

  state.config.horas.almuerzo = [
    alm1?.value || '12:30',
    alm2?.value || '13:30',
    alm3?.value || '14:30'
  ];
  state.config.horas.cena = [
    cen1?.value || '19:30',
    cen2?.value || '20:30',
    cen3?.value || '21:30'
  ];
}

async function cargarDia(fechaISO){
  state.fechaISO = fechaISO;

  // 1) Cargar grupos para ese día
  state.grupos = await cargarGruposDelDia(fechaISO);

  // 2) Config base desde la UI (por si no hay nada guardado)
  leerConfigDesdeUI();

  let encontradaGuardada = false;

  // 3) Intentar leer documento turnosCasino/{fechaISO}
  try{
    const ref = doc(db, 'turnosCasino', fechaISO);
    const snap = await getDoc(ref);

    if (snap.exists()){
      const data = snap.data() || {};
      encontradaGuardada = true;

      // Config guardada
      if (data.config){
        if (typeof data.config.maxPax === 'number'){
          state.config.maxPax = data.config.maxPax;
        }
        if (data.config.horas){
          if (Array.isArray(data.config.horas.almuerzo)){
            state.config.horas.almuerzo = data.config.horas.almuerzo;
          }
          if (Array.isArray(data.config.horas.cena)){
            state.config.horas.cena = data.config.horas.cena;
          }
        }
      }

      // Asignación por grupo
      aplicarAsignacionGuardada(data.grupos || {});
    }else{
      // Si NO hay datos guardados → sugerencia automática
      resetAsignacionVacia();
      sugerirTurnos('almuerzo');
      sugerirTurnos('cena');
    }
  }catch(err){
    console.error('[TurnosComidas] Error al cargar turnos guardados', err);
    resetAsignacionVacia();
    sugerirTurnos('almuerzo');
    sugerirTurnos('cena');
  }

  // 4) Renderizar tabla + selects + tarjetas
  renderTablaGrupos();
  syncSelectsConAsignacion();
  renderTurnos();
  renderTextoWhats();

  // 5) Reflejar config actual en los inputs de la UI
  const maxInput = document.getElementById('maxPaxTurno');
  if (maxInput){
    maxInput.value = state.config.maxPax;
  }
  const [alm1,alm2,alm3] = state.config.horas.almuerzo;
  const [cen1,cen2,cen3] = state.config.horas.cena;
  const ids  = ['horaAlm1','horaAlm2','horaAlm3','horaCen1','horaCen2','horaCen3'];
  const vals = [alm1,alm2,alm3,cen1,cen2,cen3];

  ids.forEach((id, idx)=>{
    const el = document.getElementById(id);
    if (el && vals[idx]){
      el.value = vals[idx];
    }
  });

  // 6) Setear fecha en input
  const inputFecha = document.getElementById('fechaTurno');
  if (inputFecha){
    inputFecha.value = fechaISO;
  }

  console.log(
    '[TurnosComidas] Grupos cargados para',
    fechaISO,
    state.grupos,
    encontradaGuardada ? '(con asignación guardada)' : '(sin asignación guardada)'
  );
}



// Inicialización principal
function initTurnosComidas(){
  const hoyISO = normDateISO();

  const inputFecha = document.getElementById('fechaTurno');
  if(inputFecha){
    inputFecha.value = hoyISO;
    inputFecha.addEventListener('change', ()=>{
      const f = inputFecha.value || hoyISO;
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

  ['horaAlm1','horaAlm2','horaAlm3','horaCen1','horaCen2','horaCen3'].forEach(id=>{
    const el = document.getElementById(id);
    if(!el) return;
    el.addEventListener('change', ()=>{
      leerConfigDesdeUI();
      renderTurnos();
      renderTextoWhats();
    });
  });

  const btnRecalcular = document.getElementById('btnRecalcular');
  if(btnRecalcular){
    btnRecalcular.addEventListener('click', ()=>{
      // 1) Leer config actual (máx pax + horarios)
      leerConfigDesdeUI();

      // 2) Ignorar cualquier selección manual anterior
      resetAsignacionVacia();

      // 3) Volver a sugerir desde cero usando TODOS los grupos del día
      sugerirTurnos('almuerzo');
      sugerirTurnos('cena');

      // 4) Reflejar esa nueva asignación en los <select>
      syncSelectsConAsignacion();

      // 5) Redibujar tarjetas + texto WhatsApp
      renderTurnos();
      renderTextoWhats();

      // 6) Pequeño log para confirmar que se ejecutó
      console.log('[TurnosComidas] Recalcular ejecutado con maxPax =', state.config.maxPax);
    });
  }


  const btnGuardar = document.getElementById('btnGuardar');
  if(btnGuardar){
    btnGuardar.addEventListener('click', ()=>{
      guardarTurnosDia();
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
  cargarDia(hoyISO);
}

// Como este módulo se carga al final del body, inicializamos directo
initTurnosComidas();
