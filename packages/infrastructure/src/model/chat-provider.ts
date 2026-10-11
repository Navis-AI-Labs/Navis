import { z } from 'zod';
import { ModelProviderError, type ModelProvider } from '@navis/application';

const choiceSchema = z.object({
  message: z.object({ content: z.string().trim().min(1).max(65_536) }),
});
const responseSchema = z.object({ choices: z.tuple([choiceSchema]).rest(choiceSchema) });

/** Provider input is explicit task text; no credentials, filesystem or tool executor are exposed to the model. */
export class ChatModelProvider implements ModelProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly key: string,
  ) {}
  get modelName(): string {
    return this.model;
  }

  async generate(prompt: string, requestId: string, signal: AbortSignal): Promise<string> {
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
        headers: {
          authorization: `Bearer ${this.key}`,
          'content-type': 'application/json',
          'user-agent': 'Navis/0.0.0',
          'x-request-id': requestId,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: 'system',
              content:
                'Produce candidate project knowledge for human review. You have no authority to accept, execute actions, or confirm delivery. Return plain text.',
            },
            { role: 'user', content: prompt },
          ],
          max_tokens: 2048,
          stream: false,
        }),
      });
      if (!response.ok)
        throw new ModelProviderError(
          response.status === 401 || response.status === 403
            ? 'MODEL_CREDENTIAL_DENIED'
            : 'MODEL_HTTP_FAILURE',
          response.status === 429 || response.status >= 500,
        );
      if (response.body === null) throw new ModelProviderError('MODEL_EMPTY_RESPONSE');
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
        bytes += chunk.byteLength;
        if (bytes > 262_144) throw new ModelProviderError('MODEL_RESPONSE_TOO_LARGE');
        chunks.push(chunk);
      }
      const parsed = responseSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (!parsed.success) throw new ModelProviderError('MODEL_INVALID_RESPONSE');
      return parsed.data.choices[0].message.content;
    } catch (error) {
      if (error instanceof ModelProviderError) throw error;
      throw new ModelProviderError('MODEL_UNAVAILABLE', !signal.aborted);
    }
  }
}
