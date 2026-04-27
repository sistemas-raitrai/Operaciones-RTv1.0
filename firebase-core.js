import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-app.js';
import { initializeFirestore } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

export const app = initializeApp(firebaseConfig);
export const db  = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });

console.log('projectId:', app.options?.projectId); // debe mostrar "sist-op-rt"
