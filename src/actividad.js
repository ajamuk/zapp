// Registro de actividad: quién cambió qué desde el panel (como el de Zapp). Se apunta cualquier cambio (no las
// consultas). Quién: el usuario de MetroTools (cabecera X-CFMPO-User que pone nginx) o «clave de administración».
const json = (t) => { try { return JSON.parse(t); } catch { return null; } };

const REGLAS = [
  [/^POST \/panel\/etiquetas$/, (b) => `Creó la etiqueta «${b.nombre}»`],
  [/^PUT \/panel\/etiquetas\/orden$/, () => 'Reordenó las etiquetas'],
  [/^PUT \/panel\/etiquetas\/\d+$/, (b) => `Editó la etiqueta «${b.nombre || ''}»`],
  [/^DELETE \/panel\/etiquetas\/(\d+)$/, (b, m) => `Borró la etiqueta #${m[1]}`],
  [/^POST \/panel\/etiquetas\/(\d+)\/aplicar$/, (b, m) => `Aplicó la etiqueta #${m[1]} a chats anteriores`],
  [/^POST \/panel\/etiquetas\/importar$/, (b) => `Importó de GHL: ${(b.nombres || []).join(', ')}`],
  [/^POST \/panel\/conversaciones\/([^/]+)\/etiquetas$/, (b, m) => `Puso la etiqueta #${b.etiqueta} en el chat ${m[1]}`],
  [/^DELETE \/panel\/conversaciones\/([^/]+)\/etiquetas\/(\d+)$/, (b, m) => `Quitó la etiqueta #${m[2]} del chat ${m[1]}`],
  [/^POST \/panel\/conversaciones\/([^/]+)\/pausar$/, (b, m) => `Pausó a Sofía en el chat ${m[1]}`],
  [/^POST \/panel\/conversaciones\/([^/]+)\/reanudar$/, (b, m) => `Reactivó a Sofía en el chat ${m[1]}`],
  [/^POST \/panel\/conversaciones\/([^/]+)\/forzar$/, (b, m) => `Forzó una respuesta en el chat ${m[1]}`],
  [/^POST \/panel\/conversaciones\/([^/]+)\/programar$/, (b, m) => `Programó un mensaje en el chat ${m[1]}: «${String(b.texto || '').slice(0, 80)}»`],
  [/^POST \/panel\/conversaciones\/([^/]+)\/prueba\/cancelar$/, (b, m) => `Anuló la clase de prueba del chat ${m[1]}`],
  [/^POST \/panel\/conversaciones\/([^/]+)\/reportar$/, (b, m) => `Reportó una respuesta en el chat ${m[1]}: «${String(b.que_fallo || '').slice(0, 80)}»`],
  [/^POST \/panel\/vistas$/, (b) => `Creó la vista «${b.nombre}»`],
  [/^PUT \/panel\/vistas\/\d+$/, (b) => `Editó la vista «${b.nombre || ''}»`],
  [/^DELETE \/panel\/vistas\/(\d+)$/, (b, m) => `Borró la vista #${m[1]}`],
  [/^POST \/panel\/reglas$/, (b) => `Creó el seguimiento «${b.nombre}»`],
  [/^PUT \/panel\/reglas\/(.+)$/, (b, m) => (Object.keys(b).length === 1 && 'activo' in b ? `${b.activo ? 'Encendió' : 'Apagó'} el seguimiento ${m[1]}` : `Editó el seguimiento «${b.nombre || m[1]}»`)],
  [/^DELETE \/panel\/reglas\/(.+)$/, (b, m) => `Borró el seguimiento ${m[1]}`],
  [/^POST \/panel\/seguimientos\/(\d+)\/cancelar$/, (b, m) => `Canceló el envío programado #${m[1]}`],
  [/^POST \/panel\/lanzamientos$/, (b) => `Programó el lanzamiento «${b.nombre}» para ${b.programado_at}`],
  [/^POST \/panel\/lanzamientos\/(\d+)\/cancelar$/, (b, m) => `Canceló el lanzamiento #${m[1]}`],
  [/^PUT \/panel\/ajustes$/, (b) => `Cambió los ajustes: ${Object.keys(b).join(', ')}`],
  [/^POST \/panel\/instrucciones$/, (b) => `${b.produccion ? 'Puso en producción' : 'Guardó como borrador'} una versión nueva de ${b.doc === 'negocio' ? 'la base de conocimiento' : 'el prompt'}: ${b.nota || ''}`],
  [/^POST \/panel\/instrucciones\/(\d+)\/activar$/, (b, m) => `Puso en producción la versión #${m[1]} de las instrucciones`],
  [/^POST \/panel\/reportes$/, (b) => `Envió un reporte general: «${String(b.que_fallo || '').slice(0, 80)}»`],
  [/^POST \/panel\/reportes\/(\d+)\/aplicar$/, (b, m) => `Aplicó el cambio del reporte #${m[1]}`],
  [/^POST \/panel\/reportes\/(\d+)\/descartar$/, (b, m) => `Descartó el reporte #${m[1]}`],
  [/^POST \/panel\/reportes\/(\d+)\/responder$/, (b, m) => `Respondió a la pregunta del reporte #${m[1]}`],
  [/^POST \/panel\/reportes\/(\d+)\/reanalizar$/, (b, m) => `Volvió a analizar el reporte #${m[1]}`],
  [/^POST \/panel\/recursos\/adjunto$/, (b) => `Subió el recurso «${b.nombre}»`],
  [/^PUT \/panel\/recursos\/(\d+)$/, (b, m) => `Editó el recurso «${b.nombre || '#' + m[1]}»`],
  [/^DELETE \/panel\/recursos\/(\d+)$/, (b, m) => `Borró el recurso #${m[1]}`],
  [/^POST \/panel\/alertas\/(\d+)\/resolver$/, (b, m) => `Marcó como resuelta la alerta #${m[1]}`],
  [/^POST \/probar\/conversaciones\/([^/]+)\/reportar$/, (b, m) => `Reportó una respuesta en Probar IA: «${String(b.que_fallo || '').slice(0, 80)}»`],
];

/** Texto legible de un cambio, o null si no se apunta (consultas, Probar IA, comprobaciones). */
export function describir(metodo, ruta, body = {}) {
  const linea = `${metodo} ${ruta.split('?')[0]}`;
  for (const [re, f] of REGLAS) { const m = linea.match(re); if (m) return f(body || {}, m); }
  return null;
}

export function middleware(db) {
  return (req, res, next) => {
    if (req.method === 'GET') return next();
    res.on('finish', () => {
      if (res.statusCode >= 400) return;
      const texto = describir(req.method, req.path, req.body);
      if (!texto) return;
      const quien = req.get('x-cfmpo-user') || (req.get('x-metrotools-client') ? 'MetroTools' : 'clave de administración');
      try { db.prepare('INSERT INTO actividad (quien, accion, ruta) VALUES (?, ?, ?)').run(String(quien).slice(0, 80), texto.slice(0, 500), `${req.method} ${req.path}`); } catch (e) { console.error('[actividad]', e.message); }
    });
    next();
  };
}

export const listar = (db, { quien = '', limite = 300 } = {}) =>
  db.prepare(`SELECT * FROM actividad ${quien ? 'WHERE quien = ?' : ''} ORDER BY id DESC LIMIT ?`).all(...(quien ? [quien] : []), Math.min(1000, Number(limite) || 300));
export const personas = (db) => db.prepare('SELECT quien, count(*) n FROM actividad GROUP BY quien ORDER BY n DESC').all();
