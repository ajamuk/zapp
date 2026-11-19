# metro-setter

Setter IA de CrossFit MetroPolitano. Sustituye a Zapp (ScaleX).

- **GoHighLevel** es la bandeja y el CRM: los canales (un número de WhatsApp + Instagram) viven en GHL y el equipo trabaja ahí.
- **Este servicio** es el cerebro: recibe cada mensaje por webhook de GHL, separa socios de leads (AimHarder),
  contesta como Sofía, etiqueta, asigna, programa seguimientos y prepara el alta en AimHarder.

> **Estado:** construido y probado con tests. Arranca en **modo prueba** (`MODE=shadow`): no envía nada,
> deja la respuesta como nota en GHL. El traspaso del número y el paso a `MODE=live` esperan la aprobación de Carlos.

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
npm test                                  # 16 pruebas, sin red
ANTHROPIC_API_KEY=... npm run simular     # chat de terminal con Sofía (modelo real, sin GHL)
```

## Desplegar en el VPS

```sh
git clone https://github.com/ajamuk/zapp.git /opt/metro-setter && cd /opt/metro-setter
npm install --omit=optional
cp .env.example .env && nano .env         # rellenar claves; dejar MODE=shadow
pm2 start deploy/ecosystem.config.cjs && pm2 save
```

Nginx: `deploy/nginx-setter.conf` (expone solo el webhook y /health) + `certbot --nginx -d setter.crossfitmpo.com`.

## Conectar GHL

1. En GHL: Ajustes → Integraciones privadas → token con permisos de conversaciones (leer/escribir), contactos (leer/escribir) y notas. Va a `GHL_TOKEN`.
2. Workflow «Mensaje entrante» (disparador *Customer Replied*, canales WhatsApp e Instagram) → acción *Webhook* a
   `https://setter.crossfitmpo.com/webhooks/ghl` con la cabecera `x-setter-secret` = `WEBHOOK_SECRET`.
   Incluir conversationId, contactId, messageType, body, messageId, phone, tags y nombre del contacto.
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

- [ ] Probar el prompt con conversaciones reales en modo prueba (comparar con Zapp).
- [ ] URL de búsqueda de socios de AimHarder (`docs/aimharder.md`).
- [ ] Grabar los pasos del alta por navegador.
- [ ] Festivos 2026-2027 en `config/festivos.json`; confirmar tamaño de grupo de Academy (8 o 10).
- [ ] Comprobar en GHL los nombres exactos de campos del webhook y de la plantilla `zapp_seguimiento_programado`.
- [ ] Aprobación de Carlos → traspaso del número a GHL → `MODE=live`.
