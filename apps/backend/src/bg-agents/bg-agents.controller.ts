import { Body, ConflictException, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiNoContentResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { type AgentAnswerBody, AgentAnswerBodySchema, type AgentMessageBody, AgentMessageBodySchema, type BgAgent, BgAgentSchema } from '@pi-kit/protocol';
import { Fails, Responds, ThreadIdParam } from '../contract';
import { BgAgentsService } from './bg-agents.service';

/** The background agents of a thread: the list, a message to one, the user's answer to its question, stop, delete. */
@ApiTags('threads')
@ThreadIdParam()
@Controller('threads/:id/agents')
export class BgAgentsController {
  constructor(private readonly agents: BgAgentsService) {}

  @Get()
  @ApiOperation({ summary: "List a thread's background agents", description: 'Every background agent of the thread, active and finished, oldest first, with its status, what it does right now, its spend and its report.' })
  @Responds(BgAgentSchema, { array: true })
  async list(@Param('id') id: string): Promise<BgAgent[]> {
    await this.agents.warm(id);
    return this.agents.list(id).map((row) => this.agents.toAgent(row));
  }

  @Post(':agent/message')
  @HttpCode(200)
  @ApiParam({ name: 'agent', description: 'The agent id.' })
  @ApiOperation({ summary: 'Message a background agent', description: 'More instructions for a running agent: a steer (now, mid-task) or a follow-up (after its current task).' })
  @Responds(BgAgentSchema)
  @Fails({ 404: 'There is no such agent in this thread.' })
  async message(@Param('id') id: string, @Param('agent') agent: string, @Body({ schema: AgentMessageBodySchema }) body: AgentMessageBody): Promise<BgAgent> {
    const { text, mode } = body;
    await this.agents.send(this.find(id, agent).id, text, mode, `panel:${Date.now()}`);
    return this.agents.toAgent(this.find(id, agent));
  }

  @Post(':agent/answer')
  @HttpCode(200)
  @ApiParam({ name: 'agent', description: 'The agent id.' })
  @ApiOperation({ summary: "Answer a background agent's question", description: "The user's answer to the question the agent waits on (`text`), or its dismissal (`cancelled`). The agent gets it verbatim; the main agent gets a receipt." })
  @Responds(BgAgentSchema)
  @Fails({ 404: 'There is no such agent in this thread.', 409: 'The question is already answered, or it is not this agent\'s.' })
  async answer(@Param('id') id: string, @Param('agent') agent: string, @Body({ schema: AgentAnswerBodySchema }) body: AgentAnswerBody): Promise<BgAgent> {
    const row = this.find(id, agent);
    try {
      await this.agents.answer(row.id, body.question, body.cancelled ? 'cancelled' : 'user', body.cancelled ? null : (body.text ?? ''));
    } catch (error) {
      throw new ConflictException(error instanceof Error ? error.message : String(error));
    }
    return this.agents.toAgent(this.find(id, agent));
  }

  @Post(':agent/resume')
  @HttpCode(200)
  @ApiParam({ name: 'agent', description: 'The agent id.' })
  @ApiOperation({ summary: 'Resume a held background agent', description: 'An agent held after a restart goes on: the processes of its interrupted command are gone (or may be), or the crash-loop limit is lifted.' })
  @Responds(BgAgentSchema)
  @Fails({ 404: 'There is no such agent in this thread.' })
  resume(@Param('id') id: string, @Param('agent') agent: string): BgAgent {
    const row = this.find(id, agent);
    if (row.cleanup) this.agents.discardCleanup(row.id);
    else this.agents.resumeAgent(row.id);
    return this.agents.toAgent(this.find(id, agent));
  }

  @Post(':agent/stop')
  @HttpCode(200)
  @ApiParam({ name: 'agent', description: 'The agent id.' })
  @ApiOperation({ summary: 'Stop a background agent', description: 'Aborts its work; it keeps what it did so far and stays in History as stopped.' })
  @Responds(BgAgentSchema)
  @Fails({ 404: 'There is no such agent in this thread.' })
  async stop(@Param('id') id: string, @Param('agent') agent: string): Promise<BgAgent> {
    await this.agents.stop(this.find(id, agent).id);
    return this.agents.toAgent(this.find(id, agent));
  }

  @Delete(':agent')
  @HttpCode(204)
  @ApiParam({ name: 'agent', description: 'The agent id.' })
  @ApiOperation({ summary: 'Delete a background agent', description: 'Stops it if it runs and removes it from the thread, History included; its durable transcript stays in the store.' })
  @ApiNoContentResponse({ description: 'The agent is deleted.' })
  @Fails({ 404: 'There is no such agent in this thread.' })
  async remove(@Param('id') id: string, @Param('agent') agent: string): Promise<void> {
    await this.agents.deleteAgent(this.find(id, agent).id);
  }

  private find(threadId: string, agentId: string) {
    const row = this.agents.get(agentId);
    if (!row || row.threadId !== threadId) throw new NotFoundException('There is no such agent in this thread.');
    return row;
  }
}
