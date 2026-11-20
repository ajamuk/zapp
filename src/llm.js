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
    description: 'Tramita el alta en AimHarder. Solo con el sí del lead, todos sus datos (nombre y apellidos, fecha de nacimiento, teléfono, email) y la sede, tarifa y fecha de inicio confirmadas por el lead. No hay matrícula ni promociones.',
    input_schema: {
      type: 'object',
      properties: {
        nombre_completo: { type: 'string', description: 'Nombre y al menos un apellido' },
        email: { type: 'string' },
        fecha_nacimiento: { type: 'string', description: 'AAAA-MM-DD' },
        telefono: { type: 'string', description: 'Solo si no es el de esta conversación (por ejemplo, en Instagram)' },
        sede: { type: 'string', enum: ['parla', 'getafe', 'las_rosas'] },
        tarifa: { type: 'string', enum: ['academy_2', 'academy_3', 'S', 'M', 'L', 'XL'] },
        fecha_inicio: { type: 'string', description: 'AAAA-MM-DD, confirmada por el lead' },
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
  const llamar = complete || ((req) => getClient().messages.create(req));
  const conv = [...messages];
  for (let paso = 0; paso < maxPasos; paso++) {
    const t0 = Date.now();
    const res = await llamar({
      model: config.ai.model,
      max_tokens: 1024,
      system,
      tools: TOOLS,
      tool_choice: { type: 'any' },
      messages: conv,
    });
    onUsage?.(res.usage || {}, Date.now() - t0);
    const usos = (res.content || []).filter((b) => b.type === 'tool_use');
    if (!usos.length) throw new Error('El modelo no usó ninguna herramienta');
    const final = usos.find((u) => u.name === 'responder');
    if (final) return { respuesta: final.input, herramientas: conv.length - messages.length };
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

/** Bloques de sistema con caché: el prompt y la base de conocimiento casi no cambian. */
export function systemBlocks(prompt, negocio, contexto) {
  return [
    { type: 'text', text: prompt },
    { type: 'text', text: `# Base de conocimiento\n\n${negocio}`, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: contexto },
  ];
}
