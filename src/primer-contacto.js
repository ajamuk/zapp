// Primer contacto: el equipo escribe desde el panel a alguien que aún no nos ha escrito (conversación nueva).
// WhatsApp solo deja abrir una conversación con una plantilla aprobada por Meta, así que el primer mensaje siempre
// sale por plantilla (catálogo de plantillas.js). Cuando la persona responde, el chat sigue como cualquier otro:
// Sofía contesta (o no, si el equipo lo deja en pausa) sabiendo por qué le escribimos.

/**
 * Teléfono en formato internacional (+34600111222). Admite espacios, guiones, puntos y paréntesis, el prefijo con
 * 00 y los números españoles de 9 cifras sin prefijo. Devuelve null si no parece un móvil válido.
 */
export function normalizarTelefono(t) {
  let s = String(t ?? '').trim().replace(/[\s().-]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (/^[6789]\d{8}$/.test(s)) s = `+34${s}`;
  if (!/^\+[1-9]\d{7,14}$/.test(s)) return null;
  if (s.startsWith('+34') && !/^\+34[6789]\d{8}$/.test(s)) return null;
  return s;
}

/** Las 9 últimas cifras: para comparar teléfonos guardados con formatos distintos. */
const cola = (t) => String(t || '').replace(/\D/g, '').slice(-9);

/** Chat que ya tenemos con ese teléfono (o con ese contacto de GHL), si lo hay. */
export function chatExistente(db, { telefono, contactId = null }) {
  if (contactId) {
    const c = db.prepare('SELECT * FROM conversations WHERE contact_id = ? ORDER BY updated_at DESC LIMIT 1').get(contactId);
    if (c) return c;
  }
  const n = cola(telefono);
  if (n.length < 9) return null;
  return db.prepare('SELECT * FROM conversations WHERE telefono IS NOT NULL ORDER BY updated_at DESC').all().find((c) => cola(c.telefono) === n) || null;
}

/** Datos del formulario del panel, ya comprobados. */
export function validar(d = {}) {
  const telefono = normalizarTelefono(d.telefono);
  if (!telefono) throw new Error('Escribe un móvil válido: 9 cifras si es español, o con su prefijo (+351…, +44…).');
  const nombre = String(d.nombre || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  if (!nombre) throw new Error('Escribe el nombre de la persona: así sale en el chat y en GHL.');
  if (!d.plantilla) throw new Error('Elige la plantilla del primer mensaje: WhatsApp no deja abrir una conversación con texto libre.');
  const motivo = String(d.motivo || '').trim().slice(0, 600);
  if (!motivo) throw new Error('Cuenta a Sofía por qué le escribimos (p. ej. «vino a una clase de prueba en 2025 y no se apuntó»): lo usará cuando responda.');
  return { telefono, nombre, plantilla: Number(d.plantilla), variables: Array.isArray(d.variables) ? d.variables : [], motivo, sofiaResponde: d.sofiaResponde !== false };
}

/** Línea para el contexto de Sofía en un chat que empezamos nosotros. */
export function contextoIA(conv) {
  if (!conv?.primer_contacto) return '';
  let p; try { p = JSON.parse(conv.primer_contacto); } catch { return ''; }
  return `- Esta conversación la empezamos nosotros: le escribimos por primera vez el ${String(p.at || '').slice(0, 10)} con una plantilla de WhatsApp (es el primer mensaje del chat). Motivo que nos dio el equipo: ${p.motivo}. No te escribió él: no le preguntes qué necesita como si nos hubiera escrito por su cuenta; sigue desde ese mensaje, con naturalidad, y si no le interesa, despídete con amabilidad.`;
}
