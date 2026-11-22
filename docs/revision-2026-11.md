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

## Revisión del panel de control (22 de noviembre)

Se recorrieron las 12 secciones y sus subpáginas con un navegador automático, en tamaño de escritorio (1366 px) y de
móvil (390 px), sobre una copia local con 4.000 chats y 58.000 mensajes de ejemplo: 48 acciones probadas una a una
(filtros, vistas, pausar, etiquetar, programar, exportar, crear y borrar etiquetas, seguimientos, lanzamientos,
recursos, Probar IA, reportes, instrucciones, batería, ajustes) comprobando cada cifra y cada cambio contra la base.
Las pruebas del servidor están en `test/panel-revision.test.js`.

### Cifras que no eran lo que decían

- **«Hoy» en Resumen eran las últimas 24 horas**: a las 10 de la mañana contaba también la tarde de ayer. Ahora es
  desde las 00:00 de Madrid; «7 días» es hoy y los 6 anteriores. El gráfico por día iba por día UTC (un mensaje de
  las 00:30 caía en el día anterior) y ahora va por día de Madrid.
- El filtro de Chats «Actividad: Hoy» sigue siendo de 24 horas y ahora se llama así («Últimas 24 h»).
- El coste de la batería de pruebas usaba un cambio a euros fijo (0,92) y Consumo el configurado: ahora el mismo.
- Los números de las tarjetas (Resumen, Estadísticas) salían dentro de una pastilla gris por un estilo cruzado.

### Cosas que no se actualizaban

- **Cabecera**: el aviso «⚠️ N alertas» seguía ahí después de resolverlas, y el número de chats del menú era el de
  cuando se abrió la página. Ahora la cabecera se refresca cada minuto y al resolver, comprobar o guardar ajustes.
  El menú enseña también las **preguntas pendientes**.
- **Resumen** se actualiza solo cada minuto (dice a qué hora) y los **contadores de las vistas** de Chats cada 30 s.
- **Estadísticas**: si se cambiaba de filtro deprisa, podía quedarse pintada la respuesta del filtro anterior.

### Cosas que no se podían hacer

- La lista de chats enseñaba **100 y no avisaba de que había más**: ahora hay «Ver más chats» (hasta 500).
- **Botón «atrás» del móvil** dentro de un chat: salía de la sección. Ahora cada chat tiene su dirección
  (`#chats/<id>`): atrás vuelve a la lista, en el punto donde estabas, y el enlace se puede compartir.
- Un **doble toque** en guardar o crear (vista, etiqueta, prueba, lanzamiento…) lo creaba dos veces.
- **Ajustes**: los interruptores parecen inmediatos pero no se aplican hasta «Guardar»; ahora la barra de guardar
  queda siempre a la vista y avisa de que hay cambios sin guardar.
- Un interruptor que el servidor no llegaba a guardar se quedaba marcado como si sí.
- Anular la clase de prueba desde el chat pide confirmación (cancela recordatorios).

### Velocidad

| Consulta (4.000 chats, 58.000 mensajes) | Antes | Ahora |
| --- | --- | --- |
| Estadísticas, 30 días | 147 ms | 45 ms |
| Estadísticas, 90 días | 249 ms | 74 ms |
| Consumo de la IA | 191 ms | 50–85 ms |
| Resumen de hoy | 57 ms | 21 ms |

Importa más de lo que parece: mientras el servidor calcula, Sofía no atiende nada más.

- Al abrir el panel, la primera consulta de la sección sale a la vez que la comprobación de acceso (una espera menos).
- Cambiar de vista en Chats hace una consulta en vez de tres; Estadísticas no repide el consumo al filtrar.
- Etiquetas, el editor de seguimientos y la ficha de un reporte piden sus datos a la vez, no uno tras otro.
- El refresco automático no repinta la lista de chats si no ha cambiado nada.

### Móvil y escritorio

- Cabecera en una línea en el móvil; las 12 secciones caben en el menú de un portátil.
- Botones pequeños («Editar», «Cancelar», ✕, quitar filtro) con tamaño de dedo en pantallas táctiles, y campos a
  16 px para que el iPhone no amplíe la página al escribir.
- Botón «↑» para volver arriba en las páginas largas (Seguimientos, Altas, Batería).
- En Seguimientos, las instrucciones largas se ven recortadas a tres líneas y se despliegan con un toque.
- Una dirección que no existe (`#loquesea`) lleva a Resumen en vez de dejar el menú sin marcar.

### Vista de chat en escritorio

- Con un chat largo, la conversación **se salía de la ventana**: lista y chat crecían hasta los 1.700 px, la página
  entera hacía scroll y el chat se abría por el primer mensaje. Ahora la zona de chats llega justo hasta abajo de la
  ventana, cada columna tiene su desplazamiento y el chat se abre por el último mensaje.
- En escritorio (más de 1040 px), la **ficha del lead** (lo que ha entendido Sofía, altas, clase de prueba, mensaje
  programado, follow-ups) va en una tercera columna a la derecha en vez de quitarle sitio a los mensajes.
- En monitores grandes la zona de chats se ensancha (hasta 1.640 px); la cabecera y el menú no se mueven.
- Los mensajes llevan un separador por día («Hoy», «Ayer», «viernes, 20 de noviembre») y cada burbuja solo la hora.
- El chat abierto queda marcado en la lista con una banda verde, y las burbujas no pasan de 620 px de ancho.

### No comprobado aquí

- El panel integrado en MetroTools (`/zapp/`): usa el mismo código, pero la barra y los estilos de `metro-os` no
  están en este repositorio. Conviene abrirlo una vez en el móvil tras desplegar.
- Lo que depende de servicios reales (GHL, AimHarder, Anthropic, Meta, Telegram) se probó con dobles de prueba.

## Pendiente (hace falta el VPS)

- El servicio corre sin `User=` en `deploy/codex-zapp.service` (como root). Conviene un usuario propio, pero hay que
  comprobar antes sus permisos sobre los datos, el almacén de tokens de AimHarder, rclone y el transcriptor.
- El panel integrado en MetroTools (`/zapp/`) aplica una política de contenido que permite su script por huella
  y los dos scripts publicados de `metro-os`. Al actualizar la versión de esos recursos, se actualiza la política.
