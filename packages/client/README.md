# @fhirjs/client

FHIR REST client: typed resources through `@fhirjs/core`.

It reads and writes resources as the classes of a FHIR version, pages through search results,
and sends conditional interactions. Authorization comes in as interceptors: a bearer token, SMART
Backend Services, or SMART App Launch with PKCE.

## Install

```bash
npm install @fhirjs/client @fhirjs/core @fhirjs/r4
```

## Usage

```ts
import { bearerToken, FhirClient } from '@fhirjs/client';
import { FhirContext } from '@fhirjs/core';
import { Patient, r4Model } from '@fhirjs/r4';

const client = new FhirClient({
  baseUrl: 'https://fhir.example.org/fhir',
  fhir: new FhirContext(r4Model),
  interceptors: [bearerToken(() => token)],
});

const patient = await client.read(Patient, '123');

const page = await client.search(Patient, { family: 'Doe' });
for (const p of await page.all(100)) console.log(p.id);

const created = await client.create(new Patient({ name: [{ family: 'Kaya' }] }));
```

### SMART on FHIR

`discoverSmart()` reads the server's SMART configuration. `SmartBackendServices` gets tokens for
a system with a signed JWT, and `SmartAppLaunch` runs the authorization code flow with PKCE for
an app with a user. Both give a token provider for `bearerToken()`:

```ts
import { bearerToken, discoverSmart, FhirClient, SmartBackendServices } from '@fhirjs/client';

const config = await discoverSmart(baseUrl);
const backend = new SmartBackendServices({
  tokenEndpoint: config.token_endpoint,
  clientId,
  key, // a CryptoKey or a private JWK
  alg: 'ES384',
  scope: 'system/Patient.rs',
});
const client = new FhirClient({ baseUrl, fhir, interceptors: [bearerToken(backend.provider)] });
```

### Bulk Data export

`bulkExport()` starts an export on the server, `wait()` asks its status as the server's
Retry-After says, and `resources()` reads its files as resources, a line at a time:

```ts
const job = await client.bulkExport({ level: { group: 'ward-3' }, types: ['Patient', 'Observation'] });
const manifest = await job.wait({ onProgress: p => console.log(p) });
for await (const resource of job.resources(manifest)) save(resource);
```

`typeFilters`, `elements`, `patients` (a POST) and `includeAssociatedData` send the IG's
parameters; `deleted(manifest)` gives the
resources deleted since `since`, when the server lists them.

## Documentation

[The design of the library](https://github.com/panates/fhirjs/blob/main/docs/design/decorator-model.md)

## License

BSD-3-Clause
