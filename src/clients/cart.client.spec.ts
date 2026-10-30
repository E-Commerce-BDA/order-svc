import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { CartClient } from './cart.client.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';

describe('CartClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let warn: ReturnType<typeof vi.spyOn>;
  let client: CartClient;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    client = new CartClient({
      get: (key: string) =>
        ({
          CART_SVC_URL: 'http://cart.test',
          INTERNAL_SERVICE_KEY: 'service-key-1234567890',
        })[key],
    } as unknown as ConfigService);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('posts the conversion to the internal route with the service key', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    await client.convertCart(USER_ID);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `http://cart.test/api/v1/cart/internal/carts/${USER_ID}/convert`,
    );
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'x-service-key': 'service-key-1234567890' },
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(warn).not.toHaveBeenCalled();
  });

  it('treats a 204 replay as success', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204 });

    await client.convertCart(USER_ID);

    expect(warn).not.toHaveBeenCalled();
  });

  it('warns with the status on a 404 without throwing', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });

    await expect(client.convertCart(USER_ID)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('404'),
    );
  });

  it('warns and swallows a network failure', async () => {
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(client.convertCart(USER_ID)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('ECONNREFUSED'),
    );
  });
});
