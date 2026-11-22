# ZAPP · Sofía

Setter IA de CrossFit MetroPolitano. Sustituye a Zapp (ScaleX).

- **GoHighLevel** es la bandeja y el CRM: los canales (un número de WhatsApp + Instagram) viven en GHL y el equipo trabaja ahí.
- **Este servicio** es el cerebro: recibe cada mensaje por webhook de GHL, separa socios de leads (AimHarder),
  contesta como Sofía, etiqueta, asigna, programa seguimientos y prepara el alta en AimHarder.

> **Estado:** revisión interna en MetroTools. En el VPS arranca con `MODE=shadow` y `GHL_WEBHOOK_ENABLED=false`.
> Al habilitar la entrada en modo prueba, Sofía puede añadir notas, etiquetas y asignaciones en GHL.
> El traspaso del número y el paso a `MODE=live` esperan la aprobación de Carlos.

## Estructura

| Ruta | Qué es |
| --- | --- |
| `config/prompt-sofia.md` | Prompt de Sofía, reescrito con lo aprendido en Zapp |
| `config/negocio.md` | Base de conocimiento: tarifas, sedes, normas, pagos, prueba de Parla… |
| `config/horarios.json`, `tarifas.json`, `festivos.json` | Datos que usan las herramientas (no se dejan a la memoria del modelo) |
| `config/followups.json` | Seguimientos copiados de Zapp |
| `config/etiquetas.json` | Etiquetas de GHL: sede, tipo, tareas, control de la IA |
| `config/aimharder-alta.json` | Pasos del alta por navegador (pendiente de grabar) |
| `src/setter.js` | Lógica principal |
| `src/followups.js` | Seguimientos (ventana de 24 h y plantilla de WhatsApp) |
| `docs/analisis-conversaciones.md` | Análisis de 200 conversaciones de Zapp |
| `docs/aimharder.md` | Cómo terminar la parte de AimHarder |

## Probar en local

```sh
npm install
npm test                                  # pruebas sin red
ANTHROPIC_API_KEY=... npm run simular     # chat de terminal con Sofía (modelo real, sin GHL)
ANTHROPIC_API_KEY=... npm run evaluar     # réplica de 32 momentos reales de Zapp → data/informe-evaluacion.md
npm run sync-aimharder                    # horarios desde AimHarder + aviso si cambia algún precio
```

## Probar a Sofía

La pestaña **Probar IA** del panel usa la misma lógica conversacional con GHL y AimHarder simulados y las etiquetas reales.
Requiere `ANTHROPIC_API_KEY`. Las pruebas se guardan en `data/pruebas.db` (otra base: nunca se mezclan con los chats reales).
El simulador HTML independiente se puede regenerar con `npm run build-simulador`.

## Instalación en el VPS

- Panel: [ZAPP · Sofía en MetroTools](https://apps.crossfitmpo.com/zapp/). Aparece en «En desarrollo» para administradores.
- Servicio: `codex-zapp.service` en `127.0.0.1:3200`. Código en `/opt/codex-hosting/apps/zapp/current`.
- Configuración: `/etc/codex-hosting/zapp.env`. La base SQLite se conserva en el `DB_PATH` de la instalación anterior.
- Proxy: `deploy/nginx-metrotools.conf` usa la sesión de MetroTools. Nginx añade la credencial de administración desde el servidor.
  El dominio del webhook expone únicamente el webhook y `/health`.
- Para actualizar: instalar en una release nueva con `npm ci --omit=optional`, validar con `npm test`,
  conservar los horarios específicos del VPS y cambiar `current` antes de reiniciar `codex-zapp`.

## Conectar GHL

Guía paso a paso: [`docs/activar-ghl.md`](docs/activar-ghl.md). En el VPS, `npm run verificar-ghl` comprueba token, usuarios y permisos sin enviar nada.

1. En GHL: Ajustes → Integraciones privadas → token con permisos de conversaciones (leer/escribir), contactos (leer/escribir) y notas. Va a `GHL_TOKEN`.
2. Workflow «Mensaje entrante» (disparador *Customer Replied*, canales WhatsApp e Instagram) → acción *Webhook* a
   la URL HTTPS del webhook del VPS con la cabecera `x-setter-secret` = `WEBHOOK_SECRET`.
   Basta con el cuerpo estándar de GHL (`contact_id`, `message.body`…): el id de la conversación y el canal se piden a GHL.
3. Mensajes que envía el equipo: para que la IA se aparte cuando escribe una persona, el servicio entiende el evento
   `OutboundMessage` de GHL (con `userId`). Si no se puede suscribir ese evento, el equipo pone la etiqueta `parar ia`
   antes de escribir. **A confirmar al conectar.**
4. Rellenar los IDs de usuario de cada sede (`GHL_USER_*`).

Etiquetas de control en GHL: `parar ia` pausa la IA en ese contacto; `continuar ia` la reanuda.

## Herramientas de administración (solo desde el VPS)

```sh
curl -s -X POST localhost:3200/admin/probar -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"sesion":"carlos","texto":"cuánto cuesta en getafe?"}'
curl -s localhost:3200/admin/costes -H "Authorization: Bearer $ADMIN_TOKEN"
```

## Pendiente antes de producción

- [ ] Pasar `npm run evaluar` y revisar el informe; luego modo prueba con conversaciones reales en GHL.
- [ ] Configurar el modelo y validar altas en AimHarder por sede con la cuenta y el navegador de esa integración.
- [ ] Confirmar la cobertura de las solicitudes de prueba en Parla. El flujo existente pide confirmación al equipo.
- [ ] Comprobar en GHL los nombres exactos de campos del webhook.
- [ ] Crear la plantilla de WhatsApp y el workflow «Sofía · enviar plantilla» (ver `docs/seguimientos.md`).
- [ ] Aprobación de Carlos → traspaso del número a GHL → `MODE=live`.
