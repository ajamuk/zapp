# Activar a Sofía en GHL

Orden pensado para no tocar a ningún lead hasta el final. Los pasos 1 a 5 dejan a Sofía en **modo prueba**
(`MODE=shadow`): lee cada mensaje y deja su respuesta como **nota interna** en el contacto, sin enviar nada.
El paso 6 (enviar de verdad) espera la aprobación de Carlos.

## 1. Token de GHL

GHL → Ajustes → Integraciones privadas → *Crear nueva integración*. Permisos:

- `conversations.readonly`, `conversations.write`, `conversations/message.write`
- `contacts.readonly`, `contacts.write` (incluye etiquetas y notas)
- `locations.readonly`, `locations/tags.readonly`, `locations/tags.write`, `locations/customFields.readonly`, `locations/customFields.write`
- `users.readonly`
- `calendars.readonly` y `calendars/events.write` si se usa la prueba de Parla

Copiar el token a `GHL_TOKEN` en `/etc/codex-hosting/zapp.env`.

## 2. Variables en el VPS

En `/etc/codex-hosting/zapp.env`:

```sh
MODE=shadow
GHL_WEBHOOK_ENABLED=true
GHL_TOKEN=...
GHL_LOCATION_ID=ZzJQpaOb7hMdco1EsiiF
WEBHOOK_SECRET=...          # openssl rand -hex 24
ANTHROPIC_API_KEY=...
GHL_USER_PARLA=sLgnrdRLAga2CGdokcDQ     # usuario «MPO Parla»
GHL_USER_GETAFE=iMUgiA6Znf4twwLX7iT2    # «MPO Getafe»
GHL_USER_LAS_ROSAS=qIS1fE7PimrcQ5IJiIFy
```

## 3. Comprobar

```sh
cd /opt/codex-hosting/apps/zapp/current
set -a; . /etc/codex-hosting/zapp.env; set +a
npm run verificar-ghl
```

Comprueba token, cuenta, usuarios de cada sede (y lista los ids para copiarlos), etiquetas y permisos.
No envía nada. Reiniciar después: `systemctl restart codex-zapp` y `curl -s https://<dominio-webhook>/health`.

## 4. Workflow «Sofía · Mensaje entrante»

GHL → Automatización → Workflows → nuevo desde cero:

- **Disparador:** *Customer Replied* → filtro *Reply channel* es WhatsApp **o** Instagram.
  Activar *Allow re-entry* (si no, solo salta con el primer mensaje de cada contacto).
- Ya hay un borrador «Metro Setter · Eventos · Respuesta lead»: se puede reutilizar.
- **Acción:** *Webhook* (o *Custom Webhook*), método `POST`, URL `https://<dominio-webhook>/webhooks/ghl`.
  - Cabecera: `x-setter-secret` = el `WEBHOOK_SECRET`.
  - No hace falta nada en *Custom Data*: el servicio lee `contact_id`, `full_name`, `phone` y `tags` del formato de
    GHL y, con cada aviso, lee los mensajes nuevos de la conversación en GHL (id, canal y adjuntos). Así no se pierde
    ninguno aunque GHL se salte el aviso de un mensaje que llega mientras procesa el anterior.
  - Dos disparadores *Customer Replied* (uno por canal): el filtro *Reply channel* solo admite un valor.
- Guardar y **publicar**.

## 5. Probar con un número propio

1. Escribir por WhatsApp al número del centro desde un móvil del equipo.
2. En GHL, en ese contacto, a los 15–50 s debe aparecer una nota `[Borrador IA, no enviado] …`.
3. En el panel (`/zapp/`) se ve el chat. Si no llega nada: *Historial de ejecución* del workflow (código de
   respuesta: 401 = secreto mal puesto, 503 = `GHL_WEBHOOK_ENABLED=false`) y `journalctl -u codex-zapp -n 100`.

Dejarlo unos días en prueba y comparar las notas de Sofía con lo que contesta el equipo.

## 6. Enviar de verdad (con el visto bueno de Carlos)

- Antes de contestar, Sofía repasa la conversación en GHL: si alguien del equipo ya ha escrito (desde GHL o desde
  el móvil), se aparta de ese chat. Para pararla antes de escribir, etiqueta `parar ia`; para devolvérselo,
  `continuar ia`. Los mensajes de otros workflows de GHL no la apartan.
- **Hace falta un número de WhatsApp propio de Sofía, en una subcuenta solo suya** (sin tocar el número ni los
  workflows que ya hay): ver [aislamiento-whatsapp.md](aislamiento-whatsapp.md). Sin ese aislamiento configurado,
  con `MODE=live` el servicio no recibe ni envía nada.
- `MODE=live` en `zapp.env` y `systemctl restart codex-zapp`.
- Plantilla de WhatsApp fuera de las 24 h: ver `docs/seguimientos.md`.
