import { z } from 'zod';

/**
 * What the composer and the message toolbar need from the backend beyond the AG-UI stream: thumbs feedback on
 * assistant messages, argument completion from pi extensions, and the toolbar actions and suggestion pills that
 * extensions register over pi's shared event bus.
 */

// ---- thumbs feedback: GET and PUT /api/threads/:id/feedback

export const FeedbackRatingSchema = z.enum(['up', 'down']);
export type FeedbackRating = z.infer<typeof FeedbackRatingSchema>;

/** `messageId` is the pi entry id of the assistant message (the AG-UI message id once the run's history snapshot is applied). */
export const FeedbackEntrySchema = z.object({
  messageId: z.string(),
  rating: FeedbackRatingSchema,
  updatedAt: z.number(),
}).meta({ id: 'FeedbackEntry' });
export type FeedbackEntry = z.infer<typeof FeedbackEntrySchema>;

/** `rating: null` clears the message's rating. */
export const PutFeedbackSchema = z.object({
  messageId: z.string().min(1),
  rating: FeedbackRatingSchema.nullable(),
}).meta({ id: 'PutFeedback' });
export type PutFeedback = z.infer<typeof PutFeedbackSchema>;

// ---- argument completion: POST /api/threads/:id/complete

/** Single-line composer text and the caret position in it (a character offset). */
export const CompleteRequestSchema = z.object({
  text: z.string(),
  cursor: z.number().int().nonnegative(),
}).meta({ id: 'CompleteRequest' });
export type CompleteRequest = z.infer<typeof CompleteRequestSchema>;

export const CompleteItemSchema = z.object({
  value: z.string(),
  label: z.string(),
  description: z.string().optional(),
  /** The whole composer text and caret after applying this item, so the renderer only has to set both. */
  insert: z.object({ text: z.string(), cursor: z.number().int().nonnegative() }),
});
export type CompleteItem = z.infer<typeof CompleteItemSchema>;

export const CompleteResponseSchema = z.object({
  /** The text before the caret that the items replace. */
  prefix: z.string(),
  items: z.array(CompleteItemSchema),
}).meta({ id: 'CompleteResponse' });
export type CompleteResponse = z.infer<typeof CompleteResponseSchema>;

/** At most this many items are returned. */
export const COMPLETE_MAX_ITEMS = 20;

// ---- toolbar actions and suggestion pills registered by extensions

/**
 * `pi.events.emit('pi-kit:composer', payload)` from an extension. The backend validates the payload with this schema and
 * relays it to the renderer as the AG-UI custom event `pi.composer` (the same value). The renderer reduces the events by
 * `id`: a later `action` or `suggestion` with the same id replaces the earlier one, `remove` deletes it.
 */
export const COMPOSER_CHANNEL = 'pi-kit:composer';

export const ComposerActionSchema = z.object({
  op: z.literal('action'),
  id: z.string().min(1),
  label: z.string().min(1),
  /** One short glyph or word. */
  icon: z.string().max(8).optional(),
  /** What the button puts in the composer, e.g. `/pk-hello `. */
  text: z.string(),
  /** Send the text at once instead of inserting it. */
  send: z.boolean().optional(),
});

export const ComposerSuggestionSchema = z.object({
  op: z.literal('suggestion'),
  id: z.string().min(1),
  title: z.string().min(1),
  text: z.string(),
  send: z.boolean().optional(),
});

export const ComposerRemoveSchema = z.object({
  op: z.literal('remove'),
  id: z.string().min(1),
});

export const ComposerRegistrationSchema = z.discriminatedUnion('op', [ComposerActionSchema, ComposerSuggestionSchema, ComposerRemoveSchema]).meta({ id: 'ComposerRegistration' });
export type ComposerRegistration = z.infer<typeof ComposerRegistrationSchema>;
export type ComposerAction = z.infer<typeof ComposerActionSchema>;
export type ComposerSuggestion = z.infer<typeof ComposerSuggestionSchema>;
