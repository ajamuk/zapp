import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Carga .env sin dependencias (KEY=VALUE, ignora comentarios)
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const env = (k, d = '') => process.env[k] ?? d;
const num = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? Number(process.env[k]) : d);

export const config = {
  root,
  mode: env('MODE', 'shadow'),
  port: num('PORT', 3200),
  dbPath: path.resolve(root, env('DB_PATH', './data/setter.db')),
  // Zona horaria del negocio (no la del servidor: si el servicio corre en UTC, el horario de Sofía no se mueve)
  tz: env('BUSINESS_TZ', 'Europe/Madrid'),
  ghlWebhookEnabled: env('GHL_WEBHOOK_ENABLED', 'true') === 'true',
  webhookSecret: env('WEBHOOK_SECRET'),
  adminToken: env('ADMIN_TOKEN'),
  ai: {
    apiKey: env('ANTHROPIC_API_KEY'),
    // Opcional: clave de administrador (sk-ant-admin…) para comparar Consumo con lo que factura Anthropic. Solo lee costes.
    adminKey: env('ANTHROPIC_ADMIN_KEY'),
    // Opcional: id de la API key de zapp (apikey_…). Si falta, se busca entre las claves de la organización por su pista.
    apiKeyId: env('ANTHROPIC_API_KEY_ID'),
    model: env('AI_MODEL', 'claude-sonnet-5-5'),
    // Modelo que analiza los reportes y propone cambios en las instrucciones (no habla con leads)
    modeloOptimizador: env('OPTIMIZADOR_MODEL', 'claude-opus-5-5'),
    // Modelo que hace de lead en la batería de pruebas (barato: solo escribe mensajes cortos)
    modeloLead: env('BATERIA_LEAD_MODEL', 'claude-haiku-5-5'),
    minDelay: num('AI_MIN_DELAY', 15),
    maxDelay: num('AI_MAX_DELAY', 50),
    typingSpeed: num('AI_TYPING_SPEED', 4),
    horaInicio: num('AI_HORA_INICIO', 8),
    horaFin: num('AI_HORA_FIN', 0),
  },
  ghl: {
    token: env('GHL_TOKEN'),
    locationId: env('GHL_LOCATION_ID'),
    baseUrl: env('GHL_BASE_URL', 'https://services.leadconnectorhq.com'),
    users: {
      parla: env('GHL_USER_PARLA'),
      getafe: env('GHL_USER_GETAFE'),
      las_rosas: env('GHL_USER_LAS_ROSAS'),
      el_canaveral: env('GHL_USER_LAS_ROSAS'),
    },
    calendarPruebaParla: env('GHL_CALENDAR_PRUEBA_PARLA'),
    // Envío por plantilla de WhatsApp a través de un workflow de GHL (ver docs/seguimientos.md)
    tagPlantilla: env('GHL_TAG_PLANTILLA', 'sofia-enviar-plantilla'),
    campoPlantilla: env('GHL_CAMPO_PLANTILLA', 'Sofía · Texto de seguimiento'),
  },
  aimharder: {
    tokens: Object.fromEntries(['parla', 'getafe', 'las_rosas'].map((s) => [s, {
      access: env(`AIMHARDER_TOKEN_${s.toUpperCase()}`), refresh: env(`AIMHARDER_REFRESH_${s.toUpperCase()}`),
    }])),
    tokenStore: env('AIMHARDER_TOKEN_STORE'),
    adminUrl: env('AIMHARDER_ADMIN_URL'),
    adminUser: env('AIMHARDER_ADMIN_USER'),
    adminPassword: env('AIMHARDER_ADMIN_PASSWORD'),
    altaDryRun: env('AIMHARDER_ALTA_DRY_RUN', 'true') !== 'false',
    // Clase de prueba de Parla reservada directamente en AimHarder (además hace falta MODE=live)
    reservaPrueba: env('AIMHARDER_RESERVA_PRUEBA', 'false') === 'true',
  },
  // metro-trial-ops (pruebas de los calendarios de GHL, con asistencia y alta verificadas): su base, solo lectura
  trialOps: { db: env('TRIAL_OPS_DB', '/var/lib/metro-trial-ops/trial_ops.sqlite3') },
  // Dirección pública del servicio (para que GHL descargue los recursos que envía Sofía)
  publicUrl: env('PUBLIC_URL', 'https://setter.82.223.108.143.nip.io'),
  // API de Conversiones de Meta (eventos al ponerse ciertas etiquetas)
  meta: { pixelId: env('META_PIXEL_ID', ''), token: env('META_CAPI_TOKEN', ''), testCode: env('META_TEST_EVENT_CODE', ''), version: env('META_API_VERSION', 'v21.0') },
  media: {
    // Carpeta donde se guardan audios e imágenes (por defecto, data/media junto a la base de datos)
    dir: env('MEDIA_DIR', ''),
    // faster-whisper en local: python con la librería y carpeta del modelo «small» ya descargado
    python: env('TRANSCRIPTOR_PYTHON', '/opt/hermes-agent/.venv/bin/python'),
    modelos: env('TRANSCRIPTOR_MODELOS', '/var/cache/metrito-stt'),
    // Reserva si lo anterior falla: script del VPS con openai-whisper (más lento)
    reserva: env('TRANSCRIPTOR_RESERVA', '/usr/local/bin/cfmp-whisper-transcribe'),
    ffmpeg: env('FFMPEG', 'ffmpeg'),
  },
  embudo: {
    // Informes mensuales de pruebas que genera metro-trial-crm desde AimHarder (aimharder-AAAA-MM.json)
    pruebasDir: env('EMBUDO_PRUEBAS_DIR', '/opt/metro-trial-crm/data'),
  },
  telegram: {
    token: env('TELEGRAM_BOT_TOKEN'),
    chats: {
      parla: env('TELEGRAM_CHAT_PARLA'),
      getafe: env('TELEGRAM_CHAT_GETAFE'),
      las_rosas: env('TELEGRAM_CHAT_LAS_ROSAS'),
      general: env('TELEGRAM_CHAT_GENERAL'),
    },
  },
};

export const isLive = () => config.mode === 'live';
