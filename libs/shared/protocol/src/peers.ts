import { z } from 'zod';
import { EnvironmentNameSchema, EnvironmentSchema, InstanceIdSchema } from './environments';

const fingerprint = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const proof = z.string().min(32).max(16384).meta({ secret: true });
export const PeerPublicKeySchema = z
  .object({ kty: z.literal('OKP'), crv: z.literal('Ed25519'), x: fingerprint })
  .strict();
export const InstanceKeyInfoSchema = z.object({ publicKey: PeerPublicKeySchema, fingerprint }).strict();
export type InstanceKeyInfo = z.infer<typeof InstanceKeyInfoSchema>;
export const PeerProofClaimsSchema = z
  .object({
    aud: InstanceIdSchema,
    purpose: z.enum([
      'pair-request',
      'pair-status',
      'pair-pending',
      'pair-confirm',
      'pair-ack',
      'session',
      'session-confirm',
      'unpair',
    ]),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
    pairId: z.uuid().optional(),
    bootId: z.uuid().optional(),
    binding: fingerprint.optional(),
    relay: z.boolean().optional(),
  })
  .strict();
export type PeerProofClaims = z.infer<typeof PeerProofClaimsSchema>;
export const InstanceKeyRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('info'), instanceId: InstanceIdSchema, create: z.boolean().default(false) }).strict(),
  z.object({ action: z.literal('sign'), instanceId: InstanceIdSchema, claims: PeerProofClaimsSchema }).strict(),
]);
export type InstanceKeyRequest = z.infer<typeof InstanceKeyRequestSchema>;
export const PeerOriginSchema = z
  .string()
  .max(300)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.origin === value &&
        /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ts\.net(?::[1-9][0-9]{0,4})?$/.test(
          value,
        ) &&
        (!url.port || Number(url.port) <= 65535)
      );
    } catch {
      return false;
    }
  }, 'Use a canonical private Tailscale HTTPS origin.');
export const PeerIdentitySchema = z
  .object({
    instanceId: InstanceIdSchema,
    name: EnvironmentNameSchema,
    origin: PeerOriginSchema,
    publicKey: PeerPublicKeySchema,
    fingerprint,
    protocolVersion: z.literal(1),
  })
  .strict()
  .meta({ id: 'PeerIdentity' });
export type PeerIdentity = z.infer<typeof PeerIdentitySchema>;
export const PeerMetadataSchema = z
  .object({ identity: PeerIdentitySchema, bootId: z.uuid() })
  .strict()
  .meta({ id: 'PeerMetadata' });
export const PeerInvitationSchema = z
  .object({
    kind: z.literal('pi-kit-instance'),
    version: z.literal(1),
    pairId: z.uuid(),
    secret: fingerprint,
    identity: PeerIdentitySchema,
    expiresAt: z.number().int(),
  })
  .strict();
export const PeerInvitationResultSchema = z
  .object({ invitation: z.string(), expiresAt: z.number().int() })
  .meta({ id: 'PeerInvitationResult' });
export const PeerConnectSchema = z
  .object({ invitation: z.string().min(10).max(8192).meta({ secret: true }), allowRelay: z.boolean() })
  .strict()
  .meta({ id: 'PeerConnect' });
export const PeerConsentSchema = z.object({ allowRelay: z.boolean() }).strict().meta({ id: 'PeerConsent' });
export const PeerPairRequestSchema = z
  .object({
    pairId: z.uuid(),
    secret: fingerprint.meta({ secret: true }),
    identity: PeerIdentitySchema,
    allowRelay: z.boolean(),
    proof,
  })
  .strict()
  .meta({ id: 'PeerPairRequest' });
export const PeerPairProofSchema = z.object({ pairId: z.uuid(), proof }).strict().meta({ id: 'PeerPairProof' });
export const PeerPairStatusSchema = z
  .discriminatedUnion('status', [
    z.object({ status: z.literal('pending'), confirmationCode: z.string().regex(/^\d{6}$/), proof }),
    z.object({
      status: z.literal('approved'),
      receipt: proof,
      confirmationCode: z.string().regex(/^\d{6}$/),
      allowRelay: z.boolean(),
      remoteAllowRelay: z.boolean(),
    }),
  ])
  .meta({ id: 'PeerPairStatus' });
export const PeerSummarySchema = z
  .object({
    peerId: z.uuid(),
    pairId: z.uuid(),
    name: EnvironmentNameSchema,
    origin: PeerOriginSchema,
    fingerprint,
    state: z.enum(['pending', 'active', 'revoked']),
    allowRelay: z.boolean(),
    remoteAllowRelay: z.boolean(),
    sharedWithPhones: z.boolean(),
    unpairPending: z.boolean(),
    confirmationCode: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
  })
  .meta({ id: 'PeerSummary' });
export type PeerSummary = z.infer<typeof PeerSummarySchema>;
export const PeerManagerSchema = z
  .object({
    self: EnvironmentSchema,
    keyInitialized: z.boolean(),
    endpoint: PeerOriginSchema.optional(),
    peers: z.array(PeerSummarySchema),
    requests: z.array(
      z.object({
        pairId: z.uuid(),
        name: EnvironmentNameSchema,
        origin: PeerOriginSchema,
        fingerprint,
        confirmationCode: z.string(),
        expiresAt: z.number().int(),
      }),
    ),
  })
  .meta({ id: 'PeerManager' });
export type PeerManager = z.infer<typeof PeerManagerSchema>;
export const PeerChallengeRequestSchema = z.object({ peerId: z.uuid() }).strict().meta({ id: 'PeerChallengeRequest' });
export const PeerChallengeSchema = z
  .object({ nonce: fingerprint, bootId: z.uuid(), expiresAt: z.number().int() })
  .strict()
  .meta({ id: 'PeerChallenge' });
export const PeerSessionRequestSchema = z
  .object({
    peerId: z.uuid(),
    proof,
    nonce: fingerprint,
    relay: z.boolean(),
    actor: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,128}$/)
      .optional(),
  })
  .strict()
  .refine(
    (value) => (value.relay ? value.actor !== undefined : value.actor === undefined),
    'Relay sessions require an entry-scoped device actor; native sessions must not assert one.',
  )
  .meta({ id: 'PeerSessionRequest' });
export const PeerSessionSchema = z
  .object({ token: fingerprint.meta({ secret: true }), expiresAt: z.number().int(), proof, bootId: z.uuid() })
  .strict()
  .meta({ id: 'PeerSession' });
