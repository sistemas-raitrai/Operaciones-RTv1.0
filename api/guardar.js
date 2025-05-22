export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const { datos, historial } = req.body;

  const accessToken = process.env.GRAPH_TOKEN; // 🔒 Token seguro desde Vercel
  const workbookId = 'ID_DEL_ARCHIVO'; // ⬅️ Reemplazar con el ID real
  const baseTable = 'BaseOperaciones';
  const historialTable = 'HistorialCambios';

  try {
    // Guardar en BaseOperaciones
    await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${workbookId}/workbook/tables/${baseTable}/rows/add`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        values: [[
          datos.numeroNegocio, datos.nombreGrupo, datos.cantidadgrupo, datos.colegio, datos.curso, datos.anoViaje,
          datos.destino, datos.programa, datos.hotel, datos.asistenciaEnViajes, datos.autorizacion,
          datos.fechaDeViaje, datos.observaciones, datos.versionFicha,
          datos.creadoPor, datos.fechaCreacion
        ]]
      })
    });

    // Guardar en HistorialCambios
    for (const cambio of historial) {
      await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${workbookId}/workbook/tables/${historialTable}/rows/add`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          values: [[
            datos.numeroNegocio, datos.nombreGrupo, datos.anoViaje,
            cambio.campo, cambio.anterior, cambio.nuevo,
            datos.modificadoPor, new Date().toISOString()
          ]]
        })
      });
    }

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error("❌ Error al guardar en Excel:", error);
    return res.status(500).json({ error: 'Error al guardar en Excel' });
  }
}
