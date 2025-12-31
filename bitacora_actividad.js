// bitacora_actividades.js
// Lee bitácoras desde la MISMA estructura que COORDINADORES.JS v2.5:
// grupos shows → grupos/{gid}/bitacora/{actKey}/{fechaISO}/{timeId}
// Fuente: loadBitacora() en COORDINADORES.JS:contentReference[oaicite:2]{index=2}

import { app, db } from './firebase-init.js';
import {
  collection, getDocs, doc, getDoc,
  query, where, orderBy, limit
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

/* =========================
   UI refs
========================= */
const $ = (id) => document.getElementById(id);

const elDestino   = $('fDestino');
const elCoord     = $('fCoord');
const elGrupo     = $('fGrupo');
const elModo      = $('fModo');
const elActividad = $('fActividad');
const elLimit     = $('fLimit');

const btnCargar   = $('btnCargar');
const btnLimpiar  = $('btnLimpiar');

const metaStatus  = $('metaStatus');
const pillResumen = $('pillResumen');
const qBuscar     = $('qBuscar');
const results     = $('results');

/* =========================
   Helpers (igual filosofía que RT)
========================= */
const norm = (s='') => (s ?? '')
  .toString()
  .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
  .toLowerCase()
  .trim();

function safeUp(s=''){ return (s ?? '').toString().toUpperCase(); }

function dmySafe(iso){
  if (!iso) return '';
  // iso: YYYY-MM-DD
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(iso);
  return `${m[3]}-${m[2]}-${m[1]}`;
}

// actKey compatible con el “slugActKey(a)” de Coordinadores
function actKeyFromActivityObj(a){
  const name = (a?.actividad || a?.nombre || a?.titulo || '').toString().trim();
  return slug(name);
}
function slug(s=''){
  return norm(s)
    .replace(/[^a-z0-9\s-]/g,'')
    .replace(/[\s_]+/g,'-')
    .replace(/-+/g,'-')
    .replace(/(^-|-$)/g,'');
}

function setStatus(txt, kind=''){
  metaStatus.className = 'metaLine ' + (kind || '');
  metaStatus.textContent = txt;
}

function setResumen(n){
  pillResumen.textContent = `ENTRADAS: ${n.toLocaleString('es-CL')}`;
}

/* =========================
   Cache/state
========================= */
const state = {
  grupos: [],          // [{id, ...data}]
  actividades: [],     // [{label, actKey}]
  lastRows: []         // rows renderizadas para búsqueda
};

/* =========================
   Carga inicial de filtros
========================= */
init().catch(console.error);

async function init(){
  setStatus('Cargando grupos…');
  await loadGruposBase();
  fillFiltros();
  wireUI();
  setStatus(`Listo. Grupos cargados: ${state.grupos.length}.`);
}

async function loadGruposBase(){
  // 1) Trae todos los grupos (si esto es pesado, luego lo optimizamos con filtros por destino/coord)
  const qs = await getDocs(collection(db,'grupos'));
  const arr = [];
  qs.forEach(d => arr.push({ id:d.id, ...(d.data()||{}) }));

  // Orden estable por numeroNegocio / nombre
  arr.sort((a,b)=>{
    const an = String(a.numeroNegocio||'').localeCompare(String(b.numeroNegocio||''), 'es', { sensitivity:'base' });
    if (an) return an;
    return String(a.nombreGrupo||a.aliasGrupo||'').localeCompare(String(b.nombreGrupo||b.aliasGrupo||''), 'es', { sensitivity:'base' });
  });

  state.grupos = arr;
}

function fillFiltros(){
  // DESTINOS
  const destinos = new Set();
  const coords   = new Set();

  for (const g of state.grupos){
    if (g.destino) destinos.add(String(g.destino));
    // ajusta aquí si tu campo se llama distinto:
    const c = g.coordinador || g.coordinadorNombre || g.coordinadorEmail || '';
    if (c) coords.add(String(c));
  }

  // fill destino
  [...destinos].sort((a,b)=>a.localeCompare(b,'es',{sensitivity:'base'}))
    .forEach(d=>{
      const op=document.createElement('option');
      op.value=d; op.textContent=safeUp(d);
      elDestino.appendChild(op);
    });

  // fill coordinador
  [...coords].sort((a,b)=>a.localeCompare(b,'es',{sensitivity:'base'}))
    .forEach(c=>{
      const op=document.createElement('option');
      op.value=c; op.textContent=safeUp(c);
      elCoord.appendChild(op);
    });

  // fill grupos (se recalcula también al cambiar filtros)
  rebuildGrupoOptions();
}

function rebuildGrupoOptions(){
  const dest = elDestino.value || '';
  const coord= elCoord.value || '';

  const curr = elGrupo.value || '';
  elGrupo.innerHTML = `<option value="">(Todos)</option>`;

  getFilteredGrupos(dest, coord).forEach(g=>{
    const label = groupLabel(g);
    const op=document.createElement('option');
    op.value=g.id; op.textContent=label;
    elGrupo.appendChild(op);
  });

  // intenta mantener selección previa
  if (curr && [...elGrupo.options].some(o=>o.value===curr)){
    elGrupo.value = curr;
  }
}

function groupLabel(g){
  const num = g.numeroNegocio ? `(${g.numeroNegocio}${g.identificador?('/'+g.identificador):''}) ` : '';
  const name= g.nombreGrupo || g.aliasGrupo || g.id;
  return safeUp(num + name);
}

function getFilteredGrupos(dest, coord){
  return state.grupos.filter(g=>{
    if (dest && String(g.destino||'') !== dest) return false;
    if (coord){
      const c = g.coordinador || g.coordinadorNombre || g.coordinadorEmail || '';
      if (String(c||'') !== coord) return false;
    }
    return true;
  });
}

function wireUI(){
  elDestino.onchange = ()=>{
    rebuildGrupoOptions();
    rebuildActividadOptions(); // depende de destino/filtros
  };
  elCoord.onchange = ()=>{
    rebuildGrupoOptions();
    rebuildActividadOptions();
  };
  elGrupo.onchange = ()=>{
    rebuildActividadOptions(); // en modo grupo igual podemos recalcular
  };

  elModo.onchange = ()=>{
    const isAct = elModo.value === 'actividad';
    elActividad.disabled = !isAct;
    rebuildActividadOptions();
  };

  btnLimpiar.onclick = ()=>{
    results.innerHTML = `<div class="muted">Sin resultados.</div>`;
    state.lastRows = [];
    setResumen(0);
    qBuscar.value = '';
    setStatus('Limpio.');
  };

  btnCargar.onclick = async ()=>{
    await runLoad();
  };

  qBuscar.oninput = ()=>{
    applySearchFilter();
  };

  // inicial
  rebuildActividadOptions();
}

function rebuildActividadOptions(){
  const isAct = elModo.value === 'actividad';
  // en modo grupo, el selector de actividad no manda (lo dejamos igual deshabilitado)
  if (!isAct){
    elActividad.innerHTML = `<option value="">(No aplica)</option>`;
    elActividad.disabled = true;
    return;
  }

  elActividad.disabled = false;
  elActividad.innerHTML = `<option value="">(Selecciona actividad)</option>`;

  // actividades se construyen desde itinerarios de grupos filtrados (dest/coord/grupo)
  const grupos = getScopeGrupos();
  const map = new Map(); // actKey -> label

  for (const g of grupos){
    const it = g.itinerario || {};
    for (const fecha of Object.keys(it)){
      const acts = Array.isArray(it[fecha]) ? it[fecha] : [];
      for (const a of acts){
        const name = (a.actividad || a.nombre || a.titulo || '').toString().trim();
        if (!name) continue;
        const k = actKeyFromActivityObj(a);
        if (!k) continue;
        if (!map.has(k)) map.set(k, name);
      }
    }
  }

  const list = [...map.entries()]
    .map(([actKey,label])=>({ actKey, label }))
    .sort((a,b)=>a.label.localeCompare(b.label,'es',{sensitivity:'base'}));

  state.actividades = list;

  for (const x of list){
    const op=document.createElement('option');
    op.value = x.actKey;
    op.textContent = safeUp(x.label);
    elActividad.appendChild(op);
  }
}

function getScopeGrupos(){
  const dest = elDestino.value || '';
  const coord= elCoord.value || '';
  const gid  = elGrupo.value || '';

  let grupos = getFilteredGrupos(dest, coord);
  if (gid) grupos = grupos.filter(g=>g.id===gid);
  return grupos;
}

/* =========================
   Carga principal
========================= */
async function runLoad(){
  const modo = elModo.value;
  const limitN = Number(elLimit.value || 200);

  const grupos = getScopeGrupos();
  if (!grupos.length){
    setStatus('No hay grupos para esos filtros.', 'warn');
    results.innerHTML = `<div class="warn">No hay grupos para esos filtros.</div>`;
    setResumen(0);
    return;
  }

  if (modo === 'actividad'){
    const actKey = elActividad.value || '';
    if (!actKey){
      setStatus('Selecciona una actividad (modo Actividad).', 'warn');
      return;
    }
  }

  btnCargar.disabled = true;
  setStatus('Cargando bitácora desde Firebase…');

  try{
    // Recolecta “targets”: (grupo, fechaISO, actKey, actLabel)
    const targets = buildTargets(grupos, modo);

    if (!targets.length){
      results.innerHTML = `<div class="muted">No hay actividades/itinerario en este alcance.</div>`;
      setResumen(0);
      setStatus('Sin actividades en itinerario para esos filtros.', 'warn');
      return;
    }

    // Lectura “con límite global”: vamos sumando notas hasta llegar al límite
    const rows = [];
    let totalNotes = 0;

    // Orden: primero por grupo, luego por fecha, luego por actividad
    // (si prefieres por “reciente”, lo ajustamos a futuro)
    for (const t of targets){
      if (totalNotes >= limitN) break;

      const notes = await loadBitacoraChunk(t.grupoId, t.fechaISO, t.actKey, 50);
      for (const n of notes){
        rows.push({
          grupoId: t.grupoId,
          grupoLabel: t.grupoLabel,
          destino: t.destino,
          coord: t.coord,
          fechaISO: t.fechaISO,
          actKey: t.actKey,
          actLabel: t.actLabel,
          texto: n.texto,
          by: n.by,
          when: n.when
        });
        totalNotes++;
        if (totalNotes >= limitN) break;
      }
    }

    state.lastRows = rows;
    renderRows(rows);
    applySearchFilter(); // respeta buscador si ya está escrito
    setResumen(rows.length);
    setStatus(`Listo. Notas cargadas: ${rows.length} (límite ${limitN}).`);

  }catch(e){
    console.error(e);
    setStatus('Error cargando desde Firebase. Revisa consola.', 'err');
    results.innerHTML = `<div class="err">Error cargando desde Firebase. Revisa consola.</div>`;
    setResumen(0);
  }finally{
    btnCargar.disabled = false;
  }
}

function buildTargets(grupos, modo){
  const targets = [];
  const actKeySelected = elActividad.value || '';

  for (const g of grupos){
    const it = g.itinerario || {};
    const fechas = Object.keys(it).sort(); // asc
    for (const fechaISO of fechas){
      const acts = Array.isArray(it[fechaISO]) ? it[fechaISO] : [];
      for (const a of acts){
        const actLabel = (a.actividad || a.nombre || a.titulo || '').toString().trim();
        if (!actLabel) continue;

        const actKey = actKeyFromActivityObj(a);
        if (!actKey) continue;

        if (modo === 'actividad' && actKey !== actKeySelected) continue;

        targets.push({
          grupoId: g.id,
          grupoLabel: groupLabel(g),
          destino: safeUp(g.destino || '—'),
          coord: safeUp(g.coordinador || g.coordinadorNombre || g.coordinadorEmail || '—'),
          fechaISO,
          actKey,
          actLabel: safeUp(actLabel)
        });
      }
    }
  }

  return targets;
}

// Lee bitácora EXACTA como Coordinadores:
// collection(db,'grupos',grupoId,'bitacora',actKey,fechaISO) + orderBy('ts','desc') limit(50)
// Fuente: loadBitacora():contentReference[oaicite:3]{index=3}
async function loadBitacoraChunk(grupoId, fechaISO, actKey, max=50){
  const out = [];
  const coll = collection(db,'grupos',grupoId,'bitacora',actKey,fechaISO);

  const qs = await getDocs(query(coll, orderBy('ts','desc'), limit(max)));
  qs.forEach(d=>{
    const x = d.data() || {};
    const by = String(x.byEmail || x.byUid || 'USUARIO').toUpperCase();
    let when = '';
    try{
      const tv = x.ts?.seconds
        ? new Date(x.ts.seconds*1000)
        : (x.ts?.toDate ? x.ts.toDate() : null);
      if (tv) when = tv.toLocaleString('es-CL').toUpperCase();
    }catch(_){}

    const texto = String(x.texto || x.text || '').trim();
    if (!texto) return;

    out.push({ texto, by, when });
  });

  return out;
}

/* =========================
   Render
========================= */
function renderRows(rows){
  if (!rows.length){
    results.innerHTML = `<div class="muted">Sin notas para este alcance.</div>`;
    return;
  }

  // agrupamos por (grupoId + fechaISO + actKey)
  const map = new Map();
  for (const r of rows){
    const k = `${r.grupoId}__${r.fechaISO}__${r.actKey}`;
    if (!map.has(k)){
      map.set(k, { head: r, notes: [] });
    }
    map.get(k).notes.push(r);
  }

  const groups = [...map.values()];

  const frag = document.createDocumentFragment();

  for (const g of groups){
    const head = g.head;
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.search = norm([
      head.grupoLabel, head.destino, head.coord, head.actLabel, head.fechaISO,
      ...g.notes.map(x=>x.texto)
    ].join(' '));

    card.innerHTML = `
      <div class="cardHead">
        <div>
          <div class="cardTitle">${head.actLabel}</div>
          <div class="cardSub">
            GRUPO: ${head.grupoLabel}<br>
            DESTINO: ${head.destino} · COORD: ${head.coord} · FECHA: ${dmySafe(head.fechaISO)}
          </div>
        </div>
        <div class="pill">${g.notes.length} notas</div>
      </div>
      <div class="cardBody"></div>
    `;

    const body = card.querySelector('.cardBody');
    for (const n of g.notes){
      const div = document.createElement('div');
      div.className = 'note';
      div.innerHTML = `
        <div>${safeUp(n.texto)}</div>
        <div class="noteMeta">— ${n.by}${n.when ? ` · ${n.when}` : ''}</div>
      `;
      body.appendChild(div);
    }

    frag.appendChild(card);
  }

  results.innerHTML = '';
  results.appendChild(frag);
}

function applySearchFilter(){
  const q = norm(qBuscar.value || '');
  const cards = [...results.querySelectorAll('.card')];
  if (!cards.length) return;

  let visible = 0;
  for (const c of cards){
    const hay = !q || (c.dataset.search || '').includes(q);
    c.style.display = hay ? '' : 'none';
    if (hay) visible++;
  }

  // No cambiamos el “ENTRADAS” global, pero puedes ver cuántas quedan visibles:
  // pillResumen.textContent = `ENTRADAS: ${visible}`;
}
