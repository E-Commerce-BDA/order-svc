import { MockPaymentProvider } from './mock-payment.provider.js';

describe('MockPaymentProvider idempotency', () => {
  it('replays the original capture for a repeated order id', async () => {
    const provider = new MockPaymentProvider();

    const first = await provider.capture(100, 'order-1');
    const replay = await provider.capture(100, 'order-1');

    expect(first.success).toBe(true);
    expect(replay).toEqual(first);
  });

  it('replays the original refund for a repeated captured transaction', async () => {
    const provider = new MockPaymentProvider();

    const first = await provider.refund('mock_tx_seed', 100);
    const replay = await provider.refund('mock_tx_seed', 100);

    expect(first.success).toBe(true);
    expect(replay).toEqual(first);
  });

  it('keeps separate order ids independent', async () => {
    const provider = new MockPaymentProvider();

    const first = await provider.capture(100, 'order-1');
    const second = await provider.capture(100, 'order-2');

    expect(second.transactionId).not.toBe(first.transactionId);
  });
});
