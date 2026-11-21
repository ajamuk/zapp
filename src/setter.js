import { config } from './config.js';
import { knowledge, consultarHorarios, consultarTarifas, calcularPrimerRecibo, ofertaCanaveral, normalizarSede, normalizarModalidad } from './knowledge.js';
import { pagoCanaveral } from './knowledge.js';
import { validarDatos } from './aimharder/alta-navegador.js';
import { plazasCanaveral } from './canaveral.js';
import { runTurn, systemBlocks } from './llm.js';
import { leerAjustes } from './ajustes.js';
import { dentroDeHorario, siguienteApertura, hoyLocal, retardoHumano, esperar } from './horario.js';
import { tipoAdjunto } from './etiquetas.js';
import * as mediosReales from './medios.js';
import * as reglasSeg from './reglas.js';
import { programarCita } from './followups.js';
import { textosActivos, versionesActivas } from './documentos.js';
import { textoFestivos } from './knowledge.js';
import * as recursos from './recursos.js';

const TAGS = knowledge.etiquetas;
/** Devuelve la palabra o frase de la lista que aparece en el texto (sin tildes ni mayúsculas, palabra completa). */
export function contienePalabra(texto, lista = []) {
  const n = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const t = ` ${n(texto).replace(/[^a-z0-9#ñ@]+/g, ' ')} `;
  return lista.find((p) => p && t.includes(` ${n(p).replace(/[^a-z0-9#ñ@]+/g, ' ').trim()} `)) || null;
}
const ESPERAS_REINTENTO = [2 * 60000, 5 * 60000]; // si falla la IA o GHL: reintento a los 2 y a los 5 minutos
const SIN_RESPUESTA =/^\s*\[(story_mention|ig_post|ig_reel|reaction)\]\s*$/i;
// Canales que GHL recibe de forma nativa. Lo demás (p. ej. «SMS personalizado») son copias que mete un conector
// externo: en la cuenta hay un «WA1 Connector» que repite cada WhatsApp, y además trae los grupos.
const CANALES_NATIVOS = new Set(['whatsapp', 'instagram', 'messenger']);
/** Texto comparable de un mensaje: sin la firma que añade el conector, sin espacios de más y en minúsculas. */
export function textoComparable(t) {
  return String(t || '').split('\n').filter((l) => !/^\s*(💬|☑️)|^\s*(sent from|received on|from other device)\b/i.test(l))
    .join(' ').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 120);
}
const SEDE_NOMBRE = { parla: 'Parla', getafe: 'Getafe', las_rosas: 'Las Rosas', el_canaveral: 'El Cañaveral' };

/**
 * Cerebro del setter. Todas las dependencias se inyectan para poder probarlo sin red.
 * - repo: acceso a SQLite (db.js)
 * - ghl: cliente de GoHighLevel (ghl.js)
 * - aimharder: { buscarSocioPorTelefono, prepararAlta }
 * - avisar(texto, {sede}): aviso al equipo (Telegram)
 * - complete: sustituto de la llamada al modelo (tests)
 * - etiquetas: Etiquetador (etiquetas.js) para reglas, criterios de IA y acciones (opcional)
 */
export class Setter {
  constructor({ repo, ghl, aimharder, avisar, complete, etiquetas = null, medios = mediosReales, catalogo = null, borradores = null, now = () => new Date(), sleep = esperar, live = config.mode === 'live', random = Math.random }) {
    // catalogo: base con las reglas de seguimiento y etiquetas (en Probar IA, la real; los chats van a otra)
    Object.assign(this, { repo, ghl, aimharder, avisar, complete, etiquetas, medios, catalogo: catalogo || repo.db, borradores, now, sleep, live, random });
  }

  // ---------- Entrada ----------

  async handleWebhook(evt) {
    // Cambio de tags en GHL (evento ContactTagUpdate): se reflejan en las etiquetas del panel
    if (evt.evento === 'tags') return (await this.safe(() => this.etiquetas?.sincronizarContacto(evt.contactId, evt.tags))) || { ignorado: 'sin etiquetas' };
    if (!evt.conversationId || !evt.contactId) return { ignorado: 'faltan ids' };
    const copia = !CANALES_NATIVOS.has(evt.canal);
    if (evt.evento === 'outbound') {
      // El mismo mensaje llega dos veces (nativo y copia del conector, en cualquier orden): solo cuenta el primero.
      // Así la copia de un mensaje de Sofía tampoco la toma por una persona del equipo.
      if (this.yaRegistrado(evt)) return { ignorado: 'copia de un mensaje ya registrado' };
      // Lo escrito desde el móvil solo llega por el conector: se trata como un mensaje del equipo.
      return this.onOutbound(evt);
    }
    if (copia) return { ignorado: 'copia de un conector (no es WhatsApp ni Instagram nativo)' };
    return this.onInbound(evt);
  }

  /** ¿Hay en este chat, en los últimos 10 minutos, un mensaje nuestro (de Sofía o del equipo) con el mismo texto? */
  yaRegistrado(evt) {
    const t = textoComparable(evt.texto);
    if (!t) return false;
    const desde = new Date(Date.now() - 10 * 60000).toISOString();
    return this.repo.db.prepare("SELECT texto FROM messages WHERE conversation_id = ? AND autor IN ('ia', 'humano') AND created_at >= ? AND (external_id IS NULL OR external_id != ?)")
      .all(evt.conversationId, desde, evt.messageId || '').some((m) => textoComparable(m.texto) === t);
  }

  async onOutbound(evt) {
    // Mensajes que envía el propio sistema ya están registrados (mismo external_id) → se ignoran.
    if (!evt.userId) return { ignorado: 'saliente sin usuario (sistema o plantilla)' };
    const conv = this.repo.getConv(evt.conversationId);
    if (!conv) return { ignorado: 'conversación desconocida' };
    const ins = this.repo.addMessage({ conversation_id: conv.id, external_id: evt.messageId, autor: 'humano', texto: evt.texto, adjunto: tipoAdjunto(evt.adjuntos) });
    if (!ins) return { ignorado: 'duplicado' };
    await this.safe(() => this.etiquetas?.alMensaje(conv.id, { autor: 'humano', texto: evt.texto, adjunto: tipoAdjunto(evt.adjuntos) }));
    const ajustes = leerAjustes(this.repo);
    // Palabra para reanudar (p. ej. «#sofia»): Sofía vuelve a contestar en este chat
    if (contienePalabra(evt.texto, ajustes.palabrasReanudar)) {
      this.repo.updateConv(conv.id, { ai_paused: 0, derivado: 0, pause_reason: null });
      return { reanudada: true };
    }
    // Si una persona del equipo escribe (o usa una palabra para parar), la IA se aparta de esa conversación.
    const parar = contienePalabra(evt.texto, ajustes.palabrasParar);
    if (!ajustes.pausarSiEquipoEscribe && !parar) return { registrado: true };
    this.repo.updateConv(conv.id, { ai_paused: 1, pause_reason: parar ? `el equipo escribió «${parar}»` : 'humano escribió', respond_at: null });
    this.repo.cancelScheduled(conv.id, 'humano escribió');
    return { pausada: true };
  }

  async onInbound(evt) {
    const nuevo = !this.repo.getConv(evt.conversationId);
    const conv = this.repo.upsertConv({ id: evt.conversationId, contact_id: evt.contactId, channel: evt.canal, nombre: evt.nombre, telefono: evt.telefono });
    const ajustesC = leerAjustes(this.repo);
    if (nuevo && ajustesC.canalesPausa[conv.channel]) this.repo.updateConv(conv.id, { ai_paused: 1, pause_reason: `los chats de ${conv.channel} empiezan en pausa` });
    const pararLead = contienePalabra(evt.texto, ajustesC.palabrasParar);
    if (pararLead) this.repo.updateConv(conv.id, { ai_paused: 1, pause_reason: `el lead escribió «${pararLead}»`, respond_at: null });
    let adjunto = tipoAdjunto(evt.adjuntos);
    const ins = this.repo.addMessage({ conversation_id: conv.id, external_id: evt.messageId, autor: 'lead', texto: evt.texto || (adjunto ? `[${adjunto}]` : ''), adjunto });
    if (!ins) return { ignorado: 'duplicado' };
    // Audios e imágenes: se descargan y los audios se transcriben antes de que Sofía conteste
    let transcripcion = null;
    if (evt.adjuntos?.length || evt.subida) {
      // Mientras se descarga y transcribe, el bucle no contesta este chat (si no, diría «no he podido oír el audio»)
      this.mediosEnCurso ??= new Map();
      this.mediosEnCurso.set(conv.id, (this.mediosEnCurso.get(conv.id) || 0) + 1);
      let m;
      try { m = evt.subida || (await this.safe(() => this.medios.procesarAdjuntos(evt.adjuntos))); }
      finally { const n = this.mediosEnCurso.get(conv.id) - 1; if (n > 0) this.mediosEnCurso.set(conv.id, n); else this.mediosEnCurso.delete(conv.id); }
      if (m) {
        adjunto = m.adjunto; transcripcion = m.transcripcion;
        this.repo.updateMessage(ins.lastInsertRowid, { adjunto: m.adjunto, media_ruta: m.media_ruta, media_mime: m.media_mime, transcripcion: m.transcripcion, media_error: m.media_error, ...(evt.texto ? {} : { texto: `[${m.adjunto}]` }) });
      }
    }
    const ahora = this.now();
    this.repo.updateConv(conv.id, { last_inbound_at: ahora.toISOString() });
    this.repo.cancelScheduled(conv.id, 'el lead escribió', { soloCortos: true }); // los de largo plazo los revisa Sofía antes de enviar

    // Etiquetas de control puestas a mano en GHL
    const tags = (evt.tags || []).map((t) => String(t).toLowerCase());
    if (tags.includes(TAGS.control.reanudar_ia) && conv.ai_paused) {
      this.repo.updateConv(conv.id, { ai_paused: 0, pause_reason: null, derivado: 0 });
      await this.safe(() => this.ghl.removeTags(conv.contact_id, [TAGS.control.reanudar_ia]));
    } else if (tags.includes(TAGS.control.pausar_ia)) {
      this.repo.updateConv(conv.id, { ai_paused: 1, pause_reason: 'etiqueta parar ia' });
    }
    // Tags que trae el webhook: las etiquetas del panel se ajustan a GHL
    if (Array.isArray(evt.tags)) await this.safe(() => this.etiquetas?.sincronizarContacto(conv.contact_id, evt.tags));
    // Etiquetas por reglas de texto/adjunto (pueden pausar, derivar o forzar la respuesta)
    await this.safe(() => this.etiquetas?.alMensaje(conv.id, { autor: 'lead', texto: [evt.texto, transcripcion].filter(Boolean).join(' '), adjunto }));

    // ¿Socio o lead? Solo la primera vez.
    if (!conv.tipo) {
      const tipo = await this.clasificar(conv, evt);
      if (tipo === 'socio') return { socio: true };
    }

    const actual = this.repo.getConv(conv.id);
    if (actual.ai_paused || actual.derivado) return { pausada: true };
    if (SIN_RESPUESTA.test(evt.texto || '') && !adjunto) return { ignorado: 'mención o reacción' };

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
  /**
   * Varios chats a la vez (hasta `maxParalelo`): la espera de «escribiendo…» de uno no retrasa a los demás.
   * Cada chat se marca `respondiendo_desde` mientras se atiende; si el servicio se reinicia a mitad, al arrancar
   * se vuelve a poner en cola (arranque.js). Si la IA o GHL fallan, se reintenta a los 2 y a los 5 minutos.
   */
  async tick() {
    this.enCurso ??= new Set();
    const libres = (this.maxParalelo || 4) - this.enCurso.size;
    if (libres <= 0) return;
    const ahora = this.now();
    this.ultimoTick = Date.now();
    const ajustes = leerAjustes(this.repo);
    const tanda = this.repo.dueResponses(ahora.toISOString()).filter((c) => !this.enCurso.has(c.id) && !this.mediosEnCurso?.has(c.id)).slice(0, libres);
    await Promise.all(tanda.map((c) => this.atender(c, ajustes)));
  }

  async atender(c, ajustes) {
    // Sofía apagada (o el canal) desde el panel: contesta el equipo en GHL
    if (!ajustes.ia_activa || !ajustes.canales[c.channel]) { this.repo.updateConv(c.id, { respond_at: null }); return; }
    this.enCurso.add(c.id);
    this.repo.updateConv(c.id, { respond_at: null, respondiendo_desde: this.now().toISOString() });
    const reintentos = c.reintentos || 0;
    const ultimo = reintentos >= ESPERAS_REINTENTO.length;
    let reloj;
    try {
      // Tope de seguridad: ningún chat ocupa un hueco más de 5 minutos
      await Promise.race([
        this.responder(c.id, { avisarFallo: ultimo }),
        new Promise((_, mal) => { reloj = setTimeout(() => mal(new Error('la respuesta ha tardado más de 5 minutos')), 5 * 60000); reloj.unref?.(); }),
      ]);
      this.repo.updateConv(c.id, { respondiendo_desde: null, reintentos: 0 });
    } catch (e) {
      console.error(`Error respondiendo ${c.id} (intento ${reintentos + 1}):`, e.message);
      const actual = this.repo.getConv(c.id);
      const patch = { respondiendo_desde: null };
      // Se reintenta solo si no ha salido ya nada de este turno y el lead no ha vuelto a escribir (eso ya lo reprograma)
      const yaSalio = Boolean(this.repo.db.prepare(`SELECT 1 FROM messages WHERE conversation_id = ? AND autor = 'ia'
        AND id > IFNULL((SELECT max(id) FROM messages WHERE conversation_id = ? AND autor = 'lead'), 0) LIMIT 1`).get(c.id, c.id));
      if (!ultimo && !e.noReintentar && actual && !actual.respond_at && !actual.ai_paused && !actual.derivado && !yaSalio) {
        patch.respond_at = new Date(this.now().getTime() + ESPERAS_REINTENTO[reintentos]).toISOString();
        patch.reintentos = reintentos + 1;
      } else patch.reintentos = 0;
      this.repo.updateConv(c.id, patch);
    } finally {
      clearTimeout(reloj);
      this.enCurso.delete(c.id);
    }
  }

  /**
   * Bloques de sistema con las instrucciones vigentes (versión en producción, o los borradores si es una prueba).
   * `docs` permite forzar otros textos (la comprobación de un reporte).
   */
  sistema(conv, extraContexto = '', docs = null) {
    const t = docs || textosActivos(this.catalogo, this.borradores || {});
    return systemBlocks(t.prompt ?? knowledge.prompt, `${t.negocio ?? knowledge.negocio.split('\n\n## Festivos')[0]}\n\n${textoFestivos()}`, this.contexto(conv, extraContexto));
  }

  versiones() { const v = versionesActivas(this.catalogo, this.borradores || {}); return { prompt_v: v.prompt, negocio_v: v.negocio }; }

  contexto(conv, extra = '') {
    const hoy = hoyLocal(this.now());
    return [
      '# Contexto de esta conversación',
      `- Hoy es ${hoy.dia} ${hoy.iso} (hora de Madrid).`,
      `- Canal: ${conv.channel}.`,
      `- Nombre del perfil: ${conv.nombre || 'desconocido'}.`,
      `- Sede conocida: ${conv.sede ? SEDE_NOMBRE[conv.sede] : 'aún no'}.`,
      `- Alta: ${conv.alta_estado || 'no iniciada'}. Prueba de Parla solicitada: ${conv.prueba_reservada ? 'sí' : 'no'}.`,
      '- Puedes ver las imágenes que manda el lead y recibes sus notas de voz ya transcritas (la transcripción puede tener algún error: si algo no se entiende, pregúntalo). Si no se ha podido escuchar un audio, pídele con naturalidad que lo escriba.',
      conv.retomar ? (() => { const r = JSON.parse(conv.retomar); return `- El lead dijo que lo dejaba para más adelante (${r.motivo || 'sin motivo'}); hay que retomarlo el ${r.fecha}. Si vuelve a aplazarlo, indica la nueva fecha en \`retomar\`.`; })() : '',
      this.etiquetas?.contextoIA(conv.id) || '',
      recursos.contextoIA(this.catalogo),
      extra,
    ].filter(Boolean).join('\n');
  }

  /**
   * Convierte el historial al formato del modelo (turnos alternos, empezando por el lead).
   * Las notas de voz van como su transcripción y las imágenes del lead como imagen (solo las 3 últimas,
   * para no disparar el coste; las anteriores quedan como «[imagen enviada antes]»).
   */
  async mensajesModelo(historial) {
    const conImagen = historial.filter((m) => m.autor === 'lead' && m.adjunto === 'imagen' && m.media_ruta).slice(-3).map((m) => m.id);
    const out = [];
    const anadir = (role, bloques) => {
      const last = out[out.length - 1];
      if (last && last.role === role) last.content.push(...bloques);
      else out.push({ role, content: [...bloques] });
    };
    for (const m of historial) {
      const role = m.autor === 'lead' ? 'user' : 'assistant';
      const bloques = [];
      if (m.autor === 'lead' && m.adjunto === 'audio') {
        bloques.push({ type: 'text', text: m.transcripcion ? `[nota de voz, transcrita automáticamente] ${m.transcripcion}` : '[nota de voz que no se ha podido escuchar]' });
        if (m.texto && !/^\[(audio|adjunto)\]$/.test(m.texto)) bloques.push({ type: 'text', text: m.texto });
      } else if (m.autor === 'lead' && m.adjunto === 'imagen') {
        let img = null;
        if (conImagen.includes(m.id)) img = await this.safe(() => this.medios.imagenParaModelo(m.media_ruta));
        if (img) bloques.push({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } });
        bloques.push({ type: 'text', text: img ? '[imagen enviada por el lead]' : conImagen.includes(m.id) ? '[imagen que no se ha podido abrir]' : '[imagen enviada antes]' });
        if (m.texto && !/^\[(imagen|adjunto)\]$/.test(m.texto)) bloques.push({ type: 'text', text: m.texto });
      } else {
        const texto = m.autor === 'humano' ? `[escrito por una persona del equipo] ${m.texto}` : m.texto;
        if (texto) bloques.push({ type: 'text', text: texto });
      }
      if (bloques.length) anadir(role, bloques);
    }
    if (!out.length || out[0].role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '(el lead abrió la conversación)' }] });
    if (out[out.length - 1].role !== 'user') out.push({ role: 'user', content: [{ type: 'text', text: '(sin mensaje nuevo del lead)' }] });
    // Mensajes solo de texto: como cadena (igual que antes)
    return out.map((x) => (x.content.every((b) => b.type === 'text') ? { role: x.role, content: x.content.map((b) => b.text).join('\n') } : x));
  }

  async responder(convId, { extraContexto = '', motivo = 'respuesta', plantilla = null, avisarFallo = true } = {}) {
    const conv = this.repo.getConv(convId);
    if (!conv || conv.ai_paused || conv.derivado) return null;
    const system = this.sistema(conv, extraContexto);
    const messages = await this.mensajesModelo(this.repo.history(convId));
    const efectos = { tags: new Set(), derivado: false, herramientas: [], etiquetas: [] };

    let respuesta;
    try {
      ({ respuesta } = await runTurn({
        system, messages, complete: this.complete,
        ejecutarHerramienta: (n, i) => this.herramienta(conv, n, i, efectos),
        onHerramienta: (h) => efectos.herramientas.push(h),
        onUsage: (u, ms) => this.repo.logRun({
          conversation_id: convId, motivo, modelo: config.ai.model, ms, ...this.versiones(),
          tokens_in: u.input_tokens || 0, tokens_out: u.output_tokens || 0,
          tokens_cache_read: u.cache_read_input_tokens || 0, tokens_cache_write: u.cache_creation_input_tokens || 0,
        }),
      }));
    } catch (e) {
      this.repo.logRun({ conversation_id: convId, motivo, modelo: config.ai.model, error: e.message });
      if (avisarFallo) await this.safe(() => this.avisar?.(`La IA falló en una conversación y no ha contestado: ${e.message}`, { sede: conv.sede }));
      throw e;
    }

    // Mientras Sofía pensaba, alguien del equipo ha escrito o han pausado el chat: no se envía nada
    const ahoraConv = this.repo.getConv(convId);
    if (!ahoraConv || ((ahoraConv.ai_paused || ahoraConv.derivado) && !efectos.derivado)) return null;

    if (conv.prompt_v == null) this.repo.updateConv(convId, { prompt_v: this.versiones().prompt_v });
    await this.aplicarRespuesta(conv, respuesta, efectos);
    let mensajes = (respuesta.mensajes || []).map((m) => m.trim()).filter(Boolean);
    if (plantilla) mensajes = mensajes.slice(0, 1);
    if (!plantilla && mensajes.length) {
      for (const r of this.imagenesInfo(conv, efectos.info, mensajes)) if (!(efectos.recursos ||= []).some((x) => x.id === r.id)) efectos.recursos.push(r);
    }
    try {
      if (mensajes.length) await this.enviar(conv, mensajes, plantilla);
      if (efectos.recursos?.length) await this.enviarRecursos(conv, efectos.recursos);
    } catch (e) {
      // GHL ha fallado al enviar: queda registrado y el aviso del alta se intenta igualmente. Si en este turno
      // ya se hizo algo que no se debe repetir (alta, derivación), no se reintenta el turno: se avisa al equipo.
      this.repo.logRun({ conversation_id: convId, motivo, modelo: config.ai.model, error: `envío: ${e.message}`, ...this.versiones() });
      if (efectos.avisoAlta) await this.enviarAvisoAlta(conv, efectos.avisoAlta);
      e.noReintentar = Boolean(efectos.avisoAlta || efectos.derivado || efectos.herramientas.some((h) => ['preparar_alta', 'reservar_prueba_parla', 'derivar_a_equipo'].includes(h.nombre)));
      if (e.noReintentar) await this.safe(() => this.avisar?.(`Sofía no ha podido enviar su respuesta por un fallo de GHL (${e.message}). Revisar el chat de ${conv.nombre || conv.telefono || conv.id}.`, { sede: conv.sede }));
      throw e;
    }
    if (efectos.avisoAlta) await this.enviarAvisoAlta(conv, efectos.avisoAlta);
    // Seguimientos (también en modo prueba: al vencer quedan como borrador). Si lo deja para más adelante,
    // en vez de los cortos se programa el de largo plazo.
    let largoPlazo = null;
    if (motivo === 'respuesta' && !efectos.derivado && respuesta.retomar && (respuesta.retomar.fecha || respuesta.retomar.motivo)) {
      largoPlazo = this.programarLargoPlazo(conv, respuesta.retomar);
    } else if (motivo === 'respuesta' && mensajes.length && !efectos.derivado) this.programarSeguimientos(conv);
    const turno = { at: this.now().toISOString(), motivo, herramientas: efectos.herramientas, etiquetas: efectos.etiquetas, tags_ghl: [...efectos.tags], derivado: efectos.derivado, ...(largoPlazo ? { retomar: largoPlazo } : {}) };
    this.repo.updateConv(convId, { ultimo_turno: JSON.stringify(turno) });
    return { ...respuesta, mensajes, turno };
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
    if (r.analisis) patch.analisis = String(r.analisis).slice(0, 800);
    if (r.siguiente_paso) patch.siguiente_paso = String(r.siguiente_paso).slice(0, 400);
    if (Object.keys(patch).length) this.repo.updateConv(conv.id, patch);
    // Etiquetas del catálogo con criterio IA: las pone el etiquetador (con sus condiciones y acciones).
    // El resto siguen yendo a GHL como tags, como siempre.
    let libres = r.etiquetas || [];
    if (this.etiquetas) {
      const res = (await this.safe(() => this.etiquetas.deSofia(conv.id, libres))) || { puestas: [], libres };
      efectos.etiquetas.push(...res.puestas);
      libres = res.libres;
      const porEstado = await this.safe(() => this.etiquetas.alCambiarEstado(conv.id));
      if (porEstado) efectos.etiquetas.push(...porEstado);
    }
    for (const t of libres) efectos.tags.add(String(t).toLowerCase());
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
      const r = await this.ghl.enviarPorPlantilla({ contactId: conv.contact_id, texto: mensajes[0] });
      this.repo.addMessage({ conversation_id: conv.id, external_id: r?.messageId || null, autor: 'ia', texto: mensajes[0], tipo: 'plantilla' });
      this.repo.updateConv(conv.id, { last_ai_at: this.now().toISOString() });
      return [r?.messageId || null];
    }
    const ids = [];
    const pausadaAlEmpezar = Boolean(this.repo.getConv(conv.id)?.ai_paused);
    for (let i = 0; i < mensajes.length; i++) {
      await this.sleep(escritura[i]);
      // Alguien del equipo ha escrito mientras Sofía «escribía»: no se mandan las burbujas que faltan
      if (i > 0 && !pausadaAlEmpezar && this.repo.getConv(conv.id)?.ai_paused) break;
      const r = await this.ghl.sendMessage({ contactId: conv.contact_id, canal: conv.channel, texto: mensajes[i] });
      this.repo.addMessage({ conversation_id: conv.id, external_id: r?.messageId || null, autor: 'ia', texto: mensajes[i] });
      ids.push(r?.messageId || null);
      await this.safe(() => this.etiquetas?.alMensaje(conv.id, { autor: 'ia', texto: mensajes[i] }));
    }
    this.repo.updateConv(conv.id, { last_ai_at: this.now().toISOString() });
    return ids;
  }

  /**
   * Imágenes de tarifas/horarios que acompañan al texto: las de las consultas de este turno cuyo dato aparece de verdad
   * en los mensajes (un precio en euros, una hora) y que no se le hayan mandado ya en esta conversación.
   */
  imagenesInfo(conv, consultas = [], mensajes = []) {
    const texto = mensajes.join('\n');
    const da = {
      tarifas: /\d\s*(€|euros?\b)/i.test(texto),
      horarios: /\b([01]?\d|2[0-3])(:[0-5]\d|\s*h\b)/i.test(texto),
    };
    const out = [];
    for (const c of consultas) {
      if (!da[c.tipo]) continue;
      const r = recursos.porNombre(this.catalogo, recursos.nombreImagenInfo(c.tipo, c.sede, c.familia));
      if (!r || out.some((x) => x.id === r.id)) continue;
      if (this.repo.db.prepare('SELECT 1 FROM messages WHERE conversation_id = ? AND media_ruta = ? LIMIT 1').get(conv.id, r.media_ruta)) continue;
      out.push(r);
    }
    return out.slice(0, 2);
  }

  /** Envía archivos de Recursos. En modo prueba, solo una nota en GHL y un borrador en el chat. */
  async enviarRecursos(conv, lista) {
    for (const r of lista) {
      const msg = { conversation_id: conv.id, autor: 'ia', texto: `[${r.tipo}: ${r.nombre}]`, adjunto: r.tipo, media_ruta: r.media_ruta, media_mime: r.mime };
      if (!this.live) {
        await this.safe(() => this.ghl.addNote(conv.contact_id, `[Borrador IA, no enviado] adjuntaría el archivo «${r.nombre}»`));
        this.repo.addMessage({ ...msg, enviado: 0 });
        continue;
      }
      try {
        const out = await this.ghl.enviarAdjunto({ contactId: conv.contact_id, canal: conv.channel, url: recursos.urlPublica(r) });
        this.repo.addMessage({ ...msg, external_id: out?.messageId || null });
      } catch (e) {
        console.error('[recursos]', e.message);
        await this.avisar?.(`Sofía quiso enviar «${r.nombre}» y GHL no lo aceptó: ${e.message}`, { sede: conv.sede });
      }
    }
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
    if (String(conv.id).startsWith('prueba-')) return; // chat de pruebas: se fuerzan a mano desde Probar IA
    const base = this.now().getTime();
    this.repo.cancelScheduled(conv.id, 'Sofía volvió a responder', { soloCortos: true });
    for (const regla of reglasSeg.listar(this.catalogo)) {
      if (regla.tipo !== 'silencio' || !regla.canales.includes(conv.channel) || !regla.activo) continue;
      this.repo.schedule(conv.id, regla.id, new Date(base + regla.minutos * 60000).toISOString(), null, 'silencio');
    }
  }

  /**
   * El lead lo deja para más adelante: se cancelan los cortos y se programan los de largo plazo (fecha que indica
   * Sofía, entre 3 días y 1 año; si no hay fecha, la de la regla). Salen a las 11:00 de Madrid.
   * Devuelve { fecha, motivo, segundo } o null si el canal no lo permite.
   */
  programarLargoPlazo(conv, { fecha = '', motivo = '' } = {}) {
    const reglas = reglasSeg.listar(this.catalogo).filter((r) => r.tipo === 'largo-plazo');
    const primera = reglas.find((r) => !r.despuesDe);
    const ahora = this.now();
    const dia = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 10, 0)); // 11:00 en invierno, 12:00 en verano
    let objetivo = /^\d{4}-\d{2}-\d{2}$/.test(String(fecha)) ? new Date(`${fecha}T10:00:00Z`) : null;
    const min = ahora.getTime() + 3 * 864e5, max = ahora.getTime() + 365 * 864e5;
    if (!objetivo || Number.isNaN(objetivo.getTime()) || objetivo < min || objetivo > max) objetivo = dia(new Date(ahora.getTime() + (primera?.dias || 21) * 864e5));
    const info = { fecha: objetivo.toISOString().slice(0, 10), motivo: String(motivo || '').slice(0, 300), at: ahora.toISOString() };
    this.repo.updateConv(conv.id, { retomar: JSON.stringify(info) });
    if (!primera || !primera.canales.includes(conv.channel)) return { ...info, programado: false, nota: 'Instagram no deja escribir pasados unos días: no se programa' };
    this.repo.cancelScheduled(conv.id, 'lo deja para más adelante', { tipos: ['silencio', 'largo-plazo'] });
    if (String(conv.id).startsWith('prueba-')) return { ...info, programado: false, nota: 'chat de pruebas: usa «Forzar» para verlo' };
    // La primera en la fecha; las encadenadas (despuesDe), sus días después de la anterior
    let base = objetivo; let anterior = primera;
    if (primera.activo) this.repo.schedule(conv.id, primera.id, base.toISOString(), { fecha: info.fecha, motivo: info.motivo }, 'largo-plazo');
    for (let r = reglas.find((x) => x.despuesDe === anterior.id); r; anterior = r, r = reglas.find((x) => x.despuesDe === anterior.id)) {
      base = new Date(base.getTime() + r.minutos * 60000);
      if (r.activo) this.repo.schedule(conv.id, r.id, base.toISOString(), { fecha: info.fecha, motivo: info.motivo }, 'largo-plazo');
    }
    return { ...info, programado: true };
  }

  /**
   * Redacta un mensaje sin enviarlo ni cambiar nada (para preparar el texto de un seguimiento).
   * Solo puede usar herramientas de consulta. Devuelve el texto ('' si Sofía decide no enviar nada).
   */
  async redactar(convId, extraContexto = '', { docs = null } = {}) {
    const conv = this.repo.getConv(convId);
    if (!conv) return '';
    const system = this.sistema(conv, extraContexto, docs);
    const messages = await this.mensajesModelo(this.repo.history(convId));
    const consulta = { consultar_horarios: consultarHorarios, consultar_tarifas: consultarTarifas, calcular_primer_recibo: calcularPrimerRecibo };
    const { respuesta } = await runTurn({
      system, messages, complete: this.complete,
      ejecutarHerramienta: async (n, i) => (consulta[n] ? consulta[n](i) : { ok: false, error: 'Ahora solo estás redactando un mensaje: no uses esta herramienta.' }),
      onUsage: (u, ms) => this.repo.logRun({
        conversation_id: convId, motivo: 'redactar-seguimiento', modelo: config.ai.model, ms,
        tokens_in: u.input_tokens || 0, tokens_out: u.output_tokens || 0,
        tokens_cache_read: u.cache_read_input_tokens || 0, tokens_cache_write: u.cache_creation_input_tokens || 0,
      }),
    });
    return (respuesta.mensajes || []).map((m) => m.trim()).filter(Boolean).join('\n');
  }

  // ---------- Herramientas ----------

  async herramienta(conv, nombre, input, efectos) {
    switch (nombre) {
      case 'consultar_horarios': {
        const res = consultarHorarios(input);
        if (res?.ok && Object.keys(res.dias || {}).length) (efectos.info ||= []).push({ tipo: 'horarios', sede: res.sede, familia: res.modalidad === 'academy' ? 'academy' : 'crossfit_hyrox' });
        return res;
      }
      case 'consultar_tarifas': {
        const res = consultarTarifas({ ...input, plazas_ocupadas: this.plazasCanaveral() });
        const sede = normalizarSede(input.sede);
        if (res?.ok && sede) (efectos.info ||= []).push({ tipo: 'tarifas', sede, familia: normalizarModalidad(input.familia) === 'academy' ? 'academy' : 'crossfit_hyrox' });
        return res;
      }
      case 'calcular_primer_recibo': return calcularPrimerRecibo({ ...input, plazas_ocupadas: this.plazasCanaveral() });
      case 'preparar_alta': return this.alta(conv, input, efectos);
      case 'reservar_prueba_parla': {
        efectos.tags.add(TAGS.tareas.prueba_parla);
        this.repo.updateConv(conv.id, { prueba_reservada: 1 });
        programarCita(this.repo, this.catalogo, conv.id, input.fecha_hora, this.now()); // recordatorios antes de la clase
        await this.avisar?.(`Prueba en Parla pedida: ${input.modalidad} · ${input.fecha_hora}. Confirmar en el calendario y avisar al lead.`, { sede: 'parla' });
        return { ok: true, estado: 'solicitada', nota: 'Dile que se la dejas apuntada y que el equipo se la confirma por aquí. Es sin coste.' };
      }
      case 'enviar_recurso': {
        const r = recursos.porNombre(this.catalogo, input.nombre);
        if (!r) return { ok: false, error: 'No hay ningún archivo con ese nombre en la lista.' };
        if ((efectos.recursos ||= []).some((x) => x.id === r.id)) return { ok: true, nota: 'Ya lo vas a enviar en este turno.' };
        efectos.recursos.push(r);
        return { ok: true, nota: 'Se enviará justo después de tus mensajes. No pegues enlaces ni lo describas de más.' };
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

  /** Plazas de apertura de El Cañaveral ya ocupadas (registro de AimHarder + altas de Sofía que aún no están en él). */
  plazasCanaveral(sinConv = null) {
    return plazasCanaveral(this.repo, { sinConv }).total;
  }

  /**
   * Alta en El Cañaveral (abre el 1 feb 2027): empieza el día de la apertura, con el descuento del tramo en las cuotas
   * de febrero a abril y la primera mensualidad emitida el día del alta. Su AimHarder aún no está mapeado para el
   * alta automática (tarifas y descuento por meses), así que la termina el equipo con todos los datos en el aviso.
   */
  async altaCanaveral(conv, datos, efectos) {
    if (this.repo.getConv(conv.id)?.alta_estado === 'pendiente') return { ok: true, estado: 'ya_en_tramite', nota: 'El alta de este lead ya está pasada al equipo: no la repitas ni vuelvas a pedir los datos.' };
    const telefono = datos.telefono || conv.telefono || '';
    const oferta = ofertaCanaveral({ tarifa: datos.tarifa, fecha_inicio: datos.fecha_inicio, plazas_ocupadas: this.plazasCanaveral(conv.id) });
    if (!oferta.ok) return { ok: false, error: oferta.error };
    const d = { ...datos, sede: 'el_canaveral', telefono, canal: conv.channel, fecha_inicio: oferta.fecha_inicio, descuento_pct: oferta.descuento_pct, descuento_hasta: oferta.descuento_hasta, primer_recibo: oferta.primer_recibo };
    delete d.avisar_lead;
    const falta = validarDatos(d, this.now());
    if (falta) {
      this.repo.addAlta(conv.id, d, 'rechazada', falta);
      return { ok: false, error: falta, nota: 'Pide solo el dato que falta o corrige el que está mal. Si es menor de 16 años, explícale con cariño que la edad mínima para entrenar es 16.' };
    }
    this.repo.addAlta(conv.id, d, 'pendiente', 'El Cañaveral: alta para terminar a mano con el descuento de apertura');
    this.repo.updateConv(conv.id, { alta_estado: 'pendiente' });
    efectos.tags.add(TAGS.tareas.responder);
    const eur = (n) => `${String(n).replace('.', ',')} €`;
    await this.avisar?.(
      `Alta de El Cañaveral para terminar a mano: ${d.nombre_completo} · ${d.email} · tel. ${telefono} · nac. ${d.fecha_nacimiento} · ${d.tarifa} · inicio ${d.fecha_inicio}\n` +
      (oferta.descuento_pct
        ? `Descuento de apertura ${oferta.descuento_pct} % (plaza ${this.plazasCanaveral(conv.id) + 1}, tramo ${oferta.tramo_plazas}) en las cuotas de febrero, marzo y abril de 2027: ${eur(oferta.cuota_con_descuento)}/mes; desde mayo, ${eur(oferta.cuota_mensual)}/mes.\n`
        : `Sin descuento de apertura: ${eur(oferta.cuota_mensual)}/mes.\n`) +
      `Primer recibo: ${eur(oferta.primer_recibo)}, emitido hoy aunque empiece el ${d.fecha_inicio}${oferta.pago_habilitado ? ' (se paga en la fecha del alta)' : ' (queda pendiente: el pago aún no está habilitado; avisar al lead cuando lo esté)'}. Forma de pago TPV RedSys, sin matrícula.`,
      { sede: 'el_canaveral' },
    );
    return {
      ok: true, estado: 'pendiente_equipo', sede: SEDE_NOMBRE.el_canaveral, fecha_inicio: d.fecha_inicio, descuento_pct: oferta.descuento_pct,
      cuota_con_descuento: oferta.cuota_con_descuento, cuota_desde_mayo: oferta.cuota_mensual, primer_pago: oferta.primer_recibo,
      pago_habilitado: oferta.pago_habilitado,
      nota: `El equipo termina de tramitar el alta. Dile que ya está apuntado para empezar el ${d.fecha_inicio} y que le llega la invitación de AimHarder al correo. Primer pago: ${eur(oferta.primer_recibo)}. ${pagoCanaveral()} ` +
        (oferta.descuento_pct ? `Su descuento: ${oferta.descuento_pct} % en febrero, marzo y abril (${eur(oferta.cuota_con_descuento)}/mes; desde mayo, ${eur(oferta.cuota_mensual)}).` : 'No hay descuento de apertura porque las plazas ya están cubiertas.') +
        ' No digas que el alta ya está hecha ni des otros importes.',
    };
  }

  async alta(conv, datos, efectos) {
    // Un alta ya hecha no se repite (duplicaría la tarifa y el recibo en AimHarder)
    if (this.repo.getConv(conv.id)?.alta_estado === 'preparada') return { ok: true, estado: 'ya_preparada', nota: 'El alta de este lead ya está hecha: no la repitas ni vuelvas a dar los datos.' };
    const sede = normalizarSede(datos.sede);
    if (sede === 'el_canaveral') return this.altaCanaveral(conv, datos, efectos);
    if (!knowledge.tarifas[sede]?.[datos.tarifa]) return { ok: false, error: `La tarifa ${datos.tarifa} no existe en ${SEDE_NOMBRE[sede] || 'esa sede'}.` };
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
          ? 'El sistema ya le envía el aviso del alta con la sede, la fecha, la app, los documentos y el importe pendiente. Son 3 mensajes que salen justo después de los tuyos, así que tú manda UNA sola burbuja corta de bienvenida y no repitas ninguno de esos datos.'
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
    m.push(`como ya habías estado con nosotros he usado tu ficha de siempre y te he reenviado la invitación a ${email}, entra en la app CrossFit MetroPolitano con ese email (si no recuerdas la contraseña, dale a recuperarla en la propia app)`);
  } else {
    m.push(`te acaba de llegar un correo a ${email} con tu contraseña (mira también en spam), descárgate la app CrossFit MetroPolitano y entra con ese email y esa contraseña`);
  }
  m.push(`antes de tu primera clase firma los documentos y paga el primer recibo desde la app${pendiente ? `, son ${euros(pendiente)}` : ''}`);
  return m;
}
