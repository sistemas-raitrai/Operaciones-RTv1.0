import {
  auth,
  db,
  isOperationsStaff
} from './firebase-init.js';

import {
  onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';

import {
  collection,
  getDocs,
  getDoc,
  doc,
  query,
  where
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

function clean(value = '') {
  return String(value ?? '').trim();
}

function escapeHtml(value = '') {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function passengerName(item = {}) {
  return clean(
    item.identificacion?.nombreCompleto ||
    [
      item.identificacion?.nombres,
      item.identificacion?.primerApellido,
      item.identificacion?.segundoApellido
    ].filter(Boolean).join(' ')
  ) || 'Pasajero sin nombre';
}

function isArchived(item = {}) {
  return ['ARCHIVADA', 'ELIMINADA_LOGICA'].includes(
    normalizar(item.privacidad?.estado)
  );
}

function isCancelled(item = {}) {
  return item.anulado === true ||
    normalizar(item.estadoViaje) === 'ANULADO' ||
    normalizar(item.estado) === 'ANULADO' ||
    normalizar(item.privacidad?.estado) === 'ANULADA';
}

async function loadGroupInscriptions(groupDocId) {
  const snap = await getDocs(
    collection(
      db,
      'ventas_cotizaciones',
      clean(groupDocId),
      'inscripciones'
    )
  );

  return snap.docs
    .map(item => ({
      ...item.data(),
      id: item.id
    }))
    .filter(item => !isArchived(item))
    .sort((a, b) =>
      passengerName(a).localeCompare(passengerName(b), 'es')
    );
}

// Ambas variantes existen en los datos actuales:
// anoViaje numérico y anoViaje como texto.
async function documentosDelAno(nombreColeccion, ano) {
  const resultados = await Promise.all([
    getDocs(query(
      collection(db, nombreColeccion),
      where('anoViaje', '==', Number(ano))
    )),
    getDocs(query(
      collection(db, nombreColeccion),
      where('anoViaje', '==', String(ano))
    ))
  ]);

  const documentos = new Map();

  for (const resultado of resultados) {
    for (const documento of resultado.docs) {
      documentos.set(documento.id, documento);
    }
  }

  return [...documentos.values()];
}

const $ = id => document.getElementById(id);
const estado = { grupos: [], filas: [], filtradas: [], incidencias: [], cargando: false };
const DESTINOS_SERVICIOS = ['BRASIL', 'BARILOCHE', 'SUR DE CHILE', 'NORTE DE CHILE'];

function normalizar(v) {
  return String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/\s+/g, ' ').trim();
}
function fechaISO(v) {
  if (!v) return '';
  if (typeof v === 'string') {
    const iso = v.match(/^(\d{4}-\d{2}-\d{2})/);
    if (iso) return iso[1];
    const lat = v.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
    if (lat) return `${lat[3]}-${lat[2].padStart(2,'0')}-${lat[1].padStart(2,'0')}`;
  }
  const d = v?.toDate?.() || v;
  return d instanceof Date && !Number.isNaN(d.getTime())
    ? `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` : '';
}
function fechaVisible(iso) { return iso ? iso.split('-').reverse().join('-') : 'Sin fecha'; }
function numerosNegocio(g = {}) { return String(g.numeroNegocio ?? g.negocioId ?? '').trim(); }
function negociosIndividuales(valor) {
  const numeros = String(valor ?? '').match(/\d+/g) || [];

  return [...new Set(
    numeros.map(numero => numero.replace(/^0+(?=\d)/, ''))
  )];
}
function destinosDeGrupo(g = {}) {
  const s = normalizar([g.destinoPrincipal, g.destino].filter(Boolean).join(' '));
  if (s.includes('BRASIL')) return ['BRASIL'];
  if (s.includes('BARILOCHE') && s.includes('SUR DE CHILE')) return ['BARILOCHE','SUR DE CHILE'];
  return DESTINOS_SERVICIOS.filter(d => s.includes(d));
}

function etiquetaAlimentacion(valor) {
  const texto = clean(valor);
  if (!texto) return '';

  const clave = normalizar(texto)
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const etiquetas = {
    'SIN LACTOSA': 'Sin lactosa',
    'SIN GLUTEN': 'Sin gluten',
    'VEGETARIANA': 'Vegetariana',
    'VEGETARIANO': 'Vegetariana',
    'VEGANA': 'Vegana',
    'VEGANO': 'Vegana',
    'SIN CERDO': 'Sin cerdo',
    'SIN CARNE': 'Sin carne',
    'SIN FRUTOS SECOS': 'Sin frutos secos',
    'OTRA': 'Otra',
    'OTRO': 'Otro'
  };

  if (etiquetas[clave]) return etiquetas[clave];

  const legible = texto.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();

  return legible.charAt(0).toLocaleUpperCase('es')
    + legible.slice(1);
}

function etiquetasAlimentacion(valores = []) {
  return [...new Set(
    valores.map(etiquetaAlimentacion).filter(Boolean)
  )];
}

function fechaDocumento(iso) {
  if (!iso) return 'Sin fecha informada';

  const fecha = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(fecha.getTime())) return fechaVisible(iso);

  return fecha.toLocaleDateString('es-CL', {
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
}

function datosAlimentacion(items) {
  return items.filter(i => !isCancelled(i)).map(i => {
    const s = i.salud || {};
    const tipos = Array.isArray(s.dietaTipos) ? s.dietaTipos.map(clean).filter(Boolean) : [];
    const restricciones = Array.isArray(s.dietaRestricciones) ? s.dietaRestricciones.map(clean).filter(Boolean) : [];
    const alergias = Array.isArray(s.alergiasAlimentarias)
      ? s.alergiasAlimentarias.map(a => clean(typeof a === 'string' ? a : a?.alimento || a?.detalle)).filter(Boolean) : [];
    const detalle = clean(s.dietaDetalle);
    const informada = normalizar(s.dietaFlag) === 'SI' || tipos.length || restricciones.length || alergias.length || detalle;
    return informada ? {
      id: i.id || '', nombre: clean(passengerName(i)) || 'Nombre no registrado',
      tipos, restricciones, alergias, detalle,
      pendiente: !tipos.length && !restricciones.length && !alergias.length && !detalle
    } : null;
  }).filter(Boolean).sort((a,b) => a.nombre.localeCompare(b.nombre,'es',{sensitivity:'base'}));
}
function resumenPersonas(personas) {
  return tipos(personas);
}

function tipos(personas) {
  const conteo = new Map();

  for (const persona of personas) {
    const categorias = etiquetasAlimentacion(persona.tipos);

    for (const categoria of categorias) {
      conteo.set(categoria, (conteo.get(categoria) || 0) + 1);
    }
  }

  return [...conteo]
    .sort((a, b) => a[0].localeCompare(b[0], 'es'))
    .map(([categoria, cantidad]) => `${categoria}: ${cantidad}`)
    .join(' · ') || 'Ver restricciones y observaciones';
}
function itemHotel(h) {
  const nombre = clean(h.hotelNombre || h.nombre || h.hotel?.nombre);
  const desde = fechaISO(h.checkIn);
  const hasta = fechaISO(h.checkOut);
  return nombre ? { nombre, desde, hasta, id: String(h.hotelId || h.id || normalizar(nombre)) } : null;
}
function esComida(nombre, dato = {}) {
  const texto = normalizar(nombre);
  const clase = normalizar(dato.tipoComida || dato.comidaIncluida || '');
  if (/\bALMUERZO\b/.test(texto) || clase.includes('ALMUERZO')) return 'Almuerzo';
  if (/\bCENA\b/.test(texto) || clase.includes('CENA')) return 'Cena';
  if (/\bDESAYUNO\b/.test(texto) || clase.includes('DESAYUNO')) return 'Desayuno';
  return '';
}
async function cargarCatalogo(ano) {
  const mapa = new Map();
  for (const destino of DESTINOS_SERVICIOS) {
    const snap = await getDocs(collection(db,'ServiciosPorAno',String(ano),'Destinos',destino,'Listado'));
    for (const d of snap.docs) {
      const x = d.data() || {};
      const nombre = clean(x.servicio || d.id);
      mapa.set(`${destino}|${normalizar(nombre)}`, {
        nombre, destino, proveedor: clean(x.proveedor || x.Proveedor) || 'Proveedor no identificado',
        comida: esComida(nombre,x)
      });
    }
  }
  return mapa;
}
function claveGrupoCalendario(g) {
  return String(g.numeroNegocio || '').trim();
}
function llenarSelect(id, values, nombreTodos) {
  const el = $(id), anterior = el.value;
  el.replaceChildren(new Option(nombreTodos,''),...values.map(v => new Option(v.label,v.value)));
  if (values.some(v => v.value === anterior)) el.value = anterior;
}
async function cargar() {
  if (estado.cargando) return;
  estado.cargando = true; estado.grupos = []; estado.filas = []; estado.filtradas = []; estado.incidencias = [];
  $('deResultados').hidden = true; $('deImprimir').disabled = true; $('deCargar').disabled = true;
  const ano = Number($('deAno').value);
  try {
    $('deEstado').textContent = `Cargando grupos ${ano}…`;
  const [
    gruposOperaciones,
    resumenesVentas,
    documentosCalendario,
    catalogo
  ] = await Promise.all([
    documentosDelAno('grupos', ano),
    documentosDelAno('ventas_grupos_resumen', ano),
    documentosDelAno('operaciones_calendario_resumen', ano),
    cargarCatalogo(ano)
  ]);
  
  // El listado lo determina Operaciones.
  // Ventas solo aporta el vínculo hacia las inscripciones.
  const resumenes = gruposOperaciones;
  
  // Cada número individual puede apuntar a varios documentos de Ventas.
  const ventasPorNegocio = new Map();
  
  for (const documento of resumenesVentas) {
    const datos = documento.data() || {};
    const negocios = negociosIndividuales(numerosNegocio(datos));
    const docId = clean(datos.groupDocId || documento.id);
  
    if (!docId || !negocios.length) continue;
  
    for (const negocio of negocios) {
      if (!ventasPorNegocio.has(negocio)) {
        ventasPorNegocio.set(negocio, new Set());
      }
  
      ventasPorNegocio.get(negocio).add(docId);
    }
  }
  
  const cal = {
    docs: documentosCalendario
  };
    const calendario = new Map();
    for (const d of cal.docs) {
      const g = d.data() || {};
      if (String(g.anoViaje || '') !== String(ano)) continue;
      const n = claveGrupoCalendario(g);
      if (n) calendario.set(n,g);
    }
    const filas = [];
    for (let i=0;i<resumenes.length;i+=5) {
      const lote = await Promise.all(resumenes.slice(i,i+5).map(async d => {
        const operacion = d.data() || {};
        const negocio = numerosNegocio(operacion);
        
        if (!negocio) {
          estado.incidencias.push(
            `Grupo de Operaciones ${d.id} sin número de negocio.`
          );
          return [];
        }
        
        const negociosOperacion = negociosIndividuales(negocio);
        
        if (!negociosOperacion.length) {
          estado.incidencias.push(
            `Grupo de Operaciones ${d.id}: no se pudieron reconocer sus números de negocio.`
          );
          return [];
        }
        
        // Reúne todos los documentos asociados a cualquiera
        // de los números del grupo de Operaciones.
        const idsVentas = new Set();
        
        for (const numero of negociosOperacion) {
          const coincidencias = ventasPorNegocio.get(numero);
        
          if (!coincidencias?.size) {
            estado.incidencias.push(
              `Negocio ${negocio}: no se encontró vínculo de Ventas para ${numero}.`
            );
            continue;
          }
        
          for (const id of coincidencias) {
            idsVentas.add(id);
          }
        }
        
        if (!idsVentas.size) return [];
        
        const documentosVentas = await Promise.all(
          [...idsVentas].map(async id => {
            const ref = await getDoc(
              doc(db, 'ventas_cotizaciones', id)
            );
        
            if (!ref.exists()) {
              estado.incidencias.push(
                `Negocio ${negocio}: no existe el grupo de Ventas ${id}.`
              );
              return null;
            }
        
            const datos = ref.data() || {};
            const negocioVentas = numerosNegocio(datos);
            const numerosVentas = negociosIndividuales(negocioVentas);
        
            // Si el documento informa un negocio, debe compartir
            // al menos un número con el grupo de Operaciones.
            if (
              negocioVentas &&
              !numerosVentas.some(numero => negociosOperacion.includes(numero))
            ) {
              estado.incidencias.push(
                `Negocio ${negocio}: el grupo de Ventas ${id} tiene otro número de negocio (${negocioVentas}).`
              );
              return null;
            }
        
            return { id, datos };
          })
        );
        
        const ventasVinculadas = documentosVentas.filter(Boolean);
        
        if (!ventasVinculadas.length) return [];
        
        // La identidad de la fila corresponde al documento de Operaciones.
        // Así, dos grupos operativos que compartan un documento de Ventas
        // siguen apareciendo como grupos diferentes.
        const docId = d.id;
        
        // Solo se usa como respaldo de los datos operativos.
        const ventas = ventasVinculadas[0].datos;
                
        // Conservamos "g" y "x" porque el resto de la función
        // utiliza esos nombres. Los datos operativos tienen prioridad.
        const g = {
          ...ventas,
          ...operacion,
          numeroNegocio: negocio
        };
        
        const x = operacion;
        
        const c = calendario.get(negocio) || {};
        
        if (!calendario.has(negocio)) {
          estado.incidencias.push(
            `Negocio ${negocio}: falta el calendario operativo resumido; no se podrán identificar sus hoteles y comidas.`
          );
        }
        
        const lotesInscripciones = await Promise.all(
          ventasVinculadas.map(async grupoVentas => {
            const items = await loadGroupInscriptions(grupoVentas.id);
        
            return items.map(item => ({
              ...item,
        
              // Evita confundir inscripciones con el mismo ID
              // ubicadas en documentos de Ventas diferentes.
              id: `${grupoVentas.id}|${item.id}`,
              groupDocId: grupoVentas.id,
              inscripcionId: item.id
            }));
          })
        );
        
        const inscripciones = lotesInscripciones
          .flat()
          .sort((a, b) =>
            passengerName(a).localeCompare(passengerName(b), 'es')
          );
        
        const personas = datosAlimentacion(inscripciones);
        
        if (!personas.length) return [];
        
        const colegioCurso = [
          clean(operacion.colegio),
          clean(operacion.curso)
        ].filter(Boolean).join(' · ');
        
        const nombre = clean(
          colegioCurso ||
          operacion.nombreGrupo ||
          operacion.aliasGrupo ||
          ventas.aliasGrupo ||
          ventas.nombreGrupo ||
          negocio
        );
        estado.grupos.push({ idGrupo: docId, negocio, grupo: nombre, personas,
          fecha: fechaISO(g.fechaInicio || c.fechaInicio),
          fechaFin: fechaISO(g.fechaFin || c.fechaFin) });
        const base = { idGrupo:docId, negocio, grupo:nombre, personas, destino:clean(c.destino || g.destino) };
        const out = [];
        for (const raw of (Array.isArray(c.hoteles) ? c.hoteles : [])) {
          const h = itemHotel(raw); if (!h) continue;
          out.push({...base,tipo:'hotel',entidad:h.nombre,entidadId:h.id,proveedor:h.nombre,
            fecha:h.desde,fechaFin:h.hasta});
        }
        for (const [dia,actividades] of Object.entries(c.itinerario || {})) {
          if (!Array.isArray(actividades)) continue;
          for (const actividad of actividades) {
            const nombreActividad = clean(actividad?.actividad);
            const coincidencias = destinosDeGrupo({...g,...c}).map(dest => catalogo.get(`${dest}|${normalizar(nombreActividad)}`)).filter(Boolean);
            const unicas = [...new Map(coincidencias.map(s=>[`${s.destino}|${normalizar(s.nombre)}`,s])).values()];
            if (unicas.length > 1) { estado.incidencias.push(`${negocio} · ${dia}: servicio ambiguo ${nombreActividad}`); continue; }
            const servicio = unicas[0];
            if (!servicio) {
              if (/ALMUERZO|CENA|DESAYUNO|TOM WESLEY|BETO CARRERO/i.test(normalizar(nombreActividad)))
                estado.incidencias.push(`${negocio} · ${dia}: comida sin servicio asociado: ${nombreActividad}`);
              continue;
            }
            if (!servicio.comida) {
              if (/TOM WESLEY|BETO CARRERO/.test(normalizar(nombreActividad)))
                estado.incidencias.push(`${negocio} · ${dia}: confirmar si incluye comida: ${nombreActividad}`);
              continue;
            }
            const asistentes = Number(actividad.adultos || 0) + Number(actividad.estudiantes || 0);
            const pasajeros = inscripciones.filter(p => !isCancelled(p)).length;
            if (asistentes > 0 && asistentes < pasajeros)
              estado.incidencias.push(`${negocio} · ${dia}: ${nombreActividad} registra ${asistentes} asistentes frente a ${pasajeros} pasajeros; confirmar cuáles requieren dieta.`);
            out.push({...base,tipo:'servicio',entidad:`${servicio.comida} · ${servicio.nombre}`,
              entidadId:`${servicio.destino}|${normalizar(servicio.nombre)}`,proveedor:servicio.proveedor,fecha:fechaISO(dia),fechaFin:''});
          }
        }
        return out;
      }));
      filas.push(...lote.flat());
      $('deEstado').textContent =
        `Revisados ${Math.min(i + 5, resumenes.length)} ` +
        `de ${resumenes.length} grupos de Operaciones…`;
    }
    estado.filas = [...new Map(filas.map(r => [[r.idGrupo,r.tipo,r.entidadId,r.fecha].join('|'),r])).values()];
    estado.grupos.sort((a,b)=>(a.fecha||'9999').localeCompare(b.fecha||'9999') || a.grupo.localeCompare(b.grupo,'es'));
    llenarSelect('deGrupo',[...new Map(estado.grupos.map(r=>[r.idGrupo,{value:r.idGrupo,label:`${r.grupo} · ${r.negocio}`}])).values()].sort((a,b)=>a.label.localeCompare(b.label,'es')),'Todos');
    const grupoSolicitado = new URLSearchParams(location.search).get('id');
    if (grupoSolicitado) $('deGrupo').value = grupoSolicitado;
    llenarSelect('deHotel',[...new Map(estado.filas.filter(r=>r.tipo==='hotel').map(r=>[r.entidadId,{value:r.entidadId,label:r.entidad}])).values()].sort((a,b)=>a.label.localeCompare(b.label,'es')),'Todos');
    llenarSelect('deProveedor',[...new Set(estado.filas.filter(r=>r.tipo==='servicio').map(r=>r.proveedor))].sort((a,b)=>a.localeCompare(b,'es')).map(v=>({value:v,label:v})),'Todos');
    mostrar();
  } catch(e) {
    console.error('[dietas]',e); $('deEstado').textContent = `No se completó la consulta: ${e.message}`;
    $('deEstado').className = 'de-danger'; estado.filas=[];estado.grupos=[]; $('deResultados').hidden=true;
  } finally { estado.cargando=false; $('deCargar').disabled=false; }
}
function personasHTML(personas) {
  return `<ol>${personas.map(p => {
    const dietas = etiquetasAlimentacion(p.tipos);
    const restricciones = etiquetasAlimentacion(p.restricciones);
    const alergias = etiquetasAlimentacion(p.alergias);

    const partes = [];

    if (dietas.length) {
      partes.push(escapeHtml(dietas.join(', ')));
    }

    if (restricciones.length) {
      partes.push(
        `Restricciones: ${escapeHtml(restricciones.join(', '))}`
      );
    }

    if (alergias.length) {
      partes.push(
        `<strong>Alergias alimentarias: ${
          escapeHtml(alergias.join(', '))
        }</strong>`
      );
    }

    if (p.detalle) {
      partes.push(escapeHtml(p.detalle));
    }

    if (p.pendiente) {
      partes.push('Requerimiento informado, pendiente de detalle');
    }

    return `<li>
      <strong>${escapeHtml(p.nombre)}</strong>
      — ${partes.join(' · ')}
    </li>`;
  }).join('')}</ol>`;
}

function visibleGrupo(g) {
  const grupo=$('deGrupo').value, desde=$('deDesde').value, hasta=$('deHasta').value;
  if (desde && hasta && desde>hasta) throw new Error('La fecha desde es posterior a la fecha hasta.');
  if (grupo && g.idGrupo!==grupo) return false;
  if (desde && (!g.fechaFin && !g.fecha || (g.fechaFin || g.fecha)<desde)) return false;
  if (hasta && (!g.fecha || g.fecha>hasta)) return false;
  return true;
}
function filasProveedor(grupos) {
  const ids=new Set(grupos.map(g=>g.idGrupo));
  const hotel=$('deHotel').value, proveedor=$('deProveedor').value;
  return estado.filas.filter(r=>ids.has(r.idGrupo)
    && (!hotel || r.tipo==='hotel' && r.entidadId===hotel)
    && (!proveedor || r.tipo==='servicio' && r.proveedor===proveedor)
    && (!($('deDesde').value) || (r.fechaFin||r.fecha)>=$('deDesde').value)
    && (!($('deHasta').value) || r.fecha<=$('deHasta').value))
    .sort((a,b)=>(a.fecha||'9999').localeCompare(b.fecha||'9999') || a.grupo.localeCompare(b.grupo,'es'));
}
function mostrar() {
  let grupos, filas;
  try {
    grupos=estado.grupos.filter(visibleGrupo);
    filas=filasProveedor(grupos);
  } catch(e) { $('deEstado').textContent=e.message;$('deEstado').className='error';return; }
  const vista=$('deVista').value;
  const relevantes=vista==='proveedor'?grupos.filter(g=>filas.some(r=>r.idGrupo===g.idGrupo)):grupos;
  const unicas=relevantes.flatMap(g=>g.personas.map(p=>({ ...p, clave:g.idGrupo+'|'+p.id })));
  $('deTotales').textContent=relevantes.length+' grupos · '+unicas.length+' personas únicas · '+tipos(unicas)
    +(vista==='proveedor'?' · '+filas.length+' asignaciones; confirmar asistentes antes de enviar cantidades.':'');
  estado.mostrados={grupos,filas};
  $('deCabecera').innerHTML=vista==='proveedor'
    ? '<tr><th>Fecha</th><th>Grupo · negocio</th><th>Tipo</th><th>Hotel / servicio</th><th>Proveedor</th><th>Personas y dietas</th><th>Detalle</th></tr>'
    : '<tr><th>Salida</th><th>Grupo</th><th>N.º negocio</th><th>Personas</th><th>Tipos de dieta</th><th>Detalle</th></tr>';
  $('deFilas').innerHTML=vista==='proveedor'
    ? filas.map((r,i)=>'<tr><td>'+escapeHtml(fechaVisible(r.fecha))+(r.fechaFin?' → '+escapeHtml(fechaVisible(r.fechaFin)):'')+'</td><td>'+escapeHtml(r.grupo)+' · '+escapeHtml(r.negocio)+'</td><td>'+(r.tipo==='hotel'?'Hotel':'Comida')+'</td><td>'+escapeHtml(r.entidad)+'</td><td>'+escapeHtml(r.proveedor)+'</td><td>'+r.personas.length+' · '+escapeHtml(tipos(r.personas))+'</td><td><button type="button" data-vista="proveedor" data-indice="'+i+'">Ver nómina</button></td></tr>').join('')
    : grupos.map((g,i)=>'<tr><td>'+escapeHtml(fechaVisible(g.fecha))+'</td><td>'+escapeHtml(g.grupo)+'</td><td>'+escapeHtml(g.negocio)+'</td><td>'+g.personas.length+'</td><td>'+escapeHtml(tipos(g.personas))+'</td><td><button type="button" data-vista="grupo" data-indice="'+i+'">Ver nómina</button></td></tr>').join('');
  if (!$('deFilas').innerHTML) $('deFilas').innerHTML='<tr><td colspan="7">Sin datos para estos filtros.</td></tr>';
  $('deResultados').hidden=false;$('deImprimir').disabled=!(vista==='proveedor'?filas.length:grupos.length);
  $('deEstado').className='de-muted';$('deEstado').textContent=estado.incidencias.length+' vínculos requieren revisión.';
  $('deRevision').hidden=!estado.incidencias.length;
  $('deRevisionLista').innerHTML=estado.incidencias.map(v=>'<li>'+escapeHtml(v)+'</li>').join('');
}
function imprimir() {
  const esProveedor = $('deVista').value === 'proveedor';
  const mostrados = estado.mostrados || { grupos: [], filas: [] };
  const datos = esProveedor ? mostrados.filas : mostrados.grupos;

  if (!datos.length) return;

  if (
    esProveedor &&
    !$('deProveedor').value &&
    !$('deHotel').value
  ) {
    alert('Selecciona un proveedor o un hotel para imprimir.');
    return;
  }

  const ventana = window.open('', '_blank');

  if (!ventana) {
    alert('Permite ventanas emergentes para imprimir.');
    return;
  }

  const logo = new URL('IMG/logo-raitrai.png', location.href).href;

  const emitido = new Date().toLocaleString('es-CL', {
    timeZone: 'America/Santiago',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  // Permite comparar etiquetas sin diferencias de mayúsculas,
  // tildes o guiones bajos.
  function claveTexto(valor) {
    return normalizar(valor)
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function etiquetasUnicas(valores = []) {
    const resultado = new Map();

    for (const valor of valores) {
      const etiqueta = etiquetaAlimentacion(valor);
      const clave = claveTexto(etiqueta);

      if (clave && !resultado.has(clave)) {
        resultado.set(clave, etiqueta);
      }
    }

    return [...resultado.values()];
  }

  function requerimientos(persona) {
    return etiquetasUnicas([
      ...(persona.tipos || []),
      ...(persona.restricciones || [])
    ]);
  }

  // Presenta la comida sin repetir el nombre del restaurante.
  // Si hay más de una, conserva ambas.
  function nombreComida(entidad) {
    const texto = normalizar(entidad);

    const opciones = [
      ['DESAYUNO', 'Desayuno'],
      ['ALMUERZO', 'Almuerzo'],
      ['CENA', 'Cena'],
      ['ONCE', 'Once'],
      ['COLACION', 'Colación'],
      ['COFFEE BREAK', 'Coffee break'],
      ['CAFE BREAK', 'Coffee break'],
      ['BOX LUNCH', 'Box lunch'],
      ['PICNIC', 'Picnic'],
      ['MERIENDA', 'Merienda']
    ];

    const encontradas = opciones
      .filter(([clave]) => texto.includes(clave))
      .map(([, etiqueta]) => etiqueta);

    return [...new Set(encontradas)].join(' y ')
      || clean(entidad).replace(/_+/g, ' ')
      || 'Servicio de alimentación';
  }

  function resumenGrupo(personas) {
    const conteo = new Map();

    for (const persona of personas) {
      for (const etiqueta of requerimientos(persona)) {
        const clave = claveTexto(etiqueta);

        if (!conteo.has(clave)) {
          conteo.set(clave, { etiqueta, cantidad: 0 });
        }

        conteo.get(clave).cantidad++;
      }
    }

    return [...conteo.values()]
      .sort((a, b) => a.etiqueta.localeCompare(b.etiqueta, 'es'))
      .map(item => `${item.etiqueta}: ${item.cantidad}`)
      .join(' · ');
  }

  function tablaPersonas(personas) {
    const filas = personas.map((persona, indice) => {
      const requisitos = requerimientos(persona);
      const alergias = etiquetasUnicas(persona.alergias || []);
      const observaciones = [];

      // Las alergias siempre se mantienen explícitas.
      if (alergias.length) {
        observaciones.push(`
          <div class="alergia">
            Alergias alimentarias:
            ${escapeHtml(alergias.join(', '))}
          </div>
        `);
      }

      const detalle = clean(persona.detalle);

      // Evita repetir un detalle que sea exactamente igual
      // a un requerimiento. Conserva los textos más extensos.
      const detalleRepetido = detalle && requisitos.some(
        requisito => claveTexto(requisito) === claveTexto(detalle)
      );

      if (detalle && !detalleRepetido) {
        observaciones.push(`
          <div>${escapeHtml(detalle)}</div>
        `);
      }

      if (persona.pendiente) {
        observaciones.push(`
          <div><strong>Pendiente de especificación.</strong></div>
        `);
      }

      return `
        <tr>
          <td class="numero">${indice + 1}</td>
          <td class="pasajero">${escapeHtml(persona.nombre)}</td>
          <td>${
            requisitos.length
              ? escapeHtml(requisitos.join(' · '))
              : 'Ver observaciones'
          }</td>
          <td>${observaciones.join('') || '—'}</td>
        </tr>
      `;
    }).join('');

    return `
      <table>
        <thead>
          <tr>
            <th>N.º</th>
            <th>Pasajero</th>
            <th>Requerimiento alimentario</th>
            <th>Observaciones</th>
          </tr>
        </thead>
        <tbody>${filas}</tbody>
      </table>
    `;
  }

  function bloqueGrupo(grupo, mostrarFechas = false) {
    const personas = grupo.personas || [];
    const resumen = resumenGrupo(personas);

    const cantidad = personas.length === 1
      ? '1 persona con requerimientos'
      : `${personas.length} personas con requerimientos`;

    return `
      <section class="grupo">
        <div class="grupo-cabecera">
          <h3>${escapeHtml(grupo.grupo)}</h3>

          <p class="grupo-datos">
            <strong>N.º de negocio:</strong>
            ${escapeHtml(grupo.negocio || 'Sin informar')}
            <span class="separador">·</span>
            ${cantidad}
          </p>

          ${mostrarFechas ? `
            <p class="fechas-viaje">
              <strong>Viaje:</strong>
              ${escapeHtml(fechaDocumento(grupo.fecha))}
              ${grupo.fechaFin ? `
                al ${escapeHtml(fechaDocumento(grupo.fechaFin))}
              ` : ''}
            </p>
          ` : ''}
        </div>

        ${tablaPersonas(personas)}

        ${resumen ? `
          <p class="resumen">
            <strong>Resumen:</strong>
            ${escapeHtml(resumen)}
          </p>
        ` : ''}
      </section>
    `;
  }

  let contenido = '';
  let destinatario = '';

  if (esProveedor) {
    destinatario = clean(datos[0].proveedor || datos[0].entidad);

    const servicios = new Map();

    for (const fila of datos) {
      const esHotel = fila.tipo === 'hotel';

      // No se divide por destino: el proveedor necesita
      // identificar el servicio y sus fechas.
      // Se conserva la identidad del servicio para no mezclar
      // actividades diferentes que compartan tipo de comida.
      const clave = JSON.stringify([
        fila.tipo,
        fila.proveedor,
        fila.entidadId || fila.entidad,
        fila.fecha,
        esHotel ? fila.fechaFin : ''
      ]);

      if (!servicios.has(clave)) {
        servicios.set(clave, {
          ...fila,
          grupos: new Map()
        });
      }

      servicios.get(clave).grupos.set(fila.idGrupo, fila);
    }

    contenido = [...servicios.values()]
      .sort((a, b) =>
        (a.fecha || '9999').localeCompare(b.fecha || '9999') ||
        a.entidad.localeCompare(b.entidad, 'es')
      )
      .map(servicio => {
        const esHotel = servicio.tipo === 'hotel';

        const encabezado = esHotel
          ? `
            <h2>
              Ingreso:
              ${escapeHtml(fechaDocumento(servicio.fecha))}
            </h2>
            <p>
              <strong>Salida:</strong>
              ${escapeHtml(fechaDocumento(servicio.fechaFin))}
            </p>
          `
          : `
            <h2>
              ${escapeHtml(fechaDocumento(servicio.fecha))}
              <span class="separador">·</span>
              ${escapeHtml(nombreComida(servicio.entidad))}
            </h2>
          `;

        const grupos = [...servicio.grupos.values()]
          .sort((a, b) => a.grupo.localeCompare(b.grupo, 'es'));

        return `
          <section class="servicio">
            <div class="servicio-cabecera">
              ${encabezado}
            </div>

            ${grupos.map(grupo => bloqueGrupo(grupo)).join('')}
          </section>
        `;
      }).join('');
  } else {
    contenido = [...datos]
      .sort((a, b) =>
        (a.fecha || '9999').localeCompare(b.fecha || '9999') ||
        a.grupo.localeCompare(b.grupo, 'es')
      )
      .map(grupo => bloqueGrupo(grupo, true))
      .join('');
  }

  const titulo = 'Dietas especiales';

  const documento = `
    <!doctype html>
    <html lang="es">
    <head>
      <meta charset="utf-8">

      <title>${escapeHtml(titulo)}${
        destinatario ? ' · ' + escapeHtml(destinatario) : ''
      }</title>

      <style>
        @page {
          size: A4;
          margin: 15mm;
        }

        * {
          box-sizing: border-box;
        }

        body {
          margin: 0;
          background: #fff;
          color: #263247;
          font: 10pt/1.4 Arial, sans-serif;
        }

        .documento-cabecera {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 20px;
          padding-bottom: 12px;
          margin-bottom: 18px;
          border-bottom: 2px solid #633c85;
          break-inside: avoid;
        }

        .documento-titulo {
          flex: 1;
          min-width: 0;
        }

        .marca {
          margin: 0 0 5px;
          color: #633c85;
          font-size: 8pt;
          font-weight: bold;
          letter-spacing: 1px;
        }

        h1 {
          margin: 0 0 6px;
          font-size: 22pt;
          line-height: 1.15;
        }

        .destinatario {
          margin: 0 0 5px;
          font-size: 11pt;
          font-weight: bold;
        }

        .emision {
          margin: 0;
          color: #625b69;
          font-size: 8pt;
        }

        .logo {
          display: block;
          flex: 0 0 auto;
          width: 125px;
          height: auto;
          max-height: 75px;
          margin-left: auto;
          object-fit: contain;
          object-position: right top;
        }

        p {
          margin: 4px 0;
        }

        .servicio {
          margin-bottom: 22px;
        }

        .servicio-cabecera {
          padding: 8px 0;
          border-bottom: 1px solid #bcb2c6;
          break-inside: avoid;
          break-after: avoid;
        }

        h2 {
          margin: 0;
          font-size: 12pt;
          line-height: 1.4;
        }

        .grupo {
          margin: 13px 0 20px;
        }

        .grupo-cabecera {
          margin-bottom: 8px;
          break-inside: avoid;
          break-after: avoid;
        }

        h3 {
          margin: 0 0 4px;
          font-size: 11pt;
        }

        .grupo-datos,
        .fechas-viaje {
          font-size: 9pt;
        }

        .separador {
          padding: 0 5px;
        }

        table {
          width: 100%;
          border-collapse: collapse;
          table-layout: fixed;
          font-size: 9pt;
        }

        thead {
          display: table-header-group;
        }

        th,
        td {
          padding: 7px;
          border: 1px solid #d8d4dd;
          text-align: left;
          vertical-align: top;
          overflow-wrap: anywhere;
        }

        th {
          background: #f2eef6;
          color: #382846;
        }

        th:nth-child(1) {
          width: 7%;
          text-align: center;
        }

        th:nth-child(2) {
          width: 29%;
        }

        th:nth-child(3) {
          width: 28%;
        }

        th:nth-child(4) {
          width: 36%;
        }

        tr {
          break-inside: avoid;
        }

        .numero {
          text-align: center;
        }

        .pasajero,
        .alergia {
          font-weight: bold;
        }

        td div + div {
          margin-top: 5px;
        }

        .resumen {
          margin-top: 7px;
          font-size: 9pt;
          color: #4d4355;
        }

        .documento-pie {
          margin-top: 18px;
          padding-top: 8px;
          border-top: 1px solid #d8d4dd;
          color: #625b69;
          font-size: 8pt;
          break-inside: avoid;
        }

        @media print {
          body {
            print-color-adjust: exact;
            -webkit-print-color-adjust: exact;
          }
        }
      </style>
    </head>

    <body>
      <header class="documento-cabecera">
        <div class="documento-titulo">
          <p class="marca">OPERACIONES · RAI TRAI</p>

          <h1>Dietas especiales</h1>

          ${destinatario ? `
            <p class="destinatario">
              ${escapeHtml(destinatario)}
            </p>
          ` : ''}

          <p class="emision">
            Emitido: ${escapeHtml(emitido)}
          </p>
        </div>

        <img
          class="logo"
          src="${escapeHtml(logo)}"
          alt="Rai Trai"
        >
      </header>

      ${contenido}

      <footer class="documento-pie">
        Información alimentaria informada a Rai Trai.
        Una persona puede presentar más de un requerimiento.
      </footer>
    </body>
    </html>
  `;

  ventana.document.open();
  ventana.document.write(documento);
  ventana.document.close();

  // Espera a que el documento y el logo estén listos.
  let impresionIniciada = false;

  async function prepararImpresion() {
    if (impresionIniciada || ventana.closed) return;
    impresionIniciada = true;

    const imagen = ventana.document.querySelector('.logo');

    if (imagen && !imagen.complete) {
      await new Promise(resolve => {
        imagen.addEventListener('load', resolve, { once: true });
        imagen.addEventListener('error', resolve, { once: true });
      });
    }

    if (ventana.closed) return;

    ventana.focus();
    ventana.print();
  }

  if (ventana.document.readyState === 'complete') {
    prepararImpresion();
  } else {
    ventana.addEventListener('load', prepararImpresion, { once: true });
  }
}
onAuthStateChanged(auth, async user=>{
  if(!user){location.href='login.html';return;}
  if (!isOperationsStaff(user)) {
    $('deEstado').textContent =
      'Sin acceso al sistema de Operaciones.';
    return;
  }
  if(document.body.dataset.dietasIniciadas)return;
  document.body.dataset.dietasIniciadas='1';
  const ano=new Date().getFullYear();
  for(let n=ano-1;n<=ano+2;n++)$('deAno').add(new Option(String(n),String(n)));
  $('deAno').value=String(ano);
  $('deCargar').addEventListener('click',cargar);
  $('deImprimir').addEventListener('click',imprimir);
  for(const id of ['deVista','deGrupo','deHotel','deProveedor','deDesde','deHasta'])$(id).addEventListener('change',mostrar);
  $('deAno').addEventListener('change',()=>{estado.grupos=[];estado.filas=[];$('deResultados').hidden=true;$('deImprimir').disabled=true;$('deEstado').textContent='Pulsa Consultar para el año seleccionado.'});
  $('deFilas').addEventListener('click',e=>{
    const boton=e.target.closest('[data-indice]');if(!boton)return;
    const r=estado.mostrados[boton.dataset.vista==='grupo'?'grupos':'filas'][Number(boton.dataset.indice)];
    if(!r)return;
    const capa=document.createElement('div');capa.className='de-overlay';
    capa.innerHTML='<div class="de-detalle" role="dialog" aria-modal="true"><button type="button" data-cerrar>Cerrar</button><h2>'+escapeHtml(boton.dataset.vista==='grupo'?r.grupo:r.entidad)+'</h2><p>Negocio '+escapeHtml(r.negocio)+' · '+r.personas.length+' personas</p>'+personasHTML(r.personas)+'</div>';
    capa.addEventListener('click',ev=>{if(ev.target===capa||ev.target.closest('[data-cerrar]'))capa.remove()});
    document.body.append(capa);capa.querySelector('button').focus();
  });
  await cargar();
});
