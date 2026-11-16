// A stand-in for a Cloudflare D1 binding, backed by Node's built-in SQLite, so the tests run the
// Worker's real SQL: unique codes, all-or-nothing batches and the partial index on snapshots.
import { DatabaseSync } from 'node:sqlite';

export function makeDB() {
  const sql = new DatabaseSync(':memory:');
  const tick = () => new Promise(r => setImmediate(r));   // like a network round trip, so requests can interleave
  const stmt = (text, args = []) => ({
    bind: (...a) => {
      if (a.some(v => v === undefined)) throw new Error('D1_TYPE_ERROR: Type undefined is not supported');
      return stmt(text, a);
    },
    async first(col) { await tick(); const r = sql.prepare(text).get(...args); return r ? (col ? r[col] : { ...r }) : null; },
    async all() { await tick(); return { results: sql.prepare(text).all(...args).map(r => ({ ...r })), success: true, meta: {} }; },
    async run() { await tick(); const r = sql.prepare(text).run(...args); return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
    exec() {
      const p = sql.prepare(text);
      if (/^\s*(select|with)\b/i.test(text)) return { results: p.all(...args), success: true };
      const r = p.run(...args);
      return { success: true, meta: { changes: Number(r.changes) } };
    },
  });
  return {
    sql,   // for looking inside in tests
    prepare: text => stmt(text),
    async batch(list) {
      await tick();
      sql.exec('BEGIN');
      try {
        const out = list.map(s => s.exec());
        sql.exec('COMMIT');
        return out;
      } catch (err) {
        sql.exec('ROLLBACK');
        throw new Error('D1_ERROR: ' + err.message);
      }
    },
  };
}

// Every value stored anywhere in the database, for checking that something (like an email) isn't
export function everything(db) {
  const tables = db.sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name);
  return tables.flatMap(t => db.sql.prepare(`SELECT * FROM ${t}`).all().flatMap(r => Object.values(r).map(String)));
}
