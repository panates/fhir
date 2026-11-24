/**
 * A patient's addresses, a child written by hand rather than with
 * `childTable()`: the EMR keeps a home and a work address at most, keyed by
 * the patient and the kind, and deletes them with the patient. The SQL is
 * the EMR's own (an upsert, an array of ids).
 */
import { FhirServerError } from '@fhirjs/server';
import type { SqlChild } from '@fhirjs/sql';
import { addressRows } from './mapping.js';

export const addresses: SqlChild = {
  async read(parentIds, db) {
    const rows = await db.rows(
      `select patient_id::text as patient_id, kind, line, city, postal_code, country
         from patient_addresses where patient_id = any(cast(:ids as bigint[]))
        order by patient_id, kind`,
      { ids: parentIds },
    );
    const byPatient = new Map<string, Record<string, any>[]>();
    for (const { patient_id, ...row } of rows)
      byPatient.set(patient_id, [...(byPatient.get(patient_id) ?? []), row]);
    return byPatient;
  },

  join: (parentId, alias) => ({
    table: 'patient_addresses',
    on: `${alias}.patient_id = ${parentId}`,
  }),

  async write(parentId, resource, db) {
    const rows = addressRows(resource);
    const kinds = rows.map(a => a.kind);
    if (new Set(kinds).size !== kinds.length)
      throw new FhirServerError(
        422,
        'The Patient has two addresses of the same use',
        'not-supported',
      );
    await db.rows(
      `delete from patient_addresses
        where patient_id = :patient and not (kind = any(cast(:kinds as text[])))`,
      { patient: parentId, kinds },
    );
    for (const a of rows)
      await db.rows(
        `insert into patient_addresses (patient_id, kind, line, city, postal_code, country)
         values (:patient, :kind, :line, :city, :postal_code, :country)
         on conflict (patient_id, kind) do update set line = excluded.line,
           city = excluded.city, postal_code = excluded.postal_code,
           country = excluded.country`,
        { patient: parentId, ...a },
      );
  },
  // the foreign key cascades: no remove()
};
