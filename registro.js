// registro.js
import { getAuth } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";
import { app, db }   from "./firebase-init.js";
import { doc, setDoc, getDoc, collection, addDoc } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js";

// 1) Auth & Sheet URL
const auth     = getAuth(app);
const sheetURL = "https://script.google.com/macros/s/AKfycbzuyexFe0dUTBNtRLPL9NDdt8-elJH5gk2O_yb0vsdpTWTgx_E0R0UnPsIGzRhzTjf1JA/exec";

// 2) Campos del formulario
const campos = [
  'numeroNegocio','nombreGrupo','cantidadgrupo','colegio','curso','anoViaje',
  'destino','programa','fechaInicio','duracion','noches','fechaFin',
  'adultos','estudiantes','asistenciaEnViajes','autorizacion','fechaDeViaje','vendedora'
];

// 3) Catálogos actualizados
const DESTINOS_CANONICOS = [
  'SUR DE CHILE',
  'NORTE DE CHILE',                   // añadido
  'BARILOCHE',
  'BRASIL',
  'SUR DE CHILE Y BARILOCHE',
  'OTRO'
];
const PROGRAMAS_POR_DESTINO = {
  'SUR DE CHILE':             ['SUR DE CHILE 7/6','SUR DE CHILE HUILO HUILO 7/6','SUR DE CHILE PUCON 7/6'],
  'NORTE DE CHILE':           ['SAN PEDRO DE ATACAMA 7/6'],       // añadido
  'BARILOCHE':                ['BARILOCHE 6/5','BARILOCHE 7/6'],
  'BRASIL':                   ['CAMBORIÚ ECO 8/7','CAMBORIÚ VUELO DIRECTO 6/5','CAMBORIÚ VUELO DIRECTO 8/7'],
  'SUR DE CHILE Y BARILOCHE': ['SUR DE CHILE Y BARILOCHE 7/6',  // añadido
                               'SUR DE CHILE Y BARILOCHE 8/7'],
  'OTRO':                     []
};
let HOTELES_POR_DESTINO = {};  // se llenará desde Sheet
let manualMode = false;

// 4) Referencias DOM
const elems = {};
[ 'filtroAno','negocioList','nombreList','destinosList','programasList','hoteles',
  'numeroNegocio','nombreGrupo','cantidadgrupo','colegio','curso','anoViaje',
  'destino','programa','fechaInicio','duracion','noches','fechaFin',
  'adultos','estudiantes','asistenciaEnViajes','autorizacion','fechaDeViaje','vendedora',
  'formRegistro','tbodyTabla' ]
.forEach(id => elems[id] = document.getElementById(id));

// 5) Arranque Auth
auth.onAuthStateChanged(user => {
  if (!user) return location.href = 'login.html';
  init();
});

// 6) Inicialización
async function init() {
  // 6.1) Leer ventas desde Sheet
  const ventas = await (await fetch(sheetURL)).json();

  // 6.2) Filtro año → negocio/nombre
  const anos = [...new Set(ventas.map(r=>r.anoViaje))].sort();
  elems.filtroAno.innerHTML =
    `<option value="">Todos</option>` +
    anos.map(a=>`<option>${a}</option>`).join('');
  elems.filtroAno.value = new Date().getFullYear();
  elems.filtroAno.onchange = () => {
    const y = elems.filtroAno.value;
    const list = y ? ventas.filter(r=>r.anoViaje==y) : ventas;
    elems.negocioList.innerHTML = list.map(r=>`<option value="${r.numeroNegocio}"></option>`).join('');
    elems.nombreList .innerHTML = list.map(r=>`<option value="${r.nombreGrupo}"></option>`).join('');
  };
  elems.filtroAno.dispatchEvent(new Event('change'));

  // 6.3) Poblamos destinos canónicos
  elems.destinosList.innerHTML =
    DESTINOS_CANONICOS.map(d=>`<option>${d}</option>`).join('');

  // 6.4) Construir HOTELES_POR_DESTINO desde Sheet
  HOTELES_POR_DESTINO = {};
  ventas.forEach(({ destino, hotel }) => {
    if (!destino||!hotel) return;
    const d = destino.toUpperCase().trim();
    HOTELES_POR_DESTINO[d] = HOTELES_POR_DESTINO[d]||[];
    if (!HOTELES_POR_DESTINO[d].includes(hotel)) {
      HOTELES_POR_DESTINO[d].push(hotel);
    }
  });
  HOTELES_POR_DESTINO['OTRO'] = [];

  // 6.5) Listeners UI
  ['numeroNegocio','nombreGrupo'].forEach(id=>
    elems[id].onchange = () => loadVenta(ventas)
  );
  elems.destino.onchange     = handleDestinoChange;
  elems.programa.onchange    = handleProgramaChange;
  elems.fechaInicio.onchange = calcularFin;
  elems.adultos.oninput      = ajustComp;
  elems.estudiantes.oninput  = ajustComp;
  elems.formRegistro.onsubmit= e=>{ e.preventDefault(); guardar(); };
}

// 7) handleDestinoChange
function handleDestinoChange() {
  const d = elems.destino.value.toUpperCase();
  manualMode = (d==='OTRO');
  // programas
  const progs = manualMode?[]:(PROGRAMAS_POR_DESTINO[d]||[]);
  elems.programasList.innerHTML = progs.map(p=>`<option>${p}</option>`).join('');
  // hoteles
  const hots = manualMode?[]:(HOTELES_POR_DESTINO[d]||[]);
  elems.hoteles.innerHTML = hots.map(h=>`<option value="${h}">${h}</option>`).join('');
}

// 8) handleProgramaChange
function handleProgramaChange() {
  if (!manualMode) {
    const p = elems.programa.value;
    // forzar destino
    const dest = Object.entries(PROGRAMAS_POR_DESTINO)
      .find(([,arr])=>arr.includes(p))?.[0];
    if (dest&&elems.destino.value!==dest) {
      elems.destino.value = dest;
      handleDestinoChange();
    }
    // extraer días/noches
    const m = p.match(/(\d+)\/(\d+)$/);
    if (m) {
      elems.duracion.value = m[1];
      elems.noches.value   = m[2];
    }
  }
  calcularFin();
}

// 9) calcularFin
function calcularFin() {
  const inicio = elems.fechaInicio.value;
  const dias   = Number(elems.duracion.value)||0;
  if (inicio&&dias) {
    const d = new Date(inicio);
    d.setDate(d.getDate()+dias-1);
    elems.fechaFin.value = d.toISOString().slice(0,10);
  } else elems.fechaFin.value = '';
}

// 10) ajustComp
function ajustComp(e) {
  const tot = Number(elems.cantidadgrupo.value)||0;
  const val = Number(e.target.value)||0;
  if (e.target===elems.adultos)
    elems.estudiantes.value = Math.max(0,tot-val);
  else
    elems.adultos.value     = Math.max(0,tot-val);
}

// 11) loadVenta
async function loadVenta(ventas) {
  const v = ventas.find(r=>
    String(r.numeroNegocio)===elems.numeroNegocio.value||
    r.nombreGrupo===elems.nombreGrupo.value
  );
  if (!v) return;

  // datos base y libres
  elems.destino.value       = v.destino||'';
  elems.programa.value      = v.programa||'';
  elems.cantidadgrupo.value = v.cantidadgrupo||'';
  campos.forEach(c=>{
    if (!['destino','programa','duracion','noches','fechaFin','cantidadgrupo'].includes(c))
      elems[c].value = v[c]||'';
  });

  // normalizar destino
  const dn = DESTINOS_CANONICOS.find(d=>v.destino?.toUpperCase().includes(d));
  if (dn) elems.destino.value = dn;
  handleDestinoChange();

  // normalizar programa
  const pn = (PROGRAMAS_POR_DESTINO[elems.destino.value]||[])
    .find(p=>v.programa?.toUpperCase().includes(p));
  if (pn) elems.programa.value = pn;
  handleProgramaChange();

  calcularFin();

  // preseleccionar hoteles
  (HOTELES_POR_DESTINO[elems.destino.value]||[])
    .filter(h=> (v.hotel||'').toUpperCase().includes(h))
    .forEach(h=>{
      const o = Array.from(elems.hoteles.options).find(o=>o.value===h);
      if (o) o.selected = true;
    });

  paintTable(v.numeroNegocio);
}

// 12) guardar
async function guardar() {
  const id   = elems.numeroNegocio.value;
  const ref  = doc(db,'grupos',id);
  const user = auth.currentUser.email;
  const payload = {};
  campos.forEach(c=> payload[c] = elems[c].value);
  payload.hoteles        = [...elems.hoteles.selectedOptions].map(o=>o.value);
  payload.actualizadoPor = user;
  payload.actualizadoEn  = new Date();

  await setDoc(ref,payload,{merge:true});

  // historial
  const beforeSnap = await getDoc(ref);
  const before     = beforeSnap.exists()?beforeSnap.data():{};
  const cambios    = [];
  Object.keys(payload).forEach(k=>{
    if (JSON.stringify(before[k]||'')!==JSON.stringify(payload[k]||'')) {
      cambios.push({campo:k,anterior:before[k]||null,nuevo:payload[k]});
    }
  });
  if (cambios.length) {
    const col = collection(db,'historial');
    await Promise.all(cambios.map(c=>
      addDoc(col,{
        numeroNegocio:id, campo:c.campo,
        anterior:c.anterior, nuevo:c.nuevo,
        modificadoPor:user, timestamp:new Date()
      })
    ));
  }

  alert('✅ Datos guardados en Firestore');
  paintTable(id);
}

// 13) paintTable
async function paintTable(id) {
  const snap = await getDoc(doc(db,'grupos',id));
  if (!snap.exists()) return;
  const d      = snap.data();
  const tbody  = elems.tbodyTabla;
  tbody.innerHTML = '';
  const tr     = document.createElement('tr');
  [
    d.numeroNegocio,d.nombreGrupo,d.cantidadgrupo,
    d.colegio,d.curso,d.anoViaje,
    d.destino,d.programa,d.fechaInicio,
    d.duracion,d.noches,d.fechaFin,
    d.adultos,d.estudiantes,
    d.asistenciaEnViajes,d.autorizacion,d.fechaDeViaje,
    d.vendedora,(d.hoteles||[]).join(', '),
    d.actualizadoPor,d.actualizadoEn.toLocaleString()
  ].forEach(v=>{
    const td = document.createElement('td');
    td.textContent = v||'';
    tr.appendChild(td);
  });
  tbody.appendChild(tr);
}
