# Sofía en un número de WhatsApp propio (aislamiento)

Para que Sofía pueda enviar de verdad (`MODE=live`) sin tocar el número que ya atiende el equipo ni ninguna otra
automatización, se le da un **número de WhatsApp exclusivo** y se activa el aislamiento. Con él:

- **Entrada.** Solo se atiende un mensaje si GoHighLevel, consultado por su API, dice que es un WhatsApp **entrante**,
  de **la subcuenta de Sofía** y **enviado a su número**. Lo que diga el aviso del workflow no cuenta, y el teléfono
  del contacto (quién escribe) nunca se usa como si fuera el destino (a quién escribe).
- **Falla en cerrado.** Si falta cualquiera de esos datos, GHL no responde o la configuración está a medias, el mensaje
  se descarta: no se crea el chat, no se llama a la IA y no se toca el contacto (ni etiquetas, ni notas, ni
  asignación, ni AimHarder, ni avisos al equipo). En el registro queda solo el motivo, sin teléfonos ni texto.
- **Salida.** Todo envío de WhatsApp lleva el número propio como emisor (`fromNumber`). No sale nada por Instagram ni
  Messenger. Las **plantillas** (mensajes fuera de las 24 h) quedan **bloqueadas**: las envía un workflow de GHL y desde
  Sofía no se puede fijar con qué número salen; esos seguimientos quedan como «omitido» con el motivo.
- **Cola heredada.** Los chats que ya había en la base (del número anterior) no están verificados: al arrancar se les
  quita la respuesta pendiente y se cancelan sus seguimientos, y aunque alguien los fuerce desde el panel no sale nada
  ni se toca su contacto. Un chat queda verificado cuando entra por él un mensaje que pasa el control.

Sin las variables de abajo no cambia nada: el modo prueba y el resto del comportamiento siguen como estaban.

## Qué hace falta (pasos mínimos)

1. **Número y subcuenta** (pendiente de confirmar por Carlos). Lo recomendable es una **subcuenta de GHL solo para
   Sofía** con ese único número de WhatsApp conectado: así el aislamiento del servicio se suma al de GHL. Apuntar el
   número en formato internacional (`+34…`) y el id de la subcuenta (Ajustes → Perfil del negocio, o la dirección del
   navegador: `/location/<id>/`).
2. **Token de esa subcuenta.** Integración privada creada **en la subcuenta de Sofía**, con los permisos de
   [activar-ghl.md](activar-ghl.md) y además `conversations/message.readonly` (leer cada mensaje para comprobarlo).
3. **Variables** en `/etc/codex-hosting/zapp.env` (el despliegue lo hace y lo verifica otro proceso):

   ```sh
   GHL_TOKEN=...                    # el de la subcuenta de Sofía
   GHL_LOCATION_ID=<id subcuenta>
   SOFIA_WA_LOCATION_ID=<id subcuenta>   # el mismo: se escribe dos veces a propósito
   SOFIA_WA_NUMERO=+34...
   MODE=shadow                      # primero en prueba
   ```

   Los ids `GHL_USER_*` y `GHL_CALENDAR_PRUEBA_PARLA` son de la subcuenta actual: hay que poner los de la nueva (o
   dejarlos vacíos). `npm run verificar-ghl` y `npm run verificar-aislamiento` lo comprueban sin enviar nada.
4. **Workflow en la subcuenta de Sofía** (no en la actual): disparador *Customer Replied* con *Reply channel* =
   WhatsApp y *Allow re-entry*; acción *Webhook* `POST https://<dominio-webhook>/webhooks/ghl` con la cabecera
   `x-setter-secret`. Sin *Custom Data*. No hay que tocar ningún workflow existente.
5. **Prueba con un móvil del equipo**, todavía en `MODE=shadow`:
   1. Escribir un WhatsApp al número de Sofía. En 15–50 s debe aparecer en ese contacto la nota
      `[Borrador IA, no enviado] …` y el chat en el panel.
   2. Si no aparece: `journalctl -u codex-zapp -n 50 | grep aislamiento` dice el motivo, y
      `npm run verificar-aislamiento -- --contacto <id del contacto>` enseña qué devuelve GHL de ese mensaje.
   3. Escribir desde el mismo móvil a **otro** número de la empresa: Sofía no debe dejar nota ni crear chat.
   4. Añadir ese móvil a `TEST_PHONES` y repetir el paso 1: ahora contesta de verdad. Comprobar **en el móvil** que la
      respuesta llega desde el número de Sofía.
6. **Pasar a `MODE=live`** solo con el visto bueno de Carlos y con los pasos anteriores comprobados.

## Lo que hay que saber antes

- **El destinatario no está documentado por HighLevel.** En su especificación pública (repositorio
  `GoHighLevel/highlevel-api-docs`, `apps/conversations.json` y `docs/webhook events/InboundMessage.md`, revisado el
  23/11/2026 en el commit `0af86a4`), un mensaje trae `locationId`, `direction`, `messageType`, `conversationProviderId`…
  pero **no** el número al que se envió; `to` solo aparece para el correo, y WhatsApp ni figura en la tabla de canales
  del webhook `InboundMessage`. Sofía lee el campo `to` del mensaje si GHL lo devuelve. **Si no lo devuelve, lo descarta
  todo**: es lo que se pidió (sin prueba no se atiende), pero significa que el paso 5 es el que dice si esto funciona
  con la cuenta real. Si GHL no da ese dato, habrá que decidir otra prueba (por ejemplo `conversationProviderId`,
  que sí está documentado) antes de poder usar `MODE=live`.
- **El emisor.** `fromNumber` está documentado en «Send a new message» como «número usado como emisor», sin precisar
  que valga para WhatsApp. Por eso el paso 5.4 se comprueba en el móvil, y por eso se recomienda la subcuenta con un
  solo número.
- **Sin plantillas** no hay mensajes pasadas 24 h desde el último mensaje del lead (recordatorios lejanos,
  «lo dejo para más adelante», lanzamientos a chats antiguos). Para recuperarlos haría falta un workflow de plantilla
  propio de la subcuenta de Sofía y revisar este bloqueo.
- Si el número propio estuviera en la **misma subcuenta** que el actual, un contacto que ya tenía chat conserva su
  historial anterior en la base: Sofía lo vería al contestar. Con subcuenta propia no ocurre.
- Cambiar `SOFIA_WA_NUMERO` invalida lo verificado para el número anterior (los chats vuelven a necesitar un entrante).

Código: `src/aislamiento.js` (reglas), `src/ghl.js` (emisor), `src/setter.js` (entrada y salida). Pruebas:
`test/aislamiento.test.js`.
