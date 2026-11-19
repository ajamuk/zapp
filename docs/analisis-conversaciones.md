# Análisis de las últimas 200 conversaciones de Zapp

Fecha: 19 nov 2026 · Muestra: las 200 conversaciones más recientes (del 2 al 19 nov 2026), 6.335 mensajes.
Datos anonimizados: aquí solo hay cifras agregadas, sin nombres, teléfonos ni emails.

## Cifras clave

| Métrica | Valor |
| --- | --- |
| Conversaciones | 200 (162 WhatsApp, 36 Instagram, 2 Messenger) |
| Mensajes del lead / de la IA | 2.401 / 3.625 |
| Mensajes de lead por conversación (mediana) | 10 |
| Longitud de un mensaje de la IA (mediana / p90) | 68 / 154 caracteres |
| Conversaciones con la etiqueta «No contesta» | 177 de 200 |
| Conversaciones cuyo último mensaje es de la IA en fase Cierre | 61 |
| Conversaciones con la IA en pausa | 98 |

## Hallazgo principal: el precio llega tarde

- 127 leads preguntaron el precio.
- Solo 8 lo recibieron en la respuesta inmediata.
- Mediana: el lead escribe 5 mensajes más antes de ver una cifra.
- 31 nunca recibieron el precio.
- 43 tuvieron que volver a preguntarlo.

La causa es el orden fijo del guion: nombre → experiencia → motivo → mañana/tarde → días → precio.
**Cambio en el prompt nuevo:** si el lead pregunta el precio, se pregunta solo lo imprescindible
(sede y, si hace falta, días por semana) y se da la cifra en ese mismo turno. El diagnóstico va después.

## Otros patrones

- **Se pregunta el nombre** en 56 conversaciones, a veces cuando el perfil ya lo trae. El nombre del perfil cuenta.
- **Horarios mezclados:** en algunos casos se dio el horario de otra modalidad (HYROX por CrossFit) o de una sede
  que el lead no había dicho. **Cambio:** los horarios salen de una herramienta que filtra por sede + modalidad + franja,
  no de memoria.
- **Salud:** las limitaciones (p. ej. diástasis, embarazo reciente) se derivan al equipo; el equipo contesta en horas.
  Se mantiene la derivación, con tag `derivado salud` y aviso por Telegram.
- **Alta pendiente:** la IA repite «tu alta sigue pendiente de prepararse» mientras el equipo la prepara a mano.
  **Cambio:** el alta la hace el sistema (navegador sobre AimHarder) y el mensaje con los datos sale al terminar.
- **Mensajes de apertura desde GHL:** muchos mensajes «humanos» son la plantilla de apertura que lanza GHL
  («Hola!! Te escribo porque hemos recibido tu solicitud…»). Uno salió con la URL codificada (`%20`).
  Con todo en GHL desaparece la duplicidad.
- **Menciones en historias de IG:** 20 conversaciones son solo `[story_mention]`. No deben activar a la IA.
- **Temas más preguntados** (conversaciones que lo mencionan): horarios 145, precio 121, nivel/empezar de cero 65,
  alta 41, prueba 33, HYROX 33, ubicación 25, pago 24, permanencia 23, turnos de trabajo 14, salud 11, El Cañaveral 9.

## Fuentes de la configuración copiada

- Ficha del negocio (producto, tarifas, horarios, normas, FAQ, tono, objetivo) — `config/negocio.md`.
- Reglas de follow-up de WhatsApp e Instagram — `config/followups.json`.
- Etiquetas y carpetas — `config/etiquetas.json`.
- 34 informes de cambios del prompt (ago–nov 2026): de ahí salen datos que no estaban en la ficha
  (matrícula, parking, duchas, efectivo y Bizum, festivos, Wellhub, nutricionista, El Cañaveral, publicación de entrenamientos).

El prompt compilado de Zapp (versión 98) no se puede descargar: solo lo ve ScaleX. El prompt nuevo
(`config/prompt-sofia.md`) se ha reescrito desde cero con todo lo anterior.
