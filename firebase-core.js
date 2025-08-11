// firebase-core.js  (SIN autenticación)
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-app.js';
import { getFirestore }  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const firebaseConfig = {
  // … Pega aquí tu config de Firebase …
};

export const app = initializeApp(firebaseConfig);
export const db  = getFirestore(app);
