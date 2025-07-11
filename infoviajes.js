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
const selNum       = document.getElementById('numeroNegocio');
const inpNombre    = document.getElementById('nombreGrupo');
const selDestino   = document.getElementById('destino');
const selPrograma  = document.getElementById('programa');
const inpCoord     = document.getElementById('coordinador');
const inpInicio    = document.getElementById('fechaInicio');
const inpDuracion  = document.getElementById('duracion');
const inpFin       = document.getElementById('fechaFin');
const inpTotal     = document.getElementById('totalPax');
const inpAdultos   = document.getElementById('adultos');
const inpEst       = document.getElementById('estudiantes');
const selTran      = document.getElementById('transporte');
const seccionTramos= document.getElementById('seccionTramos');
const contTramos   = document.getElementById('tramosDetalle');
const btnAddTramo  = document.getElementById('btnAddTramo');
const nochesCtr    = document.getElementById('nochesContainer');
const inpCiudades  = document.getElementById('ciudades');
const inpObs       = document.getElementById('observaciones');
const form         = document.getElementById('formInfoViaje');

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

// Mapa destino → hoteles con su ciudad
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

// 3) Auth + arranque
onAuthStateChanged(auth, user => {
  if (!user) return location.href='login.html';
  initForm();
});

// 4) initForm: pobla selects y listeners
async function initForm() {
  // 4.1) Grupos → selectNum
  const snap = await getDocs(collection(db,'grupos'));
  selNum.innerHTML = snap.docs.map(d=>{
    const o = d.data();
    return `<option value="${d.id}">${o.numeroNegocio}</option>`;
  }).join('');

  // 4.2) Destino y Programa
  selDestino.innerHTML = DESTINOS.map(d=>`<option>${d}</option>`).join('');
  selPrograma.innerHTML = PROGRAMAS.map(p=>`<option>${p}</option>`).join('');

  // 4.3) Listeners básicos
  selNum.onchange     = cargarGrupo;
  selDestino.onchange = onDestinoChange;
  selPrograma.onchange= onProgramaChange;
  inpInicio.onchange  = calcularFin;
  inpDuracion.oninput = calcularFin;
  inpAdultos.oninput  = ajustarComp;
  inpEst.oninput      = ajustarComp;
  selTran.onchange    = toggleTramos;
  btnAddTramo.onclick = ()=> addTramo();
  form.onsubmit       = guardarInfo;

  // 4.4) Primera carga
  selNum.dispatchEvent(new Event('change'));
}

// 5) Cuando cambia Destino → refiltra Programas
function onDestinoChange() {
  const d = selDestino.value;
  selPrograma.innerHTML = PROGRAMAS
    .filter(p => p.toUpperCase().includes(d.toUpperCase()))
    .map(p=>`<option>${p}</option>`).join('');
  // También recarga hoteles si ya había programa
  generateHotelInputs();
}

// 6) Cuando cambia Programa → extrae duración + noches
function onProgramaChange() {
  const txt = selPrograma.value || '';
  const m = txt.match(/(\d+)\/(\d+)$/);
  if (m) {
    inpDuracion.value = m[1];
    calcularFin();
    generateHotelInputs(Number(m[2]));
  }
}

// 7) Genera X selects de hotel según noches y destino
function generateHotelInputs(noches = Number(inpDuracion.value)-1) {
  nochesCtr.innerHTML = '';
  const dest = selDestino.value;
  const hoteles = HOTELES_MAP[dest] || [];
  for (let i=1; i<=noches; i++) {
    const sel = document.createElement('select');
    sel.innerHTML = `<option value="">Noche ${i}…</option>` +
      hoteles.map(h=>`<option value="${h.name}">${h.name} (${h.city})</option>`).join('');
    sel.onchange = () => {
      // al elegir hotel, auto-agrega ciudad
      const opt = hoteles.find(h=>h.name===sel.value);
      if (opt) {
        const list = new Set(inpCiudades.value.split(';').map(s=>s.trim()).filter(Boolean));
        list.add(opt.city);
        inpCiudades.value = Array.from(list).join('; ');
      }
    };
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `<label>Noche ${i}:</label>`;
    wrapper.appendChild(sel);
    nochesCtr.appendChild(wrapper);
  }
}

// 8) cargarGrupo: precarga todos los campos desde grupos/{id}
async function cargarGrupo() {
  const id = selNum.value;
  const snap = await getDoc(doc(db,'grupos',id));
  if (!snap.exists()) return;
  const g = snap.data();

  // Solo lectura
  inpNombre.value  = g.nombreGrupo    || '';
  selDestino.value = g.destino        || '';
  selPrograma.value= g.programa       || '';
  inpTotal.value   = g.cantidadgrupo  || '';

  // Editables
  inpCoord.value     = g.coordinador    || '';
  inpInicio.value    = g.fechaInicio    || '';
  inpDuracion.value  = g.duracion       || '';
  inpAdultos.value   = g.adultos        || '';
  inpEst.value       = g.estudiantes    || '';
  selTran.value      = g.transporte     || '';
  inpCiudades.value  = (g.ciudades||[]).join('; ');
  inpObs.value       = g.observaciones  || '';

  // Fecha fin + hoteles + tramos
  calcularFin();
  generateHotelInputs((g.programa.match(/\/(\d+)$/)||[])[1]);
  if (Array.isArray(g.tramos)) {
    toggleTramos();
    g.tramos.forEach(t=>addTramo(t));
  } else {
    toggleTramos();
  }
}

// Resto de funciones: calcularFin(), ajustarComp(), toggleTramos(), addTramo(), renderTramos(), guardarInfo()
// — idénticas a las que hemos comentado antes, pero ahora **todo** se guarda en el mismo doc “grupos/{id}”
// y cada campo modificado queda registrado en “historial”.

// …

