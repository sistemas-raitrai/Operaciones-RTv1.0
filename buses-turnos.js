// buses-turnos.js
// Asignador MANUAL de salidas + asignación de buses por turno
// NUEVO FLUJO:
// 1) eliges Actividad (con hora inicio sugerida)
// 2) indicas duración traslado + buffer
// 3) eliges Coordinador => auto arma grupos + pax (editable)
// 4) hora salida = horaInicio - duracion (editable)
// 5) + Agregar salida => recién aparece en tabla
// 6) Calcular/Asignar buses => auto asigna (capacidad + no solape)

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
  destino: 'BARILOCHE',

  turnos: {
    manana: { label:'MAÑANA', ini:'06:00', fin:'11:59' },
    tarde:  { label:'TARDE',  ini:'12:00', fin:'18:59' },
    noche:  { label:'NOCHE',  ini:'19:00', fin:'23:59' }
  },

  // grupos cargados desde Firestore (solo para sugerencias)
  grupos: [],

  // catálogo del día (sugerencias) {label, horaInicio, actividad, lugar, gid, coordKey, grupoLabel, pax}
  actividadesDia: [],

  // selección actual del formulario
  form: {
    actividadKey: '',   // clave interna de actividad sugerida
    horaInicio: '',     // HH:MM
    actividadLabel: '', // texto visible
    durMin: 40,
    bufMin: 10,
    horaSalida: '',     // HH:MM auto
    coordKey: '',       // clave coordinador
    gruposTexto: '',
    pax: 0
  },

  turnoActivo: 'manana',

  data: {
    buses:   { manana: [], tarde: [], noche: [] },
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
  return Math.random().toString(36).slice(2,10) + Date.now().toString(36).slice(2,8);
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
   Normalización texto / destino
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
  if(typeof v.toDate === 'function') return v.toDate();
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

/* =========================
   Itinerario -> actividades del día (solo sugerencias)
========================= */
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
   Modelo bloque + solape
========================= */
function calcBloqueSalida(s){
  const start = timeToMin(s.hora);
  const dur = Number(s.duracionMin || 0);
  const buf = Number(s.bufferMin || 0);
  const end = start + dur + buf;
  return { start, end, dur, buf };
}
function solapa(a, b){
  return a.start < b.end && b.start < a.end;
}

/* =========================
   Validación salida (capacidad + solape)
========================= */
function evaluarSalida(turno, salidaId){
  const salidas = state.data.salidas[turno] || [];
  const buses   = state.data.buses[turno]   || [];
  const s = salidas.find(x => x.id === salidaId);
  if(!s) return { ok:true, level:'ok', msg:'OK' };

  if(!s.busId){
    return { ok:false, level:'warn', msg:'Sin bus' };
  }

  const bus = buses.find(b => b.id === s.busId);
  if(!bus){
    return { ok:false, level:'bad', msg:'Bus no existe' };
  }

  const pax = Number(s.pax || 0);
  if (pax > Number(bus.capacidad || 0)){
    return { ok:false, level:'bad', msg:`Sobrecupo (${pax}/${bus.capacidad})` };
  }

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
   Loader grupos del día (para sugerencias)
========================= */
async function cargarGruposDelDia(fechaISO, destinoFiltro){
  const fechaObj = new Date(`${fechaISO}T00:00:00`);
  if (isNaN(fechaObj.getTime())) return [];

  const snap = await getDocs(collection(db, 'grupos'));
  const resultados = [];

  snap.forEach(docSnap => {
    const data = docSnap.data() || {};

    // 1) Destino
    const destinoRaw = data.destino || data.destinoBase || '';
    if (!incluyeDestino(destinoRaw, destinoFiltro)) return;

    // 2) Rango fechas
    const ini = data.fechaInicioViaje || data.fechaInicio || data.inicioViaje;
    const fin = data.fechaFinViaje    || data.fechaFin    || data.finViaje;
    if (!dentroRangoFechas(fechaObj, ini, fin)) return;

    const pax = Number(data.cantidadGrupo ?? data.pax ?? data.paxTotal ?? 0);

    const numeroNegocio = data.numeroNegocio || data.numNegocio || data.numero || docSnap.id;
    const nombreGrupo   = data.nombreGrupo || data.grupo || data.nombre || '(sin nombre)';
    const coordinador   = data.coordinadorNombre || data.coordinador || data.coordNombre || '';

    resultados.push({
      id: docSnap.id,
      numeroNegocio,
      nombreGrupo,
      pax,
      coordinador,
      itinerarioRaw: data.itinerario || {}
    });
  });

  return resultados;
}

/* =========================
   Sugerencias: construir catálogo de actividades y coordinadores
========================= */
function buildActividadesDia(){
  const acts = [];
  const seen = new Set();

  for(const g of state.grupos){
    const grupoLabel = `(${g.numeroNegocio}) ${g.nombreGrupo}`;
    const coordKey = K(g.coordinador || 'SIN COORD');
    const actsDia = extraerItinerarioDia(g.itinerarioRaw || {}, state.fechaISO);

    for(const a of actsDia){
      if(!a.hora) continue;

      // clave para “deduplicar” sugerencias (hora + actividad)
      const key = `${a.hora}__${K(a.actividad)}`;
      if(seen.has(key)) continue;
      seen.add(key);

      acts.push({
        key,
        horaInicio: a.hora,
        actividad: a.actividad || '(sin nombre)',
        lugar: a.lugar || '',
        // solo para referencia (no fija grupo)
        sample: {
          gid: g.id,
          coordKey,
          grupoLabel,
          pax: Number(g.pax||0)
        }
      });
    }
  }

  acts.sort((x,y)=> timeToMin(x.horaInicio) - timeToMin(y.horaInicio));
  state.actividadesDia = acts;

  // datalist
  const dl = document.getElementById('actividadList');
  if(dl){
    dl.innerHTML = '';
    for(const a of acts){
      const opt = document.createElement('option');
      // valor visible (lo que escribes/seleccionas)
      opt.value = `${a.horaInicio} · ${a.actividad}${a.lugar ? ` · ${a.lugar}` : ''}`;
      // guardamos key para poder “resolver” luego
      opt.dataset.key = a.key;
      dl.appendChild(opt);
    }
  }
}

function buildCoordinadoresDia(){
  const sel = document.getElementById('salidaCoord');
  if(!sel) return;

  const map = new Map(); // coordKey -> {name, grupos:[]}
  for(const g of state.grupos){
    const key = K(g.coordinador || 'SIN COORD');
    const name = (g.coordinador || 'SIN COORD').toString().trim() || 'SIN COORD';
    if(!map.has(key)) map.set(key, { key, name, grupos: [] });
    map.get(key).grupos.push(g);
  }

  const coords = Array.from(map.values()).sort((a,b)=> a.name.localeCompare(b.name));
  sel.innerHTML = '<option value="">— Seleccionar —</option>';
  for(const c of coords){
    const opt = document.createElement('option');
    opt.value = c.key;
    opt.textContent = c.name;
    sel.appendChild(opt);
  }
}

/* =========================
   Form helpers (auto hora salida + coord => pax/grupos)
========================= */
function setHoraInicioUI(hhmm){
  state.form.horaInicio = hhmm || '';
  const lbl = document.getElementById('lblHoraInicio');
  if(lbl) lbl.textContent = hhmm || '—';
}

function recalcHoraSalida(){
  const iniMin = timeToMin(state.form.horaInicio);
  const dur = Number(state.form.durMin || 0);
  if(!Number.isFinite(iniMin) || !Number.isFinite(dur) || dur <= 0){
    state.form.horaSalida = '';
    const inp = document.getElementById('salidaHora');
    if(inp) inp.value = '';
    return;
  }
  const salidaMin = iniMin - dur;
  const hhmm = minToTime(salidaMin);
  state.form.horaSalida = hhmm;
  const inp = document.getElementById('salidaHora');
  if(inp) inp.value = hhmm;

  // si al recalcular cambia de turno, nos movemos al tab correspondiente
  const turno = turnoPorHora(hhmm);
  if(turno){
    setTurnoActivo(turno);
  }
}

function applyCoordinadorToForm(coordKey){
  state.form.coordKey = coordKey || '';

  const grupos = state.grupos.filter(g => K(g.coordinador || 'SIN COORD') === coordKey);
  const gruposTexto = grupos
    .map(g => `(${g.numeroNegocio}) ${g.nombreGrupo}`)
    .join(', ');
  const pax = grupos.reduce((acc,g)=> acc + Number(g.pax||0), 0);

  state.form.gruposTexto = gruposTexto;
  state.form.pax = pax;

  const inG = document.getElementById('salidaGrupos');
  const inP = document.getElementById('salidaPax');
  if(inG) inG.value = gruposTexto;
  if(inP) inP.value = String(pax);
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
  state.data.buses[turno] = (state.data.buses[turno] || []).filter(b => b.id !== busId);
  (state.data.salidas[turno] || []).forEach(s => {
    if(s.busId === busId) s.busId = null;
  });
  renderTodo();
}

/* =========================
   CRUD en memoria: salidas (manuales)
========================= */
function agregarSalidaManual(){
  // actividad
  const actTxt = (document.getElementById('salidaActividad')?.value || '').trim();
  const dur = Number(document.getElementById('salidaDur')?.value || 0);
  const buf = Number(document.getElementById('salidaBuf')?.value || 0);
  const horaSalida = (document.getElementById('salidaHora')?.value || '').trim();
  const coordKey = document.getElementById('salidaCoord')?.value || '';
  const gruposTxt = (document.getElementById('salidaGrupos')?.value || '').trim();
  const pax = Number(document.getElementById('salidaPax')?.value || 0);

  if(!actTxt){
    alert('Elige o escribe una Actividad.');
    return;
  }
  if(!Number.isFinite(dur) || dur <= 0){
    alert('Duración traslado inválida.');
    return;
  }
  if(!Number.isFinite(buf) || buf < 0){
    alert('Buffer inválido.');
    return;
  }
  if(!horaSalida || !Number.isFinite(timeToMin(horaSalida))){
    alert('Hora salida inválida (HH:MM).');
    return;
  }
  if(!coordKey){
    alert('Selecciona un Coordinador(a).');
    return;
  }

  const turno = turnoPorHora(horaSalida) || state.turnoActivo;

  state.data.salidas[turno].push({
    id: uid(),
    hora: horaSalida,
    duracionMin: dur,
    bufferMin: buf,

    // “Destino” en tabla = la actividad elegida
    destino: actTxt,

    // texto de grupos auto (editable)
    gruposTexto: gruposTxt,

    // pax auto (editable)
    pax: Number.isFinite(pax) ? pax : 0,

    // guardamos coordKey por referencia
    coordKey,

    // asignación
    busId: null
  });

  state.data.salidas[turno].sort((a,b)=> timeToMin(a.hora) - timeToMin(b.hora));

  // mover a ese turno para verlo inmediatamente
  setTurnoActivo(turno);

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
   Auto asignación buses (capacidad + no solape)
   - sólo asigna si busId está vacío
========================= */
function autoAsignarBusesTurno(turno){
  const buses = (state.data.buses[turno] || []).slice()
    .sort((a,b)=> Number(a.capacidad||0) - Number(b.capacidad||0)); // primero el más chico que sirva

  const salidas = (state.data.salidas[turno] || []).slice()
    .sort((a,b)=> timeToMin(a.hora) - timeToMin(b.hora));

  // tracks por bus: lista de bloques asignados
  const agenda = new Map(); // busId -> [{start,end}]
  for(const b of buses) agenda.set(b.id, []);

  function puedeAsignar(bus, salida){
    const pax = Number(salida.pax||0);
    if(pax > Number(bus.capacidad||0)) return false;

    const bloque = calcBloqueSalida(salida);
    if(!Number.isFinite(bloque.start) || !Number.isFinite(bloque.end)) return false;

    const slots = agenda.get(bus.id) || [];
    for(const s of slots){
      if(solapa(bloque, s)) return false;
    }
    return true;
  }

  // asignación greedy
  for(const salida of salidas){
    if(salida.busId) {
      // si ya tenía bus asignado, lo “reservamos” en agenda
      const bus = buses.find(b=> b.id === salida.busId);
      if(bus){
        const bloque = calcBloqueSalida(salida);
        if(Number.isFinite(bloque.start) && Number.isFinite(bloque.end)){
          agenda.get(bus.id).push({start: bloque.start, end: bloque.end});
        }
      }
      continue;
    }

    // busca el primer bus que pueda (por capacidad + no solape)
    let chosen = null;
    for(const bus of buses){
      if(puedeAsignar(bus, salida)){
        chosen = bus;
        break;
      }
    }

    if(chosen){
      salida.busId = chosen.id;
      const bloque = calcBloqueSalida(salida);
      agenda.get(chosen.id).push({start: bloque.start, end: bloque.end});
    }
  }

  // escribir de vuelta en state (manteniendo objetos)
  // (resolvemos por id)
  const map = new Map(salidas.map(s=>[s.id, s]));
  state.data.salidas[turno] = (state.data.salidas[turno] || []).map(s => map.get(s.id) || s);

  renderTodo();
}

/* =========================
   Firestore: busesTurnos/{fechaISO}
   - ahora guardamos buses + salidas (manuales)
========================= */
function normalizarTurnosObj(obj){
  const out = { manana: [], tarde: [], noche: [] };
  if(!obj || typeof obj !== 'object') return out;
  for(const t of ['manana','tarde','noche']){
    if(Array.isArray(obj[t])) out[t] = obj[t];
  }
  return out;
}

async function cargarDia(fechaISO){
  state.fechaISO = fechaISO;

  state.destino = document.getElementById('destinoFiltro')?.value || state.destino;

  // 1) base vacía
  state.data = {
    buses: { manana: [], tarde: [], noche: [] },
    salidas: { manana: [], tarde: [], noche: [] }
  };

  // 2) cargar grupos del día (para sugerencias)
  state.grupos = await cargarGruposDelDia(fechaISO, state.destino);

  // 3) construir sugerencias
  buildActividadesDia();
  buildCoordinadoresDia();

  // 4) cargar doc guardado (si existe)
  try{
    const ref = doc(db, 'busesTurnos', fechaISO);
    const snap = await getDoc(ref);
    if(snap.exists()){
      const data = snap.data() || {};
      if(data.buses) state.data.buses = normalizarTurnosObj(data.buses);
      if(data.salidas) state.data.salidas = normalizarTurnosObj(data.salidas);
    }
  }catch(err){
    console.error('[BusesTurnos] Error cargando día', err);
  }

  // reset form UI (sin agregar nada)
  resetFormUI();

  renderTodo();
}

async function guardarDia(){
  if(!state.fechaISO){
    alert('Selecciona una fecha.');
    return;
  }

  try{
    const ref = doc(db, 'busesTurnos', state.fechaISO);
    const payload = {
      fecha: state.fechaISO,
      destino: state.destino,
      buses: state.data.buses,
      salidas: state.data.salidas,
      updatedAt: new Date().toISOString()
    };
    await setDoc(ref, payload);
    alert('Día guardado correctamente.');
  }catch(err){
    console.error('[BusesTurnos] Error guardando día', err);
    alert('Ocurrió un error al guardar.');
  }
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

  el.textContent = `${state.fechaISO} · ${totalSalidas} salida(s) · ${totalPax} pax`;
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
      <td><b>${escapeHtml(b.numero)}</b></td>
      <td>${escapeHtml(b.conductor)}</td>
      <td class="right">${Number(b.capacidad||0)}</td>
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

    const options = [
      `<option value="">— Sin bus —</option>`,
      ...buses.map(b => `<option value="${b.id}" ${s.busId===b.id?'selected':''}>Bus ${escapeHtml(b.numero)} · ${escapeHtml(b.conductor)} (${Number(b.capacidad||0)})</option>`)
    ].join('');

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><b>${escapeHtml(s.hora)}</b></td>
      <td>
        <div><b>${escapeHtml(s.destino || '(sin destino)')}</b></div>
        <div class="muted small">${escapeHtml(s.gruposTexto || '')}</div>
      </td>
      <td class="small">${bloqueTxt}<div class="muted small">${Number(s.duracionMin||0)}m + ${Number(s.bufferMin||0)}m</div></td>
      <td class="right"><b>${Number(s.pax||0)}</b></td>
      <td>
        <select class="select-bus" data-salida="${s.id}">
          ${options}
        </select>
      </td>
      <td>
        <span class="tag"><span class="dot ${dotClass}"></span><span class="${msgClass}">${escapeHtml(ev.msg)}</span></span>
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

/* =========================
   WhatsApp
========================= */
function renderWhats(){
  const ta = document.getElementById('whatsText');
  if(!ta) return;

  const lineas = [];
  lineas.push(`🚌 MOVILIZACIÓN · FECHA ${state.fechaISO || '—'} · DESTINO ${state.destino || '—'}`);
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

/* =========================
   Form UI bindings
========================= */
function resetFormUI(){
  // No borra sugerencias; solo limpia campos
  const inAct = document.getElementById('salidaActividad');
  const inDur = document.getElementById('salidaDur');
  const inBuf = document.getElementById('salidaBuf');
  const inHora = document.getElementById('salidaHora');
  const selCoord = document.getElementById('salidaCoord');
  const inGr = document.getElementById('salidaGrupos');
  const inP = document.getElementById('salidaPax');

  if(inAct) inAct.value = '';
  if(inDur) inDur.value = 40;
  if(inBuf) inBuf.value = 10;
  if(inHora) inHora.value = '';
  if(selCoord) selCoord.value = '';
  if(inGr) inGr.value = '';
  if(inP) inP.value = '0';

  state.form = {
    actividadKey: '',
    horaInicio: '',
    actividadLabel: '',
    durMin: 40,
    bufMin: 10,
    horaSalida: '',
    coordKey: '',
    gruposTexto: '',
    pax: 0
  };
  setHoraInicioUI('');
}

function resolveActividadFromInput(){
  // Intenta matchear el string del input con alguna sugerencia (por prefijo HH:MM · ...)
  const txt = (document.getElementById('salidaActividad')?.value || '').trim();
  if(!txt){
    state.form.actividadKey = '';
    state.form.actividadLabel = '';
    setHoraInicioUI('');
    return;
  }

  // si coincide con una opción generada: "HH:MM · actividad ..."
  const m = txt.match(/^([01]\d|2[0-3]):[0-5]\d/);
  const hora = m ? m[0] : '';

  // buscamos por hora+actividad “normalizada” (lo más estable)
  const guessKey = hora ? `${hora}__${K(txt.replace(/^([01]\d|2[0-3]):[0-5]\d\s*·\s*/,'').split('·')[0])}` : '';

  const found = state.actividadesDia.find(a => a.key === guessKey)
    || state.actividadesDia.find(a => txt.startsWith(`${a.horaInicio} · ${a.actividad}`))
    || null;

  if(found){
    state.form.actividadKey = found.key;
    state.form.horaInicio = found.horaInicio;
    state.form.actividadLabel = `${found.horaInicio} · ${found.actividad}${found.lugar ? ` · ${found.lugar}` : ''}`;
    setHoraInicioUI(found.horaInicio);
  }else{
    // si no matchea, al menos intentamos usar hora del texto si existe
    state.form.actividadKey = '';
    state.form.actividadLabel = txt;
    if(hora){
      state.form.horaInicio = hora;
      setHoraInicioUI(hora);
    }else{
      state.form.horaInicio = '';
      setHoraInicioUI('');
    }
  }

  // recalcula hora salida si ya tenemos horaInicio
  state.form.durMin = Number(document.getElementById('salidaDur')?.value || 0);
  recalcHoraSalida();
}

function initFormListeners(){
  const inAct = document.getElementById('salidaActividad');
  const inDur = document.getElementById('salidaDur');
  const inBuf = document.getElementById('salidaBuf');
  const inHora = document.getElementById('salidaHora');
  const selCoord = document.getElementById('salidaCoord');

  if(inAct){
    inAct.addEventListener('change', resolveActividadFromInput);
    inAct.addEventListener('blur', resolveActividadFromInput);
  }

  if(inDur){
    inDur.addEventListener('change', ()=>{
      state.form.durMin = Number(inDur.value || 0);
      recalcHoraSalida();
    });
  }

  if(inBuf){
    inBuf.addEventListener('change', ()=>{
      state.form.bufMin = Number(inBuf.value || 0);
      // buffer afecta el bloque, no la hora salida (pero queda guardado)
    });
  }

  if(inHora){
    inHora.addEventListener('change', ()=>{
      // el usuario puede editar hora salida manualmente
      state.form.horaSalida = inHora.value || '';
      const turno = turnoPorHora(state.form.horaSalida);
      if(turno) setTurnoActivo(turno);
    });
  }

  if(selCoord){
    selCoord.addEventListener('change', ()=>{
      const key = selCoord.value || '';
      if(!key) return;
      applyCoordinadorToForm(key);
    });
  }
}

/* =========================
   Init
========================= */
function init(){
  const hoy = normDateISO();
  const inputFecha = document.getElementById('fechaMov');
  const destinoSel = document.getElementById('destinoFiltro');

  if(inputFecha){
    inputFecha.value = hoy;
    inputFecha.addEventListener('change', ()=>{
      const f = inputFecha.value || hoy;
      cargarDia(f);
    });
  }

  if(destinoSel){
    destinoSel.addEventListener('change', ()=>{
      state.destino = destinoSel.value || state.destino;
      cargarDia(state.fechaISO || hoy);
    });
  }

  document.querySelectorAll('.tab').forEach(btn=>{
    btn.addEventListener('click', ()=> setTurnoActivo(btn.dataset.turno));
  });

  initFormListeners();

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
      const n = document.getElementById('busNumero'); if(n) n.value='';
      const c = document.getElementById('busConductor'); if(c) c.value='';
      const cap = document.getElementById('busCapacidad'); if(cap) cap.value='';
    });
  }

  // Agregar salida (manual)
  const btnAgregarSalida = document.getElementById('btnAgregarSalida');
  if(btnAgregarSalida){
    btnAgregarSalida.addEventListener('click', ()=>{
      agregarSalidaManual();
      // limpiar solo lo necesario
      const inAct = document.getElementById('salidaActividad'); if(inAct) inAct.value='';
      const selCoord = document.getElementById('salidaCoord'); if(selCoord) selCoord.value='';
      const inGr = document.getElementById('salidaGrupos'); if(inGr) inGr.value='';
      const inP = document.getElementById('salidaPax'); if(inP) inP.value='0';
      const inHora = document.getElementById('salidaHora'); if(inHora) inHora.value='';
      setHoraInicioUI('');
      state.form.horaInicio = '';
      state.form.actividadKey = '';
      state.form.actividadLabel = '';
    });
  }

  // Calcular / asignar buses (turno activo)
  const btnCalcular = document.getElementById('btnCalcular');
  if(btnCalcular){
    btnCalcular.addEventListener('click', ()=>{
      autoAsignarBusesTurno(state.turnoActivo);
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

  cargarDia(hoy);
}

init();
