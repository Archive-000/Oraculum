import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import axios from 'axios';
import { PaystackProvider } from './paystack.provider';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;
const SECRET = 'test-secret-key';
function makeProviderWith(value: string | undefined = SECRET): PaystackProvider {
  return new PaystackProvider({ get: jest.fn().mockReturnValue(value) } as unknown as ConfigService);
}

describe('PaystackProvider', () => {
  beforeEach(() => jest.clearAllMocks());
  it.each([undefined, '', '   '])('rejects missing secret key (%s)', (value) => {
    expect(() => makeProviderWith(value)).toThrow('PAYSTACK_SECRET_KEY environment variable is not defined');
  });
  it('constructs when secret is set', () => expect(makeProviderWith()).toBeDefined());

  it('validates webhook signatures', () => {
    const provider = makeProviderWith();
    const body = Buffer.from('payload');
    const signature = crypto.createHmac('sha512', SECRET).update(body).digest('hex');
    expect(provider.verifyWebhookSignature(body, signature)).toBe(true);
    expect(provider.verifyWebhookSignature(body, 'bad')).toBe(false);
  });

  it('initializes a transaction and sends bearer auth', async () => {
    mockedAxios.post = jest.fn().mockResolvedValue({ data: { data: { authorization_url: 'https://paystack.com/pay/x', access_code: 'ac', reference: 'r1' } } });
    const result = await makeProviderWith().initializeTransaction('a@b.com', 1000, 'r1', 'https://callback.test');
    expect(result.reference).toBe('r1');
    expect((mockedAxios.post as jest.Mock).mock.calls[0][2].headers.Authorization).toBe(`Bearer ${SECRET}`);
  });

  it('retries transient provider errors up to the bounded attempt count', async () => {
    mockedAxios.get = jest.fn()
      .mockRejectedValueOnce({ isAxiosError: true, response: { status: 503 } })
      .mockResolvedValueOnce({ data: { data: { status: 'success' } } });
    await expect(makeProviderWith().verifyTransaction('ref')).resolves.toEqual({ status: 'success' });
    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-transient provider errors', async () => {
    mockedAxios.get = jest.fn().mockRejectedValue({ isAxiosError: true, response: { status: 400 } });
    await expect(makeProviderWith().verifyTransaction('ref')).rejects.toMatchObject({ response: { status: 400 } });
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it('retries network failures but stops after three attempts', async () => {
    mockedAxios.post = jest.fn().mockRejectedValue(new Error('Network error'));
    await expect(makeProviderWith().initializeTransaction('a@b.com', 100, 'r', 'https://cb.test')).rejects.toThrow('Network error');
    expect(mockedAxios.post).toHaveBeenCalledTimes(3);
  });

  it('sends partial refund amount', async () => {
    mockedAxios.post = jest.fn().mockResolvedValue({ data: { data: { id: 1 } } });
    await makeProviderWith().initiateRefund('ref_123', 5000);
    expect(mockedAxios.post).toHaveBeenCalledWith(expect.stringContaining('/refund'), { transaction: 'ref_123', amount: 5000 }, expect.any(Object));
  });
});
