# Sofía para otros negocios

Qué parte de Sofía ya se configura por negocio, qué sigue escrito para CrossFit MetroPolitano y en qué orden
conviene generalizarlo. El despliegue de varios negocios en un VPS propio está en [vps-propio.md](vps-propio.md).

## Ya se configura por negocio

Cada negocio tiene su `CONFIG_DIR`. Lo que falta en esa carpeta se lee de la configuración de ejemplo del
repositorio.

| Archivo | Qué decide |
| --- | --- |
| `negocio.json` | Nombre del negocio, nombre de la asistente y sedes: id, nombre, alias para reconocerla en un mensaje, si tiene AimHarder y qué equipo la atiende. De aquí salen los nombres de sede del panel, los avisos y la base de conocimiento, y las variables de entorno por sede (`GHL_USER_<ID>`, `AIMHARDER_TOKEN_<ID>`, `TELEGRAM_CHAT_<ID>`…). |
| `prompt-sofia.md`, `negocio.md` | Instrucciones y base de conocimiento. Solo se leen la primera vez; después se editan y versionan en el panel (Ajustes → Instrucciones). |
| `tarifas.json`, `horarios.json`, `festivos.json`, `cierres.json` | Datos que usan las herramientas de Sofía. Los horarios se sincronizan con AimHarder si está configurado. |
| `etiquetas.json`, `followups.json` | Etiquetas de GHL y seguimientos iniciales. Después se editan en el panel. |
| `aimharder-alta.json` | Pasos del alta por navegador (solo negocios con AimHarder). |

Por negocio también son independientes la base de datos, los audios, las copias, los tokens, las claves
(`.env`), el modo (`shadow` o `live`), el horario de respuesta y los ajustes del panel.

## Sigue escrito para MetroPolitano

Estas piezas funcionan para MetroPolitano y habría que convertirlas en configuración, o en funciones que se
activan por negocio, antes de venderlas a otros:

- **Herramientas de Sofía** (`src/llm.js`). Las listas de sedes, modalidades (Academy, CrossFit, HYROX…) y
  tarifas (S, M, L, XL, Academy) están en el esquema de cada herramienta. Deberían generarse desde
  `negocio.json`, `tarifas.json` y `horarios.json`.
- **Clase de prueba de Parla** (`reservar_prueba_parla`, `src/clase-prueba.js`, recordatorio y seguimiento de
  la prueba en `src/reglas.js`). La reserva como invitado solo existe para Parla. Debería ser una opción por
  sede: reserva directa, calendario de GHL o aviso al equipo.
- **Apertura de El Cañaveral** (`src/canaveral.js`, `ofertaCanaveral` y tramos de plazas en
  `src/knowledge.js`, comprobación de la lista de sedes en `src/llm.js`). Es una promoción concreta. El modelo
  general sería una promoción por sede con fechas y tramos en la configuración.
- **Embudo** (`src/embudo.js`). Lee informes de metro-trial-crm y los registros de clientes-analytics de cada
  sede. Para otros negocios, el embudo debería salir solo de lo que registra Sofía y de su programa de reservas.
- **Teléfonos** (`src/aimharder/index.js`, `src/primer-contacto.js`). Se normalizan a 9 dígitos españoles. Con
  clientes de otros países hace falta el prefijo del país en `negocio.json` y formato internacional (E.164).
- **Filtro de Instagram** (`src/instagram.js`). Su instrucción describe MetroPolitano y sus sedes. Debería
  construirse con `negocio.json`.
- **Casos de la batería de pruebas** (`eval/`). Son momentos reales de Zapp para MetroPolitano. Cada negocio
  debería tener los suyos.
- **Panel.** El título («ZAPP · Panel de Sofía»), los textos de MetroTools y la identidad visual son de
  MetroPolitano. Los nombres de sede ya llegan del servidor.

## Orden recomendado

1. Herramientas generadas desde la configuración y teléfonos internacionales: con eso, otro box con AimHarder
   puede funcionar solo con configuración.
2. Clase de prueba y promociones como opciones por sede.
3. Interfaz de reservas con adaptadores (AimHarder, calendarios de GHL, Google Calendar…) para negocios que no
   son gimnasios.
4. Cuentas de usuario en el panel, cobro de la suscripción y alta de negocios desde una web (ver la hoja de ruta
   de [vps-propio.md](vps-propio.md)).
