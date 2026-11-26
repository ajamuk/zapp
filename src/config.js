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
  // Teléfonos del equipo para probar: Sofía los trata como lead aunque sean socios y les contesta de verdad
  // también en modo shadow (separados por comas)
  telefonosPrueba: env('TEST_PHONES').split(',').map((x) => x.trim()).filter(Boolean),
  // Mensaje con el que un teléfono de prueba reinicia su conversación desde WhatsApp (solo funciona para TEST_PHONES)
  palabraReinicio: env('TEST_RESET_WORD', '#reset'),
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
    // Modelo que redacta los textos de los seguimientos (tarea corta: Haiku cuesta 20 veces menos que Sonnet)
    modeloSeguimientos: env('SEGUIMIENTOS_MODEL', 'claude-haiku-5-5'),
    // Modelo que decide si un mensaje nuevo de Instagram pide información de verdad (sí/no)
    modeloFiltroInstagram: env('INSTAGRAM_FILTRO_MODEL', 'claude-haiku-5-5'),
    // Esfuerzo de razonamiento de Sofía (low | medium | high | xhigh | max). Vacío = el del modelo (high en Sonnet 5.5)
    effort: env('AI_EFFORT', 'medium'),
    // Duración de la caché del prompt y la base de conocimiento: 1h (los leads contestan con minutos u horas de pausa) o 5m
    cacheTtl: env('AI_CACHE_TTL', '1h'),
    minDelay: num('AI_MIN_DELAY', 15),
    maxDelay: num('AI_MAX_DELAY', 50),
    typingSpeed: num('AI_TYPING_SPEED', 4),
    typingMax: num('AI_TYPING_MAX', 12), // tope de «escribiendo…» por burbuja, en segundos
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
  // Aislamiento en un número de WhatsApp propio (docs/aislamiento-whatsapp.md). Los dos vacíos = sin aislamiento.
  aislamiento: {
    numero: env('SOFIA_WA_NUMERO'),          // número propio de Sofía en formato internacional (+34…)
    locationId: env('SOFIA_WA_LOCATION_ID'), // subcuenta de GHL de ese número; tiene que ser la misma que GHL_LOCATION_ID
    // El número propio es el que ya tenía la subcuenta: los chats que había en la base son de esta misma línea y se
    // pueden adoptar, uno a uno, cuando GHL lo confirma (ver docs/aislamiento-whatsapp.md)
    adoptar: env('SOFIA_WA_ADOPTAR_CHATS', 'false') === 'true',
    // El workflow «Sofía · enviar plantilla» de esta subcuenta envía desde el número propio (docs/seguimientos.md)
    plantillas: env('SOFIA_WA_PLANTILLAS', 'false') === 'true',
    // Cuenta de Instagram que también atiende Sofía (id de la página que GHL pone en meta.ig.pageId). Vacío = solo WhatsApp
    instagram: env('SOFIA_IG_PAGE_ID'),
  },
  aimharder: {
    tokens: Object.fromEntries(['parla', 'getafe', 'las_rosas'].map((s) => [s, {
      access: env(`AIMHARDER_TOKEN_${s.toUpperCase()}`), refresh: env(`AIMHARDER_REFRESH_${s.toUpperCase()}`),
    }])),
    tokenStore: env('AIMHARDER_TOKEN_STORE'),
    // Exsocio cuya última tarifa pagada terminó hace menos de estos meses: Sofía no le contesta (lo lleva el equipo)
    exsocioRecienteMeses: Number(env('EXSOCIO_RECIENTE_MESES', '3')),
    adminUrl: env('AIMHARDER_ADMIN_URL'),
    adminUser: env('AIMHARDER_ADMIN_USER'),
    adminPassword: env('AIMHARDER_ADMIN_PASSWORD'),
    altaDryRun: env('AIMHARDER_ALTA_DRY_RUN', 'true') !== 'false',
    // Clase de prueba de Parla reservada directamente en AimHarder (además hace falta MODE=live)
    reservaPrueba: env('AIMHARDER_RESERVA_PRUEBA', 'false') === 'true',
    // Webhooks de AimHarder (docs/aimharder-webhooks.md): un token común en la URL y una clave privada RSA por sede
    webhookToken: env('AIMHARDER_WEBHOOK_TOKEN'),
    webhookClaves: Object.fromEntries(['parla', 'getafe', 'las_rosas'].map((s) => [s, {
      pem: env(`AIMHARDER_WEBHOOK_KEY_${s.toUpperCase()}`), fichero: env(`AIMHARDER_WEBHOOK_KEY_${s.toUpperCase()}_FILE`),
    }])),
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
  // Notas de voz de Sofía con ElevenLabs (src/voz.js). Sin clave no se genera ninguna; las normas van en Ajustes.
  voz: {
    apiKey: env('ELEVENLABS_API_KEY'),
    vozId: env('ELEVENLABS_VOICE_ID'),                       // «Voice ID» de la voz (se puede cambiar en Ajustes)
    modelo: env('ELEVENLABS_MODEL', 'eleven_multilingual_v2'),
    baseUrl: env('ELEVENLABS_BASE_URL', 'https://api.elevenlabs.io'),
  },
  embudo: {
    // Informes mensuales de pruebas que genera metro-trial-crm desde AimHarder (aimharder-AAAA-MM.json)
    pruebasDir: env('EMBUDO_PRUEBAS_DIR', '/opt/metro-trial-crm/data'),
    // Registro de socios de cada sede (clientes-analytics, se rehace solo): de ahí sale el primer pago histórico
    sociosDb: {
      parla: env('EMBUDO_SOCIOS_PARLA', '/opt/clientes-analytics-parla/data/clientes.sqlite'),
      getafe: env('EMBUDO_SOCIOS_GETAFE', '/opt/clientes-analytics/data/clientes.sqlite'),
      las_rosas: env('EMBUDO_SOCIOS_LAS_ROSAS', '/opt/clientes-analytics-rosas/data/clientes.sqlite'),
    },
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

/**
 * Claves del servicio que faltan o son fáciles de adivinar (menos de 24 caracteres). Devuelve los avisos en texto;
 * no cambia nada: sin clave, el webhook y el panel ya rechazan todas las peticiones.
 */
export function clavesDebiles(c = config) {
  const avisos = [];
  const mirar = (valor, nombre, para) => {
    if (!valor) avisos.push(`Falta ${nombre} en la configuración: ${para} rechaza todas las peticiones.`);
    else if (valor.length < 24) avisos.push(`${nombre} tiene ${valor.length} caracteres: usa una clave aleatoria de al menos 24 (openssl rand -hex 24).`);
  };
  mirar(c.webhookSecret, 'WEBHOOK_SECRET', 'el webhook de GHL');
  mirar(c.adminToken, 'ADMIN_TOKEN', 'el panel');
  return avisos;
}
