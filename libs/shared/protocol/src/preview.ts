import { z } from 'zod';

export const PreviewUrlSchema = z
  .string()
  .trim()
  .max(8192)
  .refine((value) => {
    try {
      const url = new URL(value);
      return /^https?:$/.test(url.protocol) && !url.username && !url.password;
    } catch {
      return false;
    }
  }, 'Preview URLs must be absolute HTTP(S) URLs without embedded credentials.');

export const PreviewDescriptorSchema = z.object({
  sourceUrl: PreviewUrlSchema,
  previewUrl: PreviewUrlSchema.optional(),
  title: z.string().trim().max(200).optional(),
});
export type PreviewDescriptor = z.infer<typeof PreviewDescriptorSchema>;

export const PreviewRegistrationSchema = z.discriminatedUnion('op', [
  PreviewDescriptorSchema.extend({ op: z.literal('set') }),
  z.object({ op: z.literal('clear') }),
]);
export type PreviewRegistration = z.infer<typeof PreviewRegistrationSchema>;

export function previewOrigins(values: readonly string[]): string[] {
  return [
    ...new Set(
      values.map((value) => {
        const url = new URL(value);
        if (
          !/^https?:$/.test(url.protocol) ||
          !(/^[a-z0-9.-]+$/i.test(url.hostname) || /^\[[0-9a-f:.]+\]$/i.test(url.hostname)) ||
          url.username ||
          url.password ||
          url.pathname !== '/' ||
          url.search ||
          url.hash
        )
          throw new Error('Preview origins must be exact HTTP(S) origins without paths or credentials.');
        return url.origin;
      }),
    ),
  ];
}
