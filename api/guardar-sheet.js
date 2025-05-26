// pages/api/guardar-sheet.js

export default async function handler(req, res) {
  // ✅ Permitir CORS para desarrollo
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // ⚠️ Manejo de preflight
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido" });
  }

  const { datos, historial } = req.body;

  // 🔍 Validación mínima
  if (!datos || !datos.numeroNegocio) {
    return res.status(400).json({ error: "Faltan datos o número de negocio" });
  }

  try {
    const scriptURL = process.env.GOOGLE_SCRIPT_URL;
    if (!scriptURL) {
      console.error("❌ GOOGLE_SCRIPT_URL no está definido.");
      return res.status(500).json({ error: "No se configuró GOOGLE_SCRIPT_URL" });
    }

    const payload = JSON.stringify({ datos, historial });

    // 🧭 Medir cuánto tarda el fetch real a Apps Script
    console.time("⏱ Tiempo de envío a Apps Script");

    const response = await fetch(scriptURL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });

    console.timeEnd("⏱ Tiempo de envío a Apps Script");

    const texto = await response.text();
    console.log("📬 Respuesta Apps Script:", texto);

    if (texto.includes("OK")) {
      return res.status(200).json({ message: "✅ Datos guardados en Google Sheets" });
    } else {
      return res.status(500).json({ error: "Respuesta inesperada: " + texto });
    }

  } catch (error) {
    console.error("❌ Error al enviar a Apps Script:", error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
}
