
## Panel de control

`https://<dominio>/panel` (clave: `ADMIN_TOKEN` del `.env`). Las conversaciones se siguen contestando en GHL; el panel es para revisar y ajustar:

- **Resumen**: leads, chats atendidos, borradores (modo prueba), altas, follow-ups, derivaciones y uso de la IA (hoy, 7 y 30 días).
- **Chats**: filtros como en Zapp (IA activa, pausadas, derivadas, seguimiento, clase de prueba, alta, socios), búsqueda, hilo con borradores, y pausar o reactivar a Sofía en ese chat.
- **Altas**: cada alta con su estado y el detalle de AimHarder.
- **Follow-ups**: las 4 reglas con interruptor, resultados de 7 días y próximos envíos (se pueden cancelar).
- **Probar IA**: chat de pruebas que no toca GHL ni AimHarder.
- **Ajustes**: Sofía encendida/apagada, canales, franja horaria, tiempo de respuesta y velocidad de escritura (mismos valores que Zapp: 8 a 0 h, 15–50 s, 4 letras/s). Se guardan en la base de datos y se aplican sin reiniciar. El modo real (MODE=live) no se cambia desde el panel.
