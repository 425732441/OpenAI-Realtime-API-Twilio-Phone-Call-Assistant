import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { IncomingMessage } from 'http';
import { Server, WebSocket } from 'ws';
import { CallLogService } from './call-log.service';
import { AgentService } from '../agent/agent.service';
import { SystemConfigService } from '../system-config/system-config.service';

const VOICE = 'alloy';
// List of Event Types to log to the console. See OpenAI Realtime API Documentation. (session.updated is handled separately.)
const LOG_EVENT_TYPES = [
  'response.content.done',
  'rate_limits.updated',
  'response.done',
  'input_audio_buffer.committed',
  'input_audio_buffer.speech_stopped',
  'input_audio_buffer.speech_started',
  'session.created',
];

@WebSocketGateway({
  path: '/media-stream',
  transports: ['websocket'],
})
export class CallLogGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  constructor(
    private readonly callLogService: CallLogService,
    private readonly agentService: AgentService,
    private systemConfigService: SystemConfigService,
  ) {}

  @WebSocketServer()
  server: Server;

  private openAiWs: WebSocket;
  private streamSid: string | null = null;
  private callSid: string | null = null;
  private req_msg :boolean = false;
  private conversation_id: string | null = null;

  afterInit() {
    console.log('WebSocket server initialized');
  }

  async handleConnection(client: WebSocket, request: IncomingMessage): Promise<void> {
    const openAiApiKey = await this.systemConfigService.getConfigByKey('openai_api_key');
    console.log(openAiApiKey);

    this.openAiWs = new WebSocket('wss://ea01-azureopenai-eus201.openai.azure.com/openai/realtime?api-version=2024-10-01-preview&deployment=ea01-us201-gpt-4o-realtime-preview', {
      headers: {
        "api-key": openAiApiKey,
        // Authorization: `Bearer ${openAiApiKey}`,
        // "OpenAI-Beta": "realtime=v1"
      },
      timeout: 5000,
    });

    this.setupOpenAiWebSocket(client);

    client.on('message', (message: WebSocket.Data) => {
      this.handleMessage(client, message);
    });

    client.on('close', () => {
      this.handleDisconnect(client);
    });
  }

  private setupOpenAiWebSocket(client: WebSocket): void {
    this.openAiWs.on('open', async () => {
      console.log('Connected to the Azure OpenAI Realtime API');
      const callLog = await this.callLogService.findAll({
        where: [{ key: 'call_sid', operator: '=', value: this.callSid }],
      });
      if (callLog.length === 0) throw new Error('Call log not found');
      const agent = callLog[0].agent;
      const agentPrompt = await this.agentService.findOne(agent);
      if (!agentPrompt) throw new Error('Agent not found');
      
      await new Promise(resolve => setTimeout(resolve, 250));
      this.sendSessionUpdate(agentPrompt.prompt);
      this.callLogService.update(callLog[0].id, {
        status: 'called',
      });
    });

    this.openAiWs.on('message', (data: WebSocket.Data) => {
      this.handleOpenAiMessage(client, data);
    });

    this.openAiWs.on('close', () => {
      console.log('Disconnected from the Azure OpenAI Realtime API');
    });

    this.openAiWs.on('error', (error) => {
      console.error('Error in the Azure OpenAI WebSocket:', error);
    });
  }

  private sendSessionUpdate(systemMessage: string): void {
    const sessionUpdate = {
      type: 'session.update',
      session: {
        turn_detection: { type: 'server_vad' },
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        voice: VOICE,
        instructions: systemMessage,
        modalities: ['text', 'audio'],
        temperature: 0.8,
        tools: [
          {
            type: 'function',
            name: 'call_kofe',
            description: '调用kofe',
            parameters: {
              type: 'object',
              properties: {
                  query: {
                      type: 'string',
                      description: 'query from user',
                  },
              },
              required: ['query'],
          }
        }
        ],
      },
      
    };

    console.log('Sending session update:', JSON.stringify(sessionUpdate));
    this.openAiWs.send(JSON.stringify(sessionUpdate));
  }

  private async handleFunctionCall(message): Promise<void> {
    try {
      this.req_msg = false;
      const params = JSON.parse(message.arguments);

      const funcName: string = message.name;
      console.log('Function call:', funcName, params);

      const result = await fetch('https://demo.kofe.ai/v1/chat-messages', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer app-8vgs4ptlJA9N8fmp1R49w1VS',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          inputs: {
            session_id: "test_session",
          },
          query: params.query,
          response_mode: "blocking",
          conversation_id: this.conversation_id,
          user: "test_user",
        }),
      });
      
      const data = await result.json();
      console.log("data======>",data)
      if (!this.conversation_id) {
        this.conversation_id = data.conversation_id;
      }

      this.openAiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: message.call_id,
          output: JSON.stringify({ response: data.answer }),
        },
      }));

    } catch (error) {
      console.error('Error call tool:', error, 'param',message);

      this.openAiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: message.call_id,
          output: JSON.stringify({ error: "解析异常" }),
        },
      }));
      

    }
    this.createResponse()

  }
  private createResponse() {
    this.openAiWs.send(JSON.stringify({
        type: 'input_audio_buffer.commit'
    }));
    this.openAiWs.send(JSON.stringify({
        type: 'response.create'
    }));
    return true;
}

  private handleOpenAiMessage(client: WebSocket, data: WebSocket.Data): void {
    try {
      const response = JSON.parse(data.toString());
      console.log('Response', response);

      if (LOG_EVENT_TYPES.includes(response.type)) {
        console.log(`Received event: ${response.type}`, response);
      }

      if (response.type === 'session.updated') {
        console.log('Session updated successfully:', response);
      }

      // response.function_call_arguments.done
      if (response.type === 'response.function_call_arguments.done') {
        if (this.req_msg) {
          return;
        }
        this.req_msg = true;
        this.handleFunctionCall(response);
        // console.log('Function call arguments done:', response);
      }

      if (response.type === 'response.audio.delta' && response.delta) {
        const audioDelta = {
          event: 'media',
          streamSid: this.streamSid,
          media: {
            payload: Buffer.from(response.delta, 'base64').toString('base64'),
          },
        };
        client.send(JSON.stringify(audioDelta));
      }
    } catch (error) {
      console.error(
        'Error processing OpenAI message:',
        error,
        'Raw message:',
        data,
      );
    }
  }

  private async handleMessage(
    client: WebSocket,
    message: WebSocket.Data,
  ): Promise<void> {
    try {
      const data = JSON.parse(message.toString());

      switch (data.event) {
        case 'media':
          if (this.openAiWs.readyState === WebSocket.OPEN) {
            const audioAppend = {
              type: 'input_audio_buffer.append',
              audio: data.media.payload,
            };
            this.openAiWs.send(JSON.stringify(audioAppend));
          }
          break;
        case 'start':
          this.streamSid = data.start.streamSid;
          this.callSid = data.start.callSid;
          console.log('Incoming stream has started', this.streamSid);
          console.log('Call SID', this.callSid);
          break;
        default:
          console.log('Received non-media event:', data.event);
          break;
      }
    } catch (error) {
      console.error('Error parsing message:', error, 'Message:', message);
    }
  }

  handleDisconnect(client: WebSocket) {
    console.log('Client disconnected');
    if (this.openAiWs?.readyState === WebSocket.OPEN) this.openAiWs.close();
  }
}
