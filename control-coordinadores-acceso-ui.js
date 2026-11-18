// Login dentro del enlace de firma: no navega a index.html ni altera el token.
export function accesoFirma(h,abrir){
 const {auth,onAuthStateChanged,signInWithEmailAndPassword,signOut,state,node,text,button}=h;
 const hash=location.hash;if(!/^#firmar-(?:guia=[a-f0-9]{32,64}|contrato=[a-f0-9]{48}|manual=[a-f0-9]{48})$/.test(hash))throw new Error('Enlace de firma inválido.');
 sessionStorage.setItem('rt-enlace-firma',location.pathname+location.search+hash);
 let generation=0;
 onAuthStateChanged(auth,async user=>{const n=++generation;state.user=user;
  if(!user){const main=node('main',{class:'wrap'}),panel=node('section',{class:'panel login'}),f=node('form'),email=node('input',{type:'email',value:'coordinador@raitrai.cl',autocomplete:'username',required:true}),pw=node('input',{type:'password',autocomplete:'current-password',required:true}),status=text('p','','notice'),save=node('button',{type:'submit',class:'btn primary',text:'Ingresar y abrir documento'});
   panel.append(text('h1','Firma de documentos'),text('p','Inicia sesión para revisar y firmar el documento que te enviaron.'));f.append(node('label',{class:'field'},'Correo',email),node('label',{class:'field'},'Contraseña',pw),save,status);panel.append(f);main.append(panel);document.body.replaceChildren(main);
   f.onsubmit=async ev=>{ev.preventDefault();save.disabled=true;status.textContent='Ingresando…';try{await signInWithEmailAndPassword(auth,email.value.trim(),pw.value);}catch{status.textContent='No se pudo ingresar. Revisa el correo y la contraseña.';save.disabled=false;}finally{pw.value='';}};return;
  }
  try{await abrir();if(n!==generation)return;const bar=node('div',{class:'wrap'},text('p','Sesión: '+user.email,'mini'),button('Salir de la sesión',()=>signOut(auth)));document.body.append(bar);}catch(e){document.body.replaceChildren(node('main',{class:'wrap'},text('p',e.message,'notice error'),button('Volver a ingresar',()=>signOut(auth))));}
 });
}
