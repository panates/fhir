import { FhirClient } from '@fhirjs/client';
import { FhirContext } from '@fhirjs/core';
import { Patient, r4Model } from '@fhirjs/r4';
import { expect } from 'expect';
import { FhirServer, MemoryStore, SUBSETTED } from '../src/index.js';

const fhir = new FhirContext(r4Model);
const DIV = '<div xmlns="http://www.w3.org/1999/xhtml">Ayşe</div>';

const PATIENT = {
  resourceType: 'Patient',
  id: 'p1',
  meta: { tag: [{ system: 'urn:t', code: 'kept' }] },
  text: { status: 'generated', div: DIV },
  active: true,
  name: [{ family: 'Yılmaz' }],
  birthDate: '2000-01-01',
  _birthDate: { extension: [{ url: 'urn:x', valueString: 'approx' }] },
  maritalStatus: { text: 'M' },
  contact: [{ name: { family: 'Kaya' } }],
};
const OBSERVATION = {
  resourceType: 'Observation',
  id: 'o1',
  status: 'final',
  code: { text: 'bp' },
  subject: { reference: 'Patient/p1' },
  note: [{ text: 'sitting' }],
  component: [
    {
      code: { text: 'systolic' },
      valueQuantity: { value: 120 },
      interpretation: [{ text: 'normal' }],
    },
  ],
};

async function serverOf() {
  const store = new MemoryStore();
  const server = new FhirServer({ fhir, store });
  await store.update('Patient', 'p1', PATIENT);
  await store.update('Observation', 'o1', OBSERVATION);
  const get = async (path: string, strict = true) => {
    const r = await server.handle(
      new Request(`http://localhost/${path}`, {
        headers: strict ? { Prefer: 'handling=strict' } : {},
      }),
    );
    const body = await r.json();
    return r.status === 200 ? body : `${r.status} ${body.issue[0].diagnostics}`;
  };
  return { server, get };
}

/** The keys of a resource but meta, and whether it is tagged SUBSETTED */
const shape = (r: Record<string, any>) => [
  Object.keys(r)
    .filter(k => k !== 'meta')
    .join(','),
  r.meta?.tag?.some((t: any) => t.code === SUBSETTED.code) ?? false,
];

describe('FhirServer: _summary and _elements', () => {
  it('reads the summary elements, also within backbone elements, tagged SUBSETTED', async () => {
    const { get } = await serverOf();
    const p = await get('Patient/p1?_summary=true');
    expect(shape(p)).toEqual([
      'resourceType,id,active,name,birthDate,_birthDate',
      true,
    ]);
    // the tags it had are kept, and its version
    expect(p.meta).toMatchObject({
      versionId: '1',
      tag: [{ code: 'kept' }, SUBSETTED],
    });
    const o = await get('Observation/o1?_summary=true');
    expect(shape(o)[0]).toBe('resourceType,id,status,code,subject,component');
    // Observation.component.interpretation is not a summary element
    expect(o.component).toEqual([
      { code: { text: 'systolic' }, valueQuantity: { value: 120 } },
    ]);
    expect(shape(await get('Patient/p1/_history/1?_summary=true'))[0]).toBe(
      'resourceType,id,active,name,birthDate,_birthDate',
    );
  });

  it('reads the text, the data, and the elements asked for with the mandatory ones', async () => {
    const { get } = await serverOf();
    expect([
      shape(await get('Patient/p1?_summary=text')),
      shape(await get('Patient/p1?_summary=data')),
      shape(await get('Patient/p1?_elements=birthDate,name')),
      // status and code are mandatory
      shape(await get('Observation/o1?_elements=note')),
      shape(await get('Observation/o1?_elements=value[x]')),
      // false, and no element known: the whole resource, not tagged
      shape(await get('Patient/p1?_summary=false')),
      shape(await get('Patient/p1?_elements=nope', false)),
    ]).toEqual([
      ['resourceType,id,text', true],
      [
        'resourceType,id,active,name,birthDate,_birthDate,maritalStatus,contact',
        true,
      ],
      ['resourceType,id,name,birthDate,_birthDate', true],
      ['resourceType,id,status,code,note', true],
      ['resourceType,id,status,code', true],
      [
        'resourceType,id,text,active,name,birthDate,_birthDate,maritalStatus,contact',
        false,
      ],
      [
        'resourceType,id,text,active,name,birthDate,_birthDate,maritalStatus,contact',
        false,
      ],
    ]);
  });

  it('gives a search the total alone with count, and subsets the included resources', async () => {
    const { get } = await serverOf();
    const count = await get(
      'Observation?_summary=count&_include=Observation:subject',
    );
    expect(count.total).toBe(1);
    expect(count.entry).toBeUndefined();
    expect(count.link[0].url).toBe(
      'http://localhost/Observation?_summary=count&_count=50',
    );
    const both = await get(
      'Observation?_elements=note,Patient.active&_include=Observation:subject',
    );
    expect(both.entry.map((e: any) => shape(e.resource))).toEqual([
      ['resourceType,id,status,code,note', true],
      ['resourceType,id,active', true],
    ]);
    expect(both.link[0].url).toContain('_elements=note%2CPatient.active');
    expect(
      (await get('Patient?_summary=text')).entry.map((e: any) =>
        shape(e.resource),
      ),
    ).toEqual([['resourceType,id,text', true]]);
  });

  it('refuses what it cannot read', async () => {
    const { get } = await serverOf();
    expect([
      await get('Patient?_summary=some'),
      await get('Patient?_summary=true&_summary=text'),
      await get('Patient?_summary=true&_elements=name'),
      await get('Patient/p1?_summary=count'),
      await get('Patient?_elements=nope'),
      await get('Observation?_elements=Nope.name'),
    ]).toEqual([
      '400 _summary: "some" is not one of true, false, text, data, count',
      '400 _summary is given more than once',
      '400 _summary and _elements cannot be used together',
      '400 _summary=count is for a search, not a read',
      '400 _elements: Patient has no element nope',
      '400 _elements: Nope has no element name',
    ]);
  });

  it('is asked for by the client, which reads the part it is given', async () => {
    const { server } = await serverOf();
    const client = new FhirClient({
      baseUrl: 'http://localhost',
      fhir,
      fetch: (input, init) => server.handle(new Request(input, init)),
    });
    const p = await client.read(Patient, 'p1', { elements: ['birthDate'] });
    expect(p.birthDate).toBe('2000-01-01');
    expect(p.name).toBeUndefined();
    expect(p.meta!.tag!.map(t => t.code)).toEqual(['kept', 'SUBSETTED']);
  });
});
