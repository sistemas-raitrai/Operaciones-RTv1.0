// 📦 Importaciones necesarias
import { google } from 'googleapis';

// ✅ Autenticación con Google (usa variables de entorno)
const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const SHEET_ID = '124rwvhKhVLDnGuGHB1IGIm1-KrtWXencFqr8SfnbhRI';
const HOJA = 'LecturaBaseOperaciones';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Método no permitido' });
  }

  try {
    const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
    const { numeroNegocio, ...datos } = req.body;

    if (!numeroNegocio) {
      return res.status(400).json({ ok: false, error: 'Falta número de negocio' });
    }

    // 1️⃣ Leer todas las filas para encontrar el índice
    const respuesta = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: HOJA,
    });

    const valores = respuesta.data.values || [];
    const encabezados = valores[0];
    const filas = valores.slice(1);

    const colNumero = encabezados.indexOf('numeroNegocio');
    if (colNumero === -1) throw new Error('Columna numeroNegocio no encontrada');

    const filaIndex = filas.findIndex(f => String(f[colNumero]).trim() === String(numeroNegocio).trim());
    if (filaIndex === -1) {
      return res.status(404).json({ ok: false, error: 'Número de negocio no encontrado' });
    }

    const filaReal = filaIndex + 2; // +2 porque indexado desde 1 y saltamos encabezado

    // 2️⃣ Determinar columnas desde la Q en adelante (Q = índice 16)
    const inicioCol = 16; // columna Q es la 17, índice 16
    const columnasObjetivo = encabezados.slice(inicioCol);

    // 3️⃣ Crear arreglo con los nuevos valores en la misma posición
    const filaNueva = columnasObjetivo.map(col => datos[col] ?? '');

    // 4️⃣ Escribir los datos nuevos en la fila exacta
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${HOJA}!Q${filaReal}:${columnToLetter(inicioCol + filaNueva.length)}${filaReal}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [filaNueva],
      },
    });

    return res.status(200).json({ ok: true, message: 'Datos actualizados correctamente' });

  } catch (error) {
    console.error('❌ Error al guardar:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
}

// 🔠 Convertir índice de columna a letra (ej. 16 → Q)
function columnToLetter(colIndex) {
  let letter = '';
  while (colIndex >= 0) {
    letter = String.fromCharCode((colIndex % 26) + 65) + letter;
    colIndex = Math.floor(colIndex / 26) - 1;
  }
  return letter;
}
