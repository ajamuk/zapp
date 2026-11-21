// «Mi Setter IA» (como en Zapp): un resumen legible de las instrucciones de Sofía por apartados, para que el equipo
// sepa qué hace sin leerse el prompt entero. Se prepara con el modelo optimizador y se guarda con la versión del
// prompt (y de la base de conocimiento) a la que corresponde.
import { pedirJSON } from './llm.js';
import * as docs from './documentos.js';
import { apuntarUso } from './db.js';

export const APARTADOS = ['Quién es y cómo habla', 'Qué tiene que conseguir', 'Cómo lleva la conversación', 'Precios y condiciones', 'Clase de prueba', 'Altas', 'Cuándo pasa el chat al equipo', 'Lo que nunca hace', 'Casos especiales', 'Seguimientos y leads que lo dejan para más adelante'];

const ESQUEMA = {
  type: 'object', additionalProperties: false, required: ['apartados'],
  properties: { apartados: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['titulo', 'puntos'], properties: { titulo: { type: 'string', enum: APARTADOS }, puntos: { type: 'array', items: { type: 'string' } } } } } },
};

export async function resumenInstrucciones(db, { completeJSON, rehacer = false } = {}) {
  const p = docs.enProduccion(db, 'prompt'); const n = docs.enProduccion(db, 'negocio');
  if (!rehacer && p.resumen && p.resumen_negocio_v === n.version) return { version: p.version, negocio_version: n.version, ...JSON.parse(p.resumen) };
  const r = await pedirJSON({
    complete: completeJSON,
    system: 'Explicas, en español claro y para alguien del equipo de un box de CrossFit que no es técnico, qué hace Sofía (su setter por WhatsApp e Instagram) según sus instrucciones. Para cada apartado, de 2 a 6 puntos cortos y concretos, fieles a lo que dicen las instrucciones (con cifras y ejemplos si los hay). No inventes nada: si un apartado no está definido, un único punto «No queda definido en las instrucciones». No copies el prompt: resúmelo.',
    contenido: `Apartados, en este orden: ${APARTADOS.join(' · ')}\n\n<prompt>\n${p.texto}\n</prompt>\n\n<base_de_conocimiento>\n${n.texto}\n</base_de_conocimiento>`,
    schema: ESQUEMA,
    onUsage: (uso) => apuntarUso(db, { motivo: 'resumen-instrucciones', ...uso }),
  });
  const orden = (t) => APARTADOS.indexOf(t);
  const out = { apartados: r.apartados.sort((a, b) => orden(a.titulo) - orden(b.titulo)), generado: new Date().toISOString() };
  db.prepare('UPDATE documentos SET resumen = ?, resumen_negocio_v = ? WHERE id = ?').run(JSON.stringify(out), n.version, p.id);
  return { version: p.version, negocio_version: n.version, ...out };
}
