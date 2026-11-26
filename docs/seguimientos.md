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

### Lo que hay en GHL (creado el 23 nov 2026)

1. **Plantilla** `sofia_seguimiento_v1` (WhatsApp → Templates): Marketing, español (SPA), aprobada. Cuerpo:
   `Hola 😊 Te escribimos de CrossFit MetroPolitano. {{1}} Cuéntanos por aquí cuando puedas.`
   La variable `{{1}}` está enlazada en la propia plantilla al campo `{{contact.sofa__texto_de_seguimiento}}`.
   (Meta no admite una plantilla que empiece o acabe en variable: por eso lleva texto fijo delante y detrás. El
   texto de Sofía va en medio, en una sola frase.)
2. **Workflow** «Sofía · enviar plantilla» (publicado):
   - Disparador: *Contact Tag* → *Tag added* → `sofia-enviar-plantilla`.
   - Acción *WhatsApp*: **From phone number = +34 604 84 08 58** (el número de Sofía; es el único de la subcuenta),
     plantilla `sofia_seguimiento_v1`, sin ramas.
   - Acción *Remove contact tag* → `sofia-enviar-plantilla`.
   - *Allow re-entry* activado, para que salga en cada seguimiento.

Configurable con `GHL_TAG_PLANTILLA` y `GHL_CAMPO_PLANTILLA`. Para cambiar el texto fijo hay que crear otra plantilla
(`sofia_seguimiento_v2`), esperar la aprobación de Meta y elegirla en la acción del workflow.

Con el aislamiento activo (`docs/aislamiento-whatsapp.md`) las plantillas solo salen si además está
`SOFIA_WA_PLANTILLAS=true`, que declara justo eso: que este workflow envía desde el número propio. Si alguna vez una
plantilla saliera por otra línea, Sofía lo ve al repasar la conversación y deja de actuar en ese chat.

Cada plantilla de marketing la cobra Meta. Qué reglas la usan se decide en el panel (Seguimientos → «enviar por
plantilla si han pasado 24 h»); hoy: «cierre a los 4 días», los dos de largo plazo y los de la clase de prueba.

## Primer contacto (Chats → «+ Nuevo chat»)

Para escribir a alguien que aún no nos ha escrito: una persona que vino a una prueba hace tiempo, un contacto de un
evento, una recomendación… El equipo pone el **móvil** (9 cifras si es español, o con prefijo), el **nombre**, la
**plantilla** del primer mensaje con sus variables y **por qué le escribimos** (es lo que Sofía sabrá si responde).

- WhatsApp no deja abrir una conversación con texto libre: el primer mensaje siempre es una plantilla aprobada de la
  pestaña Plantillas, enviada directamente (`Ghl.enviarPlantillaWa`) desde el número de Sofía. Meta la cobra.
- El contacto se crea en GHL (o se reutiliza: GHL deduplica por teléfono) con la fuente «Sofía · primer contacto» y
  una nota con el motivo.
- Si ya hay un chat con ese número, no se envía nada: el panel ofrece abrir ese chat (desde ahí se le puede mandar
  una plantilla).
- El chat queda creado con el mensaje enviado y el motivo (`conversations.primer_contacto`). Por defecto Sofía
  contesta cuando la persona responda, sabiendo que la conversación la empezamos nosotros; con la casilla
  desmarcada el chat queda en pausa para el equipo. Al responder se comprueba si es socio como en cualquier chat.
- Con el aislamiento activo, el chat queda verificado para el número propio (sale con `fromNumber`).

Antes de usarlo hace falta una plantilla de marketing aprobada pensada para un primer mensaje (que diga quiénes
somos), dada de alta en GHL y copiada en la pestaña Plantillas.
