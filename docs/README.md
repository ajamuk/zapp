
## Panel de control

`https://<dominio>/panel` (clave: `ADMIN_TOKEN` del `.env`). Las conversaciones se siguen contestando en GHL; el panel es para revisar y ajustar:

- **Resumen**: leads, chats atendidos, borradores (modo prueba), altas, follow-ups, derivaciones y uso de la IA (hoy, 7 y 30 días).
- **Embudo**: por sede y mes, leads nuevos → reservan prueba → asisten → primer pago.
- **Chats**: vistas en pestañas con contador (las del sistema y las que guardéis), filtros combinables (estado, etiquetas que lleva o no lleva —alguna o todas—, sin etiquetas, sede, canal, fase, actividad y quién debe contestar), búsqueda, hilo con borradores, etiquetas del chat (poner y quitar), lo que ha entendido Sofía, y pausar o reactivar a Sofía.
- **Etiquetas** (como en Zapp): nombre y color; se ponen a mano, por reglas (texto del lead o nuestro: contiene, exacto, empieza o termina; adjunto; inactividad de X horas; fase; sede) o por Sofía con un criterio en lenguaje natural. Condiciones «solo si ya lleva» / «nunca si lleva». Al ponerse: pausar, reanudar o forzar a Sofía, derivar, avisar por Telegram y copiar a GHL. «Aplicar a chats de antes» busca en el historial.
- **Altas**: cada alta con su estado y el detalle de AimHarder.
- **Follow-ups**: las 4 reglas con interruptor, resultados de 7 días y próximos envíos (se pueden cancelar).
- **Probar IA** (como en Zapp): pruebas guardadas en `data/pruebas.db` (lista, borrar una o todas), WhatsApp o Instagram, panel de análisis (fase, sede, etiquetas reales aplicadas, herramientas del último turno, lo que ha entendido y siguiente paso), «IA inicia» (outbound), forzar cada follow-up, teléfono y fecha simulados (con el teléfono de un socio se prueba la detección de socios), exportar a texto con o sin análisis, enlace directo y vista móvil. No toca GHL ni AimHarder.
- **Ajustes**: Sofía encendida/apagada, canales, franja horaria, tiempo de respuesta y velocidad de escritura (mismos valores que Zapp: 8 a 0 h, 15–50 s, 4 letras/s). Se guardan en la base de datos y se aplican sin reiniciar. El modo real (MODE=live) no se cambia desde el panel.
