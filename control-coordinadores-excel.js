// Exportación de activos del año. Usa el mismo SheetJS que Control Stock.
export function datosExcelActivos({state,operacion,bancoFormulario,vigente}){
 if(!state.user)throw new Error('Inicia sesión.');
 if(state.loading)throw new Error('Espera a que termine la carga del año.');
 if(state.travelError)throw new Error('Actualiza los datos del año antes de exportar: '+state.travelError);
 const personas=state.personas.filter(c=>operacion.activo(c)).slice().sort((a,b)=>String(a.nombre||'').localeCompare(String(b.nombre||''),'es'));
 if(!personas.length)throw new Error('No hay coordinadores activos en el año seleccionado.');
 const texto=v=>v==null?'':String(v),si=v=>v?'Sí':'No';
 const activos=[],viajes=[],documentos=[],adicionales=[];
 const etiquetas={antecedentes:'Antecedentes',inhabilidad:'Inhabilidades',primerosAuxilios:'Primeros auxilios (opcional)',carnetAnverso:'Carnet anverso',carnetReverso:'Carnet reverso'};
 function plano(obj,prefijo,base){
  if(!obj||typeof obj!=='object')return;
  for(const[k,v]of Object.entries(obj)){
   if(/token|password|clave|secreto|secret|firma|base64|ruta|path/i.test(k)||v==null)continue;
   const campo=prefijo?prefijo+'.'+k:k;
   if(typeof v==='object'){
    if(typeof v.toDate==='function'){adicionales.push({...base,Campo:campo,Valor:v.toDate().toISOString()});}
    else if(typeof v.seconds==='number'&&Object.keys(v).every(x=>['seconds','nanoseconds'].includes(x)))adicionales.push({...base,Campo:campo,Valor:new Date(v.seconds*1000).toISOString()});
    else plano(v,campo,base);
   }else if(['string','number','boolean'].includes(typeof v)&&!/^data:/i.test(String(v)))adicionales.push({...base,Campo:campo,Valor:typeof v==='boolean'?si(v):texto(v)});
  }
 }
 for(const c of personas){
  const base={'ID coordinador':texto(c.id),Nombre:texto(c.nombre),RUT:texto(c.rut)};
  const gs=state.viajes.filter(g=>g.asignaciones.has(c.id)),ops=operacion.operativas(c),b=bancoFormulario(c),docs=c.documentosControl||{};
  const ficha={...base,'Año operativo':state.ano,Correo:texto(c.correo),'Teléfono':texto(c.telefono),'Fecha de nacimiento':texto(c.fechaNacimiento),'Dirección':texto(c.direccion),'Ciudad de residencia':texto(c.ciudadResidencia),'Celular marca/modelo':texto(c.celularMarcaModelo),'Talla de polera':texto(c.tallaPolera),'Dato para conteos hoteles':texto(c.sexo),Banco:b.banco,'Tipo de cuenta':b.tipoCuenta,'Número de cuenta':texto(b.numeroCuenta),'Datos para transferir originales':texto(c.datosTransferir),'Información adicional':texto(c.notas),'Foto URL':texto(c.fotoURL),'Carnet vence':texto(c.carnetVence),'Grupos asignados':gs.length,'Asignaciones operativas activas':ops.length,'Tipo de actividad':[gs.length?'Con grupo':'',ops.length?'Función operativa':''].filter(Boolean).join(' / '),'Destinos':[...new Set([...gs.map(g=>g.destino||g.destinoPrincipal),...ops.map(a=>a.destino)].filter(Boolean))].join(' / ')};
  for(const[k,label]of Object.entries(etiquetas)){const meta=docs[k];ficha[label+' · Estado']=vigente(meta).label;ficha[label+' · Vence']=texto(meta?.vence);documentos.push({...base,Documento:label,Adjunto:si(meta?.ruta),'Estado de vigencia':vigente(meta).label,'Fecha de emisión':texto(meta?.emision),'Fecha de vencimiento':texto(meta?.vence)});}
  activos.push(ficha);
  for(const g of gs){const a=g.asignaciones.get(c.id)||{};viajes.push({...base,'Año operativo':state.ano,Tipo:'Grupo','ID viaje/asignación':texto(g.id),Grupo:texto(g.aliasGrupo||g.nombre||[g.colegio,g.curso].filter(Boolean).join(' ')),Colegio:texto(g.colegio),Curso:texto(g.curso),'Número de negocio':texto(g.numeroNegocio),Destino:texto(g.destino||g.destinoPrincipal),Inicio:texto(g.fechaInicio||g.inicio),Término:texto(g.fechaFin||g.fin),Función:texto(a.funcion||a.rol),Confirmado:si(a.confirmado),'Estado coordinación':texto(a.estadoCoord)});}
  for(const a of ops)viajes.push({...base,'Año operativo':state.ano,Tipo:'Operativa sin grupo','ID viaje/asignación':texto(a.id),Grupo:'',Colegio:'',Curso:'','Número de negocio':'',Destino:texto(a.destino),Inicio:texto(a.inicio),Término:texto(a.fin),Función:({coordinador_general:'Coordinador general',asistente_general:'Coordinador asistente general',monitor:'Monitor de entretenimiento'})[a.funcion]||texto(a.funcion),Confirmado:'','Estado coordinación':'Activa'});
  plano(c,'Ficha',base);plano(state.perfiles.get(c.id),'Perfil anual',base);
 }
 return {ano:state.ano,total:personas.length,hojas:[['Activos',activos],['Viajes y funciones',viajes],['Documentos',documentos],['Datos adicionales',adicionales]]};
}
export async function exportarExcelActivos(h){
 const datos=datosExcelActivos(h),X=globalThis.XLSX;
 if(!X?.utils||!X.writeFile)throw new Error('No se cargó la biblioteca de Excel. Recarga la página y revisa la conexión.');
 const wb=X.utils.book_new();wb.Props={Title:'Coordinadores activos '+datos.ano,Author:'RaiTrai',Subject:'Activos del año operativo, sin depender del buscador'};
 for(const[nombre,filas]of datos.hojas){
  const ws=X.utils.json_to_sheet(filas.length?filas:[{Información:'Sin datos registrados'}]);
  if(ws['!ref'])ws['!autofilter']={ref:ws['!ref']};
  const encabezados=Object.keys(filas[0]||{Información:''});
  ws['!cols']=encabezados.map(k=>({wch:Math.min(55,Math.max(14,k.length+2,...filas.slice(0,100).map(r=>Math.min(55,String(r[k]??'').length+2))))}));
  X.utils.book_append_sheet(wb,ws,nombre);
 }
 const fecha=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Santiago',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 X.writeFile(wb,`Coordinadores_activos_${datos.ano}_${fecha}.xlsx`,{bookType:'xlsx',compression:true});
 return datos.total;
}
