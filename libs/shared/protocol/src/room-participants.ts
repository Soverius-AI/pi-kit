import { z } from 'zod';
import { PlaybookParticipantSchema } from './playbooks';
import { RoomWorkerCandidateSchema } from './rooms';
import { A2aAgentSchema } from './a2a';

export const RoomParticipantInputSchema = z
  .object(PlaybookParticipantSchema.shape)
  .strict()
  .refine((value) => value.role !== 'lead', {
    message: 'The lead role is reserved.',
    path: ['role'],
  })
  .refine(
    (value) => {
      const { local, machine, agent } = value.agent;
      return Number(local === true) + Number(!!machine) + Number(!!agent) === 1;
    },
    { message: 'Choose exactly one local, paired-machine, or external agent target.', path: ['agent'] },
  )
  .meta({ id: 'RoomParticipantInput' });
export type RoomParticipantInput = z.infer<typeof RoomParticipantInputSchema>;
export const RoomParticipantSchema = z
  .object({ ...PlaybookParticipantSchema.shape, source: z.enum(['room', 'playbook']) })
  .meta({
    id: 'RoomParticipant',
  });
export type RoomParticipant = z.infer<typeof RoomParticipantSchema>;
export const RoomParticipantsSchema = z
  .object({ members: z.array(RoomParticipantSchema) })
  .strict()
  .meta({ id: 'RoomParticipants' });
export type RoomParticipants = z.infer<typeof RoomParticipantsSchema>;
export const RoomParticipantTargetsSchema = z
  .object({
    machines: z.array(RoomWorkerCandidateSchema),
    agents: z.array(A2aAgentSchema),
  })
  .strict()
  .meta({ id: 'RoomParticipantTargets' });
export type RoomParticipantTargets = z.infer<typeof RoomParticipantTargetsSchema>;
