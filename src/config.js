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
  tz: env('TZ', 'Europe/Madrid'),
  webhookSecret: env('WEBHOOK_SECRET'),
  adminToken: env('ADMIN_TOKEN'),
  ai: {
    apiKey: env('ANTHROPIC_API_KEY'),
    model: env('AI_MODEL', 'claude-sonnet-5-5'),
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
  },
  aimharder: {
    apiUrl: env('AIMHARDER_API_URL'),
    apiKey: env('AIMHARDER_API_KEY'),
    adminUrl: env('AIMHARDER_ADMIN_URL'),
    adminUser: env('AIMHARDER_ADMIN_USER'),
    adminPassword: env('AIMHARDER_ADMIN_PASSWORD'),
    altaDryRun: env('AIMHARDER_ALTA_DRY_RUN', 'true') !== 'false',
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
