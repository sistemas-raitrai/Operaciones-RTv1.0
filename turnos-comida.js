// turnos-comidas.js
// Asignador de turnos de comida (almuerzo / cena) para Bariloche.
// Versión inicial: trabaja en memoria con datos de prueba.

import { app, db } from './firebase-init.js';
// Más adelante: importamos getDocs, query, where, etc. para leer Firestore.

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
// Datos de prueba (MOCK)
// =========================
// ➜ Luego reemplazamos esta función por lectura real desde Firestore
async function cargarGruposDelDiaMock(fechaISO){
  // Puedes variar pax para ver cómo se comporta el reparto
  return [
    {
      id: 'g1',
      numeroNegocio: '1479',
      nombreGrupo: '(1479) SANTO TOMAS CURICO 3B',
      pax: 30,
      coordinador: 'VALENTÍN'
    },
    {
      id: 'g2',
      numeroNegocio: '1444',
      nombreGrupo: '(1444) CASTELGANDOLFO 3A',
      pax: 38,
      coordinador: 'COORD CASTEL'
    },
    {
      id: 'g3',
      numeroNegocio: '1486',
      nombreGrupo: '(1486) SAN JUAN 3',
      pax: 23,
      coordinador: 'COORD SAN JUAN'
    },
    {
      id: 'g4',
      numeroNegocio: '1399',
      nombreGrupo: '(1399) ALIANZA 3B',
      pax: 30,
      coordinador: 'COORD ALIANZA'
    },
    {
      id: 'g5',
      numeroNegocio: '1391',
      nombreGrupo: '(1391) MANQUECURA CIUDAD ESTE 3B',
      pax: 42,
      coordinador: 'COORD MCE'
    },
    {
      id: 'g6',
      numeroNegocio: '1407',
      nombreGrupo: '(1407) MANQUECURA CIUDAD VALLE 3B',
      pax: 36,
      coordinador: 'COORD MCV'
    }
  ];
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
    tdNombre.textContent = g.nombreGrupo;

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

// Carga de datos de un día
async function cargarDia(fechaISO){
  state.fechaISO = fechaISO;

  // TODO: aquí después usamos Firestore.
  state.grupos = await cargarGruposDelDiaMock(fechaISO);

  resetAsignacionVacia();
  renderTablaGrupos();

  // Sugerencia automática
  sugerirTurnos('almuerzo');
  sugerirTurnos('cena');
  syncSelectsConAsignacion();
  renderTurnos();
  renderTextoWhats();

  // Setear fecha en input si viene de fuera
  const inputFecha = document.getElementById('fechaTurno');
  if(inputFecha && !inputFecha.value){
    inputFecha.value = fechaISO;
  }
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
      // Aquí en el futuro: guardar en Firestore (colección turnosCasino)
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
  cargarDia(hoyISO);
}

// Como este módulo se carga al final del body, inicializamos directo
initTurnosComidas();
