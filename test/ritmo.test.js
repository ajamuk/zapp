import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retardoHumano, chatCaliente } from '../src/horario.js';

const o = { min: 15, max: 50, velocidad: 4, tope: 12 };
const fijo = (v) => ({ ...o, random: () => v });

test('ritmo: la espera antes de contestar queda en la franja de Ajustes y es más corta con el chat caliente', () => {
  assert.equal(retardoHumano([], fijo(0)).lectura, 15000);
  assert.equal(retardoHumano([], fijo(1)).lectura, 50000);
  assert.equal(retardoHumano([], { ...fijo(1), caliente: true }).lectura, 29000); // 15 + 40 % de la franja
  assert.equal(retardoHumano([], { ...fijo(0), caliente: true }).lectura, 15000);
  // Leer un mensaje largo suma unos segundos, 6 como mucho
  assert.equal(retardoHumano([], { ...fijo(0), leido: 90 }).lectura, 18000);
  assert.equal(retardoHumano([], { ...fijo(0), leido: 5000 }).lectura, 21000);
});

test('ritmo: las burbujas largas no tardan todas lo mismo, hay tope y pausa entre burbujas', () => {
  const medio = fijo(0.5); // sin variación (factor 1)
  const [corta, media, larga, enorme] = ['x'.repeat(20), 'x'.repeat(48), 'x'.repeat(120), 'x'.repeat(2000)].map((t) => retardoHumano([t], medio).escritura[0]);
  assert.equal(corta, 5000);
  assert.equal(media, 12000);
  assert.equal(larga, 15600);          // 12 + 20 % de los 18 s que pasan del tope
  assert.equal(enorme, 21000);         // nunca más de 1,75 × tope
  assert.ok(media < larga && larga < enorme);
  // De la segunda burbuja en adelante se añade una pausa de 0,8 a 2 s
  const [a, b] = retardoHumano(['x'.repeat(20), 'x'.repeat(20)], medio).escritura;
  assert.equal(a, 5000); assert.equal(b, 6400);
  // La variación es de ±20 %: dos turnos iguales no salen con los mismos tiempos
  assert.equal(retardoHumano(['x'.repeat(40)], fijo(0)).escritura[0], 8000);
  assert.equal(retardoHumano(['x'.repeat(40)], fijo(1)).escritura[0], 12000);
});

test('ritmo: el chat está caliente si Sofía escribió hace menos de 3 minutos', () => {
  const ahora = new Date('2026-11-24T10:00:00Z');
  assert.equal(chatCaliente('2026-11-24T09:58:30Z', ahora), true);
  assert.equal(chatCaliente('2026-11-24T09:50:00Z', ahora), false);
  assert.equal(chatCaliente(null, ahora), false);
});
