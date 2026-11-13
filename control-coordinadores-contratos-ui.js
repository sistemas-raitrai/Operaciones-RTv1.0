// Nuevo archivo, junto a control-coordinadores.js y firebase-init.js.
export function instalarContratos(h){
 const {api,node,text,button,modal,field,formSave,requireOperator,state,latest,tripTitle,fecha,hora,today,uuid,copy,toast,fileData,showFile}=h;
 const labels={manual:'Anexo 1 · Manual',confirmacion:'Confirmación del viaje',itinerario:'Itinerario',equipamiento:'Anexo 2 · Equipamiento'};
 const T=v=>String(v??'').trim();
 function enlace(token){const u=new URL('./control-coordinadores.html',location.href);u.hash='firmar-contrato='+token;return u.href;}
 function fechaCompleta(f){if(!f)return 'Sin fecha';const d=/^\d{4}-\d{2}-\d{2}$/.test(String(f))?String(f):new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Santiago'}).format(new Date(f));return fecha(d)+' '+d.slice(0,4);}
 function documentoNode(r){
  const s=r.documento,a=node('article',{class:'printdoc contrato'});
  if(s.modoPrueba)a.append(text('p','MODO PRUEBA · Contrato generado con controles documentales sin bloqueo.','notice warn'));
  a.append(text('p','Folio '+r.id+' · '+fechaCompleta(s.fechaContrato),'mini'));
  for(const [titulo,contenido]of s.secciones){a.append(text(titulo.startsWith('CONTRATO')?'h1':'h3',titulo));const contenidoFechas=contenido.replace(/\b\d{4}-\d{2}-\d{2}\b/g,fechaCompleta);a.append(text('p',contenidoFechas,'contrato-parrafo'));}
  a.append(text('h3','DOCUMENTACIÓN DEL COORDINADOR(A)'));
  for(const [k,label]of [['antecedentes','Certificado de antecedentes'],['inhabilidad','Certificado de inhabilidad para trabajar con menores'],['primerosAuxilios','Certificado de primeros auxilios (opcional)']]){
   const d=s.certificados[k],estado=d.vigente?'vigente al generar el contrato':d.presente?'vigencia pendiente o vencida':'sin archivo registrado';
   a.append(text('p',label+': '+estado+(d.emision?' · Emisión: '+fechaCompleta(d.emision):'')+(d.vence?' · Vence / renovar: '+fechaCompleta(d.vence):''),'mini'));
  }
  if(s.pendientes.length)a.append(text('p','Pendientes al generar esta copia: '+s.pendientes.join(' · '),'notice warn'));
  a.append(text('h3','POR LA EMPRESA'),text('p','Carlos Flores Maragaño'),text('p','Firma: __________________________________'),text('h3','EL/LA COORDINADOR(A)'),text('p',s.persona.nombre));
  if(r.firma)a.append(node('img',{src:r.firma,alt:'Firma del coordinador(a)',class:'signimg'}),text('p','Firmado el '+fechaCompleta(r.firmadoEn)+' · '+hora(r.firmadoEn),'mini'));
  else a.append(text('p','Firma: __________________________________'));
  a.append(text('p','Identificador del contenido: '+r.hash,'mini'));
  const imagenes=node('div',{class:'idimages'});for(const [k,label]of [['carnetAnverso','Anverso'],['carnetReverso','Reverso']])if(s.carnetSnapshot[k])imagenes.append(node('figure',{},node('img',{src:s.carnetSnapshot[k],alt:'Carnet '+label}),text('figcaption',label)));
  if(imagenes.children.length)a.append(text('h3','CÉDULA DE IDENTIDAD'),imagenes);
  return a;
 }
 async function imprimir(a){let area=document.getElementById('printArea');if(!area){area=node('div',{id:'printArea'});document.body.append(area);}area.replaceChildren(a.cloneNode(true));await Promise.all([...area.querySelectorAll('img')].map(i=>i.decode?.().catch(()=>{})));window.print();}
 function botonesAdjuntos(s,datos,publica=false){
  const row=node('div',{class:'row'});for(const [tipo,label]of Object.entries(labels))if(s.adjuntos[tipo])row.append(button('Abrir '+label,async()=>{const r=await api('contractFile',{...datos,tipo},uuid(),publica);await showFile(r,label);}));return row;
 }
 async function verContrato(id){requireOperator();const r=await api('contractRead',{contratoId:id}),d=modal('Contrato · '+r.documento.persona.nombre),a=documentoNode(r);d._body.append(a,botonesAdjuntos(r.documento,{contratoId:id}),text('p','Los PDF adjuntos se abren y descargan por separado. La impresión incluye el contrato, la firma registrada y las imágenes del carnet.','mini'),button('Imprimir / Guardar contrato como PDF',()=>imprimir(a),'primary'));}
 function crearContrato(c,alGuardar){
  requireOperator();if(state.loading||state.travelError)throw new Error('Actualiza los viajes antes de crear el contrato.');
  const viajes=state.viajes.filter(g=>g.asignaciones.has(c.id));if(!viajes.length)throw new Error('Sin viajes asignados en el año seleccionado.');
  const d=modal('Crear contrato · '+c.nombre),form=node('form'),rid=uuid();
  const grupo=field('Viaje del contrato',{required:true,options:[['','Selecciona un viaje'],...viajes.map(g=>[g.id,tripTitle(g)+' · '+fecha(g.fechaInicio)+' a '+fecha(g.fechaFin)])]});
  form.append(grupo.wrap,text('p','Se genera un contrato por viaje. La tarifa se obtiene en el servidor: Brasil / Bariloche $73.000; Sur de Chile / Sur de Chile–Bariloche / Norte de Chile $78.000 brutos diarios. El extra de $20.000 conserva la condición indicada en el contrato; no se suma automáticamente.','notice'));
  const archivos={};for(const [tipo,label]of Object.entries(labels)){const f=field(label+' · PDF hasta 2 MB',{type:'file',accept:'application/pdf'});archivos[tipo]=f.input;form.append(f.wrap);}
  form.append(text('p','Para Anexo 2, guarda primero el anexo de entrega como PDF y adjúntalo aquí. Los PDF se guardan como copias de este contrato y estarán disponibles en el enlace de firma. En modo prueba puedes continuar sin ellos y sin certificados, con los pendientes visibles. Primeros auxilios es opcional.','notice warn'));
  formSave(d,form,async()=>{
   const adjuntos={};for(const [k,input]of Object.entries(archivos))if(input.files[0])adjuntos[k]=await fileData(input.files[0],2*1024*1024);
   const r=await api('contractCreate',{coordinadorId:c.id,grupoId:grupo.input.value,fechaContrato:today(),adjuntos},rid);
   await alGuardar();queueMicrotask(()=>{const aviso=modal('Contrato creado',{wide:false});aviso._body.append(text('p','Contrato generado. El enlace de firma dura 7 días.'),button('Copiar enlace de firma',async()=>{await copy(enlace(r.token));toast('Enlace de contrato copiado.');}),button('Ver contrato',()=>verContrato(r.contratoId)));});
  },'Generar contrato');d._body.append(form);
 }
 function panelContratos(c){
  const box=node('div',{class:'doccard'},text('h3','Contratos por viaje')),list=node('div'),status=text('p','','mini');
  async function cargar(){try{status.textContent='Cargando contratos…';const r=await api('contractList',{coordinadorId:c.id});if(!box.isConnected)return;list.replaceChildren();for(const x of r.filas){const item=node('div',{class:'delivery'},text('h3',x.viaje.nombre),text('p',x.viaje.destino+' · '+fechaCompleta(x.viaje.inicio)+' a '+fechaCompleta(x.viaje.fin)),text('p',(x.estado==='firmado'?'FIRMADO':'PENDIENTE DE FIRMA')+(x.modoPrueba?' · MODO PRUEBA':''),'pill'),button('Ver contrato / imprimir',()=>verContrato(x.id)));if(x.estado==='pendiente')item.append(button('Generar / renovar enlace de firma',async()=>{if(!confirm('Se invalidará el enlace anterior. ¿Generar uno nuevo por 7 días?'))return;const r=await api('contractRenew',{contratoId:x.id,coordinadorId:c.id});await copy(enlace(r.token));toast('Enlace nuevo copiado.');}));list.append(item);}status.textContent=r.filas.length?r.filas.length+' contratos registrados.':'Sin contratos registrados.';}catch(e){status.textContent=e.message;}}
  box.append(node('div',{class:'row'},button('Crear contrato',()=>crearContrato(latest(c.id)||c,cargar),'primary'),button('Actualizar contratos',cargar),button('Ver requisitos',async()=>{const r=await api('contractCheck',{coordinadorId:c.id});status.textContent=(r.bloqueoActivo?'Control documental activo. ':'Modo prueba, sin bloqueo. ')+(r.faltantes.length?r.faltantes.join(' · '):'Carnet y certificados obligatorios vigentes.');})),status,list);
  queueMicrotask(cargar);return box;
 }
 async function firmarContrato(token){
  document.body.replaceChildren();const main=node('main',{class:'wrap'}),panel=node('section',{class:'panel'}),status=text('p','Cargando contrato…','notice');status.id='status';main.append(panel,status);document.body.append(main);
  try{
   const r=await api('contractPublicGet',{token},uuid(),true),a=documentoNode(r);panel.append(a,botonesAdjuntos(r.documento,{token},true));
   if(r.estado==='firmado'){panel.append(button('Imprimir contrato firmado',()=>imprimir(a)));status.textContent='Este contrato ya está firmado.';return;}
   const canvas=node('canvas',{width:640,height:220,class:'signature'}),ctx=canvas.getContext('2d');ctx.lineWidth=3;ctx.lineCap='round';let pointer=null,trazos=0,requestId=uuid();
   const point=e=>{const z=canvas.getBoundingClientRect();return [(e.clientX-z.left)*640/z.width,(e.clientY-z.top)*220/z.height];};
   canvas.onpointerdown=e=>{if(pointer!==null)return;pointer=e.pointerId;canvas.setPointerCapture(pointer);ctx.beginPath();ctx.moveTo(...point(e));};canvas.onpointermove=e=>{if(pointer!==e.pointerId)return;ctx.lineTo(...point(e));ctx.stroke();trazos++;};canvas.onpointerup=canvas.onpointercancel=()=>pointer=null;
   const acepta=node('input',{type:'checkbox'});
   panel.append(text('h2','Firma del coordinador(a)'),text('p','Revisa el contrato, el carnet y los PDF adjuntos antes de firmar.'),canvas,node('p',{},node('label',{},acepta,' He revisado el contrato y sus adjuntos, incluidos los pendientes indicados, y acepto su contenido.')),node('div',{class:'row'},button('Limpiar firma',()=>{ctx.clearRect(0,0,640,220);trazos=0;}),button('Firmar contrato',async()=>{
    try{if(!acepta.checked||!trazos)throw new Error('Dibuja tu firma y marca la aceptación.');await api('contractPublicSign',{token,hash:r.hash,firma:canvas.toDataURL('image/png'),acepto:true},requestId,true);await firmarContrato(token);}catch(e){status.textContent=e.message;}
   },'primary')));status.textContent='El enlace permite firmar una sola vez.';
  }catch(e){status.textContent=e.message;}
 }
 return {panelContratos,firmarContrato};
}
