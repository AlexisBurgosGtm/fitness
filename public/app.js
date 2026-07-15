/* ==========================================================================
   AuraCal - Lógica de Negocio, SPA y API REST MySQL (app.js)
   ========================================================================== */

// 1. CAPA DE ACCESO A DATOS — API REST (reemplaza IndexedDB)
const API = {
  BASE: '',

  async request(url, options = {}) {
    let res;
    try {
      res = await fetch(this.BASE + url, options);
    } catch (networkError) {
      const err = new Error('Sin conexión con el servidor. Comprueba que el backend esté disponible.');
      err.isNetworkError = true;
      err.cause = networkError;
      notifyBackendOffline(err.message);
      throw err;
    }

    let data = {};
    try {
      data = await res.json();
    } catch (_) {
      data = {};
    }

    if (!res.ok) {
      const message = data.details || data.error || `Error del servidor (${res.status})`;
      const err = new Error(message);
      err.status = res.status;
      err.payload = data;
      if (res.status === 503) {
        err.isNetworkError = true;
        notifyBackendOffline(message);
      }
      throw err;
    }

    notifyBackendOnline();
    return data;
  },

  post(url, body) {
    return this.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  },

  put(url, body) {
    return this.request(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  },

  get(url) {
    return this.request(url);
  },

  delete(url) {
    return this.request(url, { method: 'DELETE' });
  },

  // Gemini: consultar calorías de alimentos
  consultarNutricion(query) {
    return this.post('/api/nutrition', { query });
  },

  // Gemini: guardar consulta pendiente (recuperación ante fallos)
  guardarConsultaGemini(query_text, gemini_response = null, status = 'pendiente', error_message = null) {
    return this.post('/api/gemini-queries', { query_text, gemini_response, status, error_message });
  },

  // Gemini: obtener todas las consultas pendientes
  obtenerConsultasPendientes() {
    return this.get('/api/gemini-queries/pending');
  },

  // Gemini: obtener consultas por estado
  obtenerConsultasPorEstado(status) {
    return this.get(`/api/gemini-queries/status/${status}`);
  },

  // Gemini: obtener una consulta específica
  obtenerConsultaGemini(id) {
    return this.get(`/api/gemini-queries/${id}`);
  },

  // Gemini: actualizar una consulta (marcar como completada, etc.)
  actualizarConsultaGemini(id, status, gemini_response = null, error_message = null) {
    return this.put(`/api/gemini-queries/${id}`, { status, gemini_response, error_message });
  },

  // Gemini: eliminar una consulta
  eliminarConsultaGemini(id) {
    return this.delete(`/api/gemini-queries/${id}`);
  },

  // Guardar lista de alimentos en MySQL
  guardarComidas(comida, fecha, items) {
    return this.post('/api/comidas', { comida, fecha, items });
  },

  // Obtener alimentos por fecha
  getComidasByDate(fecha) {
    return this.get(`/api/comidas?fecha=${fecha}`);
  },

  // Obtener todos los alimentos con filtros opcionales
  getAllComidas(filters = {}) {
    const params = new URLSearchParams();
    if (filters.comida && filters.comida !== 'TODOS') params.set('comida', filters.comida);
    if (filters.fecha) params.set('fecha', filters.fecha);
    const qs = params.toString();
    return this.get(`/api/comidas${qs ? '?' + qs : ''}`);
  },

  // Eliminar un alimento
  deleteComida(id) {
    return this.delete(`/api/comidas/${id}`);
  },

  // Eliminar todo el historial
  clearAll() {
    return this.delete('/api/comidas');
  },

  // Estadísticas generales
  getStats() {
    return this.get('/api/stats');
  },

  // Resumen semanal para el gráfico
  getWeeklySummary(dates) {
    return this.get(`/api/weekly?dates=${dates.join(',')}`);
  },

  // Guardar medida corporal manualmente
  guardarMedida(fecha, item, valor) {
    return this.post('/api/medidas', { fecha, item, valor });
  },

  // Obtener medidas guardadas
  getMedidas() {
    return this.get('/api/medidas');
  },

  // Eliminar una medida
  deleteMedida(id) {
    return this.delete(`/api/medidas/${id}`);
  }
};

// 2. CONSTANTES Y CONFIGURACIÓN GLOBAL
let caloriesChart = null;
let measurementsChart = null;
let tempAnalysisResults = [];
let bootstrapTargetModal = null;
let bootstrapMaxModal = null;
let bootstrapMeasureModal = null;
let currentGeminiQueryId = null; // ID de la consulta Gemini actual
let manualFoodItems = [];
let isGeminiQueryInFlight = false;
let isSavingResults = false;
let isSavingManual = false;
let backendOnline = true;
let lastOfflineToastAt = 0;
let cachedMeasurements = [];
let measuresHistoryVisible = false;
let measuresActiveGroup = 'TODOS';

const MEASURE_TYPE_ORDER = [
  'ABDOMEN BAJO',
  'ABDOMEN ALTO',
  'PIERNA ALTA',
  'PIERNA BAJA',
  'TORSO',
  'BRAZO'
];

const MEASURE_GROUPS = {
  TODOS: MEASURE_TYPE_ORDER,
  ABDOMEN: ['ABDOMEN BAJO', 'ABDOMEN ALTO'],
  PIERNA: ['PIERNA ALTA', 'PIERNA BAJA'],
  BRAZO: ['BRAZO'],
  TORSO: ['TORSO']
};

function renderManualResultsTable() {
  const tbody = document.getElementById('manual-results-tbody');
  const totalBadge = document.getElementById('manual-total-temp');
  if (!tbody || !totalBadge) return;

  tbody.innerHTML = '';

  if (!manualFoodItems || manualFoodItems.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="text-center text-muted-custom py-4">Aún no agregaste alimentos manuales.</td></tr>';
    totalBadge.textContent = 'Total: 0 kcal';
    return;
  }

  let totalKcal = 0;
  manualFoodItems.forEach((item, index) => {
    const kcal = Math.round(Number(item.calorias || 0));
    totalKcal += kcal;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td data-label="Alimento" class="text-white">${item.alimento || ''}</td>
      <td data-label="Porción" class="text-muted-custom">${item.porcion || '1 porción'}</td>
      <td data-label="Calorías (kcal)" class="fw-semibold text-warning">${kcal} kcal</td>`;
    tbody.appendChild(tr);
  });

  totalBadge.textContent = `Total: ${totalKcal} kcal`;
}

// Obtener fecha actual en formato local YYYY-MM-DD
function getLocalDateString(date = new Date()) {
  const offset = date.getTimezoneOffset();
  const adjustedDate = new Date(date.getTime() - (offset * 60 * 1000));
  return adjustedDate.toISOString().split('T')[0];
}

function formatDateToDisplay(dateValue) {
  if (!dateValue) return '';

  const value = String(dateValue).trim();
  if (!value) return '';

  const datePart = value.includes('T') ? value.split('T')[0] : value;
  const parts = datePart.split('-');
  if (parts.length !== 3) return value;

  const [year, month, day] = parts;
  if (!year || !month || !day) return value;

  return `${day}/${month}/${year.slice(-2)}`;
}

// Ideal de calorías (guardado en localStorage, antes llamado "meta")
function getCalorieTarget() {
  return parseInt(localStorage.getItem('auraCalTarget') || '2000', 10);
}
function setCalorieTarget(value) {
  localStorage.setItem('auraCalTarget', value);
}

// Máximo diario de calorías (parallel a la meta/ideal)
function getCalorieMax() {
  return parseInt(localStorage.getItem('auraCalMax') || '2500', 10);
}
function setCalorieMax(value) {
  localStorage.setItem('auraCalMax', value);
}

function notifyBackendOffline(message) {
  const now = Date.now();
  if (backendOnline || now - lastOfflineToastAt > 8000) {
    lastOfflineToastAt = now;
    showAlert(message || 'Sin conexión con el servidor. Algunas funciones pueden no estar disponibles.', 'warning');
  }
  backendOnline = false;
}

function notifyBackendOnline() {
  if (!backendOnline) {
    backendOnline = true;
    showAlert('Conexión con el servidor restaurada.', 'success');
  }
}

async function checkBackendConnection() {
  try {
    await API.getStats();
    notifyBackendOnline();
    return true;
  } catch (error) {
    if (!error.isNetworkError) {
      notifyBackendOffline(error.message || 'No se pudo conectar con el servicio.');
    }
    return false;
  }
}

// 3. ALERTAS TOAST
function showAlert(message, type = 'info') {
  const alertContainer = document.getElementById('alert-container');
  const alertId = 'alert_' + Date.now();

  let icon = 'info';
  let alertClass = 'bg-dark text-white border-info';
  if (type === 'success') { icon = 'check-circle'; alertClass = 'bg-dark text-success border-success'; }
  else if (type === 'danger') { icon = 'alert-triangle'; alertClass = 'bg-dark text-danger border-danger'; }
  else if (type === 'warning') { icon = 'alert-circle'; alertClass = 'bg-dark text-warning border-warning'; }

  const alertHtml = `
    <div id="${alertId}" class="toast align-items-center ${alertClass} border-1 glass-card" role="alert" aria-live="assertive" aria-atomic="true" style="opacity:0; transition:opacity .3s ease;">
      <div class="d-flex">
        <div class="toast-body d-flex align-items-center">
          <i data-lucide="${icon}" class="me-2 fs-6"></i>
          <span>${message}</span>
        </div>
        <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>
      </div>
    </div>`;

  alertContainer.insertAdjacentHTML('beforeend', alertHtml);
  const element = document.getElementById(alertId);
  const toast = new bootstrap.Toast(element, { delay: 4000 });
  lucide.createIcons();
  element.style.opacity = '1';
  toast.show();
  element.addEventListener('hidden.bs.toast', () => element.remove());
}

// 4. SPA ROUTER
function openMenu() {
  document.getElementById('side-menu').classList.add('open');
  document.getElementById('menu-overlay').classList.add('active');
}

function closeMenu() {
  document.getElementById('side-menu').classList.remove('open');
  document.getElementById('menu-overlay').classList.remove('active');
}

function showView(viewId) {
  const views = document.querySelectorAll('.spa-view');
  const targetView = document.getElementById(`view-${viewId}`);
  const currentView = document.querySelector('.spa-view.active');
  if (!targetView || targetView === currentView) return;

  if (currentView) {
    currentView.classList.add('view-exit');
    currentView.addEventListener('transitionend', function cleanup() {
      currentView.classList.remove('active', 'view-exit');
      currentView.style.display = 'none';
      currentView.removeEventListener('transitionend', cleanup);
    }, { once: true });
  }

  targetView.style.display = 'block';
  targetView.classList.remove('view-exit');
  targetView.classList.add('view-enter');
  requestAnimationFrame(() => {
    targetView.classList.add('active');
    targetView.classList.remove('view-enter');
  });
}

function initRouter() {
  const navLinks = document.querySelectorAll('.navbar-nav .nav-link, .menu-link, #dash-lnk-add');

  function handleRoute(hash) {
    const targetId = hash || '#dashboard';
    const cleanId = targetId.substring(1);

    navLinks.forEach(link => {
      if (link.getAttribute('href') === targetId) link.classList.add('active');
      else link.classList.remove('active');
    });

    showView(cleanId);
    closeMenu();
    if (cleanId === 'dashboard') loadDashboard();
    else if (cleanId === 'historial') loadHistorial();
    else if (cleanId === 'medidas') loadMedidas();
    else if (cleanId === 'agregar') resetQueryForm();
    else if (cleanId === 'manual') {
      toggleManualFoodForm(true);
      const manualDate = document.getElementById('manual-date');
      if (manualDate && !manualDate.value) manualDate.value = getLocalDateString();
      document.getElementById('manual-food-name')?.focus();
    }
  }

  window.addEventListener('hashchange', () => handleRoute(window.location.hash));

  // Cada recarga abre el dashboard (sin conservar la vista previa)
  if (window.location.hash && window.location.hash !== '#dashboard') {
    history.replaceState(null, '', '#dashboard');
  }
  handleRoute('#dashboard');
}

function triggerViewLoad(viewId) {
  const fab = document.getElementById('fab-agregar');
  if (fab) fab.style.display = 'flex';

  if (viewId === 'dashboard') loadDashboard();
  else if (viewId === 'historial') loadHistorial();
  else if (viewId === 'medidas') loadMedidas();
  else if (viewId === 'agregar') resetQueryForm();
}

// 5. CONTROLADOR: DASHBOARD
async function loadDashboard() {
  const selectedDate = document.getElementById('dashboard-date').value;

  try {
    const target = getCalorieTarget();
    const maxCalories = getCalorieMax();
    document.getElementById('dash-calories-target-val').textContent = target;
    const maxEl = document.getElementById('dash-calories-max-val');
    if (maxEl) maxEl.textContent = maxCalories;

    // Obtener alimentos del día desde MySQL
    const result = await API.getComidasByDate(selectedDate);
    const items = result.data || [];

    let totalConsumed = 0, breakfastSum = 0, lunchSum = 0, dinnerSum = 0, snackSum = 0;
    items.forEach(item => {
      const kcal = Number(item.calorias || 0);
      totalConsumed += kcal;
      switch (item.comida) {
        case 'DESAYUNO':  breakfastSum += kcal; break;
        case 'ALMUERZO':  lunchSum += kcal;     break;
        case 'CENA':      dinnerSum += kcal;    break;
        case 'MERIENDA':  snackSum += kcal;     break;
      }
    });

    document.getElementById('dash-calories-consumed').innerHTML = `${totalConsumed} <span class="fs-6 fw-normal">kcal</span>`;
    document.getElementById('dash-meal-desayuno').textContent  = `${breakfastSum} kcal`;
    document.getElementById('dash-meal-almuerzo').textContent  = `${lunchSum} kcal`;
    document.getElementById('dash-meal-cena').textContent      = `${dinnerSum} kcal`;
    document.getElementById('dash-meal-merienda').textContent  = `${snackSum} kcal`;

    const progressPct = target > 0 ? Math.round((totalConsumed / target) * 100) : 0;
    const maxProgressPct = maxCalories > 0 ? Math.round((totalConsumed / maxCalories) * 100) : 0;
    const idealBarPct = Math.min(progressPct, 100);
    const maxBarPct = Math.min(maxProgressPct, 100);

    const idealPctEl = document.getElementById('dash-ideal-pct');
    if (idealPctEl) idealPctEl.textContent = `${progressPct}%`;
    const maxPctEl = document.getElementById('dash-max-pct');
    if (maxPctEl) maxPctEl.textContent = `${maxProgressPct}%`;

    updateDashboardProgressColor(progressPct, totalConsumed, target, maxCalories);

    const progressBar = document.getElementById('dash-progress-bar');
    progressBar.style.width = `${idealBarPct}%`;
    progressBar.setAttribute('aria-valuenow', idealBarPct);

    if (totalConsumed > target) {
      progressBar.classList.remove('bg-gradient-warning');
      progressBar.style.background = 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)';
      progressBar.style.boxShadow = '0 0 10px rgba(245, 158, 11, 0.35)';
    } else {
      progressBar.style.background = '';
      progressBar.style.boxShadow = '';
      progressBar.classList.add('bg-gradient-warning');
    }

    const progressBarMax = document.getElementById('dash-progress-bar-max');
    if (progressBarMax) {
      progressBarMax.style.width = `${maxBarPct}%`;
      progressBarMax.setAttribute('aria-valuenow', maxBarPct);

      if (totalConsumed > maxCalories) {
        progressBarMax.classList.remove('bg-gradient-max');
        progressBarMax.style.background = 'linear-gradient(135deg, #ef4444 0%, #b91c1c 100%)';
        progressBarMax.style.boxShadow = '0 0 10px rgba(239, 68, 68, 0.4)';
      } else {
        progressBarMax.style.background = '';
        progressBarMax.style.boxShadow = '';
        progressBarMax.classList.add('bg-gradient-max');
      }
    }

    const remainingIdeal = Math.max(target - totalConsumed, 0);
    const remainingMax = Math.max(maxCalories - totalConsumed, 0);
    if (totalConsumed > maxCalories) {
      document.getElementById('dash-remaining-calories').textContent =
        `Has superado el máximo por ${totalConsumed - maxCalories} kcal.`;
    } else if (totalConsumed > target) {
      document.getElementById('dash-remaining-calories').textContent =
        `Ideal alcanzado. Quedan ${remainingMax} kcal hasta el máximo.`;
    } else {
      document.getElementById('dash-remaining-calories').textContent =
        `Faltan ${remainingIdeal} kcal para el ideal.`;
    }

    renderTodayLogsList(items);
    await updateWeeklyChart();

  } catch (error) {
    console.error('Error cargando dashboard:', error);
    showAlert('Error al obtener datos del servidor. Comprueba la conexión.', 'danger');
  }
}

// Renderizar la lista de consumos del día
function updateDashboardProgressColor(progressPct, totalConsumed = 0, target = 0, maxCalories = 0) {
  const percentageLabel = document.getElementById('dash-percentage-val');
  const largeLabel = document.getElementById('dash-progress-large');
  if (!largeLabel) return;

  if (percentageLabel) {
    percentageLabel.classList.remove('text-success', 'text-warning', 'text-danger');
  }
  largeLabel.classList.remove('text-success', 'text-warning', 'text-danger');
  largeLabel.style.color = '';

  if (maxCalories > 0 && totalConsumed > maxCalories) {
    largeLabel.classList.add('text-danger');
    if (percentageLabel) percentageLabel.classList.add('text-danger');
    largeLabel.style.color = '#ef4444';
  } else if (target > 0 && totalConsumed > target) {
    largeLabel.classList.add('text-warning');
    if (percentageLabel) percentageLabel.classList.add('text-warning');
    largeLabel.style.color = '#f59e0b';
  } else if (progressPct > 90) {
    largeLabel.classList.add('text-danger');
    if (percentageLabel) percentageLabel.classList.add('text-danger');
    largeLabel.style.color = '#ef4444';
  } else if (progressPct > 80) {
    largeLabel.classList.add('text-warning');
    if (percentageLabel) percentageLabel.classList.add('text-warning');
    largeLabel.style.color = '#f59e0b';
  } else {
    largeLabel.classList.add('text-success');
    if (percentageLabel) percentageLabel.classList.add('text-success');
    largeLabel.style.color = '#22c55e';
  }

  largeLabel.textContent = `${progressPct}%`;
}

function renderTodayLogsList(items) {
  const container = document.getElementById('today-logs-list');
  container.innerHTML = '';

  if (items.length === 0) {
    container.innerHTML = `
      <li class="list-group-item bg-transparent text-center text-muted py-4 border-0">
        <i data-lucide="cookie" class="fs-1 text-muted-custom mb-2"></i>
        <p class="m-0">No has registrado alimentos para hoy.</p>
        <button class="btn btn-sm btn-outline-warning rounded-pill mt-3 px-3" onclick="window.location.hash='#agregar'">Registrar Primero</button>
      </li>`;
    lucide.createIcons();
    return;
  }

  items.forEach(item => {
    let mealBadgeClass = 'bg-desayuno';
    if (item.comida === 'ALMUERZO') mealBadgeClass = 'bg-almuerzo';
    else if (item.comida === 'CENA')  mealBadgeClass = 'bg-cena';
    else if (item.comida === 'MERIENDA') mealBadgeClass = 'bg-merienda';

    const li = document.createElement('li');
    li.className = 'list-group-item bg-transparent border-secondary d-flex justify-content-between align-items-center py-2_5';
    li.innerHTML = `
      <div class="d-flex flex-column">
        <div class="d-flex align-items-center">
          <span class="dot ${mealBadgeClass} me-2" title="${item.comida}"></span>
          <span class="fw-semibold text-white fs-7">${item.alimento}</span>
        </div>
        <span class="text-muted-custom fs-8 ms-3">${item.porcion || '1 porción'}</span>
      </div>
      <div class="d-flex align-items-center gap-2">
        <span class="badge rounded-pill bg-dark border border-secondary text-warning fs-8">${item.calorias} kcal</span>
        <button class="btn btn-link text-danger p-0 border-0 fs-8" onclick="deleteItemFromDashboard(${item.id})" title="Eliminar">
          <i data-lucide="trash-2" style="width:14px;height:14px;"></i>
        </button>
      </div>`;
    container.appendChild(li);
  });

  lucide.createIcons();
}

// Eliminar desde el Dashboard
async function deleteItemFromDashboard(id) {
  if (confirm('¿Seguro que deseas eliminar este registro?')) {
    try {
      await API.deleteComida(id);
      showAlert('Alimento eliminado correctamente.', 'success');
      loadDashboard();
    } catch (e) {
      console.error(e);
      showAlert('No se pudo eliminar el alimento.', 'danger');
    }
  }
}

// Gráfico semanal (consulta un único endpoint en lugar de 7 llamadas)
async function updateWeeklyChart() {
  const dates = [];
  const labels = [];
  const today = new Date();

  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(today.getDate() - i);
    dates.push(getLocalDateString(d));
    labels.push(`${d.toLocaleDateString('es-ES', { weekday: 'short' })} ${d.getDate()}`);
  }

  const summaryResult = await API.getWeeklySummary(dates);
  const summaryMap = summaryResult.data || {};
  const calorieSums = dates.map(d => summaryMap[d] || 0);

  const ctx = document.getElementById('caloriesChart').getContext('2d');
  if (caloriesChart) caloriesChart.destroy();

  const gradient = ctx.createLinearGradient(0, 0, 0, 300);
  gradient.addColorStop(0, 'rgba(245, 158, 11, 0.85)');
  gradient.addColorStop(1, 'rgba(236, 72, 153, 0.05)');

  caloriesChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Calorías diarias',
        data: calorieSums,
        backgroundColor: gradient,
        borderColor: 'rgba(245, 158, 11, 0.9)',
        borderWidth: 1.5,
        borderRadius: 8,
        borderSkipped: false
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(19, 21, 38, 0.95)',
          titleFont: { family: 'Outfit', size: 12, weight: 'bold' },
          bodyFont:  { family: 'Plus Jakarta Sans', size: 12 },
          borderColor: 'rgba(255, 255, 255, 0.1)',
          borderWidth: 1,
          padding: 10,
          displayColors: false,
          callbacks: { label: ctx => `Consumo: ${ctx.parsed.y} kcal` }
        }
      },
      scales: {
        y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#8e95b3', font: { family: 'Plus Jakarta Sans', size: 11 } } },
        x: { grid: { display: false },                  ticks: { color: '#8e95b3', font: { family: 'Plus Jakarta Sans', size: 11 } } }
      }
    }
  });
}

// 6. CONTROLADOR: AGREGAR / GEMINI
function resetQueryForm() {
  document.getElementById('gemini-query-form').reset();
  document.getElementById('form-date').value = getLocalDateString();
  document.getElementById('gemini-results-container').classList.add('d-none');
  document.getElementById('gemini-loading').classList.add('d-none');
  tempAnalysisResults = [];
  currentGeminiQueryId = null;
  loadPendingGeminiQueries(); // Mostrar consultas pendientes
}

async function handleGeminiQuery(e) {
  e.preventDefault();
  if (isGeminiQueryInFlight) return;

  const queryForm = document.getElementById('gemini-query-form');
  if (!queryForm.checkValidity()) {
    queryForm.classList.add('was-validated');
    return;
  }

  const queryText  = document.getElementById('form-query').value.trim();
  const loadingDiv = document.getElementById('gemini-loading');
  const submitBtn  = document.getElementById('btn-submit-query');

  isGeminiQueryInFlight = true;
  loadingDiv.classList.remove('d-none');
  document.getElementById('gemini-results-container').classList.add('d-none');
  submitBtn.disabled = true;

  try {
    const result = await API.consultarNutricion(queryText);

    if (!result || !Array.isArray(result.data) || result.data.length === 0) {
      const errMsg = result?.error || result?.details || 'Respuesta inválida del servidor.';
      throw new Error(errMsg);
    }

    tempAnalysisResults = result.data;

    // Guardar la consulta exitosa en la BD
    const saveResult = await API.guardarConsultaGemini(
      queryText,
      result.data,
      'completado',
      null
    );
    currentGeminiQueryId = saveResult.id;

    const sourceBadge = document.getElementById('gemini-source-badge');
    if (result.isMock) {
      sourceBadge.textContent = result.message || 'Mostrando estimaciones simuladas.';
      sourceBadge.className = 'text-warning fs-8 m-0';
      showAlert('Se están utilizando datos simulados de calorías.', 'warning');
    } else {
      sourceBadge.textContent = 'Respuestas calculadas por Gemini 3.5 Flash';
      sourceBadge.className = 'text-muted-custom fs-8 m-0';
      showAlert('¡Gemini analizó tu comida correctamente!', 'success');
    }

    renderTempResultsTable();
  } catch (error) {
    console.error('Error consultando backend:', error);
    const details = error.payload?.details || error.payload?.error || error.message;
    await guardarConsultaGeminiLocal(queryText, null, 'error', details);
    showAlert(`Error de Gemini: ${details}`, 'danger');
    const sourceBadge = document.getElementById('gemini-source-badge');
    if (sourceBadge) {
      sourceBadge.textContent = `Error: ${details}`;
      sourceBadge.className = 'text-danger fs-8 m-0';
    }
  } finally {
    isGeminiQueryInFlight = false;
    loadingDiv.classList.add('d-none');
    submitBtn.disabled = false;
  }
}

// Función auxiliar para guardar consulta con error
async function guardarConsultaGeminiLocal(queryText, gemini_response, status, error_message) {
  try {
    const result = await API.guardarConsultaGemini(queryText, gemini_response, status, error_message);
    currentGeminiQueryId = result.id;
    console.log(`✅ Consulta guardada para recuperación (ID: ${result.id})`);
  } catch (error) {
    console.error('Error guardando consulta para recuperación:', error);
  }
}

// Tabla editable de resultados de Gemini
function renderTempResultsTable() {
  const tbody      = document.getElementById('gemini-results-tbody');
  const totalBadge = document.getElementById('gemini-total-temp');
  tbody.innerHTML  = '';

  if (!tempAnalysisResults || tempAnalysisResults.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3" class="text-center">No se encontraron resultados. Intente reescribir.</td></tr>`;
    totalBadge.textContent = 'Total: 0 kcal';
    return;
  }

  let totalKcal = 0;
  tempAnalysisResults.forEach((item, index) => {
    const kcal = Math.round(Number(item.calorias || 0));
    totalKcal += kcal;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td data-label="Alimento"><div contenteditable="true" class="editable-cell text-white" data-index="${index}" data-field="alimento">${item.alimento || ''}</div></td>
      <td data-label="Porción Estimada"><div contenteditable="true" class="editable-cell text-muted-custom" data-index="${index}" data-field="porcion">${item.porcion || '1 porción'}</div></td>
      <td data-label="Calorías (kcal)"><div contenteditable="true" class="editable-cell fw-semibold text-warning" data-index="${index}" data-field="calorias">${kcal}</div></td>`;
    tbody.appendChild(tr);
  });

  totalBadge.textContent = `Total: ${totalKcal} kcal`;
  document.getElementById('gemini-results-container').classList.remove('d-none');

  tbody.querySelectorAll('.editable-cell').forEach(cell => {
    cell.addEventListener('blur', e => {
      const idx   = parseInt(e.target.dataset.index, 10);
      const field = e.target.dataset.field;
      const val   = e.target.textContent.trim();
      if (field === 'calorias') {
        const num = parseInt(val, 10);
        if (isNaN(num) || num < 0) {
          showAlert('Las calorías deben ser un número positivo.', 'warning');
          e.target.textContent = tempAnalysisResults[idx].calorias;
          return;
        }
        tempAnalysisResults[idx].calorias = num;
      } else {
        tempAnalysisResults[idx][field] = val;
      }
      recalculateTempTotal();
    });
    cell.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); cell.blur(); } });
  });
}

function recalculateTempTotal() {
  const total = tempAnalysisResults.reduce((s, item) => s + Number(item.calorias || 0), 0);
  document.getElementById('gemini-total-temp').textContent = `Total: ${total} kcal`;
}

// Guardar en MySQL
async function saveResultsToDB() {
  if (isSavingResults) return;

  const mealType = document.getElementById('form-meal-type').value;
  const rawDate  = document.getElementById('form-date').value;
  const itemsToSave = [...tempAnalysisResults];

  if (itemsToSave.length === 0) {
    showAlert('No hay alimentos para guardar.', 'warning');
    return;
  }

  const saveBtn = document.getElementById('btn-save-results');
  isSavingResults = true;
  saveBtn.disabled = true;

  try {
    const result = await API.guardarComidas(mealType, rawDate, itemsToSave);

    if (!result.success) throw new Error(result.error || 'Error desconocido al guardar.');

    showAlert(`¡${result.insertedCount} alimento(s) guardados!`, 'success');
    resetQueryForm();
    window.location.hash = '#dashboard';
  } catch (error) {
    console.error('Error guardando alimentos:', error);
    showAlert('Error al guardar en la base de datos: ' + error.message, 'danger');
  } finally {
    isSavingResults = false;
    saveBtn.disabled = false;
  }
}

function toggleManualFoodForm(show) {
  const btn = document.getElementById('btn-manual-food');
  if (!btn) return;

  btn.classList.toggle('btn-outline-info', !show);
  btn.classList.toggle('btn-info', show);
  if (show) {
    document.getElementById('manual-food-name')?.focus();
  }
}

function openManualView() {
  window.location.hash = '#manual';
  setTimeout(() => document.getElementById('manual-food-name')?.focus(), 120);
}

function addManualFoodToResults() {
  const name = document.getElementById('manual-food-name').value.trim();
  const caloriesValue = document.getElementById('manual-food-calories').value;
  const calories = Number(caloriesValue);

  if (!name) {
    showAlert('Ingresa una descripción del alimento.', 'warning');
    return;
  }
  if (!Number.isFinite(calories) || calories < 0) {
    showAlert('Ingresa un valor de calorías válido.', 'warning');
    return;
  }

  manualFoodItems.push({ alimento: name, calorias: Math.round(calories), porcion: '1 porción manual' });
  renderManualResultsTable();
  document.getElementById('manual-food-name').value = '';
  document.getElementById('manual-food-calories').value = '';
  document.getElementById('manual-food-name')?.focus();
  showAlert('Alimento agregado a la lista. Guárdalo en el diario cuando termines.', 'success');
}

async function saveManualResultsToDB() {
  if (isSavingManual) return;

  const mealType = document.getElementById('manual-meal-type').value;
  const rawDate = document.getElementById('manual-date').value || getLocalDateString();
  const itemsToSave = [...manualFoodItems];

  if (itemsToSave.length === 0) {
    showAlert('No hay alimentos para guardar.', 'warning');
    return;
  }

  const saveBtn = document.getElementById('btn-save-manual-results');
  isSavingManual = true;
  if (saveBtn) saveBtn.disabled = true;

  try {
    const result = await API.guardarComidas(mealType, rawDate, itemsToSave);
    if (!result.success) throw new Error(result.error || 'Error desconocido al guardar.');

    showAlert(`¡${result.insertedCount} alimento(s) guardados!`, 'success');
    manualFoodItems = [];
    renderManualResultsTable();
    document.getElementById('manual-food-form')?.reset();
    document.getElementById('manual-date').value = getLocalDateString();
    document.getElementById('manual-meal-type').value = 'DESAYUNO';
    window.location.hash = '#dashboard';
  } catch (error) {
    console.error('Error guardando alimentos manuales:', error);
    showAlert('Error al guardar en la base de datos: ' + error.message, 'danger');
  } finally {
    isSavingManual = false;
    if (saveBtn) saveBtn.disabled = false;
  }
}

function discardManualResults() {
  manualFoodItems = [];
  renderManualResultsTable();
  showAlert('Lista manual descartada.', 'info');
}

// Cargar y mostrar consultas pendientes a Gemini
async function loadPendingGeminiQueries() {
  try {
    const result = await API.obtenerConsultasPendientes();
    const queries = result.data || [];
    const containerHtml = document.getElementById('pending-queries-container');
    
    if (!containerHtml) return; // Si el contenedor no existe, no hacer nada

    if (queries.length === 0) {
      containerHtml.innerHTML = '';
      return;
    }

    let html = `
      <div class="alert alert-info alert-dismissible fade show mt-3" role="alert">
        <i data-lucide="alert-circle" class="me-2"></i>
        <strong>Consultas Pendientes:</strong> Tienes ${queries.length} consulta(s) anterior(es) que puedes recuperar si Gemini no respondió correctamente.
        <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
        <div class="mt-2">`;
    
    queries.forEach(query => {
      html += `
        <div class="btn-group d-block mt-2 w-100" role="group">
          <small class="d-block mb-2 text-muted">${new Date(query.created_at).toLocaleString()}</small>
          <p class="mb-2 text-break">"${query.query_text.substring(0, 100)}${query.query_text.length > 100 ? '...' : ''}"</p>
          <button type="button" class="btn btn-sm btn-outline-info" onclick="reusePendingQuery(${query.id})">
            <i data-lucide="refresh-cw" style="width:14px;height:14px;" class="me-1"></i> Reutilizar Consulta
          </button>
          <button type="button" class="btn btn-sm btn-outline-danger" onclick="deletePendingQuery(${query.id})">
            <i data-lucide="trash-2" style="width:14px;height:14px;" class="me-1"></i> Eliminar
          </button>
        </div>
      `;
    });

    html += `</div></div>`;
    containerHtml.innerHTML = html;
    lucide.createIcons();
  } catch (error) {
    console.error('Error cargando consultas pendientes:', error);
  }
}

// Reutilizar una consulta pendiente (restaurar texto en formulario)
async function reusePendingQuery(queryId) {
  try {
    const result = await API.obtenerConsultaGemini(queryId);
    const query = result.data;

    if (query && query.query_text) {
      document.getElementById('form-query').value = query.query_text;
      showAlert('Consulta recuperada. Ahora puedes intentar consultar a Gemini nuevamente.', 'info');
    }
  } catch (error) {
    console.error('Error recuperando consulta:', error);
    showAlert('Error al recuperar la consulta.', 'danger');
  }
}

// Eliminar una consulta pendiente
async function deletePendingQuery(queryId) {
  if (!confirm('¿Estás seguro de que deseas eliminar esta consulta pendiente?')) return;

  try {
    await API.eliminarConsultaGemini(queryId);
    showAlert('Consulta pendiente eliminada.', 'success');
    loadPendingGeminiQueries(); // Recargar lista
  } catch (error) {
    console.error('Error eliminando consulta:', error);
    showAlert('Error al eliminar la consulta.', 'danger');
  }
}

// 7. CONTROLADOR: MEDIDAS
function openMeasureModal() {
  const dateInput = document.getElementById('measure-date');
  if (dateInput) dateInput.value = getLocalDateString();
  const valueInput = document.getElementById('measure-value');
  if (valueInput) valueInput.value = '';
  if (bootstrapMeasureModal) bootstrapMeasureModal.show();
}

function toggleMeasuresHistory() {
  measuresHistoryVisible = !measuresHistoryVisible;
  const panel = document.getElementById('measures-history-panel');
  const label = document.getElementById('btn-toggle-measures-history-label');
  if (panel) panel.classList.toggle('d-none', !measuresHistoryVisible);
  if (label) label.textContent = measuresHistoryVisible ? 'Ocultar historial' : 'Ver historial';
}

function setMeasuresGroupFilter(group) {
  measuresActiveGroup = MEASURE_GROUPS[group] ? group : 'TODOS';
  document.querySelectorAll('#measures-group-filters button').forEach(btn => {
    btn.classList.toggle('btn-glass-active', btn.dataset.group === measuresActiveGroup);
  });
  renderMeasurementsChart(cachedMeasurements);
}

async function loadMedidas() {
  try {
    const result = await API.getMedidas();
    const items = result.data || [];
    cachedMeasurements = items;

    const tbody = document.getElementById('measurements-table-tbody');
    const countEl = document.getElementById('measures-history-count');
    if (countEl) countEl.textContent = `${items.length} registro${items.length === 1 ? '' : 's'}`;

    if (tbody) {
      if (items.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="text-center py-4 text-muted-custom">No hay medidas registradas aún.</td></tr>';
      } else {
        tbody.innerHTML = '';
        items.forEach(item => {
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td data-label="Fecha" class="text-white fs-7">${formatDateToDisplay(item.fecha)}</td>
            <td data-label="Medida" class="fw-semibold text-white fs-7">${item.item}</td>
            <td data-label="cm" class="text-warning fw-semibold">${Number(item.valor).toFixed(1)} cm</td>
            <td data-label="Acciones" class="text-center">
              <button class="btn btn-glass-icon btn-sm px-2 text-danger" onclick="deleteMeasurementItem(${item.id})" title="Eliminar medida">
                <i data-lucide="trash-2" style="width:14px;height:14px;"></i>
              </button>
            </td>`;
          tbody.appendChild(tr);
        });
        lucide.createIcons();
      }
    }

    renderMeasurementsChart(items);
  } catch (error) {
    console.error('Error cargando medidas:', error);
    showAlert('No se pudieron cargar las medidas.', 'danger');
  }
}

async function saveMeasurement() {
  const fecha = document.getElementById('measure-date').value;
  const item = document.getElementById('measure-item').value;
  const valor = document.getElementById('measure-value').value;

  if (!fecha || !item || valor === '') {
    showAlert('Completa la fecha, la medida y los centímetros.', 'warning');
    return;
  }

  const saveBtn = document.getElementById('btn-save-measure');
  if (saveBtn) saveBtn.disabled = true;

  try {
    await API.guardarMedida(fecha, item, valor);
    showAlert('Medida guardada correctamente.', 'success');
    document.getElementById('measure-value').value = '';
    document.getElementById('measure-date').value = getLocalDateString();
    if (bootstrapMeasureModal) bootstrapMeasureModal.hide();
    loadMedidas();
  } catch (error) {
    console.error('Error guardando medida:', error);
    showAlert('No se pudo guardar la medida.', 'danger');
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

async function deleteMeasurementItem(id) {
  if (!confirm('¿Deseas eliminar esta medida?')) return;

  try {
    await API.deleteMedida(id);
    showAlert('Medida eliminada.', 'success');
    loadMedidas();
  } catch (error) {
    console.error(error);
    showAlert('No se pudo eliminar la medida.', 'danger');
  }
}

function renderMeasurementsChart(items) {
  const ctx = document.getElementById('measurementsChart');
  const emptyState = document.getElementById('measurements-chart-empty');
  if (!ctx) return;

  const allowedTypes = MEASURE_GROUPS[measuresActiveGroup] || MEASURE_TYPE_ORDER;

  const normalizedItems = (items || [])
    .map(item => ({
      ...item,
      fecha: String(item.fecha || '').trim().split('T')[0],
      item: String(item.item || '').trim().toUpperCase()
    }))
    .filter(item => item.fecha && item.item && allowedTypes.includes(item.item));

  const typeLabels = allowedTypes.filter(type =>
    normalizedItems.some(item => item.item === type)
  );

  const allDates = [...new Set(normalizedItems.map(item => item.fecha))].sort();
  // Mostrar hasta las últimas 6 fechas para no saturar las barras agrupadas
  const dates = allDates.slice(-6);
  const displayDateLabels = dates.map(date => formatDateToDisplay(date));

  const hasData = typeLabels.length > 0 && dates.length > 0;

  if (emptyState) emptyState.classList.toggle('d-none', hasData);
  ctx.style.display = hasData ? 'block' : 'none';

  if (!hasData) {
    if (measurementsChart) {
      measurementsChart.destroy();
      measurementsChart = null;
    }
    return;
  }

  const datasets = dates.map((date, index) => {
    const color = getDateBarColor(index, dates.length);
    return {
      label: displayDateLabels[index],
      data: typeLabels.map(type => {
        const entry = normalizedItems.find(i => i.fecha === date && i.item === type);
        return entry ? Number(entry.valor) : null;
      }),
      backgroundColor: color,
      borderColor: color.replace('0.85', '1'),
      borderWidth: 1,
      borderRadius: 6,
      maxBarThickness: 42
    };
  });

  if (measurementsChart) measurementsChart.destroy();

  ctx.style.width = '100%';
  ctx.style.height = '100%';

  measurementsChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: typeLabels.map(formatMeasureLabel),
      datasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top',
          labels: {
            color: '#d7dce5',
            boxWidth: 12,
            usePointStyle: true,
            pointStyle: 'rectRounded'
          }
        },
        tooltip: {
          callbacks: {
            label: ctx => {
              const value = ctx.parsed.y;
              if (value == null) return `${ctx.dataset.label}: —`;
              return `${ctx.dataset.label}: ${value.toFixed(1)} cm`;
            }
          }
        }
      },
      scales: {
        x: {
          stacked: false,
          ticks: {
            color: '#c5cae0',
            font: { family: 'Plus Jakarta Sans', size: 11, weight: '600' },
            maxRotation: 0,
            autoSkip: false
          },
          grid: { display: false }
        },
        y: {
          beginAtZero: false,
          ticks: {
            color: '#8e95b3',
            font: { family: 'Plus Jakarta Sans', size: 11 },
            callback: value => `${value} cm`
          },
          grid: { color: 'rgba(255,255,255,0.05)' },
          title: {
            display: true,
            text: 'Centímetros',
            color: '#8e95b3',
            font: { size: 11 }
          }
        }
      }
    }
  });

  requestAnimationFrame(() => {
    if (measurementsChart) measurementsChart.resize();
  });
}

function formatMeasureLabel(metric) {
  const map = {
    'ABDOMEN BAJO': 'Abd. Bajo',
    'ABDOMEN ALTO': 'Abd. Alto',
    'PIERNA ALTA': 'Pierna Alta',
    'PIERNA BAJA': 'Pierna Baja',
    'TORSO': 'Torso',
    'BRAZO': 'Brazo'
  };
  return map[metric] || metric;
}

function getDateBarColor(index, total) {
  const palette = [
    'rgba(56, 189, 248, 0.85)',
    'rgba(99, 102, 241, 0.85)',
    'rgba(168, 85, 247, 0.85)',
    'rgba(34, 211, 238, 0.85)',
    'rgba(132, 204, 22, 0.85)',
    'rgba(245, 158, 11, 0.85)'
  ];
  if (total <= palette.length) return palette[index % palette.length];
  const hue = Math.round((index / Math.max(total, 1)) * 300);
  return `hsla(${hue}, 75%, 60%, 0.85)`;
}

function getMetricColor(metric, alpha = 1) {
  const colors = {
    'ABDOMEN BAJO': `rgba(249, 115, 22, ${alpha})`,
    'ABDOMEN ALTO': `rgba(34, 211, 238, ${alpha})`,
    'PIERNA ALTA': `rgba(132, 204, 22, ${alpha})`,
    'PIERNA BAJA': `rgba(244, 114, 182, ${alpha})`,
    'TORSO': `rgba(129, 140, 248, ${alpha})`,
    'BRAZO': `rgba(245, 158, 11, ${alpha})`
  };
  return colors[metric] || `rgba(255,255,255,${alpha})`;
}

// 8. CONTROLADOR: HISTORIAL
async function loadHistorial() {
  const filterMeal  = document.getElementById('filter-meal-type').value;
  const filterDate  = document.getElementById('filter-date').value;
  const tbody       = document.getElementById('history-table-tbody');
  const countBadge  = document.getElementById('history-count');

  tbody.innerHTML = `
    <tr><td colspan="6" class="text-center py-4">
      <div class="spinner-border spinner-border-sm text-warning me-2"></div>
      <span class="text-muted-custom">Cargando historial...</span>
    </td></tr>`;

  try {
    const result = await API.getAllComidas({ comida: filterMeal, fecha: filterDate });
    const items  = result.data || [];

    countBadge.textContent = `Mostrando ${items.length} registros`;
    tbody.innerHTML = '';

    if (items.length === 0) {
      tbody.innerHTML = `
        <tr><td colspan="6" class="text-center py-5 text-muted-custom">
          <i data-lucide="database" class="fs-1 mb-2"></i>
          <p class="m-0">No se encontraron registros.</p>
        </td></tr>`;
      lucide.createIcons();
      return;
    }

    items.forEach(item => {
      let mealBadgeClass = 'bg-desayuno';
      if (item.comida === 'ALMUERZO')  mealBadgeClass = 'bg-almuerzo';
      else if (item.comida === 'CENA') mealBadgeClass = 'bg-cena';
      else if (item.comida === 'MERIENDA') mealBadgeClass = 'bg-merienda';

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td data-label="Fecha" class="text-white fs-7">${item.fecha}</td>
        <td data-label="Comida"><span class="badge ${mealBadgeClass} text-white text-uppercase fs-8" style="font-weight:600">${item.comida}</span></td>
        <td data-label="Alimento" class="fw-semibold text-white fs-7">${item.alimento}</td>
        <td data-label="Porción" class="text-muted-custom fs-7">${item.porcion}</td>
        <td data-label="Calorías"><span class="badge bg-dark border border-secondary text-warning fs-7">${item.calorias} kcal</span></td>
        <td data-label="Acciones" class="text-center">
          <button class="btn btn-glass-icon btn-sm px-2 text-danger" onclick="deleteHistoryItem(${item.id})" title="Eliminar registro">
            <i data-lucide="trash-2" style="width:14px;height:14px;"></i>
          </button>
        </td>`;
      tbody.appendChild(tr);
    });

    lucide.createIcons();
  } catch (error) {
    console.error('Error cargando historial:', error);
    showAlert('Error al cargar el historial desde el servidor.', 'danger');
  }
}

async function deleteHistoryItem(id) {
  if (confirm('¿Seguro que deseas eliminar este registro del historial?')) {
    try {
      await API.deleteComida(id);
      showAlert('Registro eliminado.', 'success');
      loadHistorial();
    } catch (e) {
      console.error(e);
      showAlert('No se pudo borrar el registro.', 'danger');
    }
  }
}

async function deleteAllHistory() {
  if (confirm('⚠️ ¡ATENCIÓN! Esto borrará permanentemente todo tu historial de calorías de MySQL. ¿Estás absolutamente seguro?')) {
    try {
      await API.clearAll();
      showAlert('Historial completo eliminado de la base de datos.', 'success');
      loadHistorial();
    } catch (e) {
      console.error(e);
      showAlert('Error al vaciar el historial.', 'danger');
    }
  }
}

// 9. INICIALIZACIÓN
document.addEventListener('DOMContentLoaded', () => {
  const today = getLocalDateString();

  // Establecer fechas por defecto
  document.getElementById('dashboard-date').value = today;
  document.getElementById('form-date').value = today;
  const measureDateInput = document.getElementById('measure-date');
  if (measureDateInput) measureDateInput.value = today;
  const manualDateInput = document.getElementById('manual-date');
  if (manualDateInput) manualDateInput.value = today;
  const filterDateInput = document.getElementById('filter-date');
  if (filterDateInput) filterDateInput.value = today;

  lucide.createIcons();
  initRouter();
  checkBackendConnection();

  bootstrapTargetModal = new bootstrap.Modal(document.getElementById('modalTargetCalories'));
  bootstrapMaxModal = new bootstrap.Modal(document.getElementById('modalMaxCalories'));
  const measureModalEl = document.getElementById('modalNewMeasure');
  if (measureModalEl) bootstrapMeasureModal = new bootstrap.Modal(measureModalEl);

  // ── Event Listeners ──
  document.getElementById('dashboard-date').addEventListener('change', loadDashboard);

  document.getElementById('btn-edit-target').addEventListener('click', e => {
    e.preventDefault();
    document.getElementById('input-target-calories').value = getCalorieTarget();
    bootstrapTargetModal.show();
  });

  document.getElementById('btn-save-target-calories').addEventListener('click', () => {
    const val = parseInt(document.getElementById('input-target-calories').value, 10);
    const maxVal = getCalorieMax();
    if (isNaN(val) || val < 500 || val > 10000) {
      showAlert('Introduce un valor calórico razonable (500 - 10000 kcal).', 'warning');
      return;
    }
    if (val > maxVal) {
      showAlert('El ideal no puede ser mayor que el máximo diario.', 'warning');
      return;
    }
    setCalorieTarget(val);
    bootstrapTargetModal.hide();
    showAlert('¡Ideal calórico actualizado!', 'success');
    loadDashboard();
  });

  document.getElementById('btn-edit-max').addEventListener('click', e => {
    e.preventDefault();
    document.getElementById('input-max-calories').value = getCalorieMax();
    bootstrapMaxModal.show();
  });

  document.getElementById('btn-save-max-calories').addEventListener('click', () => {
    const val = parseInt(document.getElementById('input-max-calories').value, 10);
    const ideal = getCalorieTarget();
    if (isNaN(val) || val < 500 || val > 15000) {
      showAlert('Introduce un máximo razonable (500 - 15000 kcal).', 'warning');
      return;
    }
    if (val < ideal) {
      showAlert('El máximo debe ser mayor o igual al ideal diario.', 'warning');
      return;
    }
    setCalorieMax(val);
    bootstrapMaxModal.hide();
    showAlert('¡Máximo calórico actualizado!', 'success');
    loadDashboard();
  });

  document.getElementById('gemini-query-form').addEventListener('submit', handleGeminiQuery);
  const geminiFab = document.getElementById('fab-agregar');
  if (geminiFab) {
    geminiFab.addEventListener('click', e => {
      e.preventDefault();
      window.location.hash = '#agregar';
    });
  }

  const manualFab = document.getElementById('fab-manual-global');
  if (manualFab) {
    manualFab.addEventListener('click', e => {
      e.preventDefault();
      openManualView();
    });
  }
  document.getElementById('btn-cancel-results').addEventListener('click', () => {
    resetQueryForm();
    showAlert('Análisis descartado.', 'info');
  });
  document.getElementById('btn-save-results').addEventListener('click', saveResultsToDB);
  const manualFormButton = document.getElementById('btn-manual-food');
  if (manualFormButton) {
    manualFormButton.addEventListener('click', () => openManualView());
  }
  document.getElementById('btn-back-to-gemini').addEventListener('click', () => window.location.hash = '#agregar');
  document.getElementById('manual-food-form').addEventListener('submit', e => {
    e.preventDefault();
    addManualFoodToResults();
  });
  document.getElementById('btn-save-manual-results')?.addEventListener('click', saveManualResultsToDB);
  document.getElementById('btn-cancel-manual-results')?.addEventListener('click', discardManualResults);
  document.getElementById('btn-save-measure')?.addEventListener('click', saveMeasurement);
  document.getElementById('btn-open-measure-modal')?.addEventListener('click', openMeasureModal);
  document.getElementById('btn-open-measure-modal-empty')?.addEventListener('click', openMeasureModal);
  document.getElementById('btn-toggle-measures-history')?.addEventListener('click', toggleMeasuresHistory);
  document.querySelectorAll('#measures-group-filters button').forEach(btn => {
    btn.addEventListener('click', () => setMeasuresGroupFilter(btn.dataset.group));
  });

  document.getElementById('filter-meal-type').addEventListener('change', loadHistorial);
  document.getElementById('filter-date').addEventListener('change', loadHistorial);
  document.getElementById('btn-clear-filters').addEventListener('click', () => {
    document.getElementById('filter-meal-type').value = 'TODOS';
    document.getElementById('filter-date').value = getLocalDateString();
    loadHistorial();
  });

  document.getElementById('btn-delete-all-db').addEventListener('click', deleteAllHistory);

  const menuToggle = document.getElementById('menu-toggle');
  const menuClose = document.getElementById('menu-close');
  const menuOverlay = document.getElementById('menu-overlay');
  if (menuToggle) menuToggle.addEventListener('click', () => openMenu());
  if (menuClose) menuClose.addEventListener('click', () => closeMenu());
  if (menuOverlay) menuOverlay.addEventListener('click', () => closeMenu());

  window.addEventListener('offline', () => {
    notifyBackendOffline('Sin conexión a internet. El backend no está disponible.');
  });
  window.addEventListener('online', () => {
    checkBackendConnection();
  });
});
