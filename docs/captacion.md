# Captación por nivel de conciencia (modo prueba)

Un «estratega» aparte de Sofía. Cuando un chat se enfría sin alta y los seguimientos normales ya han terminado,
diagnostica al lead, decide si entra en el grupo de control y planifica qué contenido mandarle según lo que ya sabe.

> **Estado: solo modo prueba.** No envía nada a ningún lead, no escribe en GHL y no programa nada en la cola de
> seguimientos. Los toques, al vencer, quedan como **borradores** en la pestaña **Captación** del panel. El módulo
> (`src/captacion.js`) no tiene ruta de envío: pasar a real exige escribirla en un cambio aparte y revisarla.
> La vuelta automática viene apagada (`CAPTACION_ENABLED=false`).

## Qué no toca

- **Sofía**: ni su prompt, ni sus herramientas, ni sus respuestas, ni su modo (`MODE`). `setter.js`, `followups.js`,
  `llm.js` y `reglas.js` no cambian y no conocen este módulo.
- **Los seguimientos existentes**: las reglas de `reglas_seguimiento` y la cola `scheduled` siguen igual. Captación
  usa tablas propias (`captacion_perfiles`, `captacion_diagnosticos`, `captacion_toques`).
- **Zapp (ScaleX)**: es un sistema externo; aquí no hay nada que lo pause ni que cambie su configuración, su
  routing, sus números o sus seguimientos.

## Cómo funciona

Cada vuelta (`captacion.ciclo`, cada 30 minutos si está activada) hace tres cosas, en este orden:

1. **Paradas.** Repasa los leads ya diagnosticados y corta su plan si hay motivo (ver «Paradas»).
2. **Borradores.** Los toques que vencen se convierten en borrador (texto + material que falta). Nada sale.
3. **Diagnóstico.** Busca chats fríos sin diagnosticar, los diagnostica y les planifica los toques.

### A quién se diagnostica

Un chat entra cuando se cumple todo esto:

- Lleva **5 días** sin ningún mensaje (`diagnostico_dias`), o sea, ya ha pasado el «cierre a 4 días».
- **No tiene ningún seguimiento pendiente** en la cola de Sofía (silencio, largo plazo, etiqueta, cita, manual o
  lanzamiento). Mientras quede alguno, captación ni lo mira.
- No tiene una clase de prueba por delante o de hace menos de 5 días (mandan sus recordatorios).
- No es socio, no tiene alta, no está derivado ni en pausa, y no es un chat de Probar IA.
- El lead ha escrito al menos una vez y su última actividad es de hace menos de 180 días (`antiguedad_max_dias`;
  este tope no estaba en el diseño: es una cautela para no escribir a leads muy antiguos).

### Diagnóstico

| Parámetro | Valores |
| --- | --- |
| Nivel de conciencia | 1 no consciente · 2 del problema · 3 de la solución · 4 del producto · 5 totalmente consciente |
| Freno | precio, horario, miedo (al nivel), momento, prueba, distancia, ninguno, desconocido |
| Motivo | forma, peso, fuerza, comunidad, hyrox, salud, otro, desconocido |
| Ruta | academy, crossfit, hyrox, desconocida |

Dos formas de diagnosticar:

- **Con IA** (`CAPTACION_IA=true` y `ANTHROPIC_API_KEY`): una llamada al modelo de Sofía (Anthropic, el proveedor que
  ya se usa; no hay ningún servicio nuevo). La conversación sale **sin emails, sin teléfonos y sin el nombre** del
  contacto. El gasto se ve en Consumo como «Captación (diagnóstico)». Como mucho 20 diagnósticos por vuelta.
- **Por reglas de texto** (sin IA ni red): respaldo automático si el modelo falla, y modo por defecto del
  diagnóstico histórico. Es más tosco: sirve para ver el reparto, no para afinar.

Cada diagnóstico se guarda en `captacion_diagnosticos`, así que se ve si un lead sube de nivel.

### Grupo de control

El **20 %** de los leads (`control_pct`) queda de control: se diagnostica igual, pero no recibe contenidos, solo los
seguimientos de siempre. El reparto es fijo por contacto (una huella de su id), así que no cambia entre vueltas ni
al volver a diagnosticar. El panel compara los dos grupos: cuántos responden, cuántos suben de nivel y cuántas altas.
En modo prueba los dos grupos deben salir parecidos (nadie recibe nada): la comparación vale al enviar de verdad.

### Planificación

| Nivel | Qué recibe | Cadencia (días desde su último mensaje) |
| --- | --- | --- |
| 1 | Nada: solo lanzamientos | — |
| 2 | Historias de socios, cómo es una clase, «CrossFit para gente normal» | 10, 25, 45, 75 |
| 3 | Academy (o clases con la comunidad si tiene experiencia), reseñas, sin permanencia | 10, 25, 45, 75 |
| 4 | La pieza que resuelve su freno | 7, 14, 30 |
| 5 | Disparadores reales: primer recibo prorrateado, alta preparada; en El Cañaveral, apertura y orden de alta | 7, 14, 30 |

- Las piezas, sus textos y las cadencias están en `config/captacion.json`. Las de su freno y su sede van primero.
- Nivel 4 con freno «momento» recibe las piezas del nivel 5.
- Un nivel 4 o 5 con valoración de Sofía por debajo de 7 va por la cadencia fría.
- **Menos toques a quien menos probable es** (cada plantilla de WhatsApp se paga): valoración 1-3, dos toques;
  4-6, tres; 7-10, hasta cuatro; sin valoración, tres.
- Los toques van a las **11:00 de Madrid**. Si el día ya pasó (lead antiguo), el primero es al día siguiente y los
  demás conservan la distancia.
- **Solo WhatsApp**: Instagram no deja escribir pasados unos días, así que esos leads se diagnostican y no se planifican.
- Reglas del negocio que respetan las piezas: clase de prueba solo en Parla y solo si no se le ha ofrecido ya; en
  Getafe y Las Rosas, «un mes sin permanencia»; en El Cañaveral, ni prorrateo ni horarios (no publicados), ni
  plazas que quedan, ni tramo prometido. Nada de descuentos ni urgencia inventada.

### Paradas

| Motivo | Qué pasa |
| --- | --- |
| El lead responde | Se cancelan los toques; el chat vuelve a Sofía. Si se enfría otra vez, se diagnostica de nuevo |
| El equipo escribe | Igual que una respuesta |
| Alta (pendiente o preparada) | Parado para siempre |
| Socio (por el chat o por el índice de AimHarder) | Parado para siempre |
| Oposición («no me escribáis», «no me interesa», palabra de parar) | Parado para siempre |
| Derivación al equipo o chat en pausa | Plan cancelado; puede retomarse si se reanuda y vuelve a enfriarse |
| 4 toques sin respuesta, o plan terminado | «Dormido»: solo lanzamientos |
| Aparece un seguimiento de Sofía o un mensaje programado | El plan entero se retrasa hasta 3 días después de ese envío |

### Borradores

Al vencer un toque se guarda el texto que se habría enviado. Por defecto es el de la pieza, tal cual. Con
`CAPTACION_REDACTAR_IA=true`, Sofía lo adapta a la conversación con su función de redactar seguimientos (solo
consulta; no cambia nada del chat) y puede decidir no enviarlo. Siempre una sola frase: fuera de las 24 h de
WhatsApp solo cabe una plantilla con una variable de texto.

## Diagnóstico histórico

Pasa el diagnóstico por las conversaciones que ya hay y saca un informe agregado (niveles, frenos, motivos, por
sede, qué contenidos se pedirían más y qué material hace falta primero). Abre la base en **solo lectura**, no envía
nada y el informe no lleva nombres, teléfonos ni textos de leads.

```sh
npm run diagnostico-captacion                                  # base del servicio, por reglas, sin IA ni red
npm run diagnostico-captacion -- --jsonl eval/casos-zapp.jsonl # un export anonimizado
npm run diagnostico-captacion -- --ia                          # con el modelo de Sofía (conversación sin emails ni teléfonos)
```

El informe se guarda en `data/diagnostico-captacion.md` (o `--salida`).

## Qué material real falta

Ninguno de estos materiales existe todavía en Recursos. Mientras falten, el borrador sale solo con el texto y el
panel lo marca. Se suben en **Recursos** con el nombre exacto de la primera columna.

| Recurso | Qué es | Lo usan |
| --- | --- | --- |
| `testimonio-empezo-de-cero` | Testimonio real de un socio que empezó sin experiencia, con permiso por escrito; mejor uno por sede | Nivel 2 y freno «miedo» |
| `video-clase-1h` | Vídeo de 30-60 s de una clase completa | Nivel 2 |
| `fotos-comunidad` | 2 o 3 fotos reales de clases, con permiso de imagen | Nivel 2 |
| `video-academy` | Vídeo de 30-60 s de una sesión de Academy | Nivel 3 |
| `video-clase-crossfit` | Vídeo de una clase de CrossFit o HYROX | Nivel 3 con experiencia |
| `resenas-socios` | Imagen con 3 o 4 reseñas reales por sede (El Cañaveral aún no tiene) | Nivel 3 |

Además del material, antes de enviar de verdad falta:

- **Revisar los textos** de `config/captacion.json`: son una propuesta inicial, no están validados por el equipo.
- **Plantilla de WhatsApp** aprobada por Meta para estos mensajes (categoría Marketing) y el workflow de GHL que la
  envía. La actual (`docs/seguimientos.md`) aún está pendiente de crear, y solo admite una variable de texto.
- **Cómo llega el material**: una plantilla de texto no adjunta archivos. Hoy el borrador añade el enlace público
  del recurso (`/r/<código>`); hay que confirmar que Meta lo acepta dentro de la variable o crear plantillas con
  cabecera de imagen o vídeo.
- **Consentimiento**: confirmar que los leads que escribieron por un anuncio aceptan mensajes comerciales
  posteriores, y dejar una forma clara de darse de baja.
- **Validar el diagnóstico con IA** sobre conversaciones reales (aquí solo se ha probado con datos sintéticos y con
  los 32 casos anonimizados de `eval/`), y decidir el coste por lead que compensa.
- **El envío en sí** (no está escrito a propósito), con las mismas comprobaciones que los seguimientos de Sofía:
  horario, repaso del chat en GHL antes de salir y socio nuevo según AimHarder.

## Parámetros

`config/captacion.json`: `control_pct`, `diagnostico_dias`, `antiguedad_max_dias`, `max_sin_respuesta`,
`separacion_dias`, `hora_envio`, `max_diagnosticos_por_vuelta`, `valoracion_caliente`, `cadencias`,
`toques_por_valoracion`, `piezas` y `material`. El fichero se valida al cargarlo: una cadencia que empiece antes de
terminar los seguimientos normales no se acepta.

Variables de entorno: `CAPTACION_ENABLED`, `CAPTACION_IA`, `CAPTACION_REDACTAR_IA`, `CAPTACION_MODEL` (ver `.env.example`).
