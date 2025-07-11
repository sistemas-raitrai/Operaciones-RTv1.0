// 0) Importes Firebase
import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged }
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  doc, getDoc, updateDoc,
  collection, getDocs, addDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

// 1) DOM
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

// 2) Datos estáticos
const DESTINOS = ['Sur de Chile','Norte de Chile','Bariloche','Brasil'];
const PROGRAMAS = [
  'BARILOCHE 6/5','BARILOCHE 7/6',
  'CAMBORIU ECO 8/7','CAMBORIU VUELO DIRECTO 6/5','CAMBORIU VUELO DIRECTO 8/7',
  'SAN PEDRO DE ATACAMA 7/6',
  'SUR DE CHILE 7/6','SUR DE CHILE HUILO HUILO 7/6','SUR DE CHILE PUCON 7/6',
  'SUR Y BARILOCHE 7/6','SUR Y BARILOCHE 8/7'
].sort();

// destino → hoteles + ciudad
const HOTELES_MAP = {
  'Sur de Chile': [
    { name:'BORDELAGO',      city:'Puerto Varas' },
    { name:'VIENTOS DEL SUR',city:'Pucón' }
  ],
  'Norte de Chile': [
    { name:'LA ALDEA',       city:'San Pedro de Atacama' }
  ],
  'Brasil': [
    { name:'MARIMAR',        city:'Camboriú' },
    { name:'PLAZA CAMBORIÚ', city:'Camboriú' },
    { name:'BRUT',           city:'Camboriú' },
    { name:'HM',             city:'Camboriú' },
    { name:'GERANIUM',       city:'Camboriú' },
    { name:'MARAMBAIA',      city:'Camboriú' }
  ],
  'Bariloche': [
    { name:'VILLA HUINID',   city:'Bariloche' },
    { name:'ECOMAX',         city:'Bariloche' }
  ]
};

// 3) Auth & init
onAuthStateChanged(auth, user => {
  if (!user) location.href='login.html';
  else initForm();
});

async function initForm() {
  // Grupos → select
  const snap = await getDocs(collection(db,'grupos'));
  selNum.innerHTML = snap.docs.map(d=>{
    return `<option value="${d.id}">${d.data().numeroNegocio}</option>`;
  }).join('');

  // datalists
  dataDest.innerHTML = DESTINOS.map(d=>`<option>${d}</option>`).join('');
  dataProg.innerHTML = PROGRAMAS.map(p=>`<option>${p}</option>`).join('');

  // listeners
  selNum.onchange     = cargarGrupo;
  inpDestino.onchange = onDestinoChange;
  inpPrograma.onchange= onProgramaChange;
  inpInicio.onchange  = calcularFin;
  inpDuracion.oninput = calcularFin;
  inpAdultos.oninput  = ajustarComp;
  inpEst.oninput      = ajustarComp;
  selTran.onchange    = toggleTramos;
  btnAddTramo.onclick = ()=> addTramo();
  form.onsubmit       = guardarInfo;

  // primera carga
  selNum.dispatchEvent(new Event('change'));
}

function onDestinoChange() {
  // refiltrar programas
  const d = inpDestino.value.toUpperCase();
  dataProg.innerHTML = PROGRAMAS
    .filter(p=>p.includes(d))
    .map(p=>`<option>${p}</option>`)
    .join('');
  // regenerar hoteles si ya hay programa
  generateHotelInputs();
}

function onProgramaChange() {
  const txt = inpPrograma.value;
  const m = txt.match(/(\d+)\/(\d+)$/);
  if (m) {
    inpDuracion.value = m[1];
    calcularFin();
    generateHotelInputs(Number(m[2]));
  }
}

function calculateDates() {
  calcularFin();
  generateHotelInputs();
}

// Extrae fechaFin = inicio + duracion -1
function calcularFin() {
  if (!inpInicio.value || !inpDuracion.value) {
    inpFin.value = '';
    return;
  }
  const d = new Date(inpInicio.value);
  d.setDate(d.getDate() + Number(inpDuracion.value) - 1);
  inpFin.value = d.toISOString().slice(0,10);
}

// Adultos/Est mutual
function ajustarComp(e) {
  const total = Number(inpTotal.value)||0;
  const a     = Number(inpAdultos.value)||0;
  const s     = Number(inpEst.value)||0;
  if (e.target===inpAdultos) inpEst.value = total - a;
  else                        inpAdultos.value = total - s;
}

// Toggle tramos
function toggleTramos() {
  const t = selTran.value;
  if (['aereo','terrestre','mixto'].includes(t)) {
    seccionTramos.style.display = 'block';
    contTramos.innerHTML = ''; tramoCount=0;
  } else {
    seccionTramos.style.display = 'none';
    contTramos.innerHTML = ''; tramoCount=0;
  }
}

// Añade un bloque de tramo
function addTramo(data={}) {
  tramoCount++;
  let html = '';
  const tipo = selTran.value;
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
  div.querySelectorAll('.btn-del').forEach(b=>b.onclick=()=>b.closest('fieldset').remove());
  contTramos.appendChild(div);
}

// Precarga tramos existentes
function renderTramos(arr) {
  arr.forEach(t=>addTramo(t));
}

// Genera selects de hotel por noche
function generateHotelInputs(noches) {
  nochesCtr.innerHTML = '';
  const prog = inpPrograma.value;
  const n = noches != null ? noches : (Number(inpDuracion.value)-1);
  const dest = inpDestino.value;
  const hoteles = HOTELES_MAP[dest] || [];
  for (let i=1; i<=n; i++) {
    const lbl = document.createElement('label');
    lbl.textContent = `Noche ${i}:`;
    const sel = document.createElement('select');
    sel.innerHTML = `<option value="">-- Hotel noche ${i} --</option>` +
      hoteles.map(h=>`<option value="${h.name}">${h.name} (${h.city})</option>`).join('');
    sel.onchange = ()=>{
      const h = hoteles.find(x=>x.name===sel.value);
      if (h) {
        const cities = new Set(inpCiudades.value.split(';').map(s=>s.trim()).filter(Boolean));
        cities.add(h.city);
        inpCiudades.value = Array.from(cities).join('; ');
      }
    };
    noitesCtr.appendChild(lbl);
    noitesCtr.appendChild(sel);
  }
}

// Precarga todo el formulario
async function cargarGrupo() {
  const id = selNum.value;
  const snap = await getDoc(doc(db,'grupos',id));
  if (!snap.exists()) return;
  const g = snap.data();

  inpNombre.value   = g.nombreGrupo   || '';
  inpDestino.value  = g.destino       || '';
  inpPrograma.value = g.programa      || '';
  inpTotal.value    = g.cantidadgrupo || '';

  inpCoord.value    = g.coordinador   || '';
  inpInicio.value   = g.fechaInicio   || '';
  inpDuracion.value = g.duracion      || '';
  inpAdultos.value  = g.adultos       || '';
  inpEst.value      = g.estudiantes   || '';
  selTran.value     = g.transporte    || '';
  inpCiudades.value = (g.ciudades||[]).join('; ');
  inpObs.value      = g.observaciones || '';

  calcularFin();
  generateHotelInputs((g.programa.match(/\/(\d+)$/)||[])[1]);
  if (Array.isArray(g.tramos)) {
    toggleTramos();
    renderTramos(g.tramos);
  } else toggleTramos();
}

// Guarda + historial
async function guardarInfo(e) {
  e.preventDefault();
  const id = selNum.value;
  const refG = doc(db,'grupos',id);
  const snap = await getDoc(refG);
  const before = snap.exists() ? snap.data() : {};

  // extrae tramos
  const tramos = [...contTramos.querySelectorAll('fieldset.tramo')].map(fs=>{
    const inp = fs.querySelectorAll('input');
    return {
      salida: inp[0]?.value, origen: inp[1]?.value,
      aerolinea: inp[2]?.value, numero: inp[3]?.value,
      origenVta: inp[5]?.value, aerolineaVta: inp[6]?.value,
      numeroVta: inp[7]?.value, salidaVta: inp[8]?.value,
      lugar: inp[9]?.value, hora: inp[10]?.value,
      empresa: inp[11]?.value, cond1: inp[12]?.value, cond2: inp[13]?.value
    };
  });

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
    hoteles:       [], // ya quedan en ciudades + historia de selección
    ciudades:      inpCiudades.value.split(';').map(s=>s.trim()).filter(Boolean),
    observaciones: inpObs.value,
    actualizadoPor: auth.currentUser.email,
    actualizadoEn:  new Date()
  };

  // update
  await updateDoc(refG, payload);

  // historial
  const cambios = [];
  for (let k in payload) {
    if (JSON.stringify(before[k]||'') !== JSON.stringify(payload[k]||'')) {
      cambios.push({ campo:k, anterior:before[k]||null, nuevo:payload[k] });
    }
  }
  if (cambios.length) {
    await Promise.all(cambios.map(c=>
      addDoc(collection(db,'historial'),{
        numeroNegocio:id, campo:c.campo,
        anterior:c.anterior, nuevo:c.nuevo,
        modificadoPor:auth.currentUser.email,
        timestamp:new Date()
      })
    ));
  }

  alert('✅ Datos guardados y registrados');
}
