# Revisión de noviembre de 2026

Revisión completa de Sofía (funcional, velocidad, seguridad y usabilidad). Cada arreglo tiene su prueba en
`test/revision.test.js`. No cambia el modo (`MODE`) ni nada de GHL o AimHarder.

## Seguridad

- **Adjuntos de los leads** (`src/medios.js`): solo se descargan por https y nunca de este servidor ni de una red
  interna (tampoco siguiendo una redirección). El token de GHL solo se envía a hosts de GHL (`GHL_MEDIA_HOSTS` añade
  otros). La descarga se corta al pasar de 25 MB aunque el servidor no diga el tamaño.
- **Archivos que no son imagen, audio, vídeo o PDF** se entregan como descarga: un «adjunto» en HTML no se ejecuta
  con la sesión del panel.
- **Exportar a CSV**: un nombre o mensaje que empieza por `=`, `+`, `-` o `@` sale como texto, no como fórmula.
- **Cabeceras** en todas las respuestas (`nosniff`, `X-Frame-Options`, `Referrer-Policy`, sin `X-Powered-By`) y
  política de contenido en el panel suelto (`/panel`).
- **Claves**: si `WEBHOOK_SECRET` o `ADMIN_TOKEN` faltan o tienen menos de 24 caracteres, sale una alerta en el panel.
- Los errores internos ya no enseñan detalles de la base de datos al navegador.

## Funcional

- Un cuerpo mal formado en una petición del panel podía **cerrar el servicio** (fallaba el registro de actividad
  después de responder). Ya no, y esas rutas responden bien.
- Los eventos de un mismo chat se procesan **en orden y de uno en uno**: dos mensajes casi a la vez ya no clasifican
  el chat dos veces ni mandan dos avisos de «socio escribe».
- Si el lead **vuelve a escribir mientras Sofía piensa**, la respuesta a medias se descarta y contesta una sola vez
  con todo delante (salvo que en ese turno ya hubiera hecho un alta, una reserva o una derivación).
- Una respuesta que pasa del **tope de 5 minutos** queda anulada: no sale tarde ni repetida con el reintento.
- Un webhook repetido ya no vuelve a pausar un chat que el equipo había reanudado.

## Velocidad

- Las respuestas grandes del panel van **comprimidas** y la lista de chats solo lleva lo que pinta (con 60 chats de
  ejemplo: de 92 KB a 2,6 KB). La página del panel pasa de 198 KB a 54 KB y el navegador la reutiliza (304).

## Usabilidad del panel

- En móvil, la conversación ocupa la pantalla y los datos del chat van debajo.
- Los chats se **actualizan solos** cada 30 s con la pestaña a la vista, sin perder la posición.
- Si una acción falla (pausar, cancelar, borrar…), se ve un aviso con el motivo. Barra de carga si el servidor tarda.
- En la entrada, el mensaje distingue entre clave incorrecta y falta de conexión.

## Pendiente (hace falta el VPS)

- El servicio corre sin `User=` en `deploy/codex-zapp.service` (como root). Conviene un usuario propio, pero hay que
  comprobar antes sus permisos sobre los datos, el almacén de tokens de AimHarder, rclone y el transcriptor.
- No hay política de contenido en el panel integrado en MetroTools (`/zapp/`): depende de los scripts de
  `metro-os`, que no están en este repositorio.
