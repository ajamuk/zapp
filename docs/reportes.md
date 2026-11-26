# Reportes e instrucciones de Sofía

Como en Zapp: cuando una respuesta de Sofía no gusta, se reporta y el sistema lo convierte en un cambio concreto de
sus instrucciones, comprobado antes de aplicarlo. Aquí lo hace un optimizador automático (en Zapp lo hacía el equipo
de Skalex); nada cambia hasta que alguien pulsa «Aplicar».

## Instrucciones con versiones

Sofía funciona con dos textos guardados en la tabla `documentos` (la primera vez se copian de
`config/prompt-sofia.md` y `config/negocio.md`; desde entonces mandan los de la base):

- **Prompt**: cómo se comporta (estilo, proceso de venta, reglas, cuándo derivar).
- **Base de conocimiento**: datos del negocio. Los festivos se añaden aparte al usarla.

Cada cambio crea una versión. Siempre hay una en producción; las demás son borradores o anteriores.
En **Reportes → Instrucciones de Sofía** se ven las versiones con su diferencia, se edita a mano (como borrador o
directamente en producción) y se vuelve a cualquier versión anterior. En **Probar IA → Simular…** se elige con qué
versión probar (por ejemplo un borrador antes de ponerlo en producción).

## Cómo funciona un reporte

1. **Reportar**: botón ⚑ en cualquier respuesta de Sofía (Chats o Probar IA): qué falló, qué debería haber hecho y,
   si se quiere, el texto exacto. También hay reportes generales sin chat. Se guarda la conversación hasta ese punto.
2. **Diagnóstico** (modelo `OPTIMIZADOR_MODEL`, por defecto `claude-opus-5-5`, con salida JSON estructurada):
   - *cambiar*: propone 1 a 3 cambios mínimos «buscar → reemplazar» en el prompt o en la base de conocimiento,
     generalizados (no para ese lead) y respetando el estilo del documento;
   - *ya_cubierto*: las instrucciones ya lo decían (fallo puntual);
   - *no_prompt*: no se arregla ahí (configuración, seguimientos, integraciones, datos de AimHarder);
   - *duda*: falta un dato del negocio → pregunta al equipo; al responder se vuelve a analizar.
3. **Comprobación**: repite la conversación hasta justo antes de la respuesta reportada con las instrucciones
   cambiadas. Es un turno completo de Sofía, con sus herramientas simuladas (derivar, enviar un archivo, reservar…),
   en una base temporal en memoria. Un segundo análisis, que tiene delante las instrucciones corregidas, la base de
   conocimiento y las tarifas, juzga si la nueva respuesta (y lo que hizo) arregla lo reportado sin problemas graves
   nuevos. Si no, hace un segundo intento con lo aprendido; si tampoco, queda «Ningún cambio funcionó» (se puede
   aplicar igualmente). Si no hay conversación que repetir (reporte general), el cambio queda listo «sin comprobar».
4. **Aplicar**: crea una versión nueva en producción con la nota «Reporte #N: …». Si las instrucciones cambiaron
   mientras tanto y el cambio ya no encaja, avisa para volver a analizarlo.

Estados: recibido, analizando, necesita un dato, cambio listo para aplicar, aplicado, ya estaba en las instrucciones,
no se arregla en las instrucciones, ningún cambio funcionó, descartado, error.

Cada análisis hace entre 3 y 6 llamadas al modelo (diagnóstico, repetición de la conversación con Sofía y juicio).

## Batería de pruebas

Panel → Reportes → **Batería de pruebas**. Mide una versión de las instrucciones (la de producción o un borrador) antes de fiarse de ella.

- **Casos** (`casos_prueba`): «momentos» (una conversación cortada en el punto donde Sofía debe contestar: 32 reales de Zapp anonimizados, más uno por cada reporte que se aplica) y «leads simulados» (un perfil y un primer mensaje; una IA barata hace de lead durante varios turnos; salen de `eval/escenarios.json`). Cada caso lleva criterios de sí o no. Se pueden crear, editar y desactivar desde el panel.
- **Pasada** (`bateria_pasadas`, `bateria_resultados`): ejecuta cada caso N veces contra la Sofía real (mismo código, herramientas simuladas, base en memoria: no toca chats, GHL ni AimHarder). Un caso pasa si no salta ninguna comprobación automática (horas que no existen, estilo, precios donde no toca…) y un juez (modelo `OPTIMIZADOR_MODEL`) da por cumplidos todos los criterios.
- **Grupos**: «ajuste» (para mejorar el prompt mirando sus fallos) y «reserva» (≈1 de cada 4; no se mira para ajustar, sirve para comprobar que una mejora no es casualidad).
- **Comparación**: al abrir una pasada se compara con la última de producción con el mismo filtro: qué casos mejoran y cuáles empeoran.
- **Coste**: una pasada completa ronda 2-2,5 € por repetición (medido en la primera: 2,35 $ con 58 casos); el coste real queda en cada pasada. Solo puede haber una en marcha; si el servicio se reinicia queda como interrumpida.
- Modelos: Sofía `ANTHROPIC_MODEL`, lead simulado `BATERIA_LEAD_MODEL` (por defecto Haiku), juez `OPTIMIZADOR_MODEL`.

Forma de trabajar recomendada: pasada de referencia en producción → crear borrador del prompt → pasada del borrador solo «ajuste» → cuando mejore, pasada completa → si no empeora nada en «reserva», activar.
