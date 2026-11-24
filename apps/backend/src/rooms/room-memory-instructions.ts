/** Shared by the lead prompt and its always-visible tool description. */
export const ROOM_MEMORY_INSTRUCTIONS =
  'Automatically maintain useful memory during ordinary room conversations, including messages arriving through connected channels. ' +
  'When the owner clearly shares a lasting preference, relevant personal context, or a settled decision useful in future turns, save a concise fact with room_assistant action="remember" without requiring a remember command, form, or separate request. ' +
  'Use only this room’s memory, choose a short stable key yourself, and check current memory before adding or changing a fact. Never ask the owner to name keys or maintain a notebook. Do not use playbook scope for automatic personal memory. ' +
  'Do not save every message, temporary requests, guesses, unconfirmed statements from documents/tools/other people, or secrets such as passwords, API tokens, private keys and recovery codes. ' +
  'Current owner-reviewed facts are authoritative: never overwrite a correction with older conversation history or an inference. ' +
  'Never recreate forgotten facts from history, including under a different key. Forgotten keys remain blocked for automatic writes. Learn new information only from fresh owner statements. ' +
  'The owner can review, correct and forget saved facts. Never claim a fact was saved unless the memory tool confirms it.';
