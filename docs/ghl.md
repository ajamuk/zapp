# Conectar Sofía a GoHighLevel

Guía paso a paso para pasar de «instalado en el VPS» a «modo prueba con conversaciones reales».
Nada de esto envía mensajes a leads mientras `MODE=shadow`: Sofía deja sus respuestas como **notas internas** en el contacto.

## 1. Token de integración privada

GHL → Ajustes → Integraciones privadas → *Crear nueva integración*. Permisos:

| Permiso | Para qué |
| --- | --- |
| `conversations.readonly`, `conversations.write` | encontrar la conversación del contacto |
| `conversations/message.readonly`, `conversations/message.write` | enviar mensajes (solo en `MODE=live`) |
| `contacts.readonly`, `contacts.write` | teléfono, etiquetas, asignar responsable, notas |
| `locations.readonly`, `locations/tags.readonly` | comprobaciones del paso 3 |
| `users.readonly` | sacar los IDs de usuario por sede |
| `calendars.readonly` | (opcional) calendario de la prueba de Parla |

El token va a `GHL_TOKEN` en `/etc/codex-hosting/zapp.env`. `GHL_LOCATION_ID` ya está puesto.

## 2. Secreto del webhook

```sh
openssl rand -hex 32
```

Va a `WEBHOOK_SECRET` y, el mismo valor, en la cabecera del workflow del paso 4.

## 3. Comprobar la conexión

En el VPS, desde la release actual:

```sh
set -a; . /etc/codex-hosting/zapp.env; set +a; npm run comprobar-ghl
```

Solo lee (no toca contactos). Comprueba el token y sus permisos de lectura, lista los **usuarios de la subcuenta con su ID**
para rellenar `GHL_USER_PARLA`, `GHL_USER_GETAFE` y `GHL_USER_LAS_ROSAS` (El Cañaveral usa el de Las Rosas),
el calendario y las etiquetas que todavía no existen. Repetir hasta que diga «Todo correcto».

## 4. Workflow «Sofía · mensaje entrante»

GHL → Automatización → Workflows → nuevo:

- **Disparador:** *Customer Replied*. Filtro de canal: WhatsApp e Instagram (si no se filtra, el servicio ignora SMS y email igualmente).
- **Acción:** *Webhook* (o *Custom Webhook*), método `POST`, URL `https://<dominio-del-webhook>/webhooks/ghl`.
- **Cabecera:** `x-setter-secret` = el valor de `WEBHOOK_SECRET`.
- **Custom Data** (recomendado; el servicio también lee los campos estándar del workflow):

| Clave | Valor (variable de GHL) |
| --- | --- |
| `contactId` | `{{contact.id}}` |
| `body` | `{{message.body}}` |
| `messageType` | `{{message.type}}` o el canal fijo si se hace un workflow por canal (`WhatsApp`, `IG`) |
| `tags` | `{{contact.tags}}` |
| `phone` | `{{contact.phone}}` |
| `contactName` | `{{contact.name}}` |

Lo que el servicio ya resuelve solo:

- **Etiquetas en texto** (`"parla, lead"`) o en lista: las dos valen.
- **Sin `conversationId`:** lo busca en GHL por el contacto (y lo recuerda).
- **Canal numérico o vacío:** lo saca de la conversación en GHL. SMS y email se ignoran.
- **Reintentos:** si llega `messageId`, los duplicados se descartan.

## 5. Activar la entrada en modo prueba

En `zapp.env`: `GHL_WEBHOOK_ENABLED=true` y **`MODE=shadow`**. Reiniciar `codex-zapp`.

Primeras comprobaciones con un mensaje de prueba desde un móvil del equipo:

```sh
curl -s localhost:3200/admin/webhooks?limite=5 -H "Authorization: Bearer $ADMIN_TOKEN"
```

Devuelve cada webhook **tal cual llegó** y lo que hizo Sofía (`programada`, `socio`, `pausada` o `ignorado` con el motivo).
Se guardan los últimos 500. Si sale `ignorado`, el motivo dice qué falta (por ejemplo, el contacto o el canal).
En el contacto de GHL debe aparecer, tras el retardo, una nota `[Borrador IA, no enviado]` y las etiquetas.

## 6. Cuando escribe una persona del equipo

Para que Sofía se aparte sola, el servicio necesita el evento `OutboundMessage` con `userId`.
Los workflows normalmente no lo ofrecen (es un evento de app del Marketplace).
Mientras no lo tengamos, **la norma del equipo es poner la etiqueta `parar ia` antes de escribir** (y `continuar ia` para devolverle el chat).
También se puede pausar desde el panel. En modo prueba no es crítico, porque Sofía no envía nada.

## 7. Antes de `MODE=live`

- [ ] Una semana de borradores revisados en el panel (pestaña Chats) sin errores de formato en `/admin/webhooks`.
- [ ] Plantilla de WhatsApp `zapp_seguimiento_programado` aprobada en GHL, y un envío de prueba a un móvil del equipo
      (el campo exacto que espera la API para plantillas está sin confirmar).
- [ ] Decidido cómo se aparta Sofía cuando escribe el equipo (paso 6).
- [ ] Altas de AimHarder validadas por sede (`AIMHARDER_ALTA_DRY_RUN`).
- [ ] Aprobación de Carlos → traspaso del número a GHL → `MODE=live`.
