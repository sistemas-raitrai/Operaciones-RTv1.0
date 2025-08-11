// firebase-core.js  (SIN autenticación)
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-app.js';
import { getFirestore }  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const firebaseConfig = {
  // ⬇️ COPIA TU CONFIG DESDE: Firebase Console → Project settings → Your apps → Web app (CDN)
  apiKey: "…",
  authDomain: "…",
  projectId: "…",        // <- ESTE CAMPO ES EL QUE FALTA SEGÚN TU ERROR
  storageBucket: "…",
  messagingSenderId: "…",
  appId: "…"
};

export const app = initializeApp(firebaseConfig);
export const db  = getFirestore(app);

// (opcional para debug)
console.log('Firebase projectId:', app.options?.projectId);
