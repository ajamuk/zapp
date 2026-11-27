# Sofía en un VPS propio, con varios negocios

Esta guía explica cómo llevar Sofía a un VPS propio y cómo servir desde él a varios negocios: otros boxes de
CrossFit o cualquier negocio que trabaje con reservas y atienda por WhatsApp o Instagram. El despliegue actual de
CrossFit MetroPolitano en el VPS compartido sigue igual: [despliegue.md](despliegue.md).

## Cómo se organiza: un contenedor por negocio

Cada negocio funciona en su propio contenedor, con la misma imagen de Sofía para todos y con sus datos y su
configuración por separado:

```
/srv/sofia/
  codigo/                    copia del repositorio (de aquí sale la imagen)
  clientes/
    metro/                   un negocio
      .env                   claves y ajustes del negocio (permisos 600)
      config/                instrucciones, negocio, tarifas, horarios, etiquetas, seguimientos…
      data/                  base SQLite, audios e imágenes, copias diarias, tokens
      compose.yml            su contenedor, escuchando solo en 127.0.0.1:<puerto>
      nginx.conf             su dominio
    boxnorte/
      …
```

Este modelo tiene varias ventajas frente a una base compartida:

- **Datos separados.** Cada negocio tiene su base y su carpeta. Un fallo o un error de configuración no expone
  los chats de otro negocio, y la baja de un cliente consiste en borrar su carpeta.
- **Fallos aislados.** Si un negocio se queda sin crédito de Anthropic, recibe un pico de mensajes o un token
  caduca, los demás siguen funcionando. Cada contenedor tiene su límite de memoria y CPU.
- **Mismo código.** El servicio está escrito para un único negocio por proceso (configuración global, una base
  SQLite y bucles propios). Así se reutiliza tal cual, sin reescribir cada consulta para filtrar por cliente.
- **Copias y migraciones sencillas.** Cada negocio se copia, se restaura o se mueve a otro servidor de forma
  independiente.

Consumo orientativo, medido en el servicio actual: unos 80 MB de memoria en reposo y picos de unos 130 MB. Hay
que añadir lo que gastan las transcripciones de audio y Chromium si se usan las altas por navegador de AimHarder.
Un VPS de 4 vCPU y 8 GB da margen para bastantes negocios. Mide el consumo real con `docker stats` antes de
añadir más.

## Preparar el VPS (una vez)

1. Ubuntu 24.04 LTS con actualizaciones automáticas (`unattended-upgrades`) y cortafuegos con solo 22, 80 y 443
   (`ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw enable`). Acceso SSH solo con clave.
2. Docker Engine con el plugin de Compose (repositorio oficial de Docker), nginx y certbot
   (`apt install nginx certbot python3-certbot-nginx`).
3. En el bloque `http` de nginx (`/etc/nginx/conf.d/sofia.conf`), la zona que limita los intentos contra el panel
   y un formato de registro sin la parte `?…` de la URL (el webhook de AimHarder lleva su token ahí). Los bloques de
   cada negocio usan los dos: sin ellos, `nginx -t` falla.

   ```nginx
   limit_req_zone $binary_remote_addr zone=sofia_admin:10m rate=10r/s;
   log_format sofia_sin_query '$remote_addr - $remote_user [$time_local] "$request_method $uri $server_protocol" $status $body_bytes_sent "$http_user_agent"';
   ```

4. Código y primera imagen:

   ```sh
   git clone https://github.com/ajamuk/zapp.git /srv/sofia/codigo
   cd /srv/sofia/codigo && docker build -t sofia:actual .
   docker run --rm --network none sofia:actual npm test
   ```

## Dar de alta un negocio

```sh
/srv/sofia/codigo/deploy/vps-propio/nuevo-cliente.sh boxnorte 3202 boxnorte.tudominio.com
```

El script crea la carpeta del negocio en modo prueba (`MODE=shadow`), con `WEBHOOK_SECRET` y `ADMIN_TOKEN`
aleatorios, la configuración de ejemplo, su `compose.yml` y su bloque de nginx. No arranca nada. Después:

1. Rellena `.env`: `ANTHROPIC_API_KEY`, `GHL_TOKEN`, `GHL_LOCATION_ID`, usuarios de GHL y Telegram del negocio.
   Las integraciones que no se rellenan quedan apagadas (AimHarder, Meta, ElevenLabs, copia en Drive).
2. Adapta `config/`: `negocio.json` (nombre, asistente y sedes), `prompt-sofia.md`, `negocio.md`, `tarifas.json`,
   `horarios.json`, `festivos.json`, `etiquetas.json` y `followups.json`. Lo que falte en esta carpeta se lee de la
   configuración de ejemplo de la imagen.
3. Activa nginx y el certificado con los comandos que imprime el script.
4. Arranca con `docker compose -f /srv/sofia/clientes/boxnorte/compose.yml up -d` y comprueba
   `curl -fsS http://127.0.0.1:3202/health`.
5. Panel: `https://boxnorte.tudominio.com/panel` con el `ADMIN_TOKEN` del `.env`.
6. En GHL, el workflow «Mensaje entrante» apunta a `https://boxnorte.tudominio.com/webhooks/ghl` con la cabecera
   `x-setter-secret` (ver [activar-ghl.md](activar-ghl.md)).
7. Revisa en modo prueba los borradores durante unos días y pasa a `MODE=live` cuando el negocio lo apruebe.

## Actualizar

```sh
cd /srv/sofia/codigo && deploy/vps-propio/actualizar.sh            # último main, todos los negocios
SOLO=boxnorte deploy/vps-propio/actualizar.sh                       # primero en uno
```

El script construye la imagen del commit, pasa los tests dentro de ella sin red y la pone negocio a negocio.
Si un negocio no responde bien en `/health`, vuelve a la imagen anterior y para la actualización. Conserva las
últimas cinco imágenes (`SOFIA_IMAGENES_CONSERVAR`) más `actual` y `anterior`.

Para volver atrás a mano: `docker tag sofia:anterior sofia:actual` y `docker compose -f … up -d` en cada negocio.

## Copias de seguridad

Cada contenedor hace una copia diaria de su base en `data/backups/`, conserva 14 días y vuelca el registro
de escritura a disco cada hora. Fuera del servidor, copia periódicamente `/srv/sofia/clientes/*/` cifrado
(restic o rclone con `crypt`) a un almacenamiento externo. Esa copia debe incluir `data/backups/`, `config/`
y `.env`. La copia a Drive integrada (`COPIA_DRIVE_REMOTO`) necesita `rclone` y no está en la imagen. En el VPS
propio es más sencillo hacerla desde el anfitrión para todos los negocios a la vez.

## Llevar CrossFit MetroPolitano al VPS propio

1. **Preparar sin cortar.** Crea el negocio `metro` con `nuevo-cliente.sh`. Copia los valores de
   `/etc/codex-hosting/zapp.env` a su `.env`, salvo `DB_PATH`, `PORT` y `HOST`, que fija `compose.yml`. Pon el
   dominio nuevo en `PUBLIC_URL`. Copia `config/` de la versión en marcha, con los horarios del VPS.
2. **Dependencias del VPS actual.** Hay varias funciones que hoy leen datos de otras aplicaciones del VPS
   compartido. En el VPS nuevo se apagan solas, sin errores, hasta que se sustituyan:

   | Función | Hoy lee | En el VPS propio |
   | --- | --- | --- |
   | Tokens de AimHarder | `AIMHARDER_TOKEN_STORE`, que renueva un cron central | Tokens propios por sede (`AIMHARDER_TOKEN_*` y `AIMHARDER_REFRESH_*`). Sofía los renueva y los guarda en `data/`. |
   | Pruebas verificadas | `TRIAL_OPS_DB` (metro-trial-ops) | Sin dato: el embudo usa lo que registra Sofía. |
   | Embudo mensual | `EMBUDO_PRUEBAS_DIR` y `EMBUDO_SOCIOS_*` (metro-trial-crm, clientes-analytics) | Montar esos ficheros en solo lectura o dejar el embudo con los datos de Sofía. |
   | Plazas de El Cañaveral | `CANAVERAL_REGISTRO` (metro-paid-signup-sheet) | El número de Ajustes del panel. |
   | Transcripción de audios | Python de hermes y modelo de metrito-stt | Un servicio de transcripción común para todos los negocios (ver más abajo). |
   | Copia en Drive | `rclone` del VPS | Copia desde el anfitrión. |

3. **Corte (unos minutos).** Para `codex-zapp` en el VPS actual. Copia la carpeta de `DB_PATH` (base, `media/`,
   `backups/`, `horarios.json`, `aimharder-tokens.json`) a `clientes/metro/data/` con `rsync -a` y cambia el
   propietario al usuario del contenedor (`chown -R 1000:1000`). Arranca el contenedor y comprueba `/health`.
4. **Cambiar las direcciones.** En GHL, el webhook pasa al dominio nuevo. Haz lo mismo con los webhooks de
   AimHarder. Los enlaces `/r/…` que ya se enviaron apuntan al dominio antiguo: mantén ese dominio redirigiendo
   `/r/` al nuevo durante unas semanas.
5. **Panel.** En el VPS propio, el panel está en `https://<dominio>/panel` con `ADMIN_TOKEN`. Si se quiere seguir
   entrando desde MetroTools, su nginx puede reenviar `/zapp/` al dominio nuevo con la misma cabecera de
   administración.
6. Cuando todo funcione, desactiva `codex-zapp` en el VPS compartido y conserva su carpeta de datos unos días.

## Recursos compartidos entre negocios

- **Transcripción de audios.** Cada transcripción con faster-whisper usa en torno a 1 GB de memoria mientras
  dura. Con varios negocios, conviene un único servicio de transcripción con cola o una API externa, en vez de
  un modelo en cada contenedor. Mientras no exista, los audios llegan al panel sin texto y salta la alerta de
  audios sin transcribir.
- **Chromium (altas de AimHarder por navegador).** Solo para negocios con AimHarder. La imagen se construye con
  `--build-arg NAVEGADOR=1` y pasa a ocupar unos 2,3 GB. Basta con una imagen así, compartida por los negocios que
  la necesiten.
- **Imagen única.** Todos los negocios comparten la imagen en disco (alrededor de 1 GB, en su mayor parte ffmpeg).
  Cada negocio nuevo solo añade sus datos.

## Qué falta para venderlo como suscripción

Lo anterior deja Sofía lista para funcionar en un servidor propio con varios negocios separados. Para venderla a
terceros sin intervención técnica en cada alta, quedan estas piezas:

1. **Configuración del negocio sin tocar código.** Las sedes, el nombre del negocio y el de la asistente salen
   de `config/negocio.json`. Todavía hay lógica escrita para MetroPolitano: la clase de prueba de Parla, la
   promoción de apertura de El Cañaveral, el embudo con sus fuentes y los alias de barrios. Está detallado en
   [multi-negocio.md](multi-negocio.md).
2. **Acceso al panel por usuario.** Hoy el panel se abre con una clave por negocio (`ADMIN_TOKEN`). Para clientes
   hacen falta cuentas con contraseña o enlace por correo, roles (dueño, recepción) y registro de accesos.
3. **Reservas con otros programas.** AimHarder está integrado directamente. Para otros negocios hace falta una
   interfaz común: buscar cliente, ver horarios, reservar prueba y dar de alta. Cada programa se conecta
   mediante un adaptador, por ejemplo los calendarios de GHL, Google Calendar o Calendly.
4. **WhatsApp sin GHL.** Los canales entran hoy por GoHighLevel. Para negocios sin GHL, se necesita un adaptador
   de la API de WhatsApp Cloud de Meta con su propio webhook.
5. **Cobro y consumo.** El consumo de IA de cada negocio ya se registra (Estadísticas → Consumo). Falta
   conectarlo a la suscripción (Stripe) y fijar límites por plan.
6. **Aspectos legales.** Sofía trata datos personales de los clientes del negocio. Hace falta un contrato de
   encargado del tratamiento con cada negocio, la lista de subencargados (Anthropic, GHL, ElevenLabs y Meta), un
   plazo de conservación de chats y audios, y revisar las políticas de WhatsApp Business sobre asistentes de IA.
