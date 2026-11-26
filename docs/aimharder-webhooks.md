# Webhooks de AimHarder (índice de socios en tiempo real)

AimHarder avisa a Sofía cuando se crea un cliente, se da de baja, se reactiva o se le asigna una tarifa.
Con cada aviso se vuelve a leer **esa ficha** (`GET /clients/:id`) y se actualiza ese socio del índice, sin esperar
a la sincronización de 4 horas (que se mantiene como red de seguridad: las renovaciones automáticas no generan evento).

Eventos usados: `CLIENT_CREATED`, `CLIENT_DEACTIVATED`, `CLIENT_REACTIVATED`, `MEMBERSHIP_ASSIGNED`. `WEBHOOK_TEST` solo se registra.

## Cómo funciona

- URL por sede: `https://setter.crossfitmpo.com/webhooks/aimharder/<parla|getafe|las_rosas>?token=<AIMHARDER_WEBHOOK_TOKEN>`.
  AimHarder no firma los avisos (solo los cifra), así que el token de la URL es lo que impide que nadie los falsifique.
- Cifrado en sobre: AES-256-GCM, con la clave AES cifrada con la clave pública RSA de la sede (OAEP **SHA-1**).
  Cada sede tiene su propio par de claves; Sofía guarda solo la privada.
- **Primero se guarda, luego se contesta.** El evento descifrado se guarda en la cola (`aimharder_eventos`, estado
  `pendiente`) y solo entonces se responde 200 (AimHarder da 3 s). Si no se puede guardar, se responde 500 y
  AimHarder lo reenvía. La entrega es «al menos una vez»: un id repetido se contesta 200 sin volver a procesarlo.
- **La lectura de la ficha la reintenta Zapp**, no AimHarder (con el 200 dado, AimHarder no volvería a enviar nada).
  Un procesador despierta al guardar y cada 30 s revisa la cola, también tras un reinicio:
  - Fallo normal: reintentos tras 1 min, 5 min, 30 min, 2 h, 6 h y 15 h. Agotados (o pasadas 25 h) el evento queda
    `fallido`, se registra en el log y solo lo cubre la sincronización de socios de 4 h.
  - **429**: esa sede se pausa lo que diga `Retry-After` (mínimo 1 min, máximo 1 h), sin gastar intentos; las demás
    sedes siguen. Zapp comparte el límite de peticiones con otras apps, así que no se insiste.
  - Varios eventos del mismo cliente en una pasada cuestan una sola lectura (se lee la ficha tal como está ahora).
  - Una ficha que ya no existe (404) se da por hecha.
- Estados en la base: `SELECT estado, count(*) FROM aimharder_eventos GROUP BY estado;`. Los hechos y fallidos se
  borran a los 30 días.

## Activarlo, sede por sede (lo hace el administrador de cada centro)

1. Tener la API pública activada en el centro.
2. En AimHarder: **Configuración > Integraciones > Webhook & Claves RSA**.
3. URL: la de arriba con la sede de ese centro. Pulsar **Activar Webhook**.
4. AimHarder muestra la **clave privada una sola vez**: copiarla. Si se pierde, hay que desactivar y activar de nuevo.
5. Guardar la clave en el VPS (mejor como fichero con permisos 600) y apuntarla en `.env`:
   ```
   AIMHARDER_WEBHOOK_TOKEN=<texto aleatorio largo, el mismo para las tres sedes>
   AIMHARDER_WEBHOOK_KEY_PARLA_FILE=/etc/zapp/aimharder-parla.pem
   ```
   (o `AIMHARDER_WEBHOOK_KEY_PARLA` con el PEM en una línea, con los saltos escritos como `\n`).
6. Reiniciar Sofía y pulsar **Enviar evento de prueba**: en el registro aparece `[aimharder-webhook] <sede>: prueba recibida`,
   y en AimHarder la última entrega pasa a correcta.
7. Una sede sin clave configurada responde 503 y AimHarder lo trata como fallo, así que se activa en AimHarder
   solo cuando la clave ya está en el VPS.

Nginx (`deploy/nginx-setter.conf`) ya expone `/webhooks/aimharder/<sede>` solo por POST.
