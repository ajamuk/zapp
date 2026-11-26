import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { usosDe } from './precios.js';

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
    description: 'Reserva la clase de prueba gratuita en Parla directamente en AimHarder, cuando el lead la pide o acepta la que le ofreces, con día y hora elegidos. Necesita su nombre y apellidos, su email y, si no escribe por WhatsApp, su teléfono. Si esa hora no existe ese día, devuelve las horas que sí hay para que le propongas otra. Si ya tenía una prueba, la cambia a la nueva.',
    input_schema: {
      type: 'object',
      properties: {
        modalidad: { type: 'string', enum: ['academy', 'crossfit', 'hyrox'] },
        fecha_hora: { type: 'string', description: 'AAAA-MM-DD HH:MM de una clase de esa modalidad en Parla' },
        nombre_completo: { type: 'string', description: 'Nombre y al menos un apellido del lead (el que te haya dicho; si no lo sabes, pídeselo antes)' },
        email: { type: 'string', description: 'El email del lead (si no lo tienes, pídeselo antes)' },
        telefono: { type: 'string', description: 'Solo si no es el de esta conversación (por ejemplo, en Instagram)' },
      },
      required: ['modalidad', 'fecha_hora', 'nombre_completo', 'email'],
    },
  },
  {
    name: 'pregunta_sin_respuesta',
    description: 'Apunta una pregunta concreta del lead sobre el centro que NO está en tu información (ni en «Respuestas del equipo») para que la responda el equipo. Cuando respondan, se le escribe por aquí y la sabrás para siguientes veces. No pausa la conversación: sigue con lo demás. No la uses para temas de salud, gestiones de socios o cobros (eso es derivar_a_equipo).',
    input_schema: {
      type: 'object',
      properties: {
        pregunta: { type: 'string', description: 'La pregunta, redactada de forma general y corta (p. ej. «¿Hay parking en Parla?»), sin datos personales' },
      },
      required: ['pregunta'],
    },
  },
  {
    name: 'derivar_a_equipo',
    description: 'Pasa la conversación a una persona del equipo y pausa la IA en este chat. Solo cuando una persona tiene que encargarse (ver «Cuándo pasar a una persona»). Si no hay nada que derivar, no la llames: no existe una llamada «vacía» ni «no aplica»; para contestar usa solo `responder`.',
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
    description: 'Obligatoria al final de cada turno: mensajes que se envían al lead (1 o 2 burbujas, 3 como mucho), etiquetas, fase y una nota interna corta para el equipo.',
    // strict: la API garantiza que los argumentos cumplen el esquema (mensajes siempre como lista de textos).
    // El modo estricto no admite límites numéricos ni de tamaño de lista: el máximo de 3 burbujas lo comprueba revisarRespuesta.
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mensajes: { type: 'array', items: { type: 'string' }, description: '1 o 2 burbujas (3 como mucho); cada una, un texto' },
        sede: { type: 'string', enum: ['parla', 'getafe', 'las_rosas', 'el_canaveral', 'desconocida'] },
        fase: { type: 'string', enum: ['f1 apertura', 'f2 diagnóstico', 'f3 presentación', 'f4 objeciones', 'f5 cierre', 'cerrada'] },
        etiquetas: { type: 'array', items: { type: 'string' } },
        analisis: { type: 'string', description: 'Nota interna (no se envía): qué sabes del lead y en qué punto está, en una o dos frases.' },
        siguiente_paso: { type: 'string', description: 'Nota interna (no se envía): qué buscas conseguir con el próximo mensaje.' },
        valoracion: {
          type: 'object',
          description: 'Nota interna (no se envía), en cada turno: lo probable que es que se apunte, de 1 (nada) a 10 (ya decidido o con el alta hecha), según su interés, su encaje y lo que falta para cerrar.',
          additionalProperties: false,
          properties: {
            nota: { type: 'integer', description: 'De 1 a 10' },
            motivo: { type: 'string', description: 'Por qué, en una frase corta' },
          },
          required: ['nota'],
        },
        resumen: { type: 'string', description: 'Nota interna (no se envía), en cada turno: resumen de TODA la conversación para la ficha del lead en el CRM, en 2 a 4 frases: qué busca, sede y modalidad, qué se le ha dado (precio, prueba, alta) y en qué punto está.' },
        retomar: {
          type: 'object',
          description: 'Solo si el lead dice que lo decidirá o se apuntará más adelante (después de vacaciones, cuando cobre, en enero, cuando se recupere...). Programa volver a escribirle entonces.',
          additionalProperties: false,
          properties: {
            fecha: { type: 'string', description: 'AAAA-MM-DD en la que tiene sentido volver a escribirle según lo que ha dicho. Vacía si no da ninguna pista.' },
            motivo: { type: 'string', description: 'Lo que dijo, en pocas palabras (p. ej. «se apunta en septiembre, ahora está de vacaciones»).' },
          },
        },
      },
      // `sede` es obligatoria (con «desconocida» si aún no se sabe): si se deja opcional, el modelo a veces no la
      // manda aunque lleve toda la conversación hablando de una sede, y el contacto se queda sin etiquetar ni asignar.
      required: ['mensajes', 'fase', 'sede'],
    },
  },
];

let client;
const getClient = () => (client ??= new Anthropic({ apiKey: config.ai.apiKey }));

/**
 * Reglas que no se dejan al criterio del modelo. Devuelve el motivo si la respuesta no se debe enviar tal cual.
 * Hoy solo una: si enumera las sedes, El Cañaveral (próxima apertura, 1 feb 2027) tiene que estar en la lista.
 */
export function revisarRespuesta(input) {
  const t = (Array.isArray(input?.mensajes) ? input.mensajes : []).join(' ').toLowerCase();
  if (/parla/.test(t) && /getafe/.test(t) && /las rosas/.test(t) && !/ca[ñn]averal/.test(t)) {
    return 'No enviado: has enumerado las sedes sin El Cañaveral. Vuelve a llamar a `responder` con los mismos mensajes, nombrando las cuatro: Parla, Getafe, Las Rosas y El Cañaveral, que es nuestra próxima apertura el 1 de febrero de 2027.';
  }
  const textos = (Array.isArray(input?.mensajes) ? input.mensajes : []).filter((m) => !/^\[(imagen|audio|video|documento): /.test(String(m).trim()));
  if (textos.length > 3) {
    return `No enviado: son ${textos.length} burbujas y el máximo es 3. Vuelve a llamar a \`responder\` con 1 o 2 (3 solo si es imprescindible): quédate con lo que contesta a su mensaje y la pregunta que hace avanzar.`;
  }
  if (puntoEnMedio(input?.mensajes)) {
    return 'No enviado: una burbuja lleva un punto en medio («… de este chat. los documentos …»). Vuelve a llamar a `responder` con lo mismo, pero cada frase en su propia burbuja (o unidas con una coma), sin puntos.';
  }
  if (dosPreguntas(input?.mensajes)) {
    return 'No enviado: haces dos preguntas en el mismo turno. Vuelve a llamar a `responder` con una sola pregunta, la que más desbloquea, en la última burbuja; la otra, para el turno siguiente.';
  }
  return null;
}

/**
 * Los mensajes de `responder` como lista de textos. A veces el modelo manda la lista como texto (un JSON entre
 * comillas o burbujas separadas por saltos de línea) en vez de como lista: se convierte en lugar de fallar.
 */
export function comoLista(mensajes) {
  if (Array.isArray(mensajes)) return mensajes.map((m) => (typeof m === 'string' ? m : String(m ?? ''))).filter((m) => m.trim());
  if (typeof mensajes !== 'string' || !mensajes.trim()) return [];
  const t = mensajes.trim();
  try { const j = JSON.parse(t); if (Array.isArray(j)) return comoLista(j); } catch { /* no es JSON válido */ }
  // Parece una lista pero está mal formada (p. ej. «["a",["b"][0],"c"]»): se rescatan los textos entre comillas
  if (t.startsWith('[')) {
    const textos = [...t.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => { try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; } });
    if (textos.length) return comoLista(textos);
  }
  return t.split(/\n+/).map((m) => m.trim()).filter(Boolean);
}

/** Un punto que separa dos frases dentro de una burbuja (no cuentan «...», «p. ej.», «etc.» ni las direcciones «C.»/«Av.»). */
export function puntoEnMedio(mensajes) {
  return (Array.isArray(mensajes) ? mensajes : []).some((m) => /(?<![.\s])(?<!\b(?:p|ej|etc|av|avda|c|n|nº|sr|sra|dr|dra|tel))\.(?!\.)\s+\S/i.test(String(m).replace(/https?:\/\/\S+/g, '')));
}

/** Dos preguntas en un turno: dos «?» o una pregunta que engancha otra con «, y …» («cuántos días, y te va mejor mañana o tarde?»). */
export function dosPreguntas(mensajes) {
  const ms = (Array.isArray(mensajes) ? mensajes : []).filter((m) => !/^\[(imagen|audio|video|documento): /.test(String(m).trim()));
  const t = ms.join('\n');
  if ((t.match(/\?/g) || []).length > 1) return true;
  const ultima = t.split(/(?<=[.!\n])/).find((x) => x.includes('?')) || '';
  return /,\s*y\s+(qu[eé]|cu[aá]l|cu[aá]nt[oa]s?|cu[aá]ndo|c[oó]mo|d[oó]nde|te\s+(va|viene|vendr[ií]a|encaja|parece)|prefieres|puedes)\b/i.test(ultima);
}

/** Herramientas cuyo resultado tiene que ver Sofía antes de contestar (no se aceptan en el mismo paso que `responder`). */
export const ESPERAR_RESULTADO = ['preparar_alta', 'reservar_prueba_parla', 'calcular_primer_recibo', 'consultar_horarios', 'consultar_tarifas'];

/** Respaldo en el servidor si el modelo se niega. Haiku no lo tiene: con él se llama sin `fallbacks`. */
export const opcionesRespaldo = (modelo) => (/haiku/.test(modelo) ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });

/**
 * Ejecuta un turno: llama al modelo, resuelve herramientas y devuelve la entrada de `responder`.
 * `complete` se puede sustituir en tests.
 */
export async function runTurn({ system, messages, ejecutarHerramienta, complete, maxPasos = 6, onUsage, onHerramienta, modelo = config.ai.model, effort = config.ai.effort }) {
  // Sonnet 5.5 no admite forzar herramienta (tool_choice any/tool → 400): se pide en modo auto y, si contesta
  // en texto sin llamar a `responder`, se le recuerda una vez. Si el modelo se niega por seguridad, la API
  // reintenta con su modelo de respaldo (fallbacks "default").
  // Tiempo límite de 60 s por llamada (el SDK reintenta 2 veces los fallos de red, 429 y 5xx): una respuesta
  // normal tarda 4-8 s, y sin límite una llamada colgada bloquearía el chat hasta 10 minutos.
  const respaldo = opcionesRespaldo(modelo);
  const llamar = complete || ((req) => getClient().beta.messages.create({ ...req, ...respaldo }, { timeout: 60000, maxRetries: 2 }));
  const conv = [...messages];
  let recordatorios = 0; let correcciones = 0; let esperas = 0;
  for (let paso = 0; paso < maxPasos; paso++) {
    const t0 = Date.now();
    const res = await llamar({
      model: modelo,
      max_tokens: 8000, // el razonamiento interno (siempre activo en este modelo) cuenta dentro de este límite
      ...(effort ? { output_config: { effort } } : {}),
      system,
      tools: TOOLS,
      tool_choice: { type: 'auto' },
      messages: conv,
    });
    // Una fila por intento facturable (modelo real, caché por duración, coste ya calculado)
    for (const f of usosDe(res, modelo)) onUsage?.(f, Date.now() - t0);
    if (res.stop_reason === 'refusal') throw new Error(`El modelo se ha negado a responder (${res.stop_details?.category || 'sin categoría'})`);
    if (res.stop_reason === 'max_tokens') throw new Error('La respuesta del modelo se cortó por longitud'); // una herramienta a medias no se ejecuta
    const usos = (res.content || []).filter((b) => b.type === 'tool_use');
    const final = usos.find((u) => u.name === 'responder');
    if (final?.input) final.input = { ...final.input, mensajes: comoLista(final.input.mensajes) };
    // Comprobación fija antes de enviar: si falla, se le devuelve al modelo una vez para que lo corrija
    const pega = final && usos.length === 1 && correcciones < 1 ? revisarRespuesta(final.input) : null;
    if (pega) {
      correcciones++;
      conv.push({ role: 'assistant', content: res.content });
      conv.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: final.id, content: pega, is_error: true }] });
      continue;
    }
    // `responder` a la vez que una herramienta cuyo resultado necesita (el alta, la reserva, horarios, precios): lo
    // habría escrito sin verlo («ya está tu alta en marcha»). Se ejecuta la herramienta y se le pide contestar después.
    const prisa = final && esperas < 2 && usos.filter((u) => ESPERAR_RESULTADO.includes(u.name));
    if (prisa?.length) {
      esperas++;
      conv.push({ role: 'assistant', content: res.content });
      const resultados = [];
      for (const u of usos) {
        if (u === final || u.name === 'responder') {
          resultados.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: `No enviado: has contestado antes de ver el resultado de ${prisa.map((x) => `\`${x.name}\``).join(', ')}. Mira el resultado y vuelve a llamar a \`responder\` una sola vez, con lo que ha pasado de verdad.` });
          continue;
        }
        let out;
        try { out = await ejecutarHerramienta(u.name, u.input); } catch (e) { out = { ok: false, error: e.message }; }
        onHerramienta?.({ nombre: u.name, entrada: u.input, resultado: out });
        resultados.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out) });
      }
      conv.push({ role: 'user', content: resultados });
      continue;
    }
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
  for (const f of usosDe(res, modelo)) onUsage?.(f);
  if (res.stop_reason === 'refusal') throw new Error('El modelo se ha negado a analizarlo');
  if (res.stop_reason === 'max_tokens') throw new Error('La respuesta del modelo se cortó');
  const texto = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  try { return JSON.parse(texto); } catch { throw new Error('El modelo no devolvió un JSON válido'); }
}

/** Llamada de texto simple (el lead simulado de la batería de pruebas). */
export async function pedirTexto({ system, messages, modelo = config.ai.modeloLead, complete, onUsage }) {
  const llamar = complete || ((req) => getClient().messages.create(req, { timeout: 60000, maxRetries: 2 }));
  const res = await llamar({ model: modelo, max_tokens: 2000, system, messages });
  for (const f of usosDe(res, modelo)) onUsage?.(f);
  return (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

/** Bloques de sistema con caché: el prompt y la base de conocimiento casi no cambian. */
export function systemBlocks(prompt, negocio, contexto, ttl = config.ai.cacheTtl) {
  // Caché de 1 h por defecto: escribirla cuesta el doble que la de 5 min, pero entre mensajes de leads suele haber
  // más de 5 min y, sin ella, cada respuesta volvería a pagar los ~11.000 tokens del prompt y la base.
  const cache = ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
  return [
    { type: 'text', text: prompt },
    { type: 'text', text: `# Base de conocimiento\n\n${negocio}`, cache_control: cache },
    { type: 'text', text: contexto },
  ];
}
