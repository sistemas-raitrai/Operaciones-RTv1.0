// Nuevo archivo, junto a control-coordinadores.js y firebase-init.js.
export function instalarContratos(h){
 const {api,node,text,button,modal,field,formSave,requireOperator,state,latest,tripTitle,fecha,hora,today,uuid,copy,toast,fileData,showFile}=h;
 // Solo para consultar adjuntos de contratos antiguos, sin modificar su contenido firmado.
 const labels={manual:'Manual (adjunto histórico)',confirmacion:'Confirmación (adjunto histórico)',itinerario:'Itinerario (adjunto histórico)',equipamiento:'Equipamiento (adjunto histórico)'};
 const tipos={principal:'Coordinador principal',asistente:'Asistente de coordinación',no_aplica:'No aplica'};
 const T=v=>String(v??'').trim();
 function enlace(token){const u=new URL('./control-coordinadores.html',location.href);u.hash='firmar-contrato='+token;return u.href;}
 function fechaCompleta(f){if(!f)return 'Sin fecha';const d=/^\d{4}-\d{2}-\d{2}$/.test(String(f))?String(f):new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Santiago'}).format(new Date(f));return fecha(d)+' '+d.slice(0,4);}
 function documentoNode(r){
  const s=r.documento,a=node('article',{class:'printdoc contrato'});
  if(s.modoPrueba)a.append(text('p','MODO PRUEBA · Contrato generado con controles documentales sin bloqueo.','notice warn'));
  a.append(text('p','Folio '+r.id+' · '+fechaCompleta(s.fechaContrato),'mini'));
  for(const [titulo,contenido]of s.secciones){a.append(text(titulo.startsWith('CONTRATO')?'h1':'h3',titulo));const contenidoFechas=contenido.replace(/\b\d{4}-\d{2}-\d{2}\b/g,fechaCompleta);a.append(text('p',contenidoFechas,'contrato-parrafo'));}
  a.append(text('h3',s.tipoContrato==='asistente'?'DOCUMENTACIÓN DEL/DE LA ASISTENTE':'DOCUMENTACIÓN DEL COORDINADOR(A)'));
  for(const [k,label]of [['antecedentes','Certificado de antecedentes'],['inhabilidad','Certificado de inhabilidad para trabajar con menores'],['primerosAuxilios','Certificado de primeros auxilios (opcional)']]){
   const d=s.certificados[k],estado=d.vigente?'vigente al generar el contrato':d.presente?'vigencia pendiente o vencida':'sin archivo registrado';
   a.append(text('p',label+': '+estado+(d.emision?' · Emisión: '+fechaCompleta(d.emision):'')+(d.vence?' · Vence / renovar: '+fechaCompleta(d.vence):''),'mini'));
  }
  if(s.pendientes.length)a.append(text('p','Pendientes al generar esta copia: '+s.pendientes.join(' · '),'notice warn'));
  a.append(text('h3','POR LA EMPRESA'),text('p','Carlos Flores Maragaño'),s.firmaEmpresaSnapshot?node('img',{src:s.firmaEmpresaSnapshot,alt:'Firma de Carlos Flores Maragaño',class:'signimg'}):text('p','Firma: __________________________________'),text('h3',s.tipoContrato==='asistente'?'EL/LA ASISTENTE DE COORDINACIÓN':'EL/LA COORDINADOR(A)'),text('p',s.persona.nombre));
  if(r.firma)a.append(node('img',{src:r.firma,alt:'Firma del coordinador(a)',class:'signimg'}),text('p','Firmado el '+fechaCompleta(r.firmadoEn)+' · '+hora(r.firmadoEn),'mini'));
  else a.append(text('p','Firma: __________________________________'));
  a.append(text('p','Identificador del contenido: '+r.hash,'mini'));
  const imagenes=node('div',{class:'idimages'});for(const [k,label]of [['carnetAnverso','Anverso'],['carnetReverso','Reverso']])if(s.carnetSnapshot[k])imagenes.append(node('figure',{},node('img',{src:s.carnetSnapshot[k],alt:'Carnet '+label}),text('figcaption',label)));
  if(imagenes.children.length)a.append(text('h3','CÉDULA DE IDENTIDAD'),imagenes);
  return a;
 }
 async function imprimir(a){let area=document.getElementById('printArea');if(!area){area=node('div',{id:'printArea'});document.body.append(area);}area.replaceChildren(a.cloneNode(true));await Promise.all([...area.querySelectorAll('img')].map(i=>i.decode?.().catch(()=>{})));window.print();}
 function botonesAdjuntos(s,datos,publica=false){
  const row=node('div',{class:'row'});for(const [tipo,label]of Object.entries(labels))if(s.adjuntos?.[tipo])row.append(button('Abrir '+label,async()=>{const r=await api('contractFile',{...datos,tipo},uuid(),publica);await showFile(r,label);}));return row;
 }
 async function abrirPDF(id,versionId=''){
  requireOperator();await showFile(await api('contractFile',{contratoId:id,tipo:'sustituto',...(versionId?{versionId}:{})}),'Contrato adjunto');
 }
 async function verContrato(id){
  requireOperator();const r=await api('contractRead',{contratoId:id}),d=modal('Contrato · '+r.documento.persona.nombre);
  if(r.tipoContrato==='no_aplica'){
   d._body.append(text('h3','Contrato NO APLICA'),text('p',r.documento.viaje.nombre+' · '+r.documento.viaje.destino),text('p','Motivo: '+r.motivoNoAplica,'notice'),text('p','Registrado por '+r.registradoPor+' · '+fechaCompleta(r.registradoEn)+' · '+hora(r.registradoEn),'mini'),text('p','No se generó contrato ni firma. Los anexos de equipamiento y manual son independientes.'));return;
  }
  const a=documentoNode(r);
  if(r.sustitutoActual){
   const v=r.sustitutoActual;
   d._body.append(text('h3','Documento vigente: contrato adjunto'),text('p',v.nombre),text('p',v.firmadoExterno?'Firmado fuera del sistema · '+fechaCompleta(v.fechaFirma):'Adjuntado · sin firma registrada','notice'),text('p','Cargado por '+v.operador+' · '+fechaCompleta(v.cargadoEn)+' · '+hora(v.cargadoEn),'mini'),text('p','Motivo: '+v.motivo),button('Abrir / descargar PDF vigente',()=>abrirPDF(id),'primary'));
   const original=node('details',{},node('summary',{},'Ver contrato generado anterior (reemplazado)'),a,botonesAdjuntos(r.documento,{contratoId:id}),button('Imprimir copia anterior',()=>imprimir(a)));
   d._body.append(original,text('h3','Historial de archivos adjuntos'));
   for(const v of r.versiones||[]){const box=node('div',{class:'doccard'},text('p','Versión '+v.revision+' · '+v.nombre+(v.id===r.sustitutoActual.versionId?' · VIGENTE':' · REEMPLAZADA')),text('p',v.operador+' · '+fechaCompleta(v.cargadoEn)+' · '+hora(v.cargadoEn),'mini'),text('p',v.motivo,'mini'),text('p',v.firmadoExterno?'Firmado fuera del sistema · '+fechaCompleta(v.fechaFirma):'Sin firma registrada','mini'),button('Abrir esta versión',()=>abrirPDF(id,v.id)));d._body.append(box);}
  }else d._body.append(a,botonesAdjuntos(r.documento,{contratoId:id}),button('Imprimir / Guardar contrato como PDF',()=>imprimir(a),'primary'));
 }
 function sustituirContrato(c,x,alGuardar){
  requireOperator();const d=modal('Adjuntar contrato sustituto · '+c.nombre),form=node('form'),rid=uuid();
  const archivo=field('Contrato sustituto · PDF hasta 10 MB',{type:'file',accept:'application/pdf',required:true}),motivo=field('Motivo del reemplazo',{multiline:true,required:true,maxLength:2000}),firmado=node('input',{type:'checkbox'}),firmaFecha=field('Fecha de firma del documento',{type:'date',max:today()},today());
  firmaFecha.wrap.hidden=true;
  firmado.onchange=()=>{firmaFecha.wrap.hidden=!firmado.checked;firmaFecha.input.required=firmado.checked;};
  form.append(text('p',x.viaje.nombre),text('p','Este PDF pasará a ser el contrato vigente. Se conservarán el contrato generado, su firma si existe y los PDF anteriores. El enlace de firma anterior quedará invalidado. Este cambio no afecta al Anexo 1 de equipamiento ni a sus saldos o firmas.','notice warn'),archivo.wrap,motivo.wrap,node('p',{},node('label',{},firmado,' El documento ya está firmado fuera del sistema')),firmaFecha.wrap);
  formSave(d,form,async()=>{
   await api('contractReplace',{contratoId:x.id,coordinadorId:c.id,revisionEsperada:x.sustitutoRevision||0,archivo:await fileData(archivo.input.files[0],10*1024*1024),motivo:T(motivo.input.value),firmadoExterno:firmado.checked,fechaFirma:firmado.checked?firmaFecha.input.value:''},rid);
   await alGuardar();
  },'Guardar contrato sustituto');d._body.append(form);
 }

 function crearContrato(c,alGuardar){
  requireOperator();void actualizarModo();if(state.loading||state.travelError)throw new Error('Actualiza los viajes antes de crear el contrato.');
  const viajes=state.viajes.filter(g=>g.asignaciones.has(c.id));if(!viajes.length)throw new Error('Sin viajes asignados en el año seleccionado.');
  const d=modal('Crear contrato · '+c.nombre),form=node('form'),rid=uuid();
  const grupo=field('Viaje del contrato',{required:true,options:[['','Selecciona un viaje'],...viajes.map(g=>[g.id,tripTitle(g)+' · '+fecha(g.fechaInicio)+' a '+fecha(g.fechaFin)])]});
  const tipo=field('Modalidad para este viaje',{required:true,options:[['principal','Coordinador principal'],['asistente','Asistente de coordinación'],['no_aplica','No aplica']]},'principal');
  const motivo=field('Motivo de No aplica',{multiline:true,maxLength:2000});
  const explicacion=text('p','','notice'),anexos=text('p','El Anexo 1 de equipamiento y el Anexo 2 del manual se mantienen independientes, también si eliges No aplica. No se cargan Confirmación ni Itinerario.','notice');
  function actualizar(){
   const no=tipo.input.value==='no_aplica';motivo.wrap.hidden=!no;motivo.input.required=no;
   explicacion.textContent=no?'Registra que el contrato No aplica a esta persona para este viaje. Debes indicar el motivo. No se genera documento, enlace ni firma; tampoco se exigen carnet o certificados para registrar esta decisión.':tipo.input.value==='asistente'?'Asistente: $36.500 brutos diarios en Brasil o Bariloche solo; $39.000 en Sur de Chile y sus variantes, Sur de Chile–Bariloche o Norte de Chile. El contrato contiene las funciones y condiciones de asistencia. El extra de $20.000 conserva la condición del regreso después de medianoche.':'Principal: $73.000 brutos diarios en Brasil o Bariloche solo; $78.000 en Sur de Chile y sus variantes, Sur de Chile–Bariloche o Norte de Chile. Se completan los datos y el carnet de la ficha. El extra de $20.000 conserva la condición del regreso después de medianoche.';
  }
  tipo.input.onchange=actualizar;actualizar();
  form.append(grupo.wrap,tipo.wrap,motivo.wrap,explicacion,anexos,text('p','La elección afecta solo a este coordinador y viaje. Si ya hay un registro, Sistemas o Administración debe borrarlo antes de cambiarlo.','mini'));
  formSave(d,form,async()=>{
   const r=await api('contractCreate',{coordinadorId:c.id,grupoId:grupo.input.value,tipoContrato:tipo.input.value,motivoNoAplica:tipo.input.value==='no_aplica'?T(motivo.input.value):'',fechaContrato:today()},rid);
   await alGuardar();
   if(r.noAplica){toast('Contrato No aplica registrado.');return;}
   queueMicrotask(()=>{const aviso=modal('Contrato creado',{wide:false});aviso._body.append(text('p',(r.tipoContrato==='asistente'?'Contrato de asistente':'Contrato de coordinador principal')+' generado. El enlace de firma dura 7 días.'),button('Copiar enlace de firma',async()=>{await copy(enlace(r.token));toast('Enlace de contrato copiado.');}),button('Ver contrato',()=>verContrato(r.contratoId)));});
  },'Guardar selección');d._body.append(form);
 }
 function panelContratos(c){
  const box=node('div',{class:'doccard'},text('h3','Contratos por viaje')),list=node('div'),status=text('p','','mini');
  const estados={no_aplica:'CONTRATO NO APLICA',pendiente:'PENDIENTE DE FIRMA POR ENLACE',firmado:'FIRMADO POR ENLACE',adjuntado:'ADJUNTADO · SIN FIRMA REGISTRADA',firmado_externo:'FIRMADO FUERA DEL SISTEMA'};
  async function cargar(){
   try{
    status.textContent='Cargando contratos…';const r=await api('contractList',{coordinadorId:c.id});if(!box.isConnected)return;
    list.replaceChildren();
    for(const x of r.filas){
     const item=node('div',{class:'delivery'},text('h3',x.viaje.nombre),text('p',x.viaje.destino+' · '+fechaCompleta(x.viaje.inicio)+' a '+fechaCompleta(x.viaje.fin)),text('p',(estados[x.estado]||x.estado)+(x.estado!=='no_aplica'&&x.modoPrueba?' · MODO PRUEBA':''),'pill'),button(x.estado==='no_aplica'?'Ver registro No aplica':x.sustitutoActual?'Ver PDF vigente e historial':'Ver contrato / imprimir',()=>verContrato(x.id)));
     item.append(text('p',tipos[x.tipoContrato||'principal']||'Coordinador principal','mini'));if(x.estado==='no_aplica')item.append(text('p','Motivo: '+x.motivoNoAplica,'mini'));
     if(x.estado==='pendiente'&&!x.sustitutoActual)item.append(button('Generar / renovar enlace de firma',async()=>{if(!confirm('Se invalidará el enlace anterior. ¿Generar uno nuevo por 7 días?'))return;const r=await api('contractRenew',{contratoId:x.id,coordinadorId:c.id});await copy(enlace(r.token));toast('Enlace nuevo copiado.');}));
     if(x.estado!=='no_aplica')item.append(button(x.sustitutoActual?'Reemplazar PDF vigente':'Adjuntar contrato sustituto',()=>sustituirContrato(latest(c.id)||c,x,cargar)));
     if(puedeBorrar())item.append(button(x.estado==='no_aplica'?'Borrar registro No aplica':'Borrar contrato',()=>borrarContrato(latest(c.id)||c,x,cargar),'danger'));
     list.append(item);
    }
    status.textContent=r.filas.length?r.filas.length+' contratos registrados.':'Sin contratos registrados.';
   }catch(e){status.textContent=e.message;}
  }
  box.append(node('div',{class:'row'},button('Crear contrato',()=>crearContrato(latest(c.id)||c,cargar),'primary'),button('Actualizar contratos',cargar),button('Ver requisitos',async()=>{const r=await api('contractCheck',{coordinadorId:c.id});status.textContent=(r.bloqueoActivo?'Control documental activo. ':'Modo prueba, sin bloqueo. ')+(r.faltantes.length?r.faltantes.join(' · '):'Carnet y certificados obligatorios vigentes.');})),text('p','Anexo 1 · Equipamiento: entregas y firma independientes. Anexo 2 · Manual: pendiente de incorporar, con firma independiente.','mini'),status,list);
  queueMicrotask(cargar);void actualizarModo();return box;
 }

 async function firmarContrato(token){
  document.body.replaceChildren();const main=node('main',{class:'wrap'}),panel=node('section',{class:'panel'}),status=text('p','Cargando contrato…','notice');status.id='status';main.append(panel,status);document.body.append(main);
  try{
   const r=await api('contractPublicGet',{token},uuid(),true),a=documentoNode(r);panel.append(a,botonesAdjuntos(r.documento,{token},true));
   if(r.estado==='firmado'){panel.append(button('Imprimir contrato firmado',()=>imprimir(a)));status.textContent='Este contrato ya está firmado.';return;}
   const firma=capturaFirma(),requestId=uuid();
   const acepta=node('input',{type:'checkbox'});
   panel.append(text('h2',r.documento.tipoContrato==='asistente'?'Firma del/de la asistente de coordinación':'Firma del coordinador(a)'),text('p','Revisa el contrato y el carnet antes de firmar. Los anexos se firman por separado.'),firma.element,node('p',{},node('label',{},acepta,' He revisado el contrato y la identificación mostrada, incluidos los pendientes indicados, y acepto su contenido. Esta firma corresponde únicamente al contrato.')),node('div',{class:'row'},button('Firmar contrato',async()=>{
    try{if(!acepta.checked||!firma.value())throw new Error('Dibuja tu firma y marca la aceptación.');await api('contractPublicSign',{token,hash:r.hash,firma:firma.value(),acepto:true},requestId,true);await firmarContrato(token);}catch(e){status.textContent=e.message;}
   },'primary')));status.textContent='El enlace permite firmar una sola vez.';
  }catch(e){status.textContent=e.message;}
 }
 let modeConfig=null;
 const email=()=>T(state.user?.email).toLowerCase();
 const puedeBorrar=()=>['sistemas@raitrai.cl','administracion@raitrai.cl'].includes(email());
 async function actualizarModo(){
  const label=document.getElementById('modeLabel'),toggle=document.getElementById('modeToggle'),notice=document.getElementById('modeNotice');
  if(!state.user){modeConfig=null;if(label)label.hidden=true;if(toggle)toggle.hidden=true;if(notice)notice.hidden=true;return;}
  const uid=state.user.uid;
  try{
   const r=await api('contractConfigGet');if(state.user?.uid!==uid)return;
   modeConfig=r;
   if(label){label.hidden=false;label.textContent=r.modoPrueba?'Modo prueba activo':'Modo definitivo';label.className='pill '+(r.modoPrueba?'warn':'ok');}
   if(notice){notice.hidden=false;notice.className='notice '+(r.modoPrueba?'warn':'good');notice.textContent=r.modoPrueba?'Modo prueba activo: los contratos pueden generarse y firmarse sin completar los documentos obligatorios. Las firmas y registros se guardan realmente.':'Modo definitivo: se exige carnet, antecedentes e inhabilidad vigentes para generar y firmar contratos. Primeros auxilios es opcional. Los anexos se firman por separado.';}
   if(toggle){toggle.hidden=email()!=='sistemas@raitrai.cl';toggle.textContent=r.modoPrueba?'Salir del modo prueba':'Activar modo prueba';toggle.onclick=()=>cambiarModo().catch(e=>toast(e.message));}
  }catch(e){if(state.user?.uid!==uid)return;modeConfig=null;if(notice)notice.hidden=true;if(label){label.hidden=false;label.textContent='Modo sin verificar';label.className='pill warn';}if(toggle)toggle.hidden=true;}
 }
 async function cambiarModo(){
  requireOperator();if(email()!=='sistemas@raitrai.cl')throw new Error('Solo Sistemas puede cambiar el modo prueba.');
  await actualizarModo();if(!modeConfig)throw new Error('No se pudo consultar el modo actual.');
  const actual={...modeConfig},nuevo=!actual.modoPrueba,d=modal(nuevo?'Activar modo prueba':'Salir del modo prueba',{wide:false}),form=node('form'),rid=uuid(),motivo=field('Motivo del cambio',{multiline:true,required:true,maxLength:2000});
  form.append(text('p',nuevo?'Se permitirán contratos sin completar el control documental. Los datos y firmas se guardarán realmente.':'Se exigirá carnet, antecedentes e inhabilidad vigentes. Los contratos ya creados conservarán su contenido y su marca de prueba.','notice warn'),motivo.wrap);
  formSave(d,form,async()=>{await api('contractConfigSet',{modoPrueba:nuevo,revisionEsperada:actual.revision,motivo:T(motivo.input.value)},rid);await actualizarModo();},nuevo?'Activar modo prueba':'Salir del modo prueba');d._body.append(form);
 }
 setInterval(()=>{if(state.user)void actualizarModo();},60000);
 function borrarContrato(c,x,alGuardar){
  requireOperator();if(!puedeBorrar())throw new Error('Solo Sistemas y Administración pueden borrar contratos.');
  const d=modal((x.estado==='no_aplica'?'Borrar registro No aplica · ':'Borrar contrato · ')+c.nombre,{wide:false}),form=node('form'),rid=uuid(),motivo=field('Motivo del borrado',{multiline:true,required:true,maxLength:2000});
  form.append(text('p',x.viaje.nombre+' · Folio '+x.id),text('p','Se retirará este contrato de la lista y se invalidará su enlace. Podrás generar otro. Se conservará el registro de auditoría. No se borrarán entregas ni firmas de equipamiento.','notice warn'),motivo.wrap);
  formSave(d,form,async()=>{await api('contractDelete',{contratoId:x.id,coordinadorId:c.id,motivo:T(motivo.input.value)},rid);await alGuardar();},x.estado==='no_aplica'?'Borrar registro No aplica':'Borrar contrato');d._body.append(form);
 }
 function capturaFirma(){
  let guardada='',trazosGuardados=[];
  const area=node('div',{class:'firma-captura'}),preview=node('div',{class:'firma-preview'}),estado=text('p','Todavía no dibujaste tu firma.','mini');
  function actualizar(){preview.replaceChildren();if(guardada)preview.append(node('img',{src:guardada,alt:'Vista previa de tu firma'}));estado.textContent=guardada?'Firma preparada. Revisa la aceptación antes de confirmar.':'Todavía no dibujaste tu firma.';}
  function abrir(){
   const d=modal('Dibuja tu firma');d.classList.add('firma-dialog');d._body.classList.add('firma-editor-body');
   const canvas=node('canvas',{class:'firma-canvas'}),ctx=canvas.getContext('2d');
   let trazos=trazosGuardados.map(s=>s.map(p=>[...p])),actual=null,pointer=null;
   const pintar=()=>{
    ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.strokeStyle='#162033';ctx.fillStyle='#162033';ctx.lineWidth=Math.max(2,canvas.width/260);ctx.lineCap='round';ctx.lineJoin='round';
    for(const trazo of trazos){if(!trazo.length)continue;ctx.beginPath();ctx.moveTo(trazo[0][0]*canvas.width,trazo[0][1]*canvas.height);for(const p of trazo.slice(1))ctx.lineTo(p[0]*canvas.width,p[1]*canvas.height);if(trazo.length===1){ctx.lineTo(trazo[0][0]*canvas.width+1,trazo[0][1]*canvas.height+1);}ctx.stroke();}
   };
   const ajustar=()=>{const r=canvas.getBoundingClientRect();if(r.width<=0||r.height<=0)return;const ratio=Math.min(window.devicePixelRatio||1,2);canvas.width=Math.round(r.width*ratio);canvas.height=Math.round(r.height*ratio);pintar();};
   const punto=e=>{const r=canvas.getBoundingClientRect();return [Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))];};
   canvas.onpointerdown=e=>{if(pointer!==null)return;e.preventDefault();pointer=e.pointerId;canvas.setPointerCapture(pointer);actual=[punto(e)];trazos.push(actual);pintar();};
   canvas.onpointermove=e=>{if(pointer!==e.pointerId)return;e.preventDefault();actual.push(punto(e));pintar();};canvas.onpointerup=canvas.onpointercancel=()=>{pointer=null;actual=null;};
   const limpiar=button('Limpiar firma',()=>{trazos=[];pointer=null;actual=null;pintar();});
   const usar=button('Usar esta firma',()=>{if(trazos.reduce((n,t)=>n+t.length,0)<3)throw new Error('Dibuja tu firma antes de continuar.');const data=canvas.toDataURL('image/png');if(data.length>330000)throw new Error('La firma es demasiado grande. Limpia e inténtalo de nuevo.');guardada=data;trazosGuardados=trazos.map(s=>s.map(p=>[...p]));actualizar();d.close();},'primary');
   d._body.append(text('p','Firma con el dedo o el mouse. Puedes girar el celular; el dibujo se conserva.','mini'),canvas,node('div',{class:'row firma-controles'},limpiar,usar));
   let observer;if(typeof ResizeObserver!=='undefined'){observer=new ResizeObserver(ajustar);observer.observe(canvas);}window.addEventListener('resize',ajustar);d._cleanup=()=>{observer?.disconnect();window.removeEventListener('resize',ajustar);};requestAnimationFrame(ajustar);
  }
  area.append(preview,button('Abrir panel para dibujar firma',abrir,'primary firma-abrir'),estado);actualizar();
  return {element:area,value:()=>guardada};
 }

 return {panelContratos,firmarContrato,capturaFirma,actualizarModo};
}
