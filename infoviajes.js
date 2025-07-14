// 0) Firebase imports
import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged }
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  doc, getDoc, updateDoc,
  collection, getDocs, addDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

// 1) Referencias DOM
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
const btnAddHotel   = document.getElementById('btnAddHotel');
const hotelesCtr    = document.getElementById('hotelesContainer');
const inpCiudades   = document.getElementById('ciudades');
const inpObs        = document.getElementById('observaciones');
const form          = document.getElementById('formInfoViaje');

let tramoCount = 0;

// 2) Datos estáticos (mayúsculas)
const DESTINOS = [
  'SUR DE CHILE',
  'NORTE DE CHILE',
  'SUR DE CHILE Y BARILOCHE',
  'BARILOCHE',
  'BRASIL',
  'OTRO'
];
const PROGRAMAS = [
  'BARILOCHE 6/5',
  'BARILOCHE 7/6',
  'CAMBORIU ECO 8/7',
  'CAMBORIU VUELO DIRECTO 6/5',
  'CAMBORIU VUELO DIRECTO 8/7',
  'SAN PEDRO DE ATACAMA 7/6',
  'SUR DE CHILE 7/6',
  'SUR DE CHILE HUILO HUILO 7/6',
  'SUR DE CHILE PUCON 7/6',
  'SUR Y BARILOCHE 7/6',
  'SUR Y BARILOCHE 8/7'
].sort();

// Mapa destino→hoteles
const HOTELES_MAP = {
  'SUR DE CHILE': [
    { name:'BORDELAGO',      city:'Puerto Varas' },
    { name:'VIENTOS DEL SUR',city:'Pucón' }
  ],
  'NORTE DE CHILE': [
    { name:'LA ALDEA',       city:'San Pedro de Atacama' }
  ],
  'BARILOCHE': [
    { name:'VILLA HUINID',   city:'Bariloche' },
    { name:'ECOMAX',         city:'Bariloche' }
  ],
  'BRASIL': [
    { name:'MARIMAR',        city:'Camboriú' },
    { name:'PLAZA CAMBORIÚ', city:'Camboriú' },
    { name:'BRUT',           city:'Camboriú' },
    { name:'HM',             city:'Camboriú' },
    { name:'GERANIUM',       city:'Camboriú' },
    { name:'MARAMBAIA',      city:'Camboriú' }
  ]
};
// combinación especial
HOTELES_MAP['SUR DE CHILE Y BARILOCHE'] = [
  ...HOTELES_MAP['SUR DE CHILE'],
  ...HOTELES_MAP['BARILOCHE']
];

// 3) Autenticación + init
onAuthStateChanged(auth, user => {
  if (!user) location.href = 'login.html';
  else initForm();
});

async function initForm() {
  // 3.1) Poblar select grupos
  const snap = await getDocs(collection(db,'grupos'));
  selNum.innerHTML = snap.docs
    .map(d => `<option value="${d.id}">${d.data().numeroNegocio}</option>`)
    .join('');

  // 3.2) Poblar datalists
  dataDest.innerHTML = DESTINOS.map(d => `<option>${d}</option>`).join('');
  dataProg.innerHTML = PROGRAMAS.map(p => `<option>${p}</option>`).join('');

  // 3.3) Listeners
  selNum.onchange      = cargarGrupo;
  inpDestino.onchange  = onDestinoChange;
  inpPrograma.onchange = onProgramaChange;
  inpInicio.onchange   = calcularFin;
  inpDuracion.oninput  = calcularFin;
  inpAdultos.oninput   = ajustarComp;
  inpEst.oninput       = ajustarComp;
  selTran.onchange     = toggleTramos;
  btnAddTramo.onclick  = () => addTramo();
  btnAddHotel.onclick  = () => addHotelRow();
  form.onsubmit        = guardarInfo;

  // 3.4) Primera carga
  selNum.dispatchEvent(new Event('change'));
}

// 4) Cuando cambia destino: filtrar programas + limpiar hoteles/ciudades
function onDestinoChange() {
  const d = inpDestino.value.toUpperCase();
  dataProg.innerHTML = PROGRAMAS
    .filter(p => p.includes(d))
    .map(p => `<option>${p}</option>`)
    .join('');
  hotelesCtr.innerHTML = '';
  inpCiudades.value = '';
}

// 5) Cuando cambia programa: extraer X/Y → duración + limpiar hoteles
function onProgramaChange() {
  const txt = inpPrograma.value;
  const m = txt.match(/(\d+)\/(\d+)$/);
  if (m) {
    inpDuracion.value = m[1];
    calcularFin();
  }
  hotelesCtr.innerHTML = '';
}

// 6) Fecha fin = inicio + duracion – 1
function calcularFin() {
  if (!inpInicio.value || !inpDuracion.value) {
    inpFin.value = ''; return;
  }
  const d = new Date(inpInicio.value);
  d.setDate(d.getDate() + Number(inpDuracion.value) - 1);
  inpFin.value = d.toISOString().slice(0,10);
}

// 7) Adultos + estudiantes = totalPax
function ajustarComp(e) {
  const tot = Number(inpTotal.value) || 0;
  const a   = Number(inpAdultos.value) || 0;
  const s   = Number(inpEst.value) || 0;
  if (e.target === inpAdultos) inpEst.value = tot - a;
  else                          inpAdultos.value = tot - s;
}

// 8) Mostrar/ocultar tramos
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

// 9) Añadir un tramo (vuelo o bus)
function addTramo(data = {}) {
  tramoCount++;
  let html = '', tipo = selTran.value;

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
  div.querySelectorAll('.btn-del')
     .forEach(b => b.onclick = () => b.closest('fieldset').remove());
  contTramos.appendChild(div);
}

// 10) Recargar tramos existentes
function renderTramos(arr) {
  arr.forEach(t => addTramo(t));
}

// 11) Validar que la suma de noches === Y
function recalcHotels() {
  // Extraer Y del programa “X/Y”
  const m = inpPrograma.value.match(/\/(\d+)$/);
  const maxN = m ? Number(m[1]) : Infinity;

  // Sumar noches
  let suma = 0;
  hotelesCtr.querySelectorAll('.hotel-nights')
    .forEach(i => suma += Number(i.value) || 0);

  // Si distinta: bloquear guardado y avisar
  if (suma !== maxN) {
    // no dejamos que el botón "Guardar" se active
    form.querySelector('button[type=submit]').disabled = true;
  } else {
    form.querySelector('button[type=submit]').disabled = false;
  }
}

// 12) Añadir fila de hotel + noches
function addHotelRow(data = { nombre:'', noches:'' }) {
  const dest = inpDestino.value.toUpperCase();
  const opts = (HOTELES_MAP[dest] || []).map(h =>
    `<option value="${h.name}">${h.name} (${h.city})</option>`
  ).join('');

  const row = document.createElement('div');
  row.classList.add('hotel-row');
  row.innerHTML = `
    <select class="hotel-select">
      <option value="">-- Seleccionar Hotel --</option>${opts}
    </select>
    <input type="number" min="1" class="hotel-nights" placeholder="Noches" value="${data.noches||''}">
    <button type="button" class="btn-remove">×</button>
  `;

  // Al elegir hotel, añadir ciudad
  row.querySelector('.hotel-select').onchange = e => {
    const sel = e.target.value;
    const info = (HOTELES_MAP[dest]||[]).find(h => h.name === sel);
    if (info) {
      const set = new Set(
        inpCiudades.value.split(';').map(s=>s.trim()).filter(Boolean)
      );
      set.add(info.city);
      inpCiudades.value = Array.from(set).join('; ');
    }
  };

  // Al cambiar noches, revalidar
  row.querySelector('.hotel-nights').oninput = recalcHotels;

  // Botón “×” quita fila + revalida
  row.querySelector('.btn-remove').onclick = () => {
    row.remove();
    recalcHotels();
  };

  hotelesCtr.appendChild(row);
  recalcHotels();
}

// 13) Cargar grupo desde Firestore
async function cargarGrupo() {
  const id = selNum.value;
  const snap = await getDoc(doc(db,'grupos',id));
  if (!snap.exists()) return;
  const g = snap.data();

  // Rellenar campos base
  inpNombre.value   = g.nombreGrupo || '';
  inpDestino.value  = g.destino      || '';
  inpPrograma.value = g.programa     || '';
  inpTotal.value    = g.cantidadgrupo|| '';

  // Rellenar resto editable
  inpCoord.value    = g.coordinador  || '';
  inpInicio.value   = g.fechaInicio  || '';
  inpDuracion.value = g.duracion     || '';
  inpAdultos.value  = g.adultos      || '';
  inpEst.value      = g.estudiantes  || '';
  selTran.value     = g.transporte   || '';
  inpCiudades.value = (g.ciudades||[]).join('; ');
  inpObs.value      = g.observaciones|| '';

  calcularFin();

  // Hoteles existentes
  hotelesCtr.innerHTML = '';
  if (Array.isArray(g.hoteles)) {
    g.hoteles.forEach(h => addHotelRow({ nombre: h.nombre, noches: h.noches }));
  }

  // Tramos existentes
  if (Array.isArray(g.tramos)) {
    toggleTramos();
    renderTramos(g.tramos);
  } else {
    toggleTramos();
  }
}

// 14) Guardar + historial
async function guardarInfo(e) {
  e.preventDefault();

  // Validar noches exactas
  const m = inpPrograma.value.match(/\/(\d+)$/);
  const maxN = m ? Number(m[1]) : Infinity;
  let sumN = 0;
  hotelesCtr.querySelectorAll('.hotel-nights')
    .forEach(i => sumN += Number(i.value)||0);
  if (sumN !== maxN) {
    return alert(`❌ La suma de noches debe ser exactamente ${maxN}. Actualmente es ${sumN}.`);
  }

  const id = selNum.value;
  const refG = doc(db,'grupos',id);
  const snap = await getDoc(refG);
  const before = snap.exists() ? snap.data() : {};

  // Recolectar tramos
  const tramos = [...contTramos.querySelectorAll('fieldset.tramo')]
    .map(fs => {
      const i = fs.querySelectorAll('input');
      return {
        salida:      i[0]?.value, origen:      i[1]?.value,
        aerolinea:   i[2]?.value, numero:      i[3]?.value,
        origenVta:   i[5]?.value, aerolineaVta:i[6]?.value,
        numeroVta:   i[7]?.value, salidaVta:   i[8]?.value,
        lugar:       i[9]?.value, hora:        i[10]?.value,
        empresa:     i[11]?.value,cond1:       i[12]?.value,
        cond2:       i[13]?.value
      };
    });

  // Recolectar hoteles
  const hoteles = [...hotelesCtr.querySelectorAll('.hotel-row')]
    .map(r => ({
      nombre: r.querySelector('.hotel-select').value,
      noches: Number(r.querySelector('.hotel-nights').value)||0
    }));

  // Payload
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
    hoteles,
    ciudades:      inpCiudades.value.split(';').map(s=>s.trim()).filter(Boolean),
    observaciones: inpObs.value,
    actualizadoPor: auth.currentUser.email,
    actualizadoEn:  new Date()
  };

  // Update Firestore
  await updateDoc(refG, payload);

  // Historial campo a campo
  const cambios = [];
  for (let k in payload) {
    if (JSON.stringify(before[k]||'') !== JSON.stringify(payload[k]||'')) {
      cambios.push({ campo:k, anterior:before[k]||null, nuevo:payload[k] });
    }
  }
  if (cambios.length) {
    await Promise.all(cambios.map(c =>
      addDoc(collection(db,'historial'),{
        numeroNegocio:id,
        campo:        c.campo,
        anterior:     c.anterior,
        nuevo:        c.nuevo,
        modificadoPor:auth.currentUser.email,
        timestamp:    new Date()
      })
    ));
  }

  alert('✅ Datos guardados y registrados');
}
