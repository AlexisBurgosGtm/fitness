// db.js - Módulo de conexión y gestión de MySQL para AuraCal
require('dotenv').config();
const mysql = require('mysql2/promise');

// Crear pool de conexiones (más eficiente que una conexión única)
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  database: process.env.DB_DATABASE,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  multipleStatements: false
});

/**
 * Inicializa la base de datos: verifica la conexión y crea las tablas
 * necesarias si no existen.
 */
async function initDatabase() {
  const conn = await pool.getConnection();
  try {
    console.log('🔌 Conectado a MySQL: ' + process.env.DB_HOST);

    // Tabla principal: registro de alimentos consumidos
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS comidas (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        comida      ENUM('DESAYUNO','ALMUERZO','CENA','MERIENDA') NOT NULL,
        fecha       DATE NOT NULL,
        alimento    VARCHAR(255) NOT NULL,
        calorias    INT NOT NULL DEFAULT 0,
        porcion     VARCHAR(100) DEFAULT '1 porción',
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_fecha (fecha),
        INDEX idx_comida (comida)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    console.log('✅ Tablas MySQL verificadas/creadas correctamente.');
  } finally {
    conn.release();
  }
}

// ─── CRUD de Comidas ────────────────────────────────────────────────────────

/**
 * Insertar un registro de alimento.
 * @param {{ comida, fecha, alimento, calorias, porcion }} item
 * @returns {Promise<number>} ID del registro insertado
 */
async function addFood(item) {
  const [result] = await pool.execute(
    'INSERT INTO comidas (comida, fecha, alimento, calorias, porcion) VALUES (?, ?, ?, ?, ?)',
    [item.comida, item.fecha, item.alimento, item.calorias, item.porcion || '1 porción']
  );
  return result.insertId;
}

/**
 * Obtener todos los registros de una fecha específica (YYYY-MM-DD).
 * @param {string} fecha
 * @returns {Promise<Array>}
 */
async function getFoodByDate(fecha) {
  const [rows] = await pool.execute(
    'SELECT * FROM comidas WHERE fecha = ? ORDER BY comida, id ASC',
    [fecha]
  );
  return rows;
}

/**
 * Obtener todos los registros, con filtros opcionales.
 * @param {{ comida?: string, fecha?: string }} filters
 * @returns {Promise<Array>}
 */
async function getAllFood(filters = {}) {
  let query = 'SELECT * FROM comidas WHERE 1=1';
  const params = [];

  if (filters.comida && filters.comida !== 'TODOS') {
    query += ' AND comida = ?';
    params.push(filters.comida);
  }

  if (filters.fecha) {
    query += ' AND fecha = ?';
    params.push(filters.fecha);
  }

  query += ' ORDER BY fecha DESC, id DESC';

  const [rows] = await pool.execute(query, params);
  return rows;
}

/**
 * Eliminar un registro por ID.
 * @param {number} id
 */
async function deleteFood(id) {
  await pool.execute('DELETE FROM comidas WHERE id = ?', [id]);
}

/**
 * Eliminar todos los registros de la tabla.
 */
async function clearAll() {
  await pool.execute('DELETE FROM comidas');
}

/**
 * Obtener suma de calorías agrupada por los últimos N días (para gráfico semanal).
 * @param {string[]} dates - Array de fechas en formato YYYY-MM-DD
 * @returns {Promise<Object>} Mapa de fecha -> total kcal
 */
async function getCaloriesSummaryByDates(dates) {
  if (!dates || dates.length === 0) return {};

  const placeholders = dates.map(() => '?').join(', ');
  const [rows] = await pool.execute(
    `SELECT fecha, SUM(calorias) AS total FROM comidas WHERE fecha IN (${placeholders}) GROUP BY fecha`,
    dates
  );

  // Convertir a mapa para acceso rápido
  const map = {};
  rows.forEach(row => {
    // Normalizar fecha a string YYYY-MM-DD (viene como Date object de mysql2)
    const dateStr = typeof row.fecha === 'string'
      ? row.fecha
      : row.fecha.toISOString().split('T')[0];
    map[dateStr] = Number(row.total);
  });
  return map;
}

/**
 * Obtener estadísticas generales (total de registros y días únicos activos).
 * @returns {Promise<{ totalLogs: number, activeDays: number }>}
 */
async function getStats() {
  const [[countRow]] = await pool.execute('SELECT COUNT(*) AS total FROM comidas');
  const [[daysRow]] = await pool.execute('SELECT COUNT(DISTINCT fecha) AS dias FROM comidas');
  return {
    totalLogs: Number(countRow.total),
    activeDays: Number(daysRow.dias)
  };
}

module.exports = {
  pool,
  initDatabase,
  addFood,
  getFoodByDate,
  getAllFood,
  deleteFood,
  clearAll,
  getCaloriesSummaryByDates,
  getStats
};
