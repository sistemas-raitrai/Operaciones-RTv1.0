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
  const pat = g.patente||g.busPatente||g.placa||g.matricula;
  if(!(emp||sal||reg||cond||pat)) return null;
  return { empresa:safe(emp,''), salida:safe(normTime(sal)||sal,''), regreso:safe(normTime(reg)||reg,''), conductor:safe(cond,''), patente:safe(pat,'') };
}
// Itinerario día
function normalizeItinerarioDay(x){ if(Array.isArray(x)) return x.slice(); if(x&&typeof x==='object') return Object.values(x).filter(o=>o&&typeof o==='object'); return []; }

/* ───────── UI ───────── */
function renderSelector(lista, cont, hideNotes){
  cont.innerHTML = `
    <div style="padding:1rem;">
      <h3>Selecciona tu grupo (${lista.length} encontrados):</h3>
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;margin-top:8px;">
        ${lista.map(g=>`
          <a class="activity-card" style="display:block;padding:12px;text-decoration:none;border:1px solid #ddd;border-radius:12px"
             href="?id=${encodeURIComponent(g.id)}${hideNotes?'&notas=0':''}">
            <div style="font-weight:700;margin-bottom:4px;">${(g.nombreGrupo||'—')}</div>
            <div>Programa: ${(g.programa||'—')}</div>
            <div>N° Negocio: ${(g.numeroNegocio??g.id)}</div>
            <div>Fechas: ${(g.fechaInicio||'—')} — ${(g.fechaFin||'—')}</div>
          </a>
        `).join('')}
      </div>
    </div>`;
}
function ensureFichaContainer(){
  let s=document.getElementById('grupo-ficha');
  if(!s){
    s=document.createElement('section'); s.id='grupo-ficha'; s.style.margin='12px 0';
    s.innerHTML=`<h3 style="margin:12px 0 6px;">Ficha del grupo</h3><div id="ficha-inner" class="grid" style="grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;"></div>`;
    const cont=document.getElementById('itinerario-container'); cont?.parentNode?.insertBefore(s, cont);
  }
  return s.querySelector('#ficha-inner');
}
function renderVuelosCard(g){
  const vuelos=normalizeVuelos(g); if(!vuelos.length) return '';
  const rows=vuelos.map(v=>`
    <tr>
      <td>${safe(v.fecha)}</td><td>${safe(v.numeroVuelo)}</td><td>${safe(v.aerolinea)}</td>
      <td>${safe(v.desde)} → ${safe(v.hasta)}</td><td>${safe(v.horaSalida)}</td><td>${safe(v.horaArribo)}</td>
    </tr>`).join('');
  return `<div class="card"><div style="font-weight:700;margin-bottom:6px;">✈️ Vuelos</div>
    <div class="table-wrapper"><table><thead><tr><th>Fecha</th><th>N° Vuelo</th><th>Aerolínea</th><th>Ruta</th><th>Salida</th><th>Arribo</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}
function renderHotelesCard(g){
  const hoteles=normalizeHoteles(g); if(!hoteles.length) return '';
  return `<div class="card"><div style="font-weight:700;margin-bottom:6px;">🏨 Hoteles</div>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;">
      ${hoteles.map(h=>`
        <div style="border:1px dashed #e5e7eb;border-radius:10px;padding:10px;">
          <div style="font-weight:600;">${safe(h.nombre)}</div>
          <div>${safe(h.ciudad)}</div>
          <div>In: ${safe(h.checkIn)} · Out: ${safe(h.checkOut)}</div>
          ${h.telefono?`<div>Tel: <a href="tel:${h.telefono}">${h.telefono}</a></div>`:''}
          ${h.web?`<div>Web: <a href="${h.web}" target="_blank" rel="noopener">${h.web}</a></div>`:''}
          ${h.notas?`<div style="opacity:.85;">📝 ${h.notas}</div>`:''}
        </div>`).join('')}
    </div></div>`;
}
function renderContactosCard(g){
  const C=normalizeContactos(g); if(!C.length) return '';
  const rows=C.map(c=>`
    <tr>
      <td>${safe(c.etiqueta)}</td>
      <td>${safe(c.persona)}</td>
      <td>${c.telefono?`<a href="tel:${c.telefono}">${c.telefono}</a>`:'—'}</td>
      <td>${c.email?`<a href="mailto:${c.email}">${c.email}</a>`:'—'}</td>
    </tr>`).join('');
  return `<div class="card"><div style="font-weight:700;margin-bottom:6px;">👥 Contactos</div>
    <div class="table-wrapper"><table><thead><tr><th>Tipo</th><th>Nombre</th><th>Teléfono</th><th>Correo</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}
function renderSeguroCard(g){
  const S=normalizeSeguro(g); if(!S) return '';
  return `<div class="card"><div style="font-weight:700;margin-bottom:6px;">🛡️ Seguro</div>
    <div class="table-wrapper"><table><tbody>
      <tr><th style="width:140px;">Aseguradora</th><td>${safe(S.aseguradora)}</td></tr>
      <tr><th>N° Póliza</th><td>${safe(S.poliza)}</td></tr>
      <tr><th>Vigencia</th><td>${safe(S.desde)} ${S.hasta?'— '+S.hasta:''}</td></tr>
      <tr><th>Asistencia 24/7</th><td>${S.telefono?`<a href="tel:${S.telefono}">${S.telefono}</a>`:'—'}</td></tr>
    </tbody></table></div></div>`;
}
function renderTerrestreCard(g){
  const T=normalizeTerrestre(g); if(!T) return '';
  return `<div class="card"><div style="font-weight:700;margin-bottom:6px;">🚌 Transporte terrestre</div>
    <div class="table-wrapper"><table><tbody>
      <tr><th style="width:140px;">Empresa</th><td>${safe(T.empresa)}</td></tr>
      <tr><th>Salida</th><td>${safe(T.salida)}</td></tr>
      <tr><th>Regreso</th><td>${safe(T.regreso)}</td></tr>
      <tr><th>Conductor</th><td>${safe(T.conductor)}</td></tr>
      <tr><th>Patente</th><td>${safe(T.patente)}</td></tr>
    </tbody></table></div></div>`;
}
function renderFichaGrupo(g){
  const inner=ensureFichaContainer();
  const blocks=[ renderVuelosCard(g), renderHotelesCard(g), renderContactosCard(g), renderSeguroCard(g), renderTerrestreCard(g) ].filter(Boolean);
  const sec=document.getElementById('grupo-ficha');
  if(!blocks.length){ if(sec) sec.style.display='none'; return; }
  if(sec) sec.style.display='';
  inner.innerHTML = blocks.join('');
}

/* ───────── impresión (texto plano opcional) ───────── */
function buildPrintText(grupo, fechas){
  let out='';
  out += `PROGRAMA: ${(grupo.programa||'—').toString().toUpperCase()}\n`;
  out += `GRUPO: ${grupo.nombreGrupo||'—'}\n`;
  out += `N° NEGOCIO: ${grupo.numeroNegocio??grupo.id??'—'}\n`;
  out += `DESTINO: ${grupo.destino||'—'}\n`;
  out += `FECHAS: ${formatDateRange(grupo.fechaInicio, grupo.fechaFin)}\n\n`;

  const V=normalizeVuelos(grupo);
  if(V.length){ out+='VUELOS\n'; V.forEach(v=>{ const h=[safe(v.horaSalida,''),safe(v.horaArribo,'')].filter(Boolean).join('–'); out+=`• ${safe(v.fecha)}  ${safe(v.numeroVuelo)}  ${safe(v.aerolinea)}  ${safe(v.desde)}→${safe(v.hasta)}  ${h}\n`;}); out+='\n'; }
  const H=normalizeHoteles(grupo);
  if(H.length){ out+='HOTELES\n'; H.forEach(h=>{ out+=`• ${safe(h.nombre)} (${safe(h.ciudad)})  In:${safe(h.checkIn)}  Out:${safe(h.checkOut)}\n`;}); out+='\n'; }
  const C=normalizeContactos(grupo);
  if(C.length){ out+='CONTACTOS\n'; C.forEach(c=>{ out+=`• ${safe(c.etiqueta)} — ${safe(c.persona)} — ${safe(c.telefono)} — ${safe(c.email)}\n`;}); out+='\n'; }
  const S=normalizeSeguro(grupo);
  if(S){ out+='SEGURO\n'; out+=`• ${safe(S.aseguradora)}  Póliza:${safe(S.poliza)}  Vigencia:${safe(S.desde)} ${S.hasta?('— '+S.hasta):''}  Asistencia:${safe(S.telefono)}\n\n`; }
  const T=normalizeTerrestre(grupo);
  if(T){ out+='TRANSPORTE TERRESTRE\n'; out+=`• ${safe(T.empresa)}  Salida:${safe(T.salida)}  Regreso:${safe(T.regreso)}  Conductor:${safe(T.conductor)}  Patente:${safe(T.patente)}\n\n`; }

  fechas.forEach((f,i)=>{
    out+=`Día ${i+1} – ${formatDateReadable(f)}\n`;
    const arr=normalizeItinerarioDay(grupo.itinerario?.[f]).sort((a,b)=>(normTime(a?.horaInicio)||'99:99').localeCompare(normTime(b?.horaInicio)||'99:99'));
    if(!arr.length){ out+='— Sin actividades —\n\n'; return; }
    arr.forEach(act=>{
      const hi=normTime(act.horaInicio)||'--:--', hf=normTime(act.horaFin), rango=hf?` – ${hf}`:'';
      const name=(act.actividad||'').toString().toUpperCase();
      const a=parseInt(act.adultos,10)||0, e=parseInt(act.estudiantes,10)||0, pax=(a+e)||act.pasajeros||0;
      out+=`${hi}${rango}  ${name}${pax?` 👥 ${pax} pax`:''}\n\n`;
    });
    out+='\n';
  });
  return out.trimEnd();
}

/* ───────── main ───────── */
async function main(){
  const { numeroNegocio, id, hideNotes } = getParamsFromURL();
  const titleEl=document.getElementById('grupo-title');
  const nombreEl=document.getElementById('grupo-nombre');
  const numEl=document.getElementById('grupo-numero');
  const destinoEl=document.getElementById('grupo-destino');
  const fechasEl=document.getElementById('grupo-fechas');
  const resumenPax=document.getElementById('resumen-pax');
  const cont=document.getElementById('itinerario-container');
  const printEl=document.getElementById('print-block');
  const btnPrint=document.getElementById('btnPrint');
  const btnShare=document.getElementById('btnShare');
  btnPrint?.addEventListener('click',()=>window.print());

  if(!numeroNegocio && !id){
    cont.innerHTML='<p style="padding:1rem;">Falta <code>numeroNegocio</code> o <code>id</code> en la URL.</p>';
    if(printEl) printEl.textContent=''; return;
  }

  let g=await fetchGrupoById(id);
  if(!g){
    const lista=await buscarGruposPorNumero(numeroNegocio);
    if(!lista.length){ cont.innerHTML=`<p style="padding:1rem;">No se encontró el grupo ${numeroNegocio}.</p>`; if(printEl) printEl.textContent=''; return; }
    if(lista.length>1){
      renderSelector(lista,cont,hideNotes);
      const shareUrl=`${location.origin}${location.pathname}?numeroNegocio=${encodeURIComponent(numeroNegocio)}${hideNotes?'&notas=0':''}`;
      btnShare?.addEventListener('click', async ()=>{ try{ await navigator.clipboard.writeText(shareUrl); alert('Enlace copiado'); }catch{ const i=document.createElement('input'); i.value=shareUrl; document.body.appendChild(i); i.select(); document.execCommand('copy'); i.remove(); alert('Enlace copiado'); }});
      if(printEl) printEl.textContent=''; return;
    }
    g=lista[0];
  }

  const idLink = g?.id ? `?id=${encodeURIComponent(g.id)}` : `?numeroNegocio=${encodeURIComponent(numeroNegocio||'')}`;
  const shareUrl=`${location.origin}${location.pathname}${idLink}${hideNotes?'&notas=0':''}`;
  btnShare?.addEventListener('click', async ()=>{ try{ await navigator.clipboard.writeText(shareUrl); alert('Enlace copiado'); }catch{ const i=document.createElement('input'); i.value=shareUrl; document.body.appendChild(i); i.select(); document.execCommand('copy'); i.remove(); alert('Enlace copiado'); }});

  titleEl && (titleEl.textContent=` ${(g.programa||'—').toString().toUpperCase()}`);
  nombreEl && (nombreEl.textContent=g.nombreGrupo||'—');
  numEl && (numEl.textContent=g.numeroNegocio??g.id??'—');
  destinoEl && (destinoEl.textContent=g.destino||'—');
  fechasEl && (fechasEl.textContent=formatDateRange(g.fechaInicio,g.fechaFin));

  const A=parseInt(g.adultos,10)||0, E=parseInt(g.estudiantes,10)||0;
  if(resumenPax){ const total=(A+E)||g.pax||g.cantidadgrupo||''; resumenPax.textContent = total ? `👥 Total pax: ${total}${(A||E)?` (A:${A} · E:${E})`:''}` : ''; }

  // FICHA
  renderFichaGrupo(g);

  // Fechas e Itinerario
  let fechas=[];
  if(g.itinerario && typeof g.itinerario==='object') fechas=Object.keys(g.itinerario).sort((a,b)=>new Date(a)-new Date(b));
  else if(g.fechaInicio && g.fechaFin) fechas=getDateRange(g.fechaInicio,g.fechaFin);

  cont.innerHTML='';
  if(!fechas.length){
    cont.innerHTML='<p style="padding:1rem;">No hay itinerario disponible.</p>';
    if(printEl) printEl.textContent=buildPrintText(g,[]);
  }else{
    fechas.forEach((fecha,idx)=>{
      const sec=document.createElement('section'); sec.className='dia-seccion'; sec.dataset.fecha=fecha;
      sec.innerHTML=`<h3 class="dia-titulo"><span class="dia-label">Día ${idx+1}</span> – <span class="dia-fecha">${formatDateReadable(fecha)}</span></h3><ul class="activity-list"></ul>`;
      const ul=sec.querySelector('.activity-list');
      const arr=normalizeItinerarioDay(g.itinerario?.[fecha]).sort((a,b)=>(normTime(a?.horaInicio)||'99:99').localeCompare(normTime(b?.horaInicio)||'99:99'));
      if(!arr.length){ ul.innerHTML='<li class="empty">— Sin actividades —</li>'; }
      else{
        arr.forEach(act=>{
          const li=document.createElement('li'); li.className='activity-card';
          const notesHtml = hideNotes ? '' : (act.notas?`<p style="opacity:.85;">📝 ${act.notas}</p>`:'');
          li.innerHTML = `<p><strong>${(act.actividad||'').toString().toUpperCase()}</strong></p>${notesHtml}`;
          ul.appendChild(li);
        });
      }
      cont.appendChild(sec);
    });
    if(printEl) printEl.textContent=buildPrintText(g,fechas);
  }
}

main().catch(err=>{
  console.error('Firestore error:', err?.code||err?.message, err);
  const cont=document.getElementById('itinerario-container');
  if(cont) cont.innerHTML='<p style="padding:1rem;color:#b00;">Error cargando el itinerario.</p>';
  const printEl=document.getElementById('print-block'); if(printEl) printEl.textContent='';
});
