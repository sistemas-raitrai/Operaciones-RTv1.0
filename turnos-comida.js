// turnos-comida.js
// Módulo de asignación de turnos de comida (almuerzo / cena) para Bariloche.

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
    almuerzo: { 1: [], 2: [], 3: [] },  // arrays de ids de grupos
    cena:     { 1: [], 2: [], 3: [] }
  }
};

// =========================
// Utilidades
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
// ➜ Reemplaza esta función por tu lectura real desde Firestore:
//    - filtrar por fecha (grupo está en Bariloche ese día)
//    - destino = "BARILOCHE" o similar
async function cargarGruposDelDiaMock(fechaISO){
  // Para probar, ignoramos la fecha y devolvemos siempre lo mismo.
  // Puedes ajustar pax y cantidad para testear límites.
  return [
    {
      id: 'g1',
      numeroNegocio: '1479',
      nombreGrupo: '(1479) SANTO TOMAS CURICO 3B',
      pax: 30,
      coordinador: 'Coordinador 1479'
    },
    {
      id: 'g2',
      numeroNegocio: '1444',
      nombreGrupo: '(1444) CASTELGANDOLFO 3A',
      pax: 38,
      coordinador: 'Coordinador 1444'
    },
    {
      id: 'g3',
      numeroNegocio: '1486',
      nombreGrupo: '(1486) SAN JUAN 3',
      pax: 23,
      coordinador: 'Coordinador 1486'
    },
    {
      id: 'g4',
      numeroNegocio: '1399',
      nombreGrupo: '(1399) ALIANZA 3B',
      pax: 30,
      coordinador: 'Coordinador 1399'
    },
    {
      id: 'g5',
      numeroNegocio: '1391',
      nombreGrupo: '(1391) MANQUECURA CIUDAD ESTE 3B',
      pax: 42,
      coordinador: 'Coordinador 1391'
    },
    {
      id: 'g6',
      numeroNegocio: '1407',
      nombreGrupo: '(1407) MANQUECURA CIUDAD VALLE 3B',
      pax: 36,
      coordinador: 'Coordinador 1407'
    }
  ];
}

// =========================
// Render de tabla de grupos
// =========================
function renderTablaGrupos(){
  const tbody = document.getElementById('tablaGruposBody');
  tbody.innerHTML = '';

  let totalPax = 0;
  for(const g of state.grupos){
    totalPax += g.pax;

    const tr = document.createElement('tr');

    const tdNeg = document.createElement('td');
    tdNeg.textContent = g.numeroNegocio;
    tdNeg.style.fontWeight = '600';
    tdNeg.style.fontSize = '11px';

    const tdNombre = document.createElement('td');
    tdNombre.textContent = g.nombreGrupo;

    const tdPax = document.createElement('td');
    tdPax.textContent = g.pax;
    tdPax.style.textAlign = 'right';

    const tdCoord = document.createElement('td');
    const coordSpan = document.createElement('span');
    coordSpan.className = 'tag';
    coordSpan.innerHTML = `<span class="tag-dot"></span><span>${g.coordinador || '—'}</span>`;
    tdCoord.appendChild(coordSpan);

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
  resumen.textContent = `${state.grupos.length} grupo(s) · ${totalPax} pax`;

  // Eventos para selects
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
 * Algoritmo sencillo tipo "greedy balanceado":
 * - Ordena grupos por pax (desc).
 * - Va tirando cada grupo al turno con menos pax acumulado
 *   mientras no se pase del maxPax; si no cabe en ninguno
 *   igual lo coloca donde haya menos, pero quedará como "sobrecupo".
 */
function sugerirTurnos(tipo){
  const maxPax = state.config.maxPax;
  const asign = state.asignacion[tipo];

  // Reset solo de ese tipo
  asign[1] = [];
  asign[2] = [];
  asign[3] = [];

  // Copia de grupos
  const gruposOrdenados = [...state.grupos].sort((a,b)=>b.pax - a.pax);

  for(const g of gruposOrdenados){
    // Totales actuales por turno
    const t1 = sumPax(asign[1]);
    const t2 = sumPax(asign[2]);
    const t3 = sumPax(asign[3]);

    // Intentar turno con menos pax que permita no pasarse del máximo
    const opciones = [
      { turno:1, total:t1 },
      { turno:2, total:t2 },
      { turno:3, total:t3 }
    ].sort((a,b)=>a.total - b.total); // ascendente

    let elegido = null;

    // 1) Intento donde no se pase del máximo
    for(const op of opciones){
      if(op.total + g.pax <= maxPax){
        elegido = op.turno;
        break;
      }
    }

    // 2) Si ninguno cabe "limpio", pongo en el más vacío (posible sobrecupo)
    if(!elegido){
      elegido = opciones[0].turno;
    }

    asign[elegido].push(g.id);
  }
}

/**
 * Tras recalcular con el motor automático, sincronizamos los selects
 * para que representen lo que hay en state.asignacion.
 */
function syncSelectsConAsignacion(){
  // Poner todos en 0
  document.querySelectorAll('.sel-almuerzo').forEach(sel => sel.value = '0');
  document.querySelectorAll('.sel-cena').forEach(sel => sel.value = '0');

  // Almuerzo
  for(const turno of [1,2,3]){
    for(const gid of state.asignacion.almuerzo[turno]){
      const sel = document.querySelector(`.sel-almuerzo[data-gid="${gid}"]`);
      if(sel) sel.value = String(turno);
    }
  }
  // Cena
  for(const turno of [1,2,3]){
    for(const gid of state.asignacion.cena[turno]){
      const sel = document.querySelector(`.sel-cena[data-gid="${gid}"]`);
      if(sel) sel.value = String(turno);
    }
  }
}

/**
 * Si el usuario mueve los selects manualmente, reconstruimos
 * state.asignacion desde esos valores.
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
  grid.innerHTML = '';

  const horasA = state.config.horas.almuerzo;
  const horasC = state.config.horas.cena;
  const maxPax = state.config.maxPax;

  // Helper estado de color
  function getEstadoClass(total){
    if(total === 0) return '';
    if(total <= maxPax) return 'turno-status-ok';
    if(total <= maxPax * 1.1) return 'turno-status-warn';
    return 'turno-status-danger';
  }

  // Helper texto estado
  function getEstadoText(total){
    if(total === 0) return 'Sin grupos';
    if(total <= maxPax) return 'Dentro de capacidad';
    if(total <= maxPax * 1.1) return 'Al límite';
    return 'Sobrecupo';
  }

  // Construir 6 tarjetas: 3 almuerzo + 3 cena
  const bloques = [
    { tipo:'almuerzo', label:'ALMUERZO', horas:horasA },
    { tipo:'cena',     label:'CENA',     horas:horasC }
  ];

  for(const bloque of bloques){
    const tipo = bloque.tipo;
    for(let t=1;t<=3;t++){
      const ids = state.asignacion[tipo][t] || [];
      const total = sumPax(ids);
      const hora = bloque.horas[t-1] || '—';
      const estadoClass = getEstadoClass(total);
      const estadoText = getEstadoText(total);

      const card = document.createElement('div');
      card.className = 'turno-card';

      const header = document.createElement('div');
      header.className = 'turno-header';
      header.innerHTML = `
        <span>${bloque.label} · TURNO ${t} · ${hora} H</span>
        <span class="turno-pill">
          <span class="turno-badge ${estadoClass}">${total} pax</span>
          <span class="${estadoClass}" style="font-size:10px;">${estadoText}</span>
        </span>
      `;

      const ul = document.createElement('ul');
      ul.className = 'turno-list';

      if(ids.length === 0){
        const li = document.createElement('li');
        li.innerHTML = '<span style="color:var(--muted);">— Sin grupos asignados —</span><span></span>';
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

  document.getElementById('resumenCapacidad').textContent =
    `Máx ${maxPax} pax por turno`;
}

// =========================
// Texto para WhatsApp / correo
// =========================
function renderTextoWhats(){
  const dateLabel = state.fechaISO || 'SIN FECHA';
  const horasA = state.config.horas.almuerzo;
  const horasC = state.config.horas.cena;
  const maxPax = state.config.maxPax;

  const lineas = [];
  lineas.push(`TURNO COMIDAS · FECHA ${formatearFechaHumana(state.fechaISO)}`);
  lineas.push(`Capacidad referencia: ${maxPax} pax por turno`);
  lineas.push('');

  // Helper para un bloque
  function pushBloque(tipo,label,horas){
    lineas.push(`➡️ ${label.toUpperCase()}:`);
    for(let t=1;t<=3;t++){
      const ids = state.asignacion[tipo][t] || [];
      const total = sumPax(ids);
      const hora = horas[t-1] || '—';
      lineas.push(``);
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
  textarea.value = lineas.join('\n');
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
// Inicialización / eventos
// =========================
async function cargarDia(fechaISO){
  state.fechaISO = fechaISO;

  // 1) Cargar grupos (mock o real)
  state.grupos = await cargarGruposDelDiaMock(fechaISO);

  // 2) Reset asignación y tabla
  resetAsignacionVacia();
  renderTablaGrupos();

  // 3) Sugerir turnos (almuerzo y cena)
  sugerirTurnos('almuerzo');
  sugerirTurnos('cena');
  syncSelectsConAsignacion();

  // 4) Render resumen
  renderTurnos();
  renderTextoWhats();
}

function leerConfigDesdeUI(){
  const maxInput = document.getElementById('maxPaxTurno');
  const alm1 = document.getElementById('horaAlm1');
  const alm2 = document.getElementById('horaAlm2');
  const alm3 = document.getElementById('horaAlm3');
  const cen1 = document.getElementById('horaCen1');
  const cen2 = document.getElementById('horaCen2');
  const cen3 = document.getElementById('horaCen3');

  const maxPax = Number(maxInput.value) || 96;
  state.config.maxPax = maxPax;
  state.config.horas.almuerzo = [alm1.value || '12:00', alm2.value || '13:00', alm3.value || '14:00'];
  state.config.horas.cena     = [cen1.value || '20:00', cen2.value || '21:00', cen3.value || '22:00'];
}

function initUI(){
  const inputFecha = document.getElementById('filtroFecha');
  const hoy = normDateISO();
  inputFecha.value = hoy;

  inputFecha.addEventListener('change', ()=>{
    const f = inputFecha.value || hoy;
    cargarDia(f);
  });

  document.getElementById('maxPaxTurno').addEventListener('change', ()=>{
    leerConfigDesdeUI();
    // Recalcular con nuevo máximo
    sugerirTurnos('almuerzo');
    sugerirTurnos('cena');
    syncSelectsConAsignacion();
    renderTurnos();
    renderTextoWhats();
  });

  // Horarios: cualquier cambio recalcula sin tocar selección manual por ahora.
  ['horaAlm1','horaAlm2','horaAlm3','horaCen1','horaCen2','horaCen3'].forEach(id=>{
    document.getElementById(id).addEventListener('change', ()=>{
      leerConfigDesdeUI();
      renderTurnos();
      renderTextoWhats();
    });
  });

  document.getElementById('btnRecalcular').addEventListener('click', ()=>{
    leerConfigDesdeUI();
    // Vuelve a usar el motor automático desde cero
    sugerirTurnos('almuerzo');
    sugerirTurnos('cena');
    syncSelectsConAsignacion();
    renderTurnos();
    renderTextoWhats();
  });

  document.getElementById('btnGuardar').addEventListener('click', ()=>{
    // Por ahora solo mostramos por consola.
    // Aquí en el futuro podrías hacer:
    // - Escribir en Firestore (colección "turnosCasino")
    // - Guardar snapshot, etc.
    console.log('Guardar turnos (mock):', JSON.stringify(state, null, 2));
    alert('Turnos guardados en memoria (mock). Luego se conecta a Firestore).');
  });

  document.getElementById('btnCopiarWhats').addEventListener('click', ()=>{
    const txt = document.getElementById('whatsText').value;
    navigator.clipboard.writeText(txt)
      .then(()=> alert('Texto copiado al portapapeles.'))
      .catch(()=> alert('No se pudo copiar automáticamente, copia manualmente.'));
  });

  // Primera carga
  leerConfigDesdeUI();
  cargarDia(hoy);
}

// Cuando carga el DOM
document.addEventListener('DOMContentLoaded', initUI);
