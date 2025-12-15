// buses-turnos.js
// Asignador MANUAL de salidas + asignación de buses por turno
// Regla: capacidad + NO solapamiento en el tiempo (duración + buffer).

import { app, db } from './firebase-init.js';
import {
  collection, getDocs,
  doc, getDoc, setDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';


/* =========================
   STATE
========================= */
const state = {
  fechaISO: null,

  // destino elegido en UI (BARILOCHE / BRASIL / etc.)
  destino: 'BARILOCHE',

  // Rangos de turnos para clasificar actividades por hora
  turnos: {
    manana: { label:'MAÑANA', ini:'06:00', fin:'11:59' },
    tarde:  { label:'TARDE',  ini:'12:00', fin:'18:59' },
    noche:  { label:'NOCHE',  ini:'19:00', fin:'23:59' }
  },

  // Config global del “bloque” (ida+vuelta) que deja un bus ocupado
  config: {
    duracionVueltaMin: 40,
    bufferMin: 10
  },

  // grupos reales cargados desde Firestore (como en turnos-comidas)
  grupos: [],

  turnoActivo: 'manana',
  data: {
    buses:   { manana: [], tarde: [], noche: [] },

    // OJO: ahora se auto-genera desde el itinerario del día
    salidas: { manana: [], tarde: [], noche: [] }
  }
};


/* =========================
   Utils (fecha/hora)
========================= */
function normDateISO(d = new Date()){
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

function formatearFechaHumana(fechaISO){
  if(!fechaISO) return 'SIN FECHA';
  const [y,m,d] = fechaISO.split('-').map(Number);
  const date = new Date(y,m-1,d);
  const dia = String(d).padStart(2,'0');
  const meses = ['ENE','FEB','MAR','ABR','MAY','JUN','JUL','AGO','SEP','OCT','NOV','DIC'];
  return `${dia}-${meses[date.getMonth()]}-${y}`;
}

function pad2(n){ return String(n).padStart(2,'0'); }

function timeToMin(hhmm){
  if(!hhmm || typeof hhmm !== 'string') return NaN;
  const m = hhmm.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if(!m) return NaN;
  return parseInt(m[1],10)*60 + parseInt(m[2],10);
}

function minToTime(min){
  if(!Number.isFinite(min)) return '--:--';
  const hh = Math.floor(min/60);
  const mm = min%60;
  return `${pad2(hh)}:${pad2(mm)}`;
}

function uid(){
  // id simple suficiente para UI/Firestore
  return Math.random().toString(36).slice(2,10) + Date.now().toString(36).slice(2,8);
}

/* =========================
   Helpers (destino / fechas / itinerario) — igual estilo turnos-comidas
========================= */
const K = s => (s ?? '').toString()
  .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
  .toUpperCase().trim();

function incluyeDestino(destinoRaw='', destinoFiltro=''){
  const txt = K(destinoRaw);
  const d   = K(destinoFiltro);
  return d && txt.includes(d);
}

function toDateSafe(v){
  if(!v) return null;
  if(typeof v.toDate === 'function') return v.toDate(); // Timestamp Firestore
  if(typeof v === 'string'){ const d = new Date(v); return isNaN(d.getTime()) ? null : d; }
  if(v instanceof Date) return v;
  return null;
}

function dentroRangoFechas(targetDate, inicioRaw, finRaw){
  const ini = toDateSafe(inicioRaw);
  const fin = toDateSafe(finRaw);
  if(!ini || !fin) return false;
  const t = targetDate.getTime();
  return t >= ini.setHours(0,0,0,0) && t <= fin.setHours(23,59,59,999);
}

// Extrae actividades del día desde itinerario[fechaISO] (igual turnos-comidas)
function extraerItinerarioDia(itinerarioRaw, fechaISO){
  if (!itinerarioRaw || typeof itinerarioRaw !== 'object') return [];
  const dia = itinerarioRaw[fechaISO];
  if (!dia || typeof dia !== 'object') return [];

  const regexHora = /([01]\d|2[0-3]):[0-5]\d/;

  function pickHoraFromAct(act){
    if (!act || typeof act !== 'object') return '';
    const candidatos = [act.hora, act.horario, act.horaInicio, act.horaSalida, act.horaTexto, act.horaLabel];
    for (const c of candidatos){
      if (typeof c === 'string' && regexHora.test(c)) return c.match(regexHora)[0];
    }
    for (const val of Object.values(act)){
      if (typeof val === 'string' && regexHora.test(val)) return val.match(regexHora)[0];
    }
    return '';
  }

  function horaToMinutos(horaStr){
    if (!horaStr || !regexHora.test(horaStr)) return 9999;
    const [hh, mm] = horaStr.match(regexHora)[0].split(':').map(n => parseInt(n, 10));
    if (Number.isNaN(hh) || Number.isNaN(mm)) return 9999;
    return hh * 60 + mm;
  }

  const out = [];
  for (const k of Object.keys(dia)){
    const act = dia[k];
    if(!act || typeof act !== 'object') continue;

    const horaStr = pickHoraFromAct(act);

    out.push({
      hora: horaStr,
      actividad: act.actividad || act.titulo || act.nombre || '(sin nombre)',
      lugar: act.lugar || act.ciudad || '',
      notas: act.notas || act.detalle || act.obs || '',
      _orden: horaToMinutos(horaStr)
    });
  }

  out.sort((a,b)=> a._orden - b._orden);
  return out.map(({_orden, ...rest}) => rest);
}

// Determina turno por hora según state.turnos
function turnoPorHora(hhmm){
  const m = timeToMin(hhmm);
  if(!Number.isFinite(m)) return null;

  const enRango = (ini, fin) => {
    const a = timeToMin(ini), b = timeToMin(fin);
    return m >= a && m <= b;
  };

  if(enRango(state.turnos.manana.ini, state.turnos.manana.fin)) return 'manana';
  if(enRango(state.turnos.tarde.ini,  state.turnos.tarde.fin))  return 'tarde';
  if(enRango(state.turnos.noche.ini,  state.turnos.noche.fin))  return 'noche';
  return null;
}

/* =========================
   Modelo de cálculo: bloque
========================= */
function calcBloqueSalida(s){
  const start = timeToMin(s.hora);
  const dur = Number(s.duracionMin || 0);
  const buf = Number(s.bufferMin || 0);
  const end = start + dur + buf;
  return { start, end, dur, buf };
}

function solapa(a, b){
  // [a.start, a.end) con [b.start, b.end)
  return a.start < b.end && b.start < a.end;
}

/* =========================
   Validaciones (capacidad + solapamiento)
========================= */
function evaluarSalida(turno, salidaId){
  const salidas = state.data.salidas[turno] || [];
  const buses   = state.data.buses[turno]   || [];
  const s = salidas.find(x => x.id === salidaId);
  if(!s) return { ok:true, level:'ok', msg:'OK' };

  // 1) Si no hay bus asignado
  if(!s.busId){
    return { ok:false, level:'warn', msg:'Sin bus' };
  }

  const bus = buses.find(b => b.id === s.busId);
  if(!bus){
    return { ok:false, level:'bad', msg:'Bus no existe' };
  }

  // 2) Capacidad
  const pax = Number(s.pax || 0);
  if (pax > Number(bus.capacidad || 0)){
    return { ok:false, level:'bad', msg:`Sobrecupo (${pax}/${bus.capacidad})` };
  }

  // 3) Solapamiento: comparar con otras salidas del mismo turno asignadas al mismo bus
  const bloqueS = calcBloqueSalida(s);
  if(!Number.isFinite(bloqueS.start) || !Number.isFinite(bloqueS.end)){
    return { ok:false, level:'warn', msg:'Hora inválida' };
  }

  for(const other of salidas){
    if(other.id === s.id) continue;
    if(other.busId !== s.busId) continue;
    const bloqueO = calcBloqueSalida(other);
    if(!Number.isFinite(bloqueO.start) || !Number.isFinite(bloqueO.end)) continue;
    if(solapa(bloqueS, bloqueO)){
      return { ok:false, level:'bad', msg:'Choque horario' };
    }
  }

  return { ok:true, level:'ok', msg:'OK' };
}
/* =========================
   Loader REAL (grupos del día) + Auto-salidas desde itinerario
========================= */
async function cargarGruposDelDia(fechaISO, destinoFiltro){
  const fechaObj = new Date(`${fechaISO}T00:00:00`);
  if (isNaN(fechaObj.getTime())) return [];

  const gruposRef = collection(db, 'grupos');
  const snap = await getDocs(gruposRef);

  const resultados = [];

  snap.forEach(docSnap => {
    const data = docSnap.data() || {};

    // 1) Destino
    const destinoRaw = data.destino || data.destinoBase || '';
    if (!incluyeDestino(destinoRaw, destinoFiltro)) return;

    // 2) Rango de fechas (ajusta nombres si alguno difiere)
    const ini = data.fechaInicioViaje || data.fechaInicio || data.inicioViaje;
    const fin = data.fechaFinViaje    || data.fechaFin    || data.finViaje;
    if (!dentroRangoFechas(fechaObj, ini, fin)) return;

    // 3) Pax
    const pax = Number(data.cantidadGrupo ?? data.pax ?? data.paxTotal ?? 0);

    resultados.push({
      id: docSnap.id,
      numeroNegocio: data.numeroNegocio || data.numNegocio || data.numero || docSnap.id,
      nombreGrupo: data.nombreGrupo || data.grupo || data.nombre || '(sin nombre)',
      pax,
      coordinador: data.coordinadorNombre || data.coordinador || data.coordNombre || '',
      itinerarioRaw: data.itinerario || {}
    });
  });

  return resultados;
}

// Genera salidas AUTOMÁTICAS desde el itinerario del día
function generarSalidasDesdeItinerario(){
  state.data.salidas = { manana: [], tarde: [], noche: [] };

  const dur = Number(state.config.duracionVueltaMin || 40);
  const buf = Number(state.config.bufferMin || 10);

  for(const g of state.grupos){
    const acts = extraerItinerarioDia(g.itinerarioRaw || {}, state.fechaISO);

    for(const a of acts){
      if(!a.hora) continue;

      const turno = turnoPorHora(a.hora);
      if(!turno) continue;

      state.data.salidas[turno].push({
        id: uid(),
        hora: a.hora,

        // Bloque automático (ida+vuelta)
        duracionMin: dur,
        bufferMin: buf,

        destino: a.actividad || '(actividad)',

        // Texto automático (lo puedes mejorar después)
        gruposTexto: `(${g.numeroNegocio}) ${g.nombreGrupo}`,
        pax: Number(g.pax || 0),

        // trazabilidad para re-aplicar asignaciones guardadas
        gid: g.id,
        actividad: a.actividad || '',
        busId: null
      });
    }
  }

  for(const t of ['manana','tarde','noche']){
    state.data.salidas[t].sort((a,b)=> timeToMin(a.hora) - timeToMin(b.hora));
  }
}

// Clave estable para guardar/reaplicar bus asignado aunque regeneremos salidas
function keyAsignacionSalida(s){
  return `${s.gid || ''}__${s.hora || ''}__${K(s.actividad || s.destino || '')}`;
}

function aplicarAsignacionesGuardadas(map){
  if(!map || typeof map !== 'object') return;
  for(const t of ['manana','tarde','noche']){
    for(const s of state.data.salidas[t]){
      const k = keyAsignacionSalida(s);
      if(map[k]) s.busId = map[k];
    }
  }
}

/* =========================
   Firestore: busesTurnos/{fechaISO}
========================= */
async function cargarDia(fechaISO){
  state.fechaISO = fechaISO;

  // 1) Leer destino + config global desde UI (si existen esos inputs)
  state.destino = document.getElementById('destinoFiltro')?.value || state.destino;

  const durUI = Number(document.getElementById('duracionVueltaMin')?.value);
  const bufUI = Number(document.getElementById('bufferMinGlobal')?.value);
  if(Number.isFinite(durUI) && durUI > 0) state.config.duracionVueltaMin = durUI;
  if(Number.isFinite(bufUI) && bufUI >= 0) state.config.bufferMin = bufUI;

  // 2) Base vacía (buses se cargan desde doc; salidas se generan desde itinerario)
  state.data = {
    buses: { manana: [], tarde: [], noche: [] },
    salidas: { manana: [], tarde: [], noche: [] }
  };

  // 3) Cargar grupos reales del día (AUTO)
  state.grupos = await cargarGruposDelDia(fechaISO, state.destino);

  // 4) Generar salidas desde itinerario (AUTO)
  generarSalidasDesdeItinerario();

  // 5) Leer documento guardado para recuperar BUSES + ASIGNACIONES
  try{
    const ref = doc(db, 'busesTurnos', fechaISO);
    const snap = await getDoc(ref);

    if(snap.exists()){
      const data = snap.data() || {};
      if(data.buses) state.data.buses = normalizarTurnosObj(data.buses);

      // Re-aplicar asignaciones guardadas (busId por salida “estable”)
      if(data.asignaciones) aplicarAsignacionesGuardadas(data.asignaciones);
    }
  }catch(err){
    console.error('[BusesTurnos] Error cargando día (doc busesTurnos)', err);
    // seguimos igual con lo auto generado
  }

  renderTodo();
}

async function guardarDia(){
  if(!state.fechaISO){
    alert('Selecciona una fecha.');
    return;
  }

  // Guardamos asignaciones estables (porque salidas se regeneran desde itinerario)
  const asignaciones = {};
  for(const t of ['manana','tarde','noche']){
    for(const s of state.data.salidas[t]){
      if(!s.busId) continue;
      asignaciones[keyAsignacionSalida(s)] = s.busId;
    }
  }

  try{
    const ref = doc(db, 'busesTurnos', state.fechaISO);
    const payload = {
      fecha: state.fechaISO,
      destino: state.destino,
      config: { ...state.config },
      buses: state.data.buses,
      asignaciones,
      updatedAt: new Date().toISOString()
    };
    await setDoc(ref, payload);
    alert('Día guardado correctamente.');
  }catch(err){
    console.error('[BusesTurnos] Error guardando día', err);
    alert('Ocurrió un error al guardar.');
  }
}

function normalizarTurnosObj(obj){
  // garantiza estructura {manana:[], tarde:[], noche:[]}
  const out = { manana: [], tarde: [], noche: [] };
  if(!obj || typeof obj !== 'object') return out;
  for(const t of ['manana','tarde','noche']){
    if(Array.isArray(obj[t])) out[t] = obj[t];
  }
  return out;
}

/* =========================
   CRUD en memoria: buses
========================= */
function agregarBus(turno, numero, conductor, capacidad){
  const n = String(numero || '').trim();
  const c = String(conductor || '').trim();
  const cap = Number(capacidad);

  if(!n || !c || !Number.isFinite(cap) || cap <= 0){
    alert('Completa N° bus, conductor y capacidad válida.');
    return;
  }

  state.data.buses[turno].push({
    id: uid(),
    numero: n,
    conductor: c,
    capacidad: cap
  });

  renderTodo();
}

function eliminarBus(turno, busId){
  // Ojo: si un bus se elimina, dejamos las salidas que lo usaban con busId=null
  state.data.buses[turno] = (state.data.buses[turno] || []).filter(b => b.id !== busId);
  (state.data.salidas[turno] || []).forEach(s => {
    if(s.busId === busId) s.busId = null;
  });
  renderTodo();
}

/* =========================
   CRUD en memoria: salidas
========================= */
function agregarSalida(turno, hora, durMin, bufMin, destino, gruposTxt, pax){
  const hhmm = String(hora || '').trim();
  const start = timeToMin(hhmm);
  if(!Number.isFinite(start)){
    alert('Hora inválida. Usa HH:MM.');
    return;
  }

  const dur = Number(durMin);
  const buf = Number(bufMin);
  if(!Number.isFinite(dur) || dur <= 0){
    alert('Duración inválida (min).');
    return;
  }
  if(!Number.isFinite(buf) || buf < 0){
    alert('Buffer inválido (min).');
    return;
  }

  state.data.salidas[turno].push({
    id: uid(),
    hora: hhmm,
    duracionMin: dur,
    bufferMin: buf,
    destino: String(destino || '').trim(),
    gruposTexto: String(gruposTxt || '').trim(),
    pax: Number(pax || 0),
    busId: null
  });

  // mantener orden por hora
  state.data.salidas[turno].sort((a,b)=> timeToMin(a.hora) - timeToMin(b.hora));

  renderTodo();
}

function eliminarSalida(turno, salidaId){
  state.data.salidas[turno] = (state.data.salidas[turno] || []).filter(s => s.id !== salidaId);
  renderTodo();
}

function setBusEnSalida(turno, salidaId, busIdOrNull){
  const s = (state.data.salidas[turno] || []).find(x => x.id === salidaId);
  if(!s) return;
  s.busId = busIdOrNull || null;
  renderTodo();
}

/* =========================
   Render UI
========================= */
function renderTodo(){
  renderHeaderResumen();
  renderTurnoActivo();
  renderWhats();
}

function renderHeaderResumen(){
  const el = document.getElementById('resumenDia');
  if(!el) return;

  let totalSalidas = 0;
  let totalPax = 0;
  for(const t of ['manana','tarde','noche']){
    totalSalidas += (state.data.salidas[t] || []).length;
    totalPax += (state.data.salidas[t] || []).reduce((acc,s)=> acc + Number(s.pax||0), 0);
  }

  el.textContent = `${formatearFechaHumana(state.fechaISO)} · ${totalSalidas} salida(s) · ${totalPax} pax`;
}

function renderTurnoActivo(){
  const turno = state.turnoActivo;

  const titulo = document.getElementById('tituloTurno');
  const resumen = document.getElementById('resumenTurno');
  if(titulo) titulo.textContent = `Turno: ${turno.toUpperCase()}`;
  if(resumen){
    const buses = state.data.buses[turno] || [];
    const salidas = state.data.salidas[turno] || [];
    resumen.textContent = `${buses.length} bus(es) · ${salidas.length} salida(s)`;
  }

  renderBusesTable(turno);
  renderSalidasTable(turno);
}

function renderBusesTable(turno){
  const tbody = document.getElementById('busesBody');
  if(!tbody) return;
  tbody.innerHTML = '';

  const buses = state.data.buses[turno] || [];
  if(!buses.length){
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="4" class="muted">— No hay buses cargados para este turno —</td>`;
    tbody.appendChild(tr);
    return;
  }

  for(const b of buses){
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><b>${b.numero}</b></td>
      <td>${b.conductor}</td>
      <td class="right">${b.capacidad}</td>
      <td class="right">
        <button class="btn" data-delbus="${b.id}">Eliminar</button>
      </td>
    `;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll('[data-delbus]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const id = btn.getAttribute('data-delbus');
      if(confirm('¿Eliminar este bus? Se desasignará de cualquier salida.')){
        eliminarBus(turno, id);
      }
    });
  });
}

function renderSalidasTable(turno){
  const tbody = document.getElementById('salidasBody');
  if(!tbody) return;
  tbody.innerHTML = '';

  const buses = state.data.buses[turno] || [];
  const salidas = state.data.salidas[turno] || [];

  if(!salidas.length){
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="7" class="muted">— No hay salidas registradas —</td>`;
    tbody.appendChild(tr);
    return;
  }

  for(const s of salidas){
    const { start, end } = calcBloqueSalida(s);
    const bloqueTxt = `${minToTime(start)}–${minToTime(end)}`;

    const ev = evaluarSalida(turno, s.id);
    const dotClass = ev.level === 'ok' ? 'ok' : (ev.level === 'warn' ? 'warn' : 'bad');
    const msgClass = ev.level === 'ok' ? 'oktext' : (ev.level === 'warn' ? 'warntext' : 'danger');

    // select buses
    const options = [
      `<option value="">— Sin bus —</option>`,
      ...buses.map(b => `<option value="${b.id}" ${s.busId===b.id?'selected':''}>Bus ${b.numero} · ${b.conductor} (${b.capacidad})</option>`)
    ].join('');

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><b>${s.hora}</b></td>
      <td>
        <div><b>${escapeHtml(s.destino || '(sin destino)')}</b></div>
        <div class="muted small">${escapeHtml(s.gruposTexto || '')}</div>
      </td>
      <td class="small">${bloqueTxt}<div class="muted small">${s.duracionMin}m + ${s.bufferMin}m</div></td>
      <td class="right"><b>${Number(s.pax||0)}</b></td>
      <td>
        <select class="select-bus" data-salida="${s.id}">
          ${options}
        </select>
      </td>
      <td>
        <span class="tag"><span class="dot ${dotClass}"></span><span class="${msgClass}">${ev.msg}</span></span>
      </td>
      <td class="right">
        <button class="btn" data-delsalida="${s.id}">Eliminar</button>
      </td>
    `;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll('.select-bus').forEach(sel=>{
    sel.addEventListener('change', ()=>{
      const salidaId = sel.dataset.salida;
      const busId = sel.value || null;
      setBusEnSalida(turno, salidaId, busId);
    });
  });

  tbody.querySelectorAll('[data-delsalida]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const id = btn.getAttribute('data-delsalida');
      if(confirm('¿Eliminar esta salida?')){
        eliminarSalida(turno, id);
      }
    });
  });
}

function escapeHtml(s){
  return String(s ?? '')
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'","&#039;");
}

/* =========================
   WhatsApp text
========================= */
function renderWhats(){
  const ta = document.getElementById('whatsText');
  if(!ta) return;

  const fechaLabel = formatearFechaHumana(state.fechaISO);
  const lineas = [];

  lineas.push(`🚌 MOVILIZACIÓN · FECHA ${fechaLabel}`);
  lineas.push('');

  for(const turno of ['manana','tarde','noche']){
    const salidas = (state.data.salidas[turno] || []).slice()
      .sort((a,b)=> timeToMin(a.hora) - timeToMin(b.hora));

    lineas.push(`➡️ TURNO ${turno.toUpperCase()}`);
    if(!salidas.length){
      lineas.push('- (sin salidas)');
      lineas.push('');
      continue;
    }

    for(const s of salidas){
      const ev = evaluarSalida(turno, s.id);
      const icon = ev.level === 'ok' ? '✅' : (ev.level === 'warn' ? '⚠️' : '⛔');
      const buses = state.data.buses[turno] || [];
      const bus = s.busId ? buses.find(b => b.id === s.busId) : null;
      const busTxt = bus ? `Bus ${bus.numero} (${bus.conductor})` : 'SIN BUS';

      lineas.push('');
      lineas.push(`${icon} SALIDA ${s.hora} · ${s.destino || '(sin destino)'}`);
      lineas.push(`Bus: ${busTxt} · Pax: ${Number(s.pax||0)}`);
      if(s.gruposTexto) lineas.push(`Grupos: ${s.gruposTexto}`);
      if(ev.level !== 'ok') lineas.push(`Estado: ${ev.msg}`);
    }

    lineas.push('');
  }

  ta.value = lineas.join('\n');
}

/* =========================
   Tabs + eventos
========================= */
function setTurnoActivo(turno){
  state.turnoActivo = turno;
  document.querySelectorAll('.tab').forEach(btn=>{
    btn.classList.toggle('active', btn.dataset.turno === turno);
  });
  renderTurnoActivo();
  renderWhats();
}

function init(){
  // Fecha
  const hoy = normDateISO();
  const inputFecha = document.getElementById('fechaMov');
  if(inputFecha){
    inputFecha.value = hoy;
    inputFecha.addEventListener('change', ()=>{
      const f = inputFecha.value || hoy;
      cargarDia(f);
    });
  }

  // Tabs
  document.querySelectorAll('.tab').forEach(btn=>{
    btn.addEventListener('click', ()=> setTurnoActivo(btn.dataset.turno));
  });

  // Agregar bus
  const btnAgregarBus = document.getElementById('btnAgregarBus');
  if(btnAgregarBus){
    btnAgregarBus.addEventListener('click', ()=>{
      agregarBus(
        state.turnoActivo,
        document.getElementById('busNumero')?.value,
        document.getElementById('busConductor')?.value,
        document.getElementById('busCapacidad')?.value
      );
      // limpiar
      const n = document.getElementById('busNumero'); if(n) n.value='';
      const c = document.getElementById('busConductor'); if(c) c.value='';
      const cap = document.getElementById('busCapacidad'); if(cap) cap.value='';
    });
  }

  // Agregar salida
  const btnAgregarSalida = document.getElementById('btnAgregarSalida');
  if(btnAgregarSalida){
    btnAgregarSalida.addEventListener('click', ()=>{
      agregarSalida(
        state.turnoActivo,
        document.getElementById('salidaHora')?.value,
        document.getElementById('salidaDur')?.value,
        document.getElementById('salidaBuf')?.value,
        document.getElementById('salidaDestino')?.value,
        document.getElementById('salidaGrupos')?.value,
        document.getElementById('salidaPax')?.value
      );
      // limpiar liviano
      const dest = document.getElementById('salidaDestino'); if(dest) dest.value='';
      const grupos = document.getElementById('salidaGrupos'); if(grupos) grupos.value='';
      const pax = document.getElementById('salidaPax'); if(pax) pax.value='0';
    });
  }

  // Guardar
  const btnGuardar = document.getElementById('btnGuardar');
  if(btnGuardar) btnGuardar.addEventListener('click', guardarDia);

  // Copiar Whats
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

  // Reset en memoria (no borra Firestore)
  const btnReset = document.getElementById('btnResetDia');
  if(btnReset){
    btnReset.addEventListener('click', ()=>{
      if(!confirm('Esto resetea el día SOLO en memoria (no borra Firestore). ¿Continuar?')) return;
      state.data = {
        buses: { manana: [], tarde: [], noche: [] },
        salidas: { manana: [], tarde: [], noche: [] }
      };
      renderTodo();
    });
  }

  // cargar hoy
  cargarDia(hoy);
}

init();

