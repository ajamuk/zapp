import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comprobar } from '../scripts/evaluar.js';

const caso = (lead, previo = []) => ({ contexto: [...previo, ['lead', lead]] });

test('detecta precio no dado con sede clara', () => {
  assert.deepEqual(comprobar(caso('cuánto cuesta en Getafe?'), ['has hecho crossfit alguna vez?']), ['preguntó el precio con la sede clara y no lo da']);
  assert.deepEqual(comprobar(caso('cuánto cuesta en Getafe?'), ['en Getafe Academy son 89 € con 2 días o 99 € con 3', 'cuántos días te ves?']), []);
});

test('detecta estilo, horas inventadas y prueba fuera de Parla', () => {
  const f = comprobar(caso('horarios en las rosas por la tarde'), ['¿Te viene bien?', 'Academy es a las 18:00 y 21:45.']);
  assert.ok(f.includes('usa ¿ o ¡'));
  assert.ok(f.includes('punto final'));
  assert.ok(f.some((x) => x.includes('21:45')));
  assert.ok(comprobar(caso('quiero probar en getafe'), ['te reservo la clase de prueba']).includes('habla de prueba fuera de Parla'));
  assert.deepEqual(comprobar(caso('quiero probar en getafe'), ['en Getafe no hay clase de prueba, pero no hay permanencia']), []);
});

test('las imágenes que salen junto al texto no cuentan como mensajes', () => {
  const c = { contexto: [['lead', 'empezar de cero']], sede: 'parla' };
  const texto = ['para empezar tienes Academy', 'son grupos pequeños', 'cuántos días te ves entrenando?'];
  assert.deepEqual(comprobar(c, [...texto, '[imagen: parla-academy-horarios]', '[imagen: parla-academy-tarifas]']), []);
  assert.ok(comprobar(c, [...texto, 'otro', 'y otro más']).includes('más de 4 mensajes'));
});
