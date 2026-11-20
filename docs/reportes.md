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
   cambiadas (en una base temporal en memoria) y un segundo análisis juzga si la nueva respuesta arregla lo reportado
   sin problemas nuevos. Si no, hace un segundo intento con lo aprendido; si tampoco, queda «Ningún cambio funcionó»
   (se puede aplicar igualmente).
4. **Aplicar**: crea una versión nueva en producción con la nota «Reporte #N: …». Si las instrucciones cambiaron
   mientras tanto y el cambio ya no encaja, avisa para volver a analizarlo.

Estados: recibido, analizando, necesita un dato, cambio listo para aplicar, aplicado, ya estaba en las instrucciones,
no se arregla en las instrucciones, ningún cambio funcionó, descartado, error.

Cada análisis hace entre 3 y 6 llamadas al modelo (diagnóstico, repetición de la conversación con Sofía y juicio).
