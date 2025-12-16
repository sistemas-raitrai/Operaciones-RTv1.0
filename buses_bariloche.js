// buses_bariloche.js
// Gestor de buses para grupos destino BARILOCHE.
// Usa: firebase-init.js (exporta { app, db })

import { app, db } from './firebase-init.js';
import {
  getAuth,
  onAuthStateChanged,
  signOut
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';

import {
  collection,
  getDocs,
  getDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  serverTimestamp,
  query,
  where
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';


const auth = getAuth(app);

/* ─────────────────────────────────────────────────────────
   STATE
────────────────────────────────────────────────────────── */
const state = {
  user: null,
  buses: [],        // [{id, numeroBus, capacidad, conductor, telefono, estado}]
  grupos: [],       // [{id, numeroNegocio, nombreGrupo, pax, destino}]
  traslados: [],    // lista para la fecha actual
  editingId: null,  // id del traslado que se está editando (o null)
};

/* ─────────────────────────────────────────────────────────
   UTILIDADES
────────────────────────────────────────────────────────── */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// Normaliza texto para comparar (sin tildes, minúsculas)
const norm = (s = '') =>
  s.toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

// Convierte "HH:MM" a minutos (number) para comparar rangos horarios
const toMinutes = (hhmm) => {
  if (!hhmm || typeof hhmm !== 'string' || !hhmm.includes(':')) return null;
  const [h, m] = hhmm.split(':').map((x) => parseInt(x, 10));
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
};

// Devuelve true si dos rangos horarios se solapan
// [start1, end1] y [start2, end2]
const rangesOverlap = (start1, end1, start2, end2) => {
  if (start1 == null || end1 == null || start2 == null || end2 == null) return false;
  return start1 < end2 && end1 > start2;
};

// Fecha de MAÑANA en formato YYYY-MM-DD (local, día calendario siguiente)
// Nota: dejamos el nombre todayISO para no cambiar el resto del código,
// pero internamente suma +1 día al calendario.
const todayISO = () => {
  const d = new Date();
  // Normalizamos a inicio de día y luego sumamos 1 día calendario
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);

  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

  const hoy = todayISO();
  $('#filtroFecha').value = hoy;
  $('#inputFecha').value = hoy;
  $('#lblFechaActual').textContent = hoy;

// Formatea breve la etiqueta de grupo
const labelGrupo = (g) => {
  const num = g.numeroNegocio ? `(${g.numeroNegocio}) ` : '';
  const pax = g.pax ? ` – ${g.pax} pax` : '';
  return `${num}${g.nombreGrupo}${pax}`;
};

// Encuentra grupo por id
const findGrupoById = (gid) => state.grupos.find((g) => g.id === gid) || null;

// Encuentra bus por id
const findBusById = (bid) => state.buses.find((b) => b.id === bid) || null;

// ---- Itinerario: leer actividades del grupo en una fecha ----
function pickHoraFromAct(act){
  const regexHora = /([01]\d|2[0-3]):[0-5]\d/;
  if(!act || typeof act !== 'object') return '';
  const candidatos = [act.hora, act.horario, act.horaInicio, act.horaSalida, act.horaTexto];
  for(const c of candidatos){
    if(typeof c === 'string' && regexHora.test(c)) return c.match(regexHora)[0];
  }
  for(const v of Object.values(act)){
    if(typeof v === 'string' && regexHora.test(v)) return v.match(regexHora)[0];
  }
  return '';
}

function extraerItinerarioDia(itinerarioRaw, fechaISO){
  if(!itinerarioRaw || typeof itinerarioRaw !== 'object') return [];
  const dia = itinerarioRaw[fechaISO];
  if(!dia || typeof dia !== 'object') return [];

  const acts = [];
  for(const k of Object.keys(dia)){
    const act = dia[k];
    if(!act || typeof act !== 'object') continue;
    const hora = pickHoraFromAct(act);
    const actividad = act.actividad || act.titulo || act.nombre || '(sin nombre)';
    acts.push({ hora, actividad });
  }

  // orden por hora (las sin hora al final)
  acts.sort((a,b)=>{
    const ma = toMinutes(a.hora) ?? 9999;
    const mb = toMinutes(b.hora) ?? 9999;
    return ma - mb;
  });

  return acts;
}

async function getItinerarioGrupoDia(gid, fechaISO){
  try{
    const ref = doc(db, 'grupos', gid);
    const snap = await getDoc(ref);
    if(!snap.exists()) return [];
    const data = snap.data() || {};
    const itinerario = data.itinerario || {};
    return extraerItinerarioDia(itinerario, fechaISO);
  }catch(err){
    console.error('Error leyendo itinerario del grupo', err);
    return [];
  }
}

function poblarDatalistActividades(lista){
  const dl = document.getElementById('actividadList');
  if(!dl) return;
  dl.innerHTML = '';
  // evitamos duplicados por nombre
  const seen = new Set();
  for(const a of lista){
    const key = norm(a.actividad);
    if(!key || seen.has(key)) continue;
    seen.add(key);
    const opt = document.createElement('option');
    opt.value = a.actividad;
    dl.appendChild(opt);
  }
}

/* ─────────────────────────────────────────────────────────
   MANEJO DE SESIÓN + HEADER
────────────────────────────────────────────────────────── */

function setupHeaderActions() {
  const btnHome = $('#btnHome');
  const btnRefresh = $('#btnRefresh');
  const btnBack = $('#btnBack');
  const btnLogout = $('#btnLogout');

  if (btnHome) {
    btnHome.addEventListener('click', () => {
      // Ajusta si tu home tiene otra URL
      window.location.href = 'https://sistemas-raitrai.github.io/Operaciones-RTv1.0';
    });
  }

  if (btnRefresh) {
    btnRefresh.addEventListener('click', () => {
      window.location.reload();
    });
  }

  if (btnBack) {
    btnBack.addEventListener('click', () => {
      window.history.back();
    });
  }

  if (btnLogout) {
    btnLogout.addEventListener('click', async () => {
      try {
        await signOut(auth);
      } catch (err) {
        console.error('Error al cerrar sesión', err);
      } finally {
        // Ajusta tu página de login si es distinta
        window.location.href = './index.html';
      }
    });
  }
}

/* ─────────────────────────────────────────────────────────
   CARGA INICIAL
────────────────────────────────────────────────────────── */

async function initPage(user) {
  state.user = user;

  // Seteo de fecha por defecto
  const hoy = todayISO();
  $('#filtroFecha').value = hoy;
  $('#inputFecha').value = hoy;
  $('#lblFechaActual').textContent = hoy;

  setupHeaderActions();
  setupFormListeners();

  await Promise.all([
    loadGruposBariloche(),
    loadBuses(),
  ]);

  await loadTrasladosForDate(hoy);
  refreshBusSelects();
}

// Carga grupos con destino BARILOCHE (filtrado en cliente)
async function loadGruposBariloche() {
  try {
    const snap = await getDocs(collection(db, 'grupos'));
    const grupos = [];
    snap.forEach((docSnap) => {
      const d = docSnap.data();
      const destino = d.destino || d.Destino || '';
      const destinoNorm = norm(destino);
      if (!destinoNorm.includes('bariloche')) return; // solo grupos con destino BARILOCHE

      const cantidadGrupo = d.cantidadGrupo ?? d.pax ?? d.Pax ?? null;
      const numeroNegocio = d.numeroNegocio || d.numero || d.Numero || null;
      const nombreGrupo = d.nombreGrupo || d.grupo || d.Grupo || d.nombre || 'SIN NOMBRE';

      grupos.push({
        id: docSnap.id,
        numeroNegocio,
        nombreGrupo,
        pax: cantidadGrupo,
        destino,
      });
    });

    // Ordena por número de negocio o nombre
    grupos.sort((a, b) => {
      const an = a.numeroNegocio || '';
      const bn = b.numeroNegocio || '';
      return String(an).localeCompare(String(bn));
    });

    state.grupos = grupos;
    renderSelectGrupos();
  } catch (err) {
    console.error('Error cargando grupos Bariloche', err);
  }
}

// Carga los buses desde 'buses_bariloche'
async function loadBuses() {
  try {
    const snap = await getDocs(collection(db, 'buses_bariloche'));
    const buses = [];
    snap.forEach((docSnap) => {
      const d = docSnap.data();
      buses.push({
        id: docSnap.id,
        numeroBus: d.numeroBus || d.nombre || 'BUS SIN NOMBRE',
        capacidad: d.capacidad ?? 0,
        conductor: d.conductor || 'SIN NOMBRE',
        telefono: d.telefono || '',
        estado: d.estado || 'libre',
      });
    });

    // Orden simple por numeroBus
    buses.sort((a, b) => String(a.numeroBus).localeCompare(String(b.numeroBus)));
    state.buses = buses;
    renderTablaBuses();
  } catch (err) {
    console.error('Error cargando buses_bariloche', err);
  }
}

// Carga los traslados de una fecha
async function loadTrasladosForDate(fechaISO) {
  try {
    const q = query(
      collection(db, 'buses_traslados'),
      where('fecha', '==', fechaISO)
    );
    const snap = await getDocs(q);
    const traslados = [];
    snap.forEach((docSnap) => {
      const d = docSnap.data();
      traslados.push({
        id: docSnap.id,
        ...d,
      });
    });

    // Ordena por hora de salida
    traslados.sort((a, b) => {
      const ma = toMinutes(a.salidaHora);
      const mb = toMinutes(b.salidaHora);
      return (ma || 0) - (mb || 0);
    });

    state.traslados = traslados;
    renderTablaTraslados();
    renderTablaBuses(); // para recalcular estados según traslados de la fecha
  } catch (err) {
    console.error('Error cargando traslados para fecha', fechaISO, err);
  }
}

/* ─────────────────────────────────────────────────────────
   RENDER UI
────────────────────────────────────────────────────────── */

// Rellena el select de grupos
function renderSelectGrupos() {
  const sel = $('#selGrupo');
  if (!sel) return;
  sel.innerHTML = '<option value="">— Seleccionar grupo —</option>';

  state.grupos.forEach((g) => {
    const opt = document.createElement('option');
    opt.value = g.id;
    opt.textContent = labelGrupo(g);
    sel.appendChild(opt);
  });
}

// Renderiza la tabla de buses
function renderTablaBuses() {
  const tbody = $('#tbodyBuses');
  if (!tbody) return;
  tbody.innerHTML = '';

  const fechaActual = $('#filtroFecha').value || todayISO();
  const hoy = new Date();
  const ahoraMin = hoy.getHours() * 60 + hoy.getMinutes();

  state.buses.forEach((bus) => {
    // Calculamos si el bus está ocupado hoy según traslados de la fecha
    let ocupado = false;
    let ocupadoHasta = null;
    let grupoActualLabel = null;

    for (const t of state.traslados) {
      const sameFecha = t.fecha === fechaActual;
      if (!sameFecha) continue;

      const salidaMin = toMinutes(t.salidaHora);
      const regresoMin = toMinutes(t.recogerHora);
      if (salidaMin == null || regresoMin == null) continue;

      const usaBusIda = t.busIdaId === bus.id;
      const usaBusVuelta = t.busRegresoId === bus.id;

      if (!usaBusIda && !usaBusVuelta) continue;
      if (t.estado === 'cancelado') continue;

      // Ocupado si ahora está entre salida y regreso
      if (ahoraMin >= salidaMin && ahoraMin <= regresoMin) {
        ocupado = true;
        ocupadoHasta = regresoMin;
        grupoActualLabel = t.grupoNombre || t.numeroNegocio || t.grupoId || null;
        break;
      }
    }

    const tr = document.createElement('tr');

    const tdBus = document.createElement('td');
    tdBus.textContent = bus.numeroBus;
    tr.appendChild(tdBus);

    const tdCap = document.createElement('td');
    tdCap.textContent = bus.capacidad || '—';
    tr.appendChild(tdCap);

    const tdCond = document.createElement('td');
    tdCond.textContent = bus.conductor;
    tr.appendChild(tdCond);

    const tdTel = document.createElement('td');
    if (bus.telefono) {
      const limpio = bus.telefono.replace(/[^\d]/g, '');
      const wa = document.createElement('a');
      wa.href = `https://wa.me/${limpio}`;
      wa.target = '_blank';
      wa.rel = 'noopener noreferrer';
      wa.textContent = bus.telefono;
      tdTel.appendChild(wa);
    } else {
      tdTel.textContent = '—';
    }
    tr.appendChild(tdTel);

    const tdEstado = document.createElement('td');
    tdEstado.classList.add('text-center');

    if (ocupado) {
      const pill = document.createElement('span');
      pill.className = 'pill warn';
      const horaFin = ocupadoHasta != null
        ? `${String(Math.floor(ocupadoHasta / 60)).padStart(2, '0')}:${String(ocupadoHasta % 60).padStart(2, '0')}`
        : '—';
      pill.textContent = `Ocupado hasta ${horaFin}`;
      tdEstado.appendChild(pill);

      if (grupoActualLabel) {
        const div = document.createElement('div');
        div.className = 'subnote';
        div.textContent = `Con grupo: ${grupoActualLabel}`;
        tdEstado.appendChild(div);
      }
    } else {
      const pill = document.createElement('span');
      pill.className = 'pill ok';
      pill.textContent = 'Libre';
      tdEstado.appendChild(pill);
    }

    tbody.appendChild(tr);
  });
}

// Renderiza la tabla de traslados
function renderTablaTraslados() {
  const tbody = $('#tbodyTraslados');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (!state.traslados.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.className = 'text-center muted';
    td.textContent = 'No hay traslados registrados para esta fecha.';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  for (const t of state.traslados) {
    const tr = document.createElement('tr');

    // Hora
    const tdHora = document.createElement('td');
    tdHora.textContent = `${t.salidaHora || '—'} → ${t.recogerHora || '—'}`;
    tr.appendChild(tdHora);

    // Grupo
    const tdGrupo = document.createElement('td');
    tdGrupo.textContent = t.grupoNombre || t.numeroNegocio || '—';
    tr.appendChild(tdGrupo);

    // Actividad
    const tdAct = document.createElement('td');
    tdAct.textContent = t.actividad || '—';
    tr.appendChild(tdAct);

    // Bus ida
    const tdIda = document.createElement('td');
    tdIda.textContent = t.busIdaLabel || '—';
    tr.appendChild(tdIda);

    // Bus regreso
    const tdReg = document.createElement('td');
    tdReg.textContent = t.busRegresoLabel || '—';
    tr.appendChild(tdReg);

    // Estado
    const tdEstado = document.createElement('td');
    const estado = t.estado || 'pendiente';
    const span = document.createElement('span');
    span.className = 'pill';
    let clase = 'warn';
    let texto = 'Pendiente';

    if (estado === 'pendiente') {
      clase = 'warn';
      texto = 'Pendiente';
    } else if (estado === 'en_curso') {
      clase = 'ok';
      texto = 'En curso';
    } else if (estado === 'completado') {
      clase = 'ok';
      texto = 'Completado';
    } else if (estado === 'cancelado') {
      clase = 'bad';
      texto = 'Cancelado';
    }

    span.classList.add(clase);
    span.textContent = texto;
    tdEstado.appendChild(span);
    tr.appendChild(tdEstado);

    // Acciones
    const tdAcc = document.createElement('td');
    tdAcc.className = 'text-center';
    const wrap = document.createElement('div');
    wrap.className = 'actions';

    const btnEdit = document.createElement('button');
    btnEdit.type = 'button';
    btnEdit.className = 'btn secondary';
    btnEdit.textContent = 'Editar';
    btnEdit.addEventListener('click', () => {
      startEditTraslado(t.id);
    });
    wrap.appendChild(btnEdit);

    const btnDel = document.createElement('button');
    btnDel.type = 'button';
    btnDel.className = 'btn danger';
    btnDel.textContent = 'Eliminar';
    btnDel.addEventListener('click', () => {
      deleteTraslado(t.id);
    });
    wrap.appendChild(btnDel);

    tdAcc.appendChild(wrap);
    tr.appendChild(tdAcc);

    tbody.appendChild(tr);
  }
}

/* ─────────────────────────────────────────────────────────
   SELECTS DE BUSES (DISPONIBILIDAD)
────────────────────────────────────────────────────────── */

// Recalcula los options de bus ida / bus regreso según:
// - pax del grupo
// - fecha
// - rango horario actual del formulario
function refreshBusSelects() {
  const selGrupo = $('#selGrupo');
  const grupoId = selGrupo.value || null;
  const grupo = grupoId ? findGrupoById(grupoId) : null;
  const pax = grupo?.pax ? Number(grupo.pax) : null;

  const fecha = $('#inputFecha').value || $('#filtroFecha').value || todayISO();
  const salida = $('#inputSalida').value;
  const regreso = $('#inputRegreso').value;

  const selIda = $('#selBusIda');
  const selReg = $('#selBusRegreso');

  if (!selIda || !selReg) return;

  const currentIda = selIda.value;
  const currentReg = selReg.value;

  const buildOptions = (select, keepId) => {
    select.innerHTML = '<option value="">— Seleccionar bus —</option>';

    state.buses.forEach((bus) => {
      // 1) Capacidad
      if (pax && bus.capacidad && bus.capacidad < pax) {
        // No cabe el grupo en este bus
        return;
      }

      // 2) Disponibilidad horaria (si ya hay hora)
      let disponible = true;
      const start = toMinutes(salida);
      const end = toMinutes(regreso);

      if (start != null && end != null && end > start) {
        for (const t of state.traslados) {
          if (t.fecha !== fecha) continue;
          if (t.estado === 'cancelado') continue;

          const busIds = [t.busIdaId, t.busRegresoId];
          if (!busIds.includes(bus.id)) continue;

          const tStart = toMinutes(t.salidaHora);
          const tEnd = toMinutes(t.recogerHora);
          if (rangesOverlap(start, end, tStart, tEnd)) {
            // Si estamos editando el mismo traslado, permitimos reusar el bus
            if (state.editingId && t.id === state.editingId) {
              continue;
            }
            disponible = false;
            break;
          }
        }
      }

      if (!disponible) return;

      const opt = document.createElement('option');
      opt.value = bus.id;
      opt.textContent = `${bus.numeroBus} · ${bus.capacidad || '?'} pax`;
      select.appendChild(opt);
    });

    // Si el valor anterior aún existe, lo dejamos seleccionado.
    if (keepId && keepId !== '' && select.querySelector(`option[value="${keepId}"]`)) {
      select.value = keepId;
    } else {
      select.value = '';
    }
  };

  buildOptions(selIda, currentIda);
  buildOptions(selReg, currentReg);
}

/* ─────────────────────────────────────────────────────────
   FORMULARIO (NUEVO / EDITAR)
────────────────────────────────────────────────────────── */

function setupFormListeners() {
  const filtroFecha = $('#filtroFecha');
  const inputFecha = $('#inputFecha');
  const inputSalida = $('#inputSalida');
  const inputRegreso = $('#inputRegreso');
  const selGrupo = $('#selGrupo');
  const btnNuevo = $('#btnNuevo');
  const form = $('#formTraslado');

  if (filtroFecha) {
    filtroFecha.addEventListener('change', async () => {
      const f = filtroFecha.value || todayISO();
      $('#lblFechaActual').textContent = f;
      // Sincronizamos también la fecha del formulario si estaba vacía
      if (!inputFecha.value) {
        inputFecha.value = f;
      }
      await loadTrasladosForDate(f);
      refreshBusSelects();
    });
  }

  // Calcula automáticamente "ocupado hasta" = salida + dur + buffer
  const recalcOcupadoHasta = () => {
    const salida = $('#inputSalida')?.value || '';
    const start = toMinutes(salida);
    const dur = Number($('#inputDuracion')?.value || 0);
    const buf = Number($('#inputBuffer')?.value || 0);

    if(start == null || !Number.isFinite(dur) || dur <= 0 || !Number.isFinite(buf) || buf < 0){
      $('#inputRegreso').value = '';
      return;
    }
    const end = start + dur + buf;
    const hh = String(Math.floor(end / 60)).padStart(2,'0');
    const mm = String(end % 60).padStart(2,'0');
    $('#inputRegreso').value = `${hh}:${mm}`;
  };

  if (selGrupo) {
    selGrupo.addEventListener('change', () => {
      const gid = selGrupo.value;
      const g = gid ? findGrupoById(gid) : null;
  
      // Solo autocompletamos pax del grupo
      $('#inputPax').value = g?.pax ?? '';
  
      // NO cargamos actividades automáticamente.
      // La actividad la eliges/escribes tú y recién al guardar queda registrada.
      recalcOcupadoHasta();
      refreshBusSelects();
    });
  }

  // Si cambia fecha, recargamos sugerencias de actividad del grupo seleccionado
  if (inputFecha) {
    inputFecha.addEventListener('change', async () => {
      const f = inputFecha.value || todayISO();
      $('#filtroFecha').value = f;
      $('#lblFechaActual').textContent = f;
  
      await loadTrasladosForDate(f);
  
      // NO cargamos actividades automáticamente.
      recalcOcupadoHasta();
      refreshBusSelects();
    });
  }


  // Recalcular ocupado-hasta si cambia salida / duración / buffer
  ['inputSalida','inputDuracion','inputBuffer'].forEach(id=>{
    const el = document.getElementById(id);
    if(!el) return;
    el.addEventListener('change', ()=>{
      recalcOcupadoHasta();
      refreshBusSelects();
    });
  });


  if (inputFecha) {
    inputFecha.addEventListener('change', () => {
      // Si cambias la fecha en el form, sincronizamos con el filtro para ver los traslados
      const f = inputFecha.value || todayISO();
      $('#filtroFecha').value = f;
      $('#lblFechaActual').textContent = f;
      loadTrasladosForDate(f).then(() => {
        refreshBusSelects();
      });
    });
  }

  if (inputSalida) {
    inputSalida.addEventListener('change', () => {
      refreshBusSelects();
    });
  }

  if (inputRegreso) {
    inputRegreso.addEventListener('change', () => {
      refreshBusSelects();
    });
  }

  if (btnNuevo) {
    btnNuevo.addEventListener('click', () => {
      resetForm();
    });
  }

  if (form) {
    form.addEventListener('submit', handleFormSubmit);
  }
}

// Limpia el formulario y sale del modo edición
function resetForm() {
  state.editingId = null;
  $('#estadoEdicion').textContent = 'Modo: nuevo traslado';

  const form = $('#formTraslado');
  if (form) form.reset();

  // Volvemos a setear la fecha con la del filtro
  const f = $('#filtroFecha').value || todayISO();
  $('#inputFecha').value = f;
  $('#lblFechaActual').textContent = f;

  // Pax del grupo
  $('#inputPax').value = '';
  refreshBusSelects();
}

// Carga un traslado en el formulario para editar
function startEditTraslado(trasladoId) {
  const t = state.traslados.find((x) => x.id === trasladoId);
  if (!t) return;

  state.editingId = trasladoId;
  $('#estadoEdicion').textContent = `Editando traslado (${t.grupoNombre || t.numeroNegocio || t.id})`;
  $('#btnGuardar').textContent = 'Actualizar traslado';

  // Sincronizamos fecha
  $('#inputFecha').value = t.fecha || todayISO();
  $('#filtroFecha').value = t.fecha || todayISO();
  $('#lblFechaActual').textContent = t.fecha || todayISO();

  // Grupo
  $('#selGrupo').value = t.grupoId || '';
  const g = t.grupoId ? findGrupoById(t.grupoId) : null;
  $('#inputPax').value = g?.pax ?? t.pax ?? '';

  // Actividad
  $('#inputActividad').value = t.actividad || '';

  // Horas
  $('#inputSalida').value = t.salidaHora || '';
  $('#inputRegreso').value = t.recogerHora || '';

  // Recalculamos opciones de buses y luego seteamos el seleccionado
  refreshBusSelects();

  if (t.busIdaId) $('#selBusIda').value = t.busIdaId;
  if (t.busRegresoId) $('#selBusRegreso').value = t.busRegresoId;
}

// Manejo submit (crear / actualizar)
async function handleFormSubmit(ev) {
  ev.preventDefault();

  const grupoId = $('#selGrupo').value || null;
  const fecha = $('#inputFecha').value || null;
  const salida = $('#inputSalida').value || null;
  const regreso = $('#inputRegreso').value || null;
  const actividad = $('#inputActividad').value.trim();
  const busIdaId = $('#selBusIda').value || null;
  const busRegresoId = $('#selBusRegreso').value || null;

  if (!grupoId || !fecha || !salida || !regreso || !actividad || !busIdaId || !busRegresoId) {
    alert('Completa todos los campos obligatorios.');
    return;
  }

  const start = toMinutes(salida);
  const end = toMinutes(regreso);
  if (!start || !end || end <= start) {
    alert('La hora de regreso debe ser posterior a la hora de salida.');
    return;
  }

  const grupo = findGrupoById(grupoId);
  if (!grupo) {
    alert('No se encontró el grupo seleccionado.');
    return;
  }

  const pax = grupo.pax ?? null;

  // Verificamos disponibilidad de los buses (por si algo cambió entre medio)
  const checkBus = (busId) => {
    for (const t of state.traslados) {
      if (t.fecha !== fecha) continue;
      if (t.estado === 'cancelado') continue;

      const usaBus = t.busIdaId === busId || t.busRegresoId === busId;
      if (!usaBus) continue;

      // Si es el mismo traslado que estamos editando, se permite
      if (state.editingId && t.id === state.editingId) continue;

      const tStart = toMinutes(t.salidaHora);
      const tEnd = toMinutes(t.recogerHora);
      if (rangesOverlap(start, end, tStart, tEnd)) {
        return false;
      }
    }
    return true;
  };

  if (!checkBus(busIdaId)) {
    alert('El bus de ida ya está asignado en ese horario. Elige otro bus o ajusta el horario.');
    return;
  }

  if (!checkBus(busRegresoId)) {
    alert('El bus de regreso ya está asignado en ese horario. Elige otro bus o ajusta el horario.');
    return;
  }

  const busIda = findBusById(busIdaId);
  const busReg = findBusById(busRegresoId);

  const payload = {
    fecha,
    grupoId,
    numeroNegocio: grupo.numeroNegocio || null,
    grupoNombre: grupo.nombreGrupo,
    pax: pax ? Number(pax) : null,
    actividad,
    salidaHora: salida,
    recogerHora: regreso,
    busIdaId,
    busIdaLabel: busIda
      ? `${busIda.numeroBus} · ${busIda.capacidad || '?'} pax`
      : null,
    busRegresoId,
    busRegresoLabel: busReg
      ? `${busReg.numeroBus} · ${busReg.capacidad || '?'} pax`
      : null,
    estado: 'pendiente',
    tsModificado: serverTimestamp(),
  };

  if (state.user?.email) {
    payload.modificadoPor = state.user.email;
  }

  try {
    if (state.editingId) {
      // UPDATE
      const ref = doc(db, 'buses_traslados', state.editingId);
      await updateDoc(ref, payload);
    } else {
      // CREATE
      payload.tsCreado = serverTimestamp();
      const ref = collection(db, 'buses_traslados');
      await addDoc(ref, payload);
    }

    const f = fecha;
    await loadTrasladosForDate(f);
    resetForm();
    $('#btnGuardar').textContent = 'Guardar traslado';
    refreshBusSelects();
  } catch (err) {
    console.error('Error guardando traslado', err);
    alert('Ocurrió un error al guardar el traslado. Revisa la consola.');
  }
}

// Eliminar traslado
async function deleteTraslado(trasladoId) {
  const t = state.traslados.find((x) => x.id === trasladoId);
  const label = t
    ? `${t.grupoNombre || t.numeroNegocio || trasladoId} (${t.actividad || ''})`
    : trasladoId;

  if (!confirm(`¿Eliminar definitivamente este traslado?\n\n${label}`)) {
    return;
  }

  try {
    await deleteDoc(doc(db, 'buses_traslados', trasladoId));
    const fecha = $('#filtroFecha').value || todayISO();
    await loadTrasladosForDate(fecha);
    resetForm();
  } catch (err) {
    console.error('Error eliminando traslado', err);
    alert('Ocurrió un error al eliminar el traslado.');
  }
}

/* ─────────────────────────────────────────────────────────
   ARRANQUE: VERIFICAR SESIÓN
────────────────────────────────────────────────────────── */

onAuthStateChanged(auth, (user) => {
  if (!user) {
    // Ajusta la ruta de login si es otra
    window.location.href = './index.html';
    return;
  }
  initPage(user);
});
