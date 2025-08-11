// firebase-core.js  (SIN autenticación)
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-app.js';
import {
  initializeFirestore,
  setLogLevel
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const firebaseConfig = {
  apiKey: "TU_API_KEY",
  authDomain: "TU_AUTH_DOMAIN",
  projectId: "TU_PROJECT_ID",
  storageBucket: "TU_BUCKET",
  messagingSenderId: "TU_SENDER_ID",
  appId: "TU_APP_ID"
};

export const app = initializeApp(firebaseConfig);

// Fuerza transporte compatible (evita 400 en algunos entornos)
export const db  = initializeFirestore(app, {
  experimentalAutoDetectLongPolling: true
});

// Útil para ver detalle si algo falla
setLogLevel('error');
console.log('Firebase projectId:', app?.options?.projectId);
