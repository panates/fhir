import { JwtError } from './jwt-error.js';

export interface JwksClientOptions {
  /** Where the JWK Set is: the authorization server's jwks_uri */
  jwksUri?: string;
  /**
   * The issuer, when jwksUri is not given: its jwks_uri is read from its
   * /.well-known/openid-configuration, which must name the same issuer
   */
  issuer?: string;
  /** How long the keys are kept, in milliseconds (default an hour) */
  cacheTtl?: number;
  /**
   * The least time between two reads for a key the set does not have, in
   * milliseconds (default 30 s): a token naming an unknown kid makes the
   * keys be read again (keys are rotated), but not at every request. 0 reads
   * them again each time.
   */
  minRefetchInterval?: number;
  fetch?: typeof fetch;
}

/** The header fields a key is chosen by */
export interface JwkSelector {
  kid?: string;
  alg: string;
}

/**
 * The signing keys of an authorization server, from its JWK Set: read once,
 * kept, and read again when a token names a key the set does not have (the
 * server has rotated its keys). Concurrent reads are one read.
 */
export class JwksClient {
  private _keys?: JsonWebKey[];
  private _readAt = 0;
  private _reading?: Promise<JsonWebKey[]>;
  private _jwksUri?: string;

  constructor(readonly options: JwksClientOptions) {
    if (!options.jwksUri && !options.issuer)
      throw new TypeError('JwksClient: jwksUri or issuer is needed');
    this._jwksUri = options.jwksUri;
  }

  /** The keys of the set; read again when `reload`, or when kept too long */
  async keys(reload = false): Promise<JsonWebKey[]> {
    const ttl = this.options.cacheTtl ?? 3_600_000;
    if (this._keys && !reload && Date.now() - this._readAt < ttl)
      return this._keys;
    this._reading ??= this._read().finally(() => (this._reading = undefined));
    return this._reading;
  }

  /**
   * The key a token's header names: by kid (when it has one) and an alg the
   * key is not limited away from; never a key for encryption. Reads the set
   * again once when it has none, at most every minRefetchInterval.
   */
  async keyFor(header: JwkSelector): Promise<JsonWebKey | undefined> {
    const pick = (keys: JsonWebKey[]) =>
      keys.find(
        k =>
          (header.kid === undefined || (k as any).kid === header.kid) &&
          (k.alg === undefined || k.alg === header.alg) &&
          k.use !== 'enc',
      );
    const found = pick(await this.keys());
    if (found) return found;
    const min = this.options.minRefetchInterval ?? 30_000;
    if (Date.now() - this._readAt < min) return;
    return pick(await this.keys(true));
  }

  private async _read(): Promise<JsonWebKey[]> {
    const f = this.options.fetch ?? fetch;
    if (!this._jwksUri) {
      const issuer = this.options.issuer!;
      const config = await getJson(
        `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`,
        'OpenID configuration',
        f,
      );
      if (config.issuer !== undefined && config.issuer !== issuer)
        throw new JwtError(
          `The OpenID configuration of ${issuer} names another issuer, ${config.issuer}`,
          'key',
        );
      if (typeof config.jwks_uri !== 'string')
        throw new JwtError(
          `The OpenID configuration of ${issuer} has no jwks_uri`,
          'key',
        );
      this._jwksUri = config.jwks_uri;
    }
    const jwks = await getJson(this._jwksUri!, 'JWK Set', f);
    this._keys = Array.isArray(jwks.keys) ? jwks.keys : [];
    this._readAt = Date.now();
    return this._keys!;
  }
}

/** https only, but for this machine (development) */
export function checkHttps(url: string, what: string): string {
  const u = new URL(url);
  const local =
    u.hostname === 'localhost' ||
    u.hostname === '127.0.0.1' ||
    u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local))
    throw new JwtError(`The ${what} ${url} is not https`, 'key');
  return url;
}

async function getJson(
  url: string,
  what: string,
  f: typeof fetch,
): Promise<any> {
  const res = await f(checkHttps(url, what), {
    headers: { Accept: 'application/json' },
  });
  const json = await res.json().catch(() => undefined);
  if (!res.ok || !json)
    throw new JwtError(`${url}: ${res.status}, no ${what}`, 'key');
  return json;
}
