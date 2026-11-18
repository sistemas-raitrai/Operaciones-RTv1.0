// Misma lógica en navegador y backend. Nunca modifica fechas ni transportes.
(function(root){
 const iso=x=>/^\d{4}-\d{2}-\d{2}$/.test(String(x||''))?String(x):'',hora=x=>/^([01]\d|2[0-3]):[0-5]\d$/.test(String(x||''))?String(x):'',norm=x=>String(x||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase(),daydiff=(a,b)=>Math.round((Date.parse(b+'T12:00:00Z')-Date.parse(a+'T12:00:00Z'))/86400000);
 function clasificarRegreso(g={}){
  const ts=(Array.isArray(g.transportes)?g.transportes:[]).filter(t=>t.sentido==='vuelta'&&!t.isTransfer&&/a[eé]reo|aereo/i.test(t.tipoTransporte||'aereo')&&/SANTIAGO|\bSCL\b/.test(norm(t.destino))).slice().sort((a,b)=>String(a.fechaLlegada||a.fechaSalida).localeCompare(String(b.fechaLlegada||b.fechaSalida))||String(a.llegada).localeCompare(String(b.llegada)));
  if(!ts.length)return {estado:'sin_datos',detectado:false,motivo:'Sin tramo aéreo de regreso a Santiago identificado.'};
  const t=ts.at(-1),salida=iso(t.fechaSalida),llegada=iso(t.fechaLlegada),h=hora(t.llegada);let f=llegada,inferida=t.fechaLlegadaInferida!==false;
  if(!f&&salida&&hora(t.salida)&&h&&h<t.salida){f=new Date(Date.parse(salida+'T12:00:00Z')+86400000).toISOString().slice(0,10);inferida=true;}
  const delta=salida&&f?daydiff(salida,f):null,detectado=delta!==null&&delta>0;
  const completo=!!salida&&!!f&&!!h,estado=!completo||inferida||delta<0||delta>1?'por_verificar':detectado?'medianoche':'normal';
  return {estado,detectado,fechaSalida:salida,fechaLlegada:f,horaLlegada:h,origen:String(t.origen||''),destino:String(t.destino||''),fuenteId:String(t.fuenteId||''),numero:String(t.numero||''),fechaInferida:inferida,finBasePropuesto:detectado?salida:iso(g.fechaFin),extraSugerido:detectado?20000:0,motivo:estado==='por_verificar'?'Confirmar fecha/hora de llegada y último día remunerado. No se modifica la planificación.':detectado?'Aterrizaje en Santiago al día siguiente: extra habitual, sin sumar un día base.':'Regreso sin cambio de fecha detectado.'};
 }
 const api=Object.freeze({clasificarRegreso});if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.RaiTraiRegresos=api;
})(globalThis);
