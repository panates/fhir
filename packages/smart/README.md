# @fhirjs/smart

SMART on FHIR building blocks: JWT verification with JWK Sets, and SMART scopes.

It has no dependency and uses Web Crypto. [`@fhirjs/client`](https://www.npmjs.com/package/@fhirjs/client)
verifies id_tokens with it, and [`@fhirjs/server`](https://www.npmjs.com/package/@fhirjs/server)
access tokens.

## Install

```bash
npm install @fhirjs/smart
```

## Usage

### Verifying a JWT

```ts
import { JwksClient, JwtError, verifyJwt } from '@fhirjs/smart';

// the issuer's keys, found through its /.well-known/openid-configuration
const keys = new JwksClient({ issuer: 'https://auth.example.org/realms/hbys' });

try {
  const { claims } = await verifyJwt(token, {
    keys,
    issuer: 'https://auth.example.org/realms/hbys',
    audience: 'https://fhir.example.org/fhir',
  });
} catch (e) {
  if (e instanceof JwtError) console.log(e.code, e.message); // 'expired', 'signature' ...
}
```

The algorithm must be one taken (RS256, RS384, ES256, ES384 and PS256 by default; never `none`),
the token must come from the issuer expected, be signed with a key of that issuer, be for the
audience, and be within `exp` and `nbf` (with 60 seconds of clock skew). `JwksClient` keeps the
keys for an hour and reads them again for a `kid` it does not have, as an issuer rotates its
keys, but at most every 30 seconds, so tokens naming unknown keys do not make it call the issuer
at every request.

### SMART scopes

```ts
import { grantingScopes, parseScopes } from '@fhirjs/smart';

const scopes = parseScopes('openid patient/*.read patient/Observation.cu?category=laboratory');
// v1 is read as v2: patient/*.read grants r and s
grantingScopes(scopes, 's', 'Encounter'); // [patient/*.read]
grantingScopes(scopes, 'c', 'Observation')[0].query; // 'category=laboratory'
```

## Documentation

[The design of authentication and authorization](https://github.com/panates/fhirjs/blob/main/docs/decisions/server-auth.md)

## License

BSD-3-Clause
