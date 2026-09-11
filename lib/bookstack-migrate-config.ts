import { normalizeBookStackOrigin, type BookStackClientInput } from "./bookstack-migrate-client.ts";

type BookStackEnvironment = Record<string, string | undefined>;

const requiredSecret = (value: string | undefined, code: string) => {
  if (!value || /[\r\n]/.test(value)) throw new Error(code);
  return value;
};

export function resolveBookStackOrigin(environment: BookStackEnvironment): string {
  const baseUrl = environment.BOOKSTACK_BASE_URL?.trim();
  const legacyOrigin = environment.BOOKSTACK_ORIGIN?.trim();
  if (!baseUrl && !legacyOrigin) throw new Error("bookstack_base_url_required");

  const primary = baseUrl ? normalizeBookStackOrigin(baseUrl) : null;
  const legacy = legacyOrigin ? normalizeBookStackOrigin(legacyOrigin) : null;
  if (primary && legacy && primary !== legacy) throw new Error("bookstack_origin_conflict");
  return primary ?? legacy!;
}

export function resolveBookStackClientInput(environment: BookStackEnvironment): BookStackClientInput {
  return {
    origin: resolveBookStackOrigin(environment),
    tokenId: requiredSecret(environment.BOOKSTACK_TOKEN_ID, "bookstack_token_id_required"),
    tokenSecret: requiredSecret(environment.BOOKSTACK_TOKEN_SECRET, "bookstack_token_secret_required"),
  };
}
