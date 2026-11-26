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
- Responde 200 enseguida (AimHarder da 3 s) y procesa después. La entrega es «al menos una vez»: los duplicados se
  descartan por el id del evento (tabla `aimharder_eventos`). Si la ficha no se puede leer, el evento se olvida para
  que el reintento de AimHarder (hasta 7 en 24 h) se procese.

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
