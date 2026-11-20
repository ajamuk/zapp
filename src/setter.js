import { config } from './config.js';
import { knowledge, consultarHorarios, consultarTarifas, calcularPrimerRecibo, normalizarSede } from './knowledge.js';
import { runTurn, systemBlocks } from './llm.js';
import { leerAjustes } from './ajustes.js';
import { dentroDeHorario, siguienteApertura, hoyLocal, retardoHumano, esperar } from './horario.js';

const TAGS = knowledge.etiquetas;
const SIN_RESPUESTA = /^\s*\[(story_mention|ig_post|ig_reel|reaction)\]\s*$/i;
const SEDE_NOMBRE = { parla: 'Parla', getafe: 'Getafe', las_rosas: 'Las Rosas', el_canaveral: 'El Cañaveral' };

/**
 * Cerebro del setter. Todas las dependencias se inyectan para poder probarlo sin red.
 * - repo: acceso a SQLite (db.js)
 * - ghl: cliente de GoHighLevel (ghl.js)
 * - aimharder: { buscarSocioPorTelefono, prepararAlta }
 * - avisar(texto, {sede}): aviso al equipo (Telegram)
 * - complete: sustituto de la llamada al modelo (tests)
 */
export class Setter {
  constructor({ repo, ghl, aimharder, avisar, complete, now = () => new Date(), sleep = esperar, live = config.mode === 'live', random = Math.random }) {
    Object.assign(this, { repo, ghl, aimharder, avisar, complete, now, sleep, live, random });
  }

  // ---------- Entrada ----------

  async handleWebhook(evt) {
    if (!evt.conversationId || !evt.contactId) return { ignorado: 'faltan ids' };
    if (evt.evento === 'outbound') return this.onOutbound(evt);
    return this.onInbound(evt);
  }

  async onOutbound(evt) {
    // Mensajes que envía el propio sistema ya están registrados (mismo external_id) → se ignoran.
    if (!evt.userId) return { ignorado: 'saliente sin usuario (sistema o plantilla)' };
    const conv = this.repo.getConv(evt.conversationId);
    if (!conv) return { ignorado: 'conversación desconocida' };
    const ins = this.repo.addMessage({ conversation_id: conv.id, external_id: evt.messageId, autor: 'humano', texto: evt.texto });
    if (!ins) return { ignorado: 'duplicado' };
    // Si una persona del equipo escribe, la IA se aparta de esa conversación.
    this.repo.updateConv(conv.id, { ai_paused: 1, pause_reason: 'humano escribió', respond_at: null });
    this.repo.cancelScheduled(conv.id, 'humano escribió');
    return { pausada: true };
  }

  async onInbound(evt) {
    const conv = this.repo.upsertConv({ id: evt.conversationId, contact_id: evt.contactId, channel: evt.canal, nombre: evt.nombre, telefono: evt.telefono });
    const ins = this.repo.addMessage({ conversation_id: conv.id, external_id: evt.messageId, autor: 'lead', texto: evt.texto || (evt.adjuntos?.length ? '[adjunto]' : '') });
    if (!ins) return { ignorado: 'duplicado' };
    const ahora = this.now();
    this.repo.updateConv(conv.id, { last_inbound_at: ahora.toISOString() });
    this.repo.cancelScheduled(conv.id, 'el lead escribió');

    // Etiquetas de control puestas a mano en GHL
    const tags = (evt.tags || []).map((t) => String(t).toLowerCase());
    if (tags.includes(TAGS.control.reanudar_ia) && conv.ai_paused) {
      this.repo.updateConv(conv.id, { ai_paused: 0, pause_reason: null, derivado: 0 });
      await this.safe(() => this.ghl.removeTags(conv.contact_id, [TAGS.control.reanudar_ia]));
    } else if (tags.includes(TAGS.control.pausar_ia)) {
      this.repo.updateConv(conv.id, { ai_paused: 1, pause_reason: 'etiqueta parar ia' });
    }

    // ¿Socio o lead? Solo la primera vez.
    if (!conv.tipo) {
      const tipo = await this.clasificar(conv, evt);
      if (tipo === 'socio') return { socio: true };
    }

    const actual = this.repo.getConv(conv.id);
    if (actual.ai_paused || actual.derivado) return { pausada: true };
    if (SIN_RESPUESTA.test(evt.texto || '')) return { ignorado: 'mención o reacción' };

    // Retardo humano; cada mensaje nuevo reinicia la espera para contestar todo junto.
    const { lectura } = retardoHumano([], { random: this.random });
    let cuando = new Date(ahora.getTime() + lectura);
    if (!dentroDeHorario(cuando)) cuando = siguienteApertura(cuando);
    this.repo.updateConv(conv.id, { respond_at: cuando.toISOString() });
    return { programada: cuando.toISOString() };
  }

  async clasificar(conv, evt) {
    let telefono = conv.telefono || evt.telefono;
    if (!telefono) {
      const c = await this.safe(() => this.ghl.getContact(conv.contact_id));
      telefono = c?.contact?.phone || null;
      if (telefono) this.repo.updateConv(conv.id, { telefono });
    }
    let socio = { esSocio: false };
    if (telefono) socio = (await this.safe(() => this.aimharder.buscarSocioPorTelefono(telefono))) || { esSocio: false };
    if (socio.esSocio) {
      const sede = normalizarSede(socio.sede);
      this.repo.updateConv(conv.id, { tipo: 'socio', sede, ai_paused: 1, pause_reason: 'socio' });
      const etiquetas = [TAGS.tipo.socio, TAGS.tareas.gestion_socio, sede && TAGS.sedes[sede]?.tag].filter(Boolean);
      await this.safe(() => this.ghl.addTags(conv.contact_id, etiquetas));
      if (sede) await this.safe(() => this.ghl.assign(conv.contact_id, config.ghl.users[sede]));
      await this.avisar?.(`Socio escribe${sede ? ` (${SEDE_NOMBRE[sede]})` : ''}: «${(evt.texto || '').slice(0, 200)}»`, { sede });
      return 'socio';
    }
    this.repo.updateConv(conv.id, { tipo: 'captacion' });
    await this.safe(() => this.ghl.addTags(conv.contact_id, [TAGS.tipo.captacion, ...(socio.exSocio ? ['exsocio'] : [])]));
    return 'captacion';
  }

  // ---------- Respuesta ----------

  /** Procesa las conversaciones cuya respuesta toca ya. Lo llama el bucle de index.js. */
  async tick() {
    const ahora = this.now();
    const ajustes = leerAjustes(this.repo);
    for (const c of this.repo.dueResponses(ahora.toISOString())) {
      this.repo.updateConv(c.id, { respond_at: null });
      // Sofía apagada (o el canal) desde el panel: contesta el equipo en GHL
      if (!ajustes.ia_activa || !ajustes.canales[c.channel]) continue;
      try { await this.responder(c.id); } catch (e) { console.error(`Error respondiendo ${c.id}:`, e); }
    }
  }

  contexto(conv, extra = '') {
    const hoy = hoyLocal(this.now());
    return [
      '# Contexto de esta conversación',
      `- Hoy es ${hoy.dia} ${hoy.iso} (hora de Madrid).`,
      `- Canal: ${conv.channel}.`,
      `- Nombre del perfil: ${conv.nombre || 'desconocido'}.`,
      `- Sede conocida: ${conv.sede ? SEDE_NOMBRE[conv.sede] : 'aún no'}.`,
      `- Alta: ${conv.alta_estado || 'no iniciada'}. Prueba de Parla solicitada: ${conv.prueba_reservada ? 'sí' : 'no'}.`,
      extra,
    ].filter(Boolean).join('\n');
  }

  /** Convierte el historial al formato del modelo (turnos alternos, empezando por el lead). */
  mensajesModelo(historial) {
    const out = [];
    for (const m of historial) {
      const role = m.autor === 'lead' ? 'user' : 'assistant';
      const texto = m.autor === 'humano' ? `[escrito por una persona del equipo] ${m.texto}` : m.texto;
      if (!texto) continue;
      const last = out[out.length - 1];
      if (last && last.role === role) last.content += `\n${texto}`;
      else out.push({ role, content: texto });
    }
    if (!out.length || out[0].role !== 'user') out.unshift({ role: 'user', content: '(el lead abrió la conversación)' });
    if (out[out.length - 1].role !== 'user') out.push({ role: 'user', content: '(sin mensaje nuevo del lead)' });
    return out;
  }

  async responder(convId, { extraContexto = '', motivo = 'respuesta', plantilla = null } = {}) {
    const conv = this.repo.getConv(convId);
    if (!conv || conv.ai_paused || conv.derivado) return null;
    const system = systemBlocks(knowledge.prompt, knowledge.negocio, this.contexto(conv, extraContexto));
    const messages = this.mensajesModelo(this.repo.history(convId));
    const efectos = { tags: new Set(), derivado: false };

    let respuesta;
    try {
      ({ respuesta } = await runTurn({
        system, messages, complete: this.complete,
        ejecutarHerramienta: (n, i) => this.herramienta(conv, n, i, efectos),
        onUsage: (u, ms) => this.repo.logRun({
          conversation_id: convId, motivo, modelo: config.ai.model, ms,
          tokens_in: u.input_tokens || 0, tokens_out: u.output_tokens || 0,
          tokens_cache_read: u.cache_read_input_tokens || 0, tokens_cache_write: u.cache_creation_input_tokens || 0,
        }),
      }));
    } catch (e) {
      this.repo.logRun({ conversation_id: convId, motivo, modelo: config.ai.model, error: e.message });
      await this.avisar?.(`La IA falló en una conversación y no ha contestado: ${e.message}`, { sede: conv.sede });
      throw e;
    }

    await this.aplicarRespuesta(conv, respuesta, efectos);
    let mensajes = (respuesta.mensajes || []).map((m) => m.trim()).filter(Boolean);
    if (plantilla) mensajes = mensajes.slice(0, 1);
    if (mensajes.length) await this.enviar(conv, mensajes, plantilla);
    if (efectos.avisoAlta) await this.enviarAvisoAlta(conv, efectos.avisoAlta);
    if (motivo === 'respuesta' && mensajes.length && !efectos.derivado && this.live) this.programarSeguimientos(conv);
    return { ...respuesta, mensajes };
  }

  async aplicarRespuesta(conv, r, efectos) {
    const patch = {};
    if (r.fase) patch.fase = r.fase;
    const sede = r.sede && r.sede !== 'desconocida' ? normalizarSede(r.sede) : null;
    if (sede && sede !== conv.sede) {
      patch.sede = sede;
      efectos.tags.add(TAGS.sedes[sede].tag);
      await this.safe(() => this.ghl.assign(conv.contact_id, config.ghl.users[sede]));
    }
    if (r.fase && r.fase !== 'cerrada') efectos.tags.add(r.fase);
    for (const t of r.etiquetas || []) efectos.tags.add(String(t).toLowerCase());
    if (Object.keys(patch).length) this.repo.updateConv(conv.id, patch);
    // Quita la fase anterior para que solo quede una etiqueta de embudo
    const viejas = TAGS.embudo.filter((f) => f !== r.fase && conv.fase === f);
    if (viejas.length) await this.safe(() => this.ghl.removeTags(conv.contact_id, viejas));
    if (efectos.tags.size) await this.safe(() => this.ghl.addTags(conv.contact_id, [...efectos.tags]));
  }

  async enviar(conv, mensajes, plantilla = null) {
    const { escritura } = retardoHumano(mensajes, { random: this.random });
    if (!this.live) {
      // Modo prueba: nada sale hacia el lead; queda una nota interna en GHL para comparar.
      await this.safe(() => this.ghl.addNote(conv.contact_id, `[Borrador IA, no enviado${plantilla ? ', plantilla' : ''}]\n${mensajes.join('\n')}`));
      for (const m of mensajes) this.repo.addMessage({ conversation_id: conv.id, autor: 'ia', texto: m, enviado: 0 });
      return [];
    }
    if (plantilla) {
      const r = await this.ghl.sendTemplate({ contactId: conv.contact_id, plantilla: plantilla.nombre, variables: [mensajes[0]] });
      this.repo.addMessage({ conversation_id: conv.id, external_id: r?.messageId || null, autor: 'ia', texto: mensajes[0], tipo: 'plantilla' });
      this.repo.updateConv(conv.id, { last_ai_at: this.now().toISOString() });
      return [r?.messageId || null];
    }
    const ids = [];
    for (let i = 0; i < mensajes.length; i++) {
      await this.sleep(escritura[i]);
      const r = await this.ghl.sendMessage({ contactId: conv.contact_id, canal: conv.channel, texto: mensajes[i] });
      this.repo.addMessage({ conversation_id: conv.id, external_id: r?.messageId || null, autor: 'ia', texto: mensajes[i] });
      ids.push(r?.messageId || null);
    }
    this.repo.updateConv(conv.id, { last_ai_at: this.now().toISOString() });
    return ids;
  }

  /** Aviso del alta al lead, y comprobación de que el mensaje ha salido al chat. */
  async enviarAvisoAlta(conv, mensajes) {
    try {
      const ids = await this.enviar(conv, mensajes);
      if (this.live && (!ids || ids.length < mensajes.length || ids.some((x) => !x))) throw new Error('GHL no devolvió el id de algún mensaje');
    } catch (e) {
      await this.avisar?.(`El alta está hecha pero el aviso al lead no se ha podido comprobar en el chat: ${e.message}. Revisar la conversación.`, { sede: conv.sede });
    }
  }

  programarSeguimientos(conv) {
    if (String(conv.id).startsWith('prueba-')) return; // chat de pruebas: sin seguimientos reales
    const base = this.now().getTime();
    const activos = leerAjustes(this.repo).seguimientos;
    for (const regla of knowledge.followups.reglas) {
      if (!regla.canales.includes(conv.channel) || !activos[regla.id]) continue;
      this.repo.schedule(conv.id, regla.id, new Date(base + regla.minutos * 60000).toISOString());
    }
  }

  // ---------- Herramientas ----------

  async herramienta(conv, nombre, input, efectos) {
    switch (nombre) {
      case 'consultar_horarios': return consultarHorarios(input);
      case 'consultar_tarifas': return consultarTarifas(input);
      case 'calcular_primer_recibo': return calcularPrimerRecibo(input);
      case 'preparar_alta': return this.alta(conv, input, efectos);
      case 'reservar_prueba_parla': {
        efectos.tags.add(TAGS.tareas.prueba_parla);
        this.repo.updateConv(conv.id, { prueba_reservada: 1 });
        await this.avisar?.(`Prueba en Parla pedida: ${input.modalidad} · ${input.fecha_hora}. Confirmar en el calendario y avisar al lead.`, { sede: 'parla' });
        return { ok: true, estado: 'solicitada', nota: 'Dile que se la dejas apuntada y que el equipo se la confirma por aquí. Es sin coste.' };
      }
      case 'derivar_a_equipo': {
        efectos.derivado = true;
        const tarea = { salud: TAGS.tareas.derivado_salud, gestion_socio: TAGS.tareas.gestion_socio, cobro: TAGS.tareas.pago_por_verificar, llamada: TAGS.tareas.llamar, visita: TAGS.tareas.visita }[input.motivo] || TAGS.tareas.responder;
        efectos.tags.add(tarea);
        this.repo.updateConv(conv.id, { derivado: 1, ai_paused: 1, pause_reason: `derivado: ${input.motivo}` });
        this.repo.cancelScheduled(conv.id, 'derivado');
        await this.avisar?.(`Derivado (${input.motivo})${conv.sede ? ` · ${SEDE_NOMBRE[conv.sede]}` : ''}: ${input.resumen}`, { sede: conv.sede });
        return { ok: true, nota: 'Avisa al lead de que lo revisa una persona del equipo y que le escribirá por aquí. No sigas vendiendo.' };
      }
      default: return { ok: false, error: `Herramienta desconocida: ${nombre}` };
    }
  }

  async alta(conv, datos, efectos) {
    const sede = normalizarSede(datos.sede);
    const telefono = datos.telefono || conv.telefono || '';
    const d = { ...datos, sede, telefono, canal: conv.channel };
    delete d.avisar_lead;
    // Antiguo socio en esa sede: se reutiliza su ficha
    const ficha = await this.safe(() => this.aimharder.fichaEnSede?.(telefono, sede));
    if (ficha?.aimharder_id) d.aimharder_id = ficha.aimharder_id;
    const recibo = calcularPrimerRecibo({ sede, tarifa: d.tarifa, fecha_inicio: d.fecha_inicio });
    if (recibo.ok) d.primer_recibo = recibo.primer_recibo;
    const res = await this.aimharder.prepararAlta(d);
    this.repo.addAlta(conv.id, d, res.estado, res.detalle);
    if (res.estado === 'rechazada') return { ok: false, error: res.detalle, nota: 'Pide solo el dato que falta o corrige el que está mal. Si es menor de 16 años, explícale con cariño que la edad mínima para entrenar es 16.' };
    if (res.estado === 'preparada') {
      this.repo.updateConv(conv.id, { alta_estado: 'preparada' });
      efectos.tags.add(TAGS.tareas.alta_preparada);
      if (res.exSocio) efectos.tags.add('exsocio');
      await this.avisar?.(`Alta ${res.exSocio ? 'de antiguo socio (ficha reutilizada) ' : ''}verificada en AimHarder: ${d.nombre_completo} · ${SEDE_NOMBRE[sede]} · ${res.tarifa || d.tarifa} · inicio ${d.fecha_inicio} · ${res.pendiente} € pendiente\n${res.detalle}`, { sede });
      const avisar = datos.avisar_lead !== false;
      if (avisar) efectos.avisoAlta = mensajesAlta({ ...res, sede, fecha_inicio: d.fecha_inicio, email: d.email });
      return {
        ok: true, estado: 'preparada', ex_socio: Boolean(res.exSocio), sede: SEDE_NOMBRE[sede], fecha_inicio: d.fecha_inicio,
        pendiente_verificado: res.pendiente,
        nota: avisar
          ? 'El sistema ya le envía el aviso del alta con la sede, la fecha, la app, los documentos y el importe pendiente. Tú no repitas esos datos: como mucho una frase corta de bienvenida, o nada.'
          : 'Alta preparada sin avisar al lead (lo ha pedido el equipo). No le digas nada del alta.',
      };
    }
    // Simulada (dry run), ficha existente sin localizar, sin configurar o fallida: el equipo la termina a mano.
    this.repo.updateConv(conv.id, { alta_estado: 'pendiente' });
    efectos.tags.add(res.estado === 'fallida' ? TAGS.tareas.alta_fallida : TAGS.tareas.responder);
    if (res.estado === 'existente') efectos.tags.add('exsocio');
    await this.avisar?.(
      `Alta para terminar a mano (${res.estado}): ${d.nombre_completo} · ${d.email} · tel. ${telefono} · nac. ${d.fecha_nacimiento} · ${SEDE_NOMBRE[sede]} · ${d.tarifa} · inicio ${d.fecha_inicio}` +
      (recibo.ok ? ` · prorrateo previsto ${recibo.primer_recibo} €` : '') + `\n${res.detalle}\nProcedimiento: TPV RedSys, prorrateo de AimHarder, primer recibo emitido hoy, sin matrícula ni promociones.`,
      { sede },
    );
    return { ok: true, estado: 'pendiente_equipo', nota: 'El equipo termina de tramitar el alta. Dile que en cuanto esté le llega la invitación de AimHarder al correo y le avisamos por aquí. No digas que ya está hecha ni des importes.' };
  }

  async safe(fn) {
    try { return await fn(); } catch (e) { console.error('[aviso]', e.message); return null; }
  }
}

const fechaLarga = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const euros = (n) => `${Number(n).toFixed(2).replace('.', ',').replace(',00', '')} €`;

/** Mensajes del aviso de alta, con el estilo de Sofía (sin mayúscula inicial ni puntos). */
export function mensajesAlta({ sede, fecha_inicio, email, pendiente, exSocio }) {
  const donde = `${SEDE_NOMBRE[sede] || sede}`;
  const m = [`listo, ya tienes el alta hecha en ${donde} para empezar el ${fechaLarga(fecha_inicio)}`];
  if (exSocio) {
    m.push(`como ya habías estado con nosotros he usado tu ficha de siempre y te he reenviado la invitación a ${email}`);
    m.push('entra en la app CrossFit MetroPolitano con ese email, y si no recuerdas la contraseña dale a recuperarla en la propia app');
  } else {
    m.push(`te acaba de llegar un correo a ${email} con tu contraseña, míralo también en spam por si acaso`);
    m.push('descárgate la app CrossFit MetroPolitano y entra con ese email y la contraseña del correo');
  }
  m.push(`antes de tu primera clase firma los documentos y paga el primer recibo desde la app${pendiente ? `, son ${euros(pendiente)}` : ''}`);
  return m;
}
