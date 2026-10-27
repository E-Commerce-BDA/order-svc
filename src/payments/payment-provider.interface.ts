export interface PaymentResult {
  success: boolean;
  transactionId?: string;
  errorMessage?: string;
}

export interface IPaymentProvider {
  capture(
    amount: number,
    orderId: string,
    metadata?: Record<string, unknown>,
  ): Promise<PaymentResult>;

  refund(
    transactionId: string,
    amount: number,
    reason?: string,
  ): Promise<PaymentResult>;
}
