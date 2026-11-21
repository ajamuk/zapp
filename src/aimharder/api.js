// Cliente de la API pública de AimHarder (https://api.aimharder.com). Un token por sede.
const BASE = 'https://api.aimharder.com';

export class AimHarderApi {
  /**
   * tokens: { access, refresh, onRefresh? } — onRefresh(access, refresh) para guardar la pareja nueva.
   * O bien leerToken(): token compartido con otras apps. Se relee antes de cada petición y NUNCA se renueva
   * aquí (lo renueva un cron central; renovarlo desde dos sitios deja sin acceso a los demás).
   */
  constructor({ access, refresh, onRefresh, leerToken, fetchImpl = fetch }) {
    Object.assign(this, { access, refresh, onRefresh, leerToken, fetch: fetchImpl });
  }

  async req(method, path, body, reintento = true) {
    if (this.leerToken) this.access = this.leerToken();
    const r = await this.fetch(BASE + path, {
      method,
      headers: { Authorization: `Bearer ${this.access}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000), // que una sincronización nunca se quede colgada
    });
    if (r.status === 410 && reintento && this.refresh && !this.leerToken) { // token caducado
      await this.refrescar();
      return this.req(method, path, body, false);
    }
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    if (!r.ok) throw new Error(`AimHarder ${method} ${path} → ${r.status}: ${String(text).slice(0, 200)}`);
    return data;
  }

  async refrescar() {
    const r = await this.fetch(`${BASE}/auth/tokens/refresh`, { headers: { Authorization: `Bearer ${this.refresh}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`AimHarder refresh → ${r.status}`);
    const { data } = await r.json();
    this.access = data['access-token'];
    this.refresh = data['refresh-token'];
    await this.onRefresh?.(this.access, this.refresh);
  }

  /** Recorre todas las páginas (paginación por cursor). */
  async todo(path) {
    const out = [];
    let cursor = null;
    for (let i = 0; i < 500; i++) {
      const sep = path.includes('?') ? '&' : '?';
      const page = await this.req('GET', cursor ? `${path}${sep}cursor=${encodeURIComponent(cursor)}` : path);
      out.push(...(page.data || []));
      cursor = page.pagination?.nextCursor;
      if (!cursor) return out;
    }
    throw new Error(`AimHarder ${path}: demasiadas páginas (lista sin terminar)`);
  }

  tarifas() { return this.todo('/memberships'); }
  clases() { return this.todo('/classes'); }
  horariosDeClase(id) { return this.todo(`/classes/${id}/schedule`); }
  calendario(fechaIso) { return this.req('GET', `/calendar/${fechaIso}`).then((r) => r.data || []); }
  clientes({ conTarifas = true } = {}) { return this.todo(`/clients${conTarifas ? '?with-current-memberships=true' : ''}`); }
  cliente(id) { return this.req('GET', `/clients/${id}?with-current-memberships=true`).then((r) => r.data); }
  crearCliente(datos) { return this.req('POST', '/clients', datos).then((r) => r.data); }
  crearLead(datos) { return this.req('POST', '/leads', datos).then((r) => r.data); }
}
