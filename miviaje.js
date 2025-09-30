// miviaje.js — visor SOLO LECTURA (sin autenticación)
// Lee un grupo por ?id=<docId> o ?numeroNegocio= (incluye “1475/1411”, “1475-1411”, “1475 y 1411”).
// Si hay varios matches, muestra selector con links ?id=.
// Botones: Copiar enlace / Imprimir. &notas=0 para ocultar notas.
// FICHA DEL GRUPO: ✈️ Vuelos · 🏨 Hoteles · 👥 Contactos · 🛡️ Seguro · 🚌 Terrestre.

import { app, db } from './firebase-core.js';
import {
  collection, doc, getDoc, getDocs, query, where, limit
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

/* ───────── URL & helpers ───────── */
function getParamsFromURL() {
  const parts = location.pathname.split('/').filter(Boolean);
  const i = parts.findIndex(p => p.toLowerCase().includes('miviaje'));
  const seg = (i >= 0 && parts[i + 1]) ? decodeURIComponent(parts[i + 1]) : null;
  const qs = new URLSearchParams(location.search);
  const numeroKey = [...qs.keys()].find(k => k.toLowerCase() === 'numeronegocio');
  const numeroNegocio = (seg || (numeroKey ? qs.get(numeroKey) : '') || '').trim();
  const idKey = [...qs.keys()].find(k => k.toLowerCase() === 'id');
  const id = idKey ? (qs.get(idKey) || '').trim() : '';
  const hideNotes = qs.get('notas') === '0';
  return { numeroNegocio, id, hideNotes };
}
function splitNumeroCompuesto(v) {
  if (!v) return [];
  return String(v).split(/(?:\s*[\/,\-]\s*|\s+y\s+)/i).map(s => s.trim()).filter(Boolean);
}
function buildCompositeVariants(v) {
  const p = splitNumeroCompuesto(v); if (p.length < 2) return [];
  const seps = ['/', '-', ',']; const out = new Set();
  for (const s of seps){ out.add(p.join(s)); out.add(p.join(` ${s} `)); out.add(p.join(` ${s}`)); out.add(p.join(`${s} `)); }
  return [...out];
}
async function fetchGrupoById(id) {
  if (!id) return null;
  const s = await getDoc(doc(db,'grupos',id));
  return s.exists()? { id:s.id, ...s.data() } : null;
}
async function buscarGruposPorNumero(numeroNegocio) {
  if (!numeroNegocio) return [];
  const vistos = new Map(); const push = snap => snap.forEach(d => vistos.set(d.id,{id:d.id,...d.data()}));

  let snap = await getDocs(query(collection(db,'grupos'), where('numeroNegocio','==',numeroNegocio), limit(10)));
  push(snap);
  for (const v of buildCompositeVariants(numeroNegocio)) {
    const s = await getDocs(query(collection(db,'grupos'), where('numeroNegocio','==',v), limit(10)));
    push(s);
  }
  const asNum = Number(numeroNegocio);
  if (!Number.isNaN(asNum)) {
    snap = await getDocs(query(collection(db,'grupos'), where('numeroNegocio','==',asNum), limit(10)));
    push(snap);
  }
  for (const p of splitNumeroCompuesto(numeroNegocio)) {
    const s1 = await getDocs(query(collection(db,'grupos'), where('numeroNegocio','==',p), limit(10)));
    push(s1);
    const pn = Number(p);
    if (!Number.isNaN(pn)) {
      const s2 = await getDocs(query(collection(db,'grupos'), where('numeroNegocio','==',pn), limit(10)));
      push(s2);
    }
  }
  return [...vistos.values()];
}

/* ───────── util ───────── */
function safe(v, fb='—'){ return (v===0||v)?v:fb; }
function normTime(t){ if(!t) return ''; const m=String(t).match(/(\d{1,2})[:hH\.](\d{2})/); if(!m) return ''; const h=String(Math.max(0,Math.min(23,parseInt(m[1],10)))).padStart(2,'0'); const mi=String(Math.max(0,Math.min(59,parseInt(m[2],10)))).padStart(2,'0'); return `${h}:${mi}`; }
function formatDateRange(ini,fin){ if(!ini||!fin) return '—'; try{ const [iy,im,id]=String(ini).split('-').map(Number); const [fy,fm,fd]=String(fin).split('-').map(Number); const di=new Date(iy,im-1,id); const df=new Date(fy,fm-1,fd); const fmt=d=>d.toLocaleDateString('es-CL',{day:'2-digit',month:'2-digit',year:'numeric'}); return `${fmt(di)} — ${fmt(df)}`; }catch{ return '—'; } }
function formatDateReadable(iso){ if(!iso) return '—'; const [y,m,d]=iso.split('-').map(Number); const dt=new Date(y,m-1,d); const wd=dt.toLocaleDateString('es-CL',{weekday:'long'}); const name=wd.charAt(0).toUpperCase()+wd.slice(1); return `${name} ${String(d).padStart(2,'0')}/${String(m).padStart(2,'0')}`; }
function getDateRange(s,e){ const out=[]; if(!s||!e) return out; const [sy,sm,sd]=s.split('-').map(Number), [ey,em,ed]=e.split('-').map(Number); const a=new Date(sy,sm-1,sd), b=new Date(ey,em-1,ed); for(let d=new Date(a); d<=b; d.setDate(d.getDate()+1)){ out.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`);} return out; }

/* ───────── normalizadores ───────── */
// ✈️
function normalizeVuelos(g){
  const res=[]; const push=v=>{ if(!v) return; res.push({
    fecha: v.fecha||v.fechaVuelo||v.fechaSalida||v.dia||'',
    numeroVuelo: v.numeroVuelo||v.numVuelo||v.vuelo||v.numero||v.flightNumber||'',
    aerolinea: v.aerolinea||v.linea||v.airline||'',
    desde: v.desde||v.origen||v.from||'',
    hasta: v.hasta||v.destino||v.to||'',
    horaSalida: normTime(v.horaSalida||v.salida||v.hora||v.horaDespegue||''),
    horaArribo: normTime(v.horaArribo||v.llegada||v.horaLlegada||v.arribo||'')
  });};
  const vx=g?.vuelos;
  if(Array.isArray(vx)) vx.forEach(push);
  else if(vx&&typeof vx==='object') Object.values(vx).forEach(push);
  else{
    const ida={ fecha:g.fechaSalida||g.fechaIda, numero:g.vueloSalida||g.vueloIda||g.nroVueloIda,
      aerolinea:g.aerolinea||g.lineaAerea, desde:g.origenSalida||g.origenIda||g.origen, hasta:g.destinoSalida||g.destinoIda||g.destino,
      horaSalida:g.horaSalidaIda||g.horaSalida, horaLlegada:g.horaLlegadaIda||g.horaArriboIda };
    const vuelta={ fecha:g.fechaRegreso||g.fechaVuelta, numero:g.vueloRegreso||g.vueloVuelta||g.nroVueloVuelta,
      aerolinea:g.aerolineaVuelta||g.aerolinea||g.lineaAerea, desde:g.origenRegreso||g.origenVuelta||g.destino, hasta:g.destinoRegreso||g.destinoVuelta||g.origen,
      horaSalida:g.horaSalidaVuelta||g.horaSalidaRegreso, horaLlegada:g.horaLlegadaVuelta||g.horaArriboVuelta };
    if(ida.fecha||ida.numero||ida.desde||ida.hasta) push(ida);
    if(vuelta.fecha||vuelta.numero||vuelta.desde||vuelta.hasta) push(vuelta);
  }
  return res.filter(v=>v.fecha||v.numeroVuelo||v.aerolinea||v.desde||v.hasta||v.horaSalida||v.horaArribo);
}
// 🏨
function normalizeHoteles(g){
  const res=[]; const push=h=>{ if(!h) return; res.push({
    nombre: h.nombre||h.hotel||h.name||'',
    ciudad: h.ciudad||h.localidad||h.ubicacion||'',
    checkIn: h.checkIn||h.in||h.fechaIn||h.ingreso||h.entrada||'',
    checkOut: h.checkOut||h.out||h.fechaOut||h.salida||'',
    telefono: h.telefono||h.fono||h.tel||'',
    web: h.web||h.url||h.website||'',
    notas: h.notas||''
  });};
  const H=g?.hoteles||g?.hotel||g?.hoteleria||g?.alojamiento;
  if(Array.isArray(H)) H.forEach(push); else if(H&&typeof H==='object') push(H);
  if(g?.hotel1||g?.hotel_1) push(g.hotel1||g.hotel_1);
  if(g?.hotel2||g?.hotel_2) push(g.hotel2||g.hotel_2);
  return res.filter(h=>h.nombre||h.ciudad||h.checkIn||h.checkOut||h.telefono||h.web);
}
// 👥 Contactos
function normalizeContactos(g){
  const out=[];
  const push=(etiqueta,persona,telefono,email,extra='')=>{
    if(!(persona||telefono||email||extra)) return;
    out.push({ etiqueta: etiqueta||'CONTACTO', persona: safe(persona,''), telefono: safe(telefono,''), email: safe(email,''), extra: safe(extra,'') });
  };
  const coordNom = g.coordinadorNombre||g.coordinador||g.coordinador_name||g.nombreCoordinador;
  const coordTel = g.coordinadorTelefono||g.telefonoCoordinador||g.coordTelefono||g.coordCelular;
  const coordMail= g.coordinadorEmail||g.coordEmail||g.emailCoordinador||g.coordinador_correo;
  push('COORDINADOR(A)', coordNom, coordTel, coordMail);

  const opsTel = g.operacionesTelefono||g.telefonoOperaciones||g.opsTelefono||g.contactoOperaciones;
  const opsMail= g.operacionesEmail||g.emailOperaciones||g.opsEmail||'operaciones@raitrai.cl';
  push('OPERACIONES RT', 'OPERACIONES', opsTel, opsMail);

  const emer= g.emergenciaNombre||g.contactoEmergencia||'EMERGENCIA';
  const emerTel= g.emergenciaTelefono||g.telefonoEmergencia||g.emergencyPhone||g.fonoEmergencia;
  const emerMail= g.emergenciaEmail||g.emailEmergencia||'';
  push('EMERGENCIA', emer, emerTel, emerMail);

  const provNom = g.proveedor||g.proveedorPrincipal||g.operador||g.agenciaLocal;
  const provTel = g.proveedorTelefono||g.telefonoProveedor;
  const provMail= g.proveedorEmail||g.correoProveedor||g.emailProveedor;
  push('PROVEEDOR', provNom, provTel, provMail);

  return out;
}
// 🛡️ Seguro
function normalizeSeguro(g){
  const aseg = g.seguro||g.aseguradora||g.companiaSeguro||g.seguroCompania;
  const pol  = g.poliza||g.numeroPoliza||g.polizaNumero||g.nroPoliza;
  const tel  = g.telefonoSeguro||g.seguroTelefono||g.asistenciaTelefono||g.assistancePhone;
  const vigI = g.seguroInicio||g.vigenciaInicio||g.seguroVigenciaInicio;
  const vigF = g.seguroFin||g.vigenciaFin||g.seguroVigenciaFin;
  if(!(aseg||pol||tel||vigI||vigF)) return null;
  return { aseguradora:safe(aseg,''), poliza:safe(pol,''), telefono:safe(tel,''), desde:safe(vigI,''), hasta:safe(vigF,'') };
}
// 🚌 Terrestre
function normalizeTerrestre(g){
  const emp = g.empresaBus||g.busEmpresa||g.transportista||g.terrestreEmpresa;
  const sal = g.busSalida||g.idaHora||g.horaBusSalida||g.terrestreSalida;
  const reg = g.busRegreso||g.vueltaHora||g.horaBusRegreso||g.terrestreRegreso;
  const cond= g.conductor||g.conductorNombre||g.chofer||g.driver;
  const pat = g.patente||g.busPatente||
