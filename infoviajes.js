// ——————————————————————————————
// 0) Importes Firebase (modular v11.7.3)
// ——————————————————————————————
import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged }
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  doc, getDoc, updateDoc,
  collection, getDocs, addDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

// ——————————————————————————————
// 1) Referencias DOM
// ——————————————————————————————
const selNum        = document.getElementById('numeroNegocio');
const inpNombre     = document.getElementById('nombreGrupo');
const inpDestino    = document.getElementById('destinoInput');
const dataDest      = document.getElementById('destinosList');
const inpPrograma   = document.getElementById('programaInput');
const dataProg      = document.getElementById('programasList');
const inpCoord      = document.getElementById('coordinador');
const inpInicio     = document.getElementById('fechaInicio');
const inpDuracion   = document.getElementById('duracion');
const inpFin        = document.getElementById('fechaFin');
const inpTotal      = document.getElementById('totalPax');
const inpAdultos    = document.getElementById('adultos');
const inpEst        = document.getElementById('estudiantes');
const selTran       = document.getElementById('transporte');
const seccionTramos = document.getElementById('seccionTramos');
const contTramos    = document.getElementById('tramosDetalle');
const btnAddTramo   = document.getElementById('btnAddTramo');
const nochesCtr     = document.getElementById('nochesContainer');
const inpCiudades   = document.getElementById('ciudades');
const inpObs        = document.getElementById('observaciones');
const form          = document.getElementById('formInfoViaje');

let tramoCount = 0;

// ——————————————————————————————
// 2) Datos estáticos
// ——————————————————————————————
const DESTINOS = ['Sur de Chile','Norte de Chile','Bariloche','Brasil'];
const PROGRAMAS = [
  'BARILOCHE 6/5','BARILOCHE 7/6',
  'CAMBORIU ECO 8/7','CAMBORIU VUELO DIRECTO 6/5','CAMBORIU VUELO DIRECTO 8/7',
  'SAN PEDRO DE ATACAMA 7/6',
  'SUR DE CHILE 7/6','SUR DE CHILE HUILO HUILO 7/6','SUR DE CHILE PUCON 7/6',
  'SUR Y BARILOCHE 7/6','SUR Y BARILOCHE 8/7'
].sort();

// Map destino → lista de hoteles con ciudad
const HOTELES_MAP = {
  'Sur de Chile': [
    { name:'BORDELAGO',       city:'Puerto Varas' },
    { name:'VIENTOS DEL SUR', city:'Pucón' }
  ],
  'Norte de Chile': [
    { name:'LA ALDEA',        city:'San Pedro de Atacama' }
  ],
  'Brasil': [
    { name:'MARIMAR',         city:'Camboriú' },
    { name:'PLAZA CAMBORIÚ',  city:'Camboriú' },
    { name:'BRUT',            city:'Camboriú' },
    { name:'HM',              city:'Camboriú' },
    { name:'GERANIUM',        city:'Camboriú' },
    { name:'MARAMBAIA',       city:'Camboriú' }
  ],
  'Bariloche': [
    { name:'VILLA HUINID',    city:'Bariloche' },
    { name:'ECOMAX',          city:'Bariloche' }
  ]
};

// ——————————————————————————————
// 3) Autenticación & init
// ——————————————————————————————
onAuthStateChanged(auth, user => {
  if (!user) {
    location.href = 'login.html';
  } else {
    initForm();
  }
});

async function initForm() {
  // 3.1) Poblar select de grupos
  const snap = await getDocs(collection(db,'grupos'));
  selNum.innerHTML = snap.docs.map(d=>`
    <option value="${d.id}">${d.data().numeroNegocio}</option>
  `).join('');

  // 3.2) Poblar datalists
  dataDest.innerHTML = DESTINOS.map(d=>`<option>${d}</option>`).join('');
  dataProg.innerHTML = PROGRAMAS.map(p=>`<option>${p}</option>`).join('');

  // 3.3) Conectar listeners
  selNum.onchange       = cargarGrupo;
  inpDestino.oninput    = onDestinoChange;
  inpPrograma.oninput   = onProgramaChange;
  inpInicio.onchange    = calcularFin;
  inpDuracion.oninput   = calcularFin;
  inpAdultos.oninput    = ajustarComp;
  inpEst.oninput        = ajustarComp;
  selTran.onchange      = toggleTramos;
  btnAddTramo.onclick   = () => addTramo();
  form.onsubmit         = guardarInfo;

  // 3.4) Primera carga
  selNum.dispatchEvent(new Event('change'));
}

// ——————————————————————————————
// 4) Cuando cambia destino, filtramos programas & reset hoteles
// ——————————————————————————————
function onDestinoChange() {
  const dest = inpDestino.value.toUpperCase();
  dataProg.innerHTML = PROGRAMAS
    .filter(p => !dest || p.includes(dest))
    .map(p => `<option>${p}</option>`)
    .join('');
  // Actualiza inputs de hotel (puede haber cambiado el mapa)
  generateHotelInputs();
}

// ——————————————————————————————
// 5) Cuando cambia programa, parseo X/Y → duración + noches
// ——————————————————————————————
function onProgramaChange() {
  const m = inpPrograma.value.match(/(\d+)\/(\d+)$/);
  if (m) {
    inpDuracion.value = m[1];      // días
    calcularFin();                 // recalcular fecha fin
    generateHotelInputs(+m[2]);    // generar selects de hotel
  }
}

// ——————————————————————————————
// Recalcula fechaFin = inicio + duración - 1
// ——————————————————————————————
function calcularFin() {
  if (!inpInicio.value || !inpDuracion.value) {
    inpFin.value = '';
    return;
  }
  const d = new Date(inpInicio.value);
  d.setDate(d.getDate() + Number(inpDuracion.value) - 1);
  inpFin.value = d.toISOString().slice(0,10);
}

// ——————————————————————————————
// Mutual: adultos + estudiantes = total
// ——————————————————————————————
function ajustarComp(e) {
  const total = Number(inpTotal.value)||0;
  const a     = Number(inpAdultos.value)||0;
  const s     = Number(inpEst.value)||0;
  if (e.target===inpAdultos) inpEst.value = total - a;
  else                        inpAdultos.value = total - s;
}

// ——————————————————————————————
// Muestra/oculta sección de tramos
// ——————————————————————————————
function toggleTramos() {
  const t = selTran.value;
  if (['aereo','terrestre','mixto'].includes(t)) {
    seccionTramos.style.display = 'block';
    contTramos.innerHTML = '';
    tramoCount = 0;
  } else {
    seccionTramos.style.display = 'none';
    contTramos.innerHTML = '';
    tramoCount = 0;
  }
}

// ——————————————————————————————
// Añade un bloque de tramo (vuelo, bus o mixto)
// ——————————————————————————————
function addTramo(data={}) {
  tramoCount++;
  const tipo = selTran.value;
  let html = '';

  // **Vuelo** (ida + vuelta)
  if (['aereo','mixto'].includes(tipo)) {
    html += `
      <fieldset class="tramo">
        <legend>Vuelo ${tramoCount}</legend>
        <label>Hora Salida (ida):<input type="time" value="${data.salida||''}"></label>
        <label>Origen (ida):<input value="${data.origen||''}"></label>
        <label>Aerolínea (ida):<input value="${data.aerolinea||''}"></label>
        <label>N° Vuelo (ida):<input value="${data.numero||''}"></label>
        <hr>
        <label>Origen (vta):<input value="${data.origenVta||''}"></label>
        <label>Aerolínea (vta):<input value="${data.aerolineaVta||''}"></label>
        <label>N° Vuelo (vta):<input value="${data.numeroVta||''}"></label>
        <label>Hora Salida (vta):<input type="time" value="${data.salidaVta||''}"></label>
        <button type="button" class="btn-del">Eliminar</button>
      </fieldset>`;
  }

  // **Bus** (terrestre)
  if (['terrestre','mixto'].includes(tipo)) {
    html += `
      <fieldset class="tramo">
        <legend>Bus ${tramoCount}</legend>
        <label>Lugar Encuentro:<input value="${data.lugar||''}"></label>
        <label>Hora Inicio:<input type="time" value="${data.hora||''}"></label>
        <label>Empresa:<input value="${data.empresa||''}"></label>
        <label>Conductor 1:<input value="${data.cond1||''}"></label>
        <label>Conductor 2:<input value="${data.cond2||''}"></label>
        <button type="button" class="btn-del">Eliminar</button>
      </fieldset>`;
  }

  const div = document.createElement('div');
  div.innerHTML = html;
  // enlazar botones “Eliminar”
  div.querySelectorAll('.btn-del')
    .forEach(b => b.onclick = () => b.closest('fieldset').remove());
  contTramos.appendChild(div);
}

// ——————————————————————————————
// Renderiza tramos ya existentes
// ——————————————————————————————
function renderTramos(arr) {
  arr.forEach(t => addTramo(t));
}

// ——————————————————————————————
// Genera un <select> de hotel por cada noche
// ——————————————————————————————
function generateHotelInputs(noches) {
  nochesCtr.innerHTML = '';
  // número de noches: parámetro o (duración - 1)
  const n = noches != null
    ? noches
    : (Number(inpDuracion.value) - 1);
  const dest = inpDestino.value;
  const lista = HOTELES_MAP[dest] || [];
  for (let i = 1; i <= n; i++) {
    const label = document.createElement('label');
    label.textContent = `Noche ${i}:`;
    const sel   = document.createElement('select');
    sel.innerHTML = `<option value="">-- Hotel noche ${i} --</option>` +
      lista.map(h =>
        `<option value="${h.name}">${h.name} (${h.city})</option>`
      ).join('');
    // al elegir un hotel, añade la ciudad a “ciudades”
    sel.onchange = () => {
      const opt = lista.find(x => x.name === sel.value);
      if (opt) {
        const cs = new Set(
          inpCiudades.value.split(';')
            .map(s=>s.trim())
            .filter(Boolean)
        );
        cs.add(opt.city);
        inpCiudades.value = Array.from(cs).join('; ');
      }
    };
    nochesCtr.appendChild(label);
    nochesCtr.appendChild(sel);
  }
}

// ——————————————————————————————
// 6) Precarga TODO el formulario al cambiar de grupo
// ——————————————————————————————
async function cargarGrupo() {
  const id   = selNum.value;
  const snap = await getDoc(doc(db,'grupos',id));
  if (!snap.exists()) return;
  const g = snap.data();

  // Campos base (solo lectura)
  inpNombre.value   = g.nombreGrupo   || '';
  inpDestino.value  = g.destino       || '';
  inpPrograma.value = g.programa      || '';
  inpTotal.value    = g.cantidadgrupo || '';

  // Campos editables
  inpCoord.value    = g.coordinador   || '';
  inpInicio.value   = g.fechaInicio   || '';
  inpDuracion.value = g.duracion      || '';
  inpAdultos.value  = g.adultos       || '';
  inpEst.value      = g.estudiantes   || '';
  selTran.value     = g.transporte    || '';
  inpCiudades.value = (g.ciudades||[]).join('; ');
  inpObs.value      = g.observaciones || '';

  // Recalcular & regenerar
  calcularFin();
  // extraer noches de “programa” para el input initial
  const noches = +(g.programa.match(/\/(\d+)$/)?.[1] || 0);
  generateHotelInputs(noches);

  // Tramos previos
  if (Array.isArray(g.tramos)) {
    toggleTramos();
    renderTramos(g.tramos);
  } else {
    toggleTramos();
  }
}

// ——————————————————————————————
// 7) Guardar + registrar historial
// ——————————————————————————————
async function guardarInfo(e) {
  e.preventDefault();
  const id    = selNum.value;
  const refG  = doc(db,'grupos',id);
  const snap  = await getDoc(refG);
  const before= snap.exists()? snap.data(): {};

  // Extrae tramos actuales
  const tramos = [...contTramos.querySelectorAll('fieldset.tramo')]
    .map(fs => {
      const inp = fs.querySelectorAll('input');
      return {
        salida:       inp[0]?.value,
        origen:       inp[1]?.value,
        aerolinea:    inp[2]?.value,
        numero:       inp[3]?.value,
        origenVta:    inp[5]?.value,
        aerolineaVta: inp[6]?.value,
        numeroVta:    inp[7]?.value,
        salidaVta:    inp[8]?.value,
        lugar:        inp[9]?.value,
        hora:         inp[10]?.value,
        empresa:      inp[11]?.value,
        cond1:        inp[12]?.value,
        cond2:        inp[13]?.value
      };
    });

  // Construye payload
  const payload = {
    destino:       inpDestino.value,
    programa:      inpPrograma.value,
    coordinador:   inpCoord.value,
    fechaInicio:   inpInicio.value,
    duracion:      Number(inpDuracion.value),
    fechaFin:      inpFin.value,
    adultos:       Number(inpAdultos.value),
    estudiantes:   Number(inpEst.value),
    transporte:    selTran.value,
    tramos,
    ciudades:      inpCiudades.value.split(';').map(s=>s.trim()).filter(Boolean),
    observaciones: inpObs.value,
    actualizadoPor: auth.currentUser.email,
    actualizadoEn:  new Date()
  };

  // 7.1) Actualiza doc en grupos/{id}
  await updateDoc(refG, payload);

  // 7.2) Historial: un registro por campo modificado
  const cambios = [];
  for (let k in payload) {
    if (JSON.stringify(before[k]||'') !== JSON.stringify(payload[k]||'')) {
      cambios.push({
        campo:       k,
        anterior:    before[k] || null,
        nuevo:       payload[k]
      });
    }
  }
  if (cambios.length) {
    await Promise.all(cambios.map(c =>
      addDoc(collection(db,'historial'), {
        numeroNegocio: id,
        campo:         c.campo,
        anterior:      c.anterior,
        nuevo:         c.nuevo,
        modificadoPor: auth.currentUser.email,
        timestamp:     new Date()
      })
    ));
  }

  alert('✅ Datos guardados y registrados');
}
