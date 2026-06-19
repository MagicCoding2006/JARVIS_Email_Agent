import { randomUUID, randomBytes } from "node:crypto";

/** Stable UUID for primary keys. */
export function uuid(): string {
  return randomUUID();
}

/** Short URL-safe token for tracking links / unsubscribe tokens. */
export function token(bytes = 12): string {
  return randomBytes(bytes).toString("base64url");
}
