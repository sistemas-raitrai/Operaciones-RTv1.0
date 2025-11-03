// reservas-hoteles.js — Hotel → Grupo → Día (almuerzo/cena)
// Importes Firebase
import { app, db } from './firebase-init.js';
import {
  collection, getDocs, doc, getDoc, setDoc, updateDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';
import { getAuth, onAuthStateChanged, signOut }
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';

// =============== Estado global ===============
let HOTELES = [];          // docs de 'hoteles'
let ASIGNS  = [];          // docs de 'hotelAssignments'
let GRUPOS  = [];          // docs de 'grupos' (con itinerario)
let AGG     = new Map();   // hotelId -> { hotel, grupos: Map(grupoId -> {info, dias, totAlm, totCen}), totAlm, totCen }
let INDEX_OCUP = new Map();// grupoId -> Map(fechaISO -> { hotelId, asg })
let INDEX_ITIN = new Map();// grupoId -> Map(fechaISO -> { text, almCount, cenCount })

let DT = null;             // DataTable principal

// =============== Encabezado + Login ===============
(async function mountHeader(){
  try {
    const r = await fetch('encabezado.html');
    const html = await r.text();
    document.getElementById('encabezado').innerHTML = html;
  } catch(e) { console.warn('No pude cargar encabezado.html', e); }
})();

const auth = getAuth(app);
onAuthStateChanged(auth, user => {
  if (!user) { location.href = 'login.html'; return; }
  init();
});
document.body.addEventListener('click', (e)=>{
  if (e.target?.id === 'logoutBtn') signOut(auth);
});

// =============== Helpers ===============
const toISO = (x) => {
  if (!x) return '';
  if (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x)) return x;
  const d = new Date(x);
  return isNaN(d) ? '' : d.toISOString().slice(0,10);
};
const fmt = (iso) => {
  const d = new Date(iso + 'T00:00:00');
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}`;
};
function* eachDateISO(startISO, endISOExcl){
  let d = new Date(startISO + 'T00:00:00');
  const end = new Date(endISOExcl + 'T00:00:00');
  for (; d < end; d.setDate(d.getDate()+1)) {
    yield d.toISOString().slice(0,10);
  }
}
const stripAccents = s => (s||'').toString().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
const norm = s => stripAccents(String(s||'').toLowerCase().trim());

// ====== Años disponibles desde los días detectados (rec.porDia) ======
function populateFiltroAno(){
  const sel = document.getElementById('filtroAno');
  if (!sel) return;
  const years = new Set();

  for (const [, rec] of AGG.entries()){
    const porDia = rec.porDia || new Map();
    // porDia puede ser Object o Map
    if (porDia instanceof Map){
      for (const iso of porDia.keys()){
        if (iso && /^\d{4}-/.test(iso)) years.add(iso.slice(0,4));
      }
    } else {
      for (const iso of Object.keys(porDia || {})){
        if (iso && /^\d{4}-/.test(iso)) years.add(iso.slice(0,4));
      }
    }
  }

  const current = sel.value;
  sel.innerHTML = `<option value="">TODOS</option>` +
    Array.from(years).sort().map(y => `<option value="${y}">${y}</option>`).join('');

  // si existía selección previa, la conservamos
  if ([...years].includes(current)) sel.value = current;
}

// === Totales robustos por grupo (funciona con g.dias ó con g.totAlm/totCen) ===
function sumGrupoDesdeDias(g){
  const vals = g?.dias instanceof Map ? [...g.dias.values()]
             : Array.isArray(g?.dias) ? g.dias
             : Object.values(g?.dias || {});
  return {
    alm: vals.reduce((s,d)=> s + Number(d?.alm || 0), 0),
    cen: vals.reduce((s,d)=> s + Number(d?.cen || 0), 0),
  };
}

function totalesDeGrupo(g){
  // si hay días, SIEMPRE sumar desde g.dias
  const hasDias =
    (g?.dias instanceof Map   && g.dias.size > 0) ||
    (Array.isArray(g?.dias)   && g.dias.length > 0) ||
    (g?.dias && typeof g.dias === 'object' && Object.keys(g.dias).length > 0);

  if (hasDias) return sumGrupoDesdeDias(g);

  // fallback: usar totAlm/totCen si no hay días disponibles
  return { alm: Number(g?.totAlm || 0), cen: Number(g?.totCen || 0) };
}


// Filtra un 'rec' (entrada de AGG por hotel) solo al año indicado
function recForYear(rec, year){
  if (!year) return rec;

  const porDia = rec.porDia || new Map();

  const byDay = (porDia instanceof Map)
    ? [...porDia.entries()].filter(([iso]) => String(iso).startsWith(year + '-'))
    : Object.entries(porDia || {}).filter(([iso]) => String(iso).startsWith(year + '-'));

  const grupos = new Map();
  let totAlm = 0, totCen = 0;

  for (const [, list] of byDay){
    (list || []).forEach(it => {
      const gid = it.grupoId || it.gid || it.grupo || '';
      const g = grupos.get(gid) || {
        grupoId: gid,
        numeroNegocio: it.numeroNegocio || '',
        nombreGrupo: it.nombreGrupo || it.name || '',
        identificador: it.identificador || '',
        totAlm: 0,
        totCen: 0
      };
      g.totAlm += Number(it.alm || 0);
      g.totCen += Number(it.cen || 0);
      grupos.set(gid, g);

      totAlm += Number(it.alm || 0);
      totCen += Number(it.cen || 0);
    });
  }

  const filteredPorDia = new Map(byDay.map(([iso, list]) => [iso, list]));
  return { hotel: rec.hotel, grupos, totAlm, totCen, porDia: filteredPorDia };
}


// regex robustas:
const NEG = /(no incluye|por cuenta|libre|sin\s+(almuerzo|cena))/i;
const R_ALM = /(almuerzo|lunch)/i;
const R_CEN = /\b(cena|dinner)\b/i;
const R_HOT = /\bhotel\b/i;

// ✔︎ helper visual
const tick = v => (v ? '✓' : '—');

// ✔︎ calcula estado/alertas según pensión y noches
function calcEstadoGrupo(pension, noches, almDias, cenDias, diasMap){
  const pen = (pension || '').toLowerCase();
  const total = almDias + cenDias;

  // desgloses por día (para media pensión)
  let zeroDays = 0, doubleDays = 0;
  if (diasMap && diasMap.size){
    for (const d of diasMap.values()){
      const s = Number(d.alm||0) + Number(d.cen||0);
      if (s === 0) zeroDays++;
      if (s > 1)   doubleDays++;
    }
  }

  let ok = true;
  const notes = [];
  if (pen === 'completa'){
    if (almDias !== noches) { ok = false; notes.push(`almuerzos ${almDias}/${noches}`); }
    if (cenDias !== noches) { ok = false; notes.push(`cenas ${cenDias}/${noches}`); }
  } else if (pen === 'media'){
    if (total !== noches)   { ok = false; notes.push(`total servicios ${total}/${noches}`); }
    if (zeroDays > 0)       { ok = false; notes.push(`${zeroDays} día(s) sin servicio`); }
    if (doubleDays > 0)     { ok = false; notes.push(`${doubleDays} día(s) con 2 servicios`); }
  } else {
    // sin dato: no exigimos, pero lo mostramos
    notes.push('pensión sin dato');
  }
  return { ok, label: ok ? 'OK' : 'Revisar', detail: notes.join('; ') };
}

// --- helpers de timestamp para ordenar por "el último guardado" ---
function toMillis(x){
  if (!x) return 0;
  if (typeof x === 'number') return x;
  if (typeof x === 'string') { const t = Date.parse(x); return isNaN(t) ? 0 : t; }
  // Firestore Timestamp u objeto con toDate()
  if (typeof x.toDate === 'function') return +x.toDate();
  if (x.seconds !== undefined) return x.seconds * 1000 + Math.floor((x.nanoseconds||0)/1e6);
  if (x instanceof Date) return +x;
  return 0;
}
const savedAtOf = (asg) =>
  Math.max(
    toMillis(asg?.updatedAt),
    toMillis(asg?.createdAt),
    toMillis(asg?.changedAt) // por si usas otro campo
  );


// =============== Carga base ===============
async function loadAll(){
  const [snapH, snapA, snapG] = await Promise.all([
    getDocs(collection(db,'hoteles')),
    getDocs(collection(db,'hotelAssignments')),
    getDocs(collection(db,'grupos'))
  ]);
  HOTELES = snapH.docs.map(d=>({ id:d.id, ...d.data() }));
  ASIGNS  = snapA.docs.map(d=>({ id:d.id, ...d.data() }));
  GRUPOS  = snapG.docs.map(d=>({ id:d.id, ...d.data() }));
}

// =============== Index ocupación por día (checkIn ≤ D < checkOut) ===============
// =============== Index ocupación por día (preferir último guardado) ===============
function buildIndexOcup(){
  INDEX_OCUP = new Map();

  for (const a of ASIGNS) {
    const gid = a.grupoId, hid = a.hotelId;
    const ci  = toISO(a.checkIn), co = toISO(a.checkOut);
    if (!gid || !hid || !ci || !co) continue;

    const byDate = INDEX_OCUP.get(gid) || new Map();
    const stamp  = savedAtOf(a);

    for (const d of eachDateISO(ci, co)) {
      const prev = byDate.get(d);
      if (!prev) {
        // primera asignación para ese día
        byDate.set(d, { hotelId: hid, asg: a, conflict: false, _ts: stamp });
      } else {
        // ya había algo: nos quedamos con la MÁS RECIENTE
        const winner = (stamp >= (prev._ts || 0))
          ? { hotelId: hid, asg: a, _ts: stamp }
          : prev;
        // marcamos conflicto, pero guardamos el ganador
        byDate.set(d, { ...winner, conflict: true });
      }
    }
    INDEX_OCUP.set(gid, byDate);
  }
}


// =============== Index itinerario: por grupo y día, conteos alm/cena ===============
function buildIndexItin(){
  INDEX_ITIN = new Map();
  for (const g of GRUPOS) {
    const idx = new Map();
    const itin = g.itinerario || {};
    for (const [fecha, arr] of Object.entries(itin)) {
      const items = Array.isArray(arr) ? arr : [];
      let almC = 0, cenC = 0;
      const chunks = [];

      for (const it of items) {
        const s = norm(it?.actividad || it?.texto || '');
        if (!s) continue;
        chunks.push(s);
        if (!NEG.test(s)) {
          const hasAlm = R_ALM.test(s) && R_HOT.test(s);
          const hasCen = R_CEN.test(s) && R_HOT.test(s);
          if (hasAlm) almC++;
          if (hasCen) cenC++;
        }
      }
      idx.set(toISO(fecha), { text: chunks.join(' | '), almCount: almC, cenCount: cenC });
    }
    INDEX_ITIN.set(g.id, idx);
  }
}

// =============== Construir AGG: Hotel → Grupo → Día ===============
function rebuildAgg(includeCoord=true, includeCond=true){
  AGG = new Map();

  const paxFromAsg = (asg) => {
    const a = Number(asg?.adultosTotal ?? asg?.adultostotal ?? 0);
    const e = Number(asg?.estudiantesTotal ?? asg?.estudiantestotal ?? 0);
    const c = includeCoord ? Number(asg?.coordinadores ?? 0) : 0;
    const d = includeCond  ? Number(asg?.conductores   ?? 0) : 0;
    return a + e + c + d;
  };

  for (const g of GRUPOS) {
    const byDate = INDEX_OCUP.get(g.id) || new Map();   // días ocupados por hotel
    const itIdx  = INDEX_ITIN.get(g.id) || new Map();   // conteo de 'hotel alm/cen' por fecha

    for (const [fecha, occ] of byDate.entries()) {
      const { hotelId, asg } = occ || {};
      if (!hotelId || !asg) continue;

      const byHotel = AGG.get(hotelId) || {
        hotel: HOTELES.find(h=>h.id===hotelId) || { id:hotelId, nombre:'(Hotel)', destino:'', ciudad:'' },
        grupos: new Map(),
        porDia: new Map(),     // fecha -> lista de {grupoId, ...alm, cen (0/1)}
        totAlm: 0,             // Σ alm(días) del hotel
        totCen: 0              // Σ cen(días) del hotel
      };

      const gInfo = byHotel.grupos.get(g.id) || {
        grupoId: g.id,
        numeroNegocio: g.numeroNegocio || g.id,
        nombreGrupo:   g.nombreGrupo   || '',
        identificador: g.identificador || '',
        dias: new Map(),     // fecha -> { alm:0/1, cen:0/1, texto, flags }
        almDias: 0,          // Σ alm(días)
        cenDias: 0,          // Σ cen(días)
        noches:  0,          // noches en este hotel (= #fechas asignadas)
        paxGrupo: 0          // pax informativo del grupo
      };

      // detector de servicios en el ITINERARIO del día
      const it = itIdx.get(fecha) || { text:'', almCount:0, cenCount:0 };
      const alm = it.almCount > 0 ? 1 : 0;
      const cen = it.cenCount > 0 ? 1 : 0;

      const flags = [];
      if (it.almCount > 1) flags.push('almuerzo duplicado');
      if (it.cenCount > 1) flags.push('cena duplicada');
      if (occ.conflict)    flags.push('conflicto ocupación');

      // por día
      gInfo.dias.set(fecha, {
        alm, cen,
        texto: it.text,
        flags
      });

      // acumulados por grupo / hotel (días, no pax)
      gInfo.almDias += alm;
      gInfo.cenDias += cen;
      gInfo.noches  += 1;

      // pax de referencia (solo informativo)
      const paxRef = paxFromAsg(asg);
      if (paxRef > gInfo.paxGrupo) gInfo.paxGrupo = paxRef;

      // acumulados por hotel
      byHotel.totAlm += alm;
      byHotel.totCen += cen;

      // índice por fecha a nivel hotel (para filtro Año)
      const list = byHotel.porDia.get(fecha) || [];
      list.push({
        grupoId: g.id,
        numeroNegocio: g.numeroNegocio || '',
        nombreGrupo:   g.nombreGrupo   || '',
        identificador: g.identificador || '',
        alm, cen
      });
      byHotel.porDia.set(fecha, list);

      byHotel.grupos.set(g.id, gInfo);
      AGG.set(hotelId, byHotel);
    }
  }
}

// =============== Render tabla principal ===============
function renderTable(){
  const rows = [];
  const destinos = new Set();

  // Filtros actuales
  const filDest = document.getElementById('filtroDestino').value || '';
  const filHot  = document.getElementById('filtroHotel').value || '';
  const filAno  = document.getElementById('filtroAno').value   || '';
  const busc    = norm(document.getElementById('buscador').value || '');

  // Opciones de selects (una sola vez por sesión)
  for (const h of HOTELES) destinos.add(h.destino || '');
  const elDes = document.getElementById('filtroDestino');
  const elHot = document.getElementById('filtroHotel');
  if (elDes && elDes.options.length === 1) {
    [...destinos].sort().forEach(d => elDes.appendChild(new Option(d || '(sin)', d)));
  }
  if (elHot && elHot.options.length === 1) {
    HOTELES.slice().sort((a,b)=> (a.nombre||'').localeCompare(b.nombre||''))
      .forEach(h => elHot.appendChild(new Option(h.nombre || h.id, h.id)));
  }

  // Construir filas (SOLO 1 <tr> por hotel; el detalle va como child row)
  for (const [hotelId, recRaw] of AGG.entries()) {
    const rec = filAno ? recForYear(recRaw, filAno) : recRaw;   // ← aplica año
    const h = rec.hotel || {};
    if (filDest && (h.destino||'') !== filDest) continue;
    if (filHot && hotelId !== filHot) continue;

    const name = `${h.nombre || hotelId}`;
    const searchBlob = norm(`${name} ${h.destino||''} ${h.ciudad||''} ${[...rec.grupos.values()].map(g=>g.nombreGrupo).join(' ')}`);
    if (busc && !searchBlob.includes(busc)) continue;

    const gruposCount = rec.grupos.size;
    // si por año no hay datos, escondemos el hotel
    if (filAno && rec.totAlm + rec.totCen === 0) continue;

    rows.push(`
      <tr data-hotel="${hotelId}">
        <td><span class="badge">${name}</span></td>
        <td>${h.destino || ''}</td>
        <td>${h.ciudad || ''}</td>
        <td>${rec.totAlm}</td>
        <td>${rec.totCen}</td>
        <td>${gruposCount}</td>
        <td>
          <button class="btn" data-act="ver" data-hotel="${hotelId}">Ver grupos</button>
          <button class="btn" data-act="reservar" data-hotel="${hotelId}">Reservar</button>
        </td>
      </tr>
    `);
  }

  // Pintar tbody
  const tbody = document.querySelector('#tablaHoteles tbody');
  tbody.innerHTML = rows.join('') || `<tr><td colspan="7" class="muted">No hay datos para los filtros actuales.</td></tr>`;

  // (Re)inicializar DataTable
  if (DT && $.fn.DataTable.isDataTable('#tablaHoteles')) {
    DT.destroy();
  }
  DT = $('#tablaHoteles').DataTable({
    paging:false, searching:false, info:false,
    fixedHeader:{ header:true, headerOffset:90 },
    order:[]
  });

  // Delegación de eventos sobre el tbody
  const $tbody = $('#tablaHoteles tbody');
  $tbody.off('click', 'button[data-act="ver"]');
  $tbody.on('click', 'button[data-act="ver"]', function(){
    const hid = this.dataset.hotel;
    const recRaw = AGG.get(hid);
    if (!recRaw) return;
    const rec = filAno ? recForYear(recRaw, filAno) : recRaw;   // ← detalle coherente con el año
    const row = DT.row($(this).closest('tr'));
    if (row.child.isShown()) {
      row.child.hide();
      this.textContent = 'Ver grupos';
    } else {
      
      // Si tu función existente acepta un solo arg, no pasa nada por pasar uno.
      const htmlDetalle = (typeof renderSubtablaHotel === 'function')
        ? renderSubtablaHotel(rec)
        : `<div style="padding:6px 0">Sin renderer de subtabla.</div>`;
      
      row.child(`<div style="padding:6px 0">${htmlDetalle}</div>`).show();
      this.textContent = 'Ocultar';
    }
  });

  $tbody.off('click', 'button[data-act="reservar"]');
  $tbody.on('click', 'button[data-act="reservar"]', function(){
    abrirModalHotel(this.dataset.hotel);
  });
}

// Subtabla: lista de grupos del hotel con Σ almuerzos/cenas
function renderSubtablaHotel(rec){
  const hid = rec?.hotel?.id || '';
  const pension = rec?.hotel?.pension || '';  // 'media' | 'completa' | ''

  const rows = [...rec.grupos.values()]
    .sort((a,b)=> (a.numeroNegocio+' '+a.nombreGrupo).localeCompare(b.numeroNegocio+' '+b.nombreGrupo))
    .map(g => {
      const etiqueta = `(${g.numeroNegocio}) ${g.identificador ? g.identificador+' – ' : ''}${g.nombreGrupo || ''}`;
      const estado = calcEstadoGrupo(pension, g.noches, g.almDias, g.cenDias, g.dias);
      return `
        <tr>
          <td>${etiqueta}</td>
          <td style="text-align:center">${g.noches}</td>
          <td style="text-transform:capitalize">${pension || '(sin dato)'}</td>
          <td style="text-align:center">${g.almDias}</td>
          <td style="text-align:center">${g.cenDias}</td>
          <td style="text-align:center">${g.paxGrupo}</td>
          <td>${estado.ok ? '✔️ OK' : ('⚠️ ' + estado.detail)}</td>
          <td><button class="btn btn-mini" data-act="detalle-grupo" data-gid="${g.grupoId}" data-hid="${hid}">Detalle</button></td>
        </tr>
      `;
    }).join('');

  // wire de "Detalle"
  setTimeout(()=>{
    document.querySelectorAll('button[data-act="detalle-grupo"]').forEach(b=>{
      b.onclick = ()=> abrirModalGrupo(b.dataset.hid, b.dataset.gid);
    });
  },0);

  return `
    <table class="subtabla">
      <thead>
        <tr>
          <th>Grupo</th>
          <th>Noches</th>
          <th>Pensión</th>
          <th>Σ Almuerzos</th>
          <th>Σ Cenas</th>
          <th>PAX</th>
          <th>Estado</th>
          <th>Detalle</th>
        </tr>
      </thead>
      <tbody>${rows || `<tr><td colspan="8" class="muted">Sin grupos.</td></tr>`}</tbody>
    </table>
  `;
}

// =============== MODAL: Detalle Grupo (día a día) ===============
function abrirModalGrupo(hotelId, grupoId){
  const recH = AGG.get(hotelId);
  if (!recH) return;
  const g = recH.grupos.get(grupoId);
  if (!g) return;

  document.getElementById('mg-title').textContent =
    `Detalle — ${recH.hotel.nombre} — (${g.numeroNegocio}) ${g.nombreGrupo}`;

  // rows por día ordenadas
  const rows = [...g.dias.entries()].sort((a,b)=> a[0].localeCompare(b[0]))
    .map(([fecha, d]) => `
      <tr>
        <td>${fmt(fecha)}</td>
        <td>${d.alm}</td>
        <td>${d.cen}</td>
        <td>${d.paxBase}</td>
        <td>${(d.texto || '').slice(0,180)}</td>
        <td>${(d.flags || []).join(', ')}</td>
      </tr>
    `).join('');

  document.querySelector('#mg-tabla tbody').innerHTML = rows || `<tr><td colspan="6" class="muted">Sin datos para este grupo.</td></tr>`;

  // open
  document.getElementById('modalGrupoBackdrop').style.display = 'block';
  document.getElementById('modalGrupo').style.display = 'block';
}
document.getElementById('mg-close').onclick = closeModalGrupo;
document.getElementById('mg-ok').onclick    = closeModalGrupo;
function closeModalGrupo(){
  document.getElementById('modalGrupoBackdrop').style.display = 'none';
  document.getElementById('modalGrupo').style.display = 'none';
}

// =============== MODAL: Hotel (Reservar) ===============
async function abrirModalHotel(hotelId){
  const rec = AGG.get(hotelId);
  if (!rec) return;

  const h = rec.hotel || {};
  const pension = h.pension || '';
  const para = h.contactoCorreo || h.contacto || '';

  // ordenar grupos con consumo (aunque ahora el "consumo" son días marcados)
  const gruposOrden = [...rec.grupos.values()]
    .filter(g => (g.almDias + g.cenDias) > 0 || g.noches > 0)
    .sort((a,b)=> (a.numeroNegocio+' '+a.nombreGrupo).localeCompare(b.numeroNegocio+' '+b.nombreGrupo));

  // texto de correo
  let cuerpo = `Estimado/a:\n\n`;
  cuerpo += `Reserva de alimentación para ${h.nombre || '(Hotel)'}.\n`;
  cuerpo += `Pensión declarada: ${pension || '(sin dato)'}.\n\n`;
  cuerpo += `Resumen por grupo (días de servicio):\n`;

  for (const g of gruposOrden) {
    const est = calcEstadoGrupo(pension, g.noches, g.almDias, g.cenDias, g.dias);
    const etiqueta = `(${g.numeroNegocio}) ${g.identificador ? g.identificador+' – ' : ''}${g.nombreGrupo}`;
    cuerpo += `- ${etiqueta} — Noches:${g.noches} | Alm(días):${g.almDias} | Cen(días):${g.cenDias} | PAX:${g.paxGrupo} | ${est.ok ? 'OK' : 'ATENCIÓN: '+est.detail}\n`;
  }
  cuerpo += `\nAtte.\nOperaciones Rai Trai`;

  // pintar modal
  document.getElementById('mh-title').textContent = `Reservar — ${h.nombre || hotelId}`;
  document.getElementById('mh-para').value   = para || 'CORREO@HOTEL.COM';
  document.getElementById('mh-asunto').value = `Reserva alimentación — ${h.nombre || hotelId}`;
  document.getElementById('mh-cuerpo').value = cuerpo;

  const tb = document.querySelector('#mh-tablaGrupos tbody');
  tb.innerHTML = gruposOrden.map(g => {
    const est = calcEstadoGrupo(pension, g.noches, g.almDias, g.cenDias, g.dias);
    const etiqueta = `(${g.numeroNegocio}) ${g.identificador ? g.identificador+' – ' : ''}${g.nombreGrupo}`;
    return `<tr>
      <td>${etiqueta}</td>
      <td style="text-align:center">${g.noches}</td>
      <td style="text-transform:capitalize">${pension || '(sin dato)'}</td>
      <td style="text-align:center">${g.almDias}</td>
      <td style="text-align:center">${g.cenDias}</td>
      <td style="text-align:center">${g.paxGrupo}</td>
      <td>${est.ok ? '✔️ OK' : ('⚠️ ' + est.detail)}</td>
      <td><button class="btn btn-mini" data-act="detalle-grupo" data-hid="${hotelId}" data-gid="${g.grupoId}">Ver detalle</button></td>
    </tr>`;
  }).join('') || `<tr><td colspan="8" class="muted">Sin grupos para mostrar.</td></tr>`;

  tb.querySelectorAll('button[data-act="detalle-grupo"]').forEach(b=>{
    b.onclick = ()=> abrirModalGrupo(b.dataset.hid, b.dataset.gid);
  });

  document.getElementById('mh-guardarPend').dataset.hid = hotelId;
  document.getElementById('mh-enviar').dataset.hid = hotelId;

  document.getElementById('modalHotelBackdrop').style.display = 'block';
  document.getElementById('modalHotel').style.display = 'block';
}

// Guardar PENDIENTE (marca por cada fecha con consumo > 0)
document.getElementById('mh-guardarPend').onclick = async (e)=>{
  try {
    const hid = e.currentTarget.dataset.hid;
    const rec = AGG.get(hid);
    if (!rec) return;

    const cuerpo = document.getElementById('mh-cuerpo').value;
    // armar payload por fecha: Σ almuerzos y Σ cenas del hotel en esa fecha
    const perDate = new Map();
    for (const g of rec.grupos.values()) {
      for (const [fecha, d] of g.dias.entries()) {
        const acc = perDate.get(fecha) || { alm:0, cen:0 };
        acc.alm += d.alm; acc.cen += d.cen;
        perDate.set(fecha, acc);
      }
    }
    const patch = {};
    for (const [fecha, t] of perDate.entries()) {
      if ((t.alm + t.cen) > 0) patch[`reservasAlimentos.${fecha}`] =
        { estado:'PENDIENTE', cuerpo, totAlmuerzos: t.alm, totCenas: t.cen };
    }
    if (Object.keys(patch).length) await updateDoc(doc(db,'hoteles', hid), patch);
    closeModalHotel();
    alert('Guardado como PENDIENTE.');
  } catch(err) {
    console.error(err); alert('No se pudo guardar PENDIENTE.');
  }
};

// Enviar (abre Gmail + marca ENVIADA por cada fecha con consumo > 0)
document.getElementById('mh-enviar').onclick = async (e)=>{
  const hid = e.currentTarget.dataset.hid;
  const rec = AGG.get(hid);
  if (!rec) return;

  const para   = document.getElementById('mh-para').value.trim();
  const asunto = document.getElementById('mh-asunto').value.trim();
  const cuerpo = document.getElementById('mh-cuerpo').value;

  // Gmail compose (como contador.js)
  const base = 'https://mail.google.com/mail/u/0/?view=cm&fs=1';
  const params = `to=${encodeURIComponent(para)}&su=${encodeURIComponent(asunto)}&body=${encodeURIComponent(cuerpo)}`;
  window.open(`${base}&${params}`, '_blank');

  try {
    // actualizar estado ENVIADA por fecha
    const perDate = new Map();
    for (const g of rec.grupos.values()) {
      for (const [fecha, d] of g.dias.entries()) {
        const acc = perDate.get(fecha) || { alm:0, cen:0 };
        acc.alm += d.alm; acc.cen += d.cen;
        perDate.set(fecha, acc);
      }
    }
    const patch = {};
    for (const [fecha, t] of perDate.entries()) {
      if ((t.alm + t.cen) > 0) patch[`reservasAlimentos.${fecha}`] =
        { estado:'ENVIADA', cuerpo, totAlmuerzos: t.alm, totCenas: t.cen };
    }
    if (Object.keys(patch).length) await updateDoc(doc(db,'hoteles', hid), patch);
    closeModalHotel();
  } catch(err) {
    console.error(err); alert('No se pudo marcar ENVIADA.');
  }
};

// =============== Export a Excel ===============
document.getElementById('btnExportExcel').onclick = exportExcel;
function exportExcel(){
  // Hoja 1: Detalle día a día
  const detalle = [];
  for (const [hid, rec] of AGG.entries()) {
    for (const g of rec.grupos.values()) {
      for (const [fecha, d] of g.dias.entries()) {
        detalle.push({
          Hotel: rec.hotel.nombre || hid,
          Destino: rec.hotel.destino || '',
          Ciudad: rec.hotel.ciudad || '',
          Grupo: g.numeroNegocio,
          NombreGrupo: g.nombreGrupo,
          Fecha: fecha,
          Almuerzo: d.alm,
          Cena: d.cen,
          PaxBase: d.paxBase,
          Texto: d.texto.slice(0,300),
          Flags: (d.flags||[]).join(', ')
        });
      }
    }
  }

  // Hoja 2: Totales por grupo en hotel
  const totGrupo = [];
  for (const [hid, rec] of AGG.entries()) {
    for (const g of rec.grupos.values()) {
      totGrupo.push({
        Hotel: rec.hotel.nombre || hid,
        Destino: rec.hotel.destino || '',
        Ciudad: rec.hotel.ciudad || '',
        Grupo: g.numeroNegocio,
        NombreGrupo: g.nombreGrupo,
        'Σ Almuerzos': g.totAlm,
        'Σ Cenas': g.totCen
      });
    }
  }

  // Hoja 3: Totales por hotel
  const totHotel = [];
  for (const [hid, rec] of AGG.entries()) {
    totHotel.push({
      Hotel: rec.hotel.nombre || hid,
      Destino: rec.hotel.destino || '',
      Ciudad: rec.hotel.ciudad || '',
      'Σ Almuerzos': rec.totAlm,
      'Σ Cenas': rec.totCen,
      Grupos: rec.grupos.size
    });
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(detalle),  'Detalle_dias');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(totGrupo), 'Totales_grupo');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(totHotel), 'Totales_hotel');
  XLSX.writeFile(wb, `reservas_hoteles_${new Date().toISOString().slice(0,10)}.xlsx`);
}

// =============== Eventos UI ===============
document.getElementById('btnRecalcular').addEventListener('click', recalcAndPaint);
document.getElementById('filtroDestino').addEventListener('change', renderTable);
document.getElementById('filtroHotel').addEventListener('change', renderTable);
document.getElementById('filtroAno').addEventListener('change', renderTable);
document.getElementById('buscador').addEventListener('input', renderTable);

// Estos SÍ cambian el cómputo => recalcular
document.getElementById('chkCoord').addEventListener('change', recalcAndPaint);
document.getElementById('chkCond').addEventListener('change', recalcAndPaint);


// =============== Init ===============
async function init(){
  await loadAll();
  buildIndexOcup();
  buildIndexItin();
  recalcAndPaint();

  // cerrar modales al click en backdrop
  document.getElementById('modalHotelBackdrop').onclick = closeModalHotel;
  document.getElementById('modalGrupoBackdrop').onclick = closeModalGrupo;
}

function recalcAndPaint(){
  const incC = document.getElementById('chkCoord').checked;
  const incD = document.getElementById('chkCond').checked;
  rebuildAgg(incC, incD);
  populateFiltroAno();
  renderTable();
}
