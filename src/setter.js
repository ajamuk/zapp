import { config } from './config.js';
import { knowledge, consultarHorarios, consultarTarifas, calcularPrimerRecibo, ofertaCanaveral, normalizarSede, normalizarModalidad, pagoCanaveral, textoFestivos, SEDE_NOMBRE } from './knowledge.js';
import { validarDatos } from './aimharder/alta-navegador.js';
import { plazasCanaveral } from './canaveral.js';
import { runTurn, systemBlocks } from './llm.js';
import { leerAjustes } from './ajustes.js';
import { dentroDeHorario, siguienteApertura, hoyLocal, instanteLocal, retardoHumano, chatCaliente, esperar } from './horario.js';
import { tipoAdjunto } from './etiquetas.js';
import * as mediosReales from './medios.js';
import * as reglasSeg from './reglas.js';
import { programarCita, horaMadrid, fueraDeVentana } from './followups.js';
import { entraEnNivel } from './intensidad.js';
import { ultimaPrueba, guardarPrueba, actualizarPrueba, describir as describirPrueba, fechaLegible, pruebaTrialOps, resultadoTrialOps, describirTrialOps } from './clase-prueba.js';
import * as preguntas from './preguntas.js';
import { textosActivos, versionesActivas } from './documentos.js';
import * as recursos from './recursos.js';
import * as archivos from './archivos.js';
import * as plantillasWa from './plantillas.js';
import { contextoSolicitud } from './formularios.js';
import * as primerContacto from './primer-contacto.js';
import * as vozReal from './voz.js';
import { textoAviso, avisadoEnEsteCierre, TIPO_AVISO } from './fuera-horario.js';
import { APAGADO, evaluarEntrante, chatPermitido, esDeOtraLinea, salienteVerificado, plantillasPermitidas } from './aislamiento.js';
import { filtroInstagram, pideInformacion } from './instagram.js';

const TAGS = knowledge.etiquetas;
/** Devuelve la palabra o frase de la lista que aparece en el texto (sin tildes ni mayúsculas, palabra completa). */
export function contienePalabra(texto, lista = []) {
  const n = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const t = ` ${n(texto).replace(/[^a-z0-9#ñ@]+/g, ' ')} `;
  return lista.find((p) => p && t.includes(` ${n(p).replace(/[^a-z0-9#ñ@]+/g, ' ').trim()} `)) || null;
}
const ESPERAS_REINTENTO = [2 * 60000, 5 * 60000]; // si falla la IA o GHL: reintento a los 2 y a los 5 minutos
const SIN_RESPUESTA =/^\s*\[(story_mention|ig_post|ig_reel|reaction)\]\s*$/i;
const ultimos9 = (t) => String(t || '').replace(/\D/g, '').slice(-9);
/** ¿Es el mensaje de reinicio? Tiene que ser el mensaje entero (sin distinguir mayúsculas ni espacios de más). */
export const esReinicio = (texto, palabra) => Boolean(palabra) && String(texto || '').trim().toLowerCase() === String(palabra).trim().toLowerCase();
// Tope de lo que Sofía espera «escuchando» un audio (los más largos se contestan como si durasen esto)
const MAX_ESCUCHA_S = 600;
export const esTelefonoPrueba = (tel, lista = []) => { const d = ultimos9(tel); return d.length === 9 && lista.some((x) => ultimos9(x) === d); };

// Canales que GHL recibe de forma nativa. Lo demás (p. ej. «SMS personalizado») son copias que mete un conector
// externo: en la cuenta hay un «WA1 Connector» que repite cada WhatsApp, y además trae los grupos.
const CANALES_NATIVOS = new Set(['whatsapp', 'instagram', 'messenger']);
const VENTANA_SYNC = 3 * 60000; // chat sin sincronizar todavía: solo se miran los mensajes de GHL de los últimos 3 min
const SOLAPE_SYNC = 2 * 60000;  // margen hacia atrás al repasar un chat ya sincronizado
/** Texto comparable de un mensaje: sin la firma que añade el conector, sin espacios de más y en minúsculas. */
export function textoComparable(t) {
  return String(t || '').split('\n').filter((l) => !/^\s*(💬|☑️)|^\s*(sent from|received on|from other device)\b/i.test(l))
    .join(' ').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 120);
}
// Resúmenes con los que la IA llama a derivar_a_equipo «para no hacer nada» (no son derivaciones)
const RESUMEN_DE_RELLENO = /\b(no aplica|no procede|no hace falta|no es necesario|no necesita|nada que derivar|sin derivar|no derivar|no hay que derivar)\b/i;
const VENTANA_SEG_MS = 24 * 3600e3;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Herramientas que cambian algo fuera del chat y no se deben repetir ni dar por no hechas
const NO_REPETIBLES = ['preparar_alta', 'reservar_prueba_parla', 'derivar_a_equipo', 'pregunta_sin_respuesta'];
const MOTIVOS_DERIVAR = ['salud', 'gestion_socio', 'cobro', 'llamada', 'visita', 'no_documentado', 'otro'];
// Zona horaria del negocio tal como se le dice a Sofía («hora de Madrid» con Europe/Madrid)
const ZONA_TXT = `hora de ${String(config.tz).split('/').pop().replace(/_/g, ' ')}`;

/**
 * Cerebro del setter. Todas las dependencias se inyectan para poder probarlo sin red.
 * - repo: acceso a SQLite (db.js)
 * - ghl: cliente de GoHighLevel (ghl.js)
 * - aimharder: { buscarSocioPorTelefono, prepararAlta }
 * - avisar(texto, {sede}): aviso al equipo (Telegram)
 * - complete: sustituto de la llamada al modelo (tests)
 * - etiquetas: Etiquetador (etiquetas.js) para reglas, criterios de IA y acciones (opcional)
 * - aislamiento: estado de aislamiento.js (el servicio real pasa el de la configuración; simuladores y tests, ninguno)
 */
export class Setter {
  constructor({ repo, ghl, aimharder, avisar, complete, etiquetas = null, medios = mediosReales, voz = vozReal, catalogo = null, borradores = null, now = () => new Date(), sleep = esperar, live = config.mode === 'live', random = Math.random, telefonosPrueba = config.telefonosPrueba, palabraReinicio = config.palabraReinicio, aislamiento = APAGADO }) {
    // catalogo: base con las reglas de seguimiento y etiquetas (en Probar IA, la real; los chats van a otra)
    Object.assign(this, { repo, ghl, aimharder, avisar, complete, etiquetas, medios, voz, catalogo: catalogo || repo.db, borradores, now, sleep, live, random, telefonosPrueba, palabraReinicio, aislamiento: aislamiento || APAGADO });
  }

  // ---------- Aislamiento en el número propio (aislamiento.js) ----------

  /** ¿Hay aislamiento configurado (bien o mal)? */
  aislado() { return this.aislamiento.modo !== 'apagado'; }

  /** ¿Se pueden enviar plantillas? (false: aislamiento sin la declaración de que el workflow envía desde el número propio) */
  plantillas() { return plantillasPermitidas(this.aislamiento); }

  /**
   * Chat que ya estaba en la base antes del aislamiento. Si el número propio es el que la subcuenta ya tenía
   * (SOFIA_WA_ADOPTAR_CHATS=true), se repasa su conversación en GHL y pasa a verificado solo si GHL lo confirma
   * (ver `sincronizar`). Devuelve si al terminar Sofía puede actuar en él.
   */
  async intentarAdoptar(convId) {
    const c = this.repo.getConv(convId);
    if (!c) return false;
    if (this.permitido(c)) return true;
    if (this.aislamiento.modo !== 'activo' || !this.aislamiento.adoptar || c.aislado_bloqueo || !this.ghl.mensajes) return false;
    await this.safe(() => this.enSerie(convId, () => this.sincronizar(convId, null, { enMarcha: false })));
    return this.permitido(this.repo.getConv(convId));
  }

  /** ¿Puede Sofía hacer algo en este chat? Sin aislamiento, siempre. */
  permitido(conv) { return chatPermitido(this.aislamiento, conv); }

  /** Último seguro antes de cualquier salida o cambio en GHL de un chat. */
  exigirPermitido(conv) {
    if (!this.permitido(conv)) { const e = new Error('Aislamiento: este chat no está verificado para el número propio; no se envía nada'); e.noReintentar = true; throw e; }
  }

  /**
   * ¿Es este entrante un WhatsApp al número propio? Se decide solo con el mensaje leído de la API de GHL (`evidencia`
   * es el de la lista de la conversación; si le faltan datos o no hay, se pide el mensaje por su id). Lo que diga el
   * webhook (canal, teléfono del contacto, datos del workflow) no cuenta. Sin prueba, no entra.
   */
  async comprobarEntrante(evt, evidencia = null) {
    const a = this.aislamiento;
    if (a.modo === 'apagado') return { ok: true };
    if (a.modo !== 'activo') return { ok: false, motivo: 'aislamiento mal configurado' };
    // Solo entra lo que sale de repasar la conversación en GHL (`sincronizar`): ahí se ve también si la conversación
    // la comparte otra línea de WhatsApp. Un aviso suelto, aunque traiga un id de mensaje bueno, no basta.
    if (!evidencia?.id) return { ok: false, motivo: 'sin la conversación leída de GHL' };
    const id = evidencia.id;
    this.descartados ??= new Map();
    if (this.descartados.has(id)) return { ok: false, motivo: this.descartados.get(id), repetido: true };
    const esperado = { conversationId: evt.conversationId, contactId: evt.contactId };
    // Un chat que ya estaba en la base sin verificar para este número (de antes del aislamiento, de otra línea o de
    // otro número propio) no se adopta: su historial y su estado (pausas, fase, alta, seguimientos) no son de aquí.
    const previa = this.repo.getConv(evt.conversationId);
    let v = previa?.aislado_bloqueo ? { ok: false, motivo: `chat bloqueado (${previa.aislado_bloqueo})` }
      : previa && previa.aislado_num !== a.clave ? { ok: false, motivo: 'el chat ya existía con historial ajeno al número propio' }
        : evaluarEntrante(a, evidencia, esperado);
    if (!v.ok && !previa && this.ghl.mensaje && (!evidencia.locationId || evidencia.para == null)) {
      const m = await this.safe(() => this.ghl.mensaje(id));
      v = m ? evaluarEntrante(a, m, esperado) : { ok: false, motivo: 'GHL no devuelve ese mensaje' };
      // GHL caído o lento no es una prueba en contra: no se recuerda como descartado y se volverá a mirar
      if (!m) return v;
    }
    if (!v.ok) {
      this.descartados.set(id, v.motivo); if (this.descartados.size > 2000) this.descartados.delete(this.descartados.keys().next().value);
      console.warn(`[aislamiento] entrante descartado (${v.motivo})`); // sin teléfonos ni texto
    }
    return v;
  }

  /**
   * En la conversación de GHL hay WhatsApp de otra línea (el mismo contacto ha hablado con otro número de la empresa):
   * el historial, el contacto y sus etiquetas son compartidos y no se pueden separar desde aquí, así que Sofía no
   * actúa en esa conversación. Si ya tenía chat, queda bloqueado y sin nada pendiente. No se toca GHL.
   */
  bloquearCompartida(convId) {
    const motivo = 'conversación compartida con otra línea de WhatsApp';
    const conv = this.repo.getConv(convId);
    if (conv && !conv.aislado_bloqueo) {
      this.repo.updateConv(convId, { aislado_bloqueo: motivo, respond_at: null, reintentos: 0 });
      this.repo.cancelScheduled(convId, `aislamiento: ${motivo}`);
      console.warn(`[aislamiento] ${convId}: ${motivo}; Sofía deja de actuar en este chat`);
    } else if (!conv && !(this.compartidasVistas ??= new Set()).has(convId)) {
      this.compartidasVistas.add(convId); if (this.compartidasVistas.size > 2000) this.compartidasVistas.clear();
      console.warn(`[aislamiento] entrante descartado (${motivo})`);
    }
    return { visto: false, entrantes: 0, salientes: 0, compartida: true, ignorado: `aislamiento: ${motivo}` };
  }

  /** GHL aún no lista el mensaje del aviso: se vuelve a mirar la conversación un par de veces (si no, se perdería). */
  repasarLuego(evt) {
    if (!this.ghl.mensajes) return;
    for (const ms of this.repasosAislamiento ?? [8000, 40000]) {
      const t = setTimeout(() => { this.enSerie(evt.conversationId, () => this.sincronizar(evt.conversationId, evt)).catch(() => {}); }, ms);
      t.unref?.();
    }
  }

  /**
   * Contacto recién creado: el aviso del workflow llega a los pocos segundos y GHL aún no devuelve su conversación.
   * Sin esto el primer mensaje del lead se perdía (no entraba en el panel ni contestaba nadie). Se vuelve a preguntar
   * a GHL unas cuantas veces; en cuanto aparece, el aviso se procesa como si hubiera llegado completo.
   */
  buscarConversacionLuego(evt) {
    if (!this.ghl.buscarConversacion || evt.evento !== 'inbound' || evt.reintentoConversacion) return false;
    const pendientes = (this.conversacionesPendientes ??= new Set());
    if (pendientes.has(evt.contactId)) return true; // ya hay un repaso en marcha para este contacto
    pendientes.add(evt.contactId);
    const esperas = [...(this.repasosConversacion ?? [5000, 15000, 45000, 120000])];
    const intentar = () => {
      const ms = esperas.shift();
      if (ms === undefined) {
        pendientes.delete(evt.contactId);
        console.warn(`[webhook] ${evt.contactId}: GHL sigue sin devolver la conversación del contacto; aviso sin procesar`);
        return;
      }
      const t = setTimeout(async () => {
        try {
          const ya = this.repo.db.prepare('SELECT id FROM conversations WHERE contact_id = ? ORDER BY rowid DESC LIMIT 1').get(evt.contactId)?.id;
          const id = ya || (await this.safe(() => this.ghl.buscarConversacion(evt.contactId)))?.id;
          if (!id) return intentar();
          pendientes.delete(evt.contactId);
          console.log(`[webhook] ${evt.contactId}: conversación ${id} encontrada al repasar; se procesa el aviso`);
          await this.handleWebhook({ ...evt, conversationId: id, reintentoConversacion: true });
        } catch (e) { pendientes.delete(evt.contactId); console.error('[webhook] repaso de conversación:', e); }
      }, ms);
      t.unref?.();
    };
    intentar();
    return true;
  }

  /**
   * Instagram: nunca historias, reacciones, emojis ni mensajes sin texto; y un chat nuevo solo se abre si el mensaje
   * pide información de forma clara. Lo que no pasa no crea chat ni toca el contacto (lo atiende el equipo en GHL).
   * La decisión se recuerda por id de mensaje: los repasos de la conversación no vuelven a preguntar al modelo.
   */
  async filtrarInstagram(evt, m) {
    this.decisionesIg ??= new Map();
    const id = m?.id || evt.messageId;
    if (id && this.decisionesIg.has(id)) return this.decisionesIg.get(id);
    let v = filtroInstagram(m || { texto: evt.texto, adjuntos: evt.adjuntos });
    if (v.ok && !this.repo.getConv(evt.conversationId)) {
      v = await pideInformacion(m?.texto ?? evt.texto, { complete: this.completeFiltro || this.complete, onUsage: (uso) => this.safe(() => this.repo.logRun({ conversation_id: evt.conversationId, motivo: 'filtro instagram', ...uso })) });
    }
    if (id) { this.decisionesIg.set(id, v); if (this.decisionesIg.size > 2000) this.decisionesIg.delete(this.decisionesIg.keys().next().value); }
    if (!v.ok) console.warn(`[instagram] entrante no atendido (${v.motivo})`); // sin texto ni datos del contacto
    return v;
  }

  /**
   * Red de seguridad: chats nuevos de GHL de los que no llegó el aviso (workflow que falla, Sofía reiniciándose, GHL que
   * tarda más de lo previsto). Cada pocos minutos se miran las conversaciones con actividad reciente que aún no están
   * aquí y se ponen al día como si hubiera llegado su aviso: mismas comprobaciones (aislamiento, Instagram, equipo que
   * ya contestó). Lo muy reciente se deja al aviso normal. Una conversación descartada no se vuelve a mirar mientras
   * no tenga mensajes nuevos.
   */
  async barrerConversacionesNuevas({ minutos = 30, margenMs = 90000, limite = 30 } = {}) {
    if (!this.ghl.conversacionesRecientes || !this.ghl.mensajes) return { revisadas: 0, recuperadas: 0 };
    const lista = await this.safe(() => this.ghl.conversacionesRecientes(limite));
    if (!lista) return { revisadas: 0, recuperadas: 0 };
    const ahora = this.now().getTime();
    this.barridoVistas ??= new Map();
    let revisadas = 0; let recuperadas = 0;
    for (const c of lista) {
      const edad = ahora - new Date(c.ultimo).getTime();
      if (edad > minutos * 60000 || edad < margenMs) continue;
      if (this.repo.getConv(c.id) || this.barridoVistas.get(c.id) === c.ultimo) continue;
      revisadas++;
      const evt = { evento: 'inbound', contactId: c.contactId, conversationId: c.id, canal: 'desconocido', texto: '', messageId: null, recibido: this.now().toISOString() };
      const r = await this.safe(() => this.enSerie(c.id, () => this.sincronizar(c.id, evt, { ventana: (minutos + 5) * 60000, horaReal: true, enMarcha: false })));
      if (!r) continue; // GHL no responde: se vuelve a mirar en el siguiente barrido
      this.barridoVistas.set(c.id, c.ultimo); if (this.barridoVistas.size > 2000) this.barridoVistas.delete(this.barridoVistas.keys().next().value);
      if (this.repo.getConv(c.id)) { recuperadas++; console.warn(`[barrido] ${c.id}: chat nuevo sin aviso de GHL; recuperado`); }
    }
    return { revisadas, recuperadas };
  }

  // ---------- Entrada ----------

  async handleWebhook(evt) {
    // Cambio de tags en GHL (evento ContactTagUpdate): se reflejan en las etiquetas del panel
    if (evt.evento === 'tags') return (await this.safe(() => this.etiquetas?.sincronizarContacto(evt.contactId, evt.tags))) || { ignorado: 'sin etiquetas' };
    if (!evt.contactId) return { ignorado: 'faltan ids' };
    if (this.aislamiento.modo === 'invalido') return { ignorado: 'aislamiento mal configurado' };
    evt.recibido ??= this.now().toISOString(); // cuándo llegó el aviso (puede procesarse más tarde, detrás de otro)
    // Webhook de un workflow de GHL: no trae el id de la conversación. Si el contacto ya tiene chat, sale de la
    // base; si no, se pregunta a GHL.
    if (!evt.conversationId) evt.conversationId = this.repo.db.prepare('SELECT id FROM conversations WHERE contact_id = ? ORDER BY rowid DESC LIMIT 1').get(evt.contactId)?.id;
    let buscada = null;
    if ((!evt.conversationId || (!CANALES_NATIVOS.has(evt.canal) && !this.ghl.mensajes)) && this.ghl.buscarConversacion) {
      buscada = await this.safe(() => this.ghl.buscarConversacion(evt.contactId));
      if (buscada?.id && !evt.conversationId) evt.conversationId = buscada.id;
    }
    if (!evt.conversationId) return { ignorado: 'faltan ids', reintento: this.buscarConversacionLuego(evt) };
    // Los eventos de un mismo chat se procesan de uno en uno y en orden: si llegan dos mensajes casi a la vez,
    // el chat no se clasifica dos veces (dos avisos de «socio escribe») ni se cruzan la pausa y la respuesta.
    return this.enSerie(evt.conversationId, async () => {
      // Aislamiento: un aviso de saliente no dice por qué línea salió. No se usa tal cual: se repasa la conversación
      // (solo en chats propios), y ahí cuentan únicamente los salientes del número propio.
      if (this.aislado() && evt.evento === 'outbound') {
        const conv = this.repo.getConv(evt.conversationId);
        if (!conv || !this.permitido(conv) || !this.ghl.mensajes) return { ignorado: 'aislamiento: saliente sin verificar' };
        return (await this.sincronizar(evt.conversationId)) || { ignorado: 'aislamiento: GHL no responde' };
      }
      // Entrante de workflow (sin id de mensaje o sin canal): lo que cuenta es lo que hay en la conversación de GHL.
      // El canal NO se saca del «último mensaje» del chat: el conector de WhatsApp mete una copia de cada mensaje
      // y, si la copia era lo último, el mensaje de verdad se descartaba como copia.
      if (evt.evento === 'inbound' && (this.aislado() || !evt.messageId || evt.canal === 'desconocido')) {
        if (this.ghl.mensajes) {
          const r = await this.sincronizar(evt.conversationId, evt);
          if (r?.compartida || r?.ajeno) return r;
          if (r?.visto) {
            // El texto coincidía con un mensaje que ya estaba: por si era otro igual que GHL aún no listaba
            if (r.repasar && !r.entrantes) { const t = setTimeout(() => { this.enSerie(evt.conversationId, () => this.sincronizar(evt.conversationId)).catch(() => {}); }, this.repasoMs ?? 8000); t.unref?.(); }
            return r;
          }
        }
        // Con aislamiento nada entra «tal como vino»: sin el mensaje de GHL no hay prueba de a qué número se escribió
        if (this.aislado()) { this.repasarLuego(evt); return { ignorado: 'aislamiento: GHL aún no lista el mensaje; se repasa en unos segundos' }; }
        // GHL no contesta o aún no lista el mensaje: entra tal como vino (el disparador del workflow solo salta
        // con WhatsApp e Instagram). Cuando aparezca en GHL, `sincronizar` lo reconoce por el texto y no lo repite.
        if (evt.canal === 'desconocido') {
          const conocido = this.repo.getConv(evt.conversationId)?.channel;
          evt.canal = CANALES_NATIVOS.has(conocido) ? conocido : CANALES_NATIVOS.has(buscada?.canal) ? buscada.canal : 'whatsapp';
        }
      }
      return this.procesarEvento(evt);
    });
  }

  /**
   * Pone el chat al día con la conversación de GHL (por id de mensaje, así que repetirlo no duplica nada):
   *  - entrantes de WhatsApp/Instagram que no estaban: entran como mensajes del lead (con su id, canal y adjuntos).
   *    Cubre los que GHL no avisa: su workflow se salta los mensajes que llegan mientras procesa el anterior.
   *  - salientes que no son de Sofía (el equipo desde GHL o desde el móvil): quedan en el historial como «equipo»
   *    y, si Sofía está enviando de verdad en ese chat, se aparta (ajuste «pausar si el equipo escribe»).
   * `evt` es el webhook que lo ha provocado; `visto` dice si su mensaje está en GHL (ya registrado o recién entrado).
   */
  async sincronizar(convId, evt = null, { programar = true, enMarcha = this.enCurso?.has(convId), ventana = VENTANA_SYNC, horaReal = false } = {}) {
    // Aislamiento: un chat de la base que no es del número propio (heredado o bloqueado) ni se consulta ni se toca
    let porAdoptar = false;
    if (this.aislado()) {
      const c = this.repo.getConv(convId);
      porAdoptar = Boolean(c && !this.permitido(c) && this.aislamiento.modo === 'activo' && this.aislamiento.adoptar && !c.aislado_bloqueo);
      if (c && !this.permitido(c) && !porAdoptar) {
        if (!(this.ajenosVistos ??= new Set()).has(convId)) { this.ajenosVistos.add(convId); if (this.ajenosVistos.size > 2000) this.ajenosVistos.clear(); console.warn(`[aislamiento] ${convId}: chat no verificado para el número propio; no se atiende`); }
        return { visto: false, entrantes: 0, salientes: 0, ajeno: true, ignorado: 'aislamiento: chat no verificado para el número propio' };
      }
    }
    const lista = await this.safe(() => this.ghl.mensajes(convId));
    if (!lista) return null;
    const aisl = this.aislamiento.modo === 'activo' ? this.aislamiento : null;
    // Se mira toda la lista (no solo lo reciente): basta un mensaje de otra línea para que la conversación sea compartida
    if (aisl && lista.some((m) => esDeOtraLinea(aisl, m))) return this.bloquearCompartida(convId);
    if (porAdoptar) {
      // Se adopta solo con prueba: en la conversación de GHL no hay nada de otra línea (comprobado arriba) y sí al
      // menos un WhatsApp entrante al número propio. Sin eso, el chat sigue sin atenderse.
      const c = this.repo.getConv(convId);
      const prueba = lista.some((m) => evaluarEntrante(aisl, m, { conversationId: convId, contactId: c.contact_id }).ok);
      if (!prueba) return { visto: false, entrantes: 0, salientes: 0, ajeno: true, ignorado: 'aislamiento: chat anterior sin WhatsApp al número propio en GHL' };
      this.repo.updateConv(convId, { aislado_num: aisl.clave });
      console.log(`[aislamiento] ${convId}: chat anterior adoptado (GHL confirma que es del número propio)`);
    }
    const db = this.repo.db;
    const cursor = this.repo.getConv(convId)?.ghl_sync_at;
    // Se repasa un poco hacia atrás (GHL a veces lista tarde un mensaje); en un chat nuevo, solo lo reciente
    // Chat que ya existe pero sin cursor (GHL no listó nada las veces anteriores): desde su primer mensaje aquí
    const primero = cursor ? null : db.prepare('SELECT min(created_at) c FROM messages WHERE conversation_id = ?').get(convId)?.c;
    const base = cursor ? new Date(cursor).getTime() - SOLAPE_SYNC : Math.min(this.now().getTime(), primero ? new Date(primero).getTime() : Infinity) - ventana;
    const suelo = this.repo.getConv(convId)?.ghl_sync_suelo;
    const desde = [new Date(base).toISOString(), suelo].filter(Boolean).sort().pop();
    const iso = (fecha, ms) => new Date(new Date(fecha).getTime() + ms).toISOString();
    const conocido = (id) => Boolean(db.prepare('SELECT 1 FROM messages WHERE external_id = ?').get(id));
    const buscado = textoComparable(evt?.texto);
    const out = { visto: false, entrantes: 0, salientes: 0 };
    let nuevoCursor = cursor || null; let pendiente = false;
    for (const m of lista) {
      if (!(m.fecha >= desde)) continue;
      const t = textoComparable(m.texto);
      if (m.direccion === 'inbound' && CANALES_NATIVOS.has(m.canal)) {
        const esElDelWebhook = Boolean(evt) && (!buscado || buscado === t);
        if (!conocido(m.id)) {
          // Entró antes sin id (GHL aún no lo listaba): se le pone el id y no se repite
          const gemelo = t && db.prepare("SELECT id, texto FROM messages WHERE conversation_id = ? AND autor = 'lead' AND external_id IS NULL AND created_at >= ? AND created_at <= ?")
            .all(convId, iso(m.fecha, -60000), iso(m.fecha, 15 * 60000)).find((x) => textoComparable(x.texto) === t);
          if (gemelo) db.prepare('UPDATE messages SET external_id = ? WHERE id = ?').run(m.id, gemelo.id);
          else {
            const conv = this.repo.getConv(convId);
            const r = await this.onInbound({ evento: 'inbound', conversationId: convId, contactId: evt?.contactId || conv?.contact_id, canal: m.canal, texto: m.texto, messageId: m.id,
              adjuntos: m.adjuntos, nombre: evt?.nombre || null, telefono: evt?.telefono || null, tags: evt?.tags ?? null, fecha: m.fecha, ...(horaReal ? { creado: m.fecha } : {}) }, { programar, evidencia: m });
            if (r?.aislamiento) out.descartados = (out.descartados || 0) + 1; else out.entrantes++;
          }
          // Recién registrado: es el del webhook aunque este se haya procesado con retraso
          if (esElDelWebhook) out.visto = true;
        } else if (esElDelWebhook && m.fecha > iso(evt.recibido || this.now(), -VENTANA_SYNC)) {
          // Ya estaba: cuenta como «el del webhook» si es reciente respecto a cuando llegó el aviso. Puede ser otro
          // mensaje anterior con el mismo texto («hola», «hola») y que GHL aún no liste el nuevo: se repasa luego.
          out.visto = true; out.repasar = true;
        }
      } else if (m.direccion === 'outbound' && m.source !== 'workflow' && !conocido(m.id) && (!this.aislado() || salienteVerificado(aisl, m))) {
        const nativo = CANALES_NATIVOS.has(m.canal); const delConector = m.tipo === 'TYPE_CUSTOM_SMS';
        // Sin texto solo cuenta por el canal nativo (una foto o un audio del equipo); el conector no se puede cotejar
        const cuenta = (nativo && (t || m.adjuntos.length)) || (delConector && t);
        // Copia del conector de un saliente nativo que está en la lista (de Sofía, de un workflow de GHL o del
        // equipo): lo que vale es el nativo, que se trata por su cuenta. Solo sin nativo es alguien desde el móvil.
        const esCopia = delConector && lista.some((x) => x !== m && x.direccion === 'outbound' && CANALES_NATIVOS.has(x.canal)
          && Math.abs(new Date(x.fecha) - new Date(m.fecha)) < 2 * 60000 && (textoComparable(x.texto) === t || (!textoComparable(x.texto) && x.adjuntos.length)));
        if (cuenta && !esCopia) {
          // Sofía está enviando ahora mismo: su burbuja puede verse en GHL antes de quedar registrada aquí.
          // Se deja para la próxima vez (el cursor no pasa de aquí).
          if (enMarcha) pendiente = true;
          else if (this.repo.getConv(convId) && !this.adoptarSinConfirmar(convId, m)) {
            const nuestro = t && db.prepare("SELECT texto FROM messages WHERE conversation_id = ? AND autor IN ('ia', 'humano') AND enviado = 1 AND created_at >= ? AND created_at <= ?")
              .all(convId, iso(m.fecha, -10 * 60000), iso(m.fecha, 10 * 60000)).some((x) => textoComparable(x.texto) === t);
            if (!nuestro) {
              await this.onOutbound({ evento: 'outbound', conversationId: convId, canal: m.canal, texto: m.texto || '[archivo]', messageId: m.id, userId: m.userId || 'equipo', adjuntos: m.adjuntos, creado: m.fecha }, { verificado: true });
              out.salientes++;
            }
          }
        }
      }
      if (!pendiente && (!nuevoCursor || m.fecha > nuevoCursor)) nuevoCursor = m.fecha;
    }
    if (nuevoCursor && nuevoCursor !== cursor && this.repo.getConv(convId)) this.repo.updateConv(convId, { ghl_sync_at: nuevoCursor });
    if (out.entrantes > 1 || out.salientes) console.log(`[sync] ${convId}: ${out.entrantes} entrantes y ${out.salientes} del equipo recuperados de GHL`);
    return out;
  }

  /**
   * Envíos que GHL no confirmó (tiempo agotado o error) y que pueden haber salido igualmente. Si luego aparecen en
   * la conversación, son de Sofía: sin esto se tomarían por un mensaje del equipo y el chat se pausaría.
   */
  anotarSinConfirmar(convId, { texto, url = null, extra = {} }) {
    this.sinConfirmar ??= new Map();
    const lista = (this.sinConfirmar.get(convId) || []).filter((x) => x.at > Date.now() - 30 * 60000);
    lista.push({ texto, t: textoComparable(texto), url, extra, at: Date.now() });
    this.sinConfirmar.set(convId, lista);
  }

  adoptarSinConfirmar(convId, m) {
    const lista = this.sinConfirmar?.get(convId);
    if (!lista?.length) return false;
    const t = textoComparable(m.texto);
    const i = lista.findIndex((x) => x.at > Date.now() - 30 * 60000 && ((x.url && m.adjuntos.includes(x.url)) || (!x.url && x.t && x.t === t)));
    if (i < 0) return false;
    const [x] = lista.splice(i, 1);
    this.repo.addMessage({ conversation_id: convId, external_id: m.id, autor: 'ia', texto: x.texto, ...x.extra, created_at: m.fecha });
    console.log(`[envío] ${convId}: un mensaje que GHL no confirmó sí había salido; queda registrado como de Sofía`);
    return true;
  }

  /** ¿Ha salido ya algo de Sofía después del último mensaje del lead? */
  yaContestado(convId) {
    return Boolean(this.repo.db.prepare(`SELECT 1 FROM messages WHERE conversation_id = ? AND autor = 'ia'
      AND id > IFNULL((SELECT max(id) FROM messages WHERE conversation_id = ? AND autor = 'lead'), 0) LIMIT 1`).get(convId, convId));
  }

  /** Ejecuta `fn` cuando haya terminado lo anterior con la misma clave (los fallos no cortan la cola). */
  enSerie(clave, fn) {
    this.colas ??= new Map();
    const p = (this.colas.get(clave) || Promise.resolve()).then(fn);
    const guardada = p.catch(() => {});
    this.colas.set(clave, guardada);
    guardada.then(() => { if (this.colas.get(clave) === guardada) this.colas.delete(clave); });
    return p;
  }

  async procesarEvento(evt) {
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

  async onOutbound(evt, { verificado = false } = {}) {
    // Aislamiento: solo cuenta un saliente que GHL sitúa en el número propio (lo comprueba `sincronizar`)
    if (this.aislado() && !verificado) return { ignorado: 'aislamiento: saliente sin verificar' };
    // Mensajes que envía el propio sistema ya están registrados (mismo external_id) → se ignoran.
    if (!evt.userId) return { ignorado: 'saliente sin usuario (sistema o plantilla)' };
    const conv = this.repo.getConv(evt.conversationId);
    if (!conv) return { ignorado: 'conversación desconocida' };
    if (!this.permitido(conv)) return { ignorado: 'aislamiento: chat de otro número' };
    // `creado`: fecha real del mensaje en GHL cuando se recupera más tarde (su copia del conector se compara por esa fecha)
    const ins = this.repo.addMessage({ conversation_id: conv.id, external_id: evt.messageId, autor: 'humano', texto: evt.texto, adjunto: tipoAdjunto(evt.adjuntos), ...(evt.creado ? { created_at: evt.creado } : {}), ...(evt.medio || {}) });
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
    // En modo prueba el equipo contesta todos los chats: sus mensajes quedan en el historial (Sofía redacta su
    // borrador sabiendo lo que se ha dicho), pero no la apartan. Solo se aparta donde envía de verdad.
    if (!parar && (!ajustes.pausarSiEquipoEscribe || !this.enviaDeVerdad(conv))) return { registrado: true };
    this.repo.updateConv(conv.id, { ai_paused: 1, pause_reason: parar ? `el equipo escribió «${parar}»` : 'humano escribió', respond_at: null });
    this.repo.cancelScheduled(conv.id, 'humano escribió');
    return { pausada: true };
  }

  async onInbound(evt, { programar = true, evidencia = null } = {}) {
    // Aislamiento: antes de crear el chat o tocar nada del contacto (etiquetas, notas, AimHarder, avisos)
    if (this.aislado()) {
      const v = await this.comprobarEntrante(evt, evidencia);
      if (!v.ok) return { ignorado: `aislamiento: ${v.motivo}`, aislamiento: true };
      evt.canal = String(evidencia?.tipo) === 'TYPE_INSTAGRAM' ? 'instagram' : 'whatsapp';
      if (evt.canal === 'instagram') {
        const f = await this.filtrarInstagram(evt, evidencia);
        if (!f.ok) return { ignorado: f.motivo, aislamiento: true };
      }
    }
    // Un teléfono de prueba reinicia su conversación escribiendo la palabra de reinicio (para los leads es un texto más)
    const previa = this.repo.getConv(evt.conversationId);
    if (esReinicio(evt.texto, this.palabraReinicio) && esTelefonoPrueba(evt.telefono || previa?.telefono, this.telefonosPrueba)) {
      // Aviso repetido del mismo reinicio (llega sin id de mensaje): no se borra otra vez lo que se haya escrito después
      const reciente = previa?.ghl_sync_suelo && this.now().getTime() - new Date(previa.ghl_sync_suelo).getTime() < 5 * 60000;
      if (!evt.messageId && reciente) return { ignorado: 'reinicio ya hecho' };
      return this.reiniciarPrueba(evt, previa);
    }
    const nuevo = !this.repo.getConv(evt.conversationId);
    const conv = this.repo.upsertConv({ id: evt.conversationId, contact_id: evt.contactId, channel: evt.canal, nombre: evt.nombre, telefono: evt.telefono });
    // Solo un chat recién creado (o reiniciado por un teléfono de prueba ya verificado) recibe la marca: nunca uno heredado
    if (this.aislamiento.modo === 'activo' && nuevo) { this.repo.updateConv(conv.id, { aislado_num: this.aislamiento.clave }); conv.aislado_num = this.aislamiento.clave; }
    // Se contesta por donde ha escrito la última vez (el mismo contacto puede escribir por Instagram y luego por WhatsApp)
    if (!nuevo && CANALES_NATIVOS.has(evt.canal) && conv.channel !== evt.canal) { this.repo.updateConv(conv.id, { channel: evt.canal }); conv.channel = evt.canal; }
    const ajustesC = leerAjustes(this.repo);
    if (nuevo && ajustesC.canalesPausa[conv.channel]) this.repo.updateConv(conv.id, { ai_paused: 1, pause_reason: `los chats de ${conv.channel} empiezan en pausa` });
    let adjunto = tipoAdjunto(evt.adjuntos);
    const ins = this.repo.addMessage({ conversation_id: conv.id, external_id: evt.messageId, autor: 'lead', texto: evt.texto || (adjunto ? `[${adjunto}]` : ''), adjunto, ...(evt.creado ? { created_at: evt.creado } : {}) });
    // Un webhook repetido de GHL no cambia nada (tampoco vuelve a pausar un chat que el equipo ya reanudó)
    if (!ins) return { ignorado: 'duplicado' };
    const pararLead = contienePalabra(evt.texto, ajustesC.palabrasParar);
    if (pararLead) this.repo.updateConv(conv.id, { ai_paused: 1, pause_reason: `el lead escribió «${pararLead}»`, respond_at: null });
    // Audios e imágenes: se descargan y los audios se transcriben antes de que Sofía conteste
    let transcripcion = null;
    const llegada = this.now().getTime();
    let duracionAudio = 0;
    if (evt.adjuntos?.length || evt.subida) {
      // Mientras se descarga y transcribe, el bucle no contesta este chat (si no, diría «no he podido oír el audio»)
      this.mediosEnCurso ??= new Map();
      this.mediosEnCurso.set(conv.id, (this.mediosEnCurso.get(conv.id) || 0) + 1);
      let m;
      try { m = evt.subida || (await this.safe(() => this.medios.procesarAdjuntos(evt.adjuntos))); }
      finally { const n = this.mediosEnCurso.get(conv.id) - 1; if (n > 0) this.mediosEnCurso.set(conv.id, n); else this.mediosEnCurso.delete(conv.id); }
      if (m) {
        adjunto = m.adjunto; transcripcion = m.transcripcion;
        if (m.adjunto === 'audio') duracionAudio = Math.min(MAX_ESCUCHA_S, Math.max(0, Number(m.duracion) || 0));
        this.repo.updateMessage(ins.lastInsertRowid, { adjunto: m.adjunto, media_ruta: m.media_ruta, media_mime: m.media_mime, transcripcion: m.transcripcion, media_error: m.media_error, ...(evt.texto ? {} : { texto: `[${m.adjunto}]` }) });
      }
    }
    const ahora = this.now();
    // Ventana de 24 h de WhatsApp: cuenta desde que el lead escribió (fecha del mensaje en GHL), no desde que se
    // procesó (puede ser bastante después); nunca hacia atrás (un mensaje antiguo recuperado tarde) ni en el futuro.
    const escrito = [evt.creado, evt.fecha].map((f) => (f ? Date.parse(f) : NaN)).find((t) => Number.isFinite(t));
    const llegadaLead = new Date(Math.min(ahora.getTime(), escrito ?? ahora.getTime())).toISOString();
    const ultimaLlegada = Date.parse(this.repo.getConv(conv.id)?.last_inbound_at || '');
    if (!(ultimaLlegada >= Date.parse(llegadaLead))) this.repo.updateConv(conv.id, { last_inbound_at: llegadaLead });
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
    // Recuperado de GHL justo antes de contestar: ya va incluido en esa respuesta, no se programa otra
    if (!programar) return { registrado: true };

    // Retardo humano; cada mensaje nuevo reinicia la espera para contestar todo junto.
    const { lectura } = retardoHumano([], { random: this.random, caliente: chatCaliente(actual.last_ai_at, ahora), leido: String(evt.texto || '').length });
    // Un audio se escucha entero, a su velocidad, antes de ponerse a contestar: la espera normal empieza cuando
    // termina. Empieza a oírlo al llegar (lo que tarde en transcribirse no se suma) y varios audios se oyen seguidos.
    this.oyendoHasta ??= new Map();
    let finEscucha = this.oyendoHasta.get(conv.id) || 0;
    if (duracionAudio) { finEscucha = Math.max(finEscucha, llegada) + duracionAudio * 1000; this.oyendoHasta.set(conv.id, finEscucha); }
    if (finEscucha <= ahora.getTime()) this.oyendoHasta.delete(conv.id);
    let cuando = new Date(Math.max(ahora.getTime(), finEscucha) + lectura);
    // Los teléfonos de prueba del equipo no tienen horario: se prueba a Sofía a cualquier hora
    let aviso = null;
    if (!dentroDeHorario(cuando) && !this.esDePrueba(actual)) {
      cuando = siguienteApertura(cuando);
      aviso = await this.avisoFueraDeHorario(actual, ahora);
    }
    this.repo.updateConv(conv.id, { respond_at: cuando.toISOString() });
    return { programada: cuando.toISOString(), ...(aviso ? { aviso_fuera_horario: aviso } : {}) };
  }

  /**
   * Fuera de horario, el lead recibe al momento un aviso automático (texto fijo de Ajustes, sin pasar por la IA):
   * que ahora no se está atendiendo y que se le contesta en cuanto se lea. Uno por cada cierre y chat. Sofía
   * contesta de verdad en la siguiente apertura. Queda en el chat como mensaje del «sistema»: no cuenta como
   * respuesta de Sofía ni entra en lo que lee el modelo (que solo recibe una nota en el contexto).
   */
  async avisoFueraDeHorario(conv, ahora = this.now()) {
    const ajustes = leerAjustes(this.repo);
    const a = ajustes.fueraHorario;
    if (!this.permitido(conv)) return null;
    if (!a?.activo || !a.canales[conv.channel] || !ajustes.ia_activa || !ajustes.canales[conv.channel]) return null;
    if (avisadoEnEsteCierre(conv.aviso_fuera_at, ahora)) return null;
    const texto = textoAviso(a.mensaje, { ahora, nombre: conv.nombre });
    // Se marca antes de enviar: dos mensajes casi a la vez no mandan dos avisos
    this.repo.updateConv(conv.id, { aviso_fuera_at: ahora.toISOString() });
    const msg = { conversation_id: conv.id, autor: 'sistema', tipo: TIPO_AVISO, texto };
    if (!this.enviaDeVerdad(conv)) {
      await this.safe(() => this.ghl.addNote(conv.contact_id, `[Borrador IA, no enviado: aviso fuera de horario]\n${texto}`));
      this.repo.addMessage({ ...msg, enviado: 0 });
      return 'borrador';
    }
    try {
      const r = await this.ghl.sendMessage({ contactId: conv.contact_id, canal: conv.channel, texto });
      this.repo.addMessage({ ...msg, external_id: r?.messageId || null });
      return 'enviado';
    } catch (e) {
      // Puede haber salido aunque GHL no lo confirme: si aparece luego en GHL, no se toma por un mensaje del equipo
      this.anotarSinConfirmar(conv.id, { texto, extra: { autor: 'sistema', tipo: TIPO_AVISO } });
      console.error(`Aviso fuera de horario sin confirmar en ${conv.id}:`, e.message);
      return 'error';
    }
  }

  async clasificar(conv, evt) {
    let telefono = conv.telefono || evt.telefono;
    if (!telefono) {
      const c = await this.safe(() => this.ghl.getContact(conv.contact_id));
      telefono = c?.contact?.phone || null;
      if (telefono) this.repo.updateConv(conv.id, { telefono });
    }
    let socio = { esSocio: false };
    // TEST_PHONES: números del equipo que se tratan siempre como lead (para probar a Sofía desde el CRM)
    const prueba = telefono && esTelefonoPrueba(telefono, this.telefonosPrueba);
    if (telefono && !prueba) socio = (await this.safe(() => this.aimharder.buscarSocioPorTelefono(telefono))) || { esSocio: false };
    if (socio.esSocio) {
      const sede = normalizarSede(socio.sede);
      // Exsocio reciente (última tarifa hace menos de 3 meses): se trata igual que un socio
      this.repo.updateConv(conv.id, { tipo: 'socio', sede, ai_paused: 1, pause_reason: socio.exSocioReciente ? 'exsocio reciente' : 'socio' });
      const etiquetas = [TAGS.tipo.socio, TAGS.tareas.gestion_socio, sede && TAGS.sedes[sede]?.tag, socio.exSocioReciente && 'exsocio'].filter(Boolean);
      await this.safe(() => this.ghl.addTags(conv.contact_id, etiquetas));
      if (sede) await this.safe(() => this.ghl.assign(conv.contact_id, config.ghl.users[sede]));
      // Sin aviso por Telegram: los socios los lleva el equipo desde GHL (etiqueta + asignación). Telegram es solo para leads.
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
    const pendientes = [];
    for (const c of this.repo.dueResponses(ahora.toISOString()).filter((x) => !this.enCurso.has(x.id) && !this.mediosEnCurso?.has(x.id))) {
      if (this.permitido(c) || (await this.intentarAdoptar(c.id))) { pendientes.push(c); continue; }
      // Aislamiento: respuesta pendiente de un chat que no es del número propio (cola de antes, «forzar» desde el panel…)
      this.repo.updateConv(c.id, { respond_at: null, reintentos: 0 });
    }
    // Fuera de horario no se contesta, venga de donde venga la respuesta pendiente (un reintento, un reinicio del
    // servicio, «forzar respuesta»…): pasa a la siguiente apertura. Los chats de prueba del panel y los teléfonos
    // de prueba del equipo (TEST_PHONES) no tienen horario.
    const sinHorario = (c) => String(c.id).startsWith('prueba-') || this.esDePrueba(c);
    if (pendientes.length && !dentroDeHorario(ahora)) {
      const apertura = siguienteApertura(ahora).toISOString();
      for (const c of pendientes) if (!sinHorario(c)) this.repo.updateConv(c.id, { respond_at: apertura });
    }
    const tanda = pendientes.filter((c) => dentroDeHorario(ahora) || sinHorario(c)).slice(0, libres);
    await Promise.all(tanda.map((c) => this.atender(c, ajustes)));
  }

  async atender(c, ajustes) {
    this.enCurso ??= new Set();
    // `tick` no espera a sus chats y puede quedarse esperando a adoptar otro: una segunda vuelta puede haber elegido
    // este mismo chat. Si ya se está atendiendo, o ya se atendió y no le queda respuesta pendiente, no se repite.
    const fresco = this.repo.getConv(c.id);
    if (this.enCurso.has(c.id) || !fresco?.respond_at || Date.parse(fresco.respond_at) > this.now().getTime()) return;
    // Sofía apagada (o el canal) desde el panel: contesta el equipo en GHL
    if (!ajustes.ia_activa || !ajustes.canales[c.channel]) { this.repo.updateConv(c.id, { respond_at: null }); return; }
    this.enCurso.add(c.id);
    const reintentos = c.reintentos || 0;
    const ultimo = reintentos >= ESPERAS_REINTENTO.length;
    let reloj;
    // Si salta el tope, la respuesta que siguiera en marcha queda anulada: no enviará nada cuando termine
    // (si no, podría salir tarde y repetida con el reintento).
    const control = { cancelado: false };
    try {
      this.repo.updateConv(c.id, { respond_at: null, respondiendo_desde: this.now().toISOString() });
      // Antes de contestar se repasa la conversación en GHL: mensajes del lead que no avisó el workflow (entran en
      // esta misma respuesta) y si alguien del equipo ha contestado ya (entonces Sofía no escribe). Va en la cola
      // del chat: si había un webhook a medias, se espera a que termine y esta respuesta ya lo incluye; por eso
      // al acabar se quita la respuesta que ese webhook hubiera dejado programada (si no, saldrían dos).
      if (this.ghl.mensajes && !String(c.id).startsWith('prueba-')) {
        await this.safe(() => this.enSerie(c.id, async () => {
          await this.sincronizar(c.id, null, { programar: false, enMarcha: false });
          this.repo.updateConv(c.id, { respond_at: null });
        }));
      }
      // Reintento de un turno cuyo envío no se confirmó: si al repasar resulta que sí salió, no se contesta otra vez
      if (reintentos > 0 && this.yaContestado(c.id)) { this.repo.updateConv(c.id, { respondiendo_desde: null, reintentos: 0 }); return; }
      // Tope de seguridad: ningún chat ocupa un hueco más de 5 minutos
      await Promise.race([
        this.responder(c.id, { avisarFallo: ultimo, control }),
        new Promise((_, mal) => { reloj = setTimeout(() => { control.cancelado = true; mal(new Error('la respuesta ha tardado más de 5 minutos')); }, this.topeRespuestaMs || 5 * 60000); reloj.unref?.(); }),
      ]);
      this.repo.updateConv(c.id, { respondiendo_desde: null, reintentos: 0 });
    } catch (e) {
      console.error(`Error respondiendo ${c.id} (intento ${reintentos + 1}):`, e.message);
      // El modelo se ha negado (también su respaldo): no se reintenta y el equipo lo sabe ya (en el último intento ya
      // avisa `responder`)
      if (e.rechazo && !ultimo) await this.safe(() => this.avisar?.(`Sofía no ha contestado en el chat de ${c.nombre || c.telefono || c.id}: ${e.message}. Contéstale desde GHL.`, { sede: c.sede }));
      const actual = this.repo.getConv(c.id);
      const patch = { respondiendo_desde: null };
      // Se reintenta solo si no ha salido ya nada de este turno y el lead no ha vuelto a escribir (eso ya lo reprograma)
      const yaSalio = this.yaContestado(c.id);
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
    const faq = preguntas.bloqueConocimiento(this.catalogo); // respuestas del equipo a preguntas que Sofía no sabía
    return systemBlocks(t.prompt ?? knowledge.prompt, `${t.negocio ?? knowledge.negocio.split('\n\n## Festivos')[0]}\n\n${textoFestivos()}${faq ? `\n\n${faq}` : ''}`, this.contexto(conv, extraContexto));
  }

  versiones() { const v = versionesActivas(this.catalogo, this.borradores || {}); return { prompt_v: v.prompt, negocio_v: v.negocio }; }

  contexto(conv, extra = '') {
    const hoy = hoyLocal(this.now());
    return [
      '# Contexto de esta conversación',
      `- Hoy es ${hoy.dia} ${hoy.iso} (${ZONA_TXT}).`,
      `- Canal: ${conv.channel}.`,
      `- Nombre del perfil: ${conv.nombre || 'desconocido'}.`,
      `- Sede conocida: ${conv.sede ? SEDE_NOMBRE[conv.sede] : 'aún no'}.`,
      `- Alta: ${conv.alta_estado || 'no iniciada'}. ${this.textoPrueba(conv)}`,
      '- Puedes ver las imágenes que manda el lead y recibes sus notas de voz ya transcritas (la transcripción puede tener algún error: si algo no se entiende, pregúntalo). Si no se ha podido escuchar un audio, pídele con naturalidad que lo escriba.',
      this.notaAvisoFuera(conv),
      this.notaVoz(conv),
      conv.retomar ? (() => { const r = JSON.parse(conv.retomar); return `- El lead dijo que lo dejaba para más adelante (${r.motivo || 'sin motivo'}); hay que retomarlo el ${r.fecha}. Si vuelve a aplazarlo, indica la nueva fecha en \`retomar\`.`; })() : '',
      primerContacto.contextoIA(conv),
      contextoSolicitud(this.repo.db, conv, this.now()),
      this.etiquetas?.contextoIA(conv.id) || '',
      recursos.contextoIA(this.catalogo),
      extra,
    ].filter(Boolean).join('\n');
  }

  /** Si la respuesta de este turno puede salir como nota de voz, Sofía lo sabe y la escribe para ser oída: breve. */
  notaVoz(conv) {
    const ajustes = leerAjustes(this.repo).voz;
    if (!this.enviaDeVerdad(conv) || !ajustes.activo || !this.voz || !this.ghl?.enviarAdjunto) return '';
    const ultimo = this.repo.db.prepare("SELECT adjunto FROM messages WHERE conversation_id = ? AND autor = 'lead' ORDER BY id DESC LIMIT 1").get(conv.id);
    const d = this.voz.decidirVoz({
      ajustes, canal: conv.channel, clave: this.voz.hayClave(), vozId: this.voz.vozElegida(ajustes), esPrueba: this.esDePrueba(conv),
      ultimoLeadAudio: ultimo?.adjunto === 'audio', mensajes: ['hola'], usoDe: () => this.voz.uso(this.repo.db, conv.id, this.now()),
    });
    if (!d.voz) return '';
    return '- El lead te ha mandado una nota de voz y tu respuesta le va a llegar también como nota de voz, leída tal cual la escribas. Escríbela para ser oída: muy breve (dos o tres frases cortas, unas 200 letras como mucho, 15 segundos), una sola idea y, si hace falta, una pregunta al final. Nada de listas ni de varios precios u horarios seguidos: da solo el dato que te pide. Si necesitas pasar un enlace o muchos datos, escríbelos con normalidad (entonces irá por escrito).';
  }

  /** Si lo último que recibió el lead fue el aviso automático de fuera de horario, Sofía lo sabe al volver. */
  notaAvisoFuera(conv) {
    const db = this.repo.db;
    const aviso = db.prepare("SELECT id, texto FROM messages WHERE conversation_id = ? AND autor = 'sistema' AND tipo = ? ORDER BY id DESC LIMIT 1").get(conv.id, TIPO_AVISO);
    if (!aviso) return '';
    if (db.prepare("SELECT 1 FROM messages WHERE conversation_id = ? AND autor IN ('ia', 'humano') AND id > ? LIMIT 1").get(conv.id, aviso.id)) return '';
    return `- Fuera de horario, al lead le llegó este aviso automático: «${aviso.texto}». Ahora ya le atiendes: contesta a lo que escribió con naturalidad, sin volver a decir que no estabais ni pedir perdón por la espera.`;
  }

  /** Línea de la clase de prueba para el contexto: la reservada aquí, o la del calendario de GHL (metro-trial-ops). */
  textoPrueba(conv) {
    const p = ultimaPrueba(this.repo.db, conv.id);
    if (p) return describirPrueba(p, this.now());
    const t = String(conv.id).startsWith('prueba-') ? null : pruebaTrialOps(conv.contact_id);
    const parla = `Prueba de Parla solicitada: ${conv.prueba_reservada ? 'sí' : 'no'}.`;
    // Una cita por venir manda; una antigua solo es un dato más y el resto del contexto queda igual que sin ella
    if (t) return new Date(t.start_time) > this.now() ? describirTrialOps(t, this.now()) : `${parla} ${describirTrialOps(t, this.now())}`;
    return parla;
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

  async responder(convId, { extraContexto = '', motivo = 'respuesta', plantilla = null, avisarFallo = true, control = null } = {}) {
    const conv = this.repo.getConv(convId);
    if (!conv || conv.ai_paused || conv.derivado) return null;
    if (!this.permitido(conv)) return null; // aislamiento: ni se llama al modelo ni se ejecuta ninguna herramienta
    const ultimoDelLead = () => this.repo.db.prepare("SELECT max(id) m FROM messages WHERE conversation_id = ? AND autor = 'lead'").get(convId)?.m ?? 0;
    const leadAlEmpezar = ultimoDelLead();
    const reinicioAlEmpezar = this.reinicios?.get(convId) || 0;
    const system = this.sistema(conv, extraContexto);
    const messages = await this.mensajesModelo(this.repo.history(convId));
    const efectos = { tags: new Set(), derivado: false, herramientas: [], etiquetas: [] };

    let respuesta;
    const empezo = Date.now();
    try {
      ({ respuesta } = await runTurn({
        system, messages, complete: this.complete, control,
        ejecutarHerramienta: (n, i) => this.herramienta(conv, n, i, efectos),
        onHerramienta: (h) => efectos.herramientas.push(h),
        onUsage: (uso, ms) => this.repo.logRun({ conversation_id: convId, motivo, ms, ...this.versiones(), ...uso }),
      }));
    } catch (e) {
      this.repo.logRun({ conversation_id: convId, motivo, modelo: config.ai.model, error: e.message });
      // ¿Puede salir algo todavía? (mismas condiciones que una respuesta normal: ni pausado ni reiniciado ni ajeno)
      const puedeSalir = () => {
        const a = this.repo.getConv(convId);
        return Boolean(a && this.permitido(a) && (!(a.ai_paused || a.derivado) || efectos.derivado) && (this.reinicios?.get(convId) || 0) === reinicioAlEmpezar);
      };
      // Anulado por el tope mientras pensaba o hacía una gestión: mismo trato que si hubiera terminado tarde
      if (e.cancelado || control?.cancelado) return this.anularTurno(conv, efectos, { avisoAlta: puedeSalir() });
      // El alta ya se hizo en este turno y lo que falló vino después: su aviso al lead sale igualmente (el reintento
      // ya no lo mandaría, el alta consta como hecha) y el turno no se repite
      if (efectos.avisoAlta && puedeSalir()) {
        const salio = await this.enviarAvisoAlta(conv, efectos.avisoAlta);
        e.noReintentar = true;
        await this.safe(() => this.avisar?.(`Sofía dejó hecha el alta pero falló antes de contestar (${e.message})${salio ? '; el aviso del alta sí le ha llegado' : ''}. Revisar el chat de ${conv.nombre || conv.telefono || conv.id}.`, { sede: conv.sede }));
      } else if (avisarFallo) await this.safe(() => this.avisar?.(`La IA falló en una conversación y no ha contestado: ${e.message}`, { sede: conv.sede }));
      throw e;
    }

    // Mientras Sofía pensaba pueden haber escrito el equipo o el lead, y GHL no avisa de lo primero: se repasa la
    // conversación justo antes de enviar (todavía no ha salido nada de este turno).
    if (this.ghl.mensajes && !String(convId).startsWith('prueba-') && !control?.cancelado) {
      await this.safe(() => this.enSerie(convId, () => this.sincronizar(convId, null, { enMarcha: false })));
    }
    // La conversación de prueba se ha reiniciado mientras Sofía pensaba: esta respuesta era de la anterior
    if ((this.reinicios?.get(convId) || 0) !== reinicioAlEmpezar) return null;
    // Mientras Sofía pensaba, alguien del equipo ha escrito o han pausado el chat: no se envía nada
    const ahoraConv = this.repo.getConv(convId);
    if (!ahoraConv || ((ahoraConv.ai_paused || ahoraConv.derivado) && !efectos.derivado)) return null;
    if (!this.permitido(ahoraConv)) return null; // al repasar, la conversación resultó compartida con otra línea
    const hechoFuera = efectos.derivado || efectos.herramientas.some((h) => NO_REPETIBLES.includes(h.nombre));
    // El turno se anuló por tardar demasiado (ya hay un reintento en cola): esta respuesta no sale
    if (control?.cancelado) return this.anularTurno(conv, efectos, { avisoAlta: true });
    // El lead ha vuelto a escribir mientras Sofía pensaba y ya tiene otro turno en cola: esta respuesta contestaría
    // a medias y luego saldría otra. Se descarta y contesta una sola vez con todo delante. No se descarta si en
    // este turno se hizo una gestión que no se repite.
    if (motivo === 'respuesta' && !hechoFuera && ahoraConv.respond_at && ultimoDelLead() > leadAlEmpezar) {
      console.log(`[respuesta] ${convId}: el lead escribió mientras Sofía pensaba; se contesta con el mensaje nuevo incluido`);
      return { ...respuesta, mensajes: [], descartada: true };
    }

    if (conv.prompt_v == null) this.repo.updateConv(convId, { prompt_v: this.versiones().prompt_v });
    await this.aplicarRespuesta(conv, respuesta, efectos);
    let mensajes = (respuesta.mensajes || []).map((m) => m.trim()).filter(Boolean);
    if (plantilla) mensajes = mensajes.slice(0, 1);
    if (!plantilla && mensajes.length) {
      for (const r of this.imagenesInfo(conv, efectos.info, mensajes)) if (!(efectos.recursos ||= []).some((x) => x.id === r.id)) efectos.recursos.push(r);
    }
    try {
      // null = el turno se anuló por tardar antes de que saliera nada: no se envía ni se programa nada más
      if (mensajes.length && (await this.enviar(conv, mensajes, plantilla, control, Date.now() - empezo)) === null) return null;
      if (efectos.recursos?.length) await this.enviarRecursos(conv, efectos.recursos);
    } catch (e) {
      // GHL ha fallado al enviar: queda registrado y el aviso del alta se intenta igualmente. Si en este turno
      // ya se hizo algo que no se debe repetir (alta, derivación), no se reintenta el turno: se avisa al equipo.
      this.repo.logRun({ conversation_id: convId, motivo, modelo: config.ai.model, error: `envío: ${e.message}`, ...this.versiones() });
      if (efectos.avisoAlta) await this.enviarAvisoAlta(conv, efectos.avisoAlta);
      e.noReintentar = Boolean(efectos.avisoAlta || hechoFuera);
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

  /**
   * El turno se anuló por tardar demasiado (atender ya dejó un reintento en cola): su respuesta no sale. Si en él se
   * hizo algo que no se repite (alta, prueba, derivación), se quita el reintento y se avisa al equipo; si fue el alta
   * y aún puede salir algo al chat, su aviso al lead sale igualmente (el reintento no lo mandaría). Devuelve null.
   */
  async anularTurno(conv, efectos, { avisoAlta = false } = {}) {
    const hechas = efectos.herramientas.map((h) => h.nombre);
    if (!efectos.derivado && !hechas.some((n) => NO_REPETIBLES.includes(n))) return null;
    this.repo.updateConv(conv.id, { respond_at: null, reintentos: 0 });
    const salio = avisoAlta && efectos.avisoAlta ? await this.enviarAvisoAlta(conv, efectos.avisoAlta) : false;
    await this.safe(() => this.avisar?.(`Sofía tardó demasiado en un turno en el que ya había hecho una gestión (${hechas.join(', ')}) y no ha enviado su respuesta${salio ? ' (el aviso del alta sí le ha llegado)' : ''}. Revisar el chat de ${conv.nombre || conv.telefono || conv.id}.`, { sede: conv.sede }));
    return null;
  }

  async aplicarRespuesta(conv, r, efectos) {
    const patch = {};
    if (r.fase) patch.fase = r.fase;
    // La fase más avanzada alcanzada se guarda aparte: «cerrada» no dice hasta dónde llegó el chat
    if (r.fase && r.fase !== 'cerrada' && TAGS.embudo.indexOf(r.fase) > TAGS.embudo.indexOf(conv.fase_max)) patch.fase_max = r.fase;
    // Si Sofía no dice la sede pero en este turno ha consultado precios, horarios o recibo de una sola, es esa
    const consultadas = [...new Set((efectos.herramientas || []).map((h) => h.entrada?.sede && normalizarSede(h.entrada.sede)).filter(Boolean))];
    const sede = r.sede && r.sede !== 'desconocida' ? normalizarSede(r.sede) : (!conv.sede && consultadas.length === 1 ? consultadas[0] : null);
    if (sede && sede !== conv.sede) {
      patch.sede = sede;
      efectos.tags.add(TAGS.sedes[sede].tag);
      await this.safe(() => this.ghl.assign(conv.contact_id, config.ghl.users[sede]));
    }
    if (r.fase && r.fase !== 'cerrada') efectos.tags.add(r.fase);
    if (r.analisis) patch.analisis = String(r.analisis).slice(0, 800);
    if (r.siguiente_paso) patch.siguiente_paso = String(r.siguiente_paso).slice(0, 400);
    const nota = Number(r.valoracion?.nota);
    if (Number.isFinite(nota) && nota >= 1) { patch.valoracion = Math.min(10, Math.round(nota)); patch.valoracion_motivo = r.valoracion.motivo ? String(r.valoracion.motivo).slice(0, 300) : null; }
    if (r.resumen) patch.resumen = String(r.resumen).trim().slice(0, 1500);
    if (Object.keys(patch).length) this.repo.updateConv(conv.id, patch);
    if (patch.valoracion != null || patch.resumen) await this.safe(() => this.notaFicha(conv.id));
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

  /**
   * Nota de la ficha del lead en GHL con la valoración y el resumen de Sofía. Es una sola nota por contacto que se
   * va actualizando (si la borran en GHL, se crea otra). No se llama a GHL si el texto no ha cambiado.
   */
  async notaFicha(convId) {
    const c = this.repo.getConv(convId);
    if (!c || (c.valoracion == null && !c.resumen)) return null;
    const cuerpo = `⭐ Valoración de Sofía: ${c.valoracion != null ? `${c.valoracion}/10` : 'sin nota'}${c.valoracion_motivo ? ` · ${c.valoracion_motivo}` : ''}\n\n📝 Resumen de la conversación: ${c.resumen || '—'}`;
    if (cuerpo === c.nota_ghl_texto) return c.nota_ghl_id;
    const cuando = this.now().toLocaleString('es-ES', { timeZone: config.tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const body = `${cuerpo}\n\n(Nota de Sofía: se actualiza sola con cada respuesta. Última: ${cuando})`;
    let id = c.nota_ghl_id;
    if (id) {
      try { await this.ghl.updateNote(c.contact_id, id, body); } catch (e) { if (!/404|not found/i.test(e.message)) throw e; id = null; }
    }
    if (!id) {
      const r = await this.ghl.addNote(c.contact_id, body);
      id = r?.note?.id || r?.id || null;
    }
    this.repo.updateConv(convId, { nota_ghl_id: id, nota_ghl_texto: cuerpo });
    return id;
  }

  /**
   * Borra la conversación de un teléfono de prueba y la deja como recién creada. Quedan dos marcas de sistema (que
   * Sofía no ve) con los ids de GHL del mensaje de reinicio y de la confirmación, y un «suelo»: al repasar GHL no
   * se mira nada anterior, así que los mensajes viejos no vuelven a entrar.
   */
  async reiniciarPrueba(evt, previa) {
    const id = evt.conversationId;
    const base = {
      id, contact_id: evt.contactId || previa?.contact_id, channel: CANALES_NATIVOS.has(evt.canal) ? evt.canal : (previa?.channel || 'whatsapp'),
      nombre: evt.nombre || previa?.nombre || null, telefono: evt.telefono || previa?.telefono || null,
    };
    const marca = evt.fecha && !Number.isNaN(Date.parse(evt.fecha)) ? new Date(evt.fecha).toISOString() : this.now().toISOString();
    this.repo.borrarConversacion(id);
    this.repo.upsertConv(base);
    this.repo.updateConv(id, { ghl_sync_at: marca, ghl_sync_suelo: marca, ...(this.aislamiento.modo === 'activo' ? { aislado_num: this.aislamiento.clave } : {}) });
    this.repo.addMessage({ conversation_id: id, external_id: evt.messageId || null, autor: 'sistema', texto: '[conversación de prueba reiniciada desde WhatsApp]' });
    // Una respuesta que estuviera en marcha para la conversación anterior ya no debe salir
    (this.reinicios ??= new Map()).set(id, (this.reinicios.get(id) || 0) + 1);
    this.sinConfirmar?.delete(id);
    const texto = 'conversación de prueba reiniciada ✅ tu siguiente mensaje empieza de cero';
    const marcaEnvio = { conversation_id: id, autor: 'sistema', texto: `[enviado al teléfono de prueba] ${texto}` };
    try {
      const r = await this.ghl.sendMessage({ contactId: base.contact_id, canal: base.channel, texto });
      this.repo.addMessage({ ...marcaEnvio, external_id: r?.messageId || null });
    } catch (e) {
      // Si GHL no confirma pero el aviso sale, que no se tome por un mensaje del equipo
      this.anotarSinConfirmar(id, { texto, extra: { autor: 'sistema', texto: marcaEnvio.texto } });
      console.error('[reinicio]', e.message);
    }
    console.log(`[reinicio] ${id}: conversación de prueba reiniciada desde WhatsApp`);
    return { reiniciada: true };
  }

  /** ¿Es un teléfono de prueba del equipo (TEST_PHONES)? Se trata siempre como lead, aunque sea socio. */
  esDePrueba(conv) { return Boolean(conv?.telefono && esTelefonoPrueba(conv.telefono, this.telefonosPrueba)); }

  /** ¿Salen de verdad los mensajes a este chat? En modo live, siempre; en shadow, solo a los TEST_PHONES. */
  enviaDeVerdad(conv) {
    return Boolean(this.live || (conv?.telefono && esTelefonoPrueba(conv.telefono, this.telefonosPrueba)));
  }

  /** `yaEsperadoMs`: lo que ha tardado el modelo en pensar; se descuenta del «escribiendo…» de la primera burbuja. */
  async enviar(conv, mensajes, plantilla = null, control = null, yaEsperadoMs = 0) {
    this.exigirPermitido(conv);
    if (plantilla && !this.plantillas()) { const e = new Error('Aislamiento: la plantilla la envía un workflow de GHL y no se puede fijar el número emisor'); e.noReintentar = true; throw e; }
    const { escritura } = retardoHumano(mensajes, { random: this.random });
    if (!this.enviaDeVerdad(conv)) {
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
    // Nota de voz en vez de texto, si las normas de Ajustes lo piden. Si no se puede generar o enviar, sale el texto.
    const antesVoz = Date.now();
    const nota = await this.notaDeVoz(conv, mensajes);
    if (nota) {
      await this.sleep(Math.max(0, escritura[0] - yaEsperadoMs - (Date.now() - antesVoz)));
      if (control?.cancelado) return null;
      const msg = { conversation_id: conv.id, autor: 'ia', texto: mensajes.join('\n'), adjunto: 'audio', media_ruta: nota.media_ruta, media_mime: nota.media_mime };
      try {
        const r = await this.ghl.enviarAdjunto({ contactId: conv.contact_id, canal: conv.channel, url: nota.url, mime: nota.media_mime, nombre: 'nota-de-voz.ogg' });
        this.repo.addMessage({ ...msg, external_id: r?.messageId || null });
        await this.safe(() => this.etiquetas?.alMensaje(conv.id, { autor: 'ia', texto: msg.texto }));
        this.repo.updateConv(conv.id, { last_ai_at: this.now().toISOString() });
        return [r?.messageId || null];
      } catch (e) {
        // GHL puede dejar el audio creado aunque devuelva un error: si aparece luego, es de Sofía. La respuesta
        // sale igualmente por escrito (mejor repetida en voz y texto que sin contestar).
        this.anotarSinConfirmar(conv.id, { texto: msg.texto, url: nota.url, extra: { adjunto: msg.adjunto, media_ruta: msg.media_ruta, media_mime: msg.media_mime } });
        console.error('[voz]', `GHL no aceptó la nota de voz, sale el texto: ${e.message}`);
      }
    }
    for (let i = 0; i < mensajes.length; i++) {
      await this.sleep(i === 0 ? Math.max(0, escritura[0] - yaEsperadoMs) : escritura[i]);
      // Alguien del equipo ha escrito mientras Sofía «escribía»: no se mandan las burbujas que faltan
      if (i > 0 && !pausadaAlEmpezar && this.repo.getConv(conv.id)?.ai_paused) break;
      // El turno se anuló por tardar mientras Sofía «escribía» la primera burbuja: no sale nada (ya hay un
      // reintento en cola). Si ya había salido alguna, se termina de enviar para no dejar la respuesta a medias.
      if (control?.cancelado && !ids.length) return null;
      let r;
      try { r = await this.ghl.sendMessage({ contactId: conv.contact_id, canal: conv.channel, texto: mensajes[i] }); }
      catch (e) {
        // GHL a veces tarda más de 20 s en confirmar un mensaje que sí ha salido: se comprueba en la conversación.
        // Si está, el turno sigue; si no, falla como antes.
        r = await this.confirmarEnvio(conv, mensajes[i]);
        if (!r) { this.anotarSinConfirmar(conv.id, { texto: mensajes[i] }); throw e; }
        console.log(`[envío] ${conv.id}: GHL no confirmó a tiempo, pero el mensaje sí salió`);
      }
      this.repo.addMessage({ conversation_id: conv.id, external_id: r?.messageId || null, autor: 'ia', texto: mensajes[i] });
      ids.push(r?.messageId || null);
      await this.safe(() => this.etiquetas?.alMensaje(conv.id, { autor: 'ia', texto: mensajes[i] }));
    }
    this.repo.updateConv(conv.id, { last_ai_at: this.now().toISOString() });
    return ids;
  }

  /**
   * Nota de voz de esta respuesta ({ media_ruta, media_mime, url }) si las normas de Ajustes dicen que va por voz;
   * null si va por texto, también cuando ElevenLabs o la conversión fallan.
   */
  async notaDeVoz(conv, mensajes) {
    const ajustes = leerAjustes(this.repo).voz;
    if (!ajustes.activo || !this.voz || !this.ghl.enviarAdjunto) return null;
    const ultimo = this.repo.db.prepare("SELECT adjunto FROM messages WHERE conversation_id = ? AND autor = 'lead' ORDER BY id DESC LIMIT 1").get(conv.id);
    const vozId = this.voz.vozElegida(ajustes);
    const d = this.voz.decidirVoz({
      ajustes, canal: conv.channel, clave: this.voz.hayClave(), vozId, esPrueba: this.esDePrueba(conv),
      ultimoLeadAudio: ultimo?.adjunto === 'audio', mensajes, usoDe: () => this.voz.uso(this.repo.db, conv.id, this.now()),
    });
    if (!d.voz) return null;
    try { return await this.voz.sintetizar(d.texto, { vozId, velocidad: ajustes.velocidad, base: this.medios?.base }); }
    catch (e) { console.error('[voz]', `no se ha podido generar la nota de voz, sale el texto: ${e.message}`); return null; }
  }

  /** ¿Está en GHL, recién enviado y sin registrar aquí, un saliente con ese texto? Devuelve { messageId } o null. */
  async confirmarEnvio(conv, texto) {
    if (!this.ghl.mensajes) return null;
    const t = textoComparable(texto);
    for (const espera of [2000, 6000]) {
      await this.sleep(espera);
      const lista = (await this.safe(() => this.ghl.mensajes(conv.id, 15))) || [];
      const desde = new Date(this.now().getTime() - 2 * 60000).toISOString();
      const m = lista.filter((x) => x.direccion === 'outbound' && CANALES_NATIVOS.has(x.canal) && x.fecha > desde && textoComparable(x.texto) === t && (!this.aislado() || salienteVerificado(this.aislamiento, x)))
        .find((x) => !this.repo.db.prepare('SELECT 1 FROM messages WHERE external_id = ?').get(x.id));
      if (m) return { messageId: m.id };
    }
    return null;
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
    this.exigirPermitido(conv);
    for (const r of lista) {
      const msg = { conversation_id: conv.id, autor: 'ia', texto: `[${r.tipo}: ${r.nombre}]`, adjunto: r.tipo, media_ruta: r.media_ruta, media_mime: r.mime };
      if (!this.enviaDeVerdad(conv)) {
        await this.safe(() => this.ghl.addNote(conv.contact_id, `[Borrador IA, no enviado] adjuntaría el archivo «${r.nombre}»`));
        this.repo.addMessage({ ...msg, enviado: 0 });
        continue;
      }
      try {
        const out = await this.ghl.enviarAdjunto({ contactId: conv.contact_id, canal: conv.channel, url: recursos.urlPublica(r), mime: r.mime, nombre: `${r.nombre}${String(r.media_ruta).match(/\.[a-z0-9]+$/i)?.[0] || ''}`, ...(conv.channel === 'whatsapp' ? { texto: recursos.pieDeArchivo(r) } : {}) });
        this.repo.addMessage({ ...msg, external_id: out?.messageId || null });
      } catch (e) {
        // GHL puede dejar el mensaje creado aunque devuelva un error: si aparece luego, es de Sofía
        this.anotarSinConfirmar(conv.id, { texto: msg.texto, url: recursos.urlPublica(r), extra: { adjunto: msg.adjunto, media_ruta: msg.media_ruta, media_mime: msg.media_mime } });
        console.error('[recursos]', e.message);
        await this.avisar?.(`Sofía quiso enviar «${r.nombre}» y GHL no lo aceptó: ${e.message}`, { sede: conv.sede });
      }
    }
  }

  /** Aviso del alta al lead, y comprobación de que el mensaje ha salido al chat. Devuelve si salió. */
  async enviarAvisoAlta(conv, mensajes) {
    try {
      const ids = await this.enviar(conv, mensajes);
      if (this.enviaDeVerdad(conv) && (!ids || ids.length < mensajes.length || ids.some((x) => !x))) throw new Error('GHL no devolvió el id de algún mensaje');
      return true;
    } catch (e) {
      await this.avisar?.(`El alta está hecha pero el aviso al lead no se ha podido comprobar en el chat: ${e.message}. Revisar la conversación.`, { sede: conv.sede });
      return false;
    }
  }

  programarSeguimientos(conv) {
    if (String(conv.id).startsWith('prueba-')) return; // chat de pruebas: se fuerzan a mano desde Probar IA
    const base = this.now().getTime();
    this.repo.cancelScheduled(conv.id, 'Sofía volvió a responder', { soloCortos: true });
    // Sin plantilla solo se puede escribir dentro de las 24 h desde el último mensaje del lead (no desde la respuesta
    // de Sofía): el que caería fuera se adelanta a 15 min antes del cierre de esa ventana, o no se programa.
    const ultimoLead = this.repo.getConv(conv.id)?.last_inbound_at;
    const cierre = ultimoLead ? new Date(ultimoLead).getTime() + VENTANA_SEG_MS - 15 * 60000 : Infinity;
    const todas = reglasSeg.listar(this.catalogo);
    const nivel = leerAjustes(this.repo).intensidadSeguimientos;
    for (const regla of todas) {
      if (regla.tipo !== 'silencio' || !regla.canales.includes(conv.channel) || !regla.activo) continue;
      if (!entraEnNivel(regla, todas, nivel)) continue; // la intensidad elegida en el panel no lo incluye
      let due = base + regla.minutos * 60000;
      if (!regla.plantilla && due > cierre) {
        if (cierre - base < 60 * 60000) continue; // ya no queda ventana para él
        due = cierre;
      }
      this.repo.schedule(conv.id, regla.id, new Date(due).toISOString(), null, 'silencio');
    }
  }

  /**
   * El lead lo deja para más adelante: se cancelan los cortos y se programan los de largo plazo (fecha que indica
   * Sofía; si no hay fecha, ya ha pasado o pasa de un año, la de la regla; si es antes de 3 días, a los 3 días).
   * Salen a las 11:00 en la zona del negocio, también en verano. Devuelve { fecha, motivo, segundo } o null si el
   * canal no lo permite.
   */
  programarLargoPlazo(conv, { fecha = '', motivo = '' } = {}) {
    const reglas = reglasSeg.listar(this.catalogo).filter((r) => r.tipo === 'largo-plazo');
    const primera = reglas.find((r) => !r.despuesDe);
    const ahora = this.now();
    // Fechas del calendario del negocio (no de UTC): «dentro de N días» y las 11:00 de ese día
    const dentroDe = (dias) => hoyLocal(new Date(ahora.getTime() + dias * 864e5)).iso;
    const a11 = (iso) => instanteLocal(iso, '11:00');
    const hoy = hoyLocal(ahora).iso;
    let dia = /^\d{4}-\d{2}-\d{2}$/.test(String(fecha)) && a11(fecha) ? String(fecha) : null;
    if (!dia || dia < hoy || dia > dentroDe(365)) dia = dentroDe(primera?.dias || 21);
    else if (dia < dentroDe(3)) dia = dentroDe(3); // «el lunes» dicho el sábado: lo antes que se le vuelve a escribir
    const objetivo = a11(dia);
    const info = { fecha: dia, motivo: String(motivo || '').slice(0, 300), at: ahora.toISOString() };
    this.repo.updateConv(conv.id, { retomar: JSON.stringify(info) });
    if (!primera || !primera.canales.includes(conv.channel)) return { ...info, programado: false, nota: 'Instagram no deja escribir pasados unos días: no se programa' };
    this.repo.cancelScheduled(conv.id, 'lo deja para más adelante', { tipos: ['silencio', 'largo-plazo'] });
    if (String(conv.id).startsWith('prueba-')) return { ...info, programado: false, nota: 'chat de pruebas: usa «Forzar» para verlo' };
    // La primera en la fecha; las encadenadas (despuesDe), sus días después de la anterior
    const nivel = leerAjustes(this.repo).intensidadSeguimientos;
    const sale = (r) => r.activo && entraEnNivel(r, reglas, nivel);
    let base = objetivo; let anterior = primera;
    if (sale(primera)) this.repo.schedule(conv.id, primera.id, base.toISOString(), { fecha: info.fecha, motivo: info.motivo }, 'largo-plazo');
    for (let r = reglas.find((x) => x.despuesDe === anterior.id); r; anterior = r, r = reglas.find((x) => x.despuesDe === anterior.id)) {
      base = new Date(base.getTime() + r.minutos * 60000);
      if (r.minutos % 1440 === 0) base = a11(hoyLocal(base).iso) || base; // días enteros: a las 11:00 aunque cambie la hora
      if (sale(r)) this.repo.schedule(conv.id, r.id, base.toISOString(), { fecha: info.fecha, motivo: info.motivo }, 'largo-plazo');
    }
    return { ...info, programado: true };
  }

  /**
   * Redacta un mensaje sin enviarlo ni cambiar nada (para preparar el texto de un seguimiento).
   * Solo puede usar herramientas de consulta. Devuelve el texto ('' si Sofía decide no enviar nada).
   */
  async redactar(convId, extraContexto = '', { docs = null, modelo } = {}) {
    const conv = this.repo.getConv(convId);
    if (!conv) return '';
    const system = this.sistema(conv, extraContexto, docs);
    const messages = await this.mensajesModelo(this.repo.history(convId));
    const consulta = { consultar_horarios: (i) => consultarHorarios(i, { hoy: hoyLocal(this.now()).iso }), consultar_tarifas: consultarTarifas, calcular_primer_recibo: calcularPrimerRecibo };
    const { respuesta } = await runTurn({
      system, messages, complete: this.complete, ...(modelo ? { modelo } : {}),
      ejecutarHerramienta: async (n, i) => (consulta[n] ? consulta[n](i) : { ok: false, error: 'Ahora solo estás redactando un mensaje: no uses esta herramienta.' }),
      onUsage: (uso, ms) => this.repo.logRun({ conversation_id: convId, motivo: 'redactar-seguimiento', ms, ...uso }),
    });
    return (respuesta.mensajes || []).map((m) => m.trim()).filter(Boolean).join('\n');
  }

  // ---------- Herramientas ----------

  async herramienta(conv, nombre, input, efectos) {
    switch (nombre) {
      case 'consultar_horarios': {
        const res = consultarHorarios(input, { hoy: hoyLocal(this.now()).iso });
        if (res?.ok && Object.keys(res.dias || {}).length) (efectos.info ||= []).push({ tipo: 'horarios', sede: res.sede, familia: res.modalidad === 'academy' ? 'academy' : 'crossfit_hyrox' });
        return res;
      }
      case 'consultar_tarifas': {
        const res = consultarTarifas({ ...input, plazas_ocupadas: this.plazasSiCanaveral(input.sede) });
        const sede = normalizarSede(input.sede);
        if (res?.ok && sede) (efectos.info ||= []).push({ tipo: 'tarifas', sede, familia: normalizarModalidad(input.familia) === 'academy' ? 'academy' : 'crossfit_hyrox' });
        return res;
      }
      case 'calcular_primer_recibo': return calcularPrimerRecibo({ ...input, plazas_ocupadas: this.plazasSiCanaveral(input.sede) });
      case 'preparar_alta': return this.alta(conv, input, efectos);
      case 'reservar_prueba_parla': return this.reservarPrueba(conv, input, efectos);
      case 'pregunta_sin_respuesta': {
        const ultimo = this.repo.history(conv.id).filter((m) => m.autor === 'lead').pop();
        let r;
        try { r = preguntas.apuntar(this.repo.db, { conversation_id: conv.id, sede: conv.sede, pregunta: input.pregunta, mensaje_lead: ultimo?.texto }); } catch (e) { return { ok: false, error: e.message }; }
        if (r.nueva) await this.avisar?.(`Pregunta que Sofía no sabe responder${conv.sede ? ` (${SEDE_NOMBRE[conv.sede]})` : ''}: «${String(input.pregunta).trim()}». Respóndela en el panel, sección Preguntas (#${r.id}): se le contesta al lead y Sofía la sabrá para siguientes veces.`, { sede: conv.sede });
        return { ok: true, nota: 'Dile con naturalidad que eso lo consultas con el equipo y le escribes en cuanto lo sepas. No inventes la respuesta y sigue con el resto de la conversación.' };
      }
      case 'enviar_recurso': {
        const r = recursos.porNombre(this.catalogo, input.nombre);
        if (!r) return { ok: false, error: 'No hay ningún archivo con ese nombre en la lista.' };
        if ((efectos.recursos ||= []).some((x) => x.id === r.id)) return { ok: true, nota: 'Ya lo vas a enviar en este turno.' };
        efectos.recursos.push(r);
        return { ok: true, nota: 'Se enviará justo después de tus mensajes. No pegues enlaces ni lo describas de más.' };
      }
      case 'derivar_a_equipo': {
        // A veces la IA la llama vacía o de relleno (sin motivo, o con un resumen como «no»): eso no es una derivación y no debe pausar el chat.
        const resumen = String(input?.resumen || '').trim();
        if (!MOTIVOS_DERIVAR.includes(input?.motivo) || resumen.split(/\s+/).filter((p) => p.length > 1).length < 3 || RESUMEN_DE_RELLENO.test(resumen)) {
          return { ok: false, error: 'No se ha derivado: falta el motivo o un resumen de verdad (qué necesita el lead, en una o dos frases). Solo deriva si de verdad lo tiene que llevar una persona (salud, gestión de socio, cobro, llamada, visita o algo que tú no puedes hacer); en ese caso vuelve a llamarla con motivo y resumen. Si no, sigue tú la conversación.' };
        }
        efectos.derivado = true;
        const tarea = { salud: TAGS.tareas.derivado_salud, gestion_socio: TAGS.tareas.gestion_socio, cobro: TAGS.tareas.pago_por_verificar, llamada: TAGS.tareas.llamar, visita: TAGS.tareas.visita }[input.motivo] || TAGS.tareas.responder;
        efectos.tags.add(tarea);
        this.repo.updateConv(conv.id, { derivado: 1, ai_paused: 1, pause_reason: `derivado: ${input.motivo}` });
        this.repo.cancelScheduled(conv.id, 'derivado');
        // Los temas de socio no van a Telegram: quedan en GHL con su etiqueta de tarea
        if (input.motivo !== 'gestion_socio' && conv.tipo !== 'socio') await this.avisar?.(`Derivado (${input.motivo})${conv.sede ? ` · ${SEDE_NOMBRE[conv.sede]}` : ''}: ${input.resumen}`, { sede: conv.sede });
        return { ok: true, nota: 'Avisa al lead de que lo revisa una persona del equipo y que le escribirá por aquí. No sigas vendiendo.' };
      }
      default: return { ok: false, error: `Herramienta desconocida: ${nombre}` };
    }
  }

  /**
   * Clase de prueba en Parla. Con la reserva directa activada (AIMHARDER_RESERVA_PRUEBA=true y live) se apunta en
   * AimHarder como invitado; si no, o si AimHarder no la acepta, se avisa al equipo para que la reserve (como antes).
   * Siempre se comprueba antes que esa clase existe ese día en el calendario de AimHarder.
   */
  reservarPrueba(conv, input, efectos) {
    return this.deUnaEnUna('pruebasEnCurso', conv.id, () => this.reservarPruebaYa(conv, input, efectos),
      { ok: true, estado: 'en_curso', nota: 'Su clase de prueba se está reservando ahora mismo: no la repitas. Dile que se la dejas apuntada y que se la confirmas por aquí.' });
  }

  /**
   * Una gestión lenta (AimHarder) de un chat a la vez: si llega otra mientras tanto (un turno anulado por el tope y
   * su reintento, dos turnos a la vez), no se repite y recibe `enCurso`. La marca se pone antes de esperar nada.
   */
  async deUnaEnUna(clave, convId, fn, enCurso) {
    const marcas = (this[clave] ??= new Set());
    if (marcas.has(convId)) return enCurso;
    marcas.add(convId);
    try { return await fn(); } finally { marcas.delete(convId); }
  }

  async reservarPruebaYa(conv, input, efectos) {
    const modalidad = normalizarModalidad(input.modalidad);
    const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(String(input.fecha_hora || '').trim());
    if (!['academy', 'crossfit', 'hyrox'].includes(modalidad)) return { ok: false, error: 'La prueba es de Academy, CrossFit o HYROX.' };
    if (!m) return { ok: false, error: 'fecha_hora tiene que ser AAAA-MM-DD HH:MM.' };
    const fechaHora = `${m[1]} ${m[2]}`;
    const clase = horaMadrid(fechaHora);
    if (!clase || clase.getTime() - this.now().getTime() < 3600e3) return { ok: false, error: 'Esa clase ya ha pasado o empieza en menos de una hora: propón otra.' };
    const nombre = String(input.nombre_completo || '').trim();
    if (nombre.split(/\s+/).filter(Boolean).length < 2) return { ok: false, error: 'Para apuntarle en AimHarder hace falta su nombre y un apellido: pídeselo antes de reservar.' };
    const email = String(input.email || '').trim();
    if (!EMAIL.test(email)) return { ok: false, error: 'Para reservar la prueba hace falta su email: pídeselo (con los demás datos que falten) antes de reservar.' };
    const telefono = String(input.telefono || '').trim() || conv.telefono;
    if (!telefono && conv.channel !== 'whatsapp') return { ok: false, error: 'Para reservar la prueba hace falta su teléfono (no escribe por WhatsApp): pídeselo antes de reservar.' };
    const db = this.repo.db;
    const anterior = ultimaPrueba(db, conv.id);
    if (anterior && anterior.fecha_hora === fechaHora && anterior.modalidad === modalidad) return { ok: true, estado: 'ya_reservada', nota: 'Ya la tiene a esa hora: no la repitas, confírmasela si hace falta.' };
    const escribir = Boolean(this.live && config.aimharder.reservaPrueba && !String(conv.id).startsWith('prueba-'));
    const res = (await this.safe(() => this.aimharder.reservarPrueba?.({ sede: 'parla', modalidad, fecha: m[1], hora: m[2], nombre_completo: nombre, telefono: telefono || null, email }, { escribir })))
      || { estado: 'simulada', detalle: 'Sin conexión con AimHarder: no se ha comprobado la clase.' };
    if (res.estado === 'no_hay_clase') {
      return { ok: false, error: res.detalle, horas_ese_dia: res.horas || [], nota: res.horas?.length ? 'Propónle una de esas horas (o otro día) y reserva cuando la elija.' : 'Ese día no hay clase de esa modalidad: propón otro día con consultar_horarios.' };
    }
    const estado = res.estado === 'reservada' ? 'reservada' : res.estado === 'fallida' ? 'fallida' : 'simulada';
    guardarPrueba(db, { conversation_id: conv.id, sede: 'parla', modalidad, fecha_hora: fechaHora, estado, schedule_id: res.schedule_id || null, booking_id: res.booking_id || null, nombre, detalle: res.detalle || null });
    if (anterior) {
      actualizarPrueba(db, anterior.id, { estado: 'anulada', detalle: `cambiada a ${fechaHora}` });
      // La anterior estaba en AimHarder: se anula allí después de tener la nueva
      if (anterior.estado === 'reservada' && anterior.booking_id && escribir) {
        const ok = await this.safe(() => this.aimharder.cancelarPrueba?.(anterior));
        if (!ok) await this.avisar?.(`No se ha podido anular en AimHarder la prueba anterior de ${anterior.nombre} (${anterior.modalidad} · ${fechaLegible(anterior.fecha_hora)}): anularla a mano.`, { sede: 'parla' });
      }
    }
    this.repo.updateConv(conv.id, { prueba_reservada: 1 });
    programarCita(this.repo, this.catalogo, conv.id, fechaHora, this.now()); // recordatorios antes y seguimiento después
    const cuando = fechaLegible(fechaHora);
    const cambio = anterior ? ` (cambia la del ${fechaLegible(anterior.fecha_hora)})` : '';
    if (estado === 'reservada') {
      efectos.tags.add(TAGS.tareas.prueba_reservada || 'prueba reservada');
      await this.avisar?.(`Prueba reservada en AimHarder (Parla): ${nombre} · ${modalidad} · ${cuando}${cambio}. Ya está en el calendario: no hace falta hacer nada.`, { sede: 'parla' });
      return { ok: true, estado: 'reservada', nota: 'Ya está reservada en AimHarder. Confírmale el día y la hora en un mensaje; es sin coste. No inventes otros detalles.' };
    }
    efectos.tags.add(TAGS.tareas.prueba_parla);
    await this.avisar?.(`Prueba en Parla pedida: ${nombre} · ${modalidad} · ${cuando}${cambio}. ${estado === 'fallida' ? `AimHarder no la aceptó (${res.detalle}). ` : ''}Reservarla en AimHarder y confirmar al lead.`, { sede: 'parla' });
    return { ok: true, estado: 'solicitada', nota: 'Dile que se la dejas apuntada y que el equipo se la confirma por aquí. Es sin coste.' };
  }

  /**
   * Resultado de la última clase de prueba: alta (ya es socio o Sofía le hizo el alta) · asistio / no_vino / cancelada
   * (metro-trial-ops o AimHarder) · sin_ausencia (pasó y AimHarder no marca ausencia) · sin_dato. Se guarda en la prueba.
   */
  async resultadoPrueba(conv) {
    const db = this.repo.db;
    const p = ultimaPrueba(db, conv.id);
    let resultado = null; let fuente = null;
    if (conv.alta_estado === 'preparada' || conv.tipo === 'socio') { resultado = 'alta'; fuente = 'sofia'; }
    if (!resultado && conv.telefono && !this.esDePrueba(conv) && this.aimharder?.buscarSocioPorTelefono) {
      const socio = await this.safe(() => this.aimharder.buscarSocioPorTelefono(conv.telefono));
      if (socio?.esSocio) { resultado = 'alta'; fuente = 'socios-aimharder'; }
    }
    if (!resultado) {
      const t = String(conv.id).startsWith('prueba-') ? null : pruebaTrialOps(conv.contact_id);
      const mismaClase = t && (!p || String(new Date(t.start_time).toLocaleDateString('sv-SE', { timeZone: config.tz })) === p.fecha_hora.slice(0, 10));
      const rt = mismaClase ? resultadoTrialOps(t) : null;
      const ra = p?.estado === 'reservada' && p.booking_id ? await this.safe(() => this.aimharder?.resultadoPrueba?.(p)) : null;
      // Lo verificado por metro-trial-ops manda sobre «sin ausencia» de AimHarder (que solo dice que nadie marcó la falta)
      if (rt && (!ra || ra === 'sin_ausencia')) { resultado = rt; fuente = 'metro-trial-ops'; } else if (ra) { resultado = ra; fuente = 'aimharder'; }
    }
    resultado ||= 'sin_dato';
    if (p) actualizarPrueba(db, p.id, { resultado, resultado_fuente: fuente, resultado_at: this.now().toISOString() });
    const tag = { asistio: 'prueba asistida', no_vino: 'prueba no show', cancelada: 'prueba anulada' }[resultado];
    if (tag && !String(conv.id).startsWith('prueba-')) await this.safe(() => this.ghl.addTags(conv.contact_id, [tag]));
    return { resultado, fuente, prueba: p };
  }

  /**
   * El equipo ha respondido una pregunta pendiente desde el panel: Sofía se lo cuenta al lead en su chat.
   * Devuelve el resultado en palabras (para el panel).
   */
  async contestarPregunta(p) {
    const conv = p.conversation_id ? this.repo.getConv(p.conversation_id) : null;
    if (!conv) return 'sin chat';
    if (!this.permitido(conv)) return 'aislamiento: el chat no es del número propio de Sofía; no se envía';
    if (conv.ai_paused || conv.derivado) return 'chat pausado o derivado: contéstale tú';
    if (this.enCurso?.has(conv.id)) return 'Sofía estaba contestando en ese chat: no se ha enviado';
    if (!String(conv.id).startsWith('prueba-') && fueraDeVentana(conv, this.now())) return 'han pasado más de 24 h desde su último mensaje: no se puede escribir sin plantilla';
    // Mientras escribe, el chat cuenta como «en curso» (igual que en atender): el bucle de respuestas y los
    // seguimientos no abren otro turno a la vez en él. No va dentro de enSerie: responder ya usa esa cola para
    // repasar GHL y se esperaría a sí mismo.
    (this.enCurso ??= new Set()).add(conv.id);
    let r;
    try { r = await this.responder(conv.id, { extraContexto: preguntas.contextoRespuesta(p), motivo: 'pregunta-respondida', avisarFallo: false }); }
    finally { this.enCurso.delete(conv.id); }
    if (!r) return 'no se ha enviado (chat pausado)';
    if (!r.mensajes.length) return 'Sofía vio que ya estaba contestada';
    return this.enviaDeVerdad(conv) ? 'enviada al lead' : 'borrador (modo prueba)';
  }

  /** ¿Por qué no se puede escribir a mano en este chat desde el panel? Cadena vacía si se puede. */
  motivoNoEscribir(conv) {
    if (!conv) return 'Ese chat no existe.';
    if (String(conv.id).startsWith('prueba-')) return 'Es un chat de prueba: no sale a nadie.';
    if (!this.ghl?.sendMessage) return 'El envío a GHL no está configurado.';
    if (this.aislado() && this.aislamiento.modo !== 'activo') return 'El número de Sofía está mal configurado: no se envía nada.';
    if (!this.permitido(conv)) return 'Este chat no es del número de Sofía: contéstalo en el CRM.';
    if (!CANALES_NATIVOS.has(conv.channel) || (this.aislado() && conv.channel !== 'whatsapp')) return `Desde aquí solo se escribe por WhatsApp${this.aislado() ? '' : ' e Instagram'}: este chat contéstalo en el CRM.`;
    if (fueraDeVentana(conv, this.now())) return 'Han pasado más de 24 h desde su último mensaje: solo se le puede escribir con una plantilla de WhatsApp (abajo, «📨 Plantilla de WhatsApp»).';
    return '';
  }

  /**
   * Una persona del equipo escribe al lead desde el panel. Sale siempre de verdad (también en modo prueba, como si
   * se escribiera en el CRM) y, a partir de ahí, cuenta como cualquier mensaje del equipo: queda en el historial y
   * Sofía se aparta del chat según los ajustes. Los motivos para no enviar llevan `usuario` (se enseñan tal cual).
   */
  /**
   * Envía un archivo del equipo (archivos.js) al chat: con el texto como pie, salvo en los audios (WhatsApp no les
   * pone pie), donde el texto sale antes en su propio mensaje. Devuelve lo que hay que anotar del archivo enviado.
   */
  async enviarArchivo(conv, a, texto = '') {
    const pieAparte = a.tipo === 'audio' && texto;
    if (pieAparte) {
      const r = await this.ghl.sendMessage({ contactId: conv.contact_id, canal: conv.channel, texto });
      this.repo.addMessage({ conversation_id: conv.id, external_id: r?.messageId || null, autor: 'humano', texto });
    }
    const r = await this.ghl.enviarAdjunto({ contactId: conv.contact_id, canal: conv.channel, url: archivos.urlPublica(a), mime: a.mime, nombre: a.nombre, texto: pieAparte ? '' : texto });
    return { messageId: r?.messageId || null, texto: pieAparte || !texto ? `[${a.tipo}: ${a.nombre}]` : texto, medio: { adjunto: a.tipo, media_ruta: a.media_ruta, media_mime: a.mime } };
  }

  /** Una persona del equipo envía un archivo (con texto opcional) desde el panel. Igual que `enviarDelEquipo`. */
  enviarArchivoDelEquipo(convId, archivoId, texto = '') {
    return this.enSerie(convId, async () => {
      const conv = this.repo.getConv(convId);
      const motivo = this.motivoNoEscribir(conv) || (this.ghl?.enviarAdjunto ? '' : 'El envío de archivos no está configurado.');
      const a = archivos.obtener(this.repo.db, archivoId);
      if (motivo || !a) { const e = new Error(motivo || 'Ese archivo ya no está: vuelve a adjuntarlo.'); e.usuario = true; throw e; }
      const r = await this.enviarArchivo(conv, a, String(texto || '').trim());
      const res = await this.onOutbound({ evento: 'outbound', conversationId: conv.id, canal: conv.channel, texto: r.texto, messageId: r.messageId, userId: 'panel', medio: r.medio }, { verificado: true });
      return { ...res, pausada: Boolean(this.repo.getConv(conv.id)?.ai_paused) };
    });
  }

  /** ¿Se le puede mandar una plantilla de WhatsApp a este chat? ('' = sí). A diferencia de un texto, vale pasadas 24 h. */
  motivoNoPlantilla(conv) {
    if (!conv) return 'Ese chat no existe.';
    if (String(conv.id).startsWith('prueba-')) return 'Es un chat de prueba: no sale a nadie.';
    if (conv.channel !== 'whatsapp') return 'Las plantillas solo son de WhatsApp.';
    if (!this.ghl?.enviarPlantillaWa) return 'El envío de plantillas no está configurado.';
    if (this.aislado() && this.aislamiento.modo !== 'activo') return 'El número de Sofía está mal configurado: no se envía nada.';
    if (!this.permitido(conv)) return 'Este chat no es del número de Sofía: contéstalo en el CRM.';
    return '';
  }

  /** Envía una plantilla ya preparada (plantillas.prepararEnvio). Devuelve lo que hay que anotar en el chat. */
  async enviarPlantilla(conv, env) {
    const r = await this.ghl.enviarPlantillaWa({ contactId: conv.contact_id, nombre: env.plantilla.nombre, idioma: env.plantilla.idioma, categoria: env.plantilla.categoria, variables: env.variables, texto: env.texto });
    return { messageId: r?.messageId || null, texto: env.texto, medio: { tipo: 'plantilla' } };
  }

  /** Una persona del equipo envía una plantilla de WhatsApp desde el panel. */
  enviarPlantillaDelEquipo(convId, plantillaId, variables = []) {
    return this.enSerie(convId, async () => {
      const conv = this.repo.getConv(convId);
      const motivo = this.motivoNoPlantilla(conv);
      if (motivo) { const e = new Error(motivo); e.usuario = true; throw e; }
      let env;
      try { env = plantillasWa.prepararEnvio(this.repo.db, plantillaId, variables); } catch (e) { e.usuario = true; throw e; }
      const r = await this.enviarPlantilla(conv, env);
      const res = await this.onOutbound({ evento: 'outbound', conversationId: conv.id, canal: conv.channel, texto: r.texto, messageId: r.messageId, userId: 'panel', medio: r.medio }, { verificado: true });
      return { ...res, pausada: Boolean(this.repo.getConv(conv.id)?.ai_paused) };
    });
  }

  /**
   * Primer contacto: el equipo escribe a alguien que aún no nos ha escrito. Crea (o recupera) el contacto en GHL,
   * le envía la plantilla elegida desde el número de Sofía y deja el chat creado aquí con el motivo, para que Sofía
   * lo sepa si responde. `d`: { telefono, nombre, plantilla, variables, motivo, sofiaResponde }.
   * Si ya hay un chat con ese número no envía nada: devuelve `existente` para abrirlo (ahí se puede mandar la plantilla).
   */
  async iniciarConversacion(d = {}) {
    const fallo = (m) => { const e = new Error(m); e.usuario = true; return e; };
    let v, env;
    try { v = primerContacto.validar(d); env = plantillasWa.prepararEnvio(this.repo.db, v.plantilla, v.variables); } catch (e) { e.usuario = true; throw e; }
    if (!this.ghl?.enviarPlantillaWa || !this.ghl?.upsertContacto) throw fallo('El envío de plantillas no está configurado.');
    if (this.aislado() && this.aislamiento.modo !== 'activo') throw fallo('El número de Sofía está mal configurado: no se envía nada.');
    const previo = primerContacto.chatExistente(this.repo.db, { telefono: v.telefono });
    if (previo) return { existente: previo.id, nombre: previo.nombre };
    const contacto = await this.ghl.upsertContacto({ telefono: v.telefono, nombre: v.nombre });
    const previoGhl = primerContacto.chatExistente(this.repo.db, { contactId: contacto.id });
    if (previoGhl) return { existente: previoGhl.id, nombre: previoGhl.nombre };
    const r = await this.ghl.enviarPlantillaWa({ contactId: contacto.id, nombre: env.plantilla.nombre, idioma: env.plantilla.idioma, categoria: env.plantilla.categoria, variables: env.variables, texto: env.texto });
    const convId = r?.conversationId || (await this.safe(() => this.ghl.buscarConversacion?.(contacto.id)))?.id;
    if (!convId) throw fallo('La plantilla ha salido, pero GHL no ha dicho en qué conversación: el chat aparecerá aquí cuando responda.');
    const ahora = this.now().toISOString();
    return this.enSerie(convId, async () => {
      this.repo.upsertConv({ id: convId, contact_id: contacto.id, channel: 'whatsapp', nombre: v.nombre, telefono: v.telefono });
      this.repo.updateConv(convId, {
        primer_contacto: JSON.stringify({ motivo: v.motivo, plantilla: env.plantilla.nombre, at: ahora }),
        // El chat sale del número propio: queda verificado para el aislamiento igual que uno que entra
        ...(this.aislamiento.modo === 'activo' ? { aislado_num: this.aislamiento.clave } : {}),
        ...(v.sofiaResponde ? {} : { ai_paused: 1, pause_reason: 'primer contacto: lo lleva el equipo' }),
      });
      // Se anota como mensaje del equipo, pero sin apartar a Sofía: abrir la conversación no es contestarla
      this.repo.addMessage({ conversation_id: convId, external_id: r?.messageId || null, autor: 'humano', texto: env.texto, tipo: 'plantilla' });
      await this.safe(() => this.ghl.addNote(contacto.id, `[Primer contacto desde el panel] Plantilla «${env.plantilla.nombre}». Motivo: ${v.motivo}`));
      return { id: convId, contacto: contacto.id, nuevo: contacto.nuevo, texto: env.texto, sofiaResponde: v.sofiaResponde };
    });
  }

  enviarDelEquipo(convId, texto) {
    return this.enSerie(convId, async () => {
      const conv = this.repo.getConv(convId);
      const motivo = this.motivoNoEscribir(conv);
      if (motivo) { const e = new Error(motivo); e.usuario = true; throw e; }
      let r;
      try { r = await this.ghl.sendMessage({ contactId: conv.contact_id, canal: conv.channel, texto }); }
      catch (e) {
        // GHL a veces no confirma a tiempo un mensaje que sí ha salido: se mira antes de dar el error (y evitar un reenvío doble)
        r = await this.confirmarEnvio(conv, texto);
        if (!r) throw e;
      }
      const res = await this.onOutbound({ evento: 'outbound', conversationId: conv.id, canal: conv.channel, texto, messageId: r?.messageId || null, userId: 'panel' }, { verificado: true });
      return { ...res, pausada: Boolean(this.repo.getConv(conv.id)?.ai_paused) };
    });
  }

  /** Plazas de apertura de El Cañaveral ya ocupadas (registro de AimHarder + altas de Sofía que aún no están en él). */
  plazasCanaveral(sinConv = null) {
    return plazasCanaveral(this.repo, { sinConv }).total;
  }

  /** Lo mismo, solo si la consulta es de El Cañaveral (las demás sedes no lo usan y contarlas lee el registro entero). */
  plazasSiCanaveral(sede) { return normalizarSede(sede) === 'el_canaveral' ? this.plazasCanaveral() : 0; }

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

  alta(conv, datos, efectos) {
    return this.deUnaEnUna('altasEnCurso', conv.id, () => this.altaYa(conv, datos, efectos),
      { ok: true, estado: 'en_curso', nota: 'El alta de este lead se está tramitando ahora mismo: no la repitas ni vuelvas a pedir los datos. Dile que en cuanto esté le llega la invitación de AimHarder al correo.' });
  }

  async altaYa(conv, datos, efectos) {
    // Un alta ya hecha no se repite (duplicaría la tarifa y el recibo en AimHarder)
    if (this.repo.getConv(conv.id)?.alta_estado === 'preparada') return { ok: true, estado: 'ya_preparada', nota: 'El alta de este lead ya está hecha: no la repitas ni vuelvas a dar los datos.' };
    if (!String(datos.telefono || '').trim() && !conv.telefono && conv.channel !== 'whatsapp') return { ok: false, error: 'Para el alta hace falta su teléfono (no escribe por WhatsApp): pídeselo antes de tramitarla.' };
    const sede = normalizarSede(datos.sede);
    if (sede === 'el_canaveral') return this.altaCanaveral(conv, datos, efectos);
    // Ya pasada al equipo: no se vuelve a tramitar ni a avisar en cada turno
    if (this.repo.getConv(conv.id)?.alta_estado === 'pendiente') return { ok: true, estado: 'ya_en_tramite', nota: 'El alta de este lead ya está pasada al equipo: no la repitas ni vuelvas a pedir los datos.' };
    if (!knowledge.tarifas[sede]?.[datos.tarifa]) return { ok: false, error: `La tarifa ${datos.tarifa} no existe en ${SEDE_NOMBRE[sede] || 'esa sede'}.` };
    const telefono = datos.telefono || conv.telefono || '';
    const d = { ...datos, sede, telefono, canal: conv.channel };
    delete d.avisar_lead;
    // Antiguo socio en esa sede: se reutiliza su ficha
    const ficha = await this.safe(() => this.aimharder.fichaEnSede?.(telefono, sede));
    if (ficha?.aimharder_id) d.aimharder_id = ficha.aimharder_id;
    const recibo = calcularPrimerRecibo({ sede, tarifa: d.tarifa, fecha_inicio: d.fecha_inicio });
    if (recibo.ok) d.primer_recibo = recibo.primer_recibo;
    // Donde Sofía no escribe de verdad (modo prueba), el alta tampoco: se ensaya sin guardar, diga lo que diga la configuración
    const res = await this.aimharder.prepararAlta(d, this.enviaDeVerdad(conv) ? undefined : { dryRun: true });
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
