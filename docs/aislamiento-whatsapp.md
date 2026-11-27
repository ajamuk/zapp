# Sofía en un número de WhatsApp propio (aislamiento)

Para que Sofía pueda enviar de verdad sin tocar el número que ya atiende el equipo ni ninguna otra automatización, se
le da un **número de WhatsApp exclusivo** y se activa el aislamiento. **`MODE=live` lo exige**: con `MODE=live` y sin
aislamiento el servicio arranca (panel y simulador siguen funcionando) pero no recibe ni envía nada, y sale una alerta
en el panel. En `MODE=shadow` sin aislamiento todo sigue como hasta ahora.

Con el aislamiento activo:

- **Entrada.** Solo se atiende un mensaje si GoHighLevel, consultado por su API, dice que es un WhatsApp **entrante**,
  de **la subcuenta de Sofía** y **enviado a su número** (campo `to`). Lo que diga el aviso del workflow no cuenta
  —tampoco si trae un id de mensaje—, y el teléfono del contacto (quién escribe) nunca se usa como si fuera el destino.
- **Falla en cerrado.** Si falta cualquiera de esos datos, GHL no responde o la configuración está a medias, el mensaje
  se descarta: no se crea el chat, no se llama a la IA y no se toca el contacto (ni etiquetas, ni notas, ni
  asignación, ni AimHarder, ni avisos al equipo). En el registro queda solo el motivo, sin teléfonos ni texto.
- **Salida.** Todo envío de WhatsApp lleva el número propio como emisor (`fromNumber`). No sale nada por Instagram ni
  Messenger. Las **plantillas** (mensajes fuera de las 24 h) quedan **bloqueadas**: las envía un workflow de GHL y desde
  Sofía no se puede fijar con qué número salen; esos seguimientos quedan como «omitido» con el motivo.
- **Mensajes del equipo.** Solo cuenta como «ha escrito una persona» (y aparta a Sofía) un saliente de WhatsApp que GHL
  sitúa en el número propio (campo `from`). Un saliente de otra línea, la copia de un conector o uno que no diga su
  emisor no se importa al chat ni pausa nada. El aviso de saliente del webhook, por sí solo, tampoco.
- **Cola heredada.** Los chats que ya había en la base no están verificados y **no se adoptan nunca**: al arrancar se
  les quita la respuesta pendiente y se cancelan sus seguimientos; no se consultan en GHL, no se les escribe aunque
  alguien los fuerce desde el panel y, si ese mismo contacto escribe al número de Sofía, tampoco se atiende (su
  historial y su estado —pausas, fase, alta— no son de esta línea).

## Una conversación, varias líneas: topología no admitida

En GHL hay **una conversación por contacto y subcuenta**. Si el número de Sofía convive en la misma subcuenta con otra
línea de WhatsApp, un contacto que hable con las dos tiene **un solo `conversationId`**, un solo contacto y unas solas
etiquetas. Eso no se puede separar desde Sofía: sus etiquetas y notas las verían las automatizaciones de la otra línea,
y al revés. Por eso **esa topología no se admite**:

- Si en la conversación de GHL aparece algún WhatsApp de otra línea (un entrante con otro `to` o un saliente con otro
  `from`), Sofía **no actúa en esa conversación**: si no tenía chat, no lo crea; si lo tenía, queda bloqueado
  (`aislado_bloqueo`), sin respuesta pendiente ni seguimientos, y no vuelve a activarse solo aunque después escriban a
  su número. Ningún mensaje de la otra línea entra en su historial ni cuenta como respuesta humana.
- La detección lee entera, por páginas, la conversación de GHL de un chat nuevo o por adoptar (hasta 20 páginas de 30
  mensajes; si no cabe o falla una página, el chat no se atiende todavía). En un chat ya verificado mira lo que ha
  llegado desde el último repaso. No sustituye a la separación real.

**Lo que hay que hacer:** una **subcuenta de GHL solo para Sofía** con su único número. Ahí los contactos, las
conversaciones y las etiquetas son nuevos y no hay nada que compartir. Compartir subcuenta con otra línea no es una
configuración válida para `MODE=live`.

## El número de Sofía es el que ya tenía la subcuenta

Confirmado el 23 nov 2026: el número propio es el WhatsApp que ya está conectado en la subcuenta de GHL, y es el
**único** número de esa subcuenta (WhatsApp → Numbers: 1). Los 86 mensajes revisados por API llevan ese número en
`to` (entrantes) y `from` (salientes). No hay otra línea con la que compartir conversación, así que:

```sh
SOFIA_WA_NUMERO=+34600000099   # número de ejemplo: el real va solo en el .env del servidor
SOFIA_WA_LOCATION_ID=<el mismo id que GHL_LOCATION_ID>
SOFIA_WA_ADOPTAR_CHATS=true     # los chats que ya había son de este mismo número
SOFIA_WA_PLANTILLAS=true        # el workflow «Sofía · enviar plantilla» envía desde este número
```

- **`SOFIA_WA_ADOPTAR_CHATS`**: sin él, un chat que ya estaba en la base no se atiende nunca. Con él, se adopta **uno
  a uno y con prueba**: al entrar un mensaje (o al ir a enviarle algo pendiente) se lee su conversación en GHL y pasa
  a verificado solo si no hay nada de otra línea y hay al menos un WhatsApp entrante al número propio. Conserva su
  historial y su estado (socio, pausa, alta…), que son de esta misma línea, y su cola de seguimientos no se cancela
  al arrancar. Si GHL no lo confirma, sigue sin atenderse.
- **`SOFIA_WA_PLANTILLAS`**: sin él, las plantillas siguen bloqueadas. Ver `docs/seguimientos.md`.
- Si algún día se conecta **otro número** a esta subcuenta, vuelve a aplicar todo lo de «topología no admitida»:
  los chats donde aparezca la otra línea quedan bloqueados.
- Instagram queda fuera: con el aislamiento activo no entra ni sale nada por Instagram.

## Qué hace falta (pasos mínimos)

1. **Número y subcuenta** (pendiente de confirmar por Carlos): una **subcuenta de GHL solo para Sofía** con ese único
   número de WhatsApp conectado (ver «topología no admitida»). Apuntar el
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
   3. Añadir ese móvil a `TEST_PHONES` y repetir el paso 1: ahora contesta de verdad. Comprobar **en el móvil** que la
      respuesta llega desde el número de Sofía.
   4. Contestar a mano desde GHL en ese chat: Sofía debe apartarse (chat en pausa, «humano escribió»).
   5. Si se quiere probar el descarte escribiendo a **otro** número de la empresa, hacerlo con **otro móvil**: Sofía no
      debe dejar nota ni crear chat. (Con el mismo móvil y en la misma subcuenta, esa conversación quedaría bloqueada.)
6. **Pasar a `MODE=live`** solo con el visto bueno de Carlos y con los pasos anteriores comprobados.

## Lo que hay que saber antes

- **`to` y `from` no están documentados por HighLevel, pero la API los devuelve.** En su especificación pública
  (repositorio `GoHighLevel/highlevel-api-docs`, `apps/conversations.json` y `docs/webhook events/InboundMessage.md`,
  commit `0af86a4`, 23/11/2026) un mensaje trae `locationId`, `direction`, `messageType`… pero no el número de la
  línea. Comprobado por API en la cuenta real, con un móvil de pruebas del equipo (3 entrantes y 10 salientes): `to` en
  los entrantes y `from` en los salientes contienen el número de la empresa, **con espacios** («+34 910 00 00 01»).
  Sofía compara solo las cifras, todas (con prefijo de país). Esa comprobación valida el contrato, no qué número será
  el de Sofía. Al no estar documentados, GHL podría dejar de enviarlos: en ese caso Sofía deja de atender (falla en
  cerrado) y se ve en el registro (`[aislamiento] entrante descartado (GHL no indica a qué número se envió)`).
- **El emisor al enviar.** `fromNumber` está documentado en «Send a new message» como «número usado como emisor», sin
  precisar que valga para WhatsApp. Por eso el paso 5.3 se comprueba en el móvil, y por eso la subcuenta con un solo
  número.
- **Sin plantillas** no hay mensajes pasadas 24 h desde el último mensaje del lead (recordatorios lejanos,
  «lo dejo para más adelante», lanzamientos a chats antiguos). Para recuperarlos haría falta un workflow de plantilla
  propio de la subcuenta de Sofía y revisar este bloqueo.
- **Escribir desde el móvil** (la app de WhatsApp del número, vía conector) no aparta a Sofía: esa copia no dice por
  qué línea salió. Para pararla en un chat: contestar desde GHL, la etiqueta `parar ia` o «Pausar» en el panel.
- **Las etiquetas son del contacto**, no de la línea: `parar ia`, `continuar ia` y el resto se siguen leyendo de GHL
  en los chats propios. En una subcuenta solo de Sofía las pone su equipo; es otro motivo para no compartir subcuenta.
- Cambiar `SOFIA_WA_NUMERO` deja sin verificar todos los chats del número anterior, y no se readoptan.
- Un chat bloqueado por compartir conversación no se desbloquea desde el panel (hay que separar la topología).

Código: `src/aislamiento.js` (reglas), `src/ghl.js` (emisor), `src/setter.js` (entrada y salida). Pruebas:
`test/aislamiento.test.js`.

## Instagram

Con `SOFIA_IG_PAGE_ID` (el id de la página de Instagram que GHL pone en `meta.ig.pageId` de cada mensaje), Sofía
también atiende esa cuenta de Instagram de la misma subcuenta. Vacío, Instagram queda fuera, como antes.

- **Solo peticiones claras.** Un chat nuevo de Instagram solo se abre si el mensaje pide información para entrenar
  (precios, horarios, clase de prueba, apuntarse…). Lo decide un modelo pequeño (`INSTAGRAM_FILTRO_MODEL`, Haiku por
  defecto); si falla, un respaldo que solo deja pasar frases inequívocas. Lo que no pasa no crea chat ni toca el contacto:
  lo atiende el equipo en GHL.
- **Nunca historias ni reacciones.** Respuestas o reacciones a historias, publicaciones compartidas, mensajes sin texto
  y emojis sueltos se ignoran siempre, también en un chat ya abierto (`src/instagram.js`).
- **Misma comprobación de origen.** Entra solo lo que GHL confirma que se escribió a esa página; un mensaje de otra
  cuenta de Instagram en la conversación la marca como compartida. Si el equipo contesta desde la cuenta, Sofía se aparta.
- **Ventana de Instagram.** Sin plantillas: pasadas 24 h desde el último mensaje del lead no sale nada (los seguimientos
  se omiten).
