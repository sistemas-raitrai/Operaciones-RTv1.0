// infoviajes.js

import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs, query, where,
  doc, setDoc, updateDoc, addDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

// Elementos del DOM
const selNum      = document.getElementById('numeroNegocio');
const inpNombre   = document.getElementById('nombreGrupo');
const inpDestino  = document.getElementById('destino');
const inpPrograma = document.getElementById('programa');
const inpInicio   = document.getElementById('fechaInicio');
const inpDuracion = document.getElementById('duracion');
const inpFin      = document.getElementById('fechaFin');
const inpTotal    = document.getElementById('totalPax');
const inpAdultos  = document.getElementById('adultos');
const inpEst      = document.getElementById('estudiantes');
const selTrans    = document.getElementById('transporte');
const secTramos   = document.getElementById('seccionTramos');
const detTramos   = document.getElementById('tramosDetalle');
const selHoteles  = document.getElementById('hoteles');
const selCiudades = document.getElementById('ciudades');
const txtObs      = document.getElementById('observaciones');
const form        = document.getElementById('formInfoViaje');

// Datos temporales (hasta que tengamos Firebase para estas colecciones)
const hotelesPorDestino = {
  'Sur de Chile': ['Hotel A', 'Hotel B'],
  'Bariloche':     ['Hotel C', 'Hotel D']
};
const ciudadesPorDestino = {
  'Sur de Chile': ['Puerto Varas', 'Puerto Montt'],
  'Bariloche':     ['Centro', 'Cerro Catedral']
};

// 1) Autenticación y arranque
onAuthStateChanged(auth, user => {
  if (!user) return location.href = 'login.html';
  init();
});

async function init() {
  // 2) Cargar grupos desde Firestore
  const snap = await getDocs(collection(db, 'grupos'));
  const grupos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  // Llenar select
  selNum.innerHTML = grupos
    .map(g => `<option value="${g.id}">${g.numeroNegocio}</option>`)
    .join('');
  // 3) Al cambiar de grupo
  selNum.onchange = onGrupoChange;
  // 4) Validaciones en vivo
  inpInicio.onchange  = calcularFin;
  inpDuracion.oninput = calcularFin;
  inpAdultos.oninput  = ajustarEst;
  inpEst.oninput      = ajustarAdultos;
  selTrans.onchange   = toggleTramos;
  // 5) Envío de formulario
  form.onsubmit = guardarViaje;
  // Disparamos la primera carga
  selNum.dispatchEvent(new Event('change'));
}

async function onGrupoChange() {
  const id = selNum.value;
  if (!id) return;
  // Leer datos del grupo
  const snap = await getDocs(query(collection(db, 'grupos'), where('__name__','==',id)));
  const data = snap.docs[0].data();
  // Población de campos solo lectura
  inpNombre.value   = data.nombreGrupo;
  inpDestino.value  = data.destino;
  inpPrograma.value = data.programa;
  inpTotal.value    = data.cantidadgrupo;
  // Reiniciar fechas y composición
  inpInicio.value = '';
  inpDuracion.value = '';
  inpFin.value = '';
  inpAdultos.value = '';
  inpEst.value = '';
  selHoteles.innerHTML = '';
  selCiudades.innerHTML = '';
}

// Calcula fecha fin = inicio + duración - 1
function calcularFin() {
  const inicio = new Date(inpInicio.value);
  const dias   = parseInt(inpDuracion.value,10);
  if (isNaN(inicio) || isNaN(dias)) {
    inpFin.value = '';
    return;
  }
  const fin = new Date(inicio);
  fin.setDate(fin.getDate() + dias - 1);
  inpFin.value = fin.toISOString().slice(0,10);

  // Cargar hoteles/ciudades según destino
  const dest = inpDestino.value;
  selHoteles.innerHTML = (hotelesPorDestino[dest] || [])
    .map(h => `<option value="${h}" selected>${h}</option>`).join('');
  selCiudades.innerHTML = (ciudadesPorDestino[dest] || [])
    .map(c => `<option value="${c}" selected>${c}</option>`).join('');
}

// Si cambian adultos, ajusta estudiantes
function ajustarEst() {
  const total = parseInt(inpTotal.value,10)||0;
  const adultos = parseInt(inpAdultos.value,10)||0;
  inpEst.value = Math.max(0, total - adultos);
}
// Si cambian estudiantes, ajusta adultos
function ajustarAdultos() {
  const total = parseInt(inpTotal.value,10)||0;
  const est = parseInt(inpEst.value,10)||0;
  inpAdultos.value = Math.max(0, total - est);
}

// Muestra u oculta detalle de tramos
function toggleTramos() {
  detTramos.innerHTML = '';
  secTramos.style.display = 'none';
  if (selTrans.value === 'aereo' || selTrans.value === 'mixto') {
    secTramos.style.display = 'block';
    // Ejemplo simple, luego puedes añadir inputs dinámicos
    detTramos.innerHTML = `
      <p>Vuelo Ida: <input placeholder="Número de vuelo" /></p>
      <p>Vuelo Vta: <input placeholder="Número de vuelo" /></p>
    `;
  }
  if (selTrans.value === 'terrestre' || selTrans.value === 'mixto') {
    secTramos.style.display = 'block';
    detTramos.innerHTML += `
      <p>Bus Empresa: <input placeholder="Empresa de buses" /></p>
    `;
  }
}

// Guarda o actualiza en Firestore
async function guardarViaje(e) {
  e.preventDefault();
  const id        = selNum.value;
  const docRef    = doc(db,'viajes', id);
  const payload = {
    numeroNegocio: id,
    fechaInicio: inpInicio.value,
    duracion: parseInt(inpDuracion.value,10),
    fechaFin: inpFin.value,
    adultos: parseInt(inpAdultos.value,10),
    estudiantes: parseInt(inpEst.value,10),
    transporte: selTrans.value,
    hoteles: Array.from(selHoteles.selectedOptions).map(o=>o.value),
    ciudades: Array.from(selCiudades.selectedOptions).map(o=>o.value),
    observaciones: txtObs.value,
    usuario: auth.currentUser.email,
    actualizado: new Date()
  };
  // setDoc con merge para crear o actualizar
  await setDoc(docRef, payload, { merge:true });
  // Registro en historial
  await addDoc(collection(db,'historial'), {
    numeroNegocio: id,
    campo: 'infoViaje',
    anterior: '',
    nuevo: JSON.stringify(payload),
    modificadoPor: auth.currentUser.email,
    timestamp: new Date()
  });
  alert('Información guardada correctamente');
}
