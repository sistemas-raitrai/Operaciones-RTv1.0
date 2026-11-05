// control-coordinadores.js
import { app, db } from './firebase-init.js';

import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';

import {
  getStorage,
  ref as sRef,
  uploadBytesResumable,
  getBlob,
  uploadBytes,
  getDownloadURL,
  listAll,
  deleteObject
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-storage.js';

import {
  onSnapshot,
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  query,
  where,
  serverTimestamp,
  runTransaction
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const $ = (id) => document.getElementById(id);
const auth = getAuth(app);
const storage = getStorage(app);

let toastTimer = null;
function toast(msg){
  const el = $('toast');
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=> el.style.display='none', 2400);
}
function safeNum(n, def=0){
  const x = Number(n);
  return Number.isFinite(x) ? x : def;
}
function setEstado(msg){
  $('lblEstado').textContent = msg || 'Listo.';
}
const enMayusculas = valor => String(valor ?? '').toLocaleUpperCase('es-CL');
function U(s){ return String(s||'').trim().toUpperCase(); }
const state = {user:null};
function abrirAccionBodega({
  titulo,
  contexto = '',
  accion = 'Guardar',
  campos,
  guardar,
  refrescar
}) {
  const modal = $('bdAccionModal');
  const formulario = $('bdAccionForm');
  const contenedor = $('bdAccionCampos');
  const estado = $('bdAccionEstado');
  const confirmar = $('bdAccionGuardar');
  const cancelar = $('bdAccionCancelar');

  if (modal.open) return;

  let guardando = false;
  const controles = {};

  $('bdAccionTitulo').textContent = titulo;
  $('bdAccionContexto').textContent = contexto;
  estado.textContent = '';
  confirmar.textContent = accion;
  confirmar.disabled = false;
  cancelar.disabled = false;
  contenedor.replaceChildren();

  for (const campo of campos) {
    const fila = document.createElement('label');
    fila.className = 'field';

    const texto = document.createElement('span');
    texto.textContent = campo.etiqueta;

    const control = document.createElement(
      campo.opciones ? 'select' : campo.multilinea ? 'textarea' : 'input'
    );

    if (campo.opciones) {
      for (const [valor, etiqueta] of campo.opciones) {
        control.add(new Option(etiqueta, valor));
      }
    } else if (!campo.multilinea) {
      control.type = campo.tipo || 'text';
    }

    if (campo.min !== undefined) control.min = campo.min;
    if (campo.max !== undefined) control.max = campo.max;
    if (campo.tipo === 'number') control.step = '1';

    const esTexto = control.matches('input[type=text], textarea');
    if (esTexto) control.classList.add('dato-mayuscula');
    control.required = Boolean(campo.requerido);
    control.value = esTexto ? enMayusculas(campo.valor) : (campo.valor ?? '');
    control.readOnly = Boolean(campo.soloLectura);
    controles[campo.nombre] = control;
    fila.append(texto, control);
    contenedor.append(fila);

    if (campo.dependeDe) {
      const origen = controles[campo.dependeDe];
      const actualizarVisibilidad = () => {
        const mostrar = campo.ocultarCon === undefined
          ? origen.value === campo.mostrarCon : origen.value !== campo.ocultarCon;
        fila.hidden = !mostrar;
        fila.style.display = mostrar ? '' : 'none';
        control.disabled = !mostrar;
      };
      origen.addEventListener('change', actualizarVisibilidad);
      actualizarVisibilidad();
    }
  }

  cancelar.onclick = () => modal.close();
  modal.oncancel = evento => {
    if (guardando) evento.preventDefault();
  };

  formulario.onsubmit = async evento => {
    evento.preventDefault();
    if (guardando) return;

    const valores = Object.fromEntries(
      Object.entries(controles).map(([nombre, control]) => [
        nombre,
        control.disabled ? '' : control.matches('input[type=text], textarea')
          ? U(control.value) : control.value.trim()
      ])
    );

    guardando = true;
    confirmar.disabled = true;
    cancelar.disabled = true;
    confirmar.textContent = 'Guardando…';
    estado.textContent = 'Guardando…';

    let mensaje;

    try {
      mensaje = await guardar(valores);
    } catch (error) {
      console.error('[BODEGA]', error);
      estado.textContent = error.message || 'No se pudo guardar.';
      confirmar.disabled = false;
      cancelar.disabled = false;
      confirmar.textContent = accion;
      guardando = false;
      return;
    }

    modal.close();
    toast(mensaje);

    try {
      await refrescar?.();
    } catch (error) {
      console.error('[BODEGA] Actualizar pantalla', error);
      toast(`${mensaje} Pulsa Actualizar para recargar los saldos.`);
    }
  };

  modal.showModal();
}

// Stock de coordinadores. Catálogo vinculado por ID, cantidades independientes.
const guiaCol = nombre => collection(db, nombre);
const guiaStockId = (bodegaId,itemId,talla) => encodeURIComponent(JSON.stringify([bodegaId,itemId,talla]));
const guiaStock = id => doc(guiaCol('bodega_guia_stock'), id);
const guiaEntregas = guiaCol('bodega_guia_entregas');
const guiaFirmas = guiaCol('bodega_guia_firmas');
const guiaMov = guiaCol('bodega_guia_movimientos');
function guiaPuedeBorrar() {
  return String(auth.currentUser?.email || '').trim().toLowerCase() === 'sistemas@raitrai.cl';
}

async function guiaBorrarEntrega(ref) {
  if (!guiaPuedeBorrar()) throw new Error('Solo sistemas@raitrai.cl puede borrar entregas de prueba.');
  if (!confirm('¿Borrar esta entrega de prueba? Se eliminarán la firma y los adjuntos. Si se confirmó la entrega, se reintegrarán las unidades que aún no se devolvieron.')) return;

  const uid = auth.currentUser.uid;
  const movimiento = doc(guiaMov);
  const existe = await runTransaction(db, async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return false;
    const e = snap.data();
    if (e.estado === 'eliminando') return true;
    if (!['preparada', 'entregada'].includes(e.estado)) throw new Error('Estado de entrega desconocido.');

    const cambios = new Map();
    if (e.estado === 'entregada') {
      for (const linea of e.lineas) {
        const {stockId,cantidad,devuelto} = linea;
        if (!stockId || !Number.isSafeInteger(cantidad) || !Number.isSafeInteger(devuelto) ||
            cantidad < 1 || devuelto < 0 || devuelto > cantidad) {
          throw new Error('Hay una línea con saldo inválido. Revisa la entrega.');
        }
        const saldo = cantidad - devuelto;
        if (saldo) cambios.set(stockId, (cambios.get(stockId) || 0) + saldo);
      }
    }
    const saldos = await Promise.all([...cambios].map(async ([id, cantidad]) => {
      const stock = await tx.get(guiaStock(id));
      const anterior = stock.data()?.unidades;
      if (!Number.isSafeInteger(anterior) || anterior < 0 || !Number.isSafeInteger(anterior + cantidad)) {
        throw new Error('No se pudo verificar el saldo de un artículo. Revisa Stock de coordinadores.');
      }
      return {ref:stock.ref,unidades:anterior + cantidad};
    }));
    for (const saldo of saldos) tx.update(saldo.ref, {unidades:saldo.unidades});
    if (e.firmaId) tx.delete(doc(guiaFirmas,e.firmaId));
    tx.update(ref, {estado:'eliminando', eliminacionIniciadaEn:serverTimestamp()});
    tx.set(movimiento, {
      tipo:'eliminacion_entrega_prueba', entregaId:ref.id,
      lineas:[...cambios].map(([stockId,cantidad])=>({stockId,cantidad})),
      fecha:serverTimestamp(), por:uid
    });
    return true;
  });

  if (existe) {
    try {
      const archivos = await listAll(sRef(storage,`bodega_guia_anexos/${ref.id}`));
      for (const archivo of archivos.items) {
        try { await deleteObject(archivo); }
        catch (error) { if (error.code !== 'storage/object-not-found') throw error; }
      }
      await deleteDoc(ref);
    } catch (error) {
      console.error('[GUÍAS] Limpieza pendiente', error);
      try { await guiaActualizar(); } catch (refreshError) { console.error(refreshError); }
      throw new Error('Firma invalidada y saldo procesado. Usa Reintentar borrado para terminar de eliminar los adjuntos.');
    }
  }
  toast('Entrega de prueba borrada.');
  await guiaActualizar();
}
const guiaFecha = valor => {
  const d = valor?.toDate?.() || (valor ? new Date(valor) : null);
  if (!d || !Number.isFinite(+d)) return '';
  return typeof valor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(valor)
    ? valor : new Intl.DateTimeFormat('sv-SE', {timeZone:'America/Santiago'}).format(d);
};
const guiaNorm = valor => String(valor || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().trim();
const guiaTexto = (tag, texto) => Object.assign(document.createElement(tag), {textContent:texto});
const guiaBoton = (titulo, fn) => {
  const b = guiaTexto('button', titulo);
  b.type = 'button';
  b.className = 'btn small';
  b.onclick = async () => {
    if (b.disabled) return;
    b.disabled = true;
    try { await fn(); }
    catch (e) {
      const estado = $('guiaEstado');
      if (estado) guiaAviso(e.message, 'error');
      else console.error(e);
    }
    finally { b.disabled = false; }
  };
  return b;
};

async function guiaActualizar() {
  const anoConsulta = controlAno;
  const [stock, entregas] = await Promise.all([getDocs(guiaCol('bodega_guia_stock')), getDocs(guiaEntregas)]);
  const panel = $('guiaLista');
  if (!panel || !state.user || anoConsulta !== controlAno) return;
  panel.replaceChildren();
  const inventario = guiaTexto('details', '');
  inventario.append(guiaTexto('summary', 'Disponible para entregar'));
  for (const d of stock.docs) {
    const s = d.data();
    inventario.append(guiaTexto('div', `${enMayusculas(s.nombre)} · ${enMayusculas(s.talla) || 'Sin talla'} · ${s.unidades}`));
  }
  panel.append(inventario);
  const hoy = guiaFecha(new Date());
  let visibles = 0;
  const orden = entregas.docs.sort((a,b) => (b.data().creado?.seconds || 0) - (a.data().creado?.seconds || 0));
  for (const d of orden) {
    const e = d.data();
    if (controlPersona && e.coordinadorId !== controlPersona) continue;
    const anosEntrega = e.anoViaje ? [Number(e.anoViaje)] : (e.viajes || []).map(v=>anoDeFecha(v.inicio));
    if (!anosEntrega.includes(controlAno)) continue;
    if (e.estado === 'eliminando') {
      if (guiaPuedeBorrar()) {
        const pendiente = guiaTexto('div', `${enMayusculas(e.coordinador)} · Limpieza pendiente`);
        pendiente.append(guiaBoton('Reintentar borrado', () => guiaBorrarEntrega(d.ref)));
        panel.append(pendiente);
      }
      continue;
    }
    visibles++;
    const pendientes = e.estado === 'entregada' ? e.lineas.filter(l => !l.cortesia && l.devuelto < l.cantidad) : [];
    const monto = pendientes.reduce((s,l) => s + (l.cantidad-l.devuelto)*l.valor, 0);
    const fila = guiaTexto('div', '');
    fila.className = 'card';
    fila.style.marginTop = '10px';
    fila.append(guiaTexto('strong', enMayusculas(e.coordinador)), guiaTexto('div',
      e.estado === 'preparada' ? 'Preparada' : pendientes.length
        ? `${e.plazo < hoy ? 'Vencida' : 'Pendiente'} · ${e.plazo} · CLP ${monto.toLocaleString('es-CL')}`
        : 'Cerrada'));
    fila.append(guiaTexto('div', e.viajes.map(v=>enMayusculas(v.nombre)).join(' · ')));
    const detalle = guiaTexto('details', '');
    detalle.append(guiaTexto('summary', 'Ver artículos y devoluciones'));
    for (const l of e.lineas) {
      const saldo = e.estado === 'preparada' ? 'Por entregar' : l.cortesia
        ? 'Cortesía' : `${l.devuelto} devueltas · ${l.cantidad - l.devuelto} pendientes`;
      detalle.append(guiaTexto('div', `${enMayusculas(l.nombre)} · ${enMayusculas(l.talla) || 'Sin talla'} · ${l.cantidad} un. · ${saldo}`));
    }
    fila.append(detalle);
    fila.append(
      guiaBoton('Anexo / imprimir', async () => {
        const firma = await guiaLeerFirma(e);
        guiaImprimir(d.id, e, firma);
      }),
      guiaBoton('Adjuntar anexo firmado', () => guiaAdjuntar(d.ref))
    );
    if (e.firmaId) {
      fila.append(guiaBoton('Copiar enlace de firma', async () => {
        const url = new URL('./control-coordinadores.html', location.href);
        url.hash = 'firmar-guia=' + e.firmaId;
        await navigator.clipboard.writeText(url.href);
        guiaAviso('Enlace de firma copiado.', 'exito');
      }));
    } else {
      const aviso = guiaTexto('p', e.respaldoRuta
        ? 'Anexo firmado adjunto.'
        : 'Sin enlace de firma. Puedes adjuntar el anexo firmado.');
      aviso.className = e.respaldoRuta ? 'aviso exito' : 'aviso alerta';
      fila.append(aviso);
    }
    if (e.estado === 'preparada') fila.append(guiaBoton('Confirmar entrega física', async () => {
      if (confirm(`¿Confirmar la entrega física a ${enMayusculas(e.coordinador)}?`)) await guiaMover(d.ref);
    }));
    if (pendientes.length) fila.append(guiaBoton('Registrar devolución', () => guiaDevolver(d.ref, e)));
    if (guiaPuedeBorrar()) fila.append(guiaBoton('Borrar entrega de prueba', () => guiaBorrarEntrega(d.ref)));
    panel.append(fila);
  }
  guiaAviso(`${visibles} entregas registradas.`, 'info');
}

async function guiaDatosViajes(ano) {
  const [personas, resumen, respuesta] = await Promise.all([
    getDocs(guiaCol('coordinadores')),
    getDocs(query(guiaCol('coordinacion_grupos_resumen'),where('anoViaje','in',[Number(ano),String(ano)]))),
    coordPost('cargarConjuntosCoordinadores', {anoViaje:Number(ano)})
  ]);
  const porGrupo = new Map();
  for (const conjunto of respuesta.conjuntos || []) {
    const cid = conjunto.owner === '_borradores' ? conjunto.coordinadorId : conjunto.owner;
    if (!cid || cid === '_borradores') continue;
    for (const gid of conjunto.viajes || []) {
      if (!porGrupo.has(String(gid))) porGrupo.set(String(gid),new Map());
      const mapa = porGrupo.get(String(gid));
      mapa.set(cid, {confirmado:!!conjunto.confirmado, estado:conjunto.estadoCoord || 'pendiente'});
    }
  }
  const viajes = resumen.docs.map(d => {
    const g = d.data(), asignados = porGrupo.get(d.id) || new Map();
    return {id:d.id,ano:Number(ano),numeroNegocio:g.numeroNegocio || '',
      nombre:U(g.aliasGrupo || [g.colegio,g.curso].filter(Boolean).join(' ') || d.id),
      destino:U(g.destino || g.destinoPrincipal),inicio:guiaFecha(g.fechaInicio),fin:guiaFecha(g.fechaFin),
      coords:[...asignados.keys()],asignados};
  }).sort((a,b)=>a.inicio.localeCompare(b.inicio));
  return {personas:personas.docs.filter(p=>p.id !== '_borradores'),viajes};
}

async function guiaNuevaEntrega() {
  const ano = controlAno;
  const [{personas,viajes}, inventario] = await Promise.all([
    guiaDatosViajes(ano),getDocs(guiaCol('bodega_guia_stock'))
  ]);
  const stock = inventario.docs.map(d=>({id:d.id,...d.data()})).filter(s=>s.unidades>0);
  const campos = [{nombre:'coord',etiqueta:'Coordinador',requerido:true,
    opciones:[['','Selecciona'],...personas.filter(p=>viajes.some(v=>v.coords.includes(p.id)))
      .sort((a,b)=>String(a.data().nombre).localeCompare(String(b.data().nombre),'es'))
      .map(p=>[p.id,enMayusculas(p.data().nombre) || p.id])]}];
  abrirAccionBodega({
    titulo:'Preparar anexo de entrega',
    contexto:'Selecciona los viajes y agrega las líneas de una sola entrega.',
    campos,
    guardar:async datos => {
      const persona = personas.find(p=>p.id===datos.coord);
      const seleccion = viajes.filter(v=>v.coords.includes(datos.coord) && controlesViajes.get(v.id)?.checked);
      if (!persona || !seleccion.length || seleccion.some(v=>!v.fin)) throw new Error('Selecciona viajes con fecha de término.');
      const lineas = [...contenedorLineas.children].map(f=>{
        const s = stock.find(s=>s.id===f.querySelector('select').value);
        const [cantidad, valor, cortesia] = f.querySelectorAll('input');
        const n = cantidad.valueAsNumber;
        const precio = valor.valueAsNumber;
        if (!s || !Number.isSafeInteger(n) || n<1 || !Number.isSafeInteger(precio) || precio<0 || (!cortesia.checked && precio===0)) {
          throw new Error('Completa producto, cantidad y valor de reposición. Solo la cortesía admite valor cero.');
        }
        return {stockId:s.id,nombre:U(s.nombre),talla:U(s.talla),cantidad:n,valor:precio,cortesia:cortesia.checked,devuelto:0};
      });
      if (!lineas.length || lineas.length>20) throw new Error('Agrega entre 1 y 20 líneas.');
      const cantidades = new Map();
      for (const linea of lineas) {
        cantidades.set(linea.stockId, (cantidades.get(linea.stockId) || 0) + linea.cantidad);
      }
      for (const [id, cantidad] of cantidades) {
        const articulo = stock.find(s => s.id === id);
        if (cantidad > articulo.unidades) {
          throw new Error(`La suma de las líneas supera el stock de ${U(articulo.nombre)}.`);
        }
      }
      const resumenViajes = seleccion.map(({id,nombre,destino,inicio,fin})=>({id,nombre:U(nombre),destino:U(destino),inicio,fin}));
      const plazo = resumenViajes.map(v=>v.fin).sort().at(-1);
      const entrega = doc(guiaEntregas);
      const firma = activarFirma.checked ? doc(guiaFirmas,crypto.randomUUID().replaceAll('-','')) : null;
      const anexo = {anoViaje:ano,folio:entrega.id,coordinador:U(persona.data().nombre) || persona.id,viajes:resumenViajes,plazo,lineas};
      await runTransaction(db, async tx => {
        if (firma) tx.set(firma,{...anexo,firma:'',vence:new Date(Date.now()+7*86400000)});
        tx.set(entrega,{...anexo,coordinadorId:persona.id,firmaId:firma?.id || '',estado:'preparada',creado:serverTimestamp(),por:state.user.uid});
      });
      return 'Anexo preparado. Confirma la entrega física cuando corresponda.';
    },
    refrescar:guiaActualizar
  });
  const raiz = $('bdAccionCampos');
  const controlesViajes = new Map();
  const listaViajes = guiaTexto('div','');
  const sugerencia = guiaTexto('p','');
  const contenedorLineas = guiaTexto('div','');
  const activarFirma = document.createElement('input');
  activarFirma.type = 'checkbox';
  activarFirma.style.width = 'auto';
  const etiquetaFirma = guiaTexto('label',' Habilitar enlace de firma por 7 días');
  etiquetaFirma.prepend(activarFirma);

  function sugerir() {
    const elegidos = viajes.filter(v=>controlesViajes.get(v.id)?.checked);
    const polar = elegidos.some(v=>['BARILOCHE','SUR DE CHILE','SUR DE CHILE Y BARILOCHE'].includes(guiaNorm(v.destino)));
    sugerencia.textContent = elegidos.length
      ? 'Kit sugerido: 6 poleras guía amarillas, 2 blusas amarillas, 1 cortaviento amarillo' +
        (polar ? ' y 1 polar amarillo.' : '.') + ' Agrega el equipo efectivamente entregado.'
      : 'Selecciona los viajes que cubre el equipo.';
  }

  raiz.querySelector('select').onchange = ev => {
    listaViajes.replaceChildren();
    controlesViajes.clear();
    for (const v of viajes.filter(v=>v.coords.includes(ev.target.value))) {
      const c = document.createElement('input');
      c.type = 'checkbox';
      c.style.width = 'auto';
      c.onchange = sugerir;
      controlesViajes.set(v.id,c);
      const etiqueta = guiaTexto('label', ` ${enMayusculas(v.nombre)} · ${enMayusculas(v.destino)} · ${v.inicio} a ${v.fin}`);
      etiqueta.style.display = 'block';
      etiqueta.prepend(c);
      listaViajes.append(etiqueta);
    }
    sugerir();
  };
  const agregar = () => {
    const f = guiaTexto('div','');
    f.className = 'card';
    f.style.marginTop = '8px';
    const select = document.createElement('select');
    select.required = true;
    select.setAttribute('aria-label','Producto y talla');
    select.add(new Option('Selecciona producto y talla',''));
    stock.forEach(s=>select.add(new Option(`${enMayusculas(s.nombre)} · ${enMayusculas(s.talla) || 'Sin talla'} (${s.unidades} disponibles)`,s.id)));
    f.append(select);
    for (const [nombre,min,valor] of [['Cantidad',1,1],['Valor unitario CLP',0,'']]) {
      const label = guiaTexto('label',nombre);
      const input = document.createElement('input');
      Object.assign(input,{type:'number',step:'1',min:String(min),value:String(valor),required:true});
      label.append(input);
      f.append(label);
    }
    const cortesia = document.createElement('input');
    cortesia.type = 'checkbox';
    cortesia.style.width = 'auto';
    const label = guiaTexto('label',' Cortesía · sin devolución');
    label.prepend(cortesia);
    f.append(label,guiaBoton('Quitar línea',()=>f.remove()));
    contenedorLineas.append(f);
  };
  raiz.append(listaViajes,sugerencia,contenedorLineas,guiaBoton('Agregar artículo',agregar),etiquetaFirma);
  sugerir();
  agregar();
  if (controlPersona) {
    const sel = raiz.querySelector('select');
    sel.value = controlPersona;
    sel.dispatchEvent(new Event('change'));
  }
}

async function guiaMover(ref, devoluciones = null) {
  const movimiento = doc(guiaMov);
  const uid = state.user.uid;
  await runTransaction(db, async tx => {
    const e = (await tx.get(ref)).data();
    if (!e || e.estado !== (devoluciones ? 'entregada' : 'preparada')) throw new Error('La entrega cambió. Actualiza el módulo.');
    const cambios = new Map();
    const lineas = e.lineas.map((l,i)=>{
      const cantidad = devoluciones ? (devoluciones[i] ?? 0) : -l.cantidad;
      if (devoluciones && (!Number.isSafeInteger(cantidad) || cantidad<0 || cantidad>l.cantidad-l.devuelto || (l.cortesia && cantidad))) {
        throw new Error('Una devolución supera lo pendiente.');
      }
      if (cantidad) cambios.set(l.stockId,(cambios.get(l.stockId)||0)+cantidad);
      return {...l,devuelto:l.devuelto+(devoluciones ? cantidad : 0)};
    });
    if (!cambios.size) throw new Error('Ingresa al menos una unidad.');
    const saldos = await Promise.all([...cambios].map(async ([id,delta])=>{
      const s = await tx.get(guiaStock(id));
      const unidades = s.data()?.unidades + delta;
      if (!s.exists() || !Number.isSafeInteger(unidades) || unidades<0) {
        throw new Error(`Stock insuficiente para ${s.data()?.nombre || id}.`);
      }
      return {ref:s.ref,unidades};
    }));
    for (const s of saldos) tx.update(s.ref,{unidades:s.unidades});
    tx.update(ref,devoluciones ? {lineas} : {estado:'entregada',fechaEntrega:serverTimestamp()});
    tx.set(movimiento,{tipo:devoluciones?'devolucion':'entrega',entregaId:ref.id,
      lineas:[...cambios].map(([stockId,cantidad])=>({stockId,cantidad})),fecha:serverTimestamp(),por:uid});
  });
  try { await guiaActualizar(); }
  catch (error) { $('guiaEstado').textContent = 'Movimiento guardado. Actualiza el módulo para ver el saldo.'; }
  if (!devoluciones) toast('Entrega registrada.');
}

function guiaDevolver(ref,e) {
  abrirAccionBodega({
    titulo:'Registrar devolución', contexto:e.coordinador,
    campos:e.lineas.flatMap((l,i)=> l.cortesia || l.devuelto>=l.cantidad ? [] : [{
      nombre:String(i),etiqueta:`${enMayusculas(l.nombre)} · ${enMayusculas(l.talla) || 'Sin talla'} · ${l.cantidad-l.devuelto} pendientes`,
      tipo:'number',min:0,max:l.cantidad-l.devuelto,valor:0,requerido:true
    }]),
    guardar:async datos=>{
      await guiaMover(ref,Object.fromEntries(Object.entries(datos).map(([i,n])=>[i,Number(n)])));
      return 'Devolución registrada.';
    }
  });
}

function guiaAdjuntar(ref) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/jpeg,image/png,application/pdf';
  input.onchange = async () => {
    const archivo = input.files[0];
    if (!archivo || !['image/jpeg','image/png','application/pdf'].includes(archivo.type) || archivo.size>10*1024*1024) {
      $('guiaEstado').textContent = 'Selecciona JPG, PNG o PDF de hasta 10 MB.';
      return;
    }
    try {
      const entrega = (await getDoc(ref)).data();
      if (!entrega || entrega.estado === 'eliminando') throw new Error('La entrega ya no admite adjuntos.');
      const ruta = `bodega_guia_anexos/${ref.id}/${crypto.randomUUID()}`;
      const tarea = uploadBytesResumable(sRef(storage,ruta),archivo);
      await new Promise((ok,fail)=>tarea.on('state_changed',null,fail,ok));
      try {
        await runTransaction(db, async tx => {
          const actual = (await tx.get(ref)).data();
          if (!actual || actual.estado === 'eliminando') throw new Error('La entrega ya no admite adjuntos.');
          tx.update(ref,{respaldoRuta:ruta,respaldoFecha:serverTimestamp(),respaldoPor:state.user.uid});
        });
      } catch (error) {
        try { await deleteObject(sRef(storage,ruta)); }
        catch (limpieza) { if (limpieza.code !== 'storage/object-not-found') console.error(limpieza); }
        throw error;
      }
      try { await guiaActualizar(); }
      catch (error) { console.error('[GUÍAS] Recargar anexo',error); }
      $('guiaEstado').textContent = 'Anexo firmado adjuntado.';
    } catch (e) { guiaAviso(e.message, 'error'); }
  };
  input.click();
}

async function guiaLeerFirma(e) {
  if (e.respaldoRuta) {
    const archivo = await getBlob(sRef(storage,e.respaldoRuta),10*1024*1024);
    return {respaldo:URL.createObjectURL(archivo)};
  }
  if (!e.firmaId) return {};
  const s = await getDoc(doc(guiaFirmas,e.firmaId));
  return s.data() || {};
}

function guiaAnexo(e,folio) {
  const nodo = guiaTexto('article','');
  nodo.append(guiaTexto('h1','Anexo de entrega de equipamiento'),
    guiaTexto('p',`Folio ${folio} · Coordinador: ${enMayusculas(e.coordinador)}`),
    guiaTexto('p',`Devolución prevista: ${e.plazo}`));
  for (const v of e.viajes) nodo.append(guiaTexto('div',`${enMayusculas(v.nombre)} · ${enMayusculas(v.destino)} · ${v.inicio} a ${v.fin}`));
  const tabla = document.createElement('table');
  const cabecera = tabla.createTHead().insertRow();
  for (const valor of ['Artículo','Talla','Cantidad','Valor unitario CLP','Devolución']) cabecera.append(guiaTexto('th',valor));
  const cuerpo = tabla.createTBody();
  for (const l of e.lineas) {
    const fila = cuerpo.insertRow();
    for (const valor of [enMayusculas(l.nombre),enMayusculas(l.talla) || '—',l.cantidad,l.valor,l.cortesia?'Cortesía':'Sí']) fila.insertCell().textContent=valor;
  }
  nodo.append(tabla,guiaTexto('p','Los artículos marcados para devolución deben entregarse al término del último viaje indicado. Los artículos de cortesía quedan con el coordinador.'));
  return nodo;
}

function guiaImprimir(id,e,firma) {
  const modal = $('guiaImpresion');
  modal.replaceChildren(guiaAnexo(e,id));
  modal.onclose = () => {
    if (firma.respaldo) URL.revokeObjectURL(firma.respaldo);
  };
  if (firma.respaldo) {
    const enlace = guiaTexto('a','Abrir anexo firmado en papel');
    enlace.href = firma.respaldo;
    enlace.target = '_blank';
    enlace.rel = 'noopener noreferrer';
    modal.append(enlace);
  }
  if (/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(firma.firma || '')) {
    const img = new Image();
    img.alt = 'Firma del coordinador';
    img.width = 320;
    img.src = firma.firma;
    modal.append(img,guiaTexto('p',`Firma registrada: ${firma.firmadoEn?.toDate?.().toLocaleString('es-CL') || ''}`));
  } else modal.append(guiaTexto('p','Firma del coordinador: _________________________'));
  modal.append(guiaBoton('Imprimir / Guardar como PDF',()=>window.print()),guiaBoton('Cerrar',()=>modal.close()));
  modal.showModal();
}

async function guiaAbrirFirma(token) {
  document.body.replaceChildren();
  const panel = guiaTexto('main','');
  panel.className = 'wrap';
  document.body.append(panel);
  try {
    const ref = doc(guiaFirmas,token);
    const e = (await getDoc(ref)).data();
    if (!e) throw new Error('Enlace inválido o vencido.');
    panel.append(guiaAnexo(e,e.folio));
    if (e.firma) {
      panel.append(guiaTexto('p','La firma ya fue registrada.'));
      return;
    }
    if (!e.vence?.toDate || e.vence.toDate().getTime() <= Date.now()) {
      throw new Error('El enlace de firma venció.');
    }
    const lienzo = document.createElement('canvas');
    lienzo.width = 640;
    lienzo.height = 220;
    lienzo.style.cssText = 'width:100%;max-width:640px;border:1px solid;touch-action:none;background:white';
    const ctx = lienzo.getContext('2d');
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    let trazo = false;
    let puntero = null;
    const punto = ev=>{
      const r=lienzo.getBoundingClientRect();
      return [(ev.clientX-r.left)*lienzo.width/r.width,(ev.clientY-r.top)*lienzo.height/r.height];
    };
    lienzo.onpointerdown=ev=>{
      if (puntero!==null) return;
      puntero=ev.pointerId;
      lienzo.setPointerCapture(puntero);
      ctx.beginPath();
      ctx.moveTo(...punto(ev));
    };
    lienzo.onpointermove=ev=>{
      if (ev.pointerId!==puntero) return;
      ctx.lineTo(...punto(ev));
      ctx.stroke();
      trazo=true;
    };
    lienzo.onpointerup=lienzo.onpointercancel=()=>{puntero=null;};
    const confirma=document.createElement('input');
    confirma.type='checkbox';
    confirma.style.width='auto';
    const etiqueta=guiaTexto('label',' He revisado el anexo y confirmo mi firma.');
    etiqueta.prepend(confirma);
    const estado=guiaTexto('p','');
    estado.setAttribute('role','status');
    const firmar=guiaBoton('Guardar firma',async()=>{
      if (!trazo || !confirma.checked) {estado.textContent='Dibuja tu firma y marca la confirmación.';return;}
      try {
        const firmaPNG = lienzo.toDataURL('image/png');
        await runTransaction(db, async tx => {
          const actual = (await tx.get(ref)).data();
          if (!actual || actual.firma || !actual.vence?.toDate ||
              actual.vence.toDate().getTime() <= Date.now()) {
            throw new Error('Enlace vencido o ya utilizado.');
          }
          tx.update(ref,{firma:firmaPNG,firmadoEn:serverTimestamp()});
        });
        panel.replaceChildren(guiaTexto('h1','Firma registrada'),guiaTexto('p',`Folio ${e.folio}`));
      } catch (error) {estado.textContent='No se pudo guardar. El enlace puede estar vencido o ya utilizado.';}
    });
    panel.append(guiaTexto('p','Firma aquí con tu dedo.'),lienzo,etiqueta,
      guiaBoton('Limpiar firma',()=>{ctx.clearRect(0,0,lienzo.width,lienzo.height);trazo=false;}),firmar,estado);
  } catch (e) { panel.append(guiaTexto('p','Enlace inválido, vencido o inaccesible.')); }
}

document.addEventListener('input', evento => {
  const campo = evento.target;
  if (evento.isComposing || !campo.matches?.('.dato-mayuscula')) return;
  const valor = enMayusculas(campo.value);
  if (valor === campo.value) return;
  const inicio = enMayusculas(campo.value.slice(0,campo.selectionStart)).length;
  const fin = enMayusculas(campo.value.slice(0,campo.selectionEnd)).length;
  campo.value = valor;
  campo.setSelectionRange(inicio,fin);
});


function guiaAviso(texto, tipo = 'info') {
  const estado = $('guiaEstado');
  if (!estado) return;
  estado.textContent = texto;
  estado.className = 'aviso ' + tipo;
  estado.setAttribute('role', tipo === 'error' ? 'alert' : 'status');
}

let detenerStock = null;
let detenerEntregas = null;
let actualizacion = null;
let cargandoGuias = false;
let recargarGuias = false;

async function actualizarCoordinadores() {
  if (cargandoGuias) {
    recargarGuias = true;
    return;
  }
  cargandoGuias = true;
  try {
    try { await cargarControl(); } catch(error) { console.error('[CONTROL] Viajes',error); }
    await guiaActualizar();
  }
  catch (error) { guiaAviso(error.message, 'error'); }
  finally {
    cargandoGuias = false;
    if (recargarGuias && state.user) {
      recargarGuias = false;
      void actualizarCoordinadores();
    }
  }
}

function programarActualizacion() {
  clearTimeout(actualizacion);
  actualizacion = setTimeout(() => void actualizarCoordinadores(), 100);
}

// Ficha administrativa compartida con Gestionar coordinadores.
function anoDeFecha(fecha) {
  const f = String(fecha || '');
  return /^\d{4}-\d{2}-\d{2}/.test(f) ? Number(f.slice(0,4)) - (Number(f.slice(5,7)) < 3 ? 1 : 0) : null;
}
let controlAno = anoDeFecha(guiaFecha(new Date()));
let controlCatalogo = [], controlViajes = [], controlPersona = '';
let detenerPersonas = null, versionControl = 0;
async function coordPost(nombre, datos) {
  if (!auth.currentUser) throw new Error('Inicia sesión.');
  const token = await auth.currentUser.getIdToken();
  const resp = await fetch('https://southamerica-west1-sist-op-rt.cloudfunctions.net/' + nombre, {
    method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(datos)
  });
  const data = await resp.json();
  if (!resp.ok || !data.ok) throw new Error(data.error || 'No se pudieron cargar las asignaciones.');
  return data;
}
async function cargarControl() {
  const version = ++versionControl, ano = controlAno;
  $('coordPeriodo').textContent = `Desde 01/03/${ano} hasta antes del 01/03/${ano+1}`;
  $('coordCarga').textContent = 'Cargando viajes de '+ano+' y '+(ano+1)+'…';
  try {
    const temporadas = await Promise.all([guiaDatosViajes(ano),guiaDatosViajes(ano+1)]);
    if (version !== versionControl || !state.user) return;
    controlViajes = temporadas.flatMap(t=>t.viajes);
    $('coordCarga').textContent = '';
    renderControl();
  } catch (error) {
    if (version !== versionControl) return;
    controlViajes = [];
    $('coordCarga').textContent = 'No se pudieron cargar los viajes: '+error.message+' Pulsa Actualizar para reintentar.';
    renderControl();
    throw error;
  }
}
function renderControl() {
  const panel = $('coordTarjetas');
  if (!panel || !state.user) return;
  const texto = guiaNorm($('coordBuscar').value);
  const lista = controlCatalogo.filter(c=>guiaNorm([c.nombre,c.rut,c.correo,c.telefono].join(' ')).includes(texto))
    .sort((a,b)=>U(a.nombre).localeCompare(U(b.nombre),'es'));
  panel.replaceChildren();
  $('coordCantidad').textContent = lista.length+' coordinadores';
  for (const c of lista) {
    const tarjeta = guiaTexto('article',''); tarjeta.className='item';
    const top = guiaTexto('div',''); top.className='top';
    const foto = guiaTexto('div',''); foto.className='thumb';
    if (/^https:\/\//i.test(c.fotoURL || '')) {
      const img = new Image(); img.src=c.fotoURL; img.alt=U(c.nombre); img.loading='lazy';
      img.onerror=()=>foto.replaceChildren(guiaTexto('span','Sin foto')); foto.append(img);
    } else foto.textContent='Sin foto';
    const meta=guiaTexto('div',''); meta.className='meta';
    meta.append(guiaTexto('b',U(c.nombre)),guiaTexto('div','RUT: '+(U(c.rut)||'—')),
      guiaTexto('div',U(c.correo)||'Sin correo'),guiaTexto('div',U(c.telefono)||'Sin teléfono'),
      guiaTexto('div','Talla de polera: '+(U(c.tallaPolera)||'Sin informar')));
    top.append(foto,meta);tarjeta.append(top);
    const agenda=guiaTexto('div','');agenda.className='coord-agenda';
    for (const ano of [controlAno,controlAno+1]) {
      agenda.append(guiaTexto('h3','Viajes '+ano));
      const viajes=controlViajes.filter(v=>v.ano===ano && v.coords.includes(c.id));
      if (!viajes.length) agenda.append(guiaTexto('p',$('coordCarga').textContent ? 'Viajes sin verificar.' : 'Sin viajes asignados registrados.'));
      for (const v of viajes) {
        const estado=v.asignados.get(c.id);
        agenda.append(guiaTexto('p',`${v.nombre} · ID ${v.id} · NEGOCIO ${v.numeroNegocio || '—'} · ${v.destino}\n${v.inicio || 'Sin fecha'} a ${v.fin || 'Sin fecha'} · ${estado.confirmado ? 'CONFIRMADO' : 'PLANIFICADO'} · ${U(estado.estado)}`));
      }
    }
    tarjeta.append(agenda);
    const acciones=guiaTexto('div','');acciones.className='bottom';
    acciones.append(guiaBoton('Editar datos',()=>editarControl(c)),guiaBoton('Cargar foto',()=>fotoControl(c)),
      guiaBoton('Entregas y anexos',async()=>{controlPersona=c.id;actualizarFiltroPersona();await guiaActualizar();$('seccionEntregas').scrollIntoView({behavior:'smooth'});}),
      guiaBoton('Preparar entrega',async()=>{controlPersona=c.id;actualizarFiltroPersona();await guiaNuevaEntrega();}));
    tarjeta.append(acciones);panel.append(tarjeta);
  }
}
function editarControl(c) {
  const campos = [
    {nombre:'nombre',etiqueta:'Nombre',requerido:true}, {nombre:'rut',etiqueta:'RUT'},
    {nombre:'fechaNacimiento',etiqueta:'Fecha de nacimiento',tipo:'date'},
    {nombre:'telefono',etiqueta:'Teléfono',tipo:'tel'}, {nombre:'correo',etiqueta:'Correo',tipo:'email'},
    {nombre:'datosTransferir',etiqueta:'Datos para transferir',multilinea:true},
    {nombre:'sexo',etiqueta:'Dato para conteos de hoteles',opciones:[['sin_informar','Sin informar'],['hombre','Hombre'],['mujer','Mujer']]},
    {nombre:'tallaPolera',etiqueta:'Talla de polera (puedes escribir cualquier talla)'},
    {nombre:'notas',etiqueta:'Información adicional',multilinea:true}
  ].map(f=>({...f,valor:f.nombre==='sexo' ? c.sexo || 'sin_informar' : c[f.nombre] || ''}));
  abrirAccionBodega({titulo:'Editar coordinador',contexto:U(c.nombre),campos,
    guardar:async datos=>{
      if (!datos.nombre) throw new Error('Nombre obligatorio.');
      const cambios={...datos,nombre:U(datos.nombre),rut:U(datos.rut).replace(/\s/g,''),
        correo:datos.correo.toLowerCase(),fechaNacimiento:datos.fechaNacimiento || null,actualizadoAt:serverTimestamp()};
      await runTransaction(db,async tx=>{
        const ref=doc(db,'coordinadores',c.id), snap=await tx.get(ref);
        if (!snap.exists()) throw new Error('El coordinador ya no existe.');
        // Evita sobrescribir modificaciones hechas en otra pantalla mientras se editaba.
        for (const f of campos) if (JSON.stringify(snap.data()[f.nombre] ?? '') !== JSON.stringify(c[f.nombre] ?? ''))
          throw new Error('Los datos cambiaron en otra pantalla. Cancela y vuelve a abrir la ficha.');
        tx.update(ref,cambios);
      });
      return 'Datos guardados en el registro compartido.';
    }});
}
function fotoControl(c) {
  const input=document.createElement('input');input.type='file';input.accept='image/jpeg,image/png,image/webp';
  input.onchange=async()=>{
    const file=input.files[0];if (!file) return;
    if (file.size>5*1024*1024 || !['image/jpeg','image/png','image/webp'].includes(file.type)) return guiaAviso('Usa JPG, PNG o WEBP de hasta 5 MB.','error');
    try {
      guiaAviso('Subiendo foto…');
      const fotoPath='coordinadores-fotos/'+c.id+'/perfil', ref=sRef(storage,fotoPath);
      await uploadBytes(ref,file,{contentType:file.type});
      const url=await getDownloadURL(ref);
      await updateDoc(doc(db,'coordinadores',c.id),{fotoPath,fotoURL:url+(url.includes('?')?'&':'?')+'v='+Date.now(),actualizadoAt:serverTimestamp()});
      guiaAviso('Foto actualizada.','exito');
    } catch(error) {guiaAviso('No se pudo guardar la foto: '+error.message,'error');}
  }; input.click();
}
function actualizarFiltroPersona() {
  const c=controlCatalogo.find(c=>c.id===controlPersona);
  $('coordFiltroEntrega').textContent=c ? 'Entregas de '+U(c.nombre) : 'Todas las entregas del año seleccionado';
}
function iniciarControlUI() {
  for(let ano=2025;ano<=Math.max(controlAno+3,2030);ano++) $('coordAno').add(new Option(String(ano),String(ano)));
  $('coordAno').value=String(controlAno);
  $('coordAno').onchange=()=>{
    controlAno=Number($('coordAno').value);controlPersona='';controlViajes=[];
    actualizarFiltroPersona();renderControl();void actualizarCoordinadores();
  };
  $('coordBuscar').oninput=renderControl;
  $('coordVerTodas').onclick=()=>{controlPersona='';actualizarFiltroPersona();void guiaActualizar().catch(e=>guiaAviso(e.message,'error'));};
}

const guiaToken = location.hash.match(/^#firmar-guia=([a-f0-9]{32})$/)?.[1];
if (guiaToken) {
  void guiaAbrirFirma(guiaToken);
} else {
  iniciarControlUI();
  $('btnLogin').onclick = async () => {
    const email = $('loginEmail').value.trim();
    const clave = $('loginPass').value;
    if (!email || !clave) return toast('Completa email y contraseña.');
    const boton = $('btnLogin');
    boton.disabled = true;
    try { await signInWithEmailAndPassword(auth,email,clave); }
    catch (error) { setEstado('No se pudo ingresar. Revisa tus datos.'); }
    finally { boton.disabled = false; }
  };
  $('btnLogout').onclick = () => signOut(auth).catch(error => toast(error.message));
  $('guiaCargar').onclick = () => void actualizarCoordinadores();
  $('guiaNueva').onclick = async () => {
    const boton = $('guiaNueva');
    boton.disabled = true;
    try { await guiaNuevaEntrega(); }
    catch (error) { guiaAviso(error.message, 'error'); }
    finally { boton.disabled = false; }
  };
  onAuthStateChanged(auth, usuario => {
    detenerStock?.();
    detenerEntregas?.();
    detenerPersonas?.();
    versionControl++;
    clearTimeout(actualizacion);
    state.user = usuario || null;
    $('userPill').textContent = usuario?.email || 'No autenticado';
    $('btnLogout').classList.toggle('hide', !usuario);
    $('loginView').classList.toggle('hide', !!usuario);
    $('appView').classList.toggle('hide', !usuario);
    if (!usuario) {
      $('guiaLista').replaceChildren();
      $('coordTarjetas').replaceChildren();
      controlCatalogo = [];
      return;
    }
    guiaAviso('Cargando stock y entregas…');
    detenerPersonas = onSnapshot(guiaCol('coordinadores'), snap => {
      controlCatalogo = snap.docs.filter(d=>d.id !== '_borradores').map(d=>({id:d.id,...d.data()}));
      renderControl();
    }, error=>guiaAviso(error.message,'error'));
    detenerStock = onSnapshot(guiaCol('bodega_guia_stock'),programarActualizacion,
      error => guiaAviso(error.message,'error'));
    detenerEntregas = onSnapshot(guiaEntregas,programarActualizacion,
      error => guiaAviso(error.message,'error'));
  });
}
