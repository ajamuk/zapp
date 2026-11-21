import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';

/** Definición de las herramientas que puede usar Sofía. La implementación está en setter.js. */
export const TOOLS = [
  {
    name: 'consultar_horarios',
    description: 'Horario habitual publicado de una sede y modalidad, opcionalmente filtrado por franja. Úsala siempre antes de dar horarios.',
    input_schema: {
      type: 'object',
      properties: {
        sede: { type: 'string', enum: ['parla', 'getafe', 'las_rosas'] },
        modalidad: { type: 'string', enum: ['academy', 'crossfit', 'hyrox', 'open_box', 'halterofilia', 'crossfit_partner'] },
        franja: { type: 'string', enum: ['manana', 'tarde'] },
      },
      required: ['sede', 'modalidad'],
    },
  },
  {
    name: 'consultar_tarifas',
    description: 'Tarifas oficiales de una sede y familia. Con dias_por_semana devuelve la tarifa recomendada.',
    input_schema: {
      type: 'object',
      properties: {
        sede: { type: 'string', enum: ['parla', 'getafe', 'las_rosas'] },
        familia: { type: 'string', enum: ['academy', 'crossfit_hyrox'] },
        dias_por_semana: { type: 'integer', minimum: 1, maximum: 7 },
      },
      required: ['sede', 'familia'],
    },
  },
  {
    name: 'calcular_primer_recibo',
    description: 'Importe del primer recibo prorrateado según la fecha de inicio.',
    input_schema: {
      type: 'object',
      properties: {
        sede: { type: 'string', enum: ['parla', 'getafe', 'las_rosas'] },
        tarifa: { type: 'string', enum: ['academy_2', 'academy_3', 'S', 'M', 'L', 'XL'] },
        fecha_inicio: { type: 'string', description: 'AAAA-MM-DD' },
      },
      required: ['sede', 'tarifa', 'fecha_inicio'],
    },
  },
  {
    name: 'preparar_alta',
    description: 'Tramita el alta en AimHarder. Solo con el sí del lead, todos sus datos (nombre y apellidos, fecha de nacimiento, teléfono, email) y la sede, tarifa y fecha de inicio confirmadas por el lead. No hay matrícula ni promociones, salvo en El Cañaveral: allí el sistema aplica solo el descuento de apertura del tramo que toque y el alta empieza el 2027-02-01.',
    input_schema: {
      type: 'object',
      properties: {
        nombre_completo: { type: 'string', description: 'Nombre y al menos un apellido' },
        email: { type: 'string' },
        fecha_nacimiento: { type: 'string', description: 'AAAA-MM-DD' },
        telefono: { type: 'string', description: 'Solo si no es el de esta conversación (por ejemplo, en Instagram)' },
        sede: { type: 'string', enum: ['parla', 'getafe', 'las_rosas', 'el_canaveral'] },
        tarifa: { type: 'string', enum: ['academy_1', 'academy_2', 'academy_3', 'S', 'M', 'L', 'XL'], description: 'academy_1 solo existe en El Cañaveral' },
        fecha_inicio: { type: 'string', description: 'AAAA-MM-DD, confirmada por el lead. En El Cañaveral, 2027-02-01' },
        avisar_lead: { type: 'boolean', description: 'false solo si el equipo pide prepararla sin avisarle. Por defecto true' },
      },
      required: ['nombre_completo', 'email', 'fecha_nacimiento', 'sede', 'tarifa', 'fecha_inicio'],
    },
  },
  {
    name: 'reservar_prueba_parla',
    description: 'Pide al equipo la clase de prueba gratuita en Parla. Solo si el lead la ha pedido.',
    input_schema: {
      type: 'object',
      properties: {
        modalidad: { type: 'string', enum: ['academy', 'crossfit', 'hyrox'] },
        fecha_hora: { type: 'string', description: 'AAAA-MM-DD HH:MM de una clase de esa modalidad en Parla' },
      },
      required: ['modalidad', 'fecha_hora'],
    },
  },
  {
    name: 'derivar_a_equipo',
    description: 'Pasa la conversación a una persona del equipo y pausa la IA en este chat.',
    input_schema: {
      type: 'object',
      properties: {
        motivo: { type: 'string', enum: ['salud', 'gestion_socio', 'cobro', 'llamada', 'visita', 'no_documentado', 'otro'] },
        resumen: { type: 'string', description: 'Qué necesita el lead, en una o dos frases, para el equipo' },
      },
      required: ['motivo', 'resumen'],
    },
  },
  {
    name: 'enviar_recurso',
    description: 'Envía al lead uno de los archivos de la lista «Archivos que puedes enviar» (horarios en PDF, fotos, vídeo…). Solo si encaja con lo que pregunta.',
    input_schema: { type: 'object', properties: { nombre: { type: 'string', description: 'Nombre exacto del archivo' } }, required: ['nombre'] },
  },
  {
    name: 'responder',
    description: 'Obligatoria al final de cada turno: mensajes que se envían al lead (1 a 4 burbujas), etiquetas, fase y una nota interna corta para el equipo.',
    input_schema: {
      type: 'object',
      properties: {
        mensajes: { type: 'array', items: { type: 'string' }, minItems: 0, maxItems: 4 },
        sede: { type: 'string', enum: ['parla', 'getafe', 'las_rosas', 'el_canaveral', 'desconocida'] },
        fase: { type: 'string', enum: ['f1 apertura', 'f2 diagnóstico', 'f3 presentación', 'f4 objeciones', 'f5 cierre', 'cerrada'] },
        etiquetas: { type: 'array', items: { type: 'string' } },
        analisis: { type: 'string', description: 'Nota interna (no se envía): qué sabes del lead y en qué punto está, en una o dos frases.' },
        siguiente_paso: { type: 'string', description: 'Nota interna (no se envía): qué buscas conseguir con el próximo mensaje.' },
        retomar: {
          type: 'object',
          description: 'Solo si el lead dice que lo decidirá o se apuntará más adelante (después de vacaciones, cuando cobre, en enero, cuando se recupere...). Programa volver a escribirle entonces.',
          properties: {
            fecha: { type: 'string', description: 'AAAA-MM-DD en la que tiene sentido volver a escribirle según lo que ha dicho. Vacía si no da ninguna pista.' },
            motivo: { type: 'string', description: 'Lo que dijo, en pocas palabras (p. ej. «se apunta en septiembre, ahora está de vacaciones»).' },
          },
        },
      },
      required: ['mensajes', 'fase'],
    },
  },
];

let client;
const getClient = () => (client ??= new Anthropic({ apiKey: config.ai.apiKey }));

/**
 * Ejecuta un turno: llama al modelo, resuelve herramientas y devuelve la entrada de `responder`.
 * `complete` se puede sustituir en tests.
 */
export async function runTurn({ system, messages, ejecutarHerramienta, complete, maxPasos = 6, onUsage, onHerramienta }) {
  // Sonnet 5.5 no admite forzar herramienta (tool_choice any/tool → 400): se pide en modo auto y, si contesta
  // en texto sin llamar a `responder`, se le recuerda una vez. Si el modelo se niega por seguridad, la API
  // reintenta con su modelo de respaldo (fallbacks "default").
  // Tiempo límite de 60 s por llamada (el SDK reintenta 2 veces los fallos de red, 429 y 5xx): una respuesta
  // normal tarda 4-8 s, y sin límite una llamada colgada bloquearía el chat hasta 10 minutos.
  const llamar = complete || ((req) => getClient().beta.messages.create({ ...req, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, { timeout: 60000, maxRetries: 2 }));
  const conv = [...messages];
  let recordatorios = 0;
  for (let paso = 0; paso < maxPasos; paso++) {
    const t0 = Date.now();
    const res = await llamar({
      model: config.ai.model,
      max_tokens: 8000, // el razonamiento interno (siempre activo en este modelo) cuenta dentro de este límite
      system,
      tools: TOOLS,
      tool_choice: { type: 'auto' },
      messages: conv,
    });
    onUsage?.(res.usage || {}, Date.now() - t0);
    if (res.stop_reason === 'refusal') throw new Error(`El modelo se ha negado a responder (${res.stop_details?.category || 'sin categoría'})`);
    if (res.stop_reason === 'max_tokens') throw new Error('La respuesta del modelo se cortó por longitud'); // una herramienta a medias no se ejecuta
    const usos = (res.content || []).filter((b) => b.type === 'tool_use');
    const final = usos.find((u) => u.name === 'responder');
    if (final) {
      // Si junto a `responder` pidió otras herramientas (derivar, reservar, enviar un archivo…), se ejecutan también:
      // si no, el lead leería «te paso con el equipo» sin que el chat se derive de verdad.
      for (const u of usos.filter((x) => x !== final && x.name !== 'responder')) {
        let out;
        try { out = await ejecutarHerramienta(u.name, u.input); } catch (e) { out = { ok: false, error: e.message }; }
        onHerramienta?.({ nombre: u.name, entrada: u.input, resultado: out });
      }
      return { respuesta: final.input, herramientas: conv.length - messages.length };
    }
    if (!usos.length) {
      if (recordatorios++ >= 1) throw new Error('El modelo no usó la herramienta responder');
      conv.push({ role: 'assistant', content: res.content });
      conv.push({ role: 'user', content: '(Mensaje del sistema, no del lead) Termina el turno llamando a la herramienta `responder`: lo que escribas fuera de ella no le llega al lead.' });
      continue;
    }
    conv.push({ role: 'assistant', content: res.content });
    const resultados = [];
    for (const u of usos) {
      let out;
      try { out = await ejecutarHerramienta(u.name, u.input); } catch (e) { out = { ok: false, error: e.message }; }
      onHerramienta?.({ nombre: u.name, entrada: u.input, resultado: out });
      resultados.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out) });
    }
    conv.push({ role: 'user', content: resultados });
  }
  throw new Error('Demasiados pasos de herramientas sin respuesta final');
}

/**
 * Llamada que devuelve un objeto JSON con el esquema dado (structured outputs). Se usa para el optimizador de
 * reportes, que no habla con leads. `complete` se puede sustituir en tests.
 */
export async function pedirJSON({ system, contenido, schema, modelo = config.ai.modeloOptimizador, complete, maxTokens = 16000, onUsage }) {
  const llamar = complete || ((req) => getClient().beta.messages.create({ ...req, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, { timeout: 240000, maxRetries: 1 }));
  const res = await llamar({
    model: modelo, max_tokens: maxTokens, system,
    messages: [{ role: 'user', content: contenido }],
    output_config: { format: { type: 'json_schema', schema } },
  });
  onUsage?.(res.usage || {}, modelo);
  if (res.stop_reason === 'refusal') throw new Error('El modelo se ha negado a analizarlo');
  if (res.stop_reason === 'max_tokens') throw new Error('La respuesta del modelo se cortó');
  const texto = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  try { return JSON.parse(texto); } catch { throw new Error('El modelo no devolvió un JSON válido'); }
}

/** Llamada de texto simple (el lead simulado de la batería de pruebas). */
export async function pedirTexto({ system, messages, modelo = config.ai.modeloLead, complete, onUsage }) {
  const llamar = complete || ((req) => getClient().messages.create(req, { timeout: 60000, maxRetries: 2 }));
  const res = await llamar({ model: modelo, max_tokens: 2000, system, messages });
  onUsage?.(res.usage || {}, modelo);
  return (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

/** Bloques de sistema con caché: el prompt y la base de conocimiento casi no cambian. */
export function systemBlocks(prompt, negocio, contexto) {
  return [
    { type: 'text', text: prompt },
    { type: 'text', text: `# Base de conocimiento\n\n${negocio}`, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: contexto },
  ];
}
