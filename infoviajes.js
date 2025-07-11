// 0) Firebase imports
import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged }
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  doc, getDoc, updateDoc,
  collection, getDocs, addDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

// 1) DOM refs
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

// 2) Static data
const DESTINOS = ['Sur de Chile','Norte de Chile','Bariloche','Brasil'];
const PROGRAMAS = [
  'BARILOCHE 6/5','BARILOCHE 7/6',
  'CAMBORIU ECO 8/7','CAMBORIU VUELO DIRECTO 6/5','CAMBORIU VUELO DIRECTO 8/7',
  'SAN PEDRO DE ATACAMA 7/6',
  'SUR DE CHILE 7/6','SUR DE CHILE HUILO HUILO 7/6','SUR DE CHILE PUCON 7/6',
  'SUR Y BARILOCHE 7/6','SUR Y BARILOCHE 8/7'
].sort();

// map destino → hoteles
const HOTELES_MAP = {
  'Sur de Chile':      [ {name:'BORDELAGO',city:'Puerto Varas'}, {name:'VIENTOS DEL SUR',city:'Pucón'} ],
  'Norte de Chile':    [ {name:'LA ALDEA',city:'San Pedro de Atacama'} ],
  'Bariloche':         [ {name:'VILLA HUINID',city:'Bariloche'}, {name:'ECOMAX',city:'Bariloche'} ],
  'Brasil':            [ {name:'MARIMAR',city:'Camboriú'}, {name:'PLAZA CAMBORIÚ',city:'Camboriú'},
                         {name:'BRUT',city:'Camboriú'}, {name:'HM',city:'Camboriú'},
                         {name:'GERANIUM',city:'Camboriú'},{name:'MARAMBAIA',city:'Camboriú'} ]
};
HOTELES_MAP['Sur de Chile y Bariloche'] = [
  ...HOTELES_MAP['Sur de Chile'],
  ...HOTELES_MAP['Bariloche']
];

// 3) Auth + init
onAuthStateChanged(auth, user => {
  if (!user) return location.href='login.html';
  initForm();
});

async function initForm() {
  // 3.1) llenar select grupos
  const snap = await getDocs(collection(db,'grupos'));
  selNum.innerHTML = snap.docs.map(d=>
    `<option value="${d.id}">${d.data().numeroNegocio}</option>`
  ).join('');

  // 3.2) llenar datalists
  dataDest.innerHTML = DESTINOS.map(d=>`<option>${d}</option>`).join('');
  dataProg.innerHTML = PROGRAMAS.map(p=>`<option>${p}</option>`).join('');

  // 3.3) listeners
  selNum.onchange      = cargarGrupo;
  inpDestino.onchange  = onDestinoChange;
  inpPrograma.onchange = onProgramaChange;
  inpInicio.onchange   = calcularFin;
  inpDuracion.oninput  = calcularFin;
  inpAdultos.oninput   = ajustarComp;
  inpEst.oninput       = ajustarComp;
  selTran.onchange     = toggleTramos;
  btnAddTramo.onclick  = ()=> addTramo();
  btnAddHotel.onclick  = ()=> addHotelRow();
  form.onsubmit        = guardarInfo;

  // 3.4) disparar carga
  selNum.dispatchEvent(new Event('change'));
}

function onDestinoChange() {
  const d = inpDestino.value.toUpperCase();
  dataProg.innerHTML = PROGRAMAS.filter(p=>p.includes(d))
                                .map(p=>`<option>${p}</option>`).join('');
  hotelesCtr.innerHTML='';
  inpCiudades.value='';
}

function onProgramaChange() {
  const txt = inpPrograma.value;
  const m = txt.match(/(\d+)\/(\d+)$/);
  if (m) { inpDuracion.value=m[1]; calcularFin(); }
  hotelesCtr.innerHTML='';
}

function calcularFin() {
  if (!inpInicio.value||!inpDuracion.value) {
    inpFin.value=''; return;
  }
  const d = new Date(inpInicio.value);
  d.setDate(d.getDate()+Number(inpDuracion.value)-1);
  inpFin.value=d.toISOString().slice(0,10);
}

function ajustarComp(e) {
  const tot=Number(inpTotal.value)||0, a=Number(inpAdultos.value)||0, s=Number(inpEst.value)||0;
  if(e.target===inpAdultos) inpEst.value=tot-a; else inpAdultos.value=tot-s;
}

function toggleTramos() {
  const t=selTran.value;
  if(['aereo','terrestre','mixto'].includes(t)){
    seccionTramos.style.display='block';
    contTramos.innerHTML=''; tramoCount=0;
  } else {
    seccionTramos.style.display='none';
    contTramos.innerHTML=''; tramoCount=0;
  }
}

function addTramo(data={}) {
  tramoCount++;
  let html='', tipo=selTran.value;
  if(['aereo','mixto'].includes(tipo)){
    html+=`<fieldset class="tramo"><legend>Vuelo ${tramoCount}</legend>
      <label>Hora Salida (ida):<input type="time" value="${data.salida||''}"></label>
      <label>Origen (ida):<input value="${data.origen||''}"></label>
      <label>Aerolínea (ida):<input value="${data.aerolinea||''}"></label>
      <label>N° Vuelo (ida):<input value="${data.numero||''}"></label><hr>
      <label>Origen (vta):<input value="${data.origenVta||''}"></label>
      <label>Aerolínea (vta):<input value="${data.aerolineaVta||''}"></label>
      <label>N° Vuelo (vta):<input value="${data.numeroVta||''}"></label>
      <label>Hora Salida (vta):<input type="time" value="${data.salidaVta||''}"></label>
      <button type="button" class="btn-del">Eliminar</button></fieldset>`;
  }
  if(['terrestre','mixto'].includes(tipo)){
    html+=`<fieldset class="tramo"><legend>Bus ${tramoCount}</legend>
      <label>Lugar Encuentro:<input value="${data.lugar||''}"></label>
      <label>Hora Inicio:<input type="time" value="${data.hora||''}"></label>
      <label>Empresa:<input value="${data.empresa||''}"></label>
      <label>Conductor 1:<input value="${data.cond1||''}"></label>
      <label>Conductor 2:<input value="${data.cond2||''}"></label>
      <button type="button" class="btn-del">Eliminar</button></fieldset>`;
  }
  const div=document.createElement('div');
  div.innerHTML=html;
  div.querySelectorAll('.btn-del').forEach(b=>b.onclick=()=>b.closest('fieldset').remove());
  contTramos.appendChild(div);
}

function renderTramos(arr){ arr.forEach(t=>addTramo(t)); }

function addHotelRow(data={hotel:'',noches:''}) {
  const dest=inpDestino.value;
  const opts=(HOTELES_MAP[dest]||[]).map(h=>
    `<option value="${h.name}">${h.name} (${h.city})</option>`
  ).join('');
  const row=document.createElement('div');
  row.classList.add('hotel-row');
  row.innerHTML=`
    <select class="hotel-select">
      <option value="">-- Seleccionar Hotel --</option>${opts}
    </select>
    <input type="number" class="hotel-nights" min="1" placeholder="Noches" value="${data.noches||''}">
    <button type="button" class="btn-remove">×</button>`;
  row.querySelector('.btn-remove').onclick=()=>row.remove();
  hotelesCtr.appendChild(row);
}

// ——————————————————————————————
// 8.b) recalcHotels(): comprueba que la suma de noches ≤ noches del programa
// ——————————————————————————————
function recalcHotels() {
  // extrae noches máximas del programa (X/Y)
  const progMatch = inpPrograma.value.match(/\/(\d+)$/);
  const maxNoches = progMatch ? Number(progMatch[1]) : Infinity;

  // recorre las filas de hoteles y suma sus noches
  const inputs = hotelesCtr.querySelectorAll('.hotel-nights');
  let suma = 0;
  inputs.forEach(i => suma += Number(i.value) || 0);

  // si se pasa, aviso y limpio el último cambio
  if (suma > maxNoches) {
    alert(`⚠️ Has excedido el total de noches (${maxNoches}). Ajusta por favor.`);
    // quitar el valor que provocó el exceso
    const exceso = suma - maxNoches;
    const last = inputs[inputs.length - 1];
    last.value = Math.max(0, Number(last.value) - exceso);
    suma = maxNoches;
  }

  // Si quieres desactivar añadir más hoteles cuando ya llegaste:
  const btn = document.getElementById('btnAddHotel');
  btn.disabled = (suma >= maxNoches);
}

// ——————————————————————————————
// 8.c) modifica addHotelRow para enganchar recalc y city‐sync
// ——————————————————————————————
function addHotelRow(data={hotel:'',noches:''}) {
  const dest = inpDestino.value;
  const opts  = (HOTELES_MAP[dest] || []).map(h =>
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
  // al cambiar hotel: agrego ciudad
  row.querySelector('.hotel-select').onchange = e => {
    const sel = e.target.value;
    const info = (HOTELES_MAP[dest]||[]).find(h=>h.name===sel);
    if (info) {
      const set = new Set(
        inpCiudades.value.split(';')
          .map(s=>s.trim()).filter(Boolean)
      );
      set.add(info.city);
      inpCiudades.value = Array.from(set).join('; ');
    }
  };
  // al cambiar noches: recalc
  const nightsInput = row.querySelector('.hotel-nights');
  nightsInput.oninput = recalcHotels;

  row.querySelector('.btn-remove').onclick = () => {
    row.remove();
    recalcHotels();
  };

  hotelesCtr.appendChild(row);
  // y recalculo tras añadir
  recalcHotels();
}

async function cargarGrupo() {
  const id=selNum.value;
  const snap=await getDoc(doc(db,'grupos',id));
  if(!snap.exists()) return;
  const g=snap.data();

  inpNombre.value   = g.nombreGrupo||'';
  inpDestino.value  = g.destino||'';
  inpPrograma.value = g.programa||'';
  inpTotal.value    = g.cantidadgrupo||'';
  inpCoord.value    = g.coordinador||'';
  inpInicio.value   = g.fechaInicio||'';
  inpDuracion.value = g.duracion||'';
  inpAdultos.value  = g.adultos||'';
  inpEst.value      = g.estudiantes||'';
  selTran.value     = g.transporte||'';
  inpCiudades.value = (g.ciudades||[]).join('; ');
  inpObs.value      = g.observaciones||'';

  calcularFin();
  hotelesCtr.innerHTML='';
  if(Array.isArray(g.hoteles)) g.hoteles.forEach(h=>addHotelRow(h));
  if(Array.isArray(g.tramos)){
    toggleTramos(); renderTramos(g.tramos);
  } else toggleTramos();
}

async function guardarInfo(e){
  e.preventDefault();
  const id=selNum.value, refG=doc(db,'grupos',id),
        snap=await getDoc(refG), before=snap.exists()?snap.data():{};

  const tramos=[...contTramos.querySelectorAll('fieldset.tramo')].map(fs=>{
    const i=fs.querySelectorAll('input');
    return {
      salida:i[0]?.value, origen:i[1]?.value,
      aerolinea:i[2]?.value, numero:i[3]?.value,
      origenVta:i[5]?.value, aerolineaVta:i[6]?.value,
      numeroVta:i[7]?.value, salidaVta:i[8]?.value,
      lugar:i[9]?.value, hora:i[10]?.value,
      empresa:i[11]?.value, cond1:i[12]?.value, cond2:i[13]?.value
    };
  });

  const hoteles=[...hotelesCtr.querySelectorAll('.hotel-row')].map(r=>{
    return {
      nombre: r.querySelector('.hotel-select').value,
      noches: Number(r.querySelector('.hotel-nights').value)||0
    };
  });

  const payload={
    destino: inpDestino.value,
    programa: inpPrograma.value,
    coordinador: inpCoord.value,
    fechaInicio: inpInicio.value,
    duracion: Number(inpDuracion.value),
    fechaFin: inpFin.value,
    adultos: Number(inpAdultos.value),
    estudiantes: Number(inpEst.value),
    transporte: selTran.value,
    tramos, hoteles,
    ciudades: inpCiudades.value.split(';').map(s=>s.trim()).filter(Boolean),
    observaciones: inpObs.value,
    actualizadoPor: auth.currentUser.email,
    actualizadoEn: new Date()
  };

  await updateDoc(refG,payload);

  const cambios=[];
  for(let k in payload){
    if(JSON.stringify(before[k]||'')!==JSON.stringify(payload[k]||'')){
      cambios.push({ campo:k, anterior:before[k]||null, nuevo:payload[k] });
    }
  }
  if(cambios.length){
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
