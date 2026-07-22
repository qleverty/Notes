// =============================================
// CONSTANTS
// Loaded first. All other scripts read these as globals.
// =============================================

// Canvas zoom limits
const ZOOM_MIN = 0.05;
const ZOOM_MAX = 10;

// Thread (wire) magnetic snap radius in screen pixels
const MAGNETIC_RADIUS = 50;

// Project dropdown: minimum selector width in px
const PROJ_MIN_W = 200;

// Forbidden characters for cross-platform filenames (Windows is most restrictive)
const FORBIDDEN_CHARS = /[\\/:*?"<>|\x00-\x1f]/g;

// =============================================
// VIEWPORT CULLING
// Минимальный zoom для загрузки контента.
// Чем больше число — тем нужно сильнее приблизить.
// =============================================
const CULL = Object.freeze({
    // Тело заметки — с 20% зума; заголовок всегда виден
    NOTE_BODY_MIN_ZOOM: 0.20,
    // IMAGE_MIN_ZOOM: 0.50,   // раскомментировать когда появятся изображения
    // TABLE_MIN_ZOOM: 0.35,
});

// =============================================
// БУФЕР СОХРАНЕНИЯ
// =============================================
const SAVE_BUFFER = Object.freeze({
    DEBOUNCE_MS:    800,   // пауза после последнего нажатия клавиши
    MAX_PENDING_MS: 5000,  // максимум без сохранения даже при непрерывном вводе
});

// =============================================
// БЮДЖЕТ ПАМЯТИ ДЛЯ КОНТЕНТА
// 15% RAM устройства, не более 600 МБ
// =============================================
const CONTENT_BUDGET = Math.min((navigator.deviceMemory ?? 1) * 1024 * 1024 * 1024 * 0.15, 600 * 1024 * 1024);

// =============================================
// ОБЩИЕ ПАРАМЕТРЫ ПРИЛОЖЕНИЯ
// =============================================
const APP_CONSTANTS = Object.freeze({
    DEFAULT_NOTE_W: 250,
    DEFAULT_NOTE_H: 250,
    DEFAULT_COLOR:  [255, 235, 180],
    MIN_ZOOM: 0.05,
    MAX_ZOOM: 5.0,
});
