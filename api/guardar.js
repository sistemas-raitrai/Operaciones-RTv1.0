// ✅ Archivo API para guardar datos en Excel Online (Microsoft 365) desde Vercel

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end(); // 🔁 Maneja el preflight
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const token = process.env.GRAPH_TOKEN; // 🔐 Agrega este token en Vercel (Settings > Environment Variables)
  const workbookId = '38e4db77-4608-4481-96d1-712a199e4156';
  const endpointBase = `https://graph.microsoft.com/v1.0/me/drive/items/${workbookId}/workbook/worksheets`;

  const { datos, historial } = req.body;

  if (!datos || !historial) {
    return res.status(400).json({ error: 'Datos incompletos.' });
  }

  try {
    // ✅ 1. Insertar o actualizar fila en la hoja BaseOperaciones
    const insertData = [
      datos.numeroNegocio,
      datos.nombreGrupo,
      datos.cantidadgrupo,
      datos.colegio,
      datos.curso,
      datos.anoViaje,
      datos.destino,
      datos.programa,
      datos.hotel,
      datos.asistenciaEnViajes,
      datos.autorizacion,
      datos.fechaDeViaje,
      datos.observaciones,
      datos.versionFicha,
      datos.creadoPor,
      datos.fechaCreacion
    ];

    await fetch(`${endpointBase}/BaseOperaciones/tables/BaseOperaciones/rows/add`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        values: [insertData]
      })
    });

    // ✅ 2. Insertar cada cambio en la hoja HistorialCambios
    const historialData = historial.map(change => [
      datos.numeroNegocio,
      datos.nombreGrupo,
      datos.anoViaje,
      change.campo,
      change.anterior,
      change.nuevo,
      datos.modificadoPor,
      new Date().toISOString()
    ]);

    if (historialData.length > 0) {
      await fetch(`${endpointBase}/HistorialCambios/tables/HistorialCambios/rows/add`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          values: historialData
        })
      });
    }

    res.status(200).json({ message: 'Datos guardados correctamente en Excel Online.' });
  } catch (err) {
    console.error('❌ Error al guardar en Excel:', err);
    res.status(500).json({ error: 'Error interno al guardar en Excel.' });
  }
}
