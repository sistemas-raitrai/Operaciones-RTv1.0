// registro.js

import { getAuth } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";
import { app, db }    from "./firebase-init.js";
import {
  doc, setDoc, getDoc,
  collection, addDoc
} from "https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js";

// Constantes y mapeo
const auth     = getAuth(app);
const sheetURL = "https://script.google.com/macros/s/AKfycbzuyexFe0dUTBNtRLPL9NDdt8-elJH5gk2O_yb0vsdpTWTgx_E0R0UnPsIGzRhzTjf1JA/exec";
const campos   = [
  'numeroNegocio','nombreGrupo','cantidadgrupo','colegio','curso','anoViaje',
  'destino','programa','fechaInicio','duracion','noches','fechaFin',
  'adultos','estudiantes','asistenciaEnViajes','autorizacion','fechaDeViaje','vendedora'
];

// Mapa destino → lista de hoteles
let HOTELES_MAP = {};

// Referencias DOM
const elems = {};
[
  'filtroAno','negocioList','nombreList','destinosList','programasList','hoteles',
  'numeroNegocio','nombreGrupo','cantidadgrupo','colegio','curso','anoViaje',
  'destino','programa','fechaInicio','duracion','noches','fechaFin',
  'adultos','estudiantes','asistenciaEnViajes','autorizacion','fechaDeViaje','vendedora',
  'formRegistro','tbodyTabla'
].forEach(id => {
  elems[id] = document.getElementById(id);
});

// Autenticación y arranque
auth.onAuthStateChanged(user => {
  if (!user) return location.href = 'login.html';
  init();
});

async function init() {
  // 1) Leer ventas desde Sheets
  const ventas = await (await fetch(sheetURL)).json();

  // 2) Rellenar filtro de años
  const anos = [...new Set(ventas.map(r=>r.anoViaje))].sort();
  elems.filtroAno.innerHTML = `<option value="">Todos</option>` +
    anos.map(a=>`<option>${a}</option>`).join('');
  elems.filtroAno.value = new Date().getFullYear();

  // 3) Construir datalists y HOTELES_MAP
  buildMaps(ventas);

  // 4) Registro de eventos
  elems.filtroAno.onchange = () => filterVentas(ventas);
  ['numeroNegocio','nombreGrupo'].forEach(id =>
    elems[id].onchange = () => loadVenta(ventas)
  );
  elems.programa.onchange   = () => { onPrograma(); calcularFin(); };
  elems.fechaInicio.onchange = calcularFin;
  elems.destino.onchange     = onDestino;
  elems.adultos.oninput      = ajustComp;
  elems.estudiantes.oninput  = ajustComp;
  elems.formRegistro.onsubmit= e => { e.preventDefault(); guardar(); };

  // trigger inicial
  elems.filtroAno.dispatchEvent(new Event('change'));
}

function buildMaps(ventas) {
  // datalists
  const dests = [...new Set(ventas.map(r=>r.destino))].sort();
  const progs = [...new Set(ventas.map(r=>r.programa))].sort();
  elems.destinosList.innerHTML  = dests.map(d=>`<option>${d}</option>`).join('');
  elems.programasList.innerHTML = progs.map(p=>`<option>${p}</option>`).join('');
  // hoteles
  dests.forEach(d => {
    HOTELES_MAP[d] = [
      ...new Set(
        ventas
          .filter(r=>r.destino===d)
          .map(r=>r.hotel)
          .filter(Boolean)
      )
    ];
  });
}

function filterVentas(ventas) {
  const y    = elems.filtroAno.value;
  const list = y ? ventas.filter(r=>r.anoViaje == y) : ventas;
  elems.negocioList.innerHTML = list.map(r=>`<option value="${r.numeroNegocio}"></option>`).join('');
  elems.nombreList.innerHTML  = list.map(r=>`<option value="${r.nombreGrupo}"></option>`).join('');
}

function loadVenta(ventas) {
  const v = ventas.find(r =>
    String(r.numeroNegocio) === elems.numeroNegocio.value ||
    r.nombreGrupo === elems.nombreGrupo.value
  );
  if (!v) return;

  // Llenado de campos (excepto duracion, noches, fechaFin)
  campos.forEach(c => {
    if (!['duracion','noches','fechaFin'].includes(c)) {
      elems[c].value = v[c] || '';
    }
  });

  // recalcular segun programa y fechaInicio
  onPrograma();
  calcularFin();

  // precargar hoteles originales
  const orig = v.hoteles || (v.hotel ? [v.hotel] : []);
  orig.forEach(hot => {
    const o = Array.from(elems.hoteles.options)
                   .find(o => o.value === hot);
    if (o) o.selected = true;
    else  elems.hoteles.add(new Option(hot, hot, true, true));
  });

  paintTable(v.numeroNegocio);
}

function onPrograma() {
  const m = elems.programa.value.match(/(\d+)\/(\d+)$/);
  if (m) {
    elems.duracion.value = m[1];
    elems.noches.value   = m[2];
  }
}

function calcularFin() {
  const inicio = elems.fechaInicio.value;
  const dias   = Number(elems.duracion.value) || 0;
  if (inicio && dias) {
    const d = new Date(inicio);
    d.setDate(d.getDate() + dias - 1);
    elems.fechaFin.value = d.toISOString().slice(0,10);
  } else {
    elems.fechaFin.value = '';
  }
}

function onDestino() {
  const d = elems.destino.value;
  elems.hoteles.innerHTML = (HOTELES_MAP[d] || [])
    .map(h=>`<option value="${h}">${h}</option>`)
    .join('');
}

function ajustComp(e) {
  const total = Number(elems.cantidadgrupo.value) || 0;
  if (e.target === elems.adultos) {
    elems.estudiantes.value = Math.max(0, total - Number(e.target.value));
  } else {
    elems.adultos.value     = Math.max(0, total - Number(e.target.value));
  }
}

async function guardar() {
  const id     = elems.numeroNegocio.value;
  const ref    = doc(db,'grupos',id);
  const user   = auth.currentUser.email;
  const payload = {};
  campos.forEach(c => payload[c] = elems[c].value);
  payload.hoteles        = [...elems.hoteles.selectedOptions].map(o=>o.value);
  payload.actualizadoPor = user;
  payload.actualizadoEn  = new Date();

  await setDoc(ref,payload,{merge:true});

  // historial
  const beforeSnap = await getDoc(ref);
  const before     = beforeSnap.exists() ? beforeSnap.data() : {};
  const cambios    = [];
  for (let k in payload) {
    if (JSON.stringify(before[k] || '') !== JSON.stringify(payload[k] || '')) {
      cambios.push({
        campo: k,
        anterior: before[k] || null,
        nuevo: payload[k]
      });
    }
  }
  if (cambios.length) {
    const col = collection(db,'historial');
    await Promise.all(cambios.map(c =>
      addDoc(col,{
        numeroNegocio: id,
        campo:         c.campo,
        anterior:      c.anterior,
        nuevo:         c.nuevo,
        modificadoPor: user,
        timestamp:     new Date()
      })
    ));
  }

  alert('✅ Datos guardados en Firestore');
  paintTable(id);
}

async function paintTable(id) {
  const snap = await getDoc(doc(db,'grupos',id));
  if (!snap.exists()) return;
  const d     = snap.data();
  const tbody = elems.tbodyTabla;
  tbody.innerHTML = '';
  const tr = document.createElement('tr');
  [
    d.numeroNegocio, d.nombreGrupo, d.cantidadgrupo,
    d.colegio,       d.curso,       d.anoViaje,
    d.destino,       d.programa,    d.fechaInicio,
    d.duracion,      d.noches,      d.fechaFin,
    d.adultos,       d.estudiantes, d.asistenciaEnViajes,
    d.autorizacion,  d.fechaDeViaje,d.vendedora,
    (d.hoteles||[]).join(', '), d.actualizadoPor,
    d.actualizadoEn.toLocaleString()
  ].forEach(v=>{
    const td = document.createElement('td');
    td.textContent = v || '';
    tr.appendChild(td);
  });
  tbody.appendChild(tr);
}
