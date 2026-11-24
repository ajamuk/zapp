import { config } from './config.js';
import * as reglas from './reglas.js';
import { ajustesFueraHorario, validarFueraHorario } from './fuera-horario.js';
import { ajustesVoz, validarVoz } from './voz.js';

// Teléfonos de prueba de .env (TEST_PHONES): valen mientras no se guarde una lista desde el panel
const TELEFONOS_ENV = [...config.telefonosPrueba];

/** Lista de teléfonos de prueba limpia: «+34600111222», sin repetidos (se comparan por sus 9 últimas cifras). */
export function validarTelefonosPrueba(lista) {
  const vistos = new Set(); const out = [];
  for (const bruto of (Array.isArray(lista) ? lista : String(lista || '').split(/[,;\n]/))) {
    const t = String(bruto ?? '').trim(); if (!t) continue;
    const cifras = t.replace(/\D/g, '').replace(/^00/, '');
    if (/[^\d\s+().-]/.test(t) || cifras.length < 9 || cifras.length > 15) throw new Error(`«${t.slice(0, 30)}» no parece un teléfono (9 cifras, con o sin prefijo)`);
    const k = cifras.slice(-9); if (vistos.has(k)) continue;
    vistos.add(k); out.push(cifras.length === 9 ? `+34${cifras}` : `+${cifras}`);
  }
  if (out.length > 30) throw new Error('Como mucho 30 teléfonos de prueba');
  return out;
}

/**
 * Ajustes que se cambian desde el panel sin reiniciar (se guardan en la base de datos).
 * Lo que no esté guardado sale de .env / config. El modo (prueba o real) NO se cambia desde aquí:
 * pasar a real es una decisión de producción y va en .env.
 */
export function leerAjustes(repo) {
  const g = repo.ajustesGuardados();
  // Interruptores de los seguimientos: viven en cada regla (tabla reglas_seguimiento)
  const seguimientos = Object.fromEntries(reglas.listar(repo.db).map((r) => [r.id, r.activo]));
  return {
    ia_activa: g.ia_activa ?? true,
    canales: { whatsapp: g.canales?.whatsapp ?? true, instagram: g.canales?.instagram ?? true },
    horaInicio: g.horaInicio ?? config.ai.horaInicio,
    horaFin: g.horaFin ?? config.ai.horaFin,
    minDelay: g.minDelay ?? config.ai.minDelay,
    maxDelay: g.maxDelay ?? config.ai.maxDelay,
    typingSpeed: g.typingSpeed ?? config.ai.typingSpeed,
    seguimientos,
    // Controles como los de Zapp
    pausarSiEquipoEscribe: g.pausarSiEquipoEscribe ?? true,   // si una persona del equipo escribe, Sofía se aparta
    palabrasParar: g.palabrasParar ?? [],                       // si aparecen (lead o equipo), Sofía se pausa en ese chat
    palabrasReanudar: g.palabrasReanudar ?? [],                 // si el equipo las escribe, Sofía vuelve a contestar
    canalesPausa: { whatsapp: g.canalesPausa?.whatsapp ?? false, instagram: g.canalesPausa?.instagram ?? false }, // chats nuevos empiezan pausados
    horarioDias: g.horarioDias ?? {},
    // Aviso automático cuando un lead escribe fuera del horario de Sofía: { activo, mensaje, canales }
    fueraHorario: ajustesFueraHorario(g.fueraHorario),
    // Notas de voz de Sofía (voz.js): { activo, soloPruebas, soloSiLeadAudio, maxPorConversacion, maxCaracteres, topeMensual, vozId }
    voz: ajustesVoz(g.voz),
    // Teléfonos de prueba del equipo: siempre lead, sin horario y con envío real también en modo prueba
    telefonosPrueba: g.telefonosPrueba ?? TELEFONOS_ENV,
    canaveralPlazasOcupadas: g.canaveralPlazasOcupadas ?? 0,    // plazas de apertura de El Cañaveral ya ocupadas por otras vías (web, en persona)                           // { lunes: { desde, hasta } | null } (null = ese día no contesta)
  };
}

/** Aplica los ajustes guardados a la configuración en memoria (horario y retrasos). */
export function aplicarAjustes(repo) {
  const a = leerAjustes(repo);
  Object.assign(config.ai, { horaInicio: a.horaInicio, horaFin: a.horaFin, minDelay: a.minDelay, maxDelay: a.maxDelay, typingSpeed: a.typingSpeed, horarioDias: a.horarioDias });
  // Misma lista (no una nueva): el setter la tiene cogida y así el cambio le llega sin reiniciar
  config.telefonosPrueba.splice(0, config.telefonosPrueba.length, ...a.telefonosPrueba);
  return a;
}

export const DIAS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];
const hora = (v) => Number.isInteger(v) && v >= 0 && v <= 23;

/** Valida y guarda un cambio parcial. Devuelve los ajustes nuevos o lanza un error legible. */
export function guardarAjustes(repo, cambio = {}) {
  const actual = leerAjustes(repo);
  const n = { ...actual, ...cambio, canales: { ...actual.canales, ...(cambio.canales || {}) }, seguimientos: { ...actual.seguimientos, ...(cambio.seguimientos || {}) } };
  n.canalesPausa = { ...actual.canalesPausa, ...(cambio.canalesPausa || {}) };
  n.fueraHorario = validarFueraHorario(actual.fueraHorario, cambio.fueraHorario);
  n.voz = validarVoz(actual.voz, cambio.voz);
  n.telefonosPrueba = 'telefonosPrueba' in cambio ? validarTelefonosPrueba(cambio.telefonosPrueba) : actual.telefonosPrueba;
  const palabras = (l) => [...new Set((Array.isArray(l) ? l : String(l || '').split(',')).map((x) => String(x).trim().toLowerCase()).filter((x) => x.length >= 2))].slice(0, 30);
  n.palabrasParar = palabras(n.palabrasParar); n.palabrasReanudar = palabras(n.palabrasReanudar);
  if (n.palabrasParar.some((x) => n.palabrasReanudar.includes(x))) throw new Error('Una palabra no puede parar y reanudar a la vez.');
  if (typeof n.pausarSiEquipoEscribe !== 'boolean') throw new Error('pausarSiEquipoEscribe debe ser sí o no');
  const dias = {};
  for (const [d, v] of Object.entries(n.horarioDias || {})) {
    if (!DIAS.includes(d)) continue;
    if (v === null) { dias[d] = null; continue; }
    if (v === undefined || v === 'normal') continue;
    if (!hora(v.desde) || !hora(v.hasta === 24 ? 0 : v.hasta)) throw new Error('Las horas de cada día van de 0 a 23');
    dias[d] = { desde: v.desde, hasta: v.hasta };
  }
  n.horarioDias = dias;
  n.canaveralPlazasOcupadas = Number(n.canaveralPlazasOcupadas);
  if (!Number.isInteger(n.canaveralPlazasOcupadas) || n.canaveralPlazasOcupadas < 0 || n.canaveralPlazasOcupadas > 5000) throw new Error('Plazas ocupadas en El Cañaveral: un número entero, 0 o más');
  if (typeof n.ia_activa !== 'boolean') throw new Error('ia_activa debe ser sí o no');
  if (!hora(n.horaInicio) || !hora(n.horaFin)) throw new Error('Las horas van de 0 a 23');
  if (!(n.minDelay >= 0 && n.maxDelay >= n.minDelay && n.maxDelay <= 600)) throw new Error('Retraso: mínimo ≥ 0, máximo ≥ mínimo y como mucho 600 s');
  if (!(n.typingSpeed >= 1 && n.typingSpeed <= 20)) throw new Error('Velocidad de escritura: de 1 a 20 letras por segundo');
  for (const [id, on] of Object.entries(cambio.seguimientos || {})) repo.db.prepare('UPDATE reglas_seguimiento SET activo = ? WHERE id = ?').run(on ? 1 : 0, id);
  for (const k of ['ia_activa', 'canales', 'horaInicio', 'horaFin', 'minDelay', 'maxDelay', 'typingSpeed', 'pausarSiEquipoEscribe', 'palabrasParar', 'palabrasReanudar', 'canalesPausa', 'horarioDias', 'fueraHorario', 'voz', 'canaveralPlazasOcupadas', 'telefonosPrueba']) {
    if (JSON.stringify(n[k]) !== JSON.stringify(actual[k])) repo.guardarAjuste(k, n[k]);
  }
  return aplicarAjustes(repo);
}
