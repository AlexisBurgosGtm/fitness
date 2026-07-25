const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('./db');

// Cargar variables de entorno
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3012;

// Middleware
app.use(cors());
app.use(express.json());

// Servir archivos estáticos del frontend desde la carpeta 'public'
app.use(express.static(path.join(__dirname, 'public')));

// Inicializar la API de Gemini si está configurada
let genAI = null;
const apiKey = process.env.GEMINI_API_KEY;

if (apiKey && apiKey !== 'tu_api_key_aqui' && apiKey.trim() !== '') {
  try {
    genAI = new GoogleGenerativeAI(apiKey);
    console.log('✅ Conexión con Gemini API inicializada.');
  } catch (error) {
    console.error('❌ Error al inicializar Gemini API:', error.message);
  }
} else {
  console.warn('⚠️ GEMINI_API_KEY no configurada. Se usará el generador simulado (Mock).');
}

// ─── ENDPOINTS: GEMINI / NUTRITION ──────────────────────────────────────────

// Modelos Gemini permitidos en la app
const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash';
const GEMINI_MODELS = [
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash (recomendado)' },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite' },
  { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' }
];

function resolveGeminiModel(requested) {
  const allowed = new Set(GEMINI_MODELS.map(m => m.id));
  if (requested && allowed.has(requested)) return requested;
  return DEFAULT_GEMINI_MODEL;
}

const NUTRITION_SYSTEM_PROMPT = `Eres un experto en nutrición y dietética. Tu tarea es analizar la consulta del usuario sobre alimentos consumidos y devolver un listado detallado en formato JSON estructurado.
Debes identificar cada alimento o plato mencionado, estimar su tamaño de porción estándar (o la porción especificada por el usuario), estimar su contenido calórico en kilocalorías (kcal), y estimar proteínas y carbohidratos en gramos.

La respuesta DEBE ser estrictamente un arreglo de objetos JSON con el siguiente formato:
[
  {
    "alimento": "Nombre del alimento (ej. Manzana, Huevo frito, etc.)",
    "calorias": 120,
    "proteina": 5.2,
    "carbohidratos": 18.0,
    "porcion": "1 unidad mediana, 100g, 1 taza, etc."
  }
]
No agregues texto introductorio ni explicaciones. Responde únicamente el arreglo JSON.`;

// POST /api/nutrition — Consultar calorías y macros de alimentos vía Gemini
app.post('/api/nutrition', async (req, res) => {
  const { query, model: requestedModel } = req.body;

  if (!query || query.trim() === '') {
    return res.status(400).json({ error: 'La consulta no puede estar vacía.' });
  }

  let modelName = resolveGeminiModel(requestedModel);
  try {
    const savedModel = await db.getConfig('gemini_model');
    if (!requestedModel && savedModel) modelName = resolveGeminiModel(savedModel);
  } catch (_) { /* usa default */ }

  if (!genAI) {
    console.log(`[MOCK] Procesando consulta con modelo ${modelName}: "${query}"`);
    return res.json({
      data: generateMockNutrition(query),
      isMock: true,
      model: modelName,
      message: 'Mostrando datos simulados. Configura tu GEMINI_API_KEY en .env para usar IA real.'
    });
  }

  try {
    const model = genAI.getGenerativeModel({
      model: modelName,
      systemInstruction: NUTRITION_SYSTEM_PROMPT,
      generationConfig: { responseMimeType: 'application/json' }
    });

    const response = await model.generateContent(query);
    const responseText = response.response.text();
    console.log(`Gemini (${modelName}) raw response:`, responseText);

    const parsedData = JSON.parse(responseText);
    const normalized = (Array.isArray(parsedData) ? parsedData : []).map(item => ({
      alimento: item.alimento || 'Alimento',
      calorias: Number(item.calorias || 0),
      proteina: Number(item.proteina || item.proteinas || 0),
      carbohidratos: Number(item.carbohidratos || item.carbs || 0),
      porcion: item.porcion || '1 porción'
    }));

    res.json({ data: normalized, isMock: false, model: modelName });

  } catch (error) {
    console.error('❌ Error al consultar Gemini API:', error);
    res.status(500).json({
      error: 'Error al consultar el servicio de Inteligencia Artificial.',
      details: error.message || 'Gemini no pudo procesar la consulta.',
      model: modelName
    });
  }
});

// GET /api/gemini-models — Lista de modelos disponibles
app.get('/api/gemini-models', (req, res) => {
  res.json({ data: GEMINI_MODELS, default: DEFAULT_GEMINI_MODEL });
});

// GET /api/config — Configuración actual
app.get('/api/config', async (req, res) => {
  try {
    const config = await db.getAllConfig();
    res.json({
      data: {
        gemini_model: resolveGeminiModel(config.gemini_model || DEFAULT_GEMINI_MODEL)
      }
    });
  } catch (error) {
    console.error('❌ Error obteniendo configuración:', error);
    res.status(500).json({ error: 'Error al obtener la configuración.', details: error.message });
  }
});

// PUT /api/config — Actualizar configuración
app.put('/api/config', async (req, res) => {
  try {
    const { gemini_model } = req.body || {};
    if (gemini_model) {
      const model = resolveGeminiModel(gemini_model);
      if (gemini_model !== model) {
        return res.status(400).json({ error: 'Modelo de Gemini no permitido.' });
      }
      await db.setConfig('gemini_model', model);
    }
    const config = await db.getAllConfig();
    res.json({
      success: true,
      data: {
        gemini_model: resolveGeminiModel(config.gemini_model || DEFAULT_GEMINI_MODEL)
      }
    });
  } catch (error) {
    console.error('❌ Error guardando configuración:', error);
    res.status(500).json({ error: 'Error al guardar la configuración.', details: error.message });
  }
});

// ─── ENDPOINTS: COMIDAS / MYSQL ──────────────────────────────────────────────

// POST /api/comidas — Insertar uno o más alimentos
app.post('/api/comidas', async (req, res) => {
  const { comida, fecha, items } = req.body;

  if (!comida || !fecha || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Datos incompletos. Se requiere: comida, fecha y al menos un alimento en items[].' });
  }

  try {
    const insertedIds = [];
    for (const item of items) {
      const id = await db.addFood({
        comida,
        fecha,
        alimento: item.alimento,
        calorias: Number(item.calorias || 0),
        porcion: item.porcion || '1 porción',
        proteina: Number(item.proteina || 0),
        carbohidratos: Number(item.carbohidratos || 0)
      });
      insertedIds.push(id);
    }
    res.status(201).json({ success: true, insertedCount: insertedIds.length, ids: insertedIds });
  } catch (error) {
    console.error('❌ Error insertando comidas:', error);
    res.status(500).json({ error: 'Error al guardar los alimentos en la base de datos.', details: error.message });
  }
});

// GET /api/comidas?fecha=YYYY-MM-DD — Obtener alimentos de una fecha
app.get('/api/comidas', async (req, res) => {
  const { fecha, comida } = req.query;
  try {
    let items;
    if (fecha && !comida) {
      items = await db.getFoodByDate(fecha);
    } else {
      items = await db.getAllFood({ comida, fecha });
    }
    // Normalizar campo fecha a string YYYY-MM-DD
    items = items.map(item => ({
      ...item,
      fecha: typeof item.fecha === 'string'
        ? item.fecha
        : item.fecha.toISOString().split('T')[0]
    }));
    res.json({ data: items });
  } catch (error) {
    console.error('❌ Error obteniendo comidas:', error);
    res.status(500).json({ error: 'Error al obtener los registros.', details: error.message });
  }
});

// DELETE /api/comidas/:id — Eliminar un alimento por ID
app.delete('/api/comidas/:id', async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: 'ID inválido.' });
  }
  try {
    await db.deleteFood(Number(id));
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Error eliminando comida:', error);
    res.status(500).json({ error: 'Error al eliminar el registro.', details: error.message });
  }
});

// DELETE /api/comidas — Eliminar todos los registros
app.delete('/api/comidas', async (req, res) => {
  try {
    await db.clearAll();
    res.json({ success: true, message: 'Historial completo eliminado.' });
  } catch (error) {
    console.error('❌ Error limpiando historial:', error);
    res.status(500).json({ error: 'Error al limpiar el historial.', details: error.message });
  }
});

// GET /api/stats — Estadísticas generales (total registros y días activos)
app.get('/api/stats', async (req, res) => {
  try {
    const stats = await db.getStats();
    res.json(stats);
  } catch (error) {
    console.error('❌ Error obteniendo estadísticas:', error);
    res.status(500).json({ error: 'Error al obtener estadísticas.', details: error.message });
  }
});

// POST /api/medidas — Guardar una medida corporal manualmente
app.post('/api/medidas', async (req, res) => {
  const { fecha, item, valor } = req.body;

  if (!fecha || !item || valor === undefined || valor === null || isNaN(Number(valor))) {
    return res.status(400).json({ error: 'Se requiere fecha, item y valor numérico.' });
  }

  try {
    const id = await db.addMeasurement({ fecha, item, valor: Number(valor) });
    res.status(201).json({ success: true, id });
  } catch (error) {
    console.error('❌ Error guardando medida:', error);
    res.status(500).json({ error: 'Error al guardar la medida.', details: error.message });
  }
});

// GET /api/medidas — Obtener todas las medidas registradas
app.get('/api/medidas', async (req, res) => {
  try {
    const medidas = await db.getMeasurements();
    res.json({ data: medidas });
  } catch (error) {
    console.error('❌ Error obteniendo medidas:', error);
    res.status(500).json({ error: 'Error al obtener las medidas.', details: error.message });
  }
});

// DELETE /api/medidas/:id — Eliminar una medida específica
app.delete('/api/medidas/:id', async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: 'ID inválido.' });
  }

  try {
    await db.deleteMeasurement(Number(id));
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Error eliminando medida:', error);
    res.status(500).json({ error: 'Error al eliminar la medida.', details: error.message });
  }
});

// GET /api/weekly?dates=2026-07-01,2026-07-02,... — Suma de calorías por fechas (para el gráfico)
app.get('/api/weekly', async (req, res) => {
  const { dates } = req.query;
  if (!dates) {
    return res.status(400).json({ error: 'Parámetro "dates" requerido (fechas separadas por coma).' });
  }
  try {
    const dateArray = dates.split(',').map(d => d.trim()).filter(Boolean);
    const summary = await db.getCaloriesSummaryByDates(dateArray);
    res.json({ data: summary });
  } catch (error) {
    console.error('❌ Error obteniendo resumen semanal:', error);
    res.status(500).json({ error: 'Error al obtener el resumen semanal.', details: error.message });
  }
});

// ─── ENDPOINTS: CONSULTAS GEMINI (RECUPERACIÓN) ──────────────────────────────

// POST /api/gemini-queries — Guardar una consulta pendiente a Gemini
app.post('/api/gemini-queries', async (req, res) => {
  const { query_text, gemini_response, status, error_message } = req.body;

  if (!query_text || query_text.trim() === '') {
    return res.status(400).json({ error: 'El texto de consulta no puede estar vacío.' });
  }

  try {
    const queryId = await db.saveGeminiQuery({
      query_text,
      gemini_response,
      status: status || 'pendiente',
      error_message
    });
    res.status(201).json({ success: true, id: queryId, message: 'Consulta guardada para recuperación posterior.' });
  } catch (error) {
    console.error('❌ Error guardando consulta Gemini:', error);
    res.status(500).json({ error: 'Error al guardar la consulta.', details: error.message });
  }
});

// GET /api/gemini-queries/pending — Obtener todas las consultas pendientes
app.get('/api/gemini-queries/pending', async (req, res) => {
  try {
    const queries = await db.getPendingGeminiQueries();
    res.json({ data: queries });
  } catch (error) {
    console.error('❌ Error obteniendo consultas pendientes:', error);
    res.status(500).json({ error: 'Error al obtener consultas pendientes.', details: error.message });
  }
});

// GET /api/gemini-queries/status/:status — Obtener consultas por estado
app.get('/api/gemini-queries/status/:status', async (req, res) => {
  const { status } = req.params;
  const validStatuses = ['pendiente', 'completado', 'error'];

  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Estado inválido. Debe ser: pendiente, completado o error.' });
  }

  try {
    const queries = await db.getGeminiQueriesByStatus(status);
    res.json({ data: queries });
  } catch (error) {
    console.error('❌ Error obteniendo consultas por estado:', error);
    res.status(500).json({ error: 'Error al obtener las consultas.', details: error.message });
  }
});

// GET /api/gemini-queries/:id — Obtener una consulta específica
app.get('/api/gemini-queries/:id', async (req, res) => {
  const { id } = req.params;

  if (!id || isNaN(id)) {
    return res.status(400).json({ error: 'ID inválido.' });
  }

  try {
    const query = await db.getGeminiQuery(Number(id));
    if (!query) {
      return res.status(404).json({ error: 'Consulta no encontrada.' });
    }
    res.json({ data: query });
  } catch (error) {
    console.error('❌ Error obteniendo consulta:', error);
    res.status(500).json({ error: 'Error al obtener la consulta.', details: error.message });
  }
});

// PUT /api/gemini-queries/:id — Actualizar una consulta (marcar como completada, agregar respuesta, etc.)
app.put('/api/gemini-queries/:id', async (req, res) => {
  const { id } = req.params;
  const { status, gemini_response, error_message } = req.body;

  if (!id || isNaN(id)) {
    return res.status(400).json({ error: 'ID inválido.' });
  }

  try {
    await db.updateGeminiQuery(Number(id), { status, gemini_response, error_message });
    res.json({ success: true, message: 'Consulta actualizada.' });
  } catch (error) {
    console.error('❌ Error actualizando consulta:', error);
    res.status(500).json({ error: 'Error al actualizar la consulta.', details: error.message });
  }
});

// DELETE /api/gemini-queries/:id — Eliminar una consulta específica
app.delete('/api/gemini-queries/:id', async (req, res) => {
  const { id } = req.params;

  if (!id || isNaN(id)) {
    return res.status(400).json({ error: 'ID inválido.' });
  }

  try {
    await db.deleteGeminiQuery(Number(id));
    res.json({ success: true, message: 'Consulta eliminada.' });
  } catch (error) {
    console.error('❌ Error eliminando consulta:', error);
    res.status(500).json({ error: 'Error al eliminar la consulta.', details: error.message });
  }
});

// DELETE /api/gemini-queries/completed/all — Limpiar todas las consultas completadas
app.delete('/api/gemini-queries/completed/all', async (req, res) => {
  try {
    await db.clearCompletedGeminiQueries();
    res.json({ success: true, message: 'Consultas completadas eliminadas.' });
  } catch (error) {
    console.error('❌ Error limpiando consultas completadas:', error);
    res.status(500).json({ error: 'Error al limpiar consultas.', details: error.message });
  }
});

// ─── MOCK FALLBACK ────────────────────────────────────────────────────────────

function generateMockNutrition(query) {
  const queryLower = query.toLowerCase();
  const results = [];
  const dictionary = [
    { keywords: ['huevo', 'huevos'], alimento: 'Huevo entero', calorias: 70, proteina: 6.3, carbohidratos: 0.4, porcion: '1 unidad' },
    { keywords: ['pan', 'tostada', 'tostadas'], alimento: 'Pan integral tostado', calorias: 80, proteina: 3.5, carbohidratos: 14, porcion: '1 rebanada' },
    { keywords: ['café', 'cafe'], alimento: 'Café negro sin azúcar', calorias: 2, proteina: 0.1, carbohidratos: 0, porcion: '1 taza (200ml)' },
    { keywords: ['leche'], alimento: 'Leche entera', calorias: 120, proteina: 6.4, carbohidratos: 9.5, porcion: '1 vaso (200ml)' },
    { keywords: ['manzana', 'manzanas'], alimento: 'Manzana roja', calorias: 95, proteina: 0.5, carbohidratos: 25, porcion: '1 unidad mediana' },
    { keywords: ['platano', 'plátano', 'banano'], alimento: 'Plátano', calorias: 105, proteina: 1.3, carbohidratos: 27, porcion: '1 unidad mediana' },
    { keywords: ['arroz'], alimento: 'Arroz blanco cocido', calorias: 130, proteina: 2.7, carbohidratos: 28, porcion: '100g' },
    { keywords: ['pollo', 'pechuga'], alimento: 'Pechuga de pollo a la plancha', calorias: 165, proteina: 31, carbohidratos: 0, porcion: '100g' },
    { keywords: ['aguacate', 'palta'], alimento: 'Aguacate', calorias: 160, proteina: 2, carbohidratos: 8.5, porcion: '100g' },
    { keywords: ['ensalada'], alimento: 'Ensalada mixta', calorias: 45, proteina: 2, carbohidratos: 7, porcion: '1 plato' },
    { keywords: ['carne', 'bife', 'filete'], alimento: 'Filete de ternera a la plancha', calorias: 200, proteina: 26, carbohidratos: 0, porcion: '100g' },
    { keywords: ['avena'], alimento: 'Avena en hojuelas', calorias: 150, proteina: 5.5, carbohidratos: 27, porcion: '40g' },
    { keywords: ['yogur', 'yogurt'], alimento: 'Yogur natural sin azúcar', calorias: 60, proteina: 5, carbohidratos: 6, porcion: '1 vaso (125g)' }
  ];

  let matched = false;
  dictionary.forEach(item => {
    if (item.keywords.some(k => queryLower.includes(k))) {
      results.push({
        alimento: item.alimento,
        calorias: item.calorias,
        proteina: item.proteina,
        carbohidratos: item.carbohidratos,
        porcion: item.porcion
      });
      matched = true;
    }
  });

  if (!matched) {
    query.split(/,| y /).forEach(segment => {
      const name = segment.trim();
      if (name.length > 2) {
        const hash = name.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
        results.push({
          alimento: name.charAt(0).toUpperCase() + name.slice(1),
          calorias: 50 + (hash % 250),
          proteina: 2 + (hash % 20),
          carbohidratos: 5 + (hash % 30),
          porcion: '1 porción estimada'
        });
      }
    });
  }

  if (results.length === 0) {
    results.push({ alimento: query, calorias: 150, proteina: 8, carbohidratos: 15, porcion: '1 porción' });
  }

  return results;
}

// ─── ARRANQUE DEL SERVIDOR ───────────────────────────────────────────────────

async function startServer() {
  try {
    await db.initDatabase();
    app.listen(PORT, () => {
      console.log(`🚀 Servidor AuraCal escuchando en http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('❌ Error fatal al inicializar la base de datos MySQL:', error.message);
    console.error('   Verifica las credenciales en el archivo .env (DB_HOST, DB_DATABASE, DB_USER, DB_PASS)');
    process.exit(1);
  }
}

startServer();
