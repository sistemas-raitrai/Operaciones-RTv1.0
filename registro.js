// registro.js

import { getAuth } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";
import { app, db }   from "./firebase-init.js";
import { doc, setDoc, getDoc, collection, addDoc } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js";

// 1) Constantes y mapeo
const auth     = getAuth(app);
const sheetURL = "https://script.google.com/macros/s/AKfycbzuyexFe0dUTBNtRLPL9NDdt8-elJH5gk2O_yb0vsdpTWTgx_E0R0UnPsIGzRhzTjf1JA/exec";
const campos   = [
  'numeroNegocio','nombreGrupo','cantidadgrupo','colegio','curso','anoViaje',
  'destino','programa','fechaInicio','duracion','noches','fechaFin',
  'adultos','estudiantes','asistenciaEnViajes','autorizacion','fechaDeViaje','vendedora'
];

// 2) Catálogos canónicos
const DESTINOS_CANONICOS = [
  'SUR DE CHILE',
  'BARILOCHE',
  'BRASIL',
  'SUR DE CHILE Y BARILOCHE',
  'OTRO'
];
const PROGRAMAS_POR_DESTINO = {
  'SUR DE CHILE': [
    'SUR DE CHILE 7/6',
    'SUR DE CHILE HUILO HUILO 7/6',
    'SUR DE CHILE PUCON 7/6'
  ],
  'BARILOCHE': [
    'BARILOCHE 6/5',
    'BARILOCHE 7/6'
  ],
  'BRASIL': [
    'CAMBORIÚ ECO 8/7',
    'CAMBORIÚ VUELO DIRECTO 6/5',
    'CAMBORIÚ VUELO DIRECTO 8/7'
  ],
  'SUR DE CHILE Y BARILOCHE': [
    'SUR DE CHILE Y BARILOCHE 8/7'
  ],
  'OTRO': []
};
const HOTELES_POR_DESTINO = {
  'SUR DE CHILE': [
    'BORDELAGO',
    'VIENTOS DEL SUR'
  ],
  'BARILOCHE': [
    'VILLA HUINID',
    'ECOMAX'
  ],
  'BRASIL': [
    'MARIMAR',
    'PLAZA CAMBORIÚ',
    'BRUT',
    'HM',
    'GERANIUM',
    'MARAMBAIA'
  ],
  'SUR DE CHILE Y BARILOCHE': [
    'BORDELAGO',
    'VIENTOS DEL SUR',
    'VILLA HUINID',
    'ECOMAX'
  ],
  'OTRO': []
};
let manualMode = false;

// 3) Referencias DOM
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

// 4) Auth y arranque
auth.onAuthStateChanged(user => {
  if (!user) {
    location.href = 'login.html';
  } else {
    init();
  }
});

// 5) Inicialización
async function init() {
  // 5.1) Leer ventas para datalists de negocio/nombre
  const ventas = await (await fetch(sheetURL)).json();
  const anos = [...new Set(ventas.map(r => r.anoViaje))].sort();
  elems.filtroAno.innerHTML =
    `<option value="">Todos</option>` +
    anos.map(a => `<option>${a}</option>`).join('');
  elems.filtroAno.value = new Date().getFullYear();

  // datalists negocio/nombre
  elems.filtroAno.onchange = () => {
    const y = elems.filtroAno.value;
    const list = y ? ventas.filter(r => r.anoViaje == y) : ventas;
    elems.negocioList.innerHTML =
      list.map(r => `<option value="${r.numeroNegocio}"></option>`).join('');
    elems.nombreList.innerHTML =
      list.map(r => `<option value="${r.nombreGrupo}"></option>`).join('');
  };
  elems.filtroAno.dispatchEvent(new Event('change'));

  // destinos canónicos
  elems.destinosList.innerHTML =
    DESTINOS_CANONICOS.map(d => `<option>${d}</option>`).join('');

  // listeners
  ['numeroNegocio','nombreGrupo'].forEach(id => {
    elems[id].onchange = () => loadVenta(ventas);
  });
  elems.destino.onchange     = handleDestinoChange;
  elems.programa.onchange    = handleProgramaChange;
  elems.fechaInicio.onchange = calcularFin;
  elems.adultos.oninput      = ajustComp;
  elems.estudiantes.oninput  = ajustComp;
  elems.formRegistro.onsubmit= e => { e.preventDefault(); guardar(); };
}

// 6) Cuando cambia destino
function handleDestinoChange() {
  const d = elems.destino.value;
  manualMode = (d === 'OTRO');
  // poblar lista de programas
  elems.programasList.innerHTML =
    (PROGRAMAS_POR_DESTINO[d] || []).map(p => `<option>${p}</option>`).join('');
  // poblar lista de hoteles
  elems.hoteles.innerHTML =
    (HOTELES_POR_DESTINO[d] || []).map(h => `<option value="${h}">${h}</option>`).join('');
}

// 7) Cuando cambia programa
function handleProgramaChange() {
  if (!manualMode) {
    const p = elems.programa.value;
    // normalizar destino según programa
    const dest = Object.entries(PROGRAMAS_POR_DESTINO)
      .find(([,arr]) => arr.includes(p))?.[0];
    if (dest && elems.destino.value !== dest) {
      elems.destino.value = dest;
      handleDestinoChange();
    }
    // extraer días/noches
    const m = p.match(/(\d+)\/(\d+)$/);
    if (m) {
      elems.duracion.value = m[1];
      elems.noches.value   = m[2];
    }
    calcularFin();
  }
}

// 8) Calcular fecha fin
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

// 9) Ajuste adultos/estudiantes
function ajustComp(e) {
  const total = Number(elems.cantidadgrupo.value) || 0;
  const val   = Number(e.target.value) || 0;
  if (e.target === elems.adultos) {
    elems.estudiantes.value = Math.max(0, total - val);
  } else {
    elems.adultos.value     = Math.max(0, total - val);
  }
}

// 10) Cargar grupo existente
async function loadVenta(ventas) {
  const v = ventas.find(r =>
    String(r.numeroNegocio) === elems.numeroNegocio.value ||
    r.nombreGrupo === elems.nombreGrupo.value
  );
  if (!v) return;

  // llenar campos (salvo duracion/noches/fechaFin)
  campos.forEach(c => {
    if (!['duracion','noches','fechaFin'].includes(c)) {
      elems[c].value = v[c] || '';
    }
  });

  // normalizar destino
  const dn = DESTINOS_CANONICOS.find(d => v.destino?.toUpperCase().includes(d)) || 'OTRO';
  elems.destino.value = dn;
  handleDestinoChange();

  // normalizar programa
  const pn = (PROGRAMAS_POR_DESTINO[dn] || [])
    .find(p => v.programa?.toUpperCase().includes(p)) || '';
  elems.programa.value = pn;
  handleProgramaChange();

  // fecha fin
  calcularFin();

  // preseleccionar hoteles del texto original
  const origText = v.hotel || '';
  (HOTELES_POR_DESTINO[dn] || []).forEach(h => {
    if (origText.toUpperCase().includes(h)) {
      const o = Array.from(elems.hoteles.options).find(o => o.value === h);
      if (o) o.selected = true;
    }
  });

  paintTable(v.numeroNegocio);
}

// 11) Guardar en Firestore + historial
async function guardar() {
  const id   = elems.numeroNegocio.value;
  const ref  = doc(db,'grupos',id);
  const user = auth.currentUser.email;
  const payload = {};
  campos.forEach(c => payload[c] = elems[c].value);
  payload.hoteles        = [...elems.hoteles.selectedOptions].map(o => o.value);
  payload.actualizadoPor = user;
  payload.actualizadoEn  = new Date();

  await setDoc(ref, payload, { merge:true });

  // historial
  const snapBefore = await getDoc(ref);
  const before     = snapBefore.exists() ? snapBefore.data() : {};
  const cambios    = [];
  Object.keys(payload).forEach(k => {
    if (JSON.stringify(before[k]||'') !== JSON.stringify(payload[k]||'')) {
      cambios.push({ campo:k, anterior:before[k]||null, nuevo:payload[k] });
    }
  });
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

// 12) Pintar tabla
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
  ].forEach(v => {
    const td = document.createElement('td');
    td.textContent = v || '';
    tr.appendChild(td);
  });
  tbody.appendChild(tr);
}
