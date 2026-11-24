
## Panel de control

`https://<dominio>/panel` (clave: `ADMIN_TOKEN` del `.env`). Las conversaciones se siguen contestando en GHL; el panel es para revisar y ajustar:

- **Resumen**: leads, chats atendidos, borradores (modo prueba), altas, follow-ups, derivaciones y uso de la IA (hoy, 7 y 30 días).
- **Embudo**: por sede y mes, leads nuevos → reservan prueba → asisten → primer pago.
- **Chats**: vistas en pestañas con contador (las del sistema y las que guardéis), filtros combinables (estado, etiquetas que lleva o no lleva —alguna o todas—, sin etiquetas, sede, canal, fase, actividad y quién debe contestar), búsqueda, hilo con borradores, etiquetas del chat (poner y quitar), lo que ha entendido Sofía, y pausar o reactivar a Sofía.
- **Etiquetas** (como en Zapp): nombre y color; se ponen a mano, por reglas (texto del lead o nuestro: contiene, exacto, empieza o termina; adjunto; inactividad de X horas; fase; sede) o por Sofía con un criterio en lenguaje natural. Condiciones «solo si ya lleva» / «nunca si lleva». Al ponerse: pausar, reanudar o forzar a Sofía, derivar y avisar por Telegram. «Aplicar a chats de antes» busca en el historial. **Sincronizadas con GHL** en los dos sentidos: cada etiqueta es un tag de GHL con el mismo nombre en minúsculas; poner o quitar aquí lo hace en el contacto, y lo que se pone o quita en GHL llega por el webhook (mensajes o `ContactTagUpdate`) y por una revisión cada 15 min de los contactos con actividad en 30 días. Una etiqueta solo se borra del panel si antes se confirmó en GHL; si no llegó a subir, se reintenta. Crear o renombrar aquí crea o renombra el tag en GHL; borrar aquí no lo borra de GHL. «Importar de GHL» trae tags existentes.
- **Altas**: cada alta con su estado y el detalle de AimHarder.
- **Follow-ups**: las 4 reglas con interruptor, resultados de 7 días y próximos envíos (se pueden cancelar).
- **Probar IA** (como en Zapp): pruebas guardadas en `data/pruebas.db` (lista, borrar una o todas), WhatsApp o Instagram, panel de análisis (fase, sede, etiquetas reales aplicadas, herramientas del último turno, lo que ha entendido y siguiente paso), «IA inicia» (outbound), forzar cada follow-up, teléfono y fecha simulados (con el teléfono de un socio se prueba la detección de socios), exportar a texto con o sin análisis, enlace directo y vista móvil. No toca GHL ni AimHarder.
- **Ajustes**: Sofía encendida/apagada, canales, franja horaria, tiempo de respuesta y velocidad de escritura (mismos valores que Zapp: 8 a 0 h, 15–50 s, 4 letras/s). Se guardan en la base de datos y se aplican sin reiniciar. El modo real (MODE=live) no se cambia desde el panel.

## Audios e imágenes

Sofía escucha las notas de voz y ve las imágenes que manda el lead:

- Los adjuntos de GHL se descargan y se guardan en `data/media/AAAA-MM/` (si la URL pide autenticación, se reintenta con el token de GHL).
- **Audios**: se transcriben en el propio VPS con faster-whisper (modelo «small», int8, unos 8 s por nota) usando `scripts/transcribir.py`; la voz no sale a ningún servicio externo. Si falla, se usa `/usr/local/bin/cfmp-whisper-transcribe` (openai-whisper, más lento). Una transcripción cada vez. Config: `TRANSCRIPTOR_PYTHON`, `TRANSCRIPTOR_MODELOS`, `TRANSCRIPTOR_RESERVA`. Hoy usa el entorno Python de hermes y el modelo de metrito-stt (solo lectura): si desaparecen, cae a la reserva.
- **Imágenes**: van al modelo como imagen (las 3 últimas del chat; las anteriores quedan como «[imagen enviada antes]»). Las grandes o en formatos raros (HEIC…) se convierten con ffmpeg a JPEG de 1568 px.
- Las reglas de etiquetas de texto también se aplican a la transcripción.
- En el panel, los chats muestran el audio con su transcripción y la imagen. En Probar IA se puede adjuntar una imagen o audio (📎) o grabar una nota de voz (🎙️).

## Más secciones del panel

- **Resumen → alertas**: cada 10 minutos se comprueba GHL (token), los tokens de AimHarder, errores de la IA, respuestas
  atascadas, seguimientos con error, audios sin transcribir, que lleguen mensajes de GHL y el disco. Una alerta por
  problema, aviso por Telegram la primera vez y se cierra sola cuando vuelve a ir bien (`src/alertas.js`).
- **Estadísticas**: chats nuevos por día y canal, mapa de cuándo entran (día × hora), embudo, por canal y sede,
  etiquetas más puestas y **consumo de la IA** por mes y uso (en dólares de la API y € aproximados, `EUR_POR_USD`).
- **Recursos**: archivos que Sofía puede enviar con la herramienta `enviar_recurso` (y que un seguimiento puede
  adjuntar). Se publican en `PUBLIC_URL/r/<código>` (nginx deja pasar solo GET) para que GHL los descargue.
- **Notas de voz** (`src/voz.js`, apagado por defecto): Sofía manda su respuesta como nota de voz de WhatsApp cuando
  se cumplen las normas de Ajustes → Notas de voz (solo teléfonos de prueba, solo si el lead mandó un audio, máximo
  por conversación, largo máximo y tope de letras al mes). La voz es de ElevenLabs (`ELEVENLABS_API_KEY`,
  `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL`), se pasa a OGG/Opus con ffmpeg y se publica en
  `PUBLIC_URL/r/voz_<código>.ogg`. Sin clave, en modo prueba o si algo falla, sale el texto de siempre.
- **Etiquetas → Avisar a Meta**: evento de la API de Conversiones al ponerse la etiqueta (`META_PIXEL_ID`,
  `META_CAPI_TOKEN`, `META_TEST_EVENT_CODE`). Teléfono cifrado con SHA-256, una vez por chat y evento; en modo prueba
  no se envía. Lista de eventos al final de Etiquetas.
- **Reportes → Instrucciones**: «Mi Setter IA» (resumen legible por apartados) y rendimiento por versión del prompt
  (cada chat cuenta en la versión con la que empezó: siguen hablando, prueba, alta, derivados).
- **Chats**: ⚡ «Responder ya» y exportar a CSV (chats o chats con mensajes, con los filtros aplicados).
- **Ajustes**: si escribe el equipo, Sofía se aparta (se puede apagar); palabras que la paran (lead o equipo) y que la
  reanudan (equipo); canales cuyos chats nuevos empiezan en pausa; horario distinto por día. **Registro de actividad**:
  quién cambió qué (usuario de MetroTools por la cabecera `X-CFMPO-User`).

## Estabilidad y velocidad

- **Llamadas externas con tiempo límite**: GHL 20 s (se reintentan lecturas y los 429; un envío de mensaje nunca se
  repite tras un corte, para no duplicarlo), AimHarder 30 s, Telegram 10 s, modelo 60 s por llamada.
- **Respuestas en paralelo**: hasta 4 chats a la vez; cada chat se marca mientras se atiende. Si la IA o GHL fallan
  se reintenta a los 2 y 5 minutos (solo si no salió nada y el turno no hizo un alta o una derivación); el equipo
  recibe un aviso cuando se rinde.
- **Reinicios**: al arrancar (`src/arranque.js`) los chats que se estaban contestando vuelven a la cola; los envíos
  programados a medias quedan en error (nunca se duplican) y los reportes a medias se pueden volver a analizar. Con
  SIGTERM se espera hasta 25 s a las respuestas en curso y se vuelca la base.
- **Bucles** que no se solapan ni se caen por un error; `/health` devuelve 503 si la base no responde o un bucle
  lleva parado más del triple de su intervalo, y se abre la alerta «tarea interna parada».
- **Seguimientos**: cada envío se «toma» antes de procesarlo y se vuelve a comprobar el chat justo antes de salir
  (lead que acaba de escribir, pausa, socio nuevo según AimHarder).
- **Base de datos**: `busy_timeout`, índices para el panel y los bucles, y copia diaria en `data/backups/`
  (14 días la principal, 7 la de Probar IA).
- La zona horaria del negocio es `BUSINESS_TZ` (por defecto Europe/Madrid), no la del servidor.
