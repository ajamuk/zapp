# Seguimientos (follow-ups) y plantillas de WhatsApp

## Cómo funcionan

- **Normales** (`config/followups.json`): se programan cada vez que Sofía responde y cuentan desde ese momento
  (5 h, 6 h tras reserva, 24 h, 4 días). Se cancelan si el lead contesta, si escribe alguien del equipo, o si se
  pausa o deriva el chat.
- **Largo plazo** 🗓️: si el lead dice que lo decidirá o se apuntará más adelante, Sofía rellena `retomar`
  (fecha AAAA-MM-DD y motivo). Se cancelan los normales y se programan «Retomar más adelante» (en esa fecha, entre
  3 días y 1 año; si no da fecha, a los 21 días) y «Segundo intento» 30 días después, a las 11:00. No se cancelan
  si el lead escribe: antes de enviar, Sofía comprueba si siguen teniendo sentido. Si lo vuelve a aplazar, la fecha
  se actualiza. Solo WhatsApp (Instagram no deja escribir pasados unos días).
- **Texto previsto**: el panel enseña el texto que Sofía enviaría (Chats, Seguimientos y Probar IA). Se guarda junto
  al seguimiento con el último mensaje del chat; al vencer, si el chat no ha cambiado se envía ese mismo texto sin
  volver a llamar a la IA; si ha cambiado, se vuelve a redactar. Si Sofía decide que no se cumple la condición, no
  sale nada.
- **Modo prueba** (`MODE=shadow`): se programan igual y, al vencer, quedan como borrador (nota en GHL), sin enviarse.

## Gestión desde el panel (pestaña Seguimientos)

Las reglas viven en la tabla `reglas_seguimiento` (la primera vez se copian de `config/followups.json`, que ya solo
sirve de semilla y para el estilo común). Desde el panel se crean, editan, apagan y borran. Cada regla tiene:

- **Cuándo**: *cuando el lead se queda callado* (X después de la última respuesta de Sofía; se cancela si el lead
  escribe), *al ponerse una etiqueta* (X después; una vez por chat y etiqueta; solo se cancela si quitan la etiqueta),
  *antes de la clase de prueba* (X antes; se prepara cuando Sofía pide la prueba de Parla y se cancela con «Anular o
  cambiada» en el chat), *después de la clase de prueba* (X después de la hora de la clase, para saber qué tal y
  cerrar el alta; se cancela igual) y *cuando lo deja para más adelante* (en la fecha que dé el lead; se pueden encadenar).
- **Canales**, **condición** (siempre / solo si…, la comprueba Sofía justo antes de enviar).
- **Quién escribe**: Sofía (con instrucciones) o un **texto fijo**; lo que va [entre corchetes] lo rellena Sofía sin
  tocar el resto (como mucho 3 huecos). Si Sofía cambia el texto fijo o no tiene el dato, no sale.
- **A quién no le llega**: socios o con el alta hecha, chats pausados o derivados, o quien escribió hace menos de X h.
- **Al enviarse**: poner una etiqueta; enviar por plantilla si han pasado 24 h (si no, no sale).

**Mensaje programado a mano** (cada chat → «Programar mensaje»): el texto sale tal cual a esa hora exacta, sin IA ni
horario; por plantilla si ya no hay ventana. Se cancela desde el chat o desde Seguimientos.

**Lanzamientos** (Seguimientos → «+ Lanzamiento»): un aviso con fecha y hora para los leads activos en los últimos
N días (WhatsApp y/o Instagram), solo con o sin ciertas etiquetas, nunca a socios ni a chats derivados. El panel
enseña a cuántos les llegaría. A la hora, se calcula la lista y se envía tal cual, uno cada 20 s; en WhatsApp por
plantilla a quien escribió hace más de 24 h (Meta cobra cada mensaje). En modo prueba queda como borrador.

## Plantillas de WhatsApp (fuera de las 24 h)

WhatsApp solo deja escribir por plantilla aprobada cuando han pasado 24 h desde el último mensaje del lead. La API
de GHL no admite variables de plantilla, así que el envío se hace con un **workflow de GHL**:

1. Sofía guarda el texto en el campo de contacto **«Sofía · Texto de seguimiento»**
   (clave `{{contact.sofa__texto_de_seguimiento}}`; se crea solo la primera vez).
2. Quita y vuelve a poner la etiqueta **`sofia-enviar-plantilla`** al contacto.

### Qué hay que crear en GHL (una vez)

1. **Plantilla de WhatsApp** aprobada por Meta (WhatsApp → Templates), categoría *Marketing* o *Utility*, idioma
   español, con **una variable en el cuerpo**. Ejemplo de cuerpo: `{{1}}` o `hola 😊 {{1}}`. Ejemplo para Meta:
   «me dijiste que en enero te ponías con ello, te miro horarios para empezar?».
2. **Workflow** «Sofía · enviar plantilla»:
   - Disparador: *Contact Tag* → añadida → `sofia-enviar-plantilla`.
   - Acción: *WhatsApp* → enviar plantilla → la del paso 1 → variable 1 = `{{contact.sofa__texto_de_seguimiento}}`.
   - Acción: *Remove Contact Tag* → `sofia-enviar-plantilla`.
   - Permitir volver a entrar en el workflow (re-entry), para que salga en cada seguimiento.

Configurable con `GHL_TAG_PLANTILLA` y `GHL_CAMPO_PLANTILLA`. Mientras no exista el workflow, los seguimientos por
plantilla se marcan como enviados en el panel pero no le llegan al lead.
