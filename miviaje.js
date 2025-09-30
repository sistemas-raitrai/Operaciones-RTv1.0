// miviaje.js — Visor SOLO LECTURA (sin auth) con “Hoja” estilo documento
// Lee ?id=<docId> o ?numeroNegocio= (incluye “1475/1411”, “1475-1411”, “1475 y 1411”).
// Si hay varios matches, muestra selector con links ?id=.
// Botones: Copiar enlace / Imprimir. &notas=0 para ocultar notas en actividades.
// Incluye Hoja Resumen como en la imagen: (1) Confirmación salida (2) Vuelos (3) Hotelería (4) Documentos (5) Equipaje (6) Recomendaciones.

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
const safe = (v, fb='—') => (v===0||v)?v:fb;
function normTime(t){
  if(!t) return ''; const s=String(t).trim();
  if(/^\d{1,2}$/.test(s)) return s.padStart(2,'0')+':00';
  const m=s.match(/(\d{1,2})[:hH\.](\d{2})/); if(!m) return '';
  const h=String(Math.max(0,Math.min(23,parseInt(m[1],10)))).padStart(2,'0');
  const mi=String(Math.max(0,Math.min(59,parseInt(m[2],10)))).padStart(2,'0');
  return `${h}:${mi}`;
}
function formatShortDate(iso){ // 25 de septiembre 2025
  if(!iso) return '—';
  const [y,m,d] = iso.split('-').map(Number);
  const dt = new Date(y, m-1, d);
  const mes = dt.toLocaleDateString('es-CL',{month:'long'});
  return `${d} de ${mes} ${y}`;
}
function formatDateRange(ini,fin){ if(!ini||!fin) return '—'; try{
  return `${formatShortDate(ini)} — ${formatShortDate(fin)}`;
} catch { return '—'; } }
function formatDateReadable(iso){ if(!iso) return '—'; const [y,m,d]=iso.split('-').map(Number); const dt=new Date(y,m-1,d); const wd=dt.toLocaleDateString('es-CL',{weekday:'long'}); const name=wd.charAt(0).toUpperCase()+wd.slice(1); return `${name} ${String(d).padStart(2,'0')}/${String(m).padStart(2,'0')}`; }
function getDateRange(s,e){ const out=[]; if(!s||!e) return out; const [sy,sm,sd]=s.split('-').map(Number), [ey,em,ed]=e.split('-').map(Number); const a=new Date(sy,sm-1,sd), b=new Date(ey,em-1,ed); for(let d=new Date(a); d<=b; d.setDate(d.getDate()+1)){ out.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`);} return out; }

/* ───────── normalizadores de datos (vuelos / hoteles, etc.) ───────── */
// ✈️ Vuelos
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
  // ordenar por fecha + hora
  res.sort((a,b)=> new Date(a.fecha||'2100-01-01') - new Date(b.fecha||'2100-01-01')
    || (a.horaSalida||'99:99').localeCompare(b.horaSalida||'99:99'));
  return res.filter(v=>v.fecha||v.numeroVuelo||v.aerolinea||v.desde||v.hasta||v.horaSalida||v.horaArribo);
}
// 🏨 Hoteles
function normalizeHoteles(g){
  const res=[]; const push=h=>{ if(!h) return; res.push({
    nombre: h.nombre||h.hotel||h.name||'',
    ciudad: h.ciudad||h.localidad||h.ubicacion||'',
    checkIn: h.checkIn||h.in||h.fechaIn||h.ingreso||h.entrada||'',
    checkOut: h.checkOut||h.out||h.fechaOut||h.salida||'',
    telefono: h.telefono||h.fono||h.tel||'',
    web: h.web||h.url||h.website||'',
  });};
  const H=g?.hoteles||g?.hotel||g?.hoteleria||g?.alojamiento;
  if(Array.isArray(H)) H.forEach(push); else if(H&&typeof H==='object') push(H);
  if(g?.hotel1||g?.hotel_1) push(g.hotel1||g.hotel_1);
  if(g?.hotel2||g?.hotel_2) push(g.hotel2||g.hotel_2);
  // agrupar por ciudad para el layout estilo imagen
  return res.filter(h=>h.nombre||h.ciudad||h.checkIn||h.checkOut||h.telefono||h.web);
}

/* ───────── UI (selector en caso de varias coincidencias) ───────── */
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

/* ───────── Hoja estilo imagen ───────── */
function renderHojaResumen(grupo){
  // contenedor: insertamos antes del itinerario
  let hoja = document.getElementById('hoja-resumen');
  if(!hoja){
    hoja = document.createElement('section');
    hoja.id = 'hoja-resumen';
    hoja.style.cssText = 'background:#fff;border:1px solid #d1d5db;border-radius:8px;padding:14px;margin:12px 0;';
    const cont = document.getElementById('itinerario-container');
    cont?.parentNode?.insertBefore(hoja, cont);
  }

  // Título como en la imagen
  const colegio = grupo.colegio || grupo.cliente || '';
  const curso   = grupo.curso || grupo.subgrupo || grupo.nombreGrupo || '';
  const titulo  = (colegio || curso)
    ? `Viaje de Estudios ${colegio ? colegio : ''} ${curso ? curso : ''}`.trim()
    : `Viaje de Estudios ${grupo.programa||''}`.trim();

  const fechaViaje = grupo.fechaInicio
    ? formatShortDate(grupo.fechaInicio)
    : (grupo.fecha || '');

  // (1) Confirmación de salida: texto parametrizable o default
  const presentHora   = normTime(grupo.presentacionHora||grupo.horaPresentacion||'03:00');
  const presentLugar  = grupo.presentacionLugar || 'En las puertas del Colegio';
  const aeropuerto    = grupo.presentacionAeropuerto || 'A. Merino Benítez, Terminal 1';
  const presentacion  = `${presentLugar} a las ${presentHora} hrs. A.M para salir con destino al aeropuerto ${aeropuerto}.`;

  // (2) Vuelos
  const vuelos = normalizeVuelos(grupo);
  const vuelosRows = vuelos.map(v=>`
    <tr>
      <td style="padding:6px 8px;border:1px solid #d1d5db;">
        ${v.fecha ? formatShortDate(v.fecha) : '—'}
        ${v.aerolinea ? `<div style="font-size:.85em;color:#374151;">vía ${v.aerolinea}</div>`:''}
      </td>
      <td style="padding:6px 8px;border:1px solid #d1d5db;">${safe(v.numeroVuelo)}</td>
      <td style="padding:6px 8px;border:1px solid #d1d5db;">${safe(v.desde)}</td>
      <td style="padding:6px 8px;border:1px solid #d1d5db;">${safe(v.horaSalida)}</td>
      <td style="padding:6px 8px;border:1px solid #d1d5db;">${safe(v.hasta)}</td>
      <td style="padding:6px 8px;border:1px solid #d1d5db;">${safe(v.horaArribo)}</td>
    </tr>`).join('');

  // (3) Hotelería confirmada: bloques por ciudad
  const hoteles = normalizeHoteles(grupo);
  const hotelesHtml = hoteles.map(h => `
    <div style="display:flex;gap:16px;align-items:flex-start;">
      <div style="width:120px;font-weight:700;">${safe(h.ciudad,'—')}</div>
      <div>
        <div style="font-weight:700;">${safe(h.nombre)}</div>
        <div>In : ${safe(h.checkIn)} </div>
        <div>Out: ${safe(h.checkOut)}</div>
        ${h.telefono?`<div>Fono: <a href="tel:${h.telefono}">${h.telefono}</a></div>`:''}
        ${h.web?`<div>Web: <a href="${h.web}" target="_blank" rel="noopener">${h.web}</a></div>`:''}
      </div>
    </div>
  `).join('<hr style="border:none;border-top:1px dashed #e5e7eb;margin:6px 0;">');

  // (4)(5)(6) Textos (se pueden sobreescribir desde la BD si quieres)
  const docsText = grupo.textos?.documentos || 'Verificar que Cédula de Identidad o Pasaporte, esté en buen estado y vigente (mínimo 6 meses a futuro al momento del viaje).';
  const equipajeText1 = grupo.textos?.equipaje1 || 'Equipaje en bodega 01 Maleta (peso máximo 23 kg.) el cual debe tener como medidas máximo 158 cm lineales (largo, ancho, alto), más un bolso de mano. (peso máximo 5 Kg.)';
  const equipajeText2 = grupo.textos?.equipaje2 || 'Está prohibido transportar líquidos, elementos corto-punzantes o de aseo en el bolso de mano.';
  const recs = grupo.textos?.recomendaciones || [
    'Llevar ropa y calzado, cómodo, adecuado a Clima del Destino. Llevar protector solar',
    'Llevar una botella reutilizable para el consumo de agua',
    'Llevar Saco de Dormir',
    'Llevar toalla, Shampoo y Jabón (Huilo Huilo NO INCLUYE TOALLAS NI AMENIDADES)',
    'Se recomienda que la documentación quede bajo la supervisión de los adultos para evitar su pérdida',
    'Las pertenencias personales son de responsabilidad exclusiva de cada persona, se recomienda que los elementos de valor queden en sus domicilios',
    'Se recomienda que los adultos acompañantes tengan una fotocopia de las Cédulas de Identidad de todos los pasajeros.'
  ];

  hoja.innerHTML = `
    <div style="text-align:center;margin-bottom:10px;">
      <div style="font-size:20px;font-weight:800;">${titulo}</div>
      <div style="font-size:14px;margin-top:2px;">Fecha Viaje: ${fechaViaje}</div>
    </div>

    <ol style="padding-left:18px;margin:0;">
      <li style="margin-bottom:10px;">
        <div style="font-weight:700;">CONFIRMACIÓN DE HORARIO DE SALIDA</div>
        <div>Presentación: ${presentacion}</div>
      </li>

      <li style="margin-bottom:10px;">
        <div style="font-weight:700;">INFORMACIÓN DE VUELOS CONFIRMADOS</div>
        ${vuelos.length?`
        <div style="overflow:auto;margin-top:6px;">
          <table style="border-collapse:collapse;min-width:560px;">
            <thead>
              <tr>
                <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Fecha</th>
                <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">N° de Vuelo</th>
                <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Desde</th>
                <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Horario Salida</th>
                <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Hasta</th>
                <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Horario de Arribo</th>
              </tr>
            </thead>
            <tbody>${vuelosRows}</tbody>
          </table>
        </div>` : `<div style="opacity:.7;">— Sin información de vuelos —</div>`}
      </li>

      <li style="margin-bottom:10px;">
        <div style="font-weight:700;">HOTELERÍA CONFIRMADA</div>
        ${hoteles.length? `<div style="margin-top:6px;display:grid;gap:8px;">${hotelesHtml}</div>` : `<div style="opacity:.7;">— Sin hotelería cargada —</div>`}
      </li>

      <li style="margin-bottom:10px;">
        <div style="font-weight:700;">DOCUMENTOS PARA EL VIAJE</div>
        <ul style="margin:4px 0 0 18px;list-style:disc;">
          <li>${docsText}</li>
        </ul>
      </li>

      <li style="margin-bottom:10px;">
        <div style="font-weight:700;">EQUIPAJE</div>
        <ul style="margin:4px 0 0 18px;list-style:disc;">
          <li>${equipajeText1}</li>
          <li>${equipajeText2}</li>
        </ul>
      </li>

      <li style="margin-bottom:6px;">
        <div style="font-weight:700;">RECOMENDACIONES GENERALES</div>
        <ul style="margin:4px 0 0 18px;list-style:disc;">
          ${Array.isArray(recs) ? recs.map(r=>`<li>${r}</li>`).join('') : `<li>${recs}</li>`}
        </ul>
      </li>
    </ol>

    <div style="text-align:center;font-weight:800;margin-top:12px;">¡¡ TURISMO RAITRAI LES DESEA UN VIAJE INOLVIDABLE !!</div>
  `;
}

/* ───────── impresión (texto plano opcional para PDF simple) ───────── */
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
  fechas.forEach((f,i)=>{
    out+=`Día ${i+1} – ${formatDateReadable(f)}\n`;
    const arr = (grupo.itinerario?.[f] && Array.isArray(grupo.itinerario[f]) ? grupo.itinerario[f] : (grupo.itinerario?.[f] ? Object.values(grupo.itinerario[f]) : [])).sort((a,b)=>(normTime(a?.horaInicio)||'99:99').localeCompare(normTime(b?.horaInicio)||'99:99'));
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

  // Cabecera estándar de tu página
  titleEl && (titleEl.textContent=` ${(g.programa||'—').toString().toUpperCase()}`);
  nombreEl && (nombreEl.textContent=g.nombreGrupo||'—');
  numEl && (numEl.textContent=g.numeroNegocio??g.id??'—');
  destinoEl && (destinoEl.textContent=g.destino||'—');
  fechasEl && (fechasEl.textContent=formatDateRange(g.fechaInicio,g.fechaFin));
  const A=parseInt(g.adultos,10)||0, E=parseInt(g.estudiantes,10)||0;
  if(resumenPax){ const total=(A+E)||g.pax||g.cantidadgrupo||''; resumenPax.textContent = total ? `👥 Total pax: ${total}${(A||E)?` (A:${A} · E:${E})`:''}` : ''; }

  // NUEVO: Hoja estilo documento (como en la imagen)
  renderHojaResumen(g);

  // Itinerario (se mantiene igual)
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

      const src = g.itinerario?.[fecha];
      const arr = (Array.isArray(src) ? src : (src && typeof src==='object' ? Object.values(src) : []))
        .sort((a,b)=>(normTime(a?.horaInicio)||'99:99').localeCompare(normTime(b?.horaInicio)||'99:99'));

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
