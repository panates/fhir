/** Why a JWT does not verify */
export type JwtErrorCode =
  | 'malformed'
  | 'algorithm'
  | 'issuer'
  | 'key'
  | 'signature'
  | 'audience'
  | 'expired'
  | 'not-yet-valid'
  | 'claims';

/** A JWT that does not verify, or keys that cannot be read */
export class JwtError extends Error {
  constructor(
    message: string,
    readonly code: JwtErrorCode,
  ) {
    super(message);
    this.name = 'JwtError';
  }
}
